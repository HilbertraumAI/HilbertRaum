// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type {
  ActiveStreamSnapshot,
  Conversation,
  Message,
  RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// T-1 (audit chat-docs-2026-07-07): the renderer STREAM-RECOVERY flow — the user sent a message,
// navigated away (unmounting the screen + its token listeners), and came back while the model is
// still responding — was completely untested on the renderer side. It is the most intricate effect
// in ChatScreen. These tests drive it end-to-end (jsdom + fake timers) and fold in the CR-4
// recovered-stop toast and the CR-5 conversation-mode-authoritative send branch, each with teeth.

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

function docConv(id: string, title: string): Conversation {
  return {
    ...chatConv(id, title),
    mode: 'documents',
    // An explicit (docs-only) scope so nothing raises the D71 narrow/widen dialog.
    scope: { collectionIds: [], documentIds: [] }
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

/** Flush microtasks (awaited IPC) + zero-delay timers under fake timers. */
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

      stubApi({
        listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1')]),
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages,
        listDocuments: vi.fn(async () => []),
        listCollections: vi.fn(async () => []),
        listAttachments: vi.fn(async () => []),
        listActiveStreamConversations: vi.fn(async () => []),
        getActiveStream,
        stopGeneration
      })

      renderChat()
      await flush() // mount: runtime + conversation list

      // Select c1 → the recovery effect polls getActiveStream and finds the in-flight reply.
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()

      // Live recovered bubble + locked composer (Stop replaces Send; Enter is inert while streaming).
      expect(screen.getByText('partial answer')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

      // CR-4: click Stop on the RECOVERED stream — the recovered path has no local stream() finally,
      // so the completed tick below is the only place that can confirm the stop.
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(stopGeneration).toHaveBeenCalledWith('c1')

      // The generation finishes: the snapshot goes null and the persisted final reply is available.
      history = [userMsg('u1', 'c1', 'hello'), assistantMsg('a1', 'c1', 'the final answer')]
      liveSnap = null
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300) // one recovery poll
      })
      await flush()

      // Completion: the persisted reply replaced the live bubble and Stop→Send.
      expect(screen.getByText('the final answer')).toBeInTheDocument()
      expect(screen.queryByText('partial answer')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
      // CR-4 teeth: without the recovered-stop branch this toast never appears (a recovered stop
      // would look like a normal complete turn — the M-U2 gap).
      expect(screen.getByText(/Stopped/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-re-selects the streaming conversation on a fresh mount and mirrors its (documents) mode', async () => {
    vi.useFakeTimers()
    try {
      const getActiveStream = vi.fn(async (_id: string) => ({ content: 'partial answer', reasoning: '' }))
      stubApi({
        listConversations: vi.fn(async () => [docConv('c1', 'Doc chat 1')]),
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages: vi.fn(async () => []),
        listDocuments: vi.fn(async () => []),
        listCollections: vi.fn(async () => []),
        listAttachments: vi.fn(async () => []),
        // A generation is in flight for c1 even though the fresh mount forgot which conversation it was.
        listActiveStreamConversations: vi.fn(async () => ['c1']),
        getActiveStream
      })

      renderChat()
      await flush()

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
        return [docConv('c1', 'Doc chat 1')]
      })
      // Nothing actually in flight → no recovery lock, so the composer is free to send.
      const getActiveStream = vi.fn(async (_id: string) => null)
      const askDocuments = vi.fn(async () => undefined as unknown as Message)
      const sendChatMessage = vi.fn(async () => undefined as unknown as Message)

      stubApi({
        listConversations,
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages: vi.fn(async () => []),
        listDocuments: vi.fn(async () => []),
        listCollections: vi.fn(async () => []),
        listAttachments: vi.fn(async () => []),
        listActiveStreamConversations: vi.fn(async () => ['c1']),
        getActiveStream,
        askDocuments,
        sendChatMessage,
        onToken: vi.fn(() => () => {}),
        onReasoning: vi.fn(() => () => {}),
        onScopeNotice: vi.fn(() => () => {})
      })

      renderChat()
      await flush()

      // The screen mode stayed 'chat' (the re-select fetch failed to mirror it) — the CHAT placeholder,
      // not the documents one — proving the divergence the CR-5 branch must survive.
      const box = screen.getByPlaceholderText('Message…')
      fireEvent.change(box, { target: { value: 'the question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // CR-5 teeth: the send branches on the CONVERSATION's own (documents) mode, not the screen mode.
      // Revert `stream` to the `mode`-state branch → sendChatMessage fires here instead.
      expect(askDocuments).toHaveBeenCalledWith('c1', 'the question', undefined, false, undefined)
      expect(sendChatMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not yank the user off a conversation they hand-picked while the re-select is resolving', async () => {
    vi.useFakeTimers()
    try {
      // Park the active-stream lookup so the user can click a different conversation mid-flight.
      let releaseList: ((ids: string[]) => void) | null = null
      const listActiveStreamConversations = vi.fn(
        () =>
          new Promise<string[]>((res) => {
            releaseList = res
          })
      )
      const getActiveStream = vi.fn(async (_id: string) => null)

      stubApi({
        listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1'), chatConv('c2', 'Chat 2')]),
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages: vi.fn(async () => []),
        listDocuments: vi.fn(async () => []),
        listCollections: vi.fn(async () => []),
        listAttachments: vi.fn(async () => []),
        listActiveStreamConversations,
        getActiveStream
      })

      renderChat()
      await flush()
      expect(releaseList).not.toBeNull()

      // The user hand-picks c2 before the re-select (which would land on c1) resolves.
      fireEvent.click(screen.getByText('Chat 2'))
      await flush()

      // Now the parked lookup resolves, naming c1 as the streaming conversation.
      await act(async () => {
        releaseList!(['c1'])
      })
      await flush()

      // Teeth: the `activeIdRef.current != null` guards keep the user on c2 — the recovery effect only
      // ever polls c2. Remove the guard and the re-select stamps activeId back to c1 (→ getActiveStream('c1')).
      expect(getActiveStream).toHaveBeenCalledWith('c2')
      expect(getActiveStream).not.toHaveBeenCalledWith('c1')
    } finally {
      vi.useRealTimers()
    }
  })
})
