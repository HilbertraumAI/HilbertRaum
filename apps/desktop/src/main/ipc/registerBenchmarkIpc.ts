import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { AppSettings, BenchmarkResult, GpuDevice } from '../../shared/types'
import { runBenchmark, type GpuBenchmarkInput } from '../services/benchmark'
import { gpuUsefulForProfile } from '../services/runtime/gpu'
import { resolveLlamaServerPath } from '../services/runtime/sidecar'
import { discoverManifests } from '../services/models'
import { getSettings, updateSettings } from '../services/settings'
import { tMain } from '../services/i18n'
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

/** Run the benchmark and persist the result (the shared core of IPC + first-run). */
export async function runAndPersistBenchmark(ctx: AppContext): Promise<BenchmarkResult> {
  const manifests = ctx.manifestsDir
    ? discoverManifests(ctx.manifestsDir).manifests.map((m) => m.manifest)
    : []
  const gpu = await probeAndPersistGpu(ctx)

  const result = await runBenchmark({
    workspacePath: ctx.paths.workspacePath,
    manifests,
    runtime: ctx.runtime.active(),
    gpu
  })

  // Persist the last result via the settings store (spec §8 defines no benchmarks table).
  updateSettings(ctx.db, { lastBenchmark: result })
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
    if (!ctx.workspace.isUnlocked()) return
    if (getSettings(ctx.db).lastBenchmark !== null) {
      // Already benchmarked — still refresh the persisted GPU probe for THIS
      // machine/session in the background: a drive moved between machines would
      // otherwise keep showing the previous machine's GPU in Diagnostics until a
      // manual re-benchmark (and older workspaces may have no `gpuProbe` at all).
      void probeAndPersistGpu(ctx)
      return
    }
  } catch {
    return // settings unreadable (e.g. just locked again) — a manual run still works
  }
  log.info('First run: benchmarking hardware in the background')
  void runAndPersistBenchmark(ctx).catch((err) =>
    log.warn('First-run benchmark failed (re-run from Diagnostics)', String(err))
  )
}

/**
 * "Try GPU again" (Diagnostics): clearing the flags alone is not enough —
 * a probe that timed out once (cold/wedged driver) stays cached for the session and
 * would keep labeling a now-working GPU machine as CPU. Invalidate the cache, clear
 * the flags, re-probe + persist, and hand the renderer the fresh settings.
 */
export async function tryGpuAgain(ctx: AppContext): Promise<AppSettings> {
  ctx.probeGpu?.invalidate?.()
  updateSettings(ctx.db, { gpuAutoDisabled: false, gpuLastError: null })
  await probeAndPersistGpu(ctx)
  return getSettings(ctx.db)
}

export function registerBenchmarkIpc(ctx: AppContext): void {
  // SEC-N2: both handlers touch ctx.db (via updateSettings/getSettings). The ctx.db getter already
  // fail-closes when the workspace is locked, but it throws a raw English string; mirror every other
  // DB-touching handler with an explicit requireUnlocked() so a locked call surfaces the localized
  // main.benchmark.locked instead (parity, and the parametrized lock test now covers these too).
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) throw new Error(tMain('main.benchmark.locked'))
  }
  ipcMain.handle(IPC.runBenchmark, (): Promise<BenchmarkResult> => {
    requireUnlocked()
    return runAndPersistBenchmark(ctx)
  })
  ipcMain.handle(IPC.tryGpuAgain, (): Promise<AppSettings> => {
    requireUnlocked()
    return tryGpuAgain(ctx)
  })
}
