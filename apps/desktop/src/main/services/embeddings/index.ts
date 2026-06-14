import type { Db } from '../db'
import { buildScopeFilter } from '../retrieval-scope'

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

/** Encode a vector to the raw Float32 bytes stored in `embeddings.vector_blob`. */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/**
 * Decode a stored BLOB back into a `Float32Array` of `dimensions` floats.
 * SQLite blobs can land on an unaligned byte offset, so we copy into a fresh,
 * 4-byte-aligned buffer before viewing it as Float32 (avoids a RangeError).
 */
export function decodeVector(blob: Uint8Array, dimensions: number): Float32Array {
  const bytes = Uint8Array.prototype.slice.call(blob, 0, dimensions * 4) // copy → offset 0, aligned
  return new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)
}

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

interface EmbeddingRow {
  chunk_id: string
  vector_blob: Uint8Array
  dimensions: number
}

/**
 * Cosine vector search over the `embeddings` table.
 *
 * MVP = linear scan over all stored chunk vectors (the 1000-chunk-per-file cap
 * bounds the work). Upgrade path: an ANN index (sqlite-vec / HNSW) behind this
 * same `search` signature when corpora grow.
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
    const sql =
      'SELECT chunk_id, vector_blob, dimensions FROM embeddings' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
    const rows = this.db.prepare(sql).all(...params) as unknown as EmbeddingRow[]
    const hits: VectorSearchHit[] = []
    for (const row of rows) {
      // Skip vectors from a different model/dimensionality (e.g. mid-migration).
      if (row.dimensions !== queryVector.length) continue
      // Skip a physically truncated blob rather than letting decodeVector throw a
      // RangeError and abort the whole query — one corrupt row must not break all search.
      if (row.vector_blob.length < row.dimensions * 4) continue
      const vec = decodeVector(row.vector_blob, row.dimensions)
      hits.push({ chunkId: row.chunk_id, score: cosineSimilarity(queryVector, vec) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /** Embed `query` with the same embedder, then run the cosine search. */
  async searchText(query: string, topK: number, signal?: AbortSignal): Promise<VectorSearchHit[]> {
    const [queryVector] = await this.embedder.embed([query], { signal })
    return this.search(queryVector, topK)
  }
}

export { MockEmbedder, createMockEmbedder, MOCK_EMBEDDING_DIMENSIONS, MOCK_EMBEDDING_MODEL_ID } from './mock'
export { E5Embedder, createE5Embedder } from './e5'
export type { E5EmbedderOptions } from './e5'
