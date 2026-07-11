// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import { DOC_TASK_BUSY_MESSAGE, type Conversation, type Message, type RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// CR-1 (audit chat-docs-2026-07-07): a send that fails BEFORE the user turn persists (document-task
// busy, no model, a slot held by another window) used to lose both the composer text and the
// optimistic bubble — precisely when the banner invites a retry. The fix keeps the responsive early
// setInput('') but restores the draft into a still-empty composer when the turn did not persist.
// CR-2 (same file cluster): keying the Transcript on the conversation resets scroll/bottom-pin on a
// switch. Both are exercised here with teeth.

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function chatConv(id: string, title: string): Conversation {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null
  }
}

function userMsg(id: string, convId: string, content: string): Message {
  return { id, conversationId: convId, role: 'user', content, createdAt: '2026-01-01T00:01:00Z' }
}

function assistantMsg(id: string, convId: string, content: string): Message {
  return { id, conversationId: convId, role: 'assistant', content, createdAt: '2026-01-01T00:02:00Z' }
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.clear()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
  })
}

function renderChat(): void {
  render(
    <ToastProvider>
      <ChatScreen onNavigate={() => {}} />
    </ToastProvider>
  )
}

/** Common stub for a working chat screen with one conversation and a controllable send. */
function baseStub(overrides: Partial<Parameters<typeof stubApi>[0]>): void {
  stubApi({
    listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1')]),
    getRuntimeStatus: vi.fn(async () => runningStatus),
    listDocuments: vi.fn(async () => []),
    listCollections: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    listActiveStreamConversations: vi.fn(async () => []),
    getActiveStream: vi.fn(async () => null),
    onToken: vi.fn(() => () => {}),
    onReasoning: vi.fn(() => () => {}),
    onScopeNotice: vi.fn(() => () => {}),
    ...overrides
  })
}

describe('ChatScreen — draft restore on pre-persist send failure (CR-1)', () => {
  it('refills the composer and shows the banner when a send fails before the user turn persists', async () => {
    vi.useFakeTimers()
    try {
      // Guard rejects before writing the user turn; the failure refresh returns an EMPTY history.
      const sendChatMessage = vi.fn(async () => {
        throw new Error(DOC_TASK_BUSY_MESSAGE)
      })
      baseStub({ listMessages: vi.fn(async () => []), sendChatMessage })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'a long typed question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // Teeth: without the restore the composer stays empty (the draft is lost). The banner is shown.
      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe(
        'a long typed question'
      )
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/document task/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps newer in-flight typing (the cur === "" guard) instead of clobbering it', async () => {
    vi.useFakeTimers()
    try {
      // The send parks until we release it as a rejection, so we can type again mid-flight.
      let rejectSend: ((e: Error) => void) | null = null
      const sendChatMessage = vi.fn(
        () =>
          new Promise<Message>((_res, rej) => {
            rejectSend = (e) => rej(e)
          })
      )
      baseStub({ listMessages: vi.fn(async () => []), sendChatMessage })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()
      // The early setInput('') cleared it; the user types a NEW draft while the send is in flight.
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'world' } })

      // Now the send fails pre-persist — the restore must NOT overwrite the newer 'world'.
      await act(async () => {
        rejectSend!(new Error('no model running'))
      })
      await flush()

      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('world')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT restore when the failed send still persisted the user turn (no duplicate)', async () => {
    vi.useFakeTimers()
    try {
      // The send errors (e.g. a socket drop mid-stream) but the user turn WAS written — the failure
      // refresh returns a history that already contains it.
      const sendChatMessage = vi.fn(async () => {
        throw new Error('stream failed')
      })
      baseStub({
        listMessages: vi.fn(async () => [userMsg('u1', 'c1', 'persisted question')]),
        sendChatMessage
      })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'persisted question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // Teeth: the persisted-check keeps the composer empty (the question already shows in the
      // transcript — restoring it would invite a duplicate re-send). Drop the check → it refills.
      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('')
      expect(screen.getByText('persisted question')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // full-audit 2026-07-11 CODE-40: the persisted-check used to be `persisted.some(content ===)` —
  // a REPEATED question matched the OLD turn, so a busy-rejected re-ask was silently lost (no
  // restore, no bubble). The check now compares against the TAIL: a send that persisted its user
  // turn leaves the conversation ENDING in that turn when the catch runs.
  it('restores the draft when a REPEATED question is busy-rejected before it persists (CODE-40)', async () => {
    vi.useFakeTimers()
    try {
      // History: the SAME question was asked and answered earlier; the new send is guard-rejected
      // pre-persist, so the failure refresh returns that unchanged history (tail = assistant).
      const history = [userMsg('u1', 'c1', 'x'), assistantMsg('a1', 'c1', 'answer to x')]
      const sendChatMessage = vi.fn(async () => {
        throw new Error(DOC_TASK_BUSY_MESSAGE)
      })
      baseStub({ listMessages: vi.fn(async () => history), sendChatMessage })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // TEETH: with `some(content ===)` the OLD 'x' matches → no restore → this reads ''.
      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('x')
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/document task/i)
    } finally {
      vi.useRealTimers()
    }
  })

  // CODE-40 follow-up (review): the try also spans the two POST-send refreshes — a fully
  // successful send whose refreshConversations then throws lands in the same catch with the
  // persisted tail being the ASSISTANT reply. The bare tail compare misread that as "turn never
  // persisted" and restored the already-answered question (a duplicate-re-send invitation);
  // the `sendSucceeded` latch scopes the compare to send FAILURES.
  it('does NOT restore the draft when the send succeeded but a post-send refresh throws (CODE-40 follow-up)', async () => {
    vi.useFakeTimers()
    try {
      // The send itself SUCCEEDS, resolving the persisted assistant reply.
      const sendChatMessage = vi.fn(async () => assistantMsg('a1', 'c1', 'the answer'))
      const listConversations = vi
        .fn<() => Promise<Conversation[]>>()
        .mockResolvedValueOnce([chatConv('c1', 'Chat 1')]) // mount refresh
        .mockRejectedValue(new Error('list failed after send')) // the post-send refresh throws
      baseStub({
        listConversations,
        // The persisted truth after the successful send: question + fresh answer (tail = assistant).
        listMessages: vi.fn(async () => [
          userMsg('u1', 'c1', 'quantum question'),
          assistantMsg('a1', 'c1', 'the answer')
        ]),
        sendChatMessage
      })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      fireEvent.change(screen.getByPlaceholderText('Message…'), {
        target: { value: 'quantum question' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // TEETH: without the latch the assistant tail reads as "not persisted" → the composer
      // refills with the ALREADY-ANSWERED question (one Enter away from a duplicate turn).
      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('')
      // The question shows exactly once, in the transcript — no duplicate vector anywhere.
      expect(screen.getAllByText('quantum question')).toHaveLength(1)
      // The refresh failure itself still surfaces (never silent).
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/list failed after send/)
    } finally {
      vi.useRealTimers()
    }
  })
})

// full-audit 2026-07-11 CODE-39 (ChatScreen fold): the busy banner's "Cancel document task" button
// had an explicit `.catch(() => undefined)` — a REJECTED cancel left the banner up with zero
// feedback. The failure now lands on the same banner.
describe('ChatScreen — rejected banner cancel surfaces (CODE-39)', () => {
  it('shows the cancel failure instead of swallowing it', async () => {
    vi.useFakeTimers()
    try {
      const sendChatMessage = vi.fn(async () => {
        throw new Error(DOC_TASK_BUSY_MESSAGE)
      })
      const cancelDocTask = vi.fn(async () => {
        throw new Error("Error invoking remote method 'docs:cancelTask': Error: cancel exploded")
      })
      baseStub({ listMessages: vi.fn(async () => []), sendChatMessage, cancelDocTask })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'q' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/document task/i)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel document task' }))
      await flush()

      // TEETH: with the old no-op catch the banner keeps the busy copy and the failure vanishes.
      expect(cancelDocTask).toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/cancel exploded/)
    } finally {
      vi.useRealTimers()
    }
  })
})

// RD-1 (full-audit 2026-07-10): on the FIRST send of a brand-new conversation, the history-load
// effect fires DURING ensureConversation's await — its listMessages reaches main BEFORE the send
// IPC, main answers [], and that [] lands AFTER the optimistic append, wiping the user's bubble
// for the whole first answer (the CR-7 activeIdRef guard passes: it IS the active conversation).
describe('ChatScreen — first send keeps the optimistic bubble (RD-1)', () => {
  it('a history [] that resolves only after the send IPC does not wipe the first user bubble', async () => {
    vi.useFakeTimers()
    try {
      // The exact production interleave, made deterministic: the history read parks until the
      // send IPC has been invoked, then answers [] — so without the guard the [] always lands
      // after the optimistic append. The send itself stays in flight (a streaming first answer).
      let openHistoryGate: (() => void) | null = null
      const historyGate = new Promise<void>((res) => {
        openHistoryGate = res
      })
      const listMessages = vi.fn(async (): Promise<Message[]> => {
        await historyGate
        return []
      })
      const sendChatMessage = vi.fn(() => {
        openHistoryGate?.()
        return new Promise<Message>(() => {})
      })
      const created: Conversation[] = []
      baseStub({
        listConversations: vi.fn(async () => created),
        createConversation: vi.fn(async () => {
          const conv = chatConv('c-new', 'New chat')
          created.push(conv)
          return conv
        }),
        listMessages,
        sendChatMessage
      })

      renderChat()
      await flush()

      // No conversation selected — the send goes through ensureConversation (the racy path).
      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'first question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // Teeth: the send is in flight and every parked microtask has settled — without the guard
      // the gated [] has already replaced the transcript and the bubble is gone.
      expect(sendChatMessage).toHaveBeenCalled()
      expect(screen.getByText('first question')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ChatScreen — transcript scroll resets on conversation switch (CR-2)', () => {
  it('re-pins to the bottom of the newly selected conversation even after the user scrolled up in the previous one', async () => {
    vi.useFakeTimers()
    try {
      const scrollTo = vi.fn()
      Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value: scrollTo
      })
      // Per-conversation histories so switching changes the content the transcript scrolls.
      const byConv: Record<string, Message[]> = {
        c1: [userMsg('a1', 'c1', 'A first'), userMsg('a2', 'c1', 'A second')],
        c2: [userMsg('b1', 'c2', 'B only')]
      }
      baseStub({
        listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1'), chatConv('c2', 'Chat 2')]),
        listMessages: vi.fn(async (id: string) => byConv[id] ?? [])
      })

      renderChat()
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()
      expect(screen.getByText('A second')).toBeInTheDocument()

      // The user scrolls UP in A: the transcript's onScroll flips atBottomRef to false, so a plain
      // messages-change would no longer auto-scroll (this is the state the old shared-instance bug got
      // stuck in across a switch).
      const transcript = document.querySelector('.chat-transcript') as HTMLElement
      Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1000 })
      Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 200 })
      transcript.scrollTop = 0 // 1000 - 0 - 200 = 800px from bottom → not pinned
      fireEvent.scroll(transcript)

      const afterScrollUp = scrollTo.mock.calls.length

      // Switch to B: keying the Transcript on activeId REMOUNTS it, resetting atBottomRef to true so the
      // fresh mount scroll effect pins B to the bottom. Teeth: remove the key → the reused instance keeps
      // A's atBottomRef=false, so the scroll effect does NOT re-pin and B opens at A's stale offset.
      fireEvent.click(screen.getByText('Chat 2'))
      await flush()
      expect(screen.getByText('B only')).toBeInTheDocument()
      expect(scrollTo.mock.calls.length).toBeGreaterThan(afterScrollUp)
    } finally {
      vi.useRealTimers()
    }
  })
})
