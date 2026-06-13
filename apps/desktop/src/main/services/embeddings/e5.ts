import type { Embedder, EmbedOptions } from './index'
import { LlamaServer, combineSignals, type LlamaServerOptions } from '../runtime/sidecar'

// Real on-device embedder (spec §6, §9.2). Drops in behind the existing
// `Embedder` interface with the SAME id/dimensions as the E5-small manifest, so the
// locked 384-dim Float32 BLOB encoding + `VectorIndex` are unchanged.
//
// Backend choice: a `llama.cpp` `llama-server --embedding` sidecar over loopback —
// the SAME prebuilt binary the chat runtime uses (`runtime/sidecar.ts`). This adds
// ZERO new npm dependencies and no fragile native build (the alternative, an
// onnxruntime-node + tokenizer stack, is a heavier, native add).
// The embeddings server is lazy-started on first `embed()` and reused; `stop()` kills
// it (wired into `will-quit` so no orphan survives). Fully offline: loopback only.

const DEFAULT_DIMENSIONS = 384
const DEFAULT_CONTEXT_TOKENS = 512
/**
 * Chunks are sized in whitespace WORDS (~500), but the embedding
 * sidecar context is real BPE tokens (E5-small caps at 512) — 500 English words is
 * 650+ tokens, so unmodified chunks routinely overflowed the context and failed the
 * whole document. Inputs are truncated to fit with a safety margin (≈1.4 tokens/word).
 */
const TOKENS_PER_WORD_ESTIMATE = 1.4
/** Embed in bounded batches instead of one giant request (up to 1000 chunks). */
const DEFAULT_EMBED_BATCH_SIZE = 32
/** Per-request bound so a wedged sidecar fails the document instead of hanging it. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export type E5EmbedderDeps = Pick<
  LlamaServerOptions,
  'spawn' | 'fetchImpl' | 'findPort' | 'threads' | 'healthTimeoutMs' | 'healthIntervalMs' | 'host'
>

export interface E5EmbedderOptions extends E5EmbedderDeps {
  /** Embedding-model id tag (the manifest id) written to `embeddings.embedding_model_id`. */
  id: string
  binPath: string
  /** Absolute path to the E5 GGUF weight file. */
  modelPath: string
  contextTokens?: number
  dimensions?: number
  /** Texts per `/v1/embeddings` request (default 32). */
  batchSize?: number
  /** Per-request timeout in ms (default 120 000). */
  requestTimeoutMs?: number
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

/** L2-normalize a vector in place so cosine similarity == dot product (interface contract). */
function l2normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm
  }
  return vec
}

export class E5Embedder implements Embedder {
  readonly id: string
  readonly dimensions: number
  private server: LlamaServer | null = null
  private starting: Promise<void> | null = null
  /** Set by `stop()`; a racing lazy start must not resurrect the sidecar after quit. */
  private stopped = false
  /**
   * Failed-start latch (the LlamaReranker's pattern): a sidecar that could not start
   * (e.g. a corrupt/incompatible GGUF) must not be re-spawned and re-awaited for the
   * full health timeout on EVERY embed. Unlike the reranker's, this latch CLEARS on
   * `suspend()` (workspace lock): the embedder has no graceful degradation — a latched
   * failure blocks all imports — so the user must be able to replace the weight file
   * and retry via lock/unlock without restarting the app.
   */
  private startFailed: Error | null = null

  constructor(private readonly opts: E5EmbedderOptions) {
    this.id = opts.id
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS
  }

  /** Lazily spawn the embeddings sidecar (once). Concurrent callers share one start. */
  private async ensureStarted(): Promise<LlamaServer> {
    if (this.stopped) throw new Error('Embedder is stopped (app is shutting down)')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    if (!this.starting) {
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens: this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
        // `--embedding` switches llama-server to the embeddings endpoint; mean pooling
        // is what E5 expects. `--device none` PINS the embedder to CPU
        // (architecture.md GPU record §7): the 384-dim model gains little from a GPU,
        // and pinning keeps ingestion immune to driver flakiness and VRAM contention
        // with the chat model.
        extraArgs: ['--embedding', '--pooling', 'mean', '--device', 'none'],
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
    if (!this.server) throw new Error('Embeddings server failed to start')
    return this.server
  }

  /** Most whitespace words that safely fit the sidecar's real-token context window. */
  private maxInputWords(): number {
    const ctx = this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS
    return Math.max(16, Math.floor(ctx / TOKENS_PER_WORD_ESTIMATE))
  }

  /** Truncate an input to the context budget (the vector covers the chunk's head). */
  private truncateForContext(text: string): string {
    const words = text.split(/\s+/).filter((w) => w.length > 0)
    const max = this.maxInputWords()
    return words.length <= max ? text : words.slice(0, max).join(' ')
  }

  /**
   * Embed texts → L2-normalized `Float32Array`s, one per input, in order. Inputs are
   * truncated to the sidecar context (see TOKENS_PER_WORD_ESTIMATE), sent in bounded
   * batches, and each request carries a timeout so a wedged sidecar cannot park a
   * document in `embedding` forever. `opts.signal` (a user "Stop") is combined with
   * the timeout so query embedding cancels promptly (M-C5).
   */
  async embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const server = await this.ensureStarted()
    const prepared = texts.map((t) => this.truncateForContext(t))
    const batchSize = Math.max(1, this.opts.batchSize ?? DEFAULT_EMBED_BATCH_SIZE)
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    const out: Float32Array[] = []
    for (let start = 0; start < prepared.length; start += batchSize) {
      const batch = prepared.slice(start, start + batchSize)
      const res = await server.fetch('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.id, input: batch }),
        signal: combineSignals(opts?.signal, timeoutMs)
      })
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined) // release the connection
        throw new Error(`Embedding request failed: HTTP ${res.status}`)
      }
      const json = (await res.json()) as EmbeddingResponse
      const data = json.data ?? []
      if (data.length !== batch.length) {
        throw new Error(`Embedding count mismatch: expected ${batch.length}, got ${data.length}`)
      }
      // Order by `index` so the result lines up with the input batch.
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      for (const d of ordered) {
        // Reject a missing/short vector rather than storing a 0/short-dim row: such a row
        // is silently un-searchable (the VectorIndex dimension guard skips it) and the
        // document would still report `indexed`. Failing here surfaces it as a doc error.
        const raw = d.embedding ?? []
        if (raw.length !== this.dimensions) {
          throw new Error(
            `Embedding dimension mismatch: expected ${this.dimensions}, got ${raw.length}`
          )
        }
        out.push(l2normalize(Float32Array.from(raw)))
      }
    }
    return out
  }

  /**
   * Kill the embeddings sidecar (no-op if it was never started). PERMANENT — used on
   * `will-quit`, where a racing lazy start must not resurrect the child as an orphan.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await this.teardown()
  }

  /**
   * Kill the sidecar but allow a lazy restart on the next `embed()`.
   * Used on workspace LOCK: the in-memory chunk text must go, but the app keeps
   * running — the permanent `stop()` latch would make every post-lock/unlock
   * import fail with "Embedder is stopped". Also clears the failed-start latch
   * (see its declaration for why this differs from the reranker).
   */
  async suspend(): Promise<void> {
    this.startFailed = null
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    // A lazy start may be IN FLIGHT (first embed() racing app quit): `this.server` is
    // only assigned after start() resolves, so returning here would let the spawned
    // child outlive the app as an orphan. Wait for the start to settle, then stop
    // whatever it produced.
    if (this.starting) {
      await this.starting.catch(() => undefined)
    }
    const server = this.server
    this.server = null
    if (server) await server.stop()
  }
}

/** Factory mirroring `createMockEmbedder`; selected when the binary + E5 weights exist. */
export function createE5Embedder(opts: E5EmbedderOptions): E5Embedder {
  return new E5Embedder(opts)
}
