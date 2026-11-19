// `db.prepare` spies: a recorder for query-plan assertions and a call counter for query-count assertions, plus a façade
// that records the statements actually EXECUTED. Pure: no electron import, no module state.
import type { Db } from '../../src/main/services/db'

/**
 * A `Db` façade that RECORDS the SQL text of every statement it executes (`get`, `all`, `run`, `iterate` on a prepared
 * statement, and `exec`), in order. `prepareCached` keys its statement cache on the `Db` object, so the façade gets its
 * own cache and every statement, cached or not, is funnelled through here: count executions with it, never
 * `countPrepares` (a statement cached on the real handle runs without a prepare). Everything still runs against the
 * real database; the façade only observes. Moved from evidence-review-batch-ops.test.ts (`recordingDb`), and replaces
 * zim-regressions.test.ts's `documentsQueryCounter` (#898).
 */
export function recordExecutions(db: Db): { db: Db; executed: string[] } {
  const executed: string[] = []
  const wrapStatement = (sql: string, stmt: object): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (prop === 'get' || prop === 'all' || prop === 'run' || prop === 'iterate') {
          return (...args: unknown[]) => {
            executed.push(sql)
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return (value as (...a: unknown[]) => unknown).bind(target)
      }
    })
  const proxy = new Proxy(db as unknown as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (prop === 'prepare') {
        return (sql: string) => wrapStatement(sql, (value as (s: string) => object).call(target, sql))
      }
      if (prop === 'exec') {
        return (sql: string) => {
          executed.push(sql)
          return (value as (s: string) => unknown).call(target, sql)
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    }
  })
  return { db: proxy as unknown as Db, executed }
}

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
