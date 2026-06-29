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
// re-decoding the corpus. There are two reconcile paths, both byte-identical to a from-scratch
// `build`:
//   • DELTA RECONCILE (F12 fast path): an in-band write site names the exact chunk_ids it added /
//     removed (`invalidate(db, { added, removed })`). The next read drops the removed ids and
//     `decodeVector`'s ONLY the added ids (a point lookup per id on the `chunk_id` PRIMARY KEY) —
//     NO whole-table scan. So a pure-add of K vectors into an N-vector corpus touches K rows, never
//     N. A cheap `Map.size === COUNT(*)` gate then confirms the result is consistent; a mismatch
//     (a missed/wrong delta, or a truncated-blob row that build also omits) falls back to ↓.
//   • FULL RECONCILE (self-heal / delta-less write): an `ids-only` scan (`SELECT chunk_id` — no
//     `vector_blob`, no decode) yields the current id set; cached ids no longer present are deleted
//     and only the ids absent from the map are decoded. This is what a delta-less `invalidate(db)`
//     (a direct/out-of-band SQL writer — tests, the manual bench) takes, and what the size gate
//     self-heals to. It is O(N) in id marshalling but does NOT re-decode (the PERF-1 win still
//     holds); the delta path avoids even the id-scan.
// Both paths key on the UNIQUE `chunk_id`, not on rowid, so they stay correct even when a deleted
// row's rowid is reused by a re-index (the documented blind spot below) — a reused rowid carries a
// NEW chunk_id, so the old id is removed and the new id decoded. The result is byte-identical to a
// from-scratch `build` for every insert/delete/reindex sequence (an in-band write never mutates a
// vector under a *surviving* chunk_id; re-index mints fresh ids).
//
// CORRECTNESS — the resident buffer MUST never serve a stale or post-lock vector. Three
// mechanisms, belt-and-suspenders (the ranking-corruption surface is the highest risk here):
//
//   • EXPLICIT DELTA (primary): `invalidate(db, delta?)` is called at the three `embeddings` write
//     sites (`ingestion/index.ts` finalize-insert + reindex-delete + doc-delete), each passing the
//     exact chunk_ids it changed so the next read takes the F12 delta fast path above. It sets a
//     pending delta (instead of dropping the map); the next `getResidentVectors` reconciles. This
//     is the in-band path that every production mutation takes, and it is what closes the one
//     signature blind spot — deleting the single max-rowid row then inserting exactly one row that
//     REUSES that rowid leaves `(count, maxRowid)` unchanged, so only the explicit flag (not the
//     signature) can see it; the reconcile's chunk-id diff then swaps the old id out and the new id
//     in. A delta-less `invalidate(db)` (a caller that can't name the ids) is honoured too — it
//     forces the full chunk-id scan.
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
// … Wave P4" and rag-design.md §12.2 D15). Phase 5 removed the per-write FULL rebuild; F12 (the
// post-merge close-out) removed the O(N) `chunk_id` scan too for the in-band write paths.

/** Cheap whole-table fingerprint that changes on any insert/delete (see module header). */
interface Signature {
  count: number
  maxRowid: number
}

/** A named chunk-id delta from an in-band `embeddings` write site (F12). Empty / absent fields
 *  mean "no change of that kind"; a delta-LESS `invalidate(db)` forces the full chunk-id scan. */
export interface EmbeddingDelta {
  added?: Iterable<string>
  removed?: Iterable<string>
}

/**
 * The NET chunk-id change accumulated by `invalidate` calls since the last read (F12). `added` and
 * `removed` are kept DISJOINT (an add then a delete of the same id nets to neither). `full` is set
 * by a delta-less `invalidate(db)` (a writer that didn't name the ids — tests, the manual bench) or
 * left for the size-gate self-heal: the next reconcile then takes the whole-table chunk-id scan and
 * `added`/`removed` are ignored.
 */
interface PendingDelta {
  added: Set<string>
  removed: Set<string>
  full: boolean
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
   * Non-null once an explicit `invalidate` at an `embeddings` write site has flagged the cache: the
   * next `getResidentVectors` RECONCILES this delta rather than trusting the staleness signature,
   * which cannot see a delete-then-reuse-same-rowid write. Cleared (→ null) once the reconcile runs.
   */
  pending: PendingDelta | null
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
  return { signature, byChunk, pending: null }
}

/** Decode `chunkId`'s stored vector by a point lookup on the `chunk_id` PRIMARY-KEY index and set
 *  it on `byChunk` (omitting a truncated/missing row, exactly like `build`). Shared by both
 *  reconcile paths. */
function decodeInto(
  byChunk: Map<string, Float32Array>,
  fetch: ReturnType<Db['prepare']>,
  chunkId: string
): void {
  const row = fetch.get(chunkId) as unknown as { vector_blob: Uint8Array; dimensions: number } | undefined
  if (!row) return // raced delete — left absent; the size gate / next signature mismatch self-heals
  const vec = decodeVector(row.vector_blob, row.dimensions)
  if (vec) byChunk.set(chunkId, vec) // truncated blob → omitted, exactly like build()
}

/**
 * FULL reconcile: an `ids-only` whole-table scan (`SELECT chunk_id` — no `vector_blob`, no decode)
 * drops cached ids no longer present and decodes only the ids absent from the map. O(N) in id
 * marshalling but never re-decodes the corpus (the PERF-1 win). Keyed on the unique `chunk_id`, so
 * correct across insert / delete / re-index / delete-then-reinsert-same-rowid and byte-identical to
 * a from-scratch `build` for any in-band sequence. Used for a delta-less `invalidate(db)` and as
 * the self-heal when the delta path's size gate trips. Mutates `cached.byChunk` in place.
 */
function reconcileFull(db: Db, cached: ResidentVectors): void {
  const byChunk = cached.byChunk
  const idRows = db.prepare('SELECT chunk_id FROM embeddings').all() as unknown as ChunkIdRow[]
  const currentIds = new Set<string>()
  for (const r of idRows) currentIds.add(r.chunk_id)

  // Drop cached ids that are no longer present (deletes / re-index of the old chunk ids).
  for (const id of byChunk.keys()) {
    if (!currentIds.has(id)) byChunk.delete(id)
  }

  // Decode ONLY ids present now but absent from the map — the new vectors.
  const fetch = db.prepare('SELECT vector_blob, dimensions FROM embeddings WHERE chunk_id = ?')
  for (const id of currentIds) {
    if (byChunk.has(id)) continue
    decodeInto(byChunk, fetch, id)
  }
}

/**
 * DELTA reconcile (F12): apply the NAMED chunk-id delta IN PLACE, decoding ONLY the added ids — no
 * whole-table `chunk_id` scan. Returns whether the result is CONSISTENT with the table's COUNT(*)
 * (`signature.count`): a correct in-band delta over a correct base always is (a missed add → too
 * few entries, a missed/extra delete → too many — both caught), so a `false` return tells the
 * caller to fall back to the self-healing `reconcileFull`. A truncated-blob row (build omits it
 * too) also returns `false` → a full scan that likewise omits it, i.e. fails SAFE. For every
 * in-band insert/delete/reindex/same-rowid sequence the result is byte-identical to a cold `build`
 * (a surviving chunk_id's vector never mutates; re-index mints fresh ids — see the module header).
 */
function reconcileDelta(
  db: Db,
  cached: ResidentVectors,
  pending: PendingDelta,
  signature: Signature
): boolean {
  const byChunk = cached.byChunk
  for (const id of pending.removed) byChunk.delete(id)
  if (pending.added.size > 0) {
    const fetch = db.prepare('SELECT vector_blob, dimensions FROM embeddings WHERE chunk_id = ?')
    for (const id of pending.added) {
      if (byChunk.has(id)) continue // a surviving chunk_id's vector never mutates in-band
      decodeInto(byChunk, fetch, id)
    }
  }
  // Cheap consistency gate (one `Map.size` compare): a correct delta over a correct base leaves
  // size == COUNT(*); any drift (or a truncated-blob omission) trips it → the caller self-heals.
  return byChunk.size === signature.count
}

/**
 * Return the resident decoded-vector map for `db`. The cheap `(count, maxRowid)` signature is
 * recomputed every call; combined with the pending delta set by the write-site hooks it routes to:
 *   • the FAST PATH — nothing changed (no pending delta + matching signature) → return the map;
 *   • the DELTA RECONCILE (F12) — an in-band write named its added/removed ids → apply just that
 *     (decode only the new chunks, NO id-scan), with a size-gate fall-through to ↓ on any drift;
 *   • the FULL RECONCILE — a delta-less write (or a size-gate trip) → ids-only scan, decode only
 *     the new chunks (no re-decode of the corpus); or
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
  const pending = cached.pending
  if (pending) {
    // An in-band write flagged the cache. Take the F12 delta fast path when the ids were named and
    // the post-delta size agrees with COUNT(*); otherwise fall back to the self-healing full scan
    // (a delta-less write, a missed/wrong delta, or a truncated-blob omission). Both are
    // byte-identical to a cold rebuild for every in-band sequence (the PERF-1 contract).
    if (pending.full || !reconcileDelta(db, cached, pending, signature)) {
      reconcileFull(db, cached)
    }
    cached.signature = signature
    cached.pending = null
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
 * Flag the cached map for `db` so the next `getResidentVectors` RECONCILES the embeddings delta
 * instead of re-decoding the corpus. Called at every `embeddings` write site (the explicit, in-band
 * delta signal).
 *
 *   • With a NAMED `delta` (the production sites pass the chunk_ids they added/removed) the next
 *     read takes the F12 delta fast path — decode only the new chunks, NO O(N) `chunk_id` scan.
 *   • WITHOUT a delta (a direct/out-of-band SQL writer that can't name the ids — tests, the manual
 *     bench) the next read takes the full chunk-id scan. Conservative and backward-compatible.
 *
 * A no-op if nothing is cached — the next read does the cold build (which reads the post-write
 * table). NOTE: this never drops the map (that was the PERF-1 per-write rebuild); the map is fully
 * discarded only by `purge` (lock) or the signature backstop.
 */
export function invalidateResidentVectors(db: Db, delta?: EmbeddingDelta): void {
  const cached = caches.get(db)
  if (!cached) return
  const pending = (cached.pending ??= { added: new Set<string>(), removed: new Set<string>(), full: false })
  if (!delta) {
    // The caller didn't name the changed ids → force the full chunk-id scan on the next read.
    pending.full = true
    return
  }
  // Merge into the NET delta, keeping `added`/`removed` disjoint: a delete supersedes a pending add
  // of the same id, and a (re-)add supersedes a pending delete — so multiple writes before one read
  // compose correctly.
  if (delta.removed) {
    for (const id of delta.removed) {
      pending.added.delete(id)
      pending.removed.add(id)
    }
  }
  if (delta.added) {
    for (const id of delta.added) {
      pending.removed.delete(id)
      pending.added.add(id)
    }
  }
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
