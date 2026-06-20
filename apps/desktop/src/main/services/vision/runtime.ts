import { LlamaServer, combineSignals, type LlamaServerOptions } from '../runtime/sidecar'
import { readChatSSE } from '../runtime/llama'

// The lazily-started vision sidecar (image-understanding plan §7 Option A, §10 `runtime.ts`).
// It composes `LlamaServer` DIRECTLY — like `E5Embedder`, NOT the chat `RuntimeManager` — so it
// does NOT inherit the chat slot's `CHAT_SERVER_ARGS` (RUNTIME-2). The V1 research gate
// (BUILD_STATE 2026-06-20) resolved the exact arg set on the pinned b9585:
//   • `--mmproj <projector>`  loads multimodal cleanly
//   • `--device none`         CPU-pin (mirrors the embedder; avoids VRAM contention)
//   • `--jinja` is DEFAULT-ENABLED on b9585 — do NOT pass it; and do NOT pass
//     `--reasoning-format deepseek` (Qwen2.5-VL is non-reasoning, emits no reasoning frames)
// The request is an OpenAI `content:[{type:'text'},{type:'image_url',image_url:{url:'data:…'}}]`
// with `cache_prompt:true` (the image prefill is cached across follow-ups), streamed back as SSE
// byte-identical to chat — so `readChatSSE` parses the frames unchanged (V1-confirmed).
//
// V2 SCOPE: this wires the real LlamaServer seam + the V1-resolved request. The idle-teardown
// timer (RUNTIME-4), the workspace-lock teardown wiring, and the dimension cap are V4 — this
// class deliberately stops at lazy start + analyze + stop, with no idle timer.

/** The vision sidecar's extra CLI args BESIDES `--mmproj <path>` (V1-resolved, RUNTIME-2). */
export const VISION_DEVICE_ARGS = ['--device', 'none'] as const

/** Default context window for the vision sidecar (V1 measured peak RSS ~4.6 GB at ctx 4096). */
const DEFAULT_VISION_CONTEXT_TOKENS = 4096
/** Per-analyze bound so a wedged sidecar fails the job instead of hanging it. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

export type VisionRuntimeDeps = Pick<
  LlamaServerOptions,
  'spawn' | 'fetchImpl' | 'findPort' | 'threads' | 'healthTimeoutMs' | 'healthIntervalMs' | 'host'
>

export interface VisionRuntimeOptions extends VisionRuntimeDeps {
  /** The vision model id (the manifest id) sent as the request `model`. */
  modelId: string
  binPath: string
  /** Absolute path to the language GGUF weight. */
  modelPath: string
  /** Absolute path to the mmproj projector (`--mmproj`). */
  projectorPath: string
  contextTokens?: number
  /** Per-analyze timeout in ms (default 300 000 — CPU prefill of a full image is slow). */
  requestTimeoutMs?: number
}

export interface VisionAnalyzeOptions {
  imageBytes: Uint8Array
  mimeType: string
  question: string
  /** A user "Stop" — combined with the per-request timeout (M-C5 pattern). */
  signal?: AbortSignal
  /** Streamed answer-token sink (the STREAM.imgToken forwarder). */
  onToken?: (delta: string) => void
}

/** Owns one lazily-started vision `llama-server` and answers one image question over loopback. */
export class VisionRuntime {
  readonly modelId: string
  private server: LlamaServer | null = null
  private starting: Promise<void> | null = null
  /** Set by `stop()`; a racing lazy start must not resurrect the sidecar after teardown. */
  private stopped = false
  /** Failed-start latch (the reranker/embedder pattern) — a corrupt GGUF mustn't re-spawn +
   *  re-await the full health timeout on every analyze. Cleared by `stop()`. */
  private startFailed: Error | null = null

  constructor(private readonly opts: VisionRuntimeOptions) {
    this.modelId = opts.modelId
  }

  /** Lazily spawn the vision sidecar (once). Concurrent callers share one start (single-flight). */
  private async ensureStarted(): Promise<LlamaServer> {
    if (this.stopped) throw new Error('Vision runtime is stopped')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    if (!this.starting) {
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens: this.opts.contextTokens ?? DEFAULT_VISION_CONTEXT_TOKENS,
        // V1-resolved: `--mmproj` loads multimodal; `--device none` CPU-pins. The b9585
        // default-on `--jinja` gives the multimodal chat-template path without inheriting
        // CHAT_SERVER_ARGS; `--reasoning-format` is left at default (non-reasoning VLM).
        extraArgs: ['--mmproj', this.opts.projectorPath, ...VISION_DEVICE_ARGS],
        spawn: this.opts.spawn,
        fetchImpl: this.opts.fetchImpl,
        findPort: this.opts.findPort,
        threads: this.opts.threads,
        healthTimeoutMs: this.opts.healthTimeoutMs,
        healthIntervalMs: this.opts.healthIntervalMs,
        host: this.opts.host
      })
      this.starting = server
        .start()
        .then(() => {
          this.server = server
        })
        .catch((err) => {
          this.startFailed = err instanceof Error ? err : new Error(String(err))
          throw this.startFailed
        })
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
    if (!this.server) throw new Error('Vision server failed to start')
    return this.server
  }

  /**
   * Analyze ONE image: base64-inline the bytes into an OpenAI `image_url` data-URL request
   * (no disk write), stream the answer through `onToken`, and return the full text. Honours
   * `signal` (a user "Stop") combined with the per-request timeout.
   */
  async analyze(opts: VisionAnalyzeOptions): Promise<string> {
    const server = await this.ensureStarted()
    const dataUrl = `data:${opts.mimeType};base64,${Buffer.from(opts.imageBytes).toString('base64')}`
    const body = JSON.stringify({
      model: this.modelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.question },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      stream: true,
      // V1: the image prefill is CACHED across follow-ups (cache_n measured) — the per-image
      // thread pays the (slow CPU) image prefill once, not per question. Loopback compute hint.
      cache_prompt: true
    })
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const res = await server.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: combineSignals(opts.signal, timeoutMs)
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      throw new Error(`Vision request failed: HTTP ${res.status}`)
    }
    if (!res.body) throw new Error('Vision request returned an empty response body')
    // The vision SSE frames are byte-identical to chat (V1-confirmed) — readChatSSE parses
    // them unchanged. A non-reasoning VLM emits no reasoning frames, so no onReasoning sink.
    let answer = ''
    for await (const delta of readChatSSE(res.body, opts.signal)) {
      answer += delta
      opts.onToken?.(delta)
    }
    return answer
  }

  /** Kill the sidecar (no-op if never started). Permanent for this instance; the orchestrator
   *  builds a fresh runtime on the next analyze if it cleared its reference. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.starting) await this.starting.catch(() => undefined)
    const server = this.server
    this.server = null
    if (server) await server.stop()
  }
}
