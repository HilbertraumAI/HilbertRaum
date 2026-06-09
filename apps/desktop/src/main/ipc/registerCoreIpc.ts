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
  ipcMain.handle(IPC.getAppStatus, (): AppStatus => {
    const s = getSettings(ctx.db)
    // Effective offline state = policy ceiling ∧ the user's allowNetwork setting.
    const policy = buildPolicyStatus(ctx.paths.configPath, s.allowNetwork, (m) => log.warn(m))
    return {
      appName: 'Private AI Drive Lite',
      appVersion: app.getVersion(),
      offlineMode: policy.offlineMode,
      networkAllowed: policy.networkAllowed,
      activeModelId: s.activeModelId,
      // Real, persisted profile from the Phase-7 benchmark; UNKNOWN until first run.
      hardwareProfile: s.lastBenchmark?.profile ?? 'UNKNOWN',
      workspaceMode: s.workspaceMode,
      workspaceReady: true
    }
  })

  ipcMain.handle(IPC.getDriveStatus, () => buildDriveStatus(ctx.paths))

  ipcMain.handle(IPC.getPolicy, (): PolicyStatus => {
    const s = getSettings(ctx.db)
    return buildPolicyStatus(ctx.paths.configPath, s.allowNetwork, (m) => log.warn(m))
  })

  ipcMain.handle(IPC.getSettings, () => getSettings(ctx.db))

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    log.info('Settings updated', Object.keys(patch))
    return updateSettings(ctx.db, patch)
  })
}
