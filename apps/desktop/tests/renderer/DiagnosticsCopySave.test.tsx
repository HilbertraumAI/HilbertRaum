// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { ToastProvider } from '../../src/renderer/components'
import { DEFAULT_SETTINGS, type BenchmarkResult, type RuntimeStatus } from '../../src/shared/types'
import { normalizeBenchmarkResult } from '../../src/shared/benchmark-schema'
import { stubApi } from '../helpers/renderer'
import { appStatus, driveStatus } from '../helpers/status'

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
  // #291: measured from the runtime's own decode timings over the 64-token probe window.
  speedBasis: { basis: 'timings', tokens: 64 },
  // #108: the honest read figure from a real load window (6.0 GB in 85.2 s ≈ 70.4 MB/s
  // — the USB-stick class the field exists to expose).
  effectiveRead: {
    mbps: 70.4,
    bytes: 6_000_000_000,
    ms: 85_200,
    source: 'model_load',
    modelId: 'mock-chat-8b',
    at: '2026-06-15T11:58:00Z'
  },
  ranAt: '2026-06-15T12:00:00Z',
  warnings: []
}

// Capture what the renderer hands to Electron's native clipboard bridge
// (window.api.copyToClipboard) — we no longer use navigator.clipboard.
let lastCopied: string | null = null

function stubDiagnostics(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  bench: BenchmarkResult = benchmark
): void {
  lastCopied = null
  stubApi({
    getAppStatus: vi.fn(async () =>
      appStatus({ appVersion: '0.1.20', activeModelId: 'qwen3-4b', hardwareProfile: 'BALANCED' })
    ),
    getDriveStatus: vi.fn(async () => driveStatus()),
    getRuntimeStatus: vi.fn(async () => runtimeStatus),
    getRuntimeInstall: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, lastBenchmark: bench })),
    copyToClipboard: vi.fn(async (text: string) => {
      lastCopied = text
      return true
    }),
    ...overrides
  })
}

function renderDiagnostics() {
  return render(
    <ToastProvider>
      <SettingsScreen tab="diagnostics" />
    </ToastProvider>
  )
}

afterEach(cleanup)

describe('Settings → Diagnostics (advanced) — the local API row', () => {
  it('reports the live counters, and shows the same line in the copy report', async () => {
    const user = userEvent.setup()
    stubDiagnostics({
      getAppStatus: vi.fn(async () =>
        appStatus({
          appVersion: '0.1.20',
          localApi: {
            running: true,
            port: 4980,
            tokenRequired: true,
            requestsServed: 7,
            rejectedCount: 2,
            lastError: null,
            externalActive: false,
            lastPreemptedAt: null
          }
        })
      )
    })
    renderDiagnostics()
    const line = 'On · port 4980 · 7 answered, 2 refused'
    expect(await screen.findByText(line)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    expect(lastCopied).toContain(line)
  })

  it('an endpoint that was switched off after a bind failure reads "Off", not "port in use"', async () => {
    // The server clears `lastError` on a deliberate stop, so a stale failure can never
    // outlive the feature being turned off (review 2026-08-18) — this is the surface that
    // would otherwise keep repeating it, in the row AND in a support paste.
    stubDiagnostics({
      getAppStatus: vi.fn(async () =>
        appStatus({
          localApi: {
            running: false,
            port: null,
            tokenRequired: true,
            requestsServed: 0,
            rejectedCount: 0,
            lastError: null,
            externalActive: false,
            lastPreemptedAt: null
          }
        })
      )
    })
    renderDiagnostics()
    expect(await screen.findByText('Off')).toBeInTheDocument()
    expect(screen.queryByText(/port number is already in use/)).not.toBeInTheDocument()
  })

  it('still names a bind failure while it is the live state', async () => {
    stubDiagnostics({
      getAppStatus: vi.fn(async () =>
        appStatus({
          localApi: {
            running: false,
            port: null,
            tokenRequired: true,
            requestsServed: 0,
            rejectedCount: 0,
            lastError: 'port_in_use',
            externalActive: false,
            lastPreemptedAt: null
          }
        })
      )
    })
    renderDiagnostics()
    expect(await screen.findByText('Off — the port number is already in use')).toBeInTheDocument()
  })
})

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
    // #108 (F-35 resolution): the page-cache-inflated "Drive read (cached)" figure is retired
    // from display — the report carries the honest measured read speed instead, and the raw
    // driveReadMbps value (120 in this fixture) must appear NOWHERE in the copied text.
    expect(lastCopied).toContain(
      'Measured read speed: 70.4 MB/s (from a model load on 6/15/2026, 6.0 GB read)'
    )
    expect(lastCopied).not.toContain('Drive read (cached)')
    expect(lastCopied).not.toContain('120 MB/s')
    // Issue #52: the tok/s line names the model that produced the number (the loaded one,
    // not the recommended one) in the card AND the copied report.
    // #291: the label says decode speed, the value names its token window.
    expect(lastCopied).toContain(
      'Decode speed (tokens / sec): 30 (over 64 tokens; measured with the loaded model mock-chat-8b)'
    )
    expect(lastCopied).not.toContain('approximate')
  })

  it('marks a chunk-count fallback reading approximate in the card and the copy (#291)', async () => {
    const user = userEvent.setup()
    stubDiagnostics({}, { ...benchmark, speedBasis: { basis: 'chunks', tokens: 41 } })
    renderDiagnostics()
    await screen.findByText('Test CPU', { exact: false })
    expect(screen.getByText(/≈ 30 \(approximate — counted chunks, not runtime timings; measured with the loaded model mock-chat-8b\)/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])
    expect(lastCopied).toContain(
      'Decode speed (tokens / sec): ≈ 30 (approximate — counted chunks, not runtime timings; measured with the loaded model mock-chat-8b)'
    )
  })

  it('renders a result persisted before speedBasis existed as approximate (#291 — they were all chunk-based)', async () => {
    const legacy = { ...benchmark }
    delete (legacy as Partial<BenchmarkResult>).speedBasis
    stubDiagnostics({}, legacy)
    renderDiagnostics()
    await screen.findByText('Test CPU', { exact: false })
    expect(screen.getByText(/≈ 30 \(approximate/)).toBeInTheDocument()
    expect(screen.queryByText(/over 64 tokens/)).not.toBeInTheDocument()
  })

  it('renders "not measured yet" for a result persisted before the effective-read field existed', async () => {
    const user = userEvent.setup()
    const legacy = { ...benchmark }
    delete (legacy as Partial<BenchmarkResult>).effectiveRead
    stubDiagnostics({}, legacy)
    renderDiagnostics()

    await screen.findByText('Test CPU', { exact: false })
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])
    expect(lastCopied).toContain(
      'Measured read speed: not measured yet — starting a model measures it'
    )
  })

  it('renders the tok/s row without a model name for a result persisted before issue #52', async () => {
    const legacy = { ...benchmark }
    delete (legacy as Partial<BenchmarkResult>).measuredModelId
    stubDiagnostics({}, legacy)
    renderDiagnostics()

    // The card row shows the number without a model name, exactly as before the field existed
    // (the #291 token-window note still renders — the fixture carries a timings basis).
    await screen.findByText('Test CPU', { exact: false })
    expect(screen.getByText('30 (over 64 tokens)')).toBeInTheDocument()
    expect(screen.queryByText(/measured with the loaded model/)).not.toBeInTheDocument()
  })

  // PR #303 audit H1: `getSettings` validates `lastBenchmark` now, and the legacy `{ profile }`
  // blob normalizes to a record with an UNKNOWN identity and an UNKNOWN date (`ranAt: ''`,
  // never a fabricated "now"). This is the shape the tab is actually handed for such a
  // workspace — it must render it, and say "unknown" rather than print "Invalid Date".
  it('renders the normalized legacy result (unknown RAM, unknown date) without throwing', async () => {
    const user = userEvent.setup()
    const legacy = normalizeBenchmarkResult({ profile: 'BALANCED' })!
    expect(legacy.ranAt).toBe('')
    stubDiagnostics({}, legacy)
    renderDiagnostics()

    expect(await screen.findByText('Hardware benchmark')).toBeInTheDocument()
    // Twice: the App-&-runtime profile row and the benchmark card's own.
    expect(screen.getAllByText('BALANCED').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('No matching model')).toBeInTheDocument()
    // RAM, CPU and OS already said "unknown"; the date now does too.
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])
    expect(lastCopied).toContain('Last run: unknown')
    expect(lastCopied).not.toContain('Invalid Date')
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
