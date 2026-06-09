import type { Db } from '../db'

// Embeddings + vector search (spec §6, §7.8, §9.2). The `Embedder` interface keeps
// the mock embedder (Phase 5) and the real on-device embedder (Phase 10)
// interchangeable behind one contract, exactly like `ModelRuntime`. `VectorIndex`
// runs a cosine search over the vectors stored in the `embeddings` table.
//
// Vector encoding (LOCKED — Phase 5): a vector is a `Float32Array`; it is stored in
// `embeddings.vector_blob` as the raw little-endian Float32 bytes and decoded back
// into a `Float32Array` on read. See `encodeVector` / `decodeVector`.
//
// Everything is local + offline: the embedder never touches the network, and the
// search is an in-process linear scan over SQLite rows (no remote vector service).

/** The contract every embedding backend implements (spec §9.2). */
export interface Embedder {
  /** The embedding-model id tag (written to `embeddings.embedding_model_id`). */
  readonly id: string
  /** Fixed output width of every vector this embedder produces. */
  readonly dimensions: number
  /** Embed a batch of texts into L2-normalized vectors (one per input, in order). */
  embed(texts: string[]): Promise<Float32Array[]>
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

/** Cosine similarity of two equal-length vectors. Returns 0 if either is all-zero. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
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
export class VectorIndex {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder
  ) {}

  /** Rank stored chunks by cosine similarity to `queryVector`; return the top `topK`. */
  search(queryVector: Float32Array, topK: number): VectorSearchHit[] {
    if (topK <= 0) return []
    const rows = this.db
      .prepare('SELECT chunk_id, vector_blob, dimensions FROM embeddings')
      .all() as unknown as EmbeddingRow[]
    const hits: VectorSearchHit[] = []
    for (const row of rows) {
      // Skip vectors from a different model/dimensionality (e.g. mid-migration).
      if (row.dimensions !== queryVector.length) continue
      const vec = decodeVector(row.vector_blob, row.dimensions)
      hits.push({ chunkId: row.chunk_id, score: cosineSimilarity(queryVector, vec) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /** Embed `query` with the same embedder, then run the cosine search. */
  async searchText(query: string, topK: number): Promise<VectorSearchHit[]> {
    const [queryVector] = await this.embedder.embed([query])
    return this.search(queryVector, topK)
  }
}

export { MockEmbedder, createMockEmbedder, MOCK_EMBEDDING_DIMENSIONS, MOCK_EMBEDDING_MODEL_ID } from './mock'
