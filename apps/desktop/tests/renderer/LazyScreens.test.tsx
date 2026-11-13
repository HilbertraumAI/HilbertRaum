// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import { App } from '../../src/renderer/App'
import { t } from '../../src/shared/i18n'
import type { Conversation, Message } from '../../src/shared/types'
import { purgeReviewSession } from '../../src/renderer/lib/reviewSession'
import { appShellStubs } from '../helpers/app-shell'
import { chatScreenStubs } from '../helpers/chat-screen'
import { modelsScreenStubs } from '../helpers/model-fixtures'
import { LAZY_SCREEN_WAIT } from '../helpers/hang-budget'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { appStatus, runtimeStatus } from '../helpers/status'
import { makeDetail, stubReviewApi } from '../helpers/evidenceReview'

// Route-level code split (full-audit 2026-07-10 PF-6): Documents/Translate/Images/Models/
// Settings/Skills are React.lazy chunks behind the per-screen ErrorBoundary's Suspense.
// This pins the boundary's user-visible contract: navigating to a lazy screen first shows
// the quiet localized loading fallback, then the real screen replaces it. The other
// full-<App/> suites (AppLock, I18n, InformationArchitecture) keep covering that every
// destination still RENDERS; this one covers the fallback → content sequence itself.

// The screens behind each boundary read a stubbed bridge (#815): an unmocked call answers
// `undefined`, so a screen would render its error path while the fallback assertions still passed.
afterEach(() => {
  cleanup()
  purgeReviewSession()
  assertNoUnexpectedApiCalls()
})

function stubAppShell(): void {
  stubApi(
    appShellStubs({
      ...modelsScreenStubs(),
      getAppStatus: vi.fn(async () => appStatus({ appName: 'x', appVersion: '0', machineRamGb: 16 })),
      getRuntimeInstall: vi.fn(async () => null)
    })
  )
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
      await screen.findByRole('heading', { name: t('en', 'models.title') }, LAZY_SCREEN_WAIT)
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
    // The chat surface's calm reads first, the shell's defaults over them, this flow's own data
    // last; `stubReviewApi` adds the freshness read every review open makes.
    stubReviewApi({
      ...chatScreenStubs(),
      ...appShellStubs({
        getAppStatus: vi.fn(async () => appStatus({ appName: 'x', appVersion: '0', activeModelId: 'm1', machineRamGb: 16 })),
        // …plus the chat surface this flow drives (a running model so the chat gate opens):
        listConversations: vi.fn(async () => [conversation]),
        listMessages: vi.fn(async () => messages),
        getRuntimeStatus: vi.fn(async () => runtimeStatus({ warmedUp: undefined })),
        getEvidenceReviewForMessage: vi.fn(async () => null),
        createEvidenceReview: vi.fn(async () => makeDetail({ messageId: 'm2' }))
      })
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
      await screen.findByRole('heading', { name: t('en', 'main.evidenceReviews.defaultTitle') }, LAZY_SCREEN_WAIT)
    ).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'app.loadingScreen'))).not.toBeInTheDocument()

    // Back → chat (the review screen's own back action, no rail entry involved).
    fireEvent.click(screen.getByRole('button', { name: `‹ ${t('en', 'review.back')}` }))
    expect(await screen.findByRole('button', { name: /^Contract chat/ })).toBeInTheDocument()
  })
})
