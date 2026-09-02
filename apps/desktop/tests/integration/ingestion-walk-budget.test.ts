import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandPaths, expandPathsBounded, summarizeImportPaths } from '../../src/main/services/ingestion'
import {
  DEFAULT_WALK_BUDGET,
  MAX_DROP_PATHS,
  resolveWalkBudget
} from '../../src/main/services/ingestion/limits'

// #240: the drop/preflight directory walk runs synchronously on the main thread, so it is
// bounded — an entry cap, a depth cap and a wall-clock budget checked once per directory — and
// the incoming path array is capped. A bounded walk returns a PREFIX of the unbounded expansion
// (same order, nothing invented) plus the reason it stopped; an unexhausted walk is byte-identical
// to `expandPaths`. Moving the walk off the main thread is #274.

function root(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-walk-budget-'))
}

describe('walk budget — expandPathsBounded', () => {
  it('an unexhausted walk equals expandPaths and reports no exhaustion', () => {
    const dir = root()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'sub', 'b.md'), 'x')
    writeFileSync(join(dir, 'sub', 'c.unsupported'), 'x')
    const bounded = expandPathsBounded([dir])
    expect(bounded.exhausted).toBeNull()
    expect(bounded.files).toEqual(expandPaths([dir]))
    expect(bounded.files.length).toBe(2)
  })

  it('a deep tree is cut at the depth cap: a prefix of the full walk, one file per admitted level', () => {
    const dir = root()
    let cur = dir
    for (let i = 0; i < 40; i++) {
      cur = join(cur, `d${i}`)
      mkdirSync(cur)
      writeFileSync(join(cur, 'note.txt'), 'x')
    }
    const full = expandPaths([dir])
    expect(full.length).toBe(40)
    const bounded = expandPathsBounded([dir], { ...DEFAULT_WALK_BUDGET, maxDepth: 8 })
    expect(bounded.exhausted).toBe('depth')
    // The picked root is depth 0; directories deeper than the cap are not entered.
    expect(bounded.files.length).toBeLessThanOrEqual(8)
    expect(bounded.files.length).toBeLessThan(full.length)
    expect(bounded.files).toEqual(full.slice(0, bounded.files.length))
  })

  it('a wide tree is cut at the entry cap: no more files than entries admitted', () => {
    const dir = root()
    for (let i = 0; i < 600; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    const full = expandPaths([dir])
    expect(full.length).toBe(600)
    const bounded = expandPathsBounded([dir], { ...DEFAULT_WALK_BUDGET, maxEntries: 100 })
    expect(bounded.exhausted).toBe('entries')
    expect(bounded.files.length).toBeLessThanOrEqual(100)
    expect(bounded.files.length).toBeGreaterThan(0)
    expect(bounded.files).toEqual(full.slice(0, bounded.files.length))
  })

  it('an elapsed wall-clock budget stops the walk at the next directory (injected clock)', () => {
    const dir = root()
    let cur = dir
    for (let i = 0; i < 6; i++) {
      cur = join(cur, `d${i}`)
      mkdirSync(cur)
      writeFileSync(join(cur, 'note.txt'), 'x')
    }
    // Every clock read advances one second; the budget is 1.5 s, so the second directory
    // check finds it elapsed. The real clock is never consulted.
    let t = 0
    const now = (): number => (t += 1000)
    const bounded = expandPathsBounded([dir], { ...DEFAULT_WALK_BUDGET, maxMillis: 1500 }, now)
    expect(bounded.exhausted).toBe('time')
    expect(bounded.files.length).toBeLessThan(6)
    expect(bounded.files).toEqual(expandPaths([dir]).slice(0, bounded.files.length))
  })

  it('a picked FILE is never subject to the walk budget', () => {
    const dir = root()
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'x')
    const bounded = expandPathsBounded([f], { maxEntries: 0, maxDepth: 0, maxMillis: 0 }, () => 0)
    expect(bounded.files).toEqual([f])
    expect(bounded.exhausted).toBeNull()
  })
})

describe('walk budget — defaults, env overrides and the drop cap', () => {
  it('resolveWalkBudget: defaults, positive-integer env overrides, junk ignored', () => {
    expect(resolveWalkBudget({})).toEqual(DEFAULT_WALK_BUDGET)
    expect(DEFAULT_WALK_BUDGET.maxEntries).toBeGreaterThan(0)
    expect(DEFAULT_WALK_BUDGET.maxDepth).toBeGreaterThan(0)
    expect(DEFAULT_WALK_BUDGET.maxMillis).toBeGreaterThan(0)
    expect(
      resolveWalkBudget({
        HILBERTRAUM_WALK_MAX_ENTRIES: '10',
        HILBERTRAUM_WALK_MAX_DEPTH: '3',
        HILBERTRAUM_WALK_BUDGET_MS: '250'
      })
    ).toEqual({ maxEntries: 10, maxDepth: 3, maxMillis: 250 })
    expect(resolveWalkBudget({ HILBERTRAUM_WALK_MAX_ENTRIES: 'lots', HILBERTRAUM_WALK_MAX_DEPTH: '-1' })).toEqual(
      DEFAULT_WALK_BUDGET
    )
  })

  it('summarizeImportPaths refuses an array over MAX_DROP_PATHS', () => {
    expect(MAX_DROP_PATHS).toBe(512)
    const dir = root()
    const paths = Array.from({ length: MAX_DROP_PATHS + 1 }, (_, i) => join(dir, `missing-${i}.txt`))
    expect(() => summarizeImportPaths(paths)).toThrow()
    // Exactly the cap is admitted (the paths do not exist → nothing counted).
    expect(summarizeImportPaths(paths.slice(0, MAX_DROP_PATHS))).toEqual({
      fileCount: 0,
      audioFileCount: 0,
      audioBytes: 0
    })
  })
})
