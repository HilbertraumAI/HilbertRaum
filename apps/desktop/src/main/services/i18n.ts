import {
  resolveUiLanguage,
  t,
  type MessageKey,
  type MessageParams,
  type UiLanguage,
  type UiLanguageSetting
} from '../../shared/i18n'

// Main-process UI language (i18n-plan §3.2 D-L3, §3.3 D-L5): a cached RESOLVED
// language for everything the main process emits to the user (transient errors,
// notices, dialog titles — never strings persisted to the DB, which stay canonical
// English per D-L4).
//
// Lifecycle: initialized from `app.getLocale()` once Electron is ready (the best
// guess while settings are unreadable), then re-resolved from the real
// `AppSettings.uiLanguage` whenever settings become readable (plaintext startup,
// after unlock/create) and whenever a settings patch changes `uiLanguage`. The OS
// locale is cached alongside so 'system' keeps resolving without touching Electron —
// which also keeps this module testable in plain node.

let osLocale = 'en'
let language: UiLanguage = 'en'

/** Set the OS locale (from `app.getLocale()`, valid after whenReady) and resolve as 'system'. */
export function initMainI18n(locale: string | null | undefined): void {
  osLocale = locale && locale.length > 0 ? locale : 'en'
  language = resolveUiLanguage('system', osLocale)
}

/** Re-resolve from the user's setting (call when settings become readable or change). */
export function applyUiLanguageSetting(setting: UiLanguageSetting): void {
  language = resolveUiLanguage(setting, osLocale)
}

/** The currently cached resolved language (diagnostics/tests). */
export function mainUiLanguage(): UiLanguage {
  return language
}

/** Translate a main-side EMISSION (D-L5). Persisted strings must NOT go through this. */
export function tMain(key: MessageKey, params?: MessageParams): string {
  return t(language, key, params)
}
