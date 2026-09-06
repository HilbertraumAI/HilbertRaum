// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PerformanceScreen } from '../../src/renderer/screens/PerformanceScreen'
import { ToastProvider } from '../../src/renderer/components'
import {
  DEFAULT_SETTINGS,
  type BenchmarkProgressStep,
  type BenchmarkResult,
  type ModelInfo,
  type ModelPlacement,
  type PerformanceSnapshot,
  type RuntimeStatus
} from '../../src/shared/types'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t } from '../../src/shared/i18n'
import { FIT_TARGET_MARGIN_MB } from '../../src/shared/performance-rules'
import { stubApi } from '../helpers/renderer'

// The Performance screen (design-guidelines §2, benchmark.md "Performance screen"): the
// check's answer as a verdict + four tiles (speed, memory, graphics memory, drive — the
// graphics tile folds into one unified tile on Apple Silicon), the observed rows, the other
// computers, and the two actions that lead somewhere (AI Model for the pick / context size,
// Diagnostics for the raw table). Copy is plain and encouraging: no "benchmark", no hardware
// shaming.

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

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
    // Resolved MAIN-side by `launchContextTokens` since the PR #303 audit M5 residual fix: the
    // screen reads it off the snapshot instead of recomputing it from the catalog entry.
    recommendedContextTokens: 8192,
    observed: null,
    observedMismatch: null,
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
    // The LIVE pick (the same one the AI Model screen stars); the default agrees with the result's saved pick.
    recommendation: { modelId: 'qwen3.5-9b-ud-q4kxl', basis: 'discrete' },
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
  /** Every live `performance:changed` subscriber (the payload-free "re-read the snapshot"). */
  const pushes: Array<() => void> = []
  /** The order the screen touched the bridge in — defaults only; an override records nothing. */
  const calls: string[] = []
  let unsubscribes = 0
  const api = {
    getPerformance: vi.fn(async () => {
      calls.push('getPerformance')
      return snap
    }),
    listModels: vi.fn(async () => {
      calls.push('listModels')
      return models
    }),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    getRuntimeStatus: vi.fn(async () => ({ running: true, modelId: 'qwen3.5-9b-ud-q4kxl', port: 1, healthy: true, message: '' })),
    onBenchmarkProgress: vi.fn((cb: (step: BenchmarkProgressStep) => void) => {
      progress.push(cb)
      return () => {}
    }),
    onPerformanceChanged: vi.fn((cb: () => void) => {
      calls.push('onPerformanceChanged')
      pushes.push(cb)
      return () => {
        unsubscribes += 1
      }
    }),
    runBenchmark: vi.fn(async () => result()),
    useModel: vi.fn(async () => ({ running: true, modelId: 'qwen3.5-9b-ud-q4kxl', port: 1, healthy: true, message: '' })),
    copyToClipboard: vi.fn(async (_text: string) => true),
    ...over
  }
  stubApi(api)
  return { api, progress, pushes, calls, unsubscribed: () => unsubscribes }
}

/** Deliver `performance:changed` to every subscriber and let the re-read settle. */
async function pushChanged(pushes: Array<() => void>): Promise<void> {
  await act(async () => {
    for (const cb of pushes) cb()
  })
}

/** A promise a test resolves by hand — the only way to hold a read "in flight" without timers. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const RUNNING_STATUS = { running: true, modelId: 'qwen3.5-9b-ud-q4kxl', port: 1, healthy: true, message: '' }
const STOPPED_STATUS = { running: false, modelId: null, port: null, healthy: false, message: '' }

/** A snapshot with an answer in the observed rows (the M3 background observation). */
const observedAnswer = {
  lastAnswer: { tokensPerSecond: 40, ttftMs: 800, tokens: 100, modelId: 'qwen3.5-9b-ud-q4kxl', at: '2026-09-05T15:00:00Z' },
  lastModelLoad: null,
  lastChecksum: null
}
const noObservations = { lastAnswer: null, lastModelLoad: null, lastChecksum: null }

function renderScreen(onNavigate = vi.fn()) {
  render(
    <ToastProvider>
      <PerformanceScreen onNavigate={onNavigate} />
    </ToastProvider>
  )
  return onNavigate
}

/** Same render, but hands back the RTL result so a test can unmount on purpose. */
function mountScreen() {
  return render(
    <ToastProvider>
      <PerformanceScreen onNavigate={vi.fn()} />
    </ToastProvider>
  )
}

describe('PerformanceScreen: the check as an answer', () => {
  it('renders the verdict, the four tiles with ratings, and the context the pick assumes', async () => {
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
    // The saved pick and the live one agree: no "at the time of the check" line.
    expect(screen.queryByText(/Recommended at the time of the check/)).not.toBeInTheDocument()
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

  it('shows the graphics memory from the result, or from this machine’s eligible probe when the result predates the field', async () => {
    install(snapshot({ current: result({ gpu: 'NVIDIA GeForce RTX 3090', gpuVramMb: 24576 }) }))
    renderScreen()
    expect(await screen.findByText('24.0')).toBeInTheDocument()
    expect(screen.getByText('Usable')).toBeInTheDocument()
    cleanup()
    // An old result (no gpuVramMb) on the current machine: the eligible probe's device fills
    // the tile — a small DISCRETE card is "Small", with its size as the reason.
    const legacy = result()
    delete (legacy as Partial<BenchmarkResult>).gpuVramMb
    install(snapshot({ current: legacy, currentGpu: { name: 'NVIDIA GeForce GTX 1650', totalMb: 4096, useful: false } }))
    renderScreen()
    expect(await screen.findByText('4.0')).toBeInTheDocument()
    expect(screen.getByText('Small')).toBeInTheDocument()
    expect(screen.getByText(/NVIDIA GeForce GTX 1650 · Under 6 GB: models run on the processor/)).toBeInTheDocument()
    cleanup()
    // …but never for a result from ANOTHER computer: that check never recorded the field, so
    // the tile claims nothing either way (N1) — not "no usable graphics card".
    install(snapshot({ current: legacy, currentMachine: false, currentGpu: { name: 'NVIDIA GeForce GTX 1650', totalMb: 4096, useful: false } }))
    renderScreen()
    expect(await screen.findByText('That check did not record the graphics card.')).toBeInTheDocument()
    expect(screen.getByText('Not recorded')).toBeInTheDocument()
    expect(screen.queryByText(/No usable graphics card/)).not.toBeInTheDocument()
    expect(screen.queryByText('4.0')).not.toBeInTheDocument()
    cleanup()
    // A foreign result that RECORDED nothing (an explicit null) is a real "none".
    install(snapshot({ current: result({ gpuVramMb: null }), currentMachine: false }))
    renderScreen()
    expect(await screen.findByText(/No usable graphics card/)).toBeInTheDocument()
    expect(screen.getByText('None')).toBeInTheDocument()
  })

  it('never reads the raw settings probe: without a device in the snapshot the tile stays empty, whatever settings hold (M8.3)', async () => {
    // `snapshot.currentGpu` is the BUDGET device for the next start (PR #308 audit decision 9);
    // when main reports none, the tile says so — it never falls back to the stored probe's first
    // device, which on a hybrid laptop is the iGPU's shared-RAM figure (the P2 carry-over).
    const legacy = result()
    delete (legacy as Partial<BenchmarkResult>).gpuVramMb
    install(snapshot({ current: legacy, currentGpu: null }), {
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        gpuProbe: { devices: [{ id: 'Vulkan0', name: 'Intel(R) Graphics (ARL)', totalMb: 11577, freeMb: 8251 }], probedAt: '2026-09-05T00:00:00Z' }
      }))
    })
    renderScreen()
    expect(await screen.findByText(/No usable graphics card/)).toBeInTheDocument()
    expect(screen.queryByText('11.3')).not.toBeInTheDocument()
    expect(screen.queryByText(/Intel\(R\) Graphics/)).not.toBeInTheDocument()
    expect(screen.getByText('None')).toBeInTheDocument()
    expect(screen.queryByText('24.2')).not.toBeInTheDocument()
    expect(screen.queryByText('Usable')).not.toBeInTheDocument()
    expect(screen.queryByText('NVIDIA GeForce RTX 3090')).not.toBeInTheDocument()
    // The screen does read `getSettings` — for the two GPU flags behind the "acceleration is
    // off" sub-line (next test), never for the probe: the ARL device above stays unseen.
  })

  it('with the GPU switched off (or auto-disabled) and no card for the next start, the tile says so instead of "no card"', async () => {
    // The result names no card (`gpu` / `gpuVramMb` null: the next start runs from RAM) although
    // the probe still lists one — the copy names the cause, not a missing card.
    for (const flags of [{ gpuMode: 'off' as const }, { gpuAutoDisabled: true }]) {
      install(snapshot({ current: result({ gpu: null, gpuVramMb: null }), currentGpu: null, placement: placement({ memoryClass: 'cpu', vramMb: null }) }), {
        getSettings: vi.fn(async () => ({
          ...DEFAULT_SETTINGS,
          ...flags,
          gpuProbe: { devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3070', totalMb: 8192, freeMb: 8000 }], probedAt: '2026-09-05T00:00:00Z' }
        }))
      })
      renderScreen()
      expect(await screen.findByText('Graphics acceleration is off. Models run on the processor.')).toBeInTheDocument()
      expect(screen.queryByText(/No usable graphics card/)).not.toBeInTheDocument()
      expect(screen.getByText('None')).toBeInTheDocument()
      cleanup()
    }
  })

  it('T12: an integrated device reporting 16 GB of shared memory is "Integrated", never "Usable", beside "On processor" (M8.1)', async () => {
    // The old tile rated `mb >= 6144` alone and printed "16.0 GB VRAM · Usable" while the row
    // below said the model runs on the processor.
    const iris = result({ gpu: 'Intel(R) Iris(R) Xe Graphics', gpuVramMb: 16_384 })
    install(
      snapshot({
        current: iris,
        currentGpu: { name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16_384, useful: false },
        placement: placement({
          memoryClass: 'cpu',
          vramMb: null,
          ramMb: 16_077,
          verdict: { kind: 'cpu', needMb: 5939, estimated: true, budgetMb: 16_077, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
        })
      })
    )
    renderScreen()
    expect(await screen.findByText('On processor')).toBeInTheDocument()
    expect(screen.getByText('16.0')).toBeInTheDocument()
    expect(screen.getByText('GB shared')).toBeInTheDocument()
    expect(screen.getByText('Integrated')).toBeInTheDocument()
    expect(screen.getByText('Intel(R) Iris(R) Xe Graphics · Integrated, shared memory: models run on the processor.')).toBeInTheDocument()
    expect(screen.queryByText('Usable')).not.toBeInTheDocument()
    expect(screen.queryByText('GB VRAM')).not.toBeInTheDocument()
    // Not blamed on size: the memory is not the card's own.
    expect(screen.queryByText(/Under 6 GB/)).not.toBeInTheDocument()
    expect(screen.queryByText('Small')).not.toBeInTheDocument()
  })

  it('rates a recorded device by the shared rule when the snapshot carries no flag for it', async () => {
    // A foreign result (no live device applies) naming an integrated device: the same rule,
    // from the recorded name + memory.
    install(snapshot({ current: result({ gpu: 'AMD Radeon(TM) Graphics', gpuVramMb: 16_000 }), currentMachine: false, currentGpu: null }))
    renderScreen()
    expect(await screen.findByText('Integrated')).toBeInTheDocument()
    expect(screen.queryByText('Usable')).not.toBeInTheDocument()
    cleanup()
    // An older main process without the flag on `currentGpu`: still never "Usable" for an iGPU.
    const oldShape = { name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16_384 } as PerformanceSnapshot['currentGpu']
    install(snapshot({ current: result({ gpu: 'Intel(R) Iris(R) Xe Graphics', gpuVramMb: 16_384 }), currentGpu: oldShape }))
    renderScreen()
    expect(await screen.findByText('Integrated')).toBeInTheDocument()
    expect(screen.queryByText('Usable')).not.toBeInTheDocument()
  })

  it('an other-computer row lists VRAM only for a usable card, never an integrated device’s shared figure', async () => {
    const igpuLaptop = result({
      cpuModel: 'Intel Core i5-1235U',
      cpuCores: 12,
      ramGb: 16,
      gpu: 'Intel(R) Iris(R) Xe Graphics',
      gpuVramMb: 16_384,
      tokensPerSecond: 6,
      ranAt: '2026-08-30T10:00:00Z'
    })
    install(snapshot({ otherMachines: [office, igpuLaptop] }))
    renderScreen()
    expect(await screen.findByText(/Intel Core i9-13900K, 64\.0 GB RAM, 24\.0 GB VRAM/)).toBeInTheDocument()
    expect(screen.getByText(/Intel Core i5-1235U, 16\.0 GB RAM · /)).toBeInTheDocument()
    expect(screen.queryByText(/16\.0 GB VRAM/)).not.toBeInTheDocument()
  })

  it('the integrated tile in German (asserted from the catalog, D-L8)', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    install(
      snapshot({
        current: result({ gpu: 'Intel(R) Iris(R) Xe Graphics', gpuVramMb: 16_384 }),
        currentGpu: { name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16_384, useful: false }
      })
    )
    render(
      <I18nProvider>
        <ToastProvider>
          <PerformanceScreen onNavigate={vi.fn()} />
        </ToastProvider>
      </I18nProvider>
    )
    expect(await screen.findByText(t('de', 'perf.rating.integrated'))).toBeInTheDocument()
    expect(screen.getByText(`Intel(R) Iris(R) Xe Graphics · ${t('de', 'perf.tile.graphics.integrated')}`)).toBeInTheDocument()
    expect(screen.getByText(t('de', 'perf.tile.graphics.unitShared'))).toBeInTheDocument()
    expect(screen.queryByText(t('de', 'perf.rating.usable'))).not.toBeInTheDocument()
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
    // Owner gate (c): the sentence names the runtime's SILENCE, never "measured on its first
    // start" — that start already happened, so a restart would change nothing.
    install(snapshot({ placement: placement({
      observed: { ...observedFull, gpuLayers: null, totalLayers: null, gpuModelMb: null, cpuModelMb: null, gpuKvMb: null },
      verdict: { kind: 'unknown', needMb: null, estimated: false, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
    }) }))
    renderScreen()
    expect(await screen.findByText('The runtime did not report where the model landed.')).toBeInTheDocument()
    expect(screen.queryByText(/measured the first time it starts/)).not.toBeInTheDocument()
    // Nothing here is an estimate, so the per-drive hint stays off.
    expect(screen.queryByText(/one record per model/)).not.toBeInTheDocument()
    expect(screen.getByText('Not measured')).toBeInTheDocument()
    expect(screen.queryByText('On GPU')).not.toBeInTheDocument()
    // The gap the L7 bug left behind ("all {layers} layers" with no count). The default
    // matcher collapses whitespace, so ask for the raw text.
    expect(screen.queryByText(/all\s{2,}layers/, { normalizer: (s) => s })).not.toBeInTheDocument()
    expect(screen.queryByText(/layers on the GPU/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Fits in graphics memory/)).not.toBeInTheDocument()
  })

  it('L8: the estimate says the measurement is taken on THIS computer, and that the drive keeps one record per model', async () => {
    // Nothing observed yet for this configuration. The placement lives in the DRIVE's settings,
    // one entry per model id, and is read back only on the machine that wrote it — so a start
    // on another computer sends this row back to the estimate.
    install(snapshot({ placement: placement({
      observed: null,
      verdict: { kind: 'unknown', needMb: null, estimated: true, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
    }) }))
    renderScreen()
    expect(
      await screen.findByText('Where the model lands is measured the first time it starts on this computer.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('The drive keeps one record per model, so a start on another computer replaces the one measured here.')
    ).toBeInTheDocument()
  })

  it('L8: the per-drive hint gives way to the more specific "measured earlier" note, never both', async () => {
    install(snapshot({ placement: placement({
      observed: null,
      observedMismatch: { contextTokens: 32_768, backend: 'gpu', at: '2026-09-01T00:00:00Z' }
    }) }))
    renderScreen()
    expect(await screen.findByText(/Measured earlier with a 32,768-token context on/)).toBeInTheDocument()
    expect(screen.queryByText(/one record per model/)).not.toBeInTheDocument()
  })

  it('a "gpu" verdict with no layer count uses the wording that needs none, never "all  layers"', async () => {
    // Defence in depth: `placementVerdict` only reports 'gpu' when it read both counts, so a
    // non-estimated 'gpu' with a null total can only come from a malformed record — it must
    // still never render the empty `{layers}` interpolation (L7 / gate (c)).
    install(snapshot({ placement: placement({
      observed: observedFull,
      verdict: { kind: 'gpu', needMb: 6540, estimated: false, budgetMb: 24_822, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
    }) }))
    renderScreen()
    expect(await screen.findByText(/Should fit in graphics memory \(24\.2 GB\)\./)).toBeInTheDocument()
    expect(screen.queryByText(/all\s{2,}layers/, { normalizer: (s) => s })).not.toBeInTheDocument()
    expect(screen.queryByText(/layers on the GPU/)).not.toBeInTheDocument()
    expect(screen.getByText('On GPU')).toBeInTheDocument()
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

  it('DR4: all three partial copies state the runtime margin from the shared constant, never a literal', async () => {
    // `FIT_TARGET_MARGIN_MB` is llama.cpp's `--fit-target` default, which the app does not
    // override. The expected figure is DERIVED from it, so raising the constant fails this
    // test instead of silently leaving three sentences claiming the old number.
    const margin = String(FIT_TARGET_MARGIN_MB / 1024)
    const spilled = {
      model: { id: 'qwen3.8-27b-ud-q4km', sizeOnDiskGb: 18.4, contextTokens: 8192 },
      observed: { ...observedFull, modelId: 'qwen3.8-27b-ud-q4km', gpuLayers: 62, totalLayers: 66 }
    }
    // (1) the card was NOT free at start.
    install(snapshot({ placement: placement({
      ...spilled,
      verdict: { kind: 'partial', needMb: 19_862, estimated: false, budgetMb: 24_822, freeAtStartMb: 20_300, workingMb: 2860, spillMb: 1750, gpuLayers: 62, totalLayers: 66 }
    }) }))
    renderScreen()
    expect(await screen.findByText(new RegExp(`the runtime keeps a ${margin} GB safety margin`))).toBeInTheDocument()
    cleanup()
    // (2) the card WAS free and the working buffers are known.
    install(snapshot({ placement: placement({
      ...spilled,
      verdict: { kind: 'partial', needMb: 19_389, estimated: false, budgetMb: 24_822, freeAtStartMb: 23_615, workingMb: 2860, spillMb: 1743, gpuLayers: 62, totalLayers: 66 }
    }) }))
    renderScreen()
    expect(await screen.findByText(new RegExp(`2\\.8 GB of working buffers and a ${margin} GB safety margin`))).toBeInTheDocument()
    cleanup()
    // (3) the card WAS free and the working buffers were never printed.
    install(snapshot({ placement: placement({
      ...spilled,
      verdict: { kind: 'partial', needMb: 19_389, estimated: false, budgetMb: 24_822, freeAtStartMb: 23_615, workingMb: null, spillMb: 1743, gpuLayers: 62, totalLayers: 66 }
    }) }))
    renderScreen()
    expect(await screen.findByText(new RegExp(`sets aside working buffers and a ${margin} GB safety margin`))).toBeInTheDocument()
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

  it('chat and translation on the processor by configuration say "processor", not "by design", and the card line is gone (DR1)', async () => {
    // The GPU switched off on a card machine: main puts both rows on the processor.
    const rows = placement().models.map((r) => (r.role === 'chat' || r.role === 'translation' ? { ...r, device: 'cpu' as const } : r))
    install(
      snapshot({
        placement: placement({
          models: rows,
          verdict: { kind: 'cpu', needMb: 5939, estimated: true, budgetMb: 16_077, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
        })
      })
    )
    renderScreen()
    await screen.findByText('Models on this computer')
    expect(screen.getAllByText(/^processor · /)).toHaveLength(2)
    expect(screen.getAllByText(/processor, by design/)).toHaveLength(4)
    expect(screen.queryByText(/Graphics card: chat/)).not.toBeInTheDocument()
    expect(screen.getByText(/Will run on the processor from RAM \(15\.7 GB\)/)).toBeInTheDocument()
  })

  it('on Apple Silicon the processor line speaks of unified memory and the pill compares against the budget (DR5)', async () => {
    // 40 GB of models: under the 48 GB of RAM, over the 36 GB Metal lets models take.
    install(
      snapshot({
        placement: placement({
          memoryClass: 'unified',
          vramMb: null,
          ramMb: 49_152,
          verdict: { kind: 'gpu', needMb: 5939, estimated: true, budgetMb: 36_864, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null },
          totals: { ramAllMb: Math.round(40.0 * 1024), bothOnCard: false }
        })
      })
    )
    renderScreen()
    expect(await screen.findByText(/Everything loaded at once needs about 40\.0 GB of the 36\.0 GB of unified memory available to models\./)).toBeInTheDocument()
    expect(screen.getByText('Too much at once')).toBeInTheDocument()
    expect(screen.queryByText(/GB RAM\./)).not.toBeInTheDocument()
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

  it('"Start … and measure" targets the LIVE recommendation, never the id saved with the check, and labels the saved one', async () => {
    // A fresh probe moved the pick to the 4B (installed); the saved result still says 9B. The
    // offer and the verdict follow the live pick; the saved one is history and is labelled so.
    const fourBInstalled = models.map((m) => (m.id === 'qwen3.5-4b-ud-q4kxl' ? { ...m, state: 'installed' } : m)) as ModelInfo[]
    const { api } = install(
      snapshot({
        current: result({ tokensPerSecond: null, measuredModelId: null, speedBasis: null, recommendedModelId: 'qwen3.5-9b-ud-q4kxl' }),
        recommendation: { modelId: 'qwen3.5-4b-ud-q4kxl', basis: 'discrete' }
      }),
      {
        listModels: vi.fn(async () => fourBInstalled),
        getRuntimeStatus: vi.fn(async () => ({ running: false, modelId: null, port: null, healthy: false, message: '' }))
      }
    )
    renderScreen()
    expect(await screen.findByText(/Qwen3\.5 4B \(UD-Q4_K_XL\) is the best fit for this computer’s graphics memory\./)).toBeInTheDocument()
    expect(screen.getByText('Recommended at the time of the check: Qwen3.5 9B (UD-Q4_K_XL)')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Start Qwen3\.5 9B/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start Qwen3.5 4B (UD-Q4_K_XL) and measure' }))
    await waitFor(() => expect(api.useModel).toHaveBeenCalledWith('qwen3.5-4b-ud-q4kxl'))
    expect(api.useModel).not.toHaveBeenCalledWith('qwen3.5-9b-ud-q4kxl')
    await waitFor(() => expect(api.runBenchmark).toHaveBeenCalledTimes(1))
  })

  it('the verdict names the memory the live pick was judged against: graphics memory, unified memory, or RAM', async () => {
    const cases: Array<[PerformanceSnapshot['recommendation'], RegExp]> = [
      [{ modelId: 'qwen3.5-9b-ud-q4kxl', basis: 'unified' }, /best fit for this computer’s unified memory\./],
      [{ modelId: 'qwen3.5-9b-ud-q4kxl', basis: 'cpu' }, /best fit for this computer’s RAM\./],
      // Nothing in the catalog matches (or no catalog at all): the honest sentence, no CTA.
      [{ modelId: null, basis: 'cpu' }, /No model in the catalog matches this computer yet\./],
      [null, /No model in the catalog matches this computer yet\./]
    ]
    for (const [recommendation, text] of cases) {
      install(snapshot({ current: result({ tokensPerSecond: null, measuredModelId: null, speedBasis: null }), recommendation }), {
        getRuntimeStatus: vi.fn(async () => ({ running: false, modelId: null, port: null, healthy: false, message: '' }))
      })
      renderScreen()
      expect(await screen.findByText(text)).toBeInTheDocument()
      if (!recommendation?.modelId) expect(screen.queryByRole('button', { name: /and measure/ })).not.toBeInTheDocument()
      cleanup()
    }
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
    // The report carries the result's own pick, labelled as what the check said at the time.
    expect(text).toContain('Recommended at the time of the check: Qwen3.5 9B (UD-Q4_K_XL)')
  })

  it('surfaces a failed run as a calm banner and returns to the tiles', async () => {
    install(snapshot(), { runBenchmark: vi.fn(async () => { throw new Error('Error: Model is busy right now') }) })
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Check failed: .*busy/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })
})

// Keyboard focus across the busy swap (HW3; design-guidelines §6). The busy branch renders a
// different subtree — the steps list and a disabled "Running…" button — so the action button a
// keyboard user just activated is UNMOUNTED and the active element falls back to <body>: the
// user is dropped out of the screen mid-task. The screen puts focus back on the primary action
// when the run IT started ends, and only then.
describe('PerformanceScreen: focus survives the run', () => {
  it('returns focus to "Check again" after a run this window started', async () => {
    const run = deferred<BenchmarkResult>()
    const { api } = install(snapshot(), { runBenchmark: vi.fn(() => run.promise) })
    renderScreen()
    const button = await screen.findByRole('button', { name: 'Check again' })
    button.focus()
    expect(document.activeElement).toBe(button)
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(api.runBenchmark).toHaveBeenCalledTimes(1))
    // The busy branch has replaced the actions row: the focused node is gone.
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    expect(document.activeElement).toBe(document.body)
    await act(async () => {
      run.resolve(result())
    })
    const back = await screen.findByRole('button', { name: 'Check again' })
    expect(document.activeElement).toBe(back)
  })

  it('returns focus after "Start … and measure" too — to the action the idle row keeps', async () => {
    const run = deferred<BenchmarkResult>()
    const { api } = install(snapshot({ current: result({ tokensPerSecond: null, measuredModelId: null, speedBasis: null }) }), {
      getRuntimeStatus: vi.fn(async () => STOPPED_STATUS),
      runBenchmark: vi.fn(() => run.promise)
    })
    renderScreen()
    const start = await screen.findByRole('button', { name: 'Start Qwen3.5 9B (UD-Q4_K_XL) and measure' })
    start.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(api.runBenchmark).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(document.body)
    await act(async () => {
      run.resolve(result())
    })
    const back = await screen.findByRole('button', { name: 'Check again' })
    expect(document.activeElement).toBe(back)
  })

  it('a run this window did NOT start never steals focus', async () => {
    // Another window (or the first-run path) takes the lane and releases it. Nothing here was
    // activated, so the caret stays wherever the user left it — on the link they were reading.
    const { api, pushes } = install(snapshot({ running: true }))
    mountScreen()
    await screen.findByRole('button', { name: 'Running…' })
    const elsewhere = screen.getByRole('button', { name: 'Open Diagnostics' })
    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)
    api.getPerformance.mockResolvedValue(snapshot({ running: false }))
    await pushChanged(pushes)
    await screen.findByRole('button', { name: 'Check again' })
    expect(document.activeElement).toBe(elsewhere)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Check again' }))
  })
})

// The pushed refresh (PR #303 audit M1/M3; benchmark.md "Push, not poll"). `performance:changed`
// carries nothing: every push means "re-read `performance:get`". The screen's own action flag and
// the backend's occupancy span stay separate — one belongs to this window, the other to the
// machine — and no read is polled, dropped, doubled or applied out of order.
describe('PerformanceScreen: the pushed refresh', () => {
  it('subscribes before the first read, and unsubscribes on unmount', async () => {
    const { api, calls, pushes, unsubscribed } = install(snapshot())
    const view = mountScreen()
    await screen.findByText(/Runs Qwen3\.5 9B/)
    // A push that lands DURING the first read must find a listener already there.
    expect(calls[0]).toBe('onPerformanceChanged')
    expect(calls.indexOf('onPerformanceChanged')).toBeLessThan(calls.indexOf('getPerformance'))
    expect(api.onPerformanceChanged).toHaveBeenCalledTimes(1)
    const reads = api.getPerformance.mock.calls.length
    view.unmount()
    expect(unsubscribed()).toBe(1)
    await pushChanged(pushes)
    expect(api.getPerformance).toHaveBeenCalledTimes(reads)
  })

  it('registers one listener per mount and leaves none behind on a remount', async () => {
    const { api, pushes, unsubscribed } = install(snapshot())
    const first = mountScreen()
    await screen.findByText(/Runs Qwen3\.5 9B/)
    first.unmount()
    mountScreen()
    await screen.findByText(/Runs Qwen3\.5 9B/)
    expect(api.onPerformanceChanged).toHaveBeenCalledTimes(2)
    expect(unsubscribed()).toBe(1)
    // Both callbacks still exist in the fake bridge; only the live screen reads.
    expect(pushes).toHaveLength(2)
    const reads = api.getPerformance.mock.calls.length
    await pushChanged(pushes)
    expect(api.getPerformance).toHaveBeenCalledTimes(reads + 1)
  })

  it('M1: a run this window did not start releases the screen the moment the backend is idle', async () => {
    const { api, pushes } = install(snapshot({ running: true }))
    mountScreen()
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled()
    api.getPerformance.mockResolvedValue(snapshot({ running: false }))
    await pushChanged(pushes)
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled()
    // The tiles are back, not just the button.
    expect(screen.getByText('Speed')).toBeInTheDocument()
    expect(screen.getByText(/Runs Qwen3\.5 9B/)).toBeInTheDocument()
  })

  it('M1: an external run shows as running with no steps ticked, never the last run’s', async () => {
    let resolveRun: (r: BenchmarkResult) => void = () => {}
    const { api, progress, pushes } = install(snapshot(), {
      runBenchmark: vi.fn(() => new Promise<BenchmarkResult>((r) => (resolveRun = r)))
    })
    mountScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    act(() => progress.forEach((cb) => cb('system')))
    expect(screen.getByText('Hardware detected').closest('li')?.className).toContain('perf-step-done')
    await act(async () => {
      resolveRun(result())
    })
    await screen.findByRole('button', { name: 'Check again' })
    // Someone else takes the lane: this window gets no steps for that run, so it shows none.
    api.getPerformance.mockResolvedValue(snapshot({ running: true }))
    await pushChanged(pushes)
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled()
    expect(screen.getByText('Hardware detected').closest('li')?.className).not.toContain('perf-step-done')
  })

  it('the push announcing our OWN run does not un-tick the steps it already reported', async () => {
    let resolveRun: (r: BenchmarkResult) => void = () => {}
    const { api, progress, pushes } = install(snapshot(), {
      runBenchmark: vi.fn(() => new Promise<BenchmarkResult>((r) => (resolveRun = r)))
    })
    mountScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    act(() => progress.forEach((cb) => cb('system')))
    // Main pushes when the run takes its span — that snapshot is about OUR run.
    api.getPerformance.mockResolvedValue(snapshot({ running: true }))
    await pushChanged(pushes)
    expect(screen.getByText('Hardware detected').closest('li')?.className).toContain('perf-step-done')
    await act(async () => {
      resolveRun(result())
    })
  })

  it('back-to-back checks each start with a clean step list', async () => {
    let resolveRun: (r: BenchmarkResult) => void = () => {}
    const { progress } = install(snapshot(), {
      runBenchmark: vi.fn(() => new Promise<BenchmarkResult>((r) => (resolveRun = r)))
    })
    mountScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    act(() => progress.forEach((cb) => cb('system')))
    act(() => progress.forEach((cb) => cb('drive')))
    expect(screen.getByText('Drive speed').closest('li')?.className).toContain('perf-step-done')
    await act(async () => {
      resolveRun(result())
    })
    await screen.findByRole('button', { name: 'Check again' })
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    // The second run starts from nothing — never from what the first one reported.
    expect(screen.getByText('Hardware detected').closest('li')?.className).not.toContain('perf-step-done')
    expect(screen.getByText('Drive speed').closest('li')?.className).not.toContain('perf-step-done')
    await act(async () => {
      resolveRun(result())
    })
  })

  it('M3: an observation from normal use fills the rows without leaving the screen', async () => {
    const { api, pushes } = install(snapshot({ observed: noObservations }))
    mountScreen()
    await screen.findByText(/Nothing observed yet this session/)
    api.getPerformance.mockResolvedValue(snapshot({ observed: observedAnswer }))
    await pushChanged(pushes)
    expect(await screen.findByText(/Last answer: 40\.0 tokens \/ s/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing observed yet this session/)).not.toBeInTheDocument()
  })

  it('a check this window starts disables its own button while the backend is still idle', async () => {
    let resolveRun: (r: BenchmarkResult) => void = () => {}
    const { api } = install(snapshot(), {
      runBenchmark: vi.fn(() => new Promise<BenchmarkResult>((r) => (resolveRun = r)))
    })
    mountScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    // Nothing pushed and the snapshot still says idle: the local flag alone drives this.
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    expect(api.getPerformance).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRun(result())
    })
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(api.getPerformance).toHaveBeenCalledTimes(2)
  })

  it('a push during a read is never dropped: one more read follows it', async () => {
    const first = deferred<PerformanceSnapshot>()
    let call = 0
    const { api, pushes } = install(snapshot(), {
      getPerformance: vi.fn(() => {
        call += 1
        return call === 1 ? first.promise : Promise.resolve(snapshot({ observed: observedAnswer }))
      })
    })
    mountScreen()
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(1))
    await pushChanged(pushes)
    // Serialised: the follow-up waits for the read already out.
    expect(api.getPerformance).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.resolve(snapshot({ observed: noObservations }))
    })
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Last answer: 40\.0 tokens \/ s/)).toBeInTheDocument()
  })

  it('several pushes during one read coalesce into a single follow-up read', async () => {
    const first = deferred<PerformanceSnapshot>()
    let call = 0
    const { api, pushes } = install(snapshot(), {
      getPerformance: vi.fn(() => {
        call += 1
        return call === 1 ? first.promise : Promise.resolve(snapshot())
      })
    })
    mountScreen()
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(1))
    await pushChanged(pushes)
    await pushChanged(pushes)
    await pushChanged(pushes)
    expect(api.getPerformance).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.resolve(snapshot())
    })
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(2))
    // …and no third: one pass answered all three pushes.
    await act(async () => {})
    expect(api.getPerformance).toHaveBeenCalledTimes(2)
  })

  it('a reply from a superseded read is discarded, never applied over a newer one', async () => {
    // The runtime status is read alongside each snapshot. Hold the FIRST one open, let a push
    // issue a second read whose status says nothing is running, then answer the first with the
    // opposite: the stale answer must not take the "Start … and measure" offer away.
    const slowStatus = deferred<RuntimeStatus>()
    let statusCall = 0
    const { api, pushes } = install(
      snapshot({ current: result({ tokensPerSecond: null, measuredModelId: null, speedBasis: null }) }),
      {
        getRuntimeStatus: vi.fn(() => {
          statusCall += 1
          return statusCall === 1 ? slowStatus.promise : Promise.resolve(STOPPED_STATUS)
        })
      }
    )
    mountScreen()
    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalledTimes(1))
    await pushChanged(pushes)
    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Start Qwen3.5 9B (UD-Q4_K_XL) and measure' })).toBeInTheDocument()
    await act(async () => {
      slowStatus.resolve(RUNNING_STATUS)
    })
    expect(screen.getByRole('button', { name: 'Start Qwen3.5 9B (UD-Q4_K_XL) and measure' })).toBeInTheDocument()
  })

  it('a read that lands after unmount applies nothing', async () => {
    const pending = deferred<PerformanceSnapshot>()
    const { api } = install(snapshot(), { getPerformance: vi.fn(() => pending.promise) })
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
    try {
      const view = mountScreen()
      await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(1))
      view.unmount()
      await act(async () => {
        pending.resolve(snapshot())
      })
      // No "update on an unmounted component" / "not wrapped in act" noise.
      expect(errors).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('the done step re-reads instead of declaring the run over', async () => {
    const { api, progress } = install(snapshot({ running: true }))
    mountScreen()
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled()
    // 'done' means the PROBES finished — the persist and the release still follow, so the
    // screen re-reads and keeps the run up until a snapshot says otherwise.
    await act(async () => {
      progress.forEach((cb) => cb('done'))
    })
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    api.getPerformance.mockResolvedValue(snapshot({ running: false }))
    await act(async () => {
      progress.forEach((cb) => cb('done'))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled())
  })

  it('a failed read keeps the figures, says so, and the retry brings them back', async () => {
    let call = 0
    const { api, pushes } = install(snapshot(), {
      getPerformance: vi.fn(async () => {
        call += 1
        if (call === 2) throw new Error("Error invoking remote method 'performance:get': Error: Workspace is locked")
        return snapshot()
      })
    })
    mountScreen()
    await screen.findByText(/Runs Qwen3\.5 9B/)
    await pushChanged(pushes)
    expect(await screen.findByText(/Could not read the latest figures: Workspace is locked/)).toBeInTheDocument()
    // The last figures stay on screen and the actions stay live.
    expect(screen.getByText(/Runs Qwen3\.5 9B/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText(/Could not read the latest figures/)).not.toBeInTheDocument())
    expect(api.getPerformance).toHaveBeenCalledTimes(3)
  })

  it('a later successful read clears the read failure without hiding the failed check', async () => {
    let call = 0
    const { pushes } = install(snapshot(), {
      runBenchmark: vi.fn(async () => {
        throw new Error('Error: Model is busy right now')
      }),
      getPerformance: vi.fn(async () => {
        call += 1
        if (call === 3) throw new Error('Error: Workspace is locked')
        return snapshot()
      })
    })
    mountScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Check failed: .*busy/)).toBeInTheDocument()
    await pushChanged(pushes)
    expect(
      await screen.findByText(/Check failed: .*busy.*Could not read the latest figures: Workspace is locked/)
    ).toBeInTheDocument()
    await pushChanged(pushes)
    await waitFor(() => expect(screen.queryByText(/Could not read the latest figures/)).not.toBeInTheDocument())
    expect(screen.getByText(/Check failed: .*busy/)).toBeInTheDocument()
  })

  it('a failed check clears only the local flag — a run that holds the lane still holds the screen', async () => {
    const { api, pushes } = install(snapshot(), {
      runBenchmark: vi.fn(async () => {
        throw new Error('Error: Model is busy right now')
      })
    })
    mountScreen()
    await screen.findByRole('button', { name: 'Check again' })
    // Refused because another run already holds the lane — which the next read reports.
    api.getPerformance.mockResolvedValue(snapshot({ running: true }))
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Check failed: .*busy/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    // When that run ends, the push brings the screen back — with the failure still on it.
    api.getPerformance.mockResolvedValue(snapshot({ running: false }))
    await pushChanged(pushes)
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(screen.getByText(/Check failed: .*busy/)).toBeInTheDocument()
  })

  it('survives a StrictMode double mount: the stale first reply is discarded and the re-read still loads', async () => {
    // React.StrictMode (main.tsx) runs every effect twice in development: mount → cleanup →
    // mount, on the SAME instance. The first read is still in flight when the cleanup bumps the
    // generation and the second mount asks for a read of its own; that read must follow, or the
    // screen sits on its empty state until the next push (the P3 launch smoke showed exactly
    // that: a completed first-run benchmark and a screen saying "Not checked yet").
    const first = deferred<PerformanceSnapshot>()
    let reads = 0
    const { api } = install(snapshot(), {
      getPerformance: vi.fn(() => {
        reads += 1
        return reads === 1 ? first.promise : Promise.resolve(snapshot())
      })
    })
    render(
      <StrictMode>
        <ToastProvider>
          <PerformanceScreen onNavigate={vi.fn()} />
        </ToastProvider>
      </StrictMode>
    )
    await waitFor(() => expect(api.getPerformance).toHaveBeenCalledTimes(1))
    await act(async () => {
      first.resolve(snapshot())
    })
    // The models card renders only from an APPLIED snapshot: the second read must have landed.
    expect(await screen.findByText('Models on this computer')).toBeInTheDocument()
    expect(api.getPerformance).toHaveBeenCalledTimes(2)
  })

})

// PR #303 audit P4 (H1 / L8 / M5 residual): the persisted benchmark records are validated on
// both sides of the settings store now, and the screen reads the launch context off the
// snapshot instead of recomputing it. These cover what the screen must do with what it is
// handed — including a record that never should have reached it.
describe('PerformanceScreen: malformed records and the resolved context', () => {
  it('H1: a structurally invalid other-computer row costs its own figures, never the screen', async () => {
    // The exact shape the old settings gate accepted and the snapshot exposed. `fmt1(undefined)`
    // threw here, and there is no error boundary above this screen: the whole page went blank.
    install(snapshot({ otherMachines: [{} as BenchmarkResult, office] }))
    renderScreen()
    // The screen is up, the healthy row beside the blob is complete…
    expect(await screen.findByText('Other computers this drive has been used on')).toBeInTheDocument()
    expect(screen.getByText(/Intel Core i9-13900K, 64\.0 GB RAM, 24\.0 GB VRAM/)).toBeInTheDocument()
    // …and the blob reads as unknowns rather than crashing or inventing figures.
    expect(screen.getByText(/Unknown CPU, – GB RAM/)).toBeInTheDocument()
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(1)
  })

  it('H1: a partially filled record renders the fields it has and dashes the ones it lacks', async () => {
    const partial = { cpuModel: 'Half A Record', profile: 'LITE', ranAt: '2026-08-01T00:00:00Z' } as unknown as BenchmarkResult
    install(snapshot({ otherMachines: [partial] }))
    renderScreen()
    expect(await screen.findByText(/Half A Record, – GB RAM/)).toBeInTheDocument()
    // Its own profile pill (the current result carries the same one).
    expect(screen.getAllByText('Lite')).toHaveLength(2)
  })

  it('H1: a current result with no usable figures still renders the card', async () => {
    const legacy = { profile: 'BALANCED', ranAt: '' } as unknown as BenchmarkResult
    install(snapshot({ current: legacy, otherMachines: [] }))
    renderScreen()
    // An unknown date says so instead of printing "Invalid Date" or an empty stamp.
    expect(await screen.findByText('Checked –')).toBeInTheDocument()
    expect(screen.getByText('Balanced')).toBeInTheDocument()
  })

  it('M5 residual: the context in the report is the snapshot’s, not a recomputed catalog value', async () => {
    // The catalog says 8,192 for this model; the snapshot says what the runtime would ACTUALLY
    // launch with (a manifest stating no window falls back to the settings default). The screen
    // must state the snapshot's figure — recomputing produced "0-token context" for that model.
    const { api } = install(snapshot({ placement: placement({ recommendedContextTokens: 4096 }) }))
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    const text = api.copyToClipboard.mock.calls[0][0] as string
    expect(text).toContain('4,096 tokens')
    expect(text).not.toContain('8,192 tokens')
    expect(text).not.toContain('0 tokens')
  })

  it('M5 residual: with nothing recommended the report states no context at all', async () => {
    const { api } = install(snapshot({ placement: placement({ recommendedContextTokens: null }) }))
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    expect(api.copyToClipboard.mock.calls[0][0] as string).not.toContain('Context size')
  })

  it('an earlier measurement under another configuration is dated, not presented as the fit', async () => {
    install(
      snapshot({
        placement: placement({
          observed: null,
          observedMismatch: { contextTokens: 32_768, backend: 'gpu', at: '2026-09-01T00:00:00Z' }
        })
      })
    )
    renderScreen()
    expect(await screen.findByText(/Measured earlier with a 32,768-token context on/)).toBeInTheDocument()
    // The verdict beside it is still the estimate for the CURRENT settings.
    expect(screen.getByText(/Needs at least 5\.8 GB for the weights/)).toBeInTheDocument()
  })

  it('the same line in German (D-L8: asserted from the catalog, never a retyped literal)', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    install(
      snapshot({
        placement: placement({
          observed: null,
          observedMismatch: { contextTokens: 32_768, backend: 'gpu', at: '2026-09-01T00:00:00Z' }
        })
      })
    )
    render(
      <I18nProvider>
        <ToastProvider>
          <PerformanceScreen onNavigate={vi.fn()} />
        </ToastProvider>
      </I18nProvider>
    )
    const expected = t('de', 'perf.model.measuredOther', {
      context: (32_768).toLocaleString('de'),
      when: new Date('2026-09-01T00:00:00Z').toLocaleDateString('de')
    })
    expect(await screen.findByText(expected)).toBeInTheDocument()
  })
})

// PR #303 audit P6 (L6): a decode figure never travels without HOW it was measured. The Speed
// tile already said "Approximate" for a chunk-counted reading; the Copy report and the
// other-computer rows presented the same number as an ordinary tokens/s figure with a Good/Slow
// rating, and the report headed every machine's figures "This computer".
describe('PerformanceScreen: where a speed figure came from', () => {
  it('L6: the report carries the window a runtime-timings figure covers, and calls it nothing else', async () => {
    const { api } = install(snapshot())
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    const text = api.copyToClipboard.mock.calls[0][0] as string
    expect(text).toContain('12 tokens / s (Measured with Qwen3.5 9B (UD-Q4_K_XL) on')
    expect(text).toContain('over 64 tokens')
    expect(text).not.toMatch(/approximate/i)
    expect(text).not.toMatch(/chunks/i)
  })

  it('L6: the report preserves the approximation qualifier and the chunk window', async () => {
    const { api } = install(snapshot({ current: result({ speedBasis: { basis: 'chunks', tokens: 10 } }) }))
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    const text = api.copyToClipboard.mock.calls[0][0] as string
    expect(text).toMatch(/approximate|chunks/i)
    expect(text).toContain('Approximate: counted chunks, not runtime timings; 10 chunks')
    expect(text).not.toContain('over 10 tokens')
  })

  it('L6: a legacy result with NO basis is approximate with no invented window, on the tile and in the report', async () => {
    // Every result persisted before #291 was chunk-based and recorded no window. The app says
    // so and stops there — it never dresses the missing figure up as a token or chunk count.
    const legacy = result()
    delete (legacy as Partial<BenchmarkResult>).speedBasis
    const { api } = install(snapshot({ current: legacy }))
    renderScreen()
    expect(await screen.findByText('Approximate')).toBeInTheDocument()
    expect(screen.getByText(/Approximate: counted chunks, not runtime timings/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    const text = api.copyToClipboard.mock.calls[0][0] as string
    expect(text).toContain('Approximate: counted chunks, not runtime timings')
    expect(text).not.toMatch(/\d+ chunks/)
    expect(text).not.toMatch(/over \d+ tokens/)
  })

  it('L6: a result from another computer is not headed "This computer" — the report names the machine it belongs to', async () => {
    const { api } = install(snapshot({ currentMachine: false }))
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Copy report' }))
    await waitFor(() => expect(api.copyToClipboard).toHaveBeenCalledTimes(1))
    const text = api.copyToClipboard.mock.calls[0][0] as string
    expect(text.split('\n')[0]).toBe('Another computer: Intel Core i7-1260P, 15.7 GB RAM')
    expect(text).not.toContain('This computer')
  })

  it('L6: an other-computer row measured from chunks reads "Approximate", never Good or Slow', async () => {
    install(snapshot({
      otherMachines: [result({ cpuModel: 'Old CPU', ramGb: 8, tokensPerSecond: 24, speedBasis: { basis: 'chunks', tokens: 10 } })]
    }))
    renderScreen()
    const row = (await screen.findByText(/Old CPU/)).closest('.perf-row') as HTMLElement
    expect(within(row).getByText('Approximate')).toBeInTheDocument()
    // The qualifier travels with the row, in the same words the tile uses.
    expect(
      within(row).getByText(/Old CPU, 8\.0 GB RAM · .* · Approximate: counted chunks, not runtime timings; 10 chunks/)
    ).toBeInTheDocument()
    // 24 tokens/s is above the slow threshold — the row must not claim the machine is Good on
    // the strength of a figure the app cannot stand behind. Scoped to the row: the CURRENT
    // result is a timings figure and keeps its own Good rating on the Speed tile.
    expect(within(row).queryByText('Good')).not.toBeInTheDocument()
    expect(within(row).queryByText('Slow')).not.toBeInTheDocument()
  })

  it('L6: an other-computer row with NO basis is approximate with no window', async () => {
    const legacy = result({ cpuModel: 'Older CPU', ramGb: 8, tokensPerSecond: 24 })
    delete (legacy as Partial<BenchmarkResult>).speedBasis
    install(snapshot({ otherMachines: [legacy] }))
    renderScreen()
    expect(await screen.findByText('Approximate')).toBeInTheDocument()
    expect(screen.getByText(/Older CPU, 8\.0 GB RAM · .* · Approximate: counted chunks, not runtime timings$/)).toBeInTheDocument()
    expect(screen.queryByText(/chunks;/)).not.toBeInTheDocument()
  })

  it('L6: an other-computer row measured from runtime timings keeps its Good/Slow rating and names its window', async () => {
    install(snapshot({ otherMachines: [office, oldLaptop] }))
    renderScreen()
    await screen.findByText(/41 tokens \/ s with Qwen3\.8 27B UD-Q4_K_M/)
    expect(screen.queryByText('Approximate')).not.toBeInTheDocument()
    // office (41 t/s) is Good, oldLaptop (2 t/s) is Slow — plus the current result's own Good.
    expect(screen.getAllByText('Good').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Slow').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Intel Core i9-13900K, 64\.0 GB RAM, 24\.0 GB VRAM · .* · over 64 tokens/)).toBeInTheDocument()
  })
})

// PR #303 audit P6 (N4 / N5): two labels that contradicted the figure beside them.
describe('PerformanceScreen: labels that match what is measured', () => {
  it('N4: the empty Drive tile credits a file check as well as a model start', async () => {
    install(snapshot({ current: result({ effectiveRead: null }) }))
    renderScreen()
    expect(await screen.findByText('Measured by the first model start or file check')).toBeInTheDocument()
  })

  it('N5: the drive step is "Drive speed", not "Drive write speed" beside a tile reading MB/s read', async () => {
    install(snapshot({ running: true }))
    renderScreen()
    expect(await screen.findByText('Drive speed')).toBeInTheDocument()
    expect(screen.queryByText(/write speed/i)).not.toBeInTheDocument()
  })
})
