import { log } from '../logging'
import { verifyBinaryBeforeSpawn, type BinaryVerifyResult } from '../binary-verifier'
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
// pre-spawn verification, same crash-reap registration — minus everything model-specific
// (no API key: the server is loopback-bound, read-only, and serves non-secret archive
// content; no GPU ladder; no idle teardown — measured RSS with three books loaded is
// ~52 MB, spike 2026-08-22).
//
// Start is lazy (first ask that needs a pack) and single-flight per library path.
//
// PER-CHILD RECORDS (#301 P3a, finding H3; plan §9.15 item 2). This class keeps NO
// per-child mutable state on `this`: every spawn produces a `ChildRecord` and the
// `error`/`exit`/`stderr` handlers close over THAT record and write only to it. An
// obsolete child's late `exit`, a late `error`, a late health poll or a late `finally`
// therefore completes its own cleanup and can never flip readiness, the failure latch or
// the in-flight start of a NEWER record — the H3 bug was exactly that cross-talk
// (`this.exited = true` from a superseded child made the live child's health wait throw
// and latched a start failure while the live child was missed by `stop()`).
//
// Each start is handed its OWN immutable library path (`ensureStarted({ libraryXmlPath })`
// — plan §9.15 item 4): the service builds `library.<generation>.xml` per pack revision,
// so a constructor-only path could not serve a new build. The constructor path survives
// only as the DEFAULT for the compatibility tests.
//
// Teardown is single-flight and SELF-BOUNDED (plan §9.15 item 6, the translation
// `teardown()`/`doTeardown()` shape): abort the in-flight start, SIGTERM, grace, SIGKILL,
// bounded wait; a child that still cannot be confirmed dead is marked `uncertain`, KEEPS
// its PID in the crash-reap registry and is reported as such — the teardown resolves
// instead of hanging a lock or a quit.

const STDERR_TAIL_MAX = 4_000
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000
const INITIAL_HEALTH_INTERVAL_MS = 50
const DEFAULT_HEALTH_INTERVAL_MS = 250
const HEALTH_PROBE_TIMEOUT_MS = 3_000
/** SIGTERM → this grace → SIGKILL (plan §9.15 item 6). */
const DEFAULT_KILL_GRACE_MS = 2_000
/** SIGKILL → this bounded wait → `uncertain` (plan §9.15 item 6). Worst case 5 s per child. */
const DEFAULT_FORCE_KILL_WAIT_MS = 3_000

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The `AbortError` shape `isStartAbortError` (runtime/sidecar.ts) recognises — the #159
 *  convention, reused for every cancellation seam of the ZIM service. */
const abortError = (message: string): DOMException => new DOMException(message, 'AbortError')

/**
 * Module-level generation allocator — the DEFAULT for a `KiwixServer` constructed without
 * one. Production passes `ZimService.nextGeneration`, so builds and children draw from a
 * single service-owned counter (plan §9.15 item 1); this fallback keeps the standalone
 * compatibility tests (`zim-serve.test.ts`) working unchanged.
 */
let moduleGeneration = 0

/**
 * Everything one spawned child owns. The only mutable state of a start; `this.activeRecord`
 * is merely a pointer to the record that is currently PUBLISHED as the server.
 */
export interface ChildRecord {
  /** Monotonic, service-observable, never reused in a process (plan §9.15 item 1). */
  readonly generation: number
  /** The immutable `library.<build>.xml` this child was spawned with. */
  readonly libraryXmlPath: string
  readonly port: number
  /** null when `spawnFn` threw synchronously — nothing was created, nothing to kill. */
  child: ChildProcessLike | null
  pid: number | undefined
  /** The child emitted `exit`. NEVER inferred from `child.killed` (LlamaServer.stop()'s rule). */
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  /** The child emitted `error` (a spawn failure may never emit `exit`). */
  spawnError: Error | null
  stderrTail: string
  /** The health probe succeeded and this record was published as the server. */
  healthy: boolean
  killSent: boolean
  forceKillSent: boolean
  /** SIGKILL + the bounded wait expired without a terminal state: the PID stays registered. */
  uncertain: boolean
  /** True once `exit` OR `error` arrived (or the child never existed) — "terminal state". */
  settled: boolean
  /** Resolves on the first terminal event; the only place `unregisterSidecarChild` runs. */
  readonly terminal: Promise<void>
}

export interface KiwixServerOptions {
  binPath: string
  /**
   * DEFAULT library path for an `ensureStarted()` call that passes no `cfg`. Production
   * always passes the path per start (plan §9.15 item 4); this option exists so the
   * standalone compatibility tests keep constructing a server without a service.
   */
  libraryXmlPath?: string
  spawn?: SpawnFn
  findPort?: () => Promise<number>
  /** Probe seam: true when the server answers on `port`. Default hits /catalog/v2/root.xml. */
  probe?: (port: number) => Promise<boolean>
  /** Pre-spawn integrity seam (the LlamaServer shape). Default `verifyBinaryBeforeSpawn`. */
  verifyBinary?: (binPath: string) => Promise<BinaryVerifyResult>
  /** Generation source; default a module counter. `ZimService` passes its own allocator. */
  allocateGeneration?: () => number
  healthTimeoutMs?: number
  healthIntervalMs?: number
  killGraceMs?: number
  forceKillWaitMs?: number
}

/** What one start publishes to its callers. */
export interface KiwixServerStart {
  port: number
  generation: number
}

interface StartEntry {
  readonly libraryXmlPath: string
  readonly promise: Promise<KiwixServerStart>
  readonly abort: AbortController
}

export class KiwixServer {
  private readonly opts: KiwixServerOptions
  private readonly spawnFn: SpawnFn
  private readonly portFn: () => Promise<number>
  private readonly probeFn: (port: number) => Promise<boolean>
  private readonly verifyFn: (binPath: string) => Promise<BinaryVerifyResult>
  private readonly allocateGeneration: () => number
  private readonly killGraceMs: number
  private readonly forceKillWaitMs: number

  /** The published child, or null (never started / died on its own / torn down). */
  private activeRecord: ChildRecord | null = null
  private starting: StartEntry | null = null
  /** Instance failure latch — compatibility only; the SERVICE latches by revision (item 7). */
  private startFailure: Error | null = null
  /** Single-flight teardown (the translation `teardownPromise`/`tearingDown` pair). */
  private teardownPromise: Promise<void> | null = null
  private tearingDown = false
  /** True when the LAST teardown could not confirm a terminal state (plan §9.15 item 6):
   *  the caller must NOT delete the build that child was given, and must report
   *  "cleanup not confirmed" rather than "complete". */
  private uncertainTeardown = false
  /** How many children of this server could NEVER be confirmed dead (monotonic). Each one
   *  left a registered PID for the crash reaper and a build file that must not be removed. */
  private unconfirmed = 0

  constructor(opts: KiwixServerOptions) {
    this.opts = opts
    this.spawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o))
    this.portFn = opts.findPort ?? ((): Promise<number> => findFreePort())
    this.verifyFn = opts.verifyBinary ?? verifyBinaryBeforeSpawn
    this.allocateGeneration = opts.allocateGeneration ?? ((): number => ++moduleGeneration)
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.forceKillWaitMs = opts.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS
    this.probeFn =
      opts.probe ??
      (async (port): Promise<boolean> => {
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

  // ---- accessors (the coherent view P5's alive/generation guard consumes) ----------

  /** The port of a healthy, live server, or null. */
  port(): number | null {
    const record = this.liveRecord()
    return record ? record.port : null
  }

  /** The generation of the live child, or null. Monotonic for the process; a crash
   *  restart under the same library build shows a NEW generation. */
  generation(): number | null {
    return this.liveRecord()?.generation ?? null
  }

  /** True when a published child exists and has not reached a terminal state. */
  alive(): boolean {
    return this.liveRecord() !== null
  }

  /** The published child's coherent tuple, or null. */
  current(): { port: number; generation: number; libraryXmlPath: string } | null {
    const record = this.liveRecord()
    if (!record) return null
    return {
      port: record.port,
      generation: record.generation,
      libraryXmlPath: record.libraryXmlPath
    }
  }

  /** Did the most recent teardown end WITHOUT a confirmed terminal state? Then the PID is
   *  still registered for the reaper and the build's XML must be kept (plan §9.15 item 6). */
  lastStopUncertain(): boolean {
    return this.uncertainTeardown
  }

  /** Monotonic count of children this server could never confirm dead. Sticky evidence for
   *  a caller that must not clear a transient directory (plan §9.15 items 6 and 10). */
  unconfirmedChildren(): number {
    return this.unconfirmed
  }

  private liveRecord(): ChildRecord | null {
    const record = this.activeRecord
    if (!record || !record.healthy || record.settled) return null
    return record
  }

  /** Re-arm after a latched start failure (pack registration changed → worth retrying).
   *  Compatibility surface: the service's own revision-keyed latch is the real one. */
  resetFailureLatch(): void {
    this.startFailure = null
  }

  /**
   * Ensure a healthy server for `cfg.libraryXmlPath`; resolves its port AND generation.
   *
   * - A healthy current child spawned with the SAME path is returned as is.
   * - An in-flight start for the SAME path is JOINED (single-flight).
   * - A live child or in-flight start for a DIFFERENT path is SUPERSEDED (`stop()` first).
   *   Defensive only: `ZimService` serializes rebuild/teardown/start on one chain.
   *
   * A bind race retries ONCE on a fresh port AND a fresh generation, the first record torn
   * down first; any other failure latches until `resetFailureLatch()`.
   */
  async ensureStarted(cfg?: {
    libraryXmlPath?: string
    signal?: AbortSignal
  }): Promise<KiwixServerStart> {
    // Never race a teardown: join it, then start fresh (a `suspend()` must be able to be
    // followed by a lazy restart — this is not a latch).
    if (this.teardownPromise) await this.teardownPromise
    const libraryXmlPath = cfg?.libraryXmlPath ?? this.opts.libraryXmlPath
    if (!libraryXmlPath) {
      throw new Error('kiwix-serve needs a library.xml path (none passed, none configured)')
    }
    if (cfg?.signal?.aborted) throw abortError('kiwix-serve start aborted')

    const live = this.liveRecord()
    if (live && live.libraryXmlPath === libraryXmlPath) {
      return { port: live.port, generation: live.generation }
    }
    if (this.starting?.libraryXmlPath === libraryXmlPath) return this.starting.promise
    if (this.starting || live) {
      // A different configuration is wanted: the old one must be gone before the new spawn.
      await this.stop()
    }
    if (this.startFailure) throw this.startFailure

    const abort = new AbortController()
    const forward = (): void => abort.abort()
    cfg?.signal?.addEventListener('abort', forward, { once: true })
    const entry: StartEntry = {
      libraryXmlPath,
      promise: this.runStart(libraryXmlPath, abort.signal),
      abort
    }
    this.starting = entry
    try {
      return await entry.promise
    } catch (err) {
      // An ABORTED start never latches (the translation rule): the pack set or the session
      // moved on, which says nothing about whether this binary can serve.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.startFailure = err instanceof Error ? err : new Error(String(err))
      }
      throw err
    } finally {
      cfg?.signal?.removeEventListener('abort', forward)
      if (this.starting === entry) this.starting = null
    }
  }

  private async runStart(libraryXmlPath: string, signal: AbortSignal): Promise<KiwixServerStart> {
    try {
      return await this.doStart(libraryXmlPath, signal)
    } catch (err) {
      // TOCTOU between findFreePort() and bind: retry ONCE on a fresh port and a fresh
      // generation. `doStart` has already torn its own record down before rejecting.
      if (err instanceof Error && !signal.aborted && isBindRaceError(err.message)) {
        log.warn('kiwix-serve hit a port-bind race; retrying once on a fresh port')
        return await this.doStart(libraryXmlPath, signal)
      }
      throw err
    }
  }

  private buildArgs(record: ChildRecord): string[] {
    return [
      '--address',
      LOOPBACK_HOST,
      '--port',
      String(record.port),
      '--nosearchbar',
      '--blockexternal',
      '--library',
      record.libraryXmlPath
    ]
  }

  private async doStart(libraryXmlPath: string, signal: AbortSignal): Promise<KiwixServerStart> {
    const generation = this.allocateGeneration()
    // Same pre-spawn integrity rule as every sidecar: a packaged-build tamper refuses
    // to spawn; dev/legacy installs resolve skip-* and proceed (binary-verifier.ts).
    if ((await this.verifyFn(this.opts.binPath)) === 'mismatch') {
      throw new Error('kiwix-serve failed pre-spawn integrity verification')
    }
    // Recheck 1 (plan §9.15 item 1) — after the verification.
    if (signal.aborted) throw abortError('kiwix-serve start aborted after verification')
    const port = await this.portFn()
    // Recheck 2 — after port allocation.
    if (signal.aborted) throw abortError('kiwix-serve start aborted after port allocation')

    let settleTerminal = (): void => {}
    const record: ChildRecord = {
      generation,
      libraryXmlPath,
      port,
      child: null,
      pid: undefined,
      exited: false,
      exitCode: null,
      exitSignal: null,
      spawnError: null,
      stderrTail: '',
      healthy: false,
      killSent: false,
      forceKillSent: false,
      uncertain: false,
      settled: false,
      terminal: new Promise<void>((resolve) => {
        settleTerminal = resolve
      })
    }
    // The ONLY place a PID leaves the crash-reap registry (plan §9.15 item 2): a child we
    // could not confirm dead must stay reapable, so `stop()` never unregisters.
    const reachTerminal = (): void => {
      if (record.settled) return
      record.settled = true
      unregisterSidecarChild(record.pid)
      settleTerminal()
    }

    let child: ChildProcessLike
    try {
      child = this.spawnFn(this.opts.binPath, this.buildArgs(record), {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      // Synchronous spawn throw: no child, no PID, nothing to kill (plan §9.15 item 7).
      record.spawnError = err instanceof Error ? err : new Error(String(err))
      reachTerminal()
      throw new Error(`kiwix-serve failed to launch: ${record.spawnError.message}`)
    }
    record.child = child
    record.pid = child.pid
    registerSidecarChild(child.pid, 'kiwix_tools')

    child.stderr?.on('data', (chunk: unknown) => {
      record.stderrTail = (record.stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    child.once('error', (err: unknown) => {
      record.spawnError = err instanceof Error ? err : new Error(String(err))
      if (this.activeRecord === record) this.activeRecord = null
      reachTerminal()
    })
    child.once('exit', (code: unknown, exitSignal: unknown) => {
      record.exited = true
      record.exitCode = typeof code === 'number' ? code : null
      record.exitSignal = typeof exitSignal === 'string' ? exitSignal : null
      // The ONE server-level guard an obsolete record is allowed to evaluate: a late exit
      // from a superseded child leaves the CURRENT record untouched (H3).
      if (this.activeRecord === record) {
        this.activeRecord = null
        if (record.healthy && !record.killSent) {
          // Died on its own after being healthy. No auto-restart (MVP): the next ask
          // cold-starts a NEW generation over the same library build — a read-only
          // content server has no in-flight state worth more machinery.
          log.warn(
            `kiwix-serve exited unexpectedly (code ${String(code)}, signal ${String(exitSignal)})`
          )
        }
      }
      reachTerminal()
    })

    await this.waitForHealthy(record, signal)
    // Recheck 3 — the probe succeeded, but the start may have been superseded while it ran.
    // Publishing here is exactly the H3 "an old probe releases true after stop()" bug.
    if (signal.aborted || record.killSent || record.settled) {
      await this.killRecord(record)
      throw abortError('kiwix-serve start aborted after the health probe')
    }
    record.healthy = true
    this.activeRecord = record
    return { port: record.port, generation: record.generation }
  }

  /** Poll THIS record's own state (never `this.*`) plus the probe, the deadline and the signal. */
  private async waitForHealthy(record: ChildRecord, signal: AbortSignal): Promise<void> {
    const timeoutMs = this.opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    const intervalCap = this.opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
    const deadline = Date.now() + timeoutMs
    let interval = Math.min(INITIAL_HEALTH_INTERVAL_MS, intervalCap)
    for (;;) {
      if (signal.aborted) {
        // Cooperative cancellation: kill the child we spawned, then reject AbortError —
        // a lock/quit no longer waits out the whole health window (plan §9.15 item 6a).
        await this.killRecord(record)
        throw abortError('kiwix-serve start aborted while waiting for health')
      }
      if (record.spawnError) {
        const message = record.spawnError.message
        await this.killRecord(record)
        throw new Error(`kiwix-serve failed to launch: ${message}`)
      }
      if (record.exited) {
        const code =
          record.exitCode != null ? `code ${record.exitCode}` : `signal ${record.exitSignal}`
        throw new Error(`kiwix-serve exited before becoming healthy (${code})${tailSuffix(record)}`)
      }
      if (await this.probeFn(record.port)) return
      if (Date.now() >= deadline) {
        await this.killRecord(record)
        throw new Error(
          `kiwix-serve did not become healthy within ${timeoutMs}ms${tailSuffix(record)}`
        )
      }
      await delay(interval)
      interval = Math.min(interval * 2, intervalCap)
    }
  }

  /**
   * Bounded, record-level kill (plan §9.15 items 6b–6d). SIGTERM → grace → SIGKILL →
   * bounded wait → the FAILURE POLICY: mark `uncertain`, leave the PID in the reaper
   * registry, keep the build's XML, warn once (generation + PID only — never a title or a
   * path, the sentinel rule) and RESOLVE. Worst case `killGraceMs + forceKillWaitMs`.
   *
   * A failing start calls THIS, never `stop()` — `stop()` awaits `this.starting`, which is
   * the failing start itself (the self-await deadlock of plan §9.15 item 7).
   *
   * Returns true when a terminal state was confirmed.
   */
  private async killRecord(record: ChildRecord): Promise<boolean> {
    const child = record.child
    if (!child) {
      // Nothing was ever created (synchronous spawn throw): terminal by construction.
      if (!record.settled) {
        record.settled = true
        unregisterSidecarChild(record.pid)
      }
      return true
    }
    if (record.settled) return true
    record.killSent = true
    try {
      child.kill()
    } catch {
      // kill() itself threw (already-dead child, EPERM): do NOT bail — a surviving orphan
      // would still hold the port. Fall through to the grace race and the SIGKILL.
    }
    await Promise.race([record.terminal, delay(this.killGraceMs)])
    // Gate on the exit listener's flag, NEVER on `child.killed` (it is true the moment a
    // signal is SENT, which would skip the escalation entirely — LlamaServer.stop()'s rule).
    if (record.settled) return true
    record.forceKillSent = true
    try {
      child.kill('SIGKILL')
    } catch {
      /* best-effort */
    }
    await Promise.race([record.terminal, delay(this.forceKillWaitMs)])
    if (record.settled) return true
    record.uncertain = true
    this.unconfirmed++
    // A child killed by an ABORTED start (the cooperative-cancellation step of a teardown)
    // counts against THAT teardown too: a stop() whose child ended here reports 'not
    // confirmed', never 'complete'.
    if (this.tearingDown) this.uncertainTeardown = true
    log.warn(
      `kiwix-serve generation ${record.generation} (pid ${String(record.pid)}) could not be ` +
        'confirmed stopped within the teardown bound; it stays registered for the crash reaper'
    )
    return false
  }

  /**
   * Kill the current child and wait, bounded, so no orphan survives — SINGLE-FLIGHT
   * (the translation `teardown()` shape): an overlapping stop SHARES this pass instead of
   * running a no-op second body whose `finally` would clear the flags while the first is
   * still inside its SIGTERM→SIGKILL window. Non-latching: a later `ensureStarted()` may
   * start again (the permanent quit latch lives on `ZimService`).
   */
  stop(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise
    this.tearingDown = true
    const run = this.doTeardown().finally(() => {
      this.tearingDown = false
      this.teardownPromise = null
    })
    this.teardownPromise = run
    return run
  }

  private async doTeardown(): Promise<void> {
    this.uncertainTeardown = false
    // Abort an in-flight start rather than wait it out (#159 / the translation rule): the
    // child is killed inside its own health wait and the start rejects AbortError.
    const starting = this.starting
    if (starting) {
      starting.abort.abort()
      await starting.promise.catch(() => undefined)
    }
    const record = this.activeRecord
    this.activeRecord = null
    if (record) {
      const confirmed = await this.killRecord(record)
      if (!confirmed) this.uncertainTeardown = true
    }
  }
}

function tailSuffix(record: ChildRecord): string {
  const tail = record.stderrTail.trim()
  return tail ? ` — last output: ${tail}` : ''
}
