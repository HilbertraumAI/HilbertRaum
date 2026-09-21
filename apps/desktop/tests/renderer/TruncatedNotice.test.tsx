// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { Message, TruncationCause } from '../../src/shared/types'

// #498: the cut-off badge used to read "Reply cut off — reached the model's context limit" and its
// tooltip always advised raising the context size — wrong for a grounded reply the app's OWN fixed
// per-reply cap ended. The label now names no cause and `Message.truncatedCause` picks the tooltip;
// a legacy row (flag set, no cause) keeps the old context-window advice.

vi.mock('streamdown', () => ({
  Streamdown: vi.fn(({ children }) => <div data-testid="sd">{children}</div>),
  defaultRehypePlugins: { raw: () => undefined, sanitize: () => undefined }
}))

function assistantMsg(id: string, truncated?: boolean, truncatedCause?: TruncationCause): Message {
  return {
    id,
    conversationId: 'c1',
    role: 'assistant',
    content: 'An answer that stops mid-',
    createdAt: '2026-01-01T00:00:00Z',
    truncated,
    truncatedCause
  }
}
const noop = (): void => {}
const onCopy = (_c: string): void => {}

function renderTranscript(lang: UiLanguage, messages: Message[]) {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
  return render(
    <I18nProvider>
      <Transcript
        messages={messages}
        streamingHere={false}
        streamText=""
        streamThinking=""
        thinkingOpen={false}
        onThinkingOpenChange={noop}
        emptyState={null}
        onCopy={onCopy}
        onSave={noop}
        actionsDisabled={false}
      />
    </I18nProvider>
  )
}

const notice = (): HTMLElement | null => document.querySelector('.msg-truncated')

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe('Transcript truncation notice (#498)', () => {
  it('names no cause in the visible label, in either language', () => {
    renderTranscript('en', [assistantMsg('a1', true, 'cap')])
    expect(screen.getByText('Reply cut off')).toBeInTheDocument()
    expect(screen.queryByText(/context limit/i)).not.toBeInTheDocument()
    cleanup()
    renderTranscript('de', [assistantMsg('a1', true, 'cap')])
    expect(screen.getByText('Antwort abgeschnitten')).toBeInTheDocument()
    expect(screen.queryByText(/Kontextlimit/)).not.toBeInTheDocument()
  })

  it('offers the context-size remedy only when the WINDOW was the cause', () => {
    renderTranscript('en', [assistantMsg('a1', true, 'context')])
    const el = notice()
    expect(el).toHaveAttribute('role', 'note')
    expect(el).toHaveAttribute('title', t('en', 'chat.truncated.hint.context'))
    expect(el?.getAttribute('title')).toContain('raise the context size')
  })

  it("offers the continue remedy — never the context size — when the app's own cap was the cause", () => {
    renderTranscript('en', [assistantMsg('a1', true, 'cap')])
    const el = notice()
    expect(el).toHaveAttribute('title', t('en', 'chat.truncated.hint.cap'))
    expect(el?.getAttribute('title')).not.toContain('raise the context size')
  })

  it('a legacy truncated row with no cause keeps the old context-window advice', () => {
    renderTranscript('en', [assistantMsg('a1', true, undefined)])
    expect(notice()).toHaveAttribute('title', t('en', 'chat.truncated.hint.context'))
  })

  it('renders the German tooltip for each cause', () => {
    renderTranscript('de', [assistantMsg('a1', true, 'context')])
    expect(notice()).toHaveAttribute('title', t('de', 'chat.truncated.hint.context'))
    cleanup()
    renderTranscript('de', [assistantMsg('a1', true, 'cap')])
    expect(notice()).toHaveAttribute('title', t('de', 'chat.truncated.hint.cap'))
  })

  it('shows nothing on a complete reply or on a user turn', () => {
    renderTranscript('en', [assistantMsg('a1')])
    expect(notice()).toBeNull()
    cleanup()
    const user: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      content: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
      truncated: true,
      truncatedCause: 'cap'
    }
    renderTranscript('en', [user])
    expect(notice()).toBeNull()
  })
})
