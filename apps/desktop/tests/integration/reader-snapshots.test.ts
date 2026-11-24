import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Db } from '../../src/main/services/db'
import { seedSettings, updateSettings } from '../../src/main/services/settings'
import { freshWorkspaceDb, listTables } from '../helpers/db-fixtures'

// W-53 (app-update plan T2.8): an "old reader" row runs the released code itself, not today's code under another name.
// Each snapshot under tests/fixtures/readers/<tag>/ is the tag's own module, bundled from the tag's sources by
// scripts/release/snapshot-readers.mjs (provenance in `<name>.provenance.json` beside it; the bytes are locked by
// tests/fixtures/golden-fixtures.sha256). It runs on this process's Node and node:sqlite, not on the tag's Electron.
//
// v0.1.60 is the first release whose `openDatabase` reads the schema stamp: a `user_version` above its SCHEMA_VERSION
// (1) is refused as written by a newer build. So it is an old reader every later schema change must keep opening (the
// later-writer duties, app-update plan F-27, with #985's schema rule). T2.2 adds the stamped-database row.

/** The part of v0.1.60's `db.ts` the rows use (the snapshot is plain CommonJS: the type is declared here). */
interface ReaderV0160 {
  SCHEMA_VERSION: number
  openDatabase(path: string): Db
  listTables(db: Db): string[]
}

/** Loads a committed snapshot through Node's own require, so the tag's code runs as built, outside vitest's transform. */
function readerSnapshot<T>(tag: string, file: string): T {
  return createRequire(__filename)(join(__dirname, '..', 'fixtures', 'readers', tag, file)) as T
}

describe('reader snapshots: released readers open what HEAD writes (W-53)', () => {
  it("v0.1.60's openDatabase opens a database HEAD created and reads HEAD's rows", () => {
    const v0160 = readerSnapshot<ReaderV0160>('v0.1.60', 'open-database.cjs')
    // 1 at v0.1.60 (and at HEAD today, so this line does not tell the two apart: that the file is v0.1.60's own code is
    // the manifest's lock and its provenance).
    expect(v0160.SCHEMA_VERSION).toBe(1)
    // HEAD's create path for a workspace database (what WorkspaceController's create and plaintext open run).
    const { db, root } = freshWorkspaceDb('reader-snapshots')
    seedSettings(db)
    updateSettings(db, { contextTokens: 8192 })
    const headTables = listTables(db)
    db.close()

    const old = v0160.openDatabase(join(root, 'test.sqlite'))
    try {
      expect(v0160.listTables(old)).toEqual(headTables) // the old open neither drops nor adds a table
      const row = old.prepare("SELECT value_json FROM settings WHERE key = 'contextTokens'").get() as { value_json: string }
      expect(JSON.parse(row.value_json)).toBe(8192)
      expect(old.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    } finally {
      old.close()
    }
  })

  // T2.8 review R-5: v0.1.60's open runs its whole schema and its column list on the file. Reading is not enough: an
  // index or column HEAD dropped and the old open put back, a changed stamp, or a rewritten row would be a release that
  // changes a newer workspace just by opening it. So the schema, the stamp and the rows must read the same through the
  // old open, and the file must not change by one byte.
  it("v0.1.60's openDatabase leaves HEAD's database as HEAD made it: same schema, stamp and rows, not one byte written", () => {
    const v0160 = readerSnapshot<ReaderV0160>('v0.1.60', 'open-database.cjs')
    const { db, root } = freshWorkspaceDb('reader-snapshots-unchanged')
    seedSettings(db)
    updateSettings(db, { contextTokens: 8192 })
    const state = (d: Db): unknown => ({
      schema: d.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
      stamp: d.prepare('PRAGMA user_version').get(),
      settings: d.prepare('SELECT key, value_json, updated_at FROM settings ORDER BY key').all()
    })
    const made = state(db)
    db.close()
    const path = join(root, 'test.sqlite')
    const bytes = readFileSync(path)

    const old = v0160.openDatabase(path)
    try {
      expect(state(old)).toEqual(made)
      expect(old.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    } finally {
      old.close()
    }
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })
})
