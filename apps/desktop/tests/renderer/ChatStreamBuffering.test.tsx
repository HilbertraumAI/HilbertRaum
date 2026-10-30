// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, fireEvent, act } from '@testing-library/react'
import { STREAM_FLUSH_MS } from '../../src/renderer/screens/ChatScreen'
import type { Message } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import {
  chatScreenStubs,
  conversationRow,
  deferred,
  fakeChatStream,
  flushFakeTimers,
  renderChatScreen,
  type ChatStreamFake,
  type Deferred
} from '../helpers/chat-screen'
import { makeConversation, userMsg } from '../helpers/chat-fixtures'

// Coverage adds (frontend audit 2026-08-09, #147): the SCREEN-level stream path. The chat
// components had oracle-equivalence sweeps, but ChatScreen itself only ever saw 1–2 tokens
// per test — a STREAM_FLUSH_MS buffering / transcript-accumulation regression (dropped or
// re-ordered chunks across flush windows) reddened nothing. And no test drove a mid-stream
// ERROR after tokens had rendered, so the partial-bubble disposition was unpinned.
// Both rows run on fake timers and advance the shipped STREAM_FLUSH_MS window.

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
  }
})

/** Select 'Chat 1', send 'the question' and park the reply, with a live fake stream. `onSend` runs when the
 *  send IPC is invoked (main persists the user turn at that point). */
async function sendInto(
  history: () => Message[],
  onSend?: () => void
): Promise<{ stream: ChatStreamFake; reply: Deferred<Message> }> {
  const stream = fakeChatStream()
  const reply = deferred<Message>()
  stubApi(
    chatScreenStubs({
      ...stream.stubs,
      listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]),
      listMessages: vi.fn(async () => history()),
      sendChatMessage: vi.fn(() => {
        onSend?.()
        return reply.promise
      })
    })
  )
  renderChatScreen()
  await flushFakeTimers()
  fireEvent.click(conversationRow('Chat 1'))
  await flushFakeTimers()
  fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'the question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await flushFakeTimers()
  expect(stream.subscribed()).toBe(true)
  return { stream, reply }
}

const transcriptText = (): string =>
  screen.getByRole('region', { name: t('en', 'chat.transcript.label') }).textContent ?? ''

describe('ChatScreen — many-token stream buffering (#147 coverage add)', () => {
  it('accumulates a 60-token burst across flush windows with nothing dropped or reordered', async () => {
    vi.useFakeTimers()
    try {
      const { stream } = await sendInto(() => [userMsg('u1', 'earlier question')])
      // 60 numbered tokens, pushed in 3 bursts of 20, one STREAM_FLUSH_MS window each.
      const tokens = Array.from({ length: 60 }, (_, i) => `t${i} `)
      for (let burst = 0; burst < 3; burst++) {
        const from = burst * 20
        const to = from + 20
        for (let i = from; i < to; i++) stream.token(tokens[i])
        // Buffered: nothing of this burst renders before its STREAM_FLUSH_MS window closes…
        expect(transcriptText()).not.toMatch(new RegExp(`\\bt${to - 1}\\b`))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS)
        })
        // …and when it closes, every token so far is there, in order.
        expect(transcriptText()).toContain(tokens.slice(0, to).join('').trim())
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('a mid-stream error after rendered tokens drops the live partial for the persisted question and shows the error', async () => {
    vi.useFakeTimers()
    try {
      // Main persists the user turn before it streams, and NO partial on a non-abort error (chat.ts:1816-1820):
      // the history gains the question when the send starts, and nothing else.
      let history: Message[] = []
      const { stream, reply } = await sendInto(
        () => history,
        () => {
          history = [userMsg('u1', 'the question')]
        }
      )
      stream.token('partial ')
      stream.token('answer')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS)
      })
      expect(screen.getByText(/partial answer/)).toBeInTheDocument()

      // A runtime crash mid-answer, as main reports it (the friendly connectionLost copy).
      await act(async () => reply.reject(new Error(t('en', 'main.chat.connectionLost'))))
      await flushFakeTimers()
      expect(screen.queryByText(/partial answer/)).not.toBeInTheDocument() // live bubble dropped
      expect(screen.getAllByText('the question')).toHaveLength(1) // the persisted turn, not a 2nd copy
      // The persisted truth replaced the optimistic bubble: the stored question offers "Send again" (#613).
      expect(screen.getByRole('button', { name: /Send again/ })).toBeInTheDocument()
      // Persisted ⇒ no draft restore.
      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('')
      expect(screen.getByRole('alert')).toHaveTextContent(t('en', 'main.chat.connectionLost'))
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
