import { describe, it, expect } from 'vitest'
import {
  backfillOutgoing,
  effectiveReadPatch,
  eligiblePersistedSample,
  historyEquals,
  mergeSampleIntoResult,
  sampleEligible
} from '../../src/main/services/benchmark-persistence'
import { machineKey } from '../../src/main/services/performance'
import { t } from '../../src/shared/i18n'
import { MAX_BENCHMARK_HISTORY, type BenchmarkResult, type EffectiveReadSample } from '../../src/shared/types'

// The pure persistence rules for a travelling drive (benchmark.md "Persistence" / "History
// per machine"; PR #303 audit M2/M4/M6/L2): identity before ranking (G3 for unknown keys),
// the upgrade backfill with its cap/eviction rules, the sample merge, and the per-destination
// patch the read-speed observer writes.

function result(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    os: 'linux',
    arch: 'x64',
    cpuModel: 'Intel Core i7-1260P',
    cpuCores: 12,
    ramGb: 16,
    gpu: null,
    driveReadMbps: null,
    driveWriteMbps: 300,
    tokensPerSecond: 12,
    measuredModelId: 'm',
    effectiveRead: null,
    profile: 'LITE',
    recommendedModelId: 'm',
    warnings: [],
    ranAt: '2026-09-04T14:02:00Z',
    ...over
  }
}
const sample = (over: Partial<EffectiveReadSample> = {}): EffectiveReadSample => ({
  mbps: 300,
  bytes: 3_000_000_000,
  ms: 10_000,
  source: 'model_load',
  modelId: 'm',
  at: '2026-09-01T00:00:00Z',
  ...over
})
const HERE = machineKey(result())!
const other = (n: number, over: Partial<BenchmarkResult> = {}): BenchmarkResult =>
  result({ cpuModel: `other-${n}`, ranAt: `2026-0${n}-01T00:00:00Z`, ...over })
const slow = (mbps: number): string => t('en', 'main.benchmark.warnSlowRead', { mbps })

describe('sampleEligible (G3)', () => {
  it('equal keys are eligible; known, unequal keys are foreign', () => {
    expect(sampleEligible(result(), HERE)).toBe(true)
    expect(sampleEligible(HERE, HERE)).toBe(true)
    expect(sampleEligible(other(1), HERE)).toBe(false)
    expect(sampleEligible('elsewhere', HERE)).toBe(false)
  })

  it('an unknown identity on EITHER side is eligible (compatibility, not provenance)', () => {
    expect(sampleEligible(result({ cpuModel: '' }), HERE)).toBe(true)
    expect(sampleEligible(null, HERE)).toBe(true)
    expect(sampleEligible(other(1), null)).toBe(true)
    expect(sampleEligible(null, null)).toBe(true)
  })
})

describe('eligiblePersistedSample', () => {
  it("a foreign lastBenchmark's sample is never a candidate; this machine's history entry is", () => {
    const foreign = other(1, { effectiveRead: sample({ modelId: 'foreign' }) })
    expect(eligiblePersistedSample({ lastBenchmark: foreign, benchmarkHistory: [foreign] }, HERE)).toBeNull()
    const mine = result({ effectiveRead: sample({ modelId: 'mine', source: 'checksum' }) })
    expect(
      eligiblePersistedSample({ lastBenchmark: foreign, benchmarkHistory: [foreign, mine] }, HERE)?.modelId
    ).toBe('mine')
  })

  it('ranks the eligible candidates: model_load beats checksum, else the newer sample', () => {
    const headline = result({ effectiveRead: sample({ modelId: 'head-checksum', source: 'checksum', at: '2026-09-02T00:00:00Z' }) })
    const older = result({ effectiveRead: sample({ modelId: 'hist-load', at: '2026-08-01T00:00:00Z' }) })
    expect(eligiblePersistedSample({ lastBenchmark: headline, benchmarkHistory: [older] }, HERE)?.modelId).toBe('hist-load')
    const newer = result({ effectiveRead: sample({ modelId: 'hist-newer', at: '2026-09-03T00:00:00Z' }) })
    const headLoad = result({ effectiveRead: sample({ modelId: 'head-load', at: '2026-09-02T00:00:00Z' }) })
    expect(eligiblePersistedSample({ lastBenchmark: headLoad, benchmarkHistory: [newer] }, HERE)?.modelId).toBe('hist-newer')
  })

  it('an unkeyed lastBenchmark is eligible; nothing at all is null', () => {
    const legacy = result({ cpuModel: '', effectiveRead: sample({ modelId: 'legacy' }) })
    expect(eligiblePersistedSample({ lastBenchmark: legacy, benchmarkHistory: [] }, HERE)?.modelId).toBe('legacy')
    expect(eligiblePersistedSample({ lastBenchmark: null, benchmarkHistory: [] }, HERE)).toBeNull()
  })
})

describe('backfillOutgoing', () => {
  it('files a keyed outgoing result at its ranAt position; an unkeyed one is never filed', () => {
    const history = [other(5), other(3)]
    expect(backfillOutgoing(history, other(4), HERE).map((e) => e.cpuModel)).toEqual(['other-5', 'other-4', 'other-3'])
    expect(backfillOutgoing(history, other(1), HERE).map((e) => e.cpuModel)).toEqual(['other-5', 'other-3', 'other-1'])
    expect(backfillOutgoing(history, other(7), HERE).map((e) => e.cpuModel)).toEqual(['other-7', 'other-5', 'other-3'])
    expect(historyEquals(backfillOutgoing(history, result({ cpuModel: '' }), HERE), history)).toBe(true)
    expect(historyEquals(backfillOutgoing(history, null, HERE), history)).toBe(true)
  })

  it('never overwrites a NEWER history observation with an older outgoing copy', () => {
    const newer = other(1, { ranAt: '2026-05-01T00:00:00Z' })
    const same = other(1, { effectiveRead: sample({ at: '2026-05-02T00:00:00Z' }) })
    expect(historyEquals(backfillOutgoing([newer], other(1), HERE), [newer])).toBe(true)
    expect(historyEquals(backfillOutgoing([same], other(1), HERE), [same])).toBe(true)
    // …but replaces an OLDER one (a stale copy beside a fresher headline).
    const fresher = other(1, { ranAt: '2026-06-01T00:00:00Z' })
    expect(backfillOutgoing([newer], fresher, HERE)[0]).toBe(fresher)
    const laterSample = other(1, { effectiveRead: sample({ at: '2026-05-03T00:00:00Z' }) })
    expect(backfillOutgoing([same], laterSample, HERE)[0]).toBe(laterSample)
  })

  it('at the cap evicts the oldest OTHER machine, never this one', () => {
    const mine = result({ ranAt: '2026-01-15T00:00:00Z' }) // the oldest entry of all
    const others = Array.from({ length: MAX_BENCHMARK_HISTORY - 1 }, (_, i) => other(i + 2))
    const history = [...others.reverse(), mine]
    expect(history).toHaveLength(MAX_BENCHMARK_HISTORY)
    const after = backfillOutgoing(history, other(9, { ranAt: '2026-09-09T00:00:00Z' }), HERE)
    expect(after).toHaveLength(MAX_BENCHMARK_HISTORY)
    expect(after.at(-1)).toBe(mine)
    expect(after.some((e) => e.cpuModel === 'other-2')).toBe(false)
    expect(after[0].cpuModel).toBe('other-9')
  })
})

describe('mergeSampleIntoResult', () => {
  it('sets the sample, re-keys only the slow-read warning, and leaves ranAt alone', () => {
    const tiny = t('en', 'main.benchmark.warnTiny')
    const base = result({ warnings: [tiny, slow(42)] })
    const merged = mergeSampleIntoResult(base, sample({ mbps: 70.4 }))
    expect(merged.effectiveRead?.mbps).toBe(70.4)
    expect(merged.warnings).toEqual([tiny, slow(70)])
    expect(merged.ranAt).toBe(base.ranAt)
    expect(mergeSampleIntoResult(base, sample({ mbps: 480 })).warnings).toEqual([tiny])
  })

  it('returns the same object for no sample or the sample it already carries', () => {
    const s = sample()
    const base = result({ effectiveRead: s })
    expect(mergeSampleIntoResult(base, null)).toBe(base)
    expect(mergeSampleIntoResult(base, { ...s })).toBe(base)
  })
})

describe('effectiveReadPatch', () => {
  it('null with no eligible destination; empty when every destination already carries it', () => {
    const s = sample()
    expect(effectiveReadPatch({ lastBenchmark: null, benchmarkHistory: [] }, s, HERE)).toBeNull()
    const foreign = other(1)
    expect(effectiveReadPatch({ lastBenchmark: foreign, benchmarkHistory: [foreign] }, s, HERE)).toBeNull()
    const mine = result({ effectiveRead: s })
    expect(effectiveReadPatch({ lastBenchmark: mine, benchmarkHistory: [mine] }, s, HERE)).toEqual({})
  })

  it('writes both destinations, or only the one that needs it (compared separately)', () => {
    const s = sample({ mbps: 70 })
    const mine = result()
    const untouched = other(1)
    const both = effectiveReadPatch({ lastBenchmark: mine, benchmarkHistory: [untouched, mine] }, s, HERE)!
    expect(both.lastBenchmark?.effectiveRead).toEqual(s)
    expect(both.lastBenchmark?.warnings).toEqual([slow(70)])
    expect(both.benchmarkHistory?.[1].effectiveRead).toEqual(s)
    // The other machine's entry keeps its identity — only the local entry is replaced.
    expect(both.benchmarkHistory?.[0]).toBe(untouched)

    // The headline already carries it, the history copy is stale → history only.
    const upToDate = result({ effectiveRead: s })
    const historyOnly = effectiveReadPatch({ lastBenchmark: upToDate, benchmarkHistory: [mine] }, s, HERE)!
    expect(historyOnly.lastBenchmark).toBeUndefined()
    expect(historyOnly.benchmarkHistory?.[0].effectiveRead).toEqual(s)

    // A foreign headline is never touched; the local history entry is.
    const foreign = other(1, { effectiveRead: sample({ modelId: 'foreign' }) })
    const local = effectiveReadPatch({ lastBenchmark: foreign, benchmarkHistory: [foreign, mine] }, s, HERE)!
    expect(local.lastBenchmark).toBeUndefined()
    expect(local.benchmarkHistory?.map((e) => e.effectiveRead?.modelId)).toEqual(['foreign', 'm'])
  })

  it('a destination whose model_load sample outranks a checksum keeps it', () => {
    const load = result({ effectiveRead: sample({ modelId: 'load' }) })
    const bare = result()
    const patch = effectiveReadPatch(
      { lastBenchmark: load, benchmarkHistory: [bare] },
      sample({ source: 'checksum', modelId: 'checksum', at: '2026-09-05T00:00:00Z' }),
      HERE
    )!
    expect(patch.lastBenchmark).toBeUndefined()
    expect(patch.benchmarkHistory?.[0].effectiveRead?.modelId).toBe('checksum')
  })
})
