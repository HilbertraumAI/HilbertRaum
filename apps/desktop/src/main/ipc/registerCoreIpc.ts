import { ipcMain, app } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { buildDriveStatus } from '../services/workspace'
import { getSettings, updateSettings } from '../services/settings'
import { buildPolicyStatus } from '../services/policy'
import { log } from '../services/logging'
import type { AppSettings, AppStatus, PolicyStatus } from '../../shared/types'

// Phase 1 IPC: app/drive status + settings (spec §9.1). Phase 8 adds the privacy
// policy surface (`getPolicy`) and makes `offlineMode` policy-aware (spec §3.6).
export function registerCoreIpc(ctx: AppContext): void {
  // The user's allowNetwork setting lives inside the (possibly locked) DB. When the
  // workspace is locked we can't read it — fall back to the safe default (false), which
  // keeps the offline ceiling intact until the workspace is unlocked.
  const allowNetworkSetting = (): boolean =>
    ctx.workspace.isUnlocked() ? getSettings(ctx.db).allowNetwork : false

  ipcMain.handle(IPC.getAppStatus, (): AppStatus => {
    const ws = ctx.workspace.getState()
    const unlocked = ctx.workspace.isUnlocked()
    const s = unlocked ? getSettings(ctx.db) : null
    // Effective offline state = policy ceiling ∧ the user's allowNetwork setting.
    const policy = buildPolicyStatus(ctx.paths.configPath, s?.allowNetwork ?? false, (m) =>
      log.warn(m)
    )
    return {
      appName: 'Private AI Drive Lite',
      appVersion: app.getVersion(),
      offlineMode: policy.offlineMode,
      networkAllowed: policy.networkAllowed,
      activeModelId: s?.activeModelId ?? null,
      // Real, persisted profile from the Phase-7 benchmark; UNKNOWN until first run.
      hardwareProfile: s?.lastBenchmark?.profile ?? 'UNKNOWN',
      workspaceMode: ws.mode ?? 'plaintext_dev',
      workspaceReady: unlocked
    }
  })

  ipcMain.handle(IPC.getDriveStatus, () => buildDriveStatus(ctx.paths))

  ipcMain.handle(IPC.getPolicy, (): PolicyStatus =>
    buildPolicyStatus(ctx.paths.configPath, allowNetworkSetting(), (m) => log.warn(m))
  )

  ipcMain.handle(IPC.getSettings, () => getSettings(ctx.db))

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    log.info('Settings updated', Object.keys(patch))
    return updateSettings(ctx.db, patch)
  })
}
