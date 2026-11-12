// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t, uiLanguageInfo, UI_LANGUAGE_CODES, type MessageKey } from '../../src/shared/i18n'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { appShellStubs } from '../helpers/app-shell'
import { LAZY_SCREEN_WAIT } from '../helpers/hang-budget'
import { catalogOf } from '../helpers/i18n-catalogs'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'

// Registration end to end, for every registered language but English (i18n record §5): the app
// shell and Settings → General in the language a user chose, through the stored setting that App
// applies once settings load. The mirror is seeded with the same language only so the first paint
// is not English, the way a real start looks; these rows do not prove the mirror path (the
// Русский round trip in I18n.test.tsx and the renderInLanguage rows do). Per-screen depth stays in
// GermanSmoke.test.tsx: every screen localizes through the same `useT()`, so replaying it per
// language would prove nothing new. A language registered later gets a row here by itself.

/** The rail's destinations: the `nav.*` labels, except the landmark's name and the brand mark's. */
const RAIL_KEYS = (Object.keys(catalogOf('en')) as MessageKey[]).filter(
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
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
    stubApi(appShellStubs({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, uiLanguage: lang })) }))
    render(<App />)

    const nav = await screen.findByRole('navigation', { name: t(lang, 'nav.aria') })
    for (const key of RAIL_KEYS) {
      expect(within(nav).getByRole('button', { name: t(lang, key) })).toBeInTheDocument()
      if (t(lang, key) !== t('en', key)) {
        expect(within(nav).queryByRole('button', { name: t('en', key) }), `${key} in English`).toBeNull()
      }
    }
    expect(document.documentElement.lang).toBe(lang)

    await userEvent.click(within(nav).getByRole('button', { name: t(lang, 'nav.settings') }))
    const picker = await screen.findByRole('combobox', { name: t(lang, 'settings.language.aria') }, LAZY_SCREEN_WAIT)
    expect(picker).toHaveValue(lang)
    expect(picker).toHaveDisplayValue(uiLanguageInfo(lang).nativeName)
  })
})
