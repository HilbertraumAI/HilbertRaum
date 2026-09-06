import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  latestEffectiveRead,
  latestEffectiveReadBySource,
  MIN_MODEL_LOAD_SAMPLE_BYTES,
  MIN_READ_SAMPLE_BYTES,
  MIN_READ_SAMPLE_MS,
  preferCandidate,
  recordChecksumRead,
  recordModelLoadRead,
  resetEffectiveReadForTests,
  setEffectiveReadObserver,
  suppressNextModelLoadSample,
  throughputMbps
} from '../../src/main/services/read-speed'
import type { EffectiveReadSample } from '../../src/shared/types'

// #108: the honest effective-read latch. Policy under test: sample floors (tiny
// files/instant reads carry no throughput information; model_load additionally needs
// 2 GiB so parse/KV-alloc/graph-init fixed costs can't dominate the window), the source
// ranking (a checksum sample can be hash-CPU-bound on fast media, so it only ever fills
// absence and is replaced by model_load, never vice versa), the page-cache suppression
// (a start whose install-state pass just hashed the file must not sample the warm
// load), and the observer (persistence is a property of recording).

function sample(over: Partial<EffectiveReadSample> = {}): EffectiveReadSample {
  return {
    mbps: 100,
    bytes: 6_000_000_000,
    ms: 60_000,
    source: 'checksum',
    modelId: 'm',
    at: '2026-08-08T10:00:00Z',
    ...over
  }
}

describe('effective-read latch (#108)', () => {
  beforeEach(() => resetEffectiveReadForTests())

  it('throughputMbps: MB = 1e6 bytes, one decimal, null on unusable timing', () => {
    expect(throughputMbps(6_000_000_000, 60_000)).toBe(100)
    expect(throughputMbps(8 * 1024 * 1024, 100)).toBe(83.9)
    expect(throughputMbps(1, 0)).toBeNull()
    expect(throughputMbps(1, Number.NaN)).toBeNull()
  })

  it('records a checksum sample with the shared MB/s definition', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'model-a')
    const s = latestEffectiveRead()
    expect(s?.mbps).toBe(100)
    expect(s?.source).toBe('checksum')
    expect(s?.modelId).toBe('model-a')
    expect(Number.isNaN(Date.parse(s!.at))).toBe(false)
  })

  it('rejects samples below the byte and elapsed floors', () => {
    recordChecksumRead(MIN_READ_SAMPLE_BYTES - 1, 10_000, 'm')
    expect(latestEffectiveRead()).toBeNull()
    recordChecksumRead(MIN_READ_SAMPLE_BYTES, MIN_READ_SAMPLE_MS - 1, 'm')
    expect(latestEffectiveRead()).toBeNull()
    recordChecksumRead(MIN_READ_SAMPLE_BYTES, MIN_READ_SAMPLE_MS, 'm')
    expect(latestEffectiveRead()).not.toBeNull()
  })

  it('model_load samples additionally require the 2 GiB floor (init costs must not dominate)', () => {
    recordModelLoadRead('/ignored.gguf', 10_000, 'small', MIN_MODEL_LOAD_SAMPLE_BYTES - 1)
    expect(latestEffectiveRead()).toBeNull()
    recordModelLoadRead('/ignored.gguf', 10_000, 'big', MIN_MODEL_LOAD_SAMPLE_BYTES)
    expect(latestEffectiveRead()?.source).toBe('model_load')
  })

  it('a newer checksum sample replaces an older checksum sample', () => {
    recordChecksumRead(1_000_000_000, 10_000, 'first')
    recordChecksumRead(2_000_000_000, 10_000, 'second')
    expect(latestEffectiveRead()?.modelId).toBe('second')
  })

  it('a checksum sample never overwrites a model_load sample; the reverse always does', () => {
    recordModelLoadRead('/ignored.gguf', 10_000, 'loaded', 6_000_000_000)
    expect(latestEffectiveRead()?.source).toBe('model_load')

    recordChecksumRead(9_000_000_000, 10_000, 'hashed') // CPU-bound on fast media — ranked below
    expect(latestEffectiveRead()?.modelId).toBe('loaded')

    recordModelLoadRead('/ignored.gguf', 20_000, 'loaded-again', 6_000_000_000)
    expect(latestEffectiveRead()?.modelId).toBe('loaded-again')
    expect(latestEffectiveRead()?.ms).toBe(20_000)
  })

  it('preferCandidate is the one ranking rule (also applied to PERSISTED incumbents)', () => {
    expect(preferCandidate(sample(), null)).toBe(true)
    expect(preferCandidate(sample(), undefined)).toBe(true)
    // checksum candidate loses only to a model_load incumbent…
    expect(preferCandidate(sample({ source: 'checksum' }), sample({ source: 'model_load' }))).toBe(false)
    // …every other pairing lets the newer candidate win.
    expect(preferCandidate(sample({ source: 'checksum' }), sample({ source: 'checksum' }))).toBe(true)
    expect(preferCandidate(sample({ source: 'model_load' }), sample({ source: 'checksum' }))).toBe(true)
    expect(preferCandidate(sample({ source: 'model_load' }), sample({ source: 'model_load' }))).toBe(true)
  })

  it('suppressNextModelLoadSample is one-shot: the page-cache-warm load after a hash records nothing', () => {
    suppressNextModelLoadSample()
    recordModelLoadRead('/ignored.gguf', 10_000, 'warm-after-hash', 6_000_000_000)
    expect(latestEffectiveRead()).toBeNull() // suppressed — the hash warmed the cache

    recordModelLoadRead('/ignored.gguf', 10_000, 'cold-next-start', 6_000_000_000)
    expect(latestEffectiveRead()?.modelId).toBe('cold-next-start') // consumed, next start samples
  })

  it('a stat failure in recordModelLoadRead (no bytes override) records nothing and does not throw', () => {
    expect(() => recordModelLoadRead('/no/such/file.gguf', 60_000, 'm')).not.toThrow()
    expect(latestEffectiveRead()).toBeNull()
  })

  it('non-finite inputs record nothing', () => {
    recordChecksumRead(Number.NaN, 10_000, 'm')
    recordChecksumRead(1_000_000_000, Number.POSITIVE_INFINITY, 'm')
    expect(latestEffectiveRead()).toBeNull()
  })

  it('the observer fires once per ACCEPTED sample (ranked winner or not) and its throw never escapes', () => {
    const seen: Array<{ ranked: string | null; checksum: string | null }> = []
    setEffectiveReadObserver(() => {
      seen.push({
        ranked: latestEffectiveRead()?.modelId ?? null,
        checksum: latestEffectiveReadBySource('checksum')?.modelId ?? null
      })
      throw new Error('persist failed — must not reach the producer')
    })
    expect(() => recordChecksumRead(6_000_000_000, 60_000, 'observed')).not.toThrow()
    recordChecksumRead(MIN_READ_SAMPLE_BYTES - 1, 60_000, 'rejected-by-floor')
    recordModelLoadRead('/ignored.gguf', 10_000, 'load', 6_000_000_000)
    // A checksum that LOSES the ranked slot to the model load still notifies (P3): its per-source
    // latch moved — the observer sees the ranked latch unchanged and the checksum latch updated.
    recordChecksumRead(6_000_000_000, 60_000, 'outranked')
    expect(seen).toEqual([
      { ranked: 'observed', checksum: 'observed' },
      { ranked: 'load', checksum: 'observed' },
      { ranked: 'load', checksum: 'outranked' }
    ])
  })


  it('the observer sees the sample already latched (persistence reads the latch)', () => {
    const cb = vi.fn(() => expect(latestEffectiveRead()?.modelId).toBe('latched-first'))
    setEffectiveReadObserver(cb)
    recordChecksumRead(6_000_000_000, 60_000, 'latched-first')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('per-source latches (the Performance screen\'s observed rows)', () => {
  beforeEach(() => resetEffectiveReadForTests())

  it('keeps the newest sample of EACH source, unranked, while the ranked latch still prefers model_load', () => {
    recordModelLoadRead('/m.gguf', 30_000, 'm1', 6_000_000_000)
    recordChecksumRead(5_000_000_000, 40_000, 'm2')
    // The ranked latch hides the checksum behind the model load…
    expect(latestEffectiveRead()?.source).toBe('model_load')
    // …the per-source view shows both, each the newest of its kind.
    expect(latestEffectiveReadBySource('model_load')?.modelId).toBe('m1')
    expect(latestEffectiveReadBySource('checksum')?.modelId).toBe('m2')
    recordChecksumRead(5_000_000_000, 20_000, 'm3')
    expect(latestEffectiveReadBySource('checksum')?.modelId).toBe('m3')
  })

  it('starts empty and clears with the test reset', () => {
    expect(latestEffectiveReadBySource('model_load')).toBeNull()
    expect(latestEffectiveReadBySource('checksum')).toBeNull()
  })
})
