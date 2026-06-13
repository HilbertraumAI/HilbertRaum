import type { Db } from '../db'
import { buildFtsMatchQuery } from '../fts'

// Hybrid keyword retrieval + rank fusion (rag-design §11).
//
// The FTS5 index (`chunks_fts`, created + trigger-synced in `db.ts`) catches the exact
// terms embeddings miss — invoice numbers, names, codes — and reciprocal-rank fusion
// merges the keyword ranking with the cosine ranking WITHOUT mixing their incomparable
// score scales (BM25 vs cosine): only ranks enter the fused score.
//
// Embedder-visibility rule: `chunks.text` is embedder-agnostic,
// so a raw keyword path would surface documents the active embedder cannot see and
// silently break the re-index honesty story. Keyword hits are therefore
// restricted to chunks that HAVE a vector under the active embedding model — hybrid
// search never sees more than vector search could, and `REINDEX_NEEDED_ANSWER` keeps
// its exact trigger semantics.

/** Standard RRF constant (Cormack et al.); rank-based, so scale-free. */
export const RRF_K = 60

// The MATCH sanitizer lives in services/fts.ts (conversation search reuses it);
// re-exported here so existing call/import sites are unchanged.
export { buildFtsMatchQuery }

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
 * Reciprocal-rank fusion of the vector and keyword ranked lists.
 * Both inputs must already be ordered best-first. Deterministic: ties break by the
 * chunk's BEST individual rank across both lists (M-C4), then chunk id. Tiebreaking on
 * `min(vectorRank, keywordRank)` rather than vector rank alone keeps a #1 keyword-only
 * hit (exact invoice numbers / codes — the precise case hybrid search exists to catch)
 * from always losing an RRF-score tie to a #1 vector hit. With an empty keyword list
 * every chunk's best rank IS its vector rank, so this is exactly today's ordering (the
 * pass-through guarantee).
 */
export function rrfFuse(
  vectorRanked: Array<{ chunkId: string; score: number }>,
  keywordRanked: KeywordHit[]
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate & { bestRank: number }>()
  vectorRanked.forEach((hit, i) => {
    byId.set(hit.chunkId, {
      chunkId: hit.chunkId,
      rrfScore: 1 / (RRF_K + i + 1),
      cosine: hit.score,
      bestRank: i + 1
    })
  })
  keywordRanked.forEach((hit, i) => {
    const keywordRank = i + 1
    const existing = byId.get(hit.chunkId)
    const contribution = 1 / (RRF_K + keywordRank)
    if (existing) {
      existing.rrfScore += contribution
      // A chunk in both lists tiebreaks on whichever list ranked it higher.
      existing.bestRank = Math.min(existing.bestRank, keywordRank)
    } else {
      byId.set(hit.chunkId, {
        chunkId: hit.chunkId,
        rrfScore: contribution,
        cosine: null,
        bestRank: keywordRank
      })
    }
  })
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        a.bestRank - b.bestRank ||
        (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)
    )
    .map(({ chunkId, rrfScore, cosine }) => ({ chunkId, rrfScore, cosine }))
}
