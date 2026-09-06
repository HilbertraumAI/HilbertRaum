import { describe, expect, it } from 'vitest'
import {
  RETRY_MIN_TERM_CHARS,
  narrowByFrequency,
  searchPattern
} from '../../src/main/services/zim/query-rewrite'

// #340 L3 (rag-design §17 D-Z18): the question → `/search` pattern rewrite. Xapian ANDs every
// word the archive's stopper does not drop, and the pinned German Wikipedia archives stop next
// to nothing — so the function AND frame words go, the content words stay as typed, and a
// zero-hit first search gets one narrower retry. The ten measured questions of the 2026-09-06
// real-pack run are the fixture (`tests/fixtures/zim/quality-questions-de.json`); this suite
// pins the rewrite itself, no server.

describe('searchPattern (#340 L3, D-Z18)', () => {
  it('keeps the content words in their original spelling and order, drops function and frame words', () => {
    expect(searchPattern('Welche Rolle spielt Methan beim Treibhauseffekt?').pattern).toBe('Methan Treibhauseffekt')
    expect(searchPattern('Warum steigt der Meeresspiegel?').pattern).toBe('steigt Meeresspiegel')
    expect(searchPattern('Wie funktioniert der Emissionshandel?').pattern).toBe('Emissionshandel')
    expect(searchPattern('Was ist der Unterschied zwischen Wetter und Klima?').pattern).toBe('Wetter Klima')
    expect(searchPattern('What is the role of methane in the greenhouse effect?').pattern).toBe('methane greenhouse effect')
    expect(searchPattern('How does emissions trading work?').pattern).toBe('emissions trading')
  })

  it('keeps hyphenated terms, numbers and case as typed (Xapian stems and folds itself)', () => {
    const r = searchPattern('Wie hoch ist die CO2-Konzentration in der Atmosphäre seit 1850?')
    expect(r.pattern).toBe('CO2-Konzentration Atmosphäre 1850')
    expect(r.rewritten).toBe(true)
    // A trailing hyphen is noise, an inner one is part of the term.
    expect(searchPattern('Kohlenstoff- und Methanemissionen').pattern).toBe('Kohlenstoff Methanemissionen')
  })

  it('never emits an empty pattern: a pure function/frame question falls back to the raw question', () => {
    const r = searchPattern('Was ist das?')
    expect(r.pattern).toBe('Was ist das?')
    expect(r.rewritten).toBe(false)
    expect(r.retry).toBeNull()
    expect(searchPattern('   ').pattern).toBe('')
  })

  it('deduplicates repeated terms and leaves a single content word alone', () => {
    expect(searchPattern('Klima Klima klima').pattern).toBe('Klima')
    const one = searchPattern('Permafrost')
    expect(one).toEqual({
      pattern: 'Permafrost',
      terms: ['Permafrost'],
      retry: null,
      retryTerms: [],
      rewritten: false
    })
  })

  it('offers a narrower retry only when it differs from the first pattern', () => {
    // Two kept terms, one short: the retry keeps the long one.
    const r = searchPattern('Wie wirkt CO2 auf das Eis?')
    expect(r.pattern).toBe('wirkt CO2 Eis')
    expect(r.terms).toEqual(['wirkt', 'CO2', 'Eis'])
    expect(r.retry).toBe('wirkt')
    expect(r.retryTerms).toEqual(['wirkt'])
    // Every kept term is long enough: the retry would be the same query — none offered, and
    // `retryTerms` is empty (#353: the ladder must never re-split `retry`, which is null here).
    const noRetry = searchPattern('Warum steigt der Meeresspiegel?')
    expect(noRetry.retry).toBeNull()
    expect(noRetry.retryTerms).toEqual([])
    // Every kept term is short: nothing narrower to try.
    expect(searchPattern('Was ist Eis und CO2?').retry).toBeNull()
    expect(RETRY_MIN_TERM_CHARS).toBe(5)
  })

  it('the raw-fallback pattern carries no terms at all (#353: the ladder must never tokenize it)', () => {
    const r = searchPattern('Was ist das?')
    expect(r.pattern).toBe('Was ist das?')
    expect(r.terms).toEqual([])
    expect(r.retry).toBeNull()
    expect(r.retryTerms).toEqual([])
  })

  it('reproduces the measured 2026-09-06 fixture patterns (the real-pack hit@5 9/9 forms)', () => {
    const cases: Array<[string, string]> = [
      ['Welche Rolle spielt Methan beim Treibhauseffekt?', 'Methan Treibhauseffekt'],
      ['Wie hoch ist die CO2-Konzentration in der Atmosphäre?', 'CO2-Konzentration Atmosphäre'],
      ['Was ist das Pariser Abkommen?', 'Pariser Abkommen'],
      ['Warum steigt der Meeresspiegel?', 'steigt Meeresspiegel'],
      ['Was bedeutet Klimasensitivität?', 'Klimasensitivität'],
      ['Welche Folgen hat die globale Erwärmung für die Landwirtschaft?', 'Folgen globale Erwärmung Landwirtschaft'],
      ['Was sind Kipppunkte im Klimasystem?', 'Kipppunkte Klimasystem'],
      ['Welche Rolle spielt der Permafrost?', 'Permafrost'],
      ['Wie funktioniert der Emissionshandel?', 'Emissionshandel']
    ]
    for (const [q, expected] of cases) expect(searchPattern(q).pattern, q).toBe(expected)
  })
})

describe('narrowByFrequency (#353 document-frequency ladder)', () => {
  it('drops every zero-df term when at least one exists, keeping the rest', () => {
    const df = new Map([
      ['a', 0],
      ['b', 0],
      ['c', 5]
    ])
    expect(narrowByFrequency(['a', 'b', 'c'], df)).toBe('c')
  })

  it('drops the one zero-df term among otherwise-known terms', () => {
    const df = new Map([
      ['a', 12],
      ['b', 0],
      ['c', 40]
    ])
    expect(narrowByFrequency(['a', 'b', 'c'], df)).toBe('a c')
  })

  it('drops the single lowest-df term when no term has df 0', () => {
    const df = new Map([
      ['a', 5],
      ['b', 2],
      ['c', 8]
    ])
    expect(narrowByFrequency(['a', 'b', 'c'], df)).toBe('a c')
  })

  it('breaks a lowest-df tie by dropping the LAST such term, so an earlier subject word survives', () => {
    const df = new Map([
      ['a', 3],
      ['b', 5],
      ['c', 3]
    ])
    expect(narrowByFrequency(['a', 'b', 'c'], df)).toBe('a b')
  })

  it('keeps a term with no df entry at all — an absent probe is never treated as the lowest', () => {
    const df = new Map([['a', 5]]) // 'b' and 'c' were never probed (past the cap, say)
    expect(narrowByFrequency(['a', 'b', 'c'], df)).toBe('b c')
  })

  it('drops every term when every one has df 0: nothing survives, so null', () => {
    const df = new Map([
      ['a', 0],
      ['b', 0]
    ])
    expect(narrowByFrequency(['a', 'b'], df)).toBeNull()
  })

  it('ignores a df entry for a term that is not in the list', () => {
    const df = new Map([
      ['a', 5],
      ['b', 2],
      ['c', 99] // never asked about — must not influence the decision
    ])
    expect(narrowByFrequency(['a', 'b'], df)).toBe('a')
  })

  it('returns null for a single term: dropping it would leave nothing to search', () => {
    expect(narrowByFrequency(['a'], new Map([['a', 5]]))).toBeNull()
    expect(narrowByFrequency(['a'], new Map([['a', 0]]))).toBeNull()
  })

  it('returns null when nothing qualifies to drop — every term unknown', () => {
    expect(narrowByFrequency(['a', 'b'], new Map())).toBeNull()
  })
})
