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
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {})
    })

    const res = await this.server.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: options?.signal
    })
    if (!res.ok || !res.body) {
      // Cancel the body so undici releases the connection instead of holding it
      // until GC.
      void res.body?.cancel().catch(() => undefined)
      throw new Error(`Chat request failed: HTTP ${res.status}`)
    }
    yield* readChatSSE(res.body, options?.signal, options?.onReasoning)
  }
}

/** Factory mirroring `createMockRuntime`; selected by the runtime factory when a binary + weights exist. */
export function createLlamaRuntime(opts: RuntimeStartOptions, deps: LlamaRuntimeDeps): LlamaRuntime {
  return new LlamaRuntime(opts, deps)
}
