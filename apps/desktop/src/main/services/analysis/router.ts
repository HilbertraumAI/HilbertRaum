import type { ExtractRecordType } from '../../../shared/types'

// The task router (whole-document-analysis plan §4.4, Phase 3) — a PURE function that maps a
// free-text question (or an explicit task button) to an answer engine. No DB, no model, no
// I/O: the caller passes the facts (does a ready deep index exist? is there extracted data in
// scope? how many documents are in scope?) and gets back an engine choice.
//
// Honesty rules it enforces (H7/M7):
//   - "list every / how many" routes to COVERAGE-EXTRACT (never top-k relevance) — but ONLY
//     when there is precomputed extracted data in scope; otherwise it falls back to LABELLED
//     relevance (we must not claim a complete "0 items" list with no precomputed table).
//   - A coverage trigger maps the user's "{X}" to one of the fixed extract types via a closed
//     synonym table (defaulting to `generic`) — the 0-query-call guarantee holds only for a
//     mapped, pre-extracted type.
//   - Fixed precedence: explicit button > compare (needs 2 docs) > coverage-extract >
//     tree-summary > relevance. A compare classified without 2 docs, or any low-confidence
//     classification, falls back to relevance — never an empty result from a stray trigger word.

export type RouteEngine = 'coverage-extract' | 'tree-summary' | 'compare' | 'relevance'

/** An explicit task button the renderer already exposes (bypasses classification). */
export type ExplicitTaskType = 'summary' | 'translate' | 'compare'

export interface RouteInput {
  /** Set when the user pressed an explicit task button (highest precedence). */
  taskType?: ExplicitTaskType
  question: string
  /** Documents in the resolved scope — compare needs at least 2. */
  documentCount?: number
  /** A ready deep-index tree exists in scope (enables tree-summary). */
  treeAvailable: boolean
  /** Precomputed structured-extract data exists in scope (enables coverage-extract). */
  extractAvailable: boolean
}

export interface RouteDecision {
  engine: RouteEngine
  /** The mapped extract type when `engine === 'coverage-extract'`. */
  recordType?: ExtractRecordType
  /**
   * `high` when the classification confidently picked a non-relevance engine; `low` when a
   * trigger fired but the precondition was missing (no extract data / no second doc) and we
   * fell back to relevance. The caller labels a low-confidence relevance answer "not
   * exhaustive" (the Phase-2 meter), never an empty "no items".
   */
  confidence: 'high' | 'low'
}

// --- Language-aware classification regexes (EN + DE) ---

const COVERAGE_RE =
  /\b(list|enumerate|every|each|all of (the|them)|all the|how many|how much|count)\b|\b(jede[rsn]?|alle[rsn]?|sämtliche[rsn]?|wie ?viele?|liste|auflist|aufzähl|zähl)\b/i
const SUMMARY_RE =
  /\b(summar(?:y|ise|ize|ies)|overview|tl;?dr|gist|whole document|entire document)\b|\b(zusammenfass|überblick|ganzes? dokument)\b/i
const COMPARE_RE =
  /\b(compare|comparison|difference|differences|versus|vs\.?|diff)\b|\b(vergleich|unterschied)\b/i

/** Closed-vocabulary synonym table: a user's "{X}" → an extracted type (plan §4.2 step 4). */
const TYPE_SYNONYMS: Array<{ type: ExtractRecordType; re: RegExp }> = [
  {
    type: 'date',
    re: /\b(deadline|deadlines|due date|due dates|due|date|dates|when)\b|\b(frist|fristen|termin|termine|datum|daten|fälligkeit|wann)\b/i
  },
  {
    type: 'amount',
    re: /\b(cost|costs|fee|fees|price|prices|amount|amounts|payment|payments|money|sum|sums)\b|\b(kosten|betrag|beträge|gebühr|gebühren|preis|preise|summe|summen|zahlung|zahlungen)\b/i
  },
  {
    type: 'party',
    re: /\b(who|part(?:y|ies)|signator(?:y|ies)|person|people|persons|name|names|organi[sz]ation|organi[sz]ations|company|companies)\b|\b(wer|partei|parteien|person|personen|name|namen|unternehmen|firma|firmen|organisation|organisationen)\b/i
  },
  {
    type: 'obligation',
    re: /\b(obligation|obligations|must|shall|clause|clauses|requirement|requirements|dut(?:y|ies)|term|terms)\b|\b(pflicht|pflichten|klausel|klauseln|muss|müssen|anforderung|anforderungen|verpflichtung|verpflichtungen|bedingung|bedingungen)\b/i
  }
]

/** Map a free-text "list every {X}" to the closed extract type set (default `generic`). */
export function mapQuestionToRecordType(question: string): ExtractRecordType {
  for (const { type, re } of TYPE_SYNONYMS) {
    if (re.test(question)) return type
  }
  return 'generic'
}

/** Classify a question / explicit button into an engine choice (pure; plan §4.4). */
export function routeQuestion(input: RouteInput): RouteDecision {
  const q = input.question ?? ''
  const docs = input.documentCount ?? 0

  // 1. Explicit task buttons win outright.
  if (input.taskType === 'compare') {
    return docs >= 2
      ? { engine: 'compare', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low' }
  }
  if (input.taskType === 'summary' || input.taskType === 'translate') {
    // Summarize/translate are served by their own task pipelines, not rag:ask — but for a
    // routed summary, prefer the tree when present (degrades to the capped path otherwise).
    return input.taskType === 'summary' && input.treeAvailable
      ? { engine: 'tree-summary', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low' }
  }

  const wantsCompare = COMPARE_RE.test(q)
  const wantsCoverage = COVERAGE_RE.test(q)
  const wantsSummary = SUMMARY_RE.test(q)

  // 2. Compare (needs two documents). A compare intent without 2 docs is low-confidence and
  //    falls back to labelled relevance (plan §4.4) — it does NOT fall through to coverage.
  if (wantsCompare) {
    return docs >= 2
      ? { engine: 'compare', confidence: 'high' }
      : { engine: 'relevance', confidence: 'low' }
  }

  // 3. Coverage-extract ("list every / how many"): only when there IS precomputed extracted
  //    data — otherwise we cannot honestly claim a complete list, so fall back to relevance.
  if (wantsCoverage) {
    if (input.extractAvailable) {
      return {
        engine: 'coverage-extract',
        recordType: mapQuestionToRecordType(q),
        confidence: 'high'
      }
    }
    return { engine: 'relevance', confidence: 'low' }
  }

  // 4. Tree-summary ("summarize / overview / whole document") when a deep index is ready.
  if (wantsSummary && input.treeAvailable) {
    return { engine: 'tree-summary', confidence: 'high' }
  }

  // 5. Everything else → relevance RAG (the existing retrieve path, byte-unchanged).
  return { engine: 'relevance', confidence: 'high' }
}
