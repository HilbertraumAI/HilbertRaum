import { createRequire } from 'node:module'

// Test sqlite-handle hygiene (issue #460). Measured 2026-09-13 on a full run: 120 test files leave
// 1,709 of the 2,306 `node:sqlite` handles the run constructs open until their fork exits — opened
// through `openDatabase`, a raw `new DatabaseSync`, or production code under test (the vault). On
// Linux that is invisible. On Windows an open handle locks its file, so the #335 per-file teardown
// (`tests/setup-temp-roots.ts`) could not remove the root the DB lives in and deferred ~1,500 roots
// per run to the post-run sweep: the fallback had become the normal path, and a root nothing could
// ever clean looked exactly like the routine ones.
//
// The fix applies the Performance fixture's pattern (`performance-fixture.ts`, TH2: register every
// DB at creation, close them in one teardown) once, in the harness, instead of by hand in 120 files:
// `tests/setup-temp-roots.ts` replaces `DatabaseSync` on the `node:sqlite` module object with a
// subclass that records every instance, and closes what was recorded in its `afterAll` BEFORE it
// removes the roots. Same box, same tree, full suite: deferred roots 1,515 → 1, no test newly failing.
//
// Why the MODULE and not `openDatabase`: `db.ts` — and every test that opens a raw handle (e.g.
// `chat-compaction.test.ts`) — reads `DatabaseSync` off the CommonJS module object
// (`createRequire(process.execPath)('node:sqlite')`; a bare `import 'node:sqlite'` does not resolve
// under Vite), and does so after the setup file has run. Replacing that one property therefore
// catches every handle, including the ones no test file opens itself, which a wrapper around
// `openDatabase` would miss. The setup file also re-syncs the builtin's ESM exports, so an ESM
// importer would see the same class.
//
// This module holds the pure pieces so they can be unit-tested (`tests/unit/sqlite-handles.test.ts`).
// Nothing here touches production code.

/** What the tracker needs from a handle. */
export interface ClosableHandle {
  close(): void
}

// A class extended by a mixin must have a single `...args: any[]` constructor (TS2545).
type HandleConstructor = new (...args: any[]) => ClosableHandle

/** The slice of `node:sqlite` the tracker patches (an injectable stand-in in the unit test). */
export interface SqliteModuleLike {
  DatabaseSync: HandleConstructor
}

// The registry lives ON the patched module object, not in this module's scope: the builtin is one
// object per process, so every copy of this helper that module isolation may load shares one list.
const TRACKED = Symbol.for('hilbertraum.trackedSqliteHandles')
type Tracked = SqliteModuleLike & { [TRACKED]?: ClosableHandle[] }

/**
 * `node:sqlite`, loaded the way `db.ts` loads it; `null` on a runtime without it.
 *
 * Node prints "SQLite is an experimental feature" as an ExperimentalWarning the first time a process
 * loads the module. The harness now loads it in EVERY fork, including the renderer and pure-logic
 * files that never open a DB, so loading it loudly added ~180 lines of noise to a full run (measured:
 * 268 → 449). That one warning — and only it — is swallowed while this call loads the module, and
 * `process.emitWarning` is restored before returning. Node emits it once per process, so a fork that
 * does use sqlite no longer prints it either; it tells a test run nothing (`db.ts` documents it).
 */
export function nodeSqlite(): SqliteModuleLike | null {
  const emitWarning = process.emitWarning
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]): void {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type
    const message = typeof warning === 'string' ? warning : warning.message
    if (type === 'ExperimentalWarning' && /SQLite/.test(message)) return
    ;(emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    return createRequire(process.execPath)('node:sqlite') as SqliteModuleLike
  } catch {
    return null
  } finally {
    process.emitWarning = emitWarning
  }
}

/**
 * Replace `sqlite.DatabaseSync` with a subclass that records every instance it constructs. A
 * constructor that throws records nothing, and `instanceof` the original class still holds.
 * Idempotent: returns `false`, changing nothing, when the module is already patched.
 */
export function installSqliteHandleTracking(sqlite: SqliteModuleLike): boolean {
  const mod = sqlite as Tracked
  if (mod[TRACKED]) return false
  const handles: ClosableHandle[] = []
  mod[TRACKED] = handles
  const Real = mod.DatabaseSync
  class TrackedDatabaseSync extends Real {
    constructor(...args: any[]) {
      super(...args)
      handles.push(this)
    }
  }
  // The name a stack trace or a log line shows stays the real one.
  Object.defineProperty(TrackedDatabaseSync, 'name', { value: Real.name })
  mod.DatabaseSync = TrackedDatabaseSync
  return true
}

/** The handles recorded so far and not yet taken by {@link closeTrackedHandles}. */
export function trackedHandles(sqlite: SqliteModuleLike): readonly ClosableHandle[] {
  return (sqlite as Tracked)[TRACKED] ?? []
}

export interface CloseResult {
  /** Handles this call closed. */
  closed: number
  /** Handles whose `close()` threw — in practice ones the suite already closed. */
  alreadyClosed: number
}

/**
 * Close every recorded handle and empty the registry. Never throws: `close()` on a handle the
 * suite already closed throws `ERR_INVALID_STATE` ("database is not open"), which is counted.
 * (`isOpen` would say so without the throw, but it is newer than the engines floor, Node 22.12.)
 */
export function closeTrackedHandles(sqlite: SqliteModuleLike): CloseResult {
  const result: CloseResult = { closed: 0, alreadyClosed: 0 }
  const handles = (sqlite as Tracked)[TRACKED]
  if (!handles) return result
  for (const handle of handles.splice(0, handles.length)) {
    try {
      handle.close()
      result.closed += 1
    } catch {
      result.alreadyClosed += 1
    }
  }
  return result
}
