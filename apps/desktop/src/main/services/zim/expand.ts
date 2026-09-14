import type { JsonSchema } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { stripThinkBlocks } from '../chat'

// The question -> search PLAN for the knowledge-pack arm (#340 L3-b originally; ported to
// route F's discovery semantics at Phase 4 PR-A — `docs/rag-design.md` §17 "Discovery port
// (Phase 4 PR-A)"). One call per ask, exactly as the expander it replaces.
//
// WHY. Xapian ANDs the question's words, and a list or superlative question ("Welche Länder
// stoßen am meisten CO2 aus?") names none of the words the answering article is indexed under
// ("Liste der Länder nach CO2-Emission"); a compound noun the question uses often does not
// match the archive's own title spelling either. The measured research programme (steps 0.6,
// 1a-i, 1c, 1g) found that a short, schema-constrained model call that proposes CANDIDATE
// article titles and full-text queries — never an answer, never a guessed fact — recovers most
// of this gap; 1c additionally measured that turning the call off roughly HALVES article-stage
// hits on English questions, so it stays unconditionally on.
//
// WHAT. `makeQueryExpander(runtime)` returns a function the arm calls ONCE per ask (never per
// pack, and memoised across the one admitted retry — `index.ts`): a two-message prompt,
// thinking off (`mode: 'fast'`), temperature 0, `PLAN_MAX_TOKENS` output cap, a
// grammar-constrained JSON reply (`PLAN_RESPONSE_SCHEMA`) and its own wall-clock bound
// (`PLAN_TIMEOUT_MS`) inside the arm's per-ask deadline. `parsePlan` then defensively parses
// the reply — malformed JSON or a non-object degrades to an EMPTY plan (every field `[]`),
// mirroring `prototype.mjs`'s own `interpret()`; a plan field is otherwise a plain string-typed,
// length- and count-capped array, with NO further content-word filtering (unlike the expander
// this replaces): a plan title is a title CANDIDATE for `/suggest`, and a plan query is an FTS
// query in its own right, so filtering it against the plain pattern's stop/frame-word lists
// would defeat the point of asking the model for search vocabulary in the first place.
//
// F1 part 1 (review 2026-09-14): route F's own `terms` array (relation/attribute terms) is
// DROPPED from the schema and the prompt — the arm never consumed it (a DEV49 iteration tried
// wiring it into the chunk-overlap picker and measured no improvement), and it was pure
// output-token cost on every planner call. See `docs/rag-design.md` §17 for the disclosure.
//
// Every CALL failure — no runtime, a timeout, a runaway reply, a transport error — resolves
// null (arm.ts then discovers using only the plan-independent routes: the head-noun rule and
// the plain `searchPattern` rewrite). The ONE exception is the ask's own cancellation, which
// is rethrown: a cancellation is never a fallback (#301 P4, T09).
//
// Deliberately UNCHANGED from route F: this keeps the prompt in "the language of the
// question" (route F's own prompt hardcodes German, because route F's one archive IS German
// Wikipedia) — the product's knowledge packs are ANY language a user adds
// (`docs/knowledge-packs.md`: "Wikipedia in about a hundred languages"), so hardcoding a
// target language would regress every non-German pack. See `docs/rag-design.md` §17 "Discovery
// port (Phase 4 PR-A)" for the measured cost of this choice on the (German-only) acceptance
// corpus's English-question half.
//
// F7 (review 2026-09-14, question-only): route F's prompt asks the model to "infer the intended
// subject from the original question and its conversation history", but neither this call nor
// `admit.ts`'s gate is ever given history at this layer (`buildPlanMessages` sends only the bare
// question; `registerRagIpc.ts` hands the arm only the current turn's text) — the "conversation
// history" clause was dead text in the prompt and is removed.

/** What the model contributed for one question — route F's `plan` shape (`prototype.mjs`
 *  `planSchema`/`interpret()`), not the `{concepts,listTitle}` shape this replaces.
 *
 *  F1 part 1 (review 2026-09-14): route F's own `terms` array is DROPPED here — a deliberate
 *  deviation from route F, disclosed in `docs/rag-design.md` §17. Nothing in this arm ever
 *  consumed `plan.terms` (a DEV49 iteration tried wiring it into the chunk-overlap picker and
 *  measured no improvement — `steps/4-product-pr-discovery/report.md` deviation 4), and it was
 *  one of the three fields the planner had to spend its output-token budget producing on every
 *  ask, which is exactly the budget F1's cap decision is measured against. */
export interface SearchPlan {
  /** Up to `PLAN_MAX_TITLES` candidate article titles or genuine aliases, for `/suggest`. */
  titles: string[]
  /** Up to `PLAN_MAX_QUERIES` full-text search queries (2-4 important words each). */
  queries: string[]
}

/** One call per ask; resolves null on any failure except the ask's own abort (rethrown). A
 *  non-null resolution is always a well-formed (possibly all-empty) {@link SearchPlan} —
 *  `parsePlan` never returns null itself, matching `prototype.mjs`'s `interpret()`. */
export type QueryExpander = (question: string, signal?: AbortSignal) => Promise<SearchPlan | null>

/**
 * Wall-clock bound on the planner call (ms) — UNCHANGED from the expander this replaces
 * (#423): it runs inside the arm's `EXTERNAL_RETRIEVAL_DEADLINE_MS` BEFORE any pack is
 * searched, so past this bound the request is aborted and discovery proceeds without a plan.
 * `zim-expand.test.ts` keeps pinning this against `EXTERNAL_RETRIEVAL_DEADLINE_MS`.
 */
export const PLAN_TIMEOUT_MS = 12_000
/**
 * Output-token budget. PROVISIONAL at 220 (route F's own `interpret()` `maxTokens`) — F1 (review
 * 2026-09-14): this was raised 96 -> 220 from the expander it replaces while `PLAN_TIMEOUT_MS`
 * stayed unchanged, and the two tests that pinned the bound and the cap against each other were
 * deleted, so no CPU decode rate this project has ever measured could afford a maximum-length
 * reply inside 12 s. Left at 220 here only long enough to run the harness's untruncated
 * planner-length measurement (`docs/rag-design.md` §17 F1 record); the shipped value is set by
 * the ruled formula from that measurement's p99 (`cap = min(104, smallest multiple of 8 >= p99 +
 * 8)`), restored together with {@link PLAN_SLOWEST_MEASURED_TOKENS_PER_SEC} and the two pins
 * `zim-expand.test.ts` carries once more.
 */
export const PLAN_MAX_TOKENS = 220
export const PLAN_MAX_TITLES = 3
export const PLAN_MAX_QUERIES = 2
/** Longest single plan string kept (route F's own `interpret()` parse: `x.length<=140`).
 *  Anything longer is dropped, not cut. */
export const PLAN_MAX_STRING_CHARS = 140
/** Defensive char cap over the token budget: a runtime that ignores `maxTokens` is cut off. */
const OUTPUT_CHAR_CAP = PLAN_MAX_TOKENS * 8

export const PLAN_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['titles', 'queries'],
  properties: {
    titles: { type: 'array', items: { type: 'string' }, maxItems: PLAN_MAX_TITLES },
    queries: { type: 'array', items: { type: 'string' }, maxItems: PLAN_MAX_QUERIES }
  }
}

/**
 * The per-call messages — route F's `interpret()` system prompt (`prototype.mjs`), adapted
 * only to keep the product's existing "in the language of the question" framing instead of a
 * hardcoded target language (see the file header). The question is CONTENT and rides in the
 * user turn only — it is never logged.
 */
export function buildPlanMessages(question: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Prepare a short Wikipedia search plan, not an answer, in the language of the question. ' +
        'Infer the intended subject from the original question. ' +
        'titles: up to three likely article titles or genuine aliases, in the language of the ' +
        'question; queries: up to two concise full-text search queries of 2-4 important words, ' +
        'in the language of the question, targeting all requested relations. Preserve entity ' +
        'distinctions, negations, dates, units and exclusions. Do not invent a private fact or ' +
        'supply guessed answer facts as search terms. An announced future event may already be ' +
        'documented. Return JSON only.'
    },
    { role: 'user', content: question }
  ]
}

/**
 * Defensively parse the model's reply into a {@link SearchPlan} — route F's own `interpret()`
 * parse (`prototype.mjs`): malformed JSON, a non-object, or a missing/non-array field degrades
 * that field (or the whole plan) to `[]`, never throws, never returns null. Each field is
 * filtered to string entries of at most `PLAN_MAX_STRING_CHARS` and capped to its own count.
 * Deliberately NOT filtered against the plain pattern's content-word lists (unlike the
 * expander this replaces): a plan title/query is used directly by `/suggest` and `/search`,
 * not merged into the plain rewrite's own term list.
 */
export function parsePlan(text: string): SearchPlan {
  const empty: SearchPlan = { titles: [], queries: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripThinkBlocks(text).trim())
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
  const raw = parsed as Record<string, unknown>
  const field = (key: 'titles' | 'queries', max: number): string[] => {
    const value = raw[key]
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (trimmed.length === 0 || trimmed.length > PLAN_MAX_STRING_CHARS) continue
      out.push(trimmed)
      if (out.length >= max) break
    }
    return out
  }
  return {
    titles: field('titles', PLAN_MAX_TITLES),
    queries: field('queries', PLAN_MAX_QUERIES)
  }
}

/**
 * Build the planner over the turn's runtime, or null when there is no runtime (the arm then
 * discovers using only the plan-independent routes). Single-shot, never retried.
 */
export function makeQueryExpander(
  runtime: ModelRuntime | null | undefined,
  opts: { timeoutMs?: number } = {}
): QueryExpander | null {
  if (!runtime) return null
  return async (question, signal) => {
    if (signal?.aborted) throw abortError()
    // A linked inner signal: aborts on the ask's abort AND on the wall-clock bound.
    const inner = new AbortController()
    const onOuterAbort = (): void => inner.abort()
    signal?.addEventListener('abort', onOuterAbort)
    const timer = setTimeout(() => inner.abort(), opts.timeoutMs ?? PLAN_TIMEOUT_MS)
    try {
      let text = ''
      const stream = runtime.chatStream(buildPlanMessages(question), {
        signal: inner.signal,
        mode: 'fast',
        maxTokens: PLAN_MAX_TOKENS,
        temperature: 0,
        responseSchema: PLAN_RESPONSE_SCHEMA,
        responseSchemaName: 'zim_search_plan'
      })
      for await (const token of stream) {
        if (inner.signal.aborted) break
        text += token
        if (text.length > OUTPUT_CHAR_CAP) return null // a runaway reply is dropped, never accumulated
      }
      if (signal?.aborted) throw abortError() // the ASK was cancelled: never a fallback
      if (inner.signal.aborted) return null // the time bound: discovery proceeds without a plan
      return parsePlan(text)
    } catch (err) {
      if (signal?.aborted) throw isAbortLike(err) ? err : abortError()
      return null // a dead runtime, a transport error, anything else: silent degrade
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function abortError(): Error {
  const err = new Error('The knowledge-pack search plan was cancelled')
  err.name = 'AbortError'
  return err
}
