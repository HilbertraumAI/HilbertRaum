// A `db.prepare` call counter for query-count assertions. Pure: no electron import, no module state.
import type { Db } from '../../src/main/services/db'

/**
 * Count the `db.prepare` calls whose SQL matches `pattern` while `fn` runs (the query-count assertions).
 * Match `FROM bank_transactions` to count only row LOADS, never the reconciled/category persists. The original
 * `prepare` is restored in `finally`, so an assertion failure inside `fn` cannot leak the spy.
 */
export async function countPrepares(db: Db, pattern: RegExp, fn: () => Promise<void>): Promise<number> {
  const real = db.prepare.bind(db)
  let count = 0
  const target = db as unknown as { prepare: Db['prepare'] }
  target.prepare = ((sql: string) => {
    if (pattern.test(sql)) count++
    return real(sql)
  }) as Db['prepare']
  try {
    await fn()
  } finally {
    target.prepare = real
  }
  return count
}
