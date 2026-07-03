// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import type { CompactionNotice } from '../../src/shared/ipc'
import { stubApi } from '../helpers/renderer'

// Phase 2 UX (context-compaction plan §5.1–§5.3): the composer context-usage meter, the transcript
// summary marker, and the one-shot "summarizing…" notice that clears on the first answer token.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Compaction chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null,
    ...over
  }
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok', ...over }
}

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, conversationId: 'c1', role, content, createdAt: '2026-01-01T00:00:01Z', tokenCount: null }
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
  window.localStorage.clear()
})

describe('ChatScreen — context-usage meter (§5.1)', () => {
  it('renders the meter from getConversationContextUsage with the amber will-summarize tooltip', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status()),
      // 6.4k / 8k = 80% ⇒ amber band ⇒ the heads-up line is appended.
      getConversationContextUsage: vi.fn(async () => ({ usedTokens: 6400, window: 8000 }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Compaction chat'))

    const meter = await screen.findByRole('progressbar')
    expect(meter).toHaveAttribute('aria-valuenow', '80')
    const tip = meter.getAttribute('title') ?? ''
    expect(tip).toMatch(/6\.4k \/ 8k tokens/)
    expect(tip).toMatch(/approximate/i)
    expect(tip).toMatch(/will be summarized/i)
  })
})

describe('ChatScreen — transcript summary marker (§5.3, D-b)', () => {
  it('renders the marker before the boundary message and expands to the summary text', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages: vi.fn(async () => [msg('m1', 'user', 'question one'), msg('m2', 'assistant', 'answer one')]),
      getRuntimeStatus: vi.fn(async () => status()),
      getConversationSummary: vi.fn(async () => ({ summary: 'SUMMARYBODY goal and facts', beforeMessageId: 'm2' }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Compaction chat'))

    const toggle = await screen.findByRole('button', { name: /earlier messages summarized/i })
    expect(screen.queryByText(/SUMMARYBODY/)).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByText(/SUMMARYBODY/)).toBeInTheDocument()
  })
})

describe('ChatScreen — "summarizing…" notice (§5.2)', () => {
  it('shows on the compaction notice and clears on the first answer token', async () => {
    const user = userEvent.setup()
    let tokenCb: ((t: string) => void) | undefined
    let compactionCb: ((notice: CompactionNotice) => void) | undefined
    let resolveSend: (() => void) | undefined
    const sendChatMessage = vi.fn(
      () =>
        new Promise<Message>((resolve) => {
          resolveSend = () => resolve(msg('a9', 'assistant', 'done'))
        })
    )
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status()),
      sendChatMessage,
      onToken: vi.fn((_id: string, cb: (t: string) => void) => {
        tokenCb = cb
        return () => {}
      }),
      onReasoning: vi.fn(() => () => {}),
      onScopeNotice: vi.fn(() => () => {}),
      onCompaction: vi.fn((_id: string, cb: (notice: CompactionNotice) => void) => {
        compactionCb = cb
        return () => {}
      })
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Compaction chat'))
    await user.type(screen.getByPlaceholderText('Message…'), 'hi')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // The stream is in flight (sendChatMessage pending) and the subscriptions are registered.
    await waitFor(() => expect(compactionCb).toBeTypeOf('function'))
    act(() => compactionCb!({ phase: 'start' }))
    expect(await screen.findByText(/summarizing earlier messages/i)).toBeInTheDocument()

    // The first answer token clears the notice.
    act(() => tokenCb!('hello'))
    await waitFor(() =>
      expect(screen.queryByText(/summarizing earlier messages/i)).not.toBeInTheDocument()
    )

    act(() => resolveSend!())
  })

  // U5 (audit §3.6): the SAME ephemeral channel carries an 'analysis' notice when an exhaustive skill
  // handler starts a long, silent extraction — shown with honest "reading the document…" copy (NOT the
  // compaction "summarizing…" line), and cleared on the first answer token exactly the same way.
  it("shows the 'analysis' notice (reading the document…) and clears it on the first token", async () => {
    const user = userEvent.setup()
    let tokenCb: ((t: string) => void) | undefined
    let compactionCb: ((notice: CompactionNotice) => void) | undefined
    let resolveSend: (() => void) | undefined
    const sendChatMessage = vi.fn(
      () =>
        new Promise<Message>((resolve) => {
          resolveSend = () => resolve(msg('a9', 'assistant', 'done'))
        })
    )
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status()),
      sendChatMessage,
      onToken: vi.fn((_id: string, cb: (t: string) => void) => {
        tokenCb = cb
        return () => {}
      }),
      onReasoning: vi.fn(() => () => {}),
      onScopeNotice: vi.fn(() => () => {}),
      onCompaction: vi.fn((_id: string, cb: (notice: CompactionNotice) => void) => {
        compactionCb = cb
        return () => {}
      })
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Compaction chat'))
    await user.type(screen.getByPlaceholderText('Message…'), 'summarize my statement')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(compactionCb).toBeTypeOf('function'))
    act(() => compactionCb!({ phase: 'start', kind: 'analysis' }))
    // The analysis copy shows — NOT the compaction "summarizing…" line.
    expect(await screen.findByText(/reading the whole document/i)).toBeInTheDocument()
    expect(screen.queryByText(/summarizing earlier messages/i)).not.toBeInTheDocument()

    // The first answer token clears it.
    act(() => tokenCb!('hello'))
    await waitFor(() => expect(screen.queryByText(/reading the whole document/i)).not.toBeInTheDocument())

    act(() => resolveSend!())
  })
})
