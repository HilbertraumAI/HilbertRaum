import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  LAST_WRITER_APPLIED_THROUGH,
  openDatabase,
  SCHEMA_VERSION,
  setStampAppVersion,
  WorkspaceNewerError
} from '../../src/main/services/db'
import { openRawDb, tempRoot } from '../helpers/db-fixtures'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// #247 (owner decision #225 — "ratify"): the workspace database carries `PRAGMA user_version`
// = SCHEMA_VERSION so an OLDER build refuses a NEWER workspace instead of opening it and
// degrading silently (a stamp read BEFORE any write, so a refused file is byte-identical).
// Before this: `applyPragmasAndMigrations` never read or wrote `user_version`, every DB sat at
// 0 forever, and a build could not tell it had opened a database written by a newer schema.
// Builds ≤ 0.1.59 ignore the stamp — the guard protects only pairs where the OLDER build is
// newer than this change.
//
// App-update T2.2 (F-10): every open also upserts the `last_writer` row of `schema_meta` (db-schema-meta.test.ts). The
// rows here open with the app version set, as the app does, so the refused file's byte identity below holds with the
// stamp in place (the refusal comes before it), and "a second open" is a write of the stamp, never of `user_version`.
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as { version: string }).version
beforeEach(() => setStampAppVersion(PACKAGE_VERSION))
afterEach(() => setStampAppVersion(''))

function freshPath(): string {
  return join(tempRoot('user-version'), 'workspace.sqlite')
}

/** Run `sql` on a raw handle (no migrations), the way an older or a newer build wrote the file. */
function rawExec(path: string, sql: string): void {
  const raw = openRawDb(path)
  try {
    raw.exec(sql)
  } finally {
    raw.close()
  }
}

/** The file's stamp, read through a READ-ONLY handle: the check can neither create the file nor write to it. */
function readVersion(path: string): number {
  const raw = openRawDb(path, { readOnly: true })
  try {
    return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    raw.close()
  }
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('PRAGMA user_version (#247)', () => {
  it('a fresh database is migrated and stamped with SCHEMA_VERSION', () => {
    // A positive integer, or "stamped with SCHEMA_VERSION" would hold for a file never stamped.
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    const p = freshPath()
    const db = openDatabase(p)
    db.close()
    expect(readVersion(p)).toBe(SCHEMA_VERSION)
  })

  it('an existing pre-stamp database (version 0) upgrades in place; every later open writes the stamp again, never user_version', () => {
    const p = freshPath()
    openDatabase(p).close()
    // Every database written before this change: stamp 0, and (as an older build left it)
    // missing a column a later migration adds.
    rawExec(p, 'ALTER TABLE documents DROP COLUMN ocr_meta_json; PRAGMA user_version = 0;')
    const db = openDatabase(p)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    // The migrations ran on the version-0 file — the schema is complete again (an additive
    // column from `ensureColumn`).
    expect(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('documents') WHERE name = 'ocr_meta_json'").get()).toEqual({ n: 1 })
    db.close()
    expect(readVersion(p)).toBe(SCHEMA_VERSION)
    // App-update T2.2 (F-10, row N4; was "a second open is a no-op"): every open upserts `last_writer`, so a second open
    // at the current version is a write: another value planted between the two opens is replaced. What stays true is
    // that `user_version` is written only when moving up: the database header (page 1's first 100 bytes, which hold it;
    // writing page 1 moves its change counter) is byte-identical across that open, whose one write is the stamp's row.
    // The whole file's hash cannot say it any more: a stamp of the same value leaves the file unchanged (measured), so
    // the old hash check would stay green whether or not this open wrote.
    rawExec(p, "UPDATE schema_meta SET value = '0.0.1;planted' WHERE key = 'last_writer'")
    const header = readFileSync(p).subarray(0, 100)
    const again = openDatabase(p)
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(again.prepare("SELECT value FROM schema_meta WHERE key = 'last_writer'").get()).toEqual({
      value: `${PACKAGE_VERSION};${LAST_WRITER_APPLIED_THROUGH}`
    })
    again.close()
    expect(readFileSync(p).subarray(0, 100).equals(header)).toBe(true)
    // T2.2 fix round (review 2, minor): what the old hash held still holds where it can. A same-version open of the
    // up-to-date file whose stamp already holds this build's value changes no byte at all: the migrations write nothing,
    // and SQLite stores an unchanged value without writing a page (measured, T2.2 S1).
    const settled = sha(p)
    openDatabase(p).close()
    expect(sha(p)).toBe(settled)
  })

  it('a database stamped by a NEWER build is refused with WorkspaceNewerError — closed, no writes', () => {
    const p = freshPath()
    openDatabase(p).close()
    rawExec(p, `PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
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
    rawExec(p, `PRAGMA user_version = ${SCHEMA_VERSION + 1000};`)
    expect(() => openDatabase(p)).toThrow(WorkspaceNewerError)
  })
})
