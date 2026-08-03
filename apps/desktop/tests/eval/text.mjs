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

/** True when the answer reads as a refusal to answer (heuristic — audit raw dumps too). */
export function isAbstention(answer) {
  const flat = ' ' + normalizeText(answer) + ' '
  return (
    ABSTAIN_PHRASES.some((p) => flat.includes(' ' + normalizeText(p) + ' ')) ||
    ABSTAIN_PATTERNS.some((re) => re.test(flat))
  )
}
