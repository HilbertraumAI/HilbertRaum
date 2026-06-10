import type {
  ChatMessage,
  HealthStatus,
  ModelRuntime,
  RuntimeChatOptions,
  RuntimeStartOptions
} from './index'
import { LlamaServer, type LlamaServerOptions } from './sidecar'

// Real local inference (spec §3.2, §7.5, Milestone 2). `LlamaRuntime` drops in behind
// the existing `ModelRuntime` interface: it spawns a `llama.cpp` `llama-server` sidecar
// bound to 127.0.0.1 (see `sidecar.ts`), then streams tokens from the server's
// OpenAI-compatible `/v1/chat/completions` endpoint. The server applies the model's
// chat template, so we send plain role/content messages — we never hand-roll Qwen's
// prompt format. Fully offline: the only socket is loopback to the sidecar.

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
  // Phase 15 (GPU ladder): the ladder forces CPU via `extraArgs: ['--device','none']`
  // (NEVER `-ngl` — locked decision) and hooks mid-session crashes.
  | 'extraArgs'
  | 'onUnexpectedExit'
> & {
  binPath: string
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string } }>
}

/** Parse one SSE `data:` line → a delta to yield, a `[DONE]` sentinel, or nothing. */
function parseSseLine(line: string): { delta?: string; done?: boolean } {
  const t = line.trim()
  if (!t.startsWith('data:')) return {}
  const data = t.slice(5).trim()
  if (data === '[DONE]') return { done: true }
  try {
    const json = JSON.parse(data) as ChatCompletionChunk
    const delta = json.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta.length > 0) return { delta }
  } catch {
    // Ignore non-JSON keep-alives / partial frames; the next read completes them.
  }
  return {}
}

/**
 * Parse a Server-Sent-Events stream of OpenAI chat-completion chunks, yielding each
 * text delta. Handles partial lines across reads, ignores keep-alive/comment lines,
 * and stops on the `[DONE]` sentinel. Honours `signal` so an aborted request stops
 * promptly and cancels the underlying reader.
 */
export async function* readChatSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
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
        if (r.delta) yield r.delta
      }
    }
    // Flush any final line the server sent without a trailing newline before closing.
    buffer += decoder.decode()
    const r = parseSseLine(buffer)
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
      extraArgs: deps.extraArgs,
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
   * `temperature`. Aborts the fetch + generator on `options.signal`.
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: RuntimeChatOptions
  ): AsyncGenerator<string, void, unknown> {
    const body = JSON.stringify({
      model: this.modelId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(options?.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
      ...(options?.temperature != null ? { temperature: options.temperature } : {})
    })

    const res = await this.server.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: options?.signal
    })
    if (!res.ok || !res.body) {
      // Cancel the body so undici releases the connection instead of holding it until
      // GC (L1, audit round 4).
      void res.body?.cancel().catch(() => undefined)
      throw new Error(`Chat request failed: HTTP ${res.status}`)
    }
    yield* readChatSSE(res.body, options?.signal)
  }
}

/** Factory mirroring `createMockRuntime`; selected by the runtime factory when a binary + weights exist. */
export function createLlamaRuntime(opts: RuntimeStartOptions, deps: LlamaRuntimeDeps): LlamaRuntime {
  return new LlamaRuntime(opts, deps)
}
