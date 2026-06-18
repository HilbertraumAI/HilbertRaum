import type { Db } from '../db'
import { decodeVector } from './codec'

// RAG-1 / RAG-6 (perf audit 2026-06-18, Wave P4 — the D15 deferral, resolved in part).
//
// THE PROBLEM. `VectorIndex.search` runs on the Electron MAIN process, synchronously, on
// every question: it SELECTed all matching embedding rows (vector BLOBs included), then in
// one uninterruptible loop `decodeVector` (a slice copy per row) + `dotProduct` over every
// vector. At ~100 docs × the 1000-chunk cap that is ~100k vectors (~150 MB) **read from
// SQLite and re-decoded from scratch on EVERY query**. Wave P1 added mmap (DB-2) and Wave P3
// the dot-product slice (RAG-1 cheap half); the structural waste — re-reading + re-decoding
// the same BLOBs every query — is killed here.
//
// THE FIX. Decode every stored vector **once** into a process-resident `Map<chunkId,
// Float32Array>` and reuse it across queries. A query then:
//   1. runs the EXACT same scope-filtered SQL as before but projects only `chunk_id` (no
//      `vector_blob` → no 150 MB blob read), and
//   2. looks each chunk's already-decoded vector up in the resident map (zero per-row
//      allocation, zero re-decode).
// Ranking is byte-identical to the old decode-every-row path (same `dotProduct`, same sort).
//
// CORRECTNESS — the resident buffer MUST never serve a stale or post-lock vector. Two
// mechanisms, belt-and-suspenders (the ranking-corruption surface is the highest risk here):
//
//   • STALENESS (primary): a cheap whole-table signature `(count, maxRowid)` is recomputed at
//     the top of every search; any mismatch rebuilds the map. `MAX(rowid)` is O(1) (rightmost
//     btree leaf) and `COUNT(*)` is a fast index count, both negligible vs the scan they gate.
//     This catches inserts (import), deletes (doc delete), and reindex (delete+insert raises
//     maxRowid) — i.e. every embeddings mutation in the tree.
//   • EXPLICIT (belt): `invalidate(db)` is also called at the three `embeddings` write sites
//     (`ingestion/index.ts` finalize-insert + reindex-delete + doc-delete). This closes the one
//     signature blind spot — deleting the single max-rowid row then inserting exactly one row
//     that reuses that rowid leaves `(count, maxRowid)` unchanged — and makes the cache robust
//     to any future writer that forgets the contract is "signature-checked".
//
//   • SECURITY (lock): `purge(db)` drops the resident map outright. Called on workspace LOCK
//     (alongside the embedder's `suspend()`, which purges the sidecar's recent-text memory):
//     the decoded vectors are derived from chunk text and must not linger in main-process RAM
//     after the vault re-encrypts. The signature would NOT catch this (the table is unchanged),
//     so the lock purge is a hard, separate requirement. Also called on embedder (re)init.
//
// Everything stays in-process and offline: no network, no native dependency, no worker — the
// off-main-thread scan (P4b) and an ANN index (P4c / sqlite-vec) remain deferred behind the
// unchanged `VectorIndex.search` signature (see architecture.md "Performance — design record
// … Wave P4" and rag-design.md §12.2 D15).

/** Cheap whole-table fingerprint that changes on any insert/delete (see module header). */
interface Signature {
  count: number
  maxRowid: number
}

interface ResidentVectors {
  signature: Signature
  /**
   * chunkId → its decoded, L2-normalized `Float32Array`. Rows whose stored BLOB is physically
   * shorter than `dimensions * 4` bytes (a partial write) are OMITTED at build time, so a
   * corrupt row is simply absent from the map — reproducing `search`'s old per-row
   * truncated-blob skip without the per-query length check.
   */
  byChunk: Map<string, Float32Array>
}

/** One resident cache per open database connection. WeakMap ⇒ a closed Db is GC-eligible. */
const caches = new WeakMap<Db, ResidentVectors>()

interface SignatureRow {
  count: number
  maxRowid: number | null
}

/** Recompute the whole-table `(count, maxRowid)` signature. `MAX(rowid)` is O(1). */
function computeSignature(db: Db): Signature {
  const row = db
    .prepare('SELECT COUNT(*) AS count, MAX(rowid) AS maxRowid FROM embeddings')
    .get() as unknown as SignatureRow
  // An empty table has MAX(rowid) = NULL — normalize to 0 so the signature is well-defined.
  return { count: row.count, maxRowid: row.maxRowid ?? 0 }
}

interface VectorRow {
  chunk_id: string
  vector_blob: Uint8Array
  dimensions: number
}

/** Decode every stored vector once into a fresh `Map<chunkId, Float32Array>`. */
function build(db: Db, signature: Signature): ResidentVectors {
  const rows = db
    .prepare('SELECT chunk_id, vector_blob, dimensions FROM embeddings')
    .all() as unknown as VectorRow[]
  const byChunk = new Map<string, Float32Array>()
  for (const row of rows) {
    // Skip a physically truncated blob (partial write) — decodeVector would throw a
    // RangeError. The chunk is then absent from the map, exactly like the old per-row skip.
    if (row.vector_blob.length < row.dimensions * 4) continue
    byChunk.set(row.chunk_id, decodeVector(row.vector_blob, row.dimensions))
  }
  return { signature, byChunk }
}

/**
 * Return the resident decoded-vector map for `db`, rebuilding it iff the cheap signature shows
 * the `embeddings` table changed since the last build (or it was invalidated/purged). The
 * returned map is the live cache — callers MUST treat it read-only (never mutate it).
 */
export function getResidentVectors(db: Db): ReadonlyMap<string, Float32Array> {
  const signature = computeSignature(db)
  const cached = caches.get(db)
  if (cached && cached.signature.count === signature.count && cached.signature.maxRowid === signature.maxRowid) {
    return cached.byChunk
  }
  const fresh = build(db, signature)
  caches.set(db, fresh)
  return fresh.byChunk
}

/**
 * Drop the cached map for `db` so the next `getResidentVectors` rebuilds. Called at every
 * `embeddings` write site (the explicit belt around the signature check). A no-op if nothing
 * is cached.
 */
export function invalidateResidentVectors(db: Db): void {
  caches.delete(db)
}

/**
 * Purge the resident map for `db` from memory. Same effect as `invalidate` today, but it is a
 * DISTINCT, named call for the security contract: it is invoked on workspace LOCK (and embedder
 * (re)init) to guarantee chunk-text-derived vectors do not linger in RAM after the vault
 * re-encrypts — a requirement the staleness signature does not cover (the table is unchanged).
 */
export function purgeResidentVectors(db: Db): void {
  caches.delete(db)
}
