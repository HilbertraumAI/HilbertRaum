import { ipcMain, app } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { buildDriveStatus } from '../services/workspace'
import { getSettings, updateSettings } from '../services/settings'
import { log } from '../services/logging'
import type { AppSettings, AppStatus } from '../../shared/types'

// Phase 1 IPC: app/drive status + settings (spec §9.1).
export function registerCoreIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.getAppStatus, (): AppStatus => {
    const s = getSettings(ctx.db)
    return {
      appName: 'Private AI Drive Lite',
      appVersion: app.getVersion(),
      offlineMode: !s.allowNetwork,
      activeModelId: s.activeModelId,
      hardwareProfile: 'UNKNOWN', // populated by the benchmark in Phase 7
      workspaceMode: s.workspaceMode,
      workspaceReady: true
    }
  })

  ipcMain.handle(IPC.getDriveStatus, () => buildDriveStatus(ctx.paths))

  ipcMain.handle(IPC.getSettings, () => getSettings(ctx.db))

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    log.info('Settings updated', Object.keys(patch))
    return updateSettings(ctx.db, patch)
  })
}
