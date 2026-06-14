// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import type { Conversation, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer tests for the chat screen's structural behaviors (Phase 25 layout, same
// contracts underneath): deleting conversations through the row "⋯" menu + ConfirmDialog
// (the last browser confirm() is gone), markdown rendering, opening the Chat screen
// directly in documents mode, the documents-scope popover (replaces the scope-chip row),
// and the Home screen's "Ask My Documents" navigating to the document-Q&A chat.

function conv(over: Partial<Conversation>): Conversation {
  return {
    id: 'c1',
    title: 'My first chat',
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
  window.localStorage.clear()
})

/** Open conversation-row "⋯" menu → "Delete conversation" → the confirm dialog. */
async function openDeleteConfirm(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: `Options for conversation "${title}"` }))
  await user.click(await screen.findByRole('menuitem', { name: /delete conversation/i }))
  await screen.findByRole('dialog')
}

describe('ChatScreen — delete conversation (⋯ menu + ConfirmDialog)', () => {
  it('deletes after confirming in the dialog and refreshes the sidebar', async () => {
    const user = userEvent.setup()
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
    await openDeleteConfirm(user, 'My first chat')
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(screen.queryByText('My first chat')).not.toBeInTheDocument())
  })

  it('does nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    const deleteConversation = vi.fn(async () => {})
    stubApi({
      listConversations: vi.fn(async () => [conv({})]),
      deleteConversation,
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(<ChatScreen onNavigate={() => {}} />)

    await screen.findByText('My first chat')
    await openDeleteConfirm(user, 'My first chat')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

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
    expect(await screen.findByPlaceholderText("Message…")).toBeInTheDocument()
  })
})

// ---- Documents-scope popover (Phase 25 §3; scope semantics from Phase 17 §5.3) ----

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

describe('ChatScreen — documents-scope multi-select picker (plan §13)', () => {
  it('shows a persisted specific-doc scope and removes one document via setConversationScope', async () => {
    const user = userEvent.setup()
    const scoped = conv({ id: 'c9', title: 'Doc Q&A', mode: 'documents', scopeDocumentIds: ['d1', 'd2'] })
    const setConversationScope = vi.fn(async () => ({ ...scoped, scopeDocumentIds: ['d2'] }))
    const listConversations = vi
      .fn<() => Promise<Conversation[]>>()
      .mockResolvedValueOnce([scoped])
      .mockResolvedValue([{ ...scoped, scopeDocumentIds: ['d2'] }])
    stubApi({
      listConversations,
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [indexedDoc('d1', 'contract.pdf'), indexedDoc('d2', 'terms.docx')]),
      setConversationScope
    })
    render(<ChatScreen onNavigate={() => {}} />)

    await user.click(await screen.findByText('Doc Q&A'))
    await user.click(await screen.findByRole('button', { name: /using 2 documents/i }))
    // The two specific docs render as removable chips.
    expect(await screen.findByText('contract.pdf')).toBeInTheDocument()
    expect(screen.getByText('terms.docx')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /stop asking contract.pdf/i }))
    await waitFor(() =>
      expect(setConversationScope).toHaveBeenCalledWith('c9', { collectionIds: [], documentIds: ['d2'] })
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /using 1 document/i })).toBeInTheDocument()
    )
  })

  it('adds a document via "Specific documents…" and resets to all documents', async () => {
    const user = userEvent.setup()
    const scoped = conv({ id: 'c9', title: 'Doc Q&A', mode: 'documents', scopeDocumentIds: ['d1'] })
    const setConversationScope = vi.fn(async () => scoped)
    const listConversations = vi
      .fn<() => Promise<Conversation[]>>()
      .mockResolvedValueOnce([scoped])
      .mockResolvedValueOnce([{ ...scoped, scopeDocumentIds: ['d1', 'd2'] }])
      .mockResolvedValue([{ ...scoped, scopeDocumentIds: ['d1', 'd2'] }])
    stubApi({
      listConversations,
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [indexedDoc('d1', 'contract.pdf'), indexedDoc('d2', 'terms.docx')]),
      setConversationScope
    })
    render(<ChatScreen onNavigate={() => {}} />)

    await user.click(await screen.findByText('Doc Q&A'))
    await user.click(await screen.findByRole('button', { name: /using 1 document/i }))
    // Reveal the doc picker, then add an out-of-scope document as a "+ add" chip.
    await user.click(await screen.findByRole('button', { name: /specific documents/i }))
    await user.click(await screen.findByRole('button', { name: /\+ terms.docx/i }))
    await waitFor(() =>
      expect(setConversationScope).toHaveBeenCalledWith('c9', { collectionIds: [], documentIds: ['d1', 'd2'] })
    )
    expect(await screen.findByRole('button', { name: /using 2 documents/i })).toBeInTheDocument()

    // The reset taps to the explicit empty "All documents" scope.
    await user.click(screen.getByRole('button', { name: 'All documents' }))
    await waitFor(() =>
      expect(setConversationScope).toHaveBeenCalledWith('c9', { collectionIds: [], documentIds: [] })
    )
  })

  it('applies the pending handoff scope to the next documents conversation', async () => {
    const user = userEvent.setup()
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents', scopeDocumentIds: ['d1'] })
    const createConversation = vi.fn(async () => created)
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [indexedDoc('d1', 'contract.pdf')]),
      createConversation
    })
    render(
      <ChatScreen onNavigate={() => {}} initialMode="documents" initialScopeDocumentIds={['d1']} />
    )

    // The handoff shows in the footer affordance before any conversation exists…
    expect(await screen.findByRole('button', { name: /using 1 document/i })).toBeInTheDocument()
    // …and the next conversation is created WITH the composite scope (plan D1).
    await user.click(screen.getByRole('button', { name: /new document q&a/i }))
    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        mode: 'documents',
        scope: { collectionIds: [], documentIds: ['d1'] },
        collectionId: undefined
      })
    )
  })

  it('labels the whole corpus honestly when no scope is set', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => [indexedDoc('d1', 'contract.pdf'), indexedDoc('d2', 'terms.docx')])
    })
    render(<ChatScreen onNavigate={() => {}} initialMode="documents" />)
    // Truthful "all" copy never shows a count (it can't be "all 0 documents").
    expect(await screen.findByRole('button', { name: /using all documents/i })).toBeInTheDocument()
  })
})

describe('HomeScreen — readiness hub (Phase 26)', () => {
  function renderHome(
    onNavigate: (s: string) => void,
    opts: {
      activeModelId?: string | null
      running?: boolean
      docCount?: number
      problems?: string[]
    } = {}
  ): void {
    const docCount = opts.docCount ?? 2
    stubApi({
      getAppStatus: vi.fn(async () => ({
        appName: 'x',
        appVersion: '0',
        offlineMode: true,
        networkAllowed: false,
        activeModelId: opts.activeModelId ?? null,
        hardwareProfile: 'UNKNOWN' as const,
        workspaceMode: 'plaintext_dev' as const,
        workspaceReady: true,
        machineRamGb: 16,
        dictationAvailable: false,
        ocrAvailable: false
      })),
      getRuntimeStatus: vi.fn(async () => ({
        running: opts.running ?? false,
        modelId: opts.running ? (opts.activeModelId ?? 'm1') : null,
        port: null,
        healthy: opts.running ?? false,
        message: ''
      })),
      listDocuments: vi.fn(async () =>
        Array.from({ length: docCount }, (_, i) => indexedDoc(`d${i + 1}`, `doc-${i + 1}.pdf`))
      ),
      runPreflight: vi.fn(async () => ({
        ok: (opts.problems ?? []).length === 0,
        rootPath: '/drive',
        writable: true,
        freeBytes: 1024 * 1024 * 1024,
        slowDriveWarning: null,
        problems: opts.problems ?? []
      }))
    })
    render(<HomeScreen onNavigate={onNavigate} />)
  }

  it('"Start chatting" is the primary action and opens Chat', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderHome(onNavigate)
    await user.click(screen.getByRole('button', { name: /start chatting/i }))
    expect(onNavigate).toHaveBeenCalledWith('chat')
  })

  it('"Ask my documents" opens the documents chat, not the import screen', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderHome(onNavigate)
    await user.click(await screen.findByRole('button', { name: /ask my documents/i }))
    expect(onNavigate).toHaveBeenCalledWith('ask-documents')
  })

  it('reads ready when the model runs, with the model name and document count', async () => {
    const onNavigate = vi.fn()
    renderHome(onNavigate, { activeModelId: 'qwen3-4b-instruct-q4', running: true, docCount: 2 })
    expect(await screen.findByText('Ready to chat.')).toBeInTheDocument()
    expect(
      await screen.findByText(/qwen3-4b-instruct-q4 is running on this device/)
    ).toBeInTheDocument()
    expect(await screen.findByText(/2 documents ready to ask about/)).toBeInTheDocument()
  })

  it('says the selected model may still be loading while the runtime is down', async () => {
    const onNavigate = vi.fn()
    renderHome(onNavigate, { activeModelId: 'qwen3-4b-instruct-q4', running: false })
    expect(await screen.findByText('Getting ready…')).toBeInTheDocument()
    expect(
      await screen.findByText(/qwen3-4b-instruct-q4 is selected — it may still be loading/)
    ).toBeInTheDocument()
  })

  it('points at the AI Model screen when no model is selected', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderHome(onNavigate, { activeModelId: null })
    expect(await screen.findByText('No model selected yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /choose a model/i }))
    expect(onNavigate).toHaveBeenCalledWith('models')
  })

  it('nudges toward Documents when none are imported (and hides "Ask my documents")', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderHome(onNavigate, { docCount: 0 })
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ask my documents/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /add documents/i }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })

  it('shows preflight problems as a quiet warning', async () => {
    renderHome(vi.fn(), { problems: ['The drive has very little free space left.'] })
    expect(
      await screen.findByText('The drive has very little free space left.')
    ).toBeInTheDocument()
  })
})
