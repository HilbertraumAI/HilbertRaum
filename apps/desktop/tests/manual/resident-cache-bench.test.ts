import { describe, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  VectorIndex,
  encodeVector,
  decodeVector,
  dotProduct,
  invalidateResidentVectors
} from '../../src/main/services/embeddings'

// RAG-1 / RAG-6 (Wave P4) before/after micro-benchmark — the synthetic-corpus measurement that
// confirms the resident decoded-vector cache is the win, and whether the residual synchronous
// scan still warrants the deferred off-main-thread move (P4b). Mock-only (no sidecar); real
// E5-runtime numbers via the PAID smoke drive are flagged PENDING in the design record.
//
// Manual: gated behind RUN_RESIDENT_BENCH=1 so it never runs in the normal suite.
//   RUN_RESIDENT_BENCH=1 npx vitest run tests/manual/resident-cache-bench.test.ts
//
// REAL-DRIVE numbers (the PAID-drive measurement the design record flagged PENDING): point
// RESIDENT_BENCH_DIR at the portable drive so the bench DB — and thus the cold-build SELECT —
// lives on real USB I/O instead of the OS temp SSD. The scan itself is data-independent (N
// dot-products of 384-dim Float32 + sort), so synthetic unit vectors give the same warm-scan
// timing as real E5 outputs; the cold build is the only term real-drive I/O changes.
//   RUN_RESIDENT_BENCH=1 RESIDENT_BENCH_DIR=D:\ RESIDENT_BENCH_N=5000,10000,30000,100000 \
//     npx vitest run tests/manual/resident-cache-bench.test.ts
const RUN = process.env.RUN_RESIDENT_BENCH === '1'
const DIMS = 384
const SIZES = (process.env.RESIDENT_BENCH_N ?? '100000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const BENCH_DIR = process.env.RESIDENT_BENCH_DIR?.trim()
const QUERIES = 20

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

function seedCorpus(db: Db, n: number): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d', 'd', 'indexed', ?, ?)`
  ).run(now, now)
  const insChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
     VALUES (?, 'd', ?, 'x', 'd', 1, ?)`
  )
  const insEmb = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, 'bench-model', ?, ?, ?)`
  )
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const id = `c${i}`
    insChunk.run(id, i, now)
    insEmb.run(id, encodeVector(randUnit()), DIMS, now)
  }
  db.exec('COMMIT')
}

/** The OLD path: SELECT every blob, decode per row, dot-product, sort, slice. */
function oldScan(db: Db, query: Float32Array, topK: number): { chunkId: string; score: number }[] {
  const rows = db
    .prepare('SELECT chunk_id, vector_blob, dimensions FROM embeddings WHERE embedding_model_id = ?')
    .all('bench-model') as unknown as Array<{ chunk_id: string; vector_blob: Uint8Array; dimensions: number }>
  const hits: { chunkId: string; score: number }[] = []
  for (const row of rows) {
    if (row.dimensions !== query.length) continue
    if (row.vector_blob.length < row.dimensions * 4) continue
    const vec = decodeVector(row.vector_blob, row.dimensions)! // guarded above → non-null
    hits.push({ chunkId: row.chunk_id, score: dotProduct(query, vec) })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function runSize(n: number): void {
  // DB on the portable drive (real USB I/O for the cold-build SELECT) when RESIDENT_BENCH_DIR
  // is set; otherwise the OS temp dir. A fresh dir per size keeps the WAL/page cache cold-ish.
  const baseDir = BENCH_DIR ? BENCH_DIR : tmpdir()
  const dir = mkdtempSync(join(baseDir, 'hilbertraum-bench-'))
  const dbPath = join(dir, 'b.sqlite')
  const db = openDatabase(dbPath)
  try {
    const t0 = performance.now()
    seedCorpus(db, n)
    const seedMs = performance.now() - t0

    const queries = Array.from({ length: QUERIES }, () => randUnit())

    // OLD path: decode every blob every query.
    const oldTimes: number[] = []
    for (const q of queries) {
      const t = performance.now()
      oldScan(db, q, 12)
      oldTimes.push(performance.now() - t)
    }

    // NEW path: resident cache. First query pays the one-time build; the rest are warm.
    invalidateResidentVectors(db)
    const index = new VectorIndex(db, { id: 'bench-model', dimensions: DIMS } as never, {
      embeddingModelId: 'bench-model'
    })
    const tb = performance.now()
    index.search(queries[0], 12) // cold: builds the resident cache
    const coldMs = performance.now() - tb
    const warmTimes: number[] = []
    for (const q of queries.slice(1)) {
      const t = performance.now()
      index.search(q, 12)
      warmTimes.push(performance.now() - t)
    }

    // F12: the FIRST-query-after-a-write RECONCILE cost — the term the post-merge close-out targeted.
    // (a) FULL reconcile (a delta-LESS `invalidate`): the residual O(N) `SELECT chunk_id` scan +
    //     Set build over the whole corpus before the new row is decoded.
    // (b) DELTA reconcile (a NAMED `{ added }`, what the production write sites now pass): a point
    //     decode of just the new row — NO id-scan. This is the F12 win.
    const insChunk = db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
       VALUES (?, 'd', ?, 'x', 'd', 1, ?)`
    )
    const insEmb = db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, 'bench-model', ?, ?, ?)`
    )
    const addOneRow = (chunkIndex: number): string => {
      const id = `cextra${chunkIndex}`
      const now = new Date().toISOString()
      insChunk.run(id, n + chunkIndex, now)
      insEmb.run(id, encodeVector(randUnit()), DIMS, now)
      return id
    }

    addOneRow(1) // (a)
    invalidateResidentVectors(db) // delta-less → full chunk-id scan
    const tFull = performance.now()
    index.search(queries[0], 12)
    const fullReconcileMs = performance.now() - tFull

    const addedId = addOneRow(2) // (b)
    invalidateResidentVectors(db, { added: [addedId] }) // named → delta fast path
    const tDelta = performance.now()
    index.search(queries[0], 12)
    const deltaReconcileMs = performance.now() - tDelta

    /* eslint-disable no-console */
    console.log(`\n===== N=${n} (db: ${BENCH_DIR ? 'REAL DRIVE ' + baseDir : 'tmp'}) =====`)
    console.log(`seed ${n} vectors      : ${seedMs.toFixed(0)} ms`)
    console.log(`OLD  decode-every-query : median ${median(oldTimes).toFixed(2)} ms/query`)
    console.log(`NEW  cold (build+scan)  : ${coldMs.toFixed(2)} ms (one-time per mutation)`)
    console.log(`NEW  warm (cached scan) : median ${median(warmTimes).toFixed(2)} ms/query`)
    console.log(`speedup (warm vs old)   : ${(median(oldTimes) / median(warmTimes)).toFixed(1)}×`)
    console.log(`F12 reconcile FULL (id-scan, +1 row) : ${fullReconcileMs.toFixed(2)} ms (delta-less / self-heal path)`)
    console.log(`F12 reconcile DELTA (named +1, no scan): ${deltaReconcileMs.toFixed(2)} ms (in-band production path)`)
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

describe.skipIf(!RUN)('resident cache benchmark', () => {
  it(`old decode-every-query vs cached, sizes=${SIZES.join(',')}`, () => {
    for (const n of SIZES) runSize(n)
  }, 600_000)
})
