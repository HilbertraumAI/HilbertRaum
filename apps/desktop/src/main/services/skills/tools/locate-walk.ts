import type { JsonSchema } from '../../../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../runtime'
import { buildLocateWindows, estimateLocateTokens, splitLocateWindow, type LocateWindow } from './locate-windows'

// #622: the window walk both LLM locate passes share — the redaction locate (architecture.md "Skills —
// design record" §21) and the document-edit locate (§22). It owns what the two passes used to repeat:
// the windows, the grammar-constrained request (D55, temperature 0), the reply, abort and progress. The
// passes keep what differs: the prompt, the schema, the parser, and how proposals are collected.
//
// Why it exists. Each window's reply was capped at a fixed 768 tokens and each window at 40 lines, with
// no regard for the model's context. Measured 2026-10-06 (Qwen3 4B, b11146): dense windows need 744–1,293
// reply tokens, so a reply cut at 768 failed to parse and the window added NOTHING, silently — on master
// 8 of a register's 10 client names stayed visible while the run said "142 items hidden". And 40 long
// paragraphs overflowed a 4,096-token context on every run. Now:
//   - the window gets a third of the context left after the system prompt, the reply the rest
//     (replies measured up to 1.5× their window's tokens);
//   - a reply cut short (`finish_reason: length`, or the runaway char cap) or a prompt over the context
//     (llama-server HTTP 400 `exceed_context_size_error`) splits the window in half and asks again;
//   - a window that cannot get smaller throws — `LocateTooLongError` (its prompt is still over the context)
//     or `LocateReplyCutError` (its reply is still cut: a model repeating itself) — never a silent skip.
// A reply that finished normally but does not parse (the dev mock runtime ignores the schema) is still
// skipped: that is not a cut.
//
// PRIVACY: the proposals are CONTENT. They go to the pass's `onWindow` callback and nowhere else — no
// log, no audit, no error message (§22-M1). Pure main-side TS: the runtime is the only seam.

/** The context assumed for a runtime that does not report one: the smallest any shipped model launches. */
export const DEFAULT_LOCATE_CONTEXT_TOKENS = 4096
/** The window's share of the context left after the system prompt; the reply gets the rest. */
const WINDOW_SHARE = 1 / 3
/** The chat template's wrappers around the system and user messages (17 measured) plus estimate slop. */
const TEMPLATE_TOKENS = 64
/** The reply ceiling: the redaction schema's 128 entities at ~30 tokens each fit; a denser window splits. */
export const LOCATE_REPLY_MAX_TOKENS = 4096
/** The reply floor, for a context too small to leave more (no shipped model). */
const LOCATE_REPLY_MIN_TOKENS = 256
/** Char cap multiplier — the same runaway-runtime bound the enricher uses (audit L-2). */
const OUTPUT_CHAR_CAP_PER_TOKEN = 8

/** #622: a window whose prompt was still over the context after it could not be split any further. */
export class LocateTooLongError extends Error {
  constructor() {
    super('A part of this document is too long for the current model, even split into the smallest pieces.')
    this.name = 'LocateTooLongError'
  }
}

/**
 * #622: a window whose reply was still cut short at its smallest. A piece that small needs a few hundred
 * reply tokens at most, so this is a model repeating itself (temperature 0 under the grammar can loop to
 * the schema's item limit), not a size problem — the seams report it as the model failing.
 */
export class LocateReplyCutError extends Error {
  constructor() {
    super("The model's reply was cut short even for the smallest piece of the document.")
    this.name = 'LocateReplyCutError'
  }
}

/**
 * llama-server's HTTP 400 `exceed_context_size_error` (`ChatRequestError` in `runtime/llama.ts`,
 * `isExceedContextError`). Matched by shape so the skill tools import no concrete runtime (spec §9.2) —
 * the `RuntimeUnresponsiveError` precedent in `runtime/index.ts`.
 */
function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'ChatRequestError') return false
  const e = err as Error & { status?: number; serverType?: string; serverMessage?: string }
  if (e.serverType === 'exceed_context_size_error') return true
  return e.status === 400 && /context size|context window|n_ctx|exceed/i.test(e.serverMessage ?? '')
}

/** The token budget for one walk: what a window may cost, and what a window leaves its reply. */
export interface LocateBudget {
  windowTokens: number
  replyTokens: (window: LocateWindow) => number
}

/** #622: the budget for a model launched with `contextTokens` and a pass whose system prompt is `system`. */
export function locateBudget(contextTokens: number, system: string): LocateBudget {
  const available = Math.max(0, contextTokens - estimateLocateTokens(system) - TEMPLATE_TOKENS)
  return {
    windowTokens: Math.max(1, Math.floor(available * WINDOW_SHARE)),
    replyTokens: (w) =>
      Math.min(LOCATE_REPLY_MAX_TOKENS, Math.max(LOCATE_REPLY_MIN_TOKENS, available - estimateLocateTokens(w.numbered)))
  }
}

export interface LocateWalkRequest<T> {
  system: string
  schema: JsonSchema
  schemaName: string
  /** Parse one window's reply into proposals; a malformed reply yields []. */
  parse: (reply: string) => T[]
  /** The AbortError message a cancel throws with (the seam maps it to a calm cancel). */
  cancelledMessage: string
}

export interface LocateWalkDeps {
  runtime: ModelRuntime
  signal: AbortSignal
  onProgress?: (done: number, total: number) => void
}

/**
 * Walk `text` window by window and hand each window's parsed proposals to `onWindow` (with the window,
 * so a pass can map a piece's anchor back to its line). `onWindow` returns false to stop the walk — a
 * pass whose proposal cap is full. Resolves `stoppedEarly` when it stopped with windows left.
 * `onProgress(done, total)` ticks per finished window; `total` grows when a window splits.
 * Throws: an AbortError on a cancel; `LocateTooLongError` / `LocateReplyCutError` (see above); any other
 * runtime failure as is (the seams fail the run, #620).
 */
export async function walkLocateWindows<T>(
  text: string,
  req: LocateWalkRequest<T>,
  deps: LocateWalkDeps,
  onWindow: (proposals: T[], window: LocateWindow) => boolean
): Promise<{ stoppedEarly: boolean }> {
  const budget = locateBudget(deps.runtime.contextWindow?.() ?? DEFAULT_LOCATE_CONTEXT_TOKENS, req.system)
  const pending = buildLocateWindows(text, { maxTokens: budget.windowTokens })
  const cancelled = (): DOMException => new DOMException(req.cancelledMessage, 'AbortError')
  let done = 0
  while (pending.length > 0) {
    if (deps.signal.aborted) throw cancelled()
    const window = pending.shift() as LocateWindow
    const answer = await askWindow(window, budget.replyTokens(window), req, deps, cancelled)
    if (answer === 'cut' || answer === 'overflow') {
      // Cut short or over the context: ask again in two halves, ahead of the windows still waiting.
      const halves = splitLocateWindow(window)
      if (halves === null) throw answer === 'overflow' ? new LocateTooLongError() : new LocateReplyCutError()
      pending.unshift(...halves)
      continue
    }
    done++
    const proceed = onWindow(req.parse(answer.reply), window)
    deps.onProgress?.(done, done + pending.length)
    if (!proceed) return { stoppedEarly: pending.length > 0 }
  }
  return { stoppedEarly: false }
}

/** One window's grammar-constrained reply, or why there is none: cut short, or a prompt over the context. */
async function askWindow<T>(
  window: LocateWindow,
  maxTokens: number,
  req: LocateWalkRequest<T>,
  deps: LocateWalkDeps,
  cancelled: () => DOMException
): Promise<{ reply: string } | 'cut' | 'overflow'> {
  const messages: ChatMessage[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: window.numbered }
  ]
  let finish: string | undefined
  const options: RuntimeChatOptions = {
    signal: deps.signal,
    maxTokens,
    temperature: 0,
    responseSchema: req.schema,
    responseSchemaName: req.schemaName,
    onFinish: (reason) => {
      finish = reason
    }
  }
  const charCap = maxTokens * OUTPUT_CHAR_CAP_PER_TOKEN
  let text = ''
  try {
    for await (const token of deps.runtime.chatStream(messages, options)) {
      if (deps.signal.aborted) throw cancelled()
      text += token
      if (text.length > charCap) return 'cut'
    }
  } catch (e) {
    if (!deps.signal.aborted && isContextOverflow(e)) return 'overflow'
    throw e
  }
  if (deps.signal.aborted) throw cancelled()
  return finish === 'length' ? 'cut' : { reply: text }
}
