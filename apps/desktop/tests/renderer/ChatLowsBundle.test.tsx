// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import { STREAM_RECOVER_FAILURE_BUDGET, STREAM_RECOVER_POLL_MS } from '../../src/renderer/lib/polling'
import type {
  ActiveStreamSnapshot,
  Conversation,
  Message,
  RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Frontend audit 2026-08-09, #148 — the chat Low bundle's behavioral teeth:
//   CH-4  — one transient getActiveStream rejection must NOT be read as "stream finished"
//   CH-14 — a double Enter during ensureConversation's round trips must not mint two conversations
//   CH-5  — a refused clipboard write gives feedback instead of silence

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

/** Flush microtasks (awaited IPC) + zero-delay timers under fake timers. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
  })
}

const unsub = (): (() => void) => () => {}

describe('ChatScreen — recovery poll failure budget (CH-4, #148)', () => {
  it('keeps the recovered bubble over a transient IPC failure; only a sustained one finishes', async () => {
    vi.useFakeTimers()
    try {
      // snapshot → one rejection (transient) → snapshot again → then sustained rejections.
      let mode: 'live' | 'reject' = 'live'
      const snap: ActiveStreamSnapshot = { content: 'partial answer', reasoning: '' }
      const getActiveStream = vi.fn(async (_id: string) => {
        if (mode === 'reject') throw new Error('ipc hiccup')
        return snap
      })
      stubApi({
        listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1')]),
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages: vi.fn(async () => [] as Message[]),
        listDocuments: vi.fn(async () => []),
        listCollections: vi.fn(async () => []),
        listAttachments: vi.fn(async () => []),
        listActiveStreamConversations: vi.fn(async () => []),
        getActiveStream
      })
      render(
        <ToastProvider>
          <ChatScreen onNavigate={() => {}} />
        </ToastProvider>
      )
      await flush()
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()
      expect(screen.getByText('partial answer')).toBeInTheDocument()

      // ONE failing tick: pre-fix this cleared the live bubble, unlocked the composer, and
      // permanently detached the poll. Now the bubble must survive.
      mode = 'reject'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STREAM_RECOVER_POLL_MS)
      })
      mode = 'live'
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      // …and the poll is still attached (the next tick refreshes from the snapshot again).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STREAM_RECOVER_POLL_MS)
      })
      expect(screen.getByText('partial answer')).toBeInTheDocument()

      // A SUSTAINED failure (>= budget consecutive rejections) falls back to best-effort
      // finish so the composer is never wedged.
      mode = 'reject'
      await act(async () => {
        for (let i = 0; i <= STREAM_RECOVER_FAILURE_BUDGET; i++) {
          await vi.advanceTimersByTimeAsync(STREAM_RECOVER_POLL_MS)
        }
      })
      expect(screen.queryByText('partial answer')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ChatScreen — double-submit guard (CH-14, #148)', () => {
  it('a second Enter during ensureConversation creates NO duplicate conversation', async () => {
    const created = chatConv('c1', 'New chat')
    let release: (c: Conversation) => void = () => {}
    const createConversation = vi.fn(
      () =>
        new Promise<Conversation>((resolve) => {
          release = resolve
        })
    )
    const sendChatMessage = vi.fn(async () => {})
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [] as Message[]),
      listDocuments: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      createConversation,
      sendChatMessage,
      onToken: vi.fn(unsub),
      onReasoning: vi.fn(unsub),
      onScopeNotice: vi.fn(unsub),
      onCompaction: vi.fn(unsub)
    })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await user.type(await screen.findByRole('textbox'), 'hello')
    const send = screen.getByRole('button', { name: /^send$/i })
    // Both submits land while createConversation is still in flight — the pre-fix window
    // where `busyStreaming` had not flipped yet and a second Enter minted conversation #2.
    await act(async () => {
      fireEvent.click(send)
      fireEvent.click(send)
    })
    release(created)
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1))
    expect(createConversation).toHaveBeenCalledTimes(1)
  })
})

describe('ChatScreen — copy feedback (CH-5, #148)', () => {
  it('a refused clipboard write toasts the failure instead of staying silent', async () => {
    const copyToClipboard = vi.fn(async () => false)
    stubApi({
      listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1')]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [assistantMsg('m1', 'c1', 'The answer.')]),
      listDocuments: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listActiveStreamConversations: vi.fn(async () => []),
      getActiveStream: vi.fn(async () => null),
      copyToClipboard
    })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await user.click(await screen.findByText('Chat 1'))
    await screen.findByText('The answer.')
    await user.click(screen.getByRole('button', { name: /copy/i }))
    expect(copyToClipboard).toHaveBeenCalledWith('The answer.')
    // Pre-fix: `ok === false` fell through silently (and a rejection was unhandled).
    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })
})
