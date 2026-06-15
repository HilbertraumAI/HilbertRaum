import { extname } from 'node:path'
import { approxTokenCount, windowByTokens } from '../ingestion/chunker'
import { cosineSimilarity } from '../embeddings'
import { SUMMARY_TOKENS_PER_WORD } from './summary'

// Compare window math + templates (split out of the former monolithic doctasks.ts —
// audit M-A4).
//
// The result is a MATERIALIZED corpus document ("Comparison: A vs B.md") and the
// strategy auto-switches on token math:
//   (a) small-docs full compare — both documents' full texts fit one call ⇒ one
//       structured-comparison call over both, then materialize.
//   (b) section-matched compare — for each window of doc A's chunks, the nearest doc-B
//       chunks are retrieved via the EXISTING VectorIndex scoped to doc B (the
//       `documentIds` scoping; the vectors are already there — no new index), each
//       matched pair is compared (map), and one reduce merges the notes into the report.
//       Mode (b) is A-DRIVEN ⇒ asymmetric (see the honesty note below).
//   (c) symmetric both-trees compare (Phase 4, plan §4.3, H8) — when BOTH documents have a
//       ready deep index, align their level-1 summary SECTIONS by node-vector cosine
//       (`alignNodes`, greedy mutual-best-match with a SWAP-INVARIANT tie-break), diff each
//       aligned pair, and attribute unmatched sections to Only-A / Only-B. Swapping A and B
//       yields the mirror-image report — the property mode (b) cannot give. The manager
//       embeds the nodes lazily on first use (`ensureNodeEmbeddings`); the diff/reduce live
//       in the manager. The pure alignment lives here so it is unit-testable for the mirror.
//
// Mode-(a) input: like the translation, mode (a) reads the parser's SEGMENTS
// re-extracted from the stored copies — NOT the stored chunks. Two reasons:
// chunk overlap (~80 tokens) would present duplicated text to the model as if both
// documents repeated themselves (phantom "shared" content in a comparison, where a
// summary merely tolerated repetition), and the MODE DECISION itself must be made on
// the true text length — the overlap inflates a chunk-based estimate by ~16%, enough
// to push a fitting pair into the heavier mode (b). Cost: one re-parse per document,
// the same the preview pays. Mode (b)'s map step uses the stored CHUNKS instead — the
// pairing needs their vectors, and per-pair notes tolerate overlap like summary
// partials do.
//
// Mode (b) honesty note: the pairing is A-driven (B excerpts are retrieved by
// similarity to A's sections), so "only in B" findings are structurally weaker than
// "only in A" — the reduce is instructed to report only what the notes support, and
// the per-pair prompt lets the model flag B-excerpt content without an A counterpart.
// Recorded in known-limitations.md.

/** maxTokens for the single-pass and reduce calls (also the output reserve). */
export const COMPARE_OUTPUT_TOKENS = 512
/** Reserved for the instruction template + chat chrome, in model tokens. */
export const COMPARE_PROMPT_RESERVE_TOKENS = 300
/** Comparison is faithful synthesis, not creative writing (same as summary). */
export const COMPARE_TEMPERATURE = 0.3
/** Hard ceiling on map calls (like the summary ceiling: bounded CPU latency). */
export const COMPARE_MAP_CALL_CEILING = 12
/** Floor for a map call's output cap — below this, per-pair notes stop being useful. */
const COMPARE_MAP_OUTPUT_FLOOR_TOKENS = 128
/** Nearest doc-B chunks retrieved per doc-A chunk before the word-budget fill. */
export const COMPARE_NEIGHBORS_PER_CHUNK = 3

/** Usable model tokens for input text after the prompt + output reserves. */
function compareUsableInputTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - COMPARE_OUTPUT_TOKENS - COMPARE_PROMPT_RESERVE_TOKENS
}

/** Total per-call input budget in WORDS (both documents/sides together). */
export function compareBudgetWords(contextTokens: number): number {
  return Math.max(200, Math.floor(compareUsableInputTokens(contextTokens) / SUMMARY_TOKENS_PER_WORD))
}

/** Mode switch: do both documents' full texts fit one comparison call? */
export function compareFitsSinglePass(wordsA: number, wordsB: number, contextTokens: number): boolean {
  return wordsA + wordsB <= compareBudgetWords(contextTokens)
}

/** A doc-A chunk reference the mode-(b) planner windows (id kept for vector lookup). */
export interface CompareChunkRef {
  id: string
  text: string
}

/** One mode-(b) map window: consecutive doc-A chunks + the ids to retrieve B-neighbors for. */
export interface CompareWindow {
  chunkIds: string[]
  text: string
}

export interface ComparePlan {
  windows: CompareWindow[]
  /** True when the map-call ceiling cut doc-A coverage: the report covers its beginning. */
  truncated: boolean
  /** Output cap per map call, sized so ALL notes fit the reduce call's input budget. */
  mapMaxTokens: number
  /** Word budget for the retrieved doc-B excerpts of one map call (the B side's share). */
  pairBudgetWords: number
  /** Model calls (map windows + 1 reduce) + the materialize step. */
  stepsTotal: number
}

/**
 * Plan the mode-(b) map windows over doc A's chunks (pure — unit-tested at the
 * boundaries). The per-call input budget is split half/half between the doc-A window
 * and the retrieved doc-B excerpts; chunks pack greedily in document order into
 * A-windows of at most half the budget (an over-budget chunk is split, its pieces
 * keeping the chunk id — neighbors are per-chunk). More windows than the ceiling →
 * keep the first COMPARE_MAP_CALL_CEILING and mark the plan truncated.
 */
export function planCompareWindows(chunks: CompareChunkRef[], contextTokens: number): ComparePlan {
  const budget = compareBudgetWords(contextTokens)
  const aShare = Math.max(100, Math.floor(budget / 2))
  const pairBudgetWords = Math.max(100, budget - aShare)

  // Split over-budget chunks into aShare-sized pieces (id kept), then pack greedily.
  // Measuring/splitting by `approxTokenCount` (not a raw word count) keeps space-less or
  // glued text from packing past the budget and overflowing the model context.
  const pieces: Array<{ id: string; text: string; tokens: number }> = []
  for (const chunk of chunks) {
    const tokens = approxTokenCount(chunk.text)
    if (tokens === 0) continue
    if (tokens <= aShare) {
      pieces.push({ id: chunk.id, text: chunk.text, tokens })
    } else {
      for (const sub of windowByTokens(chunk.text, aShare, 0)) {
        pieces.push({ id: chunk.id, text: sub, tokens: approxTokenCount(sub) })
      }
    }
  }
  const windows: CompareWindow[] = []
  let ids: string[] = []
  let texts: string[] = []
  let tokens = 0
  const flush = (): void => {
    if (texts.length > 0) {
      windows.push({ chunkIds: ids, text: texts.join('\n\n') })
      ids = []
      texts = []
      tokens = 0
    }
  }
  for (const piece of pieces) {
    if (tokens > 0 && tokens + piece.tokens > aShare) flush()
    if (!ids.includes(piece.id)) ids.push(piece.id)
    texts.push(piece.text)
    tokens += piece.tokens
  }
  flush()

  let truncated = false
  let kept = windows
  if (windows.length > COMPARE_MAP_CALL_CEILING) {
    kept = windows.slice(0, COMPARE_MAP_CALL_CEILING)
    truncated = true
  }

  // Cap each map call's notes so all of them together provably fit the reduce input
  // (windows × mapMaxTokens ≤ usable input tokens).
  const mapMaxTokens = Math.max(
    COMPARE_MAP_OUTPUT_FLOOR_TOKENS,
    Math.min(
      COMPARE_OUTPUT_TOKENS,
      Math.floor(compareUsableInputTokens(contextTokens) / Math.max(1, kept.length))
    )
  )

  return {
    windows: kept,
    truncated,
    mapMaxTokens,
    pairBudgetWords,
    stepsTotal: kept.length + 2
  }
}

const COMPARE_SYSTEM_PROMPT_TEXT =
  'You are a careful assistant comparing two documents for their owner, fully offline. ' +
  'Use only the provided text. Never invent facts, names, or numbers. ' +
  'Write the comparison in the same language as the documents.'

/** Shared system prompt for every compare call (exported for the manual smoke harness). */
export function compareSystemPrompt(): string {
  return COMPARE_SYSTEM_PROMPT_TEXT
}

/**
 * The fixed report skeleton (common / differs / only-in-A / only-in-B). The
 * headings are dictated verbatim so the materialized report has a deterministic
 * structure; the bullet content follows the documents' language.
 */
export function compareReportHeadings(titleA: string, titleB: string): string[] {
  return [
    '## What both documents share',
    '## What differs between them',
    `## Only in "${titleA}"`,
    `## Only in "${titleB}"`
  ]
}

/** Mode (a): one structured-comparison call over both full texts. */
export function compareFullPrompt(
  titleA: string,
  textA: string,
  titleB: string,
  textB: string
): string {
  return (
    `Compare document A ("${titleA}") with document B ("${titleB}"). ` +
    'Write a structured comparison report in Markdown with exactly these four sections:\n' +
    compareReportHeadings(titleA, titleB).join('\n') +
    '\n\nUnder each heading write short bullet points. Keep important names, numbers, and ' +
    'dates exact. List each finding under exactly ONE section: something present in only ' +
    'one document belongs under its "Only in" section, not under the differences. ' +
    'If a section has nothing to report, write "Nothing notable." under it. ' +
    'Reply with ONLY the report — no introduction, no notes.\n\n' +
    `Document A ("${titleA}"):\n${textA}\n\n` +
    `Document B ("${titleB}"):\n${textB}`
  )
}

/**
 * Mode (b) map: one doc-A window against its retrieved doc-B excerpts. A deliberately
 * SMALLER per-pair format than the report: compact prefixed bullets the reduce can
 * merge mechanically.
 */
export function comparePairPrompt(
  titleA: string,
  titleB: string,
  part: number,
  total: number,
  windowText: string,
  excerptsB: string
): string {
  return (
    `You are comparing document A ("${titleA}") with document B ("${titleB}") section by ` +
    `section. This is section ${part} of ${total} of document A, shown together with the ` +
    'most closely related excerpts of document B. List your findings as short bullets, ' +
    'each prefixed exactly like this:\n' +
    '- Same: a fact stated by both\n' +
    '- Different: a fact where the two versions disagree (give both versions)\n' +
    '- Only in A: something in this section of A with no counterpart in the excerpts of B\n' +
    '- Only in B: something in the excerpts of B with no counterpart in this section of A\n' +
    'Check every fact in the section of A: if the excerpts of B do not mention it, list it ' +
    'under "Only in A". Keep names, numbers, and dates exact. Do not mention excerpts or ' +
    'sections. Reply with ONLY the bullets.\n\n' +
    `Section of document A:\n${windowText}\n\n` +
    `Related excerpts of document B:\n${excerptsB}`
  )
}

/** Mode (b) reduce: merge the per-window notes into the four-section report. */
export function compareReducePrompt(titleA: string, titleB: string, partials: string[]): string {
  return (
    `Below are comparison notes from consecutive sections of document A ("${titleA}"), each ` +
    `compared against the most closely related parts of document B ("${titleB}"). Combine ` +
    'them into one comparison report in Markdown with exactly these four sections:\n' +
    compareReportHeadings(titleA, titleB).join('\n') +
    '\n\nMerge duplicate points into one bullet, keep names, numbers, and dates exact, and ' +
    'only report what the notes support — never add facts of your own. List each finding ' +
    'under exactly ONE section: a point the notes mark as "Only in" one document belongs ' +
    'under that document\'s section, not under the differences. If a section has nothing ' +
    'to report, write "Nothing notable." under it. Do not mention the notes or sections. ' +
    'Reply with ONLY the report.\n\n' +
    partials.map((p, i) => `Notes ${i + 1}:\n${p}`).join('\n\n')
  )
}

/** The honesty attribution prepended to every materialized comparison. */
export function compareAttributionLine(modelId: string): string {
  return `Machine-generated comparison by ${modelId} — may contain errors.`
}

/** Honest in-document notice when the map ceiling cut doc-A coverage (mode b). */
export function compareTruncationNotice(titleA: string): string {
  return (
    `> ⚠ These documents are long — this comparison covers the beginning of "${titleA}". ` +
    'Both documents stay fully searchable and answerable in chat.'
  )
}

/**
 * Honest in-document notice for the SYMMETRIC mode (c) when the aligned-section notes
 * overflowed the reduce budget and the tail was condensed: unlike mode (b) this is not
 * "the beginning of A" — sections from either document may have been summarized away, so
 * the wording stays document-neutral (H8 — never imply a complete two-way comparison when
 * content was dropped). English literal, matching the `compareTruncationNotice` precedent.
 */
export function compareSymmetricTruncationNotice(): string {
  return (
    '> ⚠ These documents are long — some sections were condensed to fit, so this ' +
    'comparison may not list every section-level detail. Both documents stay fully ' +
    'searchable and answerable in chat.'
  )
}

/** `"report.pdf" + "draft.docx"` → `"Comparison: report vs draft.md"`. */
export function compareDocumentTitle(titleA: string, titleB: string): string {
  const base = (t: string): string => {
    const ext = extname(t)
    return (ext ? t.slice(0, -ext.length) : t).trim() || 'document'
  }
  return `Comparison: ${base(titleA)} vs ${base(titleB)}.md`
}

// ---------------------------------------------------------------------------------------
// Mode (c) — symmetric both-trees compare (Phase 4, plan §4.3 / H4 / H8). Pure pieces here;
// the lazy node-embed + diff/reduce orchestration lives in the manager (it needs the runtime).
// ---------------------------------------------------------------------------------------

/**
 * Cosine floor for two summary sections to count as the "same" aligned section. Below it a
 * candidate pair is dropped (the sections are about different things → Only-A / Only-B). With
 * the deterministic mock embedder, identical sections score 1.0 and unrelated ones score near
 * 0, so 0.5 cleanly separates matched from unmatched in tests; on the real E5 embedder it is a
 * conservative "clearly related" bar.
 */
export const SYMMETRIC_MATCH_MIN_SCORE = 0.5

/**
 * Hard ceiling on the number of aligned-section diff calls a symmetric compare will make
 * (keeps the both-trees path CPU-bounded on weak hardware — one model job at a time). When the
 * smaller document has more level-1 sections than this, the manager falls back to the labelled
 * asymmetric mode (b) instead. The pair count never exceeds min(sectionsA, sectionsB).
 */
export const SYMMETRIC_COMPARE_CALL_CEILING = 24

/** One node's vector for alignment (id + its L2-normalized summary vector). */
export interface AlignNode {
  id: string
  vec: Float32Array
}

export interface NodeAlignment {
  /** Mutually-best-matched A↔B section pairs (each id appears at most once). */
  pairs: Array<{ aId: string; bId: string; score: number }>
  /** A sections with no B counterpart ⇒ Only-A. */
  unmatchedA: string[]
  /** B sections with no A counterpart ⇒ Only-B. */
  unmatchedB: string[]
}

/** Swap-invariant ordering key for a candidate pair (so swapping A/B yields the mirror). */
function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId} ${bId}` : `${bId} ${aId}`
}

/**
 * Greedy mutual-best-match alignment of two sets of node vectors by cosine similarity (plan
 * §4.3, H4/H8). Candidate pairs at or above `minScore` are taken best-first, each node used at
 * most once. The comparator's tie-break is the SWAP-INVARIANT canonical pair key, so swapping A
 * and B produces the mirror alignment: the SAME matched set (with aId/bId swapped) and
 * unmatched-A ↔ unmatched-B. Leftover nodes become unmatchedA / unmatchedB (Only-A / Only-B).
 * Pure + deterministic ⇒ unit-testable for the mirror property without the model.
 */
export function alignNodes(
  a: AlignNode[],
  b: AlignNode[],
  minScore: number = SYMMETRIC_MATCH_MIN_SCORE
): NodeAlignment {
  const candidates: Array<{ aId: string; bId: string; score: number; key: string }> = []
  for (const an of a) {
    for (const bn of b) {
      if (an.vec.length !== bn.vec.length) continue
      const score = cosineSimilarity(an.vec, bn.vec)
      if (score >= minScore) {
        candidates.push({ aId: an.id, bId: bn.id, score, key: pairKey(an.id, bn.id) })
      }
    }
  }
  candidates.sort((x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  const usedA = new Set<string>()
  const usedB = new Set<string>()
  const pairs: NodeAlignment['pairs'] = []
  for (const c of candidates) {
    if (usedA.has(c.aId) || usedB.has(c.bId)) continue
    usedA.add(c.aId)
    usedB.add(c.bId)
    pairs.push({ aId: c.aId, bId: c.bId, score: c.score })
  }
  return {
    pairs,
    unmatchedA: a.filter((n) => !usedA.has(n.id)).map((n) => n.id),
    unmatchedB: b.filter((n) => !usedB.has(n.id)).map((n) => n.id)
  }
}

/** Per-pair output cap so all aligned-section notes provably fit the reduce input budget. */
export function comparePairOutputCap(contextTokens: number, pairCount: number): number {
  const usableInputTokens = compareBudgetWords(contextTokens) * SUMMARY_TOKENS_PER_WORD
  return Math.max(
    128,
    Math.min(COMPARE_OUTPUT_TOKENS, Math.floor(usableInputTokens / Math.max(1, pairCount)))
  )
}

/**
 * Mode (c) map: one aligned section of A against the matching section of B, on EQUAL footing
 * (unlike the A-driven mode-(b) pair prompt, where B is "related excerpts"). Same Same/Different/
 * Only-A/Only-B bullet format the reduce merges mechanically.
 */
export function compareNodePairPrompt(
  titleA: string,
  titleB: string,
  part: number,
  total: number,
  sectionA: string,
  sectionB: string
): string {
  return (
    `You are comparing document A ("${titleA}") with document B ("${titleB}") section by ` +
    `section. This is aligned section ${part} of ${total}: a section of A shown with the ` +
    'matching section of B. List your findings as short bullets, each prefixed exactly like ' +
    'this:\n' +
    '- Same: a fact stated by both\n' +
    '- Different: a fact where the two versions disagree (give both versions)\n' +
    '- Only in A: something in the section of A with no counterpart in the section of B\n' +
    '- Only in B: something in the section of B with no counterpart in the section of A\n' +
    'Keep names, numbers, and dates exact. Do not mention sections. Reply with ONLY the bullets.' +
    '\n\n' +
    `Section of document A:\n${sectionA}\n\n` +
    `Section of document B:\n${sectionB}`
  )
}

/**
 * The honesty label prepended to a mode-(b) ASYMMETRIC comparison (the two documents are not
 * BOTH deeply indexed, so the pairing is A-driven and "only in B" is structurally weaker —
 * H8). Human, jargon-free copy ("deeply index" is the user-facing name for a ready tree).
 */
export function compareAsymmetricNotice(titleB: string): string {
  return (
    '> ⚠ This comparison is one-directional — it may under-report content found only in ' +
    `"${titleB}". For a complete two-way comparison, deeply index both documents first, ` +
    'then compare again.'
  )
}
