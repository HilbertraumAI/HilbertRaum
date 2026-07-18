// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import { App } from '../../src/renderer/App'
import { t } from '../../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type AppStatus,
  type Conversation,
  type Message,
  type PolicyStatus,
  type PreflightResult,
  type WorkspaceStateInfo
} from '../../src/shared/types'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { stubApi } from '../helpers/renderer'
import { makeDetail } from '../helpers/evidenceReview'

// Route-level code split (full-audit 2026-07-10 PF-6): Documents/Translate/Images/Models/
// Settings/Skills are React.lazy chunks behind the per-screen ErrorBoundary's Suspense.
// This pins the boundary's user-visible contract: navigating to a lazy screen first shows
// the quiet localized loading fallback, then the real screen replaces it. The other
// full-<App/> suites (AppLock, I18n, InformationArchitecture) keep covering that every
// destination still RENDERS; this one covers the fallback → content sequence itself.

afterEach(() => {
  cleanup()
  resetReviewSessionForTests()
})

// jsdom implements neither element scrolling nor scrollTo; the chat transcript's
// autoscroll effect would otherwise crash when the review-handoff test mounts it.
beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

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

function stubAppShell(): void {
  stubApi({
    getWorkspaceState: vi.fn(async () => unlockedWorkspace),
    getPolicy: vi.fn(async () => offlinePolicy),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    onRuntimeNotice: vi.fn(() => () => {}) as never,
    // Home (the default, eager screen) readiness data:
    getAppStatus: vi.fn(async () => ({
      appName: 'x',
      appVersion: '0',
      offlineMode: true,
      networkAllowed: false,
      activeModelId: null,
      hardwareProfile: 'UNKNOWN' as const,
      workspaceMode: 'plaintext_dev' as const,
      workspaceReady: true,
      machineRamGb: 16,
      dictationAvailable: false
    })),
    getRuntimeStatus: vi.fn(async () => ({
      running: false,
      modelId: null,
      port: null,
      healthy: false,
      message: 'Stopped'
    })),
    listDocuments: vi.fn(async () => []),
    runPreflight: vi.fn(async () => ({
      ok: true,
      rootPath: '/drive',
      writable: true,
      freeBytes: 1024 * 1024 * 1024,
      slowDriveWarning: null,
      problems: []
    })),
    // The lazy AI Model screen's data:
    listModels: vi.fn(async () => []),
    getRuntimeInstall: vi.fn(async () => null)
  } as never)
}

describe('lazy screens — suspense fallback → content (PF-6)', () => {
  it('navigating to a lazy screen shows the loading fallback, then the screen replaces it', async () => {
    stubAppShell()
    render(<App />)
    const nav = await screen.findByRole('navigation')

    // fireEvent, NOT userEvent: the synchronous dispatch is the deterministic gate here.
    // A dynamic import can never resolve synchronously, so immediately after the click the
    // lazy screen is guaranteed still suspended — no sleep, no race with the module cache.
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.models') }))
    const fallback = screen.getByText(t('en', 'app.loadingScreen'))
    expect(fallback).toBeInTheDocument()
    // The quiet fallback is a busy .screen container (guidelines §6: no unlabeled spinner).
    expect(fallback.closest('.screen')).toHaveAttribute('aria-busy', 'true')

    // …then the chunk resolves and the real screen replaces the fallback.
    expect(
      await screen.findByRole('heading', { name: t('en', 'models.title') })
    ).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'app.loadingScreen'))).not.toBeInTheDocument()
  })

  it('the review screen is a lazy chunk reached ONLY via the chat handoff (EP-1 plan §7.1)', async () => {
    const conversation: Conversation = {
      id: 'c1',
      title: 'Contract chat',
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T10:00:00.000Z',
      modelId: 'm1',
      mode: 'documents',
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
    stubApi({
      // The app-shell base (same shape stubAppShell installs)… Typed against the real
      // bridge contract; the two partial DTOs use NARROW named casts (the F-41 rule —
      // never a blanket `as never`).
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
      // …plus the chat surface this flow drives (a running model so the chat gate opens):
      listConversations: vi.fn(async () => [conversation]),
      listMessages: vi.fn(async () => messages),
      listDocuments: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => ({
        running: true,
        modelId: 'm1',
        port: 1234,
        healthy: true,
        message: 'ok'
      })),
      getEvidenceReviewForMessage: vi.fn(async () => null),
      createEvidenceReview: vi.fn(async () => makeDetail({ messageId: 'm2' }))
    })
    render(<App />)
    const nav = await screen.findByRole('navigation')

    // The nav rail carries NO review destination (IA: review is handoff-only).
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.chat') }))
    fireEvent.click(await screen.findByRole('button', { name: /^Contract chat/ }))
    await screen.findByText(/90 days notice/)

    // The synchronous-click gate: right after the handoff click the review chunk cannot
    // have resolved, so the quiet fallback shows…
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.action.start') }))
    expect(screen.getByText(t('en', 'app.loadingScreen'))).toBeInTheDocument()

    // …then the review workspace replaces it, created via the idempotent evidence create.
    expect(
      await screen.findByRole('heading', { name: t('en', 'main.evidenceReviews.defaultTitle') })
    ).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'app.loadingScreen'))).not.toBeInTheDocument()

    // Back → chat (the review screen's own back action, no rail entry involved).
    fireEvent.click(screen.getByRole('button', { name: `‹ ${t('en', 'review.back')}` }))
    expect(await screen.findByRole('button', { name: /^Contract chat/ })).toBeInTheDocument()
  })
})
