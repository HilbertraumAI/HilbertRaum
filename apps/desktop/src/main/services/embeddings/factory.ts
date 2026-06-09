import { existsSync } from 'node:fs'
import type { Embedder } from './index'
import { createMockEmbedder } from './mock'
import { createE5Embedder } from './e5'
import { resolveLlamaServerPath } from '../runtime/sidecar'

// Availability-aware embedder selector (Phase 10 / graceful-fallback rule), mirroring
// the runtime factory. The real `E5Embedder` (a loopback `llama-server --embedding`
// sidecar) is chosen only when BOTH the platform binary AND the E5 GGUF weights are
// present; otherwise we fall back to `MockEmbedder` so the app launches + tests pass
// with zero model files. The id/dimensions match the manifest, so existing vectors +
// `VectorIndex` are drop-in either way.

/** The embeddings model resolved from its manifest (id + GGUF weight path). */
export interface EmbeddingModelInfo {
  id: string
  /** Absolute path to the E5 GGUF weight file. */
  modelPath: string
  dimensions?: number
  contextTokens?: number
}

export interface EmbedderSelectionDeps {
  /** Drive root used to resolve `runtime/llama.cpp/<os>/llama-server`. */
  rootPath: string
  /** The embeddings model from the manifest, or null when none is configured. */
  model: EmbeddingModelInfo | null
  resolveBin?: (rootPath: string) => string | null
  modelExists?: (modelPath: string) => boolean
  makeE5?: (model: EmbeddingModelInfo, binPath: string) => Embedder
  makeMock?: () => Embedder
  onSelect?: (kind: 'e5' | 'mock', reason: string) => void
}

/**
 * Build the active `Embedder`: a real `E5Embedder` when the sidecar binary + the E5
 * weights are present, else the `MockEmbedder`. Construction is cheap (the E5 sidecar
 * is lazy-started on first `embed()`), so this returns synchronously.
 */
export function createSelectedEmbedder(deps: EmbedderSelectionDeps): Embedder {
  const resolveBin = deps.resolveBin ?? ((root: string) => resolveLlamaServerPath(root))
  const modelExists = deps.modelExists ?? existsSync
  const makeMock = deps.makeMock ?? (() => createMockEmbedder())
  const makeE5 =
    deps.makeE5 ??
    ((model: EmbeddingModelInfo, binPath: string) =>
      createE5Embedder({
        id: model.id,
        binPath,
        modelPath: model.modelPath,
        dimensions: model.dimensions,
        contextTokens: model.contextTokens
      }))

  if (!deps.model) {
    deps.onSelect?.('mock', 'no embeddings model configured')
    return makeMock()
  }
  const binPath = resolveBin(deps.rootPath)
  if (!binPath) {
    deps.onSelect?.('mock', 'no llama-server binary on the drive')
    return makeMock()
  }
  if (!modelExists(deps.model.modelPath)) {
    deps.onSelect?.('mock', 'embedding model weights not present')
    return makeMock()
  }
  deps.onSelect?.('e5', 'binary + weights present')
  return makeE5(deps.model, binPath)
}
