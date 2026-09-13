import type { KnowledgePackOutcome } from '../../../shared/types'
import type { ExternalRetrievalOutput, RetrievedChunk } from '../rag'
import { admitArticle } from './admit'
import { CHUNK_DEFAULTS, chunkSegments } from '../ingestion/chunker'
import { germanCapitalizedNounTokens, norm, resolveHeadNoun } from './head-noun'
import { log } from '../logging'
import { fetchArticleHtml, searchPack, suggestTitles, type KiwixSearchHit } from './client'
import type { QueryExpander, SearchPlan } from './expand'
import { zimArticleToSegmentsAsync, type ZimArticle } from './html'
import { searchPattern } from './query-rewrite'

// Query-time candidate production for the ZIM retrieval arm (knowledge packs).
//
// Phase 4 PR-A (`docs/rag-design.md` §17 "Discovery port (Phase 4 PR-A)") ported route F's
// discovery semantics from the ZIM research programme into this arm: a planner that proposes
// title/query/term candidates (`expand.ts`), title reads through `/suggest` (both the plan's
// own titles and the ported 1a-i head-noun rule), full-text queries from the plan plus the
// plain pattern rewrite, a per-pack read budget, and the ported topic-conflict admission gate
// (`admit.ts`). Per pack: discover a small set of ADMITTED articles this way, then fetch their
// raw HTML → segments → the SAME chunker documents go through → keep each article's few most
// query-relevant chunks — exactly as before. No embeddings, no persistence: the reranker
// downstream is what turns recall into precision.
//
// FAIRNESS, CONCURRENCY, DEADLINE (#301 P4, finding M8; plan §9.21 (c)) — UNCHANGED by the
// discovery port. The packs arrive in ONE deterministic order (`retrievablePacks` orders by
// `title COLLATE NOCASE, id`), and every decision below is taken in THAT order:
//
//   1. each pack gets a provisional quota `q_i` (`packQuota`) that bounds how many CHUNKS it
//      may contribute — the article SET a pack fetches now comes from its own discovery pass,
//      but the chunk-building loop below still stops once the pack's quota is full;
//   2. at most `PACK_SEARCH_CONCURRENCY` packs are searched at a time, each worker doing one
//      pack's whole discovery-and-fetch sequentially under the signal it was handed;
//   3. ADMISSION happens only after every pack settled (`allocateCandidates`): round-robin in
//      pack order, one candidate per pack per round, until `MAX_EXTERNAL_CANDIDATES` are
//      admitted or every pack is exhausted. A short, empty or failed pack's slots are RECLAIMED
//      by the others.
//
// The per-ask DEADLINE is NOT created here: `ZimService.runArm` combines the ask signal with
// `EXTERNAL_RETRIEVAL_DEADLINE_MS` once per ask and hands the combined signal in, together with
// the ask's own signal as `opts.askSignal`. That pair is what lets this module tell a
// CANCELLATION (the user's, or a lock) from the DEADLINE.
//
// PER-PACK budget (a documented adaptation, see report.md "Deviations"): route F's `discover()`
// bounds ONE archive per question (≤14 reads / ≤8 admitted articles); the product can have
// several packs selected for one ask, so the budget below is applied PER PACK, mirroring how
// `packQuota` already scoped fetching per pack before this port. A single-pack ask — every
// acceptance measurement in this PR — is unaffected by the distinction.

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
/**
 * The per-probe timeout for a small JSON lookup — the planner's title-index calls
 * (`/suggest`, both the plan's own titles and the head-noun rule's probes). Deliberately
 * shorter than the client's 15 s default (`DEFAULT_TIMEOUT_MS`): a probe asks for one small
 * answer, and letting one sit out the default under the arm's single 20 s per-ask deadline
 * would starve every pack still waiting for its turn at `PACK_SEARCH_CONCURRENCY`.
 */
export const PROBE_TIMEOUT_MS = 3_000
/**
 * Chunks kept from a LIST article (`Liste der …`, `List of …`), instead of `CHUNKS_PER_ARTICLE`:
 * the name rows of a list carry none of the question's words, so the overlap picker would keep
 * only the intro and trim exactly the rows a "which … are the largest" question needs. The
 * reranker still scores every chunk against the original question.
 */
export const LIST_ARTICLE_CHUNKS = 8
const LIST_TITLE_RE = /^(Liste |List of )/

/** Per-pack read budget (Phase 4 PR-A; route F's own `discover()` defaults are 14 / 8 for its
 *  one archive — see the file header for why this arm applies the pair per pack instead). */
export const DISCOVERY_MAX_READS_PER_PACK = 12
export const DISCOVERY_MAX_ADMITTED_PER_PACK = 8
/** Head-noun reads: at most this many SUCCESSFUL reads, and at most this many total `/suggest`
 *  probes across every candidate word tried (route F's 1a-i patch, ported verbatim). */
export const HEAD_NOUN_MAX_READS = 2
export const HEAD_NOUN_MAX_TOTAL_PROBES = 12
export const HEAD_NOUN_MAX_PROBES_PER_WORD = 6
/** `/suggest` rows requested for one plan title (route F: `suggestTitles(..., title, 4, ...)`). */
export const TITLE_SUGGEST_ROWS = 4
/** `/search` rows requested for one FTS query (route F: `searchPack(..., q, 5, ...)`). */
export const FTS_HITS_PER_QUERY = 5
/** The "up to 2 more unseen candidates by aggregate score" pass — run twice (after the
 *  title/head-noun stage and again after the FTS stage, "both top-2 passes kept"). */
export const FTS_TOP_UNSEEN_PASS = 2

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
  /**
   * The budget for the small JSON probes — the title-index `/suggest` lookups (plan titles and
   * the head-noun rule), `PROBE_TIMEOUT_MS`. Test seam only; production never sets it.
   */
  probeTimeoutMs?: number
  /**
   * The ask's search planner — ONE local-model call per ask, before any pack is searched; its
   * titles/queries/terms feed the discovery routes below. Absent or resolving null ⇒ discovery
   * still runs, using only the plan-independent routes (the head-noun rule and the plain
   * pattern rewrite). Its abort is the ask's abort (rethrown).
   */
  expand?: QueryExpander
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
 * first `24 mod N` packs IN PACK ORDER. It bounds how many CHUNKS a pack contributes, not what
 * is admitted: the round-robin below reclaims a short pack's share for the others.
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

/** How one pack's discovery ended, before admission was computed. */
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

/** Read-budget accounting (Phase 4 PR-A) — pure, so it is unit-testable in isolation from any
 *  transport. A read is admitted only while BOTH the read count and the admitted-article count
 *  are under their limits; every route (head-noun, title, alias, fts) shares one instance of
 *  this per pack. */
export interface ReadBudgetLimits {
  maxReads: number
  maxAdmitted: number
}
export function withinReadBudget(reads: number, admitted: number, limits: ReadBudgetLimits): boolean {
  return reads < limits.maxReads && admitted < limits.maxAdmitted
}

/** One aggregate-scored discovery candidate — fed by both the title/head-noun suggest hits and
 *  the FTS hits, exactly like route F's shared `candidates` map (`prototype.mjs` `add()`). */
interface ScoredHit {
  hit: KiwixSearchHit
  score: number
}

/** Distinct, non-empty strings, first occurrence kept. */
function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (v.length === 0 || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Thrown internally by one pack's discovery to unwind every stage at once on the ask's own
 *  abort — never on an ordinary transport failure, which every route degrades on its own. */
class PackAbort {
  constructor(readonly err: unknown) {}
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

  // The plain pattern rewrite (#340 L3, D-Z18): Xapian ANDs every word of the pattern, so the
  // question's function and frame words are stripped before it is used as the LAST FTS query
  // below — the ORIGINAL question stays the reranker's query and the chunk picker's `terms`.
  const rewrite = searchPattern(question)

  // The ask's search plan — ONE model call, before any pack is searched, under the same
  // signal. Null/empty (no runtime, a non-JSON reply, the time bound, any failure) ⇒ discovery
  // proceeds with the plan-independent routes only; the ask's own abort propagates like every
  // other cancellation.
  let plan: SearchPlan = { titles: [], queries: [], terms: [] }
  if (opts.expand) {
    try {
      const resolved = await opts.expand(question, signal)
      if (resolved) plan = resolved
    } catch (err) {
      const cancelled = opts.askSignal ? opts.askSignal.aborted : aborted()
      if (cancelled) throw err
      // else: keep the default empty plan and continue exactly as if no planner existed.
    }
  }

  /** One pack's whole discovery-and-fetch pass (Phase 4 PR-A). */
  async function runPack(item: PackWork): Promise<void> {
    const { pack } = item
    // The published serving map (`Published.names`, #301 P3b/L4) is the route authority for
    // /suggest (which needs a name to query against) and the mismatch guard below.
    const expected = names?.get(pack.id)

    const seenTargets = new Set<string>()
    const scorePool = new Map<string, ScoredHit>()
    const admittedArticles: Array<{ article: ZimArticle; hit: KiwixSearchHit }> = []
    let reads = 0
    let fetchAttempts = 0
    let fetchedOk = 0
    /** Hits refused because the response's `urlId` was not the name we serve this pack under
     *  (#429) — a route disagreement, never "nothing relevant". */
    let mismatched = 0
    let searchAttempts = 0
    let searchFailures = 0

    const addScore = (hit: KiwixSearchHit, rank: number, bonus = 0): void => {
      const existing = scorePool.get(hit.articlePath)
      if (existing) existing.score += 1 / (rank + 1) + bonus
      else scorePool.set(hit.articlePath, { hit, score: 1 / (rank + 1) + bonus })
    }
    const topUnseen = (n: number): KiwixSearchHit[] =>
      [...scorePool.values()]
        .filter((e) => !seenTargets.has(e.hit.articlePath))
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .map((e) => e.hit)

    /** One candidate read: fetch, convert, admit. Bounded by the read budget and de-duplicated
     *  by target; a route disagreement (#429) is refused before any request is made. */
    async function readHit(hit: KiwixSearchHit, route: string): Promise<void> {
      if (!withinReadBudget(reads, admittedArticles.length, {
        maxReads: DISCOVERY_MAX_READS_PER_PACK,
        maxAdmitted: DISCOVERY_MAX_ADMITTED_PER_PACK
      })) {
        return
      }
      if (seenTargets.has(hit.articlePath)) return
      seenTargets.add(hit.articlePath)
      if (expected !== undefined && hit.urlId !== expected) {
        mismatched++
        return
      }
      reads++
      fetchAttempts++
      let html: string | null
      try {
        html = await fetchArticleHtml(port, expected ?? hit.urlId, hit.articlePath, signal, {
          timeoutMs: opts.articleTimeoutMs
        })
      } catch (err) {
        if (aborted()) throw new PackAbort(err)
        return
      }
      if (html === null) return // 404: the entry vanished between search and fetch
      // Cooperatively sliced (P1b): the main thread is handed back between slices and the
      // signal is honoured at every slice boundary.
      let article: ZimArticle
      try {
        article = await zimArticleToSegmentsAsync(html, { signal })
      } catch (err) {
        if (aborted()) throw new PackAbort(err)
        return
      }
      fetchedOk++
      // The admission gate (`admit.ts`) sees a bounded slice of the body — enough to catch the
      // topic-conflict signal without scanning an arbitrarily large article.
      const bodyText = article.segments
        .slice(0, 20)
        .map((s) => s.text)
        .join(' ')
        .slice(0, 4_000)
      const admission = admitArticle(question, article.title ?? hit.title, bodyText, route)
      if (!admission.admitted) return
      if (article.title !== null && admittedArticles.some((a) => a.article.title === article.title)) return
      admittedArticles.push({ article, hit })
    }

    try {
      // STAGE 1 — head-noun reads (the ported 1a-i rule): up to `HEAD_NOUN_MAX_READS`
      // successful reads, at most `HEAD_NOUN_MAX_TOTAL_PROBES` `/suggest` probes in total across
      // every candidate word tried. Runs BEFORE the plan titles, exactly like route F's patch.
      if (expected !== undefined) {
        const words = germanCapitalizedNounTokens(question)
        let issued = 0
        let totalProbes = 0
        for (const w of words) {
          if (issued >= HEAD_NOUN_MAX_READS || totalProbes >= HEAD_NOUN_MAX_TOTAL_PROBES) break
          const probeBudget = Math.min(HEAD_NOUN_MAX_PROBES_PER_WORD, HEAD_NOUN_MAX_TOTAL_PROBES - totalProbes)
          if (probeBudget <= 0) break
          const res = await resolveHeadNoun(port, expected, w, signal, {
            maxProbes: probeBudget,
            timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
          }).catch((err) => {
            throw new PackAbort(err) // resolveHeadNoun only ever rejects on the ask's own abort
          })
          totalProbes += res.probes
          if (res.accepted) {
            const before = admittedArticles.length
            await readHit(res.accepted, 'head-noun')
            if (admittedArticles.length > before) issued++
          }
        }
      }

      // STAGE 2 — plan titles: a `/suggest` lookup per title, admission exact-or-prefix (the
      // same predicate route F's `discover()` uses), then an immediate fetch of the first
      // admitted hit. Every matching hit (not just the fetched one) feeds the aggregate score
      // pool the next pass drains.
      if (expected !== undefined) {
        for (const title of plan.titles) {
          let hits: KiwixSearchHit[] = []
          try {
            hits = await suggestTitles(port, expected, title, TITLE_SUGGEST_ROWS, signal, {
              timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
            })
          } catch (err) {
            if (aborted()) throw new PackAbort(err)
            hits = []
          }
          const target = norm(title)
          const multiWord = title.includes(' ')
          let admittedHit: KiwixSearchHit | null = null
          hits.forEach((h, hidx) => {
            const matches =
              norm(h.title) === target || norm(h.title).startsWith(`${target} (`) || (multiWord && hidx === 0)
            if (!matches) return
            addScore(h, hidx, multiWord ? 2 : 0.2)
            if (admittedHit === null) admittedHit = h
          })
          if (admittedHit !== null) await readHit(admittedHit, 'title')
        }
      }

      // STAGE 2b — up to `FTS_TOP_UNSEEN_PASS` more unseen candidates by aggregate score, drawn
      // from whatever the head-noun and title-suggest routes scored so far ("both top-2 passes
      // kept" — this is the first of the two).
      for (const hit of topUnseen(FTS_TOP_UNSEEN_PASS)) await readHit(hit, 'alias')

      // STAGE 3 — full-text queries: the plan's own queries, then the plain pattern rewrite
      // LAST. The rank-1 hit of each query is read immediately; every hit (every rank) feeds
      // the same aggregate score pool.
      const queries = uniqueStrings([...plan.queries, rewrite.pattern])
      for (const q of queries) {
        searchAttempts++
        let hits: KiwixSearchHit[] = []
        try {
          hits = await searchPack(port, pack.id, q, FTS_HITS_PER_QUERY, signal)
        } catch (err) {
          if (aborted()) throw new PackAbort(err)
          searchFailures++
          hits = []
        }
        hits.forEach((h, i) => addScore(h, i))
        if (hits[0]) await readHit(hits[0], 'fts')
      }

      // STAGE 3b — the second top-2-by-aggregate-score pass, now over the FULL pool (title/
      // head-noun suggests AND every FTS hit) — "both top-2 passes kept".
      for (const hit of topUnseen(FTS_TOP_UNSEEN_PASS)) await readHit(hit, 'fts')
    } catch (err) {
      if (err instanceof PackAbort) {
        noteAbort(err.err)
        return
      }
      throw err
    }

    // #429: a pack whose every hit disagreed about its own serving name settles `read-failed`,
    // never a silent "searched, nothing found" — logged with the pack id and the two NAMES
    // (route identifiers, never a path — the sentinel rule).
    if (fetchAttempts === 0 && mismatched > 0) {
      log.warn('Knowledge pack served under a name its own search results do not use', {
        packId: pack.id,
        servedAs: expected ?? null,
        hitsSkipped: mismatched
      })
    }

    item.settlement = admittedArticles.length > 0
      ? 'searched'
      : fetchAttempts > 0
        ? fetchedOk === 0
          ? 'read-failed'
          : 'searched'
        : mismatched > 0
          ? 'read-failed'
          : searchAttempts > 0 && searchFailures === searchAttempts
            ? 'search-failed'
            : 'searched'
    item.settled = true

    // Build this pack's candidates from the admitted articles, in discovery order — unchanged
    // chunking semantics (`html.ts`/`chunker.ts`): chunk, keep the query-overlap top slice
    // (more for a LIST article), bounded by the pack's own fair-share quota.
    for (const { article, hit } of admittedArticles) {
      if (item.candidates.length >= item.quota) break
      const chunks = chunkSegments(article.segments, CHUNK_DEFAULTS)
      const title = article.title ?? hit.title
      const wanted = LIST_TITLE_RE.test(title) ? LIST_ARTICLE_CHUNKS : CHUNKS_PER_ARTICLE
      const scored = chunks
        .map((c, i) => ({ c, i, overlap: overlapScore(c.text, terms) }))
        .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
        .slice(0, wanted)
      for (const { c, i, overlap } of scored) {
        item.candidates.push({
          chunkId: `zim:${pack.id}:${hit.articlePath}#${i}`,
          documentId: `zim:${pack.id}`,
          text: c.text,
          sourceTitle: title,
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

  // A pool of `PACK_SEARCH_CONCURRENCY` workers over the ordered queue. Each worker takes the
  // next pack and does its whole discovery-and-fetch pass sequentially, so at most two packs
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
