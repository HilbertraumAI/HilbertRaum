// Reranker contract (Phase 21, retrieval-plan §4; the spec §3.3 'reranker' manifest
// role finally in use). A cross-encoder scores (query, document) pairs jointly —
// strictly more signal than the bi-encoder cosine the vector index ranks by — and
// reorders the retrieval candidates between fusion and dedup.
//
// Graceful-fallback rule: there is NO mock reranker. When the binary or the weights
// are absent the factory returns null and retrieval keeps today's ordering
// byte-identical — a mock would invent an ordering and silently change answers.

/** One scored input; `index` points into the `documents` array passed to `rerank`. */
export interface RerankedHit {
  index: number
  /**
   * The model's relevance score — an UNBOUNDED logit (can be negative), NOT a cosine
   * similarity. Never compare it to `ragMinSimilarity` (retrieval-plan §10 D12).
   */
  score: number
}

/** The contract a reranking backend implements (mirrors `Embedder`, spec §9.2 style). */
export interface Reranker {
  /** The reranker model id (manifest id) — diagnostics/logging only, never stored. */
  readonly id: string
  /** Score every document against `query`. Returns EXACTLY one hit per input. */
  rerank(query: string, documents: string[]): Promise<RerankedHit[]>
  /** Release the backing sidecar PERMANENTLY. Called on `will-quit`. */
  stop?(): Promise<void>
  /** Stop the sidecar but allow a lazy restart on next use. Called on workspace lock. */
  suspend?(): Promise<void>
}

export { LlamaReranker, createLlamaReranker } from './llama'
export type { LlamaRerankerOptions } from './llama'
export { createSelectedReranker } from './factory'
export type { RerankerModelInfo, RerankerSelectionDeps } from './factory'
