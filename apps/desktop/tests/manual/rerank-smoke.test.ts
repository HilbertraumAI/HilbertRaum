import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaReranker } from '../../src/main/services/reranker'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'

// MANUAL rerank smoke (Phase 21, rag-design §12.1 R1 / §12.3 live verification) — NOT CI.
//
// CI stays zero-network/zero-model/zero-binary, so this file is skipped unless
// HILBERTRAUM_RERANK_SMOKE points at a provisioned drive root (same shape as HILBERTRAUM_GPU_SMOKE):
//
//   HILBERTRAUM_RERANK_SMOKE=<root with runtime/llama.cpp/<os>/llama-server + models/reranker/*.gguf>
//   npx vitest run tests/manual/rerank-smoke.test.ts
//
// Against the REAL pinned b9585 build + the real bge-reranker-v2-m3 F16 GGUF this
// proves what the fake-fetch unit tests cannot:
//   1. the F16 GGUF LOADS on b9585 (the q8_0-on-XLM-R warmup crash is the recorded
//      failure mode this guards against — BUILD_STATE §9 / rag-design §12.1 R1),
//   2. /v1/rerank scores a relevant document above an irrelevant one,
//   3. the wall-clock latency for a topKInitial-sized batch on the CPU pin — THE
//      headline number the §7 resource budget is waiting for (record it in the plan).

const ROOT = process.env.HILBERTRAUM_RERANK_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Generous health budget: a ~1.1 GB model from a possibly-cold USB drive. */
const PATIENT_MS = 240_000

function firstRerankerModel(root: string): string | null {
  const dir = join(root, 'models', 'reranker')
  if (!existsSync(dir)) return null
  const gguf = readdirSync(dir).find((f) => f.endsWith('.gguf'))
  return gguf ? join(dir, gguf) : null
}

describe.skipIf(!enabled)('Rerank smoke (manual, real b9585 + real bge-reranker-v2-m3)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const modelPath = enabled ? firstRerankerModel(ROOT) : null

  it('loads, ranks the relevant document first, and reports batch latency', { timeout: 600_000 }, async () => {
    expect(binPath).toBeTruthy()
    expect(modelPath).toBeTruthy()
    const reranker = createLlamaReranker({
      id: 'smoke-reranker',
      binPath: binPath!,
      modelPath: modelPath!,
      healthTimeoutMs: PATIENT_MS
    })
    try {
      const query = 'What is the total amount due on invoice INV-2024-001?'
      const relevant =
        'Invoice INV-2024-001 issued on 12 March: total amount due is 940 euro, payable within 30 days.'
      const irrelevant =
        'Solar panels convert sunlight into electrical power using photovoltaic cells on the roof.'

      const hits = await reranker.rerank(query, [irrelevant, relevant])
      const score = new Map(hits.map((h) => [h.index, h.score]))
      console.log('scores — relevant:', score.get(1), 'irrelevant:', score.get(0))
      expect(score.get(1)!).toBeGreaterThan(score.get(0)!)

      // Worst-case latency for a topKInitial-sized batch (the §7 number) AND the
      // regression guard for the n_ubatch=512 fix (services/reranker/llama.ts): each
      // rerank input is query+document in ONE sequence, so we drive the FULL truncation
      // budget — a MAX_QUERY_WORDS-sized query (160 words) + 12 docs of MAX_DOC_WORDS
      // (320) realistic words. Realistic lowercase words tokenize ≈ 1 token each, so an
      // input is ≈ (160 + 320) × 1.4 ≈ 670 real tokens: representative of a real
      // max-length chunk AND comfortably over the 512 physical batch the server forces
      // in embedding mode (the HTTP 500 this test once hit). Token-dense synthetic
      // filler (e.g. "fillerNwordM" ≈ 5 tokens/word) would both over-measure latency and
      // overflow even the resized batch.
      const VOCAB =
        'invoice amount payable within thirty days total due account number date issued vendor client payment terms net balance reference order item quantity price tax subtotal shipping address contact email phone project report summary section page paragraph the and for with this that from into over under value record entry list table figure note detail review request approve confirm submit'.split(
          ' '
        )
      const word = (n: number): string => VOCAB[n % VOCAB.length]
      const longQuery = Array.from({ length: 160 }, (_, w) => word(w * 3 + 1)).join(' ')
      const chunkSized = Array.from({ length: 12 }, (_, i) =>
        Array.from({ length: 320 }, (_, w) => word(i * 7 + w)).join(' ')
      )
      const started = Date.now()
      await reranker.rerank(longQuery, chunkSized)
      const elapsedMs = Date.now() - started
      console.log(`rerank latency for 12 × (160-word query + 320-word doc): ${elapsedMs} ms`)
      expect(elapsedMs).toBeGreaterThan(0)
    } finally {
      await reranker.stop()
    }
  })
})
