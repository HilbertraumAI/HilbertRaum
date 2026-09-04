// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { formatAnswerSpeed } from '../../src/renderer/chat/answerSpeed'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { Message } from '../../src/shared/types'
import type { AnswerSpeed } from '../../src/shared/ipc'

// #290: the per-answer speed line under a FINISHED chat answer — `42 tok/s · 1.8 s to first
// token · 615 tokens` — rendered only for messages whose speed payload arrived in this session.

vi.mock('streamdown', () => ({
  Streamdown: vi.fn(({ children }) => <div data-testid="sd">{children}</div>),
  defaultRehypePlugins: { raw: () => undefined, sanitize: () => undefined }
}))

function assistantMsg(id: string, content = 'An answer.'): Message {
  return { id, conversationId: 'c1', role: 'assistant', content, createdAt: '2026-01-01T00:00:00Z' }
}
const noop = (): void => {}
const onCopy = (_c: string): void => {}
const tFor = (lang: UiLanguage) => (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
  t(lang, key, params)

function renderTranscript(lang: UiLanguage, messages: Message[], answerSpeeds?: ReadonlyMap<string, AnswerSpeed>) {
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
        answerSpeeds={answerSpeeds}
      />
    </I18nProvider>
  )
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe('formatAnswerSpeed (#290) — rounding + locale', () => {
  it('drops decimals at or above 10 tok/s, keeps one below; TTFT one decimal; whole tokens', () => {
    expect(formatAnswerSpeed({ messageId: 'a', tokensPerSecond: 42.4, ttftMs: 1_840, tokens: 615 }, tFor('en'), 'en')).toBe(
      '42 tok/s · 1.8 s to first token · 615 tokens'
    )
    expect(formatAnswerSpeed({ messageId: 'a', tokensPerSecond: 9.96, ttftMs: 12_349, tokens: 1024 }, tFor('en'), 'en')).toBe(
      '10.0 tok/s · 12.3 s to first token · 1,024 tokens'
    )
    expect(formatAnswerSpeed({ messageId: 'a', tokensPerSecond: 2.25, ttftMs: 400, tokens: 3 }, tFor('en'), 'en')).toBe(
      '2.3 tok/s · 0.4 s to first token · 3 tokens'
    )
  })

  it('renders German separators and copy', () => {
    expect(formatAnswerSpeed({ messageId: 'a', tokensPerSecond: 42.4, ttftMs: 1_840, tokens: 1615 }, tFor('de'), 'de')).toBe(
      '42 Token/s · 1,8 s bis zum ersten Token · 1.615 Token'
    )
    expect(formatAnswerSpeed({ messageId: 'a', tokensPerSecond: 4.75, ttftMs: 950, tokens: 12 }, tFor('de'), 'de')).toBe(
      '4,8 Token/s · 1,0 s bis zum ersten Token · 12 Token'
    )
  })
})

describe('Transcript speed line (#290)', () => {
  const speed: AnswerSpeed = { messageId: 'a2', tokensPerSecond: 42, ttftMs: 1_800, tokens: 615 }

  it('shows the line under the answer that has a speed payload, in English', () => {
    renderTranscript('en', [assistantMsg('a1'), assistantMsg('a2')], new Map([['a2', speed]]))
    const line = screen.getByText('42 tok/s · 1.8 s to first token · 615 tokens')
    expect(line).toHaveAttribute('role', 'note')
    expect(line).toHaveAttribute('title', t('en', 'chat.speed.hint'))
    // Exactly one line: the other answer (no payload this session) shows nothing.
    expect(screen.getAllByRole('note').filter((n) => n.className === 'msg-speed')).toHaveLength(1)
  })

  it('shows the line in German', () => {
    renderTranscript('de', [assistantMsg('a2')], new Map([['a2', speed]]))
    expect(screen.getByText('42 Token/s · 1,8 s bis zum ersten Token · 615 Token')).toBeInTheDocument()
  })

  it('renders cleanly with no line when there is no payload (mock runtime / aborted answer)', () => {
    renderTranscript('en', [assistantMsg('a1'), assistantMsg('a2')], new Map())
    expect(screen.queryByText(/to first token/)).not.toBeInTheDocument()
    expect(document.querySelector('.msg-speed')).toBeNull()
  })

  it('shows nothing on reloaded history — a fresh session map carries no entries for old messages', () => {
    // The payload is never persisted, so a reload re-renders the same messages with an empty map.
    const { unmount } = renderTranscript('en', [assistantMsg('a2')], new Map([['a2', speed]]))
    expect(screen.getByText(/to first token/)).toBeInTheDocument()
    unmount()
    renderTranscript('en', [assistantMsg('a2')], new Map())
    expect(screen.queryByText(/to first token/)).not.toBeInTheDocument()
  })

  it('never renders a line on a user turn even if an id collides', () => {
    const user: Message = { id: 'a2', conversationId: 'c1', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' }
    renderTranscript('en', [user], new Map([['a2', speed]]))
    expect(document.querySelector('.msg-speed')).toBeNull()
  })
})
