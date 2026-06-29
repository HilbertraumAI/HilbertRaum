import type { Reranker, RerankedHit, RerankOptions } from './index'
import { LlamaServer, combineSignals, isBindRaceError, type LlamaServerOptions } from '../runtime/sidecar'
import { maxInputApproxTokens } from '../runtime/context-budget'
import { truncateToApproxTokens, CHUNK_DEFAULTS } from '../ingestion/chunker'

// Real on-device reranker (rag-design §11). The THIRD `LlamaServer`
// composition (after the chat runtime and the E5 embedder): the SAME shipped b9585
// `llama-server` binary, spawned with `--rerank`, serving `/v1/rerank` over loopback.
// Verified against the pinned b9585 SOURCE: `--rerank` sets
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
 * Approx-token caps per rerank FIELD (rag-design §11 / §12.3). A rerank task is ONE query+document
 * pair the server combines into a SINGLE sequence, so the combined cost must fit the context:
 * (160 + 500) approx tokens × REAL_TOKENS_PER_APPROX_TOKEN ≈ 1452 real tokens — under the 2048
 * context AND the 2048 physical batch. The constructor additionally CLAMPS both caps to the context
 * budget (usable − queryCap ≈ 754 at the default ctx, ≥ 500), so they can never exceed `n_ctx` even
 * at a smaller configured context.
 *
 * RAG-N3 (full audit 2026-06-28): the doc cap is the WHOLE chunk window
 * (`CHUNK_DEFAULTS.chunkSizeTokens`), not the former 320, so the reranker scores every chunk in
 * full. At 320 the last ~36 % of a 500-token chunk was invisible to the load-bearing relevance
 * separator (§12.3), and that truncated score drove BOTH the final order AND the dedup-by-page
 * winner (`rag/index.ts`). Cost: the worst-case CPU latency per candidate rises with the larger doc
 * budget (reasoned ~+38 %; §12.3) — bounded by the small candidate cap, CPU-pinned, and opt-in by
 * provisioning. Tightening this cap (or the candidate cap) stays the lever if latency proves high.
 *
 * EMB-1 (backend audit 2026-06-27): inputs are truncated by the CJK/Thai-aware
 * `truncateToApproxTokens` (shared with the E5 embedder), NOT a whitespace word split. The old
 * split treated a space-less passage (CJK/Thai) as ONE "word" and never truncated it, so it
 * overflowed `n_ctx`, the sidecar 500'd, and the rerank silently fell back to the fused order.
 */
const MAX_QUERY_APPROX_TOKENS = 160
/** The reranker scores the WHOLE chunk: the doc cap equals the chunk window so a chunk's tail is
 *  never dropped before scoring (RAG-N3). Keyed off the chunker's source of truth, so a future
 *  chunk-size change carries the rerank budget with it. */
const MAX_DOC_APPROX_TOKENS = CHUNK_DEFAULTS.chunkSizeTokens
/** Approx-token headroom reserved for BOS/EOS + the query↔document separator the server inserts. */
const RERANK_SPECIALS_APPROX_TOKENS = 16
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

export class LlamaReranker implements Reranker {
  readonly id: string
  /** Per-field approx-token truncation caps, clamped to the context so query+doc can't exceed
   *  n_ctx (EMB-1). Computed once from `contextTokens` in the constructor. */
  private readonly queryApproxTokens: number
  private readonly docApproxTokens: number
  private server: LlamaServer | null = null
  private starting: Promise<void> | null = null
  /** Set by `stop()`; a racing lazy start must not resurrect the sidecar after quit. */
  private stopped = false
  /**
   * Failed-start latch: a sidecar that could not start for a PERMANENT fault (e.g. an
   * incompatible GGUF quantization) must not be re-spawned and re-awaited for
   * the full health timeout on EVERY question. First failure disables this instance
   * for the session; rerank() then fails fast and retrieval keeps the fused order. A
   * TRANSIENT port-bind race does NOT arm it (F7 — see `ensureStarted`'s `.catch`): the latch
   * SURVIVES `suspend()` (unlike the embedder's), so latching a race would silently disable
   * reranking for the whole session — leaving it null lets the next rerank() retry on a fresh port.
   */
  private startFailed: Error | null = null

  constructor(private readonly opts: LlamaRerankerOptions) {
    this.id = opts.id
    // Query+document ride ONE sequence server-side, so derive the per-field caps from the SHARED
    // context budget (so they can never exceed n_ctx), then clamp to the latency-oriented
    // defaults. At the default 2048 context this yields 160/500 (query cap / whole-chunk doc cap,
    // RAG-N3); a smaller configured context shrinks the caps so a rerank can't 500.
    const contextTokens = opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS
    const usable = Math.max(2, maxInputApproxTokens(contextTokens) - RERANK_SPECIALS_APPROX_TOKENS)
    this.queryApproxTokens = Math.min(MAX_QUERY_APPROX_TOKENS, Math.max(1, Math.floor(usable / 3)))
    this.docApproxTokens = Math.min(MAX_DOC_APPROX_TOKENS, Math.max(1, usable - this.queryApproxTokens))
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
        // `--batch-size`/`--ubatch-size` = the context: in embedding/rerank mode
        // llama-server FORCES n_batch = n_ubatch and defaults them to 512 (b9585 logs
        // "embeddings enabled
        // with n_batch (2048) > n_ubatch (512) ... setting n_batch = n_ubatch = 512").
        // A rerank input is query+document in ONE sequence — up to
        // (MAX_QUERY_APPROX_TOKENS + MAX_DOC_APPROX_TOKENS) approx tokens ≈ 1452 real tokens — so
        // the 512 default makes the server 500 the WHOLE request ("input (… tokens) is too large to
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
          const error = err instanceof Error ? err : new Error(String(err))
          // F7 (post-merge audit): a TRANSIENT port-bind race must NOT arm the latch (same fix as
          // the embedder, F4). This latch is more persistent than the embedder's — `suspend()`
          // KEEPS it (a bad GGUF won't load after unlock either) — so arming it for a race killed
          // reranking for the whole session (a silent quality regression: retrieval falls back to
          // fused order, rag/index.ts). Forgiving the race makes the keep-on-suspend policy correct:
          // only a genuine load fault persists. Leave it null so the next rerank() re-attempts.
          if (!isBindRaceError(error.message)) this.startFailed = error
          throw error
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
   * Score every document against `query` via `/v1/rerank`. Inputs are truncated to the
   * context/latency budget by the CJK/Thai-aware `truncateToApproxTokens` (EMB-1 — a space-less
   * passage can't slip past and overflow n_ctx); the response's `results[].index` maps each score
   * back to its input (the server sorts by score desc — order is NOT input order).
   * Throws unless every input received exactly one score. `opts.signal` (a user "Stop")
   * is combined with the timeout so the CPU-slow rerank cancels promptly (M-C5).
   */
  async rerank(query: string, documents: string[], opts?: RerankOptions): Promise<RerankedHit[]> {
    if (documents.length === 0) return []
    const server = await this.ensureStarted()
    // REL-4: own the timeout so it is cleared the instant the request settles (no lingering timer).
    const combined = combineSignals(opts?.signal, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    let json!: RerankResponse
    try {
      const res = await server.fetch('/v1/rerank', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.id,
          query: truncateToApproxTokens(query, this.queryApproxTokens),
          documents: documents.map((d) => truncateToApproxTokens(d, this.docApproxTokens))
        }),
        signal: combined.signal
      })
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined) // release the connection
        throw new Error(`Rerank request failed: HTTP ${res.status}`)
      }
      json = (await res.json()) as RerankResponse
    } finally {
      combined.clear()
    }
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
   * workspace lock, like the E5 embedder's `suspend()`. A PERMANENT failed-start latch survives
   * a suspend: a GGUF the server could not load will not load any better after unlock. A transient
   * bind race never armed the latch (F7), so a port race no longer wrongly disables reranking past
   * a lock/unlock — only a genuine load fault persists.
   */
  async suspend(): Promise<void> {
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    // A lazy start may be in flight (first rerank() racing app quit); wait for it to
    // settle so the spawned child cannot outlive the app as an orphan.
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
