import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPerf, perfEnabled, perfMark, perfMs } from '../../src/main/services/perf'

// Opt-in perf mark log (services/perf.ts). The invariants that matter:
// 1. With HILBERTRAUM_PERF_LOG unset, nothing ever touches disk (the default-user
//    posture — no perf.log may appear for someone who never asked for one).
// 2. With it set to '1', marks append parseable lines, and marks fired BEFORE
//    initPerf() buffer in memory and flush on init (app_ready fires pre-init).
// 3. perfMark never throws, even for un-serialisable field values.

describe('perf mark log', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hr-perf-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a full no-op when the env var is unset', () => {
    vi.stubEnv('HILBERTRAUM_PERF_LOG', undefined)
    initPerf(dir)
    perfMark('app_ready')
    perfMark('unlock_done', { totalMs: 12 })
    expect(existsSync(join(dir, 'perf.log'))).toBe(false)
  })

  it('is a full no-op for values other than exactly "1"', () => {
    vi.stubEnv('HILBERTRAUM_PERF_LOG', 'true')
    initPerf(dir)
    perfMark('app_ready')
    expect(existsSync(join(dir, 'perf.log'))).toBe(false)
  })

  it('appends parseable lines with a wall clock, a monotonic column, and json fields', () => {
    vi.stubEnv('HILBERTRAUM_PERF_LOG', '1')
    initPerf(dir)
    perfMark('unlock_done', { totalMs: 42, dbBytes: null, cacheHit: true })
    perfMark('bare_event')
    const lines = readFileSync(join(dir, 'perf.log'), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)

    const m = lines[0].match(/^(\S+) (\d+(?:\.\d+)?) (\S+) (.*)$/)
    expect(m).not.toBeNull()
    expect(Number.isNaN(Date.parse(m![1]))).toBe(false)
    expect(Number(m![2])).toBeGreaterThan(0)
    expect(m![3]).toBe('unlock_done')
    expect(JSON.parse(m![4])).toEqual({ totalMs: 42, dbBytes: null, cacheHit: true })

    // A mark without fields ends at the event name.
    expect(lines[1]).toMatch(/^(\S+) (\d+(?:\.\d+)?) bare_event$/)
  })

  it('buffers marks fired before initPerf and flushes them on init, in order', async () => {
    vi.stubEnv('HILBERTRAUM_PERF_LOG', '1')
    // A fresh module instance simulates the real pre-init window (app_ready fires
    // before initBackend reaches initPerf); the static import above is already bound
    // to a directory by the earlier tests.
    vi.resetModules()
    const fresh = await import('../../src/main/services/perf')
    fresh.perfMark('pre_init_a')
    fresh.perfMark('pre_init_b', { n: 1 })
    fresh.initPerf(dir)
    fresh.perfMark('post_init')
    const events = readFileSync(join(dir, 'perf.log'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => l.split(' ')[2])
    // The pre-init marks flushed first, then the live append.
    expect(events).toEqual(['pre_init_a', 'pre_init_b', 'post_init'])
  })

  it('keeps the newest 200 marks fired before initPerf, dropping the oldest', async () => {
    // A launcher that sets the variable on a build whose init never runs must not grow without bound.
    vi.stubEnv('HILBERTRAUM_PERF_LOG', '1')
    vi.resetModules()
    const fresh = await import('../../src/main/services/perf')
    for (let i = 0; i < 205; i++) fresh.perfMark(`pre_init_${i}`)
    fresh.initPerf(dir)
    const events = readFileSync(join(dir, 'perf.log'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => l.split(' ')[2])
    expect(events).toHaveLength(200)
    expect(events[0]).toBe('pre_init_5')
    expect(events.at(-1)).toBe('pre_init_204')
  })

  it.each([
    [undefined, false],
    ['true', false],
    ['1', true]
  ])('perfEnabled answers the marks’ own switch: %s → %s', (value, enabled) => {
    vi.stubEnv('HILBERTRAUM_PERF_LOG', value)
    expect(perfEnabled()).toBe(enabled)
  })

  it('never throws on un-serialisable field values', () => {
    vi.stubEnv('HILBERTRAUM_PERF_LOG', '1')
    initPerf(dir)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() =>
      perfMark('weird', circular as unknown as Record<string, string>)
    ).not.toThrow()
    expect(readFileSync(join(dir, 'perf.log'), 'utf8')).toContain('weird')
  })

  it('perfMs returns a non-negative whole millisecond delta', () => {
    const t0 = performance.now()
    const ms = perfMs(t0)
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(ms)).toBe(true)
  })
})
