import { describe, it, expect, beforeEach } from 'vitest'
import {
  findMachine,
  latestAnswerSpeed,
  machineKey,
  memoryBudgetMb,
  memoryClassOf,
  nextStartMemory,
  otherMachines,
  placementVerdict,
  recordAnswerSpeed,
  resetPerformanceForTests,
  selectBudgetDevice,
  upsertHistory
} from '../../src/main/services/performance'
import { GPU_BUMP_MIN_VRAM_MB } from '../../src/main/services/runtime/gpu'
import { MAX_BENCHMARK_HISTORY, type BenchmarkResult, type GpuDevice, type ModelPlacement } from '../../src/shared/types'

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
    const office = result({ cpuModel: 'i9-13900K', cpuCores: 32, ramGb: 64, ranAt: '2026-09-02T00:00:00Z' })
    const laptopOld = result({ ranAt: '2026-08-01T00:00:00Z', tokensPerSecond: 4 })
    const laptopNew = result({ ranAt: '2026-09-04T00:00:00Z', tokensPerSecond: 12 })
    const history = upsertHistory(upsertHistory([], laptopOld), office)
    expect(history.map((e) => e.ranAt)).toEqual([office.ranAt, laptopOld.ranAt])
    const next = upsertHistory(history, laptopNew)
    expect(next.map((e) => e.tokensPerSecond)).toEqual([12, null].map((v) => v ?? office.tokensPerSecond))
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(laptopNew)
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

// ---- The budget device and the next start's class (PR #308 audit, decisions 6 and 9) ----

// A hybrid laptop as the pinned b9849 Vulkan build lists it: the Arrow-Lake iGPU FIRST, with
// 11.3 GiB of shared RAM as its "total", the RTX 5060 second (the audit's R6 reproduction).
const ARL: GpuDevice = { id: 'Vulkan0', name: 'Intel(R) Graphics (ARL)', totalMb: 11577, freeMb: 8251 }
const RTX5060: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 5060', totalMb: 8151, freeMb: 7573 }
const SMALL: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce GTX 1650', totalMb: 4096, freeMb: 3900 }
const CARD8: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3070', totalMb: 8192, freeMb: 8000 }

describe('selectBudgetDevice', () => {
  it('picks the LARGEST usable card, never the first device the driver listed', () => {
    // Intel first (the real driver order) and NVIDIA first give the same answer.
    expect(selectBudgetDevice([ARL, RTX5060])).toBe(RTX5060)
    expect(selectBudgetDevice([RTX5060, ARL])).toBe(RTX5060)
    // Two discrete cards: the bigger one is the budget, whichever is listed first.
    expect(selectBudgetDevice([SMALL, CARD8])).toBe(CARD8)
    expect(selectBudgetDevice([CARD8, SMALL])).toBe(CARD8)
  })

  it('returns null for an integrated-only machine, an empty probe, or only sub-gate cards', () => {
    expect(selectBudgetDevice([ARL])).toBeNull()
    expect(selectBudgetDevice([IRIS])).toBeNull()
    expect(selectBudgetDevice([])).toBeNull()
    expect(selectBudgetDevice([SMALL])).toBeNull()
  })

  it('reuses the runtime\'s 6 GiB gate at its exact boundary (N8): 5,921 MiB is out, 6,144 is in', () => {
    expect(GPU_BUMP_MIN_VRAM_MB).toBe(6144)
    // What a 6 GB laptop card actually reports (the assumptions check's N8 figure).
    const laptop6 = { ...CARD8, name: 'NVIDIA GeForce RTX 3050 Laptop GPU', totalMb: 5921 }
    expect(selectBudgetDevice([laptop6])).toBeNull()
    const exactly = { ...laptop6, totalMb: 6144 }
    expect(selectBudgetDevice([exactly])).toBe(exactly)
  })
})

describe('nextStartMemory', () => {
  const win = { platform: 'win32', arch: 'x64', gpuMode: 'auto' as const, gpuAutoDisabled: false }

  it('discrete with the budget device when a usable card is listed, cpu with no device otherwise', () => {
    expect(nextStartMemory({ ...win, devices: [ARL, RTX5060] })).toEqual({ memoryClass: 'discrete', device: RTX5060 })
    expect(nextStartMemory({ ...win, devices: [RTX5060, ARL] })).toEqual({ memoryClass: 'discrete', device: RTX5060 })
    expect(nextStartMemory({ ...win, devices: [ARL] })).toEqual({ memoryClass: 'cpu', device: null })
    expect(nextStartMemory({ ...win, devices: [] })).toEqual({ memoryClass: 'cpu', device: null })
  })

  it('GPU off in Settings, or auto-disabled after a crash, makes the next start cpu even with a card present', () => {
    expect(nextStartMemory({ ...win, devices: [CARD8], gpuMode: 'off' })).toEqual({ memoryClass: 'cpu', device: null })
    expect(nextStartMemory({ ...win, devices: [CARD8], gpuAutoDisabled: true })).toEqual({ memoryClass: 'cpu', device: null })
  })

  it('Apple Silicon is unified regardless of the probe or the flags, naming the Metal pool device', () => {
    const m2 = { id: 'Metal0', name: 'Apple M2 Pro', totalMb: 21845, freeMb: 20000 }
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'arm64', devices: [m2] })).toEqual({ memoryClass: 'unified', device: m2 })
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'arm64', devices: [] })).toEqual({ memoryClass: 'unified', device: null })
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'arm64', devices: [m2], gpuMode: 'off' }).memoryClass).toBe('unified')
    // An Intel Mac is not unified memory.
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'x64', devices: [] }).memoryClass).toBe('cpu')
  })

  it('memoryClassOf is the flags-at-default wrapper: same class as nextStartMemory with GPU on', () => {
    for (const devices of [[ARL, RTX5060], [ARL], [CARD8], [], [IRIS]]) {
      expect(memoryClassOf('win32', 'x64', devices)).toBe(nextStartMemory({ ...win, devices }).memoryClass)
    }
    // …so the hybrid laptop is discrete by the RTX, and an integrated-only one is cpu.
    expect(memoryClassOf('linux', 'x64', [ARL, RTX5060])).toBe('discrete')
    expect(memoryClassOf('linux', 'x64', [ARL])).toBe('cpu')
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
