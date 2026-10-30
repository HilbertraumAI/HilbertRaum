// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Message } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { runtimeStatus } from '../helpers/status'
import { assistantMsg, makeConversation } from '../helpers/chat-fixtures'
import { chatScreenStubs, deferred, fakeChatStream, renderChatScreen } from '../helpers/chat-screen'

// Answer-depth tests (Phase 20 contracts under the Phase 25 UI): the composer-footer
// "Answer detail" dropdown — labels are Quick/Balanced/Thorough (decision D-UI4) while
// the ids sent over IPC stay fast|balanced|deep; Thorough is offered only when the
// running model declares thinking support; the selection travels with sendChatMessage
// and sticks per conversation; and Deep-mode reasoning renders as a "Thinking…" line on
// the live bubble only (never persisted), auto-collapsing when the first answer token
// streams (the disclosure DOM itself: TranscriptA11y).

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

/** The composer-footer dropdown trigger, e.g. "Answer detail: Balanced ▾". */
function depthTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /answer detail/i })
}

describe('ChatScreen — "Answer detail" dropdown (Phase 20 / D-UI4)', () => {
  it('offers Thorough only when the running model supports thinking', async () => {
    const user = userEvent.setup()
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Depth chat' })]),
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ supportsThinkingMode: true }))
      })
    )
    const { unmount } = renderChatScreen()
    await screen.findByText('Depth chat')
    await user.click(depthTrigger())
    expect(await screen.findByRole('menuitemradio', { name: /quick/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /balanced/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /thorough/i })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    unmount()

    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Depth chat' })]),
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ supportsThinkingMode: false }))
      })
    )
    renderChatScreen()
    await screen.findByText('Depth chat')
    await user.click(depthTrigger())
    expect(await screen.findByRole('menuitemradio', { name: /quick/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /thorough/i })).not.toBeInTheDocument()
  })

  it('hides the dropdown in Ask-my-documents mode (document answers stay balanced)', async () => {
    stubApi(chatScreenStubs({ getRuntimeStatus: vi.fn(async () => runtimeStatus({ supportsThinkingMode: true })) }))
    renderChatScreen({ initialMode: 'documents' })
    await screen.findByPlaceholderText(/ask about your documents/i)
    expect(screen.queryByRole('button', { name: /answer detail/i })).not.toBeInTheDocument()
  })

  it('sends the selected depth id with the message and defaults to balanced', async () => {
    const user = userEvent.setup()
    const sendChatMessage = vi.fn(async () => assistantMsg('a1', 'ok'))
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Depth chat' })]),
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ supportsThinkingMode: true })),
        sendChatMessage
      })
    )
    renderChatScreen()
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
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [
          makeConversation({ title: 'Depth chat' }),
          makeConversation({ id: 'c2', title: 'Other chat' })
        ]),
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ supportsThinkingMode: true }))
      })
    )
    renderChatScreen()

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
    const stream = fakeChatStream()
    const send = deferred<Message>()
    const sendChatMessage = vi.fn(() => send.promise)
    const listMessages = vi
      .fn<() => Promise<Message[]>>()
      .mockResolvedValue([]) // until the stream completes
    stubApi(
      chatScreenStubs({
        ...stream.stubs,
        listConversations: vi.fn(async () => [makeConversation({ title: 'Depth chat' })]),
        listMessages,
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ supportsThinkingMode: true })),
        sendChatMessage
      })
    )
    renderChatScreen()
    await user.click(await screen.findByText('Depth chat'))
    await user.click(depthTrigger())
    await user.click(await screen.findByRole('menuitemradio', { name: /thorough/i }))
    await user.type(screen.getByPlaceholderText("Message…"), 'why?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(stream.subscribed()).toBe(true))
    // Thorough sends the 'deep' id (no other row pins it; the row above pins fast + balanced).
    expect(sendChatMessage).toHaveBeenCalledWith('c1', 'why?', { mode: 'deep' })

    // Reasoning deltas are buffered, then flushed together onto the live bubble's Thinking… line.
    stream.reasoning('step one, ')
    stream.reasoning('step two')
    const toggle = await screen.findByRole('button', { name: 'Thinking…' })
    expect(await screen.findByText('step one, step two')).toBeInTheDocument()

    // Expanding, then receiving the first answer token, auto-collapses the line (§3).
    await user.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'))
    stream.token('The answer.')
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'))

    // Stream completes → the transcript re-reads persisted history, which carries the
    // answer only (D6) — the live Thinking line is gone.
    listMessages.mockResolvedValue([assistantMsg('a1', 'The answer.')])
    await act(async () => send.resolve(assistantMsg('a1', 'The answer.')))
    await waitFor(() => expect(screen.queryByText('Thinking…')).not.toBeInTheDocument())
    expect(screen.getByText('The answer.')).toBeInTheDocument()
  })
})
