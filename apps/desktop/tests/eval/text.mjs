// Shared text primitives for the Phase-29 scorer (model-benchmarks.md §2).
//
// Lives as plain ESM JS (not TS) so BOTH the TypeScript scorer (`score.ts`, via vitest's
// esbuild) AND the offline re-score script (`eval/rescore.mjs`, via plain `node`) import the
// EXACT SAME normalization + abstention logic — no drift between a fresh harness run and a
// re-score of a dumped run. `score.ts` re-exports these; `score.test.ts` is the canonical
// regression guard for the phrase list.

/** NFC-fold, lowercase, replace every non-(letter|number) run with a single space, trim.
 *  German-aware: umlauts/ß are `\p{L}` and are KEPT (folding them would hide the D18 delta). */
export function normalizeText(s) {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Refusal phrases (DE + EN), matched as whole-token substrings of the normalized answer.
// HEURISTIC — expanded 2026-06-11 after auditing the first real run's unanswerable answers
// (the v1 list missed "none of the documents mention", "does not specify", "keine der …
// enthält", "nicht ausreichend", bolded Ministral refusals, etc. → it overcounted
// hallucination). Phrases are written naturally and normalized before matching, so
// punctuation/apostrophes/markdown asterisks don't matter. Keep phrases that signal a REFUSAL
// only — never a phrase that could appear in a confident correct answer (a genuine wrong
// answer like "twenty paid sick days" must NOT match).
export const ABSTAIN_PHRASES = [
  // English
  'not enough information',
  'do not contain',
  'does not contain',
  "doesn't contain",
  'not contain enough',
  'do not contain information',
  'cannot find',
  "can't find",
  "couldn't find",
  'could not find',
  'no information',
  'not mentioned',
  "isn't mentioned",
  'not specified',
  'does not specify',
  'do not specify',
  "doesn't specify",
  'not stated',
  'not provided',
  'do not provide',
  'does not provide',
  'unable to answer',
  'cannot answer',
  "can't answer",
  "don't have enough",
  'do not have enough',
  'no relevant',
  'not available',
  'do not mention',
  'does not mention',
  "don't mention",
  'no mention',
  'none of the',
  'not addressed',
  'is not addressed',
  'not possible to determine',
  'no specific',
  'not explicitly',
  'do not indicate',
  'does not indicate',
  'not contain information',
  // German
  'nicht genug',
  'nicht genügend',
  'nicht ausreichend',
  'keine ausreichenden',
  'keine informationen',
  'keine angaben',
  'keine angabe',
  'keine der',
  'keine antwort',
  'nicht hervor',
  'lässt sich nicht',
  'nicht in den dokumenten',
  'nicht enthalten',
  'enthalten keine',
  'enthalten nicht',
  'enthält keine',
  'nicht beantworten',
  'nicht beantwortet',
  'kann nicht beantwortet',
  'nicht angegeben',
  'nicht direkt angegeben',
  'nicht erwähnt',
  'nicht genannt',
  'nicht ausdrücklich',
  'nicht explizit',
  'keine explizite',
  'nicht abzuleiten',
  'nicht im bereitgestellten',
  'nicht in den bereitgestellten',
  'konnte nicht',
  'finde keine',
  'finden sich nicht',
  'nicht verfügbar',
  'nicht möglich',
  'fehlender daten',
  'fehlende daten',
  'nicht ersichtlich',
  'nicht entnehmen',
  'nicht bestimmt werden',
  'nicht abgeleitet',
  'nicht bestätigt werden',
  'wird kein',
  'wird keine',
  'gibt keinen',
  'gibt keine',
  'keinen spezifischen',
  // v3 additions (2026-08-03) — the 9 detector misses audited across the 2026-07-09 and
  // 2026-07-30 i9 runs (model-benchmarks.md §9 "Scorer confound" + §9.3 wave outcome; raw
  // items in eval/results/*-items.jsonl). Same rule as above: refusal-only phrasings.
  'do not have information',
  'does not have information',
  "don't have information",
  'do not state',
  'does not state',
  "doesn't state",
  'keine spezifische',
  'keine information',
  'nicht direkt erwähnt'
]

// v3 (2026-08-03): split-negation refusal families a contiguous phrase cannot express,
// observed verbatim in the audited runs — "there is no <X> mentioned", "kein/keine <X>
// erwähnt/genannt/angegeben", "kann … keine <X> finden". Applied to the SAME normalized flat
// text as the phrases. Keep the gap bounds tight: a wide gap is how a confident answer with an
// incidental negation would start matching (the regression suite pins audited REAL
// hallucinations as non-matches — e.g. the qwen3-30b "nicht direkt genannt …" item stays a
// hallucination per the 2026-07-09 hand audit because it carries no kein/keine token).
export const ABSTAIN_PATTERNS = [
  / there (?:is|are) no (?:\S+ ){0,8}?(?:mentioned|specified|stated) /,
  / kein(?:e|en)? (?:\S+ ){0,8}?(?:erwähnt|genannt|angegeben)\S* /,
  / kann (?:\S+ ){0,10}?keine (?:\S+ ){0,8}?(?:finden|entnehmen|ableiten) /
]

// v4 (2026-09-27, #517): German "not stated" forms whose words a fixed phrase cannot pin
// down — "nicht … angegeben / genannt / festgelegt / erwähnt / beantwortet" with an adverb or
// a source reference in between ("wird in den Dokumenten nicht direkt genannt", "nicht direkt
// in den Dokumenten angegeben", "laut den Dokumenten … nicht festgelegt") and the verb-first
// "nennt … nicht" ("nennt aber nicht, welches Lehrbuch …"). Observed in the #514 pin-bump
// gate: three items scored differently on b9849 vs b11146 for the SAME substance, i.e. the
// scorer moved, not the model. These run on ONE SENTENCE at a time (the raw answer split on
// sentence punctuation BEFORE normalization erases it), with a tight gap, so an incidental
// "nicht" in a confident answer ("Die Frist ist nicht verlängerbar [S1]") cannot pair with a
// participle two sentences later. Participles are matched exactly — no `\S*` — so "nicht
// genannten" (an attribute, not a refusal) stays out. The participle family additionally
// requires the SAME sentence to name the source material (Dokument/Auszüge/Unterlagen/Quelle/
// Text/Kontext/Exemplare …): "X wird im Dokument nicht genannt" declines, "X wird im Kurs nicht
// direkt genannt" is a claim about X — this keeps the 2026-07-09 hand-audit ruling on the
// qwen3-30b Lehrbuch item (pinned below in score.test.ts) intact. The verb-first form needs no
// source word: "nennt … nicht" already says a source fails to name something.
export const ABSTAIN_SENTENCE_PATTERNS = [
  / nennt (?:\S+ ){0,3}?nicht /
]
const NOT_STATED_PARTICIPLE = / nicht (?:\S+ ){0,4}?(?:angegeben|genannt|festgelegt|erwähnt|beantwortet) /
const NAMES_SOURCE_MATERIAL =
  / (?:\S*dokument\S*|\S*auszug\S*|\S*auszüge\S*|unterlagen|quellen?|texte?n?|kontext|exemplaren?) /

/** Sentence boundaries for the sentence-scoped families (raw text, pre-normalization). */
const SENTENCE_BOUNDARY = /[.!?;:\n…]+/

/** The sentence-scoped v4 test (one raw sentence in, normalized inside). */
function isAbstentionSentence(sentence) {
  const s = ' ' + normalizeText(sentence) + ' '
  return (
    ABSTAIN_SENTENCE_PATTERNS.some((re) => re.test(s)) ||
    (NOT_STATED_PARTICIPLE.test(s) && NAMES_SOURCE_MATERIAL.test(s))
  )
}

/** True when the answer reads as a refusal to answer (heuristic — audit raw dumps too). */
export function isAbstention(answer) {
  const flat = ' ' + normalizeText(answer) + ' '
  if (
    ABSTAIN_PHRASES.some((p) => flat.includes(' ' + normalizeText(p) + ' ')) ||
    ABSTAIN_PATTERNS.some((re) => re.test(flat))
  ) {
    return true
  }
  return answer.split(SENTENCE_BOUNDARY).some(isAbstentionSentence)
}
