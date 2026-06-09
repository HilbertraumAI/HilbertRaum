import { createHash } from 'node:crypto'
import type { Embedder } from './index'

// Mock embedder (spec decision: mock-first). Produces deterministic, hash-based
// vectors with ZERO network and ZERO model files, so document search runs fully
// offline. The real on-device embedder (llama.cpp / E5-small) swaps in behind the
// same `Embedder` interface in Phase 10 — callers never change.
//
// How the vectors are built (feature hashing):
//   1. lowercase + split the text into alphanumeric word tokens,
//   2. SHA-256 each token, scatter it across a few signed buckets of a fixed-dim
//      float array (deterministic per token),
//   3. sum across tokens, then L2-normalize.
// Identical text → byte-identical vector; texts sharing tokens get higher cosine
// similarity, which is enough for ranking sanity in the mock phase.

/** Default vector width — matches the E5-small manifest so a real swap is drop-in. */
export const MOCK_EMBEDDING_DIMENSIONS = 384

/** Model-id tag written to `embeddings.embedding_model_id` when no active model is set. */
export const MOCK_EMBEDDING_MODEL_ID = 'mock-embedder'

/** Bytes consumed per bucket: 4 for the dimension index + 1 for the sign. */
const BYTES_PER_BUCKET = 5

/** Lowercase, split on non-alphanumerics. Dependency-free + deterministic. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Build one deterministic, L2-normalized vector for `text`. */
export function embedTextToVector(text: string, dimensions: number): Float32Array {
  const vec = new Float32Array(dimensions)
  for (const token of tokenize(text)) {
    const digest = createHash('sha256').update(token).digest() // 32 bytes
    // Scatter each token across several buckets for a denser vector.
    for (let i = 0; i + BYTES_PER_BUCKET <= digest.length; i += BYTES_PER_BUCKET) {
      const index = digest.readUInt32BE(i) % dimensions
      const sign = (digest[i + 4] & 1) === 0 ? 1 : -1
      vec[index] += sign
    }
  }
  // L2-normalize so cosine similarity == dot product. Empty text → all-zero vector.
  let norm = 0
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) vec[i] /= norm
  }
  return vec
}

export class MockEmbedder implements Embedder {
  readonly id: string
  readonly dimensions: number

  constructor(opts?: { id?: string; dimensions?: number }) {
    this.id = opts?.id ?? MOCK_EMBEDDING_MODEL_ID
    this.dimensions = opts?.dimensions ?? MOCK_EMBEDDING_DIMENSIONS
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => embedTextToVector(t, this.dimensions))
  }
}

/** Factory mirroring `createMockRuntime`; the real embedder swaps in here in Phase 10. */
export function createMockEmbedder(opts?: { id?: string; dimensions?: number }): MockEmbedder {
  return new MockEmbedder(opts)
}
