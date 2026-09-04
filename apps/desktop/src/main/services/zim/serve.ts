import { log } from '../logging'
import { verifyBinaryBeforeSpawn } from '../binary-verifier'
import {
  LOOPBACK_HOST,
  findFreePort,
  isBindRaceError,
  registerSidecarChild,
  unregisterSidecarChild,
  type ChildProcessLike,
  type SpawnFn
} from '../runtime/sidecar'
import { spawn as nodeSpawn } from 'node:child_process'
import { kiwixGet } from './client'

// kiwix-serve sidecar lifecycle (knowledge packs). A compact sibling of LlamaServer
// (runtime/sidecar.ts) — same seams (injectable spawn/port/probe for tests), same
// stop() escalation, same crash-reap registration — minus everything model-specific
// (no API key: the server is loopback-bound, read-only, and serves non-secret archive
// content; no GPU ladder; no idle teardown — measured RSS with three books loaded is
// ~52 MB, spike 2026-08-22).
//
// Start is lazy (first ask that needs a pack) and single-flight; a failed start
// latches until `resetFailureLatch()` — pack registration changes call it, so one
// broken state never spams a spawn per keystroke, and fixing the packs re-arms it.

const STDERR_TAIL_MAX = 4_000
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000
const INITIAL_HEALTH_INTERVAL_MS = 50
const DEFAULT_HEALTH_INTERVAL_MS = 250
const HEALTH_PROBE_TIMEOUT_MS = 3_000
const DEFAULT_KILL_GRACE_MS = 2_000

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface KiwixServerOptions {
  binPath: string
  /** Absolute path of the generated library.xml naming every available pack. */
  libraryXmlPath: string
  spawn?: SpawnFn
  findPort?: () => Promise<number>
  /** Probe seam: true when the server answers on `port`. Default hits /catalog/v2/root.xml. */
  probe?: (port: number) => Promise<boolean>
  healthTimeoutMs?: number
  healthIntervalMs?: number
  killGraceMs?: number
}

export class KiwixServer {
  private readonly opts: KiwixServerOptions
  private readonly spawnFn: SpawnFn
  private readonly portFn: () => Promise<number>
  private readonly probeFn: (port: number) => Promise<boolean>

  private child: ChildProcessLike | null = null
  private currentPort: number | null = null
  private ready = false
  private stopping = false
  private exited = false
  private exitCode: number | null = null
  private exitSignal: string | null = null
  private spawnError: Error | null = null
  private stderrTail = ''
  private starting: Promise<number> | null = null
  private startFailure: Error | null = null

  constructor(opts: KiwixServerOptions) {
    this.opts = opts
    this.spawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o))
    this.portFn = opts.findPort ?? (() => findFreePort())
    this.probeFn =
      opts.probe ??
      (async (port) => {
        try {
          const res = await kiwixGet(port, '/catalog/v2/root.xml', {
            timeoutMs: HEALTH_PROBE_TIMEOUT_MS
          })
          return res.status === 200
        } catch {
          return false
        }
      })
  }

  /** The port of a healthy server, or null. */
  port(): number | null {
    return this.ready ? this.currentPort : null
  }

  /** Re-arm after a latched start failure (pack registration changed → worth retrying). */
  resetFailureLatch(): void {
    this.startFailure = null
  }

  /**
   * Ensure the server is running and healthy; resolves with its port. Single-flight;
   * a bind race retries ONCE on a fresh port (the sibling sidecars' TOCTOU rule);
   * any other failure latches until `resetFailureLatch()`.
   */
  async ensureStarted(): Promise<number> {
    if (this.ready && this.currentPort != null && !this.exited) return this.currentPort
    if (this.startFailure) throw this.startFailure
    if (this.starting) return this.starting
    this.starting = (async () => {
      try {
        return await this.doStart()
      } catch (err) {
        if (err instanceof Error && isBindRaceError(err.message)) {
          log.warn('kiwix-serve hit a port-bind race; retrying once on a fresh port')
          return await this.doStart()
        }
        throw err
      }
    })()
    try {
      return await this.starting
    } catch (err) {
      this.startFailure = err instanceof Error ? err : new Error(String(err))
      throw err
    } finally {
      this.starting = null
    }
  }

  private buildArgs(port: number): string[] {
    return [
      '--address',
      LOOPBACK_HOST,
      '--port',
      String(port),
      '--nosearchbar',
      '--blockexternal',
      '--library',
      this.opts.libraryXmlPath
    ]
  }

  private async doStart(): Promise<number> {
    // Same pre-spawn integrity rule as every sidecar: a packaged-build tamper refuses
    // to spawn; dev/legacy installs resolve skip-* and proceed (binary-verifier.ts).
    if ((await verifyBinaryBeforeSpawn(this.opts.binPath)) === 'mismatch') {
      throw new Error('kiwix-serve failed pre-spawn integrity verification')
    }
    this.spawnError = null
    this.exited = false
    this.exitCode = null
    this.exitSignal = null
    this.stderrTail = ''
    this.ready = false
    this.stopping = false
    const port = await this.portFn()
    this.currentPort = port

    const child = this.spawnFn(this.opts.binPath, this.buildArgs(port), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    this.child = child
    registerSidecarChild(child.pid, 'kiwix_tools')
    child.stderr?.on('data', (chunk: unknown) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    child.once('error', (err: unknown) => {
      unregisterSidecarChild(child.pid)
      this.spawnError = err instanceof Error ? err : new Error(String(err))
      this.exited = true
    })
    child.once('exit', (code: unknown, signal: unknown) => {
      unregisterSidecarChild(child.pid)
      this.exited = true
      this.exitCode = typeof code === 'number' ? code : null
      this.exitSignal = typeof signal === 'string' ? signal : null
      if (this.ready && !this.stopping) {
        // Died on its own after being healthy. No auto-restart (MVP): the next ask's
        // ensureStarted() cold-starts it — a read-only content server has no in-flight
        // state worth more machinery.
        this.ready = false
        log.warn(
          `kiwix-serve exited unexpectedly (code ${String(code)}, signal ${String(signal)})`
        )
      }
    })

    await this.waitForHealthy(port)
    this.ready = true
    return port
  }

  private async waitForHealthy(port: number): Promise<void> {
    const timeoutMs = this.opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    const intervalCap = this.opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
    const deadline = Date.now() + timeoutMs
    let interval = Math.min(INITIAL_HEALTH_INTERVAL_MS, intervalCap)
    for (;;) {
      if (this.spawnError) {
        const message = this.spawnError.message
        await this.stop()
        throw new Error(`kiwix-serve failed to launch: ${message}`)
      }
      if (this.exited) {
        this.child = null
        const code =
          this.exitCode != null ? `code ${this.exitCode}` : `signal ${this.exitSignal}`
        throw new Error(
          `kiwix-serve exited before becoming healthy (${code})${this.tailSuffix()}`
        )
      }
      if (await this.probeFn(port)) return
      if (Date.now() >= deadline) {
        await this.stop()
        throw new Error(
          `kiwix-serve did not become healthy within ${timeoutMs}ms${this.tailSuffix()}`
        )
      }
      await delay(interval)
      interval = Math.min(interval * 2, intervalCap)
    }
  }

  private tailSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail ? ` — last output: ${tail}` : ''
  }

  /** Kill the child and wait so no orphan survives (LlamaServer.stop() shape). */
  async stop(): Promise<void> {
    this.stopping = true
    this.ready = false
    const child = this.child
    this.child = null
    this.currentPort = null
    if (!child) return
    if (child.killed || this.exited) return

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    try {
      child.kill()
    } catch {
      // fall through to the grace race + SIGKILL — an orphan would hold the port
    }
    await Promise.race([exited, delay(this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS)])
    if (!this.exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
    }
  }
}
