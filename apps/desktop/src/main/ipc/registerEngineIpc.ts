import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { EngineDownloadJob, EngineStatus } from '../../shared/types'
import { EngineDownloadManager, engineStatus } from '../services/runtime-download'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { log } from '../services/logging'
import type { DownloadGates } from '../services/downloads'

// IPC for the in-app engine (llama.cpp sidecar) downloader. Without the engine binary a
// started model falls back to the built-in demo runtime — this lets the user install the
// real engine from inside the app. The gates mirror the model downloader exactly (the
// policy ceiling AND the user's allowNetwork setting), re-checked HERE on every start.

export function registerEngineIpc(ctx: AppContext, manager?: EngineDownloadManager): void {
  const engine =
    manager ?? new EngineDownloadManager({ fetchImpl: fetch, log: (m, meta) => log.info(m, meta) })

  const gates = (): DownloadGates => {
    const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
    const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork
    return { policyAllows: policy.network.allowModelDownloads, settingAllows }
  }

  ipcMain.handle(
    IPC.getEngineStatus,
    (): EngineStatus => engineStatus(ctx.paths.rootPath, ctx.manifestsDir ?? null)
  )

  ipcMain.handle(
    IPC.downloadEngine,
    (): Promise<EngineDownloadJob> =>
      engine.start({
        rootPath: ctx.paths.rootPath,
        manifestsDir: ctx.manifestsDir ?? null,
        gates: gates()
      })
  )

  ipcMain.handle(IPC.getEngineJob, (_e, jobId: string): EngineDownloadJob => engine.get(jobId))

  ipcMain.handle(
    IPC.cancelEngineDownload,
    (_e, jobId: string): EngineDownloadJob => engine.cancel(jobId)
  )
}
