import { describe, it, expect } from 'vitest'
import { countKeywordHits } from '../../src/main/services/skills/selector'
import {
  APP_VOCAB_SKILL_IDS,
  SKILL_VOCABULARY,
  deriveMatch,
  entryMatches,
  routeEntries,
  routeMatch,
  suggestTerms,
  type SkillVocabId,
  type VocabEntry
} from '../../src/main/services/skills/vocabulary'

// W5 (audit §3.2/§4.1/§4.2/§8.3) — the ONE canonical trigger vocabulary is the single source both the
// SUGGESTION scorer and the ROUTING gates read. These tests pin its INTERNAL invariants (so the two
// consumers can never disagree) and its MATCHING semantics (word-boundary vs substring), and prove the
// handler-vocab DRIFT guard: every routing term actually routes.

describe('vocabulary — structural invariants', () => {
  it('covers exactly the eight app skills, each with a non-empty vocabulary', () => {
    expect(APP_VOCAB_SKILL_IDS.length).toBe(8)
    for (const id of APP_VOCAB_SKILL_IDS) {
      expect(SKILL_VOCABULARY[id]?.length ?? 0).toBeGreaterThan(0)
    }
    // No stray keys beyond the declared eight.
    expect(Object.keys(SKILL_VOCABULARY).sort()).toEqual([...APP_VOCAB_SKILL_IDS].sort())
  })

  it('every entry is well-formed (whitespace ⟺ phrase, no dupes) and every offer term is scorer-matchable', () => {
    for (const id of APP_VOCAB_SKILL_IDS) {
      const seen = new Set<string>()
      for (const e of SKILL_VOCABULARY[id]) {
        const term = e.term.trim().toLowerCase()
        expect(term.length, `${id}: empty term`).toBeGreaterThan(0)
        expect(e.term, `${id}: term not trimmed`).toBe(e.term.trim())
        // No duplicate term within a skill (case-insensitive).
        expect(seen.has(term), `${id}: duplicate term "${term}"`).toBe(false)
        seen.add(term)
        // The ONE structural rule: a multi-word term MUST be a phrase, and a single token must NOT be
        // (it is 'word' for boundary matching or 'stem' for German compound substring). `match` drives
        // ROUTE only — the suggestion scorer word/phrase-infers from the term shape itself, independently.
        const hasSpace = /\s/.test(e.term)
        expect(e.match === 'phrase', `${id}: "${term}" phrase⇔whitespace mismatch`).toBe(hasSpace)
        expect(deriveMatch(e.term), `${id}: deriveMatch sanity`).toBe(hasSpace ? 'phrase' : 'word')
        // A `suggest|both` term must be matchable by the SCORER when it appears as a standalone token —
        // otherwise it is a dead offer keyword. (`countKeywordHits` word/phrase-infers exactly as the
        // scorer does, so this is the offer-side liveness guard the parity/route tests don't cover.)
        if (e.use === 'suggest' || e.use === 'both') {
          expect(countKeywordHits([e.term], `bitte ${e.term} jetzt`), `${id}: "${term}" never offers`).toBe(1)
        }
      }
    }
  })
})

describe('entryMatches / routeMatch — word-boundary vs substring', () => {
  const wordEntry = (term: string): VocabEntry => ({ term, lang: 'en', match: 'word', use: 'route' })
  const phraseEntry = (term: string): VocabEntry => ({ term, lang: 'en', match: 'phrase', use: 'route' })
  const stemEntry = (term: string): VocabEntry => ({ term, lang: 'de', match: 'stem', use: 'route' })

  it('a WORD entry is boundary-matched (never a substring inside a longer word)', () => {
    expect(entryMatches(wordEntry('net'), 'what is my net income')).toBe(true)
    expect(entryMatches(wordEntry('net'), 'cancel my netflix abo')).toBe(false)
    expect(entryMatches(wordEntry('tax'), 'the tax is due')).toBe(true)
    expect(entryMatches(wordEntry('tax'), 'the syntax of this')).toBe(false)
  })

  it('a PHRASE entry is substring-matched', () => {
    expect(entryMatches(phraseEntry('safe to share'), 'is this safe to share?')).toBe(true)
    expect(entryMatches(phraseEntry('safe to share'), 'is this safe?')).toBe(false)
  })

  it('a STEM entry is substring-matched (German inflections/compounds)', () => {
    expect(entryMatches(stemEntry('transaktion'), 'zeig mir die transaktionen')).toBe(true)
    expect(entryMatches(stemEntry('zusammenfass'), 'bitte zusammenfassen')).toBe(true)
  })

  it('the known substring reproductions do NOT route (Netflix→net, syntax→tax)', () => {
    expect(routeMatch('bank-statement', 'Wie kündige ich mein Netflix-Abo?')).toBe(false)
    expect(routeMatch('invoice', 'Explain the syntax of this formula')).toBe(false)
    // …and the flagship under-fire now DOES route.
    expect(routeMatch('meeting-protocol', 'Summarize this meeting')).toBe(true)
    // off-topic stays off.
    expect(routeMatch('bank-statement', 'what is the weather today?')).toBe(false)
    expect(routeMatch('invoice', 'tell me a joke')).toBe(false)
  })
})

describe('route-term liveness — every declared routing term self-matches', () => {
  // For every skill, EACH `route|both` term, a synthetic question embedding it matches `routeMatch`. This
  // is a LIVENESS check (no dead/typo'd route term, and the word/phrase/stem match type actually fires on
  // the term) — NOT an end-to-end handler test: the two OTHER guards cover wiring. (1) The routing gates
  // call `routeMatch(skillId: SkillVocabId, …)`, so a handler wired to the WRONG skill id is a COMPILE
  // error. (2) The per-handler integration tests (`skills-analysis-{bank,invoice,redaction,whole-doc}.test.ts`)
  // drive the REAL `applies()`/`intends()` with representative EN+DE questions, so a mis-wired gate reddens
  // there (verified: mutating redaction's gate to another skill fails those). Here we only pin term liveness.
  for (const id of APP_VOCAB_SKILL_IDS) {
    it(`${id}: all ${routeEntries(id).length} route terms match a question containing them`, () => {
      for (const e of routeEntries(id)) {
        const q = `bitte ${e.term} jetzt` // wrap so a word entry sees clean boundaries
        expect(routeMatch(id, q), `${id}: route term "${e.term}" did not route`).toBe(true)
      }
    })
  }
})

describe('suggest↔route derivation', () => {
  it('suggestTerms are exactly the `suggest|both` terms (the manifest parity contract source)', () => {
    for (const id of APP_VOCAB_SKILL_IDS) {
      const expected = SKILL_VOCABULARY[id]
        .filter((e) => e.use === 'suggest' || e.use === 'both')
        .map((e) => e.term)
      expect(suggestTerms(id)).toEqual(expected)
    }
  })

  it('unknown skill ids yield empty term/entry lists (never throw)', () => {
    expect(suggestTerms('no-such-skill')).toEqual([])
    expect(routeEntries('no-such-skill')).toEqual([])
    // `routeMatch` is compile-guarded to `SkillVocabId`; the cast checks the runtime stays robust (false,
    // not a throw) if an out-of-union id ever reaches it defensively.
    expect(routeMatch('no-such-skill' as SkillVocabId, 'anything at all')).toBe(false)
  })
})
