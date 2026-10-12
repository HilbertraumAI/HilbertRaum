import { describe, it, expect } from 'vitest'
import {
  isAggregationShaped,
  routeQuestion,
  mapQuestionToRecordType,
  type RouteInput
} from '../../src/main/services/analysis/router'
import { isClassificationTrigger } from '../../src/main/services/analysis/classify'
import { parseExtraction } from '../../src/main/services/analysis/extract'

// Whole-document-analysis Phase 3 (plan §4.2/§4.4, §7): the PURE task router (classification +
// precedence + low-confidence→relevance + open-vocab→type mapping, EN+DE) and the tolerant
// JSON-array parse for the extract pass. No DB, no model.

describe('routeQuestion — coverage-extract classification', () => {
  const base = { treeAvailable: false, extractAvailable: true, documentCount: 1 }

  it('routes "list every X" / "how many" to coverage-extract, never relevance', () => {
    for (const q of [
      'list every deadline',
      'enumerate all the parties',
      'how many payments are there?',
      'count the obligations'
    ]) {
      const d = routeQuestion({ ...base, question: q })
      expect(d.engine).toBe('coverage-extract')
    }
  })

  it('classifies German coverage triggers (jede / alle / wie viele / sämtliche)', () => {
    for (const q of ['liste alle Fristen', 'wie viele Parteien', 'sämtliche Pflichten auflisten']) {
      expect(routeQuestion({ ...base, question: q }).engine).toBe('coverage-extract')
    }
  })

  it('maps the open-vocabulary {X} to the closed extract type (EN + DE), default generic', () => {
    expect(mapQuestionToRecordType('list every deadline')).toBe('date')
    expect(mapQuestionToRecordType('what are the fees and costs')).toBe('amount')
    expect(mapQuestionToRecordType('who are the parties')).toBe('party')
    expect(mapQuestionToRecordType('list all obligations and clauses')).toBe('obligation')
    expect(mapQuestionToRecordType('liste alle Fristen')).toBe('date')
    expect(mapQuestionToRecordType('alle Beträge')).toBe('amount')
    expect(mapQuestionToRecordType('wer sind die Parteien')).toBe('party')
    expect(mapQuestionToRecordType('list everything important')).toBe('generic')
  })

  it('falls back to relevance (low confidence) when no extract data exists — never a false complete', () => {
    const d = routeQuestion({ ...base, extractAvailable: false, question: 'list every date' })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('low')
  })

  // Issue #37: aggregation/categorization questions are whole-document tasks by nature — no
  // top-k short of "all chunks" yields a correct per-category sum. They must classify as
  // coverage, EN and DE, including the exact phrasing from the incident (which carries NO
  // list/count trigger word at all).
  it('routes aggregation/categorization verbs to coverage-extract (#37) — EN + DE', () => {
    for (const q of [
      'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf', // the #37 repro, verbatim
      'gruppiere die Ausgaben nach Monat',
      'summiere die Beträge',
      'schlüssle die Ausgaben nach Kategorie auf',
      'eine Aufschlüsselung der Kosten bitte',
      'categorize the expenses',
      'group by vendor and total per month',
      'give me a breakdown of the costs',
      'sum per category please'
    ]) {
      const d = routeQuestion({ ...base, question: q })
      expect(d.engine, q).toBe('coverage-extract')
      expect(d.confidence, q).toBe('high')
    }
  })

  it('an aggregation question WITHOUT extract data falls back marked fallback:"coverage" (#38 hint gate)', () => {
    const d = routeQuestion({
      ...base,
      extractAvailable: false,
      question: 'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf'
    })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('low')
    expect(d.fallback).toBe('coverage')
  })

  it('the compare fallback is marked fallback:"compare", ordinary questions carry no fallback', () => {
    expect(
      routeQuestion({
        question: 'what is the difference here',
        documentCount: 1,
        treeAvailable: false,
        extractAvailable: false
      }).fallback
    ).toBe('compare')
    expect(
      routeQuestion({
        question: 'what does the contract say about termination?',
        documentCount: 1,
        treeAvailable: false,
        extractAvailable: false
      }).fallback
    ).toBeUndefined()
  })

  it('maps expense/income vocabulary to the amount type (EN + DE)', () => {
    expect(mapQuestionToRecordType('categorize the expenses')).toBe('amount')
    expect(mapQuestionToRecordType('kategorisiere die Ausgaben')).toBe('amount')
    expect(mapQuestionToRecordType('alle Einnahmen bitte')).toBe('amount')
  })
})

// full-audit 2026-07-10 BE-3: the German alternatives in COVERAGE_RE/SUMMARY_RE/COMPARE_RE were
// verb STEMS behind a trailing \b that only inflected forms could ever satisfy (auflist\b can
// never match "Auflistung"), and \büberblick sat an (ASCII-defined) \b before a non-ASCII
// initial — so realistic inflected German list/count/summary/compare phrasings silently missed
// their engines, the exact class issues #37/#38 were shipped to close. Table-driven: the DE rows
// all FAILED pre-fix; the EN controls pin byte-identical English behaviour; the aggregation row
// already worked (AGGREGATION_RE is the correct template the fix mirrors).
describe('routeQuestion — inflected German phrasings reach their engines (BE-3)', () => {
  // documentCount 2 + tree + extract available: every engine is reachable, so each row's engine
  // is decided purely by classification (precedence: compare > coverage > summary).
  const base = { documentCount: 2, treeAvailable: true, extractAvailable: true }

  it('classifies inflected German list/count, summary, and compare phrasings', () => {
    const rows: Array<[string, string]> = [
      // coverage: the stems must match their inflections
      ['Zähle die Ausgaben', 'coverage-extract'],
      ['Auflistung der Fristen', 'coverage-extract'],
      // #641: a typed {X} — an untyped list ask ("Aufzählen bitte") is no longer a coverage ask.
      ['Aufzählen der Fristen bitte', 'coverage-extract'],
      // summary: stem, the ü-initial word, and the separable-verb imperative
      ['Fasse das Dokument zusammen', 'tree-summary'],
      ['Zusammenfassung bitte', 'tree-summary'],
      ['Gib mir einen Überblick', 'tree-summary'],
      // compare: stems
      ['Vergleiche die beiden Verträge', 'compare'],
      ['Unterschiede zwischen den Verträgen', 'compare']
    ]
    for (const [q, engine] of rows) {
      const d = routeQuestion({ ...base, question: q })
      expect(d.engine, q).toBe(engine)
      expect(d.confidence, q).toBe('high')
    }
  })

  it('EN controls: English classification is byte-identical', () => {
    expect(routeQuestion({ ...base, question: 'List every deadline' }).engine).toBe('coverage-extract')
    expect(routeQuestion({ ...base, question: 'Summarize the whole document' }).engine).toBe('tree-summary')
    expect(routeQuestion({ ...base, question: 'Compare the two contracts' }).engine).toBe('compare')
  })

  it('DE control: the aggregation route (already correct pre-fix) keeps working', () => {
    expect(routeQuestion({ ...base, question: 'Kategorisiere die Ausgaben' }).engine).toBe('coverage-extract')
  })

  it('the LEADING stem boundary stays: "Erzähle" must not fire the zähl stem', () => {
    const d = routeQuestion({ ...base, question: 'Erzähle mir etwas über die Verträge' })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('high')
  })
})

// Issue #641: once a deep index existed, "Erkläre was in diesem Arztbrief steht inkl. aller
// Abkürzungen" was answered by the listing engine's item dump (0 model calls) instead of an
// explanation — the "aller" quantifier fired the plain list trigger, and the {X} no extract type
// covers defaulted to the `generic` table ("any other salient item", never a list of X). Every row
// below routed to coverage-extract pre-fix. Full-decision pins: LABELLED relevance (`partial`) with
// or without extract data — the answer may miss items, but no "build the deep index" hint promises a
// listing that could not answer the question; the #80 classification still runs (trigger b).
describe('routeQuestion — explain requests and untyped list asks never reach the listing (#641)', () => {
  const base = { documentCount: 1, treeAvailable: false }

  it.each([
    'Erkläre was in diesem Arztbrief steht inkl. aller Abkürzungen', // the #641 repro, verbatim
    'Explain what this letter says, including all the abbreviations',
    'Explain each abbreviation in this letter',
    'Was bedeuten alle Abkürzungen?',
    'Wofür stehen alle Abkürzungen?',
    'What do all the abbreviations stand for?',
    'Erklär mir jede Zahlung', // the bare imperative ends in "ä": no ASCII \b after it
    'Erläutere sämtliche Pflichten',
    'Was ist mit allen Fristen gemeint?',
    'Describe every payment in the contract',
    'What’s meant by every obligation?', // a typographic apostrophe (smart quotes)
    // untyped {X}: a list/count trigger alone is not a coverage ask
    'Liste alle Abkürzungen auf',
    'list all the abbreviations',
    'Wie viele Seiten hat der Brief?',
    'How many pages does the letter have?',
    // ('Does every employee get a bonus?' moved to the #644 yes/no table: a verdict, not a list.)
    // a question word or modal verb picks a list's type, but names nothing to list
    'Welche Abkürzungen muss ich kennen? Liste alle auf',
    'How many pages does the letter have and when was it written?'
  ])('%s → labelled relevance, with or without extract data', (question) => {
    for (const extractAvailable of [true, false]) {
      const decision = routeQuestion({ ...base, extractAvailable, question })
      expect(decision).toEqual({ engine: 'relevance', confidence: 'low', fallback: 'partial' })
      expect(isClassificationTrigger(decision, question)).toBe(true)
    }
  })

  // The suppression must stay narrow: these still reach the listing over extract data.
  it.each([
    ['Liste alle Erklärungen der Parteien auf', 'party'], // a noun (declarations), not "explain"
    ['Liste alle Fristen aus der Erklärung des Vermieters auf', 'date'], // the landlord's declaration
    ['List every payment with its description', 'amount'], // a noun as a list column
    ['Liste alle Fristen der Datenschutzerklärung auf', 'date'], // compound: no letter boundary
    ['Erkläre die Ausgaben pro Kategorie', 'amount'], // aggregation outranks explain (#37)
    ['categorize all the findings', 'generic'] // an aggregation ask keeps the generic default (#54)
  ] as const)('%s → coverage-extract (%s)', (question, recordType) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
      engine: 'coverage-extract',
      recordType,
      confidence: 'high'
    })
  })
})

// Issue #644: after #641 a quantifier still counted as a list request wherever it stood, so once a
// deep index with extract data existed "Gilt die Frist für alle Mieter?" got every date in the
// document, and without one the deep-index heads-up that promised that list. Rows marked "pre-fix"
// listed (or got the heads-up) on master; the controls listed before and must keep listing.
describe('routeQuestion — a quantifier is a list request only at the head of a request (#644)', () => {
  const base = { documentCount: 1, treeAvailable: false }

  it.each([
    'Gilt die Frist für alle Mieter?', // the #644 repro, verbatim
    'Is each payment due on the first of the month?', // the issue's EN example, verbatim
    'Sind alle Zahlungen pünktlich eingegangen?',
    'Müssen alle Parteien unterschreiben?',
    'Gibt es für jede Zahlung eine Quittung?',
    'Are all the payments due monthly?',
    'Has every party signed the contract?',
    'Was the deadline met for all the tenants?', // English "was" before a subject
    'Am I liable for all the costs?',
    'Does every employee get a bonus?', // #641 labelled it as untyped; it is a verdict
    // a list verb inside a yes/no question asks whether, not for the list
    'Does the contract list all the deadlines?',
    'Zählt jede Zahlung zur Miete?',
    'Is there a limit on how many payments can be late?',
    // a yes/no question embedded after a request
    'Can you tell me whether all the payments were on time?',
    'Kannst du mir sagen, ob alle Zahlungen pünktlich waren?',
    'Tell me if every payment is due monthly',
    // judged sentence by sentence
    'Ich habe einen Mietvertrag. Gilt die Frist für alle Mieter?'
  ])('%s → a plain answer, with or without extract data (pre-fix: the listing)', (question) => {
    for (const extractAvailable of [true, false]) {
      const decision = routeQuestion({ ...base, extractAvailable, question })
      expect(decision).toEqual({ engine: 'relevance', confidence: 'high' })
      expect(isClassificationTrigger(decision, question)).toBe(false)
    }
  })

  // A quantifier inside some other question modifies it: the listing cannot pair or filter, so the
  // answer is labelled like #641's untyped asks (no deep-index advice).
  it.each([
    'When is each payment due?',
    'Which deadlines apply to every tenant?',
    'Welche Frist gilt für alle Mieter?',
    'Wer muss alle Kosten tragen?',
    'Was sind die Fristen für alle Mieter?', // "was sind" opens a request, but its head is "die"
    'If all the payments are late, what happens?' // a bare "if" opens a condition, not a yes/no
  ])('%s → labelled relevance (pre-fix: the listing)', (question) => {
    for (const extractAvailable of [true, false]) {
      const decision = routeQuestion({ ...base, extractAvailable, question })
      expect(decision).toEqual({ engine: 'relevance', confidence: 'low', fallback: 'partial' })
    }
  })

  // Controls: a polite request opens like a yes/no question, and a request may open with words
  // before its quantifier. These listed before #644 and must keep listing.
  it.each([
    ['Kannst du alle Fristen auflisten?', 'date'],
    ['Kannst du mir alle Fristen nennen?', 'date'],
    ['Würden Sie mir alle Fristen nennen?', 'date'],
    ['Could you give me all the deadlines?', 'date'],
    ['Can I see all the deadlines?', 'date'],
    ['Alle Fristen?', 'date'],
    ['every deadline', 'date'],
    ['Sämtliche Zahlungen bitte', 'amount'],
    ['What are all the deadlines?', 'date'],
    ['Was sind alle Fristen?', 'date'], // German "was" (what), not the English verb
    ['Who are all the parties?', 'party'],
    ['Zeig mir alle Zahlungen', 'amount'],
    ['Bitte nenne mir sämtliche Fristen', 'date'],
    ['I need every deadline in this contract', 'date']
  ] as const)('%s → coverage-extract (%s)', (question, recordType) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
      engine: 'coverage-extract',
      recordType,
      confidence: 'high'
    })
  })

  // The #644 comment: the type is the one the list request names first — a question word included,
  // when it names what the list is of — and a word with a common second sense maps to no type.
  it.each([
    ['List every expense and when it was paid', 'amount'], // pre-fix: date (the first table row)
    ['List all payments and their due dates', 'amount'], // pre-fix: date
    ['How many payments are due in March?', 'amount'], // pre-fix: date ("due")
    ['List the due dates of all payments', 'date'],
    ['List who paid each fee', 'party'], // pre-fix: amount
    ['What must every tenant pay? List all the fees', 'amount'], // the list request's sentence decides
    ['Welche Fristen gelten? Liste alle auf', 'date'] // a list request that names nothing: the question's
  ] as const)('%s → coverage-extract (%s)', (question, recordType) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
      engine: 'coverage-extract',
      recordType,
      confidence: 'high'
    })
  })

  it.each([
    'List all the medical terms in this letter', // pre-fix: obligation ("terms")
    'List all names of the medications', // pre-fix: party ("names")
    'Liste alle Namen auf', // pre-fix: party ("Namen")
    'Liste alle Daten auf' // pre-fix: date ("Daten" — data, or dates)
  ])('%s → labelled relevance: no type names it (pre-fix: a typed listing)', (question) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
      engine: 'relevance',
      confidence: 'low',
      fallback: 'partial'
    })
  })
})

describe('routeQuestion — precedence + non-coverage', () => {
  it('honours precedence: compare (2 docs) > coverage-extract', () => {
    const d = routeQuestion({
      question: 'compare the obligations and list every clause',
      documentCount: 2,
      treeAvailable: false,
      extractAvailable: true
    })
    expect(d.engine).toBe('compare')
  })

  it('a compare question without two documents falls back to relevance', () => {
    const d = routeQuestion({
      question: 'what is the difference here',
      documentCount: 1,
      treeAvailable: false,
      extractAvailable: false
    })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('low')
  })

  it('explicit task buttons win outright', () => {
    expect(
      routeQuestion({
        taskType: 'summary',
        question: 'anything',
        treeAvailable: true,
        extractAvailable: false
      }).engine
    ).toBe('tree-summary')
    expect(
      routeQuestion({
        taskType: 'compare',
        question: 'anything',
        documentCount: 2,
        treeAvailable: false,
        extractAvailable: false
      }).engine
    ).toBe('compare')
  })

  it('routes "summarize / overview" to tree-summary only when a tree is ready', () => {
    expect(
      routeQuestion({ question: 'summarize this document', treeAvailable: true, extractAvailable: false })
        .engine
    ).toBe('tree-summary')
    expect(
      routeQuestion({ question: 'summarize this document', treeAvailable: false, extractAvailable: false })
        .engine
    ).toBe('relevance')
  })

  it('an ordinary question routes to relevance, byte-unchanged (high confidence)', () => {
    const d = routeQuestion({
      question: 'what does the contract say about termination?',
      documentCount: 1,
      treeAvailable: true,
      extractAvailable: true
    })
    expect(d.engine).toBe('relevance')
    expect(d.confidence).toBe('high')
  })
})

describe('parseExtraction — tolerant JSON-array parse (H7)', () => {
  it('parses a clean array of typed items', () => {
    const items = parseExtraction('[{"type":"date","value":"2020-01-01"},{"type":"party","value":"Acme"}]')
    expect(items).toEqual([
      { type: 'date', value: '2020-01-01' },
      { type: 'party', value: 'Acme' }
    ])
  })

  it('recovers an array wrapped in prose / code fences', () => {
    const items = parseExtraction('Sure! ```json\n[{"type":"amount","value":"$5"}]\n``` done')
    expect(items).toEqual([{ type: 'amount', value: '$5' }])
  })

  it('treats an empty array as a VALID parse (chunk genuinely had nothing), not unparsed', () => {
    expect(parseExtraction('[]')).toEqual([])
  })

  it('coerces an unknown type to generic and drops empty values', () => {
    const items = parseExtraction('[{"type":"weird","value":"x"},{"type":"date","value":"  "}]')
    expect(items).toEqual([{ type: 'generic', value: 'x' }])
  })

  it('returns null (→ retry, then unparsed marker) when no JSON array is present', () => {
    expect(parseExtraction('I could not find anything useful.')).toBeNull()
    expect(parseExtraction('{not an array}')).toBeNull()
  })

  // #50: a reply cut off at the token cap ends mid-object/mid-string. On the FINAL attempt the
  // complete leading items are salvaged instead of writing off the whole chunk as unparsed.
  describe('salvageTruncated (#50 — cap-truncated arrays, final attempt only)', () => {
    const truncated =
      '[{"type":"amount","value":"€ 12,90"},{"type":"amount","value":"€ 7,50"},{"type":"amo'

    it('is OFF by default — a truncated array still returns null (attempt-1 contract)', () => {
      expect(parseExtraction(truncated)).toBeNull()
    })

    it('recovers the complete leading items of a truncated array', () => {
      expect(parseExtraction(truncated, { salvageTruncated: true })).toEqual([
        { type: 'amount', value: '€ 12,90' },
        { type: 'amount', value: '€ 7,50' }
      ])
    })

    it('keeps a `}` inside a completed string value', () => {
      const braceInValue = '[{"type":"generic","value":"a}b"},{"type":"date","value":"2026-07-'
      expect(parseExtraction(braceInValue, { salvageTruncated: true })).toEqual([
        { type: 'generic', value: 'a}b' }
      ])
    })

    it('steps back past a `}` inside the UNTERMINATED trailing string', () => {
      const cutMidString = '[{"type":"generic","value":"ok"},{"type":"generic","value":"cut}'
      expect(parseExtraction(cutMidString, { salvageTruncated: true })).toEqual([
        { type: 'generic', value: 'ok' }
      ])
    })

    it('still returns null when not even one complete object exists', () => {
      expect(parseExtraction('[{"type":"amount","value":"€ 12', { salvageTruncated: true })).toBeNull()
      expect(parseExtraction('', { salvageTruncated: true })).toBeNull()
      expect(parseExtraction('thinking… no array here', { salvageTruncated: true })).toBeNull()
    })
  })
})

// Issue #80 (wave R80) — the CLASSIFICATION TRIGGER BOUNDARY golden set. The router itself is
// byte-unchanged (every pin above still passes); this pins WHICH decisions may additionally run
// the one bounded skill-pointer classification: (a) aggregation-shaped coverage-extract turns,
// (b) low-confidence fallbacks. The step-5 fallthrough (ordinary high-confidence relevance) and
// every other confident route must NEVER trigger — that 0-model-call guarantee is what protects
// trust in the suggestion surface, so the distractor rows are the teeth of this suite.
describe('isClassificationTrigger (#80) — golden set', () => {
  const route = (question: string, over: Partial<RouteInput> = {}): ReturnType<typeof routeQuestion> =>
    routeQuestion({ question, documentCount: 1, treeAvailable: false, extractAvailable: true, ...over })

  it('every currently-confident route is byte-unchanged — full-decision pins', () => {
    // Deep-equal against the WHOLE decision object (not just engine), so any drift in
    // confidence/recordType/fallback on the happy paths fails loudly here.
    expect(route('list every deadline')).toEqual({
      engine: 'coverage-extract',
      recordType: 'date',
      confidence: 'high'
    })
    expect(route('kategorisiere die Ausgaben')).toEqual({
      engine: 'coverage-extract',
      recordType: 'amount',
      confidence: 'high'
    })
    expect(route('what does the contract say about termination?')).toEqual({
      engine: 'relevance',
      confidence: 'high'
    })
    expect(route('Fasse das Dokument zusammen', { treeAvailable: true })).toEqual({
      engine: 'tree-summary',
      confidence: 'high'
    })
    expect(route('Compare the two contracts', { documentCount: 2 })).toEqual({
      engine: 'compare',
      confidence: 'high'
    })
  })

  it('trigger (a): aggregation-shaped coverage-extract turns — EN + DE, incl. the #54/#37 repros', () => {
    for (const q of [
      'kategorisiere alle transaktionen und erstelle eine summe pro kategorie', // #54 verbatim
      'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf', // #37 verbatim
      'gruppiere die Parteien nach Vertrag',
      'categorize the expenses',
      'group by vendor and total per month',
      'sum per category please'
    ]) {
      const d = route(q)
      expect(d.engine, q).toBe('coverage-extract')
      expect(isClassificationTrigger(d, q), q).toBe(true)
    }
  })

  it('trigger (b): low-confidence fallbacks — coverage without extract data, compare without two docs', () => {
    const noExtract = route('kategorisiere alle transaktionen und erstelle eine summe pro kategorie', {
      extractAvailable: false
    })
    expect(noExtract).toEqual({ engine: 'relevance', confidence: 'low', fallback: 'coverage' })
    expect(isClassificationTrigger(noExtract, 'kategorisiere alle transaktionen und erstelle eine summe pro kategorie')).toBe(true)

    // A PLAIN list ask that fell back also triggers — the router provably could not serve it.
    const plainNoExtract = route('list every deadline', { extractAvailable: false })
    expect(plainNoExtract).toEqual({ engine: 'relevance', confidence: 'low', fallback: 'coverage' })
    expect(isClassificationTrigger(plainNoExtract, 'list every deadline')).toBe(true)

    const compareOneDoc = route('what is the difference here', { extractAvailable: false })
    expect(compareOneDoc).toEqual({ engine: 'relevance', confidence: 'low', fallback: 'compare' })
    expect(isClassificationTrigger(compareOneDoc, 'what is the difference here')).toBe(true)
  })

  it('NEVER on the step-5 fallthrough — ordinary questions keep 0 model calls', () => {
    for (const q of [
      'what does the contract say about termination?',
      'who wrote this letter?',
      'Erzähle mir etwas über die Verträge',
      'Wann wurde der Vertrag unterschrieben?'
    ]) {
      const d = route(q)
      expect(d, q).toEqual({ engine: 'relevance', confidence: 'high' })
      expect(isClassificationTrigger(d, q), q).toBe(false)
    }
  })

  it('NEVER on confident non-aggregation routes — plain listings, summaries, compares', () => {
    // Plain list/count over extract data: coverage-extract, but NOT aggregation-shaped.
    for (const q of ['list every deadline', 'liste alle Beträge auf', 'wie viele Parteien', 'Zähle die Ausgaben']) {
      const d = route(q)
      expect(d.engine, q).toBe('coverage-extract')
      expect(isClassificationTrigger(d, q), q).toBe(false)
    }
    const summary = route('Summarize the whole document', { treeAvailable: true })
    expect(summary.engine).toBe('tree-summary')
    expect(isClassificationTrigger(summary, 'Summarize the whole document')).toBe(false)
    const compare = route('Compare the two contracts', { documentCount: 2 })
    expect(compare.engine).toBe('compare')
    expect(isClassificationTrigger(compare, 'Compare the two contracts')).toBe(false)
  })

  it('near-miss lexical distractors stay outside the boundary', () => {
    // Words NEAR the aggregation lexicon that must not fire it (and so must not trigger):
    for (const q of [
      'Welche Kategorie passt zu diesem Dokument?', // bare "Kategorie" — not the pro/nach phrase
      'Die Gruppe trifft sich morgen im Büro', // "Gruppe" ≠ the gruppier stem
      'is the total correct on page 2?', // "total" alone — no "total per"
      'give me the summary of the sums section' // summary-shaped, no tree → step-5 relevance
    ]) {
      const d = route(q, { extractAvailable: true })
      expect(isClassificationTrigger(d, q), q).toBe(false)
    }
  })
})

// Issue #54 — the pure detector behind the listing's shape hint: DID the aggregation lexicon
// fire (categorize / group / sum per …), as opposed to a plain list/count trigger? The listing
// engine can only count values; an aggregation-shaped ask served by it needs the honest hint.
describe('isAggregationShaped (#54)', () => {
  it('true for aggregation/categorization asks — EN + DE, incl. the #54 repro verbatim', () => {
    for (const q of [
      'kategorisiere alle transaktionen und erstelle eine summe pro kategorie', // the #54 repro
      'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf', // the #37 repro
      'gruppiere die Ausgaben nach Monat',
      'summiere die Beträge',
      'categorize the expenses',
      'group by vendor and total per month',
      'sum per category please'
    ]) {
      expect(isAggregationShaped(q), q).toBe(true)
    }
  })

  it('false for plain list/count asks and ordinary questions — the hint must not over-fire', () => {
    for (const q of [
      'liste alle Beträge auf',
      'Zähle die Ausgaben',
      'list every deadline',
      'how many payments are there?',
      'who wrote this letter?',
      ''
    ]) {
      expect(isAggregationShaped(q), q).toBe(false)
    }
  })
})
