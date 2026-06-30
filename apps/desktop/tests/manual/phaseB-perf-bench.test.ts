import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  VectorIndex,
  cosineSimilarity,
  encodeVector,
  invalidateResidentVectors
} from '../../src/main/services/embeddings'
import {
  compareNearestNeighbors,
  COMPARE_NEIGHBORS_PER_CHUNK,
  type CompareCandidate
} from '../../src/main/services/doctasks/compare'

// Phase B (full-audit-2026-06-30) before/after micro-benchmarks for P1 (mode-(b) compare neighbor
// selection) and P2 (unscoped vector search). Manual — gated behind RUN_PHASEB_BENCH=1 so it never
// runs in the normal suite (like resident-cache-bench).
//   RUN_PHASEB_BENCH=1 npx vitest run tests/manual/phaseB-perf-bench.test.ts
const RUN = process.env.RUN_PHASEB_BENCH === '1'
const DIMS = 384

function randUnit(): Float32Array {
  const v = new Float32Array(DIMS)
  let norm = 0
  for (let i = 0; i < DIMS; i++) {
    v[i] = Math.random() * 2 - 1
    norm += v[i] * v[i]
  }
  const inv = 1 / Math.sqrt(norm)
  for (let i = 0; i < DIMS; i++) v[i] *= inv
  return v
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// ---- P1: the mode-(b) section-matched neighbor selection (O(N_A × N_B)) -----------------------
//
// The pairing scans ALL doc-B vectors per doc-A chunk. The pre-P1 code used `cosineSimilarity` (3
// accumulators) + a full `hits.sort().slice(topK)` per A-chunk; the new `compareNearestNeighbors`
// uses `dotProduct` (1 accumulator) + a running top-K. Two ~1000-chunk docs ≈ 1e6 scorings.

function oldNearestSelection(
  bChunks: readonly CompareCandidate[],
  vec: Float32Array,
  topK: number
): string[] {
  const hits: Array<{ chunkId: string; score: number }> = []
  for (const b of bChunks) {
    if (b.vec.length !== vec.length) continue
    hits.push({ chunkId: b.id, score: cosineSimilarity(vec, b.vec) })
  }
  hits.sort((x, y) => y.score - x.score)
  return hits.slice(0, topK).map((h) => h.chunkId)
}

describe.skipIf(!RUN)('Phase B P1 — compare neighbor selection (1000 × 1000)', () => {
  it('dotProduct + running top-K vs cosine + full sort; new main-thread block < 250 ms', () => {
    const N_A = Number(process.env.PHASEB_NA ?? 1000)
    const N_B = Number(process.env.PHASEB_NB ?? 1000)
    const topK = COMPARE_NEIGHBORS_PER_CHUNK
    const aVecs = Array.from({ length: N_A }, () => randUnit())
    const bChunks: CompareCandidate[] = Array.from({ length: N_B }, (_, i) => ({
      id: `b${i}`,
      vec: randUnit()
    }))

    // OLD: cosine + full sort + slice, once per A-chunk.
    const t0 = performance.now()
    for (const a of aVecs) oldNearestSelection(bChunks, a, topK)
    const oldMs = performance.now() - t0

    // NEW: dotProduct + running top-K.
    const t1 = performance.now()
    for (const a of aVecs) compareNearestNeighbors(bChunks, a, topK)
    const newMs = performance.now() - t1

    /* eslint-disable no-console */
    console.log(`\n===== P1 compare neighbor selection (N_A=${N_A}, N_B=${N_B}, topK=${topK}) =====`)
    console.log(`OLD cosine + full sort + slice : ${oldMs.toFixed(1)} ms total`)
    console.log(`NEW dotProduct + running top-K : ${newMs.toFixed(1)} ms total`)
    console.log(`speedup                        : ${(oldMs / newMs).toFixed(2)}×`)
    console.log(`acceptance target             : < ~250 ms (hardware-dependent; ${newMs < 250 ? 'MET' : 'not met on this box — see speedup'})`)
    /* eslint-enable no-console */
    // Robust, machine-independent acceptance (the absolute ~250 ms target is hardware-specific —
    // logged above, not asserted, matching resident-cache-bench's log-only convention): the new
    // dotProduct + running-top-K path is strictly faster than the old cosine + full-sort path.
    expect(newMs).toBeLessThan(oldMs)
  }, 600_000)
})

// ---- P2: unscoped vector search — resident-iteration fast path vs the scoped SQL scan ----------

function seedCorpus(db: Db, n: number, docs: number): string[] {
  const now = new Date().toISOString()
  const docIds: string[] = []
  for (let d = 0; d < docs; d++) {
    const id = `doc-${d}`
    docIds.push(id)
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
    ).run(id, id, now, now)
  }
  const insChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
     VALUES (?, ?, ?, 'x', 'd', 1, ?)`
  )
  const insEmb = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, 'bench-model', ?, ?, ?)`
  )
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const id = `c${i}`
    insChunk.run(id, `doc-${i % docs}`, i, now)
    insEmb.run(id, encodeVector(randUnit()), DIMS, now)
  }
  db.exec('COMMIT')
  return docIds
}

describe.skipIf(!RUN)('Phase B P2 — unscoped search fast path vs scoped scan', () => {
  it('resident iteration (no scope) vs the all-documents scoped SQL scan, warm', () => {
    const SIZES = (process.env.PHASEB_N ?? '10000,50000,100000')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((x) => Number.isFinite(x) && x > 0)
    const QUERIES = 20
    for (const n of SIZES) {
      const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-phaseb-'))
      const db = openDatabase(join(dir, 'b.sqlite'))
      try {
        const docIds = seedCorpus(db, n, 10)
        invalidateResidentVectors(db)
        const queries = Array.from({ length: QUERIES }, () => randUnit())

        const fast = new VectorIndex(db, { id: 'bench-model', dimensions: DIMS } as never, {
          embeddingModelId: 'bench-model'
        })
        // Passing every doc id forces the unchanged scoped SQL candidate scan over the same universe.
        const scoped = new VectorIndex(db, { id: 'bench-model', dimensions: DIMS } as never, {
          embeddingModelId: 'bench-model',
          documentIds: docIds
        })

        fast.search(queries[0], 12) // cold: builds the resident cache
        scoped.search(queries[0], 12)

        const fastTimes: number[] = []
        for (const q of queries) {
          const t = performance.now()
          fast.search(q, 12)
          fastTimes.push(performance.now() - t)
        }
        const scopedTimes: number[] = []
        for (const q of queries) {
          const t = performance.now()
          scoped.search(q, 12)
          scopedTimes.push(performance.now() - t)
        }

        /* eslint-disable no-console */
        console.log(`\n===== P2 unscoped search N=${n} =====`)
        console.log(`SCOPED scan (SELECT chunk_id + marshal) : median ${median(scopedTimes).toFixed(2)} ms/query`)
        console.log(`FAST resident iteration (no marshal)    : median ${median(fastTimes).toFixed(2)} ms/query`)
        console.log(`speedup                                 : ${(median(scopedTimes) / median(fastTimes)).toFixed(2)}×`)
        /* eslint-enable no-console */
      } finally {
        db.close()
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }, 600_000)
})
