import { act, render, screen, waitFor, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, vi, type Mock } from 'vitest'
import { PerformanceScreen } from '../../src/renderer/screens/PerformanceScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { PreloadApi } from '../../src/preload'
import {
  DEFAULT_SETTINGS,
  type BenchmarkProgressStep,
  type BenchmarkResult,
  type ModelInfo,
  type ModelPlacement,
  type PerformanceSnapshot,
  type RuntimeStatus
} from '../../src/shared/types'
import type { UiLanguage } from '../../src/shared/i18n'
import { benchmarkResult, modelPlacement } from './benchmark-records'
import { deferred } from './deferred'
import { renderInLanguage } from './render-language'
import { stubApi } from './renderer'
import { appStatus, performanceSnapshot, runtimeStatus } from './status'

// The Performance screen harness (perf campaign, lane D). Moved out of PerformanceScreen.test.tsx: its
// `result`, `office`, `oldLaptop`, `models`, `placement`, `observedFull`, `snapshot`, `install`,
// `pushChanged`, `renderScreen` / `mountScreen`, plus the "Check again with the run held open" and
// "press Copy report" sequences the suite spelled out 12 and 13 times. Imports no main module, so it is
// safe in jsdom. EngineProblem.test.tsx (`stubPerformance`) and GermanSmoke.test.tsx (`perfSnapshot`)
// carry the same result literal and have not adopted this yet.

/** The laptop every default snapshot describes. Sets every field `benchmarkResult` sets, so none of that default's other-computer RTX 3090 leaks in. */
export function laptopResult(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return benchmarkResult({
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
  })
}

export const office: BenchmarkResult = laptopResult({
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

export const oldLaptop: BenchmarkResult = laptopResult({
  cpuModel: 'Intel Core i5-8250U',
  cpuCores: 8,
  ramGb: 7.8,
  tokensPerSecond: 2,
  measuredModelId: 'qwen3.5-4b-ud-q4kxl',
  effectiveRead: { mbps: 70, bytes: 2_500_000_000, ms: 36_000, source: 'model_load', modelId: 'qwen3.5-4b-ud-q4kxl', at: '2026-08-28T10:00:00Z' },
  profile: 'TINY',
  ranAt: '2026-08-28T10:00:00Z'
})

export const MODELS = [
  { id: 'qwen3.5-9b-ud-q4kxl', displayName: 'Qwen3.5 9B (UD-Q4_K_XL)', state: 'installed', recommended: true, recommendedContextTokens: 8192 },
  { id: 'qwen3.8-27b-ud-q4km', displayName: 'Qwen3.8 27B UD-Q4_K_M', state: 'missing', recommended: false, recommendedContextTokens: 8192 },
  { id: 'qwen3.5-4b-ud-q4kxl', displayName: 'Qwen3.5 4B (UD-Q4_K_XL)', state: 'missing', recommended: false, recommendedContextTokens: 8192 }
] as unknown as ModelInfo[]

/** A discrete-GPU machine with the 9B active and no start observed yet (weights-only estimate). */
export function placement(over: Partial<PerformanceSnapshot['placement']> = {}): PerformanceSnapshot['placement'] {
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
    totals: { ramAllMb: Math.round(17.0 * 1024), bothOnCard: false, chatAndTranslationOnCard: false },
    ...over
  }
}

export const OBSERVED_FULL: ModelPlacement = modelPlacement({ modelId: 'qwen3.5-9b-ud-q4kxl', machineKey: null })

/** A laptop checked on this computer, two other computers on the drive, the 9B live and observed. */
export function checkedSnapshot(over: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return performanceSnapshot({
    current: laptopResult(),
    // The LIVE pick (the same one the AI Model screen stars); the default agrees with the result's saved pick.
    recommendation: { modelId: 'qwen3.5-9b-ud-q4kxl', basis: 'discrete' },
    otherMachines: [office, oldLaptop],
    placement: placement(),
    observed: {
      lastAnswer: { tokensPerSecond: 11.8, ttftMs: 900, tokens: 312, modelId: 'qwen3.5-9b-ud-q4kxl', at: '2026-09-05T14:02:00Z' },
      lastModelLoad: laptopResult().effectiveRead ?? null,
      lastChecksum: null
    },
    ...over
  })
}

export const RUNNING_STATUS: RuntimeStatus = runtimeStatus({ modelId: 'qwen3.5-9b-ud-q4kxl', port: 1, message: '' })
export const STOPPED_STATUS: RuntimeStatus = runtimeStatus({ running: false, modelId: null, port: null, healthy: false, message: '' })

/** A typed `window.api` for a mounted screen answering `snap`. `over` replaces a default, and must be a `vi.fn`. */
export function installPerformance(snap: PerformanceSnapshot, over: Partial<PreloadApi> = {}) {
  const progress: Array<(step: BenchmarkProgressStep) => void> = []
  /** Every live `performance:changed` subscriber (the payload-free "re-read the snapshot"). */
  const pushes: Array<() => void> = []
  /** The order the screen touched the bridge in: defaults only, an override records nothing. */
  const calls: string[] = []
  let unsubscribes = 0
  const defaults = {
    getPerformance: vi.fn<PreloadApi['getPerformance']>(async () => {
      calls.push('getPerformance')
      return snap
    }),
    listModels: vi.fn<PreloadApi['listModels']>(async () => {
      calls.push('listModels')
      return MODELS
    }),
    getSettings: vi.fn<PreloadApi['getSettings']>(async () => DEFAULT_SETTINGS),
    getRuntimeStatus: vi.fn<PreloadApi['getRuntimeStatus']>(async () => RUNNING_STATUS),
    // useEngineProblems calls these two on every mount.
    getAppStatus: vi.fn<PreloadApi['getAppStatus']>(async () => appStatus()),
    onEngineProblemsChanged: vi.fn<PreloadApi['onEngineProblemsChanged']>(() => () => {}),
    onBenchmarkProgress: vi.fn<PreloadApi['onBenchmarkProgress']>((cb) => {
      progress.push(cb)
      return () => {}
    }),
    onPerformanceChanged: vi.fn<PreloadApi['onPerformanceChanged']>((cb) => {
      calls.push('onPerformanceChanged')
      pushes.push(cb)
      return () => {
        unsubscribes += 1
      }
    }),
    runBenchmark: vi.fn<PreloadApi['runBenchmark']>(async () => laptopResult()),
    useModel: vi.fn<PreloadApi['useModel']>(async () => RUNNING_STATUS),
    copyToClipboard: vi.fn<PreloadApi['copyToClipboard']>(async () => true)
  }
  // Every override a suite passes is a vi.fn, so the merged record keeps `.mock`.
  const api = { ...defaults, ...over } as typeof defaults
  stubApi(api)
  return { api, progress, pushes, calls, unsubscribed: () => unsubscribes }
}

/** Deliver `performance:changed` to every subscriber and let the re-read settle. */
export async function pushChanged(pushes: Array<() => void>): Promise<void> {
  await act(async () => {
    for (const cb of pushes) cb()
  })
}

/** The screen under its ToastProvider; `lang` goes through `renderInLanguage` (the caller clears localStorage). */
export function renderPerformanceScreen(opts: { lang?: UiLanguage } = {}): RenderResult & { onNavigate: Mock<(target: string) => void> } {
  const onNavigate = vi.fn<(target: string) => void>()
  const ui = (
    <ToastProvider>
      <PerformanceScreen onNavigate={onNavigate} />
    </ToastProvider>
  )
  const result = opts.lang ? renderInLanguage(ui, opts.lang) : render(ui)
  return { ...result, onNavigate }
}

/** Press "Check again" with runBenchmark held open; `finish` resolves it inside act. English UI. */
export async function startOwnRun(): Promise<{ finish(r?: BenchmarkResult): Promise<void> }> {
  const run = deferred<BenchmarkResult>()
  vi.mocked(window.api.runBenchmark).mockImplementationOnce(() => run.promise)
  await userEvent.click(await screen.findByRole('button', { name: 'Check again' }))
  return {
    finish: async (r = laptopResult()) => {
      await act(async () => {
        run.resolve(r)
      })
    }
  }
}

/** Press Copy report; the text the clipboard received. Pass the label in another language. */
export async function copiedReport(name = 'Copy report'): Promise<string> {
  await userEvent.click(await screen.findByRole('button', { name }))
  await waitFor(() => expect(window.api.copyToClipboard).toHaveBeenCalledTimes(1))
  return vi.mocked(window.api.copyToClipboard).mock.calls[0][0]
}

/** The tile a label heads. The class is only a locator: a tile has no role. */
export function tile(label: string): HTMLElement {
  const found = screen.getByText(label).closest<HTMLElement>('.perf-tile')
  if (!found) throw new Error(`tile(${JSON.stringify(label)}): that text sits in no .perf-tile`)
  return found
}

/** The other-computer row holding the text `match` finds. */
export function otherRow(match: RegExp): HTMLElement {
  const found = screen.getByText(match).closest<HTMLElement>('.perf-row')
  if (!found) throw new Error(`otherRow(${String(match)}): that text sits in no .perf-row`)
  return found
}
