import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite'
import {
  LAST_WRITER_APPLIED_THROUGH,
  SCHEMA_VERSION,
  checkpointLeftoverWal,
  openDatabase,
  openDatabaseWithStamp,
  parseLastWriter,
  setStampAppVersion,
  type Db
} from '../../src/main/services/db'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { WorkspaceController, lockEncryptedVault, unlockEncryptedVault } from '../../src/main/services/workspace-vault'
import { openRawDb, tempRoot } from '../helpers/db-fixtures'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import { ENCRYPTION_REQUIRED, freshVaultPaths, lockedVault, thrownBy, unlockedController } from '../helpers/vault-fixtures'

// App-update plan T2.2, W-9, frozen contract F-10 (Appendix B). Release 1 is the oldest version ever sold on a Kit, and
// whatever it does to a workspace a later version wrote can never be fixed in the field. So on EVERY successful open it
// leaves a `schema_meta` table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`, no trigger) holding exactly one key it owns,
// `last_writer` = `<app version>;<applied_through>`, overwritten whole; later versions read it to learn that an older one
// touched the file. The stamp is best effort and runs after the refusal check and the migrations: a refused file is
// never stamped, and a stamp that cannot be written never fails the open. It never deletes a key or table it does not
// know, never writes a second key and never sets `application_id`. The old reader's side (v0.1.60 opens a stamped
// database): reader-snapshots.test.ts (N9); the changed "a second open is a no-op" row: db-user-version.test.ts (N4);
// "no read-write connection without `defensive`": repo-hygiene.test.ts (N12). Rows are named after the T2.2 sheet.

/** The app version `main/index.ts` hands the stamp (`app.getVersion()` reads this file), independent of the code under test. */
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as { version: string }).version
/** What release 1 writes into `last_writer` (F-10): the version, one `;`, then the applied-through token. */
const STAMP = `${PACKAGE_VERSION};${LAST_WRITER_APPLIED_THROUGH}`
/** A quoted text a planted trigger aborts with: the failure code must not carry it (`failureCode`, never `err.message`). */
const SECRET = "it's the quoted text of a planted trigger"

beforeEach(() => setStampAppVersion(PACKAGE_VERSION))
afterEach(() => setStampAppVersion(''))

function freshPath(label: string): string {
  return join(tempRoot(label), 'workspace.sqlite')
}

/** Run `sql` on a raw handle (no migrations, no stamp), the way another build wrote the file. */
function rawExec(path: string, sql: string): void {
  const raw = openRawDb(path)
  try {
    raw.exec(sql)
  } finally {
    raw.close()
  }
}

/** Read the file through a READ-ONLY raw handle: the check can neither create the file nor write to it. */
function readOnly<T>(path: string, read: (db: DatabaseSync) => T): T {
  const raw = openRawDb(path, { readOnly: true })
  try {
    return read(raw)
  } finally {
    raw.close()
  }
}

/** Every `schema_meta` row, by key. */
function metaRows(db: Db | DatabaseSync): Array<{ key: string; value: string }> {
  return db.prepare('SELECT key, value FROM schema_meta ORDER BY key').all() as Array<{ key: string; value: string }>
}

/** The objects named `name` in the file's schema. */
function schemaObjects(db: Db | DatabaseSync, name: string): Array<{ type: string }> {
  return db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').all(name) as Array<{ type: string }>
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('schema_meta and the last_writer stamp (app-update T2.2, F-10)', () => {
  it('N1: a fresh open leaves schema_meta in exactly the frozen shape, no trigger, one row: last_writer; so does a create', () => {
    const p = freshPath('schema-meta-n1')
    openDatabase(p).close()
    readOnly(p, (db) => {
      expect(
        db.prepare("SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo('schema_meta') ORDER BY cid").all()
      ).toEqual([
        { name: 'key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
        { name: 'value', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 }
      ])
      // A plain rowid table, not STRICT, not WITHOUT ROWID; its only index is the primary key's own.
      expect(db.prepare("SELECT type, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = 'schema_meta'").all()).toEqual([
        { type: 'table', ncol: 2, wr: 0, strict: 0 }
      ])
      expect(db.prepare("SELECT name, \"unique\", origin, partial FROM pragma_index_list('schema_meta')").all()).toEqual([
        { name: 'sqlite_autoindex_schema_meta_1', unique: 1, origin: 'pk', partial: 0 }
      ])
      // One `CREATE TABLE` text, so a fresh and a migrated database hold the same (the all-paths test, T10.7).
      expect(db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'schema_meta'").get()).toEqual({
        sql: 'CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)'
      })
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'schema_meta'").all()).toEqual([])
      expect(metaRows(db).map((r) => r.key)).toEqual(['last_writer'])
    })

    // A1: the first `.enc` of a new workspace carries it (a controller create, read on the unlocked new vault).
    const vp = freshVaultPaths('schema-meta-n1-create')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.create('pw', 'encrypted')
    expect(metaRows(ctl.requireDb())).toEqual([{ key: 'last_writer', value: STAMP }])

    // A5: the other read-write connection, the lock's WAL retry and the start's salvage, writes only what a checkpoint
    // writes: a leftover WAL passed through it gets no schema_meta.
    const w = freshPath('schema-meta-n1-checkpoint')
    const holder = openRawDb(w)
    try {
      holder.exec('PRAGMA journal_mode = WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);')
      expect(checkpointLeftoverWal(w)).toMatchObject({ outcome: 'checkpointed' })
    } finally {
      holder.close()
    }
    expect(readOnly(w, (db) => schemaObjects(db, 'schema_meta'))).toEqual([])
  })

  it('N2: the stamp is `<package.json version>;<LAST_WRITER_APPLIED_THROUGH>`, also at the plaintext start; with no version set, no stamp', () => {
    // The applied-through token (P10 replaces its value): non-empty printable ASCII, no space, no `;`.
    expect(LAST_WRITER_APPLIED_THROUGH).toMatch(/^[\x21-\x3a\x3c-\x7e]+$/)
    const { db, stamp } = openDatabaseWithStamp(freshPath('schema-meta-n2'))
    try {
      expect(stamp).toEqual({ written: true, previous: null })
      expect(metaRows(db)).toEqual([{ key: 'last_writer', value: STAMP }])
      expect(parseLastWriter(metaRows(db)[0]!.value)).toEqual({ appVersion: PACKAGE_VERSION, appliedThrough: LAST_WRITER_APPLIED_THROUGH })
    } finally {
      db.close()
    }

    // A3: the plaintext open `init()` runs at the start (main/index.ts sets the version before it).
    const ctl = new WorkspaceController(freshVaultPaths('schema-meta-n2-plaintext'), DEFAULT_POLICY, true)
    ctl.init()
    expect(ctl.getState().mode).toBe('plaintext_dev')
    expect(metaRows(ctl.requireDb())).toEqual([{ key: 'last_writer', value: STAMP }])

    // No version set (the setter was never called): no stamp at all, and the open says so. Never a made-up version.
    setStampAppVersion('')
    const codes: string[] = []
    const p = freshPath('schema-meta-n2-unset')
    const unset = openDatabaseWithStamp(p, { onStampFailed: (code) => codes.push(code) })
    try {
      expect(unset.stamp).toEqual({ written: false, previous: null, code: 'no-app-version' })
      expect(codes).toEqual(['no-app-version'])
      expect(schemaObjects(unset.db, 'schema_meta')).toEqual([])
    } finally {
      unset.db.close()
    }
  })

  it("N3: a later build's richer last_writer is overwritten whole by one open, and the open hands back the value it found", () => {
    const p = freshPath('schema-meta-n3')
    openDatabase(p).close()
    rawExec(p, "UPDATE schema_meta SET value = '9.9.9;later;extra' WHERE key = 'last_writer'")
    const { db, stamp } = openDatabaseWithStamp(p)
    try {
      expect(stamp).toEqual({ written: true, previous: '9.9.9;later;extra' })
      expect(metaRows(db)).toEqual([{ key: 'last_writer', value: STAMP }])
    } finally {
      db.close()
    }
  })

  it('N5: a key and a table this build does not know survive two opens, value for value', () => {
    const p = freshPath('schema-meta-n5')
    openDatabase(p).close()
    rawExec(
      p,
      "INSERT INTO schema_meta (key, value) VALUES ('future_key', 'kept;as;written');" +
        'CREATE TABLE schema_meta_steps (step TEXT PRIMARY KEY, applied_at TEXT NOT NULL);' +
        "INSERT INTO schema_meta_steps (step, applied_at) VALUES ('later-step-1', '2027-01-01T00:00:00Z');"
    )
    openDatabase(p).close()
    openDatabase(p).close()
    readOnly(p, (db) => {
      expect(metaRows(db)).toEqual([
        { key: 'future_key', value: 'kept;as;written' },
        { key: 'last_writer', value: STAMP }
      ])
      expect(db.prepare('SELECT step, applied_at FROM schema_meta_steps').all()).toEqual([
        { step: 'later-step-1', applied_at: '2027-01-01T00:00:00Z' }
      ])
    })
  })

  it("N6: a newer file that already holds schema_meta is refused unstamped: same bytes, the foreign last_writer kept, no sidecar", () => {
    const p = freshPath('schema-meta-n6')
    openDatabase(p).close()
    rawExec(p, `UPDATE schema_meta SET value = '7.0.0;foreign' WHERE key = 'last_writer'; PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
    const before = sha(p)
    expect(thrownBy(() => openDatabase(p)).name).toBe('WorkspaceNewerError')
    expect(sha(p)).toBe(before)
    expect(existsSync(`${p}-wal`)).toBe(false)
    expect(existsSync(`${p}-shm`)).toBe(false)
    expect(readOnly(p, metaRows)).toEqual([{ key: 'last_writer', value: '7.0.0;foreign' }])
  })

  // N7: W-9's "best effort": a later shape change, a foreign object under the name or a full drive must never stop
  // release 1 from opening the workspace. Each case blocks the stamp differently; none may fail the open, leave a
  // transaction open, or put SQLite's message (which quotes the planted text and names objects) into the log's code.
  const blockedStamps: Array<[string, (path: string) => void]> = [
    [
      '(a) a planted trigger on schema_meta aborts with a quoted text',
      (p) => {
        openDatabase(p).close()
        rawExec(p, `CREATE TRIGGER block_stamp BEFORE INSERT ON schema_meta BEGIN SELECT RAISE(ABORT, '${SECRET.replace(/'/g, "''")}'); END;`)
      }
    ],
    ['(b) a view named schema_meta', (p) => rawExec(p, "CREATE VIEW schema_meta AS SELECT 'last_writer' AS key, '1.0.0;view' AS value;")],
    ['(c) an index named schema_meta', (p) => rawExec(p, 'CREATE TABLE planted (a TEXT); CREATE INDEX schema_meta ON planted (a);')],
    ['(d) a schema_meta table without a value column', (p) => rawExec(p, 'CREATE TABLE schema_meta (key TEXT PRIMARY KEY, note TEXT);')]
  ]

  it.each(blockedStamps)('N7: a stamp that cannot be written never fails the open: %s', (_case, plant) => {
    const p = freshPath('schema-meta-n7')
    plant(p)
    const codes: string[] = []
    const { db, stamp } = openDatabaseWithStamp(p, { onStampFailed: (code) => codes.push(code) })
    try {
      expect(codes).toHaveLength(1)
      expect(stamp).toMatchObject({ written: false, code: codes[0] })
      // SQLite's result code and its fixed description (`failureCode`), never `err.message`.
      expect(codes[0]).toMatch(/^sqlite \d+: [A-Za-z ]+$/)
      expect(codes[0]).not.toContain('quoted text')
      expect(codes[0]).not.toContain('schema_meta')
      expect(db.isTransaction).toBe(false)
      db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('n7', '1', 'now')").run()
      expect(db.prepare("SELECT value_json FROM settings WHERE key = 'n7'").get()).toEqual({ value_json: '1' })
    } finally {
      db.close()
    }
  })

  it('N7: through the unlock, a blocked stamp leaves the unlock to succeed and one content-free note for the log (A2, #844)', () => {
    const vp = lockedVault('schema-meta-n7-unlock', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    db.exec(`CREATE TRIGGER block_stamp BEFORE INSERT ON schema_meta BEGIN SELECT RAISE(ABORT, '${SECRET.replace(/'/g, "''")}'); END;`)
    lockEncryptedVault(vp, db, key)
    // Not `VaultOpenFailedError` (#844's "an upgrade step could not finish"): the stamp never reaches `openFailure`.
    const ctl = unlockedController(vp, 'pw')
    expect(ctl.isUnlocked()).toBe(true)
    const notes = ctl.takeStampFailures()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^sqlite \d+: [A-Za-z ]+$/)
    expect(notes[0]).not.toContain('quoted text')
    expect(ctl.takeStampFailures()).toEqual([]) // handed out once
  })

  it('N8: application_id stays 0, after a fresh open and after the open of a file written before the stamp existed', () => {
    const p = freshPath('schema-meta-n8')
    openDatabase(p).close()
    expect(readOnly(p, (db) => db.prepare('PRAGMA application_id').get())).toEqual({ application_id: 0 })
    // As a build before release 1 left it: `user_version` 0 and no schema_meta.
    rawExec(p, 'DROP TABLE schema_meta; PRAGMA user_version = 0;')
    openDatabase(p).close()
    readOnly(p, (db) => {
      expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
      expect(metaRows(db)).toEqual([{ key: 'last_writer', value: STAMP }])
    })
  })
})

describe('reading a last_writer value (app-update T2.2, F-10: split at the first `;`, unparseable is never an error)', () => {
  it.each([
    ["a stamp as release 1 writes it", '0.1.66;interim', { appVersion: '0.1.66', appliedThrough: 'interim' }],
    ["a later writer's richer value: split at the FIRST `;`", '9.9.9;later;extra', { appVersion: '9.9.9', appliedThrough: 'later;extra' }],
    ['a value of exactly 256 characters', `1.0.0;${'a'.repeat(250)}`, { appVersion: '1.0.0', appliedThrough: 'a'.repeat(250) }]
  ])('N10: %s reads', (_case, value, expected) => {
    expect(parseLastWriter(value)).toEqual(expected)
  })

  it.each([
    ['no value (no table, no row)', null],
    ['an empty value', ''],
    ['a value without `;`', '0.1.66'],
    ['an empty version', ';interim'],
    ['an empty rest', '0.1.66;'],
    ['a value of 257 characters', `1.0.0;${'a'.repeat(251)}`],
    ['non-ASCII text', '0.1.66;über'],
    ['a control character', '0.1.66;interim\nforged line'],
    ['a space', '0.1.66 beta;interim'],
    ['a value that is not text', 42]
  ])('N10: %s is unreadable, never an error', (_case, value) => {
    expect(parseLastWriter(value)).toBe('unreadable')
  })

  it('N10: an absent table and an absent row reach the reader as no value, through the open, and read as unreadable', () => {
    const absentTable = openDatabaseWithStamp(freshPath('schema-meta-n10-table'))
    absentTable.db.close()
    expect(absentTable.stamp).toMatchObject({ previous: null })
    expect(parseLastWriter(absentTable.stamp.previous)).toBe('unreadable')

    const p = freshPath('schema-meta-n10-row')
    openDatabase(p).close()
    rawExec(p, "DELETE FROM schema_meta WHERE key = 'last_writer'")
    const absentRow = openDatabaseWithStamp(p)
    absentRow.db.close()
    expect(absentRow.stamp).toMatchObject({ previous: null })
    expect(parseLastWriter(absentRow.stamp.previous)).toBe('unreadable')
  })
})

describe('the read-write connection is defensive (app-update T2.2, Δ-40, spike 7)', () => {
  // node:sqlite's `defensive` default depends on the runtime: on in the packaged app (Node 24.22.1), off under vitest on
  // Node 24.13.0, absent (silently ignored) on Node 22.21.1. The open passes it explicitly, so tests meet a step that
  // writes a shadow table, `sqlite_schema` or `writable_schema` where the app would. The probe decides what this runtime
  // can show: on a runtime that ignores the option, the row asserts only that the open still works with it.
  it('N11: an openDatabase handle refuses a direct FTS5 shadow-table write where node:sqlite honours the option; elsewhere the open works', () => {
    const probe = freshPath('schema-meta-n11-probe')
    rawExec(probe, 'CREATE VIRTUAL TABLE probe_fts USING fts5(t);')
    const shadowWrite = (options: DatabaseSyncOptions, k: string): string => {
      const raw = openRawDb(probe, options)
      try {
        raw.exec(`INSERT INTO probe_fts_config (k, v) VALUES ('${k}', 1);`)
        return 'allowed'
      } catch (err) {
        return (err as Error).message
      } finally {
        raw.close()
      }
    }
    // The control: the write itself is valid SQL that goes through, so a refusal below is defensive mode's.
    expect(shadowWrite({ defensive: false }, 'n11-off')).toBe('allowed')
    const honoured = /may not be modified/.test(shadowWrite({ defensive: true }, 'n11-on'))
    // Every Node 24 node:sqlite measured honours it (spike 7): there the row must not go vacuous.
    if (Number(process.versions.node.split('.')[0]) >= 24) expect(honoured).toBe(true)

    const db = openDatabase(freshPath('schema-meta-n11'))
    try {
      const write = (): void => db.exec("INSERT INTO chunks_fts_config (k, v) VALUES ('n11', 1);")
      if (honoured) expect(write).toThrow(/may not be modified/)
      else expect(write).not.toThrow()
    } finally {
      db.close()
    }
  })
})
