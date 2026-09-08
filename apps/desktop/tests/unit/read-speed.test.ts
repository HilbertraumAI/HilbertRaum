import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join, resolve } from 'node:path'
import {
  latestEffectiveRead,
  latestEffectiveReadBySource,
  MIN_MODEL_LOAD_SAMPLE_BYTES,
  MIN_READ_SAMPLE_BYTES,
  MIN_READ_SAMPLE_MS,
  noteWeightWarmed,
  preferCandidate,
  recordChecksumRead,
  recordModelLoadRead,
  resetEffectiveReadForTests,
  setEffectiveReadObserver,
  setReadSpeedClockForTests,
  suppressNextModelLoadSample,
  throughputMbps
} from '../../src/main/services/read-speed'
import { SLOW_READ_MBPS } from '../../src/shared/performance-rules'
import type { EffectiveReadSample } from '../../src/shared/types'

// #108: the honest effective-read latch. Policy under test: sample floors (tiny
// files/instant reads carry no throughput information; model_load additionally needs
// 2 GiB so parse/KV-alloc/graph-init fixed costs can't dominate the window), the source
// ranking (a checksum sample can be hash-CPU-bound on fast media, so it only ever fills
// absence and is replaced by model_load, never vice versa — UNLESS it is media-bound, below
// SLOW_READ_MBPS, which since #404 ranks by age in both directions), the page-cache suppression
// — both the one-shot flag (a start whose OWN install-state pass hashed) and, since #392,
// the per-path session set (a weight hashed ANYWHERE this session, e.g. by the Models
// screen, records no load sample) — and the observer (persistence is a property of
// recording).

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

  // #404: the SHA-256 floor is measured at ~136 MB/s (benchmark.md, "Slow read"), so a
  // checksum sample below SLOW_READ_MBPS (100) cannot be hash-CPU-bound — the premise the
  // "checksum only fills absence" rank rests on. Both halves of the amendment, and the
  // boundary that keeps every older case honest.
  it('#404: a MEDIA-bound checksum candidate displaces a model_load incumbent (half 1)', () => {
    const slowHash = sample({ source: 'checksum', mbps: 30 })
    expect(preferCandidate(slowHash, sample({ source: 'model_load', mbps: 589 }))).toBe(true)
  })

  it('#404: a model_load candidate does NOT displace a media-bound checksum incumbent (half 2)', () => {
    const slowHash = sample({ source: 'checksum', mbps: 30 })
    expect(preferCandidate(sample({ source: 'model_load', mbps: 589 }), slowHash)).toBe(false)
    // A NEWER checksum still beats a checksum incumbent — this is what makes half 2's
    // accepted failure mode (a faster USB port on the same machine) self-heal.
    expect(preferCandidate(sample({ source: 'checksum', mbps: 133 }), slowHash)).toBe(true)
  })

  it('#404: exactly SLOW_READ_MBPS is NOT media-bound — the strict < boundary is pinned', () => {
    const atThreshold = sample({ source: 'checksum', mbps: SLOW_READ_MBPS })
    // Unchanged from before #404 in BOTH directions: the old rank still applies at 100 MB/s.
    expect(preferCandidate(atThreshold, sample({ source: 'model_load' }))).toBe(false)
    expect(preferCandidate(sample({ source: 'model_load' }), atThreshold)).toBe(true)
    // One tenth below it flips both.
    const justUnder = sample({ source: 'checksum', mbps: SLOW_READ_MBPS - 0.1 })
    expect(preferCandidate(justUnder, sample({ source: 'model_load' }))).toBe(true)
    expect(preferCandidate(sample({ source: 'model_load' }), justUnder)).toBe(false)
  })

  it('#404: the latch keeps a slow hash over a page-cache load window, in either order', () => {
    // 3 GB over 100 s = 30 MB/s — a stick, not the SHA-256 floor. No path, so the #392
    // warmed-path suppression is not what is under test here.
    recordChecksumRead(3_000_000_000, 100_000, 'slow-media')
    recordModelLoadRead('/ignored.gguf', 5_000, 'page-cache', 6_000_000_000) // 1,200 MB/s
    expect(latestEffectiveRead()?.modelId).toBe('slow-media')
    expect(latestEffectiveReadBySource('model_load')?.modelId).toBe('page-cache') // still latched per source

    resetEffectiveReadForTests()
    recordModelLoadRead('/ignored.gguf', 5_000, 'page-cache', 6_000_000_000)
    recordChecksumRead(3_000_000_000, 100_000, 'slow-media')
    expect(latestEffectiveRead()?.modelId).toBe('slow-media') // half 1 repairs the incumbent
  })

  it('suppressNextModelLoadSample is one-shot: the page-cache-warm load after a hash records nothing', () => {
    suppressNextModelLoadSample()
    recordModelLoadRead('/ignored.gguf', 10_000, 'warm-after-hash', 6_000_000_000)
    expect(latestEffectiveRead()).toBeNull() // suppressed — the hash warmed the cache

    recordModelLoadRead('/ignored.gguf', 10_000, 'cold-next-start', 6_000_000_000)
    expect(latestEffectiveRead()?.modelId).toBe('cold-next-start') // consumed, next start samples
  })

  // #392: the one-shot flag above only covers a start whose OWN install check hashed. On the
  // default first-run journey the Models screen hashes the corpus first (#382), the start hits
  // the size+mtime cache and the RAM figure was persisted for good (#334 leg B1: 589 MB/s for a
  // 28 MB/s stick). A path a checksum sample was recorded for THIS process is remembered.
  it('a weight hashed earlier in the session records no load sample — the checksum stays the figure', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'm', '/models/w.gguf')
    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000)

    expect(latestEffectiveRead()?.source).toBe('checksum')
    expect(latestEffectiveReadBySource('model_load')).toBeNull()
  })

  it('any-intersection: a multi-file model whose mmproj alone was hashed is treated warm', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'm', '/models/mm.proj')
    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000, [
      '/models/w.gguf',
      '/models/mm.proj'
    ])

    expect(latestEffectiveRead()?.source).toBe('checksum')
    expect(latestEffectiveReadBySource('model_load')).toBeNull()
  })

  it('a sub-floor hash does NOT register the path (its warmth cannot move the window)', () => {
    // Under 64 MiB is under 3 % of the ≥ 2 GiB a model_load sample needs, so such a file's
    // warmth cannot meaningfully inflate the window — while registering it WOULD risk leaving a
    // session with a warm mark and no sample behind it. Aligning registration with the byte
    // floor keeps the no-starvation invariant true by construction.
    recordChecksumRead(MIN_READ_SAMPLE_BYTES - 1, 10_000, 'm', '/models/small.gguf')
    expect(latestEffectiveRead()).toBeNull() // no sample: the floor rejected it

    recordModelLoadRead('/models/small.gguf', 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveRead()?.source).toBe('model_load') // …and no warm mark either
  })

  it('a hash AT the byte floor registers even when the elapsed floor rejects the sample', () => {
    // A floor-sized file hashed in under 250 ms was itself served from the cache — it IS warm.
    recordChecksumRead(MIN_READ_SAMPLE_BYTES, MIN_READ_SAMPLE_MS - 1, 'm', '/models/w.gguf')
    expect(latestEffectiveRead()).toBeNull()

    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveRead()).toBeNull()
  })

  it('noteWeightWarmed registers a path the app WROTE: no sample, and the next load is dropped', () => {
    noteWeightWarmed('/models/just-downloaded.gguf')
    expect(latestEffectiveRead()).toBeNull() // a mark, not a sample

    recordModelLoadRead('/models/just-downloaded.gguf', 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveRead()).toBeNull() // the start after a download times RAM — dropped

    // The deliberate exception to "nothing is starved": no checksum sample stands behind this
    // one (the download verify never samples). Honest absence; the next COLD start measures.
    recordModelLoadRead('/models/other.gguf', 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveRead()?.source).toBe('model_load')
  })

  it('the session set and the one-shot flag are independent mechanisms', () => {
    suppressNextModelLoadSample()
    recordModelLoadRead('/never-hashed.gguf', 10_000, 'warm-by-flag', 6_000_000_000)
    expect(latestEffectiveRead()).toBeNull() // the flag suppressed it…

    recordModelLoadRead('/never-hashed.gguf', 10_000, 'cold-next-start', 6_000_000_000)
    expect(latestEffectiveRead()?.modelId).toBe('cold-next-start') // …and only it: the path is not in the set
  })

  it('a path never hashed still samples, and the set is per path, not per session', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'a', '/a.gguf')
    recordModelLoadRead('/b.gguf', 10_000, 'b', 6_000_000_000)

    expect(latestEffectiveRead()?.source).toBe('model_load')
    expect(latestEffectiveRead()?.modelId).toBe('b')
  })

  it('paths are compared resolved: a non-normalised spelling of the hashed file is still warm', () => {
    // Two spellings of ONE file that survive `join`'s own normalisation on every platform:
    // the relative form (what a caller may hold) and its absolute resolution.
    const relative = join('models', 'corpus', 'w.gguf')
    const absolute = resolve(relative)
    expect(absolute).not.toBe(relative)

    recordChecksumRead(6_000_000_000, 60_000, 'm', absolute)
    recordModelLoadRead(relative, 10_000, 'm', 6_000_000_000)

    expect(latestEffectiveReadBySource('model_load')).toBeNull()
  })

  it.runIf(process.platform === 'win32')(
    'win32: the drive letter and case are folded (resolve alone does not fold them)',
    () => {
      const absolute = resolve(join('models', 'corpus', 'w.gguf'))
      const shouted = absolute.toUpperCase() // same file to Windows, a different string to a Set
      expect(shouted).not.toBe(absolute)

      recordChecksumRead(6_000_000_000, 60_000, 'm', absolute)
      recordModelLoadRead(shouted, 10_000, 'm', 6_000_000_000)

      expect(latestEffectiveReadBySource('model_load')).toBeNull()
    }
  )

  it('the set is never cleared inside the process: every later start of that weight stays suppressed', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'm', '/models/w.gguf')
    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000)
    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000)

    expect(latestEffectiveReadBySource('model_load')).toBeNull()
    expect(latestEffectiveRead()?.source).toBe('checksum')
  })

  it('a checksum recorded with no path (the pre-#392 signature) warms nothing', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'm')
    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000)

    expect(latestEffectiveRead()?.source).toBe('model_load')
  })

  it('resetEffectiveReadForTests clears the warmed-path set (the shared fixture relies on it)', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'm', '/models/w.gguf')
    resetEffectiveReadForTests()

    recordModelLoadRead('/models/w.gguf', 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveRead()?.source).toBe('model_load')
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

describe('strictly increasing sample timestamps (PR #303 audit A-D4)', () => {
  beforeEach(() => resetEffectiveReadForTests())

  it('two samples under a frozen clock get distinct, increasing `at` values (ISO strings, 1 ms apart)', () => {
    setReadSpeedClockForTests(() => new Date('2026-09-06T12:00:00.000Z'))
    recordChecksumRead(6_000_000_000, 60_000, 'first')
    const first = latestEffectiveReadBySource('checksum')!.at
    recordChecksumRead(6_000_000_000, 60_000, 'second')
    const second = latestEffectiveReadBySource('checksum')!.at
    expect(first).toBe('2026-09-06T12:00:00.000Z')
    expect(second).toBe('2026-09-06T12:00:00.001Z')
  })

  it('a clock that runs backwards is bumped past the previous accepted sample; a rejected sample never reaches the clock', () => {
    const readings = ['2026-09-06T12:00:05.000Z', '2026-09-06T12:00:01.000Z', '2026-09-06T12:00:09.000Z']
    let reads = 0
    setReadSpeedClockForTests(() => new Date(readings[reads++]))
    recordChecksumRead(6_000_000_000, 60_000, 'a')
    recordChecksumRead(MIN_READ_SAMPLE_BYTES - 1, 60_000, 'rejected-by-floor')
    const a = latestEffectiveReadBySource('checksum')!.at
    recordChecksumRead(6_000_000_000, 60_000, 'b') // the clock says 4 s EARLIER than a
    const b = latestEffectiveReadBySource('checksum')!.at
    recordChecksumRead(6_000_000_000, 60_000, 'c') // the clock is ahead again: taken as is
    const c = latestEffectiveReadBySource('checksum')!.at
    expect([a, b, c]).toEqual(['2026-09-06T12:00:05.000Z', '2026-09-06T12:00:05.001Z', '2026-09-06T12:00:09.000Z'])
    expect(reads).toBe(3)
  })

  it('a checksum in the same millisecond as a model load is a distinct sample in the per-source latches; the ranked latch keeps the load', () => {
    setReadSpeedClockForTests(() => new Date('2026-09-06T12:00:00.000Z'))
    recordModelLoadRead('/ignored.gguf', 10_000, 'load', 6_000_000_000)
    recordChecksumRead(6_000_000_000, 60_000, 'hash')
    const load = latestEffectiveReadBySource('model_load')!
    const hash = latestEffectiveReadBySource('checksum')!
    expect(hash.at > load.at).toBe(true)
    expect(latestEffectiveRead()).toBe(load)
  })
})
