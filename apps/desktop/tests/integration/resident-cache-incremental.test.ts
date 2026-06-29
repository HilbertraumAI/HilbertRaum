import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// PERF-1 (full-audit-2026-06-29, Phase 5): the resident decoded-vector cache is now maintained
// INCREMENTALLY — a write marks it dirty and the next read reconciles the delta (decoding only
// new chunks) instead of dropping the whole map and re-decoding the corpus. This file proves the
// two things that matter: the incremental result is byte-identical to a from-scratch rebuild
// across every insert/delete/reindex/same-rowid sequence, AND a pure-add decodes only the K new
// rows (not N). The staleness `(count, maxRowid)` signature is retained as the self-healing
// backstop and the lock `purge` still drops the map.
//
// The decode counter (the speedup teeth) is a real spy on `decodeVector`: the codec module is
// mocked so its `decodeVector` is a `vi.fn` calling through to the real implementation, shared by
// the resident cache, the barrel re-export, and this test. `encodeVector` stays real.
const { decodeSpy } = vi.hoisted(() => ({ decodeSpy: vi.fn() }))
vi.mock('../../src/main/services/embeddings/codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/embeddings/codec')>()
  decodeSpy.mockImplementation(actual.decodeVector)
  return { ...actual, decodeVector: decodeSpy }
})

import { openDatabase, type Db } from '../../src/main/services/db'
import {
  encodeVector,
  getResidentVectors,
  invalidateResidentVectors,
  purgeResidentVectors
} from '../../src/main/services/embeddings'

const DIM = 8
const MODEL = 'test-model'

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-incr-')), 'test.sqlite'))
}

/** Deterministic unit vector for `seed` — distinct per seed so a wrong/stale entry is detectable. */
function makeVec(seed: number): Float32Array {
  const v = new Float32Array(DIM)
  let norm = 0
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.sin(seed * 7.13 + i * 1.97)
    norm += v[i] * v[i]
  }
  const inv = 1 / Math.sqrt(norm)
  for (let i = 0; i < DIM; i++) v[i] *= inv
  return v
}

let chunkIndex = 0
function seedDocRow(db: Db): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, 'd', 'indexed', ?, ?)`
  ).run(docId, now, now)
  return docId
}

/** Insert a chunk + its embedding via direct SQL (NO invalidation hook — caller controls that). */
function insertVec(db: Db, docId: string, chunkId: string, vec: Float32Array): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
     VALUES (?, ?, ?, 'x', 'd', 1, ?)`
  ).run(chunkId, docId, chunkIndex++, now)
  db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chunkId, MODEL, encodeVector(vec), vec.length, now)
}

function deleteVec(db: Db, chunkId: string): void {
  db.prepare('DELETE FROM embeddings WHERE chunk_id = ?').run(chunkId)
}

function signature(db: Db): { count: number; maxRowid: number } {
  const row = db
    .prepare('SELECT COUNT(*) AS count, MAX(rowid) AS maxRowid FROM embeddings')
    .get() as { count: number; maxRowid: number | null }
  return { count: row.count, maxRowid: row.maxRowid ?? 0 }
}

/** Snapshot the live cache map as a plain { chunkId -> number[] } for order-independent compare. */
function snapshot(map: ReadonlyMap<string, Float32Array>): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const [id, vec] of map) out[id] = Array.from(vec)
  return out
}

/** A from-scratch rebuild of the SAME db — the oracle the incremental map must equal byte-for-byte. */
function freshRebuild(db: Db): Record<string, number[]> {
  purgeResidentVectors(db) // drop everything → next read is a cold full build
  return snapshot(getResidentVectors(db))
}

beforeEach(() => {
  chunkIndex = 0
  decodeSpy.mockClear()
})

// ---- Equivalence: incremental contents == a from-scratch rebuild ------------------------------

describe('resident cache (incremental) — equivalence with a full rebuild', () => {
  it('matches a from-scratch rebuild byte-for-byte across insert → insert → delete → reindex', () => {
    const db = freshDb()
    const docId = seedDocRow(db)

    // 1. Initial insert of 10, in-band hook, cold build.
    for (let i = 0; i < 10; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    getResidentVectors(db)

    // 2. Add 5 more (pure add) → reconcile.
    for (let i = 10; i < 15; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    getResidentVectors(db)

    // 3. Delete 3 → reconcile drops them.
    for (const id of ['c1', 'c7', 'c13']) deleteVec(db, id)
    invalidateResidentVectors(db)
    getResidentVectors(db)

    // 4. "Reindex": delete 4 survivors and insert 4 brand-new ids with DIFFERENT vectors.
    for (const id of ['c2', 'c3', 'c11', 'c14']) deleteVec(db, id)
    for (let i = 100; i < 104; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    const incremental = snapshot(getResidentVectors(db))

    // The incrementally-maintained map must equal a cold rebuild of the same DB, to the byte.
    expect(incremental).toEqual(freshRebuild(db))
    // And it is the expected surviving set (no phantom of the deleted ids, all new ids present).
    expect(Object.keys(incremental).sort()).toEqual(
      ['c0', 'c4', 'c5', 'c6', 'c8', 'c9', 'c10', 'c12', 'c100', 'c101', 'c102', 'c103'].sort()
    )
  })
})

// ---- Speedup: a pure-add decodes ONLY the K new rows, never N ----------------------------------

describe('resident cache (incremental) — a pure-add decodes only the new rows', () => {
  it('decodes K new vectors on insert, not the whole N-vector corpus (purge → full decodes N)', () => {
    const db = freshDb()
    const docId = seedDocRow(db)
    const N = 50
    for (let i = 0; i < N; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(N) // cold build decodes all N

    // Insert K and reconcile — only the K new rows are decoded.
    const K = 7
    decodeSpy.mockClear()
    for (let i = N; i < N + K; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(N + K)
    expect(decodeSpy).toHaveBeenCalledTimes(K)

    // Teeth: a FULL invalidation (purge → cold build) re-decodes the whole corpus (N + K). This is
    // exactly the per-write cost PERF-1 removed; the incremental path above paid K, not N + K.
    decodeSpy.mockClear()
    purgeResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(N + K)
    expect(decodeSpy).toHaveBeenCalledTimes(N + K)
  })
})

// ---- Delete: removed ids leave the map, survivors keep their exact vectors ---------------------

describe('resident cache (incremental) — delete', () => {
  it('drops only the deleted chunk ids and keeps the rest unchanged', () => {
    const db = freshDb()
    const docId = seedDocRow(db)
    for (let i = 0; i < 5; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    getResidentVectors(db)

    deleteVec(db, 'c1')
    deleteVec(db, 'c3')
    invalidateResidentVectors(db)
    const map = getResidentVectors(db)

    expect([...map.keys()].sort()).toEqual(['c0', 'c2', 'c4'])
    expect(map.has('c1')).toBe(false)
    expect(map.has('c3')).toBe(false)
    expect(Array.from(map.get('c2')!)).toEqual(Array.from(makeVec(2))) // survivor unchanged
  })
})

// ---- The documented blind spot: delete-then-reinsert reusing the SAME rowid --------------------

describe('resident cache (incremental) — delete-then-reinsert-same-rowid', () => {
  it('reflects the NEW vector even when (count, maxRowid) is unchanged — the explicit hook closes it', () => {
    const db = freshDb()
    const docId = seedDocRow(db)
    insertVec(db, docId, 'A', makeVec(1))
    insertVec(db, docId, 'B', makeVec(2))
    insertVec(db, docId, 'C', makeVec(3)) // C is the max-rowid row
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(3)

    const before = signature(db)
    const cRowid = (db.prepare('SELECT rowid AS r FROM embeddings WHERE chunk_id = ?').get('C') as { r: number }).r

    // Delete the max-rowid row C, then insert a NEW chunk D — SQLite reuses C's freed rowid.
    deleteVec(db, 'C')
    insertVec(db, docId, 'D', makeVec(999))
    const dRowid = (db.prepare('SELECT rowid AS r FROM embeddings WHERE chunk_id = ?').get('D') as { r: number }).r
    expect(dRowid).toBe(cRowid) // rowid was reused — the signature blind spot
    expect(signature(db)).toEqual(before) // (count, maxRowid) IDENTICAL → signature can't see this

    // Teeth: with NO hook, the clean flag + unchanged signature take the fast path → STALE (still C,
    // no D). This proves the signature alone cannot catch a same-rowid reinsert.
    expect([...getResidentVectors(db).keys()].sort()).toEqual(['A', 'B', 'C'])

    // The explicit in-band hook flags the cache → reconcile swaps C out and D in (the new vector).
    invalidateResidentVectors(db)
    const map = getResidentVectors(db)
    expect([...map.keys()].sort()).toEqual(['A', 'B', 'D'])
    expect(map.has('C')).toBe(false)
    expect(Array.from(map.get('D')!)).toEqual(Array.from(makeVec(999)))
    // …and it equals a from-scratch rebuild.
    expect(snapshot(map)).toEqual(freshRebuild(db))
  })
})

// ---- Backstop: an out-of-band write (no hook) self-heals via the signature → full rebuild ------

describe('resident cache (incremental) — signature backstop self-heals an out-of-band write', () => {
  it('rebuilds and returns correct vectors when the table changes with NO invalidation hook', () => {
    const db = freshDb()
    const docId = seedDocRow(db)
    insertVec(db, docId, 'A', makeVec(1))
    insertVec(db, docId, 'B', makeVec(2))
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(2)

    // Out-of-band: insert E and delete A WITHOUT calling invalidate. The signature (count same,
    // maxRowid raised) differs from the cached one → the next read must full-rebuild (self-heal).
    // (If the signature backstop were neutered, the clean flag would serve the STALE {A,B} here.)
    insertVec(db, docId, 'E', makeVec(5))
    deleteVec(db, 'A')
    const map = getResidentVectors(db)

    expect([...map.keys()].sort()).toEqual(['B', 'E'])
    expect(map.has('A')).toBe(false)
    expect(Array.from(map.get('E')!)).toEqual(Array.from(makeVec(5)))
    expect(snapshot(map)).toEqual(freshRebuild(db))
  })
})

// ---- Lock purge: drops the map (security), distinct from invalidate which retains it -----------

describe('resident cache (incremental) — lock purge', () => {
  it('purge DROPS the decoded map (a later read re-decodes all N) while invalidate retains it', () => {
    const db = freshDb()
    const docId = seedDocRow(db)
    const N = 12
    for (let i = 0; i < N; i++) insertVec(db, docId, `c${i}`, makeVec(i))
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(N) // build

    // invalidate (no table change) → reconcile decodes NOTHING; the map is retained in RAM.
    decodeSpy.mockClear()
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(N)
    expect(decodeSpy).toHaveBeenCalledTimes(0)

    // purge (workspace lock) → the map is GONE; the next read re-decodes every row from the DB.
    decodeSpy.mockClear()
    purgeResidentVectors(db)
    expect(decodeSpy).toHaveBeenCalledTimes(0) // purge itself touches no vectors
    expect(getResidentVectors(db).size).toBe(N)
    expect(decodeSpy).toHaveBeenCalledTimes(N) // full re-decode ⇒ the prior decoded buffer was dropped
  })

  it('serves no post-lock vectors: after purge the cache reflects the current DB, not stale RAM', () => {
    const db = freshDb()
    const docId = seedDocRow(db)
    insertVec(db, docId, 'A', makeVec(1))
    invalidateResidentVectors(db)
    expect(getResidentVectors(db).size).toBe(1)

    purgeResidentVectors(db)
    db.prepare('DELETE FROM embeddings').run() // table emptied while "locked"
    expect(getResidentVectors(db).size).toBe(0) // rebuilt empty — no lingering decoded vector
  })
})
