import type { Db } from '../../db'
import type { Citation, CoverageInfo, RetrievalScope } from '../../../../shared/types'
import { documentsInScope } from '../scope-documents'
import { documentChunkCount } from '../../analysis/coverage'
import { getSkill } from '../registry'
import { matchesSkillDocSignals } from '../selector'

// Shared analysis-handler plumbing (A1, audit §6.4 plumbing bullet). Before A1 these helpers were copied
// verbatim across `analysis/bank-statement.ts`, `analysis/invoice.ts` (and `singleInScopeDocument` a third
// time in `analysis/whole-doc-skills.ts`). They are pure read helpers over the shared `documents`/`chunks`
// tables — domain-agnostic — so they live here as the single copy. The domain-specific `loadInvoice`
// (formerly duplicated) now lives in the run seam (`invoice-run.ts`, exported); the citation SELECTION
// strategy stays per-domain (bank narrows to the transactions' source pages + head; invoice takes a
// head+tail window) and calls the shared query + projection below.

/** The single in-scope ANSWERABLE document, or null when the scope is not exactly one (R2). The chat
 *  analysis path reads the stored `chunks`, so it requires them (`requireChunks: true`) — an indexed
 *  but unchunked document is runnable via the button but not answerable here (X-1, the shared helper).
 *  Carries `title`/`mimeType` too so the W2 plausibility gate can test the doc against the skill's
 *  signals; the whole-doc handlers only need the existence check (`!== null`). */
export function singleInScopeDocument(
  db: Db,
  scope: RetrievalScope
): { id: string; title: string; mimeType: string | null } | null {
  const docs = documentsInScope(db, scope, { requireChunks: true })
  return docs.length === 1 ? { id: docs[0].id, title: docs[0].title, mimeType: docs[0].mimeType } : null
}

/**
 * W2 document-plausibility gate (audit §4.5): after a ZERO-CONTENT extraction, should the turn abandon
 * the empty template and fall through to the ordinary grounded path? Only when the skill DECLARES doc
 * signals (filenamePatterns/MIME) and the document matches NONE of them — positive evidence it isn't the
 * skill's document class at all (a contract in scope with the bank/invoice skill sticky). Absent signals
 * — an unsignalled skill, or the anomaly where the skill row can't be read — give NO basis to judge, so
 * we KEEP the honest empty answer (the D56 posture). Deterministic; no model call.
 */
export function shouldFallThroughOnEmpty(
  db: Db,
  skillInstallId: string,
  doc: { title: string; mimeType: string | null }
): boolean {
  const triggers = getSkill(db, skillInstallId)?.manifest.triggers
  if (!triggers) return false
  const hasAnySignal =
    triggers.mimeTypes.some((m) => m.trim().length > 0) ||
    triggers.filenamePatterns.some((p) => p.trim().length > 0)
  if (!hasAnySignal) return false
  return !matchesSkillDocSignals(triggers, doc)
}

/**
 * A4 (SKA-7 structural, audit §3.2/§8.2): the INVERSION gate for a TOOL skill (bank/invoice). Does the
 * SINGLE in-scope document plausibly belong to the skill's class, so the chat path should run the handler
 * for EVERY non-small-talk question — RETIRING the phrasing (`routeMatch`) veto? True when the one in-scope
 * doc matches the skill's manifest doc signals (filename/MIME, `matchesSkillDocSignals`) OR a persisted
 * extraction already exists for it (`hasExtraction` — the strongest evidence: the skill has already read
 * this document). A doc matching NEITHER keeps the phrasing gate (the W2 plausibility posture, inverted:
 * the signals GATE the inversion, so a contract with the bank skill sticky is never force-extracted on
 * "who signed this?"). Returns false unless the scope is exactly one answerable doc — the inversion is
 * single-document (multi-doc is the W2 pre-pass's job). Deterministic; no model.
 */
export function singleDocMatchesSkillClass(
  db: Db,
  skillInstallId: string,
  scope: RetrievalScope,
  hasExtraction: (db: Db, documentId: string) => boolean
): boolean {
  const doc = singleInScopeDocument(db, scope)
  if (!doc) return false
  const triggers = getSkill(db, skillInstallId)?.manifest.triggers
  if (triggers && matchesSkillDocSignals(triggers, doc)) return true
  return hasExtraction(db, doc.id)
}

/** Honest extract coverage (D48): every chunk scanned; `fullyChunked` gates the "whole document" wording. */
export function computeCoverage(db: Db, documentId: string): CoverageInfo {
  const chunksTotal = documentChunkCount(db, documentId)
  const row = db
    .prepare('SELECT fully_chunked FROM documents WHERE id = ?')
    .get(documentId) as { fully_chunked: string | null } | undefined
  return {
    mode: 'extract',
    chunksCovered: chunksTotal, // the tool read every chunk
    chunksTotal,
    fullyChunked: row?.fully_chunked != null // NULL (legacy/truncated) → false
  }
}

/** Format a parsed figure as a stable 2-dp decimal — the verbatim numeric (matches the CSV export). */
export function fmt(n: number): string {
  return n.toFixed(2)
}

/** One `chunks` row projected for citation — the columns both domains' citation builders read. */
export interface ChunkRow {
  chunk_index: number
  text: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
}

/** The document's `chunks` in document order — the shared source both citation builders SELECT before
 *  applying their own (page-narrowed head / head+tail) selection strategy. */
export function loadCitationChunks(db: Db, documentId: string): ChunkRow[] {
  return db
    .prepare(
      `SELECT chunk_index, text, source_label, page_number, section_label
       FROM chunks WHERE document_id = ? ORDER BY chunk_index`
    )
    .all(documentId) as unknown as ChunkRow[]
}

/** Project selected chunks into `[Sn]`-labelled citations (M2-safe: real source rows, never a synthesised
 *  figure) — the shared projection both domains apply after their own selection. Snippet capped at 280. */
export function chunksToCitations(chunks: ChunkRow[], title: string): Citation[] {
  return chunks.map((c, i) => ({
    label: `S${i + 1}`,
    sourceTitle: c.source_label ?? title,
    pageNumber: c.page_number,
    section: c.section_label,
    snippet: c.text.length > 280 ? `${c.text.slice(0, 280)}…` : c.text
  }))
}
