import { describe, it, expect } from 'vitest'
import { prepareCached } from '../../src/main/services/db'
import { openFreshDb } from '../helpers/db-fixtures'

// DB-5 (perf audit 2026-06-18, Wave P5): node:sqlite re-parses+re-plans on every db.prepare(),
// so the hot per-turn read/write paths route their STATIC SQL through prepareCached, which
// compiles each distinct SQL string once per connection and reuses the StatementSync.

describe('prepareCached (DB-5)', () => {
  it('returns the SAME statement object for repeated identical SQL on one Db', () => {
    const db = openFreshDb('prepcache')
    const now = new Date().toISOString()
    const insert = prepareCached(
      db,
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    insert.run('c1', 'First', now, now)
    insert.run('c2', 'Second', now, now)

    const sql = 'SELECT title FROM conversations WHERE id = ?'
    const select = prepareCached(db, sql)
    expect(prepareCached(db, sql)).toBe(select)
    // The cached object re-binds and re-runs with different params each time.
    expect((select.get('c1') as { title: string }).title).toBe('First')
    expect((select.get('c2') as { title: string }).title).toBe('Second')
  })

  it('returns DISTINCT statements for different SQL', () => {
    const db = openFreshDb('prepcache')
    const a = prepareCached(db, 'SELECT * FROM conversations WHERE id = ?')
    const b = prepareCached(db, 'SELECT * FROM messages WHERE id = ?')
    expect(b).not.toBe(a)
  })

  it('keeps caches isolated per Db connection', () => {
    const db1 = openFreshDb('prepcache')
    const db2 = openFreshDb('prepcache')
    const sql = 'SELECT * FROM conversations WHERE id = ?'
    expect(prepareCached(db1, sql)).not.toBe(prepareCached(db2, sql))
  })
})
