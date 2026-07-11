// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { ToastProvider } from '../../src/renderer/components'
import { DEFAULT_SETTINGS, type BenchmarkResult, type RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Diagnostics copy/save: the per-card "Copy" buttons (App & runtime, Hardware benchmark,
// Logs) hand technical details to support without retyping, and "Save to file…" writes the
// full log as plaintext to a user-chosen location (the on-disk log stays encrypted).

const runtimeStatus: RuntimeStatus = {
  running: false,
  modelId: null,
  port: null,
  healthy: false,
  message: 'Stopped'
}

const benchmark: BenchmarkResult = {
  profile: 'BALANCED',
  recommendedModelId: 'qwen3-4b',
  ramGb: 16,
  cpuModel: 'Test CPU',
  cpuCores: 8,
  os: 'win32',
  arch: 'x64',
  gpu: null,
  driveReadMbps: 120,
  driveWriteMbps: 90,
  tokensPerSecond: 30,
  // Issue #52: the loaded model at measure time — deliberately DIFFERENT from
  // recommendedModelId above, since disambiguating the two is the point of the label.
  measuredModelId: 'mock-chat-8b',
  ranAt: '2026-06-15T12:00:00Z',
  warnings: []
}

// Capture what the renderer hands to Electron's native clipboard bridge
// (window.api.copyToClipboard) — we no longer use navigator.clipboard.
let lastCopied: string | null = null

function stubDiagnostics(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): void {
  lastCopied = null
  stubApi({
    getAppStatus: vi.fn(async () => ({
      appName: 'HilbertRaum',
      appVersion: '0.1.20',
      activeModelId: 'qwen3-4b',
      hardwareProfile: 'BALANCED'
    })) as never,
    getDriveStatus: vi.fn(async () => ({}) as never),
    getRuntimeStatus: vi.fn(async () => runtimeStatus),
    getRuntimeInstall: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, lastBenchmark: benchmark })),
    copyToClipboard: vi.fn(async (text: string) => {
      lastCopied = text
      return true
    }),
    ...overrides
  } as never)
}

function renderDiagnostics() {
  return render(
    <ToastProvider>
      <SettingsScreen tab="diagnostics" />
    </ToastProvider>
  )
}

afterEach(cleanup)

describe('Settings → Diagnostics (advanced) — copy & save logs', () => {
  it('copies the App & runtime details to the clipboard', async () => {
    const user = userEvent.setup()
    stubDiagnostics()
    renderDiagnostics()

    // App card is first; its Copy button is the first one in DOM order.
    await screen.findByText('HilbertRaum 0.1.20')
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0])

    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument()
    expect(lastCopied).toContain('App & runtime')
    expect(lastCopied).toContain('HilbertRaum 0.1.20')
    expect(lastCopied).toContain('BALANCED')
  })

  it('copies the hardware benchmark details to the clipboard', async () => {
    const user = userEvent.setup()
    stubDiagnostics()
    renderDiagnostics()

    // Benchmark Copy renders only once the last benchmark has loaded.
    await screen.findByText('Test CPU', { exact: false })
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])

    expect(lastCopied).toContain('Hardware benchmark')
    expect(lastCopied).toContain('Test CPU')
    expect(lastCopied).toContain('120 MB/s')
    // Issue #52: the tok/s line names the model that produced the number (the loaded one,
    // not the recommended one) in the card AND the copied report.
    expect(lastCopied).toContain('Tokens / sec: 30 (measured with the loaded model mock-chat-8b)')
  })

  it('renders the tok/s row without a model name for a result persisted before issue #52', async () => {
    const legacy = { ...benchmark }
    delete (legacy as Partial<BenchmarkResult>).measuredModelId
    stubDiagnostics({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, lastBenchmark: legacy })) as never
    })
    renderDiagnostics()

    // The card row shows the bare number, exactly as before the field existed.
    await screen.findByText('Test CPU', { exact: false })
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.queryByText(/measured with the loaded model/)).not.toBeInTheDocument()
  })

  it('copies the logs from a fresh tail read', async () => {
    const user = userEvent.setup()
    const getLogTail = vi.fn(async () => ['2026-06-15 [INFO] started', '2026-06-15 [WARN] hmm'])
    stubDiagnostics({ getLogTail })
    renderDiagnostics()

    // Logs Copy is the last Copy button (App, Benchmark, Logs).
    const copyButtons = await screen.findAllByRole('button', { name: 'Copy' })
    await user.click(copyButtons[copyButtons.length - 1])

    // Copy is async (tail read → clipboard write in MAIN); wait for the confirmation toast.
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument()
    expect(getLogTail).toHaveBeenCalled()
    expect(lastCopied).toContain('[WARN] hmm')
  })

  it('saves the full log to a user-chosen file and confirms with a toast', async () => {
    const user = userEvent.setup()
    const exportLog = vi.fn(async () => 'D:\\exports\\hilbertraum-logs.txt')
    stubDiagnostics({ exportLog })
    renderDiagnostics()

    await user.click(await screen.findByRole('button', { name: /save to file/i }))
    expect(exportLog).toHaveBeenCalled()
    expect(
      await screen.findByText(/Logs saved to D:\\exports\\hilbertraum-logs\.txt/)
    ).toBeInTheDocument()
  })
})
