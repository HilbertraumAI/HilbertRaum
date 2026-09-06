import { guardedHandleFor } from './guarded-handle'
import { clearSpeculativeSuppression } from '../services/runtime/factory'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  AppSettings,
  BenchmarkProgressStep,
  BenchmarkResult,
  GpuDevice,
  PerformanceSnapshot,
  ResidentModelRow
} from '../../shared/types'
import type { ModelManifest } from '../../shared/manifest'
import { detectSystem, runBenchmark, type GpuBenchmarkInput } from '../services/benchmark'
import { effectiveReadOrPersisted } from './registerModelIpc'
import { backfillOutgoing, historyEquals, mergeSampleIntoResult } from '../services/benchmark-persistence'
import {
  findMachine,
  latestAnswerSpeed,
  machineKey,
  nextStartMemory,
  otherMachines,
  placementVerdict,
  upsertHistory,
  type NextStartMemory
} from '../services/performance'
import { latestModelPlacement, setModelPlacementObserver } from '../services/runtime/placement'
import { latestEffectiveReadBySource } from '../services/read-speed'
import { EVENTS } from '../../shared/ipc'
import { gpuUsefulForProfile } from '../services/runtime/gpu'
import { resolveLlamaServerPath } from '../services/runtime/sidecar'
import { discoverManifests } from '../services/models'
import { getSettings, updateSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { modelBusyLane, modelBusyMessageKey } from './model-busy'
import { log } from '../services/logging'

// IPC for the hardware benchmark + model recommendation (spec §9.1, §11).
//
// `runBenchmark()` detects RAM/CPU/OS, probes drive speed in the workspace, optionally
// estimates tokens/sec from the running runtime, classifies a HardwareProfile, and
// recommends a chat model — STRICTLY LOCAL (no network/telemetry). The result is persisted
// to settings (`lastBenchmark`) so the recommendation pipeline (registerModelIpc) and
// `getAppStatus().hardwareProfile` read the real, detected profile instead of a stub.

/**
 * Run the (session-cached) GPU probe on the drive's own `llama-server` and persist the
 * result to `settings.gpuProbe` (architecture.md GPU record §5.4) — so Diagnostics +
 * profile classification have device info without re-probing every launch. The probe
 * stays OUT of benchmark.ts (which keeps zero `child_process`); the summary is injected.
 * Never throws: no binary / no devices / probe failure → a null-name, not-useful input.
 *
 * The summary names the BUDGET device for the next start (`nextStartMemory`, PR #308 audit
 * decisions 6 and 9), never `devices[0]`: the class and the card honour `gpuMode` /
 * `gpuAutoDisabled`, and the same helper feeds `listModels` and the Performance screen, so
 * `BenchmarkResult.gpu` / `gpuVramMb` and the Models ★ agree on which card they mean.
 *
 * A probe that CANNOT run (no binary resolves, no session probe) or that THREW persists an
 * EMPTY probe (`{ devices: [], probedAt }`), exactly as an empty successful probe does (PR #308
 * audit decision 6, findings R3/R5; GPU record §5.4): a card persisted on a previous machine
 * or before the runtime was removed used to survive both paths, so the Models ★ kept a card
 * pick while this benchmark reported the RAM pick. Now every path leaves `settings.gpuProbe`
 * describing THIS session's probe, and the badge, the benchmark and the tile read one record.
 */
async function probeAndPersistGpu(ctx: AppContext): Promise<GpuBenchmarkInput> {
  let devices: GpuDevice[] = []
  let gpuMode: AppSettings['gpuMode'] = 'auto'
  let gpuAutoDisabled = false
  const persistProbe = (list: GpuDevice[]): void => {
    updateSettings(ctx.db, { gpuProbe: { devices: list, probedAt: new Date().toISOString() } })
  }
  try {
    const binPath = resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, {
      isDev: ctx.isDev
    })
    if (binPath && ctx.probeGpu) devices = await ctx.probeGpu(binPath)
    persistProbe(devices)
  } catch (err) {
    log.warn('GPU probe failed (benchmark continues without it)', String(err))
    devices = []
    // The thrown path persists the same empty probe; its own write must not escape either
    // (a workspace locked mid-run throws from `ctx.db`) — this function never throws.
    try {
      persistProbe([])
    } catch (persistErr) {
      log.warn('Could not persist the empty GPU probe', String(persistErr))
    }
  }
  // Read the flags AFTER the probe persisted: `tryGpuAgain` clears `gpuAutoDisabled` right
  // before it re-probes, and the summary must describe the start that follows that click. An
  // unreadable settings row (locked) falls back to the GPU-on defaults.
  try {
    ;({ gpuMode, gpuAutoDisabled } = getSettings(ctx.db))
  } catch {
    /* defaults */
  }
  const next = nextStartMemory({ platform: process.platform, arch: process.arch, devices, gpuMode, gpuAutoDisabled })
  return {
    name: next.device?.name ?? null,
    // The profile bump looks at the HARDWARE (every probed device); the class below looks at
    // the next START — see `GpuBenchmarkInput.useful`.
    useful: gpuUsefulForProfile(devices),
    totalMb: next.device?.totalMb ?? null,
    memoryClass: next.memoryClass
  }
}

/** The next start's memory class and budget device, from the persisted probe and the GPU flags. */
function nextStartMemoryFor(settings: AppSettings): NextStartMemory {
  return nextStartMemory({
    platform: process.platform,
    arch: process.arch,
    devices: settings.gpuProbe?.devices ?? [],
    gpuMode: settings.gpuMode,
    gpuAutoDisabled: settings.gpuAutoDisabled
  })
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
 * Throws the friendly, localized refusal. The Diagnostics button surfaces it; the first-run
 * caller (`maybeRunFirstBenchmark`) already logs and drops it, and re-runs next launch because
 * `lastBenchmark` stays null.
 */
export async function runAndPersistBenchmark(
  ctx: AppContext,
  onProgress?: (step: BenchmarkProgressStep) => void
): Promise<BenchmarkResult> {
  const busy = modelBusyLane(ctx)
  if (busy) throw new Error(tMain(modelBusyMessageKey(busy)))
  const releaseOccupancy = ctx.runtime.occupancy.begin('benchmark')
  try {
    return await runBenchmarkAndPersist(ctx, onProgress)
  } finally {
    releaseOccupancy()
  }
}

/** The benchmark body, run under the `benchmark` occupancy span held by the caller above. */
async function runBenchmarkAndPersist(
  ctx: AppContext,
  onProgress?: (step: BenchmarkProgressStep) => void
): Promise<BenchmarkResult> {
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

/**
 * Spec §2.1 "first-run hardware benchmark": if this workspace has never been
 * benchmarked, run it once in the background so the hardware profile + model
 * recommendation appear without the user having to find the Diagnostics button. Fired
 * after the workspace becomes usable (plaintext open at startup, or unlock/create).
 * Strictly local; failures are logged and never block anything.
 */
export function maybeRunFirstBenchmark(ctx: AppContext): void {
  try {
    // AUD-02: also skipped while a lock teardown runs — the benchmark spawns a sidecar and
    // persists settings, and the DB stays open for that whole window.
    if (!workspaceAdmitsWork(ctx.workspace)) return
    const settings = getSettings(ctx.db)
    if (settings.lastBenchmark !== null) {
      // Already benchmarked — still refresh the persisted GPU probe for THIS
      // machine/session in the background: a drive moved between machines would
      // otherwise keep showing the previous machine's GPU in Diagnostics until a
      // manual re-benchmark (and older workspaces may have no `gpuProbe` at all).
      void probeAndPersistGpu(ctx)
      // The moved-drive check (benchmark.md "History per machine"): the last result belongs
      // to a DIFFERENT computer than the one we are on. With a stored result for this one,
      // restore it (the recommendation follows the machine, not the drive); without one, this
      // is a first run on this computer, so fall through to the background benchmark. A
      // result with no machine identity (an old blob, a failed detection) never counts as
      // moved — "unknown" keeps what we have.
      const here = machineKey(detectSystem())
      const last = machineKey(settings.lastBenchmark)
      if (here == null || last == null || here === last) {
        // The same-machine upgrade seed (M4): a workspace from before the history existed
        // carries its one result only in `lastBenchmark` — file a KEYED result under its
        // machine now, so a later move keeps it; an unkeyed legacy result is left alone
        // entirely (it could never be matched again). `backfillOutgoing` also repairs a
        // history copy that is older than the headline one; nothing is re-run.
        const seeded = backfillOutgoing(settings.benchmarkHistory, settings.lastBenchmark, here)
        if (!historyEquals(seeded, settings.benchmarkHistory)) {
          updateSettings(ctx.db, { benchmarkHistory: seeded })
          log.info('Filed the last benchmark result under this computer in the history')
        }
        return
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
        updateSettings(ctx.db, { benchmarkHistory: history, lastBenchmark: known })
        log.info('Drive is back on a known computer: restored its benchmark result', {
          profile: known.profile,
          recommendedModelId: known.recommendedModelId
        })
        return
      }
      if (!historyEquals(history, settings.benchmarkHistory)) {
        updateSettings(ctx.db, { benchmarkHistory: history })
      }
      log.info('Drive is on a new computer: benchmarking it in the background')
    } else {
      log.info('First run: benchmarking hardware in the background')
    }
  } catch {
    return // settings unreadable (e.g. just locked again) — a manual run still works
  }
  // #185: the busy refusal lands here too (this fires right after unlock, where a doc task or
  // the user's first message can already own the model). Dropping it is correct — `lastBenchmark`
  // stays null, so the next launch tries again, and Diagnostics can run it on demand meanwhile.
  void runAndPersistBenchmark(ctx).catch((err) =>
    log.warn('First-run benchmark skipped or failed (re-run from Diagnostics)', String(err))
  )
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
 * The Performance screen's one read: the last result and whether it is this computer's,
 * the other computers the drive has been checked on, whether a run is in progress, and the
 * session's observed figures (a finished answer, a model start, a file check) — the latter
 * two straight from the read-speed latches, never persisted.
 */
/** The "Your model" block: the active model against this computer's memory. */
function buildPlacement(
  ctx: AppContext,
  settings: AppSettings,
  here: string | null,
  ramGb: number,
  memory: NextStartMemory
): PerformanceSnapshot['placement'] {
  // The class and the card are the NEXT start's (GPU off / auto-disabled → cpu, no card); the
  // observed placement below is what the LAST start did and is kept as an observation.
  const { memoryClass } = memory
  const ramMb = ramGb > 0 ? Math.round(ramGb * 1024) : null
  const vramMb = memory.device?.totalMb ?? null
  const activeId = settings.activeModelId
  const manifests: ModelManifest[] = ctx.manifestsDir
    ? discoverManifests(ctx.manifestsDir).manifests.map((m) => m.manifest)
    : []
  // Manifests state decimal GB; the screen's other figures are GiB (RAM, VRAM, the observed
  // buffers), so convert once here rather than show 19.8 "on disk" beside 18.9 "takes".
  const gib = (m: ModelManifest | undefined): number | null =>
    m ? Math.round(((m.sizeOnDiskGb * 1e9) / 1024 ** 3) * 10) / 10 : null
  let model: PerformanceSnapshot['placement']['model'] = null
  if (activeId) {
    const manifest = manifests.find((m) => m.id === activeId)
    model = {
      id: activeId,
      sizeOnDiskGb: gib(manifest) ?? 0,
      contextTokens: settings.contextTokensOverride ?? manifest?.recommendedContextTokens ?? settings.contextTokens
    }
  }
  // Every model the app can hold (benchmark.md "Models on this computer"): chat and translation
  // auto-fit onto the card (on a machine with one); images, document search and voice are pinned
  // to the processor by design (contention immunity; vision/runtime.ts, embeddings/e5.ts,
  // reranker/llama.ts). Liveness comes from each service's own handle; whisper is a CLI that
  // runs only while transcribing.
  const byRole = (role: ModelManifest['role']): ModelManifest | undefined => manifests.find((m) => m.role === role)
  const embeddingsManifest = settings.activeEmbeddingModelId
    ? (manifests.find((m) => m.id === settings.activeEmbeddingModelId) ?? byRole('embeddings'))
    : byRole('embeddings')
  const gpuDevice: ResidentModelRow['device'] = memoryClass === 'cpu' ? 'cpu' : 'gpu'
  const translation = ctx.translator?.deviceStatus?.() ?? null
  const allRows: ResidentModelRow[] = [
    {
      role: 'chat',
      modelId: activeId,
      sizeOnDiskGb: model?.sizeOnDiskGb ?? null,
      device: gpuDevice,
      loaded: ctx.runtime.active() != null,
      lifetime: 'session',
      gpuLayers: null,
      totalLayers: null
    },
    {
      role: 'translation',
      modelId: byRole('translation')?.id ?? null,
      sizeOnDiskGb: gib(byRole('translation')),
      device: gpuDevice,
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
  const sizes = rows.map((r) => r.sizeOnDiskGb).filter((x): x is number => x != null)
  const totals = {
    ramAllMb: sizes.length === 0 ? null : Math.round(sizes.reduce((a, b) => a + b, 0) * 1024),
    bothOnCard: gpuDevice === 'gpu' && rows[0].loaded && (rows.find((r) => r.role === 'translation')?.loaded ?? false)
  }
  // The session latch wins (this start), else the persisted record; either counts only for
  // the active model on THIS machine (an unknown machine on either side is accepted).
  const latched = latestModelPlacement()
  const candidate = activeId
    ? latched?.modelId === activeId
      ? latched
      : (settings.modelPlacements[activeId] ?? null)
    : null
  const observed =
    candidate && (here == null || candidate.machineKey == null || candidate.machineKey === here) ? candidate : null
  return {
    memoryClass,
    ramMb,
    vramMb,
    model,
    observed,
    verdict: placementVerdict({ memoryClass, ramMb, vramMb, sizeOnDiskGb: model?.sizeOnDiskGb ?? null, observed }),
    models: rows,
    totals
  }
}

export function buildPerformanceSnapshot(ctx: AppContext): PerformanceSnapshot {
  const settings = getSettings(ctx.db)
  const sys = detectSystem()
  const here = machineKey(sys)
  const current = settings.lastBenchmark
  const currentKey = machineKey(current)
  // The persisted model-load sample outlives the session; the session latch wins when it
  // exists (a start we just watched), otherwise the last persisted one still says how the
  // last start on this drive went.
  const persistedLoad =
    current?.effectiveRead?.source === 'model_load' ? current.effectiveRead : null
  // The BUDGET device for the next start (decision 9), the same one `probeAndPersistGpu` and
  // `listModels` name — never the first device the driver happened to list.
  const memory = nextStartMemoryFor(settings)
  const probed = memory.device
  // An unknown identity on either side reads as "this machine": the moved-drive check in
  // maybeRunFirstBenchmark makes the same call, so the two never contradict each other.
  const currentMachine = here == null || currentKey == null || here === currentKey
  // A result persisted before `gpuVramMb` existed (or one whose probe came back empty) gets
  // the live probe's figure folded in, for THIS machine only: the graphics tile must not
  // wait for a re-run when the app already knows the card.
  const filled =
    current && current.gpuVramMb == null && currentMachine && probed
      ? { ...current, gpuVramMb: probed.totalMb, gpu: current.gpu ?? probed.name }
      : current
  return {
    current: filled,
    currentGpu: probed ? { name: probed.name, totalMb: probed.totalMb } : null,
    currentMachine,
    otherMachines: otherMachines(settings.benchmarkHistory, currentKey ?? here),
    running: modelBusyLane(ctx) === 'benchmark',
    placement: buildPlacement(ctx, settings, here, sys.ramGb, memory),
    observed: {
      lastAnswer: latestAnswerSpeed(),
      lastModelLoad: latestEffectiveReadBySource('model_load') ?? persistedLoad,
      lastChecksum: latestEffectiveReadBySource('checksum')
    }
  }
}

export function registerBenchmarkIpc(ctx: AppContext): void {
  const ipcHandle = guardedHandleFor(ctx)
  // Persist every observed placement under its model id (benchmark.md "Your model"), so the
  // row survives a restart. Skipped while locked; a failure is logged, never thrown into a start.
  setModelPlacementObserver((placement) => {
    try {
      if (!workspaceAdmitsWork(ctx.workspace)) return
      const placements = { ...getSettings(ctx.db).modelPlacements, [placement.modelId]: placement }
      updateSettings(ctx.db, { modelPlacements: placements })
    } catch (err) {
      log.warn('Could not persist the model placement', { error: String(err) })
    }
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
