import type { DocumentOcrInfo } from '../../../shared/types'

/**
 * OCR metadata sidecar (`documents.ocr_meta_json`) — PERF-3, full-audit-2026-06-29 follow-up
 * Phase 4. Holds ONLY the surface metadata `DocumentInfo.ocr` exposes (page count, languages,
 * engine id, createdAt) — NEVER the recognized page text. The hot `listDocuments` path reads the
 * OCR badge from this tiny column instead of `JSON.parse`-ing the multi-MB `ocr_json` blob (which
 * reconstructs every page's text only to read `pages.length`). The on-disk shape is exactly
 * `DocumentOcrInfo`.
 *
 * SINGLE SOURCE OF TRUTH for "metadata from a stored OCR blob": used both at OCR-write time
 * (`setDocumentOcr`) and by the one-time backfill (`db.ts`) so an old workspace's count matches a
 * freshly-written one. This is a LEAF module (only a type import) so `db.ts` can import it without
 * the `db → ingestion` cycle.
 *
 * CONTENT discipline: this metadata is counts/ids/languages only — safe to keep, but the page text
 * it summarizes is content (DB-only, never logged/audited/exported). This module never touches text.
 */

/**
 * Extract the OCR metadata from a stored `ocr_json` blob WITHOUT materializing any page text.
 * Counts only well-formed pages (integer `pageNumber` + string `text`) so the page count matches
 * what the full `parseOcr`/`ocrInfoOf` path reports; returns null for absent/malformed/empty OCR
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
    let pageCount = 0
    for (const p of v.pages) {
      const pageNumber = (p as { pageNumber?: unknown })?.pageNumber
      const text = (p as { text?: unknown })?.text
      if (typeof pageNumber === 'number' && Number.isInteger(pageNumber) && typeof text === 'string') {
        pageCount++
      }
    }
    if (pageCount === 0) return null
    return {
      pageCount,
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

/**
 * Parse a stored `ocr_meta_json` value back to `DocumentOcrInfo` (the list read path).
 * Tolerant: a malformed/empty sidecar reads as null (the caller then falls back to `ocr_json`).
 */
export function parseOcrMeta(json: string | null | undefined): DocumentOcrInfo | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<DocumentOcrInfo> | null
    if (
      !v ||
      typeof v.pageCount !== 'number' ||
      !Number.isInteger(v.pageCount) ||
      v.pageCount <= 0
    ) {
      return null
    }
    return {
      pageCount: v.pageCount,
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
