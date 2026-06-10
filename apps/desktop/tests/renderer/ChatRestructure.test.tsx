// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen, LIST_COLLAPSED_KEY } from '../../src/renderer/screens/ChatScreen'
import { groupConversations } from '../../src/renderer/chat'
import { ToastProvider } from '../../src/renderer/components'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 25 (guidelines §3) structural tests: the teaching empty state, the header
// mode segmented control, conversation-list collapse persistence (localStorage),
// per-message hover actions (Try again / Copy / Save → toasts), the header "⋯"
// overflow ("Save this conversation"), and date grouping of the conversation list.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'My first chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    ...over
  }
}

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'answer',
    createdAt: '2026-01-01T00:00:00Z',
    tokenCount: null,
    ...over
  }
}

function indexedDoc(id: string, title: string) {
  return {
    id,
    title,
    originalPath: null,
    mimeType: 'text/plain',
    sizeBytes: 10,
    status: 'indexed' as const,
    errorMessage: null,
    chunkCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
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

describe('ChatScreen — teaching empty state (guidelines §3)', () => {
  it('shows example prompt chips that fill the composer', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => [indexedDoc('d1', 'contract.pdf')])
    })
    render(<ChatScreen onNavigate={() => {}} />)

    expect(
      await screen.findByText('Ask a question, or ask about your documents.')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Summarize this contract' }))
    expect(screen.getByPlaceholderText(/message private ai drive/i)).toHaveValue(
      'Summarize this contract'
    )
  })

  it('nudges toward Documents when nothing is imported yet', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => [])
    })
    render(<ChatScreen onNavigate={onNavigate} />)

    await user.click(
      await screen.findByRole('button', { name: /add documents to ask about them/i })
    )
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })

  it('hides the nudge once indexed documents exist', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => [indexedDoc('d1', 'contract.pdf')])
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await screen.findByText('Ask a question, or ask about your documents.')
    expect(
      screen.queryByRole('button', { name: /add documents to ask about them/i })
    ).not.toBeInTheDocument()
  })
})

describe('ChatScreen — header mode segmented control', () => {
  it('is a radiogroup and switches the composer mode', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} />)

    const group = await screen.findByRole('radiogroup', { name: 'Chat mode' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Chat' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Ask my documents' }))
    expect(screen.getByPlaceholderText(/ask about your documents/i)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Ask my documents' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Chat' }))
    expect(screen.getByPlaceholderText(/message private ai drive/i)).toBeInTheDocument()
  })
})

describe('ChatScreen — conversation-list collapse persistence', () => {
  it('collapses, remembers the choice in localStorage, and restores on remount', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    const { unmount } = render(<ChatScreen onNavigate={() => {}} />)

    await screen.findByText('My first chat')
    await user.click(screen.getByRole('button', { name: 'Hide conversation list' }))
    expect(screen.queryByText('My first chat')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(LIST_COLLAPSED_KEY)).toBe('1')
    unmount()

    // A fresh mount starts collapsed; expanding persists the new preference.
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Show conversation list' })).toBeInTheDocument()
    expect(screen.queryByText('My first chat')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show conversation list' }))
    expect(await screen.findByText('My first chat')).toBeInTheDocument()
    expect(window.localStorage.getItem(LIST_COLLAPSED_KEY)).toBe('0')
  })
})

describe('ChatScreen — per-message actions (Try again · Copy · Save)', () => {
  function renderWithMessages() {
    const sendChatMessage = vi.fn(async () => msg({ content: 'regenerated' }))
    const exportConversation = vi.fn(async () => 'D:\\out\\chat.md')
    stubApi({
      listConversations: vi.fn(async () => [conv()]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [
        msg({ id: 'u1', role: 'user', content: 'question' }),
        msg({ id: 'a1', content: 'first answer' }),
        msg({ id: 'u2', role: 'user', content: 'follow-up' }),
        msg({ id: 'a2', content: 'second answer' })
      ]),
      sendChatMessage,
      exportConversation,
      onToken: vi.fn(() => () => {}),
      onReasoning: vi.fn(() => () => {})
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    return { sendChatMessage, exportConversation }
  }

  it('copies an answer and confirms with a toast', async () => {
    const user = userEvent.setup()
    renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(await window.navigator.clipboard.readText()).toBe('first answer')
  })

  it('offers Try again only on the last assistant answer and regenerates', async () => {
    const user = userEvent.setup()
    const { sendChatMessage } = renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    const tryAgain = screen.getAllByRole('button', { name: /try again/i })
    expect(tryAgain).toHaveLength(1)
    await user.click(tryAgain[0])
    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', '', { mode: 'balanced', regenerate: true })
    )
  })

  it('saves the conversation from a message row and confirms with a toast', async () => {
    const user = userEvent.setup()
    const { exportConversation } = renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    await user.click(screen.getAllByRole('button', { name: 'Save' })[0])
    await waitFor(() => expect(exportConversation).toHaveBeenCalledWith('c1'))
    expect(await screen.findByText(/saved to/i)).toBeInTheDocument()
  })

  it('saves via the header "⋯" overflow menu (Save this conversation)', async () => {
    const user = userEvent.setup()
    const { exportConversation } = renderWithMessages()
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('second answer')

    await user.click(screen.getByRole('button', { name: 'Conversation options' }))
    await user.click(await screen.findByRole('menuitem', { name: /save this conversation/i }))
    await waitFor(() => expect(exportConversation).toHaveBeenCalledWith('c1'))
    expect(await screen.findByText(/saved to/i)).toBeInTheDocument()
  })
})

describe('groupConversations — date grouping', () => {
  it('buckets by recency relative to "now" and drops empty groups', () => {
    const now = new Date('2026-06-10T12:00:00')
    const c = (id: string, updatedAt: string) => conv({ id, title: id, updatedAt })
    const groups = groupConversations(
      [
        c('today', '2026-06-10T08:00:00'),
        c('yesterday', '2026-06-09T23:00:00'),
        c('thisweek', '2026-06-05T10:00:00'),
        c('old', '2026-01-01T00:00:00'),
        c('junk', 'not-a-date')
      ],
      now
    )
    expect(groups.map((g) => [g.label, g.conversations.map((x) => x.id)])).toEqual([
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      ['Last 7 days', ['thisweek']],
      ['Earlier', ['old', 'junk']]
    ])
  })
})
