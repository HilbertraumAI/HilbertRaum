// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { App } from '../../src/renderer/App'
import { purgeReviewSession } from '../../src/renderer/lib/reviewSession'
import { en, t } from '../../src/shared/i18n'
import type { Message, PreflightResult, WorkspaceStateInfo } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { appStatus, makePolicyStatus } from '../helpers/status'
import { makeDetail, stubReviewApi } from '../helpers/evidenceReview'
import { assistantMsg, makeConversation, makeDocumentInfo, userMsg } from '../helpers/chat-fixtures'
import {
  chatDropBridge,
  chatScreenStubs,
  conversationRow,
  flushFakeTimers,
  renderChatScreen
} from '../helpers/chat-screen'

// EP-1 P5 (plan §10) — "Back to chat" returns to the ORIGINATING conversation: App hands
// the review's conversationId to ChatScreen as `initialConversationId`, and the mount-time
// re-attach effect selects it (verified against the loaded list; the same `activeIdRef`
// one-shot idiom as the stream/skill-run re-attach effects). A deleted/unknown id degrades
// to the plain chat-home landing — never a phantom selection.
//
// The second describe is the App-LEVEL lifecycle of the handoff slot (review FIX-1): the
// slot must be one-shot across EVERY path that mounts chat — including the Documents
// screen's "Ask these documents", which mounts chat WITHOUT navigate() and used to leave
// the slot armed (the re-attach then resurrected the OLD conversation and stomped the
// just-set documents mode).

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    // The review store outlives the unmount (the FIX-1 row opens a review): the production purge.
    purgeReviewSession()
    vi.restoreAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
  }
})

describe('ChatScreen — back-to-originating-conversation handoff (P5)', () => {
  it('selects the handed-off conversation on mount (history loads, row current, mode mirrors)', async () => {
    const listMessages = vi.fn(async (_id: string): Promise<Message[]> => [])
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [
          makeConversation({ id: 'c1', title: 'Conversation c1' }),
          makeConversation({ id: 'c2', title: 'Conversation c2', mode: 'documents' })
        ]),
        listMessages
      })
    )
    renderChatScreen({ initialConversationId: 'c2', onOpenReview: () => {} })

    // The re-attach effect resolved: c2 is the ACTIVE conversation.
    await waitFor(() => expect(listMessages).toHaveBeenCalledWith('c2'))
    await waitFor(() => expect(conversationRow('Conversation c2')).toHaveAttribute('aria-current', 'true'))
    // Never a spurious load of some other conversation.
    expect(listMessages).not.toHaveBeenCalledWith('c1')
    // c2 is a documents conversation: the composer mode mirrors it.
    expect(screen.getByRole('radio', { name: t('en', 'chat.mode.documents') })).toHaveAttribute('aria-checked', 'true')
  })

  it.each([
    ['an unknown (deleted) id degrades to chat home — nothing selected, nothing loaded', 'gone', 2],
    ['without a handoff the mount stays on chat home (baseline unchanged)', undefined, 1]
  ] as const)('%s', async (_title, initialConversationId, conversationReads) => {
    vi.useFakeTimers()
    const listConversations = vi.fn(async () => [makeConversation({ id: 'c1', title: 'Conversation c1' })])
    const listMessages = vi.fn(async (_id: string): Promise<Message[]> => [])
    stubApi(chatScreenStubs({ listConversations, listMessages }))
    renderChatScreen({ initialConversationId, onOpenReview: () => {} })
    await flushFakeTimers() // mount, handoff and any history-load effect have all run
    // Positive gate: the mount refresh, plus the handoff's own read when an id was handed over.
    expect(listConversations).toHaveBeenCalledTimes(conversationReads)
    expect(conversationRow('Conversation c1')).not.toHaveAttribute('aria-current')
    expect(listMessages).not.toHaveBeenCalled()
  })
})

// ---- App-level handoff-slot lifecycle (review FIX-1) -----------------------------------

const unlockedWorkspace: WorkspaceStateInfo = {
  state: 'unlocked',
  mode: 'plaintext_dev',
  plaintextAllowed: true,
  encryptionRequired: false
}

const offlinePolicy = makePolicyStatus({ policyFilePresent: false, driveFilePresent: false })

/** The App shell's boot reads (an unlocked dev workspace, the offline policy, a healthy drive, no
 *  moved-drive notice, no engine or performance events) and the Documents screen's mount reads (no
 *  import or reindex job to resume): everything these rows reach beyond `chatScreenStubs`. */
const appShellStubs = () => ({
  onEngineProblemsChanged: vi.fn(() => () => {}),
  onPerformanceChanged: vi.fn(() => () => {}),
  getMovedDriveNotice: vi.fn(async () => null),
  getActiveImportJob: vi.fn(async () => null),
  getReindexAllJob: vi.fn(async () => null),
  getWorkspaceState: vi.fn(async () => unlockedWorkspace),
  getPolicy: vi.fn(async () => offlinePolicy),
  runPreflight: vi.fn(
    async (): Promise<PreflightResult> => ({
      rootPath: '/drive',
      writable: true,
      freeBytes: 1024 * 1024 * 1024,
      slowDriveWarning: null,
      problems: []
    })
  )
})

describe('App — the back-handoff slot is one-shot across EVERY chat mount path (FIX-1)', () => {
  it('review → back (slot works once) → Documents → "Ask these documents" wins: documents mode, no resurrected conversation', async () => {
    // c1 is a CHAT-mode conversation (its answer is eligible via citations), so a
    // resurrected re-attach would ALSO stomp the composer mode — both asserted below.
    const conversation = makeConversation({
      id: 'c1',
      title: 'Contract chat',
      modelId: 'm1',
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T10:00:00.000Z'
    })
    const messages: Message[] = [
      userMsg('m1', 'What does the contract say?', { createdAt: '2026-07-18T09:59:00.000Z' }),
      assistantMsg('m2', 'It can be terminated with 90 days notice. [S1]', {
        createdAt: '2026-07-18T10:00:00.000Z',
        citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 12, snippet: '…' }]
      })
    ]
    const listMessages = vi.fn(async (_id: string) => messages)
    stubReviewApi({
      ...chatScreenStubs({
        listConversations: vi.fn(async () => [conversation]),
        listMessages,
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd1', title: 'contract.pdf', sizeBytes: 2048 })])
      }),
      ...appShellStubs(),
      getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'm1', machineRamGb: 16 })),
      getEvidenceReviewForMessage: vi.fn(async () => null),
      createEvidenceReview: vi.fn(async () => makeDetail({ conversationId: 'c1', messageId: 'm2' }))
    })
    render(<App />)
    const nav = await screen.findByRole('navigation')

    // Chat → open c1 → into the review workspace.
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.chat') }))
    fireEvent.click(await screen.findByRole('button', { name: /^Contract chat/ }))
    await screen.findByText(/90 days notice/)
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.action.start') }))
    await screen.findByRole('heading', { name: t('en', 'main.evidenceReviews.defaultTitle') })

    // Back → the slot fires ONCE: c1 comes back as the active conversation.
    fireEvent.click(screen.getByRole('button', { name: `‹ ${t('en', 'review.back')}` }))
    await waitFor(() => expect(conversationRow('Contract chat')).toHaveAttribute('aria-current', 'true'))

    // Rail → Documents (no chatMode on this navigation — the slot must not survive it
    // into the NEXT chat mount), then "Ask these documents".
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.documents') }))
    const checkbox = await screen.findByRole('checkbox', {
      name: t('en', 'docs.selectAria', { title: 'contract.pdf' })
    })
    fireEvent.click(checkbox)
    listMessages.mockClear()
    fireEvent.click(screen.getByRole('button', { name: t('en', 'docs.askSelected', { count: 1 }) }))

    // The scoped documents chat WINS: documents mode selected, c1 NOT resurrected.
    const documentsSegment = await screen.findByRole('radio', {
      name: t('en', 'chat.mode.documents')
    })
    await waitFor(() => expect(documentsSegment).toHaveAttribute('aria-checked', 'true'))
    expect(conversationRow('Contract chat')).not.toHaveAttribute('aria-current')
    expect(listMessages).not.toHaveBeenCalledWith('c1')
  })
})

// #573: a chat's "Go to Documents" (a failed attachment to make searchable there) arms a one-shot
// return slot: Documents offers "‹ Back to chat", which reopens THAT conversation. Reaching
// Documents any other way offers nothing, and the rail's Chat keeps its plain chat-home landing.
describe('App — "Back to chat" after a failed attachment sent the user to Documents (#573)', () => {
  let bridge = chatDropBridge()
  const chatMain = (): Element => {
    const el = document.querySelector('.chat-main')
    if (!el) throw new Error('no .chat-main drop target')
    return el
  }

  function stubApp(): void {
    bridge = chatDropBridge()
    const scanChat = makeConversation({
      id: 'c1',
      title: 'Scan chat',
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [] }
    })
    const scan = makeDocumentInfo({
      id: 'd1',
      title: 'scan.pdf',
      status: 'failed',
      errorMessage: en['main.ingest.pdfScanDetected'],
      scanDetected: true,
      chunkCount: 0,
      sizeBytes: 2048
    })
    stubApi(
      chatScreenStubs({
        ...bridge.stubs,
        ...appShellStubs(),
        getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'm1', machineRamGb: 16, ocrAvailable: true })),
        listConversations: vi.fn(async () => [scanChat]),
        listDocuments: vi.fn(async () => [scan]),
        listAttachments: vi.fn(async () => [scan]),
        importDocuments: vi.fn(async () => ({ jobId: 'j1', documentIds: ['d1'] })),
        getImportJob: vi.fn(async () => ({ jobId: 'j1', total: 1, completed: 0, failed: 1, done: true }))
      })
    )
  }
  const backLabel = `‹ ${t('en', 'docs.backToChat')}`

  async function pointerToDocuments(nav: HTMLElement): Promise<void> {
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.chat') }))
    fireEvent.click(await screen.findByRole('button', { name: /^Scan chat/ }))
    await waitFor(() => expect(conversationRow('Scan chat')).toHaveAttribute('aria-current', 'true'))
    bridge.drop(chatMain(), 'scan.pdf', '/tmp/scan.pdf')
    fireEvent.click(await screen.findByRole('button', { name: t('en', 'chat.attach.goToDocuments') }))
    await screen.findByRole('heading', { name: t('en', 'docs.title') })
  }

  it('the pointer → Documents → Back to chat reopens the conversation the file was attached in', async () => {
    stubApp()
    render(<App />)
    const nav = await screen.findByRole('navigation')
    await pointerToDocuments(nav)

    fireEvent.click(await screen.findByRole('button', { name: backLabel }))
    await waitFor(() => expect(conversationRow('Scan chat')).toHaveAttribute('aria-current', 'true'))
  })

  it('Documents reached from the rail offers no way back, and the rail clears an armed one', async () => {
    stubApp()
    render(<App />)
    const nav = await screen.findByRole('navigation')

    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.documents') }))
    await screen.findByRole('heading', { name: t('en', 'docs.title') })
    expect(screen.queryByRole('button', { name: backLabel })).not.toBeInTheDocument()

    // Armed by the pointer, then the rail's Chat: the plain chat-home landing, unchanged…
    await pointerToDocuments(nav)
    expect(screen.getByRole('button', { name: backLabel })).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.chat') }))
    await screen.findByRole('button', { name: /^Scan chat/ })
    expect(conversationRow('Scan chat')).not.toHaveAttribute('aria-current')
    // …and the slot is spent: Documents again shows no Back.
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.documents') }))
    await screen.findByRole('heading', { name: t('en', 'docs.title') })
    expect(screen.queryByRole('button', { name: backLabel })).not.toBeInTheDocument()
  })
})
