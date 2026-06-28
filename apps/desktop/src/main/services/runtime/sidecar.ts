import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { log } from '../logging'
import { verifyBinaryBeforeSpawn, type BinaryVerifyResult } from '../binary-verifier'
import type { HealthStatus } from './index'

// Sidecar discovery + lifecycle (spec §6, §7.5). Locates the prebuilt `llama-server`
// binary on the drive and manages the child process that both the chat runtime
// (`LlamaRuntime`) and the real embedder (`E5Embedder`) drive over loopback HTTP.
//
// LOCALHOST-ONLY (non-negotiable): the server is always spawned with
// `--host 127.0.0.1`; we never bind `0.0.0.0` or a routable interface. The offline
// guard exempts loopback precisely so this local socket is allowed; a routable bind
// would expose local inference to the LAN and violate the spec.

/** Loopback host every sidecar binds + every loopback fetch targets. Never routable. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Platform-specific `llama-server` executable name. */
export function llamaServerBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

/** OS sub-directory key under `runtime/llama.cpp/` (spec §6 drive layout). */
export function llamaOsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'mac'
  return 'linux'
}

/** Directory that holds the platform sidecar binaries: `runtime/llama.cpp/<os>/`. */
export function llamaServerDir(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  return join(rootPath, 'runtime', 'llama.cpp', llamaOsDir(platform))
}

/** Options for the sidecar binary resolvers. */
export interface ResolveBinOptions {
  /**
   * Whether this is a developer build (`!app.isPackaged`). The `HILBERTRAUM_LLAMA_BIN` /
   * `HILBERTRAUM_WHISPER_BIN` env overrides spawn an arbitrary, UNVERIFIED binary, so they
   * are honoured ONLY in dev (security audit M-5). In a packaged build the override is
   * ignored (and logged) and resolution falls back to the on-drive location. Defaults to
   * `false` (ignore the override) so a caller that forgets to pass it fails SAFE.
   */
  isDev?: boolean
}

/**
 * Resolve the `llama-server` binary, or `null` when it is absent. Pure I/O check (only
 * `existsSync`) so a "binary present?" decision has no surprises. A `HILBERTRAUM_LLAMA_BIN`
 * env override points at an explicit binary for DEV ONLY (still validated for existence);
 * in a packaged build it is ignored — see M-5 / `ResolveBinOptions`.
 */
export function resolveLlamaServerPath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveBinOptions = {}
): string | null {
  const override = env.HILBERTRAUM_LLAMA_BIN?.trim()
  if (override) {
    if (opts.isDev) return existsSync(override) ? override : null
    // Packaged build: never spawn an env-supplied, unverified binary.
    log.warn('Ignoring HILBERTRAUM_LLAMA_BIN in a packaged build (dev-only override)')
  }
  const candidate = join(llamaServerDir(rootPath, platform), llamaServerBinaryName(platform))
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolve the pure-CPU safety-net binary at `runtime/llama.cpp/<os>/cpu/` (shipped on
 * win/linux), or `null` when absent — the fallback ladder's rung 3 (architecture.md
 * GPU record §5.2). Deliberately ignores `HILBERTRAUM_LLAMA_BIN`: the override points at one
 * explicit binary and has no implied sibling.
 */
export function resolveCpuFallbackServerPath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const candidate = join(llamaServerDir(rootPath, platform), 'cpu', llamaServerBinaryName(platform))
  return existsSync(candidate) ? candidate : null
}

/** A sane default thread count: half the logical cores, at least 1. */
export function defaultThreadCount(): number {
  let count = 0
  try {
    count = cpus().length
  } catch {
    count = 0
  }
  return Math.max(1, Math.floor(count / 2) || 1)
}

/**
 * Ask the OS for a free TCP port on loopback by listening on port 0 then closing.
 * (`net.createServer().listen` is an inbound bind, not the outbound `connect` the
 * offline guard watches — so this stays loopback-only and guard-clean.)
 */
export function findFreePort(host: string = LOOPBACK_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('Could not find a free port'))))
    })
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A request abort signal that fires on EITHER the per-request timeout OR an optional
 * caller signal (a user "Stop"). When no caller signal is given it's just the timeout,
 * so existing callers are unchanged. Used by the embedder + reranker loopback fetches so
 * a "Stop" during query embedding / rerank cancels promptly, not only on timeout (M-C5).
 */
export function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

// ---- Injectable seams (so the server can be unit-tested with no real binary) -----

/** A readable stream surface — just enough to drain + capture the child's stderr. */
export interface ReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

/** Minimal child-process surface we depend on (real `ChildProcess` satisfies it). */
export interface ChildProcessLike {
  readonly pid?: number
  readonly killed: boolean
  /** Present when spawned with a piped stdout (the GPU probe); absent otherwise. */
  readonly stdout?: ReadableLike | null
  /** Present when spawned with a piped stderr; absent in tests' fake children. */
  readonly stderr?: ReadableLike | null
  kill(signal?: NodeJS.Signals | number): boolean
  /** Detach the child from the parent's event loop so it can't keep Electron alive on quit
   *  (REL-8). Optional: test fakes omit it, so call sites use `child.unref?.()`. */
  unref?(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike
export type FetchFn = typeof fetch

const realSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options)

/** What a server that died on its own (not via `stop()`) left behind. */
export interface UnexpectedExitInfo {
  exitCode: number | null
  exitSignal: string | null
  stderrTail: string
}

export interface LlamaServerOptions {
  binPath: string
  /** Absolute path to the GGUF weight file. */
  modelPath: string
  contextTokens: number
  /**
   * Physical batch size for prompt prefill — emitted as `--batch-size`/`--ubatch-size`
   * (RT-1, perf audit 2026-06-18). llama-server's 512 default chunks prefill into 512-token
   * pieces; the dominant time-to-first-token cost (skill fence + RAG excerpts + history, 3.5–15s
   * on CPU per Skills §17) is prefill, and a larger physical batch processes it in fewer passes
   * (and materially improves prompt-processing throughput on GPU). Only the CHAT sidecar sets
   * this; the embedder/reranker tune their own batch via extraArgs (reranker/llama.ts:96-115).
   */
  physicalBatchSize?: number
  /** Extra CLI args (e.g. `['--embedding']` for the embeddings server). */
  extraArgs?: string[]
  threads?: number
  /** Max time to wait for `/health` to report ready before failing the start. */
  healthTimeoutMs?: number
  /** Poll interval while waiting for health. */
  healthIntervalMs?: number
  host?: string
  /**
   * Fired when the child exits AFTER having become healthy, outside `stop()` — i.e. a
   * mid-session crash (driver crash, VRAM exhaustion). Start-time failures are NOT
   * reported here (they already throw from `start()`); the GPU crash auto-fallback
   * (architecture.md GPU record §5.3) hangs off this hook.
   */
  onUnexpectedExit?: (info: UnexpectedExitInfo) => void
  /**
   * Re-hash the binary against its install marker immediately before spawn (vuln-scan B).
   * Defaults to the shared `verifyBinaryBeforeSpawn` (session-cached; inert in dev / before
   * init). On a `mismatch` (packaged tamper) `start()` throws so the ladder falls to the
   * next rung / MockRuntime. Injected by tests to assert the refusal without a real binary.
   */
  verifyBinary?: (binPath: string) => Promise<BinaryVerifyResult>
  // Test seams:
  spawn?: SpawnFn
  fetchImpl?: FetchFn
  findPort?: (host: string) => Promise<number>
  /** Grace period after SIGTERM before escalating to SIGKILL on stop() (default 2000ms). */
  killGraceMs?: number
}

const DEFAULT_HEALTH_TIMEOUT_MS = 180_000
/**
 * Steady-state CAP for the readiness poll. RT-5: `waitForHealthy` backs off from
 * `INITIAL_HEALTH_INTERVAL_MS` up to this value rather than polling at a fixed 250 ms —
 * a sidecar that becomes ready quickly (a small model / warm page cache) is detected in
 * tens of ms instead of paying up to a full interval of dead time on every start / model
 * switch, while a slow multi-GB load still settles to this gentle cap instead of hammering
 * `/health`. The overall timeout budget (`healthTimeoutMs`) is unchanged.
 */
const DEFAULT_HEALTH_INTERVAL_MS = 250
/** First readiness-poll delay; the interval doubles each miss up to `healthIntervalMs`. */
const INITIAL_HEALTH_INTERVAL_MS = 50
const DEFAULT_KILL_GRACE_MS = 2_000
/** Per-probe timeout so a hung (accepts-but-never-responds) server can't stall the poll. */
const HEALTH_PROBE_TIMEOUT_MS = 3_000

/**
 * Owns one `llama-server` child process bound to loopback. Spawns it, waits for the
 * `/health` endpoint to report ready (with a timeout — never hangs the app on a wedged
 * server), exposes a loopback `fetch` against it, and kills it cleanly on `stop()`
 * (waiting for exit so no orphan survives). Both `LlamaRuntime` and `E5Embedder`
 * compose this; neither re-implements process hygiene.
 */
/** Keep only the last N chars of captured stderr (enough to show the failing reason). */
const STDERR_TAIL_MAX = 4000

export class LlamaServer {
  port: number | null = null
  private child: ChildProcessLike | null = null
  private spawnError: Error | null = null
  private exited = false
  private exitCode: number | null = null
  private exitSignal: string | null = null
  private stderrTail = ''
  /** True once /health reported ready — gates the unexpected-exit hook. */
  private ready = false
  /** True while stop() is tearing the child down — an exit then is EXPECTED. */
  private stopping = false

  private readonly host: string
  private readonly spawn: SpawnFn
  private readonly fetchImpl: FetchFn
  private readonly findPort: (host: string) => Promise<number>
  private readonly verifyBinary: (binPath: string) => Promise<BinaryVerifyResult>
  private readonly healthTimeoutMs: number
  private readonly healthIntervalMs: number
  private readonly killGraceMs: number

  constructor(private readonly opts: LlamaServerOptions) {
    this.host = opts.host ?? LOOPBACK_HOST
    this.spawn = opts.spawn ?? realSpawn
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.findPort = opts.findPort ?? findFreePort
    this.verifyBinary = opts.verifyBinary ?? verifyBinaryBeforeSpawn
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.healthIntervalMs = opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  }

  /** The CLI args used to launch the server. LOCALHOST-ONLY: `--host 127.0.0.1`. */
  buildArgs(port: number): string[] {
    const threads = this.opts.threads ?? defaultThreadCount()
    // RT-1: emit `--batch-size`/`--ubatch-size` only when a physical batch is requested (the
    // chat sidecar). Unset ⇒ no flags ⇒ llama-server's 512 default, leaving the embedder and
    // reranker (which set their own batch via extraArgs) untouched.
    const batchArgs =
      this.opts.physicalBatchSize != null
        ? [
            '--batch-size',
            String(this.opts.physicalBatchSize),
            '--ubatch-size',
            String(this.opts.physicalBatchSize)
          ]
        : []
    return [
      '--host',
      this.host,
      '--port',
      String(port),
      '--model',
      this.opts.modelPath,
      '--ctx-size',
      String(this.opts.contextTokens),
      '--threads',
      String(threads),
      ...batchArgs,
      ...(this.opts.extraArgs ?? [])
    ]
  }

  baseUrl(): string {
    return `http://${this.host}:${this.port}`
  }

  /** Loopback fetch against this server (exempt from the offline guard by design). */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    if (this.port == null) throw new Error('llama-server is not started')
    return this.fetchImpl(`${this.baseUrl()}${path}`, init)
  }

  /** Spawn the server and block until it is healthy (or throw on timeout/crash). */
  async start(): Promise<void> {
    if (this.child) return
    // Re-hash the binary against its install marker BEFORE we spawn it (vuln-scan B). A
    // packaged-build tamper (`mismatch`) throws here, before any port/child is allocated,
    // so the ladder cleanly falls to the next rung / MockRuntime. Dev + legacy drives
    // resolve skip-* and proceed. Covers the chat runtime, embedder, reranker, and vision
    // — every llama-server spawn funnels through this method.
    if ((await this.verifyBinary(this.opts.binPath)) === 'mismatch') {
      throw new Error('llama-server failed pre-spawn integrity verification')
    }
    this.spawnError = null
    this.exited = false
    this.exitCode = null
    this.exitSignal = null
    this.stderrTail = ''
    this.ready = false
    this.stopping = false
    this.port = await this.findPort(this.host)

    // stdin/stdout ignored; stderr PIPED. We never read stdout (health/chat go over HTTP),
    // so it is discarded — a piped-but-undrained stdout would fill the OS pipe buffer and
    // block a chatty `llama-server`. stderr is piped AND drained (below): draining prevents
    // the same deadlock, and the captured tail explains a failed start (e.g. a port
    // conflict's "bind: address already in use").
    const child = this.spawn(this.opts.binPath, this.buildArgs(this.port), {
      stdio: ['ignore', 'ignore', 'pipe'],
      // REL-7: never flash a console window on Windows for this high-frequency spawn (every
      // model start), matching the tar / transcriber / runtime-download spawns. No-op off Windows.
      windowsHide: true
    })
    this.child = child
    child.stderr?.on('data', (chunk: unknown) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    child.once('error', (err: unknown) => {
      this.spawnError = err instanceof Error ? err : new Error(String(err))
      // An 'error' after the process is up means it is gone (the OS reports it via
      // ECHILD, an EPIPE writing to a dead child) — possibly without ever emitting
      // 'exit'. Mark it exited — like the 'exit' handler does — so stop()'s grace race
      // resolves AND its SIGKILL escalation is correctly skipped (the child is already
      // dead). `stop()` clears `ready`, so we record the exit whenever it's during
      // teardown too; the unexpected-exit hook still only fires for a healthy server
      // dying on its own (the GPU crash auto-fallback path, architecture.md §5.3).
      // Start-time errors are consulted by waitForHealthy instead, so they don't set this.
      if ((this.ready || this.stopping) && !this.exited) {
        this.exited = true
        if (this.ready && !this.stopping) {
          this.opts.onUnexpectedExit?.({
            exitCode: this.exitCode,
            exitSignal: this.exitSignal,
            stderrTail: this.stderrTail
          })
        }
      }
    })
    child.once('exit', (code: unknown, signal: unknown) => {
      this.exited = true
      this.exitCode = typeof code === 'number' ? code : null
      this.exitSignal = typeof signal === 'string' ? signal : null
      // A crash AFTER the server was healthy (and not during stop()) is the
      // mid-generation failure path — report it so the GPU auto-fallback can react.
      // Exits before health are start failures and already throw from waitForHealthy.
      if (this.ready && !this.stopping) {
        this.opts.onUnexpectedExit?.({
          exitCode: this.exitCode,
          exitSignal: this.exitSignal,
          stderrTail: this.stderrTail
        })
      }
    })

    await this.waitForHealthy()
    this.ready = true
  }

  /** A ` — last output: …` suffix from the captured stderr tail, or '' if none. */
  private stderrSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail ? ` — last output: ${tail}` : ''
  }

  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
    // RT-5: start small and back off (×2) up to the configured cap, so a fast-ready
    // sidecar is picked up promptly instead of waiting a full fixed interval. Tests that
    // pass a tiny `healthIntervalMs` (e.g. 1) cap the initial too, keeping them fast.
    let interval = Math.min(INITIAL_HEALTH_INTERVAL_MS, this.healthIntervalMs)
    for (;;) {
      if (this.spawnError) {
        const message = this.spawnError.message
        await this.stop()
        throw new Error(`llama-server failed to launch: ${message}`)
      }
      if (this.exited) {
        this.child = null
        const code = this.exitCode != null ? `code ${this.exitCode}` : `signal ${this.exitSignal}`
        // A port conflict or bad model makes llama-server exit immediately — the stderr
        // tail (e.g. "bind: address already in use") explains which.
        throw new Error(`llama-server exited before becoming healthy (${code})${this.stderrSuffix()}`)
      }
      const h = await this.health()
      if (h.healthy) return
      if (Date.now() >= deadline) {
        await this.stop()
        throw new Error(
          `llama-server did not become healthy within ${this.healthTimeoutMs}ms${this.stderrSuffix()}`
        )
      }
      await delay(interval)
      interval = Math.min(interval * 2, this.healthIntervalMs)
    }
  }

  /** Poll `/health`; ready → healthy. Failures/timeouts are reported, never thrown. */
  async health(): Promise<HealthStatus> {
    if (this.port == null) return { healthy: false, message: 'Not started', port: null }
    try {
      // Bound each probe: a server that accepts the socket but never responds would
      // otherwise hang the await and the deadline check below would never be reached.
      const res = await this.fetch('/health', {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)
      })
      const healthy = res.ok
      return {
        healthy,
        port: this.port,
        message: healthy
          ? `llama-server ready on ${this.host}:${this.port}`
          : `llama-server not ready (HTTP ${res.status})`
      }
    } catch (err) {
      return {
        healthy: false,
        port: this.port,
        message: `Health check failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /** Kill the child and wait for it to exit so no orphaned process survives. */
  async stop(): Promise<void> {
    this.stopping = true
    this.ready = false
    const child = this.child
    this.child = null
    this.port = null
    if (!child) return
    if (child.killed || this.exited) return

    // Resolve the wait on EITHER 'exit' or 'error': a child that died via 'error'
    // without ever emitting 'exit' (M-C1) would otherwise never settle this race.
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    try {
      child.kill()
    } catch {
      // kill() itself threw (already-dead child, EPERM): do NOT bail early (M-C2) — a
      // surviving orphan would still hold VRAM + the port. Fall through to race the
      // grace window and attempt SIGKILL like the normal path.
    }
    // Force-kill if it ignores the polite signal, but never hang the quit path.
    // NB: gate on `this.exited` (set by the 'exit' listener), NOT `child.killed` —
    // `child.killed` becomes true the moment a signal is *sent* (line above), so it is
    // always true here and would skip the escalation entirely, leaving an orphan on a
    // process that ignored SIGTERM (mac/Linux; Windows kill() is already forceful).
    await Promise.race([exited, delay(this.killGraceMs)])
    if (!this.exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
    }
  }
}
