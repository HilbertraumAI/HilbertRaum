import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, SCHEMA_VERSION, WorkspaceNewerError } from '../../src/main/services/db'

// #247 (owner decision #225 — "ratify"): the workspace database carries `PRAGMA user_version`
// = SCHEMA_VERSION so an OLDER build refuses a NEWER workspace instead of opening it and
// degrading silently (a stamp read BEFORE any write, so a refused file is byte-identical).
// Before this: `applyPragmasAndMigrations` never read or wrote `user_version`, every DB sat at
// 0 forever, and a build could not tell it had opened a database written by a newer schema.
// Builds ≤ 0.1.59 ignore the stamp — the guard protects only pairs where the OLDER build is
// newer than this change.

// The raw driver, bypassing `openDatabase`, so a test can stamp a file the way a NEWER build
// would have (db.ts itself resolves `node:sqlite` the same way).
const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as typeof import('node:sqlite')

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'hilbertraum-user-version-')), 'workspace.sqlite')
}

function stamp(path: string, version: number): void {
  const raw = new DatabaseSync(path)
  raw.exec(`PRAGMA user_version = ${version};`)
  raw.close()
}

function readVersion(path: string): number {
  const raw = new DatabaseSync(path, { readOnly: true })
  const row = raw.prepare('PRAGMA user_version').get() as { user_version: number }
  raw.close()
  return row.user_version
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('PRAGMA user_version (#247)', () => {
  it('SCHEMA_VERSION is a positive integer', () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('a fresh database is migrated and stamped with SCHEMA_VERSION', () => {
    const p = freshPath()
    const db = openDatabase(p)
    db.close()
    expect(readVersion(p)).toBe(SCHEMA_VERSION)
  })

  it('an existing pre-stamp database (version 0) upgrades in place; a second open is a no-op', () => {
    const p = freshPath()
    openDatabase(p).close()
    stamp(p, 0) // every database written before this change
    const db = openDatabase(p)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    // The migrations still ran — the schema is complete (an additive column from `ensureColumn`).
    expect(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('documents') WHERE name = 'ocr_meta_json'").get()).toEqual({ n: 1 })
    db.close()
    expect(readVersion(p)).toBe(SCHEMA_VERSION)
    // A second open at the current version writes NOTHING: an unconditional stamp would
    // rewrite page 1 (the change counter moves) and this hash would differ.
    const before = sha(p)
    const again = openDatabase(p)
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    again.close()
    expect(sha(p)).toBe(before)
  })

  it('a database stamped by a NEWER build is refused with WorkspaceNewerError — closed, no writes', () => {
    const p = freshPath()
    openDatabase(p).close()
    stamp(p, SCHEMA_VERSION + 1)
    const before = sha(p)
    let caught: unknown
    try {
      openDatabase(p)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorkspaceNewerError)
    expect((caught as WorkspaceNewerError).name).toBe('WorkspaceNewerError')
    expect((caught as WorkspaceNewerError).found).toBe(SCHEMA_VERSION + 1)
    expect((caught as WorkspaceNewerError).supported).toBe(SCHEMA_VERSION)
    // No write reached the file (the stamp is read before the first PRAGMA that writes) and
    // no sidecar is left behind (a WAL-mode file opens `-wal`/`-shm` transiently for the read;
    // the close removes them).
    expect(sha(p)).toBe(before)
    expect(existsSync(`${p}-wal`)).toBe(false)
    expect(existsSync(`${p}-shm`)).toBe(false)
    // The handle is closed: on Windows an open handle would make the unlink fail (EPERM).
    rmSync(p)
    expect(existsSync(p)).toBe(false)
  })

  it('a far-future stamp is refused the same way (the check is >, not ===)', () => {
    const p = freshPath()
    stamp(p, SCHEMA_VERSION + 1000)
    expect(() => openDatabase(p)).toThrow(WorkspaceNewerError)
  })
})
