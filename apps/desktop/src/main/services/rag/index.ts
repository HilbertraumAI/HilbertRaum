import type { Db } from '../db'
import { t } from '../../../shared/i18n'
import type { AppSettings, Citation, CoverageInfo, Message, RetrievalScope } from '../../../shared/types'
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
import { approxTokenCount } from '../ingestion/chunker'
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
  stripThinkBlocks,
  type TurnSkill
} from '../chat'
import { ensureCompacted } from '../chat/compaction'
import {
  approxPromptTokens,
  buildSkillFence,
  skillFenceBudgetTokens,
  stripSkillFenceEcho
} from '../skills/prompt'
import { getSettings } from '../settings'
import { answerWholeDocFromTree } from './whole-doc-tree'

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
  const rows = db
    .prepare(
      'SELECT id, document_id, text, source_label, page_number, section_label, token_count ' +
        'FROM chunks WHERE document_id = ? ORDER BY chunk_index'
    )
    .all(documentId) as unknown as ChunkRow[]
  const chunksTotal = rows.length
  const selected: Array<Omit<RetrievedChunk, 'label'>> = []
  let usedTokens = 0
  for (const row of rows) {
    const tokens = Math.ceil((row.token_count ?? approxTokenCount(row.text)) * TOKENS_PER_WORD)
    // Always include the first chunk (a single over-budget chunk must not yield "no context");
    // after that, stop as soon as the next chunk would overflow the whole-document budget.
    if (selected.length > 0 && usedTokens + tokens > budgetTokens) break
    selected.push({
      chunkId: row.id,
      documentId: row.document_id,
      text: row.text,
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

/** The `[Sn] File: X | Page: 4` / `| Section: Y` metadata line for a chunk (spec §7.8). */
function sourceMeta(chunk: RetrievedChunk): string {
  if (chunk.pageNumber != null) return ` | Page: ${chunk.pageNumber}`
  if (chunk.sectionLabel) return ` | Section: ${chunk.sectionLabel}`
  return ''
}

/** A document's whole size in the SAME token unit as `retrieveWholeDocument` (persisted token_count
 *  scaled by TOKENS_PER_WORD), so the compare budget can be split by real size. */
function documentApproxTokenTotal(db: Db, documentId: string): number {
  // ORDER BY chunk_index for read-shape parity with `retrieveWholeDocument` (audit DATA-4):
  // the sum is order-independent, so this changes no value — it just keeps the budget
  // computation and the actual whole-document read on the same ordered query.
  const rows = db
    .prepare('SELECT text, token_count FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ text: string; token_count: number | null }>
  let total = 0
  for (const r of rows) total += Math.ceil((r.token_count ?? approxTokenCount(r.text)) * TOKENS_PER_WORD)
  return total
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

/** The whole-document read for a 2-document compare (Follow-up B): both documents read IN ORDER,
 *  the budget split by size, with continuous `[Sn]` labels across the two so citations stay unique. */
export interface CompareWholeDocumentsResult {
  /** Per-document groups (in scope order), for the labelled compare prompt. */
  groups: Array<{ documentId: string; title: string; chunks: RetrievedChunk[] }>
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
  const titleOf = (id: string): string => {
    const row = db.prepare('SELECT title FROM documents WHERE id = ?').get(id) as unknown as
      | { title: string | null }
      | undefined
    return row?.title ?? 'Untitled'
  }
  const a = retrieveWholeDocument(db, idA, budgetA)
  const b = retrieveWholeDocument(db, idB, budgetB)
  // Continue [Sn] numbering across the SECOND document so labels are unique + ordered (M2: the
  // citations are the source of truth, so a collision would mislabel which version a source is from).
  const offset = a.chunks.length
  const bChunks: RetrievedChunk[] = b.chunks.map((c, i) => ({ ...c, label: `S${offset + i + 1}` }))
  const bCitations: Citation[] = b.citations.map((c, i) => ({ ...c, label: `S${offset + i + 1}` }))
  return {
    groups: [
      { documentId: idA, title: titleOf(idA), chunks: a.chunks },
      { documentId: idB, title: titleOf(idB), chunks: bChunks }
    ],
    chunks: [...a.chunks, ...bChunks],
    citations: [...a.citations, ...bCitations],
    truncated: a.truncated || b.truncated,
    chunksCovered: a.chunksCovered + b.chunksCovered,
    chunksTotal: a.chunksTotal + b.chunksTotal
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
 * Build the grounded answer USER turn: the question, the optional skill fence, then the
 * numbered source excerpts in the spec §7.8 source-context format (`[S1] File: X | Page: 4`
 * then the quoted chunk text). The stable grounding rules now live in `GROUNDED_SYSTEM_PROMPT`
 * (RT-2), so this carries only the per-turn content. Pure + unit-testable.
 */
export function buildGroundedPrompt(
  question: string,
  chunks: RetrievedChunk[],
  skillFence?: string | null
): string {
  const excerpts = chunks
    .map((c) => `[${c.label}] File: ${c.sourceTitle}${sourceMeta(c)}\n"${c.text}"`)
    .join('\n\n')
  // The skill fence (skills plan §11.2/§22-H2) rides in the USER turn WITH the excerpts — the same
  // untrusted-reference-text class — never in `system`. It sits AFTER the question and BEFORE the
  // excerpts; the fence carries its own guard line. The grounding rules in GROUNDED_SYSTEM_PROMPT
  // ("use only the excerpts", "cite [S1]…", "do not invent citations") always win.
  const skillBlock = skillFence ? `\n${skillFence}\n` : ''
  return `Question:
${question}
${skillBlock}
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
  groups: Array<{ title: string; chunks: RetrievedChunk[] }>,
  skillFence?: string | null
): string {
  const docs = groups
    .map((g, i) => {
      const excerpts = g.chunks
        .map((c) => `[${c.label}] File: ${c.sourceTitle}${sourceMeta(c)}\n"${c.text}"`)
        .join('\n\n')
      return `Document ${i + 1} — "${g.title}":\n${excerpts}`
    })
    .join('\n\n')
  const skillBlock = skillFence ? `\n${skillFence}\n` : ''
  return `Question:
${question}
${skillBlock}
Documents to compare:
${docs}

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
  contextTokens?: number
): ChatMessage[] {
  // RT-2: the grounded system prompt carries the stable grounding rules so cache_prompt
  // reuses them across documents turns (byte-stable prefix).
  const messages: ChatMessage[] = [{ role: 'system', content: GROUNDED_SYSTEM_PROMPT }]
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
   * Skill-aware 2-document WHOLE-DOCUMENT compare (Follow-up B, what-changed). When set, BOTH named
   * documents are read IN ORDER (not top-k), the whole-document budget is SPLIT across them
   * (size-aware: each gets up to half, a smaller doc donates its unused half to the larger), the
   * grounded turn presents them as two labelled documents with the SKILL.md fence, and the persisted
   * coverage is `capped` (truncated when EITHER document overflowed its share). Set ONLY by a
   * `grounded-whole-doc-compare` handler over its two in-scope, fully-chunked documents.
   */
  wholeDocumentCompare?: { documentIds: string[] }
  /**
   * Fired exactly once if the context-compaction pre-pass starts a summarization for this turn.
   * Phase 1 only plumbs the callback; the `STREAM.compaction` UX channel is Phase 2.
   */
  onCompactionStart?: () => void
}

/**
 * Token budget for the whole-document chunk block (skill-whole-doc engine). The real launched
 * context window minus the answer reserve, the grounded system prompt, the question scaffolding,
 * and an allowance for the skill fence (the fence's precise placement/trim is still done downstream
 * in `generateGroundedAnswer`). Never below a small floor so a tiny window still includes something.
 */
function wholeDocumentBudgetTokens(
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
  // When set (Follow-up B), the grounded turn presents the two compared documents as labelled blocks
  // (buildCompareWholeDocPrompt) instead of a single excerpt list.
  let compareGroups: Array<{ title: string; chunks: RetrievedChunk[] }> | null = null
  if (opts.wholeDocument) {
    const budget = wholeDocumentBudgetTokens(contextTokens, question, opts.skill)
    const whole = retrieveWholeDocument(db, opts.wholeDocument.documentId, budget)
    // Over-budget document (Follow-up A): rather than truncate to the beginning, run a skill-fenced
    // map-reduce over its READY deep-index tree (true whole-document coverage, `mode:'tree'`). Returns
    // null when there is no usable tree — then fall through to the honest Wave 2 capped/"beginning"
    // path below, byte-unchanged. A document that FITS the budget never enters here (truncated:false).
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
        onToken: opts.onToken
      })
      if (viaTree) return viaTree
    }
    chunks = whole.chunks
    citations = whole.citations
    coverage = {
      mode: 'capped',
      chunksCovered: whole.chunksCovered,
      chunksTotal: whole.chunksTotal,
      truncated: whole.truncated
    }
  } else if (opts.wholeDocumentCompare) {
    // 2-document whole-doc compare (Follow-up B): read BOTH documents in order with the budget split
    // across them (size-aware), present them as two labelled blocks + the fence, and stamp honest
    // `capped` coverage (truncated when EITHER document overflowed its share).
    const budget = wholeDocumentBudgetTokens(contextTokens, question, opts.skill)
    const comp = retrieveCompareWholeDocuments(db, opts.wholeDocumentCompare.documentIds, budget)
    chunks = comp.chunks
    citations = comp.citations
    compareGroups = comp.groups
    coverage = {
      mode: 'capped',
      chunksCovered: comp.chunksCovered,
      chunksTotal: comp.chunksTotal,
      truncated: comp.truncated
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
  const groundedNoFence = compareGroups
    ? buildCompareWholeDocPrompt(question, compareGroups)
    : buildGroundedPrompt(question, chunks)
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
    skillFence = buildSkillFence({ title: opts.skill.title, body: opts.skill.body }, budget).text
  }
  const grounded = skillFence
    ? compareGroups
      ? buildCompareWholeDocPrompt(question, compareGroups, skillFence)
      : buildGroundedPrompt(question, chunks, skillFence)
    : groundedNoFence
  // Trim older history to the model context window so the grounded turn (which carries the
  // retrieved-chunk block, up to settings.maxContextTokens) plus prior turns never overflow
  // and trigger an HTTP 400 from the runtime.
  const messages = buildGroundedChatMessages(db, conversationId, grounded, contextTokens)
  let content = ''
  // No `mode` is passed: document answers always run 'balanced' — grounded
  // answers should be fast + literal.
  const stream = runtime.chatStream(messages, { signal: opts.signal, ...opts.runtimeOptions })
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
  // A stop before the first token produced nothing — persist nothing.
  if (content === '') return emptyAssistantMessage(conversationId)
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
    autoFired: skillFence ? opts.skill?.autoFired === true : false
  })
}
