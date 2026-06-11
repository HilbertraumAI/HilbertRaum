import { existsSync } from 'node:fs'
import type { Reranker } from './index'
import { createLlamaReranker } from './llama'
import { resolveLlamaServerPath } from '../runtime/sidecar'

// Availability-aware reranker selector (Phase 21, rag-design §11 reranker / §12.2 D9), mirroring
// the embedder factory — with one deliberate difference: there is NO mock fallback.
// A real `LlamaReranker` is chosen only when BOTH the platform `llama-server` binary
// AND the reranker GGUF are present; otherwise the selector returns NULL and retrieval
// keeps today's ordering byte-identical (graceful-fallback rule — a mock reranker
// would invent an ordering and silently change answers).

/** The reranker model resolved from its manifest (id + GGUF weight path). */
export interface RerankerModelInfo {
  id: string
  /** Absolute path to the reranker GGUF weight file. */
  modelPath: string
  contextTokens?: number
}

export interface RerankerSelectionDeps {
  /** Drive root used to resolve `runtime/llama.cpp/<os>/llama-server`. */
  rootPath: string
  /** The reranker model from the manifest, or null when none is configured. */
  model: RerankerModelInfo | null
  resolveBin?: (rootPath: string) => string | null
  modelExists?: (modelPath: string) => boolean
  makeReranker?: (model: RerankerModelInfo, binPath: string) => Reranker
  onSelect?: (kind: 'llama' | 'none', reason: string) => void
}

/**
 * Build the active `Reranker`, or null when unavailable. Construction is cheap (the
 * sidecar is lazy-started on first `rerank()`), so this returns synchronously.
 */
export function createSelectedReranker(deps: RerankerSelectionDeps): Reranker | null {
  const resolveBin = deps.resolveBin ?? ((root: string) => resolveLlamaServerPath(root))
  const modelExists = deps.modelExists ?? existsSync
  const makeReranker =
    deps.makeReranker ??
    ((model: RerankerModelInfo, binPath: string) =>
      createLlamaReranker({
        id: model.id,
        binPath,
        modelPath: model.modelPath,
        contextTokens: model.contextTokens
      }))

  if (!deps.model) {
    deps.onSelect?.('none', 'no reranker model configured')
    return null
  }
  const binPath = resolveBin(deps.rootPath)
  if (!binPath) {
    deps.onSelect?.('none', 'no llama-server binary on the drive')
    return null
  }
  if (!modelExists(deps.model.modelPath)) {
    deps.onSelect?.('none', 'reranker model weights not present')
    return null
  }
  deps.onSelect?.('llama', 'binary + weights present')
  return makeReranker(deps.model, binPath)
}
