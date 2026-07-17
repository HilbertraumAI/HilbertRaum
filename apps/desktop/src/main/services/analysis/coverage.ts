import type { Db } from '../db'
import type {
  Citation,
  CoverageInfo,
  CoverageTier,
  DocumentSummary
} from '../../../shared/types'
import { truncateByCodePoints } from '../text'

// Coverage + provenance reader for the deep-index summary tree (whole-document-analysis
// plan §4.5/§5.1 → rag-design §14.4). Pure DB reads — no model calls. Two honest jobs:
//
//   1. PROVENANCE — `reachableLeafChunkIds` walks `tree_edges` from the root down to the
//      leaf CHUNKS. Node summaries are derived context, NEVER `[Sn]` citations (M2) — only
//      the leaf SOURCE chunks become citations.
//
//   2. COVERAGE — `documentCoverage` reports BREADTH (reachable leaves ÷ chunk count) and
//      DEPTH (tier) as two separate statements (breadth ≠ fidelity, C1/L2). The whole-
//      document/100% claim is made ONLY for a `ready` tree, where the stored chunks are
//      provably the whole document (the `fully_chunked` invariant). A `building`/`stale`/
//      `pending` tree reports the partial reachable fraction, never 100%.
//
// All summary/node text stays CONTENT — these reads feed the renderer, never the audit log.

interface ChunkRow {
  id: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
  text: string
}

/** How many chunks the document has (the coverage denominator). */
export function documentChunkCount(db: Db, documentId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?')
    .get(documentId) as unknown as { n: number }
  return row?.n ?? 0
}

/** The document's root tree node, or null when there is no (ready/partial) tree. */
function rootNodeId(db: Db, documentId: string): string | null {
  const row = db
    .prepare('SELECT id FROM tree_nodes WHERE document_id = ? AND is_root = 1 LIMIT 1')
    .get(documentId) as unknown as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Walk `tree_edges` from the root to the leaf CHUNK ids, in document order. This is the
 * production provenance reader: "which source chunks does this deep-index summary rest on".
 * Returns ordered, de-duped chunk ids; empty when there is no root (no tree, or a torn-down
 * stale tree). Coverage = these reachable leaves ÷ the document's chunk count.
 */
export function reachableLeafChunkIds(db: Db, documentId: string): string[] {
  const root = rootNodeId(db, documentId)
  if (!root) return []
  const childEdges = db.prepare(
    'SELECT child_id, child_is_chunk FROM tree_edges WHERE parent_id = ? ORDER BY ordinal'
  )
  const seen = new Set<string>()
  // Visited NODE ids (BUG vuln-scan-2026-06-21). buildTree writes a strictly acyclic tree, so
  // this is defensive: should `tree_edges` ever hold a node→node cycle (DB corruption, or a
  // future builder bug), an unguarded recurse would overflow the stack and crash the read.
  // Skipping already-visited nodes makes the walk terminate (and tolerate a DAG) regardless.
  const visitedNodes = new Set<string>([root])
  const ordered: string[] = []
  // Iterative DFS in ordinal order so leaves come out in document order. A tree is shallow
  // (~log of chunk count) and bounded by MAX_CHUNKS_PER_DOCUMENT, so the walk is cheap.
  const walk = (nodeId: string): void => {
    const edges = childEdges.all(nodeId) as unknown as Array<{
      child_id: string
      child_is_chunk: number
    }>
    for (const e of edges) {
      if (e.child_is_chunk === 1) {
        if (!seen.has(e.child_id)) {
          seen.add(e.child_id)
          ordered.push(e.child_id)
        }
      } else if (!visitedNodes.has(e.child_id)) {
        visitedNodes.add(e.child_id)
        walk(e.child_id)
      }
    }
  }
  walk(root)
  return ordered
}

/**
 * The leaf SOURCE chunks behind a ready-tree summary, as `[Sn]` citations (M2-safe: only
 * real source chunks, never node summaries). Ordered by document order; the snippet is a
 * short head of the chunk text so `SourcesDisclosure` shows what fed the summary.
 */
export function documentLeafProvenance(db: Db, documentId: string, title: string): Citation[] {
  const ids = reachableLeafChunkIds(db, documentId)
  if (ids.length === 0) return []
  const rows = db
    .prepare(
      `SELECT id, source_label, page_number, section_label, text FROM chunks
       WHERE id IN (${ids.map(() => '?').join(', ')})`
    )
    .all(...ids) as unknown as ChunkRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: Citation[] = []
  ids.forEach((id, i) => {
    const r = byId.get(id)
    if (!r) return
    out.push({
      label: `S${i + 1}`,
      sourceTitle: r.source_label ?? title,
      pageNumber: r.page_number,
      section: r.section_label,
      // Cut by CODE POINT (F-15, the RAG-2 class): a raw slice(0, 280) could split a surrogate
      // pair and persist a snippet ending in a lone surrogate (permanent `�` in the sources panel).
      snippet: truncateByCodePoints(r.text, 280)
    })
  })
  return out
}

/** The deepest level present in a document's tree (the root's level); 0 when there is none. */
export function maxTreeLevel(db: Db, documentId: string): number {
  const row = db
    .prepare('SELECT MAX(level) AS m FROM tree_nodes WHERE document_id = ?')
    .get(documentId) as unknown as { m: number | null } | undefined
  return row?.m ?? 0
}

/**
 * The node summaries at one tree level, in `ordinal` order (whole-document-analysis plan
 * §4.5 tiers). Level 1 = the deepest summary layer (full leaf coverage — Tier 3); the layer
 * just below the root = the root's children (a section-by-section view — Tier 2). All reads,
 * no model calls.
 */
export function nodeSummariesAtLevel(db: Db, documentId: string, level: number): string[] {
  const rows = db
    .prepare(
      'SELECT summary_text FROM tree_nodes WHERE document_id = ? AND level = ? ORDER BY ordinal'
    )
    .all(documentId, level) as unknown as Array<{ summary_text: string }>
  return rows.map((r) => r.summary_text).filter((s) => s.trim().length > 0)
}

interface TreeRow {
  tree_status: string | null
  tree_meta_json: string | null
}

function treeLevelsOf(meta: string | null): number | undefined {
  if (!meta) return undefined
  try {
    const parsed = JSON.parse(meta) as { levels?: unknown }
    return typeof parsed.levels === 'number' && Number.isFinite(parsed.levels)
      ? parsed.levels
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Compute the honest coverage of a document's CURRENT summary (whole-document-analysis plan
 * §4.5). The summary (when present) decides tree-vs-capped: a deep-index summary is served
 * by `runSummary` with `truncated:false` + a `tier`, so:
 *   - tree `ready` + an untruncated summary ⇒ mode `tree`, whole-document coverage at `tier`;
 *   - a tree mid-build/stale/pending ⇒ mode `tree`, the PARTIAL reachable fraction (never
 *     100% — C1), so a meter rendered against it can't claim completeness;
 *   - otherwise (no usable tree) ⇒ mode `capped`, covering the beginning when `truncated`.
 * Pass `summary = null` to get the pure deep-index state (the row-level deep-index chip).
 */
export function documentCoverage(
  db: Db,
  documentId: string,
  summary: DocumentSummary | null
): CoverageInfo {
  const total = documentChunkCount(db, documentId)
  const treeRow = db
    .prepare('SELECT tree_status, tree_meta_json FROM documents WHERE id = ?')
    .get(documentId) as unknown as TreeRow | undefined
  const status = treeRow?.tree_status ?? null

  if (status === 'ready' && (!summary || summary.truncated === false)) {
    // A ready deep index AND a summary that came from it (untruncated): whole-document
    // coverage at the served tier. A summary made BEFORE the tree (truncated capped) is still
    // capped honesty even though a tree now exists — describe what the user is looking at.
    return {
      mode: 'tree',
      treeStatus: 'ready',
      chunksCovered: reachableLeafChunkIds(db, documentId).length,
      chunksTotal: total,
      treeLevels: treeLevelsOf(treeRow?.tree_meta_json ?? null),
      tier: (summary?.tier ?? 1) as CoverageTier,
      truncated: false
    }
  }
  if (
    summary === null &&
    (status === 'building' || status === 'pending' || status === 'stale')
  ) {
    // Pure deep-index state (the row-level chip / a standalone query — no summary to
    // describe). Partial reachable fraction, NEVER 100% (C1): the meter reports progress.
    return {
      mode: 'tree',
      treeStatus: status,
      chunksCovered: reachableLeafChunkIds(db, documentId).length,
      chunksTotal: total,
      treeLevels: treeLevelsOf(treeRow?.tree_meta_json ?? null),
      truncated: true
    }
  }

  // Capped map-reduce fallback (no usable deep index). A non-truncated capped summary still
  // covers the whole document (map-reduce over every window), just shallowly; a truncated one
  // honestly covers the beginning. The meter never prints "100%" for capped — it speaks words.
  return {
    mode: 'capped',
    chunksCovered: total,
    chunksTotal: total,
    truncated: summary?.truncated ?? false
  }
}
