import type { DocumentOcrInfo } from '../../../shared/types'

/**
 * OCR metadata sidecar (`documents.ocr_meta_json`) — PERF-3, full-audit-2026-06-29 follow-up
 * Phase 4. Holds ONLY the surface metadata `DocumentInfo.ocr` exposes (page counts, languages,
 * engine id, createdAt) — NEVER the recognized page text. The hot `listDocuments` path reads the
 * OCR badge from this tiny column instead of `JSON.parse`-ing the multi-MB `ocr_json` blob (which
 * reconstructs every page's text only to read `pages.length`). The on-disk shape is exactly
 * `DocumentOcrInfo`.
 *
 * SINGLE SOURCE OF TRUTH for "metadata from recognized pages" (`ocrMetaOf`): used at OCR-write time
 * (`setDocumentOcr`), for a photo read on import (#574 — it has meta but no `ocr_json`), and by the
 * backfill (`db.ts`), so an old workspace's counts match a freshly written one. This is a LEAF
 * module (only type imports) so `db.ts` can import it without the `db → ingestion` cycle.
 *
 * CONTENT discipline: this metadata is counts/ids/languages only — safe to keep, but the page text
 * it summarizes is content (DB-only, never logged/audited/exported). Nothing here returns text.
 */

/**
 * A page whose reading's mean confidence (0–100) is below this counts as "unsure" (#538). Calibrated
 * on rendered pages: clean upright text 92–94; a poor but upright photocopy 52–56 (88 % of words
 * right); a page read sideways, or in a script the language files do not cover, 34–62 with no word
 * right. So everything below 65 is worth a second look, and clean scans are never flagged.
 */
export const OCR_LOW_CONFIDENCE = 65

/** The page fields the metadata reads (the `OcrPage` shape; `text` is only measured, never kept). */
interface PageLike {
  text: string
  confidence?: number | null
}

/**
 * Surface metadata of a recognition: pages read, pages that produced text (#576), and — when the
 * pages carry a confidence (#538; recognitions stored before it do not) — how many text pages were
 * read with low confidence. Null for an empty page list (no badge).
 */
export function ocrMetaOf(
  pages: readonly PageLike[],
  provenance: { languages: readonly string[]; engineId: string; createdAt: string }
): DocumentOcrInfo | null {
  if (pages.length === 0) return null
  let textPageCount = 0
  let rated = 0
  let low = 0
  for (const p of pages) {
    if (p.text.trim().length === 0) continue
    textPageCount++
    if (typeof p.confidence === 'number' && Number.isFinite(p.confidence)) {
      rated++
      if (p.confidence < OCR_LOW_CONFIDENCE) low++
    }
  }
  return {
    pageCount: pages.length,
    textPageCount,
    ...(rated > 0 ? { lowConfidencePageCount: low } : {}),
    languages: [...provenance.languages],
    engineId: provenance.engineId,
    createdAt: provenance.createdAt
  }
}

/**
 * Extract the OCR metadata from a stored `ocr_json` blob WITHOUT keeping any page text.
 * Counts only well-formed pages (integer `pageNumber` + string `text`) so the counts match what
 * the full `parseOcr`/`ocrInfoOf` path reports; returns null for absent/malformed/empty OCR
 * (mirroring `parseOcr`, which also returns null when no page survives validation — the badge is
 * then absent). Tolerant: a corrupt blob must never throw on the list path.
 */
export function ocrMetaFromJson(json: string | null | undefined): DocumentOcrInfo | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as {
      pages?: unknown
      engineId?: unknown
      languages?: unknown
      createdAt?: unknown
    } | null
    if (!v || !Array.isArray(v.pages)) return null
    const pages: PageLike[] = []
    for (const p of v.pages) {
      const pageNumber = (p as { pageNumber?: unknown })?.pageNumber
      const text = (p as { text?: unknown })?.text
      const confidence = (p as { confidence?: unknown })?.confidence
      if (typeof pageNumber === 'number' && Number.isInteger(pageNumber) && typeof text === 'string') {
        pages.push({ text, confidence: typeof confidence === 'number' ? confidence : null })
      }
    }
    return ocrMetaOf(pages, {
      languages: Array.isArray(v.languages)
        ? v.languages.filter((l): l is string => typeof l === 'string')
        : [],
      engineId: typeof v.engineId === 'string' ? v.engineId : 'unknown',
      createdAt: typeof v.createdAt === 'string' ? v.createdAt : ''
    })
  } catch {
    return null
  }
}

/** A count field of a stored sidecar: a non-negative integer no larger than `max`, else absent. */
function countField(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : undefined
}

/**
 * Parse a stored `ocr_meta_json` value back to `DocumentOcrInfo` (the list read path).
 * Tolerant: a malformed/empty sidecar reads as null (the caller then falls back to `ocr_json`).
 * A sidecar written before #576/#538 simply lacks the newer counts (the backfill re-derives
 * `textPageCount` from `ocr_json`; a photo's sidecar is written whole).
 */
export function parseOcrMeta(json: string | null | undefined): DocumentOcrInfo | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Record<string, unknown> | null
    if (
      !v ||
      typeof v.pageCount !== 'number' ||
      !Number.isInteger(v.pageCount) ||
      v.pageCount <= 0
    ) {
      return null
    }
    const pageCount = v.pageCount
    const textPageCount = countField(v.textPageCount, pageCount)
    const lowConfidencePageCount = countField(v.lowConfidencePageCount, textPageCount ?? pageCount)
    return {
      pageCount,
      ...(textPageCount !== undefined ? { textPageCount } : {}),
      ...(lowConfidencePageCount !== undefined ? { lowConfidencePageCount } : {}),
      languages: Array.isArray(v.languages)
        ? v.languages.filter((l): l is string => typeof l === 'string')
        : [],
      engineId: typeof v.engineId === 'string' ? v.engineId : 'unknown',
      createdAt: typeof v.createdAt === 'string' ? v.createdAt : ''
    }
  } catch {
    return null
  }
}
