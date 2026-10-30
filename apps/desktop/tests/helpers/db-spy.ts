// `db.prepare` spies: a recorder for query-plan assertions and a call counter for query-count assertions. Pure: no
// electron import, no module state.
import type { Db } from '../../src/main/services/db'

/**
 * Every SQL string matching `pattern` that `db.prepare` received while `fn` ran, in order (`/[\s\S]/` for all). Use it
 * to EXPLAIN the statement production actually prepares instead of a retyped copy. `prepare` is restored in `finally`,
 * so an assertion failure inside `fn` cannot leak the spy.
 */
export async function capturePrepares(db: Db, pattern: RegExp, fn: () => unknown): Promise<string[]> {
  const real = db.prepare.bind(db)
  const seen: string[] = []
  const target = db as unknown as { prepare: Db['prepare'] }
  target.prepare = ((sql: string) => {
    if (pattern.test(sql)) seen.push(sql)
    return real(sql)
  }) as Db['prepare']
  try {
    await fn()
  } finally {
    target.prepare = real
  }
  return seen
}

/**
 * Count the `db.prepare` calls whose SQL matches `pattern` while `fn` runs (the query-count assertions).
 * Match `FROM bank_transactions` to count only row LOADS, never the reconciled/category persists.
 */
export async function countPrepares(db: Db, pattern: RegExp, fn: () => Promise<void>): Promise<number> {
  return (await capturePrepares(db, pattern, fn)).length
}
