import type { Reranker } from './index'
import { createLlamaReranker } from './llama'
import { resolveLlamaServerPath } from '../runtime/sidecar'
import { resolveSidecarSelection } from '../select-sidecar-backed'

// Availability-aware reranker selector (rag-design §11), mirroring
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
  const makeReranker =
    deps.makeReranker ??
    ((model: RerankerModelInfo, binPath: string) =>
      createLlamaReranker({
        id: model.id,
        binPath,
        modelPath: model.modelPath,
        contextTokens: model.contextTokens
      }))

  // Shared model→binary→weights ladder (L16). NO mock fallback — a mock reranker would
  // invent an ordering and silently change answers, so unavailable means null.
  const sel = resolveSidecarSelection<RerankerModelInfo, Reranker>({
    rootPath: deps.rootPath,
    model: deps.model,
    resolveBin: deps.resolveBin ?? ((root) => resolveLlamaServerPath(root)),
    modelExists: deps.modelExists,
    makeReal: makeReranker,
    binaryName: 'llama-server',
    modelNoun: 'reranker model'
  })
  if (!sel.available) {
    deps.onSelect?.('none', sel.reason)
    return null
  }
  deps.onSelect?.('llama', sel.reason)
  return makeReranker(sel.model, sel.binPath)
}
