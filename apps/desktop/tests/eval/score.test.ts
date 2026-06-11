import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  tokenize,
  tokenF1,
  bestF1,
  containsGold,
  isAbstention,
  scoreItem,
  aggregate,
  toCsvRow,
  QA_CSV_HEADER,
  type EvalItem,
  type ItemOutput
} from './score'

// CI-safe unit tests for the Phase-29 deterministic scorer (model-benchmarks.md
// §2). No model, no binary, no node:sqlite — pure string math, so the logic that decides
// catalog promotions (§5.4) is covered without a benchmark run.

describe('normalizeText (German-aware)', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeText('  Hello,   WORLD!! ')).toBe('hello world')
  })
  it('KEEPS umlauts and ß (folding them would hide German-quality deltas)', () => {
    expect(normalizeText('Die Donau fließt durch Wien.')).toBe('die donau fließt durch wien')
    expect(normalizeText('Straße — Größe')).toBe('straße größe')
  })
  it('is NFC-stable for composed vs decomposed umlauts', () => {
    const composed = 'Ö' // U+00D6
    const decomposed = 'Ö' // O + combining diaeresis
    expect(normalizeText(composed)).toBe(normalizeText(decomposed))
  })
})

describe('tokenize', () => {
  it('returns [] for empty/punctuation-only input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('  ,.! ')).toEqual([])
  })
  it('splits on non-letter/number runs', () => {
    expect(tokenize('1.000.000 USD')).toEqual(['1', '000', '000', 'usd'])
  })
})

describe('tokenF1 / bestF1', () => {
  it('is 1 for an exact normalized match', () => {
    expect(tokenF1('eine Million US-Dollar', 'eine million us dollar')).toBeCloseTo(1, 5)
  })
  it('is 0 with no overlap', () => {
    expect(tokenF1('völlig anderer Text', 'eine Million')).toBe(0)
  })
  it('rewards partial overlap between 0 and 1', () => {
    const f1 = tokenF1('die Haftung ist auf eine Million begrenzt', 'eine Million')
    expect(f1).toBeGreaterThan(0)
    expect(f1).toBeLessThan(1)
  })
  it('bestF1 takes the max over accepted spans', () => {
    expect(bestF1('1.000.000 USD', ['eine Million US-Dollar', '1 000 000 usd'])).toBeCloseTo(1, 5)
  })
})

describe('containsGold (containment EM, token-boundary aware)', () => {
  it('matches a gold span embedded in a full sentence', () => {
    expect(containsGold('Die Donau fließt durch Wien.', ['Donau'])).toBe(true)
  })
  it('respects token boundaries (no mid-word match)', () => {
    expect(containsGold('Es gibt keine Antwort.', ['ein'])).toBe(false)
  })
  it('accepts any one of several gold spans', () => {
    expect(containsGold('Die Obergrenze beträgt 1.000.000 USD.', ['eine Million US-Dollar', '1 000 000 USD'])).toBe(
      true
    )
  })
  it('is false when no span is present', () => {
    expect(containsGold('Der Vertrag gilt in Delaware.', ['Donau'])).toBe(false)
  })
})

describe('isAbstention (DE + EN refusal phrases)', () => {
  it('detects English declines', () => {
    expect(isAbstention("I couldn't find that in the documents.")).toBe(true)
    expect(isAbstention('The excerpts do not contain enough information.')).toBe(true)
    expect(isAbstention('That is not specified in the provided sources.')).toBe(true)
  })
  it('detects German declines', () => {
    expect(isAbstention('Das geht aus den Dokumenten nicht hervor.')).toBe(true)
    expect(isAbstention('Dazu liegen keine Informationen vor.')).toBe(true)
    expect(isAbstention('Die Auszüge enthalten nicht genügend Angaben.')).toBe(true)
  })
  it('catches the fixed no-context sentinel via "couldn t find"', () => {
    expect(
      isAbstention(
        "I couldn't find this in your documents. Try rephrasing your question, or check which documents you're asking about."
      )
    ).toBe(true)
  })
  it('does NOT flag a normal grounded answer', () => {
    expect(isAbstention('Die Haftung ist auf eine Million US-Dollar begrenzt [S1].')).toBe(false)
    expect(isAbstention('The capital of Austria is Vienna [S2].')).toBe(false)
  })
})

describe('isAbstention — audited real-run patterns (2026-06-11)', () => {
  // Refusal phrasings the v1 list MISSED on the first real run (overcounted hallucination).
  it('catches the patterns the first run missed', () => {
    expect(isAbstention('None of the documents mention an antivirus product deployed on endpoints.')).toBe(true)
    expect(isAbstention('The handbook does not specify the number of paid sick days.')).toBe(true)
    expect(isAbstention('The question is not addressed in any of the provided document excerpts.')).toBe(true)
    expect(isAbstention('The documents do not provide information on the monthly cost.')).toBe(true)
    expect(isAbstention('Die Dokumente sind nicht ausreichend, um die Vertragsstrafe zu bestimmen.')).toBe(true)
    expect(isAbstention('Keine der angegebenen Dokumente enthält Informationen zu einem Antivirenprodukt.')).toBe(true)
    expect(isAbstention('Im Rahmenvertrag wird keine explizite Vertragsstrafe genannt.')).toBe(true)
    expect(isAbstention('Antwort nicht möglich aufgrund fehlender Daten.')).toBe(true)
    expect(isAbstention('Die monatliche Miete ist nicht direkt angegeben.')).toBe(true)
    // Refusal templates surfaced by the second audit pass.
    expect(isAbstention('The penalty is not explicitly detailed in the provided excerpts.')).toBe(true)
    expect(isAbstention('Es wird jedoch nicht ausdrücklich genannt, welches Lehrbuch verwendet wird.')).toBe(true)
    expect(isAbstention('Die Information ist nicht im bereitgestellten Dokument enthalten.')).toBe(true)
    expect(isAbstention('Die genaue Bezeichnung ist aus dem Kontext nicht abzuleiten.')).toBe(true)
  })
  // The boundary: genuine WRONG answers (distractor conflations) must stay hallucinations.
  it('does NOT flag a confident wrong answer (real hallucinations from the run)', () => {
    expect(isAbstention('The handbook grants twenty paid sick days per year [S1].')).toBe(false)
    expect(isAbstention('A late fee of 2 percent applies after the due date [S1].')).toBe(false)
    expect(isAbstention('Laut dem Mitarbeiterhandbuch gibt es 20 bezahlte Urlaubstage pro Jahr [S1].')).toBe(false)
  })
})

describe('scoreItem — hedged-but-correct vs over-abstention (post-audit semantics)', () => {
  const answerableItem: EvalItem = {
    id: 'en-hr-vacation', lang: 'en', question: 'How many vacation days?',
    answer: ['twenty', '20'], unanswerable: false, gold_doc: 'Employee Handbook.docx', type: 'numeric'
  }
  it('a right + correctly-cited answer counts even if it also hedges', () => {
    const s = scoreItem(answerableItem, {
      answer: 'The handbook does not specify sick days, but it grants twenty vacation days per year [S1].',
      citations: [{ label: 'S1', sourceTitle: 'Employee Handbook.docx' }]
    })
    expect(s.em).toBe(1)
    expect(s.abstained).toBe(true) // contains a refusal phrase ("does not specify")
    expect(s.correct).toBe(true) // …but it answered correctly + cited right → still correct
  })
  it('a true over-abstention (declined, no gold span) is incorrect', () => {
    const s = scoreItem(answerableItem, { answer: 'That is not specified in the documents.', citations: [] })
    expect(s.em).toBe(0)
    expect(s.abstained).toBe(true)
    expect(s.correct).toBe(false)
  })
})

const answerable: EvalItem = {
  id: 'de-contract-liability-01',
  lang: 'de',
  pair: 'contract-liability-01',
  question: 'Wie hoch ist die Haftungsobergrenze im Vertrag mit Acme?',
  answer: ['eine Million US-Dollar', '1.000.000 USD'],
  unanswerable: false,
  gold_doc: 'Acme Rahmenvertrag.pdf',
  type: 'numeric'
}

const unanswerable: EvalItem = {
  id: 'de-contract-penalty-01',
  lang: 'de',
  question: 'Welche Vertragsstrafe gilt bei verspäteter Lieferung?',
  answer: [],
  unanswerable: true,
  gold_doc: null,
  type: 'unanswerable'
}

describe('scoreItem', () => {
  it('answerable + correct + cited right doc → correct', () => {
    const out: ItemOutput = {
      answer: 'Die Haftung ist auf eine Million US-Dollar begrenzt [S1].',
      citations: [{ label: 'S1', sourceTitle: 'Acme Rahmenvertrag.pdf' }],
      citedTexts: ['... Gesamthaftung übersteigt nicht eine Million US-Dollar ...']
    }
    const s = scoreItem(answerable, out)
    expect(s.em).toBe(1)
    expect(s.citationCorrect).toBe(true)
    expect(s.grounded).toBe(true)
    expect(s.abstained).toBe(false)
    expect(s.correct).toBe(true)
  })

  it('answerable + correct string but WRONG citation → not correct', () => {
    const out: ItemOutput = {
      answer: 'eine Million US-Dollar [S1].',
      citations: [{ label: 'S1', sourceTitle: 'Globex Invoice INV-2024-001.pdf' }]
    }
    const s = scoreItem(answerable, out)
    expect(s.em).toBe(1)
    expect(s.citationCorrect).toBe(false)
    expect(s.correct).toBe(false)
  })

  it('answerable but model abstained → not correct (over-abstention)', () => {
    const out: ItemOutput = {
      answer: 'Das geht aus den Dokumenten nicht hervor.',
      citations: []
    }
    const s = scoreItem(answerable, out)
    expect(s.abstained).toBe(true)
    expect(s.em).toBe(0)
    expect(s.correct).toBe(false)
  })

  it('unanswerable + abstained → correct', () => {
    const s = scoreItem(unanswerable, { answer: 'Dazu liegen keine Informationen vor.', citations: [] })
    expect(s.abstained).toBe(true)
    expect(s.correct).toBe(true)
  })

  it('unanswerable + confidently answered → incorrect (hallucination)', () => {
    const s = scoreItem(unanswerable, {
      answer: 'Die Vertragsstrafe beträgt 5% des Auftragswerts [S1].',
      citations: [{ label: 'S1', sourceTitle: 'Acme Rahmenvertrag.pdf' }]
    })
    expect(s.abstained).toBe(false)
    expect(s.correct).toBe(false)
  })
})

describe('aggregate + toCsvRow', () => {
  const item = (over: Partial<EvalItem>): EvalItem => ({ ...answerable, ...over })
  const scores = [
    scoreItem(item({ id: 'de-1', lang: 'de' }), {
      answer: 'eine Million US-Dollar [S1].',
      citations: [{ label: 'S1', sourceTitle: 'Acme Rahmenvertrag.pdf' }]
    }),
    scoreItem(item({ id: 'en-1', lang: 'en', answer: ['one million US dollars'] }), {
      answer: 'one million US dollars [S1].',
      citations: [{ label: 'S1', sourceTitle: 'Acme Rahmenvertrag.pdf' }]
    }),
    scoreItem({ ...unanswerable, id: 'de-u1' }, { answer: 'Keine Informationen dazu.', citations: [] })
  ]

  it('computes language-split rates and the unanswerable abstain rate', () => {
    const a = aggregate('granite-4.1-8b-q4', scores)
    expect(a.n).toBe(3)
    expect(a.answerable).toBe(2)
    expect(a.unanswerable).toBe(1)
    expect(a.emRate).toBe(1)
    expect(a.emRateDe).toBe(1)
    expect(a.emRateEn).toBe(1)
    expect(a.abstainRate).toBe(1)
    expect(a.hallucinationRate).toBe(0)
  })

  it('serializes a CSV row whose column count matches the header', () => {
    const a = aggregate('granite-4.1-8b-q4', scores)
    const cols = toCsvRow(a).split(',')
    expect(cols.length).toBe(QA_CSV_HEADER.length)
    expect(cols[0]).toBe('granite-4.1-8b-q4')
  })
})
