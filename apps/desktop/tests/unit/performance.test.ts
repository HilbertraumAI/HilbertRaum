import { describe, it, expect, beforeEach } from 'vitest'
import {
  findMachine,
  latestAnswerSpeed,
  machineKey,
  otherMachines,
  recordAnswerSpeed,
  resetPerformanceForTests,
  upsertHistory
} from '../../src/main/services/performance'
import { MAX_BENCHMARK_HISTORY, type BenchmarkResult } from '../../src/shared/types'

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
