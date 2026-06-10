import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaReranker } from '../../src/main/services/reranker'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'

// MANUAL rerank smoke (Phase 21, retrieval-plan §1.1/§7 live verification) — NOT CI.
//
// CI stays zero-network/zero-model/zero-binary, so this file is skipped unless
// PAID_RERANK_SMOKE points at a provisioned drive root (same shape as PAID_GPU_SMOKE):
//
//   PAID_RERANK_SMOKE=<root with runtime/llama.cpp/<os>/llama-server + models/reranker/*.gguf>
//   npx vitest run tests/manual/rerank-smoke.test.ts
//
// Against the REAL pinned b9585 build + the real bge-reranker-v2-m3 F16 GGUF this
// proves what the fake-fetch unit tests cannot:
//   1. the F16 GGUF LOADS on b9585 (the q8_0-on-XLM-R warmup crash is the recorded
//      failure mode this guards against — BUILD_STATE §9 / retrieval-plan §1.1),
//   2. /v1/rerank scores a relevant document above an irrelevant one,
//   3. the wall-clock latency for a topKInitial-sized batch on the CPU pin — THE
//      headline number the §7 resource budget is waiting for (record it in the plan).

const ROOT = process.env.PAID_RERANK_SMOKE?.trim() ?? ''
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

      // Latency for a topKInitial-sized batch of chunk-sized documents (the §7 number).
      const chunkSized = Array.from({ length: 12 }, (_, i) =>
        Array.from({ length: 320 }, (_, w) => `filler${i}word${w}`).join(' ')
      )
      const started = Date.now()
      await reranker.rerank(query, chunkSized)
      const elapsedMs = Date.now() - started
      console.log(`rerank latency for 12 × 320-word documents: ${elapsedMs} ms`)
      expect(elapsedMs).toBeGreaterThan(0)
    } finally {
      await reranker.stop()
    }
  })
})
