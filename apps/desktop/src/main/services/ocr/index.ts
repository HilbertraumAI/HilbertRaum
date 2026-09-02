// OCR contract (wave-3 plan §11). Turns a page IMAGE (PNG/JPEG bytes) into
// recognized text — fully local: tesseract.js (WASM) with the language files vendored
// on the drive (`ocr/`), never fetched at runtime.
//
// Recognition ALWAYS runs in the MAIN process via tesseract.js
// Node mode, which consumes image-file Buffers with no canvas and loads its worker
// script + WASM core from the app's own node_modules. Only PDF page RASTERIZATION
// needs a canvas, so only that step runs in a hidden renderer (`rasterizer.ts`);
// photos never touch a renderer at all.
//
// Graceful-fallback rule (the reranker/transcriber pattern): there is NO mock OCR
// engine. When the drive carries no language files the factory returns null — a photo
// import fails per-file with friendly copy and a detected scan shows the notice
// without the "Make searchable" offer. A mock would invent text and silently corrupt
// the corpus.

/** One recognized image: the text plus tesseract's 0–100 mean confidence. */
export interface OcrResult {
  text: string
  /** Mean word confidence (0–100) as tesseract reports it, or null when unknown. */
  confidence: number | null
}

export interface OcrRecognizeOptions {
  /** Abort between/before recognitions (a recognition in flight finishes its page). */
  signal?: AbortSignal
}

/**
 * Whether the engine can actually run in this build (#232). Asset presence decides whether an
 * engine exists (the factory's null rule); this decides whether it is honest to offer:
 *   - `'available'`   — last worker start was healthy (dev builds start here; packaged builds
 *                       reach it when the startup probe passes);
 *   - `'probing'`     — packaged build, probe not settled yet (recognitions still attempt);
 *   - `'unavailable'` — the worker failed to load, died or timed out: recognitions are skipped
 *                       with the per-document "could not run in this build" note.
 */
export type OcrAvailability = 'available' | 'probing' | 'unavailable'

/** The contract an OCR backend implements (mirrors `Embedder`/`Transcriber`). */
export interface OcrEngine {
  /** Engine id for diagnostics/metadata (e.g. 'tesseract.js-7.0.0') — never content. */
  readonly id: string
  /** Traineddata languages this engine recognizes with (e.g. ['deu', 'eng']). */
  readonly languages: readonly string[]
  /** Recognize one image (PNG/JPEG file bytes). Reuses one warm worker across calls. */
  recognize(image: Buffer, opts?: OcrRecognizeOptions): Promise<OcrResult>
  /**
   * Execution state (#232). Optional so test fakes stay minimal — absent means `'available'`.
   * `ocrAvailable` in the app status and the image parser read this, never mere presence.
   */
  availability?(): OcrAvailability
  /**
   * Packaged-mode execution probe (#232): start the worker once, bounded, and settle the
   * availability. Resolves `true` when the engine proved it can run. The startup wiring calls it.
   */
  probe?(): Promise<boolean>
  /** Release the backend permanently (terminates the worker). On `will-quit`. */
  stop?(): Promise<void>
  /**
   * Non-latching teardown for the workspace lock (BE-5): terminate the warm worker so no decoded
   * page bytes linger across the vault re-encrypt, but let the next recognition lazily respawn
   * (unlike `stop()`, which latches permanently). On `lock`.
   */
  suspend?(): Promise<void>
}

/** A page of persisted recognition output (the `documents.ocr_json` content shape). */
export interface OcrPage {
  /** 1-based page number (photos: 1). */
  pageNumber: number
  text: string
}

export { TesseractOcrEngine, createTesseractOcrEngine } from './tesseract'
export type { TesseractOcrEngineOptions } from './tesseract'
export {
  createSelectedOcrEngine,
  listOcrLanguages,
  ocrAssetsDir
} from './factory'
export type { OcrSelectionDeps } from './factory'
