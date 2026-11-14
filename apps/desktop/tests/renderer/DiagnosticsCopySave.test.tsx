// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { ToastProvider } from '../../src/renderer/components'
import { DEFAULT_SETTINGS, type BenchmarkResult, type RuntimeStatus } from '../../src/shared/types'
import { normalizeBenchmarkResult } from '../../src/shared/benchmark-schema'
import { t, tCount, UI_LANGUAGE_CODES, type MessageKey, type UiLanguage } from '../../src/shared/i18n'
import { renderInLanguage } from '../helpers/render-language'
import { stubApi } from '../helpers/renderer'
import { appStatus, driveStatus, performanceSnapshot } from '../helpers/status'

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
    at: '2026-06-15T11:58:00' // a local time: the copy prints its date, and a UTC instant is another day somewhere
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
    // #327: the Acceleration line (on screen and in the App & runtime report) takes its device
    // from the snapshot's eligible probe, not from `settings.gpuProbe` — this box has none.
    getPerformance: vi.fn(async () => performanceSnapshot()),
    copyToClipboard: vi.fn(async (text: string) => {
      lastCopied = text
      return true
    }),
    ...overrides
  })
}

/** The tab under its ToastProvider; `lang` goes through `renderInLanguage` (English when omitted). */
function renderDiagnostics(lang?: UiLanguage) {
  const ui = (
    <ToastProvider>
      <SettingsScreen tab="diagnostics" />
    </ToastProvider>
  )
  return lang ? renderInLanguage(ui, lang) : render(ui)
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

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

  // UI-languages owner call D-11 (a): the core count picks its plural form here, not in the
  // catalog alone; until the UI languages wave one core read "(1 cores)".
  it('names a single core in the singular, in the card and the copy', async () => {
    const user = userEvent.setup()
    stubDiagnostics({}, { ...benchmark, cpuCores: 1 })
    renderDiagnostics()
    expect(await screen.findByText('Test CPU (1 core)')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])
    expect(lastCopied).toContain('CPU: Test CPU (1 core)')
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
    // §5 item 22 (b): the benchmark card no longer carries the profile or the recommended-model
    // row, so "BALANCED" is now the App-&-runtime row's alone and "No matching model" is gone
    // from this tab entirely. The point of the case is unchanged — the normalized legacy blob
    // must render without throwing and must say "unknown" rather than print "Invalid Date".
    expect(screen.getAllByText('BALANCED')).toHaveLength(1)
    expect(screen.queryByText('No matching model')).not.toBeInTheDocument()
    // RAM, CPU and OS already said "unknown"; the date now does too.
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])
    expect(lastCopied).toContain('Last run: unknown')
    expect(lastCopied).not.toContain('Invalid Date')
  })

  // §5 item 22 (b), owner decision 2026-09-08: the Diagnostics benchmark card is a SUPPORT
  // ARTIFACT — the raw measurement plus Copy. The action and the two interpretive rows moved to
  // the Performance screen, which owns both the answer and the same `runBenchmark()` call.
  describe('the benchmark card is the raw measurement only (§5 item 22 (b))', () => {
    it('drops the run action and its error banner — Performance owns the check', async () => {
      stubDiagnostics()
      renderDiagnostics()
      await screen.findByText('Test CPU', { exact: false })
      for (const name of [/run benchmark/i, /re-run benchmark/i, /running/i]) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      }
      // The card keeps its Copy — it is the support artifact, and the report is why it exists.
      expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThanOrEqual(2)
    })

    it('drops the interpretive rows from the card AND the copy report, keeping every raw row', async () => {
      const user = userEvent.setup()
      stubDiagnostics()
      renderDiagnostics()
      await screen.findByText('Test CPU', { exact: false })

      // Gone from the card: the assigned profile (the App & runtime card carries the LIVE one)
      // and the recommended model (the check's HISTORICAL pick — the live-vs-history confusion
      // the PR #303 audit named; the live pick is on the Performance screen).
      // (The App & runtime card's own "Selected model" row still names qwen3-4b — that one is
      // the LIVE selection, not the check's historical recommendation.)
      expect(screen.queryByText('Recommended model')).not.toBeInTheDocument()
      // "Assigned profile" is the benchmark card's label; "Hardware profile" is the App &
      // runtime one, which stays.
      expect(screen.queryByText('Assigned profile')).not.toBeInTheDocument()
      expect(screen.getByText('Hardware profile')).toBeInTheDocument()

      // Every RAW measurement row stays.
      // getAllByText: a few of these labels also appear on the System card below.
      for (const label of ['RAM', 'CPU', 'OS / arch', 'GPU', 'Measured read speed', 'Drive write', 'Decode speed (tokens / sec)', 'Last run']) {
        expect(screen.getAllByText(label).length, label).toBeGreaterThanOrEqual(1)
      }

      // The report MIRRORS the card: the two rows are not kept "for bug reports" either.
      await user.click(screen.getAllByRole('button', { name: 'Copy' })[1])
      expect(lastCopied).toContain('Hardware benchmark')
      expect(lastCopied).toContain('Test CPU')
      expect(lastCopied).not.toContain('Recommended model')
      expect(lastCopied).not.toContain('Assigned profile')
      // …and the App & runtime report still carries the LIVE profile, so nothing support needs
      // was actually lost from this tab.
      await user.click(screen.getAllByRole('button', { name: 'Copy' })[0])
      expect(lastCopied).toContain('Hardware profile: BALANCED')
    })

    it('with no check ever run, points at Performance instead of showing an empty card', async () => {
      stubDiagnostics({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, lastBenchmark: null })) })
      renderDiagnostics()
      expect(await screen.findByText('Hardware benchmark')).toBeInTheDocument()
      expect(
        screen.getByText('No check has run on this computer yet. Open the Performance screen to run one.')
      ).toBeInTheDocument()
      // No Copy for a report that would have nothing in it (App & runtime + Logs still have theirs).
      expect(screen.queryByText('Last run')).not.toBeInTheDocument()
    })
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

// #812 (owner call G-7): the maintainers read English and German. In any other interface language
// each report's Copy pastes the report, one divider line naming English, then the same report built
// in English, so a support request stays readable. The English half is compared with what an
// English interface copies from the same data, never with typed text.
describe('Settings → Diagnostics (advanced) — an English copy for support (#812)', () => {
  const DIVIDER = '--- English ---'
  const OTHER_LANGUAGES = UI_LANGUAGE_CODES.filter((code) => code !== 'en' && code !== 'de')
  const REPORTS: ReadonlyArray<{ name: string; button: number; title: MessageKey; lines: (lang: UiLanguage) => string[] }> = [
    {
      name: 'App & runtime',
      button: 0,
      title: 'diag.app.title',
      lines: (lang) => [
        `${t(lang, 'diag.app.version')}: HilbertRaum 0.1.20`,
        `${t(lang, 'diag.app.runtime')}: ${t(lang, 'diag.app.stopped')}`
      ]
    },
    {
      name: 'Hardware benchmark',
      button: 1,
      title: 'diag.bench.title',
      lines: (lang) => [
        `${t(lang, 'diag.bench.cpu')}: Test CPU${tCount(lang, 'diag.bench.cores', 8)}`,
        `${t(lang, 'diag.bench.lastRun')}: ${new Date(benchmark.ranAt).toLocaleString(lang)}`
      ]
    }
  ]

  /** What one card's Copy hands the clipboard bridge with the interface in `lang`; unmounts after. */
  async function copiedIn(lang: UiLanguage, button: number): Promise<string> {
    stubDiagnostics()
    renderDiagnostics(lang)
    // Both cards have loaded: the version and the CPU name are system values, alike in every language.
    await screen.findByText('HilbertRaum 0.1.20')
    await screen.findByText('Test CPU', { exact: false })
    await userEvent.click(screen.getAllByRole('button', { name: t(lang, 'diag.copy') })[button])
    await waitFor(() => expect(lastCopied).not.toBeNull())
    const text = lastCopied ?? ''
    cleanup()
    window.localStorage.clear()
    return text
  }

  describe.each(REPORTS)('the $name report', ({ button, title, lines }) => {
    it.each(OTHER_LANGUAGES)('in %s: the report, a line naming English, then the English report', async (lang) => {
      const english = await copiedIn('en', button)
      const [local, englishHalf, ...rest] = (await copiedIn(lang, button)).split(`\n${DIVIDER}\n`)
      expect(rest).toEqual([])
      expect(englishHalf).toBe(english)
      // The first half is the interface-language report: its own title and wording, as many lines
      // as the English one, the system values untouched.
      const localLines = local.split('\n')
      expect(localLines[0]).toBe(t(lang, title))
      expect(localLines).toHaveLength(english.split('\n').length)
      for (const line of lines(lang)) expect(localLines).toContain(line)
    })

    it.each(['en', 'de'] as const)('in %s: the report alone, as before', async (lang) => {
      const text = await copiedIn(lang, button)
      expect(text).not.toMatch(/^--- .+ ---$/m)
      expect(text.split('\n')[0]).toBe(t(lang, title))
      for (const line of lines(lang)) expect(text.split('\n')).toContain(line)
    })
  })
})
