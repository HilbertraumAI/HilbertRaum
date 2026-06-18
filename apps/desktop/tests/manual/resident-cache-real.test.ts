import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  VectorIndex,
  encodeVector,
  invalidateResidentVectors
} from '../../src/main/services/embeddings'
import { createE5Embedder } from '../../src/main/services/embeddings/e5'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'

// RAG-1 / RAG-6 (Wave P4) — the REAL-E5 end-to-end measurement the design record flagged as
// "real E5-runtime numbers PENDING the PAID drive". The synthetic bench
// (resident-cache-bench.test.ts) proves the *scan* timing (data-independent: N dot-products of
// 384-dim Float32 + sort), which holds regardless of how the vectors were produced. This test
// closes the remaining real-world variables that synthetic vectors can't:
//   1. the vectors are GENUINE multilingual-e5-small-q8 outputs from the real b9585 sidecar,
//      stored through the production codec (encodeVector) — so the resident cache is exercised
//      on real, L2-normalized E5 data, not random unit vectors;
//   2. the DB lives on the PAID portable drive (real USB I/O for the cold-build SELECT);
//   3. the query path is the production `searchText` — a real E5 query-embed round-trip THEN
//      the cached scan — so the reported full-query latency is what a user's question pays.
//
// Manual: point HILBERTRAUM_RESIDENT_REAL at the drive root (the dir holding runtime/ + models/).
//   HILBERTRAUM_RESIDENT_REAL=D:\ npx vitest run tests/manual/resident-cache-real.test.ts
// Optional: HILBERTRAUM_RESIDENT_REAL_N=2000 (real chunks to embed; default 2000).
const ROOT = process.env.HILBERTRAUM_RESIDENT_REAL?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)
const REAL_N = Number(process.env.HILBERTRAUM_RESIDENT_REAL_N ?? 2000)
const EMBED_BATCH = 32
const QUERIES = 20
const PATIENT_MS = 240_000

function firstModel(root: string, sub: string): string | null {
  const dir = join(root, 'models', sub)
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs.length ? ggufs[0].path : null
}

// Distinct, realistic-looking passages so each E5 vector is genuinely different (a constant
// string would collapse to one point and make the scan meaningless). Real model, real text —
// only the templating is synthetic, which does not affect vector shape or scan timing.
const SUBJECTS = [
  'the quarterly revenue report',
  'the data-retention policy',
  'the vendor onboarding checklist',
  'the incident post-mortem',
  'the employee travel guidelines',
  'the encryption key-rotation schedule',
  'the customer support escalation path',
  'the annual security audit',
  'the product roadmap for next year',
  'the contract renewal terms'
]
const PREDICATES = [
  'was reviewed and approved by the compliance team in section',
  'requires sign-off from two managers before paragraph',
  'must be archived for seven years under clause',
  'is summarized for the board in appendix',
  'lists the responsible owners in table',
  'defines the rollback procedure in step',
  'caps the total exposure as described in item',
  'sets the deadline at the end of milestone'
]

function chunkText(i: number): string {
  const s = SUBJECTS[i % SUBJECTS.length]
  const p = PREDICATES[Math.floor(i / SUBJECTS.length) % PREDICATES.length]
  return `Document chunk ${i}: ${s} ${p} ${i % 97}, with additional context noted on page ${i % 313}.`
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function seedReal(
  db: Db,
  embedder: { id: string; embed: (t: string[]) => Promise<Float32Array[]> },
  n: number
): Promise<void> {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d', 'd', 'indexed', ?, ?)`
  ).run(now, now)
  const insChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
     VALUES (?, 'd', ?, ?, 'd', 1, ?)`
  )
  const insEmb = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (let start = 0; start < n; start += EMBED_BATCH) {
    const texts: string[] = []
    for (let i = start; i < Math.min(start + EMBED_BATCH, n); i++) texts.push(chunkText(i))
    const vectors = await embedder.embed(texts)
    db.exec('BEGIN')
    for (let j = 0; j < texts.length; j++) {
      const id = `c${start + j}`
      insChunk.run(id, start + j, texts[j], now)
      insEmb.run(id, embedder.id, encodeVector(vectors[j]), vectors[j].length, now)
    }
    db.exec('COMMIT')
  }
}

describe.skipIf(!enabled)('resident cache — REAL E5 end-to-end (manual, PAID drive)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const e5Path = enabled ? firstModel(ROOT, 'embeddings') : null

  it(
    `real E5 vectors on the drive: cold build + warm scan + full query, N=${REAL_N}`,
    { timeout: 900_000 },
    async () => {
      expect(binPath).toBeTruthy()
      expect(e5Path).toBeTruthy()

      const dir = mkdtempSync(join(ROOT, 'hilbertraum-resreal-'))
      const db = openDatabase(join(dir, 'r.sqlite'))
      const embedder = createE5Embedder({
        id: 'multilingual-e5-small-q8',
        binPath: binPath!,
        modelPath: e5Path!,
        healthTimeoutMs: PATIENT_MS
      })
      try {
        const t0 = performance.now()
        await seedReal(db, embedder, REAL_N)
        const seedMs = performance.now() - t0

        const index = new VectorIndex(db, embedder as never, {
          embeddingModelId: 'multilingual-e5-small-q8'
        })

        // Cold: first scan builds the resident cache from the real-E5 blobs on the drive.
        invalidateResidentVectors(db)
        const probe = await embedder.embed(['what does the security audit require?'])
        const tb = performance.now()
        const cold = index.search(probe[0], 12)
        const coldMs = performance.now() - tb
        expect(cold.length).toBeGreaterThan(0)

        // Warm: scan only (query vector already in hand), the resident map reused.
        const qVecs = await Promise.all(
          Array.from({ length: QUERIES }, (_, i) =>
            embedder.embed([`question ${i} about ${SUBJECTS[i % SUBJECTS.length]}`]).then((v) => v[0])
          )
        )
        const warmTimes: number[] = []
        for (const qv of qVecs) {
          const t = performance.now()
          index.search(qv, 12)
          warmTimes.push(performance.now() - t)
        }

        // Full production query: real E5 query-embed round-trip + cached scan (what a user pays).
        const fullTimes: number[] = []
        for (let i = 0; i < QUERIES; i++) {
          const t = performance.now()
          await index.searchText(`how is ${SUBJECTS[i % SUBJECTS.length]} handled?`, 12)
          fullTimes.push(performance.now() - t)
        }

        /* eslint-disable no-console */
        console.log(`\n===== REAL E5 end-to-end, N=${REAL_N} (drive: ${ROOT}) =====`)
        console.log(`embed+seed ${REAL_N} real chunks : ${seedMs.toFixed(0)} ms`)
        console.log(`cold (build map + scan)        : ${coldMs.toFixed(2)} ms (one-time per mutation)`)
        console.log(`warm (cached scan only)        : median ${median(warmTimes).toFixed(2)} ms/query`)
        console.log(`full (E5 embed + cached scan)  : median ${median(fullTimes).toFixed(2)} ms/query`)
        console.log(
          `  → query-embed dominates the scan by ${(median(fullTimes) / median(warmTimes)).toFixed(1)}×\n`
        )
        /* eslint-enable no-console */
      } finally {
        await embedder.stop?.()
        db.close()
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  )
})
