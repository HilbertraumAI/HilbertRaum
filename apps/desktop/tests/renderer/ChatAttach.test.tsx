// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS, type DocumentInfo, type ImportJob, type ImportJobStatus } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { makeConversation, makeDocumentInfo, makeSkillInfo, userMsg } from '../helpers/chat-fixtures'
import {
  chatDropBridge,
  chatScreenStubs,
  conversationRow,
  renderChatScreen,
  type ChatDropBridge
} from '../helpers/chat-screen'
import { hangBudgetMs } from '../helpers/hang-budget'
import { en, t } from '../../src/shared/i18n'

// Phase C renderer tests: the net-new chat attach / drag-drop intake (plan §11.2 H1),
// plain-chat drop routing (§13.5 H2), the in-flight pending chip → live attachment
// transition (N4), and the read-only "Files in this chat" affordance (§13.1).

const job: ImportJob = { jobId: 'j1', documentIds: ['d1'] }
const jobDone: ImportJobStatus = { jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }

// FE-A (full-audit-2026-06-29 follow-up, Phase 2): Electron removed the non-standard
// `File.path` in v32 (installed: 37.x). A dropped File carries NO `.path`; the renderer must
// resolve the on-disk path through the preload bridge (`window.api.getDroppedFilePath`, which
// wraps `webUtils.getPathForFile` — only callable in the preload). Every drop below therefore
// drives the *real* bridge shape: `chatDropBridge` drops a path-less `File` and stands in for
// webUtils' File→path resolution. This is the lesson of FE-A — never fabricate a platform
// property the renderer could read directly, or the test goes green while production (where
// `.path` is undefined) silently fails.
let bridge: ChatDropBridge

beforeEach(() => {
  bridge = chatDropBridge()
})

/** The chat surface the drop handler sits on (rendered while the mount reads are still in flight). */
const chatMain = (): Element => {
  const el = document.querySelector('.chat-main')
  if (!el) throw new Error('no .chat-main drop target')
  return el
}

/** The created documents conversation every empty-composer drop lands in. */
const createdDocsChat = () => makeConversation({ id: 'c2', title: 'New chat', mode: 'documents' })

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

describe('ChatScreen — chat attach / drag-drop intake (plan §11.2 / §13.5)', () => {
  it('dropping onto an empty composer attaches to a NEW documents conversation (no toast) + a pending chip', async () => {
    const createConversation = vi.fn(async () => createdDocsChat())
    const importDocuments = vi.fn(async () => job)
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        createConversation,
        importDocuments,
        // Never completes → the pending chip persists deterministically for the assertion (N4).
        getImportJob: vi.fn(async () => ({ ...jobDone, done: false }))
      })
    )
    renderChatScreen()

    bridge.drop(chatMain(), 'invoice.pdf', '/tmp/invoice.pdf')

    // A documents conversation is created and committed BEFORE the import references it (N3).
    // D71 (#26): with no pending narrowing the attach path now persists an EMPTY EXPLICIT scope so
    // the chat answers from just its attachment(s), not the whole Library.
    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        mode: 'documents',
        scope: { collectionIds: [], documentIds: [] },
        collectionId: undefined
      })
    )
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/tmp/invoice.pdf'], {
        destination: { kind: 'conversation', conversationId: 'c2' }
      })
    )
    // FE-A: the dropped File carries no `.path` (Electron 37); its path came from the preload bridge.
    expect(bridge.stubs.getDroppedFilePath).toHaveBeenCalledWith(expect.objectContaining({ name: 'invoice.pdf' }))
    // No "started a new document chat" toast — there was nothing to preserve.
    expect(screen.queryByText(/started a new document chat/i)).not.toBeInTheDocument()

    // The non-removable pending chip is visible while processing (N4); the same status is
    // mirrored to a polite aria-live region for keyboard/screen-reader users (UX-3), so the
    // text legitimately appears twice — the visible chip AND the sr-only announcer.
    await userEvent.click(await screen.findByRole('button', { name: /answering from/i }))
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
    const importDocuments = vi.fn(async () => job)
    const setConversationDefaultSkill = vi.fn(async () => {})
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        // The skill's #46 info card was already seen, so the first pick opens no card (and writes
        // no settings): this row is about the carry, not the card.
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, skillInfoSeen: ['bank-statement'] })),
        listSkills: vi.fn(async () => [makeSkillInfo()]),
        createConversation: vi.fn(async () => createdDocsChat()),
        importDocuments,
        setConversationDefaultSkill,
        getImportJob: vi.fn(async () => ({ ...jobDone, done: false }))
      })
    )
    renderChatScreen()

    // Pick the skill on the still-"new" composer (no conversation yet → not persisted, only staged).
    await user.click(await screen.findByRole('button', { name: /^skill:/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    expect(screen.getByRole('button', { name: /^skill:/i })).toHaveTextContent('Bank statement helper')
    expect(setConversationDefaultSkill).not.toHaveBeenCalled() // nothing to persist onto yet

    bridge.drop(chatMain(), 'invoice.pdf', '/tmp/invoice.pdf')

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
    let jobFinished = false
    const live = makeDocumentInfo({ id: 'd1', title: 'invoice.pdf', lifecycle: 'temporary' })
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        listDocuments: vi.fn(async () => [live]),
        createConversation: vi.fn(async () => createdDocsChat()),
        importDocuments: vi.fn(async () => job),
        getImportJob: vi.fn(async () => (jobFinished ? jobDone : { ...jobDone, completed: 0, done: false })),
        // The live entry exists only once the job has finished: only watchAttachJob's refresh can reveal it.
        listAttachments: vi.fn(async () => (jobFinished ? [live] : []))
      })
    )
    renderChatScreen()

    bridge.drop(chatMain(), 'invoice.pdf', '/tmp/invoice.pdf')

    // While processing, the file is only the pending chip (the chip names it: one file in this chat).
    await userEvent.click(await screen.findByRole('button', { name: /answering from: invoice\.pdf/i }))
    expect(await screen.findByText(t('en', 'chat.scope.filesInChatLine'))).toBeInTheDocument()
    expect(
      (await screen.findAllByText(t('en', 'chat.attach.processing', { name: 'invoice.pdf' }))).length
    ).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument() // no live entry yet

    // The job finishes: the live attachment shows in the open popover, no longer "processing…".
    jobFinished = true
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.queryByText(t('en', 'chat.attach.processing', { name: 'invoice.pdf' }))).not.toBeInTheDocument()
    )
  })

  it('dropping onto an in-progress PLAIN chat starts a new documents chat (never mutates it)', async () => {
    const user = userEvent.setup()
    const createConversation = vi.fn(async () => createdDocsChat())
    const importDocuments = vi.fn(async () => job)
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        listConversations: vi.fn(async () => [makeConversation({ title: 'My first chat' })]),
        listMessages: vi.fn(async () => [userMsg('m1', 'an in-progress plain chat')]),
        createConversation,
        importDocuments,
        getImportJob: vi.fn(async () => ({ ...jobDone, done: false }))
      })
    )
    renderChatScreen()
    // Select the plain chat so it has messages (the "in progress" condition).
    await user.click(await screen.findByText('My first chat'))
    await screen.findByText('an in-progress plain chat')

    bridge.drop(chatMain(), 'invoice.pdf', '/tmp/invoice.pdf')

    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        mode: 'documents',
        scope: { collectionIds: [], documentIds: [] },
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
    const createConversation = vi.fn(async () => createdDocsChat())
    const importDocuments = vi.fn(async () => job)
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        listDocuments: vi.fn(async () => [
          makeDocumentInfo({ id: 'd0', title: 'lease.pdf', lifecycle: 'temporary' })
        ]),
        createConversation,
        importDocuments,
        getImportJob: vi.fn(async () => ({ ...jobDone, done: false }))
      })
    )
    renderChatScreen({ initialMode: 'documents', initialScopeDocumentIds: ['d0'] })

    bridge.drop(chatMain(), 'invoice.pdf', '/tmp/invoice.pdf')

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
    const invoice = makeDocumentInfo({ id: 'd1', title: 'invoice.pdf', lifecycle: 'temporary' })
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ id: 'c9', title: 'Doc Q&A', mode: 'documents' })]),
        listDocuments: vi.fn(async () => [invoice]),
        listAttachments: vi.fn(async () => [invoice])
      })
    )
    renderChatScreen()
    await user.click(await screen.findByText('Doc Q&A'))

    // The "Answering from:" chip names the chat's file (D71); opening it reveals the read-only attachment.
    await user.click(await screen.findByRole('button', { name: /answering from/i }))
    expect(await screen.findByText('Files in this chat')).toBeInTheDocument()
    expect(screen.getAllByText('invoice.pdf').length).toBeGreaterThan(0)
  })

  // FE-C: a Files-bearing drop that resolves to ZERO importable paths (a browser-origin drag,
  // or any drop with no on-disk file) must not fail silently — it surfaces a friendly banner.
  it('shows a friendly error when a Files-bearing drop resolves to no usable path (FE-C)', async () => {
    const importDocuments = vi.fn(async () => job)
    stubApi(chatScreenStubs({ ...bridge.stubs, importDocuments }))
    renderChatScreen()

    bridge.dropUnresolvable(chatMain(), 'clipping.png')

    // The error banner explains the drop couldn't be used (en copy of chat.attach.dropUnsupported).
    expect(await screen.findByText(/couldn't add that/i)).toBeInTheDocument()
    // Nothing was imported — a zero-path drop must not start a phantom import.
    expect(importDocuments).not.toHaveBeenCalled()
  })
})

// #570: an attachment that failed because it needs OCR — a scan, or a photo while the drive has no
// OCR files — used to leave only the stored message ("This PDF looks like a scan…") with no way on.
// The banner now says what to do in Documents and links there. Detection is the structured flag
// (`ocrRemedyKind`), never the stored text; the banner belongs to the chat that received the file.
describe('ChatScreen — a failed attachment points to Documents (#570)', () => {
  const SCAN_MESSAGE = en['main.ingest.pdfScanDetected']
  function failedDoc(id: string, title: string, kind: 'scan' | 'photo' | 'other'): DocumentInfo {
    return makeDocumentInfo({
      id,
      title,
      lifecycle: 'temporary',
      status: 'failed',
      chunkCount: 0,
      errorMessage:
        kind === 'scan' ? SCAN_MESSAGE : kind === 'photo' ? en['main.ingest.imageNeedsOcr'] : 'EIO: i/o error, read',
      ...(kind === 'scan' ? { scanDetected: true } : {})
    })
  }
  const failedJob = (failed: number, documentIds = ['d1']): ImportJobStatus => ({
    jobId: 'j1',
    total: documentIds.length,
    completed: documentIds.length - failed,
    failed,
    done: true
  })

  function renderAttachBorn(opts: { docs: DocumentInfo[]; documentIds?: string[] }) {
    const ids = opts.documentIds ?? ['d1']
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        listDocuments: vi.fn(async () => opts.docs),
        createConversation: vi.fn(async () => createdDocsChat()),
        importDocuments: vi.fn(async () => ({ jobId: 'j1', documentIds: ids })),
        getImportJob: vi.fn(async () => failedJob(opts.docs.filter((d) => d.status === 'failed').length, ids))
      })
    )
    return renderChatScreen()
  }

  it('a scan: says what to do in Documents, and "Go to Documents" goes there', async () => {
    const { onNavigate } = renderAttachBorn({ docs: [failedDoc('d1', 'contract-scan.pdf', 'scan')] })
    bridge.drop(chatMain(), 'contract-scan.pdf', '/tmp/contract-scan.pdf')

    expect(await screen.findByText(t('en', 'chat.attach.scanned', { name: 'contract-scan.pdf' }))).toBeInTheDocument()
    expect(screen.queryByText(SCAN_MESSAGE)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Go to Documents' }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })

  it('a photo without the OCR files gets its own copy and the same button', async () => {
    renderAttachBorn({ docs: [failedDoc('d1', 'page.jpg', 'photo')] })
    bridge.drop(chatMain(), 'page.jpg', '/tmp/page.jpg')
    expect(await screen.findByText(t('en', 'chat.attach.photoNeedsOcr', { name: 'page.jpg' }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to Documents' })).toBeInTheDocument()
  })

  it('any other failure keeps its own message, with no button', async () => {
    renderAttachBorn({ docs: [failedDoc('d1', 'broken.pdf', 'other')] })
    bridge.drop(chatMain(), 'broken.pdf', '/tmp/broken.pdf')
    expect(await screen.findByText('EIO: i/o error, read')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Documents' })).not.toBeInTheDocument()
  })

  it('names the scan when several files failed, whatever their order', async () => {
    renderAttachBorn({
      docs: [
        failedDoc('d1', 'broken.pdf', 'other'),
        failedDoc('d2', 'page.jpg', 'photo'),
        failedDoc('d3', 'scan.pdf', 'scan')
      ],
      documentIds: ['d1', 'd2', 'd3']
    })
    bridge.drop(chatMain(), 'scan.pdf', '/tmp/scan.pdf')
    expect(await screen.findByText(t('en', 'chat.attach.scanned', { name: 'scan.pdf' }))).toBeInTheDocument()
  })

  it('dismissing the banner takes the button with it', async () => {
    renderAttachBorn({ docs: [failedDoc('d1', 'scan.pdf', 'scan')] })
    bridge.drop(chatMain(), 'scan.pdf', '/tmp/scan.pdf')
    await screen.findByText(t('en', 'chat.attach.scanned', { name: 'scan.pdf' }))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(t('en', 'chat.attach.scanned', { name: 'scan.pdf' }))).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Documents' })).not.toBeInTheDocument()
  })

  it('never shows over another chat: held while the user is elsewhere, shown on return, cleared on leaving', async () => {
    const user = userEvent.setup()
    // An attach-born chat (D71's empty explicit scope), so the drop raises no narrow/widen prompt.
    const a = makeConversation({ id: 'ca', title: 'Chat A', mode: 'documents', scope: { collectionIds: [], documentIds: [] } })
    const b = makeConversation({ id: 'cb', title: 'Chat B', mode: 'documents' })
    let finished = false
    const listDocuments = vi.fn(async () => [failedDoc('d1', 'scan.pdf', 'scan')])
    const importDocuments = vi.fn(async () => job)
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        listConversations: vi.fn(async () => [a, b]),
        listDocuments,
        importDocuments,
        getImportJob: vi.fn(async () => (finished ? failedJob(1) : { ...failedJob(1), failed: 0, done: false }))
      })
    )
    renderChatScreen()
    await user.click(await screen.findByText('Chat A'))
    bridge.drop(chatMain(), 'scan.pdf', '/tmp/scan.pdf')
    await waitFor(() => expect(importDocuments).toHaveBeenCalled())
    const docsReadsBefore = listDocuments.mock.calls.length
    await user.click(conversationRow('Chat B'))
    finished = true
    const scanCopy = t('en', 'chat.attach.scanned', { name: 'scan.pdf' })
    // The job settles while B is open; its done-tick reads the document list once more…
    await waitFor(() => expect(listDocuments.mock.calls.length).toBeGreaterThan(docsReadsBefore), {
      timeout: hangBudgetMs(3000)
    })
    // …and holds the failure synchronously after that read resolves (no wall-clock wait).
    await act(async () => {
      await listDocuments.mock.results.at(-1)!.value
    })
    await act(async () => {})
    expect(screen.queryByText(scanCopy)).not.toBeInTheDocument()
    expect(screen.queryByText(SCAN_MESSAGE)).not.toBeInTheDocument()
    // Back in A, the user learns what happened to the file they attached there.
    await user.click(conversationRow('Chat A'))
    expect(await screen.findByText(scanCopy)).toBeInTheDocument()
    // Leaving clears it (CR-6), and it does not come back a second time.
    await user.click(conversationRow('Chat B'))
    await waitFor(() => expect(screen.queryByText(scanCopy)).not.toBeInTheDocument())
    await user.click(conversationRow('Chat A'))
    await waitFor(() => expect(conversationRow('Chat A')).toHaveAttribute('aria-current', 'true'))
    expect(screen.queryByText(scanCopy)).not.toBeInTheDocument()
  })
})
