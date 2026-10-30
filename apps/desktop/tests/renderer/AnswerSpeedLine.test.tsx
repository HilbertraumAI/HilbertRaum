// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { formatAnswerSpeed } from '../../src/renderer/chat/answerSpeed'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { PreloadApi } from '../../src/preload'
import type { Message } from '../../src/shared/types'
import type { AnswerSpeed } from '../../src/shared/ipc'
import { assistantMsg, makeConversation, userMsg } from '../helpers/chat-fixtures'
import {
  chatScreenStubs,
  conversationRow,
  deferred,
  fakeChatStream,
  flushFakeTimers,
  renderChatScreen
} from '../helpers/chat-screen'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { renderTranscript } from '../helpers/transcript'

// #290: the per-answer speed line under a FINISHED chat answer — `42 tok/s · 1.8 s to first
// token · 615 tokens` — rendered only for messages whose speed payload arrived in this session.

const tFor = (lang: UiLanguage) => (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
  t(lang, key, params)

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
    renderTranscript({ messages: [assistantMsg('a1', 'An answer.'), assistantMsg('a2', 'An answer.')], answerSpeeds: new Map([['a2', speed]]) }, 'en')
    const line = screen.getByText('42 tok/s · 1.8 s to first token · 615 tokens')
    expect(line).toHaveAttribute('role', 'note')
    expect(line).toHaveAttribute('title', t('en', 'chat.speed.hint'))
    // Exactly one line: the other answer (no payload this session) shows nothing.
    expect(screen.getAllByText(/to first token/)).toHaveLength(1)
  })

  it('shows the line in German', () => {
    renderTranscript({ messages: [assistantMsg('a2', 'An answer.')], answerSpeeds: new Map([['a2', speed]]) }, 'de')
    expect(screen.getByText('42 Token/s · 1,8 s bis zum ersten Token · 615 Token')).toBeInTheDocument()
  })

  it('renders cleanly with no line when there is no payload (mock runtime / aborted answer)', () => {
    renderTranscript({ messages: [assistantMsg('a1', 'An answer.'), assistantMsg('a2', 'An answer.')], answerSpeeds: new Map() }, 'en')
    expect(screen.queryByText(/to first token/)).not.toBeInTheDocument()
  })

  it('never renders a line on a user turn even if an id collides', () => {
    renderTranscript({ messages: [userMsg('a2', 'hi')], answerSpeeds: new Map([['a2', speed]]) }, 'en')
    expect(screen.getByText('hi')).toBeInTheDocument()
    expect(screen.queryByText(/to first token/)).not.toBeInTheDocument()
  })
})

// The wiring no other suite fires: `onAnswerSpeed` → ChatScreen's session map → the line. `fakeChatStream`
// has no speed channel yet, so the listener is captured here, in the same shape.
describe('ChatScreen speed wiring (#290)', () => {
  it('the chat:speed payload shows the line for this session; a remount over the same history shows none', async () => {
    vi.useFakeTimers()
    try {
      const stream = fakeChatStream()
      const reply = deferred<Message>()
      const answer = assistantMsg('a2', 'An answer.')
      let history: Message[] = []
      const speedListener: { current: ((s: AnswerSpeed) => void) | null } = { current: null }
      stubApi(
        chatScreenStubs({
          ...stream.stubs,
          onAnswerSpeed: vi.fn<PreloadApi['onAnswerSpeed']>((_id, cb) => {
            speedListener.current = cb
            return () => {
              speedListener.current = null
            }
          }),
          listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]),
          listMessages: vi.fn(async () => history),
          sendChatMessage: vi.fn(() => reply.promise)
        })
      )
      const first = renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'the question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()
      expect(stream.subscribed()).toBe(true)
      expect(speedListener.current).not.toBeNull()
      // Main sends the payload right before `done`, keyed to the persisted message.
      act(() => speedListener.current?.({ messageId: 'a2', tokensPerSecond: 42, ttftMs: 1_800, tokens: 615 }))
      history = [userMsg('u1', 'the question'), answer]
      await act(async () => {
        reply.resolve(answer)
      })
      await flushFakeTimers()
      expect(screen.getByText('42 tok/s · 1.8 s to first token · 615 tokens')).toBeInTheDocument()
      // A fresh mount is a reload: the same persisted answer, and no payload was persisted with it.
      first.unmount()
      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      expect(screen.getByText('An answer.')).toBeInTheDocument()
      expect(screen.queryByText(/to first token/)).not.toBeInTheDocument()
      assertNoUnexpectedApiCalls()
    } finally {
      vi.useRealTimers()
    }
  })
})
