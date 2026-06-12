import { existsSync } from 'node:fs'
import type { Transcriber } from './index'
import { createWhisperCliTranscriber, resolveWhisperCliPath } from './cli'

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
  const resolveBin = deps.resolveBin ?? ((root: string) => resolveWhisperCliPath(root))
  const modelExists = deps.modelExists ?? existsSync
  const makeTranscriber =
    deps.makeTranscriber ??
    ((model: TranscriberModelInfo, binPath: string) =>
      createWhisperCliTranscriber({
        id: model.id,
        binPath,
        modelPath: model.modelPath
      }))

  if (!deps.model) {
    deps.onSelect?.('none', 'no transcriber model configured')
    return null
  }
  const binPath = resolveBin(deps.rootPath)
  if (!binPath) {
    deps.onSelect?.('none', 'no whisper-cli binary on the drive')
    return null
  }
  if (!modelExists(deps.model.modelPath)) {
    deps.onSelect?.('none', 'transcriber model weights not present')
    return null
  }
  deps.onSelect?.('whisper', 'binary + weights present')
  return makeTranscriber(deps.model, binPath)
}
