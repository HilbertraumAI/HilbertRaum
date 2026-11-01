// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { TranslateScreen } from '../../src/renderer/screens/TranslateScreen'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import { ImagesScreen } from '../../src/renderer/screens/ImagesScreen'
import { PerformanceScreen } from '../../src/renderer/screens/PerformanceScreen'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { makeDetail, makeFreshness, stubReviewApi } from '../helpers/evidenceReview'
import { PrivacyTab } from '../../src/renderer/screens/settings/PrivacyTab'
import { DiagnosticsTab } from '../../src/renderer/screens/settings/DiagnosticsTab'
import { Banner, CoverageMeter, PasswordField, ToastProvider, type Translator } from '../../src/renderer/components'
import { t } from '../../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type AppStatus,
  type ModelInfo,
  type MovedDriveNotice,
  type PerformanceSnapshot,
  type RuntimeStatus
} from '../../src/shared/types'
import { stubHomeApi } from '../helpers/home-screen'
import { modelInfo, stubModelsApi } from '../helpers/model-fixtures'
import { laptopResult } from '../helpers/performance-screen'
import { renderInLanguage } from '../helpers/render-language'
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

/** A complete `performance:get` reply for the Performance smoke (PR #303 audit T6): a discrete
 *  card, an active model with an 8,192-token context (the localized number the smoke asserts)
 *  and no observation yet, so the "Your model" row shows the estimate copy. Every field the
 *  screen dereferences unguarded is present — `models`, `totals`, `recommendedContextTokens`,
 *  `observedMismatch`, `currentGpu`, `observed`. */
function perfSnapshot(): PerformanceSnapshot {
  return {
    current: laptopResult({ os: 'win32', measuredModelId: 'qwen', effectiveRead: null, recommendedModelId: 'qwen' }),
    currentMachine: true,
    // The live pick equals the saved one here, so the smoke's copy carries no "at the time of the
    // check" label (PR #308: `PerformanceSnapshot.recommendation`).
    recommendation: { modelId: 'qwen', basis: 'discrete' },
    currentGpu: null,
    graphicsDevice: null,
    otherMachines: [],
    running: false,
    placement: {
      memoryClass: 'discrete',
      ramMb: 16_077,
      vramMb: 24_822,
      model: { id: 'qwen', sizeOnDiskGb: 5.8, contextTokens: 8192 },
      recommendedContextTokens: 8192,
      observed: null,
      observedMismatch: null,
      verdict: { kind: 'gpu', needMb: 5939, estimated: true, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null },
      models: [],
      totals: { ramAllMb: null, bothOnCard: false, chatAndTranslationOnCard: false }
    },
    observed: { lastAnswer: null, lastModelLoad: null, lastChecksum: null }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('German render smokes (Phase 40)', () => {
  it('HomeScreen renders German', async () => {
    stubHomeApi({
      getAppStatus: vi.fn(async () => appStatus()),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      // §5 item 22 (a): the moved-drive notice is a Home surface, so it belongs in this smoke.
      // The restored case is the one that interpolates a date, which is where a German render
      // can go wrong on its own. A local time, no `Z`: a UTC instant is another day somewhere.
      getMovedDriveNotice: vi.fn(async (): Promise<MovedDriveNotice> => ({ kind: 'restored', ranAt: '2026-08-14T12:00:00' }))
    })
    renderInLanguage(<HomeScreen onNavigate={() => {}} />, 'de')

    expect(
      await screen.findByRole('button', { name: t('de', 'home.actions.startChat') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'home.headline.ready'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'home.workspace.label'))).toBeInTheDocument()
    expect(
      screen.getByText(t('de', 'home.moved.restored', { when: '14.8.2026' }))
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'perf.check') })).toBeInTheDocument()
  })

  it('ChatScreen renders German (empty state + composer)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(
        async (): Promise<RuntimeStatus> => ({ ...runningStatus, backend: 'cpu', gpuAutoDisabled: true })
      ),
      listDocuments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus())
    })
    renderInLanguage(<ChatScreen onNavigate={() => {}} />, 'de')

    expect(await screen.findByText(t('de', 'chat.empty.title'))).toBeInTheDocument()
    // The header hint's label helper gets the active-language t (D-L8).
    expect(await screen.findByText(t('de', 'chat.runtime.cpuCompat', { model: 'm1' }))).toBeInTheDocument()
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
    // #497: the status seeds no transcriber, so the "not installed" mic renders its German label.
    expect(
      await screen.findByRole('button', { name: t('de', 'chat.dictation.unavailable') })
    ).toBeInTheDocument()
  })

  it('DocumentsScreen renders German (empty state + section rail)', async () => {
    stubApi({
      listDocuments: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus())
    })
    renderInLanguage(<DocumentsScreen />, 'de')

    expect(
      await screen.findByRole('heading', { name: t('de', 'docs.title') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'docs.empty.title'))).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: t('de', 'docs.import.files') }).length
    ).toBeGreaterThan(0)
    // The decluttered section rail (§11.16) renders its German labels: the header's mode
    // switch, All documents, Recently added, and — with no project yet — the one "+ New
    // project" row (empty locations stay hidden, so no "More").
    expect(screen.getByRole('radio', { name: t('de', 'docs.mode.documents') })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: t('de', 'docs.mode.packs') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.section.all') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.smart.recentlyAdded') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('de', 'docs.section.newProject') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('de', 'docs.smart.more') })).toBeNull()
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
    renderInLanguage(<DocumentsScreen />, 'de')
    await screen.findByText('bericht.pdf')
    // The "Build deep index" action renders its German label inside the "⋯" overflow (§11.6).
    await user.click(screen.getByRole('button', { name: t('de', 'docs.moreActions', { title: 'bericht.pdf' }) }))
    expect(
      await screen.findByRole('menuitem', { name: t('de', 'docs.deepIndex.build') })
    ).toBeInTheDocument()
  })

  it('CoverageMeter renders its German breadth + depth copy (honesty layer)', () => {
    renderInLanguage(
      <CoverageMeter
        coverage={{ mode: 'tree', treeStatus: 'ready', chunksCovered: 40, chunksTotal: 40, tier: 1 }}
      />,
      'de'
    )
    expect(screen.getByText(t('de', 'coverage.tree.whole'))).toBeInTheDocument()
    expect(
      screen.getByText(t('de', 'coverage.depth', { label: t('de', 'coverage.tier.1') }))
    ).toBeInTheDocument()
  })

  it('CoverageMeter renders the German extract-listing copy (Phase 3 honesty)', () => {
    renderInLanguage(
      <CoverageMeter
        coverage={{ mode: 'extract', chunksCovered: 12, chunksTotal: 12, fullyChunked: true }}
      />,
      'de'
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
    renderInLanguage(<ChatScreen onNavigate={() => {}} initialMode="documents" />, 'de')
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
    renderInLanguage(<TranslateScreen onNavigate={() => {}} />, 'de')

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
    stubModelsApi({
      getPolicy: vi.fn(async () => {
        throw new Error('no policy')
      }),
      getAppStatus: vi.fn(async () => appStatus())
    })
    renderInLanguage(<ModelsScreen />, 'de')

    expect(
      await screen.findByRole('heading', { name: t('de', 'models.title') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'models.empty.title'))).toBeInTheDocument()
  })

  it('ModelsScreen renders the German vision card: where it is used + its button (#539)', async () => {
    stubModelsApi({
      listModels: vi.fn(async (): Promise<ModelInfo[]> => [
        modelInfo({
          id: 'qwen2.5-vl-3b-instruct-q4',
          displayName: 'Qwen2.5-VL 3B Instruct Q4',
          family: 'qwen2.5-vl',
          role: 'vision',
          localPath: 'models/vision/qwen2.5-vl.gguf',
          state: 'installed'
        })
      ]),
      getPolicy: vi.fn(async () => {
        throw new Error('no policy')
      }),
      getAppStatus: vi.fn(async () => appStatus())
    })
    const onNavigate = vi.fn()
    renderInLanguage(<ModelsScreen onNavigate={onNavigate} />, 'de')

    expect(await screen.findByText(t('de', 'models.vision.installed'))).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: t('de', 'models.vision.goToImages') }))
    expect(onNavigate).toHaveBeenCalledWith('images')
  })

  it('ImagesScreen renders the German PDF pointer and the OCR line (#539)', async () => {
    stubApi({
      imageGetStatus: vi.fn(async () => ({ available: true, modelId: 'v', modelDisplayName: 'V' })),
      imageChooseImage: vi.fn(async () => ({ token: 'tok', name: 'Scan.pdf', sizeBytes: 4 }))
    })
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    renderInLanguage(<ImagesScreen onNavigate={onNavigate} />, 'de')

    expect(await screen.findByText(t('de', 'images.avail.ocrPointer'))).toBeVisible()
    await user.click(screen.getByRole('button', { name: t('de', 'images.drop.choose') }))
    expect(await screen.findByText(t('de', 'images.err.pdf'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: t('de', 'images.err.pdfAction') }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
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
    renderInLanguage(<PrivacyTab />, 'de')

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
      }),
      // #327: the Acceleration line reads its device from the snapshot. Failing here too keeps
      // this smoke's premise — every read fails, the tab still renders — and covers the
      // best-effort fallback to the CPU wording in German.
      getPerformance: vi.fn(async () => {
        throw new Error('no snapshot')
      })
    })
    renderInLanguage(<DiagnosticsTab />, 'de')

    expect(
      await screen.findByRole('heading', { name: t('de', 'diag.bench.title') })
    ).toBeInTheDocument()
    // §5 item 22 (b): `getSettings` throws here, so there is no `lastBenchmark` — the card's
    // German EMPTY state must render (a heading over nothing was the state this replaced), and
    // the benchmark run button must be absent in German too, not just in English.
    expect(screen.getByText(t('de', 'diag.bench.empty'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Benchmark/i })).not.toBeInTheDocument()
    expect(screen.getByText(t('de', 'diag.localOnly'))).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: t('de', 'diag.activity.title') })
    ).toBeInTheDocument()
  })

  it('PerformanceScreen renders German (PR #303 audit T6)', async () => {
    stubApi({
      getPerformance: vi.fn(async () => perfSnapshot()),
      listModels: vi.fn(async () => [
        { id: 'qwen', displayName: 'Qwen', state: 'installed', recommended: true, recommendedContextTokens: 8192 }
      ] as unknown as ModelInfo[]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getAppStatus: vi.fn(async () => appStatus()),
      onEngineProblemsChanged: vi.fn(() => () => {}),
      onPerformanceChanged: vi.fn(() => () => {}),
      onBenchmarkProgress: vi.fn(() => () => {})
    })
    renderInLanguage(
      <ToastProvider>
        <PerformanceScreen onNavigate={() => {}} />
      </ToastProvider>,
      'de'
    )

    expect(await screen.findByRole('heading', { name: t('de', 'perf.title') })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: t('de', 'perf.card.title') })).toBeInTheDocument()
    expect(screen.getByText(t('de', 'perf.model.title'))).toBeInTheDocument()
    // The context size flows through the German locale's number format ("8.192", not "8,192").
    expect(screen.getByText(/8\.192/)).toBeInTheDocument()
    // Nothing English leaks past t() — the EN heading of the same card must be absent.
    expect(screen.queryByText(t('en', 'perf.card.title'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('en', 'perf.model.title'))).not.toBeInTheDocument()
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
    stubReviewApi({ getEvidenceReview: vi.fn(async () => makeDetail()) })
    renderInLanguage(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={() => {}} />, 'de')

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

  it('ReviewScreen outdated overlay renders German (EP-1 P4 — banner, chip, badge, context action)', async () => {
    resetReviewSessionForTests()
    stubReviewApi(
      { getEvidenceReview: vi.fn(async () => makeDetail()) },
      makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] })
    )
    renderInLanguage(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={() => {}} />, 'de')

    // Banner (§15.5) + acknowledge action + the ADDITIONAL Outdated chip.
    expect(await screen.findByText(t('de', 'review.outdated.title'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'review.outdated.acknowledge') })
    ).toBeInTheDocument()
    expect(screen.getByText(t('de', 'review.status.outdated'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'review.status.draft'))).toBeInTheDocument()
    // Per-card changed badge + the source-in-context action.
    expect(screen.getByText(t('de', 'review.source.changed'))).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'review.sourceContext.open') })
    ).toBeInTheDocument()
    resetReviewSessionForTests()
  })
})
