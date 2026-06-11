// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import {
  DEFAULT_SETTINGS,
  type AppStatus,
  type DownloadJob,
  type ModelInfo,
  type PolicyStatus
} from '../../src/shared/types'
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
})
