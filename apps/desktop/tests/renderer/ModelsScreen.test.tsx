// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import {
  DEFAULT_SETTINGS,
  type AppStatus,
  type DownloadJob,
  type ModelInfo,
  type PolicyStatus,
  type RuntimeStatus
} from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { stubApi } from '../helpers/renderer'

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
  return {
    policy: {
      network: {
        allowModelDownloads: opts.downloadsAllowed,
        allowUpdateChecks: false,
        allowTelemetry: false
      },
      workspace: { encryptionRequired: false, allowPlaintextDevMode: true },
      models: { allowUnverifiedModels: true, requireManifest: true, requireSha256Match: false }
    },
    policyFilePresent: true,
    driveFilePresent: true,
    allowNetworkSetting: opts.settingOn,
    networkAllowedByPolicy: opts.downloadsAllowed,
    networkAllowed: opts.downloadsAllowed && opts.settingOn,
    offlineMode: !(opts.downloadsAllowed && opts.settingOn),
    telemetryAllowed: false
  }
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
    downloadModel: (opts.downloadModel ?? vi.fn()) as never,
    getDownloadJob: (opts.getDownloadJob ?? vi.fn()) as never
  })
}

afterEach(cleanup)

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
    expect(screen.getByText('Other models')).toBeInTheDocument()
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

// Issue #35: installed models and models that still need a multi-GB download used to sit
// in ONE flat list, distinguishable only by the small state badge — the picker's
// installed-first sort was invisible. Mixed sections now split into two labeled groups
// ("On this drive — ready to use" / "Available to download"), and not-yet-downloaded
// cards render visually muted (.model-card-missing).
describe('ModelsScreen — installed vs downloadable grouping (#35)', () => {
  it('labels both groups and keeps installed models first when the picker is mixed', async () => {
    stub({
      models: [
        model({ id: 'a-installed', displayName: 'A Installed', state: 'installed' }),
        model({ id: 'b-missing', displayName: 'B Missing', state: 'missing' }),
        model({ id: 'c-installed', displayName: 'C Installed', state: 'installed' })
      ]
    })
    render(<ModelsScreen />)
    await screen.findByText('A Installed')

    expect(screen.getByText(t('en', 'models.group.onDrive'))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'models.group.toDownload'))).toBeInTheDocument()
    // Reading order: the on-drive label, its cards (manifest order preserved), the
    // download label, then the not-yet-downloaded card.
    const flow = [...document.querySelectorAll('.model-group-title, .model-title')].map(
      (el) => el.textContent
    )
    expect(flow).toEqual([
      t('en', 'models.group.onDrive'),
      'A Installed',
      'C Installed',
      t('en', 'models.group.toDownload'),
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
    expect(screen.getByText(t('en', 'models.section.docSearch'))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'models.group.onDrive'))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'models.group.toDownload'))).toBeInTheDocument()
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
    const select = await screen.findByRole('combobox')
    expect(within(select).getByRole('option', { name: '65,536 tokens' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: '131,072 tokens' })).toBeInTheDocument()
  })

  it('labels Automatic with the number it resolves to for the active model', async () => {
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4' }, [
      model({ state: 'installed', recommendedContextTokens: 98_304 })
    ])
    render(<ModelsScreen />)
    const select = await screen.findByRole('combobox')
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
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement
    const option = within(select).getByRole('option', {
      name: t('en', 'models.tech.contextValue', { count: (24_576).toLocaleString('en') })
    }) as HTMLOptionElement
    expect(option.selected).toBe(true)
    expect(select.value).toBe('24576')
  })

  it('shows the honest memory warning for a big fixed pick — and not for a small one', async () => {
    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4', contextTokensOverride: 131_072 })
    render(<ModelsScreen />)
    await screen.findByRole('combobox')
    expect(document.querySelector('.context-size-warning')).not.toBeNull()
    cleanup()

    stubWithSettings({ activeModelId: 'qwen3-4b-instruct-q4', contextTokensOverride: 8192 })
    render(<ModelsScreen />)
    await screen.findByRole('combobox')
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
    // This is the last test in the file, so the still-live remembered job leaks into no later
    // test; cleanup() unmounts the screen and clears the poll interval.
  })
})
