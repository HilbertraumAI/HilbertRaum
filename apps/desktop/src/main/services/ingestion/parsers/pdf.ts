import { readFile } from 'node:fs/promises'
import { t } from '../../../../shared/i18n'
import { log } from '../../logging'
import { ensureDomMatrixPolyfill } from './dommatrix-polyfill'
import type { DocumentParser, ExtractedSegment, ParseContext, ParsedDocument } from './index'
import { reconstructPage, type LayoutWord } from './pdf-layout'

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
//
// Scanned pages inside a text PDF (#575): a page under the text threshold that carries an image
// is a scanned page (a signed letter's signature page, a scanned attachment). Import reports
// them (`scannedPages`) so the row can say so and offer OCR for exactly those pages; once read,
// their recognition replaces their (empty or near-empty) text layer page by page.

/**
 * Friendly notice for an image-only PDF (spec §11.4 — never "no text layer found").
 * Also the DERIVED `scanDetected` marker: ingestion compares a failed document's
 * error_message against this exact string, so treat the copy as part of the contract.
 * Persist-canonical English (i18n record §3.3 rule 1): this lands in
 * `documents.error_message`, so it is written as the explicit ENGLISH catalog value —
 * the renderer display map translates it at display time (D-L4).
 */
export const PDF_SCAN_DETECTED_MESSAGE = t('en', 'main.ingest.pdfScanDetected')

/**
 * A page counts as text-bearing from this many extracted characters. Real scans often
 * carry a few junk glyphs (watermark fragments, a stray page number); a genuine text
 * page of office prose is far above this.
 */
export const PDF_TEXT_PAGE_MIN_CHARS = 25

/**
 * Wall-clock bound on the scanned-page check (#575). Telling a scanned page from a blank or short
 * title page means building its operator list, which decodes its image (~0.1 s for an A4 JPEG
 * page, measured). Pages the bound leaves unchecked count as scanned: the PDF has shown plenty of
 * image pages by then, and OCR on a page that turns out blank costs one page.
 */
export const SCANNED_PAGE_CHECK_BUDGET_MS = 20_000

interface TextItemLike {
  str?: unknown
  hasEOL?: unknown
  /** pdf.js text-space transform `[a,b,c,d,e,f]`; `e`=x (index 4), `f`=y (index 5). Layout mode only. */
  transform?: unknown
  /** pdf.js advance width of the fragment. Layout mode only. */
  width?: unknown
}

function itemText(item: TextItemLike): { str: string; eol: boolean } | null {
  if (typeof item.str !== 'string') return null // skip marked-content / non-text items
  return { str: item.str, eol: item.hasEOL === true }
}

/** Lift a pdf.js text item into a positioned {@link LayoutWord} for geometry reconstruction, or null. */
function itemWord(item: TextItemLike): LayoutWord | null {
  if (typeof item.str !== 'string' || item.str === '') return null
  const tf = item.transform
  if (!Array.isArray(tf) || tf.length < 6) return null
  const x = tf[4]
  const y = tf[5]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  const w = typeof item.width === 'number' ? item.width : 0
  return { str: item.str, x, y, w }
}

export const PdfParser: DocumentParser = {
  name: 'PdfParser',
  extensions: ['.pdf'],
  mimeType: 'application/pdf',
  async parse(filePath: string, ctx?: ParseContext): Promise<ParsedDocument> {
    // pdf.js in Node only sources `DOMMatrix` from `@napi-rs/canvas` — which we exclude from
    // the package — and 6.0–6.2 needed one at import time. Install a pure-JS DOMMatrix first
    // (idempotent; a no-op where a real one exists) so the packaged main process never relies
    // on that path. See dommatrix-polyfill.ts.
    ensureDomMatrixPolyfill()
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(await readFile(filePath))
    // `verbosity: 0` (VerbosityLevel.ERRORS) silences pdf.js's font-program WARNINGS — e.g. the
    // `Warning: TT: undefined function: 21` flood a malformed embedded TrueType hint program emits on
    // every page. They are pdf.js worker noise, not our code, and carry no diagnostic value here; real
    // ERRORS still surface. Offline-safe (a verbosity flag, no network/telemetry).
    const loadingTask = pdfjs.getDocument({ data, verbosity: 0 })

    const segments: ExtractedSegment[] = []
    // Scan detection (below) must judge an image-only PDF from its RAW text-layer, INDEPENDENTLY of
    // layout reconstruction: a text page that yields no transaction rows in layout mode is still a
    // text page, not a scan. So track the raw text-bearing pages separately from the emitted segments.
    let rawTextPageCount = 0
    let numPages = 0
    /** Pages under the text threshold (#575: the scanned-page candidates). */
    const shortPages: number[] = []
    /** A text PDF's pages that look scanned (#575) — computed only when the context asks. */
    let scannedPages: number[] | undefined
    // The stored recognition, for the per-page merge in a text PDF (#575).
    const recognizedText = new Map<number, string>()
    for (const p of ctx?.ocrPages ?? []) {
      const text = p.text.trim()
      if (text.length > 0) recognizedText.set(p.pageNumber, text)
    }
    try {
      // GAP-3 (full-audit 2026-07-11): the open await sits INSIDE the try so a document that fails
      // to open (corrupt/password PDF) still reaches the finally's `loadingTask.destroy()` — it used
      // to sit before the try, leaking the loading task's transport state + up to `maxBytes` of
      // buffer on every failed parse.
      const doc = await loadingTask.promise
      numPages = doc.numPages
      // Page cap (security audit M-2): a tiny PDF can declare an enormous page count to
      // make this loop (getPage + getTextContent per page) spin unbounded. Walk at most
      // `ctx.maxPages` pages; beyond that we index what we read and log the truncation.
      const pageCap = ctx?.maxPages && ctx.maxPages > 0 ? ctx.maxPages : Number.POSITIVE_INFINITY
      const lastPage = Math.min(numPages, pageCap)
      if (numPages > lastPage) {
        log.warn('PDF page cap reached — indexing a truncated document', {
          numPages,
          pageCap: lastPage
        })
      }
      // Layout mode (plan §3.1, D51): carry the document-level year forward across pages — a
      // multi-page statement usually prints the year only in the page-1 header, so later pages whose
      // own header has none still resolve their bare DD.MM. dates. Carry the anchor MONTH the same way
      // (R5) so cross-year rollover works on later pages (page-1 period month applies to a page-3 Dec row).
      let fallbackYear: number | null = null
      let fallbackMonth: number | null = null
      for (let pageNumber = 1; pageNumber <= lastPage; pageNumber++) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()

        // Reading-order raw text — always computed; drives scan detection (and is the segment text in
        // the default mode).
        let raw = ''
        for (const item of content.items) {
          const t = itemText(item as TextItemLike)
          if (!t) continue
          raw += t.str
          raw += t.eol ? '\n' : ' '
        }
        const rawTrimmed = raw.trim()
        if (rawTrimmed.length >= PDF_TEXT_PAGE_MIN_CHARS) rawTextPageCount++
        else shortPages.push(pageNumber)

        // #575: a short page that OCR has read contributes its recognition instead of its text
        // layer (the rendered page shows that layer too, so nothing it held is lost). A whole
        // scan's segments are rebuilt from the stored recognition below, as before.
        const recognized =
          rawTrimmed.length < PDF_TEXT_PAGE_MIN_CHARS ? recognizedText.get(pageNumber) : undefined
        if (recognized) {
          segments.push({ text: recognized, pageNumber })
          continue
        }

        if (ctx?.layout) {
          // Geometry reconstruction (plan §3.1): rebuild visual rows from the word coordinates pdf.js
          // already carries. Emit the reconstructed transaction lines; an empty result is honest (no
          // rows recovered) and never a scan — `rawTextPageCount` above guards that distinction.
          const words: LayoutWord[] = []
          for (const item of content.items) {
            const w = itemWord(item as TextItemLike)
            if (w) words.push(w)
          }
          const { text, year, month } = reconstructPage(words, { fallbackYear, fallbackMonth })
          if (year != null) fallbackYear = year
          if (month != null) fallbackMonth = month
          const trimmed = text.trim()
          if (trimmed.length > 0) segments.push({ text: trimmed, pageNumber })
          continue
        }

        if (rawTrimmed.length > 0) segments.push({ text: rawTrimmed, pageNumber })
      }
      if (ctx?.detectScannedPages && rawTextPageCount > 0 && shortPages.length > 0) {
        scannedPages = await findScannedPages(doc, shortPages, pdfjs.OPS)
      }
    } finally {
      // Release pdfjs transport/worker resources promptly.
      await loadingTask.destroy()
    }

    // Scan detection: NO page reaches the text threshold ⇒ image-only (or
    // empty) PDF. A hybrid PDF (some real text pages, some scanned) is NOT detected —
    // its text pages index normally. Judged on RAW text (above), so a layout-mode page that
    // recovered no transaction rows is not mistaken for a scan.
    if (numPages > 0 && rawTextPageCount === 0) {
      // Stored recognition available (the OCR task ran) → one segment per recognized
      // page; page citations work unchanged (ExtractedSegment.pageNumber).
      const ocrPages = ctx?.ocrPages
      if (ocrPages && ocrPages.length > 0) {
        const recognized: ExtractedSegment[] = ocrPages
          .filter((p) => p.text.trim().length > 0)
          .map((p) => ({ text: p.text.trim(), pageNumber: p.pageNumber }))
        if (recognized.length > 0) {
          return { segments: recognized, mimeType: 'application/pdf', pageCount: numPages }
        }
      }
      throw new Error(PDF_SCAN_DETECTED_MESSAGE)
    }

    // `pageCount` is the DECLARED total (issue #58): a page whose text-layer trimmed empty
    // pushed no segment above, and pages past the M-2 cap were never walked — both are real
    // content gaps the translation completeness accounting must be able to see.
    return {
      segments,
      mimeType: 'application/pdf',
      pageCount: numPages,
      ...(scannedPages && scannedPages.length > 0 ? { scannedPages } : {})
    }
  }
}

/** The pdf.js operators that paint an image — a scanned page paints at least one. */
function imagePaintOps(ops: Record<string, number>): Set<number> {
  return new Set(
    [
      ops.paintImageXObject,
      ops.paintInlineImageXObject,
      ops.paintInlineImageXObjectGroup,
      ops.paintImageXObjectRepeat,
      ops.paintImageMaskXObject,
      ops.paintImageMaskXObjectGroup,
      ops.paintImageMaskXObjectRepeat,
      ops.paintSolidColorImageMask
    ].filter((op): op is number => typeof op === 'number')
  )
}

interface OperatorListDoc {
  getPage(n: number): Promise<{
    getOperatorList(): Promise<{ fnArray: number[] }>
    cleanup(): unknown
  }>
}

/**
 * #575: which of a text PDF's short pages paint an image — the scanned ones. A blank page or a
 * short title page paints none and is not offered OCR. Bounded by SCANNED_PAGE_CHECK_BUDGET_MS
 * (pages it leaves unchecked count as scanned); a page whose operator list fails is not counted.
 */
async function findScannedPages(
  doc: OperatorListDoc,
  shortPages: readonly number[],
  ops: Record<string, number>
): Promise<number[]> {
  const paintsImage = imagePaintOps(ops)
  const deadline = performance.now() + SCANNED_PAGE_CHECK_BUDGET_MS
  const scanned: number[] = []
  for (const pageNumber of shortPages) {
    if (performance.now() > deadline) {
      scanned.push(pageNumber)
      continue
    }
    try {
      const page = await doc.getPage(pageNumber)
      try {
        const list = await page.getOperatorList()
        if (list.fnArray.some((op) => paintsImage.has(op))) scanned.push(pageNumber)
      } finally {
        page.cleanup()
      }
    } catch {
      // An unreadable page is not offered OCR on this evidence.
    }
  }
  return scanned
}
