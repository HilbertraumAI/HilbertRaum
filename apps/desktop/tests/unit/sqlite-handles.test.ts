import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/services/db'
import {
  closeTrackedHandles,
  installSqliteHandleTracking,
  nodeSqlite,
  trackedHandles,
  type SqliteModuleLike
} from '../helpers/sqlite-handles'

// Issue #460: the harness closes the sqlite handles a test file leaves open, before its temp roots
// are removed (tests/helpers/sqlite-handles.ts, tests/setup-temp-roots.ts). Before it, ~1,500 roots
// per windows run could not be removed by the per-file teardown and went to the post-run sweep.

/** A stand-in for `node:sqlite`'s class: throws like a non-database file, and like a double close. */
class FakeDb {
  open = true
  constructor(readonly path: string) {
    if (path === 'not-a-database') throw new Error('file is not a database')
  }
  close(): void {
    if (!this.open) throw Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' })
    this.open = false
  }
}

const fakeModule = (): SqliteModuleLike => ({ DatabaseSync: FakeDb })
const construct = (mod: SqliteModuleLike, path: string): FakeDb => new mod.DatabaseSync(path) as FakeDb

describe('sqlite handles: the patched class records what it constructs', () => {
  it('records every instance, which is still an instance of the real class under its real name', () => {
    const mod = fakeModule()
    expect(installSqliteHandleTracking(mod)).toBe(true)
    const a = construct(mod, 'a')
    const b = construct(mod, 'b')
    expect(a).toBeInstanceOf(FakeDb)
    expect(a.path).toBe('a')
    expect(mod.DatabaseSync.name).toBe('FakeDb')
    expect(trackedHandles(mod)).toHaveLength(2)
    expect(trackedHandles(mod)[0]).toBe(a)
    expect(trackedHandles(mod)[1]).toBe(b)
  })

  it('a constructor that throws records nothing (openDatabase closes that handle itself, #208)', () => {
    const mod = fakeModule()
    installSqliteHandleTracking(mod)
    expect(() => construct(mod, 'not-a-database')).toThrow('file is not a database')
    expect(trackedHandles(mod)).toEqual([])
  })

  it('installing twice patches once — no double wrap, no double record', () => {
    const mod = fakeModule()
    installSqliteHandleTracking(mod)
    const patched = mod.DatabaseSync
    expect(installSqliteHandleTracking(mod)).toBe(false)
    expect(mod.DatabaseSync).toBe(patched)
    construct(mod, 'a')
    expect(trackedHandles(mod)).toHaveLength(1)
  })
})

describe('sqlite handles: closing never fails a suite', () => {
  it('closes the open handles, counts the ones the suite already closed, and empties the registry', () => {
    const mod = fakeModule()
    installSqliteHandleTracking(mod)
    const leftOpen = construct(mod, 'left-open')
    const closedBySuite = construct(mod, 'closed-by-suite')
    closedBySuite.close()

    expect(closeTrackedHandles(mod)).toEqual({ closed: 1, alreadyClosed: 1 })
    expect(leftOpen.open).toBe(false)
    expect(trackedHandles(mod)).toEqual([])
    // A second teardown finds nothing to do.
    expect(closeTrackedHandles(mod)).toEqual({ closed: 0, alreadyClosed: 0 })
  })

  it('a module that was never patched: nothing tracked, closing is a no-op', () => {
    const mod = fakeModule()
    expect(trackedHandles(mod)).toEqual([])
    expect(closeTrackedHandles(mod)).toEqual({ closed: 0, alreadyClosed: 0 })
  })
})

// ORDER GUARD. This DB stays open for the whole file and this file's own `afterAll` uses it. The
// harness's teardown closes every tracked handle, so it must run AFTER this hook — which holds only
// while vitest's `sequence.hooks` is 'stack' (after-hooks in reverse registration order; the setup
// file registers first). If that ever changes, this hook throws "database is not open" and fails.
const leftOpenForTheHarness = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-sqlite-handles-order-')), 'test.sqlite'))
afterAll(() => {
  expect(leftOpenForTheHarness.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 })
})

describe('sqlite handles: the harness tracks real node:sqlite handles (tests/setup-temp-roots.ts)', () => {
  it('a DB opened through openDatabase — the production seam — is tracked', () => {
    const sqlite = nodeSqlite()
    expect(sqlite).not.toBeNull()
    expect(trackedHandles(sqlite!)).toContain(leftOpenForTheHarness)

    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-sqlite-handles-seam-')), 'test.sqlite'))
    expect(trackedHandles(sqlite!)).toContain(db)
    db.close()
  })

  it('loading the module leaves process.emitWarning exactly as it found it', () => {
    // The load swallows Node's one-time SQLite ExperimentalWarning; a wrapper left behind would
    // silently swallow warnings for the rest of the fork.
    const before = process.emitWarning
    expect(nodeSqlite()).not.toBeNull()
    expect(process.emitWarning).toBe(before)
  })

  it('closing a tracked real handle releases its root — the property the teardown depends on', () => {
    // A registry of its own, layered on the harness's patched class, so this closes only its own
    // handle and not the order guard's. The harness still records the handle and later finds it closed.
    const scoped: SqliteModuleLike = { DatabaseSync: nodeSqlite()!.DatabaseSync }
    installSqliteHandleTracking(scoped)
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-sqlite-handles-rm-'))
    const db = new scoped.DatabaseSync(join(root, 'test.sqlite')) as unknown as { exec(sql: string): void }
    // WAL mode leaves -wal/-shm sidecars open next to the file, as openDatabase does.
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);')

    expect(closeTrackedHandles(scoped)).toEqual({ closed: 1, alreadyClosed: 0 })
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })
})
