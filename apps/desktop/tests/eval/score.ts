// Deterministic, judge-free scoring for the Phase-29 model benchmark
// (model-benchmarks.md §2 / D19). NO cloud judge, NO telemetry — every metric
// here is pure local string math so a run is reproducible and offline by construction.
//
// This module is intentionally dependency-free (no db / runtime / rag imports) so the unit
// test `score.test.ts` runs in CI without a model, a binary, or `node:sqlite`. The manual
// harness `tests/manual/model-eval.test.ts` imports these same functions to score real
// model output, so the math that decides promotions is the math that CI covers.
//
// Normalization + the abstention phrase list live in `./text.mjs` (shared verbatim with the
// offline `eval/rescore.mjs`); this file re-exports them so `./score` stays the single import.

import { normalizeText, ABSTAIN_PHRASES, isAbstention } from './text.mjs'
export { normalizeText, ABSTAIN_PHRASES, isAbstention }
//
// Placement note: the eval DATA + RESULTS live at the repo root `eval/` (per the plan —
// `eval/rag_de_en.jsonl`, `eval/results/*.csv`); the scoring CODE lives here with the tests
// so vitest (`include: tests/**`) gives it coverage. Repo-root `eval/` stays code-free.

/** One eval item, as stored in `eval/rag_de_en.jsonl` (one JSON object per line). */
export interface EvalItem {
  /** Stable id, e.g. `de-contract-liability-01`. Parallel DE/EN pairs share a stem. */
  id: string
  lang: 'de' | 'en'
  /** Grouping key shared by a parallel DE/EN pair (e.g. `contract-liability-01`). */
  pair?: string
  question: string
  /**
   * Accepted gold answer spans (any one counts as a hit). Verbatim spans authored to be
   * present in the corpus. EMPTY for unanswerable items (gold behaviour = abstain).
   */
  answer: string[]
  /** True = no corpus passage answers this; the model should decline (D19, ~15% of items). */
  unanswerable: boolean
  /** Expected cited document title (`source_label`/`Citation.sourceTitle`); null when unanswerable. */
  gold_doc: string | null
  type: 'span' | 'numeric' | 'date' | 'entity' | 'synthesis' | 'unanswerable'
}

/** One corpus passage, as stored in `eval/corpus_de_en.jsonl`. */
export interface CorpusChunk {
  /** Document title — becomes `documents.title` + the chunk `source_label` (= citation title). */
  doc: string
  lang: 'de' | 'en'
  /** 0-based order within the document. */
  index: number
  text: string
}

/** What the harness captured from one model answering one item (the real RAG output). */
export interface ItemOutput {
  answer: string
  citations: Array<{ label: string; sourceTitle: string }>
  /** Cited chunk texts, for the grounding check (answer span ∈ a cited chunk). */
  citedTexts?: string[]
}

/** The deterministic score of one (model, item) pair. */
export interface ItemScore {
  id: string
  lang: 'de' | 'en'
  type: EvalItem['type']
  unanswerable: boolean
  em: 0 | 1
  f1: number
  abstained: boolean
  citationPresent: boolean
  citationCorrect: boolean
  grounded: boolean
  /** Overall verdict (drives the §5.4 decision rule). See `scoreItem` for the definition. */
  correct: boolean
}

// --- Token metrics (German-aware via the shared `normalizeText`) ------------------------

export function tokenize(s: string): string[] {
  const n = normalizeText(s)
  return n.length === 0 ? [] : n.split(' ')
}

/** Standard token-overlap F1 (prediction vs a single gold span). */
export function tokenF1(prediction: string, gold: string): number {
  const pred = tokenize(prediction)
  const goldToks = tokenize(gold)
  if (pred.length === 0 && goldToks.length === 0) return 1
  if (pred.length === 0 || goldToks.length === 0) return 0
  const goldCounts = new Map<string, number>()
  for (const t of goldToks) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1)
  let overlap = 0
  for (const t of pred) {
    const c = goldCounts.get(t)
    if (c && c > 0) {
      overlap++
      goldCounts.set(t, c - 1)
    }
  }
  if (overlap === 0) return 0
  const precision = overlap / pred.length
  const recall = overlap / goldToks.length
  return (2 * precision * recall) / (precision + recall)
}

/** Best token-F1 over all accepted gold spans (0 if none). */
export function bestF1(prediction: string, golds: string[]): number {
  return golds.reduce((best, g) => Math.max(best, tokenF1(prediction, g)), 0)
}

/**
 * Containment exact-match: a generative grounded answer is a sentence, not a bare span, so
 * "EM" = the normalized answer CONTAINS a normalized gold span (any accepted span counts).
 * Token-boundary aware (substring on the space-joined normalized token streams) so "donau"
 * matches inside "die donau" but "ein" does not match inside "keine".
 */
export function containsGold(prediction: string, golds: string[]): boolean {
  const pred = ' ' + tokenize(prediction).join(' ') + ' '
  for (const g of golds) {
    const goldToks = tokenize(g)
    if (goldToks.length === 0) continue
    if (pred.includes(' ' + goldToks.join(' ') + ' ')) return true
  }
  return false
}

// (Abstention detection — `isAbstention` / `ABSTAIN_PHRASES` — lives in `./text.mjs`, shared
// verbatim with `eval/rescore.mjs` and re-exported above. It is a HEURISTIC, so the harness
// dumps every raw answer for audit, and unanswerable-item numbers must be read against that
// dump, not trusted blind, per plan §7.)

// --- Per-item + aggregate scoring ------------------------------------------------------

/**
 * Score one model answer against one gold item. Verdict (`correct`):
 *  - unanswerable item → correct ⇔ the model abstained (a confident answer = a hallucination);
 *  - answerable item   → correct ⇔ the gold span is present (EM) AND the answer cited the right
 *    document. We do NOT also require `!abstained` here: a hedged-but-correct answer ("the
 *    handbook lists vacation, not sick days, but vacation is twenty days [S1]") still answered,
 *    and a stray refusal phrase shouldn't flip a right+cited answer to wrong. `over_abstain`
 *    (declined an answerable item AND gave no gold span) is tracked separately as a diagnostic.
 */
export function scoreItem(item: EvalItem, out: ItemOutput): ItemScore {
  const abstained = isAbstention(out.answer)
  const em = !item.unanswerable && containsGold(out.answer, item.answer) ? 1 : 0
  const f1 = item.unanswerable ? 0 : bestF1(out.answer, item.answer)
  const citationPresent = out.citations.length > 0
  const citationCorrect =
    !item.unanswerable &&
    item.gold_doc != null &&
    out.citations.some((c) => c.sourceTitle === item.gold_doc)
  const grounded =
    em === 1 &&
    (out.citedTexts ?? []).some((t) => containsGold(t, item.answer))

  const correct = item.unanswerable ? abstained : em === 1 && citationCorrect
  return {
    id: item.id,
    lang: item.lang,
    type: item.type,
    unanswerable: item.unanswerable,
    em: em as 0 | 1,
    f1,
    abstained,
    citationPresent,
    citationCorrect,
    grounded,
    correct
  }
}

/** Aggregate metrics for one model, split so the DE-minus-EN gap (D18) is directly readable. */
export interface ModelAggregate {
  model: string
  n: number
  // Answerable items
  answerable: number
  emRate: number // EM over answerable
  meanF1: number // mean token-F1 over answerable
  citationCorrectRate: number // over answerable
  groundedRate: number // over answerable
  overAbstainRate: number // answerable items the model wrongly declined
  // Unanswerable items
  unanswerable: number
  abstainRate: number // correct abstention over unanswerable (higher = better)
  hallucinationRate: number // unanswerable items answered anyway (lower = better)
  // Language split (EM rate over answerable items of each language) — the D18 signal
  emRateDe: number
  emRateEn: number
  f1De: number
  f1En: number
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
function rate(num: number, den: number): number {
  return den === 0 ? 0 : num / den
}

export function aggregate(model: string, scores: ItemScore[]): ModelAggregate {
  const ans = scores.filter((s) => !s.unanswerable)
  const un = scores.filter((s) => s.unanswerable)
  const ansDe = ans.filter((s) => s.lang === 'de')
  const ansEn = ans.filter((s) => s.lang === 'en')
  return {
    model,
    n: scores.length,
    answerable: ans.length,
    emRate: rate(ans.filter((s) => s.em === 1).length, ans.length),
    meanF1: mean(ans.map((s) => s.f1)),
    citationCorrectRate: rate(ans.filter((s) => s.citationCorrect).length, ans.length),
    groundedRate: rate(ans.filter((s) => s.grounded).length, ans.length),
    overAbstainRate: rate(ans.filter((s) => s.abstained && s.em === 0).length, ans.length),
    unanswerable: un.length,
    abstainRate: rate(un.filter((s) => s.abstained).length, un.length),
    hallucinationRate: rate(un.filter((s) => !s.abstained).length, un.length),
    emRateDe: rate(ansDe.filter((s) => s.em === 1).length, ansDe.length),
    emRateEn: rate(ansEn.filter((s) => s.em === 1).length, ansEn.length),
    f1De: mean(ansDe.map((s) => s.f1)),
    f1En: mean(ansEn.map((s) => s.f1))
  }
}

/** The QA columns of one `eval/results/<machine>-<backend>.csv` row (speed/RSS joined later). */
export const QA_CSV_HEADER = [
  'model',
  'n',
  'em_rate',
  'mean_f1',
  'citation_correct_rate',
  'grounded_rate',
  'over_abstain_rate',
  'abstain_rate_unans',
  'hallucination_rate',
  'em_rate_de',
  'em_rate_en',
  'f1_de',
  'f1_en'
] as const

function num(x: number): string {
  return x.toFixed(4)
}

export function toCsvRow(a: ModelAggregate): string {
  return [
    a.model,
    String(a.n),
    num(a.emRate),
    num(a.meanF1),
    num(a.citationCorrectRate),
    num(a.groundedRate),
    num(a.overAbstainRate),
    num(a.abstainRate),
    num(a.hallucinationRate),
    num(a.emRateDe),
    num(a.emRateEn),
    num(a.f1De),
    num(a.f1En)
  ].join(',')
}
