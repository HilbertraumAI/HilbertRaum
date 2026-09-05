import { guardedHandleFor } from './guarded-handle'
import { clearSpeculativeSuppression } from '../services/runtime/factory'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  AppSettings,
  BenchmarkProgressStep,
  BenchmarkResult,
  GpuDevice,
  PerformanceSnapshot
} from '../../shared/types'
import { detectSystem, runBenchmark, type GpuBenchmarkInput } from '../services/benchmark'
import { effectiveReadOrPersisted } from './registerModelIpc'
import {
  findMachine,
  latestAnswerSpeed,
  machineKey,
  otherMachines,
  upsertHistory
} from '../services/performance'
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
    }
  } catch (err) {
    log.warn('GPU probe failed (benchmark continues without it)', String(err))
  }
  return { name: devices[0]?.name ?? null, useful: gpuUsefulForProfile(devices) }
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
  // injected here via the shared latch-vs-persisted resolution (ranking-aware, so a
  // session checksum sample never shadows a persisted model-load one) — a re-run never
  // loses an observation.
  const effectiveRead = effectiveReadOrPersisted(ctx)

  const result = await runBenchmark({
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

  // Persist the last result via the settings store (spec §8 defines no benchmarks table),
  // and file it under this machine in the per-computer history (benchmark.md "History per
  // machine") so a drive that travels keeps one result per computer.
  updateSettings(ctx.db, {
    lastBenchmark: result,
    benchmarkHistory: upsertHistory(getSettings(ctx.db).benchmarkHistory, result)
  })
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
      if (here == null || last == null || here === last) return
      const known = findMachine(settings.benchmarkHistory, here)
      if (known) {
        updateSettings(ctx.db, { lastBenchmark: known })
        log.info('Drive is back on a known computer: restored its benchmark result', {
          profile: known.profile,
          recommendedModelId: known.recommendedModelId
        })
        return
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
export function buildPerformanceSnapshot(ctx: AppContext): PerformanceSnapshot {
  const settings = getSettings(ctx.db)
  const here = machineKey(detectSystem())
  const current = settings.lastBenchmark
  const currentKey = machineKey(current)
  // The persisted model-load sample outlives the session; the session latch wins when it
  // exists (a start we just watched), otherwise the last persisted one still says how the
  // last start on this drive went.
  const persistedLoad =
    current?.effectiveRead?.source === 'model_load' ? current.effectiveRead : null
  return {
    current,
    // An unknown identity on either side reads as "this machine": the moved-drive check in
    // maybeRunFirstBenchmark makes the same call, so the two never contradict each other.
    currentMachine: here == null || currentKey == null || here === currentKey,
    otherMachines: otherMachines(settings.benchmarkHistory, currentKey ?? here),
    running: modelBusyLane(ctx) === 'benchmark',
    observed: {
      lastAnswer: latestAnswerSpeed(),
      lastModelLoad: latestEffectiveReadBySource('model_load') ?? persistedLoad,
      lastChecksum: latestEffectiveReadBySource('checksum')
    }
  }
}

export function registerBenchmarkIpc(ctx: AppContext): void {
  const ipcHandle = guardedHandleFor(ctx)
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
