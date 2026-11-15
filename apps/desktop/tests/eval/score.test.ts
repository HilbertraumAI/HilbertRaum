import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../helpers/repo-files'
import { hangBudgetMs } from '../helpers/hang-budget'
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
// catalog promotions (§5.4) is covered without a benchmark run. The one exception is the
// `eval/rescore.mjs` mirror block at the end, which runs that script under plain node.

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

describe('isAbstention — audited real-run patterns v3 (2026-08-03, the two i9 runs)', () => {
  // The 9 refusal phrasings the v2 list missed across the 2026-07-09 (13 models) and
  // 2026-07-30 (Gemma-4 wave) i9 runs — each string below is VERBATIM from the committed
  // eval/results/*-items.jsonl dumps (model-benchmarks.md §9.3 wave outcome record).
  it('catches the split-negation and new phrase families the audits found', () => {
    // qwen3.6-27b-q4 · en-invoice-discount (both runs): "there is no … mentioned"
    expect(
      isAbstention(
        'Based on the provided document excerpts, there is no early-payment discount mentioned for the Globex invoice. The terms specify that the amount is payable within 30 days and that a late fee of 2 percent applies after the due date [S3].'
      )
    ).toBe(true)
    // qwen3-8b · de-contract-penalty: "keine explizit genannte …" + "nicht direkt erwähnt"
    expect(
      isAbstention(
        'Laut Rahmenvertrag gibt es keine explizit genannte Vertragsstrafe für verspätete Lieferungen [S2]. Die Vertragsstrafe wird nicht direkt erwähnt.'
      )
    ).toBe(true)
    // qwen3.5-35b-a3b · de-invoice-discount: "kein Skonto … erwähnt" + "keine Information"
    expect(
      isAbstention(
        'Basierend auf den bereitgestellten Dokumentauszügen wird für die Globex-Rechnung (RE-2024-001) kein Skonto für eine frühere Zahlung erwähnt.'
      )
    ).toBe(true)
    expect(isAbstention('Es findet sich keine Information über einen Skontoabzug bei früherer Begleichung.')).toBe(true)
    // gemma4-e2b · de-coffee-grind: "kann … keine … finden"
    expect(
      isAbstention(
        'Ich kann aus den bereitgestellten Dokumentenauszügen keine Empfehlung zur Mahlstärke für Espresso finden.'
      )
    ).toBe(true)
    // gemma4-e2b · en-coffee-grind: "do not have information"
    expect(
      isAbstention(
        'I do not have information in the provided documents regarding the recommended grind size for espresso.'
      )
    ).toBe(true)
    // gemma4-e2b · de-invoice-discount: "keine spezifische Information"
    expect(
      isAbstention(
        'Es wird jedoch keine spezifische Information darüber gegeben, welcher Skonto bei früher Zahlung der Globex-Rechnung gilt.'
      )
    ).toBe(true)
    // gemma4-e4b · en-waste-extracost: "do not state"
    expect(
      isAbstention('The provided documents do not state the cost per month for an extra residual-waste bin.')
    ).toBe(true)
    // qwen3.5-2b · de-hausordnung-miete (the 2026-07-09 audit's "4–5 real" uncertainty item):
    // "keine spezifische monatliche Miete … genannt" reads as a refusal, not an invention.
    expect(
      isAbstention('Es wird jedoch keine spezifische monatliche Miete in diesem Dokument genannt.')
    ).toBe(true)
  })
  // Audited REAL hallucinations from the same runs must stay non-matches — including the
  // borderline qwen3-30b Lehrbuch item (hand-audited REAL 2026-07-09: hedges with "nicht
  // direkt genannt" but carries no kein/keine refusal and asserts distractor content). The v4
  // sentence family (#517) keeps this ruling: its participle form needs a source word in the
  // same sentence, and "im Italienischkurs" is not one.
  it('does NOT flag the audited real hallucinations from the i9 runs', () => {
    expect(
      isAbstention(
        'Das Lehrbuch wird im Italienischkurs nicht direkt genannt. Allerdings wird in [S1] erwähnt: "Bitte bringen Sie das Lehrbuch zur ersten Stunde mit." Es fehlen jedoch weitere Details zum spezifischen Lehrbuch.'
      )
    ).toBe(false)
    // The en-contract-penalty invoice-distractor trap (six models, both runs).
    expect(
      isAbstention('Under the agreement, a late fee of 2 percent applies after the due date for late delivery [S1].')
    ).toBe(false)
    // gemma4-e2b's sick-days/vacation-days conflation (incl. the language-bleed EN variant).
    expect(isAbstention('Vollzeitbeschäftigte erwerben zwanzig bezahlte Urlaubstage pro Jahr [S1, S2].')).toBe(false)
    // qwen3.5-0.8b's liability aside: "does not relate" must not read as a refusal.
    expect(
      isAbstention(
        'While the agreement mentions a maximum aggregate liability of one million US dollars, this figure does not relate to the specific penalty for late delivery under the Globex Invoice.'
      )
    ).toBe(false)
    // An affirmative kein-negation in a CORRECT answer must not match the kein…erwähnt family.
    expect(isAbstention('Es fallen keine weiteren Kosten für die erste Restmülltonne an [S2].')).toBe(false)
  })
})

describe('isAbstention — audited real-run patterns v4 (2026-09-27, #517: German "not stated" forms)', () => {
  // The #514 pin-bump gate (b9849 vs b11146, ten models) scored three items DIFFERENTLY for
  // the same substance — the scorer moved, not the model. Each string below is VERBATIM from
  // eval/results/i9-14900K-512-b{9849,11146}-vulkan-items.jsonl. Sentence-scoped families in
  // text.mjs: "nennt … nicht", and "nicht … angegeben/genannt/festgelegt/erwähnt/beantwortet"
  // when the same sentence names the source material.
  it('catches "nennt … nicht", "nicht festgelegt" and "nicht direkt genannt / angegeben / beantwortet"', () => {
    // qwen3.5-4b-ud-q4kxl · de-vhs-lehrbuch (unanswerable) — b9849: the verb-first form …
    expect(
      isAbstention(
        'Das Dokument [S1] erwähnt zwar, dass für den Italienischkurs ein Lehrbuch mitzubringen ist, nennt aber nicht, welches spezifische Lehrbuch verwendet wird.'
      )
    ).toBe(true)
    // … and its b11146 twin (a phrase the list already had — pinned so the pair stays level).
    expect(
      isAbstention(
        'Das angegebene Lehrbuch wird nicht im Dokument angegeben.\n\nDie einzige Erwähnung eines Lehrbuchs findet sich in [S1], wo lediglich gefordert wird, dass es zur ersten Stunde mitgebracht werden muss. Der genaue Titel oder der Autor werden in den bereitgestellten Auszügen nicht genannt.'
      )
    ).toBe(true)
    // qwen3.5-9b-ud-q4kxl · de-hr-sick (unanswerable) — b9849: plain "nicht festgelegt".
    expect(
      isAbstention(
        'Laut den vorliegenden Dokumenten sind die Anzahl der bezahlten Krankheitstage pro Jahr nicht festgelegt. Das Mitarbeiterhandbuch erwähnt lediglich, dass Vollzeitbeschäftigte zwanzig bezahlte **Urlaubstage** pro Jahr erwerben [S1]. Informationen zu bezahlten Krankheitstagen finden sich in den bereitgestellten Auszügen nicht.'
      )
    ).toBe(true)
    // qwen3-4b-instruct-q4 · de-contract-termination (answerable → an over-abstention) —
    // b9849 "in den Dokumenten nicht direkt genannt" vs b11146 "nicht direkt in den Dokumenten angegeben".
    expect(
      isAbstention(
        'Die Kündigungsfrist für eine ordentliche Kündigung des Rahmenvertrags wird in den Dokumenten nicht direkt genannt. Allerdings wird in [S1] die Kündigungsfrist während der Probezeit für neue Mitarbeitende als zwei Wochen angegeben.'
      )
    ).toBe(true)
    expect(
      isAbstention(
        'Die Kündigungsfrist für eine ordentliche Kündigung des Rahmenvertrags wird nicht direkt in den Dokumenten angegeben.'
      )
    ).toBe(true)
    // qwen3-14b-instruct-q4 · de-hr-sick (both builds; the #228 run hit the same form).
    expect(
      isAbstention(
        'Laut dem Mitarbeiterhandbuch gibt es für Vollzeitbeschäftigte zwanzig bezahlte Urlaubstage pro Jahr [S1]. Die Frage nach bezahlten Krankheitstagen wird in den bereitgestellten Dokumenten nicht direkt beantwortet.'
      )
    ).toBe(true)
  })
  it('does NOT flag a correct, cited answer that merely contains "nicht"', () => {
    expect(isAbstention('Die Frist ist nicht verlängerbar [S1].')).toBe(false)
    expect(
      isAbstention('Die Kündigungsfrist beträgt drei Monate [S1]. Eine Verlängerung ist im Vertrag nicht vorgesehen.')
    ).toBe(false)
    // "nicht" and a participle in DIFFERENT sentences never pair up (sentence scope).
    expect(
      isAbstention('Die Haftung ist nicht begrenzt [S1]. Die Obergrenze wird im Dokument in Abschnitt 4 genannt.')
    ).toBe(false)
    // A participle BEFORE the negation states a fact, it does not decline.
    expect(
      isAbstention('Der Lieferant wird im Dokument als Acme GmbH genannt und haftet nicht für Folgeschäden [S1].')
    ).toBe(false)
    // "nicht genannten" is an attribute — the participles match exactly.
    expect(isAbstention('Die im Dokument nicht genannten Nebenkosten trägt der Mieter [S1].')).toBe(false)
    // No source word in the sentence ⇒ the participle family stays out. This is the sentence
    // the v3 block above pins as a hand-audited REAL hallucination (2026-07-09).
    expect(isAbstention('Das Lehrbuch wird im Italienischkurs nicht direkt genannt.')).toBe(false)
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

/** A citation of `answerable`'s gold document. */
const cited = [{ label: 'S1', sourceTitle: 'Acme Rahmenvertrag.pdf' }]

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

// #378: containment EM saturates, so mean_f1 mostly ranks terseness; the mean answer length is
// reported beside it, over the same answerable items mean_f1 averages.
describe('mean_answer_chars (#378)', () => {
  // Answer lengths: 28 and 84 on the answerable items, 53 on the unanswerable one (a confident
  // answer, so it is not filtered out as an abstention either). Answerable only: 56; all: 55.
  const scores = [
    scoreItem({ ...answerable, id: 'de-1' }, { answer: 'eine Million US-Dollar [S1].', citations: cited }),
    scoreItem(
      { ...answerable, id: 'en-1', lang: 'en', answer: ['one million US dollars'] },
      { answer: 'The liability cap is one million US dollars under the Acme framework agreement [S1].', citations: cited }
    ),
    scoreItem(
      { ...unanswerable, id: 'de-u1' },
      { answer: 'Die Vertragsstrafe beträgt 5% des Auftragswerts [S1].', citations: cited }
    )
  ]

  it('is the QA column right after mean_f1', () => {
    expect(QA_CSV_HEADER.indexOf('mean_answer_chars')).toBe(QA_CSV_HEADER.indexOf('mean_f1') + 1)
  })

  it('averages over the answerable items only and lands in its own column', () => {
    const a = aggregate('gemma4-e4b-it-qat-q4', scores)
    expect(a.meanAnswerChars).toBe(56)
    expect(toCsvRow(a).split(',')[QA_CSV_HEADER.indexOf('mean_answer_chars')]).toBe('56.0')
  })
})

// `eval/rescore.mjs` re-aggregates the committed dumps under plain node, so its HEADER, its
// aggregate and its row are a hand mirror of QA_CSV_HEADER / aggregate() / toCsvRow(). These
// rows run the real script: a byte copy in a scratch tree laid out like the repo (it resolves
// `results/` and `text.mjs` relative to its own path), over a dump in the line shape
// `tests/manual/model-eval.test.ts` writes. Expected = score.ts on the same answers.
describe('eval/rescore.mjs mirrors score.ts', () => {
  const MODEL = 'gemma4-e4b-it-qat-q4'
  // Every column gets a non-trivial value: hits and a miss, a wrong citation, an over-abstention,
  // a correct abstention and a hallucination. The U+1F4C4 is two UTF-16 code units (the unit
  // both scorers count), so a mirror counting code points instead goes red.
  const answered: Array<[EvalItem, ItemOutput]> = [
    [{ ...answerable, id: 'de-1' }, { answer: 'eine Million US-Dollar [S1].', citations: cited, citedTexts: ['eine Million US-Dollar'] }],
    [
      { ...answerable, id: 'en-1', lang: 'en', answer: ['one million US dollars'] },
      { answer: 'The cap is one million US dollars [S1] \u{1F4C4}', citations: cited }
    ],
    [
      { ...answerable, id: 'en-2', lang: 'en', answer: ['one million US dollars'] },
      { answer: 'one million US dollars [S1].', citations: [{ label: 'S1', sourceTitle: 'Globex Invoice INV-2024-001.pdf' }] }
    ],
    [{ ...answerable, id: 'de-2' }, { answer: 'Das geht aus den Dokumenten nicht hervor.', citations: [] }],
    [{ ...unanswerable, id: 'de-u1' }, { answer: 'Keine Informationen dazu.', citations: [] }],
    [{ ...unanswerable, id: 'de-u2' }, { answer: 'Die Vertragsstrafe beträgt 5% des Auftragswerts [S1].', citations: cited }]
  ]
  const scores = answered.map(([item, out]) => scoreItem(item, out))
  const expectedCsv = `${QA_CSV_HEADER.join(',')}\n${toCsvRow(aggregate(MODEL, scores))}\n`

  let root: string
  const results = (): string => join(root, 'eval', 'results')
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hilbertraum-rescore-'))
    mkdirSync(join(root, 'eval', 'results'), { recursive: true })
    mkdirSync(join(root, 'apps', 'desktop', 'tests', 'eval'), { recursive: true })
    copyFileSync(join(REPO_ROOT, 'eval', 'rescore.mjs'), join(root, 'eval', 'rescore.mjs'))
    const textMjs = join('apps', 'desktop', 'tests', 'eval', 'text.mjs')
    copyFileSync(join(REPO_ROOT, textMjs), join(root, textMjs))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  // Exactly the keys (and order) of a committed dump line. No `answerChars`: every committed dump
  // predates it, so rescore.mjs must recompute the length from `answer`, never read the key.
  const writeDump = (stem: string): void => {
    const lines = answered.map(([, out], i) => {
      const s = scores[i]
      return JSON.stringify({
        model: MODEL,
        id: s.id,
        lang: s.lang,
        type: s.type,
        unanswerable: s.unanswerable,
        em: s.em,
        f1: s.f1,
        abstained: s.abstained,
        citationPresent: s.citationPresent,
        citationCorrect: s.citationCorrect,
        grounded: s.grounded,
        correct: s.correct,
        answer: out.answer,
        citations: out.citations.map((c) => `${c.label}=${c.sourceTitle}`)
      })
    })
    writeFileSync(join(results(), `${stem}-items.jsonl`), lines.join('\n') + '\n', 'utf8')
  }
  const runRescore = (...args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [join(root, 'eval', 'rescore.mjs'), ...args], {
      encoding: 'utf8',
      timeout: hangBudgetMs(10_000)
    })
  const rescore = (...args: string[]): void => {
    const run = runRescore(...args)
    expect(run.status, String(run.stderr)).toBe(0)
  }
  const rescored = (stem: string): string => join(results(), `${stem}-quality-rescored.csv`)

  it('writes the same header and row as QA_CSV_HEADER + toCsvRow(aggregate()) for the same answers', () => {
    writeDump('run-a')
    rescore()
    expect(readFileSync(rescored('run-a'), 'utf8')).toBe(expectedCsv)
  })

  it('with --existing-only rewrites the rescored CSVs that exist and creates no new one', () => {
    writeDump('run-a')
    writeDump('run-b')
    writeFileSync(rescored('run-a'), 'model,n\nstale,0\n', 'utf8')
    rescore('--existing-only')
    expect(readFileSync(rescored('run-a'), 'utf8')).toBe(expectedCsv)
    expect(existsSync(rescored('run-b'))).toBe(false)
  })

  it('refuses an unknown argument with exit code 2 and writes nothing (a mistyped flag must not rescore every dump)', () => {
    writeDump('run-a')
    const run = runRescore('--existing')
    expect(run.status).toBe(2)
    expect(existsSync(rescored('run-a'))).toBe(false)
  })
})
