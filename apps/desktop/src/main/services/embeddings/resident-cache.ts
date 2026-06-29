import type { Db } from '../db'
import { decodeVector } from './codec'

// RAG-1 / RAG-6 (perf audit 2026-06-18, Wave P4 — the D15 deferral, resolved in part) and
// PERF-1 (full-audit-2026-06-29, Phase 5 — the per-write rebuild removed).
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
// PERF-1 — INCREMENTAL MAINTENANCE (Phase 5). The map was originally DROPPED WHOLE on every
// `embeddings` write (each insert/delete/reindex called `invalidate` → `caches.delete`), so the
// next query paid a full ~150 MB re-read + ~580 ms re-decode — and that recurred after *every*
// import/re-index/delete (a heavy "import N docs, ask between each" session paid N full rebuilds).
// Now a write only MARKS the cache dirty, and the next query RECONCILES the delta instead of
// re-decoding the corpus:
//   • an `ids-only` scan (`SELECT chunk_id` — no `vector_blob`, no decode) yields the current id
//     set; cached ids no longer present are DELETED from the map, and
//   • ONLY the ids present now but absent from the map (the genuinely-new chunks) are fetched +
//     `decodeVector`'d (a point lookup per new id on the `chunk_id` PRIMARY-KEY index).
// So a pure-add of K vectors into an N-vector corpus DECODES exactly K rows, never N — the
// PERF-1 win. The reconcile keys on the UNIQUE `chunk_id` (PRIMARY KEY), not on rowid, so it is
// correct even when a deleted row's rowid is reused by a re-index (the documented blind spot
// below) — a reused rowid still carries a NEW `chunk_id`, so the old id is removed and the new id
// decoded. The result is byte-identical to a from-scratch `build` for every insert/delete/reindex
// sequence (an in-band write never mutates a vector under a *surviving* chunk_id; re-index mints
// fresh ids).
//
// CORRECTNESS — the resident buffer MUST never serve a stale or post-lock vector. Three
// mechanisms, belt-and-suspenders (the ranking-corruption surface is the highest risk here):
//
//   • EXPLICIT DELTA (primary): `invalidate(db)` is called at the three `embeddings` write sites
//     (`ingestion/index.ts` finalize-insert + reindex-delete + doc-delete). It now sets a `dirty`
//     flag (instead of dropping the map); the next `getResidentVectors` runs the chunk-id
//     reconcile above. This is the in-band path that every production mutation takes, and it is
//     what closes the one signature blind spot — deleting the single max-rowid row then inserting
//     exactly one row that REUSES that rowid leaves `(count, maxRowid)` unchanged, so only the
//     explicit flag (not the signature) can see it; the reconcile's chunk-id diff then swaps the
//     old id out and the new id in.
//   • STALENESS SIGNATURE (backstop / self-heal): a cheap whole-table `(count, maxRowid)` is
//     recomputed at the top of every search. If the table changed but NO write went through the
//     explicit hook (an out-of-band writer — a test, a future code path), the flag is clear yet
//     the signature mismatches → FALL BACK TO A FULL REBUILD. `MAX(rowid)` is O(1) (rightmost
//     btree leaf) and `COUNT(*)` is a fast index count, both negligible vs the scan they gate.
//     This is the path that makes a missed/buggy incremental update SELF-HEAL on the next query;
//     it must not be removed.
//   • SECURITY (lock): `purge(db)` drops the resident map outright. Called on workspace LOCK
//     (alongside the embedder's `suspend()`, which purges the sidecar's recent-text memory):
//     the decoded vectors are derived from chunk text and must not linger in main-process RAM
//     after the vault re-encrypts. The signature would NOT catch this (the table is unchanged),
//     so the lock purge is a hard, separate requirement. Also called on embedder (re)init.
//
// Everything stays in-process and offline: no network, no native dependency, no worker — the
// off-main-thread scan (P4b) and an ANN index (P4c / sqlite-vec) remain deferred behind the
// unchanged `VectorIndex.search` signature (see architecture.md "Performance — design record
// … Wave P4" and rag-design.md §12.2 D15). Phase 5 only removes the per-write FULL rebuild.

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
  /**
   * Set by an explicit `invalidate` at an `embeddings` write site: the next `getResidentVectors`
   * reconciles the delta (chunk-id diff) rather than trusting the staleness signature, which
   * cannot see a delete-then-reuse-same-rowid write. Cleared once the reconcile runs.
   */
  dirty: boolean
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

function signaturesEqual(a: Signature, b: Signature): boolean {
  return a.count === b.count && a.maxRowid === b.maxRowid
}

interface VectorRow {
  chunk_id: string
  vector_blob: Uint8Array
  dimensions: number
}

interface ChunkIdRow {
  chunk_id: string
}

/** Decode every stored vector once into a fresh `Map<chunkId, Float32Array>` (full rebuild). */
function build(db: Db, signature: Signature): ResidentVectors {
  const rows = db
    .prepare('SELECT chunk_id, vector_blob, dimensions FROM embeddings')
    .all() as unknown as VectorRow[]
  const byChunk = new Map<string, Float32Array>()
  for (const row of rows) {
    // decodeVector returns null for a physically truncated blob (partial write) — skip it so
    // the chunk is simply absent from the map, exactly like the old per-row skip (DATA-2: the
    // length guard now lives inside decodeVector, shared by every caller).
    const vec = decodeVector(row.vector_blob, row.dimensions)
    if (vec) byChunk.set(row.chunk_id, vec)
  }
  return { signature, byChunk, dirty: false }
}

/**
 * Apply the embeddings delta to an existing cache IN PLACE, decoding only the genuinely-new rows
 * (PERF-1). Keyed on the unique `chunk_id`, so it is correct across insert / delete / re-index /
 * delete-then-reinsert-same-rowid and is byte-identical to a from-scratch `build` for any in-band
 * write sequence. Mutates and returns `cached`.
 */
function reconcile(db: Db, cached: ResidentVectors, signature: Signature): ResidentVectors {
  const byChunk = cached.byChunk
  // ids-only scan: read just the `chunk_id` column (no `vector_blob` → no 150 MB read, no decode).
  // Served from the `chunk_id` PRIMARY-KEY index; far cheaper than decoding every blob.
  const idRows = db.prepare('SELECT chunk_id FROM embeddings').all() as unknown as ChunkIdRow[]
  const currentIds = new Set<string>()
  for (const r of idRows) currentIds.add(r.chunk_id)

  // Drop cached ids that are no longer present (deletes / re-index of the old chunk ids).
  for (const id of byChunk.keys()) {
    if (!currentIds.has(id)) byChunk.delete(id)
  }

  // Decode ONLY ids present now but absent from the map — the new vectors. A point lookup per id
  // on the PK index; decode count == number of genuinely-new rows (== K for a pure-add of K).
  const fetch = db.prepare('SELECT vector_blob, dimensions FROM embeddings WHERE chunk_id = ?')
  for (const id of currentIds) {
    if (byChunk.has(id)) continue
    const row = fetch.get(id) as unknown as { vector_blob: Uint8Array; dimensions: number } | undefined
    if (!row) continue // raced delete — left absent, the next signature mismatch self-heals
    const vec = decodeVector(row.vector_blob, row.dimensions)
    if (vec) byChunk.set(id, vec) // truncated blob → omitted, exactly like build()
  }

  cached.signature = signature
  cached.dirty = false
  return cached
}

/**
 * Return the resident decoded-vector map for `db`. The cheap `(count, maxRowid)` signature is
 * recomputed every call; combined with the `dirty` flag set by the write-site hooks it routes to:
 *   • the FAST PATH — nothing changed (clean flag + matching signature) → return the cached map;
 *   • the INCREMENTAL RECONCILE — an explicit write hook fired (`dirty`) → apply only the delta
 *     (decode only new chunks; PERF-1); or
 *   • a FULL REBUILD — the table changed with NO hook (out-of-band write) so the signature
 *     mismatches → rebuild from scratch (the self-healing backstop); also the cold first build.
 * The returned map is the live cache — callers MUST treat it read-only (never mutate it).
 */
export function getResidentVectors(db: Db): ReadonlyMap<string, Float32Array> {
  const signature = computeSignature(db)
  const cached = caches.get(db)
  if (!cached) {
    const fresh = build(db, signature)
    caches.set(db, fresh)
    return fresh.byChunk
  }
  if (cached.dirty) {
    // An in-band write flagged the cache: reconcile the delta (correct even for a reused rowid).
    reconcile(db, cached, signature)
    return cached.byChunk
  }
  if (signaturesEqual(cached.signature, signature)) {
    return cached.byChunk // unchanged since the last build/reconcile — fast path
  }
  // Clean flag but the signature drifted ⇒ a write that bypassed the hooks (out-of-band). Don't
  // trust the incremental base; rebuild from scratch. This is the correctness backstop that makes
  // a missed/buggy incremental update self-heal — do not remove it.
  const fresh = build(db, signature)
  caches.set(db, fresh)
  return fresh.byChunk
}

/**
 * Mark the cached map for `db` dirty so the next `getResidentVectors` RECONCILES the embeddings
 * delta (decoding only new chunks) instead of re-decoding the corpus. Called at every `embeddings`
 * write site (the explicit, in-band delta signal). A no-op if nothing is cached — the next read
 * then does the cold build. NOTE: this no longer drops the map (that was the PERF-1 per-write
 * full rebuild); the map is only fully discarded by `purge` (lock) or the signature backstop.
 */
export function invalidateResidentVectors(db: Db): void {
  const cached = caches.get(db)
  if (cached) cached.dirty = true
}

/**
 * Purge the resident map for `db` from memory. Unlike `invalidate` (which only marks dirty), this
 * DROPS the map entirely: it is the SECURITY contract, invoked on workspace LOCK (and embedder
 * (re)init) to guarantee chunk-text-derived vectors do not linger in RAM after the vault
 * re-encrypts — a requirement the staleness signature does not cover (the table is unchanged).
 */
export function purgeResidentVectors(db: Db): void {
  caches.delete(db)
}
