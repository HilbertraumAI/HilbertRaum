import type { KnowledgePackOutcome } from '../../../shared/types'
import type { ExternalRetrievalOutput, RetrievedChunk } from '../rag'
import type { RerankScope } from '../rag/rerank-profile'
import { admitArticle } from './admit'
import { CHUNK_DEFAULTS, chunkSegments } from '../ingestion/chunker'
import { germanCapitalizedNounTokens, norm, resolveHeadNoun } from './head-noun'
import { log } from '../logging'
import { fetchArticleHtml, searchPack, suggestTitles, type KiwixSearchHit } from './client'
import type { QueryExpander, SearchPlan } from './expand'
import { zimArticleToSegmentsAsync, type ZimArticle } from './html'
import { searchPattern } from './query-rewrite'
import { foldSupSub } from './supsub'

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
// PER-PACK budget (a documented adaptation — `docs/rag-design.md` §17 "Discovery port (Phase 4
// PR-A)"): route F's `discover()`
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
/** The one definition of "this is a list article" — used below and exported so an offline
 *  reconstruction of the widened scopes from a captured `all`-scope pack (deriving
 *  `top96`/`top48`/`capped` without re-running discovery) can classify a captured title exactly
 *  as this module does, never a second copy of the pattern. */
export function isListArticleTitle(title: string): boolean {
  return LIST_TITLE_RE.test(title)
}

// Phase 4 PR-B (step 4-4, ruling (a)): the candidate SCOPE per hardware profile
// (`rag/rerank-profile.ts`) is a pure widening of the SAME per-article overlap-pick construction
// `capped` (today, unchanged) already does — never a re-implementation. `top48`/`top96` double/
// quadruple both the per-article slice and the total pack-quota cap; `all` (the bgeP recipe)
// drops both bounds entirely (every chunk of every admitted article, no per-article slice, no
// total cap — the pack quota does not bind). `top48` is therefore a SUPERSET of `capped` (the
// same articles in the same order, each article's top-4/top-8 ⊆ its top-8/top-16), `top96` a
// superset of `top48`, and `all` a superset of `top96` — pinned in `zim-arm.test.ts`.
/** Per-article chunk budget for a scope (Frozen parameters, step 4-4). `Infinity` for `all` —
 *  `Array.prototype.slice(0, Infinity)` returns the whole array, so no special-casing is needed
 *  where this feeds a `.slice()`. */
export function perArticleBudget(scope: RerankScope, isList: boolean): number {
  const base = isList ? LIST_ARTICLE_CHUNKS : CHUNKS_PER_ARTICLE
  switch (scope) {
    case 'capped':
      return base
    case 'top48':
      return base * 2
    case 'top96':
      return base * 4
    case 'all':
      return Number.POSITIVE_INFINITY
  }
}
/**
 * Per-call document ceiling for the `all` scope (step 4-5, ruling (e)(ii); B3 with B7/B20).
 * `all` stays "every chunk of every admitted article" — `perArticleBudget('all', …)` is
 * UNCHANGED, still `Number.POSITIVE_INFINITY` — but the TOTAL a single rerank call may see is
 * now bounded, because run L (step 4-4) measured the unbounded pool producing a 755-document
 * call at 10,774 ms, 74 ms under this PR's own 10,848 ms bound, on a SINGLE pack; a multi-pack
 * ask (up to `MAX_SELECTED_PACKS` = 12, `shared/types.ts`) has no such margin.
 *
 * FROZEN by run L2 (step 4-5, 2026-09-16) — a two-pack development latency read on the
 * `cpu50` set (`wikipedia_de_all_nopic_2026-01.zim` + `wikipedia_de_climate-change_nopic_
 * 2026-07.zim`), `programme-state/steps/4-5-product-pr-rerank-profiles-2/artifacts/
 * scope-selection-2.json` + `run-l2-latency.json`. Pre-registered selection rule: the largest
 * of {192, 256, 384, 512} whose two-pack rerank p90 is at or under the 10,848 ms bound (4-i
 * M1's shipped CPU rerank median per question), else 192 with the miss reported. Selected:
 * **512 — no miss** (p90 by cell: 192 → 2,251 ms, 256 → 2,763 ms, 384 → 2,870 ms, 512 →
 * 2,816 ms; n=43 calls each; the genuinely uncapped two-pack distribution itself — mean 115.8
 * documents, p90 260, max 553 — measured p90 3,007 ms, also comfortably under the bound). Every
 * cell cleared with wide margin on this measurement's document-count distribution, so the
 * widest predefined cell wins; a future pack combination producing materially larger per-call
 * counts (run L's own single-pack worst case was 755 documents at 10,774 ms) is the case this
 * ceiling exists to bound.
 */
export const ALL_SCOPE_MAX_DOCS = 512

/** Total admitted-candidate cap for a scope (Frozen parameters, step 4-4; `all` capped by
 *  step 4-5 ruling (e)(ii)) — what `packQuota` and `allocateCandidates` bound against instead
 *  of the bare `MAX_EXTERNAL_CANDIDATES` constant. */
export function totalCandidateCapFor(scope: RerankScope): number {
  switch (scope) {
    case 'capped':
      return MAX_EXTERNAL_CANDIDATES
    case 'top48':
      return MAX_EXTERNAL_CANDIDATES * 2
    case 'top96':
      return MAX_EXTERNAL_CANDIDATES * 4
    case 'all':
      return ALL_SCOPE_MAX_DOCS
  }
}
/**
 * The pure per-article selection itself (run L, step 4-4, calls this OFFLINE on captured
 * per-pack material to derive `top96`/`top48`/`capped` from the SAME `all`-scope capture — never
 * a separate re-implementation of the picker). `chunks` is one article's chunks in NATURAL
 * (chunker) order, each already scored by `overlapScore`; the result is overlap-desc, index-asc,
 * exactly as `capped` orders them today, sliced to the scope's `perArticleBudget`.
 */
export function chunksForScope<T extends { index: number; overlap: number }>(
  chunks: readonly T[],
  scope: RerankScope,
  isList: boolean
): T[] {
  const wanted = perArticleBudget(scope, isList)
  return [...chunks].sort((a, b) => b.overlap - a.overlap || a.index - b.index).slice(0, wanted)
}

/** Per-pack read budget (Phase 4 PR-A; route F's own `discover()` defaults are 14 / 8 for its
 *  one archive — see the file header for why this arm applies the pair per pack instead). */
export const DISCOVERY_MAX_READS_PER_PACK = 12
export const DISCOVERY_MAX_ADMITTED_PER_PACK = 8
/** Head-noun reads: at most this many ACCEPTED `/suggest` matches issued to `readHit` (F4, review
 *  2026-09-14: counts acceptances, not admissions — a read that 404s, duplicates, or fails the
 *  gate still spends its slot, exactly like the frozen 1a-i patch's unconditional `issued++`),
 *  and at most this many total `/suggest` probes across every candidate word tried (route F's
 *  1a-i patch, ported verbatim). */
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
  /**
   * The candidate scope for this ask (step 4-4, `rag/rerank-profile.ts`'s `rerankScopeFor`):
   * how many chunks per admitted article, and how many in total, `allocateCandidates` may admit.
   * Absent ⇒ `'capped'` — today's behaviour, byte-identical to every existing caller and test.
   */
  candidateScope?: RerankScope
  /**
   * Step 4-5 (run L2, ruling (e)(ii)): overrides `totalCandidateCapFor(candidateScope)` for
   * THIS call's total admission cap — measurement/test seam only, mirroring
   * `articleTimeoutMs`/`probeTimeoutMs` above; production never sets it. Needed because run L2
   * must capture the genuinely UNCAPPED `all` candidate list (per id, per pack) to derive every
   * ceiling {192, 256, 384, 512} offline from ONE capture; once `ALL_SCOPE_MAX_DOCS` ships
   * finite (this step), an ordinary `candidateScope: 'all'` call truncates at that value, which
   * would make every WIDER cell derived from it measure identically to the narrowest one — a
   * methodologically unsound "the wider cell always clears the bound" result. The `capped`
   * companion selection (`cappedCandidates`, ruling (e)(i)) is UNAFFECTED: it always uses
   * `totalCandidateCapFor('capped')`, never this override.
   */
  totalCandidateCapOverride?: number
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
 * The provisional per-pack fetch quota (plan §9.21 (c)3): `floor(cap / N)` plus one for the
 * first `cap mod N` packs IN PACK ORDER. It bounds how many CHUNKS a pack contributes, not what
 * is admitted: the round-robin below reclaims a short pack's share for the others. `cap`
 * defaults to `MAX_EXTERNAL_CANDIDATES` (today's `capped` scope, byte-identical to every
 * existing caller); step 4-4 passes `totalCandidateCapFor(scope)` for a wider scope.
 */
export function packQuota(index: number, total: number, cap: number = MAX_EXTERNAL_CANDIDATES): number {
  if (total <= 0) return 0
  const base = Math.floor(cap / total)
  // Step 4-5 (ruling (e)(ii)): `all` no longer passes `cap = Infinity` — `totalCandidateCapFor('all')`
  // is `ALL_SCOPE_MAX_DOCS` (512), a genuine finite cap, so this "+1 for the first `cap mod N`
  // packs" term DOES fire under `all` now (e.g. 512 / 12 packs → `512 % 12 = 8`, so the first
  // eight packs get one extra), exactly like every other finite-cap scope — the non-uniform-quota
  // case 4-4's B10 flagged. Only an explicit `Number.POSITIVE_INFINITY` (the run-L2 measurement
  // seam, `totalCandidateCapOverride`) still hits the `NaN`/always-0 case this comment used to
  // describe unconditionally.
  return base + (index < cap % total ? 1 : 0)
}

/**
 * Admit candidates fairly across the packs (plan §9.21 (c)3). Round-robin in PACK ORDER, one
 * candidate per pack per round in that pack's own rank order, until `MAX_EXTERNAL_CANDIDATES`
 * are admitted or every pack is exhausted.
 *
 * Pure and completion-order independent BY CONSTRUCTION: it reads a list built from the pack
 * order the caller was handed, never the order in which the packs happened to finish, so the
 * same per-pack material always yields the same admitted set.
 *
 * `cap` defaults to `MAX_EXTERNAL_CANDIDATES` (today's `capped` scope, byte-identical to every
 * existing caller); step 4-4 passes `totalCandidateCapFor(scope)`, which step 4-5 (ruling
 * (e)(ii)) made finite for EVERY scope including `all` (`ALL_SCOPE_MAX_DOCS`, 512) — the loop
 * below now always stops at a fixed count. Only the measurement-only `totalCandidateCapOverride`
 * seam (run L2) can still pass `Number.POSITIVE_INFINITY`, in which case the loop runs until
 * every pack's cursor is exhausted instead.
 */
export function allocateCandidates(
  perPack: readonly PackCandidateList[],
  cap: number = MAX_EXTERNAL_CANDIDATES
): CandidateAllocation {
  const admitted: ExternalCandidate[] = []
  const admittedPerPack = new Map<string, number>()
  for (const pack of perPack) {
    if (!admittedPerPack.has(pack.packId)) admittedPerPack.set(pack.packId, 0)
  }
  const cursors = perPack.map(() => 0)
  let progressed = true
  while (admitted.length < cap && progressed) {
    progressed = false
    for (let i = 0; i < perPack.length; i++) {
      if (admitted.length >= cap) break
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
  /**
   * Step 4-5 (ruling (e)(i), B3/B7): this pack's OWN quota under the `capped` scope, computed
   * alongside `quota` regardless of the ask's actual scope — the companion selection a
   * rerank-call failure restricts to, rebuilt from the SAME admitted articles (never a second
   * discovery/fetch pass).
   */
  cappedQuota: number
  /** A worker picked this pack up (so a deadline hitting now is a `timeout`, not a `deadline`). */
  started: boolean
  /** The pack ran to its own end (its outcome is `settlement`, whatever happens afterwards). */
  settled: boolean
  settlement: PackSettlement
  candidates: ExternalCandidate[]
  /** Step 4-5 (ruling (e)(i)): the SAME articles' `capped`-scope selection, built beside
   *  `candidates` in the loop below. */
  cappedCandidates: ExternalCandidate[]
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

/** One aggregate-scored discovery candidate — fed by the plan-title suggest hits and the FTS
 *  hits, exactly like route F's shared `candidates` map (`prototype.mjs` `add()`). NEVER fed by
 *  the head-noun rule (STAGE 1, below): the frozen 1a-i patch (`prototype-a1.diff`) reads its
 *  accepted candidate directly and logs it to its own trace, but never calls `add()` either —
 *  a head-noun hit (accepted or a near-miss `/suggest` row that did not confirm exactly) never
 *  entered route F's shared pool, so this port does not either. */
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
  // Step 4-4 (ruling (a)): the scope for THIS ask, resolved once and applied to every pack —
  // absent ⇒ 'capped', so every existing caller keeps today's exact quota/slice.
  const scope: RerankScope = opts.candidateScope ?? 'capped'
  // Step 4-5 (run L2 measurement seam): opts.totalCandidateCapOverride, when set, replaces the
  // scope's own cap for this call only — see the option's own doc comment.
  const cap = opts.totalCandidateCapOverride ?? totalCandidateCapFor(scope)
  // Step 4-5 (ruling (e)(i)): the SAME `capped` cap/quota, computed unconditionally beside the
  // ask's own — cheap (no extra network read, just a second `chunksForScope`/`allocateCandidates`
  // pass over already-fetched material) and needed on EVERY ask, not only a wide one, so a
  // rerank-call failure always has a same-material fallback to restrict to.
  const cappedCap = totalCandidateCapFor('capped')
  const work: PackWork[] = packs.map((pack, i) => ({
    pack,
    quota: packQuota(i, packs.length, cap),
    cappedQuota: packQuota(i, packs.length, cappedCap),
    started: false,
    settled: false,
    settlement: 'searched',
    candidates: [],
    cappedCandidates: []
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
  let plan: SearchPlan = { titles: [], queries: [] }
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
      // The admission gate (`admit.ts`) sees TWO windows (F3): the narrow LEAD for the
      // title/fiction/topic-conflict-pair checks, and the WIDE full segment text for the
      // `explicitBiology` escape hatch only, so that rescue predicate keeps route F's
      // whole-article reach instead of being bounded by the same window as the trap it exists
      // to escape. N1 (second review, resolved step 4-3): the lead is `segments.slice(0, 1)` —
      // the intro segment only (`html.ts` flushes a segment at a HEADING, never a paragraph, so
      // `segments[0]` is every paragraph before the first heading). This is still NOT route F's
      // own lead (`prototype.mjs`'s first two PROSE blocks): a single-paragraph intro is
      // narrower than route F's two-paragraph lead (the port can over-admit where route F
      // refuses), and an intro of three or more paragraphs is wider (the port can refuse where
      // route F admits) — see `admit.ts`'s header for both directions, spelled out.
      const leadText = article.segments
        .slice(0, 1)
        .map((s) => s.text)
        .join(' ')
      const wideText = article.segments.map((s) => s.text).join(' ')
      const admission = admitArticle(question, article.title ?? hit.title, leadText, wideText, route)
      if (!admission.admitted) return
      if (article.title !== null && admittedArticles.some((a) => a.article.title === article.title)) return
      admittedArticles.push({ article, hit })
    }

    try {
      // STAGE 1 — head-noun reads (the ported 1a-i rule): up to `HEAD_NOUN_MAX_READS` accepted
      // `/suggest` matches issued to `readHit` (F4 — accepted, not admitted; see the constant's
      // own doc comment), at most `HEAD_NOUN_MAX_TOTAL_PROBES` `/suggest` probes in total across
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
            // F4 (review 2026-09-14): counts ACCEPTANCES (a confirmed /suggest match), exactly
            // like the frozen 1a-i patch (`prototype-a1.diff`: unconditional `issued++`), not
            // ADMISSIONS. A read that 404s, duplicates an already-admitted title, or fails the
            // gate still spends one of the two head-noun read slots — it must, or a run of such
            // reads can consume the whole per-pack budget before a single plan title or FTS
            // query is tried (demonstrated: 7 reads on one question against the cap of 2).
            issued++
            await readHit(res.accepted, 'head-noun')
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
      //
      // F2 (review 2026-09-14): two restorations from master's own no-plan fallback, gated
      // exactly as master gated them — never on every ask.
      //   (1) the #340 L3 length retry: when the PATTERN query itself (never a plan query)
      //       finds zero hits, retry once with `rewrite.retry` (the kept terms of five or more
      //       characters) if one exists — master's own trigger (`arm.ts:340` on master). A
      //       failed retry fails soft, keeping the honest zero from the primary query; it is
      //       not folded into `searchAttempts`/`searchFailures`, which track the primary query.
      //   (2) the five-read no-plan reach: when the planner produced no titles and no queries
      //       at all, the single pattern query IS the ask's entire discovery reach, so every hit
      //       it returns (up to `FTS_HITS_PER_QUERY`, matching master's `ARTICLES_PER_PACK` = 5)
      //       is read here, not just its rank-1 hit — otherwise a plan-less ask on this branch
      //       reaches only 1 + FTS_TOP_UNSEEN_PASS (= 3) articles where master reached 5.
      const noPlan = plan.titles.length === 0 && plan.queries.length === 0
      const queries = uniqueStrings([...plan.queries, rewrite.pattern])
      for (const q of queries) {
        searchAttempts++
        let hits: KiwixSearchHit[] = []
        let searched = false
        try {
          hits = await searchPack(port, pack.id, q, FTS_HITS_PER_QUERY, signal)
          searched = true
        } catch (err) {
          if (aborted()) throw new PackAbort(err)
          searchFailures++
          hits = []
        }
        if (searched && hits.length === 0 && q === rewrite.pattern && rewrite.retry !== null) {
          try {
            hits = await searchPack(port, pack.id, rewrite.retry, FTS_HITS_PER_QUERY, signal)
          } catch (err) {
            if (aborted()) throw new PackAbort(err)
            // Fail-soft: keep the honest zero the primary query already reported.
          }
        }
        hits.forEach((h, i) => addScore(h, i))
        if (noPlan) {
          for (const h of hits) await readHit(h, 'fts')
        } else if (hits[0]) {
          await readHit(hits[0], 'fts')
        }
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
    // chunking semantics (`html.ts`/`chunker.ts`): chunk, keep the query-overlap top slice for
    // this ask's SCOPE (step 4-4: `capped` = today's `LIST_ARTICLE_CHUNKS`/`CHUNKS_PER_ARTICLE`
    // per article, unchanged; `top48`/`top96` widen it; `all` drops the slice entirely), bounded
    // by the pack's own fair-share quota (`totalCandidateCapFor(scope)`-derived — `ALL_SCOPE_MAX_DOCS`
    // (512) for `all` since step 4-5 ruling (e)(ii): the pack quota DOES bind under `all` now,
    // same as every other scope). F6 (review 2026-09-14, dropped from this PR
    // per the owner's ruling): an earlier version of this port additionally capped a LIST
    // article's own share at `Math.ceil(quota / 2)` for multi-pack fairness — a real,
    // unmeasured, untested multi-pack behaviour change outside this PR's scope (a LIST article
    // always received the full per-scope budget on master); reverted here, restored unconditionally.
    for (const { article, hit } of admittedArticles) {
      const moreMain = item.candidates.length < item.quota
      const moreCapped = item.cappedCandidates.length < item.cappedQuota
      if (!moreMain && !moreCapped) break
      const chunks = chunkSegments(article.segments, CHUNK_DEFAULTS)
      const title = article.title ?? hit.title
      const isList = isListArticleTitle(title)
      const mapped = chunks.map((c, i) => ({ c, index: i, overlap: overlapScore(c.text, terms) }))
      const makeCandidate = (i: number, c: (typeof mapped)[number]['c'], overlap: number): ExternalCandidate => ({
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
      if (moreMain) {
        const scored = chunksForScope(mapped, scope, isList)
        for (const { c, index: i, overlap } of scored) {
          item.candidates.push(makeCandidate(i, c, overlap))
        }
      }
      // Step 4-5 (ruling (e)(i), B3/B7): the SAME article's `capped` selection, from the
      // IDENTICAL chunk/overlap material (`mapped`) — never a re-derivation, never a second
      // fetch. `retrieve()`'s `!reranked` branch (`rag/index.ts`) restricts to this instead of
      // the whole wide pool on a rerank-call failure.
      if (moreCapped) {
        const cappedScored = chunksForScope(mapped, 'capped', isList)
        for (const { c, index: i, overlap } of cappedScored) {
          item.cappedCandidates.push(makeCandidate(i, c, overlap))
        }
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
    work.map((item) => ({ packId: item.pack.id, candidates: item.candidates })),
    cap
  )
  // Step 4-5 (ruling (e)(i)): the SAME admission function, over the `capped`-scope companion
  // lists built alongside `candidates` above — the fallback `retrieve()` restricts to on a
  // rerank-call failure. On an already-`capped` ask this is value-identical to `allocation`
  // (same function, same per-article material, same 'capped' scope both times).
  const cappedAllocation = allocateCandidates(
    work.map((item) => ({ packId: item.pack.id, candidates: item.cappedCandidates })),
    cappedCap
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
  return { candidates: allocation.admitted, outcomes, cappedCandidates: cappedAllocation.admitted }
}

/** True when the abort came from the ask itself (a cancellation) rather than the deadline. */
function isCancellation(askSignal: AbortSignal | undefined): boolean {
  if (askSignal === undefined) return true // no deadline was combined in: it can only be the ask
  return askSignal.aborted
}

/** Distinct lowercase query terms of ≥3 letters/digits (unicode-aware), taken over the FOLDED
 *  question (#488, `supsub.ts`): a typed `10^6`, `H_2O` or `NO_x` contributes `106` / `h2o` /
 *  `nox` — the same terms the bare question produced before the converter marked sup/sub, and
 *  the same shape `overlapScore` folds the article side down to. The fold is symmetric in `^`
 *  and `_` (revised after the #488 census), so a typed `snake_case` yields the single term
 *  `snakecase` — which is also what an article writing it the same way yields. */
export function queryTerms(question: string): string[] {
  const terms = new Set<string>()
  for (const m of foldSupSub(question).toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) terms.add(m[0])
  return [...terms]
}

/** How many distinct query terms a chunk contains — the cheap per-article chunk picker.
 *  (Selection only; the reranker downstream does the real scoring.)
 *  The haystack is FOLDED first (#488): chunk text is converter output, so `25 m^2` must still
 *  answer to the term `m2` that the pre-#488 `25 m2` answered to. The comparison is by
 *  SUBSTRING, and the fold only REMOVES characters, so it can never break a term that matched
 *  before — only a marker SURVIVING between two alphanumerics could, by splitting a run, and
 *  `supsub.ts`'s emit rule writes none that the fold does not remove (bar a sign-suffixed
 *  `10^−6`, where the sign has split the run already). Invariant: every alphanumeric run of the
 *  pre-#488 text is still a substring of this haystack. */
export function overlapScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const hay = foldSupSub(text).toLowerCase()
  let n = 0
  for (const t of terms) if (hay.includes(t)) n++
  return n
}
