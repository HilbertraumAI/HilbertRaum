import { log } from '../logging'
import { verifyBinaryBeforeSpawn } from '../binary-verifier'
import {
  LOOPBACK_HOST,
  errnoCode,
  findFreePort,
  registerSidecarChild,
  unregisterSidecarChild,
  type ChildProcessLike,
  type SpawnFn
} from '../runtime/sidecar'
import { spawn as nodeSpawn } from 'node:child_process'
import { kiwixGet } from './client'

/** One `log.warn` per process for a hashless install marker (#339 P8-1, R-1) — never per
 *  start, and never with a path (the sentinel rule). */
let warnedServeSkipLegacy = false

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
// therefore completes its own cleanup and can never flip readiness or the in-flight start
// of a NEWER record — the H3 bug was exactly that cross-talk
// (`this.exited = true` from a superseded child made the live child's health wait throw
// and latched a start failure while the live child was missed by `stop()`).
//
// Each start is handed its OWN immutable library path (`ensureStarted({ libraryXmlPath })`
// — plan §9.15 item 4): the service builds `library.<generation>.xml` per pack revision,
// so a constructor-only path could not serve a new build.
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
 * What kiwix-serve wrote to stderr before a failed start, as a CLASS (#712). The text itself
 * never leaves the child's record: kiwix-serve prints the library file's absolute path when it
 * cannot load it, and again in its non-fatal "is empty" line. That file is the workspace's own
 * `zim-transient/library.<n>.xml`, so the path names the drive and workspace — and on a
 * portable exe run outside a Kit, the Windows account (`C:\Users\<name>\AppData\Roaming\…`).
 *
 * Matched on the pinned build's own wording (kiwix-tools 3.8.1 / libkiwix 14.1.1:
 * `manager.cpp` `Manager::reload`, `kiwix-serve.cpp` `reloadLibrary`, `internalServer.cpp`
 * `InternalServer::start`), captured from the real win-x86_64 binary on 2026-11-08. A pin
 * bump re-measures these two phrases (runtime-sources.yaml, "To bump").
 */
export type KiwixServeOutput = 'none' | 'port-unavailable' | 'library-unreadable' | 'unrecognised'

/** How a start failed: the pre-spawn hash, the spawn itself, an exit before health, the
 *  health window. */
export type KiwixServeStartFailureKind = 'integrity' | 'launch' | 'exit' | 'timeout'

/** `Unable to instantiate the HTTP daemon. The port N is maybe already occupied or need more
 *  permissions to be open. …` — then exit 1. The shared `isBindRaceError` wording is
 *  llama-server's and Node's; kiwix-serve never prints it, so its one retry never fired (#712). */
const PORT_UNAVAILABLE_RE = /Unable to instantiate the HTTP daemon/
/** `ERROR: Failed to load the XML library file '<path>'.` + `Errors encountered while loading
 *  the library.` — then exit 1. On Windows any non-ASCII character in the path ends here: the
 *  narrow argv is decoded as UTF-8. */
const LIBRARY_UNREADABLE_RE = /Failed to load the XML library file|Errors encountered while loading the library/

function classifyServeOutput(tail: string): KiwixServeOutput {
  if (tail.trim() === '') return 'none'
  // The two never print together (the library loads before the server binds). The non-fatal "is
  // empty" line matches neither, so beside a bind failure (measured) it changes nothing.
  if (PORT_UNAVAILABLE_RE.test(tail)) return 'port-unavailable'
  if (LIBRARY_UNREADABLE_RE.test(tail)) return 'library-unreadable'
  return 'unrecognised'
}

/** How long a start that exited waits for the child's `'close'` (its stderr drained) before the
 *  tail is classified — the #530 rule of `runtime/sidecar.ts`: Node may emit `'exit'` while
 *  output is still in the pipe, and the class decides the bind-race retry (#712). A real child
 *  closes within a millisecond or two; the bound only stops a pipe held open elsewhere. */
const STDERR_DRAIN_MS = 100

/** `code N` or `signal S` — one spelling for the message and the logged class. */
function exitDescription(exitCode: number | null, exitSignal: string | null): string {
  return exitCode != null ? `code ${exitCode}` : `signal ${String(exitSignal)}`
}

/**
 * Why a kiwix-serve start failed (#712) — built PATH-FREE and OUTPUT-FREE by construction: the
 * kind, the exit code or signal, the spawn's errno code and the class of what the child printed.
 * It is the error the service latches by pack revision and rethrows on every later ask, and four
 * callers log it, so nothing a later caller does with it can reveal what it never carried.
 */
export class KiwixServeStartError extends Error {
  readonly kind: KiwixServeStartFailureKind
  readonly output: KiwixServeOutput
  readonly exitCode: number | null
  readonly exitSignal: string | null
  readonly launchCode: string | null

  constructor(
    kind: KiwixServeStartFailureKind,
    detail: {
      output?: KiwixServeOutput
      exitCode?: number | null
      exitSignal?: string | null
      launchCode?: string | null
      timeoutMs?: number
    } = {}
  ) {
    const output = detail.output ?? 'none'
    const exitCode = detail.exitCode ?? null
    const exitSignal = detail.exitSignal ?? null
    const launchCode = detail.launchCode ?? null
    const outputSuffix = output === 'none' ? '' : `; output: ${output}`
    let message: string
    switch (kind) {
      case 'integrity':
        message = 'kiwix-serve failed pre-spawn integrity verification'
        break
      case 'launch':
        message = `kiwix-serve failed to launch${launchCode ? ` (${launchCode})` : ''}`
        break
      case 'exit':
        message = `kiwix-serve exited before becoming healthy (${exitDescription(exitCode, exitSignal)})${outputSuffix}`
        break
      case 'timeout':
        message = `kiwix-serve did not become healthy within ${String(detail.timeoutMs)}ms${outputSuffix}`
        break
    }
    super(message)
    this.name = 'KiwixServeStartError'
    this.kind = kind
    this.output = output
    this.exitCode = exitCode
    this.exitSignal = exitSignal
    this.launchCode = launchCode
  }

  /** The compact, path-free class the log carries (`zimErrorClass`): `exit:code 1:library-unreadable`. */
  diagnostic(): string {
    const parts: string[] = [this.kind]
    if (this.kind === 'exit') parts.push(exitDescription(this.exitCode, this.exitSignal))
    if (this.kind === 'launch' && this.launchCode) parts.push(this.launchCode)
    if (this.output !== 'none') parts.push(this.output)
    return parts.join(':')
  }
}

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
  /** Read only to CLASSIFY a failed start (`classifyServeOutput`); never copied into an error or
   *  a log line — it carries the library file's absolute path (#712). */
  stderrTail: string
  /** THIS child's `'close'` (its stderr drained): per record, so a superseded child's late
   *  `'close'` can never mark a retry's pipe as drained. */
  stdioClosed: boolean
  stdioClose: Promise<void>
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
  spawn?: SpawnFn
  findPort?: () => Promise<number>
  /** Probe seam: true when the server answers on `port`. Default hits /catalog/v2/root.xml. */
  probe?: (port: number) => Promise<boolean>
  /** Generation source. `ZimService` passes its own allocator, so builds and children draw
   *  from one service-owned counter (plan §9.15 item 1). */
  allocateGeneration: () => number
  healthTimeoutMs?: number
  healthIntervalMs?: number
  killGraceMs?: number
  forceKillWaitMs?: number
  /** Called once for each child the bounded kill could not confirm stopped (plan §9.15 item 6),
   *  with the build it was given and its own terminal event: `settled` resolves if the child's
   *  exit is observed later. Until then the caller must not delete that build (#713). */
  onUnconfirmedChild?: (libraryXmlPath: string, settled: Promise<void>) => void
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
  private readonly allocateGeneration: () => number
  private readonly killGraceMs: number
  private readonly forceKillWaitMs: number

  /** The published child, or null (never started / died on its own / torn down). */
  private activeRecord: ChildRecord | null = null
  private starting: StartEntry | null = null
  /** Single-flight teardown (the translation `teardownPromise` shape). */
  private teardownPromise: Promise<void> | null = null

  constructor(opts: KiwixServerOptions) {
    this.opts = opts
    this.spawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o))
    this.portFn = opts.findPort ?? ((): Promise<number> => findFreePort())
    this.allocateGeneration = opts.allocateGeneration
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

  private liveRecord(): ChildRecord | null {
    const record = this.activeRecord
    if (!record || !record.healthy || record.settled) return null
    return record
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
   * down first; any other failure rejects. Nothing here latches: the SERVICE latches a failed
   * start by pack revision (plan §9.15 item 7).
   */
  async ensureStarted(cfg: { libraryXmlPath: string; signal?: AbortSignal }): Promise<KiwixServerStart> {
    // Never race a teardown: join it, then start fresh (a `suspend()` must be able to be
    // followed by a lazy restart — this is not a latch).
    if (this.teardownPromise) await this.teardownPromise
    const { libraryXmlPath } = cfg
    if (cfg.signal?.aborted) throw abortError('kiwix-serve start aborted')

    const live = this.liveRecord()
    if (live && live.libraryXmlPath === libraryXmlPath) {
      return { port: live.port, generation: live.generation }
    }
    if (this.starting?.libraryXmlPath === libraryXmlPath) return this.starting.promise
    if (this.starting || live) {
      // A different configuration is wanted: the old one must be gone before the new spawn.
      await this.stop()
      // #554: a cancel during that teardown fired its one 'abort' before the subscription
      // below exists, so check again or the new child spawns anyway.
      if (cfg.signal?.aborted) throw abortError('kiwix-serve start aborted')
    }

    const abort = new AbortController()
    const forward = (): void => abort.abort()
    cfg.signal?.addEventListener('abort', forward, { once: true })
    const entry: StartEntry = {
      libraryXmlPath,
      promise: this.runStart(libraryXmlPath, abort.signal),
      abort
    }
    this.starting = entry
    try {
      return await entry.promise
    } finally {
      cfg.signal?.removeEventListener('abort', forward)
      if (this.starting === entry) this.starting = null
    }
  }

  private async runStart(libraryXmlPath: string, signal: AbortSignal): Promise<KiwixServerStart> {
    try {
      return await this.doStart(libraryXmlPath, signal)
    } catch (err) {
      // TOCTOU between findFreePort() and bind: retry ONCE on a fresh port and a fresh
      // generation. `doStart` has already torn its own record down before rejecting. Read from
      // the classified output, never from the message — the message carries no output (#712).
      if (err instanceof KiwixServeStartError && !signal.aborted && err.output === 'port-unavailable') {
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
    const verdict = await verifyBinaryBeforeSpawn(this.opts.binPath)
    if (verdict === 'mismatch') {
      throw new KiwixServeStartError('integrity')
    }
    // #339 P8-1: an in-app install records a hash for kiwix-serve, so `skip-legacy` now means
    // exactly one thing — a bundle placed by hand with no marker. Say so once per process, the
    // way `tools.ts` does for kiwix-manage, so the R-1 closure is auditable for BOTH binaries.
    if (verdict === 'skip-legacy' && !warnedServeSkipLegacy) {
      warnedServeSkipLegacy = true
      log.warn('hashless install marker — kiwix-serve integrity not verified (a hand-placed bundle; R-1)')
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
      stdioClosed: false,
      stdioClose: Promise.resolve(),
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
      throw new KiwixServeStartError('launch', { launchCode: errnoCode(record.spawnError) })
    }
    record.child = child
    record.pid = child.pid
    registerSidecarChild(child.pid, 'kiwix_tools')

    child.stderr?.on('data', (chunk: unknown) => {
      record.stderrTail = (record.stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    record.stdioClose = new Promise<void>((resolve) => {
      child.once('close', () => {
        record.stdioClosed = true
        resolve()
      })
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
        const launchCode = errnoCode(record.spawnError)
        await this.killRecord(record)
        throw new KiwixServeStartError('launch', { launchCode })
      }
      if (record.exited) {
        // The class decides the bind-race retry, so the tail must be complete (#530's rule).
        await this.awaitStderrDrain(record)
        throw new KiwixServeStartError('exit', {
          exitCode: record.exitCode,
          exitSignal: record.exitSignal,
          output: classifyServeOutput(record.stderrTail)
        })
      }
      if (await this.probeFn(record.port)) return
      if (Date.now() >= deadline) {
        await this.killRecord(record)
        throw new KiwixServeStartError('timeout', {
          timeoutMs,
          output: classifyServeOutput(record.stderrTail)
        })
      }
      await delay(interval)
      interval = Math.min(interval * 2, intervalCap)
    }
  }

  /** Wait, bounded by `STDERR_DRAIN_MS`, for THIS child's `'close'` after an early `'exit'`. */
  private async awaitStderrDrain(record: ChildRecord): Promise<void> {
    if (record.stdioClosed || !record.child?.stderr) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([record.stdioClose, new Promise<void>((resolve) => (timer = setTimeout(resolve, STDERR_DRAIN_MS)))])
    clearTimeout(timer)
  }

  /**
   * Bounded, record-level kill (plan §9.15 items 6b–6d). SIGTERM → grace → SIGKILL →
   * bounded wait → the FAILURE POLICY: mark `uncertain`, leave the PID in the reaper
   * registry, report the child and its build to `onUnconfirmedChild` (the caller keeps that
   * file until the child's own exit is observed, #713), warn once (generation + PID only —
   * never a title or a path, the sentinel rule) and RESOLVE. Worst case
   * `killGraceMs + forceKillWaitMs`.
   *
   * A failing start calls THIS, never `stop()` — `stop()` awaits `this.starting`, which is
   * the failing start itself (the self-await deadlock of plan §9.15 item 7).
   */
  private async killRecord(record: ChildRecord): Promise<void> {
    const child = record.child
    if (!child) {
      // Nothing was ever created (synchronous spawn throw): terminal by construction.
      if (!record.settled) {
        record.settled = true
        unregisterSidecarChild(record.pid)
      }
      return
    }
    if (record.settled) return
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
    if (record.settled) return
    record.forceKillSent = true
    try {
      child.kill('SIGKILL')
    } catch {
      /* best-effort */
    }
    await Promise.race([record.terminal, delay(this.forceKillWaitMs)])
    if (record.settled) return
    record.uncertain = true
    log.warn(
      `kiwix-serve generation ${record.generation} (pid ${String(record.pid)}) could not be ` +
        'confirmed stopped within the teardown bound; it stays registered for the crash reaper'
    )
    // Every unconfirmed child is reported, an aborted start's included, so its build is kept
    // whichever path tore it down.
    this.opts.onUnconfirmedChild?.(record.libraryXmlPath, record.terminal)
  }

  /**
   * Kill the current child and wait, bounded, so no orphan survives — SINGLE-FLIGHT
   * (the translation `teardown()` shape): an overlapping stop SHARES this pass instead of
   * running a no-op second body that would resolve while the first is still inside its
   * SIGTERM→SIGKILL window. Non-latching: a later `ensureStarted()` may
   * start again (the permanent quit latch lives on `ZimService`).
   */
  stop(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise
    const run = this.doTeardown().finally(() => {
      this.teardownPromise = null
    })
    this.teardownPromise = run
    return run
  }

  private async doTeardown(): Promise<void> {
    // Abort an in-flight start rather than wait it out (#159 / the translation rule): the
    // child is killed inside its own health wait and the start rejects AbortError.
    const starting = this.starting
    if (starting) {
      starting.abort.abort()
      await starting.promise.catch(() => undefined)
    }
    const record = this.activeRecord
    this.activeRecord = null
    if (record) await this.killRecord(record)
  }
}
