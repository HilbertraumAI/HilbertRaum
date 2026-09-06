import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import type { KnowledgePack, KnowledgePacksChangedEvent } from '../../../shared/types'
import type { Db } from '../db'
import { log } from '../logging'
import { resolveZimDir } from '../drive'
import type { BinaryVerifyResult } from '../binary-verifier'
import type { SpawnFn } from '../runtime/sidecar'
import type { ExternalRetrievalArm } from '../rag'
import { collectPackCandidates } from './arm'
import { fetchArticleHtml } from './client'
import { zimArticleToSegmentsAsync } from './html'
import {
  listPacks,
  reconcile,
  registerPack,
  removePack,
  retrievablePacks,
  servedCandidates,
  setPackEnabled,
  writeLibraryXml,
  type PackDeps
} from './packs'
import { computeServedSet, type ServingNameCollision } from './identity'
import { KiwixServer } from './serve'
import { kiwixManageAdd, resolveKiwixManagePath, resolveKiwixServePath } from './tools'
import type { PlaintextOpKind, PlaintextOpsRegistry } from '../ingestion/plaintext-ops'
import {
  ZIM_TRANSIENT_DIR_NAME,
  cleanupZimTransients,
  sweepZimTransientDir,
  type ZimCleanupReport
} from './transients'

// ZimService — the knowledge-packs facade the IPC layer and the RAG ask path talk to.
// Owns: kiwix-tools resolution, the (lazy, single) kiwix-serve instance, the generated
// library builds, registration wrappers that invalidate the running server, the retrieval
// arm factory, and the article read for the citation viewer.
//
// GENERATIONS AND PUBLICATION (#301 P3a, findings H3/M2; plan §9.15). The service publishes
// ONE coherent configuration per pack revision:
//
//     Published = { revision, build, generation, port, library.<build>.xml }
//
// - `packRevision` is bumped SYNCHRONOUSLY by every pack-set mutation (register / discover /
//   remove / enable). "Desired revision" is the value an `ensureServer` call reads before its
//   first await; every recheck compares against it.
// - ONE monotonic allocator (`nextGeneration`) hands out generations to library BUILDS and to
//   kiwix-serve CHILDREN alike, so no generation ever repeats in the process: a build takes
//   g₁ and writes `library.<g₁>.xml`, its first child takes g₂, a bind-race retry g₃, a
//   natural-crash restart g₄ (same XML — the pack set did not change, so the build is current).
//   P5's alive/generation request guard consumes this through `serverState()`.
// - ONE promise chain (`chain`) carries every library rebuild, teardown and start in FIFO
//   order, so there is exactly ONE writer of library files at any time and no two builds
//   share a path — the M2 lost-update bug ("two callers both run writeLibraryXml on the same
//   path; a parked rebuild clears the staleness flag set by a NEWER invalidation") cannot
//   occur: staleness is a revision comparison, not a boolean.
// - A start captures { revision, signal, admissionEpoch } before its first await and rechecks
//   after the manager work and immediately before publishing (the server rechecks its own
//   signal after verification, port allocation and the health probe). A stale build deletes
//   ITS OWN file and yields; the caller re-loops under the current revision.
//
// Concurrent asks SHARE one start (`starting`); a cancelled ask stops waiting without
// cancelling the start (another live waiter may still consume it). Only `invalidateLibrary()`,
// `suspend()` and `stop()` abort the shared start, and then every waiter rejects `AbortError`.
//
// OPERATIONS AND ADMISSION (#301 P3b, finding H4; plan §9.17 (a)). Every entry point — the
// ask's arm, an article read, a registration, the discovery pass, the user's remove/enable —
// runs as a REGISTERED operation: `beginOp(kind, parent?)` captures the workspace's unlock
// epoch and registers with `ctx.zimOps` (the second `createPlaintextOps` instance), and its
// `assert()` re-checks admission, the epoch and its own cancellation after EVERY await and
// immediately before EVERY database write and EVERY content return, with `release()` in a
// `finally`. Lock and quit abort that registry, so a picker, an article read or a discovery
// pass that straddles the boundary is refused instead of writing into the closing session (or
// into the NEXT one after a lock + unlock — the epoch catches that half). The service, not the
// handler, owns the operations because it is the one place that knows the transient paths to
// `track()`. Without a registry (tests, partial contexts) an operation is a local no-op whose
// signal is the caller's own.
//
// IDENTITY, RECONCILIATION AND ROUTES (#301 P3b, findings M5/L4/L7; plan §9.17 (d)/(e)1). A
// pack IS its archive UUID: every resolve reads the file's 80-byte header and compares it to
// the row, at library-build time as well as on a read. The published configuration therefore
// carries the identity-checked SERVING MAP as part of the same object —
//
//     Published = { revision, build, generation, port, library.<build>.xml, names, excluded }
//
// — where `names` is pack id → the name kiwix-serve answers to (libkiwix's own slug rule) and
// `excluded` names the packs left OUT of the library because an earlier UUID already owns their
// name. The arm and the viewer resolve their route from `names`, never from a filename stem.
// The citation locator stays `packId + articlePath` with NO route hint (plan §9.17 (d)8): the
// service resolves the route on read against the CURRENT map, so an old citation, a renamed
// file, a restart and a drive-letter change all work, and a renderer can never select another
// book. `listPacks` is a pure database read; the one filesystem pass is `reconcile()`, which is
// single-flight and runs at session start and on an explicit Refresh.
//
// THE REQUEST GUARD (#301 P5, finding M1; plan §9.19 (a)). Every request the ask arm and the
// article viewer send to kiwix-serve runs inside `withServer(db, op, request)`. It captures the
// published tuple — revision, generation, port, alive — BEFORE the request and reads it again
// AFTER the response, and a response observed across a change of that tuple is DISCARDED
// whatever it contained, including a successful body: the port may have been answered by a
// process that is not our child. The whole attempt is discarded, not merely the failed call
// inside it — the arm's search-and-fetch batch is one guard window, because candidates
// collected before an unnoticed death cannot be told apart from a squatter's. A discarded
// attempt is retried EXACTLY ONCE, and only while the same unlocked session still admits the
// operation and it was not cancelled; the retry re-enters from `ensureServer`, so eligibility is
// recomputed under the CURRENT revision and the callback is handed the NEW `ServedLibrary` (a
// caller must therefore derive its pack list inside the callback, never from a list captured
// before the first attempt). A second discard rejects with `StaleServerError` — an ORDINARY
// error, so a caller can turn it into an honest per-ask outcome, while every admission or
// cancellation refusal stays the #159 `AbortError`.
//
// What the guard is NOT: it detects an OBSERVED LIFECYCLE CHANGE of this app's own child; it
// does not authenticate the server, because kiwix-serve has no request authentication upstream
// (owner ruling D1(a), residual R-9). The windows it leaves — the initial bind race, a delayed
// `exit` notification, and a same-user process that can bind a port a live child already holds —
// are named in `docs/security-model.md` "kiwix-serve — the one unauthenticated sidecar".
//
// TRANSIENT FILES (#301 P3b, findings L3/M4, residual R-7; plan §9.17 (c)). Nothing about the
// user's pack collection persists outside the workspace database EXCEPT the transient library
// builds under `<workspacePath>/zim-transient/` — `library.<build>.xml` (served builds) and
// `meta-<n>/library.xml` (registration throwaways) — which are PLAINTEXT while present and are
// removed at lock, at quit and at every session start (`transients.ts`, contained and
// link-refusing). The file of a child whose death could not be confirmed is KEPT and reported,
// and removed by the next session start.

/** How many times one `ensureServer` call re-loops under a newly current revision before
 *  giving up: a pack set that keeps changing must not spin. */
const MAX_ENSURE_ATTEMPTS = 3

const abortError = (message: string): DOMException => new DOMException(message, 'AbortError')

/** Internal: the build this operation produced is no longer current. Not an abort — the
 *  caller re-loops under the current revision instead of failing the ask. */
class StaleBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleBuildError'
  }
}

/** Why the request guard discarded an attempt (#301 P5, plan §9.19 (a)4). */
export type StaleServerReason = 'child-died' | 'generation-changed' | 'unpublished'

/**
 * Two consecutive attempts were both observed across a lifecycle change of the pack server
 * (#301 P5, finding M1). Deliberately an ORDINARY error, never an `AbortError`: the workspace
 * still admits the work, so the caller reports "the pack server restarted during this question"
 * rather than treating it as a cancellation. `retrieve()`'s arm catch swallows it and the
 * `packs:getArticle` handler's catch turns it into the viewer's honest "unavailable" null.
 */
export class StaleServerError extends Error {
  readonly reason: StaleServerReason
  constructor(reason: StaleServerReason, message: string) {
    super(message)
    this.name = 'StaleServerError'
    this.reason = reason
  }
}

/** Test seams for the whole service (plan §9.15 item 11). Absent in production. */
export interface ZimServiceDeps {
  /** Replaces the on-drive binary resolution. Null ⇒ "kiwix-tools is not installed". */
  resolveTools?: () => { serve: string; manage: string } | null
  /** Spawn seam for kiwix-serve. */
  spawn?: SpawnFn
  /** Spawn seam for kiwix-manage (defaults to `spawn`). */
  manageSpawn?: SpawnFn
  findPort?: () => Promise<number>
  probe?: (port: number) => Promise<boolean>
  /** Pre-spawn integrity seam shared by kiwix-serve and kiwix-manage. */
  verifyBinary?: (binPath: string) => Promise<BinaryVerifyResult>
  healthTimeoutMs?: number
  healthIntervalMs?: number
  killGraceMs?: number
  forceKillWaitMs?: number
  /** Where `library.<build>.xml` files are written (default: a fresh OS temp dir). */
  libraryDir?: string
}

/**
 * Workspace admission seam (plan §9.15 item 1). P3a implements the RECHECK points; P3b wires
 * the real `{ admitsWork: workspaceAdmitsWork, epoch: unlockEpoch }` pair. Absent ⇒ no-op.
 */
export interface ZimAdmission {
  admitsWork(): boolean
  epoch(): number
}

export interface ZimServiceOptions {
  rootPath: string
  isDev: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  deps?: ZimServiceDeps
  admission?: ZimAdmission
  /**
   * The knowledge-pack operation registry (`ctx.zimOps`, #301 P3b). Absent ⇒ every operation is
   * a local no-op object whose signal is the caller's own, so nothing is tracked and nothing is
   * cancelled by an `abortAll()` that does not exist.
   */
  ops?: PlaintextOpsRegistry
  /**
   * `<workspacePath>/zim-transient` — where `library.<build>.xml` and `meta-<n>/` live in
   * production (#301 P3b, L3/M4). `deps.libraryDir` (the test seam) still WINS when both are
   * given; absent ⇒ the pre-P3b OS-temp fallback.
   */
  transientDir?: string
  /**
   * Broadcast one pack-set change to every window (#301 P3b, plan §9.17 (e)3 — wired in
   * `main/index.ts` like `notifyRenderer`, over `EVENTS.knowledgePacksChanged`). ABSENT ⇒
   * `emitPacksChanged` is a no-op (every test and partial context that does not wire it). Emitted
   * only AFTER an `assert()`, so a reconcile finishing under an old epoch writes nothing and
   * announces nothing.
   */
  notify?: (notice: KnowledgePacksChangedEvent) => void
}

/** The payload of the pack-set update event (plan §9.17 (e)3) — an alias of the shared
 *  `KnowledgePacksChangedEvent` (shared/types.ts), which is what actually crosses the
 *  `packs:changed` IPC event; kept as its own name here because every producer in this file
 *  reads more clearly against a service-scoped type. */
export type ZimPacksChangedNotice = KnowledgePacksChangedEvent

/**
 * One registered knowledge-pack operation (plan §9.17 (a)3). `assert()` throws the #159
 * `AbortError` when the service was stopped, the operation was cancelled, the workspace stopped
 * admitting work, or the unlock epoch moved since `epoch` was captured.
 */
export interface ZimOp {
  /** Aborted by `zimOps.abortAll()` (lock/quit) or by the parent signal, when there is one. */
  readonly signal: AbortSignal
  /** The unlock epoch captured when the operation began; null when no admission seam exists. */
  readonly epoch: number | null
  assert(): void
  /** Record a transient path BEFORE writing it, so the lock/quit sweep can shred it. */
  track(path: string): void
  /** The operation is over. Idempotent; belongs in a `finally`. */
  release(): void
}

/** Why a transient cleanup pass ran — the four entry points of plan §9.17 (c)3. */
export type ZimCleanupReason = 'lock' | 'quit' | 'session-start' | 'startup'

/** The published configuration, or the revision-keyed "nothing to serve" state. */
type Published =
  | {
      kind: 'served'
      revision: number
      build: number
      generation: number
      port: number
      libraryXmlPath: string
      /** pack id → the name kiwix-serve answers to for THIS build (plan §9.17 (d)6). */
      names: ReadonlyMap<string, string>
      /** Packs deliberately left out of the build: an earlier UUID owns their serving name. */
      excluded: ReadonlyArray<ServingNameCollision>
    }
  | { kind: 'empty'; revision: number }

/**
 * What a successful `ensureServer` publishes to its caller (plan §9.17 (d)7). The port alone
 * is not enough any more: a caller that knows the port but not the serving map would have to
 * guess a route, which is finding L4. P5's `withServer` guard captures this whole tuple around
 * a request and re-reads `serverState()` afterwards.
 */
export interface ServedLibrary {
  port: number
  revision: number
  generation: number
  names: ReadonlyMap<string, string>
  excluded: ReadonlyArray<ServingNameCollision>
}

/** What P5's `withServer` alive/generation guard captures around a request (plan §9.15 item 9). */
export interface ZimServerState {
  revision: number
  build: number
  generation: number
  port: number
  /** The published record is still the server's current child AND it has not reached a
   *  terminal state. False after a crash, before a restart. */
  alive: boolean
}

export interface PackArticle {
  title: string
  sections: Array<{ label: string | null; text: string }>
  /** True when the converter stopped short of the whole article (input cap, work budget or
   *  unterminated markup — html.ts `ZimArticle.truncated`), so the viewer must not present
   *  the text as the complete article. */
  partial: boolean
}

/** One `ensureServer` call's captured tuple, read BEFORE its first await. */
interface Captured {
  revision: number
  signal: AbortSignal | undefined
  admissionEpoch: number | null
}

interface StartEntry {
  revision: number
  promise: Promise<Published>
  abort: AbortController
}

export class ZimService {
  private readonly opts: ZimServiceOptions
  private readonly deps: ZimServiceDeps
  readonly zimDir: string

  /** Bumped synchronously by every pack-set mutation. Never reset (P5's guard needs that). */
  private packRevision = 0
  /** ONE allocator for library builds AND kiwix-serve children (plan §9.15 item 1). */
  private generationCounter = 0
  /** The FIFO chain every rebuild / teardown / start passes through: the single-writer rule. */
  private chain: Promise<unknown> = Promise.resolve()

  private server: KiwixServer | null = null
  private libraryDir: string | null = null
  private ownsLibraryDir = false
  private published: Published | null = null
  private starting: StartEntry | null = null
  /** Revision-keyed start-failure latch: "a start failure latches until the pack set changes". */
  private startFailure: { revision: number; error: Error } | null = null
  /** Permanent quit latch (only `stop()` arms it; `suspend()` deliberately does not). */
  private stopped = false
  /** The most recent teardown could not confirm the child was gone (plan §9.15 item 6): its
   *  PID stays in the reaper registry and its build file is kept. */
  private lastTeardownUncertain = false
  /** How many children this service could never confirm dead. STICKY for the life of the
   *  process: once one may still be writing a build file, no later path — quit included —
   *  may clear the transient directory. The crash reaper and P3b's startup sweep own it,
   *  and a teardown report says "cleanup not confirmed", never "complete".*/
  private unconfirmedChildren = 0
  /** Transient paths the cleanup must NOT remove: the library file of a serve child, or the
   *  meta dir of a manager child, whose teardown could not be confirmed (plan §9.17 (c)2).
   *  They are reported as `kept` and removed by the next session-start pass. */
  private readonly keptPaths = new Set<string>()
  /** The reconciliation pass currently running, or null — the single-flight latch (§9.17 (d)4). */
  private reconcileInFlight: Promise<void> | null = null
  /** A Refresh arrived while a pass was running: run exactly ONE more, however many arrived. */
  private runAgain = false

  constructor(opts: ZimServiceOptions) {
    this.opts = opts
    this.deps = opts.deps ?? {}
    this.zimDir = resolveZimDir(opts.rootPath)
  }

  // ---- operations (H4) ----------------------------------------------------------

  /**
   * Begin one registered operation (plan §9.17 (a)3). `parent` (an ask's own signal) also
   * cancels it. Without an operation registry the returned object is a local no-op whose
   * signal is the parent's — so a cancelled ask still cancels its arm, and every context that
   * never wired `zimOps` behaves exactly as it did before.
   */
  private beginOp(kind: PlaintextOpKind, parent?: AbortSignal): ZimOp {
    const epoch = this.opts.admission?.epoch() ?? null
    const registry = this.opts.ops
    if (!registry) {
      const signal = parent ?? new AbortController().signal
      return {
        signal,
        epoch,
        assert: () => this.assertLive(epoch, signal),
        track: () => undefined,
        release: () => undefined
      }
    }
    const op = registry.register(kind, parent)
    return {
      signal: op.signal,
      epoch,
      assert: () => this.assertLive(epoch, op.signal),
      track: (path) => op.track(path),
      release: () => op.release()
    }
  }

  /**
   * Register the operation that owns a native-picker wait (plan §9.17 (a)4). The handler opens
   * the OS dialog under it and `assert()`s the result: a picker resolving after a lock — or
   * after a lock + unlock, under a new epoch — is refused even though the dialog itself cannot
   * be cancelled. The op is the SERVICE'S, so `zimOps.abortAll()` reaches it.
   */
  beginRegistration(): ZimOp {
    return this.beginOp('zim-register')
  }

  /**
   * Run `body` and normalise a cancellation to the #159 `AbortError` convention. A
   * kiwix-manage child killed by the lock rejects with its own `KiwixManageError`; callers of
   * the service (the ask path, the session seam, the handlers) must not have to know every
   * inner error class to tell "the workspace stopped admitting this" from a real failure.
   */
  private async underOp<T>(op: ZimOp, body: () => Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (err) {
      op.assert() // throws the AbortError when the operation is the reason
      throw err
    }
  }

  // ---- tools --------------------------------------------------------------------

  /** True when the kiwix-tools binaries are present (feature availability for the UI). */
  toolsInstalled(): boolean {
    return this.resolveToolPaths() !== null
  }

  private resolveToolPaths(): { serve: string; manage: string } | null {
    if (this.deps.resolveTools) return this.deps.resolveTools()
    const serve = resolveKiwixServePath(this.opts.rootPath, this.opts.platform, this.opts.env, {
      isDev: this.opts.isDev
    })
    const manage = resolveKiwixManagePath(serve, this.opts.platform)
    return serve && manage ? { serve, manage } : null
  }

  /**
   * The pack-registry dependencies for one operation. `signal` (when given) reaches every
   * `kiwix-manage` child, so a lock/quit teardown cancels the manager work instead of waiting
   * it out; `writeLibraryXml` rethrows on an abort or an `uncertain` manager child, because a
   * shared library.xml with an unconfirmed writer is not a publishable build (plan §9.15 item 8).
   */
  private packDeps(signal?: AbortSignal, op?: ZimOp): PackDeps {
    const tools = this.resolveToolPaths()
    const spawnFn: SpawnFn =
      this.deps.manageSpawn ?? this.deps.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o))
    return {
      zimDir: this.zimDir,
      // The registration throwaway lives in the owned transient dir, under a name taken from
      // the ONE generation allocator, and is tracked on the operation BEFORE it is written
      // (plan §9.17 (c)1) so the lock/quit sweep can shred it if the operation cannot cancel.
      metaDir: () => {
        const dir = join(this.ensureLibraryDir(), `meta-${this.nextGeneration()}`)
        op?.track(join(dir, 'library.xml'))
        return dir
      },
      onUncertain: (path) => this.keptPaths.add(path),
      assert: op ? () => op.assert() : undefined,
      manageAdd: async (libraryXmlPath, zimPath, perCallSignal) => {
        if (!tools) throw new Error('kiwix-tools is not installed')
        await kiwixManageAdd(tools.manage, libraryXmlPath, zimPath, spawnFn, {
          signal: perCallSignal ?? signal,
          verifyBinary: this.deps.verifyBinary,
          killGraceMs: this.deps.killGraceMs,
          forceKillWaitMs: this.deps.forceKillWaitMs,
          // #301 P5, finding L9: injected, not read from `process.platform`, so the native
          // separator normalization is pinned in tests independently of the host.
          platform: this.opts.platform
        })
      }
    }
  }

  // ---- registration (all mutations invalidate the running server's library) ------

  /** The registered packs, DATABASE-ONLY (finding L7): no disk probe, no availability UPDATE,
   *  no manager spawn. `reconcile()` is what writes the availability this reads. */
  listPacks(db: Db): KnowledgePack[] {
    return listPacks(db)
  }

  /**
   * Register (or re-register) one archive. `op` is the caller's registration operation — the
   * SAME one the native picker was awaited under (`beginRegistration`), so every file of one
   * "Add packs" runs under one cancellable ticket; absent, this call opens its own.
   */
  async registerPack(db: Db, zimPath: string, op?: ZimOp): Promise<KnowledgePack> {
    const own = op ?? this.beginOp('zim-register')
    try {
      own.assert()
      // `packDeps.assert` re-checks again inside, right before the UPSERT (after the manager).
      const pack = await this.underOp(own, () =>
        registerPack(db, this.packDeps(own.signal, own), zimPath)
      )
      own.assert()
      this.invalidateLibrary()
      // Mutation producer (plan §9.17 (e)3): AFTER the assert, so a registration that finished
      // under an old epoch (the op above would have thrown) never announces itself.
      this.emitPacksChanged(own, 'mutation', this.refreshing())
      return pack
    } finally {
      if (!op) own.release()
    }
  }

  /**
   * Reconcile the registry against the drive — the ONE filesystem pass (plan §9.17 (d)4–5,
   * findings M5/L7). Runs at every session start and on an explicit Refresh.
   *
   * SINGLE-FLIGHT: a second call while one is running does NOT start a second pass; it sets
   * `runAgain`, and exactly ONE more pass follows the current one however many Refreshes
   * arrive meanwhile. Two concurrent passes would fight over the same rows and spawn the same
   * managers twice.
   *
   * `invalidateLibrary()` fires ONLY when the effective served set actually moved, so a no-op
   * Refresh does not churn the publication revision and kill a healthy sidecar.
   */
  async reconcile(db: Db): Promise<void> {
    if (this.reconcileInFlight) {
      this.runAgain = true
      return this.reconcileInFlight
    }
    const run = this.reconcileOnce(db).finally(() => {
      this.reconcileInFlight = null
    })
    this.reconcileInFlight = run
    await run
    // Exactly ONE coalesced rerun, whatever number of Refreshes landed during the pass.
    if (this.runAgain) {
      this.runAgain = false
      await this.reconcile(db)
    }
  }

  /** True while a reconciliation pass is running (step 3's `packs:status.refreshing`). */
  refreshing(): boolean {
    return this.reconcileInFlight !== null
  }

  private async reconcileOnce(db: Db): Promise<void> {
    const op = this.beginOp('zim-reconcile')
    try {
      op.assert()
      if (!this.toolsInstalled()) return
      this.emitPacksChanged(op, 'reconcile-start', true)
      const report = await this.underOp(op, () =>
        reconcile(db, this.packDeps(op.signal, op), { assert: () => op.assert() })
      )
      op.assert()
      if (report.changed) this.invalidateLibrary()
      // AFTER the assert: a pass that finished under an old epoch wrote nothing above and must
      // announce nothing either. `refreshing` is still true when a Refresh queued a rerun.
      this.emitPacksChanged(op, 'reconcile-end', this.runAgain)
    } finally {
      op.release()
    }
  }

  /**
   * The pack-update broadcast hook (plan §9.17 (e)3). A NO-OP without `opts.notify`, which is
   * every context until step 3 of P3b wires `packs:changed` through `main/index.ts`. Kept here
   * rather than at the call sites so there is one place that decides what a notice carries.
   */
  private emitPacksChanged(
    op: ZimOp,
    reason: ZimPacksChangedNotice['reason'],
    refreshing: boolean
  ): void {
    // `op.epoch` is `null` only when no admission seam is wired (tests, a partial context) —
    // the shared event type is a plain `number` (0 in that case), never a real session's epoch.
    this.opts.notify?.({
      epoch: op.epoch ?? 0,
      revision: this.packRevision,
      refreshing,
      reason
    })
  }

  removePack(db: Db, id: string): boolean {
    // Synchronous, but still a registered operation: the recheck immediately before the write
    // is what a lock that armed its latch between the handler's guard and this line needs.
    const op = this.beginOp('zim-register')
    try {
      op.assert()
      const removed = removePack(db, id)
      if (removed) {
        this.invalidateLibrary()
        // Mutation producer (plan §9.17 (e)3) — only on a REAL change, like reconcile's own
        // `report.changed` gate; a no-op remove (unknown id) announces nothing.
        this.emitPacksChanged(op, 'mutation', this.refreshing())
      }
      return removed
    } finally {
      op.release()
    }
  }

  setPackEnabled(db: Db, id: string, enabled: boolean): boolean {
    const op = this.beginOp('zim-register')
    try {
      op.assert()
      const changed = setPackEnabled(db, id, enabled)
      if (changed) {
        this.invalidateLibrary()
        this.emitPacksChanged(op, 'mutation', this.refreshing())
      }
      return changed
    } finally {
      op.release()
    }
  }

  /**
   * The pack set changed (plan §9.15 item 4). SYNCHRONOUS by contract, so the very next
   * `ensureServer` already reads the new revision:
   *   1. bump the revision (every in-flight capture is now stale),
   *   2. clear a failure latch that belonged to the old revision (the change may be the fix),
   *   3. abort the shared in-flight start,
   *   4. drop the publication and enqueue a TRACKED teardown of the old child on the chain —
   *      the old build's XML is deleted inside that step, only after the child is terminal,
   *      and never the XML of a build this call did not own.
   */
  private invalidateLibrary(): void {
    this.packRevision++
    this.startFailure = null
    const inFlight = this.starting
    this.starting = null
    inFlight?.abort.abort()
    this.server?.resetFailureLatch()
    const stale = this.published
    this.published = null
    void this.enqueue(() => this.teardownPublished(stale)).catch(() => {
      /* the teardown is bounded and self-reporting; a rejection must not become unhandled */
    })
  }

  // ---- sidecar ------------------------------------------------------------------

  /** The current pack revision (a pack-set change bumps it; never reset). */
  revision(): number {
    return this.packRevision
  }

  /** The next generation for a library build or a kiwix-serve child. Monotonic per process. */
  private nextGeneration(): number {
    return ++this.generationCounter
  }

  /** Resolves once every queued rebuild / teardown / start has settled (tests; P3b). */
  whenSettled(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined
    )
  }

  /**
   * The coherent published tuple for P5's request guard, or null when nothing is published
   * (never started, an empty revision, suspended, stopped).
   */
  serverState(): ZimServerState | null {
    const pub = this.published
    if (!pub || pub.kind !== 'served') return null
    const server = this.server
    const alive = server !== null && server.alive() && server.generation() === pub.generation
    return {
      revision: pub.revision,
      build: pub.build,
      generation: pub.generation,
      port: pub.port,
      alive
    }
  }

  /**
   * Ensure a sidecar serving the CURRENT enabled+available packs; resolves its port, or null
   * when there is nothing to serve or no binaries. Concurrent calls share one start; a waiter
   * whose own `signal` fires rejects at once WITHOUT cancelling the shared start; a waiter
   * whose revision moved while it waited re-loops under the new revision (at most
   * `MAX_ENSURE_ATTEMPTS` rounds). Rejects with an `AbortError` when this operation itself is
   * cancelled, the workspace stopped admitting it, or the service was stopped.
   */
  async ensureServer(db: Db, signal?: AbortSignal, op?: ZimOp): Promise<ServedLibrary | null> {
    for (let attempt = 0; attempt < MAX_ENSURE_ATTEMPTS; attempt++) {
      const captured = this.capture(signal)
      this.assertAdmitted(captured)
      if (!this.resolveToolPaths()) return null

      // Fast path: a coherent publication under the desired revision with a live child.
      const pub = this.published
      if (pub && pub.revision === captured.revision) {
        if (pub.kind === 'empty') return null
        const server = this.server
        if (server && server.alive() && server.generation() === pub.generation) {
          this.assertAdmitted(captured)
          return servedLibraryOf(pub)
        }
        // Published but the child is gone (a natural crash): fall through and restart it
        // over the SAME build — a new generation, the same revision.
      }
      if (this.startFailure) {
        if (this.startFailure.revision !== this.packRevision) this.startFailure = null
        else if (this.startFailure.revision === captured.revision) throw this.startFailure.error
      }

      const shared =
        this.starting && this.starting.revision === captured.revision
          ? this.starting
          : this.beginStart(db, captured.revision, op)

      let result: Published
      try {
        result = await raceSignal(shared.promise, captured.signal)
      } catch (err) {
        // My own cancellation / the quit latch / an admission change always wins.
        this.assertAdmitted(captured)
        // The pack set moved while I waited (an invalidate aborted the shared start, or the
        // op yielded a stale build): re-loop under the now-current revision.
        if (this.packRevision !== captured.revision) continue
        throw err
      }
      // Every waiter rechecks before CONSUMING a published result (plan §9.15 item 5).
      this.assertAdmitted(captured)
      if (result.revision !== this.packRevision) continue
      return result.kind === 'empty' ? null : servedLibraryOf(result)
    }
    throw new Error('The knowledge-pack set kept changing while the library server was starting')
  }

  /**
   * Run ONE kiwix-serve request batch under the alive/generation guard (#301 P5, finding M1;
   * plan §9.19 (a)). Resolves the callback's value, or null when there is nothing to serve —
   * the callers' existing "no packs / no tools" null.
   *
   * One attempt is:
   *
   *   assert → ensureServer → capture `serverState()` → request(library) → assert →
   *   one macrotask yield → re-read `serverState()` → accept or discard
   *
   * The BEFORE tuple must already be alive and describe the very library that was handed out
   * (a child that died between publication and this read is a lifecycle change *before* the
   * request), otherwise the attempt is spent without issuing anything. The AFTER tuple must be
   * alive and carry the same generation, revision and port; anything else discards the attempt
   * whatever it produced. An ordinary failure of the request itself — an HTTP 500, a parse
   * error — under a live, unchanged generation is NOT a lifecycle change: it is rethrown
   * unchanged so the arm's per-pack catch and the viewer's null keep their meaning.
   *
   * The single macrotask yield is a best-effort NARROWING, not a proof: it lets an `exit`
   * event already queued for the child be delivered before the second read. A death whose
   * notification has not been queued yet still passes, which is one of the residual R-9
   * windows recorded in `docs/security-model.md`.
   */
  async withServer<T>(
    db: Db,
    op: ZimOp,
    request: (library: ServedLibrary) => Promise<T>
  ): Promise<T | null> {
    // Exactly two: the attempt, and the ONE admitted retry of plan §9.19 (a)4.
    for (let attempt = 0; attempt < 2; attempt++) {
      op.assert()
      const library = await this.ensureServer(db, op.signal, op)
      op.assert()
      if (library === null) return null

      const before = this.serverState()
      if (!isLiveTuple(before, library)) {
        // The child was already gone when the request was about to go out. The attempt is
        // SPENT — nothing was asked, but the retry budget is the same one, because a caller
        // that could loop here would be a spin loop against a server that keeps dying.
        if (attempt === 0 && this.retryAdmitted(op)) continue
        throw staleServerError(staleReasonAgainst(before, library))
      }

      let value: T
      let failure: unknown
      let rejected = false
      try {
        value = await request(library)
      } catch (err) {
        rejected = true
        failure = err
        value = undefined as unknown as T
      }
      // Cancellation and the closing session always win over the response, however it ended.
      op.assert()
      // One macrotask, so an `exit` already queued for our child is observed before we decide.
      await yieldMacrotask()
      const after = this.serverState()
      if (isSameTuple(after, before)) {
        if (rejected) throw failure
        return value
      }
      // A lifecycle change across the response: the whole attempt goes, successful body
      // included — on this port that body may not have come from our child at all.
      if (attempt === 0 && this.retryAdmitted(op)) continue
      throw staleServerError(staleReasonAgainst(after, before))
    }
    /* c8 ignore next 2 -- the loop either returns, continues once, or throws above. */
    throw staleServerError('generation-changed')
  }

  /** May the discarded attempt be retried? Only while the SAME admitted session still wants
   *  it; a lock, a lock + unlock (new epoch), a cancelled ask or a stopped service make
   *  `assert()` throw the `AbortError`, which propagates INSTEAD of the retry. */
  private retryAdmitted(op: ZimOp): boolean {
    op.assert()
    return true
  }

  private capture(signal: AbortSignal | undefined): Captured {
    return {
      revision: this.packRevision,
      signal,
      admissionEpoch: this.opts.admission?.epoch() ?? null
    }
  }

  /** Cancellation / quit / admission recheck. A failed recheck REJECTS (never latches,
   *  never logs and continues) with the #159 `AbortError` convention. */
  private assertAdmitted(cap: Captured): void {
    this.assertLive(cap.admissionEpoch, cap.signal)
  }

  /** The one recheck body shared by `ensureServer`'s captured tuple and every `ZimOp`. */
  private assertLive(epoch: number | null, signal: AbortSignal | undefined): void {
    if (this.stopped) throw abortError('The knowledge-pack service has been stopped')
    if (signal?.aborted) throw abortError('The knowledge-pack operation was cancelled')
    const admission = this.opts.admission
    if (admission && (!admission.admitsWork() || admission.epoch() !== epoch)) {
      throw abortError('The workspace no longer admits this knowledge-pack operation')
    }
  }

  /** The full recheck an OPERATION performs at its recheck points: admission plus revision. */
  private assertCurrent(cap: Captured): void {
    this.assertAdmitted(cap)
    if (cap.revision !== this.packRevision) {
      throw new StaleBuildError(
        `The knowledge-pack set changed (revision ${cap.revision} → ${this.packRevision})`
      )
    }
  }

  /** Own the shared start for one revision. The start belongs to the SERVICE, not to any
   *  waiter, so an unconsumed successful start simply becomes the server for the next ask. */
  private beginStart(db: Db, revision: number, op?: ZimOp): StartEntry {
    const abort = new AbortController()
    const captured: Captured = {
      revision,
      signal: abort.signal,
      admissionEpoch: this.opts.admission?.epoch() ?? null
    }
    const promise = this.enqueue(() => this.startOp(db, captured, abort.signal, op)).catch(
      (err: unknown) => {
        // An aborted or superseded start NEVER latches (plan §9.15 item 7). The signal check
        // is the belt to the AbortError's braces: a start cancelled by invalidate / suspend /
        // stop can surface a child's own error class (a killed kiwix-manage rejects
        // `KiwixManageError`), and latching THAT would make the next ask after the unlock
        // rethrow it under the unchanged revision (#301 P3b).
        if (!isAbortError(err) && !(err instanceof StaleBuildError) && !abort.signal.aborted) {
          this.startFailure = {
            revision,
            error: err instanceof Error ? err : new Error(String(err))
          }
        }
        throw err
      }
    )
    const entry: StartEntry = { revision, promise, abort }
    this.starting = entry
    // Every waiter may have left before this settles; keep the rejection handled.
    promise.catch(() => undefined)
    void promise
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        if (this.starting === entry) this.starting = null
      })
    return entry
  }

  /**
   * One start, on the chain: build (or reuse) an immutable library file, spawn a child for it
   * and publish the still-current tuple. Recheck points per plan §9.15 item 1.
   */
  private async startOp(
    db: Db,
    cap: Captured,
    signal: AbortSignal,
    op?: ZimOp
  ): Promise<Published> {
    this.assertCurrent(cap)
    const tools = this.resolveToolPaths()
    if (!tools) throw new Error('kiwix-tools is not installed')
    const dir = this.ensureLibraryDir()

    const prior = this.published
    let build: number
    let libraryXmlPath: string
    let ownsBuild = false
    let names: ReadonlyMap<string, string>
    let excluded: ReadonlyArray<ServingNameCollision>
    if (
      prior &&
      prior.kind === 'served' &&
      prior.revision === cap.revision &&
      existsSync(prior.libraryXmlPath)
    ) {
      // Natural-crash restart: the pack set did not change, so the BUILD is still current.
      // Reuse its exact XML — and therefore its exact serving map, which describes that file —
      // and take only a new child generation (plan §9.15 item 1).
      build = prior.build
      libraryXmlPath = prior.libraryXmlPath
      names = prior.names
      excluded = prior.excluded
    } else {
      build = this.nextGeneration()
      libraryXmlPath = join(dir, `library.${build}.xml`)
      ownsBuild = true
      // Tracked on the operation that asked for this start BEFORE the first byte is written,
      // so a lock's sweep shreds it even if the build cannot cancel (plan §9.17 (c)1).
      op?.track(libraryXmlPath)
      // IDENTITY FIRST (M5/L4, plan §9.17 (d)6). Resolve every enabled pack by its header
      // UUID, compute libkiwix's own serving-name map, and build ONLY the winners: the
      // collision losers never enter the XML, so the server cannot answer for the wrong book
      // and the outcome matches whichever book libkiwix would have kept.
      const resolved = servedCandidates(db, this.zimDir)
      const served = computeServedSet(resolved, this.opts.platform ?? process.platform)
      names = served.names
      excluded = served.excluded
      if (excluded.length > 0) {
        // Ids only — a title or a path names what the user reads (the sentinel rule).
        log.warn('Knowledge packs excluded from the served library: serving-name collision', {
          excluded: excluded.map((e) => ({ packId: e.packId, collidesWith: e.collidesWith }))
        })
      }
      const winners = resolved.filter((c) => names.has(c.id))
      let count: number
      try {
        count = await writeLibraryXml(this.packDeps(signal), libraryXmlPath, winners, signal)
        // Recheck after the manager work: a build nobody wants any more is deleted here,
        // and only ever THIS build's own file.
        this.assertCurrent(cap)
      } catch (err) {
        this.discardBuild(libraryXmlPath)
        // A build the teardown cancelled surfaces as the #159 `AbortError`, not as the
        // manager's own error class: every waiter rejects with one convention, and a start
        // aborted by a lock/quit must never look like a start FAILURE (which would latch).
        if (signal.aborted) throw abortError('The knowledge-pack library build was cancelled')
        throw err
      }
      if (count === 0) {
        // "Nothing to serve", keyed by revision: the next ask under the same revision
        // returns null without rebuilding (the old `libraryStale` boolean's job, M2).
        this.discardBuild(libraryXmlPath)
        const empty: Published = { kind: 'empty', revision: cap.revision }
        this.published = empty
        return empty
      }
    }

    const server = this.serverInstance(tools.serve)
    let started: { port: number; generation: number }
    try {
      started = await server.ensureStarted({ libraryXmlPath, signal })
    } catch (err) {
      // A failing start never calls the service's own stop() (self-await): the server tore
      // its own record down through the bounded record-level path before rejecting.
      if (ownsBuild) this.discardBuild(libraryXmlPath)
      throw err
    }
    try {
      // Pre-publication recheck: the LAST gate before this tuple becomes the served truth.
      this.assertCurrent(cap)
    } catch (err) {
      await server.stop()
      this.lastTeardownUncertain = server.lastStopUncertain()
      this.syncUnconfirmed(server)
      if (this.lastTeardownUncertain) this.keptPaths.add(libraryXmlPath)
      else if (ownsBuild) this.discardBuild(libraryXmlPath)
      throw err
    }
    const pub: Published = {
      kind: 'served',
      revision: cap.revision,
      build,
      generation: started.generation,
      port: started.port,
      libraryXmlPath,
      names,
      excluded
    }
    this.published = pub
    return pub
  }

  private serverInstance(binPath: string): KiwixServer {
    if (!this.server) {
      this.server = new KiwixServer({
        binPath,
        spawn: this.deps.spawn,
        findPort: this.deps.findPort,
        probe: this.deps.probe,
        verifyBinary: this.deps.verifyBinary,
        healthTimeoutMs: this.deps.healthTimeoutMs,
        healthIntervalMs: this.deps.healthIntervalMs,
        killGraceMs: this.deps.killGraceMs,
        forceKillWaitMs: this.deps.forceKillWaitMs,
        // Builds and children draw from ONE service-owned counter, so every child of this
        // process — including a bind-race retry and a crash restart — has a distinct,
        // service-observable generation.
        allocateGeneration: () => this.nextGeneration()
      })
    }
    return this.server
  }

  /** FIFO: rebuild, teardown and start never overlap, so there is exactly one library writer. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * The transient directory, created lazily. Production is
   * `<workspacePath>/zim-transient` (`opts.transientDir`); `deps.libraryDir` is the test seam
   * and WINS when both are given; neither ⇒ the pre-P3b OS-temp fallback.
   */
  private ensureLibraryDir(): string {
    if (!this.libraryDir) {
      const injected = this.deps.libraryDir ?? this.opts.transientDir
      if (injected) {
        mkdirSync(injected, { recursive: true })
        this.libraryDir = injected
        this.ownsLibraryDir = false
      } else {
        this.libraryDir = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-library-'))
        this.ownsLibraryDir = true
      }
    }
    return this.libraryDir
  }

  /** Delete ONE build's own file. Never called for a build this operation did not own, and
   *  never for the file of a child whose death could not be confirmed. */
  private discardBuild(libraryXmlPath: string): void {
    try {
      rmSync(libraryXmlPath, { force: true })
    } catch {
      /* transient dir — best-effort; P3b owns the crash sweep */
    }
  }

  /** Stop the current child, then delete the build it was serving — only after a CONFIRMED
   *  terminal state (an uncertain child may still be writing; its file and PID are kept). */
  private async teardownPublished(stale: Published | null): Promise<void> {
    const server = this.server
    let uncertain = false
    if (server) {
      await server.stop()
      uncertain = server.lastStopUncertain()
      this.syncUnconfirmed(server)
    }
    this.lastTeardownUncertain = uncertain
    if (stale && stale.kind === 'served') {
      // An unconfirmed child may still be writing its build: keep the file AND remember it, so
      // the lock/quit/session-start cleanup reports it as `kept` instead of removing it under
      // a possibly-live process (plan §9.17 (c)2).
      if (uncertain) this.keptPaths.add(stale.libraryXmlPath)
      else this.discardBuild(stale.libraryXmlPath)
    }
  }

  /**
   * Kill the sidecar but allow a lazy restart on the next ask — the workspace LOCK path
   * (P3b calls it from `runLockTeardown`'s sidecar block after `zimOps.abortAll()`). Bounded
   * by the server's own SIGTERM → 2 s → SIGKILL → 3 s policy and NON-LATCHING: no flag that
   * only an unlock could clear.
   */
  async suspend(): Promise<void> {
    const inFlight = this.starting
    this.starting = null
    inFlight?.abort.abort()
    const stale = this.published
    this.published = null
    await this.enqueue(() => this.teardownPublished(stale))
  }

  /** Stop the sidecar PERMANENTLY and remove the generated builds (quit path — shutdown.ts).
   *  Terminal: a racing ask must not resurrect the child as an orphan. */
  async stop(): Promise<void> {
    this.stopped = true
    const inFlight = this.starting
    this.starting = null
    inFlight?.abort.abort()
    const stale = this.published
    this.published = null
    await this.enqueue(() => this.teardownPublished(stale))
    if (this.server) this.syncUnconfirmed(this.server)
    this.server = null
    // The SAME dedicated cleanup the lock and the session start run — idempotent and kept-set
    // aware, so a quit that skipped `shutdown.ts`'s explicit step still cleans, and the file of
    // a child this service could never confirm dead is kept and reported rather than removed
    // under a possibly-live process.
    this.cleanupTransients('quit')
  }

  /**
   * Remove this workspace's knowledge-pack transients (plan §9.17 (c)). Idempotent. Called at
   * lock, at quit and at every session start; the report's `confirmed` is false whenever
   * anything was left behind, and the caller logs "NOT confirmed" rather than "complete".
   */
  cleanupTransients(reason: ZimCleanupReason): ZimCleanupReport {
    const unsettledOps = this.opts.ops?.size() ?? 0
    const dir = this.libraryDir ?? this.deps.libraryDir ?? this.opts.transientDir ?? null
    if (!dir) {
      return {
        removed: 0,
        kept: 0,
        unknownEntries: 0,
        unsettledOps,
        unconfirmedChildren: this.unconfirmedChildren,
        confirmed: unsettledOps === 0
      }
    }
    // A real `<workspacePath>/zim-transient` goes through the CONTAINED cleanup (containment +
    // link refusal); a test seam or the OS-temp fallback has no workspace to be contained by.
    const base = basename(dir) === ZIM_TRANSIENT_DIR_NAME ? dirname(dir) : null
    const report = base
      ? cleanupZimTransients(dir, base, { keep: this.keptPaths, platform: this.opts.platform })
      : sweepZimTransientDir(dir, { keep: this.keptPaths })
    log.info('Knowledge-pack transient cleanup', {
      reason,
      removed: report.removed,
      kept: report.kept,
      unknownEntries: report.unknownEntries
    })
    return {
      ...report,
      unsettledOps,
      unconfirmedChildren: this.unconfirmedChildren,
      confirmed: report.confirmed && unsettledOps === 0
    }
  }

  /** Carry the server's monotonic 'could not confirm this child dead' count onto the service,
   *  where it outlives the server instance the quit path drops. */
  private syncUnconfirmed(server: KiwixServer): void {
    this.unconfirmedChildren = Math.max(this.unconfirmedChildren, server.unconfirmedChildren())
  }

  // ---- retrieval + viewer -------------------------------------------------------

  /**
   * The external retrieval arm for one ask, or null when packs cannot contribute
   * (no ids in scope, tools missing, or nothing retrievable). The arm starts the
   * sidecar lazily on first use; `retrieve` isolates any failure it throws.
   */
  makeArm(db: Db, packIds: readonly string[] | null | undefined): ExternalRetrievalArm | null {
    if (!packIds || packIds.length === 0) return null
    if (!this.toolsInstalled()) {
      log.warn('Knowledge packs in scope but kiwix-tools is not installed — skipping the ZIM arm')
      return null
    }
    const packs = retrievablePacks(db, this.zimDir, packIds)
    if (packs.length === 0) return null
    return async (question, signal) => {
      // The whole arm is ONE registered operation with the ask's signal as its parent, so a
      // lock (`zimOps.abortAll()`) cancels it exactly like a cancelled ask does. The op's
      // signal — not the raw ask signal — reaches the library preparation, the sidecar start
      // and the HTTP calls, and admission/epoch are rechecked after every await (H4).
      const op = this.beginOp('zim-ask', signal)
      try {
        op.assert()
        // The search + fetch batch is ONE guard window (#301 P5, finding M1; plan §9.19 (a)3):
        // a death noticed only afterwards cannot tell our child's candidates from a port
        // squatter's, so the batch is discarded and retried as a unit rather than per call.
        const candidates = await this.withServer(db, op, async (library) => {
          // Re-queried INSIDE the callback, per attempt: the retry re-enters under the
          // CURRENT revision, and a pack removed, disabled or vanished during the first
          // attempt must not be searched again from a list captured before it.
          const current = retrievablePacks(db, this.zimDir, packIds)
          // A pack the served library does not carry — a collision loser, or one whose file
          // stopped resolving between `retrievablePacks` and the build — is SKIPPED rather
          // than searched under a name that belongs to another book (findings M5/L4).
          const servable = current.filter((p) => library.names.has(p.id))
          if (servable.length === 0) return []
          return collectPackCandidates(
            library.port,
            servable,
            question,
            op.signal,
            library.names
          )
        })
        // Before the CONTENT return: a lock that landed during the fetches must not hand
        // archive text back into the prompt of a session that is closing.
        op.assert()
        return candidates ?? []
      } finally {
        op.release()
      }
    }
  }

  /**
   * Read one article for the citation viewer: plain sectioned TEXT (the html.ts
   * extraction), never raw HTML — the renderer keeps its no-innerHTML posture.
   * Null when the pack/article cannot be served (pack gone, entry vanished).
   */
  async getArticle(db: Db, packId: string, articlePath: string): Promise<PackArticle | null> {
    // The read is its own registered operation (H4). Its signal reaches the sidecar start, the
    // HTTP fetch and the conversion, and `assert()` runs after the fetch AND after the
    // conversion — the "content returned after the lock" reproduction closes at those two
    // points, because everything before them can still be in flight when the lock lands.
    const op = this.beginOp('zim-article')
    try {
      op.assert()
      // Cheap pre-check: an unknown, removed or unresolvable pack is refused without waking
      // the sidecar at all. The authoritative, per-attempt check is inside the guard below.
      if (retrievablePacks(db, this.zimDir, [packId]).length === 0) return null
      // The fetch runs under the request guard (#301 P5, finding M1; plan §9.19 (a)6): a body
      // observed across a child death, a restart or an invalidation is discarded and the read
      // is retried once under the new generation.
      const html = await this.withServer(db, op, async (library) => {
        // Re-checked per attempt: the retry recomputes eligibility under the current revision.
        if (retrievablePacks(db, this.zimDir, [packId]).length === 0) return null
        // The route comes from the CURRENT serving map — never from the filename stem (finding
        // L4: libkiwix ≥ 14 slugifies case, accents, spaces and `+`). This is also why the
        // citation locator needs no URL hint: an old citation, a renamed file, a restart and a
        // drive-letter change all resolve here, and a pack that is unmapped or was excluded as
        // a collision loser returns the honest "unavailable" null, not another book's text.
        const name = library.names.get(packId)
        if (name === undefined) return null
        return fetchArticleHtml(library.port, name, articlePath, op.signal)
      })
      op.assert()
      // Null covers all three honest "unavailable" cases: nothing to serve, an unmapped pack,
      // and a 404 from the archive.
      if (html === null) return null
      // Sliced like the ask path (P1b) so a big article cannot stall the main process while
      // the viewer opens.
      const article = await zimArticleToSegmentsAsync(html, { signal: op.signal })
      op.assert()
      const sections = article.segments.map((s) => {
        let text = s.text
        if (s.sectionLabel && text.startsWith(s.sectionLabel)) {
          // The heading is rendered as the section label; drop its duplicate first line.
          text = text.slice(s.sectionLabel.length).replace(/^\n+/, '')
        }
        return { label: s.sectionLabel ?? null, text }
      })
      return { title: article.title ?? articlePath, sections, partial: article.truncated !== null }
    } finally {
      op.release()
    }
  }
}

/** The caller-facing view of one published configuration (the XML path stays internal). */
function servedLibraryOf(pub: Extract<Published, { kind: 'served' }>): ServedLibrary {
  return {
    port: pub.port,
    revision: pub.revision,
    generation: pub.generation,
    names: pub.names,
    excluded: pub.excluded
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** One macrotask (#301 P5, plan §9.19 (a)2). `setImmediate` runs after the I/O callbacks of
 *  this turn, so a child `exit` the event loop has already queued is delivered before the
 *  post-request read of `serverState()`. A narrowing, never a proof — see residual R-9. */
function yieldMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/** The published tuple is alive AND describes exactly the library this attempt was handed. */
function isLiveTuple(
  state: ZimServerState | null,
  library: ServedLibrary
): state is ZimServerState {
  return (
    state !== null &&
    state.alive &&
    state.generation === library.generation &&
    state.revision === library.revision &&
    state.port === library.port
  )
}

/** Nothing about our own child moved across the response. */
function isSameTuple(after: ZimServerState | null, before: ZimServerState): boolean {
  return (
    after !== null &&
    after.alive &&
    after.generation === before.generation &&
    after.revision === before.revision &&
    after.port === before.port
  )
}

/** Classify WHAT changed, for the caller's outcome copy and the log — never a port or a path. */
function staleReasonAgainst(
  state: ZimServerState | null,
  reference: { generation: number; revision: number; port: number }
): StaleServerReason {
  if (state === null) return 'unpublished'
  if (!state.alive) return 'child-died'
  if (
    state.generation !== reference.generation ||
    state.revision !== reference.revision ||
    state.port !== reference.port
  ) {
    return 'generation-changed'
  }
  /* c8 ignore next -- only reached if a caller classifies an unchanged, live tuple. */
  return 'generation-changed'
}

function staleServerError(reason: StaleServerReason): StaleServerError {
  return new StaleServerError(
    reason,
    `The knowledge-pack server changed during the request (${reason})`
  )
}

/**
 * Race one waiter's own cancellation against the SHARED start (plan §9.15 item 5): the
 * cancelled waiter rejects at once and stops waiting, but the start keeps running for the
 * other waiters — and an unconsumed successful start simply becomes the next ask's server.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError('The knowledge-pack ask was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError('The knowledge-pack ask was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
