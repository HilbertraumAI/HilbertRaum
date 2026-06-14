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
  ranAt: '2026-06-15T12:00:00Z',
  warnings: []
}

function stubDiagnostics(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): void {
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
    const copied = await navigator.clipboard.readText()
    expect(copied).toContain('App & runtime')
    expect(copied).toContain('HilbertRaum 0.1.20')
    expect(copied).toContain('BALANCED')
  })

  it('copies the hardware benchmark details to the clipboard', async () => {
    const user = userEvent.setup()
    stubDiagnostics()
    renderDiagnostics()

    // Benchmark Copy renders only once the last benchmark has loaded.
    await screen.findByText('Test CPU', { exact: false })
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])

    const copied = await navigator.clipboard.readText()
    expect(copied).toContain('Hardware benchmark')
    expect(copied).toContain('Test CPU')
    expect(copied).toContain('120 MB/s')
  })

  it('copies the logs from a fresh tail read', async () => {
    const user = userEvent.setup()
    const getLogTail = vi.fn(async () => ['2026-06-15 [INFO] started', '2026-06-15 [WARN] hmm'])
    stubDiagnostics({ getLogTail })
    renderDiagnostics()

    // Logs Copy is the last Copy button (App, Benchmark, Logs).
    const copyButtons = await screen.findAllByRole('button', { name: 'Copy' })
    await user.click(copyButtons[copyButtons.length - 1])

    expect(getLogTail).toHaveBeenCalled()
    expect(await navigator.clipboard.readText()).toContain('[WARN] hmm')
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
