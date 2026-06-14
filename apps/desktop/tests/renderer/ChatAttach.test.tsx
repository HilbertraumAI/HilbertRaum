// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { Conversation, DocumentInfo, ImportJob, ImportJobStatus, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase C renderer tests: the net-new chat attach / drag-drop intake (plan §11.2 H1),
// plain-chat drop routing (§13.5 H2), the in-flight pending chip → live attachment
// transition (N4), and the read-only "Files in this chat" affordance (§13.1).

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

function docInfo(id: string, title: string): DocumentInfo {
  return {
    id,
    title,
    originalPath: null,
    mimeType: 'application/pdf',
    sizeBytes: 10,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 1,
    lifecycle: 'temporary',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }
}

const job: ImportJob = { jobId: 'j1', documentIds: ['d1'] }
const jobDone: ImportJobStatus = { jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }

/** Fire a native-style file drop (Electron exposes `File.path`) on the chat surface. */
function dropFile(name: string, path: string): void {
  const target = document.querySelector('.chat-main')
  if (!target) throw new Error('no .chat-main drop target')
  fireEvent.drop(target, { dataTransfer: { files: [{ name, path }], types: ['Files'] } })
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

describe('ChatScreen — chat attach / drag-drop intake (plan §11.2 / §13.5)', () => {
  it('dropping onto an empty composer attaches to a NEW documents conversation (no toast) + a pending chip', async () => {
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    const createConversation = vi.fn(async () => created)
    const importDocuments = vi.fn(async () => job)
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      createConversation,
      importDocuments,
      // Never completes → the pending chip persists deterministically for the assertion (N4).
      getImportJob: vi.fn(async () => ({ ...jobDone, done: false })),
      listAttachments: vi.fn(async () => [])
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await screen.findByText(/start chatting/i).catch(() => undefined)

    dropFile('invoice.pdf', '/tmp/invoice.pdf')

    // A documents conversation is created and committed BEFORE the import references it (N3).
    await waitFor(() => expect(createConversation).toHaveBeenCalledWith({ mode: 'documents' }))
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/invoice.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
    // No "started a new document chat" toast — there was nothing to preserve.
    expect(screen.queryByText(/started a new document chat/i)).not.toBeInTheDocument()

    // The non-removable pending chip is visible while processing (N4); the same status is
    // mirrored to a polite aria-live region for keyboard/screen-reader users (UX-3), so the
    // text legitimately appears twice — the visible chip AND the sr-only announcer.
    await userEvent.click(await screen.findByRole('button', { name: /files? in this chat/i }))
    const processing = await screen.findAllByText(/processing invoice\.pdf/i)
    expect(processing.length).toBeGreaterThanOrEqual(2)
  })

  it('converts a pending attachment to a live "Files in this chat" entry once indexed (N4)', async () => {
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    // The link exists once the job completes; the import finishes immediately here.
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d1', 'invoice.pdf')]),
      createConversation: vi.fn(async () => created),
      importDocuments: vi.fn(async () => job),
      getImportJob: vi.fn(async () => jobDone),
      listAttachments: vi.fn(async () => [docInfo('d1', 'invoice.pdf')])
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await screen.findByText(/start chatting/i).catch(() => undefined)

    dropFile('invoice.pdf', '/tmp/invoice.pdf')

    // The live attachment shows in the footer popover, no longer "processing…".
    await waitFor(() => expect(screen.getByRole('button', { name: /files? in this chat/i })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /files? in this chat/i }))
    expect(await screen.findByText('Files in this chat')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument())
    // The pending chip clears once the job completes (it overlaps briefly before the poll).
    await waitFor(() => expect(screen.queryByText(/processing invoice\.pdf/i)).not.toBeInTheDocument())
  })

  it('dropping onto an in-progress PLAIN chat starts a new documents chat (never mutates it)', async () => {
    const user = userEvent.setup()
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    const createConversation = vi.fn(async () => created)
    const importDocuments = vi.fn(async () => job)
    const msg: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'an in-progress plain chat',
      createdAt: '2026-01-01T00:00:00Z',
      tokenCount: null
    }
    stubApi({
      listConversations: vi.fn(async () => [conv({})]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => [msg]),
      listDocuments: vi.fn(async () => []),
      createConversation,
      importDocuments,
      getImportJob: vi.fn(async () => ({ ...jobDone, done: false })),
      listAttachments: vi.fn(async () => [])
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    // Select the plain chat so it has messages (the "in progress" condition).
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('an in-progress plain chat')

    dropFile('invoice.pdf', '/tmp/invoice.pdf')

    await waitFor(() => expect(createConversation).toHaveBeenCalledWith({ mode: 'documents' }))
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/invoice.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
    // A toast explains the jump to a new document chat (the plain chat is preserved).
    expect(await screen.findByText(/started a new document chat for invoice\.pdf/i)).toBeInTheDocument()
  })

  it('shows linked attachments as a read-only "Files in this chat" line', async () => {
    const user = userEvent.setup()
    const docConv = conv({ id: 'c9', title: 'Doc Q&A', mode: 'documents' })
    stubApi({
      listConversations: vi.fn(async () => [docConv]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d1', 'invoice.pdf')]),
      listAttachments: vi.fn(async () => [docInfo('d1', 'invoice.pdf')])
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Doc Q&A'))

    // The footer counts the chat's files; opening it reveals the read-only attachment.
    await user.click(await screen.findByRole('button', { name: /files? in this chat/i }))
    expect(await screen.findByText('Files in this chat')).toBeInTheDocument()
    expect(screen.getAllByText('invoice.pdf').length).toBeGreaterThan(0)
  })
})
