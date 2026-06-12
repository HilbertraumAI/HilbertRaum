import { describe, it, expect } from 'vitest'
import {
  applyUiLanguageSetting,
  initMainI18n,
  mainUiLanguage,
  tMain
} from '../../src/main/services/i18n'

// Phase 39 — the main process's cached resolved language (i18n-plan §3.2 D-L3 /
// §3.3 D-L5): OS-locale guess until settings are readable, then the real setting;
// tMain() localizes ephemeral emissions like the gate's wrong-password message.
// Plain-node testable: the module never touches Electron (the locale is passed in).

describe('main-process i18n cache', () => {
  it('initializes from the OS locale (the pre-settings guess)', () => {
    initMainI18n('de-AT')
    expect(mainUiLanguage()).toBe('de')
    initMainI18n('en-US')
    expect(mainUiLanguage()).toBe('en')
    initMainI18n(undefined)
    expect(mainUiLanguage()).toBe('en')
  })

  it('re-resolves from the setting once readable; "system" keeps using the cached OS locale', () => {
    initMainI18n('de-DE')
    applyUiLanguageSetting('en') // user chose English on a German OS
    expect(mainUiLanguage()).toBe('en')
    applyUiLanguageSetting('system') // back to following the (cached) OS locale
    expect(mainUiLanguage()).toBe('de')
  })

  it('tMain localizes the wrong-password emission; English stays byte-identical (D-L5)', () => {
    initMainI18n('en-US')
    // The exact pre-i18n literal — the unlock gate copy must not move in English.
    expect(tMain('main.workspace.wrongPassword')).toBe(
      "That password didn't unlock your workspace. Check it and try again."
    )
    applyUiLanguageSetting('de')
    expect(tMain('main.workspace.wrongPassword')).toBe(
      'Dieses Passwort hat deinen Arbeitsbereich nicht entsperrt. Prüf es und versuch es noch einmal.'
    )
    // Reset for any later test in this worker (module-level cache).
    initMainI18n('en-US')
  })
})
