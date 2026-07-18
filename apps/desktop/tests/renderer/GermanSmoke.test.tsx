// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { TranslateScreen } from '../../src/renderer/screens/TranslateScreen'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { makeDetail } from '../helpers/evidenceReview'
import { PrivacyTab } from '../../src/renderer/screens/settings/PrivacyTab'
import { DiagnosticsTab } from '../../src/renderer/screens/settings/DiagnosticsTab'
import { Banner, CoverageMeter, PasswordField, type Translator } from '../../src/renderer/components'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t } from '../../src/shared/i18n'
import type { AppStatus, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase-40 German render smokes (i18n record §5): one per migrated screen. Each renders
// the screen inside I18nProvider with the pre-unlock localStorage mirror seeded 'de'
// (i18n record §3.2 / D-L3) and asserts a German string from the de catalog — proving the
// screen's copy actually flows through t() (an untranslated literal would stay English).
// Assertions reference the catalogs (D-L8), never re-typed literals.

function appStatus(over: Partial<AppStatus> = {}): AppStatus {
  return {
    appName: 'x',
    appVersion: '0',
    offlineMode: true,
    networkAllowed: false,
    activeModelId: 'm1',
    hardwareProfile: 'UNKNOWN',
    workspaceMode: 'plaintext_dev',
    workspaceReady: true,
    machineRamGb: 16,
    dictationAvailable: false,
    ...over
  } as AppStatus
}

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function german(node: ReactNode): JSX.Element {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
  return <I18nProvider>{node}</I18nProvider>
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

describe('German render smokes (Phase 40)', () => {
  it('HomeScreen renders German', async () => {
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => ({
        rootPath: 'x',
        writable: true,
        freeBytes: null,
        slowDriveWarning: null,
        problems: []
      })),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(german(<HomeScreen onNavigate={() => {}} />))

    expect(
      await screen.findByRole('button', { name: t('de', 'home.actions.startChat') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'home.headline.ready'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'home.workspace.label'))).toBeInTheDocument()
  })

  it('ChatScreen renders German (empty state + composer)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<ChatScreen onNavigate={() => {}} />))

    expect(await screen.findByText(t('de', 'chat.empty.title'))).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText(t('de', 'chat.placeholder.chat'))
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'chat.send.send') })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'chat.exampleChat.explain') })
    ).toBeInTheDocument()
    // The Phase-C attach affordance renders its German label (plan §11.2).
    expect(
      screen.getByRole('button', { name: t('de', 'chat.attach.button') })
    ).toBeInTheDocument()
  })

  it('DocumentsScreen renders German (empty state + section rail)', async () => {
    stubApi({
      listDocuments: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<DocumentsScreen />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'docs.title') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'docs.empty.title'))).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: t('de', 'docs.import.files') }).length
    ).toBeGreaterThan(0)
    // The regrouped section rail (§11.6) renders its German group headers + labels: the
    // Projects + Locations + Views headers, the system buckets under Locations, and the
    // common smart views (always visible).
    expect(screen.getByText(t('de', 'docs.section.projects'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'docs.section.locations'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'docs.smart.heading'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.section.library') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.section.generated') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.smart.recentlyAdded') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.smart.unfiled') })).toBeInTheDocument()
  })

  it('DocumentsScreen renders the German deep-index action + coverage meter (whole-document-analysis §5.2)', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [
        {
          id: 'd1',
          title: 'bericht.pdf',
          originalPath: null,
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          status: 'indexed' as const,
          errorMessage: null,
          chunkCount: 40,
          fullyChunked: true,
          treeStatus: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z'
        }
      ]),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<DocumentsScreen />))
    await screen.findByText('bericht.pdf')
    // The "Build deep index" action renders its German label inside the "⋯" overflow (§11.6).
    await user.click(screen.getByRole('button', { name: t('de', 'docs.moreActions', { title: 'bericht.pdf' }) }))
    expect(
      await screen.findByRole('menuitem', { name: t('de', 'docs.deepIndex.build') })
    ).toBeInTheDocument()
  })

  it('CoverageMeter renders its German breadth + depth copy (honesty layer)', () => {
    render(
      german(
        <CoverageMeter
          coverage={{ mode: 'tree', treeStatus: 'ready', chunksCovered: 40, chunksTotal: 40, tier: 1 }}
        />
      )
    )
    expect(screen.getByText(t('de', 'coverage.tree.whole'))).toBeInTheDocument()
    expect(
      screen.getByText(t('de', 'coverage.depth', { label: t('de', 'coverage.tier.1') }))
    ).toBeInTheDocument()
  })

  it('CoverageMeter renders the German extract-listing copy (Phase 3 honesty)', () => {
    render(
      german(
        <CoverageMeter
          coverage={{ mode: 'extract', chunksCovered: 12, chunksTotal: 12, fullyChunked: true }}
        />
      )
    )
    expect(screen.getByText(t('de', 'coverage.extract.whole', { scanned: 12 }))).toBeInTheDocument()
  })

  it('ChatScreen documents-mode renders the German source picker (plan §13)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => [
        {
          id: 'd1',
          title: 'contract.pdf',
          originalPath: null,
          mimeType: 'text/plain',
          sizeBytes: 1,
          status: 'indexed' as const,
          errorMessage: null,
          chunkCount: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z'
        }
      ]),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<ChatScreen onNavigate={() => {}} initialMode="documents" />))
    // The composer footer's "Answering from:" scope chip (D71) reads in German, and the whole-library
    // case names the corpus size (one indexed document here).
    const source = t('de', 'chat.scope.wholeLibrary.one', { count: 1 })
    expect(
      await screen.findByRole('button', {
        name: new RegExp(t('de', 'chat.scope.answeringFrom', { source }), 'i')
      })
    ).toBeInTheDocument()
  })

  it('TranslateScreen renders German (title + language bar + action)', async () => {
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ translationAvailable: true })),
      getActiveTranslateJob: vi.fn(async () => null)
    })
    render(german(<TranslateScreen onNavigate={() => {}} />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'translate.title') })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: t('de', 'translate.action') })
    ).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText(t('de', 'translate.input.placeholder'))
    ).toBeInTheDocument()
  })

  it('ModelsScreen renders German (empty manifests)', async () => {
    stubApi({
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({}) as never),
      getPolicy: vi.fn(async () => {
        throw new Error('no policy')
      }),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<ModelsScreen />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'models.title') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'models.empty.title'))).toBeInTheDocument()
  })

  it('PrivacyTab renders German', async () => {
    stubApi({
      getPolicy: vi.fn(async () => {
        throw new Error('no policy')
      }),
      getDriveStatus: vi.fn(async () => {
        throw new Error('no drive')
      }),
      getSettings: vi.fn(async () => {
        throw new Error('no settings')
      })
    })
    render(german(<PrivacyTab />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'privacy.network.title') })
    ).toBeInTheDocument()
    expect(screen.getByText(t('de', 'privacy.networkState.noPolicy'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'privacy.statement.offline'))).toBeInTheDocument()
  })

  it('DiagnosticsTab renders German', async () => {
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      getSettings: vi.fn(async () => {
        throw new Error('no settings')
      }),
      getDriveStatus: vi.fn(async () => {
        throw new Error('no drive')
      }),
      getRuntimeInstall: vi.fn(async () => {
        throw new Error('no install')
      })
    })
    render(german(<DiagnosticsTab />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'diag.bench.title') })
    ).toBeInTheDocument()
    expect(screen.getByText(t('de', 'diag.localOnly'))).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: t('de', 'diag.activity.title') })
    ).toBeInTheDocument()
  })

  it('shared components render their built-in copy from a received t (plan §5 ⑤)', () => {
    const deT: Translator = (key, params) => t('de', key, params)
    render(
      <>
        <Banner t={deT} onDismiss={() => {}}>
          x
        </Banner>
        <PasswordField
          placeholder="pw"
          value=""
          autoComplete="new-password"
          show={false}
          onToggleShow={() => {}}
          onChange={() => {}}
          t={deT}
        />
      </>
    )
    expect(screen.getByRole('button', { name: t('de', 'common.dismiss') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'password.show') })).toBeInTheDocument()
  })

  it('ReviewScreen renders German (EP-1 plan §7.7 — header, decisions, evidence caption)', async () => {
    resetReviewSessionForTests()
    stubApi({ getEvidenceReview: vi.fn(async () => makeDetail()) })
    render(german(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={() => {}} />))

    expect(
      await screen.findByRole('button', { name: `‹ ${t('de', 'review.back')}` })
    ).toBeInTheDocument()
    // The persist-canonical default title localizes through the display map (D-L4).
    expect(
      screen.getByRole('heading', { name: t('de', 'main.evidenceReviews.defaultTitle') })
    ).toBeInTheDocument()
    // Decision chips + evidence honesty caption + disclaimer flow through t().
    expect(
      screen.getAllByRole('radio', { name: new RegExp(t('de', 'review.decision.supported')) })
        .length
    ).toBeGreaterThan(0)
    expect(screen.getByText(t('de', 'review.evidence.captionRelevance'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'review.disclaimer'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'review.footer.summary') })
    ).toBeInTheDocument()
    resetReviewSessionForTests()
  })
})
