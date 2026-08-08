import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  latestEffectiveRead,
  MIN_READ_SAMPLE_BYTES,
  MIN_READ_SAMPLE_MS,
  recordChecksumRead,
  recordModelLoadRead,
  resetEffectiveReadForTests
} from '../../src/main/services/read-speed'

// #108: the honest effective-read latch. Policy under test: sample floors (tiny
// files/instant reads carry no throughput information), and the source ranking — a
// checksum sample can be hash-CPU-bound on fast media, so it only ever fills absence
// and is replaced by a model_load sample, never the other way around.

describe('effective-read latch (#108)', () => {
  let weightFile = ''

  beforeAll(() => {
    // recordModelLoadRead stats the real file — one floor-sized fixture for the suite.
    const dir = mkdtempSync(join(tmpdir(), 'hr-read-speed-'))
    weightFile = join(dir, 'weights.gguf')
    writeFileSync(weightFile, Buffer.alloc(MIN_READ_SAMPLE_BYTES))
  })

  beforeEach(() => resetEffectiveReadForTests())

  it('computes MB/s (MB = 1e6 bytes) from bytes over elapsed', () => {
    recordChecksumRead(6_000_000_000, 60_000, 'model-a') // 6 GB in 60 s = 100 MB/s
    const s = latestEffectiveRead()
    expect(s?.mbps).toBe(100)
    expect(s?.source).toBe('checksum')
    expect(s?.modelId).toBe('model-a')
    expect(s?.bytes).toBe(6_000_000_000)
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

  it('a newer checksum sample replaces an older checksum sample', () => {
    recordChecksumRead(1_000_000_000, 10_000, 'first')
    recordChecksumRead(2_000_000_000, 10_000, 'second')
    expect(latestEffectiveRead()?.modelId).toBe('second')
  })

  it('a checksum sample never overwrites a model_load sample; the reverse always does', () => {
    recordModelLoadRead(weightFile, 10_000, 'loaded')
    expect(latestEffectiveRead()?.source).toBe('model_load')

    recordChecksumRead(9_000_000_000, 10_000, 'hashed') // CPU-bound on fast media — ranked below
    expect(latestEffectiveRead()?.modelId).toBe('loaded')

    recordModelLoadRead(weightFile, 20_000, 'loaded-again') // model_load always replaces
    expect(latestEffectiveRead()?.modelId).toBe('loaded-again')
    expect(latestEffectiveRead()?.ms).toBe(20_000)
  })

  it('a stat failure in recordModelLoadRead records nothing and does not throw', () => {
    expect(() => recordModelLoadRead('/no/such/file.gguf', 60_000, 'm')).not.toThrow()
    expect(latestEffectiveRead()).toBeNull()
  })

  it('non-finite inputs record nothing', () => {
    recordChecksumRead(Number.NaN, 10_000, 'm')
    recordChecksumRead(1_000_000_000, Number.POSITIVE_INFINITY, 'm')
    expect(latestEffectiveRead()).toBeNull()
  })
})
