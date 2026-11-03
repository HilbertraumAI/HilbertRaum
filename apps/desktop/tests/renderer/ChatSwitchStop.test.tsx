// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Conversation, Message } from '../../src/shared/types'
import type { PreloadApi } from '../../src/preload'
import { t } from '../../src/shared/i18n'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import {
  chatScreenStubs,
  conversationRow,
  deferred,
  flushFakeTimers,
  renderChatScreen,
  type Deferred
} from '../helpers/chat-screen'
import { assistantMsg, makeConversation, userMsg } from '../helpers/chat-fixtures'

// T-2 (audit chat-docs-2026-07-07): assert the invariant that keeps CR-9 safe. `onStop` targets
// `streamConvId ?? activeId`, byte-equivalent to the old `activeId` today ONLY because the user can
// never be viewing a different conversation than the streaming one while the Composer's Stop renders:
// ConversationList disables every non-active row while streaming (`disabled={streaming && !active}`,
// fed `streaming={busyStreaming}`). This test pins that disabled-row invariant AND that Stop aborts
// the streaming conversation. Reachability pointer: if a future change ever enables mid-stream
// switching, this disabled-row assertion reddens first — the signal to re-check `onStop`'s target.
// The file also holds CR-2 (a switch remounts the transcript, pinned to the bottom of the new
// conversation) and M-U2 (a local Stop is confirmed with a toast — not when the send failed, #742, nor
// when the Stop itself failed, CH-5).

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

/** Two plain chats, 'Chat 1' (c1) and 'Chat 2' (c2). */
const twoChats = (): Conversation[] => [
  makeConversation({ title: 'Chat 1' }),
  makeConversation({ id: 'c2', title: 'Chat 2' })
]

describe('ChatScreen — mid-stream switch is blocked; Stop targets the streaming conversation (T-2)', () => {
  it('disables the non-active conversation row while c1 streams, and Stop aborts c1', async () => {
    vi.useFakeTimers()
    try {
      // The send PARKS so the stream stays in flight (Composer shows Stop; the list locks).
      const sendChatMessage = vi.fn(() => new Promise<Message>(() => {}))
      const stopGeneration = vi.fn(async () => {})

      stubApi(
        chatScreenStubs({ listConversations: vi.fn(async () => twoChats()), sendChatMessage, stopGeneration })
      )

      renderChatScreen()
      await flushFakeTimers()

      // Select c1 and start a local stream.
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'hi there' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      // Streaming: the Composer shows Stop; the active row (c1) stays clickable, the other (c2) is
      // disabled — the user cannot switch away from the streaming conversation. This is the reachability
      // guarantee behind CR-9: `streamConvId === activeId` in every state Stop can render.
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
      expect(conversationRow('Chat 2').disabled).toBe(true)
      expect(conversationRow('Chat 1').disabled).toBe(false)

      // Stop aborts the STREAMING conversation (streamConvId ?? activeId === 'c1').
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(stopGeneration).toHaveBeenCalledWith('c1')
    } finally {
      vi.useRealTimers()
    }
  })
})

// CR-2 (audit chat-docs-2026-07-07; moved here from ChatSendFailure by the chat-ui test campaign): keying the
// Transcript on the conversation resets scroll / bottom-pin on a switch.
describe('ChatScreen — transcript scroll resets on conversation switch (CR-2)', () => {
  it('re-pins to the bottom of the newly selected conversation even after the user scrolled up in the previous one', async () => {
    vi.useFakeTimers()
    // jsdom lays nothing out (scrollHeight 0): give every transcript a height so a re-pin to the bottom
    // ({ top: 1000 }) reads differently from a scroll to the top ({ top: 0 }).
    const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('chat-transcript') ? 1000 : 0
    })
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo') // spies on setup.ts's no-op shim
    try {
      // Per-conversation histories so switching changes the content the transcript scrolls.
      const byConv: Record<string, Message[]> = {
        c1: [userMsg('a1', 'A first'), userMsg('a2', 'A second')],
        c2: [userMsg('b1', 'B only', { conversationId: 'c2' })]
      }
      stubApi(
        chatScreenStubs({
          listConversations: vi.fn(async () => twoChats()),
          listMessages: vi.fn(async (id: string) => byConv[id] ?? [])
        })
      )

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      expect(screen.getByText('A second')).toBeInTheDocument()

      // The user scrolls UP in A (800 px from the bottom): the transcript's onScroll flips atBottomRef to
      // false, so a plain messages-change would no longer auto-scroll (this is the state the old
      // shared-instance bug got stuck in across a switch).
      const transcriptA = document.querySelector('.chat-transcript') as HTMLElement
      Object.defineProperty(transcriptA, 'clientHeight', { configurable: true, value: 200 })
      transcriptA.scrollTop = 0 // 1000 - 0 - 200 = 800 px from the bottom → not pinned
      fireEvent.scroll(transcriptA)
      scrollTo.mockClear()

      // Switch to B: keying the Transcript on activeId REMOUNTS it, resetting atBottomRef to true so the
      // fresh mount's scroll effect pins B to the bottom. Teeth: remove the key → the reused instance keeps
      // A's atBottomRef=false, so the scroll effect does NOT re-pin and B opens at A's stale offset.
      fireEvent.click(conversationRow('Chat 2'))
      await flushFakeTimers()
      expect(screen.getByText('B only')).toBeInTheDocument()
      const transcriptB = document.querySelector('.chat-transcript') as HTMLElement
      expect(transcriptB).not.toBe(transcriptA) // keyed on activeId: a fresh instance
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000 }) // pinned to the bottom, not the top
      expect(scrollTo.mock.contexts.at(-1)).toBe(transcriptB) // …of the NEW conversation
    } finally {
      height.mockRestore()
      scrollTo.mockRestore()
      vi.useRealTimers()
    }
  })
})

// M-U2 (moved here from ChatRestructure by the chat-ui test campaign): a user-requested stop is confirmed,
// so a truncated reply is not mistaken for a complete one.
describe('ChatScreen — Stop confirmation (M-U2)', () => {
  /** Send "hello" in Chat 1, held open so the Stop button shows, then press Stop. Returns the held send. */
  async function sendThenStop(stopGeneration: PreloadApi['stopGeneration']): Promise<Deferred<Message>> {
    const user = userEvent.setup()
    const reply = deferred<Message>()
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]),
        sendChatMessage: vi.fn(() => reply.promise),
        stopGeneration
      })
    )
    renderChatScreen()

    await screen.findByText('Chat 1')
    await user.click(conversationRow('Chat 1'))
    await user.type(screen.getByRole('textbox'), 'hello')
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(stopGeneration).toHaveBeenCalledWith('c1')
    return reply
  }
  /** The send has settled: the stream's `finally`, which decides the toast, has run. */
  const settled = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Send' })

  it('toasts a "Stopped" confirmation when the user stops a live stream', async () => {
    const reply = await sendThenStop(vi.fn(async () => {}))
    // Main ends a user-stopped stream normally: it persists the partial and resolves (chat.ts, the abort catch).
    await act(async () => reply.resolve(assistantMsg('a1', 'partial')))
    expect(await screen.findByText(t('en', 'chat.stopped'))).toBeInTheDocument()
  })

  // #742: the toast is for a stop that ended the answer. A send that FAILED anyway — a real failure that
  // reached main before the Stop did — is explained by its banner, and a "Stopped" toast beside it is false.
  it('shows no "Stopped" toast when the send failed: its banner explains the end (#742)', async () => {
    const reply = await sendThenStop(vi.fn(async () => {}))
    await act(async () => reply.reject(new Error('The AI model stopped before the answer was finished.')))
    await settled()
    expect(screen.getByText('The AI model stopped before the answer was finished.')).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'chat.stopped'))).not.toBeInTheDocument()
  })

  // CH-5 (#148; a #743 gap): a Stop that fails says so, and forgets the stop — so the answer then finishing
  // normally is not confirmed as stopped.
  it('a failed Stop shows its error, and the answer then finishing gets no "Stopped" toast', async () => {
    const reply = await sendThenStop(vi.fn(async () => Promise.reject(new Error('Could not stop the answer.'))))
    expect(await screen.findByText('Could not stop the answer.')).toBeInTheDocument()
    await act(async () => reply.resolve(assistantMsg('a1', 'the whole answer')))
    await settled()
    expect(screen.queryByText(t('en', 'chat.stopped'))).not.toBeInTheDocument()
  })
})
