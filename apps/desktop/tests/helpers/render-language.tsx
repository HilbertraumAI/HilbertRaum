import type { ReactElement } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import type { UiLanguage } from '../../src/shared/i18n'

// Render a component in a forced UI language (chat-ui campaign; D-L8). Replaces the local "set the
// localStorage mirror, then wrap in I18nProvider" copies (ContextMeter's `renderMeter`, ScopePopover ×2,
// ScopeNarrowDialog, the Transcript suites). The provider reads the mirror once, at its first render, so
// the key is set BEFORE render. `I18nProvider` is the RTL `wrapper`, so `rerender(<Other />)` keeps it.
// The mirror outlives the test: callers clear localStorage in their own afterEach, as they do today.

/** `ui` rendered under `I18nProvider` in `lang`. */
export function renderInLanguage(ui: ReactElement, lang: UiLanguage): RenderResult {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
  return render(ui, { wrapper: I18nProvider })
}
