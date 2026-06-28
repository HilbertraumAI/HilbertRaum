import type { Db } from '../db'
import type { MessageKey, MessageParams } from '../../../shared/i18n'
import type { ExtractionListing, ExtractRecordType } from '../../../shared/types'

// Render a precomputed "list every X" aggregation into the deterministic chat answer
// (whole-document-analysis plan §4.2 step 2/3, Phase 3). ZERO model calls — the text is built
// from `aggregateExtractions` output. Honesty (H7): the answer leads with the coverage line
// ("across N sections scanned (k unparsed)"), labels itself exhaustive-over-sections — NOT
// complete, and gates the "whole document" wording on the `fully_chunked` invariant AND actual
// scan coverage (`scannedChunks >= totalChunks`, RAG-1): a legacy truncated doc, OR a multi-doc
// scope where extraction ran on only some docs, says "sections scanned", never "whole document".
// Per-item provenance is the source sections each item came from. The values are CONTENT and live
// only in the persisted message (never logged/audited).

const KIND_KEY: Record<ExtractRecordType, MessageKey> = {
  generic: 'analysis.kind.generic',
  date: 'analysis.kind.date',
  amount: 'analysis.kind.amount',
  party: 'analysis.kind.party',
  obligation: 'analysis.kind.obligation'
}

interface ChunkRef {
  page_number: number | null
  section_label: string | null
  chunk_index: number
}

/** A readable per-item provenance label from its source section ids (page / section / index). */
function sectionRefs(
  db: Db,
  chunkIds: string[],
  tr: (key: MessageKey, params?: MessageParams) => string
): string {
  if (chunkIds.length === 0) return ''
  const rows = db
    .prepare(
      `SELECT page_number, section_label, chunk_index FROM chunks
       WHERE id IN (${chunkIds.map(() => '?').join(', ')})`
    )
    .all(...chunkIds) as unknown as ChunkRef[]
  const labels: string[] = []
  const seen = new Set<string>()
  const ordered = rows.sort((a, b) => a.chunk_index - b.chunk_index)
  for (const r of ordered) {
    const label =
      r.page_number != null
        ? tr('analysis.listing.refPage', { n: r.page_number })
        : r.section_label && r.section_label.trim().length > 0
          ? r.section_label.trim()
          : tr('analysis.listing.refSection', { n: r.chunk_index + 1 })
    if (!seen.has(label)) {
      seen.add(label)
      labels.push(label)
    }
    if (labels.length >= 4) break
  }
  const more = chunkIds.length > labels.length ? '…' : ''
  return labels.length > 0 ? ` (${labels.join(', ')}${more})` : ''
}

/** Build the full deterministic listing answer (Markdown). Scope is already applied by
 *  `aggregateExtractions`, so this only formats the result + resolves provenance labels. */
export function buildListingAnswer(
  db: Db,
  listing: ExtractionListing,
  tr: (key: MessageKey, params?: MessageParams) => string
): string {
  const kind = tr(KIND_KEY[listing.recordType])
  const unparsed =
    listing.unparsedChunks > 0 ? tr('analysis.listing.unparsedSuffix', { k: listing.unparsedChunks }) : ''
  const headParams: MessageParams = {
    kind,
    count: listing.items.length,
    scanned: listing.scannedChunks,
    unparsed
  }

  if (listing.items.length === 0) {
    return tr('analysis.listing.empty', headParams)
  }

  // RAG-1 (backend audit 2026-06-27): the "across the whole document" wording requires BOTH the
  // chunking invariant (every in-scope indexed doc is `fully_chunked`) AND actual scan coverage —
  // every in-scope chunk carries a `__scan__` marker (`scannedChunks >= totalChunks`). In a
  // MULTI-document scope where extraction ran on only some docs, `fullyChunked` is true but
  // `scannedChunks < totalChunks`, so we honestly fall back to the "sections scanned" wording
  // rather than over-claiming whole-document coverage (H7). The single-document fully-extracted
  // case still satisfies both conditions, so its wording is unchanged.
  const coverageWhole = listing.fullyChunked && listing.scannedChunks >= listing.totalChunks
  const headKey: MessageKey = coverageWhole
    ? 'analysis.listing.coverageWhole'
    : 'analysis.listing.coverageSections'
  const lines: string[] = [tr(headKey, headParams), '']
  for (const item of listing.items) {
    const refs = sectionRefs(db, item.sourceChunkIds, tr)
    lines.push(tr('analysis.listing.item', { value: item.value, count: item.count }) + refs)
  }
  lines.push('', tr('analysis.listing.caveat'))
  return lines.join('\n')
}
