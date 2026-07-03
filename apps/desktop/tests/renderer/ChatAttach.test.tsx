// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type {
  Conversation,
  DocumentInfo,
  ImportJob,
  ImportJobStatus,
  Message,
  RuntimeStatus,
  SkillInfo
} from '../../src/shared/types'
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

/** A minimal enabled, available skill so the composer footer renders the skill picker. */
function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    installId: 'app:bank-statement',
    id: 'bank-statement',
    title: 'Bank statement helper',
    description: 'Explains a bank statement in plain language.',
    version: '1.0.0',
    kind: 'instruction',
    author: 'You',
    language: 'en',
    source: 'app',
    trustedLevel: 'app',
    enabled: true,
    warningAck: true,
    unavailable: false,
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary: 'can read the documents you pick for a turn.',
    duplicateId: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

// FE-A (full-audit-2026-06-29 follow-up, Phase 2): Electron removed the non-standard
// `File.path` in v32 (installed: 37.x). A dropped File carries NO `.path`; the renderer must
// resolve the on-disk path through the preload bridge (`window.api.getDroppedFilePath`, which
// wraps `webUtils.getPathForFile` — only callable in the preload). These tests therefore drive
// the *real* bridge shape: the dropped File is a bare `{ name }` with no `.path`, and a WeakMap
// stands in for webUtils' File→path resolution (registered via `dropFile`). This is the lesson
// of FE-A — never fabricate a platform property the renderer could read directly, or the test
// goes green while production (where `.path` is undefined) silently fails.
const droppedPaths = new WeakMap<object, string>()

/** The preload resolver as the renderer sees it: maps a dropped File to its real path the way
 *  `webUtils.getPathForFile` does in main. Wired into every stub by `stubChatApi` below. */
const getDroppedFilePath = vi.fn((file: object): string => droppedPaths.get(file) ?? '')

/** `stubApi` + the drag-drop path resolver every drop test needs (the bridge that replaced the
 *  removed `File.path` — without it `pathsFromDrop` resolves nothing and no import fires). */
function stubChatApi(overrides: Parameters<typeof stubApi>[0]): void {
  stubApi({ getDroppedFilePath: getDroppedFilePath as never, ...overrides })
}

/** Fire a native-style file drop on the chat surface. The File has NO `.path` (Electron 37);
 *  its real path is registered for the bridge resolver, exactly as webUtils would resolve it. */
function dropFile(name: string, path: string): void {
  const target = document.querySelector('.chat-main')
  if (!target) throw new Error('no .chat-main drop target')
  const file = { name } // deliberately NO `.path` — Electron 37 doesn't expose it (FE-A)
  droppedPaths.set(file, path)
  fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } })
}

/** Fire a Files-bearing drop whose File resolves to NO path (a browser-origin drag, or any
 *  drop with no on-disk file) — the FE-C "unusable drop" case. */
function dropUnresolvableFile(name: string): void {
  const target = document.querySelector('.chat-main')
  if (!target) throw new Error('no .chat-main drop target')
  // Not registered in `droppedPaths` → the bridge resolver returns '' for it.
  fireEvent.drop(target, { dataTransfer: { files: [{ name }], types: ['Files'] } })
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
  getDroppedFilePath.mockClear() // a plain vi.fn() isn't reset by restoreAllMocks
  window.localStorage.clear()
})

describe('ChatScreen — chat attach / drag-drop intake (plan §11.2 / §13.5)', () => {
  it('dropping onto an empty composer attaches to a NEW documents conversation (no toast) + a pending chip', async () => {
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    const createConversation = vi.fn(async () => created)
    const importDocuments = vi.fn(async () => job)
    stubChatApi({
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
    // With no pending narrowing the scope handoff passes null (the Library default is preserved).
    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        mode: 'documents',
        scope: null,
        collectionId: undefined
      })
    )
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

  it('carries a skill picked on the new composer onto the documents conversation an attachment creates', async () => {
    // Regression: selecting a skill and THEN uploading a document used to reset the skill to none —
    // attachFiles created/switched to a new conversation without carrying the 'new' composer's pick
    // (unlike ensureConversation). The pick must ride onto the created conversation. U3 (audit §4.3):
    // per-turn by default — the pick carries as a SESSION override (the picker still shows it) but is
    // NOT silently persisted as the sticky default (persistence is now the explicit "keep" opt-in).
    const user = userEvent.setup()
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    const createConversation = vi.fn(async () => created)
    const importDocuments = vi.fn(async () => job)
    const setConversationDefaultSkill = vi.fn(async () => {})
    stubChatApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      listSkills: vi.fn(async () => [skill()]),
      suggestSkills: vi.fn(async () => []),
      listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
      createConversation,
      importDocuments,
      setConversationDefaultSkill,
      getImportJob: vi.fn(async () => ({ ...jobDone, done: false })),
      listAttachments: vi.fn(async () => [])
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await screen.findByText(/start chatting/i).catch(() => undefined)

    // Pick the skill on the still-"new" composer (no conversation yet → not persisted, only staged).
    await user.click(await screen.findByRole('button', { name: /^skill:/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    expect(screen.getByRole('button', { name: /^skill:/i })).toHaveTextContent('Bank statement helper')
    expect(setConversationDefaultSkill).not.toHaveBeenCalled() // nothing to persist onto yet

    dropFile('invoice.pdf', '/tmp/invoice.pdf')

    // The created documents conversation received the import…
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/invoice.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
    // …the picker still shows the skill — it was NOT reset by the upload (carried as a session pick)…
    expect(screen.getByRole('button', { name: /^skill:/i })).toHaveTextContent('Bank statement helper')
    // …and per-turn: the unkept pick was NOT silently persisted as the new conversation's default.
    expect(setConversationDefaultSkill).not.toHaveBeenCalled()
  })

  it('converts a pending attachment to a live "Files in this chat" entry once indexed (N4)', async () => {
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    // The link exists once the job completes; the import finishes immediately here.
    stubChatApi({
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
    stubChatApi({
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

    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        mode: 'documents',
        scope: null,
        collectionId: undefined
      })
    )
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/invoice.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
    // A toast explains the jump to a new document chat (the plain chat is preserved).
    expect(await screen.findByText(/started a new document chat for invoice\.pdf/i)).toBeInTheDocument()
  })

  it('carries the pending composite scope onto the documents conversation created for an attachment', async () => {
    // The user narrowed scope on the 'new' composer (here: ask ONLY d0 — the real-world case is
    // unchecking Library to ask just the file). Dropping a NEW file must NOT silently reset to the
    // Library default; the new conversation must own the user's narrowing so a single-doc skill
    // (whole-doc engine) can fire. Regression for the attach-flow scope handoff bug.
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    const createConversation = vi.fn(async () => created)
    const importDocuments = vi.fn(async () => job)
    stubChatApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d0', 'lease.pdf')]),
      createConversation,
      importDocuments,
      getImportJob: vi.fn(async () => ({ ...jobDone, done: false })),
      listAttachments: vi.fn(async () => [])
    })
    render(
      <ToastProvider>
        <ChatScreen
          onNavigate={() => {}}
          initialMode="documents"
          initialScopeDocumentIds={['d0']}
        />
      </ToastProvider>
    )

    dropFile('invoice.pdf', '/tmp/invoice.pdf')

    // The pending narrowing ({ask only d0}) rides onto the created conversation — NOT dropped.
    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        mode: 'documents',
        scope: { collectionIds: [], documentIds: ['d0'] },
        collectionId: undefined
      })
    )
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/invoice.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
  })

  it('shows linked attachments as a read-only "Files in this chat" line', async () => {
    const user = userEvent.setup()
    const docConv = conv({ id: 'c9', title: 'Doc Q&A', mode: 'documents' })
    stubChatApi({
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

  // FE-A (full-audit-2026-06-29 follow-up, Phase 2): the drop path must resolve the on-disk
  // path through the preload bridge, NOT a `.path` Electron 37 no longer puts on a File.
  it('resolves a dropped File without `.path` through the preload bridge (Electron 37 — FE-A)', async () => {
    const created = conv({ id: 'c2', title: 'New chat', mode: 'documents' })
    const importDocuments = vi.fn(async () => job)
    stubChatApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      createConversation: vi.fn(async () => created),
      importDocuments,
      getImportJob: vi.fn(async () => ({ ...jobDone, done: false })),
      listAttachments: vi.fn(async () => [])
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await screen.findByText(/start chatting/i).catch(() => undefined)

    dropFile('statement.pdf', '/tmp/statement.pdf')

    // The renderer asked the bridge for the path (the dropped File carries no `.path`)…
    await waitFor(() =>
      expect(getDroppedFilePath).toHaveBeenCalledWith(expect.objectContaining({ name: 'statement.pdf' }))
    )
    // …and imported the path the bridge returned. On the old `File.path` code this stays []
    // (the File has no `.path`) → importDocuments is never called → this test reds (teeth).
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/statement.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
  })

  // FE-C: a Files-bearing drop that resolves to ZERO importable paths (a browser-origin drag,
  // or any drop with no on-disk file) must not fail silently — it surfaces a friendly banner.
  it('shows a friendly error when a Files-bearing drop resolves to no usable path (FE-C)', async () => {
    const importDocuments = vi.fn(async () => job)
    stubChatApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      importDocuments,
      listAttachments: vi.fn(async () => [])
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await screen.findByText(/start chatting/i).catch(() => undefined)

    dropUnresolvableFile('clipping.png')

    // The error banner explains the drop couldn't be used (en copy of chat.attach.dropUnsupported).
    expect(await screen.findByText(/couldn't add that/i)).toBeInTheDocument()
    // Nothing was imported — a zero-path drop must not start a phantom import.
    expect(importDocuments).not.toHaveBeenCalled()
  })
})
