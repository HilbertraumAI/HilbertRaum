import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  attributedGpuFigures,
  findMachine,
  latestAnswerSpeed,
  loadedAtOnceMb,
  machineKey,
  memoryBudgetMb,
  nextStartMemory,
  otherMachines,
  placementVerdict,
  recordAnswerSpeed,
  resetPerformanceForTests,
  upsertHistory
} from '../../src/main/services/performance'
import { join } from 'node:path'
import { discoverManifests, fitsGraphicsMemory, weightsMib } from '../../src/main/services/models'
import type { ModelManifest } from '../../src/shared/manifest'
import {
  MAX_BENCHMARK_HISTORY,
  type BenchmarkResult,
  type GpuDevice,
  type ModelPlacement,
  type PlacementVerdict,
  type ResidentModelRow
} from '../../src/shared/types'

const MANIFESTS = join(__dirname, '..', '..', '..', '..', 'model-manifests')

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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is empty until the first finished answer, then holds the latest with model + time', () => {
    expect(latestAnswerSpeed()).toBeNull()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-05T09:00:00Z'))
    recordAnswerSpeed({ messageId: 'a1', tokensPerSecond: 11.8, ttftMs: 900, tokens: 312 }, 'qwen')
    expect(latestAnswerSpeed()).toEqual({
      tokensPerSecond: 11.8,
      ttftMs: 900,
      tokens: 312,
      modelId: 'qwen',
      at: '2026-09-05T09:00:00.000Z'
    })
    recordAnswerSpeed({ messageId: 'a2', tokensPerSecond: 3, ttftMs: 2000, tokens: 10 }, null)
    expect(latestAnswerSpeed()?.tokensPerSecond).toBe(3)
  })
})

// ---- "Your model" (benchmark.md): memory class, budget, verdict ----

const RTX = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_576, freeMb: 20_000 }

describe('memoryBudgetMb', () => {
  it('budgets: VRAM for discrete, Metal working set (else 75% of RAM) for unified, RAM for cpu', () => {
    expect(memoryBudgetMb('discrete', 16_000, 24_576, null)).toBe(24_576)
    expect(memoryBudgetMb('unified', 49_152, null, null)).toBe(36_864)
    const withMetal = { metalMaxWorkingSetMb: 40_000 } as ModelPlacement
    expect(memoryBudgetMb('unified', 49_152, null, withMetal)).toBe(40_000)
    expect(memoryBudgetMb('cpu', 16_000, null, null)).toBe(16_000)
  })
})

// ---- The budget device and the next start's class (PR #308 audit, decisions 6 and 9) ----
// Which device is the budget device (the largest usable card, the 5 GiB gate, integrated names) is
// `primaryUsefulDevice` / `isUsefulDevice`, owned by gpu-rules.test.ts. This suite owns the class:
// the GPU flags, and Apple Silicon (the only test of its branch; CI never runs on a Mac).

// A hybrid laptop as the pinned b9849 Vulkan build lists it: the Arrow-Lake iGPU FIRST, with
// 11.3 GiB of shared RAM as its "total", the RTX 5060 second (the audit's R6 reproduction).
const ARL: GpuDevice = { id: 'Vulkan0', name: 'Intel(R) Graphics (ARL)', totalMb: 11577, freeMb: 8251 }
const RTX5060: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 5060', totalMb: 8151, freeMb: 7573 }
const CARD8: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3070', totalMb: 8192, freeMb: 8000 }

describe('nextStartMemory', () => {
  const win = { platform: 'win32', arch: 'x64', gpuMode: 'auto' as const, gpuAutoDisabled: false }

  it('discrete with the budget device when a usable card is listed, cpu with no device otherwise', () => {
    expect(nextStartMemory({ ...win, devices: [ARL, RTX5060] })).toEqual({ memoryClass: 'discrete', device: RTX5060, cpuForced: false })
    expect(nextStartMemory({ ...win, devices: [RTX5060, ARL] })).toEqual({ memoryClass: 'discrete', device: RTX5060, cpuForced: false })
    // No usable card is `cpu` but NOT forced: the ladder may still put layers on the iGPU under 'auto'.
    expect(nextStartMemory({ ...win, devices: [ARL] })).toEqual({ memoryClass: 'cpu', device: null, cpuForced: false })
    expect(nextStartMemory({ ...win, devices: [] })).toEqual({ memoryClass: 'cpu', device: null, cpuForced: false })
  })

  it('GPU off in Settings, or auto-disabled after a crash, makes the next start cpu even with a card present', () => {
    // …and says so (`cpuForced`): the ladder skips every GPU rung, so no GPU observation can repeat.
    expect(nextStartMemory({ ...win, devices: [CARD8], gpuMode: 'off' })).toEqual({ memoryClass: 'cpu', device: null, cpuForced: true })
    expect(nextStartMemory({ ...win, devices: [CARD8], gpuAutoDisabled: true })).toEqual({ memoryClass: 'cpu', device: null, cpuForced: true })
  })

  it('Apple Silicon is unified regardless of the probe or the flags, naming the Metal pool device', () => {
    const m2 = { id: 'Metal0', name: 'Apple M2 Pro', totalMb: 21845, freeMb: 20000 }
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'arm64', devices: [m2] })).toEqual({ memoryClass: 'unified', device: m2, cpuForced: false })
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'arm64', devices: [] })).toEqual({ memoryClass: 'unified', device: null, cpuForced: false })
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'arm64', devices: [m2], gpuMode: 'off' }).memoryClass).toBe('unified')
    // An Intel Mac is not unified memory.
    expect(nextStartMemory({ ...win, platform: 'darwin', arch: 'x64', devices: [] }).memoryClass).toBe('cpu')
  })

})

describe('placementVerdict', () => {
  const observed = (over: Partial<ModelPlacement> = {}): ModelPlacement => ({
    modelId: 'm', contextTokens: 8192, backend: 'gpu', gpuLayers: 41, totalLayers: 41,
    gpuModelMb: 5500, cpuModelMb: 400, gpuKvMb: 640, cpuKvMb: null, metalMaxWorkingSetMb: null,
    machineKey: null, at: '2026-09-05T00:00:00Z', ...over
  })
  // The unified / cpu branches and the observed reading never look at the card inputs.
  const noCard = { graphicsBudgetMb: null, manifest: null }
  /** A synthetic manifest (decimal GB on disk, an optional cache term) and the unrounded GiB the caller passes with it. */
  const model = (sizeOnDiskGb: number, cacheGib?: number): { manifest: ModelManifest; sizeOnDiskGb: number } => {
    const manifest = { id: `m-${sizeOnDiskGb}`, sizeOnDiskGb, ...(cacheGib != null ? { estimatedContextCacheGib: cacheGib } : {}) } as ModelManifest
    return { manifest, sizeOnDiskGb: weightsMib(manifest) / 1024 }
  }

  it('reads an observed start off the log: all layers on the GPU, size = weights + cache', () => {
    const v = placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 5.8, ...noCard, observed: observed() })
    expect(v).toMatchObject({ kind: 'gpu', needMb: 6540, estimated: false, budgetMb: 24_576, gpuLayers: 41, totalLayers: 41 })
  })

  it('a partial offload is named with the CPU-side bytes as the spill; a CPU backend is cpu', () => {
    const partial = placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 8192, sizeOnDiskGb: 5.8, ...noCard, observed: observed({ gpuLayers: 30, cpuModelMb: 1900, cpuKvMb: 200 }) })
    expect(partial).toMatchObject({ kind: 'partial', spillMb: 2100, gpuLayers: 30, totalLayers: 41 })
    const cpu = placementVerdict({ memoryClass: 'cpu', ramMb: 16_000, vramMb: null, sizeOnDiskGb: 5.8, ...noCard, observed: observed({ backend: 'cpu', gpuLayers: null, totalLayers: null }) })
    expect(cpu.kind).toBe('cpu')
  })

  it('counts the recurrent-state buffers in the need, and the CPU-side one in the spill (#329)', () => {
    // A hybrid Gated-DeltaNet model allocates a per-sequence RS buffer beside the KV cache
    // (`llama_memory_recurrent: … RS buffer size`), and the ESTIMATE side has always counted it
    // (`estimatedContextCacheGib` = "KV + recurrent state"), so the OBSERVED figure was the low
    // one. The numbers are the REAL 20/33 start in
    // `tests/fixtures/placement-b9849-partial-20of33-hybrid.txt`.
    const args = { memoryClass: 'discrete' as const, ramMb: 14_188, vramMb: 5994, sizeOnDiskGb: 5.8, ...noCard }
    const real = { gpuLayers: 20, totalLayers: 33, gpuModelMb: 3393.11, cpuModelMb: 2286.14, gpuKvMb: 160, cpuKvMb: 96 }
    // Without the RS pair: 3393.11 + 2286.14 + 160 + 96 = 5935.25; the spill 2286.14 + 96.
    const without = placementVerdict({ ...args, observed: observed(real) })
    expect(without).toMatchObject({ kind: 'partial', needMb: 5935, spillMb: 2382 })
    // With it: + 29.31 on the card and + 20.94 on the CPU side, the latter part of the spill.
    const withRs = placementVerdict({ ...args, observed: observed({ ...real, gpuRsMb: 29.31, cpuRsMb: 20.94 }) })
    expect(withRs).toMatchObject({ kind: 'partial', needMb: 5986, spillMb: 2403 })
  })

  it('an EMPTY reading is unknown on a gpu backend and cpu on a cpu backend, never a measured "On GPU"', () => {
    // Every figure null (a build logging below verbosity 4, or stderr the parser never saw):
    // the record proves a start happened, not that the model reached the card.
    const empty = observed({
      gpuLayers: null, totalLayers: null, gpuModelMb: null, cpuModelMb: null,
      gpuKvMb: null, cpuKvMb: null, metalMaxWorkingSetMb: null
    })
    const gpu = placementVerdict({ memoryClass: 'discrete', ramMb: 16_384, vramMb: 24_576, sizeOnDiskGb: 5.8, ...noCard, observed: empty })
    expect(gpu.kind).not.toBe('gpu')
    expect(gpu).toMatchObject({ kind: 'unknown', estimated: false, needMb: null, spillMb: null, gpuLayers: null, totalLayers: null })
    // Half a reading (only one of the two counts printed) is unknown too, never a split.
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 19.8, ...noCard, observed: observed({ totalLayers: null }) }).kind).toBe('unknown')
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, sizeOnDiskGb: 19.8, ...noCard, observed: observed({ gpuLayers: null }) }).kind).toBe('unknown')
    // The same empty reading on a CPU backend IS the answer: the backend alone settles it.
    const cpu = placementVerdict({ memoryClass: 'cpu', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 5.8, ...noCard, observed: { ...empty, backend: 'cpu' } })
    expect(cpu).toMatchObject({ kind: 'cpu', estimated: false, needMb: null, spillMb: null })
  })

  it('estimates from the weights before the first start: the picker\'s fit on a card, headroom on unified / cpu', () => {
    // Discrete (PR #308 audit decision 8): the picker's own need — offloadable weights × 1.15 + the
    // cache term + the 1 GiB margin — against the picker's BUDGET (free, else total − 1024), never
    // the weights against 92 % of the total. A 5.8 GB model (5,531 MiB; need 7,897 with the default
    // cache) on a 24 GiB card with 23,552 free fits; `needMb` stays the weights alone.
    const small = model(5.8)
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 16_384, vramMb: 24_576, graphicsBudgetMb: 23_552, ...small, observed: null }))
      .toMatchObject({ kind: 'gpu', needMb: 5531, estimated: true, budgetMb: 24_576 })
    // 19.8 GB (18,883 MiB; need 23,251) on a 16 GiB card with 15,360 free: partial, the estimated
    // need over the budget spills to RAM.
    const big = model(19.8)
    const spill = placementVerdict({ memoryClass: 'discrete', ramMb: 32_768, vramMb: 16_384, graphicsBudgetMb: 15_360, ...big, observed: null })
    expect(spill).toMatchObject({ kind: 'partial', needMb: 18_883, spillMb: 7891 })
    // The spill is never more than the weights themselves (a card with almost nothing free).
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 32_768, vramMb: 16_384, graphicsBudgetMb: 1024, ...big, observed: null }).spillMb).toBe(18_883)
    // The same on a 4 GB box: RAM + VRAM cannot take the weights.
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 4096, vramMb: 16_384, graphicsBudgetMb: 15_360, ...big, observed: null }).kind).toBe('too_large')
    // The card's free figure decides, not its total: the same 8 GiB card holds a 6.0 GB model
    // carrying a 0.4 GiB cache term (need 8,014) at 8,100 free and not at 8,000. Both the cache
    // term and the host-mapped share are supplied here, not read from a manifest, so this boundary
    // is independent of the catalog — the real 9B carries 0.3 since `-np 1` (#319) and 545.62 MiB
    // of host-mapped weights since #321, and needs 7,830.
    const nineB = model(6.0, 0.4)
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 32_768, vramMb: 8192, graphicsBudgetMb: 8100, ...nineB, observed: null }).kind).toBe('gpu')
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 32_768, vramMb: 8192, graphicsBudgetMb: 8000, ...nineB, observed: null }).kind).toBe('partial')
    // Unified: the 75% budget decides (unchanged).
    expect(placementVerdict({ memoryClass: 'unified', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 5.8, ...noCard, observed: null }).kind).toBe('gpu')
    expect(placementVerdict({ memoryClass: 'unified', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 12, ...noCard, observed: null }).kind).toBe('too_large')
    // CPU: RAM decides (unchanged).
    expect(placementVerdict({ memoryClass: 'cpu', ramMb: 16_384, vramMb: null, sizeOnDiskGb: 5.8, ...noCard, observed: null }).kind).toBe('cpu')
    expect(placementVerdict({ memoryClass: 'cpu', ramMb: 8192, vramMb: null, sizeOnDiskGb: 9, ...noCard, observed: null }).kind).toBe('too_large')
  })

  it('is unknown without a size or a budget, and on a card without a catalog entry or a card budget', () => {
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: null, vramMb: null, sizeOnDiskGb: 5.8, ...noCard, observed: null }).kind).toBe('unknown')
    expect(placementVerdict({ memoryClass: 'cpu', ramMb: 16_000, vramMb: null, sizeOnDiskGb: 0, ...noCard, observed: null }).kind).toBe('unknown')
    // A model outside the catalog has no cache term; a card without the picker's budget has
    // nothing to fit against. Neither becomes a guess.
    const v = placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, graphicsBudgetMb: 23_552, sizeOnDiskGb: 5.4, manifest: null, observed: null })
    expect(v).toMatchObject({ kind: 'unknown', needMb: 5530, estimated: true })
    expect(placementVerdict({ memoryClass: 'discrete', ramMb: 16_000, vramMb: 24_576, graphicsBudgetMb: null, ...model(5.8), observed: null }).kind).toBe('unknown')
  })

  describe('the discrete pre-start estimate IS the picker\'s fit (PR #308 audit §4.1 / A9 inverted)', () => {
    const catalog = discoverManifests(MANIFESTS).manifests.map((m) => m.manifest).filter((m) => m.role === 'chat')
    const byId = (id: string): ModelManifest => {
      const m = catalog.find((x) => x.id === id)
      if (!m) throw new Error(`missing manifest ${id}`)
      return m
    }
    /** A card of `gib` nominal GiB with the total − 1,024 budget convention (idle desktop use; the same figure `graphicsBudgetMib` falls back to without a free figure). */
    const card = (gib: number): { vramMb: number; graphicsBudgetMb: number } => ({ vramMb: gib * 1024, graphicsBudgetMb: gib * 1024 - 1024 })
    const estimate = (m: ModelManifest, gib: number, sizeOnDiskGb = weightsMib(m) / 1024) =>
      placementVerdict({ memoryClass: 'discrete', ramMb: 64 * 1024, ...card(gib), sizeOnDiskGb, manifest: m, observed: null })

    it.each([
      ['gemma4-12b-it-qat-q4', 8],
      ['gemma4-26b-a4b-it-qat-q4', 16],
      ['qwen3.6-27b-q5', 20],
      ['qwen3.5-35b-a3b-ud-q4kxl', 24]
    ])('%s on a %i GiB card: the old estimate said "gpu", the picker says no fit — the row now agrees (partial)', (id, gib) => {
      const m = byId(id)
      const v = estimate(m, gib)
      const { vramMb, graphicsBudgetMb } = card(gib)
      // The defect the audit tabulated: the weights alone sit under 92 % of the total…
      expect(v.needMb).not.toBeNull()
      expect(v.needMb as number).toBeLessThanOrEqual(vramMb * 0.92)
      // …but the picker's need does not fit the budget, so the row must not promise a full offload.
      expect(fitsGraphicsMemory(m, graphicsBudgetMb)).toBe(false)
      expect(v.kind).not.toBe('gpu')
      expect(v).toMatchObject({ kind: 'partial', estimated: true, budgetMb: vramMb })
      expect(v.spillMb).toBeGreaterThan(0)
    })

    it('128-MiB sweep over the catalog: "gpu" iff the picker fits, and the one-decimal GiB rounding flips nothing', () => {
      const gibRounded = (m: ModelManifest): number => Math.round((weightsMib(m) / 1024) * 10) / 10
      const flips: string[] = []
      const disagreements: string[] = []
      let fits = 0
      let points = 0
      for (const m of catalog) {
        for (let mb = 4096; mb <= 32_768; mb += 128) {
          points++
          const input = { memoryClass: 'discrete' as const, ramMb: 64 * 1024, vramMb: mb, graphicsBudgetMb: mb - 1024, manifest: m, observed: null }
          const exact = placementVerdict({ ...input, sizeOnDiskGb: weightsMib(m) / 1024 }).kind
          const rounded = placementVerdict({ ...input, sizeOnDiskGb: gibRounded(m) }).kind
          if (exact !== rounded) flips.push(`${m.id}@${mb}: ${rounded} vs ${exact}`)
          const pickerFits = fitsGraphicsMemory(m, mb - 1024)
          if ((exact === 'gpu') !== pickerFits) disagreements.push(`${m.id}@${mb}: verdict ${exact}, picker ${pickerFits}`)
          if (pickerFits) fits++
        }
      }
      expect(flips).toEqual([])
      expect(disagreements).toEqual([])
      // Sanity: the sweep covers real fits and real misses, not one degenerate side.
      expect(fits).toBeGreaterThan(0)
      expect(fits).toBeLessThan(points)
    })

    it('an OBSERVED start wins over the estimate: Gemma 12B fully offloaded on an 8 GiB card reads "gpu", measured', () => {
      const m = byId('gemma4-12b-it-qat-q4')
      const v = placementVerdict({
        memoryClass: 'discrete', ramMb: 64 * 1024, ...card(8), sizeOnDiskGb: weightsMib(m) / 1024, manifest: m,
        observed: observed({ modelId: m.id, gpuLayers: 49, totalLayers: 49, gpuModelMb: 6500, cpuModelMb: 180, gpuKvMb: 900 })
      })
      expect(v).toMatchObject({ kind: 'gpu', estimated: false, needMb: 7580, gpuLayers: 49, totalLayers: 49 })
      expect(estimate(m, 8).kind).toBe('partial')
    })
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

  it('a lone row that IS the selected device: its own figures, not the legacy summary (A-D3)', () => {
    // The summary fields deliberately differ from the row's, so the assertion knows which answered.
    const lone = record({ devices: [{ ...rtx }], gpuFreeAtStartMb: 15_000, gpuComputeMb: 3160 })
    expect(attributedGpuFigures(lone, 'NVIDIA GeForce RTX 3090')).toEqual({ freeAtStartMb: 2703, workingMb: 2860 })
  })

  it('a lone row that is NOT the selected device (an iGPU-only log beside a selected dGPU), or none selected: null (A-D3)', () => {
    const igpuOnly = record({ devices: [{ ...iris }], gpuFreeAtStartMb: 15_000, gpuComputeMb: 300 })
    expect(attributedGpuFigures(igpuOnly, 'NVIDIA GeForce RTX 3090')).toEqual({ freeAtStartMb: null, workingMb: null })
    expect(attributedGpuFigures(igpuOnly, null)).toEqual({ freeAtStartMb: null, workingMb: null })
    // Rows present but empty (a log without a device_info block): nothing to attribute either.
    expect(attributedGpuFigures(record({ devices: [], gpuFreeAtStartMb: null }), 'NVIDIA GeForce RTX 3090')).toEqual({ freeAtStartMb: null, workingMb: null })
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
    // Observed: the budget/manifest inputs of the pre-start estimate are not read.
    const byName = placementVerdict({ memoryClass: 'discrete', ramMb: 16_077, vramMb: 24_822, graphicsBudgetMb: null, manifest: null, sizeOnDiskGb: 18.4, observed, gpuName: 'NVIDIA GeForce RTX 3090' })
    expect(byName).toMatchObject({ kind: 'partial', freeAtStartMb: 2703, workingMb: 2860, spillMb: 1750 })
    const unnamed = placementVerdict({ memoryClass: 'discrete', ramMb: 16_077, vramMb: 24_822, graphicsBudgetMb: null, manifest: null, sizeOnDiskGb: 18.4, observed })
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
  // The figures below, as literals: every row 17.0 GiB = 17,408 MiB; the pinned rows 3.0 + 1.1 + 0.2 + 0.5 GiB
  // = 4,915.2 MiB; the chat 5.4 GiB = 5,529.6 MiB; the translation spill 6.8 GiB × 29/49 = 4,121.1 MiB.

  it('cpu class: every row runs from RAM — the plain sum', () => {
    const cpuRows = rows.map((r) => ({ ...r, device: 'cpu' as const }))
    expect(loadedAtOnceMb({ memoryClass: 'cpu', rows: cpuRows, verdict: { ...estimate, kind: 'cpu', budgetMb: 16_384 } })).toBe(17408)
  })

  it('discrete: the processor rows plus the live translation spill from its split; the card-resident weights are not counted', () => {
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows, verdict: estimate })).toBe(9036)
  })

  it('discrete: a not-live or all-on-card translation contributes 0, and so does one without a reported split', () => {
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: withTranslation({ loaded: false, gpuLayers: null, totalLayers: null }), verdict: estimate })).toBe(4915)
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: withTranslation({ gpuLayers: 49, totalLayers: 49 }), verdict: estimate })).toBe(4915)
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: withTranslation({ gpuLayers: null, totalLayers: null }), verdict: estimate })).toBe(4915)
  })

  it('discrete: the chat adds its OBSERVED partial-offload spill; an estimate, a full offload or an unknown split add 0', () => {
    const quiet = withTranslation({ loaded: false, gpuLayers: null, totalLayers: null })
    const observedPartial: PlacementVerdict = { ...estimate, kind: 'partial', estimated: false, needMb: 19_862, spillMb: 2100, gpuLayers: 62, totalLayers: 66 }
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: observedPartial })).toBe(7015)
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: { ...observedPartial, estimated: true } })).toBe(4915)
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: { ...estimate, estimated: false, kind: 'gpu' } })).toBe(4915)
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: quiet, verdict: { ...estimate, estimated: false, kind: 'unknown' } })).toBe(4915)
  })

  it('discrete: a chat or translation row that says cpu (by configuration or observation) counts in full', () => {
    const chatOnCpu = rows.map((r) => (r.role === 'chat' ? { ...r, device: 'cpu' as const } : r))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: chatOnCpu, verdict: { ...estimate, kind: 'cpu' } })).toBe(14566)
    const bothOnCpu = rows.map((r) => ({ ...r, device: 'cpu' as const }))
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: bothOnCpu, verdict: { ...estimate, kind: 'cpu' } })).toBe(17408)
  })

  it('unified: one pool — the full sum, whatever the rows say', () => {
    expect(loadedAtOnceMb({ memoryClass: 'unified', rows, verdict: { ...estimate, budgetMb: 36_864 } })).toBe(17408)
  })

  // Wave 8 ruling (d)/NF-3 (step 4-8): a `'gpu'`-posture reranker row is no longer counted
  // against the processor's memory on `discrete` — its own headroom gate only ever resolves
  // `'gpu'` when the WHOLE placement fits with margin, and no partial-offload split is tracked
  // for it the way chat/translation report one, so it contributes 0 (matching a chat/translation
  // row with no measured spill), never its full size.
  it('discrete: a gpu-posture reranker row contributes 0, not its full size', () => {
    const rerankerOnGpu = rows.map((r) => (r.role === 'reranker' ? { ...r, device: 'gpu' as const } : r))
    // The pinned rows without the reranker's 1.1 GiB: 3.0 + 0.2 + 0.5 GiB = 3,788.8 MiB, plus the spill.
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: rerankerOnGpu, verdict: estimate })).toBe(7910)
  })

  it('null when no row has a size', () => {
    expect(loadedAtOnceMb({ memoryClass: 'cpu', rows: [row({ role: 'chat', modelId: null, sizeOnDiskGb: null })], verdict: estimate })).toBeNull()
    expect(loadedAtOnceMb({ memoryClass: 'discrete', rows: [], verdict: estimate })).toBeNull()
  })
})
