import type { Db } from '../db'
import { t } from '../../../shared/i18n'
import type { AppSettings, Citation, ContextUsage, CoverageInfo, Message, RetrievalScope } from '../../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../runtime'
import { type Embedder, VectorIndex } from '../embeddings'
import type { Reranker } from '../reranker'
import { buildScopeFilter } from '../retrieval-scope'
import { keywordSearchChunks, rrfFuse } from './hybrid'
export { detectFilenameScope, type DetectedScope, type ScopeableDoc } from './scope'
// Re-exported so callers can `import { retrieve, type RetrievalScope } from '../services/rag'`
// (plan §10.2). The canonical definition lives in shared/types.ts (no cycle with embeddings).
export type { RetrievalScope } from '../../../shared/types'

/** Normalize retrieve's arg-5 union: a bare `string[]`/`null` is the legacy doc-id scope. */
function normalizeScope(scope: string[] | RetrievalScope | null | undefined): RetrievalScope {
  return Array.isArray(scope) || scope == null ? { documentIds: scope ?? null } : scope
}
import { approxTokenCount, CHUNK_DEFAULTS } from '../ingestion/chunker'
import {
  wordDiff,
  isPreciseDiffUseful,
  renderRedline,
  renderChangesForModel,
  tokenizeForDiff,
  type DiffChange,
  type DiffResult
} from '../diff'
import { log } from '../logging'
import {
  appendMessage,
  BASE_SYSTEM_PROMPT,
  CHAT_RESPONSE_RESERVE_TOKENS,
  collapseToAlternating,
  compactionEnabled,
  compactionSummaryPair,
  effectiveContextWindow,
  emptyAssistantMessage,
  fitMessagesToContext,
  getLatestCheckpoint,
  isAbortError,
  listConversationTurns,
  messageTokens,
  stripThinkBlocks,
  type TurnSkill
} from '../chat'
import { ensureCompacted } from '../chat/compaction'
import {
  approxPromptTokens,
  buildSkillFence,
  logSkillFenceReduction,
  skillFenceBudgetTokens,
  stripSkillFenceEcho
} from '../skills/prompt'
import { getSettings } from '../settings'
import { scanRedactionCandidates, type RedactionCounts } from '../skills/tools/redaction'
import { answerWholeDocFromTree, streamWholeDocMapReduce } from './whole-doc-tree'
import { documentChunkCount } from '../analysis/coverage'
import { SUMMARY_MAP_CALL_CEILING } from '../doctasks/summary'
import { buildGroundedDataPrompt } from './grounded-data'
export { buildGroundedDataPrompt, GROUNDED_DATA_RULES } from './grounded-data'

// RAG service (spec §7.8; pipeline design in rag-design §11). Turns a
// question into a grounded, cited answer:
//
//   embed query → cosine top-k ──┐
//   FTS5 keyword top-k ──────────┴→ RRF fusion → (rerank when available) →
//   dedup by document/page → trim to a token budget → assign [S1]… labels →
//   build the grounded prompt → stream the local LLM → cited answer
//
// Everything is local + offline: retrieval is a linear scan over SQLite vectors
// (`VectorIndex`) plus an in-process FTS5 keyword scan, the query
// is embedded with the SAME embedder used for chunks, and the optional reranker is a
// loopback llama-server sidecar. The `[S1] [S2] …` labels are assigned PER QUERY at
// retrieval time and are never stored; only the resolved `Citation[]` is persisted
// (in `messages.citations_json` — citations never persist scores).

// `approxTokenCount` counts whitespace words; real BPE tokens run ~1.3× that. The token
// budget is a MODEL-token limit, so words must be scaled up before comparing — otherwise
// the assembled excerpt block overflows the context window and the runtime silently
// truncates excerpts. Same factor doctasks uses (SUMMARY_TOKENS_PER_WORD).
const TOKENS_PER_WORD = 1.3

/** Retrieval knobs, resolved from `AppSettings` (spec §7.8 defaults). */
export interface RagRetrievalSettings {
  topKInitial: number
  topKFinal: number
  maxContextTokens: number
  minSimilarity: number
}

/** Pull the RAG retrieval knobs out of `AppSettings`. */
export function ragSettingsFrom(settings: AppSettings): RagRetrievalSettings {
  return {
    topKInitial: settings.ragTopKInitial,
    topKFinal: settings.ragTopKFinal,
    maxContextTokens: settings.ragMaxContextTokens,
    minSimilarity: settings.ragMinSimilarity
  }
}

/** A retrieved chunk, labelled `[S1] [S2] …` for the grounded prompt + citation. */
export interface RetrievedChunk {
  label: string // "S1", "S2", …
  chunkId: string
  documentId: string
  text: string
  sourceTitle: string
  pageNumber: number | null
  sectionLabel: string | null
  /**
   * Per-query ranking score; its MEANING depends on how the chunk won its
   * place: the embedder's cosine similarity for vector hits,
   * the RRF fusion score for keyword-only hits, or the reranker's relevance score
   * (an unbounded logit) once a reranker reordered the candidates. Internal only —
   * citations never persist scores.
   */
  score: number
}

export interface RetrievalResult {
  chunks: RetrievedChunk[]
  citations: Citation[]
}

/** Chunk text stored on a citation snippet is capped to keep citations_json small. */
export const SNIPPET_MAX_CHARS = 600

/**
 * Grounding rule (spec §7.8): when there are no indexed documents or every hit is below
 * the similarity threshold, we do NOT call the model — we return this fixed answer so the
 * assistant can never hallucinate sources it does not have.
 */
// This answer is PERSISTED into conversations (messages.content), so it is written as
// the explicit ENGLISH catalog value (i18n record §3.3 rule 1) — the renderer display
// map translates it at display time (D-L4), which also retroactively re-translates
// old rows on a language switch.
export const NO_DOCUMENT_CONTEXT_ANSWER = t('en', 'main.rag.noContext')

/**
 * The actionable variant: documents ARE indexed, but none of their
 * vectors were produced by the active embedding model, so retrieval cannot see them at
 * all (search is scoped to the active embedder's id). Telling the user to rephrase would
 * be wrong — only a re-index fixes it.
 */
// Persist-canonical English like NO_DOCUMENT_CONTEXT_ANSWER (i18n record §3.3 rule 1).
export const REINDEX_NEEDED_ANSWER = t('en', 'main.rag.reindexNeeded')

/**
 * True when the corpus is invisible to `embeddingModelId`: at least one indexed document
 * has chunks, but not a single one of those documents has any vector under the active
 * model. Drives the `REINDEX_NEEDED_ANSWER` variant — a per-document partial mismatch
 * still retrieves from the visible documents and stays on the normal path.
 *
 * `scope` (document-organization plan M2): when given, the SAME membership / id-union /
 * archived filter retrieval applies is applied here too, so the re-index honesty story is
 * correct under collection scope. This distinguishes, WITHIN the active scope, an
 * empty scope (no indexed docs ⇒ false ⇒ `NO_DOCUMENT_CONTEXT_ANSWER`, re-index wouldn't
 * help) from a stale scope (indexed docs, none visible to the embedder ⇒ true ⇒
 * `REINDEX_NEEDED_ANSWER`). Omit `scope` for the whole-corpus check (unchanged).
 */
export function corpusNeedsReindex(
  db: Db,
  embeddingModelId: string,
  scope?: RetrievalScope | null
): boolean {
  const scopeFilter = buildScopeFilter(scope, 'd.id')
  const scopeSql = scopeFilter ? ` AND ${scopeFilter.sql}` : ''
  const scopeParams = scopeFilter ? scopeFilter.params : []
  const indexed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)${scopeSql}`
    )
    .get(...scopeParams) as unknown as { n: number }
  if (indexed.n === 0) return false
  const visible = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (
           SELECT 1 FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
           WHERE c.document_id = d.id AND e.embedding_model_id = ?
         )${scopeSql}`
    )
    .get(embeddingModelId, ...scopeParams) as unknown as { n: number }
  return visible.n === 0
}

interface ChunkRow {
  id: string
  document_id: string
  text: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
  token_count: number | null
}

/**
 * Retrieve grounded context for `question` (pipeline per rag-design §11):
 *  1. embed the question and cosine-search the vector index (`topKInitial`),
 *  2. drop vector hits below `minSimilarity` (the cosine floor applies PRE-fusion/
 *     PRE-rerank; rerank scores are a different scale and never meet this floor),
 *  3. FTS5 keyword-search the corpus (`topKInitial`, embedder-visibility-scoped),
 *  4. fuse the two ranked lists by reciprocal rank (RRF, hybrid.ts),
 *  5. join candidates back to `chunks` for text + source label + page/section,
 *  6. rerank the candidates when a reranker is available (reorder by relevance;
 *     a rerank failure falls back to the fused order — never breaks asking),
 *  7. dedup by document/page (keep the best-ranked chunk per page),
 *  8. trim to `topKFinal` while respecting `maxContextTokens` (approx token counter),
 *  9. assign `[S1] [S2] …` labels and resolve `Citation[]`.
 *
 * Labels are assigned here, per query, and are never stored.
 *
 * Pass-through guarantee: with no reranker and no keyword hits, steps 3/4/6 are
 * inert and the result — ordering AND scores — is byte-identical to the vector-only
 * pipeline (RRF over a single list is monotone in rank; vector candidates keep their
 * cosine as `score` until a reranker actually rescores them).
 *
 * `scope` (spec §10.4 + document-organization plan §10.2) is a normalized union on
 * parameter 5: a bare `string[]`/`null` is the legacy "ask selected documents" doc-id
 * scope (normalized to `{ documentIds }`), so every existing positional caller stays valid;
 * a `RetrievalScope` adds `collectionIds`/`includeArchived` (membership + archived filter,
 * unioned with `documentIds`).
 */
export async function retrieve(
  db: Db,
  embedder: Embedder,
  question: string,
  settings: RagRetrievalSettings,
  scope?: string[] | RetrievalScope | null,
  reranker?: Reranker | null,
  signal?: AbortSignal
): Promise<RetrievalResult> {
  const s = normalizeScope(scope)
  // Mismatch guard: only search vectors tagged with the active embedder's id.
  // Mock and real E5 vectors are both 384-dim, so the dimension guard cannot separate
  // them; scoping by model id stops a corpus indexed under one embedder from polluting
  // search under another (until a reindex re-embeds everything with the active model).
  const index = new VectorIndex(db, embedder, {
    embeddingModelId: embedder.id,
    documentIds: s.documentIds ?? null,
    collectionIds: s.collectionIds ?? null,
    includeArchived: s.includeArchived
  })
  const vectorHits = (await index.searchText(question, settings.topKInitial, signal)).filter(
    (hit) => hit.score >= settings.minSimilarity
  )
  // Hybrid keyword path: the exact terms embeddings miss.
  // Scoped to chunks VISIBLE to the active embedder so the keyword path can
  // never surface a document vector search couldn't — the re-index honesty story
  // (staleEmbeddings / corpusNeedsReindex / REINDEX_NEEDED_ANSWER) is unchanged.
  const keywordHits = keywordSearchChunks(db, question, settings.topKInitial, {
    embeddingModelId: embedder.id,
    documentIds: s.documentIds ?? null,
    collectionIds: s.collectionIds ?? null,
    includeArchived: s.includeArchived
  })
  const fused = rrfFuse(vectorHits, keywordHits)

  // Join fused candidates → chunk rows in ONE `IN (…)` query (placeholders only),
  // then reassemble in the fused order (best first). A vector candidate keeps its
  // cosine as `score` (pass-through guarantee); a keyword-only candidate carries its
  // RRF score (no cosine exists for it).
  let candidates: Array<Omit<RetrievedChunk, 'label'>> = []
  // RAG-7: persisted per-chunk token counts (chunkId → token_count), filled with the candidate rows.
  let tokenCounts = new Map<string, number | null>()
  if (fused.length > 0) {
    const rows = db
      .prepare(
        'SELECT id, document_id, text, source_label, page_number, section_label, token_count ' +
          `FROM chunks WHERE id IN (${fused.map(() => '?').join(', ')})`
      )
      .all(...fused.map((c) => c.chunkId)) as unknown as ChunkRow[]
    const rowById = new Map(rows.map((r) => [r.id, r]))
    // RAG-7 (perf audit 2026-06-18): the persisted `chunks.token_count` is exactly
    // `approxTokenCount(text)` (chunker.ts), so the budget loop below reads it instead of
    // re-scanning each candidate's text. Keyed by chunkId in a side-map so it never rides the
    // returned `RetrievedChunk` shape. A legacy NULL falls back to a recompute (identical value).
    tokenCounts = new Map(rows.map((r) => [r.id, r.token_count]))
    for (const cand of fused) {
      const row = rowById.get(cand.chunkId)
      if (!row) continue
      candidates.push({
        chunkId: row.id,
        documentId: row.document_id,
        text: row.text,
        sourceTitle: row.source_label ?? 'Untitled',
        pageNumber: row.page_number,
        sectionLabel: row.section_label,
        score: cand.cosine ?? cand.rrfScore
      })
    }
  }

  // Rerank between fusion and dedup: the cross-encoder rescoring decides which chunk
  // represents a page BEFORE the dedup collapse. A failing reranker logs and keeps
  // the fused order — a quality pass must never turn into an error for the user.
  if (reranker && candidates.length > 0) {
    try {
      const scores = new Map(
        (await reranker.rerank(question, candidates.map((c) => c.text), { signal })).map((h) => [
          h.index,
          h.score
        ])
      )
      candidates = candidates
        .map((c, i) => ({ ...c, score: scores.get(i) ?? c.score, fusedRank: i }))
        .sort((a, b) => b.score - a.score || a.fusedRank - b.fusedRank)
        .map(({ fusedRank: _unused, ...c }) => c)
    } catch (err) {
      log.warn('Reranker unavailable for this question — using fused order', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // Dedup by document/page (spec §7.8). Only chunks that share a real page number
  // collapse — page-less chunks (txt/md windows) are kept distinct via their chunk id.
  const seen = new Set<string>()
  const deduped: Array<Omit<RetrievedChunk, 'label'>> = []
  for (const c of candidates) {
    const key = c.pageNumber != null ? `${c.documentId}#p${c.pageNumber}` : `${c.documentId}#c${c.chunkId}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
  }

  // Trim to topKFinal while respecting the token budget. The single most relevant
  // chunk is always included (so an over-budget top chunk never yields "no context").
  const selected: Array<Omit<RetrievedChunk, 'label'>> = []
  let usedTokens = 0
  for (const c of deduped) {
    if (selected.length >= settings.topKFinal) break
    // RAG-7: persisted token_count (== approxTokenCount(text)) when present, else recompute.
    const tokens = Math.ceil((tokenCounts.get(c.chunkId) ?? approxTokenCount(c.text)) * TOKENS_PER_WORD)
    if (selected.length > 0 && usedTokens + tokens > settings.maxContextTokens) break
    selected.push(c)
    usedTokens += tokens
  }

  const chunks: RetrievedChunk[] = selected.map((c, i) => ({ ...c, label: `S${i + 1}` }))
  const citations: Citation[] = chunks.map((c) => ({
    label: c.label,
    sourceTitle: c.sourceTitle,
    pageNumber: c.pageNumber,
    section: c.sectionLabel,
    snippet: truncateSnippet(c.text)
  }))
  return { chunks, citations }
}

/**
 * Cap a citation snippet to keep `citations_json` small. Counts and slices by CODE POINT, not
 * UTF-16 code unit (full-audit-2026-06-29 RAG-2): a raw `String.slice` can cut inside a
 * surrogate pair (emoji, CJK ext-B, math symbols) and leave the snippet ending in a lone
 * surrogate that renders as `�`. Spreading iterates whole code points, so the cut always lands
 * on a code-point boundary. (Code points, not graphemes — a combining mark could still be split,
 * but that never produces an invalid string; the goal here is only "never end mid-code-point".)
 * Exported for the RAG-2 boundary unit test.
 */
export function truncateSnippet(text: string): string {
  const trimmed = text.trim()
  const codePoints = [...trimmed]
  if (codePoints.length <= SNIPPET_MAX_CHARS) return trimmed
  return codePoints.slice(0, SNIPPET_MAX_CHARS).join('').trimEnd() + '…'
}

/** The whole-document read for a skill-aware analysis answer (skill-whole-doc engine, Wave 2). */
export interface WholeDocumentResult {
  chunks: RetrievedChunk[]
  citations: Citation[]
  /** Chunks included (== chunks.length); ≤ chunksTotal when the budget truncated the tail. */
  chunksCovered: number
  /** Total chunks in the document. */
  chunksTotal: number
  /** True when the document did not fit the budget and only its BEGINNING was included. */
  truncated: boolean
}

/** Generous upper bound on the chunk-overlap size in CHARACTERS: the chunker re-includes at most
 *  `chunkOverlapTokens` tokens, and a single approx-token is at most `ONE_TOKEN_WORD_CHARS` (16)
 *  characters of a whitespace word (chunker.ts) — 20 leaves slack for the joining spaces. Bounds the
 *  de-overlap scan so it stays linear AND a coincidental long match can't reach far past the real
 *  overlap. (A space-less run is ~1 char/token, comfortably inside this bound.) */
const MAX_OVERLAP_CHARS_PER_TOKEN = 20

/** Length of the longest suffix of `tail` that is also a PREFIX of `head` (byte-exact) — the chunk
 *  overlap size. KMP: build the prefix function of `head`, then run `tail` through that automaton and
 *  read off the match length at `tail`'s end. O(head+tail), no separator sentinel needed (so no
 *  assumptions about which characters extracted text may contain). */
function overlapLength(head: string, tail: string): number {
  const pi = new Array<number>(head.length).fill(0)
  for (let i = 1; i < head.length; i += 1) {
    let j = pi[i - 1]
    while (j > 0 && head[i] !== head[j]) j = pi[j - 1]
    if (head[i] === head[j]) j += 1
    pi[i] = j
  }
  let k = 0 // length of the `head`-prefix matched at the current position of `tail`
  for (let i = 0; i < tail.length; i += 1) {
    while (k > 0 && tail[i] !== head[k]) k = pi[k - 1]
    if (tail[i] === head[k]) k += 1
    if (k === head.length) k = pi[k - 1] // full head matched mid-tail — keep scanning for a longer tail-suffix
  }
  return k
}

/**
 * Consecutive chunks from the SAME segment overlap by ~`chunkOverlapTokens` (80) tokens of DUPLICATED
 * text — the chunker re-includes the previous window's tail so retrieval never splits a fact across a
 * boundary (chunker.ts `windowByTokens`). A whole-document read concatenates chunks in order, so that
 * overlap wastes ~16 % of the already-scarce budget (audit §2.2). This strips the leading run of `next`
 * that byte-exactly duplicates the tail of `prev`. It matches on CHARACTERS (not whitespace words) so
 * it is correct for space-less scripts and glued PDF runs — where a whole chunk is one space-less
 * "word" a word-level scan would either miss entirely or, for an identical repeated window, wrongly
 * empty. The scan is bounded to the known overlap size (`chunkOverlapTokens × MAX_OVERLAP_CHARS_PER_TOKEN`);
 * any run it strips is by definition also present at the END of `prev`, so nothing is lost, and the
 * `< next.length` guard means a chunk is never emptied. Callers gate this on same page/section labels
 * (only same-segment neighbours overlap). */
function deOverlapAgainstPrev(prev: string, next: string): string {
  const cap = CHUNK_DEFAULTS.chunkOverlapTokens * MAX_OVERLAP_CHARS_PER_TOKEN
  const tail = prev.length > cap ? prev.slice(prev.length - cap) : prev
  const head = next.length > cap ? next.slice(0, cap) : next
  const overlap = overlapLength(head, tail)
  if (overlap <= 0 || overlap >= next.length) return next
  return next.slice(overlap).replace(/^\s+/, '')
}

/** True when two consecutive chunks belong to the same coalesced segment (same page + section), the
 *  only case where the chunker introduces overlap. `coalesceSegments` merges adjacent same-label
 *  segments before chunking, so equal labels on order-adjacent chunks ⇒ one segment ⇒ real overlap. */
function sameSegment(
  prev: { page_number: number | null; section_label: string | null },
  cur: { page_number: number | null; section_label: string | null }
): boolean {
  return (prev.page_number ?? null) === (cur.page_number ?? null) &&
    (prev.section_label ?? null) === (cur.section_label ?? null)
}

/** A document chunk paired with its DE-OVERLAPPED text (the ~80-token same-segment boundary stripped). */
interface DeOverlappedChunk {
  row: ChunkRow
  text: string
}

/**
 * Read ALL of a document's chunks IN ORDER, de-overlapping consecutive same-segment neighbours — the
 * single home of the whole-document de-overlap read (audit §2.2). Both `retrieveWholeDocument` (which then
 * budget-caps + labels the prefix) and `answerWholeDocFromChunks` (Phase 1 chunk map-reduce — the WHOLE
 * document, uncapped) consume this, so the ~80-token boundary is stripped identically on both paths. No
 * budget cap here: the caller decides how much of the de-overlapped run it takes. Pure DB read (SEC-1).
 */
function readWholeDocumentChunkTexts(db: Db, documentId: string): DeOverlappedChunk[] {
  const rows = db
    .prepare(
      'SELECT id, document_id, text, source_label, page_number, section_label, token_count ' +
        'FROM chunks WHERE document_id = ? ORDER BY chunk_index'
    )
    .all(documentId) as unknown as ChunkRow[]
  const out: DeOverlappedChunk[] = []
  let prevRow: ChunkRow | null = null
  for (const row of rows) {
    // A same-segment neighbour repeats ~80 tokens of `prevRow`'s tail as its own prefix; strip it so the
    // read carries real coverage. `prevRow` is the RAW row (its `.text` un-de-overlapped) — the overlap is
    // measured against the original tail, exactly as the former inline loop did.
    const text = prevRow && sameSegment(prevRow, row) ? deOverlapAgainstPrev(prevRow.text, row.text) : row.text
    out.push({ row, text })
    prevRow = row
  }
  return out
}

/**
 * Load a SINGLE document's chunks IN ORDER (not top-k retrieval) for a skill-aware whole-document
 * answer (skill-whole-doc engine, Wave 2 — `architecture.md` §19/§20). Unlike `retrieve`, this does
 * NO embedding/ranking: an analysis skill (minutes, contract brief, …) must see the WHOLE document,
 * not the most-relevant passages. The chunks are taken from the start and capped to `budgetTokens`
 * (the persisted per-chunk `token_count`, scaled by `TOKENS_PER_WORD`, like `retrieve`); when the
 * document overflows the budget the TAIL is dropped and `truncated` is true so the caller can stamp
 * the honest `capped`/"covers the beginning" coverage. Labels `[S1]…[Sn]` are assigned here, per
 * query, and never stored (same contract as `retrieve`). The model-side fence/streaming/persist
 * machinery is shared with the relevance path (`generateGroundedAnswer`).
 *
 * NOTE on large documents: this stuffs the document up to the context budget. A map-reduce pass over
 * the deep-index tree (true whole-document coverage for documents that don't fit) is the documented
 * follow-up; today an over-budget document is read from the beginning with an HONEST badge, never
 * silently presented as complete.
 */
export function retrieveWholeDocument(
  db: Db,
  documentId: string,
  budgetTokens: number
): WholeDocumentResult {
  // The whole-document de-overlap read lives in one place (`readWholeDocumentChunkTexts`); here we take a
  // budget-capped PREFIX of it. Charging the DE-OVERLAPPED text against the budget means the ~16% overlap
  // tax buys ~a whole extra chunk of reach.
  const deOverlapped = readWholeDocumentChunkTexts(db, documentId)
  const chunksTotal = deOverlapped.length
  const selected: Array<Omit<RetrievedChunk, 'label'>> = []
  let usedTokens = 0
  for (const { row, text } of deOverlapped) {
    const tokens = Math.ceil(approxTokenCount(text) * TOKENS_PER_WORD)
    // Always include the first chunk (a single over-budget chunk must not yield "no context");
    // after that, stop as soon as the next chunk would overflow the whole-document budget.
    if (selected.length > 0 && usedTokens + tokens > budgetTokens) break
    selected.push({
      chunkId: row.id,
      documentId: row.document_id,
      text,
      sourceTitle: row.source_label ?? 'Untitled',
      pageNumber: row.page_number,
      sectionLabel: row.section_label,
      score: 0
    })
    usedTokens += tokens
  }
  const chunks: RetrievedChunk[] = selected.map((c, i) => ({ ...c, label: `S${i + 1}` }))
  const citations: Citation[] = chunks.map((c) => ({
    label: c.label,
    sourceTitle: c.sourceTitle,
    pageNumber: c.pageNumber,
    section: c.sectionLabel,
    snippet: truncateSnippet(c.text)
  }))
  return { chunks, citations, chunksCovered: chunks.length, chunksTotal, truncated: chunks.length < chunksTotal }
}

/** Dependencies for the no-tree over-budget whole-doc chunk map-reduce (Phase 1). */
export interface WholeDocChunksDeps {
  db: Db
  runtime: ModelRuntime
  conversationId: string
  documentId: string
  question: string
  skill?: TurnSkill | null
  contextTokens: number
  signal?: AbortSignal
  onToken?: (token: string) => void
  /** Phase 3 (§5) — the ephemeral 'analysis' progress notice, threaded to the shared map-reduce core. */
  onCompactionStart?: (kind: 'analysis') => void
  answerPrefix?: string
  /** Share-safe (or other app-authored) block for the reduce USER turn — never the system prompt. */
  extraReduceBlock?: string
}

/**
 * Answer an over-budget whole-document skill turn that has NO deep-index tree by running an on-the-fly
 * map-reduce over the document's RAW chunks (Phase 1 — wholedoc-truncation-fix-plan §3). This closes the
 * "gap band": documents between ~1.5 pages (the single-read budget) and ~50 pages (where the tree
 * auto-builds) were previously read from the BEGINNING only; now the WHOLE document is analysed and the
 * coverage stamp is honest (`mode:'capped', truncated:false` — untruncated capped = whole-doc via
 * map-reduce, the meter's meaning). Co-located with the private de-overlap helpers (no circular import
 * back into whole-doc-tree.ts); the shared `streamWholeDocMapReduce` core does the fence/map/reduce/persist.
 *
 * Returns `null` ONLY when the document has zero non-empty chunk texts (defensive; the caller then uses the
 * capped beginning-only floor). Capability ceiling unchanged: pure DB reads + the chat runtime (SEC-1).
 */
export async function answerWholeDocFromChunks(deps: WholeDocChunksDeps): Promise<Message | null> {
  const { db, documentId } = deps
  // ALL de-overlapped chunks (the WHOLE document, uncapped) — the same read `retrieveWholeDocument`
  // budget-caps. Drop empty/whitespace texts (parity with the tree path's node-summary filter).
  const nonEmpty = readWholeDocumentChunkTexts(db, documentId).filter((c) => c.text.trim().length > 0)
  if (nonEmpty.length === 0) return null
  const sourceTexts = nonEmpty.map((c) => c.text)

  // Citations = a bounded, representative sample of REAL leaf chunks (M2 — never node summaries), evenly
  // spaced across the document so provenance spans it without the noise of one citation per chunk. Bounded
  // to ≤ SUMMARY_MAP_CALL_CEILING (the map-call ceiling), matching the reduce's window budget.
  const step = Math.max(1, Math.ceil(nonEmpty.length / SUMMARY_MAP_CALL_CEILING))
  const reps = nonEmpty.filter((_, i) => i % step === 0).slice(0, SUMMARY_MAP_CALL_CEILING)
  const citations: Citation[] = reps.map((c, i) => ({
    label: `S${i + 1}`,
    sourceTitle: c.row.source_label ?? 'Untitled',
    pageNumber: c.row.page_number,
    section: c.row.section_label,
    snippet: truncateSnippet(c.text)
  }))

  // The whole document IS the source ⇒ covered == total (documentChunkCount is the whole-doc denominator
  // the meter uses). `truncated` is finalized inside the core (only a > ceiling window count / notes cut).
  const total = documentChunkCount(db, documentId)
  return streamWholeDocMapReduce({
    db: deps.db,
    runtime: deps.runtime,
    conversationId: deps.conversationId,
    documentId: deps.documentId,
    question: deps.question,
    skill: deps.skill,
    contextTokens: deps.contextTokens,
    signal: deps.signal,
    onToken: deps.onToken,
    onCompactionStart: deps.onCompactionStart,
    answerPrefix: deps.answerPrefix,
    sourceTexts,
    citations,
    chunksCovered: total,
    chunksTotal: total,
    coverageMode: 'capped',
    extraReduceBlock: deps.extraReduceBlock
  })
}

/** The `[Sn] File: X | Page: 4` / `| Section: Y` metadata line for a chunk (spec §7.8). */
function sourceMeta(chunk: RetrievedChunk): string {
  if (chunk.pageNumber != null) return ` | Page: ${chunk.pageNumber}`
  if (chunk.sectionLabel) return ` | Section: ${chunk.sectionLabel}`
  return ''
}

/** A document's whole size in the SAME token unit as `retrieveWholeDocument` (persisted token_count
 *  scaled by TOKENS_PER_WORD), so the compare budget can be split by real size. */
export function documentApproxTokenTotal(db: Db, documentId: string): number {
  // ORDER BY chunk_index for read-shape parity with `retrieveWholeDocument`: the whole-document read
  // de-overlaps consecutive same-segment chunks and charges the de-overlapped text against the budget
  // (audit §2.2), so the compare-split sizing must measure the SAME de-overlapped totals — otherwise a
  // document's ~80-token-per-boundary overlap tax would inflate its half of the split beyond what it
  // actually occupies. The scan is therefore order-dependent (each chunk compared to its predecessor).
  const rows = db
    .prepare('SELECT text, page_number, section_label FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ text: string; page_number: number | null; section_label: string | null }>
  let total = 0
  let prev: { text: string; page_number: number | null; section_label: string | null } | null = null
  for (const r of rows) {
    const text = prev && sameSegment(prev, r) ? deOverlapAgainstPrev(prev.text, r.text) : r.text
    total += Math.ceil(approxTokenCount(text) * TOKENS_PER_WORD)
    prev = r
  }
  return total
}

/**
 * Deterministic per-category PII counts over a document's ENTIRE text (U2, audit §3.5 — the share-safe
 * pre-scan). Reads ALL chunks (never budget-capped: the deterministic detectors CAN see the whole document
 * even when the model's excerpt view is truncated), de-overlapping consecutive same-segment neighbours so a
 * value duplicated in the ~80-token overlap is not double-counted, then runs the offline redaction detectors.
 * Returns COUNTS only — never a detected value (§6). */
export function scanWholeDocumentForPii(db: Db, documentId: string): RedactionCounts {
  const rows = db
    .prepare('SELECT text, page_number, section_label FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ text: string; page_number: number | null; section_label: string | null }>
  let joined = ''
  let prev: { text: string; page_number: number | null; section_label: string | null } | null = null
  for (const r of rows) {
    const text = prev && sameSegment(prev, r) ? deOverlapAgainstPrev(prev.text, r.text) : r.text
    joined += joined ? `\n${text}` : text
    prev = r
  }
  return scanRedactionCandidates(joined)
}

/**
 * Split a whole-document budget across two compared documents (Follow-up B). Size-aware with
 * redistribution: each gets up to HALF, then a smaller document donates its unused half to the
 * larger one. So two versions that JOINTLY fit are both read whole (the common what-changed case);
 * when both are large each is guaranteed ~half; a large+small pair gives the large doc the slack.
 * Pure + unit-tested. Returns `[budgetA, budgetB]`, each ≥ 1 (so each doc keeps its first chunk).
 */
export function splitCompareBudget(tokensA: number, tokensB: number, totalBudget: number): [number, number] {
  const budget = Math.max(0, Math.floor(totalBudget))
  const half = Math.floor(budget / 2)
  let a = Math.min(Math.max(0, tokensA), half)
  let b = Math.min(Math.max(0, tokensB), half)
  let leftover = budget - a - b
  if (leftover > 0) {
    const giveA = Math.min(Math.max(0, tokensA) - a, leftover)
    a += giveA
    leftover -= giveA
    const giveB = Math.min(Math.max(0, tokensB) - b, leftover)
    b += giveB
  }
  return [Math.max(1, a), Math.max(1, b)]
}

/** Title + import date for a compared document, read once from `documents`. Labels the pair in the
 *  compare prompts so a same-titled version pair is distinguishable WITHOUT claiming which is older
 *  (audit §5.1). `importedAt` is the `created_at` the shared scope helper also orders the pair by. */
function compareDocMeta(db: Db, id: string): { title: string; importedAt: string | null } {
  const row = db.prepare('SELECT title, created_at FROM documents WHERE id = ?').get(id) as unknown as
    | { title: string | null; created_at: string | null }
    | undefined
  return { title: row?.title ?? 'Untitled', importedAt: row?.created_at ?? null }
}

/** A model-facing label for a compared document: `Document A: "title" (imported YYYY-MM-DD)`. The
 *  letter carries the diff DIRECTION (A→B) — which document each change belongs to — but makes NO
 *  claim that A is the original/old version (the app cannot know; import order ≠ authoring order). */
export function describeCompareDoc(letter: 'A' | 'B', title: string, importedAt: string | null): string {
  const when = importedAt && importedAt.length >= 10 ? importedAt.slice(0, 10) : 'unknown date'
  return `Document ${letter}: "${title}" (imported ${when})`
}

/** One document's side of a labelled 2-document compare read — its title/import label, its selected
 *  chunks, and its OWN honest coverage so a partial half can print a per-document "beginning" notice
 *  in the prompt (audit §2.2). `documentId` is internal (citations carry it); the rest are prompt-facing. */
export interface CompareDocGroup {
  documentId?: string
  title: string
  importedAt: string | null
  chunks: RetrievedChunk[]
  /** True when THIS document overflowed its budget share (only its tail was dropped). */
  truncated: boolean
  chunksCovered: number
  chunksTotal: number
}

/** The whole-document read for a 2-document compare (Follow-up B): both documents read IN ORDER,
 *  the budget split by size, with continuous `[Sn]` labels across the two so citations stay unique. */
export interface CompareWholeDocumentsResult {
  /** Per-document groups (in scope order), for the labelled compare prompt. */
  groups: CompareDocGroup[]
  /** All chunks (doc A then doc B), continuously labelled — the citation source of truth. */
  chunks: RetrievedChunk[]
  citations: Citation[]
  /** True when EITHER document overflowed its budget share (honest capped/"beginning" coverage). */
  truncated: boolean
  chunksCovered: number
  chunksTotal: number
}

export function retrieveCompareWholeDocuments(
  db: Db,
  documentIds: string[],
  totalBudget: number
): CompareWholeDocumentsResult {
  const [idA, idB] = documentIds
  const [budgetA, budgetB] = splitCompareBudget(
    documentApproxTokenTotal(db, idA),
    documentApproxTokenTotal(db, idB),
    totalBudget
  )
  const metaA = compareDocMeta(db, idA)
  const metaB = compareDocMeta(db, idB)
  const a = retrieveWholeDocument(db, idA, budgetA)
  const b = retrieveWholeDocument(db, idB, budgetB)
  // Continue [Sn] numbering across the SECOND document so labels are unique + ordered (M2: the
  // citations are the source of truth, so a collision would mislabel which version a source is from).
  const offset = a.chunks.length
  const bChunks: RetrievedChunk[] = b.chunks.map((c, i) => ({ ...c, label: `S${offset + i + 1}` }))
  const bCitations: Citation[] = b.citations.map((c, i) => ({ ...c, label: `S${offset + i + 1}` }))
  return {
    groups: [
      {
        documentId: idA,
        title: metaA.title,
        importedAt: metaA.importedAt,
        chunks: a.chunks,
        truncated: a.truncated,
        chunksCovered: a.chunksCovered,
        chunksTotal: a.chunksTotal
      },
      {
        documentId: idB,
        title: metaB.title,
        importedAt: metaB.importedAt,
        chunks: bChunks,
        truncated: b.truncated,
        chunksCovered: b.chunksCovered,
        chunksTotal: b.chunksTotal
      }
    ],
    chunks: [...a.chunks, ...bChunks],
    citations: [...a.citations, ...bCitations],
    truncated: a.truncated || b.truncated,
    chunksCovered: a.chunksCovered + b.chunksCovered,
    chunksTotal: a.chunksTotal + b.chunksTotal
  }
}

/** A document's chunks in order, with the metadata needed to attribute a change to a page/section. */
interface OrderedChunkRow {
  id: string
  document_id: string
  text: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
}

/** The diff-driven whole-doc compare read (mode d, compare-diff record). */
export interface CompareDiffResult {
  /** Change-attributed chunks (where the changes are) — the citation source of truth, `[Sn]`. */
  chunks: RetrievedChunk[]
  citations: Citation[]
  /** Deterministic redline for the prompt (exact struck/added words with context). */
  redlineText: string
  /** Compact model-facing change list (Removed/Added/Changed). */
  changesText: string
  identical: boolean
  /** Chunks examined (the WHOLE of both documents) / total — coverage is honest "whole document". */
  chunksCovered: number
  chunksTotal: number
  /** True when the change list was capped (very many changes) — rare for a version pair. */
  truncated: boolean
  /** Model-facing labels for the two compared documents (title + import date). The diff is A→B
   *  ("Removed" = in A, "Added" = in B); the labels name A/B without asserting old/new (audit §5.1). */
  labelA: string
  labelB: string
}

/**
 * The DIFF-DRIVEN whole-document compare read (mode d, compare-diff record — architecture.md §20).
 * Reads BOTH documents whole (in chunk order), runs a deterministic word-level diff, and returns the
 * EXACT changes (never two walls of text) plus citations attributed to the chunks where the changes
 * are. Coverage is honestly "whole document": the diff examined every chunk, so unlike the capped
 * whole-doc path a page-2 change can never be truncated away. Returns null to fall back to the
 * whole-doc-compare path when the diff is not the right tool (docs too large/different, or the change
 * list overflows the budget). `budgetTokens` bounds the change list fed to the model.
 */
export function retrieveCompareDiff(
  db: Db,
  documentIds: string[],
  budgetTokens: number
): CompareDiffResult | null {
  const [idA, idB] = documentIds
  const metaA = compareDocMeta(db, idA)
  const metaB = compareDocMeta(db, idB)
  const labelA = describeCompareDoc('A', metaA.title, metaA.importedAt)
  const labelB = describeCompareDoc('B', metaB.title, metaB.importedAt)
  const readOrdered = (id: string): OrderedChunkRow[] =>
    db
      .prepare(
        'SELECT id, document_id, text, source_label, page_number, section_label ' +
          'FROM chunks WHERE document_id = ? ORDER BY chunk_index'
      )
      .all(id) as unknown as OrderedChunkRow[]
  const aRows = readOrdered(idA)
  const bRows = readOrdered(idB)
  if (aRows.length === 0 || bRows.length === 0) return null

  // Build each document's full word stream + the word-range each chunk owns (for attribution).
  // NB: stored chunks overlap by ~80 tokens, so the joined text repeats a little at boundaries —
  // harmless for the diff (both sides repeat identically ⇒ still equal) and no worse than the
  // whole-doc-compare path, which already feeds the model the same overlapping chunk text.
  const build = (rows: OrderedChunkRow[]): { text: string; ranges: Array<{ row: OrderedChunkRow; start: number; end: number }> } => {
    const ranges: Array<{ row: OrderedChunkRow; start: number; end: number }> = []
    let count = 0
    const parts: string[] = []
    for (const row of rows) {
      const n = tokenizeForDiff(row.text).length
      ranges.push({ row, start: count, end: count + n })
      parts.push(row.text)
      count += n
    }
    return { text: parts.join('\n'), ranges }
  }
  const a = build(aRows)
  const b = build(bRows)

  const budgetWords = Math.max(1, Math.floor(budgetTokens / TOKENS_PER_WORD))
  const diff = wordDiff(a.text, b.text)
  if (!diff || !isPreciseDiffUseful(diff)) return null

  const chunksTotal = aRows.length + bRows.length

  // Locate the chunk owning a word index (clamp to the last chunk for a trailing index).
  const chunkAt = (
    ranges: Array<{ row: OrderedChunkRow; start: number; end: number }>,
    wordIdx: number
  ): OrderedChunkRow =>
    ranges.find((r) => wordIdx >= r.start && wordIdx < r.end)?.row ?? ranges[ranges.length - 1].row

  // Attribute each change to its source chunk(s): removed/context → doc A, added → doc B. Preserve
  // document order, dedupe, and label [S1…] continuously so the citation panel points AT the changes.
  const cited: OrderedChunkRow[] = []
  const seen = new Set<string>()
  const cite = (row: OrderedChunkRow): void => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    cited.push(row)
  }
  if (diff.identical) {
    // No changes: cite the head of each document so the panel/coverage still resolve.
    cite(aRows[0])
    cite(bRows[0])
  } else {
    for (const c of diff.changes) {
      if (c.removed.length > 0) cite(chunkAt(a.ranges, c.aStart ?? 0))
    }
    for (const c of diff.changes) {
      if (c.added.length > 0) cite(chunkAt(b.ranges, c.bStart ?? 0))
    }
    if (cited.length === 0) {
      cite(aRows[0])
      cite(bRows[0])
    }
  }

  const changesText = diff.identical
    ? '(No differences — a word-level comparison found the two documents to be textually identical.)'
    : renderChangesForModel(diff.changes).text
  // Cap the change list to the budget; if even capped it overflows, fall back (docs too different).
  if (approxTokenCount(changesText) * TOKENS_PER_WORD > budgetTokens) {
    const fitted = fitChangesToBudget(diff.changes, budgetWords)
    if (!fitted) return null
    return buildDiffResult(diff, fitted.changesText, fitted.redlineText, fitted.truncated, cited, chunksTotal, labelA, labelB)
  }
  const redlineText = diff.identical ? '' : renderRedline(diff.changes).text
  return buildDiffResult(diff, changesText, redlineText, false, cited, chunksTotal, labelA, labelB)
}

/** Cap the change list to a word budget (best-first) so a very-many-changes pair still answers. */
function fitChangesToBudget(
  changes: DiffChange[],
  budgetWords: number
): { changesText: string; redlineText: string; truncated: boolean } | null {
  for (let max = Math.min(changes.length, 200); max >= 1; max = Math.floor(max / 2)) {
    const forModel = renderChangesForModel(changes, { max })
    if (approxTokenCount(forModel.text) <= budgetWords) {
      return {
        changesText: forModel.text,
        redlineText: renderRedline(changes, { max }).text,
        truncated: true
      }
    }
    if (max === 1) break
  }
  return null
}

function buildDiffResult(
  diff: DiffResult,
  changesText: string,
  redlineText: string,
  truncated: boolean,
  cited: OrderedChunkRow[],
  chunksTotal: number,
  labelA: string,
  labelB: string
): CompareDiffResult {
  const chunks: RetrievedChunk[] = cited.map((row, i) => ({
    label: `S${i + 1}`,
    chunkId: row.id,
    documentId: row.document_id,
    text: row.text,
    sourceTitle: row.source_label ?? 'Untitled',
    pageNumber: row.page_number,
    sectionLabel: row.section_label,
    score: 0
  }))
  const citations: Citation[] = chunks.map((c) => ({
    label: c.label,
    sourceTitle: c.sourceTitle,
    pageNumber: c.pageNumber,
    section: c.sectionLabel,
    snippet: truncateSnippet(c.text)
  }))
  return {
    chunks,
    citations,
    redlineText,
    changesText,
    identical: diff.identical,
    chunksCovered: chunksTotal,
    chunksTotal,
    truncated,
    labelA,
    labelB
  }
}

/**
 * RT-2 — the STABLE grounding rules + preface, hoisted out of the per-turn USER message into
 * the cacheable SYSTEM prompt (`GROUNDED_SYSTEM_PROMPT`). Keeping them in the user turn meant
 * `cache_prompt`'s longest-common-prefix reuse stopped at `BASE_SYSTEM_PROMPT` and re-prefilled
 * this whole rules block on every documents turn (the prior user turn is replayed as the RAW
 * question, so the grounded prefix never matched). With the rules in `system` — byte-stable
 * across turns — they sit in the always-reused prefix and only the per-turn excerpts re-prefill.
 *
 * Precedence is preserved/strengthened: these rules are now in `system` (≥ the user turn) and
 * still outrank the skill fence, which stays in the user turn (untrusted reference text, never
 * `system` — skills plan §11.2/§22-H2). The [Sn] citation contract is unchanged: the rules name
 * the labels, the excerpts carry them. Wording is unchanged except "excerpts below" →
 * "excerpts provided" now that the excerpts live in the user message that follows.
 */
const GROUNDING_RULES = `You are answering a question using local documents.

Rules:
- Use only the document excerpts provided when the question is about the documents.
- If the excerpts do not contain enough information, say so.
- Do not invent citations.
- Cite sources inline using [S1], [S2], etc.
- Keep the answer concise unless the user asks for detail.`

/** The grounded-answer SYSTEM prompt: the base preamble + the stable grounding rules (RT-2). */
export const GROUNDED_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${GROUNDING_RULES}`

/**
 * W3 (audit §3.1/§8.1) — the SYSTEM prompt for the grounded-DATA mode. It deliberately does NOT reuse
 * `GROUNDING_RULES`: that block talks about "document excerpts" and tells the model to "Cite [S1], [S2]…",
 * but a grounded-data turn carries a serialized data object, NOT numbered `[Sn]` excerpts — inheriting the
 * excerpt/citation rules would invite dangling `[S1]` markers that point at nothing the user is shown (the
 * persisted citations render as `extract` provenance, not `[Sn]` cards). So the rules are re-worded for a
 * data payload and explicitly forbid inline `[S]` markers. The per-turn `GROUNDED_DATA_RULES` (verbatim
 * quoting / no-arithmetic) still ride in the user turn on top of this.
 */
const GROUNDED_DATA_GROUNDING = `You are answering a question using structured data extracted from a local document.

Rules:
- Use only the extracted data provided in the user message.
- If the data does not contain enough information to answer, say so plainly.
- Do NOT add inline [S1], [S2], … citation markers — this turn contains no numbered excerpts.
- Keep the answer concise unless the user asks for detail.`
export const GROUNDED_DATA_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${GROUNDED_DATA_GROUNDING}`

/** How many `[Sn]` sections of how many a whole-document read actually provided — the shape of an
 *  in-prompt truncation notice. Absent/null ⇒ the whole document fit ⇒ no notice. */
export interface WholeDocTruncation {
  covered: number
  total: number
}

/**
 * Model-facing PARTIAL-DOCUMENT notice (fixed English, app-authored — D-L6 precedent; rides in the
 * USER turn WITH the excerpts, never `system`). Injected when a whole-document read overflowed the
 * budget and no rescue tree covered it: the model is told exactly which sections it was and was NOT
 * given, told to say its answer covers only the beginning, and FORBIDDEN from asserting an absence
 * ("no decisions", "not mentioned", "none found") beyond the provided sections — the audit §2.2
 * failure where the answer text itself claimed completeness. `covered`/`total` are `[Sn]` section
 * counts. `subject` is the noun the notice reads over ("DOCUMENT", "Document A", …). */
function truncationNotice(covered: number, total: number, subject: string): string {
  // "the first N of M sections" — NOT "sections 1 to N", which would collide with the global [Sn]
  // excerpt labels (a compare half B is labelled [S{offset+1}]…, so "sections 1 to N" would mislead).
  return (
    `IMPORTANT — PARTIAL ${subject}: you were given the first ${covered} of ${total} sections; the ` +
    `remaining ${total - covered} did not fit and were NOT provided. Answer only from the sections you ` +
    `were given, state plainly that your answer covers only the beginning, and do NOT say that ` +
    `anything is absent or missing (for example "no X", "not mentioned", "none found") — the sections ` +
    `you cannot see may contain it.`
  )
}

/**
 * Deterministic PII-scan summary injected into the share-safe-review grounded prompt (U2, audit §3.5).
 * Model-facing, fixed English (app-authored, like `truncationNotice`; rides in the USER turn WITH the
 * excerpts, never `system`). It reports COUNTS only — never a detected value (§6) — and states plainly that
 * the scan covered the WHOLE document (so the model does not treat a truncated excerpt view as the whole
 * picture). When `truncated`, it FORBIDS the "Likely low risk after review" verdict: a privacy-safe verdict
 * must rest on non-truncated coverage, not on a prefix the model happened to be shown. Pure + unit-testable.
 */
export function buildShareSafeScanBlock(counts: RedactionCounts, truncated: boolean): string {
  const summary =
    `AUTOMATED PRE-SCAN (deterministic, offline, whole document — counts only): the pattern detectors ` +
    `found e-mail addresses: ${counts.email}, phone numbers: ${counts.phone}, IBANs: ${counts.iban}, ` +
    `payment-card numbers: ${counts.card}, dates: ${counts.date}, links: ${counts.url}. This scan covers ` +
    `the ENTIRE document even where the excerpts below are only its beginning; it detects clearly-shaped ` +
    `patterns ONLY and cannot see names, postal addresses, or confidential wording — treat it as a floor, ` +
    `not a ceiling.`
  const gate = truncated
    ? ` You are shown only the BEGINNING of this document, so you MUST NOT issue the "Likely low risk ` +
      `after review" verdict — you have not reviewed the whole document. Use "Review carefully before ` +
      `sharing" (or a stronger verdict) instead.`
    : ''
  return `${summary}${gate}`
}

/**
 * Build the grounded answer USER turn: the question, the optional skill fence, an optional
 * partial-document notice, an optional analysis block (e.g. the share-safe PII pre-scan), then the numbered
 * source excerpts in the spec §7.8 source-context format (`[S1] File: X | Page: 4` then the quoted chunk
 * text). The stable grounding rules now live in `GROUNDED_SYSTEM_PROMPT` (RT-2), so this carries only the
 * per-turn content. Pure + unit-testable.
 */
export function buildGroundedPrompt(
  question: string,
  chunks: RetrievedChunk[],
  skillFence?: string | null,
  truncation?: WholeDocTruncation | null,
  analysisBlock?: string | null
): string {
  const excerpts = chunks
    .map((c) => `[${c.label}] File: ${c.sourceTitle}${sourceMeta(c)}\n"${c.text}"`)
    .join('\n\n')
  // The skill fence (skills plan §11.2/§22-H2) rides in the USER turn WITH the excerpts — the same
  // untrusted-reference-text class — never in `system`. It sits AFTER the question and BEFORE the
  // excerpts; the fence carries its own guard line. The grounding rules in GROUNDED_SYSTEM_PROMPT
  // ("use only the excerpts", "cite [S1]…", "do not invent citations") always win.
  const skillBlock = skillFence ? `\n${skillFence}\n` : ''
  // The partial-document notice sits between the fence and the excerpts (audit §2.2). Absent ⇒ the
  // string is byte-identical to the pre-W1 prompt for a document that fit (no regression).
  const truncationBlock = truncation ? `\n${truncationNotice(truncation.covered, truncation.total, 'DOCUMENT')}\n` : ''
  // The analysis block (U2 share-safe pre-scan) sits after the truncation notice, before the excerpts.
  // Absent ⇒ byte-identical to the pre-U2 prompt (every non-share-safe caller passes nothing).
  const analysis = analysisBlock ? `\n${analysisBlock}\n` : ''
  return `Question:
${question}
${skillBlock}${truncationBlock}${analysis}
Document excerpts:
${excerpts}

Answer:`
}

/**
 * Build the grounded USER turn for a 2-document WHOLE-DOCUMENT compare (Follow-up B): the question,
 * the optional skill fence, then the two documents as LABELLED blocks (so a same-titled pair of
 * versions is still distinguishable), each carrying its `[Sn] File: …` excerpts in the spec §7.8
 * format. The fence + its guard ride in this user turn exactly as `buildGroundedPrompt`; the stable
 * grounding rules stay in `GROUNDED_SYSTEM_PROMPT`. Pure + unit-testable.
 */
export function buildCompareWholeDocPrompt(
  question: string,
  groups: Array<{
    title: string
    importedAt: string | null
    chunks: RetrievedChunk[]
    truncated?: boolean
    chunksCovered?: number
    chunksTotal?: number
  }>,
  skillFence?: string | null
): string {
  const docs = groups
    .map((g, i) => {
      const letter = i === 0 ? 'A' : 'B'
      const excerpts = g.chunks
        .map((c) => `[${c.label}] File: ${c.sourceTitle}${sourceMeta(c)}\n"${c.text}"`)
        .join('\n\n')
      // A PARTIAL half prints its own notice under its label so the model never reports a value as
      // "removed"/"absent" merely because it fell past this document's provided beginning (audit §2.2).
      const notice = g.truncated
        ? `\n${truncationNotice(g.chunksCovered ?? g.chunks.length, g.chunksTotal ?? g.chunks.length, `Document ${letter}`)}`
        : ''
      return `${describeCompareDoc(letter, g.title, g.importedAt)}:${notice}\n${excerpts}`
    })
    .join('\n\n')
  const skillBlock = skillFence ? `\n${skillFence}\n` : ''
  return `Question:
${question}
${skillBlock}
Compare the two documents below. They are labelled A and B by import order ONLY — this does NOT tell
you which is the older or newer version. Describe the differences between Document A and Document B;
never call either the "old" or the "new" version.

${docs}

Answer:`
}

/**
 * Grounded prompt for the DIFF-DRIVEN compare (mode d, compare-diff record). The model is handed the
 * EXACT changes a deterministic word-level diff already found — never two walls of text — so it
 * cannot miss a one-word change or dismiss repetitive/placeholder content as "identical". It answers
 * the user's question over those changes, in the user's language, per the skill fence. The redline is
 * included verbatim so it can quote exact wording; `[Sn]` citations point at the changed locations.
 */
export function buildCompareDiffPrompt(
  question: string,
  redlineText: string,
  changesText: string,
  labelA: string,
  labelB: string,
  skillFence?: string | null,
  truncated?: boolean
): string {
  const skillBlock = skillFence ? `\n${skillFence}\n` : ''
  const redlineBlock = redlineText ? `Exact word-level changes (redline):\n${redlineText}\n\n` : ''
  // The change list can be capped to the (W1-tightened) budget. When it was, the model must NOT be
  // told it is "complete and exact" (audit §2.2 honesty): it is the most significant changes only, and
  // "no change listed for X" no longer implies X is unchanged.
  const completeness = truncated
    ? 'Base your answer ONLY on these changes. This list is PARTIAL — the most significant changes are\n' +
      'shown but some further changes did not fit and are NOT listed, so do NOT say a section is\n' +
      'unchanged just because no change for it appears here.'
    : 'Base your answer ONLY on these changes — they are complete and exact.'
  return `Question:
${question}
${skillBlock}
A deterministic word-level comparison of two documents produced the changes below.
${labelA}
${labelB}
${completeness} Do not dismiss a change as
unimportant; keep names, numbers, and dates exact. "Removed"/"Changed-from" text is present in
Document A but not Document B; "Added"/"Changed-to" text is present in Document B but not Document A.
The labels A and B follow import order only — do NOT describe either as the "old" or the "new"
version. Cite the changed locations with [S1], [S2], etc.

${redlineBlock}Differences from Document A to Document B:
${changesText}

Answer:`
}

/**
 * Build the runtime message list for a grounded answer: the base system prompt, the prior
 * conversation history, and the current (last) user turn REPLACED by the grounded prompt.
 * The DB keeps the raw question for the transcript; only the model sees the grounded form.
 */
export function buildGroundedChatMessages(
  db: Db,
  conversationId: string,
  groundedUserContent: string,
  contextTokens?: number,
  // W3: the grounded-DATA mode overrides this with `GROUNDED_DATA_SYSTEM_PROMPT` (no `[Sn]` citation rule);
  // defaulted so every existing caller (relevance / whole-doc / compare) stays byte-identical.
  systemPrompt: string = GROUNDED_SYSTEM_PROMPT
): ChatMessage[] {
  // RT-2: the grounded system prompt carries the stable grounding rules so cache_prompt
  // reuses them across documents turns (byte-stable prefix).
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
  // L2 (context compaction): when a checkpoint exists, inject its summary as a synthetic
  // user→assistant pair (§4.5) and replay only the turns AFTER it; otherwise replay the whole
  // history (byte-identical to before). The checkpoint is built from the STORED RAW turns
  // (R-RAG) — never this transient grounded prompt — and the live final grounded turn below stays
  // mandatory in fitMessagesToContext, so the question + [Sn] excerpts are always present. The §5.4
  // toggle gates the read too: when off, any existing checkpoint is ignored (full-history replay).
  const checkpoint = compactionEnabled(db) ? getLatestCheckpoint(db, conversationId) : null
  if (checkpoint) messages.push(...compactionSummaryPair(checkpoint.summary))
  const history = listConversationTurns(db, conversationId, checkpoint?.coversThroughRowid ?? 0)
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    const isLast = i === history.length - 1
    if (isLast && m.role === 'user') {
      messages.push({ role: 'user', content: groundedUserContent })
    } else {
      // Assistant turns are scrubbed of think blocks before being replayed.
      messages.push({
        role: m.role,
        content: m.role === 'assistant' ? stripThinkBlocks(m.content) : m.content
      })
    }
  }
  // Drop orphan user turns from earlier failed answers so the roles still alternate
  // (a non-alternating history makes some chat templates raise — an HTTP 500).
  const collapsed = collapseToAlternating(messages)
  // Trim older history to the model context (the grounded turn carries the retrieved
  // chunk block, so its prior turns are what overflow). The grounded turn is the final
  // message, which fitMessagesToContext always keeps. Omitted ⇒ full history (pure builder).
  return contextTokens == null ? collapsed : fitMessagesToContext(collapsed, contextTokens)
}

export interface GroundedAnswerOptions {
  signal?: AbortSignal
  onToken?: (token: string) => void
  runtimeOptions?: Pick<RuntimeChatOptions, 'maxTokens' | 'temperature'>
  /**
   * Fired once with the REAL assembled grounded prompt's usage (fitted history + the injected
   * excerpt/whole-document block, in the budget's own estimate) over the launched window, right
   * before generation. The IPC layer forwards it to the composer meter — the renderer cannot
   * estimate a document turn from the visible history alone (the excerpt block never persists),
   * which is how the meter read 7% while the window was actually full.
   */
  onPromptUsage?: (usage: ContextUsage) => void
  /**
   * Legacy "ask selected documents" doc-id scope. Null = whole corpus. Kept for existing
   * callers; ignored when `scope` is provided.
   */
  scopeDocumentIds?: string[] | null
  /**
   * Composite retrieval scope (document-organization plan §10.2): membership + specific
   * docs + archived flag. When set it takes precedence over `scopeDocumentIds` AND makes
   * the empty-context re-index check scope-aware (M2). Absent ⇒ legacy whole-corpus check.
   */
  scope?: RetrievalScope | null
  /** Optional retrieval reranker. Null/absent keeps the fused ordering. */
  reranker?: Reranker | null
  /**
   * The skill resolved for this turn (skills plan §10/§11, audit A1). Its fence rides in the
   * grounded USER turn with the excerpts. The assistant row is stamped with the install_id only
   * when chunks were found AND the fence fit — the no-context answer (model not called) stamps NULL.
   */
  skill?: TurnSkill | null
  /**
   * Skill-aware WHOLE-DOCUMENT answer (skill-whole-doc engine, Wave 2). When set, the grounded
   * context is the named document read IN ORDER (not top-k retrieval), capped to the context
   * budget, and the persisted coverage is `capped` ("covers the whole document" / "covers the
   * beginning" when truncated) instead of `relevance`. Set ONLY by a `grounded-whole-doc` analysis
   * handler over its single in-scope, fully-chunked document; the caller has already enforced those
   * preconditions (the D45 fully-chunked refusal still gates this in `registerRagIpc`).
   */
  wholeDocument?: { documentId: string }
  /**
   * U2 (audit §3.5): when set WITH `wholeDocument`, run the deterministic PII detectors over the WHOLE
   * document (all chunks, never budget-capped) and inject their COUNTS summary into the grounded prompt;
   * when the whole-document read was truncated, the injected block also forbids the "Likely low risk"
   * verdict (a privacy-safe verdict must rest on non-truncated coverage). Set ONLY by the share-safe-review
   * handler (`injectPiiScan`). Counts only — no detected value reaches the prompt (§6). No new model call.
   */
  wholeDocumentPiiScan?: boolean
  /**
   * Skill-aware 2-document WHOLE-DOCUMENT compare (Follow-up B, what-changed). When set, BOTH named
   * documents are read IN ORDER (not top-k), the whole-document budget is SPLIT across them
   * (size-aware: each gets up to half, a smaller doc donates its unused half to the larger), the
   * grounded turn presents them as two labelled documents with the SKILL.md fence, and the persisted
   * coverage is `capped` (truncated when EITHER document overflowed its share). Set ONLY by a
   * `grounded-whole-doc-compare` handler over its two in-scope, fully-chunked documents.
   */
  wholeDocumentCompare?: { documentIds: string[] }
  /**
   * Fired once when a pre-first-token "working on it" phase begins for this turn — either the context-
   * compaction pre-pass (a bare call ⇒ `'compaction'`) or, on the whole-doc map-reduce path, the SILENT
   * map loop before the first streamed reduce token (Phase 3, §5 ⇒ `'analysis'`). The IPC layer forwards
   * it to the ephemeral `STREAM.compaction` channel; the renderer clears it on the first answer token.
   */
  onCompactionStart?: (kind?: 'analysis') => void
  /**
   * W2 scope notice (audit §2.1): when the chat path AUTO-NARROWED a multi-document scope to the one
   * document this skill best matches, this fixed, localized notice ("I answered from «title» only — the
   * other N documents in scope were not read…") is prepended to the streamed answer AND to the persisted
   * content, so the honesty note rides with the answer (never a silent narrowing). Absent ⇒ no prefix
   * (the byte-unchanged path). App-authored text; it carries no content and needs no model call.
   */
  answerPrefix?: string
}

/**
 * Token budget for the whole-document chunk block (skill-whole-doc engine). The real launched
 * context window minus the answer reserve, the grounded system prompt, the question scaffolding,
 * and an allowance for the skill fence (the fence's precise placement/trim is still done downstream
 * in `generateGroundedAnswer`). Never below a small floor so a tiny window still includes something.
 */
export function wholeDocumentBudgetTokens(
  contextTokens: number,
  question: string,
  skill: TurnSkill | null | undefined
): number {
  const fenceAllowance = skill
    ? approxPromptTokens(buildSkillFence({ title: skill.title, body: skill.body }).text ?? '')
    : 0
  const questionScaffold = approxPromptTokens(question) + 64 // question + "Question:/Answer:" framing
  const budget =
    contextTokens -
    CHAT_RESPONSE_RESERVE_TOKENS -
    approxPromptTokens(GROUNDED_SYSTEM_PROMPT) -
    questionScaffold -
    fenceAllowance
  return Math.max(512, budget)
}

/**
 * Headroom the retrieval-excerpt budget leaves for the 1.3-tokens/word estimate under-counting
 * real model tokens: `retrieve` measures excerpts at `approxTokenCount × TOKENS_PER_WORD` (1.3),
 * but a subword-dense passage (e.g. a German account statement) can run closer to ~2 real BPE
 * tokens/word. Dividing the window budget by this factor keeps the assembled grounded turn under
 * the launched context window even worst-case — the fix for the HTTP 400 "exceeds context size".
 */
const RETRIEVAL_FIT_SAFETY = 1.5

/**
 * The excerpt-block budget for the RELEVANCE (top-k) path, clamped to the REAL launched context
 * window (§L0) — not just the fixed `ragMaxContextTokens` setting. Mirrors `wholeDocumentBudgetTokens`
 * (the whole-doc path already clamps; the relevance path never did), then subtracts a per-excerpt
 * framing allowance (`[Sn] File: … | Page: …`) and applies RETRIEVAL_FIT_SAFETY. The caller takes
 * `min(this, settings.maxContextTokens)`, so a large-window model keeps the full setting and only a
 * small-window model is constrained. Returned in the SAME 1.3-scaled units `retrieve` caps against.
 */
function retrievalExcerptBudgetTokens(
  contextTokens: number,
  question: string,
  skill: TurnSkill | null | undefined,
  topKFinal: number
): number {
  const perExcerptFraming = 48 * Math.max(1, topKFinal) // "[Sn] File: <title> | Page: N" + quotes, per chunk
  const usable = wholeDocumentBudgetTokens(contextTokens, question, skill) - perExcerptFraming
  return Math.max(256, Math.floor(usable / RETRIEVAL_FIT_SAFETY))
}

/**
 * The WHOLE-DOCUMENT read budget with the same RETRIEVAL_FIT_SAFETY (1.5) headroom the relevance path
 * applies (audit §2.2 [HIGH] German subword overflow). `wholeDocumentBudgetTokens` measures chunk text
 * at `approxTokenCount × TOKENS_PER_WORD` (1.3), but a subword-dense passage — a German account
 * statement — can run ~2 real BPE tokens/word, so a budget-filling whole-doc turn (the flagship de-AT
 * flow) could exceed n_ctx and fail with a raw runtime HTTP 400. Dividing by the safety factor keeps
 * the assembled grounded turn under the launched window even worst-case. Used by BOTH the single
 * whole-doc read and the 2-document compare split (which further divides this across the two documents).
 */
export function wholeDocumentFitBudgetTokens(
  contextTokens: number,
  question: string,
  skill: TurnSkill | null | undefined
): number {
  return Math.max(512, Math.floor(wholeDocumentBudgetTokens(contextTokens, question, skill) / RETRIEVAL_FIT_SAFETY))
}

/**
 * Retrieve grounded context for the last user turn of `conversationId`, stream a cited
 * answer from `runtime`, and persist the assistant message WITH its `Citation[]`
 * (→ `messages.citations_json`). The triggering user message must already be in history.
 *
 * Empty corpus / weak retrieval: when retrieval finds no usable chunks, the model is NOT
 * called — a fixed "not found in your documents" answer is persisted instead (grounding
 * rule, spec §7.8). Retrieval is the source of truth for citations; the mock runtime's
 * echo does not contain real `[Sn]` markers, so we persist the computed citations directly.
 */
export async function generateGroundedAnswer(
  db: Db,
  runtime: ModelRuntime,
  embedder: Embedder,
  conversationId: string,
  question: string,
  settings: RagRetrievalSettings,
  opts: GroundedAnswerOptions = {}
): Promise<Message> {
  // A composite `scope` (plan §10.2) wins over the legacy doc-id scope. Both normalize
  // inside `retrieve`, so a bare doc-id array still works byte-for-byte.
  const scopeArg = opts.scope ?? opts.scopeDocumentIds
  // The REAL launched context window the runtime reports (§L0) — needed up-front for the
  // whole-document budget, and reused below for fence sizing + compaction.
  const contextTokens = effectiveContextWindow(runtime, getSettings(db))

  // Skill-aware WHOLE-DOCUMENT answer (Wave 2): read the named document in order (capped to the
  // context budget) instead of top-k retrieval, and stamp honest `capped` coverage. The relevance
  // path is byte-unchanged (coverage stays undefined ⇒ persisted NULL ⇒ the relevance badge).
  let chunks: RetrievedChunk[]
  let citations: Citation[]
  let coverage: CoverageInfo | undefined
  // When a single whole-document read overflowed the budget (no rescue tree), the grounded prompt
  // carries an explicit model-facing notice: it names how many sections were provided vs total and
  // forbids asserting an absence beyond the provided beginning (audit §2.2). Null ⇒ no notice.
  let singleDocTruncation: { covered: number; total: number } | null = null
  // U2 (audit §3.5): the share-safe-review pre-scan block — a deterministic whole-document PII count
  // summary injected into the grounded prompt, gating the low-risk verdict on non-truncated coverage.
  // Set only when `opts.wholeDocumentPiiScan` (the share-safe handler). Null ⇒ no injection.
  let shareSafeScanBlock: string | null = null
  // When set (Follow-up B), the grounded turn presents the two compared documents as labelled blocks
  // (buildCompareWholeDocPrompt) instead of a single excerpt list. Each group carries its own honest
  // per-document coverage so a PARTIAL half prints its own "beginning only" notice in the prompt.
  let compareGroups: Array<CompareDocGroup> | null = null
  // When set (mode d, compare-diff record), the grounded turn presents the DETERMINISTIC changes
  // (buildCompareDiffPrompt) instead of the two whole documents — the primary version-compare path.
  // `labelA`/`labelB` name the pair (title + import date) so the prompt states the A→B direction
  // WITHOUT asserting which is the old/new version (audit §5.1).
  let compareDiff: { redlineText: string; changesText: string; labelA: string; labelB: string; truncated: boolean } | null = null
  if (opts.wholeDocument) {
    const budget = wholeDocumentFitBudgetTokens(contextTokens, question, opts.skill)
    const whole = retrieveWholeDocument(db, opts.wholeDocument.documentId, budget)
    // U2 (audit §3.5): the deterministic whole-document PII pre-scan (share-safe handler) — COUNTS only
    // (§6). Computed once here so both the chunk map-reduce (extraReduceBlock) and the capped/fit grounded
    // prompt reuse it. Null ⇒ not the share-safe handler.
    const scan = opts.wholeDocumentPiiScan ? scanWholeDocumentForPii(db, opts.wholeDocument.documentId) : null
    // Over-budget document: rather than truncate to the beginning, cover the WHOLE document via map-reduce.
    // First the deep-index TREE rescue (`mode:'tree'`) when one is ready (Follow-up A); else an on-the-fly
    // map-reduce over the RAW chunks (Phase 1 — `mode:'capped', truncated:false` — closes the "gap band" of
    // documents too large for a single read but too small to have auto-built a tree). Only when BOTH decline
    // (no usable tree / zero chunks) do we fall through to the honest beginning-only capped floor below. A
    // document that FITS the budget never enters here (truncated:false).
    if (whole.truncated) {
      const viaTree = await answerWholeDocFromTree({
        db,
        runtime,
        conversationId,
        documentId: opts.wholeDocument.documentId,
        question,
        skill: opts.skill,
        contextTokens,
        signal: opts.signal,
        onToken: opts.onToken,
        // Phase 3 (§5): fire the 'analysis' progress notice when the rescue runs a real map loop.
        onCompactionStart: opts.onCompactionStart,
        // W2 (§2.1): carry the auto-narrow scope notice into the tree rescue path too.
        answerPrefix: opts.answerPrefix
      })
      if (viaTree) return viaTree
      const viaChunks = await answerWholeDocFromChunks({
        db,
        runtime,
        conversationId,
        documentId: opts.wholeDocument.documentId,
        question,
        skill: opts.skill,
        contextTokens,
        signal: opts.signal,
        onToken: opts.onToken,
        // Phase 3 (§5): same 'analysis' progress notice for the no-tree chunk map-reduce path.
        onCompactionStart: opts.onCompactionStart,
        answerPrefix: opts.answerPrefix,
        // Share-safe parity: the chunk map-reduce covers the WHOLE document, so the verdict gate is NOT
        // applied (truncated=false) — the low-risk verdict is legitimately allowed. Rides in the reduce
        // USER turn (never the system prompt). Closes the tree-path share-safe residual for gap-band docs.
        extraReduceBlock: scan ? buildShareSafeScanBlock(scan, false) : undefined
      })
      if (viaChunks) return viaChunks
    }
    chunks = whole.chunks
    citations = whole.citations
    coverage = {
      mode: 'capped',
      chunksCovered: whole.chunksCovered,
      chunksTotal: whole.chunksTotal,
      truncated: whole.truncated
    }
    // The last-resort capped FLOOR (both map-reduce rescues declined — zero chunks, or a disabled path): the
    // read is the honest beginning. Tell the model exactly what it cannot see so its answer never claims
    // completeness or asserts an absence (§2.2).
    if (whole.truncated) singleDocTruncation = { covered: whole.chunksCovered, total: whole.chunksTotal }
    // U2: the share-safe pre-scan summary rides in the grounded (floor/fit) prompt; a truncated FLOOR read
    // additionally forbids the low-risk verdict. (The common over-budget case now returns via the chunk
    // map-reduce above, whose reduce turn carries the untruncated scan block.)
    if (scan) shareSafeScanBlock = buildShareSafeScanBlock(scan, whole.truncated)
  } else if (opts.wholeDocumentCompare) {
    const budget = wholeDocumentFitBudgetTokens(contextTokens, question, opts.skill)
    const ids = opts.wholeDocumentCompare.documentIds
    // Mode (d) — DIFF-DRIVEN compare (compare-diff record, architecture.md §20). A deterministic
    // word-level diff over BOTH whole documents is the primary path for a version pair: it examines
    // every chunk (so a page-2 change can't be truncated away) and hands the model the EXACT changes,
    // not two walls of text. Returns null when the diff is not the right tool (docs too large/too
    // different) — then fall back to the labelled whole-doc-compare read (which may cap the tail).
    const diff = retrieveCompareDiff(db, ids, budget)
    if (diff) {
      chunks = diff.chunks
      citations = diff.citations
      compareDiff = { redlineText: diff.redlineText, changesText: diff.changesText, labelA: diff.labelA, labelB: diff.labelB, truncated: diff.truncated }
      coverage = {
        mode: 'capped',
        chunksCovered: diff.chunksCovered,
        chunksTotal: diff.chunksTotal,
        truncated: diff.truncated
      }
    } else {
      // 2-document whole-doc compare (Follow-up B): read BOTH documents in order with the budget
      // split across them (size-aware), present them as two labelled blocks + the fence, and stamp
      // honest `capped` coverage (truncated when EITHER document overflowed its share).
      const comp = retrieveCompareWholeDocuments(db, ids, budget)
      chunks = comp.chunks
      citations = comp.citations
      compareGroups = comp.groups
      coverage = {
        mode: 'capped',
        chunksCovered: comp.chunksCovered,
        chunksTotal: comp.chunksTotal,
        truncated: comp.truncated
      }
    }
  } else {
    // Clamp the excerpt budget to the REAL launched window (§L0), not just the fixed
    // `ragMaxContextTokens` setting: otherwise the grounded turn (system + excerpts + framing +
    // question) can exceed a small-window model's n_ctx → HTTP 400 "exceeds context size". The
    // clamp is caller-scoped (retrieve()'s core loop is unchanged); min() keeps large windows at
    // the full setting and only constrains small ones. Mirrors the whole-document path.
    const excerptBudget = Math.min(
      settings.maxContextTokens,
      retrievalExcerptBudgetTokens(contextTokens, question, opts.skill, settings.topKFinal)
    )
    const fitted =
      excerptBudget < settings.maxContextTokens
        ? { ...settings, maxContextTokens: excerptBudget }
        : settings
    const r = await retrieve(db, embedder, question, fitted, scopeArg, opts.reranker, opts.signal)
    chunks = r.chunks
    citations = r.citations
  }

  if (chunks.length === 0) {
    // Distinguish "nothing relevant" from "the corpus is invisible to the active
    // embedder": the latter needs a re-index, not a rephrase. Either way the model is
    // never called without context (grounding rule). The check uses the SAME scope retrieval
    // uses (`scopeArg`, normalized) — composite OR legacy doc-id — so the re-index honesty
    // story holds on both paths (M2/RAG-1): a stale scope reports REINDEX_NEEDED, an empty
    // scope reports NO_DOCUMENT_CONTEXT, never the whole-corpus answer when retrieval was scoped.
    const answer = corpusNeedsReindex(db, embedder.id, normalizeScope(scopeArg))
      ? REINDEX_NEEDED_ANSWER
      : NO_DOCUMENT_CONTEXT_ANSWER
    opts.onToken?.(answer)
    return appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: answer
    })
  }

  // Pre-size the skill fence (§11.3/A6) against the fence-less grounded turn so it never starves
  // the base preamble, the question, or the excerpts — only older history yields. The fence rides
  // in the grounded USER turn (buildGroundedPrompt). Stamp only when the fence actually fit.
  const groundedNoFence = compareDiff
    ? buildCompareDiffPrompt(question, compareDiff.redlineText, compareDiff.changesText, compareDiff.labelA, compareDiff.labelB, null, compareDiff.truncated)
    : compareGroups
      ? buildCompareWholeDocPrompt(question, compareGroups)
      : buildGroundedPrompt(question, chunks, null, singleDocTruncation, shareSafeScanBlock)
  // `contextTokens` was resolved above (the whole-document budget needs it up-front); it is the
  // REAL launched context window the runtime reports (§L0), not settings.contextTokens.
  // L2 (context compaction): summarize older raw turns into a cached checkpoint when the history
  // approaches the window, BEFORE assembly. The checkpoint is built from the stored raw turns, never
  // this grounded prompt (R-RAG). A no-op below threshold; any failure/abort falls back to L1 with no
  // error. Runs after the no-context early return (no model call ⇒ nothing to compact for). Gated by
  // the §5.4 toggle: when off, no checkpoint is created and assembly ignores any existing one.
  if (compactionEnabled(db)) {
    await ensureCompacted(db, runtime, conversationId, contextTokens, {
      signal: opts.signal,
      onStart: opts.onCompactionStart
    })
  }
  let skillFence: string | null = null
  if (opts.skill) {
    // RT-2: the grounding rules moved into the system prompt, so size the fence against
    // GROUNDED_SYSTEM_PROMPT (+ the now-rules-less grounded user turn). The total fixed
    // content is unchanged — text moved from the user turn to system — so the fence budget
    // is preserved.
    const fixedTokens =
      approxPromptTokens(GROUNDED_SYSTEM_PROMPT) + approxPromptTokens(groundedNoFence) + 16
    const budget = skillFenceBudgetTokens({
      contextTokens,
      reserveTokens: CHAT_RESPONSE_RESERVE_TOKENS,
      fixedTokens
    })
    const fence = buildSkillFence({ title: opts.skill.title, body: opts.skill.body }, budget)
    // U1 (audit §3.6): log a budget-driven trim/omit (ids/counts only) — was silently discarded before.
    logSkillFenceReduction(opts.skill.installId, fence)
    skillFence = fence.text
  }
  const grounded = skillFence
    ? compareDiff
      ? buildCompareDiffPrompt(question, compareDiff.redlineText, compareDiff.changesText, compareDiff.labelA, compareDiff.labelB, skillFence, compareDiff.truncated)
      : compareGroups
        ? buildCompareWholeDocPrompt(question, compareGroups, skillFence)
        : buildGroundedPrompt(question, chunks, skillFence, singleDocTruncation, shareSafeScanBlock)
    : groundedNoFence
  // Trim older history to the model context window so the grounded turn (which carries the
  // retrieved-chunk block, up to settings.maxContextTokens) plus prior turns never overflow
  // and trigger an HTTP 400 from the runtime.
  const messages = buildGroundedChatMessages(db, conversationId, grounded, contextTokens)
  // Meter honesty: the grounded turn carries the whole excerpt/document block, which never
  // persists — report the REAL assembled usage so the live meter shows how full the window is.
  opts.onPromptUsage?.({
    usedTokens: messages.reduce((sum, m) => sum + messageTokens(m), 0),
    window: contextTokens
  })
  // W2 scope notice (§2.1): when the scope was auto-narrowed to this one document, lead with the fixed
  // localized notice so it streams first AND lands in the persisted content (never a silent narrowing).
  const seededPrefix = opts.answerPrefix ?? ''
  let content = seededPrefix
  if (opts.answerPrefix) opts.onToken?.(opts.answerPrefix)
  // Honest-signal parity with plain chat (§L0): capture the finish reason so a grounded answer the
  // model cut off at the context ceiling gets the truncated badge instead of persisting a mid-word
  // partial as if complete — a budget-filling document turn is exactly where the ceiling hits.
  let finishReason: string | null = null
  // No `mode` is passed: document answers always run 'balanced' — grounded
  // answers should be fast + literal.
  const stream = runtime.chatStream(messages, {
    signal: opts.signal,
    onFinish: (reason) => {
      finishReason = reason
    },
    ...opts.runtimeOptions
  })
  try {
    for await (const token of stream) {
      content += token
      opts.onToken?.(token)
    }
  } catch (err) {
    // A user Stop aborts the stream; persist the partial answer (still cited) and
    // return normally. Any other error is a real failure and propagates.
    if (!isAbortError(err, opts.signal)) throw err
  }
  // Reasoning never reaches the DB — same defense-in-depth strip as plain chat.
  content = stripThinkBlocks(content)
  // Drop any skill-fence framing the model echoed back (e.g. a trailing "--- END LOCAL SKILL ---").
  content = stripSkillFenceEcho(content)
  // A stop before the first token produced nothing — persist nothing. When a W2 scope-notice prefix was
  // seeded (`seededPrefix`), an empty model turn leaves ONLY that notice: it is not an answer and must
  // not be persisted alone stamped with `capped` coverage (W2 review), so treat prefix-only as empty too.
  // With no prefix `seededPrefix` is '' → byte-identical to the prior `content === ''` guard.
  if (content === '' || content === seededPrefix) return emptyAssistantMessage(conversationId)
  // Persist the assistant turn with the computed citations (source of truth = retrieval) and stamp
  // the skill only when its fence was actually placed (DS16/§22-A5).
  return appendMessage(db, {
    conversationId,
    role: 'assistant',
    content,
    citations,
    // Whole-document answers stamp honest `capped` coverage (covers the whole document / the
    // beginning when truncated); the relevance path leaves it undefined ⇒ NULL ⇒ relevance badge.
    coverage,
    skillId: skillFence ? (opts.skill?.installId ?? null) : null,
    // Auto-fire provenance rides with the stamp (S13c) — only when the fence was placed (§22-A5).
    autoFired: skillFence ? opts.skill?.autoFired === true : false,
    // 'length' with no max_tokens cap in play = cut off at the model's context ceiling (the
    // grounded path passes no mode, so only an explicit runtimeOptions cap counts as a cap).
    truncated: finishReason === 'length' && opts.runtimeOptions?.maxTokens == null
  })
}

/** Options for the W3 grounded-DATA stream (audit §3.1/§8.1). A slim sibling of `GroundedAnswerOptions`:
 *  no retrieval knobs (the context is the fixed `dataBlock`, not top-k), just the fence + streaming. */
export interface GroundedDataAnswerOptions {
  signal?: AbortSignal
  onToken?: (token: string) => void
  onCompactionStart?: () => void
  /** The real assembled-prompt usage for the composer meter — mirrors `GroundedAnswerOptions`. */
  onPromptUsage?: (usage: ContextUsage) => void
  /** The turn's skill: its fence rides in the grounded USER turn (mirrors `buildGroundedPrompt`); the
   *  assistant row is stamped only when the fence actually fit. */
  skill?: TurnSkill | null
  /** W2 scope notice (audit §2.1): streamed + persisted BEFORE the model answer when the scope was
   *  auto-narrowed to this document. Absent ⇒ no prefix. */
  answerPrefix?: string
}

/**
 * W3 (audit §3.1/§8.1) — the THIRD answer mode: stream a model answer that NARRATES a deterministically
 * extracted + validated `dataBlock`, then append a deterministic `postscript` (the parsed totals,
 * verbatim) UNDER it so any model misquote is immediately contradicted (§8.1 caveat). The figures stay
 * the parser's — the model only reads them. Unlike `generateGroundedAnswer` there is NO retrieval: the
 * authoritative context is the fixed data object the analysis handler already built and validated, so
 * the citations + coverage are the handler's (source of truth), passed straight through. Conversation
 * history IS replayed (via `buildGroundedChatMessages`), so a follow-up ("und warum stimmt das nicht?")
 * sees the prior turn — the fix for the audit §3.1 "history never consulted" complaint.
 */
export async function generateGroundedDataAnswer(
  db: Db,
  runtime: ModelRuntime,
  conversationId: string,
  question: string,
  data: { dataBlock: string; postscript: string; citations: Citation[]; coverage?: CoverageInfo },
  opts: GroundedDataAnswerOptions = {}
): Promise<Message> {
  // The REAL launched context window (§L0), for fence sizing + compaction — mirrors generateGroundedAnswer.
  const contextTokens = effectiveContextWindow(runtime, getSettings(db))

  // Compact older raw turns into a cached checkpoint when history approaches the window, BEFORE assembly
  // (L2) — identical posture to the relevance path; a no-op below threshold. The data block itself is
  // NEVER summarized (it is the current grounded turn, always kept by fitMessagesToContext).
  if (compactionEnabled(db)) {
    await ensureCompacted(db, runtime, conversationId, contextTokens, {
      signal: opts.signal,
      onStart: opts.onCompactionStart
    })
  }

  // Pre-size the skill fence against the FENCE-LESS grounded-data turn (§11.3/A6) so it never starves the
  // data block, the question, or the rules — only the fence + older history yield. The data block is
  // authoritative content (the excerpt slot) and never trims; this is the "pre-sized against the context
  // like the skill fence is" guard the plan calls for (the data block's own ~150-row cap bounds it upstream).
  const groundedNoFence = buildGroundedDataPrompt(question, data.dataBlock, null)
  let skillFence: string | null = null
  if (opts.skill) {
    const fixedTokens =
      approxPromptTokens(GROUNDED_DATA_SYSTEM_PROMPT) + approxPromptTokens(groundedNoFence) + 16
    const budget = skillFenceBudgetTokens({
      contextTokens,
      reserveTokens: CHAT_RESPONSE_RESERVE_TOKENS,
      fixedTokens
    })
    const fence = buildSkillFence({ title: opts.skill.title, body: opts.skill.body }, budget)
    // U1 (audit §3.6): log a budget-driven trim/omit (ids/counts only) — was silently discarded before.
    logSkillFenceReduction(opts.skill.installId, fence)
    skillFence = fence.text
  }
  const grounded = skillFence ? buildGroundedDataPrompt(question, data.dataBlock, skillFence) : groundedNoFence
  // The grounded-data mode uses its OWN system prompt (no `[Sn]` citation rule — the turn carries a data
  // object, not numbered excerpts), so the model is never told to cite excerpts it wasn't given.
  const messages = buildGroundedChatMessages(db, conversationId, grounded, contextTokens, GROUNDED_DATA_SYSTEM_PROMPT)
  // Meter honesty: the data block rides only in this transient turn — report the real usage.
  opts.onPromptUsage?.({
    usedTokens: messages.reduce((sum, m) => sum + messageTokens(m), 0),
    window: contextTokens
  })

  // W2 scope notice (§2.1): stream + seed it first so it leads the answer AND lands in persisted content.
  const seededPrefix = opts.answerPrefix ?? ''
  if (opts.answerPrefix) opts.onToken?.(opts.answerPrefix)
  let modelContent = ''
  // Honest-signal parity with plain chat/grounded (§L0): flag a narration the model cut off at the
  // context ceiling (no max_tokens cap is ever set on this path).
  let finishReason: string | null = null
  const stream = runtime.chatStream(messages, {
    signal: opts.signal,
    onFinish: (reason) => {
      finishReason = reason
    }
  })
  try {
    for await (const token of stream) {
      modelContent += token
      opts.onToken?.(token)
    }
  } catch (err) {
    // A user Stop aborts the stream; persist the partial answer (still cited) and return. Any other error
    // is a real failure and propagates.
    if (!isAbortError(err, opts.signal)) throw err
  }
  // Reasoning + echoed fence framing never reach the DB (parity with generateGroundedAnswer).
  modelContent = stripSkillFenceEcho(stripThinkBlocks(modelContent))
  // A stop before the first model token produced no answer: the scope-notice prefix and the deterministic
  // postscript are NOT an answer on their own (they'd be a totals husk stamped with `extract` coverage), so
  // treat that as empty — mirrors generateGroundedAnswer's prefix-only guard.
  if (modelContent === '') return emptyAssistantMessage(conversationId)

  // Deterministic figure echo (§8.1 caveat): the parsed totals, verbatim, UNDER the model answer — cheap,
  // honest, zero risk. Streamed as a trailing chunk and folded into the persisted content. Empty when the
  // extraction carried no net/tax/gross to echo (then nothing is appended).
  let content = seededPrefix + modelContent
  if (data.postscript) {
    const trailer = `\n\n${data.postscript}`
    content += trailer
    opts.onToken?.(trailer)
  }
  return appendMessage(db, {
    conversationId,
    role: 'assistant',
    content,
    // The handler's real source citations + honest extract coverage pass straight through (source of
    // truth = the deterministic extractor, never the model's prose).
    citations: data.citations,
    coverage: data.coverage,
    skillId: skillFence ? (opts.skill?.installId ?? null) : null,
    autoFired: skillFence ? opts.skill?.autoFired === true : false,
    truncated: finishReason === 'length'
  })
}
