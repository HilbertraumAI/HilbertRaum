import type { Db } from '../db'
import type { AppSettings, Citation, Message } from '../../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../runtime'
import { type Embedder, VectorIndex } from '../embeddings'
import type { Reranker } from '../reranker'
import { keywordSearchChunks, rrfFuse } from './hybrid'
export { detectFilenameScope, type DetectedScope, type ScopeableDoc } from './scope'
import { approxTokenCount } from '../ingestion/chunker'
import { log } from '../logging'
import {
  appendMessage,
  BASE_SYSTEM_PROMPT,
  emptyAssistantMessage,
  isAbortError,
  listMessages,
  stripThinkBlocks
} from '../chat'

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
// This answer is PERSISTED into conversations, so rewording it only affects future
// answers — old rows keep the text they were saved with.
export const NO_DOCUMENT_CONTEXT_ANSWER =
  "I couldn't find this in your documents. Try rephrasing your question, or check which " +
  "documents you're asking about."

/**
 * The actionable variant: documents ARE indexed, but none of their
 * vectors were produced by the active embedding model, so retrieval cannot see them at
 * all (search is scoped to the active embedder's id). Telling the user to rephrase would
 * be wrong — only a re-index fixes it.
 */
export const REINDEX_NEEDED_ANSWER =
  'Your documents need a quick re-index before they can be searched — they were indexed ' +
  'with a different search model. Open the Documents screen and choose Re-index.'

/**
 * True when the corpus is invisible to `embeddingModelId`: at least one indexed document
 * has chunks, but not a single one of those documents has any vector under the active
 * model. Drives the `REINDEX_NEEDED_ANSWER` variant — a per-document partial mismatch
 * still retrieves from the visible documents and stays on the normal path.
 */
export function corpusNeedsReindex(db: Db, embeddingModelId: string): boolean {
  const indexed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)`
    )
    .get() as unknown as { n: number }
  if (indexed.n === 0) return false
  const visible = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (
           SELECT 1 FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
           WHERE c.document_id = d.id AND e.embedding_model_id = ?
         )`
    )
    .get(embeddingModelId) as unknown as { n: number }
  return visible.n === 0
}

interface ChunkRow {
  id: string
  document_id: string
  text: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
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
 * `scopeDocumentIds` (spec §10.4): when non-empty, retrieval only searches
 * those documents — the conversation's "ask selected documents" scope.
 */
export async function retrieve(
  db: Db,
  embedder: Embedder,
  question: string,
  settings: RagRetrievalSettings,
  scopeDocumentIds?: string[] | null,
  reranker?: Reranker | null
): Promise<RetrievalResult> {
  // Mismatch guard: only search vectors tagged with the active embedder's id.
  // Mock and real E5 vectors are both 384-dim, so the dimension guard cannot separate
  // them; scoping by model id stops a corpus indexed under one embedder from polluting
  // search under another (until a reindex re-embeds everything with the active model).
  const index = new VectorIndex(db, embedder, {
    embeddingModelId: embedder.id,
    documentIds: scopeDocumentIds ?? null
  })
  const vectorHits = (await index.searchText(question, settings.topKInitial)).filter(
    (hit) => hit.score >= settings.minSimilarity
  )
  // Hybrid keyword path: the exact terms embeddings miss.
  // Scoped to chunks VISIBLE to the active embedder so the keyword path can
  // never surface a document vector search couldn't — the re-index honesty story
  // (staleEmbeddings / corpusNeedsReindex / REINDEX_NEEDED_ANSWER) is unchanged.
  const keywordHits = keywordSearchChunks(db, question, settings.topKInitial, {
    embeddingModelId: embedder.id,
    documentIds: scopeDocumentIds ?? null
  })
  const fused = rrfFuse(vectorHits, keywordHits)

  const getChunk = db.prepare(
    'SELECT id, document_id, text, source_label, page_number, section_label FROM chunks WHERE id = ?'
  )

  // Join fused candidates → chunk rows, keeping the fused order (best first). A vector
  // candidate keeps its cosine as `score` (pass-through guarantee); a keyword-only
  // candidate carries its RRF score (no cosine exists for it).
  let candidates: Array<Omit<RetrievedChunk, 'label'>> = []
  for (const cand of fused) {
    const row = getChunk.get(cand.chunkId) as unknown as ChunkRow | undefined
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

  // Rerank between fusion and dedup: the cross-encoder rescoring decides which chunk
  // represents a page BEFORE the dedup collapse. A failing reranker logs and keeps
  // the fused order — a quality pass must never turn into an error for the user.
  if (reranker && candidates.length > 0) {
    try {
      const scores = new Map(
        (await reranker.rerank(question, candidates.map((c) => c.text))).map((h) => [
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
    const tokens = approxTokenCount(c.text)
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

function truncateSnippet(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= SNIPPET_MAX_CHARS ? trimmed : trimmed.slice(0, SNIPPET_MAX_CHARS).trimEnd() + '…'
}

/** The `[Sn] File: X | Page: 4` / `| Section: Y` metadata line for a chunk (spec §7.8). */
function sourceMeta(chunk: RetrievedChunk): string {
  if (chunk.pageNumber != null) return ` | Page: ${chunk.pageNumber}`
  if (chunk.sectionLabel) return ` | Section: ${chunk.sectionLabel}`
  return ''
}

/**
 * Build the grounded answer prompt, verbatim to the spec §7.8 template: the rules, the
 * question, then the numbered source excerpts in the spec's source-context format
 * (`[S1] File: X | Page: 4` then the quoted chunk text). Pure + unit-testable.
 */
export function buildGroundedPrompt(question: string, chunks: RetrievedChunk[]): string {
  const excerpts = chunks
    .map((c) => `[${c.label}] File: ${c.sourceTitle}${sourceMeta(c)}\n"${c.text}"`)
    .join('\n\n')
  return `You are answering a question using local documents.

Rules:
- Use only the document excerpts below when the question is about the documents.
- If the excerpts do not contain enough information, say so.
- Do not invent citations.
- Cite sources inline using [S1], [S2], etc.
- Keep the answer concise unless the user asks for detail.

Question:
${question}

Document excerpts:
${excerpts}

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
  groundedUserContent: string
): ChatMessage[] {
  const history = listMessages(db, conversationId)
  const messages: ChatMessage[] = [{ role: 'system', content: BASE_SYSTEM_PROMPT }]
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role !== 'user' && m.role !== 'assistant') continue
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
  return messages
}

export interface GroundedAnswerOptions {
  signal?: AbortSignal
  onToken?: (token: string) => void
  runtimeOptions?: Pick<RuntimeChatOptions, 'maxTokens' | 'temperature'>
  /** "Ask selected documents" scope for retrieval. Null = whole corpus. */
  scopeDocumentIds?: string[] | null
  /** Optional retrieval reranker. Null/absent keeps the fused ordering. */
  reranker?: Reranker | null
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
  const { chunks, citations } = await retrieve(
    db,
    embedder,
    question,
    settings,
    opts.scopeDocumentIds,
    opts.reranker
  )

  if (chunks.length === 0) {
    // Distinguish "nothing relevant" from "the whole corpus is invisible to the active
    // embedder": the latter needs a re-index, not a rephrase. Either way the
    // model is never called without context (grounding rule).
    const answer = corpusNeedsReindex(db, embedder.id)
      ? REINDEX_NEEDED_ANSWER
      : NO_DOCUMENT_CONTEXT_ANSWER
    opts.onToken?.(answer)
    return appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: answer
    })
  }

  const grounded = buildGroundedPrompt(question, chunks)
  const messages = buildGroundedChatMessages(db, conversationId, grounded)
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
  // A stop before the first token produced nothing — persist nothing.
  if (content === '') return emptyAssistantMessage(conversationId)
  // Persist the assistant turn with the computed citations (source of truth = retrieval).
  return appendMessage(db, { conversationId, role: 'assistant', content, citations })
}
