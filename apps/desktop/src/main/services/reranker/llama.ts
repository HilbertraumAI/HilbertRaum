import type { Reranker, RerankedHit } from './index'
import { LlamaServer, type LlamaServerOptions } from '../runtime/sidecar'

// Real on-device reranker (Phase 21, rag-design §11 reranker). The THIRD `LlamaServer`
// composition (after the chat runtime and the E5 embedder): the SAME shipped b9585
// `llama-server` binary, spawned with `--rerank`, serving `/v1/rerank` over loopback.
// Verified against the pinned b9585 SOURCE (rag-design §12.1 R1): `--rerank` sets
// embedding mode + RANK pooling (common/arg.cpp L2964–2971); the endpoint takes
// `{ query, documents }` and returns `results: [{ index, relevance_score }]` sorted by
// score DESC — results map back to inputs by `index`, never by order
// (tools/server/server-context.cpp L4592–4671, server-common.cpp L1213–1258).
//
// Composing `LlamaServer` directly (not `LlamaRuntime`) keeps `CHAT_SERVER_ARGS`
// (--jinja / --reasoning-format) off this sidecar — those are chat-only. Zero new npm
// deps, loopback only, lazy-started on first rerank() and reused; stop() kills it
// (wired into will-quit AND workspace lock — the sidecar's memory holds recent queries
// and chunk text).

const DEFAULT_CONTEXT_TOKENS = 2048
/**
 * Same word→BPE-token safety margin as the E5 embedder (M7): inputs are sized in
 * whitespace words, the sidecar context is real tokens (≈1.4 tokens/word for English).
 */
const TOKENS_PER_WORD_ESTIMATE = 1.4
/**
 * Word caps per rerank input (rag-design §12.3): each rerank task is ONE
 * query+document pair, so (160 + 320) × 1.4 + specials ≈ 700 real tokens. The doc cap
 * chiefly bounds CPU latency per candidate (the reranker is CPU-pinned); tune after
 * PAID_RERANK_SMOKE produces real numbers. NOTE: ~700 tokens exceeds llama-server's
 * DEFAULT physical batch of 512 in embedding mode — see RERANK_BATCH_TOKENS below.
 */
const MAX_QUERY_WORDS = 160
const MAX_DOC_WORDS = 320
/** Per-request bound so a wedged sidecar fails the question's rerank pass, not the app. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export type LlamaRerankerDeps = Pick<
  LlamaServerOptions,
  'spawn' | 'fetchImpl' | 'findPort' | 'threads' | 'healthTimeoutMs' | 'healthIntervalMs' | 'host'
>

export interface LlamaRerankerOptions extends LlamaRerankerDeps {
  /** Reranker model id (the manifest id). */
  id: string
  binPath: string
  /** Absolute path to the reranker GGUF weight file. */
  modelPath: string
  contextTokens?: number
  requestTimeoutMs?: number
}

interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(' ')
}

export class LlamaReranker implements Reranker {
  readonly id: string
  private server: LlamaServer | null = null
  private starting: Promise<void> | null = null
  /** Set by `stop()`; a racing lazy start must not resurrect the sidecar after quit. */
  private stopped = false
  /**
   * Failed-start latch (rag-design §11 reranker): a sidecar that could not start (e.g. an
   * incompatible GGUF — the E5 q8_0 story) must not be re-spawned and re-awaited for
   * the full health timeout on EVERY question. First failure disables this instance
   * for the session; rerank() then fails fast and retrieval keeps the fused order.
   */
  private startFailed: Error | null = null

  constructor(private readonly opts: LlamaRerankerOptions) {
    this.id = opts.id
  }

  /** Lazily spawn the rerank sidecar (once). Concurrent callers share one start. */
  private async ensureStarted(): Promise<LlamaServer> {
    if (this.stopped) throw new Error('Reranker is stopped (app is shutting down)')
    if (this.startFailed) throw this.startFailed
    if (this.server) return this.server
    if (!this.starting) {
      const contextTokens = this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens,
        // `--rerank` switches llama-server to embedding mode + RANK pooling and enables
        // /v1/rerank (b9585 common/arg.cpp L2964–2971 — the one flag is the whole
        // switch). `--device none` PINS the reranker to CPU, exactly like the E5
        // embedder (architecture.md GPU record §7): a sub-1B scorer gains little from a GPU and
        // must never contend for VRAM with the chat model.
        //
        // `--batch-size`/`--ubatch-size` = the context (rag-design §12.1 R1 deviation,
        // found by PAID_RERANK_SMOKE): in embedding/rerank mode llama-server FORCES
        // n_batch = n_ubatch and defaults them to 512 (b9585 logs "embeddings enabled
        // with n_batch (2048) > n_ubatch (512) ... setting n_batch = n_ubatch = 512").
        // A rerank input is query+document in ONE sequence — up to
        // (MAX_QUERY_WORDS + MAX_DOC_WORDS) words ≈ 670 real tokens — so the 512 default
        // makes the server 500 the WHOLE request ("input (… tokens) is too large to
        // process. increase the physical batch size"), which would silently drop every
        // rerank pass back to the fused order on real-length chunks. Sizing the physical
        // batch to the context guarantees any in-context input decodes in one ubatch (a
        // single rerank input cannot exceed n_ctx anyway).
        extraArgs: [
          '--rerank',
          '--device',
          'none',
          '--batch-size',
          String(contextTokens),
          '--ubatch-size',
          String(contextTokens)
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
          this.startFailed = err instanceof Error ? err : new Error(String(err))
          throw this.startFailed
        })
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
    if (!this.server) throw new Error('Rerank server failed to start')
    return this.server
  }

  /**
   * Score every document against `query` via `/v1/rerank`. Inputs are word-truncated
   * to the context/latency budget; the response's `results[].index` maps each score
   * back to its input (the server sorts by score desc — order is NOT input order).
   * Throws unless every input received exactly one score.
   */
  async rerank(query: string, documents: string[]): Promise<RerankedHit[]> {
    if (documents.length === 0) return []
    const server = await this.ensureStarted()
    const res = await server.fetch('/v1/rerank', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.id,
        query: truncateWords(query, MAX_QUERY_WORDS),
        documents: documents.map((d) => truncateWords(d, MAX_DOC_WORDS))
      }),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined) // release the connection (L1)
      throw new Error(`Rerank request failed: HTTP ${res.status}`)
    }
    const json = (await res.json()) as RerankResponse
    const results = json.results ?? []
    const hits: RerankedHit[] = []
    const seen = new Set<number>()
    for (const r of results) {
      const index = r.index
      const score = r.relevance_score
      if (typeof index !== 'number' || typeof score !== 'number') continue
      if (index < 0 || index >= documents.length || seen.has(index)) continue
      seen.add(index)
      hits.push({ index, score })
    }
    if (hits.length !== documents.length) {
      throw new Error(`Rerank result mismatch: expected ${documents.length} scores, got ${hits.length}`)
    }
    return hits
  }

  /**
   * Kill the rerank sidecar (no-op if it was never started). PERMANENT — used on
   * `will-quit`, where a racing lazy start must not resurrect the child as an orphan.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await this.teardown()
  }

  /**
   * Kill the sidecar but allow a lazy restart on the next `rerank()` — used on
   * workspace lock (the E5 `suspend()` rationale). The failed-start latch survives a
   * suspend: a GGUF the server could not load will not load any better after unlock.
   */
  async suspend(): Promise<void> {
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    // A lazy start may be in flight (first rerank() racing app quit); wait for it to
    // settle so the spawned child cannot outlive the app as an orphan (E5 precedent).
    if (this.starting) {
      await this.starting.catch(() => undefined)
    }
    const server = this.server
    this.server = null
    if (server) await server.stop()
  }
}

/** Factory mirroring `createE5Embedder`; selected when the binary + reranker weights exist. */
export function createLlamaReranker(opts: LlamaRerankerOptions): LlamaReranker {
  return new LlamaReranker(opts)
}
