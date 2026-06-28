import { truncateToApproxTokens } from '../ingestion/chunker'

// Shared input-budget helper for the llama-server sidecars that accept free text — the E5
// embedder (`embeddings/e5.ts`) and the reranker (`reranker/llama.ts`).
//
// MAINT-2 / EMB-1 (backend audit 2026-06-27): the two subsystems used to size their inputs
// DIFFERENTLY — the embedder via the CJK/Thai-aware `truncateToApproxTokens`, the reranker via
// a naive whitespace word split. A space-less passage (CJK/Thai) is a SINGLE whitespace "word",
// so the reranker never truncated it: it overflowed `n_ctx`, llama-server replied HTTP 500, and
// `rag/index.ts` caught it and silently kept the fused order — the reranker became a no-op on
// those scripts. Both sidecars now route through THIS module so their context-fit math can't
// diverge again.

/**
 * Real BPE tokens charged per `approxTokenCount` token — the WORST-CASE multilingual factor.
 *
 * `approxTokenCount` charges an ordinary whitespace word ~1 token, but multilingual subword
 * tokenizers run heavier: a German machine translation (the case that first surfaced the
 * embedder's HTTP 500) is subword-dense at ~2 real tokens/word, while space-less CJK/Thai
 * already counts ~1 token/CHAR in `approxTokenCount` (≈ the real BPE rate). 2.2 keeps even
 * worst-case German (and a fortiori English / space-less text) comfortably under the context
 * with headroom for BOS/EOS + estimate slop. Both sidecars use this ONE factor so a future
 * tweak can't desync them.
 */
export const REAL_TOKENS_PER_APPROX_TOKEN = 2.2

/**
 * The most `approxTokenCount` tokens of input that safely fit a sidecar's real-token context,
 * after the worst-case safety factor. `minTokens` keeps a tiny configured context from
 * collapsing the budget to zero (and from truncating to nothing).
 */
export function maxInputApproxTokens(contextTokens: number, minTokens = 16): number {
  return Math.max(minTokens, Math.floor(contextTokens / REAL_TOKENS_PER_APPROX_TOKEN))
}

/**
 * Truncate `text` to the leading prefix that fits `contextTokens`, CJK/Thai-aware via
 * `truncateToApproxTokens` (so a space-less passage can't slip past a word count and overflow
 * the sidecar → HTTP 500). The vector/score covers the head of an over-long input — acceptable,
 * and strictly better than a wedged or 500'd request.
 */
export function truncateToContext(text: string, contextTokens: number, minTokens = 16): string {
  return truncateToApproxTokens(text, maxInputApproxTokens(contextTokens, minTokens))
}
