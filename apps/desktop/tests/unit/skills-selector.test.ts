import { describe, it, expect } from 'vitest'
import {
  globMatches,
  matchesSkillDocSignals,
  scoreSkillTriggers,
  selectSuggestion,
  SUGGEST_SCORE_THRESHOLD,
  type SkillCandidate
} from '../../src/main/services/skills/selector'
import type { SkillTriggers } from '../../src/shared/skill-manifest'

// Skills plan §10.2 #2 (S8) — deterministic suggestion scoring. Pure, no model, no DB. Proves: a
// topical keyword is the strong signal; a lone document signal never fires; mime+filename together
// clear the bar; matching is case-insensitive + glob; ties break deterministically; never throws.

function triggers(over: Partial<SkillTriggers> = {}): SkillTriggers {
  return { keywords: [], mimeTypes: [], filenamePatterns: [], ...over }
}
const NO_DOCS = { docTitles: [], docMimeTypes: [] }

describe('scoreSkillTriggers', () => {
  it('scores a keyword hit in the question above the threshold (case-insensitive)', () => {
    const score = scoreSkillTriggers(triggers({ keywords: ['bank statement'] }), {
      question: 'Can you reconcile this BANK STATEMENT?',
      ...NO_DOCS
    })
    expect(score).toBeGreaterThanOrEqual(SUGGEST_SCORE_THRESHOLD)
  })

  it('does NOT fire on a lone document signal (a PDF in scope is not a topical match)', () => {
    const mimeOnly = scoreSkillTriggers(triggers({ mimeTypes: ['application/pdf'] }), {
      question: 'hello',
      docTitles: [],
      docMimeTypes: ['application/pdf']
    })
    const fileOnly = scoreSkillTriggers(triggers({ filenamePatterns: ['*statement*'] }), {
      question: 'hello',
      docTitles: ['march-statement.pdf'],
      docMimeTypes: []
    })
    expect(mimeOnly).toBeLessThan(SUGGEST_SCORE_THRESHOLD)
    expect(fileOnly).toBeLessThan(SUGGEST_SCORE_THRESHOLD)
  })

  it('fires when mime AND filename match together (supporting signals combine)', () => {
    const score = scoreSkillTriggers(
      triggers({ mimeTypes: ['text/csv'], filenamePatterns: ['*kontoauszug*'] }),
      { question: 'summarize', docTitles: ['2024-kontoauszug.csv'], docMimeTypes: ['text/csv'] }
    )
    expect(score).toBeGreaterThanOrEqual(SUGGEST_SCORE_THRESHOLD)
  })

  it('returns 0 for empty triggers and ignores whitespace-only entries', () => {
    expect(scoreSkillTriggers(triggers(), { question: 'anything', ...NO_DOCS })).toBe(0)
    expect(
      scoreSkillTriggers(triggers({ keywords: ['   '] }), { question: 'anything', ...NO_DOCS })
    ).toBe(0)
  })

  it('ReDoS regression: the `*?*?…#` payload over a long title returns fast and does not match', () => {
    // The vuln-scan-2026-06-21 payload: exactly 10 `*` interleaved with `?` and a trailing literal
    // (`#`) absent from real titles. Under the old wildcard-count cap this slipped through (the cap
    // counted only `*`) and compiled to `.*..*..*…`, freezing the main process via degree-10
    // polynomial backtracking on a moderately-long title. The linear matcher cannot backtrack, so it
    // resolves the non-match in microseconds.
    const payload = '*?'.repeat(10) + '#'
    const adversarialTitle = '2024-Q3-Financial-Statement-ACME-Corporation.pdf' // ~48 chars, no '#'
    const start = Date.now()
    const score = scoreSkillTriggers(triggers({ filenamePatterns: [payload] }), {
      question: 'hello',
      docTitles: [adversarialTitle],
      docMimeTypes: []
    })
    expect(score).toBe(0) // the trailing '#' is absent from the title → no filename hit
    expect(Date.now() - start).toBeLessThan(1000) // no catastrophic backtracking
  })

  it('a wildcard-heavy glob is now safely MATCHED (no longer refused) and returns fast', () => {
    // The old guard refused any `*a*a…` glob with > 10 stars outright; the linear matcher makes it
    // safe, so a legitimate wildcard-heavy pattern that genuinely matches now contributes a hit.
    const heavy = '*a'.repeat(40) // 40 stars — far over the retired cap
    const start = Date.now()
    const score = scoreSkillTriggers(triggers({ filenamePatterns: [heavy] }), {
      question: 'hello',
      docTitles: ['a'.repeat(60)], // 60 'a's — matches `*a` × 40
      docMimeTypes: []
    })
    expect(score).toBeGreaterThanOrEqual(1) // filename hit now counts (was wrongly refused before)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('still matches a normal handful-of-wildcards glob (the guard is generous)', () => {
    const score = scoreSkillTriggers(triggers({ mimeTypes: ['text/csv'], filenamePatterns: ['*-statement-*.csv'] }), {
      question: 'x',
      docTitles: ['2024-statement-march.csv'],
      docMimeTypes: ['text/csv']
    })
    expect(score).toBeGreaterThanOrEqual(SUGGEST_SCORE_THRESHOLD)
  })
})

describe('matchesSkillDocSignals (W2 doc-count narrowing + plausibility gate)', () => {
  const bankTriggers = triggers({
    mimeTypes: ['application/pdf', 'text/csv'],
    filenamePatterns: ['*statement*', '*kontoauszug*']
  })

  it('matches on a filename-pattern hit (the discriminating signal)', () => {
    expect(matchesSkillDocSignals(bankTriggers, { title: '2024-statement-march.pdf', mimeType: 'application/pdf' })).toBe(true)
    expect(matchesSkillDocSignals(bankTriggers, { title: 'Kontoauszug-2024.txt', mimeType: 'text/plain' })).toBe(true)
  })

  it('matches on a MIME hit even without a filename match (broad but declared)', () => {
    expect(matchesSkillDocSignals(bankTriggers, { title: 'my-file.pdf', mimeType: 'application/pdf' })).toBe(true)
  })

  it('does NOT match a document that hits neither signal (a text contract falls through)', () => {
    expect(matchesSkillDocSignals(bankTriggers, { title: 'lease-agreement.txt', mimeType: 'text/plain' })).toBe(false)
    expect(matchesSkillDocSignals(bankTriggers, { title: 'notes.md', mimeType: 'text/markdown' })).toBe(false)
  })

  it('matches nothing when the skill declares no doc signals, and tolerates a null MIME', () => {
    expect(matchesSkillDocSignals(triggers(), { title: 'anything-statement.pdf', mimeType: 'application/pdf' })).toBe(false)
    expect(matchesSkillDocSignals(bankTriggers, { title: 'march-statement', mimeType: null })).toBe(true) // filename still hits
    expect(matchesSkillDocSignals(bankTriggers, { title: 'contract', mimeType: null })).toBe(false)
  })
})

describe('selectSuggestion', () => {
  const bank: SkillCandidate = {
    installId: 'user:bank',
    title: 'Bank',
    triggers: triggers({ keywords: ['bank statement'] })
  }
  const contract: SkillCandidate = {
    installId: 'user:contract',
    title: 'Contract',
    triggers: triggers({ keywords: ['contract', 'clause'] })
  }

  it('returns null when nothing clears the threshold', () => {
    expect(selectSuggestion([bank, contract], { question: 'what is the weather', ...NO_DOCS })).toBeNull()
  })

  it('picks the highest-scoring candidate', () => {
    const ctx = { question: 'review this contract clause and the bank statement', ...NO_DOCS }
    // contract matches two keywords (score 4) > bank's one (score 2).
    expect(selectSuggestion([bank, contract], ctx)?.installId).toBe('user:contract')
  })

  it('breaks ties deterministically by installId (ascending)', () => {
    const a: SkillCandidate = { installId: 'user:a', title: 'A', triggers: triggers({ keywords: ['x'] }) }
    const b: SkillCandidate = { installId: 'user:b', title: 'B', triggers: triggers({ keywords: ['x'] }) }
    expect(selectSuggestion([b, a], { question: 'x', ...NO_DOCS })?.installId).toBe('user:a')
  })
})

describe('globMatches (the linear, non-backtracking glob matcher)', () => {
  it('matches `*`/`?` with literal, full-string, case-insensitive semantics', () => {
    expect(globMatches('*statement*', 'march-statement.pdf')).toBe(true)
    expect(globMatches('*KONTOAUSZUG*', '2024-kontoauszug.csv')).toBe(true) // case-insensitive
    expect(globMatches('????.pdf', 'abcd.pdf')).toBe(true) // ? = exactly one char each
    expect(globMatches('????.pdf', 'abc.pdf')).toBe(false) // too few chars for the four '?'
    expect(globMatches('report.pdf', 'reportXpdf')).toBe(false) // '.' is a literal, not any-char
    expect(globMatches('*.csv', 'data.csv')).toBe(true)
    expect(globMatches('*.csv', 'data.csv.txt')).toBe(false) // anchored at both ends
  })

  it('handles edge cases (empty, lone star) without throwing', () => {
    expect(globMatches('*', 'anything-at-all')).toBe(true)
    expect(globMatches('*', '')).toBe(true)
    expect(globMatches('', '')).toBe(true)
    expect(globMatches('', 'x')).toBe(false)
    expect(globMatches('a*b*c', 'axxbxxc')).toBe(true)
  })
})
