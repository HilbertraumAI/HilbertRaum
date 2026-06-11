import { ipcMain, app } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { buildDriveStatus } from '../services/workspace'
import { getSettings, updateSettings } from '../services/settings'
import { buildPolicyStatus } from '../services/policy'
import { runPreflight } from '../services/preflight'
import { machineRamGb } from '../services/models'
import { log, readLogTail } from '../services/logging'
import type { AppSettings, AppStatus, PolicyStatus, PreflightResult } from '../../shared/types'

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
      workspaceReady: unlocked,
      machineRamGb: machineRamGb(),
      // Phase 37: dictation is availability-driven (transcriber selected at startup
      // iff whisper binary + weights exist) — the composer mic gates on this flag.
      dictationAvailable: ctx.transcriber != null,
      // Phase 38: OCR is availability-driven too (engine selected iff the drive's
      // ocr/ language files exist) — gates "Make searchable (OCR)" + the photo hint.
      ocrAvailable: ctx.ocrEngine != null
    }
  })

  ipcMain.handle(IPC.getDriveStatus, () => buildDriveStatus(ctx.paths))

  // Phase 13: the friendly, non-blocking launch preflight (spec §11.4). Reuses the drive
  // status + benchmark probe; surfaced on Home for a non-technical first run.
  ipcMain.handle(
    IPC.runPreflight,
    (): Promise<PreflightResult> => runPreflight({ rootPath: ctx.paths.rootPath })
  )

  ipcMain.handle(IPC.getPolicy, (): PolicyStatus =>
    buildPolicyStatus(ctx.paths.configPath, allowNetworkSetting(), (m) => log.warn(m))
  )

  // Spec §7.11 "show recent local logs" (audit M14) — read-only, local, never uploaded.
  ipcMain.handle(IPC.getLogTail, (): string[] => readLogTail())

  ipcMain.handle(IPC.getSettings, () => getSettings(ctx.db))

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    log.info('Settings updated', Object.keys(patch))
    const result = updateSettings(ctx.db, patch)
    // Audit (Phase 19, privacy rule): record ONLY the privacy-relevant keys — and their
    // post-validation values, which are booleans/enums — never any other setting's value.
    const privacyKeys = (['allowNetwork', 'gpuMode', 'developerMode'] as const).filter(
      (k) => k in patch
    )
    if (privacyKeys.length > 0) {
      ctx.audit?.(
        'settings_changed',
        `Privacy-relevant settings changed: ${privacyKeys.join(', ')}`,
        Object.fromEntries(privacyKeys.map((k) => [k, result[k]]))
      )
    }
    return result
  })
}
