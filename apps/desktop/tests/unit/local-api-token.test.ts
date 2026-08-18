import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import {
  getOrCreateToken,
  maskToken,
  readToken,
  rotateToken
} from '../../src/main/services/local-api/token'

// Local-API access-key store (local-api P2): main-process-only single-row table in the
// workspace DB (encrypted at rest on an encrypted workspace; unreadable pre-unlock — D7).
// The renderer only ever sees maskToken's output.

function freshDb(): { db: Db; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'hilbertraum-lapi-token-')), 'test.sqlite')
  const db = openDatabase(path)
  seedSettings(db)
  return { db, path }
}

describe('local-api token store', () => {
  it('starts empty; getOrCreateToken mints once and is stable across calls', () => {
    const { db } = freshDb()
    expect(readToken(db)).toBeNull()
    const first = getOrCreateToken(db)
    expect(first).toMatch(/^hr-[A-Za-z0-9_-]{43}$/) // hr- + 32 bytes base64url
    expect(getOrCreateToken(db)).toBe(first)
    expect(readToken(db)).toBe(first)
  })

  it('persists across a DB re-open (the store survives lock/unlock cycles)', () => {
    const { db, path } = freshDb()
    const token = getOrCreateToken(db)
    db.close()
    const reopened = openDatabase(path)
    expect(readToken(reopened)).toBe(token)
  })

  it('rotateToken replaces the key immediately (single row by constraint)', () => {
    const { db } = freshDb()
    const first = getOrCreateToken(db)
    const second = rotateToken(db)
    expect(second).not.toBe(first)
    expect(second).toMatch(/^hr-[A-Za-z0-9_-]{43}$/)
    expect(readToken(db)).toBe(second)
    // Exactly one row can ever exist.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM local_api_token').get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('maskToken shows only the prefix and the last 4 chars; malformed values mask fully', () => {
    const { db } = freshDb()
    const token = getOrCreateToken(db)
    const masked = maskToken(token)
    expect(masked).toBe(`hr-…${token.slice(-4)}`)
    expect(masked.length).toBeLessThan(10)
    // The masked form can never reconstruct the key (43 secret chars, 4 shown).
    expect(token).not.toContain(masked)
    // A tampered/short row must never "mask" into full disclosure (review 2026-08-18).
    expect(maskToken('hr-abc')).toBe('hr-…')
    expect(maskToken('short')).toBe('hr-…')
  })

  it('re-mints over a tampered/malformed stored row instead of serving it as a credential', () => {
    const { db } = freshDb()
    db.prepare(
      `INSERT INTO local_api_token (id, token, updated_at) VALUES (1, '', '2026-01-01T00:00:00Z')`
    ).run()
    const token = getOrCreateToken(db)
    expect(token).toMatch(/^hr-[A-Za-z0-9_-]{43}$/)
    expect(readToken(db)).toBe(token)
  })

  it('tokens are unique across workspaces (no shared/global secret)', () => {
    const a = getOrCreateToken(freshDb().db)
    const b = getOrCreateToken(freshDb().db)
    expect(a).not.toBe(b)
  })
})
