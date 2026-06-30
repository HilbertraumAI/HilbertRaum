import type { Embedder, EmbedOptions } from './index'
import { LlamaServer, combineSignals, isBindRaceError, type LlamaServerOptions } from '../runtime/sidecar'
import { truncateToContext } from '../runtime/context-budget'

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
// Inputs are truncated to fit the sidecar context BEFORE sending: chunks are sized by
// `approxTokenCount` (~500), but the embedding sidecar context is real BPE tokens (E5-small caps
// at 512) and a chunk's real-token cost is heavier than the estimate, so unmodified inputs
// routinely 500'd the request. The truncation is CJK/Thai-aware and uses the SHARED real-BPE
// safety factor (`REAL_TOKENS_PER_APPROX_TOKEN`) so the embedder and the reranker can't diverge
// (MAINT-2). See `runtime/context-budget.ts` for the factor's rationale (worst-case multilingual
// German ~2 real tokens/word).
/** Embed in bounded batches instead of one giant request (up to 1000 chunks). */
const DEFAULT_EMBED_BATCH_SIZE = 32
/**
 * RT-4 — physical batch (`--batch-size`/`--ubatch-size`) for the embedding sidecar.
 *
 * In embedding mode llama-server FORCES `n_batch = n_ubatch` and DEFAULTS both to 512
 * (it logs "embeddings enabled with n_batch (2048) > n_ubatch (512) … setting
 * n_batch = n_ubatch = 512"). We POST `DEFAULT_EMBED_BATCH_SIZE` (32) inputs per request,
 * each truncated to at most the context, so with the 512 default only ~1 full-length
 * sequence co-decodes per physical batch — the 32-input request is processed in many
 * micro-batches instead of packing several short sequences into one decode.
 *
 * Sizing the physical batch above the context lets multiple in-context sequences co-decode
 * per ubatch (each input ≤ `contextTokens` < this value, so every sequence still fits one
 * ubatch — required because mean pooling cannot split a sequence across ubatches). 2048
 * mirrors the chat sidecar's `CHAT_MAX_PHYSICAL_BATCH` (RT-1); for the 384-dim E5 the extra
 * compute buffer is negligible. We take `max(ctx, …)` so a raised context never exceeds the
 * batch. The reranker raises its batch for the same n_batch=n_ubatch reason
 * (`reranker/llama.ts`), but to fit ONE big query+doc sequence rather than to pack many.
 */
const EMBED_PHYSICAL_BATCH_TOKENS = 2048
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
   * Set WHILE `teardown()` runs (the lock/quit kill path) and cleared when it finishes — the
   * `suspend()` analogue of `stopped` (F19, full-audit-2026-06-29-postmerge). `stop()` arms the
   * permanent `stopped` latch before tearing down so a racing `ensureStarted` can't spawn an
   * orphan; `suspend()` (workspace lock) does NOT, so without this flag a `suspend()` that
   * interleaves with a concurrent `embed()` (a RAG query / tree-build embedding, NOT in
   * `inFlightStreams`) could stop the OLD sidecar while a fresh `ensureStarted` spawns and RETAINS
   * a new one — surviving the lock with chunk-text-derived state in process memory. `ensureStarted`
   * refuses while it is set. Unlike `stopped` it CLEARS in teardown's `finally`, so a normal
   * post-suspend `embed()` still lazily restarts.
   */
  private tearingDown = false
  /**
   * Failed-start latch (the LlamaReranker's pattern): a sidecar that could not start for a
   * PERMANENT fault (e.g. a corrupt/incompatible GGUF) must not be re-spawned and re-awaited for
   * the full health timeout on EVERY embed. A TRANSIENT port-bind race does NOT arm it (F4 — see
   * `ensureStarted`'s `.catch`): leaving it null lets the next embed() re-attempt a fresh start.
   * Unlike the reranker's, this latch CLEARS on `suspend()` (workspace lock): the embedder has no
   * graceful degradation — a latched failure blocks all imports — so the user must be able to
   * replace the weight file and retry via lock/unlock without restarting the app.
   */
  private startFailed: Error | null = null

  constructor(private readonly opts: E5EmbedderOptions) {
    this.id = opts.id
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS
  }

  /** Lazily spawn the embeddings sidecar (once). Concurrent callers share one start. */
  private async ensureStarted(): Promise<LlamaServer> {
    if (this.stopped) throw new Error('Embedder is stopped (app is shutting down)')
    // F19: refuse to spawn while a teardown (lock/quit) is in progress — a sidecar started here
    // would survive the lock. The `suspend()` analogue of the `stopped` guard for `stop()`.
    if (this.tearingDown) throw new Error('Embedder is suspending (workspace is locking)')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    if (!this.starting) {
      const ctx = this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS
      // RT-4: size the physical batch above the context so multiple in-context inputs of a
      // 32-input request co-decode per ubatch instead of the 512 embedding-mode default
      // processing them ~1 at a time. `max(ctx, …)` keeps batch ≥ ctx for raised contexts.
      const physicalBatch = Math.max(ctx, EMBED_PHYSICAL_BATCH_TOKENS)
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens: ctx,
        // `--embedding` switches llama-server to the embeddings endpoint; mean pooling
        // is what E5 expects. `--device none` PINS the embedder to CPU
        // (architecture.md GPU record §7): the 384-dim model gains little from a GPU,
        // and pinning keeps ingestion immune to driver flakiness and VRAM contention
        // with the chat model. `--batch-size`/`--ubatch-size` raise the physical batch
        // for multi-sequence throughput (RT-4; see EMBED_PHYSICAL_BATCH_TOKENS).
        extraArgs: [
          '--embedding',
          '--pooling',
          'mean',
          '--device',
          'none',
          '--batch-size',
          String(physicalBatch),
          '--ubatch-size',
          String(physicalBatch)
        ],
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
          const error = err instanceof Error ? err : new Error(String(err))
          // F4 (post-merge audit): a TRANSIENT port-bind race must NOT arm the failed-start latch.
          // LlamaServer.start retries a bind race only ONCE (REL-1); losing the port twice during
          // the near-simultaneous chat+embedder+reranker+vision startup throws a bind-class error.
          // The latch is for a PERMANENT fault (a bad/incompatible GGUF) — arming it for a race
          // silently disabled ALL imports for the session (the embedder has no graceful
          // degradation) until lock/unlock. Leave it null so the next embed() re-attempts a fresh
          // start on a new port — mirroring the GPU ladder's transient treatment of the same class.
          if (!isBindRaceError(error.message)) this.startFailed = error
          throw error
        })
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
    // F19: a teardown (lock/quit) may have begun during the await above and already nulled the
    // server we'd return — re-check rather than hand back a sidecar that's being / about to be
    // stopped (mirrors the top-of-function guards).
    if (this.stopped) throw new Error('Embedder is stopped (app is shutting down)')
    if (this.tearingDown) throw new Error('Embedder is suspending (workspace is locking)')
    if (!this.server) throw new Error('Embeddings server failed to start')
    return this.server
  }

  /**
   * Truncate an input to the context budget (the vector covers the chunk's head). CJK/Thai-aware
   * via the shared `truncateToContext` so space-less scripts and subword-heavy languages can't
   * slip past a naive word count and overflow the sidecar (HTTP 500); the budget uses the shared
   * real-BPE safety factor (`runtime/context-budget.ts`).
   */
  private truncateForContext(text: string): string {
    return truncateToContext(text, this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
  }

  /**
   * Embed texts → L2-normalized `Float32Array`s, one per input, in order. Inputs are
   * truncated to the sidecar context (see `truncateForContext` / `runtime/context-budget.ts`),
   * sent in bounded batches, and each request carries a timeout so a wedged sidecar cannot park a
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
      // REL-3 (full-audit-2026-06-29 follow-up): re-check teardown BETWEEN batches. `server` was
      // captured once above; a suspend()/stop() mid-loop (workspace lock / quit, racing a large
      // ingestion's many batches) nulls `this.server` and kills the child, so the NEXT
      // `server.fetch` would throw the runtime's "llama-server is not started" (or a count
      // mismatch) — a confusing per-document error. Surface the SAME clean, recognizable
      // cancellation `ensureStarted` raises instead. `this.server !== server` is the durable
      // signal: teardown nulls (or replaces) `this.server` and that staleness persists even after
      // `tearingDown` clears in teardown's `finally` (so a suspend that COMPLETED between batches is
      // caught too, not only one still in progress). `stopped` is checked first for the quit path.
      if (this.stopped) throw new Error('Embedder is stopped (app is shutting down)')
      if (this.tearingDown || this.server !== server) {
        throw new Error('Embedder is suspending (workspace is locking)')
      }
      const batch = prepared.slice(start, start + batchSize)
      // REL-4: own the per-batch timeout so it is cleared the instant the request settles —
      // hundreds of batches in a large ingestion otherwise leave hundreds of live timers.
      const combined = combineSignals(opts?.signal, timeoutMs)
      let json!: EmbeddingResponse
      try {
        const res = await server.fetch('/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.id, input: batch }),
          signal: combined.signal
        })
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined) // release the connection
          throw new Error(`Embedding request failed: HTTP ${res.status}`)
        }
        json = (await res.json()) as EmbeddingResponse
      } finally {
        combined.clear()
      }
      const data = json.data ?? []
      if (data.length !== batch.length) {
        throw new Error(`Embedding count mismatch: expected ${batch.length}, got ${data.length}`)
      }
      // Order by `index` so the result lines up with the input batch. The OpenAI
      // embeddings schema makes `index` optional, so handle the two clean cases and
      // reject the mixed one (L3): if EVERY entry carries an `index`, sort by it; if
      // NONE do, trust the response's array order. A partial mix would collapse the
      // missing entries to 0 and silently misalign vectors↔chunks (the count guard
      // above still passes), so fail loudly instead.
      const withIndex = data.filter((d) => typeof d.index === 'number').length
      if (withIndex !== 0 && withIndex !== data.length) {
        throw new Error(
          `Embedding response mixes indexed and unindexed entries (${withIndex}/${data.length}); cannot order safely`
        )
      }
      const ordered =
        withIndex === data.length
          ? [...data].sort((a, b) => (a.index as number) - (b.index as number))
          : data
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
    // Clear the failed-start latch AFTER teardown, not before (L4): teardown awaits an
    // in-flight start, and a start that fails during that await sets `startFailed`. If we
    // cleared first, that racing failure would re-arm the latch and the next embed() would
    // throw the stale error — forcing a second lock/unlock. Clearing last guarantees a
    // post-suspend embed() gets a fresh start attempt.
    await this.teardown()
    this.startFailed = null
  }

  private async teardown(): Promise<void> {
    // F19: bar a racing ensureStarted from spawning a sidecar that would outlive this teardown
    // (and survive the lock). `stop()` already has the permanent `stopped` latch; `suspend()` does
    // not, so this flag gives the lock path the same protection for the duration of the teardown.
    this.tearingDown = true
    try {
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
    } finally {
      // Cleared so a post-suspend embed() can lazily restart (suspend() permits a fresh start;
      // only stop()'s separate, permanent `stopped` latch blocks that).
      this.tearingDown = false
    }
  }
}

/** Factory mirroring `createMockEmbedder`; selected when the binary + E5 weights exist. */
export function createE5Embedder(opts: E5EmbedderOptions): E5Embedder {
  return new E5Embedder(opts)
}
