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
// is no `[DONE]` sentinel. A mid-stream failure arrives as a frame with an `error` object.

/** llama-server `/completion` per-request timings (subset we surface). */
export interface CompletionTimings {
  /** Decode throughput — the headline tokens/sec the TG-2 smoke records (plan §7 → D10). */
  predicted_per_second?: number
  /** Prompt-prefill throughput. */
  prompt_per_second?: number
  predicted_n?: number
  prompt_n?: number
}

/** What the final frame reports — surfaced to the smoke via `onFinal` (never needed by callers). */
export interface CompletionFinal {
  timings?: CompletionTimings
  /** The stop string that ended generation (`<end_of_turn>` for a clean turn boundary). */
  stoppingWord?: string
}

interface CompletionFrame {
  content?: string
  stop?: boolean
  stopping_word?: string
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

/** Parse one SSE `data:` line → a content delta, a terminal `stop`, an `error`, or nothing. */
function parseCompletionLine(line: string): {
  delta?: string
  final?: CompletionFinal
  error?: CompletionError
} {
  const t = line.trim()
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
      out.final = { timings: frame.timings, stoppingWord: frame.stopping_word }
    }
    return out
  } catch {
    // Ignore keep-alives / partial frames; the next read completes them (readChatSSE precedent).
    return {}
  }
}

/**
 * Parse a Server-Sent-Events stream of llama-server `/completion` chunks, yielding each text
 * delta. The final frame (`stop: true`) is reported through `onFinal` (its `timings`/`stopping_word`)
 * and ends the stream — its own `content` is empty, so nothing is dropped. A mid-stream `error`
 * frame throws a `CompletionError`. Handles partial lines across reads, ignores keep-alive/comment
 * lines, and honours `signal` so an aborted request stops promptly and cancels the reader.
 *
 * Structurally mirrors `readChatSSE` (buffer → split on `\n` → flush) so the two SSE readers share
 * the same partial-frame + abort discipline; only the frame SHAPE differs (bare object, no
 * `choices[].delta`, no `[DONE]`).
 */
export async function* readCompletionSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onFinal?: (info: CompletionFinal) => void
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const r = parseCompletionLine(line)
        if (r.error) throw r.error
        if (r.delta) yield r.delta
        if (r.final) {
          onFinal?.(r.final)
          return
        }
      }
    }
    // Flush a final line the server sent without a trailing newline before closing.
    buffer += decoder.decode()
    const r = parseCompletionLine(buffer)
    if (r.error) throw r.error
    if (r.delta) yield r.delta
    if (r.final) onFinal?.(r.final)
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* the stream may already be closed */
    }
  }
}
