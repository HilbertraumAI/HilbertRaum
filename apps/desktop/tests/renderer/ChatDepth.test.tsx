// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Answer-depth tests (Phase 20 contracts under the Phase 25 UI): the composer-footer
// "Answer detail" dropdown — labels are Quick/Balanced/Thorough (decision D-UI4) while
// the ids sent over IPC stay fast|balanced|deep; Thorough is offered only when the
// running model declares thinking support; the selection travels with sendChatMessage
// and sticks per conversation; and Deep-mode reasoning renders as a collapsed
// "Thinking…" line on the live bubble only (never persisted), auto-collapsing when the
// first answer token streams.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Depth chat',
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
  window.localStorage.clear()
})

/** The composer-footer dropdown trigger, e.g. "Answer detail: Balanced ▾". */
function depthTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /answer detail/i })
}

describe('ChatScreen — "Answer detail" dropdown (Phase 20 / D-UI4)', () => {
  it('offers Thorough only when the running model supports thinking', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true }))
    })
    const { unmount } = render(<ChatScreen onNavigate={() => {}} />)
    await screen.findByText('Depth chat')
    await user.click(depthTrigger())
    expect(await screen.findByRole('menuitemradio', { name: /quick/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /balanced/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /thorough/i })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    unmount()

    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => status()) // no supportsThinkingMode flag
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await screen.findByText('Depth chat')
    await user.click(depthTrigger())
    expect(await screen.findByRole('menuitemradio', { name: /quick/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /thorough/i })).not.toBeInTheDocument()
  })

  it('hides the dropdown in Ask-my-documents mode (document answers stay balanced)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true }))
    })
    render(<ChatScreen onNavigate={() => {}} initialMode="documents" />)
    await screen.findByPlaceholderText(/ask about your documents/i)
    expect(screen.queryByRole('button', { name: /answer detail/i })).not.toBeInTheDocument()
  })

  it('sends the selected depth id with the message and defaults to balanced', async () => {
    const user = userEvent.setup()
    const sendChatMessage = vi.fn(async () => assistantMsg('ok'))
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      listMessages: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status({ supportsThinkingMode: true })),
      sendChatMessage,
      onToken: vi.fn(() => () => {}),
      onReasoning: vi.fn(() => () => {}),
      onScopeNotice: vi.fn(() => () => {})
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Depth chat'))

    // Default: balanced.
    await user.type(screen.getByPlaceholderText("Message…"), 'first')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', 'first', { mode: 'balanced' })
    )

    // Selecting Quick (UI label) sends the 'fast' id and sticks for the next message.
    await user.click(depthTrigger())
    await user.click(await screen.findByRole('menuitemradio', { name: /quick/i }))
    expect(depthTrigger()).toHaveTextContent('Answer detail: Quick')
    await user.type(screen.getByPlaceholderText("Message…"), 'second')
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
    await user.click(depthTrigger())
    await user.click(await screen.findByRole('menuitemradio', { name: /quick/i }))
    expect(depthTrigger()).toHaveTextContent('Answer detail: Quick')

    // The other conversation starts on the balanced default…
    await user.click(screen.getByText('Other chat'))
    expect(depthTrigger()).toHaveTextContent('Answer detail: Balanced')

    // …and coming back restores this conversation's choice.
    await user.click(screen.getByText('Depth chat'))
    expect(depthTrigger()).toHaveTextContent('Answer detail: Quick')
  })

  it('renders streamed reasoning as a collapsed Thinking… line that auto-collapses and is not persisted', async () => {
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
      }),
      onScopeNotice: vi.fn(() => () => {})
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Depth chat'))
    await user.click(depthTrigger())
    await user.click(await screen.findByRole('menuitemradio', { name: /thorough/i }))
    await user.type(screen.getByPlaceholderText("Message…"), 'why?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(reasoningCb).toBeDefined())

    // Reasoning deltas (buffered) appear behind a collapsed disclosure on the live bubble.
    // The disclosure is a <button aria-expanded> (audit L15), not a <details>/<summary>.
    act(() => {
      reasoningCb?.('step one, ')
      reasoningCb?.('step two')
    })
    const toggle = await screen.findByRole('button', { name: 'Thinking…' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false') // collapsed by default
    const reasoning = await screen.findByText('step one, step two')
    expect(reasoning).not.toBeVisible() // mounted (buffering) but hidden while collapsed

    // Expanding, then receiving the first answer token, auto-collapses the line (§3).
    await user.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'))
    act(() => tokenCb?.('The answer.'))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'))

    // Stream completes → the transcript re-reads persisted history, which carries the
    // answer only (D6) — the live Thinking line is gone.
    listMessages.mockResolvedValue([assistantMsg('The answer.')])
    act(() => resolveSend(assistantMsg('The answer.')))
    await waitFor(() => expect(screen.queryByText('Thinking…')).not.toBeInTheDocument())
    expect(screen.getByText('The answer.')).toBeInTheDocument()
  })
})
