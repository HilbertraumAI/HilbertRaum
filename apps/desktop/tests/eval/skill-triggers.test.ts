import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectSuggestion } from '../../src/main/services/skills/selector'
import {
  loadCorpus,
  loadSkillCandidates,
  toContext,
  predict,
  scoreCorpus,
  runBaseline,
  formatReport,
  POLICIES
} from './skill-triggers'

// Skills S13a — the offline trigger-evaluation harness over a labelled SYNTHETIC corpus
// (skills-s13-plan.md §3). This runs as a MEASUREMENT, not yet a hard gate-assertion: it pins the
// harness's CORRECTNESS (it agrees with the real selector, it is deterministic, its metrics are
// well-formed, it never logs a question) and PRINTS the baseline for the owner to ratify D1/D2. The
// precision-bar assertion is deliberately NOT added here — it lands in S13b once the owner sets D1.

const LABEL_SPACE = new Set(['bank-statement', 'invoice', 'meeting-protocol', 'document-redaction', 'none'])

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S13a corpus + candidates are well-formed', () => {
  it('loads a non-trivial corpus whose every label is in the app-skill label space', () => {
    const corpus = loadCorpus()
    expect(corpus.length).toBeGreaterThanOrEqual(20)
    const ids = new Set(corpus.map((c) => c.id))
    expect(ids.size).toBe(corpus.length) // ids are unique
    for (const item of corpus) {
      expect(item.question.length).toBeGreaterThan(0)
      expect(LABEL_SPACE.has(item.expected)).toBe(true)
      expect(Array.isArray(item.inScopeDocs)).toBe(true)
    }
    // The corpus must actually exercise the hard cases (skills-s13-plan.md §3.1): some 'none's WITH a
    // doc in scope (lone-doc-signal traps) and some keyword-only true positives.
    expect(corpus.some((c) => c.expected === 'none' && c.inScopeDocs.length > 0)).toBe(true)
    expect(corpus.some((c) => c.expected !== 'none' && c.inScopeDocs.length === 0)).toBe(true)
    expect(corpus.filter((c) => c.expected !== 'none').length).toBeGreaterThan(0)
    expect(corpus.filter((c) => c.expected === 'none').length).toBeGreaterThan(0)
  })

  it('loads exactly the four real app skills as candidates', () => {
    const candidates = loadSkillCandidates()
    expect(candidates.map((c) => c.installId).sort()).toEqual([
      'bank-statement',
      'document-redaction',
      'invoice',
      'meeting-protocol'
    ])
    for (const c of candidates) expect(c.triggers.keywords.length).toBeGreaterThan(0)
  })
})

describe('S13a harness is faithful to the real selector + deterministic', () => {
  it('threshold-2 reproduces selectSuggestion EXACTLY for every turn', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const t2 = POLICIES.find((p) => p.name === 'threshold-2')!
    for (const item of corpus) {
      const ctx = toContext(item)
      const viaHarness = predict(candidates, ctx, t2)
      const viaSelector = selectSuggestion(candidates, ctx)
      const selectorId = viaSelector ? viaSelector.installId : 'none'
      expect(viaHarness).toBe(selectorId)
    }
  })

  it('is deterministic — scoring the corpus twice yields identical results', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    for (const policy of POLICIES) {
      const a = scoreCorpus(corpus, candidates, policy)
      const b = scoreCorpus(corpus, candidates, policy)
      expect(a).toEqual(b)
    }
  })

  it('produces well-formed metrics (counts sum to the corpus; rates in [0,1])', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    for (const r of runBaseline(corpus, candidates)) {
      const c = r.confusion
      expect(c.firedCorrect + c.firedWrong + c.missed + c.correctlyAbstained).toBe(corpus.length)
      for (const v of [r.precision, r.recall]) {
        if (v != null) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('a stricter bar never increases fired-wrong (monotone precision pressure)', () => {
    // Sanity on the sweep itself: raising the gate can only DROP fires, so false fires are
    // non-increasing across threshold-2 → threshold-3 → threshold-4.
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const wrong = (name: string) => scoreCorpus(corpus, candidates, POLICIES.find((p) => p.name === name)!).confusion.firedWrong
    expect(wrong('threshold-3')).toBeLessThanOrEqual(wrong('threshold-2'))
    expect(wrong('threshold-4')).toBeLessThanOrEqual(wrong('threshold-3'))
  })
})

describe('S13a privacy — the harness scores questions but never logs them (§6)', () => {
  it('emits no corpus question text to any console stream when the baseline runs + prints', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    let out = ''
    try {
      const results = runBaseline(corpus, candidates)
      console.log(formatReport(results, corpus.length)) // the report we transcribe into §3.3
    } finally {
      for (const s of spies) {
        for (const call of s.mock.calls) out += call.map((a) => String(a)).join(' ') + '\n'
        s.mockRestore()
      }
    }
    // Not one corpus question may appear in anything written to the console.
    for (const item of corpus) expect(out).not.toContain(item.question)
    // …and the report we DID print is non-empty (so the assertion above isn't vacuous).
    expect(out).toContain('Skills S13a baseline')
  })
})

// MEASUREMENT: print the baseline so `npm test` surfaces the numbers (still transcribed into
// skills-s13-plan.md §3.3). KEPT as a measurement — the hard gate-assertion lives in its own block
// below so the printout survives even if the bar regresses.
describe('S13a baseline — measured (recorded in skills-s13-plan.md §3.3)', () => {
  it('prints the precision/recall/confusion sweep', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const results = runBaseline(corpus, candidates)
    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(results, corpus.length) + '\n')
    expect(results.length).toBe(POLICIES.length)
  })
})

// S13b — the HARD GATE (owner-set form, skills-s13-plan.md §2.1): the ratified auto-fire policy
// (`threshold-3` ≡ AUTOFIRE_SCORE_THRESHOLD) must clear D1 on the corpus. Asserted as
// `fired-wrong == 0 AND precision ≥ 0.95` (NOT a brittle `== 100%`) so it survives corpus growth.
// Any change to `scoreSkillTriggers` or the threshold now re-runs this and fails if it regresses
// the precision bar — the harness is the ship gate the plan promised.
describe('S13b gate — the auto-fire policy clears the ratified D1 precision bar', () => {
  it('threshold-3 (AUTOFIRE_SCORE_THRESHOLD) fires nothing wrong AND precision ≥ 0.95 (D1)', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const t3 = POLICIES.find((p) => p.name === 'threshold-3')!
    const result = scoreCorpus(corpus, candidates, t3)
    // A false fire is the costly event D1 is set against — there must be none on the corpus.
    expect(result.confusion.firedWrong).toBe(0)
    // And precision must clear the ratified ≥ 95% bar (it actually fired ≥ once, so precision != null).
    expect(result.confusion.firedCorrect).toBeGreaterThan(0)
    expect(result.precision).not.toBeNull()
    expect(result.precision!).toBeGreaterThanOrEqual(0.95)
  })
})
