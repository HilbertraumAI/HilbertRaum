import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectSuggestion } from '../../src/main/services/skills/selector'
import {
  loadCorpus,
  loadSkillCandidates,
  toContext,
  toAutoFireContext,
  predict,
  scoreCorpus,
  runBaseline,
  formatReport,
  POLICIES,
  type CorpusItem
} from './skill-triggers'

// Skills S13a — the offline trigger-evaluation harness over a labelled SYNTHETIC corpus
// (skills-s13-plan.md §3). This runs as a MEASUREMENT, not yet a hard gate-assertion: it pins the
// harness's CORRECTNESS (it agrees with the real selector, it is deterministic, its metrics are
// well-formed, it never logs a question) and PRINTS the baseline for the owner to ratify D1/D2. The
// precision-bar assertion is deliberately NOT added here — it lands in S13b once the owner sets D1.

const LABEL_SPACE = new Set([
  'bank-statement',
  'invoice',
  'meeting-protocol',
  'contract-brief',
  'share-safe-review',
  'deadline-obligation-finder',
  'what-changed',
  'document-redaction',
  'document-edit',
  'none'
])

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S13a corpus + candidates are well-formed', () => {
  it('loads a non-trivial corpus whose every label is in the app-skill label space', () => {
    const corpus = loadCorpus()
    expect(corpus.length).toBeGreaterThanOrEqual(80) // W5: expanded to all 8 skills + confusion pairs
    const ids = new Set(corpus.map((c) => c.id))
    expect(ids.size).toBe(corpus.length) // ids are unique
    for (const item of corpus) {
      expect(item.question.length).toBeGreaterThan(0)
      expect(LABEL_SPACE.has(item.expected)).toBe(true)
      expect(Array.isArray(item.inScopeDocs)).toBe(true)
    }
    // The corpus must actually exercise the hard cases (skills-s13-plan.md §3.1 / W5): some 'none's WITH a
    // doc in scope (lone-doc-signal traps), keyword-only true positives, and cross-skill confusion pairs.
    expect(corpus.some((c) => c.expected === 'none' && c.inScopeDocs.length > 0)).toBe(true)
    expect(corpus.some((c) => c.expected !== 'none' && c.inScopeDocs.length === 0)).toBe(true)
    expect(corpus.filter((c) => c.expected !== 'none').length).toBeGreaterThan(0)
    expect(corpus.filter((c) => c.expected === 'none').length).toBeGreaterThan(0)
    // W5: every one of the 8 skills has ≥1 labelled true positive (the corpus covers the whole space).
    for (const id of loadSkillCandidates().map((c) => c.installId)) {
      expect(corpus.some((c) => c.expected === id)).toBe(true)
    }
    // W5: a non-trivial confusion set (the fired-wrong-0 bar below would be vacuous otherwise).
    expect(corpus.filter((c) => c.confusion).length).toBeGreaterThanOrEqual(6)
  })

  it('loads exactly the nine real app skills as candidates', () => {
    const candidates = loadSkillCandidates()
    expect(candidates.map((c) => c.installId).sort()).toEqual([
      'bank-statement',
      'contract-brief',
      'deadline-obligation-finder',
      'document-edit',
      'document-redaction',
      'invoice',
      'meeting-protocol',
      'share-safe-review',
      'what-changed'
    ])
    for (const c of candidates) expect(c.triggers.keywords.length).toBeGreaterThan(0)
  })
})

describe('S13a harness is faithful to the real selector + deterministic', () => {
  it('the keyword-required policy reproduces selectSuggestion EXACTLY for every turn (W5)', () => {
    // W5 (audit §4.2): the RUNTIME suggestion gate now REQUIRES a keyword hit (a lone doc signal never
    // fires) — i.e. the harness `keyword-required` policy IS `selectSuggestion`, not the old `threshold-2`.
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const kwReq = POLICIES.find((p) => p.name === 'keyword-required')!
    for (const item of corpus) {
      const ctx = toContext(item)
      const viaHarness = predict(candidates, ctx, kwReq)
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
    // non-increasing across threshold-2 → threshold-3 → threshold-4. Measured on the FULL doc signals
    // (forceFullSignals) so this is a pure BAR comparison — threshold-3's U4/§4.4 auto-fire narrowing is
    // a different axis (it can only DROP fires further) and is asserted by the auto-fire gate below.
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const wrong = (name: string) =>
      scoreCorpus(corpus, candidates, POLICIES.find((p) => p.name === name)!, { forceFullSignals: true })
        .confusion.firedWrong
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
    expect(out).toContain('Skills trigger baseline')
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

// W5 gate (audit §4.2/§8.3) — the SUGGESTION surface users actually see now has an asserted precision bar.
// The shipping suggestion policy is `keyword-required` (≡ runtime `selectSuggestion`, W5): a keyword hit is
// mandatory, doc signals only corroborate. Two bars: (1) precision ≥ 0.95 OVERALL on the whole corpus, and
// (2) ZERO wrong fires on the cross-skill CONFUSION set (word-boundary discrimination must be exact where
// two skills compete). The plan's stated floor was 0.80; the MEASURED value on the U4-expanded 90-item /
// 8-skill corpus is 0.984 (63 fired-correct, 1 fired-wrong = the documented adv-meeting-schedule ceiling;
// printed by the baseline test above and recorded in BUILD_STATE). We gate at 0.95 — matching the auto-fire
// bar — so a broad precision regression on the non-confusion majority reddens CI instead of sliding to 0.80.
describe('W5 gate — the suggestion policy clears the precision bar (§4.2/§8.3)', () => {
  it('keyword-required: precision ≥ 0.95 overall AND fired-wrong == 0 on the confusion pairs', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const kwReq = POLICIES.find((p) => p.name === 'keyword-required')!

    // (1) Overall precision gate over the whole corpus (measured 0.983; floored at 0.95, the auto-fire bar).
    const overall = scoreCorpus(corpus, candidates, kwReq)
    expect(overall.confusion.firedCorrect).toBeGreaterThan(0)
    expect(overall.precision).not.toBeNull()
    expect(overall.precision!).toBeGreaterThanOrEqual(0.95)

    // (2) The confusion subset must fire NOTHING wrong (the word-boundary discrimination bar).
    const confusion = corpus.filter((c) => c.confusion)
    expect(confusion.length).toBeGreaterThanOrEqual(6) // non-vacuous
    const confusionResult = scoreCorpus(confusion, candidates, kwReq)
    expect(confusionResult.confusion.firedWrong).toBe(0)
    // …and every confusion pair actually fires its expected skill (recall on the set is total).
    expect(confusionResult.confusion.missed).toBe(0)
  })

  it('the known substring reproductions no longer fire (Netflix→net, in-10-minutes→meeting, etc.)', () => {
    const corpus = loadCorpus()
    const candidates = loadSkillCandidates()
    const kwReq = POLICIES.find((p) => p.name === 'keyword-required')!
    // These historical over-fires must all predict 'none' now (word-boundary + route-only rebinding).
    for (const id of ['adv-net-netflix-01', 'adv-minutes-10-01', 'adv-syntax-tax-01', 'adv-bill-01', 'adv-datenschutz-01']) {
      const item = corpus.find((c) => c.id === id)
      expect(item, `corpus item ${id} present`).toBeDefined()
      expect(predict(candidates, toContext(item!), kwReq)).toBe('none')
    }
  })
})

// U4 gate (audit §2.4/§4.4) — the auto-fire EXPANSION proof. Bank/invoice/meeting-protocol are now
// autoFire-eligible (the setting is still default-off), so the auto-fire gate (threshold-3) must hold on
// the EXPANDED corpus INCLUDING whole-corpus scope shapes: the doc-signal narrowing (a Library doc that is
// not explicitly selected contributes nothing) must prevent the "keyword + any matching PDF anywhere"
// misfire while strong keyword intent still fires.
describe('U4 gate — narrowed auto-fire signals + skill opt-ins (§2.4/§4.4)', () => {
  const corpus = loadCorpus()
  const candidates = loadSkillCandidates()
  const t3 = POLICIES.find((p) => p.name === 'threshold-3')!
  const kwReq = POLICIES.find((p) => p.name === 'keyword-required')!
  const item = (id: string): CorpusItem => {
    const it = corpus.find((c) => c.id === id)
    expect(it, `corpus item ${id} present`).toBeDefined()
    return it!
  }

  it('the corpus actually exercises whole-corpus scope shapes (non-vacuous)', () => {
    const wc = corpus.filter((c) => c.scope === 'whole-corpus')
    expect(wc.length).toBeGreaterThanOrEqual(5)
    // …and at least one whole-corpus item that WOULD auto-fire on full signals (so the narrowing below
    // has something to actually suppress — the assertion isn't vacuous).
    expect(wc.some((c) => predict(candidates, toContext(c), t3) !== 'none')).toBe(true)
  })

  it('a whole-corpus doc signal is narrowed away for auto-fire but kept for the suggestion offer', () => {
    // The §4.4 trap: a SINGLE keyword + a matching PDF merely present in the Library. The inert offer
    // still fires (full scope), but auto-fire must NOT — the doc is not explicitly in front of the skill.
    for (const id of ['wc-bank-weak-01', 'wc-invoice-weak-01', 'wc-meeting-weak-01']) {
      const it = item(id)
      expect(predict(candidates, toContext(it), kwReq), `${id}: suggestion offers`).toBe(it.expected)
      expect(predict(candidates, toContext(it), t3), `${id}: WOULD fire on full signals`).toBe(it.expected)
      expect(predict(candidates, toAutoFireContext(it), t3), `${id}: narrowed → no auto-fire`).toBe('none')
    }
  })

  it('the SAME meeting question auto-fires once the doc is explicitly in scope (§2.4 fix)', () => {
    // wc-meeting-weak-01 (library only) does NOT auto-fire; wc-meeting-attached-01 (attached / hand-picked)
    // DOES — the narrowing keys on WHETHER the user put the doc in front of the skill, not on the words.
    expect(predict(candidates, toAutoFireContext(item('wc-meeting-weak-01')), t3)).toBe('none')
    expect(predict(candidates, toAutoFireContext(item('wc-meeting-attached-01')), t3)).toBe('meeting-protocol')
  })

  it('strong keyword intent still auto-fires at whole-corpus scope (narrowing removes only doc corroboration)', () => {
    // Two distinct keywords reach the ≥3 bar on words alone, so no explicit doc is required.
    expect(predict(candidates, toAutoFireContext(item('wc-bank-strong-01')), t3)).toBe('bank-statement')
    expect(predict(candidates, toAutoFireContext(item('wc-invoice-strong-01')), t3)).toBe('invoice')
  })

  it('the audit example never fires either path — dsgvo dropped AND the library doc narrowed away', () => {
    const it = item('wc-dsgvo-libdoc-01') // "Was regelt die DSGVO?" + a privacy PDF in the Library
    expect(predict(candidates, toContext(it), kwReq), 'no suggestion offer').toBe('none')
    expect(predict(candidates, toAutoFireContext(it), t3), 'no auto-fire').toBe('none')
  })

  it('threshold-3 holds fired-wrong==0 AND precision ≥ 0.95 over the WHOLE-CORPUS subset', () => {
    // The plan's explicit bar: the auto-fire gate must survive the whole-corpus shapes specifically.
    const wc = corpus.filter((c) => c.scope === 'whole-corpus')
    const result = scoreCorpus(wc, candidates, t3) // scoreCorpus narrows for threshold-3
    expect(result.confusion.firedWrong).toBe(0)
    expect(result.confusion.firedCorrect).toBeGreaterThan(0)
    expect(result.precision).not.toBeNull()
    expect(result.precision!).toBeGreaterThanOrEqual(0.95)
  })
})
