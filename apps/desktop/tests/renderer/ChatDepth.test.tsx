// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 20 renderer tests (plan §8/§11): the composer's answer-depth selector —
// Deep offered only when the running model declares thinking support, the selected
// depth travels with sendChatMessage and sticks per conversation, and Deep-mode
// reasoning renders as a collapsed "Thinking…" block on the live bubble only.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Depth chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    ...over
  }
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok', ...over }
}

function assistantMsg(content: string): Message {
  return {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    content,
    createdAt: '2026-01-01T00:00:01Z',
    tokenCount: null
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
})

describe('ChatScreen — answer-depth selector (Phase 20)', () => {
  it('offers Deep only when the running model supports thinking', async () => {
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true }))
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Deep' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fast' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Balanced' })).toBeInTheDocument()
  })

  it('hides Deep when the manifest does not declare thinking support', async () => {
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => status()) // no supportsThinkingMode flag
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await screen.findByRole('button', { name: 'Fast' })
    expect(screen.queryByRole('button', { name: 'Deep' })).not.toBeInTheDocument()
  })

  it('hides the selector in Ask Documents mode (document answers stay balanced)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true }))
    })
    render(<ChatScreen onNavigate={() => {}} initialMode="documents" />)
    // The tab's accessible name includes its subtitle — match loosely.
    await screen.findByRole('button', { name: /Ask Documents/ })
    expect(screen.queryByText('Answer depth:')).not.toBeInTheDocument()
  })

  it('sends the selected depth with the message and defaults to balanced', async () => {
    const user = userEvent.setup()
    const sendChatMessage = vi.fn(async () => assistantMsg('ok'))
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true })),
      sendChatMessage,
      onToken: vi.fn(() => () => {}),
      onReasoning: vi.fn(() => () => {})
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Depth chat'))

    // Default: balanced.
    await user.type(screen.getByPlaceholderText(/Message Private AI Drive/), 'first')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', 'first', { mode: 'balanced' })
    )

    // Selecting Fast sticks for this conversation's next message.
    await user.click(screen.getByRole('button', { name: 'Fast' }))
    await user.type(screen.getByPlaceholderText(/Message Private AI Drive/), 'second')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', 'second', { mode: 'fast' })
    )
  })

  it('keeps the depth sticky per conversation', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv(), conv({ id: 'c2', title: 'Other chat' })]),
      listMessages: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true }))
    })
    render(<ChatScreen onNavigate={() => {}} />)

    await user.click(await screen.findByText('Depth chat'))
    await user.click(screen.getByRole('button', { name: 'Fast' }))
    expect(screen.getByRole('button', { name: 'Fast' }).className).toContain('active')

    // The other conversation starts on the balanced default…
    await user.click(screen.getByText('Other chat'))
    expect(screen.getByRole('button', { name: 'Balanced' }).className).toContain('active')

    // …and coming back restores this conversation's choice.
    await user.click(screen.getByText('Depth chat'))
    expect(screen.getByRole('button', { name: 'Fast' }).className).toContain('active')
  })

  it('renders streamed reasoning as a collapsed Thinking… block that is not persisted', async () => {
    const user = userEvent.setup()
    let tokenCb: ((t: string) => void) | undefined
    let reasoningCb: ((d: string) => void) | undefined
    let resolveSend!: (m: Message) => void
    const sendChatMessage = vi.fn(
      () => new Promise<Message>((resolve) => (resolveSend = resolve))
    )
    const listMessages = vi
      .fn<() => Promise<Message[]>>()
      .mockResolvedValue([]) // until the stream completes
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages,
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true })),
      sendChatMessage,
      onToken: vi.fn((_id: string, cb: (t: string) => void) => {
        tokenCb = cb
        return () => {}
      }),
      onReasoning: vi.fn((_id: string, cb: (d: string) => void) => {
        reasoningCb = cb
        return () => {}
      })
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Depth chat'))
    await user.click(screen.getByRole('button', { name: 'Deep' }))
    await user.type(screen.getByPlaceholderText(/Message Private AI Drive/), 'why?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(reasoningCb).toBeDefined())

    // Reasoning deltas appear inside a collapsed <details> block on the live bubble.
    act(() => {
      reasoningCb?.('step one, ')
      reasoningCb?.('step two')
    })
    const summary = await screen.findByText('Thinking…')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false) // collapsed by default
    expect(screen.getByText('step one, step two')).toBeInTheDocument()
    act(() => tokenCb?.('The answer.'))

    // Stream completes → the transcript re-reads persisted history, which carries the
    // answer only (D6) — the live Thinking block is gone.
    listMessages.mockResolvedValue([assistantMsg('The answer.')])
    act(() => resolveSend(assistantMsg('The answer.')))
    await waitFor(() => expect(screen.queryByText('Thinking…')).not.toBeInTheDocument())
    expect(screen.getByText('The answer.')).toBeInTheDocument()
  })
})
