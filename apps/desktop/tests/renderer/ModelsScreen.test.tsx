// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ModelsScreen,
  __resetModelsScreenMemoryForTests
} from '../../src/renderer/screens/ModelsScreen'
import {
  DEFAULT_SETTINGS,
  type AppStatus,
  type DownloadJob,
  type EngineStatus,
  type ModelInfo,
  type PolicyStatus,
  type RuntimeStatus
} from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { appStatus as appStatusFixture, makePolicyStatus } from '../helpers/status'
import { groupModelVariants, variantGroupFace } from '../../src/renderer/lib/modelLibrary'
import { orderPickerModels } from '../../src/renderer/lib/modelAvailability'

// Phase 18 — the Models screen download surface: the gate states (why downloads are
// unavailable: policy vs. Settings), the per-download confirmation (license
// acknowledgement when the review is not approved), and the progress/cancel affordance.

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'qwen3-4b-instruct-q4',
    displayName: 'Qwen3 4B Instruct',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    sizeOnDiskGb: 2.7,
    recommendedMinRamGb: 8,
    recommendedRamGb: 16,
    recommendedContextTokens: 4096,
    localPath: 'models/chat/qwen3-4b-instruct-q4.gguf',
    state: 'missing',
    recommended: false,
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sizeBytes: 2_900_000_000,
      licenseUrl: 'https://example.test/license',
      licenseApproved: true
    },
    ...over
  }
}

function policyStatus(opts: { downloadsAllowed: boolean; settingOn: boolean }): PolicyStatus {
  return makePolicyStatus({
    network: { allowModelDownloads: opts.downloadsAllowed },
    allowNetworkSetting: opts.settingOn
  })
}

const appStatus = { machineRamGb: 32 } as unknown as AppStatus

function stub(opts: {
  models?: ModelInfo[]
  policy?: PolicyStatus
  activeModelId?: string | null
  downloadModel?: ReturnType<typeof vi.fn>
  getDownloadJob?: ReturnType<typeof vi.fn>
}): void {
  stubApi({
    listModels: vi.fn(async () => opts.models ?? [model()]),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, activeModelId: opts.activeModelId ?? null })),
    getPolicy: vi.fn(async () => opts.policy ?? policyStatus({ downloadsAllowed: true, settingOn: true })),
    getAppStatus: vi.fn(async () => appStatus),
    downloadModel: (opts.downloadModel ?? vi.fn()),
    getDownloadJob: (opts.getDownloadJob ?? vi.fn())
  })
}

afterEach(cleanup)

// The screen deliberately keeps the download job, its model's name and any dismissed result in
// MODULE state so leaving and re-entering the screen resumes/restores them. Tests must therefore
// start from a known state instead of inheriting whatever the previous case left behind.
beforeEach(() => {
  __resetModelsScreenMemoryForTests()
})

describe('ModelsScreen — download gates (plan §6.1: explain WHY, policy vs Settings)', () => {
  it('disables Download and explains when the drive policy denies downloads', async () => {
    stub({ policy: policyStatus({ downloadsAllowed: false, settingOn: true }) })
    render(<ModelsScreen />)
    const btn = await screen.findByRole('button', { name: 'Download' })
    expect(btn).toBeDisabled()
    expect(screen.getByText(/disabled by this drive’s policy/)).toBeInTheDocument()
    expect(screen.queryByText(/in Settings/)).not.toBeInTheDocument()
  })

  it('disables Download and points at the Settings toggle when allowNetwork is off', async () => {
    stub({ policy: policyStatus({ downloadsAllowed: true, settingOn: false }) })
    render(<ModelsScreen />)
    const btn = await screen.findByRole('button', { name: 'Download' })
    expect(btn).toBeDisabled()
    expect(
      screen.getByText(/turn on “Allow internet access for model downloads and updates” in Settings/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/drive’s policy/)).not.toBeInTheDocument()
  })

  it('shows no Download affordance for an installed model', async () => {
    stub({ models: [model({ state: 'installed' })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
  })

  it('shows no Download affordance when the manifest has no download block', async () => {
    stub({ models: [model({ download: undefined })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
  })

  // Issue #196: unsloth deleted the Qwen3.8 files three manifests pin. A Download button there
  // could only end in an HTTP 404 that reads like a broken connection — so the card explains
  // instead, and says what still works.
  describe('a withdrawn upstream source (#196)', () => {
    const gone = (over: Partial<ModelInfo> = {}): ModelInfo =>
      model({
        download: {
          url: 'https://example.test/qwen3-4b.gguf',
          sizeBytes: 2_900_000_000,
          licenseUrl: 'https://example.test/license',
          licenseApproved: true,
          withdrawn: '2026-08-20: upstream deleted the file'
        },
        ...over
      })

    it('replaces the Download button with the reason, naming what still works', async () => {
      stub({ models: [gone()] })
      render(<ModelsScreen />)
      await screen.findByText('Qwen3 4B Instruct')
      expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
      expect(screen.getByText(/No longer available for download/)).toBeInTheDocument()
      expect(screen.getByText(/2026-08-20: upstream deleted the file/)).toBeInTheDocument()
      expect(screen.getByText(/Copies already on a drive keep working/)).toBeInTheDocument()
    })

    it('does not raise the network-gate banner when the only "missing" model is unfetchable', async () => {
      // Downloads disabled by policy + nothing downloadable ⇒ the banner would blame the drive
      // policy for a model the policy has nothing to do with.
      stub({ models: [gone()], policy: policyStatus({ downloadsAllowed: false, settingOn: true }) })
      render(<ModelsScreen />)
      await screen.findByText('Qwen3 4B Instruct')
      expect(screen.queryByText(/disabled by this drive’s policy/)).not.toBeInTheDocument()
    })

    it('says nothing on a card whose weight is already installed', async () => {
      stub({ models: [gone({ state: 'installed' })] })
      render(<ModelsScreen />)
      await screen.findByText('Qwen3 4B Instruct')
      expect(screen.queryByText(/No longer available for download/)).not.toBeInTheDocument()
    })
  })
})

describe('ModelsScreen — "AI Model" reframe (Phase 26, guidelines §2)', () => {
  it('keeps checksums/paths/internals behind a closed-by-default "Technical details" disclosure', async () => {
    const user = userEvent.setup()
    stub({ models: [model({ state: 'installed' })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')

    // The plain-language hint is the everyday copy (2.7 GB → the "balanced" tier).
    expect(screen.getByText(/Balanced — works well on most laptops/)).toBeInTheDocument()

    // Closed by default: the technical content exists but is not shown.
    const details = document.querySelector('details.tech-details') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(screen.getByText('models/chat/qwen3-4b-instruct-q4.gguf')).not.toBeVisible()
    expect(screen.getByRole('button', { name: /verify checksum/i })).not.toBeVisible()

    // Opening the disclosure reveals path + checksum re-verify.
    await user.click(screen.getByText('Technical details'))
    expect(screen.getByText('models/chat/qwen3-4b-instruct-q4.gguf')).toBeVisible()
    expect(screen.getByRole('button', { name: /verify checksum/i })).toBeVisible()

    // M-U5: the manifest GB figures route through fmtGbNum (locale-aware). In EN the
    // value is byte-identical to the old raw render; the point is they go through the
    // formatter so a German UI gets "2,7 GB" / grouped numbers instead of raw output.
    const tech = within(details)
    expect(tech.getByText('2.7 GB')).toBeVisible() // size on disk
    expect(tech.getByText('8 GB')).toBeVisible() // minimum RAM
    expect(tech.getByText('16 GB')).toBeVisible() // recommended RAM
  })

  it('puts the active model first under "Your AI model"', async () => {
    stub({
      models: [
        model({ id: 'other-model', displayName: 'Other Model', state: 'installed' }),
        model({ id: 'active-model', displayName: 'Active Model', state: 'running' })
      ],
      activeModelId: 'active-model'
    })
    render(<ModelsScreen />)
    await screen.findByText('Active Model')

    expect(screen.getByText('Your AI model')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Model library' })).toBeInTheDocument()
    // DOM order: the active model's card precedes the picker.
    const titles = [...document.querySelectorAll('.model-title')].map((el) => el.textContent)
    expect(titles).toEqual(['Active Model', 'Other Model'])
  })
})

describe('ModelsScreen — automatic roles (Phase 36: reranker/transcriber)', () => {
  function transcriber(over: Partial<ModelInfo> = {}): ModelInfo {
    return model({
      id: 'whisper-small-multilingual',
      displayName: 'Whisper Small (multilingual transcriber)',
      family: 'whisper',
      role: 'transcriber',
      format: 'ggml',
      runtime: 'whisper_cpp',
      license: 'mit',
      sizeOnDiskGb: 0.49,
      localPath: 'models/transcriber/ggml-small.bin',
      ...over
    })
  }

  it('offers Download for a missing transcriber — never Select/Start', async () => {
    stub({ models: [transcriber({ state: 'missing' })] })
    render(<ModelsScreen />)
    await screen.findByText('Whisper Small (multilingual transcriber)')

    // The whole point of the support-matrix fix: the card is downloadable, not
    // "Unsupported", and explains it works automatically.
    expect(screen.getByText('Not downloaded')).toBeInTheDocument()
    expect(screen.queryByText('Unsupported')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
    expect(screen.getByText(/used automatically once installed/i)).toBeInTheDocument()
    // Selecting/starting a transcriber would claim the CHAT slot / feed GGML to
    // llama-server — those actions must not exist on automatic-role cards.
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start.*runtime/i })).not.toBeInTheDocument()
  })

  it('an installed transcriber says it is in use automatically (nothing to start)', async () => {
    stub({ models: [transcriber({ state: 'installed', download: undefined })] })
    render(<ModelsScreen />)
    await screen.findByText('Whisper Small (multilingual transcriber)')
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(screen.getByText(/Installed — used automatically/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Turns audio recordings into searchable text/)).toBeInTheDocument()
  })

  it('offers Download for a missing vision model — never Select/Start', async () => {
    stub({
      models: [
        model({
          id: 'qwen2.5-vl-3b-instruct-q4',
          displayName: 'Qwen2.5-VL 3B Instruct Q4',
          role: 'vision',
          state: 'missing'
        })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('Qwen2.5-VL 3B Instruct Q4')
    // Downloadable in-app, and explained as a Images-tab capability — not the chat slot.
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
    expect(screen.getByText(/available in the Images tab once installed/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start.*runtime/i })).not.toBeInTheDocument()
  })

  it('an installed vision model points to the Images tab — never Select/Start', async () => {
    stub({
      models: [
        model({
          id: 'qwen2.5-vl-3b-instruct-q4',
          displayName: 'Qwen2.5-VL 3B Instruct Q4',
          role: 'vision',
          state: 'installed',
          download: undefined
        })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('Qwen2.5-VL 3B Instruct Q4')
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(screen.getByText(/ready in the Images tab/i)).toBeInTheDocument()
    // Selecting/starting a vision model would claim the CHAT runtime slot and throw
    // (registerModelIpc rejects a non-chat role) — those actions must not exist here.
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start.*runtime/i })).not.toBeInTheDocument()
  })

  it('offers Download for a missing translation model — never Select/Start (TG-1)', async () => {
    stub({
      models: [
        model({
          id: 'translategemma-12b-it-q4',
          displayName: 'TranslateGemma 12B (Q4_K_M)',
          role: 'translation',
          license: 'gemma',
          sizeOnDiskGb: 7.3,
          state: 'missing'
        })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('TranslateGemma 12B (Q4_K_M)')
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
    expect(screen.getByText(/used automatically for translation once installed/i)).toBeInTheDocument()
    // Availability-driven role (like reranker/vision): no chat-slot Select/Start.
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start.*runtime/i })).not.toBeInTheDocument()
  })

  it('an installed translation model says it is used automatically — never Select/Start (TG-1)', async () => {
    stub({
      models: [
        model({
          id: 'translategemma-12b-it-q4',
          displayName: 'TranslateGemma 12B (Q4_K_M)',
          role: 'translation',
          license: 'gemma',
          sizeOnDiskGb: 7.3,
          state: 'installed',
          download: undefined
        })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('TranslateGemma 12B (Q4_K_M)')
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(screen.getByText(/used automatically for translation/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start.*runtime/i })).not.toBeInTheDocument()
  })

  it('the reranker card gets the same automatic treatment', async () => {
    stub({
      models: [
        model({
          id: 'bge-reranker-v2-m3-f16',
          displayName: 'BGE Reranker v2 M3 (F16)',
          role: 'reranker',
          state: 'installed',
          download: undefined
        })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('BGE Reranker v2 M3 (F16)')
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start.*runtime/i })).not.toBeInTheDocument()
    expect(screen.getByText(/used automatically/i)).toBeInTheDocument()
  })
})

describe('ModelsScreen — de-jargoned + tidy per-card buttons (§3/§7)', () => {
  it('hides the disabled "Select" for a not-downloaded model — Download is the one clear action', async () => {
    stub({ models: [model({ state: 'missing' })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    // Before the weights exist, "Select" / "Start runtime" are noise — not rendered.
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start runtime/i })).not.toBeInTheDocument()
    // The single clear action remains.
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })

  it('shows the merged "Use this model" action once the model is downloaded (installed)', async () => {
    // Beta #27 (D70): Select + Start runtime collapsed into ONE primary action.
    stub({ models: [model({ state: 'installed' })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.getByRole('button', { name: t('en', 'models.use') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start runtime/i })).not.toBeInTheDocument()
  })

  it('labels the demo affordance "Try in demo mode" — no "mock runtime" jargon', async () => {
    // Developer-only, gated in MAIN via `startableAsMock`; when offered it reads as the
    // banner's "demo mode (visibly simulated answers)", not "Start mock runtime".
    stub({ models: [model({ state: 'missing', startableAsMock: true })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.getByRole('button', { name: 'Try in demo mode' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mock runtime/i })).not.toBeInTheDocument()
  })
})

// Beta #27 (D70): a first-time user faced a "Select" AND a "Start runtime" button per installed
// chat model and couldn't tell which led to chatting. They collapse into ONE primary "Use this
// model" action (select + start via the useModel IPC). Stop / Starting… / the demo card stay.
describe('ModelsScreen — one "Use this model" action (beta #27, D70 collapse)', () => {
  function startingStatus(modelId: string): RuntimeStatus {
    return { running: false, modelId: null, startingModelId: modelId, port: null, healthy: false, message: '' }
  }

  it('shows exactly ONE primary "Use this model" action per installed card — no Select / Start runtime', async () => {
    stub({ models: [model({ state: 'installed' })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.getByRole('button', { name: t('en', 'models.use') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start runtime/i })).not.toBeInTheDocument()
  })

  it('the action calls window.api.useModel (select + start in one) and is enabled for an installed model', async () => {
    const useModel = vi.fn(async () => ({ running: true }) as RuntimeStatus)
    stub({ models: [model({ state: 'installed' })] })
    ;(window.api as unknown as { useModel: typeof useModel }).useModel = useModel
    const user = userEvent.setup()
    render(<ModelsScreen />)
    const btn = await screen.findByRole('button', { name: t('en', 'models.use') })
    expect(btn).toBeEnabled()
    await user.click(btn)
    expect(useModel).toHaveBeenCalledWith('qwen3-4b-instruct-q4')
  })

  it('disables the action while this machine has too little RAM', async () => {
    stub({ models: [model({ state: 'installed', insufficientRam: true })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.getByRole('button', { name: t('en', 'models.use') })).toBeDisabled()
  })

  it('shows the disabled Starting… spinner for the in-flight model instead of the action', async () => {
    stub({ models: [model({ state: 'installed' })] })
    ;(window.api as unknown as { getRuntimeStatus: () => Promise<RuntimeStatus> }).getRuntimeStatus =
      vi.fn(async () => startingStatus('qwen3-4b-instruct-q4'))
    render(<ModelsScreen />)
    expect(await screen.findByText(t('en', 'models.starting'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'models.use') })).not.toBeInTheDocument()
  })

  it('disables the action on OTHER cards while some model is starting (anyStarting)', async () => {
    stub({
      models: [
        model({ id: 'other-installed', displayName: 'Other Installed', state: 'installed' }),
        model({ id: 'loading', displayName: 'Loading Model', state: 'installed' })
      ]
    })
    ;(window.api as unknown as { getRuntimeStatus: () => Promise<RuntimeStatus> }).getRuntimeStatus =
      vi.fn(async () => startingStatus('loading'))
    render(<ModelsScreen />)
    await screen.findByText('Other Installed')
    // The one not starting still shows "Use this model", but it is disabled while another loads.
    expect(screen.getByRole('button', { name: t('en', 'models.use') })).toBeDisabled()
  })

  it('shows Stop (not the Use action) when the model is running', async () => {
    stub({ models: [model({ state: 'running' })], activeModelId: 'qwen3-4b-instruct-q4' })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.getByRole('button', { name: t('en', 'models.stopRuntime') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'models.use') })).not.toBeInTheDocument()
  })

  it('still offers the demo-mode button on the zero-weights developer card (no Use action)', async () => {
    stub({ models: [model({ state: 'missing', startableAsMock: true })] })
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(screen.getByRole('button', { name: t('en', 'models.startMock') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'models.use') })).not.toBeInTheDocument()
  })

  it('renders the German label for the collapsed action (D-L8: asserted from the catalog)', async () => {
    stub({ models: [model({ state: 'installed' })] })
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    try {
      render(
        <I18nProvider>
          <ModelsScreen />
        </I18nProvider>
      )
      expect(await screen.findByRole('button', { name: t('de', 'models.use') })).toBeInTheDocument()
    } finally {
      window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
    }
  })
})

describe('ModelsScreen — installed and catalog library views', () => {
  it('defaults to on-drive models; Browse includes downloads with installed models first', async () => {
    stub({
      models: [
        model({ id: 'a-installed', displayName: 'A Installed', state: 'installed' }),
        model({ id: 'b-missing', displayName: 'B Missing', state: 'missing' }),
        model({ id: 'c-installed', displayName: 'C Installed', state: 'installed' })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('A Installed')

    expect(screen.getByRole('radio', { name: 'On this drive' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('B Missing')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Browse models' }))
    const flow = [...document.querySelectorAll('.model-title')].map(
      (el) => el.textContent
    )
    expect(flow).toEqual([
      'A Installed',
      'C Installed',
      'B Missing'
    ])
  })

  it('renders flat — no group labels — when the section is homogeneous', async () => {
    stub({
      models: [
        model({ id: 'a-installed', displayName: 'A Installed', state: 'installed' }),
        model({ id: 'c-installed', displayName: 'C Installed', state: 'installed' })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('A Installed')
    expect(screen.queryByText(t('en', 'models.group.onDrive'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('en', 'models.group.toDownload'))).not.toBeInTheDocument()
  })

  it('mutes not-yet-downloaded cards (.model-card-missing) so installed ones stand out', async () => {
    stub({
      models: [
        model({ id: 'a-installed', displayName: 'A Installed', state: 'installed' }),
        model({ id: 'b-missing', displayName: 'B Missing', state: 'missing' })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('A Installed')
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Browse models' }))
    const cards = [...document.querySelectorAll('.model-card')]
    const missingCard = cards.find((c) => c.textContent?.includes('B Missing'))
    const installedCard = cards.find((c) => c.textContent?.includes('A Installed'))
    expect(missingCard?.classList.contains('model-card-missing')).toBe(true)
    expect(installedCard?.classList.contains('model-card-missing')).toBe(false)
  })

  it('groups the Document search (embeddings) section the same way', async () => {
    stub({
      models: [
        model({
          id: 'emb-installed',
          displayName: 'Embedder Installed',
          role: 'embeddings',
          state: 'installed',
          download: undefined
        }),
        model({
          id: 'emb-missing',
          displayName: 'Embedder Missing',
          role: 'embeddings',
          state: 'missing'
        })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('Embedder Installed')
    expect(screen.getByRole('heading', { name: t('en', 'models.section.docSearch') })).toBeInTheDocument()
    expect(screen.queryByText('Embedder Missing')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Browse models' }))
    expect(screen.getByText('Embedder Missing')).toBeInTheDocument()
  })
})

describe('ModelsScreen — search, tasks and model variants', () => {
  it('starts in Browse on a fresh drive and expands exact variants with the recommended one first', async () => {
    const user = userEvent.setup()
    stub({ models: [
      model({ id: 'qwen-q4', displayName: 'Qwen3.8 27B Q4_K_M' }),
      model({ id: 'qwen-ud', displayName: 'Qwen3.8 27B UD-Q4_K_M', recommended: true }),
      model({ id: 'qwen-q6', displayName: 'Qwen3.8 27B Q6_K' })
    ] })
    render(<ModelsScreen />)
    expect(await screen.findByRole('radio', { name: 'Browse models' })).toHaveAttribute('aria-checked', 'true')
    const group = within(screen.getByRole('region', { name: 'Qwen3.8 27B' }))
    expect(group.getByText('Qwen3.8 27B UD-Q4_K_M')).toBeVisible()
    expect(group.queryByText('Qwen3.8 27B Q4_K_M')).not.toBeInTheDocument()
    const expand = group.getByRole('button', { name: 'Show all variants (3)' })
    expand.focus()
    await user.keyboard('{Enter}')
    expect(expand).toHaveAttribute('aria-expanded', 'true')
    expect(group.getByText('Qwen3.8 27B Q4_K_M')).toBeVisible()
    // Each variant's action still targets its exact catalog id.
    await user.click(within(group.getByText('Qwen3.8 27B Q6_K').closest('.model-card') as HTMLElement)
      .getByRole('button', { name: 'Download' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Qwen3.8 27B Q6_K')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await user.click(expand)
    expect(group.queryByText('Qwen3.8 27B Q6_K')).not.toBeInTheDocument()
    // A search finds a collapsed variant directly, without first expanding its group.
    await user.type(screen.getByRole('searchbox', { name: 'Search models' }), 'qwen Q6')
    expect(screen.getByText('Qwen3.8 27B Q6_K')).toBeVisible()
    expect(screen.queryByText('Qwen3.8 27B UD-Q4_K_M')).not.toBeInTheDocument()
  })

  it('combines task, family and case-insensitive search; reset restores results and keeps the active model pinned', async () => {
    const user = userEvent.setup()
    stub({ activeModelId: 'active', models: [
      model({ id: 'active', displayName: 'Active model', state: 'running' }),
      model({ id: 'embed', displayName: 'Document embedder', family: 'e5', role: 'embeddings', state: 'installed' }),
      model({ id: 'rerank', displayName: 'Document reranker', family: 'bge', role: 'reranker', state: 'installed' }),
      model({ id: 'voice', displayName: 'Voice model', family: 'whisper', role: 'transcriber', state: 'installed' })
    ] })
    render(<ModelsScreen />)
    await screen.findByText('Active model')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Task' }), 'documents')
    expect(screen.getByText('Document embedder')).toBeVisible()
    expect(screen.getByText('Document reranker')).toBeVisible()
    expect(screen.queryByText('Voice model')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Family' }), 'bge')
    await user.type(screen.getByRole('searchbox'), 'RERANK')
    expect(screen.getByText('Document reranker')).toBeVisible()
    expect(screen.queryByText('Document embedder')).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox'), ' xyz')
    expect(screen.getByText(/No models match/)).toBeVisible()
    expect(screen.getByText('Active model')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByText('Voice model')).toBeVisible()
    expect(screen.getByText('Document embedder')).toBeVisible()
  })

  it('does not hide an installed variant when this computer has too little memory', async () => {
    stub({ models: [model({ state: 'installed', insufficientRam: true })] })
    render(<ModelsScreen />)
    expect(await screen.findByRole('button', { name: 'Use this model' })).toBeDisabled()
    expect(screen.getByText('Qwen3 4B Instruct')).toBeVisible()
  })

  it('keeps a filtered-out download cancellable and preserves the chosen view', async () => {
    const user = userEvent.setup()
    const downloading = model({ id: 'filtered-download', displayName: 'Filtered download Q4' })
    let currentJob: DownloadJob = {
      jobId: 'filtered-job', modelId: downloading.id, status: 'downloading',
      receivedBytes: 10, totalBytes: 1000, unverified: false, error: null
    }
    stub({ models: [downloading], downloadModel: vi.fn(async () => currentJob),
      getDownloadJob: vi.fn(async () => currentJob) })
    const cancel = vi.fn(async () => {
      currentJob = { ...currentJob, status: 'cancelled' }
      return currentJob
    })
    window.api.cancelDownload = cancel
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    await user.click(screen.getByRole('radio', { name: 'On this drive' }))
    await user.type(screen.getByRole('searchbox'), 'no match')
    const progress = within(screen.getByRole('region', { name: 'Current model download' }))
    expect(progress.getByText(downloading.displayName)).toBeVisible()
    await user.click(progress.getByRole('button', { name: 'Cancel download' }))
    expect(cancel).toHaveBeenCalledWith('filtered-job')
    expect(screen.queryByRole('region', { name: 'Current model download' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'On this drive' })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('ModelsScreen — context-size picker beyond 32k (issue #43)', () => {
  function stubWithSettings(
    settingsOver: Record<string, unknown>,
    models: ModelInfo[] = [model({ state: 'installed' })]
  ): void {
    stubApi({
      listModels: vi.fn(async () => models),
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, ...settingsOver })),
      getPolicy: vi.fn(async () => policyStatus({ downloadsAllowed: true, settingOn: true })),
      getAppStatus: vi.fn(async () => appStatus)
    })
  }

  it('offers the 65,536 and 131,072 rungs — the old 32k ceiling dead-ended long-document workflows', async () => {
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4' })
    render(<ModelsScreen />)
    const select = await screen.findByRole('combobox', { name: /Context window for answers/ })
    expect(within(select).getByRole('option', { name: '65,536 tokens' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: '131,072 tokens' })).toBeInTheDocument()
  })

  it('labels Automatic with the number it resolves to for the active model', async () => {
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4' }, [
      model({ state: 'installed', recommendedContextTokens: 98_304 })
    ])
    render(<ModelsScreen />)
    const select = await screen.findByRole('combobox', { name: /Context window for answers/ })
    // "Auto" is often the LARGEST choice in the list; naming its resolved size stops it
    // reading as a small default (issue #43).
    expect(within(select).getByRole('option', { name: /Automatic.*98,304/ })).toBeInTheDocument()
  })

  it('locale-formats the tech-details context row via the catalog — DE gets grouping + the "Token" plural (RD-3)', async () => {
    // RD-3 (full-audit 2026-07-10): the tech-details row used to interpolate the RAW number
    // (98304) while its sibling call sites already went through toLocaleString(lang); de.ts also
    // said "Tokens" where the neighboring autoResolved key correctly uses the German plural
    // "Token". Both asserted from the catalog (D-L8) — never re-typed literals.
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4' }, [
      model({ state: 'installed', recommendedContextTokens: 98_304 })
    ])
    render(<ModelsScreen />)
    await screen.findByText('Qwen3 4B Instruct')
    expect(
      screen.getByText(t('en', 'models.tech.contextValue', { count: (98_304).toLocaleString('en') }))
    ).toBeInTheDocument()
    cleanup()

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    try {
      stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4' }, [
        model({ state: 'installed', recommendedContextTokens: 98_304 })
      ])
      render(
        <I18nProvider>
          <ModelsScreen />
        </I18nProvider>
      )
      await screen.findByText('Qwen3 4B Instruct')
      expect(
        screen.getByText(t('de', 'models.tech.contextValue', { count: (98_304).toLocaleString('de') }))
      ).toBeInTheDocument()
    } finally {
      window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
    }
  })

  it('renders an off-preset override as a selected option — the select never goes blank (RD-4)', async () => {
    // RD-4 (full-audit 2026-07-10): a persisted override outside CONTEXT_SIZE_PRESETS (an older
    // release's rung, a hand-edited settings file) matched no <option>, so the select rendered
    // BLANK. It now gets an extra option in the same label style, selected.
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4', contextTokensOverride: 24_576 })
    render(<ModelsScreen />)
    const select = (await screen.findByRole('combobox', { name: /Context window for answers/ })) as HTMLSelectElement
    const option = within(select).getByRole('option', {
      name: t('en', 'models.tech.contextValue', { count: (24_576).toLocaleString('en') })
    }) as HTMLOptionElement
    expect(option.selected).toBe(true)
    expect(select.value).toBe('24576')
  })

  it('shows the honest memory warning for a big fixed pick — and not for a small one', async () => {
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4', contextTokensOverride: 131_072 })
    render(<ModelsScreen />)
    await screen.findByRole('combobox', { name: /Context window for answers/ })
    expect(document.querySelector('.context-size-warning')).not.toBeNull()
    cleanup()

    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4', contextTokensOverride: 8192 })
    render(<ModelsScreen />)
    await screen.findByRole('combobox', { name: /Context window for answers/ })
    expect(document.querySelector('.context-size-warning')).toBeNull()
  })
})

describe('ModelsScreen — per-download confirmation (plan §6.1 gate 3)', () => {
  it('confirms size, license, and URL before starting; approved license needs no checkbox', async () => {
    const downloadModel = vi.fn(async (): Promise<DownloadJob> => ({
      jobId: 'j1',
      modelId: 'qwen3-4b-instruct-q4',
      status: 'queued',
      receivedBytes: 0,
      totalBytes: 2_900_000_000,
      unverified: false,
      error: null
    }))
    const getDownloadJob = vi.fn(async (): Promise<DownloadJob> => ({
      jobId: 'j1',
      modelId: 'qwen3-4b-instruct-q4',
      status: 'done',
      receivedBytes: 2_900_000_000,
      totalBytes: 2_900_000_000,
      unverified: false,
      error: null
    }))
    stub({ downloadModel, getDownloadJob })
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('2.7 GB')).toBeInTheDocument() // 2.9e9 bytes ≈ 2.7 GiB
    expect(dialog.getByText(/apache-2\.0/)).toBeInTheDocument()
    expect(dialog.getByText('https://example.test/qwen3-4b.gguf')).toBeInTheDocument()
    expect(dialog.queryByText(/accept this model’s license/)).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Start download' }))
    expect(downloadModel).toHaveBeenCalledWith('qwen3-4b-instruct-q4', { licenseAccepted: false })

    // Drive the polled job to its terminal state so the module-level "remembered job"
    // (the leave-and-return resume affordance) cannot leak a live job into later tests.
    expect(await screen.findByText(/Downloading…|Verifying/)).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Download' }, { timeout: 3000 })
    ).toBeInTheDocument()
  })

  it('requires the explicit license acknowledgement when the review is not approved', async () => {
    const downloadModel = vi.fn(async (): Promise<DownloadJob> => ({
      jobId: 'j2',
      modelId: 'qwen3-4b-instruct-q4',
      status: 'queued',
      receivedBytes: 0,
      totalBytes: null,
      unverified: false,
      error: null
    }))
    const getDownloadJob = vi.fn(async (): Promise<DownloadJob> => ({
      jobId: 'j2',
      modelId: 'qwen3-4b-instruct-q4',
      status: 'cancelled',
      receivedBytes: 0,
      totalBytes: null,
      unverified: false,
      error: null
    }))
    stub({
      models: [
        model({
          download: {
            url: 'https://example.test/qwen3-4b.gguf',
            sizeBytes: null,
            licenseUrl: 'https://example.test/license',
            licenseApproved: false
          }
        })
      ],
      downloadModel,
      getDownloadJob
    })
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    const start = screen.getByRole('button', { name: 'Start download' })
    expect(start).toBeDisabled()

    await user.click(screen.getByRole('checkbox'))
    expect(start).toBeEnabled()
    await user.click(start)
    expect(downloadModel).toHaveBeenCalledWith('qwen3-4b-instruct-q4', { licenseAccepted: true })
  })

  // FE-2: the Cancel control now has a .catch, so a rejecting cancelDownload surfaces a friendly
  // error instead of an unhandled promise rejection.
  it('surfaces a friendly error (no unhandled rejection) when cancelling a download rejects', async () => {
    // A unique model id so a job remembered by an earlier test in this file (module-level
    // `rememberedJob`, keyed by the default qwen id) can't render a stale live download over our
    // card. Our model starts at the Download affordance.
    const myModel = model({ id: 'cancel-test-model', displayName: 'Cancel Test Model' })
    const downloadModel = vi.fn(async (): Promise<DownloadJob> => ({
      jobId: 'jc',
      modelId: 'cancel-test-model',
      status: 'queued',
      receivedBytes: 0,
      totalBytes: 1000,
      unverified: false,
      error: null
    }))
    // Keep OUR job ('jc') live so the Cancel control stays mounted; drain any leaked job
    // (different jobId) to a terminal state so it disappears.
    const getDownloadJob = vi.fn(
      async (jobId: string): Promise<DownloadJob> =>
        jobId === 'jc'
          ? {
              jobId: 'jc',
              modelId: 'cancel-test-model',
              status: 'downloading',
              receivedBytes: 100,
              totalBytes: 1000,
              unverified: false,
              error: null
            }
          : {
              jobId,
              modelId: 'qwen3-4b-instruct-q4',
              status: 'cancelled',
              receivedBytes: 0,
              totalBytes: null,
              unverified: false,
              error: null
            }
    )
    const cancelDownload = vi.fn(async () => {
      throw new Error("Error invoking remote method 'cancelDownload': Error: cancel exploded")
    })
    stub({ models: [myModel], downloadModel, getDownloadJob })
    ;(window.api as unknown as { cancelDownload: typeof cancelDownload }).cancelDownload =
      cancelDownload
    const user = userEvent.setup()
    render(<ModelsScreen />)

    // A live job remembered by an earlier test would disable every Download button (the global
    // "another download is running" gate); our getDownloadJob drains it on the first poll, so
    // wait for the button to enable before clicking.
    const downloadBtn = await screen.findByRole('button', { name: 'Download' })
    await waitFor(() => expect(downloadBtn).toBeEnabled(), { timeout: 3000 })
    await user.click(downloadBtn)
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel download' }))
    // friendlyIpcError strips the transport + Error-class prefix → only the message shows; the
    // .catch means the rejection never escapes as an unhandled promise rejection.
    expect(await screen.findByText('cancel exploded')).toBeInTheDocument()
    // The CODE-28 test below drains this still-live remembered job on its first poll (its
    // getDownloadJob returns a terminal status for foreign job ids); cleanup() unmounts the
    // screen and clears the poll interval.
  })

  // full-audit 2026-07-11 CODE-28: the poll-completion `void refresh()` had no catch — a
  // refresh failing exactly at the download's live→terminal transition left stale cards and
  // an unhandled promise rejection. Now it routes through runAndSurface → the error banner.
  it('surfaces a failing poll-completion refresh on the error banner (no unhandled rejection)', async () => {
    const myModel = model({ id: 'refresh-fail-model', displayName: 'Refresh Fail Model' })
    let failRefresh = false
    const listModels = vi.fn(async () => {
      if (failRefresh) {
        throw new Error("Error invoking remote method 'models:list': Error: refresh exploded")
      }
      return [myModel]
    })
    const downloadModel = vi.fn(async (): Promise<DownloadJob> => ({
      jobId: 'jr',
      modelId: 'refresh-fail-model',
      status: 'queued',
      receivedBytes: 0,
      totalBytes: 1000,
      unverified: false,
      error: null
    }))
    // OUR job ('jr') completes on its first poll — and from that moment every refresh fails,
    // so the completion refresh is the one that rejects. Foreign (leaked) jobs drain terminal.
    const getDownloadJob = vi.fn(async (jobId: string): Promise<DownloadJob> => {
      if (jobId === 'jr') {
        failRefresh = true
        return {
          jobId: 'jr',
          modelId: 'refresh-fail-model',
          status: 'done',
          receivedBytes: 1000,
          totalBytes: 1000,
          unverified: false,
          error: null
        }
      }
      return { jobId, modelId: 'qwen3-4b-instruct-q4', status: 'cancelled', receivedBytes: 0, totalBytes: null, unverified: false, error: null }
    })
    stubApi({
      listModels,
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, activeModelId: null })),
      getPolicy: vi.fn(async () => policyStatus({ downloadsAllowed: true, settingOn: true })),
      getAppStatus: vi.fn(async () => appStatus),
      downloadModel: downloadModel,
      getDownloadJob: getDownloadJob
    })
    const user = userEvent.setup()
    render(<ModelsScreen />)

    // Wait out any leaked live job (see the cancel test above) so Download is clickable.
    const downloadBtn = await screen.findByRole('button', { name: 'Download' })
    await waitFor(() => expect(downloadBtn).toBeEnabled(), { timeout: 3000 })
    await user.click(downloadBtn)
    await user.click(screen.getByRole('button', { name: 'Start download' }))

    // The first poll flips the job queued→done → the completion refresh runs → listModels
    // rejects → the friendly message (transport prefix stripped) lands on the error banner.
    expect(await screen.findByText('refresh exploded', undefined, { timeout: 3000 })).toBeInTheDocument()
    // The remembered job ends terminal ('done'), so nothing live leaks into later tests.
  })
})

describe('ModelsScreen — the licence link names its host and is https-only (#236)', () => {
  async function openConfirm(m: ModelInfo): Promise<ReturnType<typeof within>> {
    stub({ models: [m] })
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('button', { name: 'Download' }))
    return within(screen.getByRole('dialog'))
  }

  it('shows the licence host beside the link, and the href is the https URL', async () => {
    const dialog = await openConfirm(
      model({
        download: {
          url: 'https://example.test/qwen3-4b.gguf',
          sizeBytes: 2_900_000_000,
          licenseUrl: 'https://licenses.example.test/qwen/LICENSE',
          licenseApproved: true
        }
      })
    )
    const link = dialog.getByRole('link', { name: /read the license/ })
    expect(link).toHaveAttribute('href', 'https://licenses.example.test/qwen/LICENSE')
    expect(dialog.getByText(/licenses\.example\.test/)).toBeInTheDocument()
  })

  it('a non-https licence URL (a stale or hostile manifest) never renders as a link', async () => {
    const dialog = await openConfirm(
      model({
        download: {
          url: 'https://example.test/qwen3-4b.gguf',
          sizeBytes: 2_900_000_000,
          licenseUrl: 'http://licenses.example.test/qwen/LICENSE',
          licenseApproved: true
        }
      })
    )
    expect(dialog.queryByRole('link', { name: /read the license/ })).not.toBeInTheDocument()
    expect(dialog.getByText(/apache-2\.0/)).toBeInTheDocument() // the licence name still shows
  })
})

// PR #302 fix wave P3 (audit finding F2, gate B1): a download that FAILS, or completes without a
// verifiable checksum, used to lose its independent panel at exactly the moment the user needed
// it — the result then only lived on the model's own row, which a search, a task/family/view
// filter or a collapsed variant group may be hiding. The panel now keeps a NAMED result with
// Retry / Dismiss until the user acts, a new download is accepted, or the download ends verified
// or cancelled. The first seven cases are ports of the audit's `model-library.probe.tsx`; the
// rest pin the lifecycle, gating and stale-response contract of the fix.
describe('ModelsScreen — terminal download results stay visible (PR #302 F2, B1)', () => {
  const REGION = 'Current model download'
  const RETRY = t('en', 'models.download.retry')
  const DISMISS = t('en', 'models.download.dismiss')

  function variant(id: string, displayName: string, over: Partial<ModelInfo> = {}): ModelInfo {
    return model({ id, displayName, family: 'qwen3.8', ...over })
  }

  function jobOf(jobId: string, modelId: string, over: Partial<DownloadJob> = {}): DownloadJob {
    return {
      jobId,
      modelId,
      status: 'downloading',
      receivedBytes: 10,
      totalBytes: 1000,
      unverified: false,
      error: null,
      ...over
    }
  }

  // Typed idle fixtures instead of `... as never` payload casts (F-41 ratchet): the engine has
  // every family installed (no installer banner) and nothing is starting.
  const idleEngine: EngineStatus = {
    installed: true,
    available: true,
    version: null,
    backend: null,
    missingFamilies: []
  }
  const idleRuntime: RuntimeStatus = {
    running: false,
    modelId: null,
    startingModelId: null,
    port: null,
    healthy: false,
    message: ''
  }

  /** Every bridge method the screen actually calls, so `assertNoUnexpectedApiCalls` has teeth. */
  function stubLive(opts: {
    models: () => ModelInfo[]
    job?: () => DownloadJob
    policy?: () => PolicyStatus
    activeModelId?: string | null
    downloadModel?: (id: string, o?: { licenseAccepted?: boolean }) => Promise<DownloadJob>
    getDownloadJob?: (jobId: string) => Promise<DownloadJob>
    listModels?: () => Promise<ModelInfo[]>
    useModel?: ReturnType<typeof vi.fn>
  }): {
    listModels: ReturnType<typeof vi.fn>
    downloadModel: ReturnType<typeof vi.fn>
    getDownloadJob: ReturnType<typeof vi.fn>
  } {
    const listModels = vi.fn(opts.listModels ?? (async () => opts.models()))
    const downloadModel = vi.fn(opts.downloadModel ?? (async () => opts.job!()))
    const getDownloadJob = vi.fn(opts.getDownloadJob ?? (async () => opts.job!()))
    stubApi({
      listModels,
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        activeModelId: opts.activeModelId ?? null
      })),
      getPolicy: vi.fn(async () =>
        (opts.policy ?? (() => policyStatus({ downloadsAllowed: true, settingOn: true })))()
      ),
      getAppStatus: vi.fn(async () => appStatus),
      getEngineStatus: vi.fn(async () => idleEngine),
      getRuntimeStatus: vi.fn(async () => idleRuntime),
      onModelVerifyProgress: vi.fn(() => () => {}),
      downloadModel,
      getDownloadJob,
      ...(opts.useModel ? { useModel: opts.useModel } : {})
    })
    return { listModels, downloadModel, getDownloadJob }
  }

  const panel = (): ReturnType<typeof within> =>
    within(screen.getByRole('region', { name: REGION }))

  /** The `.model-card` for a display name — never the panel's own <strong> heading. */
  function cardFor(displayName: string): HTMLElement {
    const card = screen
      .getAllByText(displayName)
      .map((el) => el.closest('.model-card'))
      .find((el): el is HTMLElement => el != null)
    expect(card).toBeTruthy()
    return card as HTMLElement
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  afterEach(() => {
    cleanup()
    assertNoUnexpectedApiCalls()
  })

  // ---- Ported audit probes (`model-library.probe.tsx`) -----------------------------------------

  it.each(['search', 'collapsed group'] as const)(
    'keeps a failed download visible after hiding its row via %s',
    async (hide) => {
      const user = userEvent.setup()
      const first = variant(`f1-${hide}`, 'Result group Q4_K_M')
      const second = variant(`f2-${hide}`, 'Result group Q6_K')
      let current = jobOf(`failed-${hide}`, second.id)
      const api = stubLive({ models: () => [first, second], job: () => current })
      render(<ModelsScreen />)

      await user.click(await screen.findByRole('button', { name: 'Show all variants (2)' }))
      await user.click(within(cardFor(second.displayName)).getByRole('button', { name: 'Download' }))
      await user.click(screen.getByRole('button', { name: 'Start download' }))
      await screen.findByRole('region', { name: REGION })
      if (hide === 'search') await user.type(screen.getByRole('searchbox'), 'no match')
      else await user.click(screen.getByRole('button', { name: 'Show fewer variants (2)' }))

      current = { ...current, status: 'failed', error: `download failed (${hide})` }
      await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

      // The result names its model and carries its own recovery actions, wherever it renders.
      expect(panel().getByText(`download failed (${hide})`)).toBeVisible()
      expect(panel().getByText(second.displayName)).toBeVisible()
      expect(panel().getByRole('button', { name: RETRY })).toBeEnabled()
      expect(panel().getByRole('button', { name: DISMISS })).toBeEnabled()
    }
  )

  it.each(['search', 'collapsed group'] as const)(
    'keeps an unverified completion warning visible through %s',
    async (hide) => {
      const user = userEvent.setup()
      const first = variant(`u1-${hide}`, 'Unverified group Q4_K_M')
      let second = variant(`u2-${hide}`, 'Unverified group Q6_K')
      let current = jobOf(`unverified-${hide}`, second.id)
      const api = stubLive({ models: () => [first, second], job: () => current })
      render(<ModelsScreen />)

      await user.click(await screen.findByRole('button', { name: 'Show all variants (2)' }))
      await user.click(within(cardFor(second.displayName)).getByRole('button', { name: 'Download' }))
      await user.click(screen.getByRole('button', { name: 'Start download' }))
      await screen.findByRole('region', { name: REGION })
      if (hide === 'search') await user.type(screen.getByRole('searchbox'), 'no match')
      else await user.click(screen.getByRole('button', { name: 'Show fewer variants (2)' }))

      second = { ...second, state: 'installed' }
      current = { ...current, status: 'done', unverified: true, receivedBytes: 1000 }
      await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

      expect(panel().getByText('verify-models --generate')).toBeVisible()
      expect(panel().getByText(second.displayName)).toBeVisible()
      expect(panel().getByRole('button', { name: DISMISS })).toBeEnabled()
    }
  )

  it('sends the exact expanded variant ID and its own license acknowledgement to downloadModel', async () => {
    const user = userEvent.setup()
    const first = variant('q4-action-control', 'Action control Q4_K_M')
    const second = variant('q6-action-control', 'Action control Q6_K', {
      download: {
        url: 'https://example.test/q6.gguf',
        sizeBytes: 1000,
        licenseUrl: 'https://example.test/license',
        licenseApproved: false
      }
    })
    const api = stubLive({
      models: () => [first, second],
      job: () => jobOf('action-control', second.id, { status: 'cancelled' })
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Show all variants (2)' }))
    await user.click(within(cardFor(second.displayName)).getByRole('button', { name: 'Download' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Start download' })).toBeDisabled()
    expect(api.downloadModel).not.toHaveBeenCalled()
    await user.click(dialog.getByRole('checkbox'))
    await user.click(dialog.getByRole('button', { name: 'Start download' }))
    expect(api.downloadModel).toHaveBeenCalledExactlyOnceWith(second.id, { licenseAccepted: true })
  })

  it('sends the exact expanded installed variant ID to useModel', async () => {
    const user = userEvent.setup()
    const first = variant('q4-use-control', 'Use control Q4_K_M', { state: 'installed' })
    const second = variant('q6-use-control', 'Use control Q6_K', { state: 'installed' })
    const useModel = vi.fn(async () => idleRuntime)
    stubLive({ models: () => [first, second], useModel })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Show all variants (2)' }))
    await user.click(
      within(cardFor(second.displayName)).getByRole('button', { name: t('en', 'models.use') })
    )
    expect(useModel).toHaveBeenCalledExactlyOnceWith(second.id)
  })

  it('preserves Browse and finds the installed model after a filtered verified completion', async () => {
    const user = userEvent.setup()
    let entry = variant('completion-control', 'Completed model Q4')
    let current = jobOf('completion-control-job', entry.id)
    const api = stubLive({ models: () => [entry], job: () => current })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    await user.type(screen.getByRole('searchbox'), 'no match')

    entry = { ...entry, state: 'installed' }
    current = { ...current, status: 'done', receivedBytes: 1000 }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    // A VERIFIED completion needs no result surface — today's behaviour is preserved exactly.
    expect(screen.queryByRole('region', { name: REGION })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Browse models' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByRole('button', { name: t('en', 'models.use') })).toBeEnabled()
  })

  // ---- Hiding controls beyond search / collapse -------------------------------------------------

  it.each(['task', 'family', 'view'] as const)(
    'keeps a failed result visible when the %s filter hides its row',
    async (control) => {
      const user = userEvent.setup()
      const chatModel = variant(`hidden-${control}`, `Hidden chat model ${control}`)
      const other = model({
        id: `other-${control}`,
        displayName: `Other embedder ${control}`,
        family: 'e5',
        role: 'embeddings'
      })
      let current = jobOf(`hide-${control}`, chatModel.id)
      const api = stubLive({ models: () => [chatModel, other], job: () => current })
      render(<ModelsScreen />)

      await screen.findByText(chatModel.displayName)
      await user.click(
        within(cardFor(chatModel.displayName)).getByRole('button', { name: 'Download' })
      )
      await user.click(screen.getByRole('button', { name: 'Start download' }))
      current = { ...current, status: 'failed', error: `hidden by ${control}` }
      await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

      if (control === 'task') {
        await user.selectOptions(screen.getByRole('combobox', { name: 'Task' }), 'documents')
      } else if (control === 'family') {
        await user.selectOptions(screen.getByRole('combobox', { name: 'Family' }), 'e5')
      } else {
        await user.click(screen.getByRole('radio', { name: 'On this drive' }))
      }

      // No ROW carries the model any more — only the panel does.
      const rows = [...document.querySelectorAll('.model-card')]
      expect(rows.some((row) => row.textContent?.includes(chatModel.displayName))).toBe(false)
      expect(panel().getByText(`hidden by ${control}`)).toBeVisible()
      expect(panel().getByText(chatModel.displayName)).toBeVisible()
      expect(panel().getByRole('button', { name: RETRY })).toBeInTheDocument()
    }
  )

  // ---- Structural: one panel node, one always-mounted alert node --------------------------------

  it('keeps the SAME panel and alert nodes across the live → failed transition', async () => {
    const user = userEvent.setup()
    const entry = variant('same-node', 'Same node model')
    let current = jobOf('same-node-job', entry.id)
    const api = stubLive({ models: () => [entry], job: () => current })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    const region = await screen.findByRole('region', { name: REGION })
    const alert = within(region).getByRole('alert')
    // Mounted and EMPTY during progress: a live region that only appears at failure is not
    // reliably announced (the SH-2 / M-U1 discipline applied to the download panel).
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveTextContent('')

    current = { ...current, status: 'failed', error: 'the connection dropped' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    expect(screen.getByRole('region', { name: REGION })).toBe(region)
    expect(within(region).getByRole('alert')).toBe(alert)
    expect(alert).toHaveTextContent('the connection dropped')
  })

  // ---- Refresh at the terminal transition -------------------------------------------------------

  it.each(['as installed', 'not at all'] as const)(
    'keeps the named result when the refresh returns the model %s',
    async (how) => {
      const user = userEvent.setup()
      let entry = variant(
        `refresh-${how === 'as installed' ? 'installed' : 'gone'}`,
        'Refreshed model Q4'
      )
      let listed: ModelInfo[] = [entry]
      let current = jobOf(`refresh-job-${how === 'as installed' ? 'installed' : 'gone'}`, entry.id)
      const api = stubLive({ models: () => listed, job: () => current })
      render(<ModelsScreen />)

      await user.click(await screen.findByRole('button', { name: 'Download' }))
      await user.click(screen.getByRole('button', { name: 'Start download' }))

      entry = { ...entry, state: 'installed' }
      listed = how === 'as installed' ? [entry] : []
      current = { ...current, status: 'failed', error: 'checksum mismatch after retry' }
      await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

      expect(panel().getByText('Refreshed model Q4')).toBeVisible()
      expect(panel().getByText('checksum mismatch after retry')).toBeVisible()
      if (how === 'not at all') {
        // No retry target left: explained, not a button that could only fail.
        expect(panel().getByRole('button', { name: RETRY })).toBeDisabled()
        expect(panel().getByText(t('en', 'models.download.retryUnavailable'))).toBeVisible()
      }
    }
  )

  it('keeps the result and shows the friendly error when the completion refresh rejects', async () => {
    const user = userEvent.setup()
    const entry = variant('refresh-reject', 'Refresh reject model')
    let failRefresh = false
    let current = jobOf('refresh-reject-job', entry.id)
    stubLive({
      models: () => [entry],
      job: () => current,
      listModels: async () => {
        if (failRefresh) {
          throw new Error("Error invoking remote method 'models:list': Error: refresh exploded")
        }
        return [entry]
      }
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    failRefresh = true
    current = { ...current, status: 'failed', error: 'server closed the connection' }

    expect(
      await screen.findByText('refresh exploded', undefined, { timeout: 3000 })
    ).toBeInTheDocument()
    expect(panel().getByText('server closed the connection')).toBeVisible()
    expect(panel().getByText(entry.displayName)).toBeVisible()
  })

  // ---- Dismiss ----------------------------------------------------------------------------------

  it('Dismiss drops the panel and hands the row back its own recovery UI', async () => {
    const user = userEvent.setup()
    const entry = variant('dismiss-model', 'Dismiss model Q4')
    let current = jobOf('dismiss-job', entry.id)
    const api = stubLive({ models: () => [entry], job: () => current })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'disk full' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })
    // While the panel owns the job the row does not repeat the outcome.
    expect(within(cardFor(entry.displayName)).queryByText('disk full')).not.toBeInTheDocument()

    await user.click(panel().getByRole('button', { name: DISMISS }))
    expect(screen.queryByRole('region', { name: REGION })).not.toBeInTheDocument()
    const row = within(cardFor(entry.displayName))
    expect(row.getByRole('button', { name: t('en', 'models.download.resume') })).toBeEnabled()
    expect(row.getByText('disk full')).toBeVisible()
  })

  it('a dismissed result does not come back on a re-render or a remount', async () => {
    const user = userEvent.setup()
    const entry = variant('dismiss-sticky', 'Dismiss sticky Q4')
    let current = jobOf('dismiss-sticky-job', entry.id)
    const api = stubLive({ models: () => [entry], job: () => current })
    const view = render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'gone for good' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })
    await user.click(panel().getByRole('button', { name: DISMISS }))

    // A re-render driven by a filter change must not resurrect it…
    await user.click(screen.getByRole('radio', { name: 'Browse models' }))
    expect(screen.queryByRole('region', { name: REGION })).not.toBeInTheDocument()

    // …and neither must leaving and re-entering the screen (the dismissal is remembered by id).
    view.unmount()
    render(<ModelsScreen />)
    await screen.findByText(entry.displayName)
    expect(screen.queryByRole('region', { name: REGION })).not.toBeInTheDocument()
    expect(screen.getByText('gone for good')).toBeVisible() // the row still explains it
  })

  // ---- Retry ------------------------------------------------------------------------------------

  it('Retry opens the existing confirmation for the exact variant; cancelling keeps the result', async () => {
    const user = userEvent.setup()
    const first = variant('retry-q4', 'Retry group Q4_K_M')
    const second = variant('retry-q6', 'Retry group Q6_K', {
      download: {
        url: 'https://example.test/retry-q6.gguf',
        sizeBytes: 1000,
        licenseUrl: 'https://licenses.example.test/q6/LICENSE',
        licenseApproved: true
      }
    })
    let current = jobOf('retry-dialog-job', second.id)
    const api = stubLive({ models: () => [first, second], job: () => current })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Show all variants (2)' }))
    await user.click(within(cardFor(second.displayName)).getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'retry me' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    await user.click(panel().getByRole('button', { name: RETRY }))
    const dialog = within(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toHaveTextContent(second.displayName)
    expect(dialog.getByText('https://example.test/retry-q6.gguf')).toBeInTheDocument()
    expect(dialog.getByRole('link', { name: /read the license/ })).toHaveAttribute(
      'href',
      'https://licenses.example.test/q6/LICENSE'
    )
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(api.downloadModel).toHaveBeenCalledTimes(1) // the original start only
    expect(panel().getByText('retry me')).toBeVisible()
  })

  it('a rejected retry keeps the result and surfaces the friendly error', async () => {
    const user = userEvent.setup()
    const entry = variant('retry-reject', 'Retry reject Q4')
    let current = jobOf('retry-reject-job', entry.id)
    let rejectNext = false
    const api = stubLive({
      models: () => [entry],
      job: () => current,
      downloadModel: async () => {
        if (rejectNext) {
          throw new Error("Error invoking remote method 'models:download': Error: start refused")
        }
        return current
      }
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'first attempt failed' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    rejectNext = true
    await user.click(panel().getByRole('button', { name: RETRY }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))

    expect(await screen.findByText('start refused')).toBeInTheDocument()
    expect(panel().getByText('first attempt failed')).toBeVisible()
  })

  it('a successful retry re-asks for the licence, reuses the exact id and replaces the panel', async () => {
    const user = userEvent.setup()
    const entry = variant('retry-ok', 'Retry ok Q4', {
      download: {
        url: 'https://example.test/retry-ok.gguf',
        sizeBytes: 1000,
        licenseUrl: 'https://example.test/license',
        licenseApproved: false
      }
    })
    let current = jobOf('retry-ok-job-1', entry.id)
    const api = stubLive({
      models: () => [entry],
      job: () => current,
      downloadModel: async () => current
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'first attempt failed' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    await user.click(panel().getByRole('button', { name: RETRY }))
    // The acknowledgement is RESET — a retry never silently accepts a pending license.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('checkbox')).not.toBeChecked()
    expect(dialog.getByRole('button', { name: 'Start download' })).toBeDisabled()
    current = jobOf('retry-ok-job-2', entry.id)
    await user.click(dialog.getByRole('checkbox'))
    await user.click(dialog.getByRole('button', { name: 'Start download' }))

    expect(api.downloadModel).toHaveBeenCalledTimes(2)
    expect(api.downloadModel).toHaveBeenLastCalledWith(entry.id, { licenseAccepted: true })
    // The accepted job REPLACES the result: live progress, and the old failure is gone.
    expect(panel().getByRole('button', { name: 'Cancel download' })).toBeInTheDocument()
    expect(screen.queryByText('first attempt failed')).not.toBeInTheDocument()
  })

  it('disables Retry with the policy reason when downloads are gated at the refresh', async () => {
    const user = userEvent.setup()
    const entry = variant('retry-gated', 'Retry gated Q4')
    let current = jobOf('retry-gated-job', entry.id)
    let allowed = true
    const api = stubLive({
      models: () => [entry],
      job: () => current,
      policy: () => policyStatus({ downloadsAllowed: allowed, settingOn: true })
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    allowed = false
    current = { ...current, status: 'failed', error: 'network went away' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    const retry = panel().getByRole('button', { name: RETRY })
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute('title', t('en', 'models.downloads.blockedByPolicy'))
    expect(panel().getByText('network went away')).toBeVisible()
  })

  it('disables Retry and explains when the download was withdrawn at the refresh (#196)', async () => {
    const user = userEvent.setup()
    let entry = variant('retry-withdrawn', 'Retry withdrawn Q4')
    let current = jobOf('retry-withdrawn-job', entry.id)
    const api = stubLive({ models: () => [entry], job: () => current })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    entry = {
      ...entry,
      download: { ...entry.download!, withdrawn: '2026-09-01: upstream deleted the file' }
    }
    current = { ...current, status: 'failed', error: 'HTTP 404' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    expect(panel().getByRole('button', { name: RETRY })).toBeDisabled()
    expect(panel().getByText(/No longer available for download/)).toBeVisible()
    expect(panel().getByText('HTTP 404')).toBeVisible()
  })

  // ---- A retained result must never behave like a live job --------------------------------------

  it('never blocks another model: Download and Use stay enabled, and a new job replaces the result', async () => {
    const user = userEvent.setup()
    const failing = variant('stale-failing', 'Stale failing Q4')
    const another = model({
      id: 'stale-other',
      displayName: 'Another downloadable model',
      family: 'gemma'
    })
    const installed = model({
      id: 'stale-installed',
      displayName: 'Another installed model',
      family: 'phi',
      state: 'installed'
    })
    let current = jobOf('stale-failing-job', failing.id)
    const api = stubLive({
      models: () => [failing, another, installed],
      job: () => current,
      downloadModel: async (id) => {
        if (id === another.id) current = jobOf('stale-new-job', id)
        return current
      },
      useModel: vi.fn(async () => idleRuntime)
    })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('radio', { name: 'Browse models' }))
    await user.click(within(cardFor(failing.displayName)).getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'stale result' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    // The ONLY gate on other rows is still a LIVE job (`JOB_LIVE`) — a retained result is not one.
    expect(
      within(cardFor(another.displayName)).getByRole('button', { name: 'Download' })
    ).toBeEnabled()
    expect(
      within(cardFor(installed.displayName)).getByRole('button', { name: t('en', 'models.use') })
    ).toBeEnabled()

    await user.click(within(cardFor(another.displayName)).getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    expect(panel().getByText(another.displayName)).toBeVisible()
    expect(screen.queryByText('stale result')).not.toBeInTheDocument()
  })

  it('ignores a late poll response for a job that is no longer current', async () => {
    const user = userEvent.setup()
    const first = variant('late-first', 'Late first Q4')
    const second = model({ id: 'late-second', displayName: 'Late second model', family: 'gemma' })
    const late = deferred<DownloadJob>()
    const firstFailed = jobOf('late-job-1', first.id, { status: 'failed', error: 'late failure' })
    let currentSecond = jobOf('late-job-2', second.id)
    let firstPolls = 0
    const api = stubLive({
      models: () => [first, second],
      getDownloadJob: async (jobId) => {
        if (jobId === 'late-job-1') {
          firstPolls += 1
          // The FIRST poll never settles until the test releases it; the second reports the
          // failure, so the panel reaches its terminal state with one response still in flight.
          return firstPolls === 1 ? late.promise : firstFailed
        }
        return currentSecond
      },
      downloadModel: async (id) => {
        if (id === second.id) {
          currentSecond = jobOf('late-job-2', second.id)
          return currentSecond
        }
        return jobOf('late-job-1', first.id)
      }
    })
    render(<ModelsScreen />)

    await screen.findByText(first.displayName)
    await user.click(within(cardFor(first.displayName)).getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    await waitFor(() => expect(panel().getByText('late failure')).toBeVisible(), { timeout: 4000 })

    await user.click(within(cardFor(second.displayName)).getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    expect(panel().getByText(second.displayName)).toBeVisible()

    late.resolve(firstFailed)
    await act(async () => {
      await late.promise
    })
    // The stale response must not resurrect the replaced result.
    expect(screen.queryByText('late failure')).not.toBeInTheDocument()
    expect(panel().getByText(second.displayName)).toBeVisible()
    expect(api.listModels).toHaveBeenCalled()
  })

  // ---- Remembered job across ordinary screen navigation -----------------------------------------

  it('shows the named result on return when the download failed while the screen was away', async () => {
    const user = userEvent.setup()
    const entry = variant('away-model', 'Away model Q4')
    let current = jobOf('away-job', entry.id)
    stubLive({ models: () => [entry], job: () => current })
    const view = render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    await screen.findByRole('region', { name: REGION })

    view.unmount() // leaving the screen; the job keeps running in the main process
    current = { ...current, status: 'failed', error: 'failed while away' }

    render(<ModelsScreen />) // …and coming back resumes the remembered job and shows its result
    await waitFor(() => expect(panel().getByText('failed while away')).toBeVisible(), {
      timeout: 3000
    })
    expect(panel().getByText(entry.displayName)).toBeVisible()
    expect(panel().getByRole('button', { name: RETRY })).toBeEnabled()
  })

  // ---- Automatic roles share the surface --------------------------------------------------------

  it('names the result for an automatic-role download (embeddings) in the default view', async () => {
    const user = userEvent.setup()
    const embedder = model({
      id: 'auto-embedder',
      displayName: 'Document embedder (E5)',
      family: 'e5',
      role: 'embeddings'
    })
    let current = jobOf('auto-embedder-job', embedder.id)
    const api = stubLive({ models: () => [embedder], job: () => current })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: 'Start download' }))
    current = { ...current, status: 'failed', error: 'embedder download failed' }
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

    expect(panel().getByText('embedder download failed')).toBeVisible()
    expect(panel().getByText(embedder.displayName)).toBeVisible()
  })

  // ---- EN + DE ----------------------------------------------------------------------------------

  it('renders the failed result, Retry and Dismiss from the German catalog (D-L8)', async () => {
    const user = userEvent.setup()
    const entry = variant('de-model', 'DE Modell Q4')
    let current = jobOf('de-job', entry.id)
    const api = stubLive({ models: () => [entry], job: () => current })
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    try {
      render(
        <I18nProvider>
          <ModelsScreen />
        </I18nProvider>
      )
      await user.click(await screen.findByRole('button', { name: t('de', 'models.download.start') }))
      await user.click(screen.getByRole('button', { name: t('de', 'models.confirm.start') }))
      current = { ...current, status: 'failed', error: 'Verbindung abgebrochen' }
      await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2), { timeout: 3000 })

      const de = within(screen.getByRole('region', { name: t('de', 'models.library.download') }))
      expect(
        de.getByText(t('de', 'models.download.failed', { name: entry.displayName }))
      ).toBeVisible()
      expect(de.getByText('Verbindung abgebrochen')).toBeVisible()
      expect(de.getByRole('button', { name: t('de', 'models.download.retry') })).toBeEnabled()
      expect(de.getByRole('button', { name: t('de', 'models.download.dismiss') })).toBeEnabled()
    } finally {
      window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
    }
  })
})

describe('ModelsScreen — repair visibility and group face (PR #302 F3/F5, C1)', () => {
  // Typed idle fixtures instead of `... as never` payload casts (F-41 ratchet).
  const idleEngine: EngineStatus = {
    installed: true,
    available: true,
    version: null,
    backend: null,
    missingFamilies: []
  }
  const idleRuntime: RuntimeStatus = {
    running: false,
    modelId: null,
    startingModelId: null,
    port: null,
    healthy: false,
    message: ''
  }

  const OBTAINABLE = {
    url: 'https://example.test/weights.gguf',
    sizeBytes: 1000,
    licenseUrl: 'https://example.test/license',
    licenseApproved: true
  }
  const WITHDRAWN = { ...OBTAINABLE, withdrawn: 'the publisher removed the pinned file' }

  function variant(id: string, displayName: string, over: Partial<ModelInfo> = {}): ModelInfo {
    return model({ id, displayName, family: 'qwen3.8', download: OBTAINABLE, ...over })
  }

  /** Every bridge method the screen calls, so `assertNoUnexpectedApiCalls` has teeth. */
  function stubLibrary(opts: {
    models: () => ModelInfo[]
    activeModelId?: string | null
    machineRamGb?: number
    useModel?: ReturnType<typeof vi.fn>
  }): { listModels: ReturnType<typeof vi.fn> } {
    const listModels = vi.fn(async () => opts.models())
    stubApi({
      listModels,
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        activeModelId: opts.activeModelId ?? null
      })),
      getPolicy: vi.fn(async () => policyStatus({ downloadsAllowed: true, settingOn: true })),
      getAppStatus: vi.fn(async () => appStatusFixture({ machineRamGb: opts.machineRamGb ?? 32 })),
      getEngineStatus: vi.fn(async () => idleEngine),
      getRuntimeStatus: vi.fn(async () => idleRuntime),
      onModelVerifyProgress: vi.fn(() => () => {}),
      ...(opts.useModel ? { useModel: opts.useModel } : {})
    })
    return { listModels }
  }

  function cardFor(displayName: string): HTMLElement {
    const card = screen
      .getAllByText(displayName)
      .map((el) => el.closest('.model-card'))
      .find((el): el is HTMLElement => el != null)
    expect(card, `a .model-card for ${displayName}`).toBeTruthy()
    return card as HTMLElement
  }

  /** Titles of the cards rendered inside one variant group, in DOM order. */
  function groupTitles(name: string): string[] {
    const region = screen.getByRole('region', { name })
    return [...region.querySelectorAll('.model-title')].map((el) => el.textContent ?? '')
  }

  afterEach(() => {
    cleanup()
    assertNoUnexpectedApiCalls()
  })

  // ---- Ported audit probes (`model-library.probe.tsx`, F3) --------------------------------------

  it.each(['different model', 'sibling variant'] as const)(
    'shows a damaged %s in the default drive view so it can be repaired',
    async (kind) => {
      const active = variant('active', 'Active model', { state: 'running' })
      const healthy = variant('healthy', 'Repair control Q4_K_M', { state: 'installed' })
      const damaged = variant(
        'damaged',
        kind === 'sibling variant' ? 'Repair control Q6_K' : 'Damaged model',
        { state: 'checksum_failed' }
      )
      stubLibrary({ models: () => [active, healthy, damaged], activeModelId: active.id })
      render(<ModelsScreen />)
      await screen.findByText(active.displayName)

      // The default view is On this drive; the damaged model is ON the drive (its files are
      // there, they just failed verification) and its whole recovery action lives on this row.
      expect(screen.getByRole('radio', { name: 'On this drive' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      // The sibling case must NOT need "Show all variants" first: a group holding a damaged
      // member starts expanded (C1).
      expect(screen.getByText(damaged.displayName)).toBeVisible()
      expect(
        within(cardFor(damaged.displayName)).getByRole('button', { name: 'Download' })
      ).toBeEnabled()
      expect(within(cardFor(damaged.displayName)).getByText('Can’t verify')).toBeVisible()
    }
  )

  it('finds the damaged model by its exact name while On this drive is selected', async () => {
    const healthy = variant('healthy', 'Healthy model', { state: 'installed' })
    const damaged = variant('damaged', 'Damaged model Q6_K', { state: 'checksum_failed' })
    stubLibrary({ models: () => [healthy, damaged] })
    render(<ModelsScreen />)
    await screen.findByText(healthy.displayName)
    expect(screen.getByRole('radio', { name: 'On this drive' })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    // On the reviewed head this reported "No models match" — the search ran over a list the view
    // filter had already emptied of repair states.
    await userEvent.setup().type(screen.getByRole('searchbox'), damaged.displayName)
    expect(screen.getByText(damaged.displayName)).toBeVisible()
    expect(screen.queryByText(/No models match/)).not.toBeInTheDocument()
  })

  it.each(['embeddings', 'reranker', 'translation', 'vision', 'transcriber'] as const)(
    'lists a damaged %s model in the default view with its Download action',
    async (role) => {
      const chat = variant('chat-installed', 'Chat model', { state: 'installed' })
      const damaged = variant(`damaged-${role}`, `Damaged ${role} model`, {
        role,
        family: role,
        state: 'checksum_failed'
      })
      stubLibrary({ models: () => [chat, damaged] })
      render(<ModelsScreen />)
      await screen.findByText(damaged.displayName)

      expect(screen.getByRole('radio', { name: 'On this drive' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      const card = within(cardFor(damaged.displayName))
      expect(card.getByRole('button', { name: 'Download' })).toBeEnabled()
      // Automatic roles never gain Select/Start from being visible here.
      expect(card.queryByRole('button', { name: 'Use this model' })).not.toBeInTheDocument()
    }
  )

  it('keeps the withdrawn explanation — never a promised Download — on a damaged withdrawn row', async () => {
    const healthy = variant('healthy', 'Healthy model', { state: 'installed' })
    const damaged = variant('damaged-withdrawn', 'Withdrawn damaged model', {
      state: 'checksum_failed',
      download: WITHDRAWN
    })
    stubLibrary({ models: () => [healthy, damaged] })
    render(<ModelsScreen />)
    await screen.findByText(damaged.displayName)

    const card = within(cardFor(damaged.displayName))
    expect(card.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    expect(
      card.getByText(t('en', 'models.download.withdrawn', { reason: WITHDRAWN.withdrawn }))
    ).toBeVisible()
  })

  it('a damaged-only drive still starts in Browse, and On this drive lists the damaged row', async () => {
    const damaged = variant('damaged-only', 'Only damaged model', { state: 'checksum_failed' })
    stubLibrary({ models: () => [damaged] })
    render(<ModelsScreen />)
    await screen.findByText(damaged.displayName)

    // The INITIAL view choice is unchanged: it asks whether anything is usable right now
    // (`isModelInstalled`), and a model that fails its checksum is not.
    expect(screen.getByRole('radio', { name: 'Browse models' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await userEvent.setup().click(screen.getByRole('radio', { name: 'On this drive' }))
    expect(screen.getByText(damaged.displayName)).toBeVisible()
    expect(screen.queryByText(t('en', 'models.library.noneInstalled'))).not.toBeInTheDocument()
  })

  it('still shows the "only your active model" empty state when nothing else is on the drive', async () => {
    const active = variant('active', 'Active model', { state: 'installed' })
    stubLibrary({ models: () => [active], activeModelId: active.id })
    render(<ModelsScreen />)
    await screen.findByText(active.displayName)

    expect(screen.getByRole('radio', { name: 'On this drive' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByText(t('en', 'models.library.onlyActive'))).toBeVisible()
  })

  it('keeps the active model pinned above the library, listed exactly once', async () => {
    const active = variant('active', 'Active model', { state: 'running' })
    const damaged = variant('damaged', 'Damaged model', { state: 'checksum_failed' })
    stubLibrary({ models: () => [active, damaged], activeModelId: active.id })
    render(<ModelsScreen />)
    await screen.findByText(active.displayName)

    expect([...document.querySelectorAll('.model-title')].map((el) => el.textContent)).toEqual([
      'Active model',
      'Damaged model'
    ])
    expect(screen.getAllByText('Active model')).toHaveLength(1)
  })

  // ---- Default expansion vs. the user's explicit toggle (C1) ------------------------------------

  it('expands the group on its own when a refresh introduces damage', async () => {
    const healthy = variant('pair-q4', 'Refresh pair Q4_K_M', { state: 'installed' })
    const sibling = variant('pair-q6', 'Refresh pair Q6_K', { state: 'installed' })
    let damagedYet = false
    const useModel = vi.fn(async () => idleRuntime)
    stubLibrary({
      models: () =>
        damagedYet ? [healthy, { ...sibling, state: 'checksum_failed' as const }] : [healthy, sibling],
      useModel
    })
    render(<ModelsScreen />)
    await screen.findByText(healthy.displayName)

    // Healthy pair: collapsed, so only the face shows.
    expect(screen.getByRole('button', { name: 'Show all variants (2)' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText(sibling.displayName)).not.toBeInTheDocument()

    // Any refresh (here: the row's own Use action) re-derives expansion from the new states.
    damagedYet = true
    await userEvent.setup().click(
      within(cardFor(healthy.displayName)).getByRole('button', { name: 'Use this model' })
    )
    await waitFor(() => expect(screen.getByText(sibling.displayName)).toBeVisible())
    expect(screen.getByRole('button', { name: 'Show fewer variants (2)' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(useModel).toHaveBeenCalledExactlyOnceWith(healthy.id)
  })

  it('an explicit collapse survives a refresh and a filter change — and re-expansion works', async () => {
    const user = userEvent.setup()
    const healthy = variant('toggle-q4', 'Toggle pair Q4_K_M', { state: 'installed' })
    const damaged = variant('toggle-q6', 'Toggle pair Q6_K', { state: 'checksum_failed' })
    const useModel = vi.fn(async () => idleRuntime)
    const api = stubLibrary({ models: () => [healthy, damaged], useModel })
    render(<ModelsScreen />)
    await screen.findByText(damaged.displayName)

    // Starts expanded because of the damaged member; the user disagrees.
    await user.click(screen.getByRole('button', { name: 'Show fewer variants (2)' }))
    expect(screen.queryByText(damaged.displayName)).not.toBeInTheDocument()

    // A refresh must not re-open what the user closed, even though the damage is still there.
    await user.click(
      within(cardFor(healthy.displayName)).getByRole('button', { name: 'Use this model' })
    )
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(damaged.displayName)).not.toBeInTheDocument()

    // Nor a filter change: the choice is keyed by the stable group key.
    await user.type(screen.getByRole('searchbox'), 'toggle')
    expect(screen.queryByText(damaged.displayName)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all variants (2)' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    // And re-expanding still works.
    await user.click(screen.getByRole('button', { name: 'Show all variants (2)' }))
    expect(screen.getByText(damaged.displayName)).toBeVisible()
  })

  // ---- The rendered group face (F5) ------------------------------------------------------------

  it('renders the variantGroupFace choice on the collapsed card, and every variant once when expanded', async () => {
    const tie = { state: 'missing' as const, recommended: false, insufficientRam: true }
    const models = [
      variant('tie-q4km', 'Tie group Q4_K_M', { ...tie, download: WITHDRAWN }),
      variant('tie-udq4kxl', 'Tie group UD-Q4_K_XL', { ...tie, download: OBTAINABLE }),
      variant('tie-q4ks', 'Tie group Q4_K_S', { ...tie, download: WITHDRAWN }),
      variant('tie-q6k', 'Tie group Q6_K', { ...tie, download: OBTAINABLE }),
      variant('tie-q80', 'Tie group Q8_0', { ...tie, download: OBTAINABLE }),
      variant('tie-udq6kxl', 'Tie group UD-Q6_K_XL', { ...tie, download: OBTAINABLE })
    ]
    stubLibrary({ models: () => models })
    render(<ModelsScreen />)
    await screen.findByRole('region', { name: 'Tie group' })

    // The selector's answer, computed independently from the same inputs the screen receives.
    const group = groupModelVariants(orderPickerModels(models)).find((g) => g.name === 'Tie group')
    const face = variantGroupFace(group!)
    expect(face.displayName).toBe('Tie group UD-Q4_K_XL')

    // Collapsed: the DOM shows exactly that member — not the withdrawn catalog-first one.
    expect(groupTitles('Tie group')).toEqual([face.displayName])
    expect(screen.queryByText('Tie group Q4_K_M')).not.toBeInTheDocument()
    expect(group!.models[0].displayName).toBe('Tie group Q4_K_M') // the sort is untouched

    // Expanded: face first, then every other variant exactly once in its original order.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all variants (6)' }))
    expect(groupTitles('Tie group')).toEqual([
      'Tie group UD-Q4_K_XL',
      'Tie group Q4_K_M',
      'Tie group Q4_K_S',
      'Tie group Q6_K',
      'Tie group Q8_0',
      'Tie group UD-Q6_K_XL'
    ])
    expect(new Set(groupTitles('Tie group')).size).toBe(models.length)
  })

  // ---- O1 / O5 — the RAM badge and the heading outline ------------------------------------------

  it('shows the ⚠ RAM badge and its full hint while Technical details is closed (O1)', async () => {
    const tight = variant('ram-gated', 'RAM gated model', {
      state: 'installed',
      insufficientRam: true,
      recommendedMinRamGb: 24
    })
    stubLibrary({ models: () => [tight], machineRamGb: 8 })
    render(<ModelsScreen />)
    await screen.findByText(tight.displayName)

    expect((document.querySelector('details.tech-details') as HTMLDetailsElement).open).toBe(false)
    // The BADGE itself (the disabled Use action carries the same hint as its title).
    const badge = within(cardFor(tight.displayName)).getByText('Needs ≥24 GB RAM')
    expect(badge).toBeVisible()
    expect(badge.className).toContain('pill-warning')
    expect(badge).toHaveAttribute(
      'title',
      t('en', 'models.ram.needs', { min: 24 }) +
        t('en', 'models.ram.machine', { ram: 8 }) +
        t('en', 'models.ram.advice')
    )
  })

  it('nests the heading outline h2 → h3 (task) → h4 (group) and toggles aria-expanded (O5)', async () => {
    const models = [
      variant('outline-q4', 'Outline group Q4_K_M'),
      variant('outline-q6', 'Outline group Q6_K')
    ]
    stubLibrary({ models: () => models })
    render(<ModelsScreen />)
    await screen.findByRole('region', { name: 'Outline group' })

    expect(screen.getByRole('heading', { level: 2, name: 'Model library' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Chat' })).toBeInTheDocument()
    const groupHeading = screen.getByRole('heading', { level: 4, name: 'Outline group' })
    expect(groupHeading).toBeInTheDocument()
    // No heading skips a level and the group heading is not a sibling-rank h3 any more.
    expect(screen.queryByRole('heading', { level: 3, name: 'Outline group' })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: 'Show all variants (2)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(toggle)
    expect(screen.getByRole('button', { name: 'Show fewer variants (2)' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})
