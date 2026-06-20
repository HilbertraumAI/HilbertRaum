import type { Db } from '../db'
import { buildScopeFilter } from '../retrieval-scope'
import { getResidentVectors } from './resident-cache'

// Embeddings + vector search (spec §6, §7.8, §9.2). The `Embedder` interface keeps
// the mock embedder and the real on-device embedder interchangeable behind one
// contract, exactly like `ModelRuntime`. `VectorIndex` runs a cosine search over
// the vectors stored in the `embeddings` table.
//
// Vector encoding (LOCKED): a vector is a `Float32Array`; it is stored in
// `embeddings.vector_blob` as the raw little-endian Float32 bytes and decoded back
// into a `Float32Array` on read. See `encodeVector` / `decodeVector`.
//
// Everything is local + offline: the embedder never touches the network, and the
// search is an in-process linear scan over SQLite rows (no remote vector service).

/** Per-call embed options. `signal` lets a caller "Stop" cancel an in-flight request. */
export interface EmbedOptions {
  /**
   * Caller abort signal. Combined with the per-request timeout so a user "Stop" during
   * query embedding cancels the loopback request promptly (M-C5), not only on timeout.
   */
  signal?: AbortSignal
}

/** The contract every embedding backend implements (spec §9.2). */
export interface Embedder {
  /** The embedding-model id tag (written to `embeddings.embedding_model_id`). */
  readonly id: string
  /** Fixed output width of every vector this embedder produces. */
  readonly dimensions: number
  /** Embed a batch of texts into L2-normalized vectors (one per input, in order). */
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>
  /**
   * Release any backing resources (e.g. the real embedder's loopback sidecar). Optional
   * — the mock embedder holds nothing. Called on `will-quit`; PERMANENT (a racing lazy
   * start must not resurrect the sidecar as an orphan after quit).
   */
  stop?(): Promise<void>
  /**
   * Stop the backing sidecar but allow a lazy restart on next use.
   * Called on workspace LOCK: the sidecar's memory (recent chunk text) must be purged,
   * but the app keeps running and the next import must work — the permanent `stop()`
   * latch would make every post-lock/unlock embed fail.
   */
  suspend?(): Promise<void>
}

export interface VectorSearchHit {
  chunkId: string
  /** Cosine similarity in [-1, 1]; higher is more similar. */
  score: number
}

// The vector ↔ BLOB codec lives in `./codec` (kept out of this barrel so `resident-cache.ts`
// can decode without an import cycle) and is re-exported here for existing barrel callers.
export { encodeVector, decodeVector } from './codec'

/**
 * Cosine similarity of two equal-length vectors. Returns 0 if either is all-zero.
 *
 * Throws on a length mismatch rather than silently scoring on `min(length)` (L2):
 * the exported contract is "equal-length", and the only in-tree caller already
 * dimension-guards before calling — so a mismatch here means a real bug (a future
 * caller mixing dimensions), not data to score on a prefix.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity length mismatch: ${a.length} vs ${b.length}`)
  }
  const n = a.length
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Raw dot product of two equal-length vectors (RAG-1 fast path).
 *
 * INVARIANT this rests on: every vector that reaches `VectorIndex.search` is already
 * **L2-normalized** — the embedder normalizes its output (`e5.ts` `l2normalize`; the
 * mock embedder too) and the query vector comes from that same `embed()` path. For unit
 * vectors `‖a‖=‖b‖=1`, so `cosine = dot/(‖a‖·‖b‖) = dot` exactly (to floating-point
 * tolerance) — computing the two norm accumulators per row is wasted work (~2× the FLOPs).
 * Ranking is therefore identical to `cosineSimilarity` on normalized inputs.
 *
 * Do NOT use this on un-normalized vectors (it would not be a cosine). Returns 0 only when
 * the dot is genuinely 0 (e.g. an all-zero empty-text vector), matching cosine's behaviour
 * for that degenerate case.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`dotProduct length mismatch: ${a.length} vs ${b.length}`)
  }
  const n = a.length
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

/** A scope-filtered candidate row — only the id; the vector comes from the resident cache. */
interface ChunkIdRow {
  chunk_id: string
}

/**
 * Cosine vector search over the `embeddings` table.
 *
 * MVP = linear scan over all stored chunk vectors (the 1000-chunk-per-file cap
 * bounds the work). The vectors are kept **decoded and process-resident** (RAG-6, Wave P4;
 * see `resident-cache.ts`) so a query reads no BLOBs and re-decodes nothing — the scan is a
 * flat dot product over the cached `Float32Array`s. Upgrade path (still deferred behind this
 * same `search` signature, D15): an off-main-thread worker scan (P4b) and/or an ANN index
 * (P4c — sqlite-vec/HNSW) when corpora outgrow the linear scan.
 */
export interface VectorIndexOptions {
  /**
   * When set, the search only scans vectors tagged with this `embedding_model_id`.
   * Mismatch guard: mock vectors (`mock-embedder`) and real E5 vectors are
   * BOTH 384-dim, so the dimension guard alone cannot separate them — mixing them
   * silently corrupts ranking. Filtering by the active model id keeps a corpus indexed
   * under one embedder from polluting search under another (e.g. after a mock→real
   * switch, until a reindex re-embeds everything).
   */
  embeddingModelId?: string | null
  /**
   * When set and non-empty, the search only scans vectors whose chunk belongs to one of
   * these documents — "ask selected documents" (spec §10.4) / specific-doc selection.
   * Empty/absent means no document-id filter, so existing callers are unchanged.
   */
  documentIds?: string[] | null
  /**
   * Collection-membership filter (document-organization plan §10.2): scopes to chunks whose
   * document is a member of one of these collections, UNIONED with `documentIds`. Empty/absent
   * means no membership filter.
   */
  collectionIds?: string[] | null
  /**
   * Include `lifecycle='archived'` documents. Default false — archived documents are
   * globally excluded from default retrieval (plan C1).
   */
  includeArchived?: boolean
}

export class VectorIndex {
  private readonly embeddingModelId: string | null
  private readonly documentIds: string[] | null
  private readonly collectionIds: string[] | null
  private readonly includeArchived: boolean

  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
    options?: VectorIndexOptions
  ) {
    const id = options?.embeddingModelId
    this.embeddingModelId = id && id.length > 0 ? id : null
    const docs = options?.documentIds
    this.documentIds = docs && docs.length > 0 ? docs : null
    const colls = options?.collectionIds
    this.collectionIds = colls && colls.length > 0 ? colls : null
    this.includeArchived = options?.includeArchived ?? false
  }

  /** Rank stored chunks by cosine similarity to `queryVector`; return the top `topK`. */
  search(queryVector: Float32Array, topK: number): VectorSearchHit[] {
    if (topK <= 0) return []
    // Compose the scan filters: model-id scoping and/or collection/document scoping
    // (+ archived exclusion). Placeholders only — ids are never interpolated into the SQL.
    const where: string[] = []
    const params: (string | number)[] = []
    if (this.embeddingModelId) {
      where.push('embedding_model_id = ?')
      params.push(this.embeddingModelId)
    }
    // `embeddings` has only `chunk_id`, so the chunk→document hop + every scope predicate
    // live inside one `chunk_id IN (SELECT …)` subquery (the existing pattern).
    const scopeFilter = buildScopeFilter(
      {
        documentIds: this.documentIds,
        collectionIds: this.collectionIds,
        includeArchived: this.includeArchived
      },
      'c.document_id'
    )
    if (scopeFilter) {
      where.push(`chunk_id IN (SELECT c.id FROM chunks c WHERE ${scopeFilter.sql})`)
      params.push(...scopeFilter.params)
    }
    // RAG-6 (Wave P4): project ONLY `chunk_id` — the scope-filtered candidate set — and pull
    // each vector from the process-resident decoded-vector cache (`resident-cache.ts`). This
    // keeps the WHERE composition (model id + scope/archived) byte-identical to the old scan,
    // so every scope filter behaves exactly as before, while reading NO `vector_blob` from
    // SQLite (the ~150 MB-per-query read is gone) and re-decoding nothing (the cache holds the
    // already-decoded `Float32Array`s — RAG-6's per-query allocation churn is gone too).
    const sql =
      'SELECT chunk_id FROM embeddings' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
    const rows = this.db.prepare(sql).all(...params) as unknown as ChunkIdRow[]
    const resident = getResidentVectors(this.db)
    const hits: VectorSearchHit[] = []
    for (const row of rows) {
      const vec = resident.get(row.chunk_id)
      // Absent ⇒ the row was a physically truncated blob skipped at cache-build time (the old
      // per-row truncated-blob guard, now enforced once). Skip it rather than crash the query.
      if (vec === undefined) continue
      // Skip vectors of a different dimensionality (e.g. mid-migration) — the old dimension
      // guard, unchanged: mock and E5 vectors are both 384-dim but a stray model could differ.
      if (vec.length !== queryVector.length) continue
      // RAG-1 fast path: stored vectors and the query vector are both L2-normalized
      // (`e5.ts` `l2normalize`, mock embedder too), so cosine == raw dot product — skip
      // the two norm accumulators per row for ~2× fewer FLOPs. Ranking is identical.
      hits.push({ chunkId: row.chunk_id, score: dotProduct(queryVector, vec) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /** Embed `query` with the same embedder, then run the cosine search. */
  async searchText(query: string, topK: number, signal?: AbortSignal): Promise<VectorSearchHit[]> {
    return this.search(await this.embedQueryCached(query, signal), topK)
  }

  /**
   * Embed a query vector, served from a small per-embedder LRU (RAG-5, perf audit 2026-06-18).
   * Re-asking the same question, a "try again", and the re-index honesty re-check all embed the
   * SAME text — and the query-embed round-trip DOMINATES the scan at realistic corpora (Wave P4
   * measurement). The cache is keyed by the EXACT query string (no lossy normalization, so a hit
   * returns precisely the vector the embedder would have produced — byte-identical results) and
   * lives in a `WeakMap` by embedder INSTANCE, so swapping the embedder (model change) starts from
   * an empty cache automatically ("cleared on embedder change"). Bounded to QUERY_VECTOR_CACHE_MAX
   * entries (LRU by Map insertion order). A cache hit needs no round-trip, so `signal` is moot.
   */
  private async embedQueryCached(query: string, signal?: AbortSignal): Promise<Float32Array> {
    let cache = queryVectorCache.get(this.embedder)
    if (!cache) {
      cache = new Map<string, Float32Array>()
      queryVectorCache.set(this.embedder, cache)
    }
    const hit = cache.get(query)
    if (hit) {
      // LRU bump: re-insert so this entry is the most-recently used (evicted last).
      cache.delete(query)
      cache.set(query, hit)
      return hit
    }
    const [queryVector] = await this.embedder.embed([query], { signal })
    cache.set(query, queryVector)
    if (cache.size > QUERY_VECTOR_CACHE_MAX) {
      // Evict the least-recently used (the first key in insertion order).
      cache.delete(cache.keys().next().value as string)
    }
    return queryVector
  }
}

/** Max cached query→vector entries per embedder (RAG-5). Small: queries repeat in bursts. */
const QUERY_VECTOR_CACHE_MAX = 32
/** Per-embedder query-vector LRU. WeakMap by embedder instance ⇒ an embedder swap starts fresh. */
const queryVectorCache = new WeakMap<Embedder, Map<string, Float32Array>>()

export {
  getResidentVectors,
  invalidateResidentVectors,
  purgeResidentVectors
} from './resident-cache'
export { MockEmbedder, createMockEmbedder, MOCK_EMBEDDING_DIMENSIONS, MOCK_EMBEDDING_MODEL_ID } from './mock'
export { E5Embedder, createE5Embedder } from './e5'
export type { E5EmbedderOptions } from './e5'
