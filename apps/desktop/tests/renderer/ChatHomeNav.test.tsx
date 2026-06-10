// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer tests for the post-MVP polish round: deleting conversations from the chat
// sidebar (with confirm), opening the Chat screen directly in documents mode, and the
// Home screen's "Ask My Documents" navigating to the document-Q&A chat instead of the
// import screen (the original bug: both buttons went to 'documents').

function conv(over: Partial<Conversation>): Conversation {
  return {
    id: 'c1',
    title: 'My first chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
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

// jsdom implements neither element scrolling nor scrollTo; the transcript autoscroll
// effect would crash every ChatScreen render without this stub.
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

describe('ChatScreen — delete conversation', () => {
  it('deletes after confirm and refreshes the sidebar', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const listConversations = vi
      .fn<() => Promise<Conversation[]>>()
      .mockResolvedValueOnce([conv({})]) // initial mount
      .mockResolvedValue([]) // after delete
    const deleteConversation = vi.fn(async () => {})
    stubApi({
      listConversations,
      deleteConversation,
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} />)

    await screen.findByText('My first chat')
    await user.click(screen.getByRole('button', { name: /delete conversation "My first chat"/i }))

    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(screen.queryByText('My first chat')).not.toBeInTheDocument())
  })

  it('does nothing when the confirm dialog is declined', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const deleteConversation = vi.fn(async () => {})
    stubApi({
      listConversations: vi.fn(async () => [conv({})]),
      deleteConversation,
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} />)

    await screen.findByText('My first chat')
    await user.click(screen.getByRole('button', { name: /delete conversation/i }))
    expect(deleteConversation).not.toHaveBeenCalled()
    expect(screen.getByText('My first chat')).toBeInTheDocument()
  })
})

describe('ChatScreen — markdown rendering', () => {
  function msg(over: Partial<Message>): Message {
    return {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      content: '',
      createdAt: '2026-01-01T00:00:00Z',
      tokenCount: null,
      ...over
    }
  }

  it('renders assistant markdown (e.g. **bold**) as formatting, not raw asterisks', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv({})]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [
        msg({ content: 'Total for **Invoice 42** is due.\n\n- item one\n- item two' })
      ])
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('My first chat'))

    const bold = await screen.findByText('Invoice 42')
    expect(bold.tagName).toBe('STRONG')
    expect(screen.getByRole('list')).toBeInTheDocument() // the markdown bullet list
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument()
  })

  it('renders raw HTML in model output as literal text (no injection)', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv({})]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [msg({ content: 'hi <img src=x onerror=alert(1)> there' })])
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText(/hi/)
    expect(document.querySelector('.msg-content img')).toBeNull()
  })

  it('leaves user messages as plain text (asterisks intact)', async () => {
    const user = userEvent.setup()
    stubApi({
      listConversations: vi.fn(async () => [conv({})]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [msg({ id: 'u1', role: 'user', content: 'what is **this**?' })])
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('My first chat'))
    expect(await screen.findByText('what is **this**?')).toBeInTheDocument()
  })
})

describe('ChatScreen — initial mode', () => {
  it('opens in documents mode when initialMode="documents"', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} initialMode="documents" />)
    expect(await screen.findByPlaceholderText(/ask about your documents/i)).toBeInTheDocument()
  })

  it('defaults to plain chat mode', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByPlaceholderText(/message private ai drive/i)).toBeInTheDocument()
  })
})

describe('HomeScreen — quick actions', () => {
  function renderHome(onNavigate: (s: string) => void): void {
    stubApi({
      getAppStatus: vi.fn(async () => ({
        appName: 'x',
        appVersion: '0',
        offlineMode: true,
        networkAllowed: false,
        activeModelId: null,
        hardwareProfile: 'UNKNOWN' as const,
        workspaceMode: 'plaintext_dev' as const,
        workspaceReady: true
      })),
      runPreflight: vi.fn(async () => ({
        ok: true,
        rootPath: '/drive',
        writable: true,
        freeBytes: 1024 * 1024 * 1024,
        slowDriveWarning: null,
        problems: []
      }))
    })
    render(<HomeScreen onNavigate={onNavigate} />)
  }

  it('"Ask My Documents" opens the documents chat, not the import screen', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderHome(onNavigate)
    await user.click(screen.getByRole('button', { name: /ask my documents/i }))
    expect(onNavigate).toHaveBeenCalledWith('ask-documents')
  })

  it('"Import Documents" still opens the documents screen', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderHome(onNavigate)
    await user.click(screen.getByRole('button', { name: /import documents/i }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })
})
