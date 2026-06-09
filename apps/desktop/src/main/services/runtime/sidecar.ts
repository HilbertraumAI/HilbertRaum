import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import type { HealthStatus } from './index'

// Sidecar discovery + lifecycle (spec §6, §7.5). Locates the prebuilt `llama-server`
// binary on the drive and manages the child process that both the chat runtime
// (`LlamaRuntime`) and the real embedder (`E5Embedder`) drive over loopback HTTP.
//
// LOCALHOST-ONLY (non-negotiable): the server is always spawned with
// `--host 127.0.0.1`; we never bind `0.0.0.0` or a routable interface. The Phase-8
// offline guard exempts loopback precisely so this local socket is allowed; a
// routable bind would expose local inference to the LAN and violate the spec.

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

/**
 * Resolve the `llama-server` binary, or `null` when it is absent. Pure I/O check (only
 * `existsSync`) so a "binary present?" decision has no surprises. A `PAID_LLAMA_BIN`
 * env override points at an explicit binary for dev (still validated for existence).
 */
export function resolveLlamaServerPath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const override = env.PAID_LLAMA_BIN?.trim()
  if (override) return existsSync(override) ? override : null
  const candidate = join(llamaServerDir(rootPath, platform), llamaServerBinaryName(platform))
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

// ---- Injectable seams (so the server can be unit-tested with no real binary) -----

/** A readable stream surface — just enough to drain + capture the child's stderr. */
export interface ReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

/** Minimal child-process surface we depend on (real `ChildProcess` satisfies it). */
export interface ChildProcessLike {
  readonly pid?: number
  readonly killed: boolean
  /** Present when spawned with a piped stderr; absent in tests' fake children. */
  readonly stderr?: ReadableLike | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike
export type FetchFn = typeof fetch

const realSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options)

export interface LlamaServerOptions {
  binPath: string
  /** Absolute path to the GGUF weight file. */
  modelPath: string
  contextTokens: number
  /** Extra CLI args (e.g. `['--embedding']` for the embeddings server). */
  extraArgs?: string[]
  threads?: number
  /** Max time to wait for `/health` to report ready before failing the start. */
  healthTimeoutMs?: number
  /** Poll interval while waiting for health. */
  healthIntervalMs?: number
  host?: string
  // Test seams:
  spawn?: SpawnFn
  fetchImpl?: FetchFn
  findPort?: (host: string) => Promise<number>
}

const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 250
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

  private readonly host: string
  private readonly spawn: SpawnFn
  private readonly fetchImpl: FetchFn
  private readonly findPort: (host: string) => Promise<number>
  private readonly healthTimeoutMs: number
  private readonly healthIntervalMs: number

  constructor(private readonly opts: LlamaServerOptions) {
    this.host = opts.host ?? LOOPBACK_HOST
    this.spawn = opts.spawn ?? realSpawn
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.findPort = opts.findPort ?? findFreePort
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.healthIntervalMs = opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  }

  /** The CLI args used to launch the server. LOCALHOST-ONLY: `--host 127.0.0.1`. */
  buildArgs(port: number): string[] {
    const threads = this.opts.threads ?? defaultThreadCount()
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
    this.spawnError = null
    this.exited = false
    this.exitCode = null
    this.exitSignal = null
    this.stderrTail = ''
    this.port = await this.findPort(this.host)

    // stdin/stdout ignored; stderr PIPED. We never read stdout (health/chat go over HTTP),
    // so it is discarded — a piped-but-undrained stdout would fill the OS pipe buffer and
    // block a chatty `llama-server`. stderr is piped AND drained (below): draining prevents
    // the same deadlock, and the captured tail explains a failed start (e.g. a port
    // conflict's "bind: address already in use").
    const child = this.spawn(this.opts.binPath, this.buildArgs(this.port), {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.child = child
    child.stderr?.on('data', (chunk: unknown) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    child.once('error', (err: unknown) => {
      this.spawnError = err instanceof Error ? err : new Error(String(err))
    })
    child.once('exit', (code: unknown, signal: unknown) => {
      this.exited = true
      this.exitCode = typeof code === 'number' ? code : null
      this.exitSignal = typeof signal === 'string' ? signal : null
    })

    await this.waitForHealthy()
  }

  /** A ` — last output: …` suffix from the captured stderr tail, or '' if none. */
  private stderrSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail ? ` — last output: ${tail}` : ''
  }

  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
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
      await delay(this.healthIntervalMs)
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
    const child = this.child
    this.child = null
    this.port = null
    if (!child) return
    if (child.killed || this.exited) return

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      child.kill()
    } catch {
      return
    }
    // Force-kill if it ignores the polite signal, but never hang the quit path.
    await Promise.race([exited, delay(2000)])
    if (!child.killed) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
    }
  }
}
