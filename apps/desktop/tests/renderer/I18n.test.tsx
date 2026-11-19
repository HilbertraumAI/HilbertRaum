// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen, cleanup, within, fireEvent, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { ToastProvider } from '../../src/renderer/components'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { saveAllBeforeClose } from '../../src/renderer/lib/beforeClose'
import {
  I18nProvider,
  UI_LANGUAGE_STORAGE_KEY,
  resolvePreUnlockLanguage,
  useT
} from '../../src/renderer/i18n'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SaveBeforeCloseResult,
  type WorkspaceStateInfo
} from '../../src/shared/types'
import {
  UI_LANGUAGES,
  UI_LANGUAGE_CODES,
  t,
  type UiLanguage,
  type UiLanguageSetting
} from '../../src/shared/i18n'
import { appShellStubs } from '../helpers/app-shell'
import { deferred } from '../helpers/deferred'
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
  /**
   * A settings store behind `window.api`. With `hold` (#808), every save waits for the test to
   * settle it, in order: `release()` stores it and replies, `refuse()` rejects it (the write gate
   * on a locked workspace).
   */
  function stubSettings(initial: AppSettings, { hold = false } = {}) {
    let current = initial
    const held: Array<{ store: () => void; refuse: () => void }> = []
    const updateSettings = vi.fn((patch: Partial<AppSettings>): Promise<AppSettings> => {
      const store = (): AppSettings => (current = { ...current, ...patch })
      if (!hold) return Promise.resolve(store())
      const reply = deferred<AppSettings>()
      held.push({
        store: () => reply.resolve(store()),
        refuse: () => reply.reject(new Error('The workspace is locked.'))
      })
      return reply.promise
    })
    stubApi({
      getSettings: vi.fn(async () => current),
      updateSettings
    })
    return {
      updateSettings,
      release: () => held.shift()?.store(),
      refuse: () => held.shift()?.refuse()
    }
  }

  /** The picker, found by its accessible name in the language the screen renders in. */
  function findPicker(lang: UiLanguage = 'en'): Promise<HTMLElement> {
    return screen.findByRole('combobox', { name: t(lang, 'settings.language.aria') })
  }

  // #808 (open-issues wave owner call G-6): the select saves about 500 ms after its last change, at
  // once on blur, and on unmount. Steps closer together than the pause; a wait well past it.
  const STEP_MS = 200
  const PAST_THE_PAUSE_MS = 1_000

  // Runs before the file's afterEach (Vitest's stack order). A row that fails with a choice pending
  // is unmounted here and its unmount save lands now, not after the file's afterEach has cleared the
  // mirror (it would write it into the next rows). Then the real clock and `navigator.language`.
  afterEach(async () => {
    cleanup()
    await act(async () => {})
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** The screen as App.tsx hosts it: inside the language provider and a toast host. */
  function renderWithToasts(): RenderResult {
    return render(
      <I18nProvider>
        <ToastProvider>
          <SettingsScreen />
        </ToastProvider>
      </I18nProvider>
    )
  }

  /** The picker, found on the real clock; the clock is fake from here on (so no findBy after). */
  async function pickerOnFakeClock(): Promise<HTMLSelectElement> {
    const picker = (await findPicker()) as HTMLSelectElement
    vi.useFakeTimers()
    return picker
  }

  /** Moves the fake clock and lets the replies it releases land. */
  async function elapse(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  /** The toasts on screen, by text (the toast host is the one status region on this screen). */
  function toasts(): string[] {
    return Array.from(screen.getByRole('status').children, (el) => el.textContent ?? '')
  }

  it('is a drop-down list; choosing a language patches uiLanguage like theme and switches the UI live', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const picker = await findPicker()
    expect(within(picker).getByRole('option', { name: 'English' })).toBeInTheDocument()

    await userEvent.selectOptions(picker, 'Deutsch')
    await userEvent.tab() // leaving the select saves at once (#808), without waiting for the pause
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'de' })
    // The switch is live (no restart): the chrome re-renders in German…
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
    // …and the RESOLVED language is mirrored for the next pre-unlock gate + <html lang>.
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('de')
    expect(document.documentElement.lang).toBe('de')

    // Back to English via the picker (its label stays untranslated in German).
    await userEvent.selectOptions(await findPicker('de'), 'English')
    await userEvent.tab()
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'en' })
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en')
  })

  it.each([
    // The first option: [value, hidden, disabled].
    ['the saved language', 'de' as UiLanguageSetting, 'de', 'Deutsch', ['system', false, false]],
    // A newer build's language on a shared drive resolves like System, so it shows the System text,
    // on a hidden, disabled placeholder (value ''), so that choosing the real System is a change and
    // the list offers no second System entry (#808).
    ['System for a language only a newer build registers', 'xx' as UiLanguageSetting, '', t('en', 'settings.language.system'), ['', true, true]]
  ])('shows %s as the selected choice', async (_case, saved, value, label, first) => {
    stubSettings({ ...DEFAULT_SETTINGS, uiLanguage: saved })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    const picker = (await findPicker()) as HTMLSelectElement
    expect(picker).toHaveValue(value)
    expect(picker).toHaveDisplayValue(label)
    const option = picker.options[0]
    expect([option.value, option.hidden, option.disabled]).toEqual(first)
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

  // A language registered after German, from the picker to the next locked gate: the choice is
  // patched, the screen switches, the resolved language is mirrored, and the next pre-unlock gate
  // (no settings readable yet) renders in it from the mirror alone.
  it('choosing Русский saves it, mirrors it, and the next locked gate renders in Russian', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    render(
      <I18nProvider>
        <SettingsScreen />
      </I18nProvider>
    )
    await userEvent.selectOptions(await findPicker(), 'Русский')
    await userEvent.tab() // the blur saves at once (#808)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'ru' })
    expect(await screen.findByRole('heading', { name: t('ru', 'settings.title') })).toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('ru')
    cleanup()
    // Only the mirror survives into the next start: the gate must set <html lang> itself.
    document.documentElement.lang = ''

    stubApi(appShellStubs({ getWorkspaceState: vi.fn(async () => LOCKED) }))
    render(<App />)
    expect(await screen.findByRole('heading', { name: t('ru', 'gate.unlock.title') })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(t('ru', 'gate.passwordPlaceholder'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('ru', 'gate.unlock.submit') })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('ru')
  })

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
    // fireEvent, not user-event: RTL's asyncWrapper, which user-event runs every action through,
    // waits on a setTimeout(0) that a fake clock never fires outside Jest.
    vi.useFakeTimers()
    fireEvent.change(picker, { target: { value: 'xx' } })
    await elapse(PAST_THE_PAUSE_MS) // a draft would be saved by now (#808)
    expect(updateSettings).not.toHaveBeenCalled()
    expect(picker).toHaveValue('system') // still shows the saved choice
  })

  // #808: on Windows a closed select fires `change` for every arrow-key step. The steps here come
  // closer together than the pause and last longer than it, so a pause counted from the first step
  // would save in between.
  it('saves once, after a pause, for several changes in a row, and toasts once in the new language', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    for (const code of ['de', 'es', 'it', 'fr']) {
      fireEvent.change(picker, { target: { value: code } })
      expect(picker).toHaveValue(code) // the choice shows at once
      await elapse(STEP_MS)
      expect(updateSettings).not.toHaveBeenCalled()
    }
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'fr' })
    expect(screen.getByRole('heading', { name: t('fr', 'settings.title') })).toBeInTheDocument()
    // Not in English, the language being left.
    expect(toasts()).toEqual([t('fr', 'settings.saved')])
  })

  it('saves at once when the select loses focus (#808)', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    fireEvent.blur(picker)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'de' }) // the clock has not moved
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual([t('de', 'settings.saved')])
  })

  // #888: a window close runs no unmount, so a choice still inside its pause was lost (PR #823 saved it
  // only on the pause, a blur or leaving the tab). The save before the window closes sends it, and
  // answers main only once that save has answered.
  it('a choice still inside its pause is saved when the window closes, before the close-time save answers (#888)', async () => {
    const { updateSettings, release } = stubSettings({ ...DEFAULT_SETTINGS }, { hold: true })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    let answer: SaveBeforeCloseResult | undefined
    void saveAllBeforeClose().then((a) => (answer = a))
    await elapse(0)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'de' }) // the pause has not passed
    expect(answer).toBeUndefined() // waiting for that save
    release()
    await elapse(0)
    expect(answer).toEqual({ unsaved: false })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
  })

  // #808, audit PA-4: the provider outlives the tab, so a choice saved by the unmount still switches
  // the app. The screen goes; the language provider and the toast host stay, as in App.tsx.
  it('saves a pending choice when the tab unmounts, and the app switches to it', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    const { rerender } = renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    rerender(
      <I18nProvider>
        <ToastProvider>{null}</ToastProvider>
      </I18nProvider>
    )
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'de' })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(document.documentElement.lang).toBe('de')
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('de')
    expect(toasts()).toEqual([]) // none for a screen that is gone
  })

  // #808: the read path never rewrites the row (docs/data-contracts.md), so a newer build still finds
  // the choice; only the user's choice writes.
  it('writes nothing for a language only a newer build registers until the user chooses System (#808)', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS, uiLanguage: 'xx' as UiLanguageSetting })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    expect(picker).toHaveValue('') // the placeholder, so choosing System is a change
    const placeholder = picker.options[0]
    expect([placeholder.value, placeholder.hidden, placeholder.disabled]).toEqual(['', true, true])
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).not.toHaveBeenCalled()

    // By value: the placeholder has the same text, and user-event skips a disabled option.
    fireEvent.change(picker, { target: { value: 'system' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'system' })
    expect(picker).toHaveValue('system')
  })

  it('saves nothing and toasts nothing for a pick and back within the pause (#808)', async () => {
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    fireEvent.change(picker, { target: { value: 'system' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
    expect(picker).toHaveValue('system')

    // After a save has landed, the same holds against the newly stored value.
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    fireEvent.change(picker, { target: { value: 'fr' } })
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual([t('de', 'settings.saved')])
    expect(picker).toHaveValue('de')
  })

  // #808: System resolves through the OS language, so its toast is in that language, not in the
  // language the screen rendered in.
  it('toasts in the OS language when the choice is System (#808)', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE') // restored in afterEach
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en') // the screen renders in English
    const { updateSettings } = stubSettings({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'system' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'system' })
    expect(toasts()).toEqual([t('de', 'settings.saved')])
  })

  it('shows the stored language again and the failure toast when the save is refused (#808)', async () => {
    const { updateSettings, refuse } = stubSettings({ ...DEFAULT_SETTINGS }, { hold: true })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    refuse()
    await elapse(0)
    expect(picker).toHaveValue('system')
    expect(toasts()).toEqual([t('en', 'settings.saveFailed')])

    // The refused value was never stored: choosing it again sends it again.
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(2)
    refuse()
    await elapse(0)
  })

  // #808: the failure toast is in the language shown when the refusal lands, which an older save's
  // reply may have switched since this save was sent.
  it('toasts a refused save in the language an earlier reply switched to (#808)', async () => {
    const { release, refuse } = stubSettings({ ...DEFAULT_SETTINGS }, { hold: true })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    fireEvent.change(picker, { target: { value: 'fr' } })
    await elapse(PAST_THE_PAUSE_MS) // both saves sent from the English screen
    release()
    await elapse(0) // German stored: the screen is German now
    refuse()
    await elapse(0)
    expect(toasts()).toEqual([t('de', 'settings.saved'), t('de', 'settings.saveFailed')])
    expect(picker).toHaveValue('de') // the stored value again
  })

  it("keeps a newer choice on the select when an older save's reply lands (#808)", async () => {
    const { updateSettings, release } = stubSettings({ ...DEFAULT_SETTINGS }, { hold: true })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    fireEvent.change(picker, { target: { value: 'fr' } })
    release() // the German reply lands while French waits for its pause
    await elapse(0)
    expect(picker).toHaveValue('fr')
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenLastCalledWith({ uiLanguage: 'fr' })
    release()
    await elapse(0)
    expect(picker).toHaveValue('fr')
    expect(document.documentElement.lang).toBe('fr')
  })

  // #808: "a pick and back saves nothing" compares with the value the store holds once the
  // unanswered saves land, not with the stored value they are about to change.
  it('still saves a choice back to the stored language while an earlier save is unanswered (#808)', async () => {
    const { updateSettings, release } = stubSettings({ ...DEFAULT_SETTINGS }, { hold: true })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    fireEvent.change(picker, { target: { value: 'system' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenLastCalledWith({ uiLanguage: 'system' })
    release()
    await elapse(0)
    expect(picker).toHaveValue('system') // German landed; the newer choice is still being saved
    release()
    await elapse(0)
    expect(document.documentElement.lang).toBe('en')
    expect(picker).toHaveValue('system')
  })

  it('saves nothing more for a pick and back to the language an unanswered save is storing (#808)', async () => {
    const { updateSettings, release } = stubSettings({ ...DEFAULT_SETTINGS }, { hold: true })
    renderWithToasts()
    const picker = await pickerOnFakeClock()
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS) // the German save is sent; its reply waits
    fireEvent.change(picker, { target: { value: 'fr' } })
    fireEvent.change(picker, { target: { value: 'de' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(picker).toHaveValue('de') // no flash back to the stored System while German is saved
    release()
    await elapse(0)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual([t('de', 'settings.saved')])
    expect(picker).toHaveValue('de')

    // Two saves unanswered: when the older lands, the newer one's value is still the one to match.
    fireEvent.change(picker, { target: { value: 'fr' } })
    await elapse(PAST_THE_PAUSE_MS)
    fireEvent.change(picker, { target: { value: 'it' } })
    await elapse(PAST_THE_PAUSE_MS)
    release() // French lands; Italian is still unanswered
    await elapse(0)
    fireEvent.change(picker, { target: { value: 'es' } })
    fireEvent.change(picker, { target: { value: 'it' } })
    await elapse(PAST_THE_PAUSE_MS)
    expect(updateSettings).toHaveBeenCalledTimes(3)
    release()
    await elapse(0)
    expect(picker).toHaveValue('it')
  })
})
