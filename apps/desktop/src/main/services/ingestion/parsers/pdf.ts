import { readFile } from 'node:fs/promises'
import type { DocumentParser, ExtractedSegment, ParseContext, ParsedDocument } from './index'

// PDF parser (spec R3). Uses pdfjs-dist's *legacy* build, which runs in plain Node
// with no Web Worker and no DOM. Each page becomes one segment
// tagged with its 1-based page number, so every chunk derived from it can cite a page.
// pdfjs is imported lazily so the (large) library only loads when a PDF is ingested.
//
// Image-only-scan detection: a PDF whose
// pages carry ~no extractable text used to silently index NOTHING — it reached
// `indexed` with zero chunks and answers could never find it. Now it fails friendly
// with PDF_SCAN_DETECTED_MESSAGE; the Documents row offers "Make searchable (OCR)"
// when the local OCR assets exist (OCR is never automatic for PDFs).
//
// After the OCR task ran, its per-page recognition is persisted (`documents.ocr_json`)
// and arrives here as `ctx.ocrPages`: a scan-detected PDF then parses into one segment
// per RECOGNIZED page instead of failing — re-index and preview reuse the stored
// recognition (no silent re-OCR; re-running the task is the explicit way to redo it).

/**
 * Friendly notice for an image-only PDF (spec §11.4 — never "no text layer found").
 * Also the DERIVED `scanDetected` marker: ingestion compares a failed document's
 * error_message against this exact string, so treat the copy as part of the contract.
 */
export const PDF_SCAN_DETECTED_MESSAGE =
  'This PDF looks like a scan — it has no readable text yet.'

/**
 * A page counts as text-bearing from this many extracted characters. Real scans often
 * carry a few junk glyphs (watermark fragments, a stray page number); a genuine text
 * page of office prose is far above this.
 */
export const PDF_TEXT_PAGE_MIN_CHARS = 25

interface TextItemLike {
  str?: unknown
  hasEOL?: unknown
}

function itemText(item: TextItemLike): { str: string; eol: boolean } | null {
  if (typeof item.str !== 'string') return null // skip marked-content / non-text items
  return { str: item.str, eol: item.hasEOL === true }
}

export const PdfParser: DocumentParser = {
  name: 'PdfParser',
  extensions: ['.pdf'],
  mimeType: 'application/pdf',
  async parse(filePath: string, ctx?: ParseContext): Promise<ParsedDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(await readFile(filePath))
    const loadingTask = pdfjs.getDocument({ data })
    const doc = await loadingTask.promise

    const segments: ExtractedSegment[] = []
    let numPages = 0
    try {
      numPages = doc.numPages
      for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        let text = ''
        for (const raw of content.items) {
          const item = itemText(raw as TextItemLike)
          if (!item) continue
          text += item.str
          text += item.eol ? '\n' : ' '
        }
        const trimmed = text.trim()
        if (trimmed.length > 0) segments.push({ text: trimmed, pageNumber })
      }
    } finally {
      // Release pdfjs transport/worker resources promptly.
      await loadingTask.destroy()
    }

    // Scan detection: NO page reaches the text threshold ⇒ image-only (or
    // empty) PDF. A hybrid PDF (some real text pages, some scanned) is NOT detected —
    // its text pages index normally.
    const textPages = segments.filter((s) => s.text.length >= PDF_TEXT_PAGE_MIN_CHARS)
    if (numPages > 0 && textPages.length === 0) {
      // Stored recognition available (the OCR task ran) → one segment per recognized
      // page; page citations work unchanged (ExtractedSegment.pageNumber).
      const ocrPages = ctx?.ocrPages
      if (ocrPages && ocrPages.length > 0) {
        const recognized: ExtractedSegment[] = ocrPages
          .filter((p) => p.text.trim().length > 0)
          .map((p) => ({ text: p.text.trim(), pageNumber: p.pageNumber }))
        if (recognized.length > 0) {
          return { segments: recognized, mimeType: 'application/pdf' }
        }
      }
      throw new Error(PDF_SCAN_DETECTED_MESSAGE)
    }

    return { segments, mimeType: 'application/pdf' }
  }
}
