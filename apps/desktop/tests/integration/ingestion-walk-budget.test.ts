import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandPaths,
  expandPathsBounded,
  expandPathsBoundedAsync,
  summarizeImportPaths,
  type ExpandedPaths
} from '../../src/main/services/ingestion'
import {
  DEFAULT_WALK_BUDGET,
  MAX_DROP_PATHS,
  resolveWalkBudget,
  type WalkBudget
} from '../../src/main/services/ingestion/limits'

// #240: the drop/preflight directory walk is bounded — an entry cap, a depth cap and a
// wall-clock budget checked once per directory — and the incoming path array is capped. A bounded
// walk returns a subset of the unbounded expansion in walk order (a prefix when the walk was
// stopped, the expansion minus pruned subtrees when a branch was cut — nothing invented) plus the
// reason it stopped; an unexhausted walk is byte-identical to `expandPaths`.
// #274: production walks asynchronously (`expandPathsBoundedAsync`); the synchronous
// `expandPathsBounded` stays as the executable reference. Every budget case below runs over BOTH
// walks, and the property block pins the async walk to the reference across budgets.

function root(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-walk-budget-'))
}

type Walk = (paths: string[], budget?: WalkBudget, now?: () => number) => Promise<ExpandedPaths>
const WALKS: Array<[string, Walk]> = [
  ['expandPathsBounded (sync reference)', async (p, b, n) => expandPathsBounded(p, b, n)],
  ['expandPathsBoundedAsync (production, #274)', expandPathsBoundedAsync]
]

describe.each(WALKS)('walk budget — %s', (_name, walk) => {
  it('an unexhausted walk equals expandPaths and reports no exhaustion', async () => {
    const dir = root()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'sub', 'b.md'), 'x')
    writeFileSync(join(dir, 'sub', 'c.unsupported'), 'x')
    const bounded = await walk([dir])
    expect(bounded.exhausted).toBeNull()
    expect(bounded.files).toEqual(expandPaths([dir]))
    expect(bounded.files.length).toBe(2)
  })

  it('a deep tree is cut at the depth cap: a prefix of the full walk, one file per admitted level', async () => {
    const dir = root()
    let cur = dir
    for (let i = 0; i < 40; i++) {
      cur = join(cur, `d${i}`)
      mkdirSync(cur)
      writeFileSync(join(cur, 'note.txt'), 'x')
    }
    const full = expandPaths([dir])
    expect(full.length).toBe(40)
    const bounded = await walk([dir], { ...DEFAULT_WALK_BUDGET, maxDepth: 8 })
    expect(bounded.exhausted).toBe('depth')
    // The picked root is depth 0; directories deeper than the cap are not entered. A depth cut
    // prunes subtrees and keeps walking siblings, so the result is a SUBSEQUENCE of the full
    // expansion (same relative order), not necessarily a prefix.
    expect(bounded.files.length).toBeLessThanOrEqual(8)
    expect(bounded.files.length).toBeLessThan(full.length)
    const positions = bounded.files.map((f) => full.indexOf(f))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('a wide tree is cut at the entry cap: no more files than entries admitted', async () => {
    const dir = root()
    for (let i = 0; i < 600; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    const full = expandPaths([dir])
    expect(full.length).toBe(600)
    const bounded = await walk([dir], { ...DEFAULT_WALK_BUDGET, maxEntries: 100 })
    expect(bounded.exhausted).toBe('entries')
    expect(bounded.files.length).toBeLessThanOrEqual(100)
    expect(bounded.files.length).toBeGreaterThan(0)
    expect(bounded.files).toEqual(full.slice(0, bounded.files.length))
  })

  it('an elapsed wall-clock budget stops the walk at the next directory (injected clock)', async () => {
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
    const bounded = await walk([dir], { ...DEFAULT_WALK_BUDGET, maxMillis: 1500 }, now)
    expect(bounded.exhausted).toBe('time')
    expect(bounded.files.length).toBeLessThan(6)
    expect(bounded.files).toEqual(expandPaths([dir]).slice(0, bounded.files.length))
  })

  it('a picked FILE is never subject to the walk budget', async () => {
    const dir = root()
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'x')
    const bounded = await walk([f], { maxEntries: 0, maxDepth: 0, maxMillis: 0 }, () => 0)
    expect(bounded.files).toEqual([f])
    expect(bounded.exhausted).toBeNull()
  })

  it('picked files AFTER a stopped walk are still kept; a later picked folder is skipped', async () => {
    const base = root()
    const big = join(base, 'big')
    mkdirSync(big)
    for (let i = 0; i < 50; i++) writeFileSync(join(big, `f${String(i).padStart(2, '0')}.txt`), 'x')
    const later = join(base, 'later')
    mkdirSync(later)
    writeFileSync(join(later, 'l.txt'), 'x')
    const single = join(base, 'single.txt')
    writeFileSync(single, 'x')
    const bounded = await walk([big, single, later], { ...DEFAULT_WALK_BUDGET, maxEntries: 10 })
    expect(bounded.exhausted).toBe('entries')
    expect(bounded.files.length).toBeLessThanOrEqual(11)
    expect(bounded.files[bounded.files.length - 1]).toBe(single)
    expect(bounded.files.some((f) => f.startsWith(later))).toBe(false)
    // Still a subsequence of the unbounded expansion.
    const full = expandPaths([big, single, later])
    const positions = bounded.files.map((f) => full.indexOf(f))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

// #274: the async walk is pinned to the synchronous reference — same files, same ORDER, same
// `exhausted` — over one mixed tree (wide + deep + unsupported names + a picked file after the
// folder) and a sweep of budgets that cut it at every kind of boundary. With the injected clock both
// walks read the same clock sequence (one read per directory), so even the time cut lands on the
// same directory. Any change to one walk that the other does not mirror fails here.
describe('walk budget — the async walk is byte-identical to the reference (#274)', () => {
  it('same files, order and exhaustion across entry, depth and time cuts', async () => {
    const base = root()
    const tree = join(base, 'tree')
    mkdirSync(tree)
    for (let w = 0; w < 5; w++) {
      const wide = join(tree, `w${w}`)
      mkdirSync(wide)
      for (let i = 0; i < 12; i++) writeFileSync(join(wide, `f${String(i).padStart(2, '0')}.txt`), 'x')
      writeFileSync(join(wide, 'skip.unsupported'), 'x')
    }
    let cur = join(tree, 'deep')
    mkdirSync(cur)
    for (let d = 0; d < 12; d++) {
      cur = join(cur, `d${d}`)
      mkdirSync(cur)
      writeFileSync(join(cur, 'note.md'), 'x')
    }
    const picked = join(base, 'picked.txt')
    writeFileSync(picked, 'x')
    const selection = [tree, picked]

    const budgets: WalkBudget[] = [
      DEFAULT_WALK_BUDGET,
      { ...DEFAULT_WALK_BUDGET, maxEntries: 7 },
      { ...DEFAULT_WALK_BUDGET, maxEntries: 40 },
      { ...DEFAULT_WALK_BUDGET, maxDepth: 3 },
      { ...DEFAULT_WALK_BUDGET, maxDepth: 0 },
      { ...DEFAULT_WALK_BUDGET, maxMillis: 2500 },
      { maxEntries: 30, maxDepth: 2, maxMillis: 4500 }
    ]
    const full = expandPaths(selection)
    expect(full.length).toBe(5 * 12 + 12 + 1)
    for (const budget of budgets) {
      // A fresh deterministic clock per walk: each read advances one second.
      const clock = (): (() => number) => {
        let t = 0
        return () => (t += 1000)
      }
      const reference = expandPathsBounded(selection, budget, clock())
      const production = await expandPathsBoundedAsync(selection, budget, clock())
      expect(production).toEqual(reference)
      // And both stay a subsequence of the unbounded expansion.
      const positions = production.files.map((f) => full.indexOf(f))
      expect(positions.every((p) => p >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }
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

  // #274: the preflight summary carries the cut — a walk stopped by its budget used to count a
  // silent subset. Additive: absent when the walk completed.
  it('summarizeImportPaths reports a walk cut at the entry cap; absent when complete (#274)', async () => {
    const dir = root()
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x')
    const prior = process.env.HILBERTRAUM_WALK_MAX_ENTRIES
    process.env.HILBERTRAUM_WALK_MAX_ENTRIES = '10'
    try {
      const cut = await summarizeImportPaths([dir])
      expect(cut.exhausted).toBe('entries')
      expect(cut.fileCount).toBeLessThanOrEqual(10)
      expect(cut.fileCount).toBeGreaterThan(0)
    } finally {
      if (prior === undefined) delete process.env.HILBERTRAUM_WALK_MAX_ENTRIES
      else process.env.HILBERTRAUM_WALK_MAX_ENTRIES = prior
    }
    const full = await summarizeImportPaths([dir])
    expect(full.fileCount).toBe(40)
    expect(full.exhausted).toBeUndefined()
    expect('exhausted' in full).toBe(false)
  })

  it('MAX_DROP_PATHS is 512; the service itself does not cap (the handler caps the raw seams only)', async () => {
    expect(MAX_DROP_PATHS).toBe(512)
    // A main-vetted picker selection may exceed the cap and must still be countable.
    const dir = root()
    const paths = Array.from({ length: MAX_DROP_PATHS + 1 }, (_, i) => join(dir, `missing-${i}.txt`))
    expect(await summarizeImportPaths(paths)).toEqual({ fileCount: 0, audioFileCount: 0, audioBytes: 0 })
  })
})
