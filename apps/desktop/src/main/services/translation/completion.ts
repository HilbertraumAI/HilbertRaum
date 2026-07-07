// Raw `/completion` SSE reader for the translation sidecar (TG wave, plan §2 D2).
//
// TranslateGemma runs WITHOUT `--jinja` (the #20305 regression, plan §1.1), so the translation
// sidecar does NOT use the OpenAI `/v1/chat/completions` path that `runtime/llama.ts:readChatSSE`
// parses. It calls llama-server's NATIVE `/completion` endpoint with an app-built prompt
// (`prompt.ts`). Precedent for a non-chat loopback client: the e5 embedder + reranker endpoint
// clients (they POST `/embedding` and `/v1/rerank`).
//
// The `/completion` stream shape differs from the chat SSE: each frame is a bare JSON object
// (NOT wrapped in `choices[].delta`), incremental text in `content`, and a FINAL frame with
// `stop: true` carrying `timings` (tokens/sec — the smoke's D10 artifact) + `stopping_word`. There
// is no `[DONE]` sentinel. A mid-stream failure arrives EITHER as a `data:` frame with an `error`
// object OR as a bare `error:` SSE field line (llama.cpp emits both shapes) — TA-4 M3 handles both.

import { log } from '../logging'

/** llama-server `/completion` per-request timings (subset we surface). */
export interface CompletionTimings {
  /** Decode throughput — the headline tokens/sec the TG-2 smoke records (plan §7 → D10). */
  predicted_per_second?: number
  /** Prompt-prefill throughput. */
  prompt_per_second?: number
  predicted_n?: number
  prompt_n?: number
}

/** What the final frame reports — surfaced to callers via `onFinal` (TA-5 M6 makes it load-bearing). */
export interface CompletionFinal {
  timings?: CompletionTimings
  /** The stop string that ended generation (`<end_of_turn>` for a clean turn boundary). */
  stoppingWord?: string
  /**
   * The generation ended on the model's end-of-turn / EOS token — a CLEAN stop, as opposed to
   * running into the token/context cap (a LIMIT stop → truncation). LEGACY field: older
   * llama-server builds reported this as a `stopped_eos` boolean; the pinned b9849 reports the
   * consolidated `stop_type` instead (see `stopType`). Kept so an older/mocked frame still counts.
   */
  stoppedEos?: boolean
  /**
   * The MODERN llama-server stop reason (issue #31 fix): the server rework consolidated the old
   * `stopped_eos`/`stopped_word`/`stopped_limit` booleans into ONE `stop_type` field —
   * `'none' | 'eos' | 'limit' | 'word'`. On the pinned b9849 a Gemma turn ends on
   * `<end_of_turn>` as an EOS-class token, so the final frame is `stop_type: "eos"` with an
   * EMPTY `stopping_word` — the shape the pre-fix `isCleanStop` misread as a limit stop, flagging
   * every SUCCESSFUL window `runtimeFailed` (the "translation works but the failure banner always
   * shows" bug). Typed `string` (not a closed union) so an unknown future value degrades to
   * not-clean, never a parse failure.
   */
  stopType?: string
}

/**
 * Did the window stop CLEANLY (the model chose to end the turn) rather than being truncated at the
 * output-limit cap? TA-5 M6, re-grounded against the REAL pin for issue #31: a clean stop is
 * `stop_type: 'eos' | 'word'` (the pinned b9849's consolidated field — on Gemma a finished turn is
 * `eos` with an EMPTY `stopping_word`, so the stop string alone is NOT a reliable signal), or —
 * for older/mocked frame shapes — a non-empty `stopping_word` / the legacy `stopped_eos` flag. A
 * LIMIT stop (`stop_type: 'limit'`: a greedy-decode repetition loop, or a token-dense window
 * running to the ~2,070-token cap) carries none of these. Both translation consumers (the doc-task
 * `translateWithRetry` and the view job loop) treat a non-clean stop as a FAILED window —
 * retry-then-mark / retry-then-fail — so a mid-sentence truncation is never persisted or shown as
 * a finished translation. A missing `final` (no terminal frame at all) is already an
 * `IncompleteStreamError` thrown by `readCompletionSSE`, so callers only reach here with a real frame.
 */
export function isCleanStop(final: CompletionFinal | undefined): boolean {
  if (!final) return false
  if (final.stopType === 'eos' || final.stopType === 'word') return true
  return (typeof final.stoppingWord === 'string' && final.stoppingWord.length > 0) || final.stoppedEos === true
}

interface CompletionFrame {
  content?: string
  stop?: boolean
  stopping_word?: string
  stopped_eos?: boolean
  stop_type?: string
  timings?: CompletionTimings
  error?: { message?: string; type?: string }
}

/** A `/completion` error frame surfaced as a typed error (mirrors `ChatRequestError`'s intent). */
export class CompletionError extends Error {
  readonly serverType: string
  constructor(serverMessage: string, serverType: string) {
    super(`Translation request failed${serverMessage ? `: ${serverMessage}` : ''}`)
    this.name = 'CompletionError'
    this.serverType = serverType
  }
}

/**
 * The stream closed (server-side reader `done` OR a flushed tail) WITHOUT the terminal `stop: true`
 * frame — a silently truncated window (TA-4 M2). A `CompletionError` SUBTYPE so it is NOT an
 * `AbortError`: both consumers (the view job loop's `catch` and the doc-task `translateWithRetry`)
 * treat it as a normal runtime failure → retry-then-fail, never as a user cancel.
 */
export class IncompleteStreamError extends CompletionError {
  constructor() {
    super('stream ended before the terminal stop frame', 'incomplete_stream')
    this.name = 'IncompleteStreamError'
  }
}

/**
 * Parse one SSE line → a content delta, a terminal `stop`, an `error`, a dropped (garbled) marker,
 * or nothing. Handles both frame carriers: `data:` (the normal shape) and a bare `error:` field line
 * (llama.cpp's alternative mid-stream failure shape — TA-4 M3). A `data:` line whose JSON does not
 * parse is a genuinely garbled COMPLETE frame (the caller only ever feeds whole lines), flagged
 * `dropped` so the reader can count it content-free (TA-4 L4) — NOT a partial frame.
 */
function parseCompletionLine(line: string): {
  delta?: string
  final?: CompletionFinal
  error?: CompletionError
  dropped?: boolean
} {
  const t = line.trim()
  // M3: llama.cpp can report a mid-stream failure as a bare `error: {…}` SSE field line (not a
  // `data:` frame). Recognize it and map to the same typed error — a present error field is never a
  // keep-alive, so even an unparseable payload is surfaced (as a generic CompletionError), not swallowed.
  if (t.startsWith('error:')) {
    const data = t.slice('error:'.length).trim()
    if (!data) return { error: new CompletionError('', '') }
    try {
      const parsed = JSON.parse(data) as {
        error?: { message?: string; type?: string }
        message?: string
        type?: string
      }
      const e = parsed.error ?? parsed
      return { error: new CompletionError(e.message?.trim() ?? '', e.type?.trim() ?? '') }
    } catch {
      return { error: new CompletionError('', '') }
    }
  }
  if (!t.startsWith('data:')) return {}
  const data = t.slice(5).trim()
  if (!data) return {}
  try {
    const frame = JSON.parse(data) as CompletionFrame
    if (frame.error) {
      return {
        error: new CompletionError(frame.error.message?.trim() ?? '', frame.error.type?.trim() ?? '')
      }
    }
    const out: { delta?: string; final?: CompletionFinal } = {}
    if (typeof frame.content === 'string' && frame.content.length > 0) out.delta = frame.content
    if (frame.stop === true) {
      out.final = {
        timings: frame.timings,
        stoppingWord: frame.stopping_word,
        stoppedEos: frame.stopped_eos,
        stopType: frame.stop_type
      }
    }
    return out
  } catch {
    // L4: the `\n`-splitter only feeds COMPLETE lines, so a JSON parse failure here is a genuinely
    // garbled frame (NOT a partial one the next read would finish). Flag it; the reader counts it
    // content-free and skips it — the stream continues.
    return { dropped: true }
  }
}

/** The reason to throw on abort — the caller's own reason if set, else a matching AbortError. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The translation was aborted', 'AbortError')
}

/**
 * Parse a Server-Sent-Events stream of llama-server `/completion` chunks, yielding each text
 * delta. The final frame (`stop: true`) is reported through `onFinal` (its `timings`/`stopping_word`)
 * and ends the stream — its own `content` is empty, so nothing is dropped. A mid-stream `error`
 * frame (or `error:` field line) throws a `CompletionError`. Handles partial lines across reads,
 * ignores keep-alive/comment lines, and honours `signal`.
 *
 * TA-4 hardening:
 *   • M2 — if the stream ends WITHOUT the terminal `stop: true` frame (a server-side close
 *     mid-decode) and the caller did NOT abort, throw `IncompleteStreamError` so the accumulated
 *     partial is never resolved as a truncated "success".
 *   • L1 — if the caller aborted, THROW the abort reason instead of returning cleanly, so a
 *     partial cannot resolve as success (matches what an in-`read()` abort already throws).
 *   • L4 — count garbled (unparseable) complete frames content-free and warn once per stream.
 *
 * Structurally mirrors `readChatSSE` (buffer → split on `\n` → flush) so the two SSE readers share
 * the same partial-frame discipline; only the frame SHAPE differs (bare object, no `choices[].delta`,
 * no `[DONE]`) and the terminal-frame + abort contract is stricter here.
 */
export async function* readCompletionSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onFinal?: (info: CompletionFinal) => void
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawFinal = false
  let dropped = 0
  try {
    for (;;) {
      // L1: an abort between token deliveries throws (not a clean return) so no partial resolves.
      if (signal?.aborted) throw abortReason(signal)
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const r = parseCompletionLine(line)
        if (r.error) throw r.error
        if (r.dropped) dropped++
        if (r.delta) yield r.delta
        if (r.final) {
          onFinal?.(r.final)
          sawFinal = true
          return
        }
      }
    }
    // Flush a final line the server sent without a trailing newline before closing.
    buffer += decoder.decode()
    const r = parseCompletionLine(buffer)
    if (r.error) throw r.error
    if (r.dropped) dropped++
    if (r.delta) yield r.delta
    if (r.final) {
      onFinal?.(r.final)
      sawFinal = true
    }
    // L1: an abort that landed exactly as the stream closed must still throw, not resolve.
    if (signal?.aborted) throw abortReason(signal)
    // M2: the server closed mid-decode without the terminal `stop` frame — a silent truncation.
    if (!sawFinal) throw new IncompleteStreamError()
  } finally {
    // L4: content-free — the COUNT only, never the frame text (the privacy rule).
    if (dropped > 0) log.warn('translation SSE: dropped unparseable frame', { count: dropped })
    try {
      await reader.cancel()
    } catch {
      /* the stream may already be closed */
    }
  }
}
