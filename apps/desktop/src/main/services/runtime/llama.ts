import type { ChatDepthMode } from '../../../shared/types'
import type {
  ChatMessage,
  HealthStatus,
  ModelRuntime,
  RuntimeChatOptions,
  RuntimeStartOptions
} from './index'
import { LlamaServer, type LlamaServerOptions } from './sidecar'

// Real local inference (spec §3.2, §7.5). `LlamaRuntime` drops in behind
// the existing `ModelRuntime` interface: it spawns a `llama.cpp` `llama-server` sidecar
// bound to 127.0.0.1 (see `sidecar.ts`), then streams tokens from the server's
// OpenAI-compatible `/v1/chat/completions` endpoint. The server applies the model's
// chat template, so we send plain role/content messages — we never hand-roll Qwen's
// prompt format. Fully offline: the only socket is loopback to the sidecar.

/**
 * Args every CHAT sidecar gets (verified against the pinned llama.cpp b9585 source;
 * rationale in architecture.md "Chat & streaming"):
 *   --jinja                      the kwargs-driven thinking switch only acts in the
 *                                jinja template path (b9585 default is already jinja;
 *                                pinned explicitly so the mechanism's precondition is
 *                                stated in code, not assumed from upstream defaults)
 *   --reasoning-format deepseek  thinking output streams as separate
 *                                `delta.reasoning_content` frames — never inline
 *                                `<think>` tags in `delta.content`
 * The E5 embedder composes `LlamaServer` directly and does not get these.
 */
export const CHAT_SERVER_ARGS = ['--jinja', '--reasoning-format', 'deepseek'] as const

/**
 * Physical-batch cap for the chat sidecar's prompt prefill (RT-1, perf audit 2026-06-18).
 * llama-server defaults `--batch-size`/`--ubatch-size` to 512, which chunks prefill — the
 * dominant time-to-first-token cost — into 512-token pieces. We raise it to the context size
 * but cap at 2048 (a low-risk validated start on the pinned b9585; the whole prompt can't exceed
 * n_ctx anyway, so `min(ctx, 2048)` never over-allocates the batch). Mirrors the reranker, which
 * raises its batch to the context for the same reason (reranker/llama.ts:96-115).
 */
export const CHAT_MAX_PHYSICAL_BATCH = 2048

/** Per-runtime overrides; mostly test seams forwarded to `LlamaServer`. */
export type LlamaRuntimeDeps = Pick<
  LlamaServerOptions,
  | 'spawn'
  | 'fetchImpl'
  | 'findPort'
  | 'threads'
  | 'healthTimeoutMs'
  | 'healthIntervalMs'
  | 'host'
  // GPU ladder: forces CPU via `extraArgs: ['--device','none']` — `--device none` is
  // the ONLY CPU-forcing mechanism, NEVER `-ngl` — and hooks mid-session crashes.
  | 'extraArgs'
  | 'onUnexpectedExit'
> & {
  binPath: string
}

/**
 * What an answer-depth mode means for the chat request (LOCKED — architecture.md
 * "Chat & streaming"):
 *
 *   fast      thinking off + temperature 0.7 + a modest token cap — quick answers
 *   balanced  thinking off, the server/model sampling defaults — the default mode,
 *             also used whenever `mode` is omitted (document answers, old callers)
 *   deep      thinking ON + temperature 0.6 (Qwen3's documented thinking-mode
 *             sampling), uncapped
 *
 * `enableThinking` is ALWAYS explicit: at the pinned b9585 the server defaults to
 * `--reasoning auto`, which turns thinking ON for any template that supports it
 * (all four bundled Qwen3 models) — omitting the kwarg would make every mode think.
 * Explicit `RuntimeChatOptions.maxTokens`/`temperature` win over these values.
 */
export interface ModeRequestParams {
  enableThinking: boolean
  temperature?: number
  maxTokens?: number
}

export const FAST_TEMPERATURE = 0.7
export const FAST_MAX_TOKENS = 1024
export const DEEP_TEMPERATURE = 0.6

/** Map an answer-depth mode to request parameters. Omitted/unknown = 'balanced'. */
export function requestParamsForMode(mode?: ChatDepthMode): ModeRequestParams {
  switch (mode) {
    case 'fast':
      return { enableThinking: false, temperature: FAST_TEMPERATURE, maxTokens: FAST_MAX_TOKENS }
    case 'deep':
      return { enableThinking: true, temperature: DEEP_TEMPERATURE }
    default:
      return { enableThinking: false }
  }
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
}

/** Parse one SSE `data:` line → content/reasoning deltas, a `[DONE]` sentinel, or nothing. */
function parseSseLine(line: string): { delta?: string; reasoning?: string; done?: boolean } {
  const t = line.trim()
  if (!t.startsWith('data:')) return {}
  const data = t.slice(5).trim()
  if (data === '[DONE]') return { done: true }
  try {
    const json = JSON.parse(data) as ChatCompletionChunk
    const d = json.choices?.[0]?.delta
    const out: { delta?: string; reasoning?: string } = {}
    if (typeof d?.content === 'string' && d.content.length > 0) out.delta = d.content
    if (typeof d?.reasoning_content === 'string' && d.reasoning_content.length > 0) {
      out.reasoning = d.reasoning_content
    }
    return out
  } catch {
    // Ignore non-JSON keep-alives / partial frames; the next read completes them.
  }
  return {}
}

/**
 * Parse a Server-Sent-Events stream of OpenAI chat-completion chunks, yielding each
 * answer-text delta. Reasoning deltas (`delta.reasoning_content`, Deep mode) are
 * reported through `onReasoning` and are NEVER yielded — the yielded stream stays
 * answer-only, so the locked streaming token contract is untouched. Handles partial
 * lines across reads, ignores keep-alive/comment lines, and stops on the `[DONE]`
 * sentinel. Honours `signal` so an aborted request stops promptly and cancels the
 * underlying reader.
 */
export async function* readChatSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onReasoning?: (delta: string) => void
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
        const r = parseSseLine(line)
        if (r.done) return
        if (r.reasoning) onReasoning?.(r.reasoning)
        if (r.delta) yield r.delta
      }
    }
    // Flush any final line the server sent without a trailing newline before closing.
    buffer += decoder.decode()
    const r = parseSseLine(buffer)
    if (r.reasoning) onReasoning?.(r.reasoning)
    if (r.delta) yield r.delta
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* the stream may already be closed */
    }
  }
}

export class LlamaRuntime implements ModelRuntime {
  readonly modelId: string
  private readonly server: LlamaServer

  constructor(opts: RuntimeStartOptions, deps: LlamaRuntimeDeps) {
    this.modelId = opts.modelId
    this.server = new LlamaServer({
      binPath: deps.binPath,
      modelPath: opts.modelPath,
      contextTokens: opts.contextTokens,
      physicalBatchSize: Math.min(opts.contextTokens, CHAT_MAX_PHYSICAL_BATCH),
      extraArgs: [...CHAT_SERVER_ARGS, ...(deps.extraArgs ?? [])],
      onUnexpectedExit: deps.onUnexpectedExit,
      spawn: deps.spawn,
      fetchImpl: deps.fetchImpl,
      findPort: deps.findPort,
      threads: deps.threads,
      healthTimeoutMs: deps.healthTimeoutMs,
      healthIntervalMs: deps.healthIntervalMs,
      host: deps.host
    })
  }

  async start(): Promise<void> {
    await this.server.start()
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  async health(): Promise<HealthStatus> {
    return this.server.health()
  }

  /**
   * Stream assistant tokens from the OpenAI-compatible endpoint. `messages` map
   * directly to role/content; `maxTokens`/`temperature` map to `max_tokens`/
   * `temperature` (explicit values win over the mode mapping). The answer-depth
   * `mode` maps to `chat_template_kwargs.enable_thinking` — verified per-request
   * support at the pinned b9585 — plus the per-mode sampling defaults; with
   * thinking on, reasoning deltas surface via `options.onReasoning`, never in the
   * yielded answer stream. Aborts the fetch + generator on `options.signal`.
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: RuntimeChatOptions
  ): AsyncGenerator<string, void, unknown> {
    const mode = requestParamsForMode(options?.mode)
    const maxTokens = options?.maxTokens ?? mode.maxTokens
    const temperature = options?.temperature ?? mode.temperature
    const body = JSON.stringify({
      model: this.modelId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      chat_template_kwargs: { enable_thinking: mode.enableThinking },
      // Reuse the slot's KV cache for the longest common token prefix across turns instead of
      // re-prefilling the whole prompt every request. We set this EXPLICITLY rather than relying
      // on the llama-server default (which has changed across releases): with a stable system
      // prefix — e.g. the skill fence bracketed in `system` for plain chat (skills §5/§22-A6) —
      // the injected fence is prefilled once and then cached, so toggling a skill on costs one
      // prefill, not one per turn. Loopback-only, no telemetry — purely a local compute hint.
      cache_prompt: true,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {})
    })

    const res = await this.server.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: options?.signal
    })
    if (!res.ok) {
      // Read the body for the REASON: llama-server returns a JSON error
      // (`{error:{message,type}}`) that explains the failure — most importantly
      // `exceed_context_size_error` when the prompt is larger than the model's context
      // window. Surfacing it turns an opaque "HTTP 400" into an actionable error and
      // drains the body so undici releases the connection. (readBody handles no-body.)
      throw await chatRequestError(res)
    }
    if (!res.body) {
      throw new ChatRequestError(res.status, 'empty response body', '')
    }
    yield* readChatSSE(res.body, options?.signal, options?.onReasoning)
  }
}

/** Cap on how much of a non-JSON error body we keep in the message. */
const ERROR_BODY_MAX_CHARS = 500

/**
 * A failed `/v1/chat/completions` request, carrying the HTTP status plus the server's
 * own error `message`/`type` when it sent the OpenAI-style `{error:{…}}` body. The
 * message stays "Chat request failed: HTTP <status>" (callers/tests match on it) with the
 * server reason appended.
 */
export class ChatRequestError extends Error {
  readonly status: number
  readonly serverMessage: string
  readonly serverType: string
  constructor(status: number, serverMessage: string, serverType: string) {
    super(`Chat request failed: HTTP ${status}${serverMessage ? ` — ${serverMessage}` : ''}`)
    this.name = 'ChatRequestError'
    this.status = status
    this.serverMessage = serverMessage
    this.serverType = serverType
  }
}

/** Build a `ChatRequestError` from a non-ok Response, extracting the server's reason. */
async function chatRequestError(res: Response): Promise<ChatRequestError> {
  let serverMessage = ''
  let serverType = ''
  try {
    const raw = await res.text()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string; type?: string } }
        serverMessage = parsed.error?.message?.trim() ?? ''
        serverType = parsed.error?.type?.trim() ?? ''
        if (!serverMessage) serverMessage = raw.slice(0, ERROR_BODY_MAX_CHARS)
      } catch {
        serverMessage = raw.slice(0, ERROR_BODY_MAX_CHARS)
      }
    }
  } catch {
    // Body unreadable (already consumed / stream error) — the status alone must do.
  }
  return new ChatRequestError(res.status, serverMessage, serverType)
}

/**
 * True when a chat request was rejected because the prompt exceeds the model's context
 * window (llama-server `exceed_context_size_error`, an HTTP 400). The doctask + chat
 * layers map this to a friendly "too large for this model" message instead of a raw code.
 */
export function isExceedContextError(err: unknown): boolean {
  if (!(err instanceof ChatRequestError)) return false
  if (err.serverType === 'exceed_context_size_error') return true
  return err.status === 400 && /context size|context window|n_ctx|exceed/i.test(err.serverMessage)
}

/** Factory mirroring `createMockRuntime`; selected by the runtime factory when a binary + weights exist. */
export function createLlamaRuntime(opts: RuntimeStartOptions, deps: LlamaRuntimeDeps): LlamaRuntime {
  return new LlamaRuntime(opts, deps)
}
