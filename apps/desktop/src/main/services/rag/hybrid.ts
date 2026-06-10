import type { Db } from '../db'

// Hybrid keyword retrieval + rank fusion (Phase 21, retrieval-plan §5).
//
// The FTS5 index (`chunks_fts`, created + trigger-synced in `db.ts`) catches the exact
// terms embeddings miss — invoice numbers, names, codes — and reciprocal-rank fusion
// merges the keyword ranking with the cosine ranking WITHOUT mixing their incomparable
// score scales (BM25 vs cosine): only ranks enter the fused score.
//
// Embedder-visibility rule (retrieval-plan §5.4): `chunks.text` is embedder-agnostic,
// so a raw keyword path would surface documents the active embedder cannot see and
// silently break the Phase-17 re-index honesty story. Keyword hits are therefore
// restricted to chunks that HAVE a vector under the active embedding model — hybrid
// search never sees more than vector search could, and `REINDEX_NEEDED_ANSWER` keeps
// its exact trigger semantics.

/** Standard RRF constant (Cormack et al.); rank-based, so scale-free. */
export const RRF_K = 60

/** Most question tokens forwarded into the FTS MATCH query (bounds query cost). */
const MAX_QUERY_TOKENS = 32

export interface KeywordSearchOptions {
  /** Restrict hits to chunks with a vector under this embedding model (required — the visibility rule). */
  embeddingModelId: string
  /** "Ask selected documents" scope; null/empty = whole corpus (composes like the vector path). */
  documentIds?: string[] | null
}

export interface KeywordHit {
  chunkId: string
  /** BM25 rank score as reported by FTS5 (lower = better; informational only — fusion uses rank). */
  bm25: number
}

/**
 * Sanitize a natural-language question into an FTS5 MATCH query: extract word tokens,
 * quote each as a phrase, OR them together. FTS5 operator syntax in user text
 * (`"` `-` `NEAR` `*` parentheses) can never reach MATCH raw. Returns null when the
 * question yields no tokens (→ keyword search is skipped).
 */
export function buildFtsMatchQuery(question: string): string | null {
  const tokens = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return null
  return tokens
    .slice(0, MAX_QUERY_TOKENS)
    .map((t) => `"${t}"`)
    .join(' OR ')
}

/**
 * BM25-ranked keyword search over `chunks_fts`, restricted to chunks visible to the
 * active embedder (vector present under `embeddingModelId`) and, when set, to the
 * `documentIds` scope. Placeholders only — nothing is interpolated into the SQL.
 */
export function keywordSearchChunks(
  db: Db,
  question: string,
  topK: number,
  options: KeywordSearchOptions
): KeywordHit[] {
  if (topK <= 0) return []
  const match = buildFtsMatchQuery(question)
  if (!match) return []

  const params: (string | number)[] = [options.embeddingModelId]
  let docFilter = ''
  const docs = options.documentIds
  if (docs && docs.length > 0) {
    docFilter = ` AND c.document_id IN (${docs.map(() => '?').join(', ')})`
    params.push(...docs)
  }
  const sql =
    `SELECT chunks_fts.chunk_id AS chunkId, bm25(chunks_fts) AS bm25
     FROM chunks_fts
     JOIN chunks c ON c.id = chunks_fts.chunk_id
     JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?` +
    docFilter +
    ` WHERE chunks_fts MATCH ?
     ORDER BY bm25(chunks_fts)
     LIMIT ?`
  params.push(match, topK)
  return db.prepare(sql).all(...params) as unknown as KeywordHit[]
}

export interface FusedCandidate {
  chunkId: string
  /** RRF score (Σ 1/(RRF_K + rank) over the lists the chunk appeared in). */
  rrfScore: number
  /** Cosine score when the chunk came through the vector path; null for keyword-only hits. */
  cosine: number | null
}

/**
 * Reciprocal-rank fusion of the vector and keyword ranked lists (retrieval-plan §5.3).
 * Both inputs must already be ordered best-first. Deterministic: ties break by vector
 * rank (vector-listed chunks first), then chunk id. With an empty keyword list this is
 * monotone in vector rank — i.e. exactly today's ordering (the pass-through guarantee).
 */
export function rrfFuse(
  vectorRanked: Array<{ chunkId: string; score: number }>,
  keywordRanked: KeywordHit[]
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate & { vectorRank: number }>()
  vectorRanked.forEach((hit, i) => {
    byId.set(hit.chunkId, {
      chunkId: hit.chunkId,
      rrfScore: 1 / (RRF_K + i + 1),
      cosine: hit.score,
      vectorRank: i + 1
    })
  })
  keywordRanked.forEach((hit, i) => {
    const existing = byId.get(hit.chunkId)
    const contribution = 1 / (RRF_K + i + 1)
    if (existing) {
      existing.rrfScore += contribution
    } else {
      byId.set(hit.chunkId, {
        chunkId: hit.chunkId,
        rrfScore: contribution,
        cosine: null,
        vectorRank: Number.MAX_SAFE_INTEGER
      })
    }
  })
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        a.vectorRank - b.vectorRank ||
        (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)
    )
    .map(({ chunkId, rrfScore, cosine }) => ({ chunkId, rrfScore, cosine }))
}
