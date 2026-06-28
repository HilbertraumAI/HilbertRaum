import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  evictSummaryCache,
  summaryCacheEvictedThisSession,
  SUMMARY_CACHE_MAX_ROWS
} from '../../src/main/services/analysis/summary-cache'

// summary_cache row-count eviction (backend-audit-2026-06-27 DATA-3/MAINT-3). The cache has no
// document_id and survives node/tree/document deletion, so nothing else prunes it; eviction
// bounds it by deleting the OLDEST rows (created_at) past a row-count cap. Content-free: it
// touches row counts only, never the summary_text.

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-summarycache-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

/** Insert `count` cache rows with strictly increasing created_at (row i is the i-th oldest). */
function seedCache(db: Db, count: number): void {
  const put = db.prepare(
    `INSERT INTO summary_cache (content_hash, model_id, summary_text, embedding_blob,
        embedding_model_id, dimensions, created_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?)`
  )
  for (let i = 0; i < count; i++) {
    // Zero-padded ordinal so lexicographic created_at order == insertion order.
    const ts = `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
    put.run(`hash-${String(i).padStart(4, '0')}`, 'model-a', `summary ${i}`, ts)
  }
}

function rowCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM summary_cache').get() as { n: number }).n
}

function survivingHashes(db: Db): string[] {
  const rows = db
    .prepare('SELECT content_hash FROM summary_cache ORDER BY created_at ASC')
    .all() as unknown as Array<{ content_hash: string }>
  return rows.map((r) => r.content_hash)
}

describe('evictSummaryCache (DATA-3/MAINT-3)', () => {
  it('prunes a cache past the cap down to the cap, keeping the NEWEST rows', () => {
    const db = freshDb()
    seedCache(db, 10)
    const before = summaryCacheEvictedThisSession()

    const evicted = evictSummaryCache(db, 4)

    expect(evicted).toBe(6)
    expect(rowCount(db)).toBe(4)
    // The 4 survivors are the 4 NEWEST (hash-0006..hash-0009); the oldest 6 were pruned.
    expect(survivingHashes(db)).toEqual(['hash-0006', 'hash-0007', 'hash-0008', 'hash-0009'])
    // The session diagnostics counter advanced by exactly the evicted count.
    expect(summaryCacheEvictedThisSession()).toBe(before + 6)
  })

  it('is a no-op at or under the cap (a recent entry survives, nothing pruned)', () => {
    const db = freshDb()
    seedCache(db, 3)
    const before = summaryCacheEvictedThisSession()

    expect(evictSummaryCache(db, 4)).toBe(0) // under cap
    expect(evictSummaryCache(db, 3)).toBe(0) // exactly at cap
    expect(rowCount(db)).toBe(3)
    // The most-recent entry is untouched.
    expect(survivingHashes(db)).toContain('hash-0002')
    expect(summaryCacheEvictedThisSession()).toBe(before)
  })

  it('honors the HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS env override when no argument is passed', () => {
    const db = freshDb()
    seedCache(db, 8)
    const prev = process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS
    process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS = '5'
    try {
      expect(evictSummaryCache(db)).toBe(3)
      expect(rowCount(db)).toBe(5)
    } finally {
      if (prev === undefined) delete process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS
      else process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS = prev
    }
  })

  it('defaults to a generous cap so an ordinary library is never pruned', () => {
    expect(SUMMARY_CACHE_MAX_ROWS).toBeGreaterThanOrEqual(10_000)
    const db = freshDb()
    seedCache(db, 20)
    // No override, no env: the default cap is far above 20, so nothing is evicted.
    expect(evictSummaryCache(db)).toBe(0)
    expect(rowCount(db)).toBe(20)
  })
})

describe('summary_cache eviction index (PERF-4, full audit 2026-06-28)', () => {
  // Mirrors the DELETE in evictSummaryCache (summary-cache.ts): the oldest rows by created_at.
  const EVICT_SQL = `DELETE FROM summary_cache WHERE rowid IN (
         SELECT rowid FROM summary_cache ORDER BY created_at ASC, content_hash ASC LIMIT ?
       )`
  const plan = (db: Db): string =>
    (db.prepare('EXPLAIN QUERY PLAN ' + EVICT_SQL).all(10) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ')

  it('uses idx_summary_cache_created (an index scan, not a full scan + full sort)', () => {
    const db = freshDb()
    const p = plan(db)
    expect(p).toContain('idx_summary_cache_created')
    // The residual is only a partial sort for the content_hash tiebreak within an identical
    // created_at — not the full-table temp B-tree sort PERF-4 removes.
  })

  it('TEETH: without the index, eviction falls back to a full scan + temp B-tree sort', () => {
    const db = freshDb()
    db.exec('DROP INDEX idx_summary_cache_created')
    const p = plan(db)
    expect(p).not.toContain('idx_summary_cache_created')
    expect(p).toMatch(/SCAN summary_cache(?! USING INDEX)/) // a bare full table scan
    expect(p).toMatch(/USE TEMP B-TREE FOR ORDER BY/) // the full sort
  })
})
