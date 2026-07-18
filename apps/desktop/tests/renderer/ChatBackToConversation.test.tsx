// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { App } from '../../src/renderer/App'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { t } from '../../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AppStatus,
  type Conversation,
  type DocumentInfo,
  type Message,
  type PolicyStatus,
  type PreflightResult,
  type RuntimeStatus,
  type WorkspaceStateInfo
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { makeDetail } from '../helpers/evidenceReview'

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

const idleStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
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

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function baseStubs(conversations: Conversation[]) {
  return {
    listConversations: vi.fn(async () => conversations),
    getRuntimeStatus: vi.fn(async () => idleStatus),
    listMessages: vi.fn(async () => []),
    listDocuments: vi.fn(async () => []),
    listCollections: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getAppStatus: vi.fn(async () => ({ dictationAvailable: false }) as AppStatus),
    getActiveStream: vi.fn(async () => null),
    listActiveStreamConversations: vi.fn(async () => []),
    getConversationContextUsage: vi.fn(async () => null),
    getConversationSummary: vi.fn(async () => null),
    listSkillRuns: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({}) as AppSettings)
  }
}

/** The conversation-row button (`.chat-conv`) for a title, or null. The title also appears
 *  in the row's "⋯" aria-label, so role+name lookups are ambiguous — query the row class. */
function convRow(title: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('.chat-conv')).find((el) =>
      (el.textContent ?? '').includes(title)
    ) ?? null
  )
}

describe('ChatScreen — back-to-originating-conversation handoff (P5)', () => {
  it('selects the handed-off conversation on mount (history loads, row current, mode mirrors)', async () => {
    const stubs = baseStubs([conv('c1'), conv('c2', { mode: 'documents' })])
    stubApi(stubs)
    render(
      <ChatScreen onNavigate={() => {}} initialConversationId="c2" onOpenReview={() => {}} />
    )

    // The re-attach effect resolved: c2 is the ACTIVE conversation.
    await waitFor(() => expect(stubs.listMessages).toHaveBeenCalledWith('c2'))
    await waitFor(() =>
      expect(convRow('Conversation c2')).toHaveAttribute('aria-current', 'true')
    )
    // Never a spurious load of some other conversation.
    expect(stubs.listMessages).not.toHaveBeenCalledWith('c1')
  })

  it('an unknown (deleted) id degrades to chat home — nothing selected, nothing loaded', async () => {
    const stubs = baseStubs([conv('c1')])
    stubApi(stubs)
    render(
      <ChatScreen onNavigate={() => {}} initialConversationId="gone" onOpenReview={() => {}} />
    )

    // Let the mount + re-attach effects settle, then: no history load, no current row.
    await waitFor(() => expect(convRow('Conversation c1')).not.toBeNull())
    expect(stubs.listMessages).not.toHaveBeenCalled()
    expect(convRow('Conversation c1')).not.toHaveAttribute('aria-current')
  })

  it('without a handoff the mount stays on chat home (baseline unchanged)', async () => {
    const stubs = baseStubs([conv('c1')])
    stubApi(stubs)
    render(<ChatScreen onNavigate={() => {}} onOpenReview={() => {}} />)

    await waitFor(() => expect(convRow('Conversation c1')).not.toBeNull())
    expect(stubs.listMessages).not.toHaveBeenCalled()
  })
})

// ---- App-level handoff-slot lifecycle (review FIX-1) -----------------------------------

const unlockedWorkspace: WorkspaceStateInfo = {
  state: 'unlocked',
  mode: 'plaintext_dev',
  plaintextAllowed: true,
  encryptionRequired: false
}

const offlinePolicy = {
  policy: {
    network: { allowModelDownloads: false, allowUpdateChecks: false, allowTelemetry: false },
    workspace: { encryptionRequired: false, allowPlaintextDevMode: true },
    models: { allowUnverifiedModels: true, requireManifest: true, requireSha256Match: false }
  },
  policyFilePresent: false,
  driveFilePresent: false,
  allowNetworkSetting: false,
  networkAllowedByPolicy: false,
  networkAllowed: false,
  offlineMode: true,
  telemetryAllowed: false
} as PolicyStatus

describe('App — the back-handoff slot is one-shot across EVERY chat mount path (FIX-1)', () => {
  afterEach(() => {
    resetReviewSessionForTests()
  })

  it('review → back (slot works once) → Documents → "Ask these documents" wins: documents mode, no resurrected conversation', async () => {
    // c1 is a CHAT-mode conversation (its answer is eligible via citations), so a
    // resurrected re-attach would ALSO stomp the composer mode — both asserted below.
    const conversation: Conversation = {
      id: 'c1',
      title: 'Contract chat',
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T10:00:00.000Z',
      modelId: 'm1',
      mode: 'chat',
      scopeDocumentIds: null,
      collectionId: null
    } as Conversation
    const messages: Message[] = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: 'What does the contract say?',
        createdAt: '2026-07-18T09:59:00.000Z'
      },
      {
        id: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        content: 'It can be terminated with 90 days notice. [S1]',
        createdAt: '2026-07-18T10:00:00.000Z',
        citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 12, snippet: '…' }]
      }
    ]
    const doc = {
      id: 'd1',
      title: 'contract.pdf',
      originalPath: null,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      status: 'indexed',
      errorMessage: null,
      chunkCount: 3
    } as DocumentInfo
    const listMessages = vi.fn(async () => messages)
    stubApi({
      getWorkspaceState: vi.fn(async () => unlockedWorkspace),
      getPolicy: vi.fn(async () => offlinePolicy),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      onRuntimeNotice: vi.fn(() => () => {}),
      getAppStatus: vi.fn(
        async () =>
          ({
            appName: 'x',
            appVersion: '0',
            offlineMode: true,
            networkAllowed: false,
            activeModelId: 'm1',
            hardwareProfile: 'UNKNOWN',
            workspaceMode: 'plaintext_dev',
            workspaceReady: true,
            machineRamGb: 16,
            dictationAvailable: false
          }) as AppStatus
      ),
      runPreflight: vi.fn(
        async () =>
          ({
            ok: true,
            rootPath: '/drive',
            writable: true,
            freeBytes: 1024 * 1024 * 1024,
            slowDriveWarning: null,
            problems: []
          }) as unknown as PreflightResult
      ),
      listConversations: vi.fn(async () => [conversation]),
      listMessages,
      listDocuments: vi.fn(async () => [doc]),
      listCollections: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => ({
        running: true,
        modelId: 'm1',
        port: 1234,
        healthy: true,
        message: 'ok'
      })),
      getEvidenceReviewForMessage: vi.fn(async () => null),
      createEvidenceReview: vi.fn(async () =>
        makeDetail({ conversationId: 'c1', messageId: 'm2' })
      )
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
    await waitFor(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.chat-conv')).find((el) =>
        (el.textContent ?? '').includes('Contract chat')
      )
      expect(row).toHaveAttribute('aria-current', 'true')
    })

    // Rail → Documents (no chatMode on this navigation — the slot must not survive it
    // into the NEXT chat mount), then "Ask these documents".
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.documents') }))
    const checkbox = await screen.findByRole('checkbox', {
      name: t('en', 'docs.selectAria', { title: 'contract.pdf' })
    })
    fireEvent.click(checkbox)
    listMessages.mockClear()
    fireEvent.click(
      screen.getByRole('button', { name: t('en', 'docs.askSelected', { count: 1 }) })
    )

    // The scoped documents chat WINS: documents mode selected, c1 NOT resurrected.
    const documentsSegment = await screen.findByRole('radio', {
      name: t('en', 'chat.mode.documents')
    })
    await waitFor(() => expect(documentsSegment).toHaveAttribute('aria-checked', 'true'))
    const c1Row = Array.from(document.querySelectorAll<HTMLElement>('.chat-conv')).find((el) =>
      (el.textContent ?? '').includes('Contract chat')
    )
    expect(c1Row).not.toHaveAttribute('aria-current')
    expect(listMessages).not.toHaveBeenCalledWith('c1')
  })
})
