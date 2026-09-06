import { describe, it, expect, beforeEach } from 'vitest'
import {
  attributedGpuFigures,
  findMachine,
  latestAnswerSpeed,
  loadedAtOnceMb,
  machineKey,
  memoryBudgetMb,
  memoryClassOf,
  otherMachines,
  placementVerdict,
  recordAnswerSpeed,
  resetPerformanceForTests,
  upsertHistory
} from '../../src/main/services/performance'
import {
  MAX_BENCHMARK_HISTORY,
  type BenchmarkResult,
  type ModelPlacement,
  type PlacementVerdict,
  type ResidentModelRow
} from '../../src/shared/types'

// The Performance screen's model (benchmark.md "History per machine"): one result per
// computer, keyed by a fingerprint that survives a reboot (rounded RAM) and that an OLD
// blob without identity fields never matches (so it is never mistaken for a moved drive).

function result(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    os: 'linux',
    arch: 'x64',
    cpuModel: 'Intel Core i7-1260P',
    cpuCores: 12,
    ramGb: 15.7,
    gpu: null,
    driveReadMbps: null,
    driveWriteMbps: 300,
    tokensPerSecond: 12,
    measuredModelId: 'qwen3.5-9b-ud-q4kxl',
    effectiveRead: null,
    profile: 'LITE',
    recommendedModelId: 'qwen3.5-9b-ud-q4kxl',
    warnings: [],
    ranAt: '2026-09-04T14:02:00Z',
    ...over
  }
}

describe('machineKey', () => {
  it('fingerprints OS, arch, CPU model, cores and ROUNDED RAM', () => {
    expect(machineKey(result())).toBe('linux|x64|Intel Core i7-1260P|12|16')
    // totalmem drifts by a few MB between boots of the same machine, so the key is the same.
    expect(machineKey(result({ ramGb: 15.9 }))).toBe(machineKey(result({ ramGb: 16.2 })))
    expect(machineKey(result({ cpuCores: 8 }))).not.toBe(machineKey(result()))
  })

  it('is null for a result with no usable identity (old blobs, failed detection)', () => {
    expect(machineKey(null)).toBeNull()
    expect(machineKey({ profile: 'BALANCED' } as unknown as BenchmarkResult)).toBeNull()
    expect(machineKey(result({ cpuModel: '' }))).toBeNull()
    expect(machineKey(result({ ramGb: 0 }))).toBeNull()
  })
})

describe('upsertHistory', () => {
  it('replaces the entry for the same machine, newest first, keeps other machines', () => {
    const office = result({ cpuModel: 'i9-13900K', cpuCores: 32, ramGb: 64, ranAt: '2026-09-02T00:00:00Z', tokensPerSecond: 41 })
    const laptopOld = result({ ranAt: '2026-08-01T00:00:00Z', tokensPerSecond: 4 })
    const laptopNew = result({ ranAt: '2026-09-04T00:00:00Z', tokensPerSecond: 12 })
    const history = upsertHistory(upsertHistory([], laptopOld), office)
    expect(history.map((e) => e.ranAt)).toEqual([office.ranAt, laptopOld.ranAt])
    const next = upsertHistory(history, laptopNew)
    expect(next).toHaveLength(2)
    // Identities AND order: laptopNew replaces laptopOld and leads; office (a distinct
    // tokensPerSecond, so this can't pass by coincidence) is untouched, second.
    expect(next[0]).toBe(laptopNew)
    expect(next[1]).toBe(office)
    expect(next.map((e) => e.cpuModel)).toEqual([laptopNew.cpuModel, office.cpuModel])
    expect(next.map((e) => e.tokensPerSecond)).toEqual([12, 41])
  })

  it('caps at MAX_BENCHMARK_HISTORY, dropping the oldest OTHER machines, never the new one', () => {
    let history: BenchmarkResult[] = []
    for (let i = 0; i < MAX_BENCHMARK_HISTORY + 2; i++) {
      history = upsertHistory(history, result({ cpuModel: `cpu-${i}`, ranAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    }
    expect(history).toHaveLength(MAX_BENCHMARK_HISTORY)
    expect(history[0].cpuModel).toBe(`cpu-${MAX_BENCHMARK_HISTORY + 1}`)
    expect(history.some((e) => e.cpuModel === 'cpu-0')).toBe(false)
  })

  it('does not record a result with no machine identity (it could never be matched again)', () => {
    expect(upsertHistory([result()], result({ cpuModel: '' }))).toHaveLength(1)
  })
})

describe('findMachine / otherMachines', () => {
  const here = result()
  const office = result({ cpuModel: 'i9-13900K', cpuCores: 32, ramGb: 64, ranAt: '2026-09-02T00:00:00Z' })
  const old = result({ cpuModel: 'i5-8250U', cpuCores: 8, ramGb: 8, ranAt: '2026-08-28T00:00:00Z' })
  const history = [old, here, office]

  it('finds the entry for a key, null for an unknown or null key', () => {
    expect(findMachine(history, machineKey(office))).toBe(office)
    expect(findMachine(history, 'nope')).toBeNull()
    expect(findMachine(history, null)).toBeNull()
  })

  it('lists everything but the current machine, newest first', () => {
    expect(otherMachines(history, machineKey(here))).toEqual([office, old])
    // Unknown current machine: every entry is "other".
    expect(otherMachines(history, null)).toHaveLength(3)
  })
})

describe('answer-speed latch', () => {
  beforeEach(() => resetPerformanceForTests())

  it('is empty until the first finished answer, then holds the latest with model + time', () => {
    expect(latestAnswerSpeed()).toBeNull()
    const now = () => new Date('2026-09-05T09:00:00Z')
    recordAnswerSpeed({ messageId: 'a1', tokensPerSecond: 11.8, ttftMs: 900, tokens: 312 }, 'qwen', now)
    expect(latestAnswerSpeed()).toEqual({
      tokensPerSecond: 11.8,
      ttftMs: 900,
      tokens: 312,
      modelId: 'qwen',
      at: '2026-09-05T09:00:00.000Z'
    })
    recordAnswerSpeed({ messageId: 'a2', tokensPerSecond: 3, ttftMs: 2000, tokens: 10 }, null, now)
    expect(latestAnswerSpeed()?.tokensPerSecond).toBe(3)
  })
})

// ---- "Your model" (benchmark.md): memory class, budget, verdict ----

const RTX = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_576, freeMb: 20_000 }
const IRIS = { id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16_384, freeMb: 16_000 }

describe('memoryClassOf / memoryBudgetMb', () => {
  it('Apple Silicon is unified regardless of the probe; a usable card is discrete; else cpu', () => {
    expect(memoryClassOf('darwin', 'arm64', [])).toBe('unified')
    expect(memoryClassOf('linux', 'x64', [RTX])).toBe('discrete')
    // The iGPU reporting shared memory is NOT a discrete budget (the runtime's own gate).
    expect(memoryClassOf('win32', 'x64', [IRIS])).toBe('cpu')
    expect(memoryClassOf('win32', 'x64', [])).toBe('cpu')
  })

  it('budgets: VRAM for discrete, Metal working set (else 75% of RAM) for unified, RAM for cpu', () => {
    expect(memoryBudgetMb('discrete', 16_000, 24_576, null)).toBe(24_576)
    expect(memoryBudgetMb('unified', 49_152, null, null)).toBe(36_864)
    const withMetal = { metalMaxWorkingSetMb: 40_000 } as ModelPlacement
    expect(memoryBudgetMb('unified', 49_152, null, withMetal)).toBe(40_000)
    expect(memoryBudgetMb('cpu', 16_000, null, null)).toBe(16_000)
  })
})

describe('placementVerdict', () => {
  const observed = (over: Partial<ModelPlacement> = {}): ModelPlacement => ({
    modelId: 'm', contextTokens: 8192, backend: 'gpu', gpuLayers: 41, totalLayers: 41,
    gpuModelMb: 5500, cpuModelMb: 400, gpuKvMb: 640, cpuKvMb: null, metalMaxWorkingSetMb: null,
    machineKey: null, at: '2026-09-05T00:00:00Z', ...over
  })

  it('reads an observed start off the log: all layers on the GPU, size = weights + cache', () => {
    const v = placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 5.8, observed: observed() })
    expect(v).toMatchObject({ kind: 'gpu', needMb: 6540, estimated: false, budgetMb: 24_576, gpuLayers: 41, totalLayers: 41 })
  })

  it('a partial offload is named with the CPU-side bytes as the spill; a CPU backend is cpu', () => {
    const partial = placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 8192, sizeOnDiskGb: 5.8, observed: observed({ gpuLayers: 30, cpuModelMb: 1900, cpuKvMb: 200 }) })
    expect(partial).toMatchObject({ kind: 'partial', spillMb: 2100, gpuLayers: 30, totalLayers: 41 })
    const cpu = placementVerdict({ memoryClass: 'cpu', ramMb: 16_000, vramMb: null, sizeOnDiskGb: 5.8, observed: observed({ backend: 'cpu', gpuLayers: null, totalLayers: null }) })
    expect(cpu.kind).toBe('cpu')
  })

  it('a GPU start whose log carried no offload line is unknown, never "all on the GPU"', () => {
    const v = placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 19.8, observed: observed({ gpuLayers: null, totalLayers: null, gpuModelMb: null, cpuModelMb: null, gpuKvMb: null }) })
    expect(v.kind).toBe('unknown')
    expect(v.needMb).toBeNull()
    // Measured, not guessed: the record exists, it just never said where the layers went.
    expect(v.estimated).toBe(false)
    expect(v.spillMb).toBeNull()
    // Half a reading (only one of the two counts printed) is unknown too, never a split.
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 19.8, observed: observed({ totalLayers: null }) }).kind).toBe('unknown')
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 19.8, observed: observed({ gpuLayers: null }) }).kind).toBe('unknown')
  })

  it('an EMPTY reading is unknown on a gpu backend and cpu on a cpu backend, never a measured "On GPU"', () => {
    // Every figure null (a build logging below verbosity 4, or stderr the parser never saw):
    // the record proves a start happened, not that the model reached the card.
    const empty = observed({
      gpuLayers: null, totalLayers: null, gpuModelMb: null, cpuModelMb: null,
      gpuKvMb: null, cpuKvMb: null, metalMaxWorkingSetMb: null
    })
    const gpu = placementVerdict({ memoryClass: 'discrete', ramMb: 16_384, vramMb: 24_576, sizeOnDiskGb: 5.8, observed: empty })
    expect(gpu.kind).not.toBe('gpu')
    expect(gpu).toMatchObject({ kind: 'unknown', estimated: false, needMb: null, spillMb: null, gpuLayers: null, totalLayers: null })
    // The same empty reading on a CPU backend IS the answer: the backend alone settles it.
    const cpu = placementVerdict({ memoryClass: 'cpu', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 5.8, observed: { ...empty, backend: 'cpu' } })
    expect(cpu).toMatchObject({ kind: 'cpu', estimated: false, needMb: null, spillMb: null })
  })

  it('estimates from the weights before the first start, with headroom, per memory class', () => {
    const base = { ramMb: 16_384, vramMb: 24_576, sizeOnDiskGb: 5.8, observed: null }
    expect(placementVerdict({ memoryClass: 'discrete', ...base })).toMatchObject({ kind: 'gpu', needMb: 5939, estimated: true })
    // 19.8 GB on a 16 GB card: partial, the excess spills to RAM.
    const spill = placementVerdict({ memoryClass: 'discrete', ramMb: 32_768, vramMb: 16_384, sizeOnDiskGb: 19.8, observed: null })
    expect(spill.kind).toBe('partial')
    expect(spill.spillMb).toBe(Math.round(19.8 * 1024) - Math.round(16_384 * 0.92))
    // 19.8 GB on a 16 GB card in a 4 GB box: RAM cannot take the rest.
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 4096, vramMb: 16_384, sizeOnDiskGb: 19.8, observed: null }).kind).toBe('too_large')
    // Unified: the 75% budget decides.
    expect(placementVerdict({ memoryClass: 'unified', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 5.8, observed: null }).kind).toBe('gpu')
    expect(placementVerdict({ memoryClass: 'unified', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 12, observed: null }).kind).toBe('too_large')
    // CPU: RAM decides.
    expect(placementVerdict({ memoryClass: 'cpu', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 5.8, observed: null }).kind).toBe('cpu')
    expect(placementVerdict({ memoryClass: 'cpu', ramMb: 8192, vramMb: null, sizeOnDiskGb: 9, observed: null }).kind).toBe('too_large')
  })

  it('is unknown without a size or a budget', () => {
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: null, vramMb: null, sizeOnDiskGb: 5.8, observed: null }).kind).toBe('unknown')
    expect(placementVerdict({ memoryClass: 'cpu', ramMb: 16_000, vramMb: null, sizeOnDiskGb: 0, observed: null }).kind).toBe('unknown')
  })
})

// ---- Free/compute attribution to the SELECTED device (PR #303 audit DR2) ----

describe('attributedGpuFigures', () => {
  const iris = { label: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16_384, freeMb: 15_000, computeMb: 300 }
  const rtx = { label: 'Vulkan1', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_822, freeMb: 2703, computeMb: 2860 }
  const record = (over: Partial<ModelPlacement> = {}): ModelPlacement => ({
    modelId: 'm', contextTokens: 8192, backend: 'gpu', gpuLayers: 62, totalLayers: 66,
    gpuModelMb: 17_600, cpuModelMb: 1750, gpuKvMb: 512, cpuKvMb: null, metalMaxWorkingSetMb: null,
    // The legacy summary fields: the FIRST row's free figure, the compute summed over both.
    gpuFreeAtStartMb: 15_000, gpuComputeMb: 3160,
    machineKey: null, at: '2026-09-05T00:00:00Z', ...over
  })

  it('a record without rows (persisted before they existed) attributes as it always did', () => {
    expect(attributedGpuFigures(record(), 'NVIDIA GeForce RTX 3090')).toEqual({ freeAtStartMb: 15_000, workingMb: 3160 })
    expect(attributedGpuFigures(record({ gpuFreeAtStartMb: null }), null)).toEqual({ freeAtStartMb: null, workingMb: 3160 })
  })

  it('a lone device attributes as before, whatever it is called', () => {
    const lone = record({ devices: [{ ...rtx }], gpuFreeAtStartMb: 2703, gpuComputeMb: 2860 })
    expect(attributedGpuFigures(lone, 'NVIDIA GeForce RTX 3090')).toEqual({ freeAtStartMb: 2703, workingMb: 2860 })
    expect(attributedGpuFigures(lone, 'some other name')).toEqual({ freeAtStartMb: 2703, workingMb: 2860 })
  })

  it('several rows: the selected device by NAME — never the first row', () => {
    const hybrid = record({ devices: [iris, rtx] })
    expect(attributedGpuFigures(hybrid, 'NVIDIA GeForce RTX 3090')).toEqual({ freeAtStartMb: 2703, workingMb: 2860 })
    expect(attributedGpuFigures(hybrid, 'Intel(R) Iris(R) Xe Graphics')).toEqual({ freeAtStartMb: 15_000, workingMb: 300 })
  })

  it('several rows and the selected device absent from the log, or none selected: null, not a guess', () => {
    const hybrid = record({ devices: [iris, rtx] })
    expect(attributedGpuFigures(hybrid, 'NVIDIA GeForce RTX 3080 Ti')).toEqual({ freeAtStartMb: null, workingMb: null })
    expect(attributedGpuFigures(hybrid, null)).toEqual({ freeAtStartMb: null, workingMb: null })
  })

  it('placementVerdict carries the attributed figures (the renderer explains a spill with them)', () => {
    const observed = record({ devices: [iris, rtx] })
    const byName = placementVerdict({ memoryClass: 'discrete', ramMb: 16_077, vramMb: 24_822, sizeOnDiskGb: 18.4, observed, gpuName: 'NVIDIA GeForce RTX 3090' })
    expect(byName).toMatchObject({ kind: 'partial', freeAtStartMb: 2703, workingMb: 2860, spillMb: 1750 })
    const unnamed = placementVerdict({ memoryClass: 'discrete', ramMb: 16_077, vramMb: 24_822, sizeOnDiskGb: 18.4, observed })
    expect(unnamed).toMatchObject({ kind: 'partial', freeAtStartMb: null, workingMb: null })
  })
})

// ---- "Everything loaded at once" against the processor (PR #303 audit DR5, owner ruling) ----

describe('loadedAtOnceMb', () => {
  const row = (over: Partial<ResidentModelRow>): ResidentModelRow => ({
    role: 'vision', modelId: 'm', sizeOnDiskGb: 1, device: 'cpu', loaded: false, lifetime: 'idle',
    gpuLayers: null, totalLayers: null, ...over
  })
  /** A card machine: chat and translation on the card, the translation live with 20 of 49 layers offloaded. */
  const rows: ResidentModelRow[] = [
    row({ role: 'chat', modelId: 'chat', sizeOnDiskGb: 5.4, device: 'gpu', loaded: true, lifetime: 'session' }),
    row({ role: 'translation', modelId: 'tr', sizeOnDiskGb: 6.8, device: 'gpu', loaded: true, gpuLayers: 20, totalLayers: 49 }),
    row({ role: 'vision', sizeOnDiskGb: 3.0 }),
    row({ role: 'reranker', sizeOnDiskGb: 1.1, lifetime: 'session' }),
    row({ role: 'embeddings', sizeOnDiskGb: 0.2, lifetime: 'session' }),
    row({ role: 'transcriber', sizeOnDiskGb: 0.5, lifetime: 'per-use' })
  ]
  const estimate: PlacementVerdict = { kind: 'gpu', needMb: 5530, estimated: true, budgetMb: 24_576, freeAtStartMb: null, workingMb: null, spillMb: null, gpuLayers: null, totalLayers: null }
  const withTranslation = (over: Partial<ResidentModelRow>): ResidentModelRow[] => rows.map((r) => (r.role === 'translation' ? { ...r, ...over } : r))
  const pinnedMb = (3.0 + 1.1 + 0.2 + 0.5) * 1024
  const translationSpillMb = 6.8 * 1024 * (1 - 20 / 49)
  const everythingMb = Math.round((5.4 + 6.8 + 3.0 + 1.1 + 0.2 + 0.5) * 1024)

  it('cpu class: every row runs from RAM — the plain sum', () => {
    const cpuRows = rows.map((r) => ({ ...r, device: 'cpu' as const }))
    expect(loadedAtOnceMb({ memoryClass: 'cpu', rows: cpuRows, verdict: { ...estimate, kind: 'cpu', budgetMb: 16_384 } })).toBe(everythingMb)
  })

  it('discrete: the processor rows plus the live translation spill from its split; the card-resident weights are not counted', () => {
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows, verdict: estimate })).toBe(Math.round(pinnedMb + translationSpillMb))
  })

  it('discrete: a not-live or all-on-card translation contributes 0, and so does one without a reported split', () => {
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: withTranslation({ loaded: false, gpuLayers: null, totalLayers: null }), verdict: estimate })).toBe(Math.round(pinnedMb))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: withTranslation({ gpuLayers: 49, totalLayers: 49 }), verdict: estimate })).toBe(Math.round(pinnedMb))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: withTranslation({ gpuLayers: null, totalLayers: null }), verdict: estimate })).toBe(Math.round(pinnedMb))
  })

  it('discrete: the chat adds its OBSERVED partial-offload spill; an estimate, a full offload or an unknown split add 0', () => {
    const quiet = withTranslation({ loaded: false, gpuLayers: null, totalLayers: null })
    const observedPartial: PlacementVerdict = { ...estimate, kind: 'partial', estimated: false, needMb: 19_862, spillMb: 2100, gpuLayers: 62, totalLayers: 66 }
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: observedPartial })).toBe(Math.round(pinnedMb + 2100))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: { ...observedPartial, estimated: true } })).toBe(Math.round(pinnedMb))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: { ...estimate, estimated: false, kind: 'gpu' } })).toBe(Math.round(pinnedMb))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: { ...estimate, estimated: false, kind: 'unknown' } })).toBe(Math.round(pinnedMb))
  })

  it('discrete: a chat or translation row that says cpu (by configuration or observation) counts in full', () => {
    const chatOnCpu = rows.map((r) => (r.role === 'chat' ? { ...r, device: 'cpu' as const } : r))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: chatOnCpu, verdict: { ...estimate, kind: 'cpu' } })).toBe(Math.round(pinnedMb + 5.4 * 1024 + translationSpillMb))
    const bothOnCpu = rows.map((r) => ({ ...r, device: 'cpu' as const }))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: bothOnCpu, verdict: { ...estimate, kind: 'cpu' } })).toBe(everythingMb)
  })

  it('unified: one pool — the full sum, whatever the rows say', () => {
    expect(loadedAtOnceMb({ memoryClass: 'unified', rows, verdict: { ...estimate, budgetMb: 36_864 } })).toBe(everythingMb)
  })

  it('null when no row has a size', () => {
    expect(loadedAtOnceMb({ memoryClass: 'cpu', rows: [row({ role: 'chat', modelId: null, sizeOnDiskGb: null })], verdict: estimate })).toBeNull()
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: [], verdict: estimate })).toBeNull()
  })
})
