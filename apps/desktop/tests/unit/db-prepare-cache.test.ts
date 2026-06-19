import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, prepareCached } from '../../src/main/services/db'

// DB-5 (perf audit 2026-06-18, Wave P5): node:sqlite re-parses+re-plans on every db.prepare(),
// so the hot per-turn read/write paths route their STATIC SQL through prepareCached, which
// compiles each distinct SQL string once per connection and reuses the StatementSync.

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-prepcache-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

describe('prepareCached (DB-5)', () => {
  it('returns the SAME statement object for repeated identical SQL on one Db', () => {
    const db = freshDb()
    const sql = 'SELECT * FROM conversations WHERE id = ?'
    const a = prepareCached(db, sql)
    const b = prepareCached(db, sql)
    expect(b).toBe(a)
  })

  it('returns DISTINCT statements for different SQL', () => {
    const db = freshDb()
    const a = prepareCached(db, 'SELECT * FROM conversations WHERE id = ?')
    const b = prepareCached(db, 'SELECT * FROM messages WHERE id = ?')
    expect(b).not.toBe(a)
  })

  it('keeps caches isolated per Db connection', () => {
    const db1 = freshDb()
    const db2 = freshDb()
    const sql = 'SELECT * FROM conversations WHERE id = ?'
    expect(prepareCached(db1, sql)).not.toBe(prepareCached(db2, sql))
  })

  it('a reused statement returns correct, unchanged results across calls', () => {
    const db = freshDb()
    const now = new Date().toISOString()
    const insert = prepareCached(
      db,
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    insert.run('c1', 'First', now, now)
    insert.run('c2', 'Second', now, now)

    const select = prepareCached(db, 'SELECT title FROM conversations WHERE id = ?')
    // Same cached object, re-bound and re-run with different params each time.
    expect((select.get('c1') as { title: string }).title).toBe('First')
    expect((select.get('c2') as { title: string }).title).toBe('Second')
    // And the cache really did hand back the same object on a later lookup.
    expect(prepareCached(db, 'SELECT title FROM conversations WHERE id = ?')).toBe(select)
  })
})
