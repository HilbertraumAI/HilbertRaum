// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { ActiveStreamSnapshot, Conversation, Message } from '../../src/shared/types'
import { STREAM_RECOVER_FAILURE_BUDGET, STREAM_RECOVER_POLL_MS } from '../../src/renderer/lib/polling'
import { t } from '../../src/shared/i18n'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatScreenStubs, conversationRow, deferred, flushFakeTimers, renderChatScreen } from '../helpers/chat-screen'
import { assistantMsg, makeConversation, userMsg } from '../helpers/chat-fixtures'

// T-1 (audit chat-docs-2026-07-07): the renderer STREAM-RECOVERY flow — the user sent a message,
// navigated away (unmounting the screen + its token listeners), and came back while the model is
// still responding — was completely untested on the renderer side. It is the most intricate effect
// in ChatScreen. These tests drive it end-to-end (jsdom + fake timers) and fold in the CR-4
// recovered-stop toast, the CR-5 conversation-mode-authoritative send branch and the CH-4 failure
// budget, each with teeth.

// Differs from makeConversation: documents mode + an explicit docs-only scope, so nothing raises the D71 dialog.
const docConv = (title: string): Conversation =>
  makeConversation({ title, mode: 'documents', scope: { collectionIds: [], documentIds: [] } })

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

describe('ChatScreen — stream recovery (T-1)', () => {
  it('shows the live recovered bubble + locked composer, then refreshes on completion; a recovered Stop confirms (CR-4)', async () => {
    vi.useFakeTimers()
    try {
      // The main-side snapshot: a partial answer while in flight, then null once it finishes.
      let liveSnap: ActiveStreamSnapshot | null = { content: 'partial answer', reasoning: '' }
      const getActiveStream = vi.fn(async (_id: string) => liveSnap)
      let history: Message[] = []
      const listMessages = vi.fn(async (_id: string) => history)
      const stopGeneration = vi.fn(async () => {})

      stubApi(
        chatScreenStubs({
          listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]),
          listMessages,
          getActiveStream,
          stopGeneration
        })
      )

      renderChatScreen()
      await flushFakeTimers() // mount: runtime + conversation list

      // Select c1 → the recovery effect polls getActiveStream and finds the in-flight reply.
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()

      // Live recovered bubble + locked composer (Stop replaces Send; Enter is inert while streaming).
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

      // CR-4: click Stop on the RECOVERED stream — the recovered path has no local stream() finally,
      // so the completed tick below is the only place that can confirm the stop.
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(stopGeneration).toHaveBeenCalledWith('c1')

      // The generation finishes: the snapshot goes null and the persisted final reply is available.
      history = [userMsg('u1', 'hello'), assistantMsg('a1', 'the final answer')]
      liveSnap = null
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STREAM_RECOVER_POLL_MS) // one recovery poll
      })
      await flushFakeTimers()

      // Completion: the persisted reply replaced the live bubble and Stop→Send.
      expect(screen.getByText('the final answer')).toBeInTheDocument()
      expect(screen.queryByText('partial answer')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
      // CR-4 teeth: without the recovered-stop branch this toast never appears (a recovered stop
      // would look like a normal complete turn — the M-U2 gap).
      expect(screen.getByText(t('en', 'chat.stopped'))).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-re-selects the streaming conversation on a fresh mount and mirrors its (documents) mode', async () => {
    vi.useFakeTimers()
    try {
      const getActiveStream = vi.fn(async (_id: string) => ({ content: 'partial answer', reasoning: '' }))
      stubApi(
        chatScreenStubs({
          listConversations: vi.fn(async () => [docConv('Doc chat 1')]),
          // A generation is in flight for c1 even though the fresh mount forgot which conversation it was.
          listActiveStreamConversations: vi.fn(async () => ['c1']),
          getActiveStream
        })
      )

      renderChatScreen()
      await flushFakeTimers()

      // Auto-selected c1 (the recovery effect polled it) and mirrored its documents mode (the composer
      // now shows the documents placeholder + the live recovered bubble).
      expect(getActiveStream).toHaveBeenCalledWith('c1')
      expect(screen.getByPlaceholderText(/ask about your documents/i)).toBeInTheDocument()
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('CR-5: a documents conversation recovered while listConversations threw still sends via askDocuments', async () => {
    vi.useFakeTimers()
    try {
      // Mount refresh (#0) succeeds and populates `conversations` with the documents conv; the
      // re-select fetch (#1) THROWS, so setMode is never called → the screen `mode` stays 'chat'.
      let convCall = 0
      const listConversations = vi.fn(async () => {
        const i = convCall++
        if (i === 1) throw new Error('list fetch failed')
        return [docConv('Doc chat 1')]
      })
      // Nothing actually in flight (getActiveStream → null, the stub default) → no recovery lock, so the
      // composer is free to send.
      const askDocuments = vi.fn(async () => assistantMsg('a1', 'the answer'))
      const sendChatMessage = vi.fn(async () => assistantMsg('a1', 'the answer'))

      stubApi(
        chatScreenStubs({
          listConversations,
          listActiveStreamConversations: vi.fn(async () => ['c1']),
          askDocuments,
          sendChatMessage
        })
      )

      renderChatScreen()
      await flushFakeTimers()

      // The screen mode stayed 'chat' (the re-select fetch failed to mirror it) — the CHAT placeholder,
      // not the documents one — proving the divergence the CR-5 branch must survive.
      const box = screen.getByPlaceholderText('Message…')
      fireEvent.change(box, { target: { value: 'the question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      // CR-5 teeth: the send branches on the CONVERSATION's own (documents) mode, not the screen mode.
      // Revert `stream` to the `mode`-state branch → sendChatMessage fires here instead.
      expect(askDocuments).toHaveBeenCalledWith('c1', 'the question', undefined, false, undefined, undefined)
      expect(sendChatMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not yank the user off a conversation they hand-picked while the re-select is resolving', async () => {
    vi.useFakeTimers()
    try {
      // Park the active-stream lookup so the user can click a different conversation mid-flight.
      const ids = deferred<string[]>()
      const listActiveStreamConversations = vi.fn(() => ids.promise)
      const getActiveStream = vi.fn(async (_id: string) => null)

      stubApi(
        chatScreenStubs({
          listConversations: vi.fn(async () => [
            makeConversation({ title: 'Chat 1' }),
            makeConversation({ id: 'c2', title: 'Chat 2' })
          ]),
          listActiveStreamConversations,
          getActiveStream
        })
      )

      renderChatScreen()
      await flushFakeTimers()
      expect(listActiveStreamConversations).toHaveBeenCalledTimes(1)

      // The user hand-picks c2 before the re-select (which would land on c1) resolves.
      fireEvent.click(conversationRow('Chat 2'))
      await flushFakeTimers()

      // Now the parked lookup resolves, naming c1 as the streaming conversation.
      await act(async () => ids.resolve(['c1']))
      await flushFakeTimers()

      // Teeth: the `activeIdRef.current != null` guards keep the user on c2 — the recovery effect only
      // ever polls c2. Remove the guard and the re-select stamps activeId back to c1 (→ getActiveStream('c1')).
      expect(getActiveStream).toHaveBeenCalledWith('c2')
      expect(getActiveStream).not.toHaveBeenCalledWith('c1')
    } finally {
      vi.useRealTimers()
    }
  })
})

// #613: a fresh mount mid-reply lists the question main is still answering a moment before the
// in-flight check (getActiveStream) flips `recovering`. "Send again" must wait for that check: a click
// in the gap collides with the live turn ("already being generated") over a reply that is working fine.
describe('ChatScreen — "Send again" waits for the in-flight check (#613)', () => {
  it('shows nothing under the question until the check says no reply is being written', async () => {
    vi.useFakeTimers()
    try {
      const check = deferred<ActiveStreamSnapshot | null>()
      const getActiveStream = vi.fn(() => check.promise)
      stubApi(
        chatScreenStubs({
          listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]),
          listMessages: vi.fn(async () => [userMsg('u1', 'the question')]),
          listActiveStreamConversations: vi.fn(async () => ['c1']),
          getActiveStream
        })
      )
      const sendAgain = (): HTMLElement | null => screen.queryByRole('button', { name: /Send again/ })

      renderChatScreen()
      await flushFakeTimers()
      expect(screen.getByText('the question')).toBeInTheDocument()
      expect(sendAgain()).toBeNull() // the check is still out: main may be writing this answer

      await act(async () => check.resolve(null))
      await flushFakeTimers()
      expect(sendAgain()).toBeInTheDocument() // nothing in flight: the question really has no answer
    } finally {
      vi.useRealTimers()
    }
  })
})

// CH-4 (frontend audit 2026-08-09, #148; moved here from ChatLowsBundle by the chat-ui test campaign): a
// getActiveStream REJECTION is not "stream finished". One transient IPC failure used to clear the live
// bubble, unlock the composer and permanently detach the poll. The poll now tolerates a bounded burst of
// consecutive failures (the shipped STREAM_RECOVER_FAILURE_BUDGET), resets the count on a good read, and
// only a sustained failure falls through to the best-effort finish.
describe('ChatScreen — recovery poll failure budget (CH-4, #148)', () => {
  it('keeps the recovered bubble through BUDGET − 1 consecutive IPC failures; the BUDGET-th finishes it', async () => {
    vi.useFakeTimers()
    try {
      let mode: 'live' | 'reject' = 'live'
      const getActiveStream = vi.fn(async (_id: string): Promise<ActiveStreamSnapshot | null> => {
        if (mode === 'reject') throw new Error('ipc hiccup')
        return { content: 'partial answer', reasoning: '' }
      })
      stubApi(
        chatScreenStubs({
          listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]),
          getActiveStream
        })
      )
      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      const tick = async (): Promise<void> => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(STREAM_RECOVER_POLL_MS)
        })
      }

      // A transient burst one short of the budget: the bubble and Stop survive.
      mode = 'reject'
      for (let i = 0; i < STREAM_RECOVER_FAILURE_BUDGET - 1; i++) await tick()
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
      // One good read resets the count, so another short burst still keeps the bubble…
      mode = 'live'
      await tick()
      mode = 'reject'
      for (let i = 0; i < STREAM_RECOVER_FAILURE_BUDGET - 1; i++) await tick()
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      // …and the BUDGET-th consecutive failure falls back to the best-effort finish: never a wedged composer.
      await tick()
      expect(screen.queryByText('partial answer')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
