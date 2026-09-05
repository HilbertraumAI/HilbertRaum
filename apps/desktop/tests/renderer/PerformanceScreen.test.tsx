// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PerformanceScreen } from '../../src/renderer/screens/PerformanceScreen'
import { ToastProvider } from '../../src/renderer/components'
import {
  DEFAULT_SETTINGS,
  type BenchmarkProgressStep,
  type BenchmarkResult,
  type ModelInfo,
  type PerformanceSnapshot
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// The Performance screen (design-guidelines §2, benchmark.md "Performance screen"): the
// check's answer as a verdict + three tiles, the observed rows, the other computers, and
// the two actions that lead somewhere (AI Model for the pick / context size, Diagnostics
// for the raw table). Copy is plain and encouraging: no "benchmark", no hardware shaming.

afterEach(cleanup)

function result(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
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
    speedBasis: { basis: 'timings', tokens: 64 },
    measuredModelId: 'qwen3.5-9b-ud-q4kxl',
    effectiveRead: {
      mbps: 430,
      bytes: 5_800_000_000,
      ms: 13_500,
      source: 'model_load',
      modelId: 'qwen3.5-9b-ud-q4kxl',
      at: '2026-09-04T12:00:00Z'
    },
    profile: 'LITE',
    recommendedModelId: 'qwen3.5-9b-ud-q4kxl',
    warnings: [],
    ranAt: '2026-09-04T14:02:00Z',
    ...over
  }
}

const office = result({
  cpuModel: 'Intel Core i9-13900K',
  cpuCores: 32,
  ramGb: 64,
  gpu: 'NVIDIA GeForce RTX 3090',
  gpuVramMb: 24576,
  tokensPerSecond: 41,
  measuredModelId: 'qwen3.8-27b-ud-q4km',
  recommendedModelId: 'qwen3.8-27b-ud-q4km',
  profile: 'PRO',
  ranAt: '2026-09-02T10:00:00Z'
})
const oldLaptop = result({
  cpuModel: 'Intel Core i5-8250U',
  cpuCores: 8,
  ramGb: 7.8,
  tokensPerSecond: 2,
  measuredModelId: 'qwen3.5-4b-ud-q4kxl',
  effectiveRead: { mbps: 70, bytes: 2_500_000_000, ms: 36_000, source: 'model_load', modelId: 'qwen3.5-4b-ud-q4kxl', at: '2026-08-28T10:00:00Z' },
  profile: 'TINY',
  ranAt: '2026-08-28T10:00:00Z'
})

const models = [
  { id: 'qwen3.5-9b-ud-q4kxl', displayName: 'Qwen3.5 9B (UD-Q4_K_XL)', state: 'installed', recommended: true, recommendedContextTokens: 8192 },
  { id: 'qwen3.8-27b-ud-q4km', displayName: 'Qwen3.8 27B UD-Q4_K_M', state: 'missing', recommended: false, recommendedContextTokens: 8192 },
  { id: 'qwen3.5-4b-ud-q4kxl', displayName: 'Qwen3.5 4B (UD-Q4_K_XL)', state: 'missing', recommended: false, recommendedContextTokens: 8192 }
] as unknown as ModelInfo[]

function snapshot(over: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return {
    current: result(),
    currentMachine: true,
    currentGpu: null,
    otherMachines: [office, oldLaptop],
    running: false,
    observed: {
      lastAnswer: { tokensPerSecond: 11.8, ttftMs: 900, tokens: 312, modelId: 'qwen3.5-9b-ud-q4kxl', at: '2026-09-05T14:02:00Z' },
      lastModelLoad: result().effectiveRead ?? null,
      lastChecksum: null
    },
    ...over
  }
}

function install(snap: PerformanceSnapshot, over: Record<string, unknown> = {}) {
  const progress: Array<(step: BenchmarkProgressStep) => void> = []
  const api = {
    getPerformance: vi.fn(async () => snap),
    listModels: vi.fn(async () => models),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    getRuntimeStatus: vi.fn(async () => ({ running: true, modelId: 'qwen3.5-9b-ud-q4kxl', port: 1, healthy: true, message: '' })),
    onBenchmarkProgress: vi.fn((cb: (step: BenchmarkProgressStep) => void) => {
      progress.push(cb)
      return () => {}
    }),
    runBenchmark: vi.fn(async () => result()),
    useModel: vi.fn(async () => ({ running: true, modelId: 'qwen3.5-9b-ud-q4kxl', port: 1, healthy: true, message: '' })),
    copyToClipboard: vi.fn(async (_text: string) => true),
    ...over
  }
  stubApi(api)
  return { api, progress }
}

function renderScreen(onNavigate = vi.fn()) {
  render(
    <ToastProvider>
      <PerformanceScreen onNavigate={onNavigate} />
    </ToastProvider>
  )
  return onNavigate
}

describe('PerformanceScreen: the check as an answer', () => {
  it('renders the verdict, the three tiles with ratings, and the context the pick assumes', async () => {
    install(snapshot())
    renderScreen()
    expect(await screen.findByText(/Runs Qwen3\.5 9B \(UD-Q4_K_XL\) at about 12 tokens per second\./)).toBeInTheDocument()
    expect(screen.getByText(/Model starts from this drive are fast\./)).toBeInTheDocument()
    // Tiles: value + rating word (never color alone).
    expect(screen.getByText('Speed')).toBeInTheDocument()
    expect(screen.getAllByText('Good').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(screen.getByText('Lite')).toBeInTheDocument()
    expect(screen.getByText('Drive')).toBeInTheDocument()
    expect(screen.getAllByText('Fast').length).toBeGreaterThanOrEqual(1)
    // The Memory tile names the model the RAM fits and the context it launches with.
    expect(screen.getByText(/Fits Qwen3\.5 9B \(UD-Q4_K_XL\) with a 8,192-token context/)).toBeInTheDocument()
    // No graphics card on this laptop: the Graphics tile says so in words, never a bare dash.
    expect(screen.getByText('Graphics memory')).toBeInTheDocument()
    expect(screen.getByText(/No usable graphics card/)).toBeInTheDocument()
    expect(screen.getByText('None')).toBeInTheDocument()
    // No jargon on the primary surface.
    expect(screen.queryByText(/benchmark/i)).not.toBeInTheDocument()
  })

  it('lists the observed rows and the other computers with their own ratings', async () => {
    install(snapshot())
    renderScreen()
    expect(await screen.findByText(/Last answer: 11\.8 tokens \/ s, first token after 0\.9 s/)).toBeInTheDocument()
    expect(screen.getByText(/Model start: 13\.5 s/)).toBeInTheDocument()
    expect(screen.getByText(/41 tokens \/ s with Qwen3\.8 27B UD-Q4_K_M/)).toBeInTheDocument()
    // Graphics memory rides along in the other-computer rows once the result carries it.
    expect(screen.getByText(/Intel Core i9-13900K, 64\.0 GB RAM, 24\.0 GB VRAM/)).toBeInTheDocument()
    expect(screen.getByText(/2 tokens \/ s with Qwen3\.5 4B/)).toBeInTheDocument()
    // The 70 MB/s laptop is flagged by its drive, in words.
    expect(screen.getByText('Slow drive')).toBeInTheDocument()
  })

  it('shows the honest empty states before any check and before any observation', async () => {
    install(snapshot({ current: null, otherMachines: [], observed: { lastAnswer: null, lastModelLoad: null, lastChecksum: null } }))
    renderScreen()
    expect(await screen.findByRole('button', { name: 'Check this computer' })).toBeInTheDocument()
    // The card header and the Memory tile both say it: not checked yet.
    expect(screen.getAllByText('Not checked yet').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Pending')).toHaveLength(3)
    expect(screen.getByText(/Nothing observed yet this session/)).toBeInTheDocument()
    expect(screen.getByText(/None yet\. Plug the drive into another computer/)).toBeInTheDocument()
  })

  it('shows the graphics memory from the result, or from the live probe when the result predates the field', async () => {
    install(snapshot({ current: result({ gpu: 'NVIDIA GeForce RTX 3090', gpuVramMb: 24576 }) }))
    renderScreen()
    expect(await screen.findByText('24.0')).toBeInTheDocument()
    expect(screen.getByText('Usable')).toBeInTheDocument()
    cleanup()
    // An old result (no gpuVramMb) on the current machine: the live probe fills the tile.
    const legacy = result()
    delete (legacy as Partial<BenchmarkResult>).gpuVramMb
    install(snapshot({ current: legacy, currentGpu: { name: 'Intel Iris Xe', totalMb: 4096 } }))
    renderScreen()
    expect(await screen.findByText('4.0')).toBeInTheDocument()
    expect(screen.getByText('Small')).toBeInTheDocument()
    expect(screen.getByText(/Under 6 GB: models run on the processor/)).toBeInTheDocument()
    cleanup()
    // …but never for a result from ANOTHER computer.
    install(snapshot({ current: legacy, currentMachine: false, currentGpu: { name: 'Intel Iris Xe', totalMb: 4096 } }))
    renderScreen()
    expect(await screen.findByText(/No usable graphics card/)).toBeInTheDocument()
    cleanup()
    // Last resort: a snapshot with no probe at all (an older main process), but the stored
    // settings probe knows the card. The tile still fills.
    install(snapshot({ current: legacy, currentGpu: null }), {
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        gpuProbe: { devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24822, freeMb: 3000 }], probedAt: '2026-09-05T00:00:00Z' }
      }))
    })
    renderScreen()
    expect(await screen.findByText('24.2')).toBeInTheDocument()
    expect(screen.getByText('Usable')).toBeInTheDocument()
    expect(screen.getByText('NVIDIA GeForce RTX 3090')).toBeInTheDocument()
  })

  it('says so when the last result belongs to a different computer', async () => {
    install(snapshot({ currentMachine: false }))
    renderScreen()
    expect(await screen.findByText(/measured on a different computer/)).toBeInTheDocument()
  })
})

describe('PerformanceScreen: actions', () => {
  it('"Check again" runs the benchmark, shows the steps as they land, then refreshes', async () => {
    let resolveRun: (r: BenchmarkResult) => void = () => {}
    const { api, progress } = install(snapshot(), {
      runBenchmark: vi.fn(() => new Promise<BenchmarkResult>((r) => (resolveRun = r)))
    })
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    expect(api.runBenchmark).toHaveBeenCalledTimes(1)
    // Steps replace the tiles while the run is in flight.
    expect(screen.getByText('Hardware detected')).toBeInTheDocument()
    expect(screen.getByText(/Generation speed with Qwen3\.5 9B/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    act(() => progress.forEach((cb) => cb('system')))
    expect(screen.getByText('Hardware detected').closest('li')?.className).toContain('perf-step-done')
    await act(async () => {
      resolveRun(result())
    })
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('offers "Start <model> and measure" when speed is unmeasured, the pick is installed and nothing runs', async () => {
    const { api } = install(snapshot({ current: result({ tokensPerSecond: null, measuredModelId: null, speedBasis: null }) }), {
      getRuntimeStatus: vi.fn(async () => ({ running: false, modelId: null, port: null, healthy: false, message: '' }))
    })
    renderScreen()
    const start = await screen.findByRole('button', { name: 'Start Qwen3.5 9B (UD-Q4_K_XL) and measure' })
    await userEvent.click(start)
    await waitFor(() => expect(api.useModel).toHaveBeenCalledWith('qwen3.5-9b-ud-q4kxl'))
    await waitFor(() => expect(api.runBenchmark).toHaveBeenCalledTimes(1))
  })

  it('"Change context size" goes to AI Model; the footer link opens Diagnostics; no "Why this model?" button', async () => {
    install(snapshot())
    const onNavigate = renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Change context size' }))
    expect(screen.queryByRole('button', { name: /Why this model/ })).not.toBeInTheDocument()
    expect(onNavigate).toHaveBeenLastCalledWith('models')
    await userEvent.click(screen.getByRole('button', { name: 'Open Diagnostics' }))
    expect(onNavigate).toHaveBeenLastCalledWith('settings:diagnostics')
  })

  it('"Copy report" hands the figures to the native clipboard', async () => {
    const { api } = install(snapshot())
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    const text = api.copyToClipboard.mock.calls[0][0] as string
    expect(text).toContain('This computer')
    expect(text).toContain('Qwen3.5 9B (UD-Q4_K_XL)')
    expect(text).toContain('8,192 tokens')
    expect(text).toContain('Graphics memory: None')
  })

  it('surfaces a failed run as a calm banner and returns to the tiles', async () => {
    install(snapshot(), { runBenchmark: vi.fn(async () => { throw new Error('Error: Model is busy right now') }) })
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Check failed: .*busy/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })
})
