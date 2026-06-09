import type { Embedder } from './index'
import { LlamaServer, type LlamaServerOptions } from '../runtime/sidecar'

// Real on-device embedder (spec §6, §9.2, Phase 10). Drops in behind the existing
// `Embedder` interface with the SAME id/dimensions as the E5-small manifest, so the
// locked 384-dim Float32 BLOB encoding + `VectorIndex` are unchanged.
//
// Backend choice: a `llama.cpp` `llama-server --embedding` sidecar over loopback —
// the SAME prebuilt binary the chat runtime uses (`runtime/sidecar.ts`). This adds
// ZERO new npm dependencies and no fragile native build (the alternative, an
// onnxruntime-node + tokenizer stack, is a heavier, native add — see BUILD_STATE R6).
// The embeddings server is lazy-started on first `embed()` and reused; `stop()` kills
// it (wired into `will-quit` so no orphan survives). Fully offline: loopback only.

const DEFAULT_DIMENSIONS = 384
const DEFAULT_CONTEXT_TOKENS = 512

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

  constructor(private readonly opts: E5EmbedderOptions) {
    this.id = opts.id
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS
  }

  /** Lazily spawn the embeddings sidecar (once). Concurrent callers share one start. */
  private async ensureStarted(): Promise<LlamaServer> {
    if (this.server) return this.server
    if (!this.starting) {
      const server = new LlamaServer({
        binPath: this.opts.binPath,
        modelPath: this.opts.modelPath,
        contextTokens: this.opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
        // `--embedding` switches llama-server to the embeddings endpoint; mean pooling
        // is what E5 expects.
        extraArgs: ['--embedding', '--pooling', 'mean'],
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
        .finally(() => {
          this.starting = null
        })
    }
    await this.starting
    if (!this.server) throw new Error('Embeddings server failed to start')
    return this.server
  }

  /** Embed a batch of texts → L2-normalized `Float32Array`s, one per input, in order. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const server = await this.ensureStarted()
    const res = await server.fetch('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.id, input: texts })
    })
    if (!res.ok) throw new Error(`Embedding request failed: HTTP ${res.status}`)
    const json = (await res.json()) as EmbeddingResponse
    const data = json.data ?? []
    if (data.length !== texts.length) {
      throw new Error(`Embedding count mismatch: expected ${texts.length}, got ${data.length}`)
    }
    // Order by `index` so the result lines up with the input batch.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return ordered.map((d) => l2normalize(Float32Array.from(d.embedding ?? [])))
  }

  /** Kill the embeddings sidecar (no-op if it was never started). */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await server.stop()
  }
}

/** Factory mirroring `createMockEmbedder`; selected when the binary + E5 weights exist. */
export function createE5Embedder(opts: E5EmbedderOptions): E5Embedder {
  return new E5Embedder(opts)
}
