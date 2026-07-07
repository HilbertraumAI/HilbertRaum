import type { Db } from '../db'
import type { ChatMessage, ModelRuntime } from '../runtime'
import {
  BASE_SYSTEM_PROMPT,
  CHAT_RESPONSE_RESERVE_TOKENS,
  compactionSummaryPair,
  getLatestCheckpoint,
  isAbortError,
  listConversationTurns,
  messageTokens,
  stripThinkBlocks,
  writeCheckpoint,
  type ConversationTurn
} from '../chat'
import { packIntoWindows, summaryBudgetWords } from '../doctasks/summary'
import { log } from '../logging'

// L2 — conversation compaction (context-compaction-plan §4.4). When a conversation's history
// approaches the model's context window we summarize the OLDER turns once into a cached checkpoint
// and replay only the recent turns verbatim, instead of silently dropping the old ones (the L1
// `fitMessagesToContext` floor). This module owns the pre-pass + the summarizer call; persistence
// (the `kind='compaction'` row) and assembly (the synthetic summary pair) live in `../chat`.
//
// Invariants this module upholds:
//   - Below threshold OR too few compactable turns ⇒ no model call (the common path stays free).
//   - Summarize ONCE and cache it: a fresh checkpoint drops the next turn below threshold, so the
//     summarizer is not called again until enough NEW turns re-cross it (chained re-compaction).
//   - Any summarizer failure/abort ⇒ NO checkpoint written; the turn proceeds via L1, no error.
//   - L1 still runs after assembly and still guarantees fit — L2 only reduces what L1 must drop.

/** Compact when the assembled-history estimate reaches this fraction of the window. */
export const COMPACT_THRESHOLD = 0.85
/** The most-recent turns always kept verbatim (recent context matters most). */
export const KEEP_RECENT_TURNS = 6
/** Don't summarize unless at least this many turns sit older than the protected tail. */
export const MIN_COMPACTABLE_TURNS = 6
/** Output cap for the summary (dense, bounded — the §4.8 prompt targets ~500 words). */
export const SUMMARY_MAX_TOKENS = 700
/** Low temperature: a summary should be faithful and stable, not creative. */
const SUMMARY_TEMPERATURE = 0.2

/**
 * The self-summary prompt (context-compaction-plan §4.8, v2 — VERBATIM). Internal model context,
 * not user-facing copy, so it stays English (the summary CONTENT comes out in the conversation's
 * own language). Structured sections act as a preservation checklist; the verbatim-identifier and
 * anti-invention rules guard against a hallucinated fact poisoning every later turn (R6).
 */
export const selfSummaryPrompt = `You are compressing the EARLIER part of a conversation so it can continue within a
limited context window. Write a dense, factual summary that lets the assistant continue
seamlessly. Use exactly these sections; omit a section only if it truly has no content.

## Goal
One or two sentences: what the user is trying to learn or accomplish across the conversation.

## Established facts & answers
- The concrete facts, figures, and conclusions reached so far.
- Copy names, numbers, dates, file/document titles, and source markers like [S2] EXACTLY as
  written. Never round a number or rename a source.

## Documents & sources in play
- Documents, files, or sources referred to, by their exact titles/identifiers.

## Decisions & the user's preferences
- Choices made, and any stated preferences or constraints (language, format, scope, tone).

## Open questions / still to do
- Anything unresolved or explicitly deferred.

Rules:
- Be factual. Do NOT invent details. If something is unclear, write "unclear" rather than guessing.
- Preserve exact identifiers, quotes, and numbers; do not paraphrase them.
- No pleasantries, no meta-commentary, no restating these instructions.
- Keep the whole summary under ~500 words.`

export interface CompactionOptions {
  /** The turn's AbortSignal — a cancel mid-summary abandons it (no checkpoint), L1 handles length. */
  signal?: AbortSignal
  /** Fired exactly once, just before the model call, when a summary is actually started. */
  onStart?: () => void
  /**
   * Extra fixed prompt tokens the caller already committed for THIS turn that the pre-pass estimate
   * would otherwise miss — currently the pre-sized skill fence (CB-3 fold-in). Folded into the
   * assembled-size estimate so a fence-heavy turn crosses the compaction threshold at the right point
   * instead of a turn or two late. Defaults to 0 (no fence / no reservation).
   */
  reservedTokens?: number
}

/**
 * The compaction pre-pass (§4.4). Awaited inside the chat/RAG chokepoints BEFORE assembly. When the
 * (post-checkpoint) history estimate reaches the threshold and there are enough compactable turns,
 * summarize the region older than the protected recent tail — folding the prior checkpoint summary
 * in (§4.7) — and persist a new checkpoint. Otherwise returns without calling the model.
 */
export async function ensureCompacted(
  db: Db,
  runtime: ModelRuntime,
  conversationId: string,
  window: number,
  opts: CompactionOptions = {}
): Promise<void> {
  if (!(window > 0)) return

  const checkpoint = getLatestCheckpoint(db, conversationId)
  const priorCovers = checkpoint?.coversThroughRowid ?? 0
  // Only turns newer than the last checkpoint are candidates — everything older is already
  // captured by the checkpoint summary the next assembly will inject.
  const compactable = listConversationTurns(db, conversationId, priorCovers)
  if (compactable.length === 0) return

  // Estimate the ASSEMBLED-history size (what the prompt would actually carry): the summary pair
  // for the existing checkpoint, if any, plus the post-checkpoint turns. This is what makes a fresh
  // checkpoint drop the next turn below threshold, so we summarize once until NEW turns re-cross it.
  //
  // CB-3 fold-in: count the REAL fixed prompt costs the old estimate ignored — the actual
  // `compactionSummaryPair` intro/ack text (not a bare `summary` + `''`), the base system prompt,
  // and the caller-supplied `reservedTokens` (the pre-sized skill fence). Undercounting these made
  // the estimate optimistic (a few dozen–hundred tokens low), so compaction fired a turn late.
  const summaryPairTokens = checkpoint
    ? compactionSummaryPair(checkpoint.summary).reduce((sum, m) => sum + messageTokens(m), 0)
    : 0
  const fixedTokens =
    messageTokens({ role: 'system', content: BASE_SYSTEM_PROMPT }) + (opts.reservedTokens ?? 0)
  const estimated =
    fixedTokens + summaryPairTokens + compactable.reduce((sum, t) => sum + turnTokens(t), 0)
  // CB-3: cap the trigger at L1's OWN floor (window − reserve) so a small window compacts BEFORE the
  // L1 `fitMessagesToContext` trim starts silently dropping the oldest turns. Crossover: 0.85·window
  // ≤ window − 1024 ⟺ window ≥ 6827, so windows ≥ 6827 (8k/16k/32k) select 0.85·window BYTE-IDENTICAL
  // to before; only the small windows (2048/4096) take the lower L1-aligned trigger — the fix.
  const l1Budget = Math.max(256, window - CHAT_RESPONSE_RESERVE_TOKENS)
  const threshold = Math.min(COMPACT_THRESHOLD * window, l1Budget)
  if (estimated < threshold) return

  // Protect the recent tail verbatim; summarize the region before it. Too few ⇒ no-op.
  const region = compactable.slice(0, Math.max(0, compactable.length - KEEP_RECENT_TURNS))
  if (region.length < MIN_COMPACTABLE_TURNS) return

  // The summary subsumes through the last turn of the region; assembly replays turns after it.
  const coversThroughRowid = region[region.length - 1].rowid

  opts.onStart?.()

  // The summarizer input: the prior summary (chained re-compaction, §4.7) followed by the rendered
  // region. Built from the STORED RAW turns (R-RAG) — never a transient grounded prompt.
  const renderedRegion = renderRegion(region)
  const input = checkpoint
    ? `Summary of the conversation so far:\n${checkpoint.summary}\n\n` +
      `--- New messages since that summary ---\n\n${renderedRegion}`
    : renderedRegion

  let summary: string
  try {
    summary = await summarizeRegion(runtime, input, window, opts.signal)
  } catch (err) {
    // R4/R6 — any summarizer failure falls back to L1 with no checkpoint and no user-visible error;
    // the turn still proceeds. F9 (post-merge audit): LOG the NON-abort case (a real bug — a
    // TypeError, a malformed checkpoint) so a repeatable summarizer failure isn't silently masked as
    // "below threshold" forever on this offline, no-telemetry app (every other chat-stack error path
    // logs under a label). A user Stop (AbortError) is expected and must NOT log.
    if (!isAbortError(err, opts.signal)) {
      log.warn('Compaction summary failed; falling back to L1 trim', {
        conversationId,
        message: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }
  // A cancel that resolved the stream cleanly (the mock returns on abort) still means "abandon".
  if (opts.signal?.aborted) return
  summary = stripThinkBlocks(summary).trim()
  if (summary === '') return // empty summary ⇒ no checkpoint; L1 handles length

  writeCheckpoint(db, { conversationId, summary, coversThroughRowid })
}

/** Estimated tokens for one stored turn (assistant reasoning is scrubbed before counting). */
function turnTokens(turn: ConversationTurn): number {
  const content = turn.role === 'assistant' ? stripThinkBlocks(turn.content) : turn.content
  return messageTokens({ role: turn.role, content })
}

/** Render the region as a plain `User:`/`Assistant:` transcript for the summarizer input. */
function renderRegion(turns: ConversationTurn[]): string {
  return turns
    .map((t) => {
      const label = t.role === 'user' ? 'User' : 'Assistant'
      const content = t.role === 'assistant' ? stripThinkBlocks(t.content) : t.content
      return `${label}: ${content.trim()}`
    })
    .join('\n\n')
}

/**
 * Summarize `input` with the §4.8 prompt in a non-thinking, low-temperature configuration. When the
 * input overflows the summarizer's own window, summarize in windows then reduce (§4.7), reusing the
 * doctasks word-budget windowing so a chained re-compaction can never itself overflow the model.
 */
async function summarizeRegion(
  runtime: ModelRuntime,
  input: string,
  window: number,
  signal?: AbortSignal
): Promise<string> {
  const windows = packIntoWindows([input], summaryBudgetWords(window))
  if (windows.length <= 1) {
    return runSummaryCall(runtime, windows[0] ?? input, signal)
  }
  // Map: summarize each window. Reduce: summarize the concatenated partials.
  const partials: string[] = []
  for (const w of windows) {
    if (signal?.aborted) return ''
    partials.push(await runSummaryCall(runtime, w, signal))
  }
  if (signal?.aborted) return ''
  return runSummaryCall(runtime, partials.join('\n\n'), signal)
}

/** One non-thinking, low-temp summarizer call on the active runtime; accumulates the stream. */
async function runSummaryCall(
  runtime: ModelRuntime,
  userContent: string,
  signal?: AbortSignal
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: selfSummaryPrompt },
    { role: 'user', content: userContent }
  ]
  let out = ''
  // `mode: 'balanced'` ⇒ `enable_thinking: false` with no sampling overrides; the explicit
  // temperature/maxTokens then win (RuntimeChatOptions contract). A model without thinking support
  // ignores the kwarg (R11).
  const stream = runtime.chatStream(messages, {
    signal,
    mode: 'balanced',
    temperature: SUMMARY_TEMPERATURE,
    maxTokens: SUMMARY_MAX_TOKENS
  })
  for await (const token of stream) {
    if (signal?.aborted) break
    out += token
  }
  return out
}
