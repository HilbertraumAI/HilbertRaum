import type { Transcriber } from './index'
import { createWhisperCliTranscriber, resolveWhisperCliPath } from './cli'
import { resolveSidecarSelection } from '../select-sidecar-backed'

// Availability-aware transcriber selector, the reranker pattern verbatim:
// NO mock fallback. A real `WhisperCliTranscriber` is chosen only when BOTH the
// platform `whisper-cli` binary AND the transcriber weights are present; otherwise the
// selector returns NULL and an audio import fails per-file with friendly copy
// (graceful-fallback rule — a mock transcript would silently corrupt the corpus).

/** The transcriber model resolved from its manifest (id + GGML weight path). */
export interface TranscriberModelInfo {
  id: string
  /** Absolute path to the transcriber GGML weight file. */
  modelPath: string
}

export interface TranscriberSelectionDeps {
  /** Drive root used to resolve `runtime/whisper.cpp/<os>/whisper-cli`. */
  rootPath: string
  /** The transcriber model from the manifest, or null when none is configured. */
  model: TranscriberModelInfo | null
  resolveBin?: (rootPath: string) => string | null
  modelExists?: (modelPath: string) => boolean
  makeTranscriber?: (model: TranscriberModelInfo, binPath: string) => Transcriber
  onSelect?: (kind: 'whisper' | 'none', reason: string) => void
}

/**
 * Build the active `Transcriber`, or null when unavailable. Construction is cheap
 * (the CLI is spawned per `transcribe()` call), so this returns synchronously.
 */
export function createSelectedTranscriber(deps: TranscriberSelectionDeps): Transcriber | null {
  const makeTranscriber =
    deps.makeTranscriber ??
    ((model: TranscriberModelInfo, binPath: string) =>
      createWhisperCliTranscriber({
        id: model.id,
        binPath,
        modelPath: model.modelPath
      }))

  // Shared model→binary→weights ladder (L16). NO mock fallback — a mock transcript would
  // silently corrupt the corpus, so unavailable means null.
  const sel = resolveSidecarSelection<TranscriberModelInfo, Transcriber>({
    rootPath: deps.rootPath,
    model: deps.model,
    resolveBin: deps.resolveBin ?? ((root) => resolveWhisperCliPath(root)),
    modelExists: deps.modelExists,
    makeReal: makeTranscriber,
    binaryName: 'whisper-cli',
    modelNoun: 'transcriber model'
  })
  if (!sel.available) {
    deps.onSelect?.('none', sel.reason)
    return null
  }
  deps.onSelect?.('whisper', sel.reason)
  return makeTranscriber(sel.model, sel.binPath)
}
