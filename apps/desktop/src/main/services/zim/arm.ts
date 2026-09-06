import type { RetrievedChunk } from '../rag'
import { CHUNK_DEFAULTS, chunkSegments } from '../ingestion/chunker'
import { fetchArticleHtml, searchPack } from './client'
import { zimArticleToSegmentsAsync } from './html'

// Query-time candidate production for the ZIM retrieval arm (knowledge packs).
// Per pack: Xapian full-text search (the archive's own index — the keyword stage we
// did not have to build) → fetch the top articles' raw HTML → segments → the SAME
// chunker documents go through → keep each article's few most query-relevant chunks.
// No embeddings, no persistence: the reranker downstream is what turns Xapian recall
// into precision (rag-design ZIM record; spike 2026-08-22 measured 82–165 ms for
// search + 5 article fetches end-to-end).

/** Top articles fetched per pack per question. */
export const ARTICLES_PER_PACK = 5
/** Chunks kept per article (query-term overlap picks them; the reranker re-scores). */
export const CHUNKS_PER_ARTICLE = 4
/** Global candidate ceiling across all packs — mirrors the document arm's ≤2×topKInitial scale. */
export const MAX_EXTERNAL_CANDIDATES = 24

export interface ArmPack {
  /** knowledge_packs.id (ZIM UUID) — the books.id search filter. */
  id: string
  /** Pack display title → Citation.archiveTitle. */
  title: string
}

export type ExternalCandidate = Omit<RetrievedChunk, 'label'>

/**
 * Produce candidates for one question across the given packs on a running sidecar.
 * A single pack failing (vanished mid-session, index quirk) is skipped — the other
 * packs and the document arm still answer.
 */
export async function collectPackCandidates(
  port: number,
  packs: readonly ArmPack[],
  question: string,
  signal?: AbortSignal,
  names?: ReadonlyMap<string, string>
): Promise<ExternalCandidate[]> {
  const terms = queryTerms(question)
  const out: ExternalCandidate[] = []
  for (const pack of packs) {
    if (out.length >= MAX_EXTERNAL_CANDIDATES) break
    let hits
    try {
      hits = await searchPack(port, pack.id, question, ARTICLES_PER_PACK, signal)
    } catch {
      continue // this pack only; never the whole ask
    }
    for (const hit of hits) {
      if (out.length >= MAX_EXTERNAL_CANDIDATES) break
      // The published serving map (`Published.names`, #301 P3b/L4) is the route authority. A
      // hit whose parsed `urlId` is not the name this pack is served under is SKIPPED —
      // defensive within one generation: the search was filtered by `books.id`, so a
      // disagreeing link would mean the response describes a book we did not ask about, and
      // fetching it would label another archive's text with this pack's title.
      const expected = names?.get(pack.id)
      if (expected !== undefined && hit.urlId !== expected) continue
      let html: string | null
      try {
        html = await fetchArticleHtml(port, expected ?? hit.urlId, hit.articlePath, signal)
      } catch {
        continue
      }
      if (!html) continue
      // Cooperatively sliced (P1b): the main thread is handed back between slices and the
      // ask signal is honoured at every slice boundary. Deliberately OUTSIDE the per-hit
      // catch above — a fetch failure skips one article, but an abort must propagate out of
      // collectPackCandidates rather than be swallowed into an empty candidate list.
      const article = await zimArticleToSegmentsAsync(html, { signal })
      const chunks = chunkSegments(article.segments, CHUNK_DEFAULTS)
      const scored = chunks
        .map((c, i) => ({ c, i, overlap: overlapScore(c.text, terms) }))
        .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
        .slice(0, CHUNKS_PER_ARTICLE)
      for (const { c, i, overlap } of scored) {
        out.push({
          chunkId: `zim:${pack.id}:${hit.articlePath}#${i}`,
          documentId: `zim:${pack.id}`,
          text: c.text,
          sourceTitle: article.title ?? hit.title,
          pageNumber: null,
          sectionLabel: c.sectionLabel ?? null,
          score: overlap,
          sourceKind: 'archive',
          packId: pack.id,
          archiveTitle: pack.title,
          articlePath: hit.articlePath
        })
      }
    }
  }
  return out.slice(0, MAX_EXTERNAL_CANDIDATES)
}

/** Distinct lowercase query terms of ≥3 letters/digits (unicode-aware). */
export function queryTerms(question: string): string[] {
  const terms = new Set<string>()
  for (const m of question.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) terms.add(m[0])
  return [...terms]
}

/** How many distinct query terms a chunk contains — the cheap per-article chunk picker.
 *  (Selection only; the reranker downstream does the real scoring.) */
export function overlapScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const hay = text.toLowerCase()
  let n = 0
  for (const t of terms) if (hay.includes(t)) n++
  return n
}
