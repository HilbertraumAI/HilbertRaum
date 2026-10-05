import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listSkills } from '../../src/main/services/skills/registry'
import { APP_VOCAB_SKILL_IDS } from '../../src/main/services/skills/vocabulary'
import {
  loadCorpus,
  openTriggerHarness,
  scoreCorpus,
  formatReport,
  type CorpusItem,
  type TriggerHarness
} from './skill-triggers'

// Skills S13 — the trigger-evaluation harness over a labelled SYNTHETIC corpus (skills-s13-plan.md §3).
// Every row runs through the PRODUCTION paths on one real database with the committed app-skills/
// reconciled: the inert suggestion offer (`suggestSkillsForTurn`) and the silent auto-fire decision
// (`resolveAutoFireSkill`). This file owns the per-skill offer recall (EN/DE), the precision bars and the
// auto-fire bar over the real manifests; the pure scoring mechanics live in skills-selector.test.ts and
// skills-autofire.test.ts. A question is CONTENT: it is scored here and never logged.

/** Every app skill the vocabulary knows, plus the "nothing fires" label. */
const LABEL_SPACE = new Set<string>([...APP_VOCAB_SKILL_IDS, 'none'])

/**
 * Rows whose production OFFER differs from the label (id → what production offers today). An entry is a
 * documented deviation, not a pass: when a row is fixed its entry must be REMOVED (a stale entry fails).
 *  - tp-redaction-en-02: the vocabulary only knows the exact phrase "remove personal data", and U4 dropped
 *    the legal word "gdpr", so "Remove all personal data for GDPR compliance." offers nothing (#583).
 *  - adv-meeting-schedule-01: a scheduling question that merely names a meeting still offers
 *    meeting-protocol — the documented precision ceiling of a one-keyword offer.
 */
const KNOWN_SUGGESTION_DEVIATIONS: Record<string, string> = {
  'tp-redaction-en-02': 'none',
  'adv-meeting-schedule-01': 'meeting-protocol'
}

/**
 * Rows whose production AUTO-FIRE applies a different skill than the label (id → the skill it fires).
 * `sensible daten` is a keyword of BOTH share-safe-review and document-redaction, and only redaction is
 * auto-fire-eligible, so these two share-safe rows fire redaction's read-only scan. Accepted by the owner;
 * a fixed row must be REMOVED from this map.
 */
const KNOWN_AUTOFIRE_DEVIATIONS: Record<string, string> = {
  'tp-sharesafe-de-01': 'document-redaction',
  'tp-sharesafe-de-02': 'document-redaction'
}

let harness: TriggerHarness
const corpus = loadCorpus()
const byId = (id: string): CorpusItem => {
  const row = corpus.find((c) => c.id === id)
  expect(row, `corpus item ${id} present`).toBeDefined()
  return row!
}

beforeAll(() => {
  harness = openTriggerHarness()
})
afterAll(() => {
  harness.close()
})

describe('S13 corpus is well-formed', () => {
  it('loads a non-trivial corpus whose every label is in the app-skill label space', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(80) // W5: expanded to all skills + confusion pairs
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
    expect(corpus.filter((c) => c.expected === 'none').length).toBeGreaterThan(0)
    // W5: every app skill has ≥1 labelled true positive (the corpus covers the whole space).
    for (const id of APP_VOCAB_SKILL_IDS) expect(corpus.some((c) => c.expected === id)).toBe(true)
    // W5: a non-trivial confusion set (the fired-wrong-0 bar below would be vacuous otherwise).
    expect(corpus.filter((c) => c.confusion).length).toBeGreaterThanOrEqual(6)
    // U4: the whole-corpus scope shape is exercised (the narrowing the auto-fire path relies on).
    expect(corpus.filter((c) => c.scope === 'whole-corpus').length).toBeGreaterThanOrEqual(5)
  })

  it('reconciles exactly the real app skills, each with trigger keywords', () => {
    const apps = listSkills(harness.db).filter((s) => s.source === 'app')
    expect(apps.map((s) => s.id).sort()).toEqual([...APP_VOCAB_SKILL_IDS].sort())
    for (const s of apps) expect(s.manifest.triggers.keywords.length).toBeGreaterThan(0)
  })

  it('every deviation key names a corpus row (a removed row cannot leave a stale entry)', () => {
    const ids = new Set(corpus.map((c) => c.id))
    for (const id of [...Object.keys(KNOWN_SUGGESTION_DEVIATIONS), ...Object.keys(KNOWN_AUTOFIRE_DEVIATIONS)]) {
      expect(ids.has(id), `deviation key ${id} names a corpus row`).toBe(true)
    }
  })
})

// The recall gate AND the per-row precision gate: every row must give its expected offer, except the
// listed deviations. A new miss or false offer goes red with the row id in the title; a FIXED deviation
// goes red too (its entry is stale and must be removed).
describe('suggestion — every corpus row gives its expected offer (production suggestSkillsForTurn)', () => {
  const rows = corpus.map((row) => ({ row, id: row.id, want: KNOWN_SUGGESTION_DEVIATIONS[row.id] ?? row.expected }))
  it.each(rows)('$id offers $want', ({ row, want }) => {
    expect(harness.offerFor(row)).toBe(want)
  })
})

// S13b — the HARD GATE (owner-set form, architecture.md §18 ratified contract): the production auto-fire
// decision must clear D1 on the corpus. A MISS is fine (the inert offer is the fallback); firing a
// DIFFERENT skill than the label — or firing at all where the label is 'none' — is a wrong fire. The two
// accepted deviations must fire exactly the listed skill; any other row's outcome is its label or nothing.
// It first prints the two production paths' aggregates (recorded in architecture.md §18) — metrics and
// confusion only, NO question text — so the numbers surface even when a bar below regresses.
describe('S13b gate — production auto-fire clears the ratified D1 precision bar', () => {
  it('fires nothing wrong AND precision ≥ 0.95; deviation rows fire exactly the listed skill', () => {
    const gateSet = corpus.filter((c) => !(c.id in KNOWN_AUTOFIRE_DEVIATIONS))
    const result = scoreCorpus(gateSet, (r) => harness.autoFireFor(r), 'auto-fire (gate)', 'resolveAutoFireSkill, rows minus the accepted deviations (the gate set)')
    const report = [
      scoreCorpus(corpus, (r) => harness.offerFor(r), 'suggestion', 'suggestSkillsForTurn, all rows'),
      result,
      scoreCorpus(corpus, (r) => harness.autoFireFor(r), 'auto-fire (deviations wrong)', 'resolveAutoFireSkill, all rows — the accepted deviations counted as wrong fires')
    ]
    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(report, corpus.length) + '\n')

    for (const [id, fires] of Object.entries(KNOWN_AUTOFIRE_DEVIATIONS)) {
      expect(harness.autoFireFor(byId(id)), `${id}: accepted deviation still fires ${fires}`).toBe(fires)
    }
    const wrongIds = result.perItem.filter((p) => p.predicted !== 'none' && p.predicted !== p.expected).map((p) => p.id)
    expect(wrongIds).toEqual([])
    expect(result.confusion.firedCorrect).toBeGreaterThan(0)
    // The ratified D1 wording; with zero wrong fires above, precision is 1 by construction.
    expect(result.precision).not.toBeNull()
    expect(result.precision!).toBeGreaterThanOrEqual(0.95)
  })

  it('never auto-fires on a document that is merely in the Library (U4 narrowing, #130 doc-signal gate)', () => {
    // A whole-corpus doc is not an explicit selection, so it lends auto-fire no corroboration: these rows
    // must abstain even when their label is a skill (dropping the narrowing or the doc-signal gate makes
    // them fire their CORRECT label, which the wrong-fire gate above cannot see).
    const fired = corpus.filter((c) => c.scope === 'whole-corpus' && harness.autoFireFor(c) !== 'none').map((c) => c.id)
    expect(fired).toEqual([])
  })
})

// W5 gate (audit §4.2/§8.3) — the SUGGESTION surface users actually see has an asserted precision bar: a
// keyword hit is mandatory, doc signals only corroborate. Two bars: (1) precision ≥ 0.95 OVERALL on the
// whole corpus (matching the auto-fire bar, so a broad regression on the non-confusion majority reddens CI),
// and (2) ZERO wrong fires and ZERO misses on the cross-skill CONFUSION set. Recomputed from the production
// offer. The per-row table above pins every single row; these bars stay as the BOUND on the deviation map
// (no confusion row may become a deviation, and the wrong-offer deviations cannot grow past the 0.95 bar).
describe('W5 gate — the suggestion policy clears the precision bar (§4.2/§8.3)', () => {
  it('precision ≥ 0.95 overall AND fired-wrong == 0 and missed == 0 on the confusion pairs', () => {
    const overall = scoreCorpus(corpus, (r) => harness.offerFor(r), 'suggestion', 'overall')
    expect(overall.confusion.firedCorrect).toBeGreaterThan(0)
    expect(overall.precision).not.toBeNull()
    expect(overall.precision!).toBeGreaterThanOrEqual(0.95)

    const confusionRows = corpus.filter((c) => c.confusion)
    expect(confusionRows.length).toBeGreaterThanOrEqual(6) // non-vacuous
    const confusion = scoreCorpus(confusionRows, (r) => harness.offerFor(r), 'suggestion', 'confusion')
    expect(confusion.confusion.firedWrong).toBe(0)
    expect(confusion.confusion.missed).toBe(0)
    expect(confusion.confusion.firedCorrect).toBeGreaterThan(0)
  })
})

// U4 gate (audit §2.4/§4.4) — bank/invoice/meeting-protocol are autoFire-eligible (the setting is still
// default-off). The same meeting question auto-fires once the doc is EXPLICITLY in scope; the whole-corpus
// siblings (a Library-style collection doc, not selected) still get the offer (per-row table) and never
// auto-fire (the Library-abstention test in the S13b block).
describe('U4 gate — explicit scope auto-fires (§2.4)', () => {
  it('wc-meeting-attached-01 (explicitly in scope) auto-fires meeting-protocol', () => {
    expect(harness.autoFireFor(byId('wc-meeting-attached-01'))).toBe('meeting-protocol')
  })
})
