import { ipcMain, app, clipboard } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { buildDriveStatus } from '../services/workspace'
import { getSettings, updateSettings } from '../services/settings'
import { applyUiLanguageSetting, tMain } from '../services/i18n'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { buildPolicyStatus } from '../services/policy'
import { applyLocalApiSettings } from '../services/local-api/lifecycle'
import { LOCAL_API_SETTINGS_KEYS } from '../../shared/local-api'
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

  // F16 (audit-postmerge-2026-06-29): the settings get/update handlers touch ctx.db. The getter
  // fail-closes when locked but throws the raw English vault string; gate them with the localized
  // copy (parity with the other DB-touching handler groups). The status/policy/preflight/clipboard
  // and the pre-unlock diagnostics-log channels stay usable while locked BY DESIGN — they are
  // workspace-agnostic or read their value safely (allowNetworkSetting() guards the locked case).
  const requireUnlocked = (): void => {
    // AUD-02: `workspaceAdmitsWork`, never a bare `isUnlocked()` — the workspace DB stays
    // OPEN for the whole multi-second lock teardown, so a bare check admits work that then
    // lazily respawns the sidecars that teardown just killed. This module's copy is unchanged.
    if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.settings.locked'))
  }

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
      // OCR is availability-driven too — gates "Make searchable (OCR)" + the photo hint. Reads
      // the engine's execution state, not mere presence (#232): false while a packaged build's
      // startup probe runs and after a worker failure. `ocrState` tells the renderer why.
      ocrAvailable: ctx.ocrEngine != null && (ctx.ocrEngine.availability?.() ?? 'available') === 'available',
      ocrState: ctx.ocrEngine == null ? 'missing' : (ctx.ocrEngine.availability?.() ?? 'available'),
      // Translation is availability-driven the same way (TG-3: the TranslateGemma
      // sidecar is selected at startup iff llama-server + the translation GGUF exist) —
      // gates the Documents "Translate" action. Reading the composed handle keeps this
      // flag in lockstep with the doc-task guard.
      translationAvailable: ctx.translator != null,
      // Issue #42 reopen: the sidecar's last cold-start device outcome (posture + parsed
      // offload split + liveness) — the Translate screen's #36-style hint. Null before the
      // first start / when unavailable; optional on the Translator seam (fakes omit it).
      translationDevice: ctx.translator?.deviceStatus?.() ?? null,
      // Local API live state (counts + flags only, never content — D1). Null when no
      // server object exists at all; the object itself reports `running: false` when the
      // feature is off, so the Settings card can distinguish "off" from "failed to bind".
      localApi: ctx.localApi?.status() ?? null
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

  ipcMain.handle(IPC.getSettings, () => {
    requireUnlocked()
    return getSettings(ctx.db)
  })

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    requireUnlocked()
    // BE-1 (full-audit 2026-07-10): shape-check the patch BEFORE touching it —
    // `Object.keys(null)` threw a raw TypeError out of the handler; reject junk with the
    // friendly localized copy instead (the sibling registrars' validation style).
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(tMain('main.settings.invalidPatch'))
    }
    log.info('Settings updated', Object.keys(patch))
    // Read BEFORE the write so local_api_toggled records only a REAL flip — key-presence
    // alone would log phantom enable/disable events for rejected-junk or same-value
    // patches, polluting the exported audit trail's forensic value.
    const localApiBefore = 'localApiEnabled' in patch ? getSettings(ctx.db).localApiEnabled : null
    const result = updateSettings(ctx.db, patch)
    // Keep the main-side cached UI language in step with the setting (D-L3) — the
    // post-validation value, so junk patches can't move it.
    if ('uiLanguage' in patch) applyUiLanguageSetting(result.uiLanguage)
    // Local API start/stop/re-port on a live settings change (the seam precedent above).
    // A bind failure is logged + lands in `status().lastError` (running:false) — the P4
    // card reads THAT surface; the settings write itself always succeeds. Fire-and-forget
    // is safe: the server serializes start/stop internally.
    if (LOCAL_API_SETTINGS_KEYS.some((k) => k in patch)) {
      void applyLocalApiSettings(ctx).catch((err) => {
        log.warn('Local API settings change failed to apply', { error: String(err) })
      })
    }
    // Audit privacy rule: record ONLY the privacy-relevant keys — and their
    // post-validation values, which are booleans/enums — never any other setting's value.
    // The tuple is a hard allowlist: the local-API token cannot ride here structurally
    // (it never enters AppSettings at all — services/local-api/token.ts), and the port
    // is deliberately excluded (booleans only; the audit-log export writes metadata
    // verbatim to plaintext JSON outside the vault).
    const privacyKeys = (
      ['allowNetwork', 'gpuMode', 'developerMode', 'localApiEnabled', 'localApiTokenRequired'] as const
    ).filter((k) => k in patch)
    if (privacyKeys.length > 0) {
      ctx.audit?.(
        'settings_changed',
        `Privacy-relevant settings changed: ${privacyKeys.join(', ')}`,
        Object.fromEntries(privacyKeys.map((k) => [k, result[k]]))
      )
    }
    // The local-API master switch gets its own first-class audit event (boolean only) —
    // deliberately IN ADDITION to the settings_changed sweep (the filterable trust event
    // the export/Activity surface keys on), but only when the accepted value actually
    // changed.
    if (localApiBefore !== null && result.localApiEnabled !== localApiBefore) {
      ctx.audit?.(
        'local_api_toggled',
        `Local API ${result.localApiEnabled ? 'enabled' : 'disabled'}`,
        { enabled: result.localApiEnabled }
      )
    }
    return result
  })
}
