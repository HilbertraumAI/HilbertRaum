import type { DocumentOcrInfo } from '@shared/types'
import type { I18n } from '../../i18n'

// The wording of a document's OCR metadata, shared by the preview and the row so both say the
// same thing (#576, #538). Counts only — the recognized text never reaches these helpers.

/** Pages whose reading produced text; a sidecar written before #576 reads as every page. */
export function ocrTextPages(ocr: DocumentOcrInfo): number {
  return ocr.textPageCount ?? ocr.pageCount
}

/** The preview's "text recognized" line: it counts the pages that produced text (#576). */
export function ocrInfoLine(ocr: DocumentOcrInfo, t: I18n['t'], tCount: I18n['tCount']): string {
  const textPages = ocrTextPages(ocr)
  if (textPages < ocr.pageCount) {
    return t('docs.previewModal.ocrInfoPartial', { count: textPages, total: ocr.pageCount })
  }
  return tCount('docs.previewModal.ocrInfo', ocr.pageCount)
}

/**
 * "Text recognition was unsure …" (#538) when at least one text page was read with low
 * confidence, else null. Nouns agree without plural forms: `some` always has ≥ 2 pages in total,
 * `all` ≥ 2 pages, and a single page has its own sentence.
 */
export function ocrUnsureLine(ocr: DocumentOcrInfo, t: I18n['t']): string | null {
  const unsure = ocr.lowConfidencePageCount ?? 0
  if (unsure <= 0) return null
  const textPages = ocrTextPages(ocr)
  if (textPages <= 1) return t('docs.ocr.unsure.page')
  if (unsure >= textPages) return t('docs.ocr.unsure.all', { count: textPages })
  return t('docs.ocr.unsure.some', { count: unsure, total: textPages })
}
