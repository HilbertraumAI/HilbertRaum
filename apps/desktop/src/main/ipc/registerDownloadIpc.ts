import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { DownloadJob } from '../../shared/types'
import { DownloadManager, type DownloadGates } from '../services/downloads'
import { createSettingsHashStore, discoverManifests } from '../services/models'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { log } from '../services/logging'

// Phase 18 IPC: the in-app model downloader (post-mvp-functionality-plan §6).
// Async-with-polling like the Phase-4 import jobs: `downloadModel` returns the job
// immediately, the renderer polls `getDownloadJob`. The gates are re-checked HERE, in
// the main process, on every start: the policy ceiling (`allow_model_downloads`) AND
// the user's `allowNetwork` setting (default off) — the renderer's confirmation dialog
// is UX, not the enforcement layer. `licenseAccepted` carries the dialog's explicit
// license acknowledgement through to the planner's license gate (`--accept-license`
// semantics) for manifests whose `license_review.status` is not `approved`.

export function registerDownloadIpc(ctx: AppContext, manager?: DownloadManager): void {
  // Production injects the global fetch; tests pass a manager with a fake (CI is
  // zero-network — nothing in the suite ever constructs the default). The audit hook
  // routes the manager's background started/verified/failed outcomes to the app
  // recorder (Phase 19) without the service touching the DB.
  const downloads =
    manager ??
    new DownloadManager({
      fetchImpl: fetch,
      log: (m, meta) => log.info(m, meta),
      audit: (type, message, metadata) => ctx.audit?.(type, message, metadata)
    })

  // Both gates read at call time: the policy from disk (authoritative ceiling), the
  // setting from the (possibly locked → treated as off) workspace DB.
  const gates = (): DownloadGates => {
    const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m))
    const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork
    return { policyAllows: policy.network.allowModelDownloads, settingAllows }
  }

  ipcMain.handle(
    IPC.downloadModel,
    async (_e, modelId: string, opts?: { licenseAccepted?: boolean }): Promise<DownloadJob> => {
      if (!ctx.manifestsDir) throw new Error('No model-manifests directory found')
      const { manifests } = discoverManifests(ctx.manifestsDir)
      const found = manifests.find((m) => m.manifest.id === modelId)
      if (!found) throw new Error(`Unknown model id: ${modelId}`)
      return downloads.start({
        rootPath: ctx.paths.rootPath,
        manifest: found.manifest,
        gates: gates(),
        licenseAccepted: opts?.licenseAccepted === true,
        hashStore: ctx.workspace.isUnlocked() ? createSettingsHashStore(ctx.db) : undefined
      })
    }
  )

  ipcMain.handle(IPC.getDownloadJob, (_e, jobId: string): DownloadJob => downloads.get(jobId))

  ipcMain.handle(IPC.cancelDownload, (_e, jobId: string): DownloadJob => downloads.cancel(jobId))
}
