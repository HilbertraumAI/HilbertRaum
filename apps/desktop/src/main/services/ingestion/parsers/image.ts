import { readFile } from 'node:fs/promises'
import type { DocumentParser, ParseContext, ParsedDocument } from './index'
import { log } from '../../logging'

// Photo "parser": a photographed page becomes a normal corpus document by
// running the injected OCR engine over the image bytes. Deliberate asymmetry:
// photos OCR ON IMPORT (one small image, seconds) while PDFs need the explicit
// "Make searchable (OCR)" task (many pages, minutes). Recognition runs main-side in
// tesseract.js Node mode — the image bytes are decoded inside the WASM core, no
// canvas, no renderer round-trip.
//
// Page-less single segment, so the txt/md chunk-dedup rule applies. Re-index re-runs
// the recognition over the stored copy (like audio re-transcription: the stored copy
// is the source of truth; recognized text is derived).

/** Photo extensions the OCR pipeline accepts (png + jpg). */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

/** Friendly copy when no OCR engine is available (language files missing). */
export const IMAGE_NEEDS_OCR_MESSAGE =
  'Photo import needs the text-recognition (OCR) files, which are not on this drive.'

/** Friendly copy when recognition finds no readable text in the photo. */
export const IMAGE_NO_TEXT_MESSAGE =
  'No readable text was found in this photo. Try a sharper, closer picture of the page.'

/** Friendly copy for any other recognition failure (spec §11.4 — never raw errors). */
export const IMAGE_OCR_FAILED_MESSAGE =
  "This photo couldn't be read. Re-index it to try again."

export const ImageParser: DocumentParser = {
  name: 'image',
  extensions: IMAGE_EXTENSIONS,
  // Fallback only — `processDocument` records the per-extension MIME (image/png, …).
  mimeType: 'image/*',

  async parse(filePath: string, ctx?: ParseContext): Promise<ParsedDocument> {
    const engine = ctx?.ocrEngine
    if (!engine) {
      // Friendly per-file failure (graceful-fallback rule): processDocument catches
      // this onto the document row as `failed` + error_message.
      throw new Error(IMAGE_NEEDS_OCR_MESSAGE)
    }
    let text: string
    try {
      const image = await readFile(filePath)
      const result = await engine.recognize(image)
      text = result.text.trim()
    } catch (err) {
      // §11.4: the documents table gets friendly copy; the technical reason goes to
      // the LOCAL log only. Engine errors carry no recognized text (content-safe).
      const message = err instanceof Error ? err.message : String(err)
      log.warn('Photo OCR failed', { error: message.slice(0, 600) })
      throw new Error(IMAGE_OCR_FAILED_MESSAGE)
    }
    if (text.length === 0) {
      throw new Error(IMAGE_NO_TEXT_MESSAGE)
    }
    return {
      segments: [{ text, pageNumber: null, sectionLabel: null }],
      mimeType: ImageParser.mimeType
    }
  }
}
