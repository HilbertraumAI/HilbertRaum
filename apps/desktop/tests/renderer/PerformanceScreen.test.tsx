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
  type ModelPlacement,
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

/** A discrete-GPU machine with the 9B active and no start observed yet (weights-only estimate). */
function placement(over: Partial<PerformanceSnapshot['placement']> = {}): PerformanceSnapshot['placement'] {
  return {
    memoryClass: 'discrete',
    ramMb: 16_077,
    vramMb: 24_822,
    model: { id: 'qwen3.5-9b-ud-q4kxl', sizeOnDiskGb: 5.8, contextTokens: 8192 },
    observed: null,
    verdict: { kind: 'gpu', needMb: 5939, estimated: true, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null },
    models: [
      { role: 'chat', modelId: 'qwen3.5-9b-ud-q4kxl', sizeOnDiskGb: 5.4, device: 'gpu', loaded: true, lifetime: 'session', gpuLayers: null, totalLayers: null },
      { role: 'translation', modelId: 'translategemma-12b-it-q4', sizeOnDiskGb: 6.8, device: 'gpu', loaded: false, lifetime: 'idle', gpuLayers: null, totalLayers: null },
      { role: 'vision', modelId: 'qwen2.5-vl-3b-instruct-q4', sizeOnDiskGb: 3.0, device: 'cpu', loaded: false, lifetime: 'idle', gpuLayers: null, totalLayers: null },
      { role: 'reranker', modelId: 'bge-reranker-v2-m3-f16', sizeOnDiskGb: 1.1, device: 'cpu', loaded: true, lifetime: 'session', gpuLayers: null, totalLayers: null },
      { role: 'embeddings', modelId: 'multilingual-e5-small-q8', sizeOnDiskGb: 0.2, device: 'cpu', loaded: true, lifetime: 'session', gpuLayers: null, totalLayers: null },
      { role: 'transcriber', modelId: 'whisper-small', sizeOnDiskGb: 0.5, device: 'cpu', loaded: false, lifetime: 'per-use', gpuLayers: null, totalLayers: null }
    ],
    totals: { ramAllMb: Math.round(17.0 * 1024), bothOnCard: false },
    ...over
  }
}

const observedFull: ModelPlacement = {
  modelId: 'qwen3.5-9b-ud-q4kxl',
  contextTokens: 8192,
  backend: 'gpu',
  gpuLayers: 41,
  totalLayers: 41,
  gpuModelMb: 5500,
  cpuModelMb: 400,
  gpuKvMb: 640,
  cpuKvMb: null,
  metalMaxWorkingSetMb: null,
  machineKey: null,
  at: '2026-09-05T14:00:00Z'
}

function snapshot(over: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return {
    current: result(),
    currentMachine: true,
    currentGpu: null,
    otherMachines: [office, oldLaptop],
    running: false,
    placement: placement(),
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
    // The fit question is answered in its own row, never under RAM or VRAM.
    expect(screen.getByText('Your model')).toBeInTheDocument()
    expect(screen.getByText(/Qwen3\.5 9B \(UD-Q4_K_XL\) · 5\.8 GB on disk · 8,192-token context/)).toBeInTheDocument()
    expect(screen.getByText(/Needs at least 5\.8 GB for the weights.*Should fit in graphics memory \(24\.2 GB\)/)).toBeInTheDocument()
    expect(screen.getByText('On GPU')).toBeInTheDocument()
    expect(screen.queryByText(/Fits Qwen/)).not.toBeInTheDocument()
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

describe('PerformanceScreen: the Your-model row', () => {
  it('reads an observed full offload off the log: layers, size with context, On GPU', async () => {
    install(snapshot({ placement: placement({
      observed: observedFull,
      verdict: { kind: 'gpu', needMb: 6540, estimated: false, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: 41, totalLayers: 41 }
    }) }))
    renderScreen()
    expect(await screen.findByText(/Takes 6\.4 GB with this context\. Fits in graphics memory \(24\.2 GB\): all 41 layers on the GPU\./)).toBeInTheDocument()
    expect(screen.getByText('On GPU')).toBeInTheDocument()
  })

  it('an observed start whose log said nothing reads as Not measured, never "all  layers on the GPU"', async () => {
    // A start was recorded but every figure is null (a build below verbosity 4). The row must
    // not dress that up as a measured full offload with an empty layer count.
    install(snapshot({ placement: placement({
      observed: { ...observedFull, gpuLayers: null, totalLayers: null, gpuModelMb: null, cpuModelMb: null, gpuKvMb: null },
      verdict: { kind: 'unknown', needMb: null, estimated: false, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
    }) }))
    renderScreen()
    expect(await screen.findByText('Where the model lands is measured on its first start.')).toBeInTheDocument()
    expect(screen.getByText('Not measured')).toBeInTheDocument()
    expect(screen.queryByText('On GPU')).not.toBeInTheDocument()
    // The gap the L7 bug left behind ("all {layers} layers" with no count). The default
    // matcher collapses whitespace, so ask for the raw text.
    expect(screen.queryByText(/all\s{2,}layers/, { normalizer: (s) => s })).not.toBeInTheDocument()
    expect(screen.queryByText(/layers on the GPU/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Fits in graphics memory/)).not.toBeInTheDocument()
  })

  it('names a partial offload with the layer split and the RAM spill, in words', async () => {
    install(snapshot({ placement: placement({
      vramMb: 16_384,
      observed: { ...observedFull, gpuLayers: 30, gpuModelMb: 4000, cpuModelMb: 1900 },
      verdict: { kind: 'partial', needMb: 6540, estimated: false, budgetMb: 16_384, freeAtStartMb: null, workingMb: null, spillMb: 1900, gpuLayers: 30, totalLayers: 41 }
    }) }))
    renderScreen()
    expect(await screen.findByText(/Graphics memory holds 16\.0 GB: 30 of 41 layers on the GPU, about 1\.9 GB runs from RAM\. Answers slower\./)).toBeInTheDocument()
    expect(screen.getByText('Partly on GPU')).toBeInTheDocument()
  })

  it('explains a spill on a card that would hold the model: what was free at start, plus the margin', async () => {
    install(snapshot({ placement: placement({
      model: { id: 'qwen3.8-27b-ud-q4km', sizeOnDiskGb: 18.4, contextTokens: 8192 },
      observed: { ...observedFull, modelId: 'qwen3.8-27b-ud-q4km', gpuLayers: 62, totalLayers: 66, gpuModelMb: 17_600, cpuModelMb: 1750, gpuKvMb: 512, gpuFreeAtStartMb: 20_300 },
      verdict: { kind: 'partial', needMb: 19_862, estimated: false, budgetMb: 24_822, freeAtStartMb: 20_300, workingMb: 2860, spillMb: 1750, gpuLayers: 62, totalLayers: 66 }
    }) }))
    renderScreen()
    expect(await screen.findByText(/62 of 66 layers on the GPU, about 1\.7 GB runs from RAM: only 19\.8 GB of the card’s 24\.2 GB was free when the model started, and the runtime keeps a 1 GB safety margin\. Answers slower\. Restart the model once the card is free\./)).toBeInTheDocument()
  })

  it('explains a spill on a card that WAS free: the working buffers and the fixed margin', async () => {
    install(snapshot({ placement: placement({
      model: { id: 'qwen3.8-27b-ud-q4km', sizeOnDiskGb: 18.4, contextTokens: 8192 },
      observed: { ...observedFull, modelId: 'qwen3.8-27b-ud-q4km', gpuLayers: 62, totalLayers: 66, gpuModelMb: 17_134, cpuModelMb: 1711, gpuKvMb: 512, gpuFreeAtStartMb: 23_615, gpuComputeMb: 2860 },
      verdict: { kind: 'partial', needMb: 19_389, estimated: false, budgetMb: 24_822, freeAtStartMb: 23_615, workingMb: 2860, spillMb: 1743, gpuLayers: 62, totalLayers: 66 }
    }) }))
    renderScreen()
    expect(await screen.findByText(/The card was free \(23\.1 of 24\.2 GB\), but the runtime also sets aside 2\.8 GB of working buffers and a 1 GB safety margin, and moves whole layers off the card when the sum gets close\. Answers slower\./)).toBeInTheDocument()
    expect(screen.queryByText(/only 23\.1 GB/)).not.toBeInTheDocument()
  })

  it('on Apple Silicon shows one Unified memory tile, no graphics tile, and the unified budget', async () => {
    install(snapshot({ placement: placement({
      memoryClass: 'unified',
      vramMb: null,
      ramMb: 49_152,
      verdict: { kind: 'gpu', needMb: 5939, estimated: true, budgetMb: 36_864, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
    }) }))
    renderScreen()
    expect(await screen.findByText('Unified memory')).toBeInTheDocument()
    expect(screen.queryByText('Graphics memory')).not.toBeInTheDocument()
    expect(screen.getByText(/Should fit in unified memory \(48\.0 GB, up to 36\.0 GB available to the model\)/)).toBeInTheDocument()
  })

  it('a model that cannot fit gets "Too large" and a way to a smaller model', async () => {
    install(snapshot({ placement: placement({
      memoryClass: 'cpu',
      vramMb: null,
      ramMb: 8192,
      model: { id: 'qwen3.8-27b-ud-q4km', sizeOnDiskGb: 16.5, contextTokens: 8192 },
      verdict: { kind: 'too_large', needMb: 16_896, estimated: true, budgetMb: 8192, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
    }) }))
    const onNavigate = renderScreen()
    expect(await screen.findByText(/Too large for this computer \(8\.0 GB available\)\. Pick a smaller model\./)).toBeInTheDocument()
    expect(screen.getByText('Too large')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Choose a smaller model' }))
    expect(onNavigate).toHaveBeenLastCalledWith('models')
  })

  it('with no model selected says so and points at AI Model', async () => {
    install(snapshot({ placement: placement({ model: null, verdict: { kind: 'unknown', needMb: null, estimated: true, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null } }) }))
    renderScreen()
    expect(await screen.findByText(/No model selected yet/)).toBeInTheDocument()
    expect(screen.getByText('Not measured')).toBeInTheDocument()
  })
})

describe('PerformanceScreen: models on this computer', () => {
  it('lists every role with where it runs by design, its lifetime and whether it is loaded now', async () => {
    install(snapshot())
    renderScreen()
    expect(await screen.findByText('Models on this computer')).toBeInTheDocument()
    expect(screen.getByText('Translation')).toBeInTheDocument()
    expect(screen.getByText(/Document search \(ranking\)/)).toBeInTheDocument()
    expect(screen.getByText(/Document search \(index\)/)).toBeInTheDocument()
    expect(screen.getByText('Voice')).toBeInTheDocument()
    // Pinned roles say so, in words; the CLI says it runs only while working.
    expect(screen.getAllByText(/processor, by design/).length).toBe(4)
    expect(screen.getByText(/runs only while working/)).toBeInTheDocument()
    expect(screen.getAllByText(/unloads when idle/).length).toBe(2)
    expect(screen.getAllByText('loaded now').length).toBe(3)
    expect(screen.getAllByText('not loaded').length).toBe(3)
  })

  it('sums the card budget and the everything-at-once RAM need, flagging too much', async () => {
    install(snapshot({ placement: placement({ ramMb: 16_077, totals: { ramAllMb: Math.round(17.0 * 1024), bothOnCard: false } }) }))
    renderScreen()
    expect(await screen.findByText(/Graphics card: chat 5\.4 GB \+ translation 6\.8 GB, of 24\.2 GB\./)).toBeInTheDocument()
    expect(screen.getByText(/Everything loaded at once needs about 17\.0 GB of 15\.7 GB RAM\./)).toBeInTheDocument()
    expect(screen.getByText('Too much at once')).toBeInTheDocument()
  })

  it('warns when chat and translation are both on the card, with the start-order advice', async () => {
    install(snapshot({ placement: placement({ ramMb: 131_072, totals: { ramAllMb: Math.round(17.0 * 1024), bothOnCard: true } }) }))
    renderScreen()
    expect(await screen.findByText(/Both are on the card right now\. Whichever started second got what was left and runs slower/)).toBeInTheDocument()
    expect(screen.getByText('Fits')).toBeInTheDocument()
  })

  it('on a machine without a usable card there is no card line, only the RAM line', async () => {
    install(snapshot({ placement: placement({ memoryClass: 'cpu', vramMb: null, ramMb: 131_072 }) }))
    renderScreen()
    await screen.findByText('Models on this computer')
    expect(screen.queryByText(/Graphics card: chat/)).not.toBeInTheDocument()
    expect(screen.getByText(/Everything loaded at once needs about/)).toBeInTheDocument()
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
