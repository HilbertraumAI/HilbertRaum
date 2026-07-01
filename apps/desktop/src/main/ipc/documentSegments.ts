import type { DocumentChunkRead } from '../../shared/types'
import type { AppContext } from '../services/context'
import { documentsDir, extractDocumentPreview } from '../services/ingestion'
import { resolveIngestionLimits } from '../services/ingestion/limits'

// The FAITHFUL content reach shared by the two skill entry points: the chat/analysis IPC
// (`registerRagIpc`, a tool-skill analysis handler) and the run-bar IPC (`registerSkillsIpc`, the
// "Extract transactions"/"Read invoice" button). Both re-extract a document's ordered,
// non-overlapping, newline-preserving parser SEGMENTS from the stored copy — NOT the stored `chunks`
// table, which is retrieval windows (newlines collapsed, ~80-token overlap) that would give the
// line-oriented bank/invoice extractors near-zero rows. Content stays main-side: only the tool
// (inside the gate) ever sees this text.
//
// WHY ONE FACTORY (not a closure copied into each IPC file): the two copies once DRIFTED — the
// run-bar copy dropped the `layout` argument, so the "Extract transactions" BUTTON re-read a columnar
// statement in plain reading order (fewer, scrambled rows) while the chat analysis answer used
// geometry-aware layout reconstruction — the SAME document reported a DIFFERENT transaction count
// depending on which entry point ran. A single shared reader makes that divergence structurally
// impossible.

/**
 * Build the shared segment reader for `ctx`. The `layout` flag opts into geometry-aware row/column
 * reconstruction (PDF geometry-extraction plan §3.1, D58 — bank-statement only); the page cap rides
 * along ONLY in that mode (per-page clustering across an uncapped page count is a DoS/perf amplifier).
 * The default path is byte-unchanged reading-order text (redaction / invoice / translate-compare).
 */
export function buildDocumentSegmentReader(
  ctx: AppContext
): (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]> {
  const storeDir = documentsDir(ctx.paths.workspacePath)
  return async (documentId, opts): Promise<DocumentChunkRead[]> => {
    const preview = await extractDocumentPreview(
      ctx.db,
      storeDir,
      documentId,
      { cipher: ctx.workspace.documentCipher(), ocrEngine: ctx.ocrEngine },
      opts?.layout ? { layout: true, maxPages: resolveIngestionLimits().pdfMaxPages } : {}
    )
    return preview.segments.map((s, index) => ({ text: s.text, page: s.pageNumber, index }))
  }
}
