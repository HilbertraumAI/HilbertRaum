import { existsSync } from 'node:fs'

// L16 (audit-2026-06-13): the embeddings / reranker / transcriber factories all ran the
// SAME availability ladder — "no model configured → no binary on the drive → weights not
// present → build the real sidecar-backed service" — copy-pasted ~40 lines apiece. The only
// real divergence is the unavailable result: the embedder degrades to a MockEmbedder, while
// the reranker/transcriber return `null` (a mock would invent an ordering / a transcript and
// silently corrupt answers — graceful-fallback rule). This helper centralizes the ladder; a
// caller supplies the model, the binary/weight resolvers, the "make real" builder, and the
// `unavailable` value to return when any rung fails.

/** The minimum a sidecar-backed model needs to be located on the drive. */
export interface SidecarModel {
  id: string
  /** Absolute path to the GGUF/GGML weight file. */
  modelPath: string
}

export interface SelectSidecarBackedDeps<TModel extends SidecarModel, TService> {
  /** Drive root used to resolve the platform binary. */
  rootPath: string
  /** The model resolved from its manifest, or null when none is configured. */
  model: TModel | null
  /** Resolve `runtime/.../<binary>` for the drive, or null when absent. */
  resolveBin: (rootPath: string) => string | null
  /** Existence check for the weight file (overridable in tests). */
  modelExists?: (modelPath: string) => boolean
  /** Build the real sidecar-backed service from a present model + binary. */
  makeReal: (model: TModel, binPath: string) => TService
  /** Human label for the binary in the "no binary" reason (e.g. 'llama-server'). */
  binaryName: string
  /** Noun for the weights in the reasons (e.g. 'embedding model', 'reranker model'). */
  modelNoun: string
}

/** The outcome of the availability ladder, before mapping to the caller's service type. */
export type SidecarSelection<TModel extends SidecarModel> =
  | { available: false; reason: string }
  | { available: true; reason: string; model: TModel; binPath: string }

/**
 * Run the shared model→binary→weights availability ladder. Returns a discriminated result
 * so each caller decides what `available:false` means (mock vs null) and emits its own
 * `onSelect`. Pure aside from `modelExists` (defaults to `fs.existsSync`).
 */
export function resolveSidecarSelection<TModel extends SidecarModel, TService>(
  deps: SelectSidecarBackedDeps<TModel, TService>
): SidecarSelection<TModel> {
  const modelExists = deps.modelExists ?? existsSync

  if (!deps.model) {
    return { available: false, reason: `no ${deps.modelNoun} configured` }
  }
  const binPath = deps.resolveBin(deps.rootPath)
  if (!binPath) {
    return { available: false, reason: `no ${deps.binaryName} binary on the drive` }
  }
  if (!modelExists(deps.model.modelPath)) {
    return { available: false, reason: `${deps.modelNoun} weights not present` }
  }
  return { available: true, reason: 'binary + weights present', model: deps.model, binPath }
}
