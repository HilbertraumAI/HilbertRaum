// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { EndedEarly, Message, TruncationCause } from '../../src/shared/types'

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

// #600 / #612: a reply that ended before it was finished — the user stopped or switched the model,
// pressed Stop, or locked the workspace / quit — gets its OWN label ("Reply stopped"), never the cut-off
// badge, whose meaning is "the model ran out of room"; the tooltip names the cause. A question such a
// turn left with no answer gets a "Not answered" note naming the cause, which goes once an answer follows.
describe('the "Reply stopped" and "Not answered" notes (#600, #612)', () => {
  const causes: EndedEarly[] = ['model', 'user', 'lock']
  const user = (id: string, endedEarly?: EndedEarly): Message => ({
    id,
    conversationId: 'c1',
    role: 'user',
    content: 'Tell me about lighthouses.',
    createdAt: '2026-01-01T00:00:00Z',
    endedEarly
  })

  it.each((['en', 'de'] as const).flatMap((lang) => causes.map((cause) => [lang, cause] as const)))(
    '%s: a reply that ended early (%s) shows "Reply stopped" with the hint for its cause',
    (lang, cause) => {
      renderTranscript(lang, [user('u1'), { ...assistantMsg('a1'), endedEarly: cause }])
      expect(notice()).toHaveTextContent(t(lang, 'chat.endedEarly.label'))
      expect(notice()).toHaveAttribute('title', t(lang, `chat.endedEarly.hint.${cause}`))
      expect(screen.queryByText(t(lang, 'chat.truncated.label'))).toBeNull()
    }
  )

  it.each(causes)('a question a turn that ended early (%s) left unanswered says why', (cause) => {
    renderTranscript('en', [user('u1', cause)])
    expect(notice()).toHaveTextContent(t('en', `chat.unanswered.${cause}`))
  })

  it('once an answer follows the question, the "Not answered" note goes', () => {
    renderTranscript('en', [user('u1', 'user'), assistantMsg('a1')])
    expect(screen.queryByText(t('en', 'chat.unanswered.user'))).toBeNull()
  })
})
