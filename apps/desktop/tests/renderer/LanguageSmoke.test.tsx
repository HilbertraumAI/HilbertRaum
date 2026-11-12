// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { uiLanguageInfo, UI_LANGUAGE_CODES } from '../../src/shared/i18n'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { appShellStubs } from '../helpers/app-shell'
import { LAZY_SCREEN_WAIT } from '../helpers/hang-budget'
import { catalogOf } from '../helpers/i18n-catalogs'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'

// Registration end to end, for every registered language but English (i18n record §5): the app
// shell and Settings → General in the language a user chose, through the stored setting. No mirror
// is seeded, so the first paint is English (jsdom's navigator.language) and the rail has to switch
// once settings load and App applies the stored setting. The expected text is read from each
// language's catalog file, not through `t` (which the rail itself reads), so a catalog wired to
// the wrong language fails here. These rows do not prove the mirror path, the language before
// unlock: the Русский round trip in I18n.test.tsx and the renderInLanguage rows do. Per-screen
// depth stays in GermanSmoke.test.tsx: every screen localizes through the same `useT()`, so
// replaying it per language would prove nothing new. A language registered later gets a row here
// by itself.

/** The rail's destinations: the `nav.*` labels, except the landmark's name and the brand mark's. */
const RAIL_KEYS = Object.keys(catalogOf('en')).filter(
  (key) => key.startsWith('nav.') && key !== 'nav.aria' && key !== 'nav.home'
)

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    window.localStorage.clear()
    document.documentElement.lang = ''
  }
})

describe('language smoke: the shell and Settings → General in each registered language', () => {
  it.each(UI_LANGUAGE_CODES.filter((code) => code !== 'en'))('%s: the rail speaks it and the picker shows it chosen', async (lang) => {
    const text = catalogOf(lang)
    const english = catalogOf('en')
    // If no rail label differed from English, the English-absent check below would check nothing.
    const translated = RAIL_KEYS.filter((key) => text[key] !== english[key])
    expect(translated, 'every rail label is the English one').not.toEqual([])
    stubApi(appShellStubs({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, uiLanguage: lang })) }))
    render(<App />)

    // Waits for the stored setting: the first paint is English.
    const nav = await screen.findByRole('navigation', { name: text['nav.aria'] })
    for (const key of RAIL_KEYS) {
      expect(within(nav).getByRole('button', { name: text[key] })).toBeInTheDocument()
    }
    for (const key of translated) {
      expect(within(nav).queryByRole('button', { name: english[key] }), `${key} in English`).toBeNull()
    }
    expect(document.documentElement.lang).toBe(lang)

    await userEvent.click(within(nav).getByRole('button', { name: text['nav.settings'] }))
    const picker = await screen.findByRole('combobox', { name: text['settings.language.aria'] }, LAZY_SCREEN_WAIT)
    expect(picker).toHaveValue(lang)
    expect(picker).toHaveDisplayValue(uiLanguageInfo(lang).nativeName)
  })
})
