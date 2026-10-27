// Data builders shared by the ZIM retrieval suites (the arm, its regressions, the prompt framing and the IPC session):
// an archive candidate, the arm's result shape around candidates, and the kiwix /search RSS body. Plain builders with no
// state; each adopting suite is their proof.
import type { ExternalRetrievalOutput } from '../../src/main/services/rag'
import type { ExternalCandidate } from '../../src/main/services/zim/arm'

/** One archive candidate. Defaults: pack `pack-1`, article `Artikel`, section `Abschnitt`; `n` numbers its chunk id. */
export function archiveCandidate(
  n: number,
  text: string,
  o: { packId?: string; article?: string; section?: string } = {}
): ExternalCandidate {
  const packId = o.packId ?? 'pack-1'
  const article = o.article ?? 'Artikel'
  return {
    chunkId: `zim:${packId}:${article}#${n}`,
    documentId: `zim:${packId}`,
    text,
    sourceTitle: article,
    pageNumber: null,
    sectionLabel: o.section ?? 'Abschnitt',
    score: 1,
    sourceKind: 'archive' as const,
    packId,
    archiveTitle: 'Wikipedia (Test)',
    articlePath: article
  }
}

/** The arm's result shape (`{ candidates, outcomes }`) with no outcomes, for cases about the candidate pipeline. */
export function testArm(...candidates: ExternalCandidate[]): ExternalRetrievalOutput {
  return { candidates, outcomes: [] }
}

/** Like `testArm`, plus the arm's `capped`-scope companion selection, the fallback `retrieve()` restricts to on a rerank failure. */
export function testArmWithCapped(
  candidates: ExternalCandidate[],
  cappedCandidates: ExternalCandidate[]
): ExternalRetrievalOutput {
  return { candidates, outcomes: [], cappedCandidates }
}

/** A kiwix `/search` RSS body: one item per title, linking `/content/<urlId>/<Title_with_underscores>`, each with `wordCount`. */
export function searchXml(urlId: string, titles: string[], wordCount = '1,000'): string {
  const items = titles
    .map(
      (t) =>
        `<item><title>${t}</title><link>/content/${urlId}/${encodeURIComponent(t.replace(/ /g, '_'))}</link><wordCount>${wordCount}</wordCount></item>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Search</title>${items}</channel></rss>`
}
