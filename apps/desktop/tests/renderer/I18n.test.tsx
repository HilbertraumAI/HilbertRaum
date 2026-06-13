// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import {
  I18nProvider,
  UI_LANGUAGE_STORAGE_KEY,
  resolvePreUnlockLanguage
} from '../../src/renderer/i18n'
import { DEFAULT_SETTINGS, type AppSettings, type WorkspaceStateInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 39 — renderer language resolution (i18n record §3.2, D-L2/D-L3): the pre-unlock
// gate resolves from the localStorage mirror (falling back to navigator.language),
// the Settings → General picker patches `uiLanguage` and switches the UI live, and
// the RESOLVED language is mirrored to localStorage + `<html lang>`.

const LOCKED: WorkspaceStateInfo = {
  state: 'locked',
  mode: 'encrypted',
  plaintextAllowed: false,
  encryptionRequired: true
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.lang = ''
})

describe('resolvePreUnlockLanguage', () => {
  it("defaults to English with zero stored state on this EN machine (jsdom's navigator.language)", () => {
    // Pins the D-L8 assumption the whole suite rests on: the shipped default
    // ('system') resolves to 'en' here, so every English copy assertion stays valid.
    expect(navigator.language.toLowerCase().startsWith('de')).toBe(false)
    expect(resolvePreUnlockLanguage()).toBe('en')
  })

  it('prefers the localStorage mirror and ignores junk values', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    expect(resolvePreUnlockLanguage()).toBe('de')
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'klingon')
    expect(resolvePreUnlockLanguage()).toBe('en')
  })
})

describe('pre-unlock gate language (App + WorkspaceGate)', () => {
  it('renders the locked gate in English with no stored state', async () => {
    stubApi({ getWorkspaceState: vi.fn(async () => LOCKED) })
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Unlock your workspace' })
    ).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('renders the locked gate in German when the mirror says de (German render smoke)', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubApi({ getWorkspaceState: vi.fn(async () => LOCKED) })
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Entsperre deinen Arbeitsbereich' })
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Passwort')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entsperren' })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('de')
  })
})

describe('Settings → General language picker', () => {
  function stubSettings(initial: AppSettings) {
    let current = initial
    const updateSettings = vi.fn(async (patch: Partial<AppSettings>) => {
      current = { ...current, ...patch }
      return current
    })
    stubApi({
      getSettings: vi.fn(async () => current),
      updateSettings
    })
    return { updateSettings }
  }

  it('offers System / English / Deutsch and patches uiLanguage like theme', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const deutsch = await screen.findByRole('radio', { name: 'Deutsch' })
    expect(screen.getByRole('radio', { name: 'English' })).toBeInTheDocument()

    await userEvent.click(deutsch)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'de' })
    // The switch is live (no restart): the chrome re-renders in German…
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
    // …and the RESOLVED language is mirrored for the next pre-unlock gate + <html lang>.
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('de')
    expect(document.documentElement.lang).toBe('de')

    // Back to English via the picker (its label stays untranslated in German).
    await userEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'en' })
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en')
  })

  it('marks the saved choice as selected', async () => {
    stubSettings({ ...DEFAULT_SETTINGS, uiLanguage: 'de' })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    expect(await screen.findByRole('radio', { name: 'Deutsch' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('radio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })
})
