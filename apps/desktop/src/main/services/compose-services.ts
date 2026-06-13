import { createSelectedEmbedder } from './embeddings/factory'
import { createSelectedReranker } from './reranker'
import { createSelectedTranscriber } from './transcriber'
import { createSelectedOcrEngine } from './ocr'
import { resolveModelByRole } from './resolve-model'
import { log } from './logging'
import type { Embedder } from './embeddings'
import type { Reranker } from './reranker'
import type { Transcriber } from './transcriber'
import type { OcrEngine } from './ocr'

// M-A3 (audit-2026-06-13): the four availability-driven service selectors (embedder,
// reranker, transcriber, OCR) were ~30 lines of near-identical "resolve the role's model,
// pick the real sidecar-backed service when its binary + weights are present, else
// mock/null, and log the choice" inline in initBackend(). They depend on nothing but the
// drive root + the manifests dir, so they extract cleanly into one builder. The
// runtime/GPU wiring (late-bound crash handler) stays in initBackend — it is genuinely
// entangled and not part of this cohesive unit.

export interface AvailabilityServices {
  embedder: Embedder
  reranker: Reranker | null
  transcriber: Transcriber | null
  ocrEngine: OcrEngine | null
}

export interface ComposeServicesDeps {
  /** Drive root used to resolve binaries + weight paths. */
  rootPath: string
  /** Resolved model-manifests dir, or null (→ every role falls back to mock/null). */
  manifestsDir: string | null
}

/**
 * Build the availability-driven services from the drive layout: the embedder (real E5 when
 * its binary + weights are present, else mock so the app launches model-free), and the
 * reranker / transcriber / OCR engine (real when provisioned, else `null` — a mock there
 * would invent an ordering / a transcript / OCR text and silently corrupt answers).
 */
export function composeServices({ rootPath, manifestsDir }: ComposeServicesDeps): AvailabilityServices {
  const embedder = createSelectedEmbedder({
    rootPath,
    model: resolveModelByRole(manifestsDir, rootPath, 'embeddings'),
    onSelect: (kind, reason) => log.info('Embedder backend selected', { kind, reason })
  })
  // The retrieval reranker — selected only when binary + reranker GGUF exist (null
  // otherwise; retrieval then keeps today's ordering byte-identical).
  const reranker = createSelectedReranker({
    rootPath,
    model: resolveModelByRole(manifestsDir, rootPath, 'reranker'),
    onSelect: (kind, reason) => log.info('Reranker backend selected', { kind, reason })
  })
  // The audio transcriber — the whisper.cpp CLI; selected only when binary + GGML weights
  // exist (null otherwise; audio imports fail per-file with the download-the-model copy).
  // No context window.
  const transcriber = createSelectedTranscriber({
    rootPath,
    model: resolveModelByRole(manifestsDir, rootPath, 'transcriber', {
      includeContextTokens: false
    }),
    onSelect: (kind, reason) => log.info('Transcriber backend selected', { kind, reason })
  })
  // Local OCR — tesseract.js over the drive's vendored `ocr/` language files; selected
  // only when those exist (null otherwise; photo imports fail per-file and detected scans
  // show the notice without the "Make searchable" offer).
  const ocrEngine = createSelectedOcrEngine({
    rootPath,
    onSelect: (kind, reason) => log.info('OCR backend selected', { kind, reason })
  })

  return { embedder, reranker, transcriber, ocrEngine }
}
