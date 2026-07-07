// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// T-2 (audit chat-docs-2026-07-07): assert the invariant that keeps CR-9 safe. `onStop` targets
// `streamConvId ?? activeId`, byte-equivalent to the old `activeId` today ONLY because the user can
// never be viewing a different conversation than the streaming one while the Composer's Stop renders:
// ConversationList disables every non-active row while streaming (`disabled={streaming && !active}`,
// fed `streaming={busyStreaming}`). This test pins that disabled-row invariant AND that Stop aborts
// the streaming conversation. Reachability pointer: if a future change ever enables mid-stream
// switching, this disabled-row assertion reddens first — the signal to re-check `onStop`'s target.

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

/** The row <button> for a conversation title (not the ⋯ menu button). */
function convRowButton(title: string): HTMLButtonElement {
  const el = screen.getByText(title).closest('button.chat-conv')
  if (!el) throw new Error(`no row button for ${title}`)
  return el as HTMLButtonElement
}

describe('ChatScreen — mid-stream switch is blocked; Stop targets the streaming conversation (T-2)', () => {
  it('disables the non-active conversation row while c1 streams, and Stop aborts c1', async () => {
    vi.useFakeTimers()
    try {
      // The send PARKS so the stream stays in flight (Composer shows Stop; the list locks).
      const sendChatMessage = vi.fn(() => new Promise<Message>(() => {}))
      const stopGeneration = vi.fn(async () => {})

      stubApi({
        listConversations: vi.fn(async () => [chatConv('c1', 'Chat 1'), chatConv('c2', 'Chat 2')]),
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages: vi.fn(async () => []),
        listDocuments: vi.fn(async () => []),
        listCollections: vi.fn(async () => []),
        listAttachments: vi.fn(async () => []),
        listActiveStreamConversations: vi.fn(async () => []),
        getActiveStream: vi.fn(async () => null),
        sendChatMessage,
        stopGeneration,
        onToken: vi.fn(() => () => {}),
        onReasoning: vi.fn(() => () => {}),
        onScopeNotice: vi.fn(() => () => {})
      })

      render(
        <ToastProvider>
          <ChatScreen onNavigate={() => {}} />
        </ToastProvider>
      )
      await flush()

      // Select c1 and start a local stream.
      fireEvent.click(screen.getByText('Chat 1'))
      await flush()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'hi there' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flush()

      // Streaming: the Composer shows Stop; the active row (c1) stays clickable, the other (c2) is
      // disabled — the user cannot switch away from the streaming conversation. This is the reachability
      // guarantee behind CR-9: `streamConvId === activeId` in every state Stop can render.
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
      expect(convRowButton('Chat 2').disabled).toBe(true)
      expect(convRowButton('Chat 1').disabled).toBe(false)

      // Stop aborts the STREAMING conversation (streamConvId ?? activeId === 'c1').
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(stopGeneration).toHaveBeenCalledWith('c1')
    } finally {
      vi.useRealTimers()
    }
  })
})
