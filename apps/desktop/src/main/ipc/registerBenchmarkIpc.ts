import { guardedHandleFor } from './guarded-handle'
import { clearSpeculativeSuppression } from '../services/runtime/factory'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  AppSettings,
  BenchmarkProgressStep,
  BenchmarkResult,
  GpuDevice,
  GpuProbeResult,
  MemoryClass,
  ModelPlacement,
  PerformanceSnapshot,
  ResidentModelRow
} from '../../shared/types'
import type { ModelManifest } from '../../shared/manifest'
import { detectSystem, runBenchmark, type GpuBenchmarkInput } from '../services/benchmark'
import { effectiveReadOrPersisted } from './registerModelIpc'
import { notifyPerformanceChanged } from './performance-notify'
import { backfillOutgoing, historyEquals, mergeSampleIntoResult } from '../services/benchmark-persistence'
import {
  findMachine,
  latestAnswerSpeed,
  loadedAtOnceMb,
  machineKey,
  memoryClassOf,
  otherMachines,
  placementVerdict,
  recordAnswerSpeed,
  upsertHistory
} from '../services/performance'
import { latestModelPlacement, setModelPlacementObserver } from '../services/runtime/placement'
import { latestEffectiveReadBySource } from '../services/read-speed'
import { EVENTS, type AnswerSpeed } from '../../shared/ipc'
import { displayDevice, eligibleGpuProbe, gpuUsefulForProfile, primaryUsefulDevice } from '../../shared/gpu-rules'
import { resolveLlamaServerPath } from '../services/runtime/sidecar'
import { discoverManifests, launchContextTokens } from '../services/models'
import { getSettings, updateSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import type { Db } from '../services/db'
import { modelBusyLane, modelBusyMessageKey, type ModelBusyLane } from './model-busy'
import { log } from '../services/logging'

// IPC for the hardware benchmark + model recommendation (spec §9.1, §11).
//
// `runBenchmark()` detects RAM/CPU/OS, probes drive speed in the workspace, optionally
// estimates tokens/sec from the running runtime, classifies a HardwareProfile, and
// recommends a chat model — STRICTLY LOCAL (no network/telemetry). The result is persisted
// to settings (`lastBenchmark`) so the recommendation pipeline (registerModelIpc) and
// `getAppStatus().hardwareProfile` read the real, detected profile instead of a stub.

/**
 * The benchmark's GPU summary for a device list: ONE device's name and memory, paired
 * (`displayDevice` — the first useful discrete device, else the first listed), and the bump
 * eligibility over ALL devices (`gpuUsefulForProfile`, unchanged — owner decision G4).
 */
function gpuSummary(devices: readonly GpuDevice[]): GpuBenchmarkInput {
  const shown = displayDevice(devices)
  return {
    name: shown?.device.name ?? null,
    useful: gpuUsefulForProfile(devices),
    totalMb: shown?.device.totalMb ?? null
  }
}

/**
 * Run the (session-cached) GPU probe on the drive's own `llama-server` and persist the
 * result to `settings.gpuProbe` (architecture.md GPU record §5.4) — so Diagnostics +
 * profile classification have device info without re-probing every launch. The probe
 * stays OUT of benchmark.ts (which keeps zero `child_process`); the summary is injected.
 * Never throws: no binary / no devices / probe failure → a null-name, not-useful input.
 *
 * The persisted probe is STAMPED with this machine's key (PR #303 audit M8.3, owner decision
 * G3): a drive moved to a machine whose probe cannot run (no binary for that OS) used to keep
 * the previous machine's devices, and they decided the memory class, the VRAM budget and the
 * graphics tile there. Readers go through `eligibleGpuProbe`. The write rules: no binary or a
 * REJECTING probe → no write (the old devices are never re-stamped as local, whatever they
 * are); a probe that resolves — an EMPTY list included, which is the probe's own "nothing
 * usable" answer (`probeGpuDevices` maps its failures to `[]` by contract) — replaces the old
 * result with the current stamped one and notifies. The key and the session epoch are captured
 * BEFORE the await, and admission is re-checked after it: a probe that outlives a lock, or a
 * lock and a re-unlock, never writes into a session it was not admitted to (the AUD-03 seam
 * `startModelRuntime` uses; a stand-in workspace without the counter skips the epoch half).
 */
async function probeAndPersistGpu(ctx: AppContext): Promise<GpuBenchmarkInput> {
  let devices: GpuDevice[] = []
  try {
    const binPath = resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, {
      isDev: ctx.isDev
    })
    if (binPath && ctx.probeGpu) {
      const hereKey = machineKey(detectSystem())
      const epoch = ctx.workspace?.unlockEpoch?.()
      devices = await ctx.probeGpu(binPath)
      if (!workspaceAdmitsWork(ctx.workspace)) {
        log.info('GPU probe finished after the workspace locked; result not persisted')
        return gpuSummary(devices)
      }
      if (epoch !== undefined && ctx.workspace.unlockEpoch?.() !== epoch) {
        log.info('GPU probe outlived its workspace session; result not persisted')
        return gpuSummary(devices)
      }
      updateSettings(ctx.db, { gpuProbe: { devices, probedAt: new Date().toISOString(), machineKey: hereKey } })
      // The graphics tile and the memory class read this probe: an empty device list is a
      // result too (the tile flips to "None"), so the write notifies either way.
      notifyPerformanceChanged()
    }
  } catch (err) {
    log.warn('GPU probe failed (benchmark continues without it)', String(err))
  }
  return gpuSummary(devices)
}

/**
 * Run the benchmark and persist the result (the shared core of IPC + first-run).
 *
 * #185 — the re-entrancy and busy guard. This is the only entry point (both the Diagnostics
 * button and the first-run background call land here), and it had NO guard at all: two runs
 * started in quick succession, or one started while a chat streamed, both reached the model.
 * The guard is one read of the shared occupancy signal, taken and acted on SYNCHRONOUSLY —
 * before the first `await` — so two callers cannot both see idle, and the span the run then
 * holds covers the whole thing (GPU probe, drive probe, speed probe), which is what makes a
 * second run see the first.
 *
 * The benchmark's own lane is deliberately NOT ignored: a second benchmark seeing the first
 * IS the re-entrancy guard.
 *
 * Throws the friendly, localized refusal (`BenchmarkBusyError`). The Diagnostics button
 * surfaces it; the first-run scheduler (`scheduleFirstBenchmark`) reports it as
 * `'skipped-busy'` and — SD2 — does not retry within the session: the next unlock re-checks,
 * and Diagnostics can run it on demand meanwhile. A refused call emits NO
 * `performance:changed`: the span it saw belongs to the running benchmark, whose own release
 * will announce the idle state — a refusal announcing it would tell the screen the first run
 * had finished.
 *
 * The push (P3, G6): `performance:changed` once the span is taken (`running` flips true —
 * the screen learns about a run it did not start: first-run, moved-drive, another window)
 * and once more in the `finally`, after BOTH the persist and the release, on success and on
 * failure alike. That second push is the idle signal; the progress 'done' step precedes the
 * persist and must not be read as one.
 *
 * Rejects without persisting when the workspace it was admitted to is gone by the time the
 * legs finish (the P7 late-write guard in `runBenchmarkAndPersist`): the measured result is
 * deliberately NOT returned then, because the documented contract of the resolved value is
 * "the reconciled object that was written" (M6), and a lock gate has nothing to show anyway.
 */
export async function runAndPersistBenchmark(
  ctx: AppContext,
  onProgress?: (step: BenchmarkProgressStep) => void
): Promise<BenchmarkResult> {
  const busy = modelBusyLane(ctx)
  if (busy) throw new BenchmarkBusyError(busy)
  const releaseOccupancy = ctx.runtime.occupancy.begin('benchmark')
  notifyPerformanceChanged()
  try {
    return await runBenchmarkAndPersist(ctx, onProgress)
  } finally {
    releaseOccupancy()
    notifyPerformanceChanged()
  }
}

/**
 * The #185 busy refusal, typed so the first-run scheduler can tell "another lane holds the
 * model" (`'skipped-busy'`) from a failure. The message is the friendly, localized lane copy
 * the Diagnostics button shows; `lane` names who held it.
 */
export class BenchmarkBusyError extends Error {
  constructor(readonly lane: ModelBusyLane) {
    super(tMain(modelBusyMessageKey(lane)))
    this.name = 'BenchmarkBusyError'
  }
}

/** The benchmark body, run under the `benchmark` occupancy span held by the caller above. */
async function runBenchmarkAndPersist(
  ctx: AppContext,
  onProgress?: (step: BenchmarkProgressStep) => void
): Promise<BenchmarkResult> {
  // AUD-03 for the benchmark (PR #303 audit P7): WHICH unlocked session this run belongs to,
  // captured before the first await. The GPU probe, the drive probe and the speed leg below take
  // seconds — minutes on a wedged probe — and a lock, or a lock AND a re-unlock, can complete
  // inside that window; the guard after the legs mirrors `startModelRuntime`'s post-hash check
  // and `probeAndPersistGpu`'s, so the result never persists into a session it was not admitted
  // to. Undefined for a stand-in workspace without the counter ⇒ the epoch half is skipped.
  const epoch = ctx.workspace?.unlockEpoch?.()
  const manifests = ctx.manifestsDir
    ? discoverManifests(ctx.manifestsDir).manifests.map((m) => m.manifest)
    : []
  const gpu = await probeAndPersistGpu(ctx)

  // #108: the honest read figure is a byproduct of real loads/hashes (read-speed.ts),
  // injected here via the shared latch-vs-persisted resolution (identity-gated — a
  // foreign persisted sample is never a candidate, M2 — and ranking-aware, so a session
  // checksum sample never shadows THIS machine's persisted model-load one) — a re-run
  // never loses an observation.
  const effectiveRead = effectiveReadOrPersisted(ctx)

  const measured = await runBenchmark({
    workspacePath: ctx.paths.workspacePath,
    manifests,
    runtime: ctx.runtime.active(),
    gpu,
    effectiveRead,
    // #185: the admission guard above ran seconds ago — before the GPU + drive probes — so
    // re-check right at the speed probe, ignoring our OWN span (which is held for this whole
    // function and would otherwise report the benchmark as busy against itself).
    modelBusy: () => modelBusyLane(ctx, { ignore: ['benchmark'] }) != null,
    onProgress
  })

  // The late-write guard (P7): the legs are done, nothing is written yet. A completed lock reads
  // as not admitted; a lock still tearing down reads the same way (`isLocking`, AUD-02); a lock
  // AND a re-unlock look exactly like "still unlocked" — only the session epoch tells that stale
  // run apart. Refused ⇒ nothing is written and the caller's `finally` still releases the span
  // and pushes the idle signal.
  if (!workspaceAdmitsWork(ctx.workspace)) {
    log.info('Benchmark finished after the workspace locked; result not persisted')
    throw new Error('The workspace is locked — the benchmark result was not saved')
  }
  if (epoch !== undefined && ctx.workspace.unlockEpoch?.() !== epoch) {
    log.info('Benchmark outlived its workspace session; result not persisted')
    throw new Error('The workspace was locked and re-opened — the benchmark result was not saved')
  }

  // M6: the drive and speed legs above take seconds, and a model start or a cold hash can
  // land a NEWER sample meanwhile (the read-speed observer persists it onto the outgoing
  // result mid-run). Re-resolve through the same gate now, after both legs, and fold the
  // newest eligible same-machine sample in (the slow-read warning follows it; `ranAt` is
  // the run's) — the sample captured before the run must never overwrite it at commit.
  const result = mergeSampleIntoResult(measured, effectiveReadOrPersisted(ctx))

  // Persist the last result via the settings store (spec §8 defines no benchmarks table),
  // and file it under this machine in the per-computer history (benchmark.md "History per
  // machine") so a drive that travels keeps one result per computer. The OUTGOING
  // `lastBenchmark` is backfilled into the history first (M4: an upgraded workspace holds
  // the previous computer's result only there, and this run replaces it; a same-machine
  // outgoing copy is simply superseded by the upsert). ONE settings write, history first,
  // then lastBenchmark — the store has no multi-key transaction, so the order guarantees a
  // crash between the two rows loses at most the headline copy, never a machine.
  const settings = getSettings(ctx.db)
  const here = machineKey(result)
  const history = upsertHistory(backfillOutgoing(settings.benchmarkHistory, settings.lastBenchmark, here), result)
  updateSettings(ctx.db, { benchmarkHistory: history, lastBenchmark: result })
  log.info('Benchmark complete', {
    profile: result.profile,
    recommendedModelId: result.recommendedModelId,
    ramGb: result.ramGb
  })
  return result
}

// ---- The first-run benchmark: cheap preparation, then the measurement behind the auto-start ----
//
// Spec §2.1 "first-run hardware benchmark": a workspace that was never benchmarked — or a drive
// that arrives on a computer with no stored result (benchmark.md "History per machine") — is
// benchmarked once in the background, so the hardware profile + model recommendation appear
// without the user finding the Diagnostics button. Fired after the workspace becomes usable
// (the plaintext open at startup, or unlock/create). Strictly local; never blocks anything.
//
// WHY TWO HALVES (PR #303 audit L1 / SD2, owner decision G5). The three post-unlock seams used
// to fire `maybeRunFirstBenchmark` and `maybeAutoStartActiveModel` back to back. A model start
// is not an occupancy lane, so the benchmark's 8 MiB write/fsync probe contended with the
// start's multi-GB weight hash + load on the same drive; and `runtime.active()` was captured
// before the drive probe, so a start that reached ready seconds later never got its speed leg.
// The moved-drive path made that reachable on EVERY unlock of a moved drive. So:
//
//   prepareFirstBenchmark   the CHEAP half, synchronous, BEFORE the auto-start is even called:
//                           the admission guard, the session capture, the GPU probe refresh,
//                           and the restore / seed / backfill writes with their pushes — a known
//                           computer's profile and ★ pick come back promptly. Returns a DECISION.
//   scheduleFirstBenchmark  the MEASUREMENT half: waits for the auto-start to settle (success or
//                           failure — a failed start still permits the benchmark, just without
//                           the speed leg), re-checks the world at settlement, then runs.
//
// The wait is BOUNDED, but the bound is a deferral boundary, not permission to overlap the load:
// at the ceiling the scheduler releases its own outcome (`'deferred'`) and leaves exactly ONE
// continuation on the settlement, which re-checks and runs once the start actually settles; a
// session or process that ends first runs nothing (the next launch re-checks). Nothing here ever
// cancels the user's model start, and no new occupancy lane is introduced.
//
// SD2 — one automatic attempt per unlock session. Since the moved-drive check, a key mismatch
// re-triggered a background run at every unlock until a same-machine result persisted, with no
// bound on a machine whose run keeps failing (no binary, an unwritable workspace). `attemptMemo`
// records the attempt per (DB handle, session epoch): a second prepare/schedule in the same
// session is `'skipped-attempted'`; a lock + unlock (a new `Db`, a new epoch) re-checks; and a
// successful MANUAL run persists a same-machine `lastBenchmark`, so the next prepare owes nothing.

/** The measurement `prepareFirstBenchmark` found owed: the workspace was never benchmarked, or
 *  the drive is on a computer with no stored result. */
export type FirstBenchmarkRun = 'first-run' | 'new-machine'

/**
 * What `prepareFirstBenchmark` decided, handed to `scheduleFirstBenchmark`. Plain data: the
 * scheduler re-reads everything live at settlement and trusts only the session identity here.
 */
export interface FirstBenchmarkDecision {
  /** The measurement to schedule; null when nothing is owed (a restore, the same machine, a
   *  legacy result, a locked workspace) or this session already made its one attempt. */
  run: FirstBenchmarkRun | null
  /** True when `run` is null ONLY because this session's automatic attempt was already made (SD2). */
  attempted: boolean
  /** The unlock session the decision was made in — `undefined` for a stand-in without the counter. */
  epoch: number | undefined
  /** This machine's fingerprint at decision time (null when detection failed). */
  hereKey: string | null
}

/** How the scheduled measurement ended. Production callers `void` it; tests await it. */
export type FirstBenchmarkOutcome =
  /** Nothing was owed (restored, same machine, legacy result, or the workspace was locked). */
  | 'not-needed'
  /** The measurement ran and persisted. */
  | 'ran'
  /** Another lane held the model at settlement (a benchmark span, a chat, a doc task, a skill run). */
  | 'skipped-busy'
  /** The workspace locked (or a lock was under way) while the start settled. */
  | 'skipped-admission'
  /** A lock AND a re-unlock completed meanwhile — the new session re-checks on its own. */
  | 'skipped-epoch'
  /** The quit latch is armed. */
  | 'skipped-shutdown'
  /** A result for this computer was persisted meanwhile (a manual run, another window). */
  | 'skipped-already-current'
  /** This session already made its one automatic attempt (SD2). */
  | 'skipped-attempted'
  /** The start did not settle within `FIRST_BENCHMARK_SETTLE_TIMEOUT_MS`; one continuation remains. */
  | 'deferred'
  /** The run threw (a refused late persist included) — logged; Diagnostics can run it on demand. */
  | 'failed'

/** The scheduler's injectable seams — production passes none. */
export interface FirstBenchmarkSchedulerDeps {
  /** Arm `fn` after `ms` and return its cancel: the deferral clock, injectable so the timeout is
   *  testable without real time (the ONLY thing a test may drive with a fake timer). */
  timer?: (fn: () => void, ms: number) => () => void
  /** The deferral boundary; defaults to `FIRST_BENCHMARK_SETTLE_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Test seam: receives the deferred continuation's outcome when the wait timed out. */
  onContinuation?: (outcome: Promise<FirstBenchmarkOutcome>) => void
}

/**
 * How long the scheduler waits for the auto-start before it reports `'deferred'`. Sized to the
 * common slow case, not the worst: a ~5 GB GGUF on the ~70 MB/s USB stick #108 measured is hashed
 * (cold checksum cache) and then loaded — roughly a minute each — so a healthy start on slow media
 * settles around this bound, while the pathological ones (a ladder walk of serial 180 s health
 * timeouts plus the 90 s warm-up) are what the continuation exists for. The value never decides
 * whether the benchmark may overlap the load — it may not; it only decides when the caller's
 * outcome stops waiting.
 */
export const FIRST_BENCHMARK_SETTLE_TIMEOUT_MS = 120_000

const defaultTimer: NonNullable<FirstBenchmarkSchedulerDeps['timer']> = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  // A pending deferral must never keep the process alive on its own: at the ceiling the wait is
  // released and nothing runs unless the start settles.
  handle.unref()
  return () => clearTimeout(handle)
}

/**
 * SD2 — the one automatic attempt this session made, keyed like the persisted-sample memo in
 * registerModelIpc: the workspace DB handle AND the session epoch. A lock/unlock yields a new
 * `Db` and a new epoch, so the next session re-evaluates; a stand-in without the counter is
 * keyed on the handle alone. Set when a scheduling is ACCEPTED (the attempt), never on a
 * `run: null` decision — a session that owed nothing has attempted nothing.
 */
let attemptMemo: { db: Db; epoch: number | undefined } | null = null

/** Test seam: forget the session's attempt (the fixtures call it in `beforeEach`). */
export function resetFirstBenchmarkForTests(): void {
  attemptMemo = null
}

/**
 * G3 — a result whose machine key is unknown, or equal to this machine's, counts as this
 * machine's. The moved-drive check, the settlement re-check and the snapshot's `currentMachine`
 * all make this one call, so they can never contradict each other.
 */
function countsAsThisMachine(key: string | null, here: string | null): boolean {
  return here == null || key == null || here === key
}

/**
 * The cheap half (see the header above): decide whether a measurement is owed, doing the
 * restore / seed / backfill writes and the per-session GPU probe refresh on the way. Synchronous
 * apart from the fire-and-forget probe; never throws (settings unreadable — e.g. just locked
 * again — reads as "nothing owed", and a manual run still works).
 */
export function prepareFirstBenchmark(ctx: AppContext): FirstBenchmarkDecision {
  const nothing: FirstBenchmarkDecision = { run: null, attempted: false, epoch: undefined, hereKey: null }
  try {
    // AUD-02: also skipped while a lock teardown runs — the benchmark spawns a sidecar and
    // persists settings, and the DB stays open for that whole window.
    if (!workspaceAdmitsWork(ctx.workspace)) return nothing
    // AUD-03: the session this decision belongs to. The scheduler compares it at settlement.
    const epoch = ctx.workspace.unlockEpoch?.()
    const db = ctx.db
    const settings = getSettings(db)
    const here = machineKey(detectSystem())
    const owed = (run: FirstBenchmarkRun): FirstBenchmarkDecision => {
      if (attemptMemo && attemptMemo.db === db && attemptMemo.epoch === epoch) {
        log.info('First-run benchmark already attempted in this session; not retrying before the next unlock')
        return { run: null, attempted: true, epoch, hereKey: here }
      }
      log.info(
        run === 'first-run'
          ? 'First run: benchmarking hardware in the background once the model start settles'
          : 'Drive is on a new computer: benchmarking it in the background once the model start settles'
      )
      return { run, attempted: false, epoch, hereKey: here }
    }
    if (settings.lastBenchmark === null) return owed('first-run')
    // Already benchmarked — still refresh the persisted GPU probe for THIS machine/session in
    // the background: a drive moved between machines would otherwise keep showing the previous
    // machine's GPU in Diagnostics until a manual re-benchmark (and older workspaces may have no
    // `gpuProbe` at all). A `--list-devices` subprocess, session-cached — not the measurement.
    void probeAndPersistGpu(ctx)
    // The moved-drive check (benchmark.md "History per machine"): the last result belongs to a
    // DIFFERENT computer than the one we are on. With a stored result for this one, restore it
    // (the recommendation follows the machine, not the drive); without one, this is a first run
    // on this computer, so the measurement is owed. A result with no machine identity (an old
    // blob, a failed detection) never counts as moved — "unknown" keeps what we have.
    const last = machineKey(settings.lastBenchmark)
    if (countsAsThisMachine(last, here)) {
      // The same-machine upgrade seed (M4): a workspace from before the history existed
      // carries its one result only in `lastBenchmark` — file a KEYED result under its
      // machine now, so a later move keeps it; an unkeyed legacy result is left alone
      // entirely (it could never be matched again). `backfillOutgoing` also repairs a
      // history copy that is older than the headline one; nothing is re-run.
      const seeded = backfillOutgoing(settings.benchmarkHistory, settings.lastBenchmark, here)
      if (!historyEquals(seeded, settings.benchmarkHistory)) {
        updateSettings(db, { benchmarkHistory: seeded })
        log.info('Filed the last benchmark result under this computer in the history')
        notifyPerformanceChanged()
      }
      return { run: null, attempted: false, epoch, hereKey: here }
    }
    // Capture the restore destination BEFORE the backfill: the cap protects this
    // machine's entry (`backfillOutgoing` evicts the oldest OTHER machine), and the copy
    // restored is the one read here either way.
    const known = findMachine(settings.benchmarkHistory, here)
    // M4: the outgoing foreign result is seeded into the history before anything replaces
    // it (restore below, or the background run — whose own backfill then finds it already
    // filed and does nothing, so the entry is never duplicated).
    const history = backfillOutgoing(settings.benchmarkHistory, settings.lastBenchmark, here)
    if (known) {
      // History first, then lastBenchmark (the same ordering as the run's persist).
      updateSettings(db, { benchmarkHistory: history, lastBenchmark: known })
      log.info('Drive is back on a known computer: restored its benchmark result', {
        profile: known.profile,
        recommendedModelId: known.recommendedModelId
      })
      // The screen may already be open on the outgoing computer's result: tell it.
      notifyPerformanceChanged()
      return { run: null, attempted: false, epoch, hereKey: here }
    }
    if (!historyEquals(history, settings.benchmarkHistory)) {
      updateSettings(db, { benchmarkHistory: history })
      notifyPerformanceChanged()
    }
    return owed('new-machine')
  } catch {
    return nothing // settings unreadable (e.g. just locked again) — a manual run still works
  }
}

/**
 * The measurement half (see the header above): run the decided measurement once `settled` —
 * the auto-start's promise (`maybeAutoStartActiveModel`), already settled when there was
 * nothing to start — has settled, within the bounded wait. Resolves to the outcome; never
 * rejects. The three post-unlock seams `void` it and stay non-blocking.
 */
export function scheduleFirstBenchmark(
  ctx: AppContext,
  decision: FirstBenchmarkDecision,
  settled: Promise<unknown>,
  deps: FirstBenchmarkSchedulerDeps = {}
): Promise<FirstBenchmarkOutcome> {
  if (decision.run === null) return Promise.resolve(decision.attempted ? 'skipped-attempted' : 'not-needed')
  let db: Db
  try {
    db = ctx.db
  } catch {
    return Promise.resolve('skipped-admission') // locked between prepare and schedule
  }
  // SD2: the memo is checked here too, so a stale decision re-scheduled in the same session
  // (or the same decision scheduled twice) cannot buy a second attempt.
  if (attemptMemo && attemptMemo.db === db && attemptMemo.epoch === decision.epoch) {
    log.info('First-run benchmark already attempted in this session; not scheduling again')
    return Promise.resolve('skipped-attempted')
  }
  attemptMemo = { db, epoch: decision.epoch }
  return runAfterSettled(ctx, decision, settled, deps)
}

async function runAfterSettled(
  ctx: AppContext,
  decision: FirstBenchmarkDecision,
  settled: Promise<unknown>,
  deps: FirstBenchmarkSchedulerDeps
): Promise<FirstBenchmarkOutcome> {
  // A FAILED start settles the wait too: the benchmark still runs, just without the speed leg.
  const quiet = settled.then(
    () => undefined,
    () => undefined
  )
  const timeoutMs = deps.timeoutMs ?? FIRST_BENCHMARK_SETTLE_TIMEOUT_MS
  const arm = deps.timer ?? defaultTimer
  let cancel: () => void = () => undefined
  const expired = new Promise<'expired'>((resolve) => {
    cancel = arm(() => resolve('expired'), timeoutMs)
  })
  const first = await Promise.race([quiet.then(() => 'settled' as const), expired])
  // The start settled first: the timer is cleared; it fired first: clearing a fired timer is a no-op.
  cancel()
  if (first === 'settled') return runOnceSettled(ctx, decision)
  // The deferral boundary: release this outcome, retain exactly ONE continuation on the same
  // settlement. It re-runs the settlement re-checks before anything else, so a session that
  // ended meanwhile runs nothing, and a start that never settles leaves the next launch to
  // re-check. NEVER a run into the unfinished load.
  log.info('First-run benchmark deferred: the model start has not settled within the wait bound', {
    waitedMs: timeoutMs
  })
  const continuation = quiet.then(() => runOnceSettled(ctx, decision))
  deps.onContinuation?.(continuation)
  return 'deferred'
}

/** The settlement re-checks, then the run. Never throws. */
async function runOnceSettled(ctx: AppContext, decision: FirstBenchmarkDecision): Promise<FirstBenchmarkOutcome> {
  const label = decision.run === 'first-run' ? 'First-run benchmark' : 'New-computer benchmark'
  try {
    // The same three guards `startModelRuntime` applies after its long pre-start window
    // (AUD-02 / AUD-03 / CODE-3): the workspace this decision was admitted to must still be the
    // one that is open, and the app must not be quitting.
    if (!workspaceAdmitsWork(ctx.workspace)) {
      log.info(`${label} skipped: the workspace locked while the model start settled`)
      return 'skipped-admission'
    }
    if (decision.epoch !== undefined && ctx.workspace.unlockEpoch?.() !== decision.epoch) {
      log.info(`${label} skipped: the workspace was locked and re-opened meanwhile (the new session re-checks)`)
      return 'skipped-epoch'
    }
    if (ctx.runtime.isShutdown?.()) {
      log.info(`${label} skipped: the app is quitting`)
      return 'skipped-shutdown'
    }
    // #185: the busy refusal lands here too (right after unlock, a doc task or the user's first
    // message can already own the model; a benchmark span means another run is in progress).
    // The same predicate `runAndPersistBenchmark` refuses on, read in the same tick, so the two
    // never disagree. Not retried within the session (SD2); Diagnostics can run it on demand.
    const busy = modelBusyLane(ctx)
    if (busy) {
      log.info(`${label} skipped: the model is busy (${busy}); re-run from Diagnostics`)
      return 'skipped-busy'
    }
    // A manual run, or another window's, may have supplied this computer's result while the
    // start settled: measuring again would only replace it with a same-session duplicate.
    const last = getSettings(ctx.db).lastBenchmark
    if (last !== null && countsAsThisMachine(machineKey(last), decision.hereKey)) {
      log.info(`${label} skipped: a result for this computer was saved meanwhile`)
      return 'skipped-already-current'
    }
  } catch (err) {
    log.warn(`${label} skipped: the workspace could not be read`, String(err))
    return 'failed'
  }
  try {
    await runAndPersistBenchmark(ctx)
    return 'ran'
  } catch (err) {
    // Unreachable in practice (the lane check above ran in the same tick) — kept so the outcome
    // can never misreport a refusal as a failure.
    if (err instanceof BenchmarkBusyError) return 'skipped-busy'
    log.warn('First-run benchmark skipped or failed (re-run from Diagnostics)', String(err))
    return 'failed'
  }
}

/**
 * The pre-P7 shape for callers that only have `ctx` — tests, and the audit probes; no production
 * seam calls it since P7 (the three post-unlock seams run the split so the measurement waits for
 * the auto-start). Prepares, then schedules against an already-settled promise, so the
 * measurement runs at once. Resolves to the scheduling outcome; never rejects.
 */
export function maybeRunFirstBenchmark(ctx: AppContext): Promise<FirstBenchmarkOutcome> {
  return scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), Promise.resolve())
}

/**
 * "Try GPU again" (Diagnostics): clearing the flags alone is not enough —
 * a probe that timed out once (cold/wedged driver) stays cached for the session and
 * would keep labeling a now-working GPU machine as CPU. Invalidate the cache, clear
 * the flags, re-probe + persist, and hand the renderer the fresh settings.
 *
 * #182: the session latch that switches the speculative rung off after one bad attempt is
 * the same shape of sticky, hardware-derived "no" — this button is the user asking for the
 * accelerated paths back, so it re-arms that too (the ladder's VRAM/probe guard still has
 * the final say on the next start).
 */
export async function tryGpuAgain(ctx: AppContext): Promise<AppSettings> {
  ctx.probeGpu?.invalidate?.()
  clearSpeculativeSuppression()
  updateSettings(ctx.db, { gpuAutoDisabled: false, gpuLastError: null })
  await probeAndPersistGpu(ctx)
  return getSettings(ctx.db)
}

/**
 * Is the ACTIVE chat model resident and ready? Read from the runtime's state, never from
 * `active() != null` alone and never from the placement latch (DR6): the placement is
 * recorded when the rung is healthy but BEFORE the #109 warm-up generation finishes, and
 * `status().running` stays false for that whole window — so a loading model reads "not
 * loaded" until it is actually ready. A start in flight (a first start or a switch) reads
 * the same way, and a runtime running some OTHER model than the active one does not count
 * for this row. Optional-chained like the sibling service probes: partial test contexts
 * build a `runtime` with only the members they need.
 */
function chatModelResident(ctx: AppContext, activeId: string | null): boolean {
  const status = ctx.runtime?.status?.()
  if (!status || !status.running || !status.healthy || status.startingModelId) return false
  return activeId == null || status.modelId === activeId
}

/**
 * The "Your model" block: the active model against this computer's memory. `probe` is the
 * ELIGIBLE probe (`eligibleGpuProbe` — this machine's or unstamped, never a known-foreign
 * one): the memory class, the VRAM budget and the selected device all come from it, and from
 * nothing else (PR #303 audit M8, one source).
 */
function buildPlacement(
  ctx: AppContext,
  settings: AppSettings,
  here: string | null,
  ramGb: number,
  probe: GpuProbeResult | null
): PerformanceSnapshot['placement'] {
  const devices = probe?.devices ?? []
  const memoryClass = memoryClassOf(process.platform, process.arch, devices)
  const ramMb = ramGb > 0 ? Math.round(ramGb * 1024) : null
  // The SELECTED device (the first useful discrete one): its memory is the budget, its name
  // the join key for the observed free/working figures. An integrated-only box has no VRAM
  // budget at all — its shared figure is not the card's own (M8.1).
  const selected = primaryUsefulDevice(devices)
  const vramMb = selected?.totalMb ?? null
  const activeId = settings.activeModelId
  const manifests: ModelManifest[] = ctx.manifestsDir
    ? discoverManifests(ctx.manifestsDir).manifests.map((m) => m.manifest)
    : []
  // Manifests state decimal GB; the screen's other figures are GiB (RAM, VRAM, the observed
  // buffers), so convert once here rather than show 19.8 "on disk" beside 18.9 "takes".
  const gib = (m: ModelManifest | undefined): number | null =>
    m ? Math.round(((m.sizeOnDiskGb * 1e9) / 1024 ** 3) * 10) / 10 : null
  // The context a start would ACTUALLY use, resolved by the launch path's own helper
  // (`launchContextTokens`) rather than re-derived here (PR #303 audit M5 residual). The old
  // `??` chain differed from it in one real case: a manifest whose `recommended_context_tokens`
  // is missing or 0 (the parser returns 0) showed a "0-token context" while the runtime starts
  // on `settings.contextTokens`. One helper, one answer, for the active AND the recommended
  // model — the screen no longer recomputes either.
  const contextFor = (modelId: string | null): number | null =>
    modelId == null ? null : launchContextTokens(settings, manifests.find((m) => m.id === modelId) ?? null)
  let model: PerformanceSnapshot['placement']['model'] = null
  if (activeId) {
    model = {
      id: activeId,
      sizeOnDiskGb: gib(manifests.find((m) => m.id === activeId)) ?? 0,
      contextTokens: contextFor(activeId) ?? settings.contextTokens
    }
  }
  const recommendedContextTokens = contextFor(settings.lastBenchmark?.recommendedModelId ?? null)
  // The session latch wins (this start), else the persisted record; either counts only for
  // the active model on THIS machine (an unknown machine on either side is accepted).
  const latched = latestModelPlacement()
  const candidate = activeId
    ? latched?.modelId === activeId
      ? latched
      : (settings.modelPlacements[activeId] ?? null)
    : null
  const mine =
    candidate && (here == null || candidate.machineKey == null || candidate.machineKey === here) ? candidate : null
  // MEASURED EVIDENCE MUST MATCH THE CONFIGURATION (PR #303 audit). A placement is a
  // measurement of ONE start: this model, this machine (above), with a specific context and on
  // a specific backend. Change the context size, or force the processor after a GPU start, and
  // the stored buffers describe a run the app would no longer perform — presenting them as
  // "measured" would state a fit the current settings never asked for. The record is KEPT (the
  // next matching start restores it, and it is still the truth about that start); the row falls
  // back to the weights-only estimate, and the mismatch travels with the snapshot so the copy
  // can say when the earlier measurement was taken. A configuration that forces the processor
  // (`gpuMode: 'off'`, or the auto-disable after a GPU failure) admits only a `cpu` record; an
  // 'auto' configuration admits either, because the ladder itself decides per start.
  const cpuOnly = settings.gpuMode === 'off' || settings.gpuAutoDisabled
  const matchesConfig = (p: ModelPlacement): boolean =>
    p.contextTokens === (model?.contextTokens ?? null) && (!cpuOnly || p.backend === 'cpu')
  const observed = mine && matchesConfig(mine) ? mine : null
  const observedMismatch =
    mine && !matchesConfig(mine) ? { contextTokens: mine.contextTokens, backend: mine.backend, at: mine.at } : null
  // Every model the app can hold (benchmark.md "Models on this computer"): chat and translation
  // auto-fit onto the card; images, document search and voice are pinned to the processor by
  // design (contention immunity; vision/runtime.ts, embeddings/e5.ts, reranker/llama.ts).
  // Liveness comes from each service's own handle; whisper is a CLI that runs only while
  // transcribing.
  //
  // CAPABILITY IS NOT EXECUTION (PR #303 audit DR1): the memory class says the machine HAS a
  // usable card; whether chat and translation actually go there depends on the configuration
  // and on what was observed. Chat says 'cpu' when the class is cpu, when the GPU is switched
  // off or auto-disabled, or when the matching observed start landed on the CPU backend;
  // translation says 'cpu' under the same class/config, or when its sidecar's posture is the
  // forced `--device none` (`deviceStatus().device === 'cpu'`, the session fallback latch).
  const byRole = (role: ModelManifest['role']): ModelManifest | undefined => manifests.find((m) => m.role === role)
  const embeddingsManifest = settings.activeEmbeddingModelId
    ? (manifests.find((m) => m.id === settings.activeEmbeddingModelId) ?? byRole('embeddings'))
    : byRole('embeddings')
  const cardEligible = memoryClass !== 'cpu' && !cpuOnly
  const chatDevice: ResidentModelRow['device'] = cardEligible && observed?.backend !== 'cpu' ? 'gpu' : 'cpu'
  const translation = ctx.translator?.deviceStatus?.() ?? null
  const translationDevice: ResidentModelRow['device'] = cardEligible && translation?.device !== 'cpu' ? 'gpu' : 'cpu'
  const chatResident = chatModelResident(ctx, activeId)
  const allRows: ResidentModelRow[] = [
    {
      role: 'chat',
      modelId: activeId,
      sizeOnDiskGb: model?.sizeOnDiskGb ?? null,
      device: chatDevice,
      loaded: chatResident,
      lifetime: 'session',
      gpuLayers: null,
      totalLayers: null
    },
    {
      role: 'translation',
      modelId: byRole('translation')?.id ?? null,
      sizeOnDiskGb: gib(byRole('translation')),
      device: translationDevice,
      loaded: translation?.live ?? false,
      lifetime: 'idle',
      gpuLayers: translation?.live ? translation.gpuLayers : null,
      totalLayers: translation?.live ? translation.totalLayers : null
    },
    {
      role: 'vision',
      modelId: byRole('vision')?.id ?? null,
      sizeOnDiskGb: gib(byRole('vision')),
      device: 'cpu',
      loaded: ctx.vision?.isLoaded?.() ?? false,
      lifetime: 'idle',
      gpuLayers: null,
      totalLayers: null
    },
    {
      role: 'reranker',
      modelId: byRole('reranker')?.id ?? null,
      sizeOnDiskGb: gib(byRole('reranker')),
      device: 'cpu',
      loaded: ctx.reranker?.isLoaded?.() ?? false,
      lifetime: 'session',
      gpuLayers: null,
      totalLayers: null
    },
    {
      role: 'embeddings',
      modelId: embeddingsManifest?.id ?? null,
      sizeOnDiskGb: gib(embeddingsManifest),
      device: 'cpu',
      loaded: ctx.embedder?.isLoaded?.() ?? false,
      lifetime: 'session',
      gpuLayers: null,
      totalLayers: null
    },
    {
      role: 'transcriber',
      modelId: byRole('transcriber')?.id ?? null,
      sizeOnDiskGb: gib(byRole('transcriber')),
      device: 'cpu',
      loaded: false,
      lifetime: 'per-use',
      gpuLayers: null,
      totalLayers: null
    }
  ]
  const rows = allRows.filter((r) => r.role === 'chat' || r.modelId != null)
  // The verdict is asked for the EFFECTIVE class: a configuration that forces the processor
  // gets the RAM estimate ("Will run on the processor"), never "Should fit in graphics memory"
  // for a card the start would not use (DR1); a matching start OBSERVED on the CPU backend
  // (the ladder fell through under 'auto') is judged against RAM too, as its row says.
  // `memoryClassOf` — the profile bump's gate — and the snapshot's `memoryClass` (the
  // hardware, which the tiles describe) are unchanged (G4).
  const effectiveClass: MemoryClass = cpuOnly || observed?.backend === 'cpu' ? 'cpu' : memoryClass
  const verdict = placementVerdict({
    memoryClass: effectiveClass,
    ramMb,
    vramMb,
    sizeOnDiskGb: model?.sizeOnDiskGb ?? null,
    observed,
    gpuName: selected?.name ?? null
  })
  // Both on the card (the start-order contention): only rows that SAY 'gpu', with the chat
  // model resident and its observed start actually on the GPU with layers offloaded (no
  // observation under a GPU-eligible configuration counts too), and the translation sidecar
  // live with layers on the card — a live sidecar at 0 offloaded layers is not on the card.
  const chatOnCard =
    chatDevice === 'gpu' &&
    chatResident &&
    (observed == null || (observed.backend === 'gpu' && (observed.gpuLayers ?? 0) > 0))
  const translationOnCard =
    translationDevice === 'gpu' && (translation?.live ?? false) && (translation?.gpuLayers ?? 0) > 0
  const totals = {
    ramAllMb: loadedAtOnceMb({ memoryClass, rows, verdict }),
    bothOnCard: chatOnCard && translationOnCard
  }
  return {
    memoryClass,
    ramMb,
    vramMb,
    model,
    recommendedContextTokens,
    observed,
    observedMismatch,
    verdict,
    models: rows,
    totals
  }
}

/**
 * The Performance screen's one read: the last result and whether it is this computer's,
 * the other computers the drive has been checked on, whether a run is in progress, the
 * placement block, and the session's observed figures. A GETTER: it must never call
 * `notifyPerformanceChanged` (the push would fan a read out into more reads).
 *
 * `observed` (M3 / G2) is SESSION latches only — the last finished answer, the newest
 * `model_load` sample, the newest `checksum` sample, each latched in the main process and
 * cleared with it (they survive a workspace lock/unlock, never a restart). The persisted
 * `current.effectiveRead` is deliberately NOT a fallback here, for a same-machine result as
 * much as a foreign one: the copy promises "while you worked", and a weeks-old sample is not
 * that. The Drive tile reads the persisted figure with its own source and date instead.
 */
export function buildPerformanceSnapshot(ctx: AppContext): PerformanceSnapshot {
  // Every record below is already VALIDATED: `getSettings` normalizes `lastBenchmark`,
  // `benchmarkHistory` and `modelPlacements` on read (PR #303 audit H1/L8), so the snapshot
  // composes trustworthy records and nothing here has to defend against `{}`.
  const settings = getSettings(ctx.db)
  const sys = detectSystem()
  const here = machineKey(sys)
  const current = settings.lastBenchmark
  const currentKey = machineKey(current)
  // ONE source for every graphics figure (PR #303 audit M8, owner decisions G3/G4): the probe
  // when it is this machine's — stamped here, or unstamped (a legacy probe, unverifiable until
  // a local refresh replaces it) — and NOTHING when it is stamped with another machine's key.
  // Of it, ONE device: the first useful discrete one, else the first listed with `useful:
  // false` (`displayDevice`), its name and memory always paired.
  const probe = eligibleGpuProbe(settings.gpuProbe, here)
  const shown = displayDevice(probe?.devices ?? [])
  // An unknown identity on either side reads as "this machine": the moved-drive check in
  // prepareFirstBenchmark makes the same call, so the two never contradict each other.
  const currentMachine = countsAsThisMachine(currentKey, here)
  // A result persisted before `gpuVramMb` existed (or one whose probe came back empty) gets
  // the eligible probe's device folded in — name AND memory, from the same device, so an old
  // iGPU name is never paired with a dGPU's figure — for THIS machine only: the graphics tile
  // must not wait for a re-run when the app already knows the card.
  const filled =
    current && current.gpuVramMb == null && currentMachine && shown
      ? { ...current, gpu: shown.device.name, gpuVramMb: shown.device.totalMb }
      : current
  return {
    current: filled,
    currentGpu: shown ? { name: shown.device.name, totalMb: shown.device.totalMb, useful: shown.useful } : null,
    currentMachine,
    otherMachines: otherMachines(settings.benchmarkHistory, currentKey ?? here),
    // The benchmark's OWN span, read directly (M1): `modelBusyLane` answers "chat" first, so a
    // permitted foreground answer used to hide a held benchmark span and the screen re-enabled
    // its button mid-run.
    running: ctx.runtime.occupancy.held('benchmark'),
    placement: buildPlacement(ctx, settings, here, sys.ramGb, probe),
    observed: {
      lastAnswer: latestAnswerSpeed(),
      lastModelLoad: latestEffectiveReadBySource('model_load'),
      lastChecksum: latestEffectiveReadBySource('checksum')
    }
  }
}

/**
 * The chat-stream answer-speed observer's body (wired in `initBackend` through
 * `setAnswerSpeedObserver`): latch the finished answer's #290 payload with the model that
 * produced it, then push. The latch itself (`recordAnswerSpeed`) stays pure; the push lives
 * here in the IPC layer. Local-API answers never pass through the chat observer, so they
 * never latch (documented, not changed).
 */
export function observeAnswerSpeed(ctx: AppContext, speed: AnswerSpeed): void {
  recordAnswerSpeed(speed, ctx.runtime.active()?.modelId ?? null)
  notifyPerformanceChanged()
}

export function registerBenchmarkIpc(ctx: AppContext): void {
  const ipcHandle = guardedHandleFor(ctx)
  // Persist every observed placement under its model id (benchmark.md "Your model"), so the
  // row survives a restart. Skipped while locked; a failure is logged, never thrown into a start.
  // The session latch already moved before this observer ran, and the snapshot reads the
  // latch first — so the push follows the observation even when the persist is skipped.
  setModelPlacementObserver((placement) => {
    try {
      if (workspaceAdmitsWork(ctx.workspace)) {
        const placements = { ...getSettings(ctx.db).modelPlacements, [placement.modelId]: placement }
        updateSettings(ctx.db, { modelPlacements: placements })
      }
    } catch (err) {
      log.warn('Could not persist the model placement', { error: String(err) })
    }
    notifyPerformanceChanged()
  })

  // SEC-N2: both handlers touch ctx.db (via updateSettings/getSettings). The ctx.db getter already
  // fail-closes when the workspace is locked, but it throws a raw English string; mirror every other
  // DB-touching handler with an explicit requireUnlocked() so a locked call surfaces the localized
  // main.benchmark.locked instead (parity, and the parametrized lock test now covers these too).
  const requireUnlocked = (): void => {
    // AUD-02: `workspaceAdmitsWork`, never a bare `isUnlocked()` — the workspace DB stays
    // OPEN for the whole multi-second lock teardown, so a bare check admits work that then
    // lazily respawns the sidecars that teardown just killed. This module's copy is unchanged.
    if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.benchmark.locked'))
  }
  ipcHandle(IPC.runBenchmark, (event): Promise<BenchmarkResult> => {
    requireUnlocked()
    // Steps go to the window that pressed the button (the Performance screen's step list);
    // a window closed mid-run simply stops receiving them.
    return runAndPersistBenchmark(ctx, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(EVENTS.benchmarkProgress, step)
    })
  })
  ipcHandle(IPC.getPerformance, (): PerformanceSnapshot => {
    requireUnlocked()
    return buildPerformanceSnapshot(ctx)
  })
  ipcHandle(IPC.tryGpuAgain, (): Promise<AppSettings> => {
    requireUnlocked()
    return tryGpuAgain(ctx)
  })
}
