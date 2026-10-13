import { describe, it, expect } from 'vitest'
import type { Db } from '../../src/main/services/db'
import { evictSummaryCache, SUMMARY_CACHE_MAX_ROWS } from '../../src/main/services/analysis/summary-cache'
import { openFreshDb } from '../helpers/db-fixtures'

// summary_cache row-count eviction (backend-audit-2026-06-27 DATA-3/MAINT-3). The cache has no
// document_id and survives node/tree/document deletion, so nothing else prunes it; eviction
// bounds it by deleting the OLDEST rows (created_at) past a row-count cap. Content-free: it
// touches row counts only, never the summary_text.

/** Run `fn` with the documented HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS knob set to `cap`, restoring it after. */
function withMaxRows<T>(cap: number, fn: () => T): T {
  const prev = process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS
  process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS = String(cap)
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS
    else process.env.HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS = prev
  }
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
  it('prunes a cache past the HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS cap down to the cap, keeping the NEWEST rows', () => {
    const db = openFreshDb('summarycache')
    seedCache(db, 10)

    const evicted = withMaxRows(4, () => evictSummaryCache(db))

    expect(evicted).toBe(6)
    expect(rowCount(db)).toBe(4)
    // The 4 survivors are the 4 NEWEST (hash-0006..hash-0009); the oldest 6 were pruned.
    expect(survivingHashes(db)).toEqual(['hash-0006', 'hash-0007', 'hash-0008', 'hash-0009'])
  })

  it('is a no-op at or under the cap (a recent entry survives, nothing pruned)', () => {
    const db = openFreshDb('summarycache')
    seedCache(db, 3)

    expect(withMaxRows(4, () => evictSummaryCache(db))).toBe(0) // under cap
    expect(withMaxRows(3, () => evictSummaryCache(db))).toBe(0) // exactly at cap
    expect(rowCount(db)).toBe(3)
    // The most-recent entry is untouched.
    expect(survivingHashes(db)).toContain('hash-0002')
  })

  it('defaults to a generous cap so an ordinary library is never pruned', () => {
    expect(SUMMARY_CACHE_MAX_ROWS).toBeGreaterThanOrEqual(10_000)
    const db = openFreshDb('summarycache')
    seedCache(db, 20)
    // No override, no env: the default cap is far above 20, so nothing is evicted.
    expect(evictSummaryCache(db)).toBe(0)
    expect(rowCount(db)).toBe(20)
  })
})

describe('summary_cache eviction index (PERF-4, full audit 2026-06-28)', () => {
  it('uses idx_summary_cache_created (an index scan, not a full scan + full sort)', () => {
    const db = openFreshDb('summarycache')
    seedCache(db, 2) // over a cap of 1, so the DELETE really runs
    const evictSql: string[] = []
    const real = db.prepare.bind(db)
    const target = db as unknown as { prepare: Db['prepare'] }
    target.prepare = ((sql: string) => {
      if (/DELETE FROM summary_cache/.test(sql)) evictSql.push(sql)
      return real(sql)
    }) as Db['prepare']
    try {
      withMaxRows(1, () => evictSummaryCache(db))
    } finally {
      target.prepare = real
    }
    expect(evictSql).toHaveLength(1) // the statement evictSummaryCache ran — never a hand-kept copy of it
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${evictSql[0]}`).all(10) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toContain('idx_summary_cache_created')
    // The residual is only a partial sort for the content_hash tiebreak within an identical
    // created_at — not the full-table temp B-tree sort PERF-4 removes.
  })
})
