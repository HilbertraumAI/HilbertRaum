// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeNarrowDialog } from '../../src/renderer/chat/ScopeNarrowDialog'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t } from '../../src/shared/i18n'

// Beta-feedback Phase 4 (#26, D71) — attaching a file to an existing whole-library documents chat
// offers a one-time narrow/widen choice. "Just this file" narrows; "Whole library" keeps the corpus
// default. This pins the choice round-trip (which callback fires) + the German copy (D-L8).

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('ScopeNarrowDialog — attach narrow/widen choice (#26, D71)', () => {
  it('names the attached file and offers both choices', () => {
    render(
      <I18nProvider>
        <ScopeNarrowDialog open fileName="Vollmacht.docx" onNarrow={vi.fn()} onWhole={vi.fn()} onDismiss={vi.fn()} />
      </I18nProvider>
    )
    expect(screen.getByText(t('en', 'chat.scope.narrowTitle'))).toBeInTheDocument()
    expect(
      screen.getByText(t('en', 'chat.scope.narrowBody', { name: 'Vollmacht.docx' }))
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('en', 'chat.scope.narrowJust') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('en', 'chat.scope.narrowWhole') })).toBeInTheDocument()
  })

  it('"Just this file" calls onNarrow only', async () => {
    const onNarrow = vi.fn()
    const onWhole = vi.fn()
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopeNarrowDialog open fileName="a.pdf" onNarrow={onNarrow} onWhole={onWhole} onDismiss={vi.fn()} />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button', { name: t('en', 'chat.scope.narrowJust') }))
    expect(onNarrow).toHaveBeenCalledTimes(1)
    expect(onWhole).not.toHaveBeenCalled()
  })

  it('"Whole library" calls onWhole only', async () => {
    const onNarrow = vi.fn()
    const onWhole = vi.fn()
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopeNarrowDialog open fileName="a.pdf" onNarrow={onNarrow} onWhole={onWhole} onDismiss={vi.fn()} />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button', { name: t('en', 'chat.scope.narrowWhole') }))
    expect(onWhole).toHaveBeenCalledTimes(1)
    expect(onNarrow).not.toHaveBeenCalled()
  })

  it('renders the German copy (forced via the localStorage mirror, D-L8)', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    render(
      <I18nProvider>
        <ScopeNarrowDialog open fileName="Vollmacht.docx" onNarrow={vi.fn()} onWhole={vi.fn()} onDismiss={vi.fn()} />
      </I18nProvider>
    )
    expect(screen.getByText(t('de', 'chat.scope.narrowTitle'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'chat.scope.narrowJust') })
    ).toBeInTheDocument()
  })
})

// CH-13 (frontend audit 2026-08-09, #148): a dismissal is not a decision — Esc / overlay must
// close via onDismiss only, never fire onWhole (which ChatScreen records STICKY per
// conversation, permanently suppressing the one-time prompt the user never answered).
describe('ScopeNarrowDialog — Esc/overlay dismissal is not a decision (CH-13)', () => {
  it('Esc calls onDismiss only — neither choice callback fires', async () => {
    const onNarrow = vi.fn()
    const onWhole = vi.fn()
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopeNarrowDialog open fileName="a.pdf" onNarrow={onNarrow} onWhole={onWhole} onDismiss={onDismiss} />
      </I18nProvider>
    )
    await user.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onWhole).not.toHaveBeenCalled()
    expect(onNarrow).not.toHaveBeenCalled()
  })
})
