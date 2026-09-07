import type { JsonSchema } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { stripThinkBlocks } from '../chat'
import { TOKEN_RE, isContentWord, searchPattern } from './query-rewrite'

// The question → concept expansion for the knowledge-pack arm (#340 L3-b; rag-design §17 D-Z20).
//
// WHY. Xapian ANDs the question's words, and a list or superlative question ("Welche Länder
// stoßen am meisten CO2 aus?") names none of the words the answering article is indexed under
// ("Liste der Länder nach CO2-Emission"). Measured on the real climate pack (2026-09-06): the
// stripped question found the list article in 2 of 6 such questions through the arm; a
// concept-expanded query found it in 4 of 6; the title index asked with a synthesised "Liste …"
// prefix in 6 of 6. The only thing on the drive that can write those words is the local chat
// model, so — the owner's ruling of 2026-09-07, option (a) — EVERY pack-scoped ask spends one
// short call on it before the search.
//
// WHAT. `makeQueryExpander(runtime)` returns a function the arm calls ONCE per ask (never per
// pack): a two-message prompt, thinking off (`mode: 'fast'`), temperature 0, a hard output cap,
// a grammar-constrained JSON reply (`responseSchema`, the D55 machinery the skill classifier
// uses) and its own wall-clock bound INSIDE the arm's per-ask deadline. `parseExpansion` then
// sanitises the reply: only tokens the rewrite itself would keep (no function or frame words),
// nothing the plain pattern already carries, a term cap and a length cap; the list title trimmed
// and capped. Every failure — no runtime, a reply that is not JSON (the mock runtime ignores the
// schema, so mock/dev always exercises this path), a timeout, a runaway reply — resolves null and
// the arm searches exactly as it did before this module existed. The ONE exception is the ask's
// own cancellation, which is rethrown: a cancellation is never a fallback (#301 P4, T09).
//
// The expansion only ever ADDS candidates (arm.ts): the plain pattern still runs and its hits
// are kept; the reranker and the prompt still see the original question.

/** What the model contributed for one question. */
export interface QueryExpansion {
  /** Extra content words for ONE additional full-text search (joined with spaces). */
  concepts: string[]
  /** The title a list article answering the question would carry, for the title index. */
  listTitle: string | null
}

/** One call per ask; resolves null on any failure except the ask's own abort (rethrown). */
export type QueryExpander = (question: string, signal?: AbortSignal) => Promise<QueryExpansion | null>

/**
 * Wall-clock bound on the expansion (ms). It runs inside the arm's `EXTERNAL_RETRIEVAL_DEADLINE_MS`
 * BEFORE any pack is searched, so past this bound the request is aborted and the plain search
 * proceeds — one slow model must never eat the packs' whole budget. Measured 2026-09-07 with the
 * default 4B chat model on a CPU (an i9-14900K, no graphics card): 2.7–4.0 s per call when the
 * system prompt is prefilled from scratch, well under that once `cache_prompt` has kept the
 * prefix across asks (the app runtime always sets it). Six seconds leaves the packs fourteen of
 * the arm's twenty and still admits a first, uncached call on a slower processor.
 */
export const EXPAND_TIMEOUT_MS = 6_000
/** Output-token budget: six short words plus a title plus JSON framing. */
export const EXPAND_MAX_TOKENS = 96
/** Concept terms kept from the reply, at most. */
export const EXPAND_MAX_TERMS = 6
/** Longest single concept term / list title kept (chars); anything longer is dropped, not cut. */
export const EXPAND_MAX_TERM_CHARS = 40
export const EXPAND_MAX_TITLE_CHARS = 80
/** Defensive char cap over the token budget: a runtime that ignores `maxTokens` is cut off. */
const OUTPUT_CHAR_CAP = EXPAND_MAX_TOKENS * 8

export const EXPAND_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts', 'listTitle'],
  properties: {
    concepts: { type: 'array', items: { type: 'string', maxLength: EXPAND_MAX_TERM_CHARS }, maxItems: EXPAND_MAX_TERMS },
    listTitle: { type: 'string', maxLength: EXPAND_MAX_TITLE_CHARS }
  }
}

/**
 * The per-call messages. English instructions (the pinned chat models follow them in either
 * language); the question is CONTENT and rides in the user turn only — it is never logged. The
 * prompt describes the JSON shape as well as constraining it (llama.cpp's grammar guarantees the
 * shape, the description improves the choice of words).
 */
export function buildExpansionMessages(question: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You write search terms for the full-text index of an offline encyclopedia (Wikipedia). ' +
        'The index finds an article only when EVERY term occurs in it, so choose words that appear ' +
        'in the article that answers the question, in the language of the question. Reply with JSON ' +
        'only: {"concepts": [...], "listTitle": "..."}. "concepts": up to six single words — the ' +
        'topic and the things such an article is about (nouns, names, technical terms); never ' +
        'question words, never sentences. "listTitle": when the question asks for a list, a ranking, ' +
        'or the largest / most / highest / best-known items of a kind, the exact title a Wikipedia ' +
        'LIST article about it would have, in the language of the question (a German question gets a ' +
        'German title such as "Liste der Länder nach CO2-Emission", an English one "List of tallest ' +
        'buildings"); otherwise an empty string.'
    },
    { role: 'user', content: question }
  ]
}

/**
 * Sanitise the model's reply against the plain pattern the arm will search anyway. Pure.
 *   - `concepts`: tokenised by the rewrite's own token rule; a token is kept only when it is a
 *     content word by the rewrite's lists, not already in the plain pattern (case-insensitive),
 *     unique, and at most `EXPAND_MAX_TERM_CHARS` long; at most `EXPAND_MAX_TERMS` kept in order.
 *   - `listTitle`: trimmed, must hold a letter and fit `EXPAND_MAX_TITLE_CHARS`, else null.
 * Null when neither survives, when the text is not a JSON object, or on any other shape.
 */
export function parseExpansion(text: string, question: string): QueryExpansion | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripThinkBlocks(text).trim())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as { concepts?: unknown; listTitle?: unknown }
  const plain = new Set(searchPattern(question).terms.map((t) => t.toLowerCase()))
  const concepts: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.concepts)) {
    for (const item of raw.concepts) {
      if (typeof item !== 'string') continue
      for (const m of item.matchAll(TOKEN_RE)) {
        const token = m[0].replace(/-+$/, '')
        const key = token.toLowerCase()
        if (token === '' || token.length > EXPAND_MAX_TERM_CHARS) continue
        if (!isContentWord(token) || plain.has(key) || seen.has(key)) continue
        seen.add(key)
        concepts.push(token)
        if (concepts.length >= EXPAND_MAX_TERMS) break
      }
      if (concepts.length >= EXPAND_MAX_TERMS) break
    }
  }
  let listTitle: string | null = null
  if (typeof raw.listTitle === 'string') {
    const title = raw.listTitle.replace(/\s+/g, ' ').trim()
    if (title.length > 0 && title.length <= EXPAND_MAX_TITLE_CHARS && /\p{L}/u.test(title)) listTitle = title
  }
  if (concepts.length === 0 && listTitle === null) return null
  return { concepts, listTitle }
}

/**
 * Build the expander over the turn's runtime, or null when there is no runtime (the arm then
 * skips the step entirely — zero model calls). Single-shot, never retried: a second call would
 * double the cost of exactly the questions this is meant to keep cheap.
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
    const timer = setTimeout(() => inner.abort(), opts.timeoutMs ?? EXPAND_TIMEOUT_MS)
    try {
      let text = ''
      const stream = runtime.chatStream(buildExpansionMessages(question), {
        signal: inner.signal,
        mode: 'fast',
        maxTokens: EXPAND_MAX_TOKENS,
        temperature: 0,
        responseSchema: EXPAND_RESPONSE_SCHEMA,
        responseSchemaName: 'pack_query_expansion'
      })
      for await (const token of stream) {
        if (inner.signal.aborted) break
        text += token
        if (text.length > OUTPUT_CHAR_CAP) return null // a runaway reply is dropped, never accumulated
      }
      if (signal?.aborted) throw abortError() // the ASK was cancelled: never a fallback
      if (inner.signal.aborted) return null // the time bound: the plain search proceeds
      return parseExpansion(text, question)
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
  const err = new Error('The knowledge-pack expansion was cancelled')
  err.name = 'AbortError'
  return err
}
