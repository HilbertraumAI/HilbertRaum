import type { DocumentOcrInfo } from '@shared/types'
import type { I18n } from '../../i18n'

// The wording of a document's OCR metadata, shared by the preview and the row so both say the
// same thing (#576, #538, #574, #575; design-guidelines §11.19). Counts only — the recognized text
// never reaches these helpers.

/** A photo of a page (#574): its OCR metadata is one page, worded as "this photo". */
export function isPhotoDocument(mimeType: string | null | undefined): boolean {
  return (mimeType ?? '').startsWith('image/')
}

/** Pages whose reading produced text; a sidecar written before #576 reads as every page. */
export function ocrTextPages(ocr: DocumentOcrInfo): number {
  return ocr.textPageCount ?? ocr.pageCount
}

/**
 * The preview's "text recognized" line: it counts the pages that produced text (#576). For a text
 * PDF whose scanned pages were read (#575), `documentPages` is the whole document's page count,
 * so "on 3 of 12 pages" counts against what the reader sees, not just the pages OCR read.
 */
export function ocrInfoLine(
  ocr: DocumentOcrInfo,
  t: I18n['t'],
  tCount: I18n['tCount'],
  opts: { photo?: boolean; documentPages?: number } = {}
): string {
  if (opts.photo) return t('docs.previewModal.ocrInfoPhoto')
  const textPages = ocrTextPages(ocr)
  if (textPages === 0) return tCount('docs.previewModal.ocrInfoNone', ocr.pageCount)
  const total = Math.max(ocr.pageCount, opts.documentPages ?? 0)
  if (textPages < total) {
    return t('docs.previewModal.ocrInfoPartial', { count: textPages, total })
  }
  return tCount('docs.previewModal.ocrInfo', ocr.pageCount)
}

/**
 * "Text recognition was unsure …" (#538) when at least one text page was read with low
 * confidence, else null. Nouns agree without plural forms: `some` always has ≥ 2 pages in total,
 * `all` ≥ 2 pages; one recognized page is "this page" only in a one-page document (else "the one
 * page it recognized" — a 12-page document must not read "this page"). `documentPages` is the
 * whole document's page count when only its scanned pages were read (#575).
 */
export function ocrUnsureLine(
  ocr: DocumentOcrInfo,
  t: I18n['t'],
  opts: { photo?: boolean; documentPages?: number } = {}
): string | null {
  const unsure = ocr.lowConfidencePageCount ?? 0
  if (unsure <= 0) return null
  if (opts.photo) return t('docs.ocr.unsure.photo')
  const textPages = ocrTextPages(ocr)
  if (textPages <= 1) {
    const onePageDocument = Math.max(ocr.pageCount, opts.documentPages ?? 0) <= 1
    return t(onePageDocument ? 'docs.ocr.unsure.page' : 'docs.ocr.unsure.onlyRecognized')
  }
  if (unsure >= textPages) return t('docs.ocr.unsure.all', { count: textPages })
  return t('docs.ocr.unsure.some', { count: unsure, total: textPages })
}
