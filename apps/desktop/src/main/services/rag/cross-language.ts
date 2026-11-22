import type { JsonSchema } from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { isAbortError, stripThinkBlocks } from '../chat'
import { log } from '../logging'
import { detectPassageLanguage, detectQuestionLanguage } from '../zim/question-language'

// Cross-language passage search (#1003, follow-ups wave 7, owner call G-2; `docs/rag-design.md` §20).
//
// WHY. The passage search has two arms, the e5 vectors and the FTS5 keyword pass, fused by rank
// (`retrieve`). Within one language the keyword pass finds the passage that holds the question's
// own words. A German question over an English document gets no keyword hit at all, and e5 (run
// without its prefixes) ranks the answering passage low: over an English lease, 3 of 18 German
// questions had the right passage in the top 3, against 11 of 18 for their English twins.
//
// WHAT. After the first fusion `crossLanguageSearch` checks the gate: the question reads as German,
// none of the top `CROSS_LANGUAGE_GATE_CANDIDATES` fused document candidates reads as German, and a
// strict majority of them reads as English (`detectQuestionLanguage` on the question,
// `detectPassageLanguage` on the chunk text: the same count without the umlaut tie-break, so a German
// address in an English lease is no German passage). A passage it cannot read, such as a table, a
// letterhead or a signature block, does not block, but it is not English, so it counts against the
// majority (the measured rule).
// When it holds, ONE call to the turn's own chat runtime translates the question into English
// (`makeQueryTranslator`, the knowledge-pack planner's pattern in `zim/expand.ts`): thinking off
// (`mode: 'fast'`), temperature 0, a grammar-constrained `{"query": …}` reply, `TRANSLATE_MAX_TOKENS`
// output tokens and its own wall-clock bound. `retrieve` then runs both arms again and fuses again:
// the vectors on the question and its translation joined by a space (as measured), the keyword pass
// on the translation FIRST. The keyword pass keeps only the first 32 words of its text
// (`fts.ts` `MAX_QUERY_TOKENS`), so a long question would otherwise push out every English word, and
// the English words are why the keyword pass finds anything. A joined text of at most 32 words gives
// the same keyword query in either order (every measured question did: 27 words at most). The
// concatenation keeps the question's own names and numbers in the search: a wrong or partial
// translation adds words but takes none away (`docs/rag-design.md` §20 has what the fusion still does
// to a few passages). A question longer than `TRANSLATE_MAX_QUESTION_CHARS` is not translated (past
// the measured range, the caps could cut its translation). A translation that only repeats the
// question, a second search that finds nothing, or one that fails, keeps the first search. The
// knowledge-pack arm, the reranker, the grounded prompt and the stored messages keep the original
// question. The call is marked `auxiliary`, so it does not count as the runtime's first answer for
// the warm-up hint (#39).
//
// SCOPE. German questions over English documents only (owner, 2026-11-22, after a held-out check of
// the prompt). An English question over German documents stays as it was: the 4B's translations
// into German reached 77 % of the gain of a reference translation, below the 80 % the gate asked
// for. The other eight interface languages are not detected (`detectQuestionLanguage` reads German
// and English only).
//
// FAILURE. Every call failure (no runtime, the time bound, a runaway reply, malformed JSON, a
// transport error) resolves null: the search stays today's, with no notice to the user. The ONE
// exception is the ask's own cancellation, which is rethrown (#301 P4, T09). Only the gate's outcome
// and the translation call's duration are logged; the question and its translation are content and
// never are.

/**
 * How many fused document candidates the gate reads. The top 6 is `topKFinal`'s default: a German
 * question whose best six passages hold no German one and mostly English ones is asked over English
 * documents. On the bilingual eval set with every document in scope (real e5) the gate fires on 0 of
 * its 100 questions, under this rule as under the first one (every one of the six English).
 */
export const CROSS_LANGUAGE_GATE_CANDIDATES = 6

/**
 * Output-token cap. The longest measured reply was 63 tokens (the 4B, a question with an IBAN, a date
 * and an amount: Qwen spends one token per digit), and a 64-token cap cut one 9B reply; over the 180
 * calls of the held-out check the longest reply was 27 tokens.
 */
export const TRANSLATE_MAX_TOKENS = 96

/**
 * Wall-clock bound on the call. The CPU-only 4B's p90 was 3.3 s on a quiet machine (max 4.3 s) and
 * 9.0 s on a machine 91–93 % busy; past the bound the call is aborted and the search stays today's.
 */
export const TRANSLATE_TIMEOUT_MS = 8_000

/** Longest translation kept; a longer one is dropped, never cut. */
const TRANSLATE_MAX_QUERY_CHARS = 300

/**
 * Longest question translated (characters). The measured questions reach 108 characters. The
 * costliest measured reply spent 64 tokens on a 108-character question full of digits (an IBAN, a
 * date, an amount: 0.59 tokens per character), and the longest translation was 1.16 times its
 * question. At those rates a 150-character question needs about 89 of the 96 tokens and gives about
 * 174 of the 300 characters, so neither cap cuts its translation. A longer question keeps today's
 * search (`skipped`).
 */
export const TRANSLATE_MAX_QUESTION_CHARS = 150

/** Defensive char cap over the token budget: a runtime that ignores `maxTokens` is cut off. */
const OUTPUT_CHAR_CAP = TRANSLATE_MAX_TOKENS * 8

export const TRANSLATE_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string' }
  }
}

/**
 * The system prompt, byte for byte the one measured (prompt "v2", `docs/rag-design.md` §20): "a English"
 * is a slip kept as measured. It is a measured string, so a change to it needs a new measurement.
 */
const TRANSLATE_SYSTEM_PROMPT =
  "Translate the user's German question into English, for a search in English documents. " +
  'Use the words a English document on the subject would use. ' +
  'Do not answer the question and do not add anything to it. ' +
  'Keep every name, number, date, amount and unit exactly as written. ' +
  'query: the English translation of the question. Return JSON only.'

/** Translate one question for the passage search; null on any failure except the ask's own abort (rethrown). */
export type QueryTranslator = (question: string, signal?: AbortSignal) => Promise<string | null>

/** The two texts of the second search: one for the vector arm, one for the keyword arm. */
export interface CrossLanguageSearchTexts {
  /** The question, then its translation (the measured search). */
  vectorText: string
  /** The translation, then the question: the keyword pass keeps only the first 32 words of its text. */
  keywordText: string
}

/**
 * The gate: true only when the question reads as German, none of the top
 * `CROSS_LANGUAGE_GATE_CANDIDATES` fused document candidates reads as German, and a strict majority of
 * them reads as English (`detectPassageLanguage`: a tie, as in an address line with an umlaut, reads
 * as `null`). A candidate whose language reads as `null` (a table, a letterhead) does not block, but it
 * counts against the majority; a question that reads as `null`, or no candidate at all, keeps
 * today's search.
 */
function crossLanguageGateFires(question: string, candidateTexts: readonly string[]): boolean {
  const top = candidateTexts.slice(0, CROSS_LANGUAGE_GATE_CANDIDATES)
  if (top.length === 0) return false
  if (detectQuestionLanguage(question) !== 'de') return false
  const languages = top.map((text) => detectPassageLanguage(text))
  if (languages.some((language) => language === 'de')) return false
  const english = languages.filter((language) => language === 'en').length
  return english * 2 > top.length
}

/** Case- and space-folded, for "the translation only repeats the question". */
function folded(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The outcome the log line names. */
type CrossLanguageOutcome = 'translated' | 'failed' | 'unchanged' | 'empty' | 'search-failed' | 'skipped'

/**
 * The cross-language step after the first fusion (#1003): when the gate fires, translate the
 * question once and hand `search` the two texts of the second search. Resolves the second search's
 * result, or null to keep the first one: a closed gate, a question over `TRANSLATE_MAX_QUESTION_CHARS`
 * (`skipped`), no translation (`failed`), a translation that only repeats the question
 * (`unchanged`), a second search that resolves null because it found nothing (`empty`), or one that
 * throws (`search-failed`). Rejects with an AbortError when the ask is cancelled, during the call or
 * during the second search. Logs one line per fired gate: the outcome and the translation call's
 * duration, never the question, the translation or an error message (all content).
 */
export async function crossLanguageSearch<T>(
  question: string,
  candidateTexts: readonly string[],
  translate: QueryTranslator,
  search: (texts: CrossLanguageSearchTexts) => Promise<T | null>,
  signal?: AbortSignal
): Promise<T | null> {
  if (!crossLanguageGateFires(question, candidateTexts)) return null
  if (Array.from(question).length > TRANSLATE_MAX_QUESTION_CHARS) {
    log.info('Cross-language passage search', { outcome: 'skipped' satisfies CrossLanguageOutcome })
    return null
  }
  const started = Date.now()
  const translation = await translate(question, signal)
  const durationMs = Date.now() - started
  const outcome = (name: CrossLanguageOutcome): void =>
    log.info('Cross-language passage search', { outcome: name, durationMs })
  if (translation === null) {
    outcome('failed')
    return null
  }
  if (folded(translation) === folded(question)) {
    outcome('unchanged')
    return null
  }
  let result: T | null
  try {
    result = await search({
      vectorText: `${question} ${translation}`,
      keywordText: `${translation} ${question}`
    })
  } catch (err) {
    if (isAbortError(err, signal)) throw err // a cancellation is never a fallback (T09)
    outcome('search-failed')
    return null
  }
  outcome(result === null ? 'empty' : 'translated')
  return result
}

function buildTranslationMessages(question: string): ChatMessage[] {
  return [
    { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
    { role: 'user', content: question }
  ]
}

/**
 * Defensive parse: malformed JSON, a non-object, or a missing, non-string, empty or over-long `query`
 * resolves null. Runs of whitespace collapse to one space.
 */
function parseTranslation(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripThinkBlocks(text).trim())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const query = (parsed as Record<string, unknown>).query
  if (typeof query !== 'string') return null
  const collapsed = query.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0 || collapsed.length > TRANSLATE_MAX_QUERY_CHARS) return null
  return collapsed
}

/**
 * Build the translator over the turn's runtime, or null when there is no runtime (the search then
 * stays today's). Single-shot, never retried.
 */
export function makeQueryTranslator(runtime: ModelRuntime | null | undefined): QueryTranslator | null {
  if (!runtime) return null
  return async (question, signal) => {
    if (signal?.aborted) throw abortError()
    // A linked inner signal: aborts on the ask's abort AND on the wall-clock bound.
    const inner = new AbortController()
    const onOuterAbort = (): void => inner.abort()
    signal?.addEventListener('abort', onOuterAbort)
    const timer = setTimeout(() => inner.abort(), TRANSLATE_TIMEOUT_MS)
    try {
      let text = ''
      const stream = runtime.chatStream(buildTranslationMessages(question), {
        signal: inner.signal,
        mode: 'fast',
        maxTokens: TRANSLATE_MAX_TOKENS,
        temperature: 0,
        responseSchema: TRANSLATE_RESPONSE_SCHEMA,
        responseSchemaName: 'rag_query_translation',
        // #39: a search step, not the turn's answer: the warm-up hint keeps waiting for the answer.
        auxiliary: true
      })
      for await (const token of stream) {
        if (inner.signal.aborted) break
        text += token
        if (text.length > OUTPUT_CHAR_CAP) return null // a runaway reply is dropped, never accumulated
      }
      if (signal?.aborted) throw abortError() // the ASK was cancelled: never a fallback
      if (inner.signal.aborted) return null // the time bound: the search stays today's
      return parseTranslation(text)
    } catch (err) {
      if (signal?.aborted) throw isAbortLike(err) ? err : abortError()
      return null // a dead runtime, a transport error, anything else: silent degrade
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
      inner.abort() // however the call ended, its request ends with it (never runs on to the cap)
    }
  }
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function abortError(): Error {
  const err = new Error('The cross-language search translation was cancelled')
  err.name = 'AbortError'
  return err
}
