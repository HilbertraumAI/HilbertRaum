import type { Translator } from './index'
import { TranslationRuntime, type TranslationGpuDeps, type TranslationStartInfo } from './runtime'
import { resolveLlamaServerPath } from '../runtime/sidecar'
import { resolveSidecarSelection } from '../select-sidecar-backed'

// Availability-aware translation selector (TG wave, plan §2 D1), mirroring the reranker factory —
// with NO mock fallback. A real `TranslationRuntime` is chosen only when BOTH the platform
// `llama-server` binary AND the TranslateGemma GGUF are present; otherwise the selector returns
// NULL and translation refuses with a friendly "install the translation model" path (TG-3, plan
// O2/D3 — a mock translator would invent a translation and silently corrupt output).
//
// Availability-driven activation (plan §2 D1): NO settings slot, no picker recommendation. The
// caller resolves the role's default model via `resolveModelByRole('translation')`; the sidecar
// activates by PRESENCE once the weight is installed + verified.

/** The translation model resolved from its manifest (id + GGUF weight path + launch context). */
export interface TranslationModelInfo {
  id: string
  /** Absolute path to the TranslateGemma GGUF weight file. */
  modelPath: string
  /** The manifest's `recommendedContextTokens` (4096 — plan §2 D4); the sidecar's `--ctx-size`. */
  contextTokens?: number
}

export interface TranslatorSelectionDeps {
  /** Drive root used to resolve `runtime/llama.cpp/<os>/llama-server`. */
  rootPath: string
  /** The translation model from the manifest, or null when none is configured. */
  model: TranslationModelInfo | null
  /** Dev build — gates the dev-only `HILBERTRAUM_LLAMA_BIN` override (M-5). Default false. */
  isDev?: boolean
  resolveBin?: (rootPath: string) => string | null
  modelExists?: (modelPath: string) => boolean
  makeTranslator?: (model: TranslationModelInfo, binPath: string) => Translator
  onSelect?: (kind: 'llama' | 'none', reason: string) => void
  /**
   * GPU signals for the sidecar's device ladder (issue #42) — the SAME Settings read-callbacks the
   * chat ladder gets (`gpuMode` + `gpuAutoDisabled`). Omitted → 'auto' / not disabled.
   */
  gpu?: TranslationGpuDeps
  /** Session CPU-fallback observability hook (issue #42) — the caller logs it. Must never throw. */
  onDeviceFallback?: (reason: string) => void
  /**
   * Per-cold-start outcome hook (issue #42 reopen) — the caller logs posture + offload split
   * symmetrically with the chat ladder's start line. Must never throw.
   */
  onStarted?: (info: TranslationStartInfo) => void
}

/**
 * Build the active `Translator`, or null when unavailable. Construction is cheap (the sidecar is
 * lazy-started on the first `translate()`), so this returns synchronously.
 */
export function createSelectedTranslator(deps: TranslatorSelectionDeps): Translator | null {
  const makeTranslator =
    deps.makeTranslator ??
    ((model: TranslationModelInfo, binPath: string) =>
      new TranslationRuntime({
        modelId: model.id,
        binPath,
        modelPath: model.modelPath,
        contextTokens: model.contextTokens,
        gpu: deps.gpu,
        onDeviceFallback: deps.onDeviceFallback,
        onStarted: deps.onStarted
      }))

  // Shared model→binary→weights ladder (L16). NO mock fallback — unavailable means null (plan O2).
  const sel = resolveSidecarSelection<TranslationModelInfo, Translator>({
    rootPath: deps.rootPath,
    model: deps.model,
    resolveBin:
      deps.resolveBin ??
      ((root) => resolveLlamaServerPath(root, process.platform, process.env, { isDev: deps.isDev })),
    modelExists: deps.modelExists,
    makeReal: makeTranslator,
    binaryName: 'llama-server',
    modelNoun: 'translation model'
  })
  if (!sel.available) {
    deps.onSelect?.('none', sel.reason)
    return null
  }
  deps.onSelect?.('llama', sel.reason)
  return makeTranslator(sel.model, sel.binPath)
}
