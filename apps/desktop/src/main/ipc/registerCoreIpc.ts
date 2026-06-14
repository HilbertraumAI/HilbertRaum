import { ipcMain, app, clipboard } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { buildDriveStatus } from '../services/workspace'
import { getSettings, updateSettings } from '../services/settings'
import { applyUiLanguageSetting, tMain } from '../services/i18n'
import { buildPolicyStatus } from '../services/policy'
import { runPreflight } from '../services/preflight'
import { machineRamGb } from '../services/models'
import { log, readLogTail, readLogFull } from '../services/logging'
import { saveTextExport } from './save-export'
import type { AppSettings, AppStatus, PolicyStatus, PreflightResult } from '../../shared/types'

// IPC for app/drive status + settings, the privacy policy surface (`getPolicy`),
// and the policy-aware `offlineMode` (spec §9.1, §3.6).
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
    const policy = buildPolicyStatus(
      ctx.paths.configPath,
      s?.allowNetwork ?? false,
      (m) => log.warn(m),
      { isDev: ctx.isDev }
    )
    return {
      appName: 'HilbertRaum',
      appVersion: app.getVersion(),
      offlineMode: policy.offlineMode,
      networkAllowed: policy.networkAllowed,
      activeModelId: s?.activeModelId ?? null,
      // Real, persisted profile from the hardware benchmark; UNKNOWN until first run.
      hardwareProfile: s?.lastBenchmark?.profile ?? 'UNKNOWN',
      workspaceMode: ws.mode ?? 'plaintext_dev',
      workspaceReady: unlocked,
      machineRamGb: machineRamGb(),
      // Dictation is availability-driven (transcriber selected at startup iff
      // whisper binary + weights exist) — the composer mic gates on this flag.
      dictationAvailable: ctx.transcriber != null,
      // OCR is availability-driven too (engine selected iff the drive's ocr/
      // language files exist) — gates "Make searchable (OCR)" + the photo hint.
      ocrAvailable: ctx.ocrEngine != null
    }
  })

  ipcMain.handle(IPC.getDriveStatus, () => buildDriveStatus(ctx.paths))

  // The friendly, non-blocking launch preflight (spec §11.4). Reuses the drive
  // status + benchmark probe; surfaced on Home for a non-technical first run.
  ipcMain.handle(
    IPC.runPreflight,
    (): Promise<PreflightResult> => runPreflight({ rootPath: ctx.paths.rootPath })
  )

  ipcMain.handle(IPC.getPolicy, (): PolicyStatus =>
    buildPolicyStatus(ctx.paths.configPath, allowNetworkSetting(), (m) => log.warn(m), {
      isDev: ctx.isDev
    })
  )

  // Spec §7.11 "show recent local logs" — read-only, local, never uploaded.
  ipcMain.handle(IPC.getLogTail, (): string[] => readLogTail())

  // Copy text to the OS clipboard. Done in MAIN because the sandboxed preload has no access
  // to Electron's `clipboard` module and `navigator.clipboard` is unreliable in the
  // file://-loaded renderer (it threw the "can't copy" error). Returns false on failure so
  // the renderer can show a friendly message rather than throw.
  ipcMain.handle(IPC.writeClipboard, (_e, text: string): boolean => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  })

  // Save the WHOLE current log to a user-chosen file as plaintext (".txt"), so a user can
  // hand diagnostics to support without unsealing the workspace. The dialog + write run in
  // MAIN (saveTextExport). The on-disk log stays encrypted; this writes a copy the user
  // deliberately places outside the vault (spec §7.11 — logs are FOR THE USER).
  ipcMain.handle(IPC.exportLog, async (): Promise<string | null> => {
    const filePath = await saveTextExport(
      {
        title: tMain('main.dialog.exportLog'),
        defaultPath: 'hilbertraum-logs.txt',
        filters: [
          { name: 'Log', extensions: ['txt', 'log'] },
          { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
        ]
      },
      readLogFull()
    )
    if (filePath) log.info('Diagnostic logs exported')
    return filePath
  })

  ipcMain.handle(IPC.getSettings, () => getSettings(ctx.db))

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    log.info('Settings updated', Object.keys(patch))
    const result = updateSettings(ctx.db, patch)
    // Keep the main-side cached UI language in step with the setting (D-L3) — the
    // post-validation value, so junk patches can't move it.
    if ('uiLanguage' in patch) applyUiLanguageSetting(result.uiLanguage)
    // Audit privacy rule: record ONLY the privacy-relevant keys — and their
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
