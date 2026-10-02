// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, type Mock } from 'vitest'
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EngineProblemNotice, ToastProvider } from '../../src/renderer/components'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import { ModelsScreen, __resetModelsScreenMemoryForTests } from '../../src/renderer/screens/ModelsScreen'
import { PerformanceScreen } from '../../src/renderer/screens/PerformanceScreen'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { TranslateScreen } from '../../src/renderer/screens/TranslateScreen'
import { AnswerThread, type ImageTurn } from '../../src/renderer/images'
import { App } from '../../src/renderer/App'
import { resetTranslateSessionForTests } from '../../src/renderer/lib/translateSession'
import { resetFileTranslateSessionForTests } from '../../src/renderer/lib/fileTranslateSession'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import { __resetKnowledgePackToolsInstallForTests } from '../../src/renderer/lib/useKnowledgePackToolsInstall'
import { t } from '../../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type EngineProblem,
  type EngineRecheckResult,
  type EngineStatus,
  type OcrInstallStatus,
  type PerformanceSnapshot,
  type PreflightResult,
  type RuntimeStatus,
  type TranslateJob,
  type WorkspaceStateInfo
} from '../../src/shared/types'
import type { Translator } from '../../src/renderer/components/translator'
import { stubApi } from '../helpers/renderer'
import { appStatus, driveStatus, makePolicyStatus, performanceSnapshot } from '../helpers/status'

// #530: an engine program that is on the drive but that the OS loader refuses to start (Linux:
// libgomp.so.1 missing; Windows: Visual C++ runtime / Smart App Control) is recorded as a session
// verdict (`EngineProblem`). These tests pin what each surface SAYS about it: the AI Model banner
// and its Check again flow, the voice hint, Home's model row + primary, the App notice button,
// Diagnostics (line + copy report), Performance's graphics tile and the two error-code copies.
// Copy is asserted against the catalog (`t('en', key)`), not hard-coded English.

afterEach(cleanup)

const en = (key: Parameters<typeof t>[1], params?: Record<string, string | number>): string =>
  t('en', key, params)

const LIBGOMP: EngineProblem = {
  family: 'llama_cpp',
  reason: 'library-missing',
  os: 'linux',
  name: 'libgomp.so.1',
  exit: 'exit code 127'
}
const WHISPER: EngineProblem = { ...LIBGOMP, family: 'whisper_cpp' }

// ---- 1-4: the notice component ---------------------------------------------------------------

function renderNotice(
  problem: EngineProblem,
  opts: {
    variant?: 'banner' | 'hint'
    onRecheck?: () => Promise<EngineRecheckResult>
    t?: Translator
  } = {}
): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <EngineProblemNotice
        problem={problem}
        variant={opts.variant ?? 'banner'}
        onRecheck={opts.onRecheck ?? (async () => ({ problems: [problem] }))}
        t={opts.t}
      />
    </ToastProvider>
  )
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('EngineProblemNotice — banner reason copy (#530)', () => {
  it('libgomp.so.1 on Linux names the library and BOTH packages, and the demo-mode note', () => {
    renderNotice(LIBGOMP)
    expect(screen.getByText(en('models.engineProblem.title'))).toBeInTheDocument()
    expect(
      screen.getByText(
        en('models.engineProblem.libraryMissingPackage', {
          library: 'libgomp.so.1',
          debPackage: 'libgomp1',
          rpmPackage: 'libgomp'
        })
      )
    ).toBeInTheDocument()
    expect(screen.getByText(en('models.engineProblem.demoNote'))).toBeInTheDocument()
    // The banner is a polite status region (design-guidelines §6), not an alert.
    // (the toast host is a status region too, so find the banner by class)
    const banner = document.querySelector('.banner') as HTMLElement
    expect(banner).toHaveAttribute('role', 'status')
    expect(within(banner).getByText(en('models.engineProblem.title'))).toBeInTheDocument()
    // §7: the exit code never reaches the everyday surface.
    expect(document.body.textContent).not.toContain('127')
  })

  it('an unknown library gets the generic sentence, without a package', () => {
    renderNotice({ ...LIBGOMP, name: 'libfoo.so.2' })
    expect(screen.getByText(en('models.engineProblem.libraryMissing', { library: 'libfoo.so.2' }))).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('libgomp1')
  })

  it('a missing library on a non-Linux OS never gets a Linux package hint', () => {
    renderNotice({ ...LIBGOMP, os: 'win' })
    expect(screen.getByText(en('models.engineProblem.libraryMissing', { library: 'libgomp.so.1' }))).toBeInTheDocument()
  })

  const CASES: Array<[string, EngineProblem, Parameters<typeof t>[1]]> = [
    ['system-too-old on linux', { ...LIBGOMP, reason: 'system-too-old', os: 'linux' }, 'models.engineProblem.systemTooOldLinux'],
    ['system-too-old on mac', { ...LIBGOMP, reason: 'system-too-old', os: 'mac' }, 'models.engineProblem.systemTooOldMac'],
    ['system-too-old on win', { ...LIBGOMP, reason: 'system-too-old', os: 'win' }, 'models.engineProblem.systemTooOld'],
    ['vc-runtime-missing', { ...LIBGOMP, reason: 'vc-runtime-missing', os: 'win' }, 'models.engineProblem.vcRuntimeMissing'],
    ['files-damaged', { ...LIBGOMP, reason: 'files-damaged' }, 'models.engineProblem.filesDamaged'],
    ['blocked', { ...LIBGOMP, reason: 'blocked', os: 'win' }, 'models.engineProblem.blocked']
  ]
  it.each(CASES)('%s shows its own sentence', (_label, problem, key) => {
    renderNotice(problem)
    expect(screen.getByText(en(key))).toBeInTheDocument()
  })
})

describe('EngineProblemNotice — Check again (#530)', () => {
  it('is disabled and reads "Checking…" while the re-check is pending', async () => {
    const user = userEvent.setup()
    const d = deferred<EngineRecheckResult>()
    const onRecheck = vi.fn(() => d.promise)
    renderNotice(LIBGOMP, { onRecheck })
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    const busy = await screen.findByRole('button', { name: new RegExp(en('models.engineProblem.checking')) })
    expect(busy).toBeDisabled()
    expect(onRecheck).toHaveBeenCalledTimes(1)
    await act(async () => d.resolve({ problems: [LIBGOMP] }))
    expect(await screen.findByRole('button', { name: en('models.engineProblem.check') })).toBeEnabled()
  })

  it('the same family still failing shows the "still can\'t start" line', async () => {
    const user = userEvent.setup()
    renderNotice(LIBGOMP, { onRecheck: async () => ({ problems: [LIBGOMP] }) })
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    expect(await screen.findByText(en('models.engineProblem.stillFailing'))).toBeInTheDocument()
  })

  it('another family failing does not count as "still failing" for this one', async () => {
    const user = userEvent.setup()
    renderNotice(LIBGOMP, { onRecheck: async () => ({ problems: [WHISPER] }) })
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    expect(await screen.findByText(en('models.engineProblem.fixed'))).toBeInTheDocument()
    expect(screen.queryByText(en('models.engineProblem.stillFailing'))).not.toBeInTheDocument()
  })

  it('a healed chat engine toasts "runs again"', async () => {
    const user = userEvent.setup()
    renderNotice(LIBGOMP, { onRecheck: async () => ({ problems: [] }) })
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    expect(await screen.findByText(en('models.engineProblem.fixed'))).toBeInTheDocument()
  })

  it('a healed voice engine toasts the voice wording', async () => {
    const user = userEvent.setup()
    renderNotice(WHISPER, { variant: 'hint', onRecheck: async () => ({ problems: [] }) })
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    expect(await screen.findByText(en('models.engineProblem.voiceFixed'))).toBeInTheDocument()
  })

  it('a rejection shows the rejection message as-is and re-enables the button', async () => {
    const user = userEvent.setup()
    renderNotice(LIBGOMP, {
      onRecheck: async () => {
        throw new Error('Could not check right now.')
      }
    })
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    expect(await screen.findByText('Could not check right now.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en('models.engineProblem.check') })).toBeEnabled()
  })
})

describe('EngineProblemNotice — hint variant (#530)', () => {
  it('shows the voice title + reason in a .hint paragraph', () => {
    renderNotice(WHISPER, { variant: 'hint' })
    const reason = en('models.engineProblem.libraryMissingPackage', {
      library: 'libgomp.so.1',
      debPackage: 'libgomp1',
      rpmPackage: 'libgomp'
    })
    const line = screen.getByText(`${en('models.engineProblem.voiceTitle')} ${reason}`)
    expect(line.tagName).toBe('P')
    expect(line).toHaveClass('hint')
    // The hint is quiet: no banner, no demo-mode note (chat is unaffected).
    expect(document.querySelector('.banner')).toBeNull()
    expect(screen.queryByText(en('models.engineProblem.demoNote'))).not.toBeInTheDocument()
  })

  it('the outcome status region is mounted from the start, empty — an a11y rule (M-U1)', async () => {
    const user = userEvent.setup()
    renderNotice(WHISPER, { variant: 'hint', onRecheck: async () => ({ problems: [WHISPER] }) })
    // Present and EMPTY before any check: a status region inserted already holding text is missed.
    const statusIn = (): HTMLElement => document.querySelector('.engine-problem-hint [role=status]') as HTMLElement
    const status = statusIn()
    expect(status).toBeInTheDocument()
    expect(status).toHaveTextContent('')
    await user.click(screen.getByRole('button', { name: en('models.engineProblem.check') }))
    await waitFor(() => expect(status).toHaveTextContent(en('models.engineProblem.stillFailing')))
    // Same node all along (updated in place, not re-inserted).
    expect(statusIn()).toBe(status)
  })
})

describe('EngineProblemNotice — German (#530)', () => {
  const de: Translator = (k, p) => t('de', k, p)

  it('renders the German reason and button', () => {
    renderNotice(LIBGOMP, { t: de })
    expect(screen.getByText(t('de', 'models.engineProblem.title'))).toBeInTheDocument()
    const reason = screen.getByText(/Eine Systembibliothek, die sie braucht, fehlt: libgomp\.so\.1\./)
    expect(reason).toHaveTextContent('„Erneut prüfen“')
    expect(reason).toHaveTextContent('libgomp1')
    expect(screen.getByRole('button', { name: 'Erneut prüfen' })).toBeInTheDocument()
  })
})

// ---- 5: ModelsScreen -------------------------------------------------------------------------

const IDLE_ENGINE: EngineStatus = {
  installed: true,
  available: true,
  version: null,
  backend: null,
  missingFamilies: []
}
const IDLE_RUNTIME: RuntimeStatus = {
  running: false,
  modelId: null,
  startingModelId: null,
  port: null,
  healthy: false,
  message: ''
}
const NO_OCR_SOURCES: OcrInstallStatus = {
  available: false,
  languages: [],
  totalBytes: 0,
  sourceHost: null,
  license: 'Apache-2.0'
}

describe('ModelsScreen — engine problem banner (#530)', () => {
  beforeEach(() => {
    __resetModelsScreenMemoryForTests()
    __resetKnowledgePackToolsInstallForTests()
  })

  function stubModels(opts: {
    problems: () => EngineProblem[]
    recheckEngine?: Mock
    engine?: EngineStatus
    runtime?: RuntimeStatus
  }): { push: () => void; recheckEngine: Mock } {
    let subscriber: (() => void) | null = null
    const recheckEngine = opts.recheckEngine ?? vi.fn(async (): Promise<EngineRecheckResult> => ({ problems: opts.problems() }))
    stubApi({
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getPolicy: vi.fn(async () => makePolicyStatus({ network: { allowModelDownloads: true }, allowNetworkSetting: true })),
      getAppStatus: vi.fn(async () => appStatus({ engineProblems: opts.problems() })),
      getEngineStatus: vi.fn(async () => opts.engine ?? IDLE_ENGINE),
      onEngineProblemsChanged: vi.fn((cb: () => void) => {
        subscriber = cb
        return () => {
          subscriber = null
        }
      }),
      recheckEngine,
      getOcrInstallStatus: vi.fn(async () => NO_OCR_SOURCES),
      getRuntimeStatus: vi.fn(async () => opts.runtime ?? IDLE_RUNTIME),
      onModelVerifyProgress: vi.fn(() => () => {}),
      listDownloadJobs: vi.fn(async () => [])
    })
    return { push: () => subscriber?.(), recheckEngine }
  }

  const renderModels = (): ReturnType<typeof render> =>
    render(
      <ToastProvider>
        <ModelsScreen />
      </ToastProvider>
    )

  it('shows the banner when the status carries a chat-engine problem', async () => {
    stubModels({ problems: () => [LIBGOMP] })
    renderModels()
    expect(await screen.findByText(en('models.engineProblem.title'))).toBeInTheDocument()
  })

  it('hides the optional voice-engine banner while the chat engine cannot run (its copy says chat works)', async () => {
    const voiceMissing: EngineStatus = { ...IDLE_ENGINE, missingFamilies: ['whisper_cpp'] }
    stubModels({ problems: () => [LIBGOMP], engine: voiceMissing })
    const { unmount } = renderModels()
    expect(await screen.findByText(en('models.engineProblem.title'))).toBeInTheDocument()
    expect(screen.queryByText(en('models.voiceEngine.title'))).not.toBeInTheDocument()
    unmount()
    __resetModelsScreenMemoryForTests()
    stubModels({ problems: () => [], engine: voiceMissing })
    renderModels()
    expect(await screen.findByText(en('models.voiceEngine.title'))).toBeInTheDocument()
  })

  it('drops the demo note while a REAL runtime answers (a cpu/ build beside a damaged main folder)', async () => {
    stubModels({
      problems: () => [LIBGOMP],
      runtime: { ...IDLE_RUNTIME, running: true, modelId: 'm', backend: 'cpu', healthy: true }
    })
    renderModels()
    expect(await screen.findByText(en('models.engineProblem.title'))).toBeInTheDocument()
    await waitFor(() => expect(window.api.getRuntimeStatus).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(en('models.engineProblem.demoNote'))).not.toBeInTheDocument())
  })

  it('shows nothing when there is no problem', async () => {
    const s = stubModels({ problems: () => [] })
    renderModels()
    await waitFor(() => expect(window.api.getAppStatus).toHaveBeenCalled())
    await waitFor(() => expect(window.api.onEngineProblemsChanged).toHaveBeenCalled())
    expect(s.push).toBeTypeOf('function')
    expect(screen.queryByText(en('models.engineProblem.title'))).not.toBeInTheDocument()
  })

  it('the engine:problemsChanged push re-reads the status and removes the banner', async () => {
    let problems: EngineProblem[] = [LIBGOMP]
    const s = stubModels({ problems: () => problems })
    renderModels()
    expect(await screen.findByText(en('models.engineProblem.title'))).toBeInTheDocument()
    problems = []
    act(() => s.push())
    await waitFor(() => expect(screen.queryByText(en('models.engineProblem.title'))).not.toBeInTheDocument())
  })

  it('a verdict that lands after mount shows up on the push', async () => {
    let problems: EngineProblem[] = []
    const s = stubModels({ problems: () => problems })
    renderModels()
    await waitFor(() => expect(window.api.onEngineProblemsChanged).toHaveBeenCalled())
    expect(screen.queryByText(en('models.engineProblem.title'))).not.toBeInTheDocument()
    problems = [LIBGOMP]
    act(() => s.push())
    expect(await screen.findByText(en('models.engineProblem.title'))).toBeInTheDocument()
  })

  it('Check again calls window.api.recheckEngine', async () => {
    const user = userEvent.setup()
    const s = stubModels({ problems: () => [LIBGOMP] })
    renderModels()
    await user.click(await screen.findByRole('button', { name: en('models.engineProblem.check') }))
    await waitFor(() => expect(s.recheckEngine).toHaveBeenCalledTimes(1))
  })

  it('a rejected recheckEngine surfaces a friendly message in the banner', async () => {
    const user = userEvent.setup()
    stubModels({
      problems: () => [LIBGOMP],
      recheckEngine: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    renderModels()
    await user.click(await screen.findByRole('button', { name: en('models.engineProblem.check') }))
    // The screen maps the raw error through friendlyIpcError; the banner shows whatever it returns.
    await waitFor(() => expect(screen.getByRole('button', { name: en('models.engineProblem.check') })).toBeEnabled())
    expect(screen.getByText(en('models.engineProblem.title'))).toBeInTheDocument()
  })
})

// ---- 6: HomeScreen ---------------------------------------------------------------------------

describe('HomeScreen — engine problem and demo runtime (#530)', () => {
  function renderHome(opts: {
    problems?: EngineProblem[]
    runtime: Partial<RuntimeStatus>
    onNavigate?: (t: string) => void
  }): void {
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'qwen3-chat', engineProblems: opts.problems })),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async (): Promise<PreflightResult> => ({ rootPath: '/drive', writable: true, freeBytes: 1e9, slowDriveWarning: null, problems: [] })),
      getRuntimeStatus: vi.fn(async () => ({ ...IDLE_RUNTIME, ...opts.runtime })),
      getMovedDriveNotice: vi.fn(async () => null),
      onPerformanceChanged: vi.fn(() => () => {}),
      onEngineProblemsChanged: vi.fn(() => () => {})
    })
    render(<HomeScreen onNavigate={opts.onNavigate ?? vi.fn()} />)
  }

  const RUNNING = { running: true, modelId: 'qwen3-chat', port: 1, healthy: true, message: 'Running' }

  it('an engine problem: the row says it, the badge says it, and the loud primary leads to AI Model', async () => {
    const onNavigate = vi.fn()
    renderHome({ problems: [LIBGOMP], runtime: RUNNING, onNavigate })
    expect(await screen.findByText(en('home.model.engineCannotRun'))).toBeInTheDocument()
    expect(screen.getByText(en('home.model.badgeEngine'))).toBeInTheDocument()
    // The headline does not claim "ready" either.
    expect(screen.queryByText(en('home.headline.ready'))).not.toBeInTheDocument()
    // Two "Go to AI Model" buttons: the row's small one, and the hero primary.
    const buttons = screen.getAllByRole('button', { name: en('home.model.open') })
    const primary = buttons.filter((b) => b.classList.contains('primary'))
    expect(primary).toHaveLength(1)
    await userEvent.click(primary[0])
    expect(onNavigate).toHaveBeenCalledWith('models')
    // Chatting stays reachable, as a secondary.
    const chat = screen.getByRole('button', { name: en('home.actions.startChat') })
    expect(chat).not.toHaveClass('primary')
  })

  it('a voice-only problem does not touch the chat model row', async () => {
    renderHome({ problems: [WHISPER], runtime: RUNNING })
    expect(await screen.findByText(en('home.model.running', { model: 'qwen3-chat' }))).toBeInTheDocument()
    expect(screen.queryByText(en('home.model.engineCannotRun'))).not.toBeInTheDocument()
  })

  it('a running MOCK runtime with no engine problem says demo mode with the model id', async () => {
    renderHome({ runtime: { ...RUNNING, backend: 'mock' } })
    expect(await screen.findByText(en('home.model.demo', { model: 'qwen3-chat' }))).toBeInTheDocument()
    expect(screen.getByText(en('home.model.badgeDemo'))).toBeInTheDocument()
    expect(screen.queryByText(en('home.model.engineCannotRun'))).not.toBeInTheDocument()
    expect(screen.queryByText(en('home.model.running', { model: 'qwen3-chat' }))).not.toBeInTheDocument()
  })

  it('an engine problem beside a REAL runtime (a cpu/ build answering) does not claim simulated replies', async () => {
    // Review fix: a Windows Kit's cpu/ build can run beside a damaged main folder — chat works.
    renderHome({ problems: [LIBGOMP], runtime: { ...RUNNING, backend: 'cpu' } })
    expect(await screen.findByText(en('home.model.running', { model: 'qwen3-chat' }))).toBeInTheDocument()
    expect(screen.queryByText(en('home.model.engineCannotRun'))).not.toBeInTheDocument()
  })

  it('a running CPU runtime keeps the unchanged "is running" copy', async () => {
    renderHome({ runtime: { ...RUNNING, backend: 'cpu' } })
    expect(await screen.findByText(en('home.model.running', { model: 'qwen3-chat' }))).toBeInTheDocument()
    expect(screen.queryByText(en('home.model.badgeDemo'))).not.toBeInTheDocument()
    expect(screen.queryByText(en('home.model.badgeEngine'))).not.toBeInTheDocument()
  })
})

// ---- 7: the App notice -----------------------------------------------------------------------

describe('App — runtime notice target (#530)', () => {
  beforeAll(() => {
    Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: () => {}
    })
  })
  beforeEach(() => {
    __resetModelsScreenMemoryForTests()
    __resetKnowledgePackToolsInstallForTests()
  })

  const unlocked: WorkspaceStateInfo = {
    state: 'unlocked',
    mode: 'plaintext_dev',
    plaintextAllowed: true,
    encryptionRequired: false
  }

  function renderApp(opts: { problems?: () => EngineProblem[] } = {}): {
    fire: (message: string, target?: 'models') => void
    push: () => void
  } {
    let subscriber: ((message: string, target?: 'models') => void) | null = null
    // Several components subscribe (App, Home, …): keep them all, as the real preload does.
    const engineSubscribers = new Set<() => void>()
    stubApi({
      getWorkspaceState: vi.fn(async () => unlocked),
      getPolicy: vi.fn(async () => makePolicyStatus({ policyFilePresent: false, driveFilePresent: false })),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      onRuntimeNotice: vi.fn((cb: (message: string, target?: 'models') => void) => {
        subscriber = cb
        return () => {
          subscriber = null
        }
      }),
      onEngineProblemsChanged: vi.fn((cb: () => void) => {
        engineSubscribers.add(cb)
        return () => {
          engineSubscribers.delete(cb)
        }
      }),
      getAppStatus: vi.fn(async () => ({ ...appStatus({ machineRamGb: 16 }), engineProblems: opts.problems?.() ?? [] })),
      getRuntimeStatus: vi.fn(async () => IDLE_RUNTIME),
      listDocuments: vi.fn(async () => []),
      listModels: vi.fn(async () => []),
      runPreflight: vi.fn(async (): Promise<PreflightResult> => ({ rootPath: '/drive', writable: true, freeBytes: 1e9, slowDriveWarning: null, problems: [] })),
      getEngineStatus: vi.fn(async () => IDLE_ENGINE),
      getOcrInstallStatus: vi.fn(async () => NO_OCR_SOURCES),
      onModelVerifyProgress: vi.fn(() => () => {}),
      listDownloadJobs: vi.fn(async () => []),
      getDriveStatus: vi.fn(async () => driveStatus()),
      getRuntimeInstall: vi.fn(async () => null),
      getLogTail: vi.fn(async () => [])
    })
    render(<App />)
    return { fire: (message, target) => subscriber?.(message, target), push: () => engineSubscribers.forEach((cb) => cb()) }
  }

  it("a 'models' notice's button reads 'Go to AI Model' and navigates there", async () => {
    const user = userEvent.setup()
    const app = renderApp()
    const nav = await screen.findByRole('navigation')
    await waitFor(() => expect(window.api.onRuntimeNotice).toHaveBeenCalled())
    const message = 'The AI engine can not run here (test notice).'
    act(() => app.fire(message, 'models'))
    const text = await screen.findByText(message)
    const banner = text.closest('.banner') as HTMLElement
    expect(within(banner).queryByRole('button', { name: en('app.noticeDetails') })).not.toBeInTheDocument()
    const go = within(banner).getByRole('button', { name: en('app.noticeGoToModels') })
    expect(within(nav).getByRole('button', { name: 'AI Model' })).not.toHaveAttribute('aria-current')
    await user.click(go)
    await waitFor(() => expect(within(nav).getByRole('button', { name: 'AI Model' })).toHaveAttribute('aria-current', 'page'))
  })

  it('the engine notice leaves once the chat engine runs again (Check again healed it)', async () => {
    let problems: EngineProblem[] = [LIBGOMP]
    const app = renderApp({ problems: () => problems })
    await screen.findByRole('navigation')
    await waitFor(() => expect(window.api.onEngineProblemsChanged).toHaveBeenCalled())
    // The verdict is read on mount (several readers share the stub); let those reads settle.
    await waitFor(() => expect(window.api.getAppStatus).toHaveBeenCalled())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    const message = 'The AI engine can not run here (test notice).'
    act(() => app.fire(message, 'models'))
    expect(await screen.findByText(message)).toBeInTheDocument()
    // A different notice (no target) must survive the same transition — only the engine one goes.
    problems = []
    act(() => app.push())
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument())
  })

  it('an engine notice that arrives before any verdict was read is not cleared by that first read', async () => {
    const app = renderApp({ problems: () => [] })
    await screen.findByRole('navigation')
    await waitFor(() => expect(window.api.onRuntimeNotice).toHaveBeenCalled())
    const message = 'The AI engine can not run here (early notice).'
    act(() => app.fire(message, 'models'))
    act(() => app.push()) // a re-read that finds nothing — no true→false transition happened
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it('a notice without a target keeps the "Details" button (Diagnostics)', async () => {
    const user = userEvent.setup()
    const app = renderApp()
    const nav = await screen.findByRole('navigation')
    await waitFor(() => expect(window.api.onRuntimeNotice).toHaveBeenCalled())
    const message = 'Switched to compatibility mode (test notice).'
    act(() => app.fire(message))
    const banner = (await screen.findByText(message)).closest('.banner') as HTMLElement
    expect(within(banner).queryByRole('button', { name: en('app.noticeGoToModels') })).not.toBeInTheDocument()
    await user.click(within(banner).getByRole('button', { name: en('app.noticeDetails') }))
    // Diagnostics lives on a Settings tab: the rail's Settings item lights up.
    await waitFor(() => expect(within(nav).getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page'))
  })
})

// ---- 8: Diagnostics --------------------------------------------------------------------------

describe('Settings → Diagnostics — engine problem line (#530)', () => {
  let lastCopied: string | null = null

  function stubDiagnostics(problems: EngineProblem[]): void {
    lastCopied = null
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ appVersion: '0.1.20', engineProblems: problems })),
      getDriveStatus: vi.fn(async () => driveStatus()),
      getRuntimeStatus: vi.fn(async () => IDLE_RUNTIME),
      getRuntimeInstall: vi.fn(async () => null),
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

  const line = (): string =>
    en('diag.engine.cannotRun', { reason: en('diag.engine.reason.libraryMissing') }) + ' (libgomp.so.1, exit code 127)'

  it('shows the label as a dt and the reason + technical detail as its dd, and copies the same line', async () => {
    const user = userEvent.setup()
    stubDiagnostics([LIBGOMP])
    renderDiagnostics()
    const dd = await screen.findByText(line())
    expect(dd.tagName).toBe('DD')
    const dt = screen.getByText(en('diag.app.engine'))
    expect(dt.tagName).toBe('DT')
    expect(dt.nextElementSibling).toBe(dd)
    await user.click(screen.getAllByRole('button', { name: en('diag.copy') })[0])
    await waitFor(() => expect(lastCopied).not.toBeNull())
    expect(lastCopied).toContain(`${en('diag.app.engine')}: ${line()}`)
  })

  it('a voice-engine problem is labelled "Voice engine"', async () => {
    stubDiagnostics([WHISPER])
    renderDiagnostics()
    expect(await screen.findByText(en('diag.app.voiceEngine'))).toBeInTheDocument()
    expect(screen.queryByText(en('diag.app.engine'))).not.toBeInTheDocument()
  })

  it('shows no engine line when there is no problem', async () => {
    stubDiagnostics([])
    renderDiagnostics()
    await screen.findByText(en('diag.app.runtimeBuild'))
    expect(screen.queryByText(en('diag.app.engine'))).not.toBeInTheDocument()
  })
})

// ---- 9: Performance --------------------------------------------------------------------------

describe('PerformanceScreen — graphics tile under an engine problem (#530)', () => {
  function stubPerformance(problems: EngineProblem[]): void {
    const snap: PerformanceSnapshot = {
      ...performanceSnapshot(),
      current: {
        os: 'linux',
        arch: 'x64',
        cpuModel: 'Intel Core i7-1260P',
        cpuCores: 12,
        ramGb: 15.7,
        gpu: null,
        gpuVramMb: null,
        driveReadMbps: null,
        driveWriteMbps: 312,
        tokensPerSecond: 12,
        profile: 'LITE',
        recommendedModelId: null,
        warnings: [],
        ranAt: '2026-09-04T14:02:00Z'
      } as PerformanceSnapshot['current'],
      currentMachine: true,
      currentGpu: null,
      graphicsDevice: null
    }
    stubApi({
      getPerformance: vi.fn(async () => snap),
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getRuntimeStatus: vi.fn(async () => IDLE_RUNTIME),
      getAppStatus: vi.fn(async () => appStatus({ engineProblems: problems })),
      onBenchmarkProgress: vi.fn(() => () => {}),
      onPerformanceChanged: vi.fn(() => () => {}),
      onEngineProblemsChanged: vi.fn(() => () => {})
    })
  }
  const renderPerf = (): void => {
    render(
      <ToastProvider>
        <PerformanceScreen onNavigate={vi.fn()} />
      </ToastProvider>
    )
  }

  it('says the engine could not check the card, with an "Unknown" pill, instead of "no usable card"', async () => {
    stubPerformance([LIBGOMP])
    renderPerf()
    expect(await screen.findByText(en('perf.tile.graphics.engine'))).toBeInTheDocument()
    expect(screen.getByText(en('perf.rating.unknown'))).toBeInTheDocument()
    expect(screen.queryByText(en('perf.tile.graphics.none'))).not.toBeInTheDocument()
  })

  it('without a problem the same snapshot still reads "no usable graphics card"', async () => {
    stubPerformance([])
    renderPerf()
    expect(await screen.findByText(en('perf.tile.graphics.none'))).toBeInTheDocument()
    expect(screen.queryByText(en('perf.tile.graphics.engine'))).not.toBeInTheDocument()
  })

  it('a voice-only problem does not change the graphics tile', async () => {
    stubPerformance([WHISPER])
    renderPerf()
    expect(await screen.findByText(en('perf.tile.graphics.none'))).toBeInTheDocument()
  })
})

// ---- 10: the engineCannotRun error codes -----------------------------------------------------

describe('engineCannotRun error code copy (#530)', () => {
  it('AnswerThread renders images.err.engineCannotRun', () => {
    const turn: ImageTurn = { id: 't1', question: 'What?', answer: '', state: 'failed', error: 'engineCannotRun' }
    render(<AnswerThread turns={[turn]} onCopy={() => {}} onTryAgain={() => {}} onStop={() => {}} busy={false} />)
    expect(screen.getByText(en('images.err.engineCannotRun'))).toBeInTheDocument()
    expect(screen.queryByText(en('images.err.runtimeFailed'))).not.toBeInTheDocument()
  })

  describe('TranslateScreen', () => {
    afterEach(() => {
      resetTranslateSessionForTests()
      resetFileTranslateSessionForTests()
      resetDocTaskStoreForTests()
    })

    it('renders translate.err.engineCannotRun', async () => {
      const user = userEvent.setup()
      stubApi({
        getAppStatus: vi.fn(async () => appStatus({ translationAvailable: true })),
        getActiveTranslateJob: vi.fn(async () => null),
        translateStart: vi.fn(async (): Promise<TranslateJob> => ({ jobId: 'x', state: 'failed', text: '', error: 'engineCannotRun' })),
        translateCancel: vi.fn(),
        copyToClipboard: vi.fn(async () => true),
        onTranslateToken: vi.fn(() => () => {}),
        onTranslateDone: vi.fn(() => () => {}),
        onTranslateError: vi.fn(() => () => {})
      })
      render(<TranslateScreen onNavigate={() => {}} />)
      await user.type(await screen.findByLabelText(en('translate.input.label')), 'Hallo')
      await user.click(screen.getByRole('button', { name: en('translate.action') }))
      expect(await screen.findByText(en('translate.err.engineCannotRun'))).toBeInTheDocument()
      expect(screen.queryByText(en('translate.err.runtimeFailed'))).not.toBeInTheDocument()
    })
  })
})
