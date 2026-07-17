import { describe, it, expect } from 'vitest'
import {
  wordDiff,
  tokenizeForDiff,
  renderRedline,
  renderChangesForModel,
  DEFAULT_MAX_EDITS
} from '../../src/main/services/diff'

describe('tokenizeForDiff', () => {
  it('splits on any whitespace and drops empties (line/PDF reflow is normalized away)', () => {
    expect(tokenizeForDiff('a  b\n c\t d')).toEqual(['a', 'b', 'c', 'd'])
    expect(tokenizeForDiff('   ')).toEqual([])
  })
})

describe('wordDiff — the core cases', () => {
  it('identical texts: no changes, identical=true, whitespace differences ignored', () => {
    const r = wordDiff('Lorem ipsum dolor sit', 'Lorem   ipsum\ndolor  sit')
    expect(r).not.toBeNull()
    expect(r!.identical).toBe(true)
    expect(r!.changes).toHaveLength(0)
    expect(r!.stats).toEqual({ added: 0, removed: 0, equal: 4 })
  })

  // F-23 (audit 2026-07-16): two ZERO-word texts used to return null ("too different") instead of
  // identical — with n=m=0 the Myers d=0/k=0 iteration read v[1] on a length-1 Int32Array
  // (undefined), x=undefined poisoned the termination test, and myers fell through to the
  // too-different bail. Two empty texts are word-for-word identical per the DiffResult contract.
  it('two empty texts are identical, with zero stats (F-23)', () => {
    const r = wordDiff('', '')
    expect(r).not.toBeNull()
    expect(r!.identical).toBe(true)
    expect(r!.changes).toHaveLength(0)
    expect(r!.ops).toHaveLength(0)
    expect(r!.stats).toEqual({ added: 0, removed: 0, equal: 0 })
  })

  it('whitespace-only texts tokenize to zero words and are identical too (F-23)', () => {
    const r = wordDiff('   ', '\n')
    expect(r).not.toBeNull()
    expect(r!.identical).toBe(true)
    expect(r!.stats).toEqual({ added: 0, removed: 0, equal: 0 })
  })

  it('empty vs non-empty still yields a pure insert / pure delete (F-23 regression guard)', () => {
    const ins = wordDiff('', 'a b')
    expect(ins!.identical).toBe(false)
    expect(ins!.changes).toHaveLength(1)
    expect(ins!.changes[0].added).toEqual(['a', 'b'])
    expect(ins!.changes[0].removed).toEqual([])
    expect(ins!.stats).toEqual({ added: 2, removed: 0, equal: 0 })
    const del = wordDiff('a b', '   ')
    expect(del!.identical).toBe(false)
    expect(del!.changes[0].removed).toEqual(['a', 'b'])
    expect(del!.stats).toEqual({ added: 0, removed: 2, equal: 0 })
  })

  it('the real regression: a single deleted word deep in repetitive text is caught exactly', () => {
    // Doc 2 dropped "tempor" from "…eirmod tempor invidunt…" — the change the LLM missed.
    const a = 'sed diam nonumy eirmod tempor invidunt ut labore et dolore'
    const b = 'sed diam nonumy eirmod invidunt ut labore et dolore'
    const r = wordDiff(a, b, { context: 2 })
    expect(r).not.toBeNull()
    expect(r!.identical).toBe(false)
    expect(r!.changes).toHaveLength(1)
    const c = r!.changes[0]
    expect(c.removed).toEqual(['tempor'])
    expect(c.added).toEqual([])
    expect(c.before).toEqual(['nonumy', 'eirmod'])
    expect(c.after).toEqual(['invidunt', 'ut'])
    expect(r!.stats).toEqual({ added: 0, removed: 1, equal: 9 })
  })

  it('a pure insertion is reported as added-only', () => {
    const r = wordDiff('the quick fox', 'the quick brown fox', { context: 1 })
    expect(r!.changes).toHaveLength(1)
    expect(r!.changes[0].removed).toEqual([])
    expect(r!.changes[0].added).toEqual(['brown'])
    expect(r!.changes[0].before).toEqual(['quick'])
    expect(r!.changes[0].after).toEqual(['fox'])
  })

  it('a replacement populates BOTH removed and added (numbers stay exact)', () => {
    const r = wordDiff('Service fee is 100 EUR per month', 'Service fee is 120 EUR per month', {
      context: 2
    })
    expect(r!.changes).toHaveLength(1)
    expect(r!.changes[0].removed).toEqual(['100'])
    expect(r!.changes[0].added).toEqual(['120'])
  })

  it('multiple independent changes are each captured in document order', () => {
    const a = 'fee is 100 EUR term is 12 months notice is 30 days'
    const b = 'fee is 120 EUR term is 24 months notice is 60 days'
    const r = wordDiff(a, b, { context: 1 })
    expect(r!.changes.map((c) => [c.removed.join(' '), c.added.join(' ')])).toEqual([
      ['100', '120'],
      ['12', '24'],
      ['30', '60']
    ])
  })

  it('returns null when the two texts exceed the edit cutoff (→ caller falls back)', () => {
    const a = Array.from({ length: 400 }, (_, i) => `alpha${i}`).join(' ')
    const b = Array.from({ length: 400 }, (_, i) => `beta${i}`).join(' ')
    // 800 edits > a tiny cutoff → null.
    expect(wordDiff(a, b, { maxEdits: 50 })).toBeNull()
  })

  it('near-identical large texts diff cheaply under the default cutoff (Myers is ~linear here)', () => {
    const base = Array.from({ length: 2000 }, (_, i) => `w${i}`)
    const a = base.join(' ')
    const b = base.slice(0, 1000).concat(['INSERTED'], base.slice(1000)).join(' ')
    const r = wordDiff(a, b)
    expect(r).not.toBeNull()
    expect(r!.changes).toHaveLength(1)
    expect(r!.changes[0].added).toEqual(['INSERTED'])
    expect(DEFAULT_MAX_EDITS).toBeGreaterThan(2)
  })

  it('is symmetric in structure: swapping old/new swaps removed/added', () => {
    const f = wordDiff('a b c d', 'a x c d', { context: 1 })!
    const g = wordDiff('a x c d', 'a b c d', { context: 1 })!
    expect(f.changes[0].removed).toEqual(g.changes[0].added)
    expect(f.changes[0].added).toEqual(g.changes[0].removed)
  })
})

describe('renderRedline', () => {
  it('marks deletions struck-through and insertions bold, with context', () => {
    const r = wordDiff('fee is 100 EUR per month', 'fee is 120 EUR per month', { context: 2 })!
    const { text, truncated } = renderRedline(r.changes)
    expect(truncated).toBe(false)
    expect(text).toContain('~~100~~')
    expect(text).toContain('**120**')
    expect(text).toContain('is') // context word survives
  })

  it('caps the number of shown changes and reports truncation', () => {
    const changes = Array.from({ length: 10 }, (_, i) => ({
      before: [],
      removed: [`r${i}`],
      added: [`a${i}`],
      after: []
    }))
    const { text, truncated } = renderRedline(changes, { max: 3 })
    expect(truncated).toBe(true)
    expect(text).toContain('and 7 more change(s)')
  })
})

describe('renderChangesForModel', () => {
  it('labels Removed / Added / Changed with exact words for the interpretation prompt', () => {
    const r = wordDiff('a 100 b removed_word c', 'a 120 b c d', { context: 1 })!
    const { text } = renderChangesForModel(r.changes)
    expect(text).toContain('Changed: "100" → "120"')
    expect(text).toContain('Removed: "removed_word"')
    expect(text).toContain('Added: "d"')
  })
})
