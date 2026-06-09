import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { BenchmarkResult } from '../../shared/types'
import { runBenchmark } from '../services/benchmark'
import { discoverManifests } from '../services/models'
import { updateSettings } from '../services/settings'
import { log } from '../services/logging'

// Phase 7 IPC: hardware benchmark + model recommendation (spec §9.1, §11, Milestone 7).
//
// `runBenchmark()` detects RAM/CPU/OS, probes drive speed in the workspace, optionally
// estimates tokens/sec from the running runtime, classifies a HardwareProfile, and
// recommends a chat model — STRICTLY LOCAL (no network/telemetry). The result is persisted
// to settings (`lastBenchmark`) so the recommendation pipeline (registerModelIpc) and
// `getAppStatus().hardwareProfile` read the real, detected profile instead of a stub.
export function registerBenchmarkIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.runBenchmark, async (): Promise<BenchmarkResult> => {
    const manifests = ctx.manifestsDir
      ? discoverManifests(ctx.manifestsDir).manifests.map((m) => m.manifest)
      : []

    const result = await runBenchmark({
      workspacePath: ctx.paths.workspacePath,
      manifests,
      runtime: ctx.runtime.active()
    })

    // Persist the last result via the settings store (spec §8 defines no benchmarks table).
    updateSettings(ctx.db, { lastBenchmark: result })
    log.info('Benchmark complete', {
      profile: result.profile,
      recommendedModelId: result.recommendedModelId,
      ramGb: result.ramGb
    })
    return result
  })
}
