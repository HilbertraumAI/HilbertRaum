// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../src/renderer/components'
import { EngineConfirmDialog } from '../../src/renderer/components/EngineConfirmDialog'
import { ModelsScreen, __resetModelsScreenMemoryForTests } from '../../src/renderer/screens/ModelsScreen'
import { t } from '../../src/shared/i18n'
import { fmtDiskSize } from '../../src/shared/format'
import type { EngineDownloadPreview, EngineProblem, EngineStatus } from '../../src/shared/types'
import { ENGINE_INSTALLED, ENGINE_MISSING, engineJob, enginePreview, enginePreviewItem, stubModelsApi } from '../helpers/model-fixtures'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { appStatus } from '../helpers/status'

// #843: PRIVACY.md item 3 promises that every download is confirmed in a dialog showing its size,
// licence and source address. The AI engine's install, update and reinstall started on the click.
// Each now reads main's preview of THAT request (`getEnginePlan`, the step selection the job runs),
// shows it, and sends the unchanged request only on Confirm. Copy is asserted against the catalog.

afterEach(cleanup)
beforeEach(() => {
  __resetModelsScreenMemoryForTests()
})

const en = (key: Parameters<typeof t>[1], params?: Record<string, string | number>): string => t('en', key, params)
const size = (bytes: number): string => fmtDiskSize(bytes, 'en')

const CPU_NET = enginePreviewItem({
  installed: 'b9849',
  backend: 'cpu',
  safetyNet: true,
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-cpu-x64.zip',
  sizeBytes: 24_708_445
})
const UPDATE: EngineDownloadPreview = enginePreview({ kind: 'update', items: [enginePreviewItem({ installed: 'b9849' }), CPU_NET] })

const OLDER_CHAT: EngineStatus = {
  ...ENGINE_INSTALLED,
  version: 'b12110',
  backend: 'vulkan',
  engineVersions: [
    {
      family: 'llama_cpp',
      optional: false,
      installed: 'b9849',
      installedBackend: 'vulkan',
      pinned: 'b12110',
      pinnedBackend: 'vulkan',
      relation: 'older',
      cpuNet: { installed: 'b9849', pinned: 'b12110', relation: 'older' }
    }
  ]
}
const DAMAGED: EngineProblem = { family: 'llama_cpp', reason: 'files-damaged', os: 'win', exit: 'exit code 0xC0000135' }

function renderModels(): void {
  render(
    <ToastProvider>
      <ModelsScreen />
    </ToastProvider>
  )
}

describe('the AI engine asks before it downloads (#843)', () => {
  it('install: the click shows what will be fetched — and nothing starts until Confirm', async () => {
    const user = userEvent.setup()
    const getEnginePlan = vi.fn(async () => enginePreview())
    const downloadEngine = vi.fn(async () => engineJob())
    stubModelsApi({ getEngineStatus: vi.fn(async () => ENGINE_MISSING), getEnginePlan, downloadEngine, getEngineJob: vi.fn(async () => engineJob()) })
    renderModels()
    await user.click(await screen.findByRole('button', { name: en('models.engine.install') }))
    const dialog = await screen.findByRole('dialog', { name: en('models.engine.title') })
    // The default install's request: no argument, exactly as its Confirm will send it.
    expect(getEnginePlan.mock.calls).toEqual([[]])
    expect(downloadEngine).not.toHaveBeenCalled()
    const facts = within(dialog)
    expect(facts.getByText(en('models.engineConfirm.chatEngine'))).toBeInTheDocument()
    expect(facts.getByText('b12110 (vulkan)')).toBeInTheDocument()
    expect(facts.getByText(size(37_661_146))).toBeInTheDocument()
    expect(
      facts.getByText(en('models.engineConfirm.licenseIncludes', { license: 'MIT', bundled: 'Apache-2.0 WITH LLVM-exception (libomp.dll)' }), { exact: false })
    ).toBeInTheDocument()
    expect(facts.getByRole('link', { name: en('models.confirm.readLicense') })).toHaveAttribute('href', 'https://github.com/ggml-org/llama.cpp/blob/b12110/LICENSE')
    expect(facts.getByText('github.com')).toBeInTheDocument()
    // The full address, as the model and knowledge-pack tools dialogs show it.
    expect(facts.getByText('https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-vulkan-x64.zip')).toBeInTheDocument()
    expect(facts.getByText(en('models.engineConfirm.hint'))).toBeInTheDocument()
    // One archive: no total line, no update note.
    expect(facts.queryByText(en('models.engineConfirm.total'))).not.toBeInTheDocument()
    expect(facts.queryByText(en('models.engineConfirm.updateNote'))).not.toBeInTheDocument()

    await user.click(facts.getByRole('button', { name: en('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(downloadEngine).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: en('models.engine.install') }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en('models.engine.install') }))
    expect(downloadEngine.mock.calls).toEqual([[]])
    expect(await screen.findByText(en('models.engine.progress', { pct: 25 }))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('update: both archives the job replaces, the version change, the total and the pause note; Confirm sends the notice request', async () => {
    const user = userEvent.setup()
    const getEnginePlan = vi.fn(async () => UPDATE)
    const downloadEngine = vi.fn(async () => engineJob({ families: ['llama_cpp'], update: true }))
    stubModelsApi({ getEngineStatus: vi.fn(async () => OLDER_CHAT), getEnginePlan, downloadEngine, getEngineJob: vi.fn(async () => engineJob({ families: ['llama_cpp'], update: true })) })
    renderModels()
    await user.click(await screen.findByRole('button', { name: en('models.engineUpdate.update') }))
    const dialog = await screen.findByRole('dialog', { name: en('models.engineUpdate.title') })
    expect(getEnginePlan.mock.calls).toEqual([[{ families: ['llama_cpp'], update: true }]])
    const facts = within(dialog)
    expect(facts.getByText('b9849 → b12110 (vulkan)')).toBeInTheDocument()
    expect(facts.getByText('b9849 → b12110 (cpu)')).toBeInTheDocument()
    expect(facts.getByText(`${en('models.engineConfirm.chatEngine')} · ${en('models.engineConfirm.safetyNet')}`)).toBeInTheDocument()
    expect(facts.getByText(CPU_NET.url)).toBeInTheDocument()
    expect(facts.getByText(en('models.engineConfirm.total'))).toBeInTheDocument()
    expect(facts.getByText(size(37_661_146 + 24_708_445))).toBeInTheDocument()
    expect(facts.getByText(en('models.engineConfirm.updateNote'))).toBeInTheDocument()
    expect(downloadEngine).not.toHaveBeenCalled()
    await user.click(facts.getByRole('button', { name: en('models.engineUpdate.update') }))
    expect(downloadEngine.mock.calls).toEqual([[{ families: ['llama_cpp'], update: true }]])
    assertNoUnexpectedApiCalls()
  })

  it('reinstall: "Install the AI engine again" asks first; Cancel starts nothing, Confirm sends the repair request', async () => {
    const user = userEvent.setup()
    const request = { families: ['llama_cpp'], reinstall: true }
    const getEnginePlan = vi.fn(async () => enginePreview({ kind: 'reinstall', items: [enginePreviewItem({ installed: 'b12110' })] }))
    const downloadEngine = vi.fn(async () => engineJob({ families: ['llama_cpp'], reinstall: true }))
    stubModelsApi({
      getAppStatus: vi.fn(async () => appStatus({ engineProblems: [DAMAGED] })),
      getEngineStatus: vi.fn(async () => ({ ...ENGINE_INSTALLED, reinstallableFamilies: ['llama_cpp'] })),
      recheckEngine: vi.fn(async () => ({ problems: [DAMAGED] })),
      getEnginePlan,
      downloadEngine,
      getEngineJob: vi.fn(async () => engineJob({ families: ['llama_cpp'], reinstall: true }))
    })
    renderModels()
    const reinstall = await screen.findByRole('button', { name: en('models.engineProblem.reinstall') })
    await user.click(reinstall)
    let dialog = await screen.findByRole('dialog', { name: en('models.engineProblem.reinstall') })
    expect(getEnginePlan.mock.calls).toEqual([[request]])
    // A reinstall installs the pinned version over the same one: no "from → to".
    expect(within(dialog).getByText('b12110 (vulkan)')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: en('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(downloadEngine).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.reinstall') }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: en('models.engineProblem.reinstall') }))
    expect(downloadEngine.mock.calls).toEqual([[request]])
    assertNoUnexpectedApiCalls()
  })

  it('a request main refuses opens no dialog: the reason shows, and nothing is downloaded', async () => {
    const user = userEvent.setup()
    const getEnginePlan = vi.fn(async () => {
      throw new Error("Error invoking remote method 'engine:plan': Error: Every engine is up to date.")
    })
    const downloadEngine = vi.fn(async () => engineJob())
    stubModelsApi({ getEngineStatus: vi.fn(async () => OLDER_CHAT), getEnginePlan, downloadEngine })
    renderModels()
    await user.click(await screen.findByRole('button', { name: en('models.engineUpdate.update') }))
    expect(await screen.findByText('Every engine is up to date.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(downloadEngine).not.toHaveBeenCalled()
    assertNoUnexpectedApiCalls()
  })
})

describe('EngineConfirmDialog (#843)', () => {
  const props = {
    open: true,
    title: 'Install the AI engine',
    confirmLabel: 'Install AI engine',
    onConfirm: () => undefined,
    onCancel: () => undefined,
    lang: 'en' as const
  }

  // Only the AI engine's update stops the chat model for the swap; a voice-engine-only update pauses the
  // transcriber alone (registerEngineIpc pauseEngineUsers), so its dialog must not say the model pauses.
  it.each([
    ['the AI engine', [enginePreviewItem({ installed: 'b9849' })], true],
    ['the AI engine and the voice engine', [enginePreviewItem({ installed: 'b9849' }), enginePreviewItem({ family: 'whisper_cpp', version: 'v1.8.6', installed: 'v1.7.0', backend: 'cpu', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip' })], true],
    ['only the voice engine', [enginePreviewItem({ family: 'whisper_cpp', version: 'v1.8.6', installed: 'v1.7.0', backend: 'cpu', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip' })], false]
  ])('an update of %s: the model-pause note shows only when the chat engine is replaced', (_label, items, note) => {
    render(<EngineConfirmDialog {...props} preview={enginePreview({ kind: 'update', items })} downloadsEnabled blockedReason={null} />)
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByText(en('models.engineConfirm.updateNote')) !== null).toBe(note)
    // The checksum hint is there either way.
    expect(dialog.getByText(en('models.engineConfirm.hint'))).toBeInTheDocument()
  })

  it('keeps Confirm disabled while downloads are blocked, and says why', () => {
    render(<EngineConfirmDialog {...props} preview={enginePreview()} downloadsEnabled={false} blockedReason="Downloads are turned off." />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Install AI engine' })).toBeDisabled()
    expect(within(dialog).getByText('Downloads are turned off.')).toBeInTheDocument()
  })

  it('an unknown size reads "unknown" (and so does the total); a licence link that is not https is not a link (#236)', () => {
    const preview = enginePreview({
      items: [
        enginePreviewItem({ sizeBytes: null, licenseUrl: 'javascript:alert(1)', bundledLicense: null }),
        enginePreviewItem({ family: 'whisper_cpp', version: 'v1.8.6', backend: 'cpu', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip', sizeBytes: 4_093_849, bundledLicense: 'zlib (SDL2.dll)', licenseUrl: 'https://github.com/ggml-org/whisper.cpp/blob/v1.8.6/LICENSE' })
      ]
    })
    render(<EngineConfirmDialog {...props} preview={preview} downloadsEnabled blockedReason={null} />)
    const dialog = within(screen.getByRole('dialog'))
    expect(preview.totalBytes).toBeNull()
    expect(dialog.getAllByText(en('packs.tools.sizeUnknown'))).toHaveLength(2)
    expect(dialog.getByText('MIT')).toBeInTheDocument()
    expect(dialog.getByText(en('models.engineConfirm.voiceEngine'))).toBeInTheDocument()
    expect(dialog.getByText(en('models.engineConfirm.licenseIncludes', { license: 'MIT', bundled: 'zlib (SDL2.dll)' }), { exact: false })).toBeInTheDocument()
    expect(dialog.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['https://github.com/ggml-org/whisper.cpp/blob/v1.8.6/LICENSE'])
    expect(dialog.getByRole('button', { name: 'Install AI engine' })).toBeEnabled()
  })
})
