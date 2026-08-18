import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ModelRuntime, RuntimeChatOptions } from '../runtime'
import { ExternalGenerationBusyError } from '../runtime'
import type { RuntimeStatus } from '../../../shared/types'
import { LocalApiAdmission, type Admission } from './admission'
import {
  checkAuth,
  checkContentType,
  checkHost,
  checkOrigin,
  chunkEnvelope,
  completionEnvelope,
  errorBody,
  parseChatRequest,
  readJsonBody,
  sendError,
  type ApiErrorBody,
  type ParsedChatRequest
} from './handlers'

// LocalApiServer (local-api wave P3): the opt-in OpenAI-compatible loopback endpoint.
// `node:http` only — no framework dependency. Exists only while the workspace is
// unlocked AND policy ∧ setting permit it (D3/D7); binds BOTH loopbacks (O5 — Windows
// resolves `localhost` to ::1 first and many clients don't address-iterate), NEVER
// 0.0.0.0 (D2). Routes through the manager-gated `active().chatStream` (never a raw
// sidecar proxy), so external requests inherit abort registration, watchdogs, context
// budgeting, and the D8 pre-emption contract for free.

/** Typed bind failure surfaced to Settings (never a crash). */
export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Port ${port} is already in use`)
    this.name = 'PortInUseError'
  }
}

export interface LocalApiStatus {
  running: boolean
  port: number | null
  tokenRequired: boolean
  /** Counts ONLY — the endpoint stores no request content anywhere (D1). */
  requestsServed: number
  rejectedCount: number
}

export interface LocalApiServerDeps {
  /** Live settings read (port + token-required may change while running). */
  getSettings(): { localApiPort: number; localApiTokenRequired: boolean }
  /** The access key (single main-process store; P2). */
  getToken(): string
  runtime: {
    status(): RuntimeStatus
    active(): ModelRuntime | null
    isExternallyBusy(): boolean
    setExternalPreemption(hook: ((reason: string) => void) | null): void
  }
  hasActiveDocTask(): boolean
  /** workspaceAdmitsWork(workspace) — the AUD-02 class predicate. */
  admitsWork(): boolean
  /** Retry-After estimate (seconds) from the persisted measured tok/s; see initBackend. */
  estimateBusySeconds(): number
  appVersion: string
  log?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void }
  // Test seams:
  queueWaitMs?: number
  drainTimeoutMs?: number
}

const HEADERS_TIMEOUT_MS = 10_000
/** Idle bound on the BODY phase only — cleared once the body arrived, because a CPU
 *  prefill legitimately produces no bytes for minutes (PERF-H1). */
const BODY_IDLE_TIMEOUT_MS = 30_000
/** A stalled SSE reader disarms the per-read watchdogs (PERF-H3/SEC-F2): awaiting drain
 *  is bounded, and expiry aborts the generation + frees the admission slot. */
const DRAIN_TIMEOUT_MS = 15_000
const MAX_CONNECTIONS = 16

export class LocalApiServer {
  private servers: http.Server[] = []
  private port: number | null = null
  private admission: LocalApiAdmission
  private requestsServed = 0
  private rejectedCount = 0
  /** Distinguishes teardown aborts from D8 pre-emption in the client-facing error code. */
  private stopping = false
  private starting: Promise<void> | null = null
  /** Live responses — stop() lets them flush their teardown error frame before the
   *  force-close (bounded; a wedged handler never delays lock/quit past the grace). */
  private readonly inFlight = new Set<http.ServerResponse>()

  constructor(private readonly deps: LocalApiServerDeps) {
    this.admission = new LocalApiAdmission({
      runtimeBusy: () => deps.runtime.isExternallyBusy(),
      hasActiveDocTask: () => deps.hasActiveDocTask(),
      admitsWork: () => deps.admitsWork() && !this.stopping,
      queueWaitMs: deps.queueWaitMs
    })
  }

  /** Bind both loopbacks (O5). Idempotent; port-taken → typed PortInUseError. A machine
   *  without IPv6 degrades to v4-only (logged) — `::1` failing with EADDRINUSE still
   *  refuses, because half-bound would mislead `localhost`-configured clients. */
  async start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.servers.length > 0) return
    const run = this.doStart()
    this.starting = run
    try {
      await run
    } finally {
      this.starting = null
    }
  }

  private async doStart(): Promise<void> {
    this.stopping = false
    const port = this.deps.getSettings().localApiPort
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      void this.handle(req, res)
    }
    const bind = (host: string, bindPort: number): Promise<http.Server> =>
      new Promise((resolve, reject) => {
        const server = http.createServer(handler)
        server.headersTimeout = HEADERS_TIMEOUT_MS
        // Node's 300 s default kills legitimate multi-minute CPU generations (PERF-H1);
        // wedge detection lives in the app-side watchdogs + the drain timeout instead.
        server.requestTimeout = 0
        server.maxConnections = MAX_CONNECTIONS
        server.once('error', reject)
        server.listen(bindPort, host, () => {
          server.removeListener('error', reject)
          resolve(server)
        })
      })

    try {
      this.servers.push(await bind('127.0.0.1', port))
    } catch (err) {
      await this.closeAll()
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(port)
      throw err
    }
    // The ::1 twin uses the RESOLVED v4 port (identical in production, where the clamp
    // forbids 0; test harnesses bind port 0 and both listeners must still agree).
    const resolvedPort = (this.servers[0].address() as AddressInfo).port
    try {
      this.servers.push(await bind('::1', resolvedPort))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        await this.closeAll()
        throw new PortInUseError(port)
      }
      // No IPv6 on this machine — v4-only is honest (the UI shows 127.0.0.1).
      this.deps.log?.warn('Local API: IPv6 loopback bind failed — serving on 127.0.0.1 only', {
        error: String(err)
      })
    }
    this.port = (this.servers[0].address() as AddressInfo).port
    this.deps.runtime.setExternalPreemption((reason) => this.admission.abortAll(reason))
    this.deps.log?.info('Local API listening', { port: this.port })
  }

  /** Abort active/queued requests, close the listeners. Idempotent; safe pre-start. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.starting) {
      try {
        await this.starting
      } catch {
        /* a failed start left nothing to stop */
      }
    }
    this.admission.abortAll('server stopping')
    this.deps.runtime.setExternalPreemption(null)
    // Bounded grace so mid-stream handlers can flush their `server_stopped` frame — the
    // abort settles their generators within microtasks; a wedged one is force-closed.
    const deadline = Date.now() + 500
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await this.closeAll()
    this.port = null
  }

  private async closeAll(): Promise<void> {
    const servers = this.servers
    this.servers = []
    await Promise.allSettled(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            // closeAllConnections aborts live SSE sockets — close() alone would wait
            // out a multi-minute stream and wedge the lock/quit teardown.
            server.closeAllConnections?.()
            server.close(() => resolve())
          })
      )
    )
  }

  /** Start/stop/re-port on a live settings change (the `applyUiLanguageSetting` seam
   *  precedent). Caller decides WHETHER the endpoint should run (policy ∧ setting). */
  async applySettings(next: { shouldRun: boolean }): Promise<void> {
    const runningPort = this.port
    const wantPort = this.deps.getSettings().localApiPort
    if (!next.shouldRun) {
      if (this.servers.length > 0) await this.stop()
      return
    }
    if (this.servers.length > 0 && runningPort === wantPort) return
    if (this.servers.length > 0) await this.stop()
    await this.start()
  }

  status(): LocalApiStatus {
    return {
      running: this.servers.length > 0,
      port: this.port,
      tokenRequired: this.deps.getSettings().localApiTokenRequired,
      requestsServed: this.requestsServed,
      rejectedCount: this.rejectedCount
    }
  }

  // ---- Request handling -------------------------------------------------------------------

  private reject(res: http.ServerResponse, status: number, body: ApiErrorBody, headers?: Record<string, string>): void {
    this.rejectedCount++
    sendError(res, status, body, headers)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.inFlight.add(res)
    res.once('close', () => this.inFlight.delete(res))
    try {
      res.setHeader('server', `HilbertRaum/${this.deps.appVersion}`)

      // Bound the BODY phase only; the generation phase may be silent for minutes.
      req.setTimeout(BODY_IDLE_TIMEOUT_MS, () => req.destroy())
      req.once('end', () => req.setTimeout(0))

      const port = this.port ?? this.deps.getSettings().localApiPort
      const hostErr = checkHost(req, port)
      if (hostErr) return this.reject(res, 403, hostErr)
      // OPTIONS (a CORS preflight) is structurally refused — no CORS headers EVER.
      if (req.method === 'OPTIONS') {
        return this.reject(res, 403, errorBody('Forbidden', 'permission_error', 'no_cors'))
      }
      const originErr = checkOrigin(req)
      if (originErr) return this.reject(res, 403, originErr)
      const ctErr = checkContentType(req)
      if (ctErr) return this.reject(res, 415, ctErr)
      const settings = this.deps.getSettings()
      const authErr = checkAuth(req, settings.localApiTokenRequired, this.deps.getToken())
      if (authErr) return this.reject(res, 401, authErr)

      const url = (req.url ?? '/').split('?')[0]
      if (req.method === 'GET' && url === '/v1/models') return this.handleModels(res)
      if (req.method === 'POST' && url === '/v1/chat/completions') return this.handleCompletions(req, res)
      return this.reject(res, 404, errorBody('Not found', 'invalid_request_error', 'unknown_route'))
    } catch (err) {
      this.deps.log?.warn('Local API request failed', { error: String(err) })
      if (!res.headersSent) {
        this.reject(res, 500, errorBody('Internal error', 'server_error', 'internal_error'))
      } else {
        res.destroy()
      }
    }
  }

  /** Model presence as three DISTINCT client outcomes (perf M6): running (200), starting
   *  (503 + Retry-After — pace, don't tell a human to act), absent (503 — a human must
   *  open HilbertRaum and start a model). Never consumes an admission slot. */
  private modelGate(): { status: RuntimeStatus } | { error: { status: number; body: ApiErrorBody; headers?: Record<string, string> } } {
    const status = this.deps.runtime.status()
    if (status.running && this.deps.runtime.active() != null) return { status }
    if (status.startingModelId != null) {
      return {
        error: {
          status: 503,
          body: errorBody('The model is still loading', 'unavailable_error', 'model_starting'),
          headers: { 'retry-after': String(this.deps.estimateBusySeconds()) }
        }
      }
    }
    return {
      error: {
        status: 503,
        body: errorBody('No model is running — open HilbertRaum and start a model', 'unavailable_error', 'model_not_loaded')
      }
    }
  }

  private handleModels(res: http.ServerResponse): void {
    const gate = this.modelGate()
    if ('error' in gate) return this.reject(res, gate.error.status, gate.error.body, gate.error.headers)
    const { status } = gate
    const payload = JSON.stringify({
      object: 'list',
      data: [
        {
          id: status.modelId,
          object: 'model',
          owned_by: 'hilbertraum',
          // Non-standard but harmless extra: clients sizing prompts want the window.
          context_window: status.contextWindow ?? null
        }
      ]
    })
    this.requestsServed++
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }

  private async handleCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const read = await readJsonBody(req, res)
    if (!read.ok) {
      this.rejectedCount++
      return
    }
    const parsed = parseChatRequest(read.body)
    if (!parsed.ok) return this.reject(res, 400, parsed.error)

    const gate = this.modelGate()
    if ('error' in gate) return this.reject(res, gate.error.status, gate.error.body, gate.error.headers)
    const runtime = this.deps.runtime.active()!
    const model = gate.status.modelId ?? 'unknown'

    // Client disconnect aborts everything downstream (an abandoned request must not burn
    // a multi-minute generation nobody reads — both modes).
    const clientGone = new AbortController()
    res.once('close', () => clientGone.abort(new DOMException('client disconnected', 'AbortError')))

    const outcome = this.admission.tryAdmit(randomUUID(), clientGone.signal)
    if (outcome === 'aborted') {
      res.destroy()
      return
    }
    if (outcome === 'locked') {
      return this.reject(res, 503, errorBody('The workspace is locked', 'unavailable_error', 'workspace_locked'))
    }
    if (outcome === 'busy') {
      return this.reject(
        res,
        429,
        errorBody('HilbertRaum is busy with another answer — try again shortly', 'rate_limit_error', 'busy'),
        { 'retry-after': String(this.deps.estimateBusySeconds()) }
      )
    }
    const admission: Admission = outcome
    try {
      const held = await admission.ready
      if (!held) {
        return this.reject(
          res,
          429,
          errorBody('HilbertRaum is busy with another answer — try again shortly', 'rate_limit_error', 'busy'),
          { 'retry-after': String(this.deps.estimateBusySeconds()) }
        )
      }
      await this.runCompletion(req, res, runtime, model, parsed.req, admission)
    } finally {
      admission.release()
    }
  }

  private buildChatOptions(
    parsed: ParsedChatRequest,
    signal: AbortSignal,
    contextWindow: number | undefined,
    onFinish: (reason: string) => void
  ): RuntimeChatOptions {
    // External defaults: answer-depth 'balanced' ⇒ thinking OFF (a client's first-token
    // timeout must not sit through a silent reasoning phase). max_tokens clamps to the
    // launched context window.
    const cap = contextWindow != null ? Math.max(1, contextWindow) : undefined
    const maxTokens =
      parsed.maxTokens != null ? (cap != null ? Math.min(parsed.maxTokens, cap) : parsed.maxTokens) : undefined
    return {
      lane: 'external',
      signal,
      mode: 'balanced',
      maxTokens,
      temperature: parsed.temperature,
      responseSchema: parsed.responseSchema as RuntimeChatOptions['responseSchema'],
      responseSchemaName: parsed.responseSchemaName,
      onFinish
    }
  }

  private async runCompletion(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    runtime: ModelRuntime,
    model: string,
    parsed: ParsedChatRequest,
    admission: Admission
  ): Promise<void> {
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let finishReason = 'stop'
    const options = this.buildChatOptions(
      parsed,
      admission.signal,
      this.deps.runtime.status().contextWindow,
      (reason) => {
        finishReason = reason
      }
    )
    const generator = runtime.chatStream(parsed.messages, options)

    if (!parsed.stream) {
      // Non-streaming (every SDK's default): buffer server-side under the same slot.
      let content = ''
      try {
        try {
          for await (const delta of generator) content += delta
        } finally {
          await generator.return(undefined)
        }
      } catch (err) {
        return this.completionError(res, err)
      }
      if (admission.signal.aborted) {
        // Aborted mid-buffer: nothing useful to return. Distinguish teardown/pre-emption
        // for the client; a vanished client just gets the socket closed.
        return this.abortedBeforeStream(res)
      }
      const payload = completionEnvelope(id, created, model, content, finishReason)
      this.requestsServed++
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
      return
    }

    // Streaming SSE.
    let started = false
    const drainTimeout = this.deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
    const write = async (payload: string): Promise<void> => {
      if (res.writableEnded || res.destroyed) return
      if (!res.write(`data: ${payload}\n\n`)) {
        // Backpressure: bounded drain wait; expiry aborts the generation and frees the
        // slot (a stalled reader must not wedge the model — PERF-H3).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // Destroying the response ends the for-await on its next tick (the loop
            // checks res.destroyed), which settles the generator and frees the slot.
            res.destroy()
            resolve()
          }, drainTimeout)
          ;(timer as { unref?: () => void }).unref?.()
          res.once('drain', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    }
    try {
      try {
        for await (const delta of generator) {
          if (!started) {
            started = true
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive'
            })
            await write(chunkEnvelope(id, created, model, { role: 'assistant' }, null))
          }
          await write(chunkEnvelope(id, created, model, { content: delta }, null))
          if (res.destroyed) break
        }
      } finally {
        await generator.return(undefined)
      }
    } catch (err) {
      if (!started) return this.completionError(res, err)
      // Mid-stream failure: in-band error frame, close WITHOUT [DONE] (the F-02 class —
      // a [DONE] after an error marks the truncated stream successful).
      await write(JSON.stringify(errorBody('The generation failed', 'server_error', 'runtime_error')))
      res.end()
      return
    }
    if (admission.signal.aborted && !res.destroyed) {
      if (!started) return this.abortedBeforeStream(res)
      const code = this.stopping ? 'server_stopped' : 'preempted_by_user'
      await write(JSON.stringify(errorBody('The answer was interrupted', 'server_error', code)))
      res.end() // NO [DONE] — the stream is truncated, not successful (client-dev 7)
      return
    }
    if (!started) {
      // Zero-token generation: still a valid (empty) stream.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      await write(chunkEnvelope(id, created, model, { role: 'assistant' }, null))
    }
    await write(chunkEnvelope(id, created, model, {}, finishReason))
    await write('[DONE]')
    this.requestsServed++
    res.end()
  }

  /** Abort before any SSE bytes: a plain status answer is still possible. */
  private abortedBeforeStream(res: http.ServerResponse): void {
    if (this.stopping) {
      return this.reject(res, 503, errorBody('HilbertRaum is shutting down', 'unavailable_error', 'server_stopped'))
    }
    this.reject(
      res,
      429,
      errorBody('The answer was interrupted by in-app use — try again shortly', 'server_error', 'preempted_by_user'),
      { 'retry-after': String(this.deps.estimateBusySeconds()) }
    )
  }

  private completionError(res: http.ServerResponse, err: unknown): void {
    if (err instanceof ExternalGenerationBusyError) {
      return this.reject(
        res,
        429,
        errorBody('HilbertRaum is busy with another answer — try again shortly', 'rate_limit_error', 'busy'),
        { 'retry-after': String(this.deps.estimateBusySeconds()) }
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    if (/context|token budget|overflow/i.test(message)) {
      return this.reject(res, 400, errorBody('The request does not fit the model context window', 'invalid_request_error', 'context_overflow'))
    }
    if (admissionAbort(err)) {
      return this.abortedBeforeStream(res)
    }
    // Runtime unresponsive / anything else: 502 with a content-free reason.
    this.reject(res, 502, errorBody('The model runtime did not answer', 'server_error', 'runtime_unresponsive'))
  }
}

function admissionAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}
