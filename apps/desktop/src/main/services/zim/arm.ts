import type { KnowledgePackOutcome } from '../../../shared/types'
import type { ExternalRetrievalOutput, RetrievedChunk } from '../rag'
import { CHUNK_DEFAULTS, chunkSegments } from '../ingestion/chunker'
import { fetchArticleHtml, searchPack, searchPackTotal } from './client'
import { zimArticleToSegmentsAsync } from './html'
import { DF_PROBE_MAX_TERMS, narrowByFrequency, searchPattern } from './query-rewrite'

// Query-time candidate production for the ZIM retrieval arm (knowledge packs).
// Per pack: Xapian full-text search (the archive's own index — the keyword stage we
// did not have to build) → fetch the top articles' raw HTML → segments → the SAME
// chunker documents go through → keep each article's few most query-relevant chunks.
// No embeddings, no persistence: the reranker downstream is what turns Xapian recall
// into precision (rag-design ZIM record; spike 2026-08-22 measured 82–165 ms for
// search + 5 article fetches end-to-end).
//
// FAIRNESS, CONCURRENCY, DEADLINE (#301 P4, finding M8; plan §9.21 (c)). The pre-P4 arm
// walked the packs in DB order and stopped at the first 24 candidates, so pack A exhausted
// the budget and pack C was never even searched (reproduced: 24 = 20 A + 4 B). Now:
//
//   1. the packs arrive in ONE deterministic order (`retrievablePacks` orders by
//      `title COLLATE NOCASE, id`), and every decision below is taken in THAT order —
//      never in completion order, so a slow pack cannot change the result;
//   2. each pack gets a provisional quota `q_i` (`packQuota`) that only bounds ITS FETCHING:
//      articles are fetched in hit order until the pack holds `q_i` candidates (at most
//      `ARTICLES_PER_PACK` articles, at most `CHUNKS_PER_ARTICLE` chunks per article);
//   3. at most `PACK_SEARCH_CONCURRENCY` packs are searched at a time, each worker doing one
//      pack's search then fetches then conversions sequentially under the signal it was handed;
//   4. ADMISSION happens only after every pack settled (`allocateCandidates`): round-robin in
//      pack order, one candidate per pack per round in the pack's own rank order, until
//      `MAX_EXTERNAL_CANDIDATES` are admitted or every pack is exhausted. A short, empty or
//      failed pack's slots are RECLAIMED by the others (bounded by what they already fetched —
//      a reclaim never triggers a further request), and a pack that finished last still gets
//      its best hit in front of another pack's second-best.
//
// The per-ask DEADLINE is NOT created here: `ZimService.runArm` combines the ask signal with
// `EXTERNAL_RETRIEVAL_DEADLINE_MS` once per ask (outside the request guard, so the one admitted
// retry inherits the remaining time) and hands the combined signal in, together with the ask's
// own signal as `opts.askSignal`. That pair is what lets this module tell a CANCELLATION (the
// user's, or a lock) from the DEADLINE: a cancellation rethrows the `AbortError` and reports
// nothing, while the deadline keeps everything already assembled and reports `timeout` for the
// pack that was in flight and `deadline` for the packs never started.

/** Top articles fetched per pack per question (an UPPER bound, not a quota). */
export const ARTICLES_PER_PACK = 5
/** Chunks kept per article (query-term overlap picks them; the reranker re-scores). */
export const CHUNKS_PER_ARTICLE = 4
/** Global candidate ceiling across all packs — mirrors the document arm's 2x topKInitial scale. */
export const MAX_EXTERNAL_CANDIDATES = 24
/** How many packs are searched at a time (plan §9.21 (c)4). */
export const PACK_SEARCH_CONCURRENCY = 2
/**
 * The whole archive arm's budget for ONE ask (plan §9.21 (c)5), shared by the request guard's
 * attempt and its single admitted retry. Above the client's 15 s per-request timeout for
 * `/search` and above an article read's full stall budget (`ARTICLE_READ_TIMEOUT_MS` ×
 * `ARTICLE_READ_ATTEMPTS` = 12 s, #301 P7 T19), so one hung request cannot swallow the entire
 * budget, while a long sequence of timeouts still ends.
 */
export const EXTERNAL_RETRIEVAL_DEADLINE_MS = 20_000

export interface ArmPack {
  /** knowledge_packs.id (ZIM UUID) — the books.id search filter. */
  id: string
  /** Pack display title → Citation.archiveTitle and the outcome's `title`. */
  title: string
}

export type ExternalCandidate = Omit<RetrievedChunk, 'label'>

export interface CollectPackCandidatesOptions {
  /**
   * The ask's OWN signal (`op.signal`), when the caller handed in a combined deadline signal as
   * `signal`. It is the only way to tell the two aborts apart: when `signal` fired but this one
   * did not, the per-ask deadline elapsed (an outcome), otherwise the ask was cancelled (an
   * `AbortError`, never an outcome). Absent ⇒ every abort is treated as a cancellation.
   */
  askSignal?: AbortSignal
  /**
   * The per-ATTEMPT `/raw` timeout of the stall retry (`ARTICLE_READ_TIMEOUT_MS`, #301 P7 T19).
   * Test seam only, so the "one article's first read stalls" leg does not sit out the real 4 s.
   * Production never sets it.
   */
  articleTimeoutMs?: number
}

/** One pack's produced candidates, in the pack's own rank order (search hit order). */
export interface PackCandidateList {
  packId: string
  candidates: readonly ExternalCandidate[]
}

/** What `allocateCandidates` decided: the admitted candidates and each pack's share. */
export interface CandidateAllocation {
  admitted: ExternalCandidate[]
  admittedPerPack: Map<string, number>
}

/**
 * The provisional per-pack fetch quota (plan §9.21 (c)3): `floor(24 / N)` plus one for the
 * first `24 mod N` packs IN PACK ORDER. It bounds how much a pack FETCHES, not what it is
 * admitted: the round-robin below reclaims a short pack's share for the others.
 */
export function packQuota(index: number, total: number): number {
  if (total <= 0) return 0
  const base = Math.floor(MAX_EXTERNAL_CANDIDATES / total)
  return base + (index < MAX_EXTERNAL_CANDIDATES % total ? 1 : 0)
}

/**
 * Admit candidates fairly across the packs (plan §9.21 (c)3). Round-robin in PACK ORDER, one
 * candidate per pack per round in that pack's own rank order, until `MAX_EXTERNAL_CANDIDATES`
 * are admitted or every pack is exhausted.
 *
 * Pure and completion-order independent BY CONSTRUCTION: it reads a list built from the pack
 * order the caller was handed, never the order in which the packs happened to finish, so the
 * same per-pack material always yields the same admitted set.
 */
export function allocateCandidates(perPack: readonly PackCandidateList[]): CandidateAllocation {
  const admitted: ExternalCandidate[] = []
  const admittedPerPack = new Map<string, number>()
  for (const pack of perPack) {
    if (!admittedPerPack.has(pack.packId)) admittedPerPack.set(pack.packId, 0)
  }
  const cursors = perPack.map(() => 0)
  let progressed = true
  while (admitted.length < MAX_EXTERNAL_CANDIDATES && progressed) {
    progressed = false
    for (let i = 0; i < perPack.length; i++) {
      if (admitted.length >= MAX_EXTERNAL_CANDIDATES) break
      const list = perPack[i]!.candidates
      const cursor = cursors[i]!
      if (cursor >= list.length) continue
      cursors[i] = cursor + 1
      admitted.push(list[cursor]!)
      const id = perPack[i]!.packId
      admittedPerPack.set(id, (admittedPerPack.get(id) ?? 0) + 1)
      progressed = true
    }
  }
  return { admitted, admittedPerPack }
}

/** How one pack's search ended, before admission was computed. */
type PackSettlement = 'searched' | 'search-failed' | 'read-failed'

interface PackWork {
  pack: ArmPack
  quota: number
  /** A worker picked this pack up (so a deadline hitting now is a `timeout`, not a `deadline`). */
  started: boolean
  /** The pack ran to its own end (its outcome is `settlement`, whatever happens afterwards). */
  settled: boolean
  settlement: PackSettlement
  candidates: ExternalCandidate[]
}

/**
 * Produce candidates for one question across the given packs on a running sidecar, plus one
 * outcome per pack (plan §9.21 (c)/(e)2). A single pack failing (vanished mid-session, index
 * quirk, every article unreadable) is reported as ITS OWN outcome — the other packs and the
 * document arm still answer.
 *
 * The packs must arrive in the deterministic order the allocation is defined over
 * (`retrievablePacks`' `title COLLATE NOCASE, id`); the caller owns that ordering.
 */
export async function collectPackCandidates(
  port: number,
  packs: readonly ArmPack[],
  question: string,
  signal?: AbortSignal,
  names?: ReadonlyMap<string, string>,
  opts: CollectPackCandidatesOptions = {}
): Promise<ExternalRetrievalOutput> {
  const terms = queryTerms(question)
  const work: PackWork[] = packs.map((pack, i) => ({
    pack,
    quota: packQuota(i, packs.length),
    started: false,
    settled: false,
    settlement: 'searched',
    candidates: []
  }))

  /** The first abort a request or a conversion raised — rethrown verbatim for a cancellation. */
  let abortFailure: unknown
  const aborted = (): boolean => signal?.aborted === true
  const noteAbort = (err: unknown): void => {
    if (abortFailure === undefined) abortFailure = err
  }

  // #340 L3 (D-Z18) + #353: Xapian ANDs every word of the pattern, so the question's function
  // and frame words are stripped before the search; the ORIGINAL question stays the reranker's
  // query and the chunk picker's `terms`. Three stages, each tried only when the one before it
  // found nothing:
  //   1. the stripped `pattern`;
  //   2. once, the narrower `retry` (the kept terms of five or more characters) when it differs;
  //   3. the #353 document-frequency LADDER — stage 2's length threshold cannot help a pattern
  //      whose every term is already that long (a rare or misspelled five-plus-character word).
  //      When the last pattern tried still has two or more terms, probe each term's own
  //      archive-wide hit count (`searchPackTotal`, pageLength=1, up to `DF_PROBE_MAX_TERMS`
  //      terms, sequentially) and search once more without the term `narrowByFrequency` picks
  //      as the likely culprit. A probe (or the narrowed search) failing ends the ladder without
  //      a verdict: stages 1–2 already answered honestly at zero, so the pack stays `searched`
  //      with 0 found rather than `search-failed` (`docs/rag-design.md` §17 D-Z18 amendment).
  const rewrite = searchPattern(question)
  async function runPack(item: PackWork): Promise<void> {
    const { pack } = item
    let hits
    let lastPattern = rewrite.pattern
    try {
      hits = await searchPack(port, pack.id, rewrite.pattern, ARTICLES_PER_PACK, signal)
      if (hits.length === 0 && rewrite.retry !== null) {
        lastPattern = rewrite.retry
        hits = await searchPack(port, pack.id, rewrite.retry, ARTICLES_PER_PACK, signal)
      }
    } catch (err) {
      if (aborted()) return noteAbort(err)
      // Non-200 (a 404 included — ambiguous, never a capability verdict) or a network error.
      item.settlement = 'search-failed'
      item.settled = true
      return
    }
    if (hits.length === 0) {
      const terms = lastPattern.split(/\s+/).filter((t) => t.length > 0)
      if (terms.length >= 2) {
        const probeTerms = terms.slice(0, DF_PROBE_MAX_TERMS)
        const df = new Map<string, number>()
        try {
          for (const term of probeTerms) {
            const total = await searchPackTotal(port, pack.id, term, signal)
            if (total !== null) df.set(term, total)
          }
          const narrowed = narrowByFrequency(probeTerms, df)
          if (narrowed !== null) {
            hits = await searchPack(port, pack.id, narrowed, ARTICLES_PER_PACK, signal)
          }
        } catch (err) {
          if (aborted()) return noteAbort(err)
          // Fail-soft (see the stage-3 comment above): keep the honest zero from stages 1–2.
        }
      }
    }
    let attempted = 0
    let read = 0
    for (const hit of hits) {
      // Article requests are DERIVED FROM NEED (plan §9.21 (c)3): once the pack holds its
      // provisional quota, the remaining hits are not fetched at all.
      if (item.candidates.length >= item.quota) break
      if (attempted >= ARTICLES_PER_PACK) break
      // The published serving map (`Published.names`, #301 P3b/L4) is the route authority. A
      // hit whose parsed `urlId` is not the name this pack is served under is SKIPPED —
      // defensive within one generation: the search was filtered by `books.id`, so a
      // disagreeing link would mean the response describes a book we did not ask about, and
      // fetching it would label another archive's text with this pack's title.
      const expected = names?.get(pack.id)
      if (expected !== undefined && hit.urlId !== expected) continue
      attempted++
      let html: string | null
      try {
        html = await fetchArticleHtml(port, expected ?? hit.urlId, hit.articlePath, signal, {
          timeoutMs: opts.articleTimeoutMs
        })
      } catch (err) {
        if (aborted()) return noteAbort(err)
        continue
      }
      if (html === null) continue // 404: the entry vanished between search and fetch
      read++
      // Cooperatively sliced (P1b): the main thread is handed back between slices and the
      // signal is honoured at every slice boundary. An abort here is the ask's or the
      // deadline's and is classified below; any other converter failure costs this ONE
      // article, never the pack's outcome and never the other packs'.
      let article
      try {
        article = await zimArticleToSegmentsAsync(html, { signal })
      } catch (err) {
        if (aborted()) return noteAbort(err)
        continue
      }
      const chunks = chunkSegments(article.segments, CHUNK_DEFAULTS)
      const scored = chunks
        .map((c, i) => ({ c, i, overlap: overlapScore(c.text, terms) }))
        .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
        .slice(0, CHUNKS_PER_ARTICLE)
      for (const { c, i, overlap } of scored) {
        item.candidates.push({
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
    // Hits existed and every single fetch of them failed: a materially different state from
    // "searched, nothing relevant" — the pack IS searchable, its articles were not readable.
    item.settlement = attempted > 0 && read === 0 ? 'read-failed' : 'searched'
    item.settled = true
  }

  // A pool of `PACK_SEARCH_CONCURRENCY` workers over the ordered queue. Each worker takes the
  // next pack and does its search, fetches and conversions sequentially, so at most two packs
  // are ever in flight, whatever the pack count.
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted()) return
      const index = next++
      if (index >= work.length) return
      const item = work[index]!
      item.started = true
      await runPack(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PACK_SEARCH_CONCURRENCY, work.length) }, () => worker())
  )

  // A cancellation is NEVER an outcome (plan §9.21 (c)5): the ask was aborted, or the workspace
  // locked, and the caller must see the `AbortError`. Only the deadline degrades to outcomes.
  if (aborted() && isCancellation(opts.askSignal)) {
    throw abortFailure ?? new DOMException('The knowledge-pack ask was cancelled', 'AbortError')
  }

  const allocation = allocateCandidates(
    work.map((item) => ({ packId: item.pack.id, candidates: item.candidates }))
  )
  const outcomes: KnowledgePackOutcome[] = work.map((item) => {
    const base = {
      packId: item.pack.id,
      title: item.pack.title,
      found: item.candidates.length,
      admitted: allocation.admittedPerPack.get(item.pack.id) ?? 0
    }
    if (!item.settled) {
      // The deadline caught it: in flight ⇒ `timeout`, never picked up ⇒ `deadline`.
      return item.started
        ? { ...base, status: 'failed' as const, reason: 'timeout' as const }
        : { ...base, status: 'skipped' as const, reason: 'deadline' as const }
    }
    if (item.settlement === 'searched') {
      return { ...base, status: 'searched' as const, reason: null }
    }
    return { ...base, status: 'failed' as const, reason: item.settlement }
  })
  return { candidates: allocation.admitted, outcomes }
}

/** True when the abort came from the ask itself (a cancellation) rather than the deadline. */
function isCancellation(askSignal: AbortSignal | undefined): boolean {
  if (askSignal === undefined) return true // no deadline was combined in: it can only be the ask
  return askSignal.aborted
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
