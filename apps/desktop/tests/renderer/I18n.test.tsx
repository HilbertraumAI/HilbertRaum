// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import {
  I18nProvider,
  UI_LANGUAGE_STORAGE_KEY,
  resolvePreUnlockLanguage,
  useT
} from '../../src/renderer/i18n'
import { DEFAULT_SETTINGS, type AppSettings, type WorkspaceStateInfo } from '../../src/shared/types'
import {
  UI_LANGUAGES,
  UI_LANGUAGE_CODES,
  t,
  type UiLanguage,
  type UiLanguageSetting
} from '../../src/shared/i18n'
import { appShellStubs } from '../helpers/app-shell'
import { renderInLanguage } from '../helpers/render-language'
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
    stubApi(appShellStubs({ getWorkspaceState: vi.fn(async () => LOCKED) }))
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Unlock your workspace' })
    ).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('renders the locked gate in German when the mirror says de (German render smoke)', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubApi(appShellStubs({ getWorkspaceState: vi.fn(async () => LOCKED) }))
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Arbeitsbereich entsperren' })
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Passwort')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entsperren' })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('de')
  })
})

describe('a language only a newer build registers (two builds on one drive)', () => {
  // A German OS, so "follows the OS" and "falls back to English" give different answers.
  beforeEach(() => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('the pre-unlock gate ignores an unregistered mirror value and follows the OS locale', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'xx')
    expect(resolvePreUnlockLanguage()).toBe('de')
  })

  it('an unregistered stored setting resolves like System once settings load, and the mirror gets the result', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en') // the gate rendered English
    const newerBuildSettings = { ...DEFAULT_SETTINGS, uiLanguage: 'xx' as UiLanguageSetting }
    stubApi(appShellStubs({ getSettings: vi.fn(async () => newerBuildSettings) }))
    render(<App />)
    const nav = await screen.findByRole('navigation')
    expect(await within(nav).findByRole('button', { name: t('de', 'nav.settings') })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('de')
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('de')
  })
})

describe('I18nProvider — stable applyLanguageSetting identity (FE-5)', () => {
  it('keeps applyLanguageSetting referentially stable across a language switch', async () => {
    const user = userEvent.setup()
    const seen: Array<unknown> = []
    function Probe(): JSX.Element {
      const { lang, applyLanguageSetting } = useT()
      seen.push(applyLanguageSetting)
      return <button onClick={() => applyLanguageSetting('de')}>lang:{lang}</button>
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    )
    expect(screen.getByRole('button')).toHaveTextContent('lang:en')
    const first = seen[0]

    await user.click(screen.getByRole('button'))
    // The language flipped (a re-render happened)…
    expect(screen.getByRole('button')).toHaveTextContent('lang:de')
    // …but the applier kept ONE identity, so an effect listing it in deps (App's policy/settings
    // effect) no longer re-fires purely because the UI language changed.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((fn) => fn === first)).toBe(true)
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

  /** The picker, found by its accessible name in the language the screen renders in. */
  function findPicker(lang: UiLanguage = 'en'): Promise<HTMLElement> {
    return screen.findByRole('combobox', { name: t(lang, 'settings.language.aria') })
  }

  it('is a drop-down list; choosing a language patches uiLanguage like theme and applies at once', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const picker = await findPicker()
    expect(within(picker).getByRole('option', { name: 'English' })).toBeInTheDocument()

    await userEvent.selectOptions(picker, 'Deutsch')
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'de' })
    // The switch is live (no restart): the chrome re-renders in German…
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
    // …and the RESOLVED language is mirrored for the next pre-unlock gate + <html lang>.
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('de')
    expect(document.documentElement.lang).toBe('de')

    // Back to English via the picker (its label stays untranslated in German).
    await userEvent.selectOptions(await findPicker('de'), 'English')
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'en' })
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en')
  })

  it.each([
    ['the saved language', 'de' as UiLanguageSetting, 'de', 'Deutsch'],
    // A newer build's language on a shared drive resolves like System, so it shows System.
    ['System for a language only a newer build registers', 'xx' as UiLanguageSetting, 'system', t('en', 'settings.language.system')]
  ])('shows %s as the selected choice', async (_case, saved, value, label) => {
    stubSettings({ ...DEFAULT_SETTINGS, uiLanguage: saved })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const picker = await findPicker()
    expect(picker).toHaveValue(value)
    expect(picker).toHaveDisplayValue(label)
  })

  // UI-languages owner calls D-6 (a) and D-13 (a): System first, then the registry in order.
  // Language names stay in their own language whatever the UI language (so a user can always
  // find their way back); only the System label is translated. `lang` lets a screen reader say
  // each name in its language.
  it.each(UI_LANGUAGE_CODES)(
    'in %s, offers the translated System label, then every registered language by its own name',
    async (lang) => {
      stubSettings({ ...DEFAULT_SETTINGS })
      renderInLanguage(<SettingsScreen />, lang)
      const options = within(await findPicker(lang)).getAllByRole('option') as HTMLOptionElement[]
      expect(options.map((o) => [o.value, o.textContent, o.lang])).toEqual([
        ['system', t(lang, 'settings.language.system'), ''],
        ...UI_LANGUAGES.map((info) => [info.code, info.nativeName, info.code])
      ])
    }
  )

  it('is reached with the Tab key', async () => {
    stubSettings({ ...DEFAULT_SETTINGS })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const picker = await findPicker()
    const user = userEvent.setup()
    // Bounded walk through the screen's tab order (no assumption about which control precedes it).
    for (let i = 0; i < 50 && document.activeElement !== picker; i++) await user.tab()
    expect(picker).toHaveFocus()
  })

  it('saves only a registered setting: a <select> hands back a plain string', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const picker = (await findPicker()) as HTMLSelectElement
    // An option the registry doesn't know, added outside React. Main's write gate would drop
    // the value too, but only after the round trip and a "Saved" toast for nothing saved.
    picker.append(new Option('Klingon', 'xx'))
    await userEvent.selectOptions(picker, 'xx')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(picker).toHaveValue('system') // still shows the saved choice
  })
})
