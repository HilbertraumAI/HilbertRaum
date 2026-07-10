import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { DownloadJob } from '../../shared/types'
import { DownloadManager, type DownloadGates } from '../services/downloads'
import { createSettingsHashStore, discoverManifests } from '../services/models'
import { getSettings } from '../services/settings'
import { loadPolicy } from '../services/policy'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'

// IPC for the in-app model downloader (architecture.md "In-app model downloader").
// Async-with-polling like the import jobs: `downloadModel` returns the job
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
  // audit recorder without the service touching the DB.
  const downloads =
    manager ??
    new DownloadManager({
      fetchImpl: fetch,
      log: (m, meta) => log.info(m, meta),
      audit: (type, message, metadata) => ctx.audit?.(type, message, metadata),
      // Issue #40: a completed download re-runs the availability selectors that were frozen at
      // startup (main/index.ts wires the ctx hook) — e.g. TranslateGemma activates without a
      // restart. Read late off ctx (the audit-hook pattern) so registration order can't matter.
      onModelInstalled: (modelId) => ctx.onModelInstalled?.(modelId)
    })

  // Both gates read at call time: the policy from disk (authoritative ceiling), the
  // setting from the (possibly locked → treated as off) workspace DB.
  const gates = (): DownloadGates => {
    const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
    const settingAllows = ctx.workspace.isUnlocked() && getSettings(ctx.db).allowNetwork
    return { policyAllows: policy.network.allowModelDownloads, settingAllows }
  }

  ipcMain.handle(
    IPC.downloadModel,
    async (_e, modelId: string, opts?: { licenseAccepted?: boolean }): Promise<DownloadJob> => {
      if (!ctx.manifestsDir) throw new Error(tMain('main.models.noManifests'))
      const { manifests } = discoverManifests(ctx.manifestsDir)
      const found = manifests.find((m) => m.manifest.id === modelId)
      if (!found) throw new Error(`Unknown model id: ${modelId}`)
      return downloads.start({
        rootPath: ctx.paths.rootPath,
        manifest: found.manifest,
        gates: gates(),
        licenseAccepted: opts?.licenseAccepted === true,
        // BE-2 (full-audit 2026-07-10): the getter resolves the LIVE handle per call, so a
        // workspace lock mid-download (which closes the DB) degrades the cache instead of
        // failing the finished job; no unlock guard needed — the store itself is lock-aware.
        hashStore: createSettingsHashStore(() => ctx.db)
      })
    }
  )

  ipcMain.handle(IPC.getDownloadJob, (_e, jobId: string): DownloadJob => downloads.get(jobId))

  ipcMain.handle(IPC.cancelDownload, (_e, jobId: string): DownloadJob => downloads.cancel(jobId))
}
