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
import { notifyPerformanceChanged } from './performance-notify'
import { backfillOutgoing, historyEquals, mergeSampleIntoResult } from '../services/benchmark-persistence'
import {
  findMachine,
  latestAnswerSpeed,
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
 */
async function probeAndPersistGpu(ctx: AppContext): Promise<GpuBenchmarkInput> {
  let devices: GpuDevice[] = []
  try {
    const binPath = resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, {
      isDev: ctx.isDev
    })
    if (binPath && ctx.probeGpu) {
      devices = await ctx.probeGpu(binPath)
      updateSettings(ctx.db, { gpuProbe: { devices, probedAt: new Date().toISOString() } })
      // The graphics tile and the memory class read this probe: an empty device list is a
      // result too (the tile flips to "None"), so the write notifies either way.
      notifyPerformanceChanged()
    }
  } catch (err) {
    log.warn('GPU probe failed (benchmark continues without it)', String(err))
  }
  return {
    name: devices[0]?.name ?? null,
    useful: gpuUsefulForProfile(devices),
    totalMb: devices[0]?.totalMb ?? null
  }
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
 * `lastBenchmark` stays null. A refused call emits NO `performance:changed`: the span it saw
 * belongs to the running benchmark, whose own release will announce the idle state — a
 * refusal announcing it would tell the screen the first run had finished.
 *
 * The push (P3, G6): `performance:changed` once the span is taken (`running` flips true —
 * the screen learns about a run it did not start: first-run, moved-drive, another window)
 * and once more in the `finally`, after BOTH the persist and the release, on success and on
 * failure alike. That second push is the idle signal; the progress 'done' step precedes the
 * persist and must not be read as one.
 */
export async function runAndPersistBenchmark(
  ctx: AppContext,
  onProgress?: (step: BenchmarkProgressStep) => void
): Promise<BenchmarkResult> {
  const busy = modelBusyLane(ctx)
  if (busy) throw new Error(tMain(modelBusyMessageKey(busy)))
  const releaseOccupancy = ctx.runtime.occupancy.begin('benchmark')
  notifyPerformanceChanged()
  try {
    return await runBenchmarkAndPersist(ctx, onProgress)
  } finally {
    releaseOccupancy()
    notifyPerformanceChanged()
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
          notifyPerformanceChanged()
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
        // The screen may already be open on the outgoing computer's result: tell it.
        notifyPerformanceChanged()
        return
      }
      if (!historyEquals(history, settings.benchmarkHistory)) {
        updateSettings(ctx.db, { benchmarkHistory: history })
        notifyPerformanceChanged()
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

/** The "Your model" block: the active model against this computer's memory. */
function buildPlacement(
  ctx: AppContext,
  settings: AppSettings,
  here: string | null,
  ramGb: number
): PerformanceSnapshot['placement'] {
  const devices = settings.gpuProbe?.devices ?? []
  const memoryClass = memoryClassOf(process.platform, process.arch, devices)
  const ramMb = ramGb > 0 ? Math.round(ramGb * 1024) : null
  const vramMb = devices[0]?.totalMb ?? null
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
      loaded: chatModelResident(ctx, activeId),
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
  const settings = getSettings(ctx.db)
  const sys = detectSystem()
  const here = machineKey(sys)
  const current = settings.lastBenchmark
  const currentKey = machineKey(current)
  const probed = settings.gpuProbe?.devices[0]
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
    // The benchmark's OWN span, read directly (M1): `modelBusyLane` answers "chat" first, so a
    // permitted foreground answer used to hide a held benchmark span and the screen re-enabled
    // its button mid-run.
    running: ctx.runtime.occupancy.held('benchmark'),
    placement: buildPlacement(ctx, settings, here, sys.ramGb),
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
