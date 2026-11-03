// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, fireEvent, act } from '@testing-library/react'
import { WARMUP_HINT_DELAY_MS } from '../../src/renderer/screens/ChatScreen'
import type { Message, RuntimeStatus } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import {
  chatScreenStubs,
  conversationRow,
  deferred,
  fakeChatStream,
  flushFakeTimers,
  renderChatScreen,
  type ChatStreamFake
} from '../helpers/chat-screen'
import { makeConversation } from '../helpers/chat-fixtures'
import { runtimeStatus } from '../helpers/status'

// Issue #39: the calm one-time "the first answer takes a little longer — the model is
// warming up" line under the pending answer. Honesty gates, all of which must hold:
//  - only AFTER the turn has streamed nothing for WARMUP_HINT_DELAY_MS (no flash on GPU);
//  - only when the runtime says it really is the first generation since the model started
//    (RuntimeStatus.warmedUp === false — a warmed session never sees it);
//  - dropped the instant ANYTHING streams (answer token OR Deep-mode reasoning delta);
//  - absent `warmedUp` (older/bare runtime shape) fails safe: no hint, ever.
//
// #109 decision (hidden warm-up generation): the ladder's start() now runs a tiny discarded
// generation BEFORE reporting ready, but it calls the inner runtime directly, so `warmedUp`
// stays false and everything below is UNCHANGED — the hint remains armed as the safety net
// for the real first prompt (which still pays the full system-prompt prefill; the warm-up
// shares no cache_prompt prefix with it). Most first prompts now stream fast enough that the
// 3 s gate simply never trips; a still-slow one keeps its honest explanation.

const HINT = t('en', 'chat.warmup.hint')

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

/** Render the screen with `status` as every runtime read; a send parks so the stream stays in flight with
 *  no tokens yet. Returns the fake stream to emit into. */
function setup(status: RuntimeStatus): ChatStreamFake {
  const stream = fakeChatStream()
  stubApi(
    chatScreenStubs({
      ...stream.stubs,
      listConversations: vi.fn(async () => [makeConversation({ title: 'Warmup chat' })]),
      getRuntimeStatus: vi.fn(async () => status),
      // Parks forever — the turn stays pending, exactly the silent-prefill window under test.
      sendChatMessage: vi.fn(() => new Promise<Message>(() => {}))
    })
  )
  renderChatScreen()
  return stream
}

async function sendParkedTurn(): Promise<void> {
  await flushFakeTimers()
  fireEvent.click(conversationRow('Warmup chat'))
  await flushFakeTimers()
  fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'hi' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await flushFakeTimers()
}

describe('ChatScreen — first-answer warm-up hint (#39)', () => {
  it('shows the hint only after the delay on a cold runtime, and the first token retires it', async () => {
    vi.useFakeTimers()
    const stream = setup(runtimeStatus({ warmedUp: false }))
    await sendParkedTurn()

    // Just short of the shipped delay: streaming, but no hint yet — a fast first turn must never flash it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS - 1)
    })
    await flushFakeTimers()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flushFakeTimers()
    // A quiet status line inside the live bubble — announced once, never an alert.
    expect(screen.getByText(HINT)).toHaveAttribute('role', 'status')

    // The first answer token drops it for good — tokens flowing IS the "warm-up over" signal.
    stream.token('Hello')
    await flushFakeTimers()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  // The status gate reads `warmedUp === false`: a warmed runtime never sees the hint, and neither does one
  // whose status has no `warmedUp` key at all — the absent field fails safe, which is what tells
  // `=== false` from `!warmedUp`.
  const { warmedUp: _absent, ...withoutWarmedUp } = runtimeStatus()
  it.each([
    ['a warmed runtime (warmedUp: true)', runtimeStatus({ warmedUp: true })],
    ['a runtime that cannot report warm-up state (warmedUp absent — fails safe)', withoutWarmedUp]
  ])('never shows on %s, however long the wait', async (_label, status) => {
    vi.useFakeTimers()
    setup(status)
    await sendParkedTurn()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS * 3)
    })
    await flushFakeTimers()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  // A Deep-mode reasoning delta precedes any answer token and equally proves the prefill is done.
  it.each([
    ['an answer token', (s: ChatStreamFake) => s.token('fast')],
    ['a Deep-mode reasoning delta', (s: ChatStreamFake) => s.reasoning('pondering…')]
  ])('%s before the delay suppresses the hint entirely (no flash)', async (_label, emit) => {
    vi.useFakeTimers()
    const stream = setup(runtimeStatus({ warmedUp: false }))
    await sendParkedTurn()

    emit(stream)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS * 2)
    })
    await flushFakeTimers()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  it('a Deep-mode reasoning delta retires a hint that is already showing', async () => {
    vi.useFakeTimers()
    const stream = setup(runtimeStatus({ warmedUp: false }))
    await sendParkedTurn()

    // Hint shows first (cold + silent past the delay)…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS)
    })
    await flushFakeTimers()
    expect(screen.getByText(HINT)).toBeInTheDocument()

    // …then the first reasoning delta (which precedes any answer token in Deep mode) drops it:
    // the model is visibly thinking, so "warming up" would be false.
    stream.reasoning('pondering…')
    await flushFakeTimers()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  // #743: the hint is screen state, shown only inside a live bubble, and the turn's `finally` retires it. A
  // turn that ends before its first token unmounts its bubble, so without that reset the hint waits, unseen,
  // for the next live bubble. That can be a stream this screen did not start: an answer still being written
  // from before the user navigated away and back, whose re-select lost to the user's own pick (CH-3) and
  // that the user reaches later by clicking its chat. Its bubble then said "warming up" beside an answer that
  // is visibly being written.
  it('a turn that ends before its first token takes the hint with it: a recovered answer elsewhere never shows it', async () => {
    vi.useFakeTimers()
    const reselect = deferred<string[]>()
    const send = deferred<Message>()
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [
          makeConversation({ title: 'Warmup chat' }),
          makeConversation({ id: 'c2', title: 'Earlier chat' })
        ]),
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ warmedUp: false })),
        // Earlier chat's answer is still being written; the mount's re-select to it answers late.
        listActiveStreamConversations: vi.fn(() => reselect.promise),
        getActiveStream: vi.fn(async (id: string) =>
          id === 'c2' ? { content: 'the earlier answer', reasoning: '' } : null
        ),
        sendChatMessage: vi.fn(() => send.promise)
      })
    )
    renderChatScreen()
    await sendParkedTurn() // the user picked Warmup chat first and asked there
    await act(async () => reselect.resolve(['c2'])) // too late: the user's pick stands
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_HINT_DELAY_MS)
    })
    await flushFakeTimers()
    expect(screen.getByText(HINT)).toBeInTheDocument()

    // The turn fails before any token.
    await act(async () => send.reject(new Error('the turn failed')))
    await flushFakeTimers()

    fireEvent.click(conversationRow('Earlier chat'))
    await flushFakeTimers()
    expect(screen.getByText('the earlier answer')).toBeInTheDocument() // the recovered live bubble
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })
})
