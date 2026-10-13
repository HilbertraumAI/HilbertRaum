import { describe, it, expect } from 'vitest'
import {
  isAggregationShaped,
  isTotalAsk,
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
      ['Unterschiede zwischen den Verträgen', 'compare'],
      // EN controls: English classification is byte-identical; DE control: the aggregation route (correct pre-fix)
      ['List every deadline', 'coverage-extract'],
      ['Summarize the whole document', 'tree-summary'],
      ['Compare the two contracts', 'compare'],
      ['Kategorisiere die Ausgaben', 'coverage-extract']
    ]
    for (const [q, engine] of rows) {
      const d = routeQuestion({ ...base, question: q })
      expect(d.engine, q).toBe(engine)
      expect(d.confidence, q).toBe('high')
    }
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
    // judged sentence by sentence; a date, an abbreviation or a line break ends none
    'Ich habe einen Mietvertrag. Gilt die Frist für alle Mieter?',
    'Gilt ab dem 15. Januar die Frist für alle Mieter?',
    'Gilt die Frist inkl. Verlängerung für alle Mieter?',
    'Gilt die Frist\nfür alle Mieter?',
    'Gilt die Frist bis 10:30 für alle Mieter?', // a colon ends no sentence
    'Gilt die Frist z. B. für alle Mieter?',
    'Gut. Gilt die Frist für alle Mieter?',
    'Danke! Alles klar. Gilt die Frist für alle Mieter?', // a sentence of fillers asks nothing
    // fillers before the verb
    'Hallo, gilt die Frist für alle Mieter?',
    'Alles klar, gilt die Frist für alle Mieter?',
    "Gibt's für jede Zahlung eine Quittung?",
    // a modal before the one asked, or the asker, that asks for nothing
    'Kann ich alle Zahlungen zurückfordern?',
    'Can you deduct all the fees?',
    'Können Sie alle Fristen einhalten?',
    'Kann sie alle Fristen sehen?', // "sie" after a singular verb is "she", not the one asked
    // a yes/no question asked directly after an opener
    'Tell me, are all the payments on time?',
    // a claim about the quantified items, asked or stated
    'Jede Zahlung ist pünktlich eingegangen?',
    'Each payment is due on the 1st, right?',
    'Alle Zahlungen sind am Ersten fällig.',
    'Jede Zahlung an die Vermieterin ist fällig?' // "die" before a capital is an article
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
    'If all the payments are late, what happens?', // a bare "if" opens a condition, not a yes/no
    'Was an Gebühren zahlen alle Mieter?', // German "was … an", not an English subject
    'Sagen alle Parteien dasselbe?', // an unlisted verb first: the label, never the listing
    'When are all the payments due?', // a when-question is no request, plural or not
    // another sentence's typed noun does not type an untyped list request
    'Gilt die Frist für alle Mieter? Liste alle Abkürzungen auf'
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
    ['I need every deadline in this contract', 'date'],
    ['Please, can you give me all the deadlines?', 'date'], // a filler before the polite opener
    ['Können wir alle Fristen auflisten?', 'date'], // a modal before "wir" with a list verb
    ['Kann ich alle Fristen sehen?', 'date'], // … before "ich", asking to see the thing
    ['Can I please see all the deadlines?', 'date'],
    ['Is it possible to list all the payments?', 'amount'],
    ['Gibt es eine Liste aller Fristen?', 'date'],
    ['Would you mind listing all the deadlines?', 'date'],
    ['Can we get a list of all the payments?', 'amount'],
    ['Listen Sie alle Fristen auf', 'date'],
    ['Sagen Sie mir alle Fristen', 'date'], // the longest opener wins over "sag"
    ['Extrahiere alle Fristen', 'date'],
    ['Display all the deadlines', 'date'],
    ['Erstelle eine Aufstellung aller Zahlungen', 'amount'],
    ['Summarize all the payments', 'amount'],
    ['Fasse alle Fristen zusammen', 'date'],
    ['Do you have all the deadlines?', 'date'],
    ['Hast du eine Liste aller Fristen?', 'date'],
    ['Bist du in der Lage, alle Fristen aufzulisten?', 'date'],
    ['Ich zahle 500 EUR. Alle Zahlungen?', 'amount'], // a period after a word ends the sentence
    // a verb behind a comma or a clause word belongs to the clause: still a request
    ['Alle Fristen, die für den Mieter gelten?', 'date'],
    ['Alle Fristen, die Mieter einhalten müssen?', 'date'], // the comma, not "die", ends the claim
    ['Every deadline that is binding?', 'date'],
    ['Alle Zahlungen die ich erhalten habe?', 'amount'],
    ['Alle Zahlungen am Monatsende?', 'amount'], // "am" is no German verb
    ['Alle Termine für Treffen?', 'date'], // a capitalised "Treffen" is a noun, not the verb
    ['Show me every payment I have made', 'amount'] // a request is never a claim
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
    ['When was the lease signed? List all the fees', 'amount'], // pre-fix: date; the list's sentence decides
    ['How many tenants must pay a fee?', 'amount'], // "must" names nothing when a fee is named
    ['List all payment deadlines', 'date'], // the last of adjacent nouns names the thing
    ['Show me all the payments due in May', 'amount'], // "due" after a noun heads nothing
    ['List all the terms and conditions', 'obligation'],
    // a list request that names nothing refers back to the question
    ['Welche Fristen gelten? Liste alle auf', 'date'],
    ['What are the deadlines? List all of them.', 'date'],
    ['List all the abbreviations. List all the deadlines.', 'date'] // any typed list request counts
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
    'Liste alle Daten auf', // pre-fix: date ("Daten" — data, or dates)
    'List every term of the lease' // pre-fix: obligation ("term")
  ])('%s → labelled relevance: no type names it (pre-fix: a typed listing)', (question) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
      engine: 'relevance',
      confidence: 'low',
      fallback: 'partial'
    })
  })
})

// Issue #649 (and its comment): "how much" / "wie viel" counted as a list verb wherever it stood, so
// "How much is the monthly fee?" got every amount in the document; a sum got the same listing (or, with a
// quantifier inside, #644's labelled top-k sum); "list"/"Liste" as a noun and "zählt als" still listed.
// Rows marked "pre-fix" listed, labelled or answered plainly on master; the controls must keep their route.
describe('routeQuestion — "how much" is a lookup or a sum, and a list asked about is no list request (#649)', () => {
  const base = { documentCount: 1, treeAvailable: false }

  it.each([
    // a lookup asks for one amount
    'How much is the monthly fee?', // the issue's example, verbatim
    'Wie viel beträgt die Gebühr?', // the issue's example, verbatim
    'How much is the deposit?', // pre-fix: labelled (no amount synonym)
    'How much does the parking space cost?',
    'How much are the fees?',
    'How much notice do I have to give?',
    'Can you tell me how much the fee is?',
    'Weißt du, wie viel die Gebühr beträgt?',
    'Wie viel kostet der Stellplatz?',
    'Wieviel beträgt die Nebenkostenpauschale?',
    // a pay verb in the present asks what is paid, not what was: pre-fix labelled or listed
    'How much do I pay per month?',
    'How much do I have to pay for the parking space?',
    'How much is charged for a late payment?',
    'Wie viel Miete muss ich zahlen?',
    'Wie viel schulde ich dem Vermieter?',
    'Wie viel bezahlt der Mieter pro Monat?', // a participle alone is the present
    'How much is paid per month?', // … and so is one after "is"
    'How much will I be paid per month?',
    'How much has to be paid on signing?', // "be paid": a passive, not the past
    // "how much" measures something that is not money: pre-fix labelled
    'How much space does the flat have in total?',
    'Wie viel Urlaub habe ich insgesamt?',
    'wie viel urlaub habe ich insgesamt?', // written all lower-case
    // a list the question asks about, in a question that opens with a question word
    'Welche Fristen stehen auf der Liste?', // the comment's example, verbatim
    'What is on the list of fees?', // the comment's example, verbatim
    "What's on the list of fees?",
    "Tell me what's on the list of fees",
    'Which fees are on the list?',
    'What are the fees on the list?', // "what are" opens a request, but with a question word
    'Welche Kosten sind in der Liste enthalten?',
    'Kannst du mir sagen, was auf der Liste steht?', // pre-fix: labelled
    'Auf welcher Liste steht die Frist?',
    'Auf welcher Seite der Liste steht die Kaution?', // pre-fix: labelled; a preposition before the question word
    'Welche Fristen stehen in der Aufzählung?',
    'Welche Kosten nennt die Auflistung?',
    // "zählen zu / zählt als", "count as": belong to, not count
    'Welche Kosten zählen zu den Nebenkosten?', // the comment's example, verbatim
    'Was zählt als Zahlung?', // the comment's example, verbatim
    'Welche Zahlungen zählen nicht zur Miete?',
    'Welche Ausgaben zählt der Vertrag zu den Nebenkosten?',
    'Welche Kosten zählen Sie zu den Nebenkosten?', // "zählen Sie" after a question word is a question
    'Was zählen Sie als Zahlung?',
    'Which fees count as operating costs?',
    'Which costs count towards the deposit?',
    'Zählen alle Zahlungen zur Miete?', // a #644 residual: "zählen" opens a yes/no question
    'Zählen die Fristen auch am Wochenende?',
    'Welcher Zählerstand gilt für die Abrechnung der Kosten?' // a meter, no verb
  ])('%s → a plain answer, with or without extract data (pre-fix: the listing or the label)', (question) => {
    for (const extractAvailable of [true, false]) {
      const decision = routeQuestion({ ...base, extractAvailable, question })
      expect(decision).toEqual({ engine: 'relevance', confidence: 'high' })
      expect(isClassificationTrigger(decision, question)).toBe(false)
    }
  })

  // A quantifier inside a "how much" question modifies it (#644): the label, no listing.
  it.each(['How much is each payment?', 'Wie viel kostet jede Zahlung?'])(
    '%s → labelled relevance (pre-fix: the listing)',
    (question) => {
      for (const extractAvailable of [true, false]) {
        expect(routeQuestion({ ...base, extractAvailable, question })).toEqual({
          engine: 'relevance',
          confidence: 'low',
          fallback: 'partial'
        })
      }
    }
  )

  // A sum takes the aggregation route over amounts, whatever it names: with extract data the listing led by
  // the #54 hint (and the #80 offer); without it the deep-index heads-up. One fitting document is read whole
  // instead (`rag-skill-analysis.test.ts`).
  it.each([
    'How much did I pay in fees?', // the issue's example, verbatim
    'Wie viel habe ich insgesamt an Gebühren gezahlt?', // the issue's example, verbatim
    'What is the total of all the payments?', // the comment's example, verbatim: pre-fix labelled
    'Wie hoch ist die Summe aller Zahlungen?', // the comment's example, verbatim: pre-fix labelled
    'How much did I spend in total?', // names no amount
    'How much have I paid so far?',
    'How much in total?',
    'How much is that in total?', // a verb after "how much": it measures no noun
    'Wie viel macht das zusammen?', // "wie viel" makes "zusammen" a total
    'I need the total of all payments.', // a request, not a statement
    'Ich frage mich, wie viel ich insgesamt gezahlt habe?', // asked, not stated
    'We paid how much in total?', // led by a pronoun, but asked
    'What is the sum of the fees?', // pre-fix: a plain answer
    'Wie hoch ist der Gesamtbetrag?', // pre-fix: a plain answer
    "What's my total?",
    'Total of all payments?',
    'What do the payments add up to?',
    'What are the combined monthly costs?',
    'How much are all the fees together?',
    'Was kostet alles zusammen?',
    'Wie viel kostet die Wohnung mit Stellplatz insgesamt?',
    'Kannst du mir sagen, wie viel ich insgesamt zahle?',
    'Rechne alle Zahlungen zusammen.',
    'Rechne alles zusammen.', // a reckoning verb needs no money word
    'Rechne alle Zahlungen zusammen. Wie viel ist das?', // a request needs no question mark
    'Could you calculate how much I paid in total?', // a polite request to reckon, no yes/no question
    'Kannst du alle Zahlungen zusammenrechnen?',
    'We would like the total of all fees.',
    'Wir möchten die Summe aller Zahlungen wissen.',
    'Wie viel Kosten muss der Mieter insgesamt tragen?', // "tragen" gathers only with "zusammen"
    'Wie viel stellt mir der Vermieter insgesamt in Rechnung?', // a capitalising writer: "stellt" is no noun
    'wie viel zahle ich insgesamt?',
    'wie viel macht das insgesamt?', // lower-case: "macht" is a verb, no noun
    'Wie viel zahlte ich im Januar?', // a past form
    'How much was spent on repairs?', // a participle after a past auxiliary
    'Was ergeben 950 € und 180 € zusammen?', // the currency sign is the money word
    'Addiere alle Beträge.'
  ])('%s → the aggregation route over amounts (pre-fix: the plain listing, a label or a plain answer)', (question) => {
    const withExtract = routeQuestion({ ...base, extractAvailable: true, question })
    expect(withExtract).toEqual({ engine: 'coverage-extract', recordType: 'amount', confidence: 'high' })
    expect(isAggregationShaped(question)).toBe(true)
    expect(isClassificationTrigger(withExtract, question)).toBe(true)
    expect(routeQuestion({ ...base, extractAvailable: false, question })).toEqual({
      engine: 'relevance',
      confidence: 'low',
      fallback: 'coverage'
    })
  })

  // Controls: no sum. A yes/no question asks for a verdict (#644); a who / when question asks about a party or a
  // date; a statement gives context; a measure or a joint act adds up no amounts.
  it.each([
    'Is the total rent 1,175 euros?',
    'Ist die Summe aller Zahlungen korrekt?',
    'Who pays the total rent?',
    'When is the total due?',
    'Tell me who pays the total rent.', // a who-question after an opener
    'Bis wann muss die Gesamtmiete bezahlt sein?',
    'Kann ich die Gesamtmiete steuerlich absetzen?', // a yes/no question: no reckoning verb asks
    'The total rent is 1,175 euros. Is the deposit included?', // a statement in a question gives context
    'Die Gesamtmiete beträgt 1.175 Euro. Ist die Kaution darin enthalten?',
    'What happens in case of a total loss?', // an idiom
    'What is the sum insured?',
    'Welche Gebühren fallen insgesamt an?', // a which-question asks for the fees
    'Welche Kosten rechnet der Vermieter zusammen mit den Nebenkosten ab?',
    'I paid a total of 500 euros last year. Which payment was late?',
    'Ich habe insgesamt drei Zahlungen geleistet. Welche war die höchste?',
    'Ich habe insgesamt drei Zahlungen geleistet.', // a statement led by a pronoun, on its own
    'Wir zahlen die Miete zusammen. Wie hoch ist mein Anteil?',
    'Zahlen die Mieter die Miete zusammen?',
    'Haften alle Mieter zusammen?',
    'Wer wohnt zusammen in der Wohnung?',
    'Was haben die Mieter zusammen vereinbart?', // "zusammen" with no money word
    'Ist die Kaution zusammen mit der Miete fällig?',
    'Was kostet der Stellplatz zusammen mit der Garage?', // "zusammen mit" joins, it adds nothing up
    'Wir wohnen zusammen. Wie hoch ist die Miete?', // judged sentence by sentence
    'How long is the lease in total?',
    'What is the total area of the flat?',
    'What is the total number of payments?',
    'Erkläre, wie sich die Gesamtmiete zusammensetzt.',
    'Sum up the main points.'
  ])('%s → a plain answer, no sum', (question) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({ engine: 'relevance', confidence: 'high' })
    expect(isAggregationShaped(question)).toBe(false)
  })

  // Controls: list requests keep the plain listing, with no #54 hint — a count, a summary, a gathered list,
  // "the list" asked for, a "zähl…" request.
  it.each([
    ['How many payments are there in total?', 'amount'],
    ['Wie viele Zahlungen gibt es insgesamt?', 'amount'],
    ['Fasse alle Zahlungen zusammen.', 'amount'],
    ['Stelle alle Kosten zusammen.', 'amount'],
    ['Could you put together a list of all the fees?', 'amount'],
    ['Erstelle eine Liste aller Fristen', 'date'],
    ['Make a list of the payments', 'amount'],
    ['Gib mir eine Liste der Fristen', 'date'],
    ['Zeig mir die Liste der Fristen', 'date'],
    ['Zeigst du mir die Liste der Fristen?', 'date'], // an unlisted opener: "the list" still asks
    ['What is the list of deadlines?', 'date'], // the list named after "is" is asked for
    ["What's the list of deadlines?", 'date'],
    ['Wie lautet die Liste der Fristen?', 'date'],
    ['Wie lang ist die Liste der Fristen?', 'date'],
    ['Show me the list of fees', 'amount'],
    ['Could you send me the list of fees?', 'amount'],
    ['Die Liste aller Fristen, bitte.', 'date'],
    ['Is there a list of fees?', 'amount'],
    ['How many fees are on the list?', 'amount'],
    ['Zähle alle Zahlungen', 'amount'],
    ['Mach eine Zählung aller Zahlungen', 'amount'], // "Zählung" is a count, no meter
    ['Alle Zahlungen zählen und auflisten', 'amount'], // the infinitive request, no claim
    ['Zählen alle Zahlungen', 'amount'], // no question mark: the infinitive request, no yes/no question
    ['Zähle alle Zahlungen zur Miete auf', 'amount'],
    ['Zähle alle Zahlungen zur Miete.', 'amount'], // the imperative never means "belong to"
    ['Zählen Sie alle Fristen auf', 'date'], // "Sie" after "zählen" is the one asked
    ['Zählen Sie alle Fristen auf?', 'date'], // … with a question mark too: a polite request, no verdict
    ['Zählen Sie die Zahlungen bis zum 31. März.', 'amount'], // … and the formal imperative is a request
    ['Welche Zahlungen zählt der Vertrag zur Miete auf?', 'amount'], // "auf" ends the clause: "aufzählen"
    ['Welche Fristen zählt der Vertrag auf, die zu beachten sind?', 'date'], // "zu" behind a comma belongs to the clause
    ['Wie viele Zahlungen zählen zur Miete?', 'amount'],
    ['Count the payments as of May.', 'amount']
  ] as const)('%s → coverage-extract (%s), no aggregation hint', (question, recordType) => {
    expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
      engine: 'coverage-extract',
      recordType,
      confidence: 'high'
    })
    expect(isAggregationShaped(question)).toBe(false)
  })

  // A list request names its own type; the sum beside it still makes the ask aggregation-shaped.
  it.each(['List all the deadlines and the total rent', 'List all the deadlines. How much did I pay in total?'])(
    '%s → coverage-extract (date), aggregation-shaped',
    (question) => {
      expect(routeQuestion({ ...base, extractAvailable: true, question })).toEqual({
        engine: 'coverage-extract',
        recordType: 'date',
        confidence: 'high'
      })
      expect(isAggregationShaped(question)).toBe(true)
    }
  )

  // A summary that mentions a total is a summary: it keeps the tree summary over the listing.
  it.each(['Summarize the lease, including the total rent.', 'Fasse den Vertrag zusammen und nenne die Gesamtmiete.'])(
    '%s → tree-summary with a ready deep index, not a sum',
    (question) => {
      expect(routeQuestion({ documentCount: 1, treeAvailable: true, extractAvailable: true, question })).toEqual({
        engine: 'tree-summary',
        confidence: 'high'
      })
    }
  )

  // The arithmetic heads-up's question (design-guidelines §11.24): a total of amounts, not any grouping.
  it.each([
    ['How much did I pay in fees?', true],
    ['Kategorisiere alle Ausgaben', true],
    ['Summiere alle Zahlungen', true],
    ['Summiere alle Buchungen', true], // an adding-up verb, whatever it names
    ['Tally up the transactions', true],
    ['Gruppiere die Fristen nach Mieter', false],
    ['categorize all the findings', false],
    ['How much is the monthly fee?', false],
    ['List all the deadlines', false]
  ] as const)('isTotalAsk(%s) → %s', (question, expected) => {
    expect(isTotalAsk(question)).toBe(expected)
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
    for (const q of [
      'kategorisiere alle transaktionen und erstelle eine summe pro kategorie', // #54 verbatim
      'kategorisiere die ausgaben und erstelle eine summe pro kategorie auf' // #37 verbatim — the #38 hint gate
    ]) {
      const noExtract = route(q, { extractAvailable: false })
      expect(noExtract, q).toEqual({ engine: 'relevance', confidence: 'low', fallback: 'coverage' })
      expect(isClassificationTrigger(noExtract, q), q).toBe(true)
    }

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
    // The same fallthrough without extract data (#38: no fallback key) and with a ready deep index.
    for (const over of [{ extractAvailable: false }, { treeAvailable: true }]) {
      const q = 'what does the contract say about termination?'
      expect(route(q, over), JSON.stringify(over)).toEqual({ engine: 'relevance', confidence: 'high' })
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
