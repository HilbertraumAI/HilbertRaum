import { describe, it, expect } from 'vitest'
import {
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

  it('refuses a wildcard-heavy glob (ReDoS guard) — no match, returns quickly (S2)', () => {
    // A `*a*a*a…` glob compiles to the catastrophic-backtracking shape; the selector refuses it
    // (>10 wildcards) and treats it as a non-match rather than risk hanging the main process.
    const evil = '*a'.repeat(40) // 40 wildcards, far over the cap
    const adversarialTitle = 'a'.repeat(60) // the input that would blow up an unguarded regex
    const start = Date.now()
    const score = scoreSkillTriggers(triggers({ filenamePatterns: [evil] }), {
      question: 'hello',
      docTitles: [adversarialTitle],
      docMimeTypes: []
    })
    expect(score).toBe(0) // refused → no filename hit
    expect(Date.now() - start).toBeLessThan(1000) // did not backtrack into a hang
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
