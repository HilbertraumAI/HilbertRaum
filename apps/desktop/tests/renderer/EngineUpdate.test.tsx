// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../src/renderer/components'
import { ModelsScreen, __resetModelsScreenMemoryForTests } from '../../src/renderer/screens/ModelsScreen'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { __resetKnowledgePackToolsInstallForTests } from '../../src/renderer/lib/useKnowledgePackToolsInstall'
import { t } from '../../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type EngineDownloadJob,
  type EngineProblem,
  type EngineStatus,
  type EngineVersionInfo,
  type OcrInstallStatus,
  type RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { hangBudgetMs } from '../helpers/hang-budget'
import { appStatus, driveStatus, makePolicyStatus, performanceSnapshot } from '../helpers/status'

// #516: an engine on the drive OLDER than this app's pin gets a quiet "update available" notice on
// the AI Model screen (one Update for every outdated engine, the shared engine-job controls), and
// Diagnostics names every engine that is not the pinned build. Copy is asserted against the catalog.

afterEach(cleanup)

const en = (key: Parameters<typeof t>[1], params?: Record<string, string | number>): string => t('en', key, params)

const chat = (over: Partial<EngineVersionInfo> = {}): EngineVersionInfo => ({
  family: 'llama_cpp',
  optional: false,
  installed: 'b9849',
  installedBackend: 'vulkan',
  pinned: 'b11146',
  pinnedBackend: 'vulkan',
  relation: 'older',
  ...over
})
const voice = (over: Partial<EngineVersionInfo> = {}): EngineVersionInfo =>
  chat({ family: 'whisper_cpp', installed: 'v1.7.0', installedBackend: 'cpu', pinned: 'v1.8.6', pinnedBackend: 'cpu', ...over })
const engine = (versions: EngineVersionInfo[]): EngineStatus => ({
  installed: true,
  available: true,
  version: 'b11146',
  backend: 'vulkan',
  missingFamilies: [],
  engineVersions: versions
})
const IDLE_RUNTIME: RuntimeStatus = { running: false, modelId: null, startingModelId: null, port: null, healthy: false, message: '' }
const NO_OCR_SOURCES: OcrInstallStatus = { available: false, languages: [], totalBytes: 0, sourceHost: null, license: 'Apache-2.0' }

describe('ModelsScreen — the engine update notice (#516)', () => {
  beforeEach(() => {
    __resetModelsScreenMemoryForTests()
    __resetKnowledgePackToolsInstallForTests()
  })

  function stubModels(opts: {
    engine: EngineStatus
    problems?: EngineProblem[]
    downloadEngine?: Mock
    getEngineJob?: Mock
  }): void {
    stubApi({
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getPolicy: vi.fn(async () => makePolicyStatus({ network: { allowModelDownloads: true }, allowNetworkSetting: true })),
      getAppStatus: vi.fn(async () => appStatus({ engineProblems: opts.problems ?? [] })),
      getEngineStatus: vi.fn(async () => opts.engine),
      onEngineProblemsChanged: vi.fn(() => () => {}),
      recheckEngine: vi.fn(async () => ({ problems: [] })),
      getOcrInstallStatus: vi.fn(async () => NO_OCR_SOURCES),
      getRuntimeStatus: vi.fn(async () => IDLE_RUNTIME),
      onModelVerifyProgress: vi.fn(() => () => {}),
      listDownloadJobs: vi.fn(async () => []),
      ...(opts.downloadEngine ? { downloadEngine: opts.downloadEngine } : {}),
      ...(opts.getEngineJob ? { getEngineJob: opts.getEngineJob } : {})
    })
  }
  const renderModels = (): ReturnType<typeof render> =>
    render(
      <ToastProvider>
        <ModelsScreen />
      </ToastProvider>
    )
  const job = (over: Partial<EngineDownloadJob>): EngineDownloadJob => ({
    jobId: 'u1',
    status: 'downloading',
    receivedBytes: 25,
    totalBytes: 100,
    unverified: false,
    binaryPath: null,
    error: null,
    families: ['llama_cpp'],
    update: true,
    ...over
  })

  it('offers one quiet Update, runs it in the notice and confirms it when done', async () => {
    const user = userEvent.setup()
    const downloadEngine = vi.fn(async () => job({}))
    stubModels({ engine: engine([chat()]), downloadEngine, getEngineJob: vi.fn(async () => job({ status: 'done' })) })
    renderModels()
    const title = await screen.findByText(en('models.engineUpdate.title'))
    const notice = title.closest('.banner') as HTMLElement
    expect(within(notice).getByText(en('models.engineUpdate.explain'))).toBeInTheDocument()
    const update = within(notice).getByRole('button', { name: en('models.engineUpdate.update') })
    // A quiet offer, not the fix for a fault: no loud primary (design-guidelines §11.17 #516 amendment).
    expect(update).not.toHaveClass('primary')
    await user.click(update)
    expect(downloadEngine).toHaveBeenCalledWith({ families: ['llama_cpp'], update: true })
    expect(await within(notice).findByText(en('models.engine.progress', { pct: 25 }))).toBeInTheDocument()
    expect(await screen.findByText(en('models.engineUpdate.done'), {}, { timeout: hangBudgetMs(4000) })).toBeInTheDocument()
  })

  it('names both engines in one notice and updates both with one click', async () => {
    const user = userEvent.setup()
    const downloadEngine = vi.fn(async () => job({ families: ['llama_cpp', 'whisper_cpp'] }))
    stubModels({ engine: engine([chat(), voice()]), downloadEngine })
    renderModels()
    await screen.findByText(en('models.engineUpdate.bothTitle'))
    await user.click(screen.getByRole('button', { name: en('models.engineUpdate.update') }))
    expect(downloadEngine).toHaveBeenCalledWith({ families: ['llama_cpp', 'whisper_cpp'], update: true })
  })

  it('offers the update when only the cpu/ safety net is older', async () => {
    stubModels({ engine: engine([chat({ relation: 'current', cpuNet: { installed: 'b9849', pinned: 'b11146', relation: 'older' } })]) })
    renderModels()
    expect(await screen.findByText(en('models.engineUpdate.title'))).toBeInTheDocument()
  })

  it.each<[string, EngineVersionInfo[], EngineProblem[]]>([
    ['the engine is current', [chat({ relation: 'current' })], []],
    ['the engine is newer than this app (never a downgrade)', [chat({ installed: 'b11200', relation: 'newer' })], []],
    ['its version is unrecorded', [chat({ installed: null, relation: 'unknown' })], []],
    ['only the optional knowledge-pack tools are older', [chat({ family: 'kiwix_tools', optional: true })], []],
    [
      'the OS refuses that engine (its own banner leads; a reinstall fetches the pin anyway)',
      [chat()],
      [{ family: 'llama_cpp', reason: 'files-damaged', os: 'win', exit: 'exit code 0xC0000135' }]
    ]
  ])('shows no update notice when %s', async (_label, versions, problems) => {
    stubModels({ engine: engine(versions), problems })
    renderModels()
    await waitFor(() => expect(window.api.getEngineStatus).toHaveBeenCalled())
    await waitFor(() => expect(window.api.getAppStatus).toHaveBeenCalled())
    expect(screen.queryByText(en('models.engineUpdate.title'))).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en('models.engineUpdate.update') })).not.toBeInTheDocument()
  })
})

describe('Settings → Diagnostics — engine versions (#516)', () => {
  let lastCopied: string | null = null
  function stubDiagnostics(versions: EngineVersionInfo[]): void {
    lastCopied = null
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ appVersion: '0.1.62', engineProblems: [] })),
      getDriveStatus: vi.fn(async () => driveStatus()),
      getRuntimeStatus: vi.fn(async () => IDLE_RUNTIME),
      getRuntimeInstall: vi.fn(async () => ({ version: 'b9849', backend: 'vulkan', os: 'win', arch: 'x64' })),
      getEngineStatus: vi.fn(async () => engine(versions)),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getPerformance: vi.fn(async () => performanceSnapshot()),
      onEngineProblemsChanged: vi.fn(() => () => {}),
      getLogTail: vi.fn(async () => []),
      copyToClipboard: vi.fn(async (text: string) => {
        lastCopied = text
        return true
      })
    })
  }
  const renderDiagnostics = (): void => {
    render(
      <ToastProvider>
        <SettingsScreen tab="diagnostics" />
      </ToastProvider>
    )
  }

  it('names each engine that is not the pinned build — older, newer, unrecorded, the cpu/ net — and copies the same line', async () => {
    const user = userEvent.setup()
    stubDiagnostics([
      chat({ cpuNet: { installed: 'b9849', pinned: 'b11146', relation: 'older' } }),
      voice({ installed: 'v1.9.0', relation: 'newer' }),
      chat({ family: 'kiwix_tools', optional: true, installed: null, pinned: '3.8.1', relation: 'unknown' })
    ])
    renderDiagnostics()
    const line = [
      en('diag.engineVersion.older', { engine: 'llama.cpp', installed: 'b9849', pinned: 'b11146' }),
      en('diag.engineVersion.older', { engine: en('diag.engineVersion.cpuNet', { engine: 'llama.cpp' }), installed: 'b9849', pinned: 'b11146' }),
      en('diag.engineVersion.newer', { engine: 'whisper.cpp', installed: 'v1.9.0', pinned: 'v1.8.6' }),
      en('diag.engineVersion.unknown', { engine: 'kiwix-tools', pinned: '3.8.1' })
    ].join('; ')
    const dd = await screen.findByText(line)
    expect(dd.previousElementSibling?.textContent).toBe(en('diag.app.engineVersions'))
    await user.click(screen.getAllByRole('button', { name: en('diag.copy') })[0])
    await waitFor(() => expect(lastCopied).not.toBeNull())
    expect(lastCopied).toContain(`${en('diag.app.engineVersions')}: ${line}`)
  })

  it('shows no engine-versions row when every engine is the pinned build', async () => {
    stubDiagnostics([chat({ relation: 'current' })])
    renderDiagnostics()
    await screen.findByText(en('diag.app.runtimeBuild'))
    await waitFor(() => expect(window.api.getEngineStatus).toHaveBeenCalled())
    expect(screen.queryByText(en('diag.app.engineVersions'))).not.toBeInTheDocument()
  })
})
