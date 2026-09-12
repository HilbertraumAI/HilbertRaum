// Vitest setup (issue #335), applied to every test file after `tests/setup.ts`: the temp-root
// hygiene the Performance fixture does for its own suites (`performance-fixture.ts`, TH2),
// applied by the harness to every file — see `tests/helpers/temp-roots.ts` for the design.
// Issue #460 extends it to the sqlite handles those roots hold — see
// `tests/helpers/sqlite-handles.ts`.
//
// The `mkdtemp` family is wrapped on the CommonJS `fs` object and the ESM live bindings are
// re-synced (`syncBuiltinESMExports`), so a test file's `import { mkdtempSync } from 'node:fs'`
// — or `mkdtemp` from 'node:fs/promises' — reaches the wrapper (verified under the forks pool).
// Only directories minted DIRECTLY under `os.tmpdir()` with a test prefix are recorded; the
// wrapper never changes what the call returns or throws.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll } from 'vitest'
import { closeTrackedHandles, installSqliteHandleTracking, nodeSqlite } from './helpers/sqlite-handles'
import { cleanupRecordedRoots, recordTempRoot } from './helpers/temp-roots'

type MkdtempSync = typeof fs.mkdtempSync
type Mkdtemp = typeof fs.mkdtemp
type MkdtempPromise = typeof fs.promises.mkdtemp

const PATCHED = Symbol.for('hilbertraum.tempRootsPatched')
const marker = fs as unknown as Record<symbol, boolean>

if (!marker[PATCHED]) {
  marker[PATCHED] = true

  const realSync: MkdtempSync = fs.mkdtempSync
  fs.mkdtempSync = ((prefix: Parameters<MkdtempSync>[0], options?: Parameters<MkdtempSync>[1]) => {
    const dir = (realSync as (p: Parameters<MkdtempSync>[0], o?: Parameters<MkdtempSync>[1]) => ReturnType<MkdtempSync>)(prefix, options)
    recordTempRoot(dir)
    return dir
  }) as MkdtempSync

  const realCallback = fs.mkdtemp as unknown as (...args: unknown[]) => void
  fs.mkdtemp = ((...args: unknown[]) => {
    const cb = args[args.length - 1]
    if (typeof cb === 'function') {
      args[args.length - 1] = (err: unknown, dir: unknown) => {
        if (!err) recordTempRoot(dir)
        ;(cb as (e: unknown, d: unknown) => void)(err, dir)
      }
    }
    return realCallback(...args)
  }) as unknown as Mkdtemp

  const realPromise = fs.promises.mkdtemp as unknown as (...args: unknown[]) => Promise<unknown>
  fs.promises.mkdtemp = (async (...args: unknown[]) => {
    const dir = await realPromise(...args)
    recordTempRoot(dir)
    return dir
  }) as unknown as MkdtempPromise

  syncBuiltinESMExports()
}

// Issue #460: record every `DatabaseSync` this fork constructs — a test's own `openDatabase` or
// `new DatabaseSync`, a helper's, and the ones production code opens under test (the vault's) —
// so the teardown below can close what the file left open. `db.ts` and the tests read the class
// off the CommonJS module object this replaces (the helper says why that catches every handle);
// the re-sync covers an ESM importer too.
const sqlite = nodeSqlite()
if (sqlite && installSqliteHandleTracking(sqlite)) syncBuiltinESMExports()

// One teardown per file. It first CLOSES every sqlite handle the file left open (#460): on
// Windows an open handle locks its file, so before this almost every root failed to be removed
// here — ~1,500 per run went to the deferred list, and a root that genuinely could not be
// cleaned was indistinguishable from the routine case. Then it removes what this file minted;
// what still cannot be removed is deferred to the post-run sweep in `tests/global-temp-roots.ts`.
// Never throws, never fails a green suite.
//
// It never closes a DB a suite's own teardown still needs: vitest's default `sequence.hooks`
// ('stack') runs after-hooks in REVERSE registration order and this setup file registers first,
// so a test file's own `afterAll` runs before this one (`tests/unit/sqlite-handles.test.ts` pins
// that order).
//
// ONE attempt per root here, no in-hook retry: a locked root does not clear in 25 ms, and a
// second recursive delete of it only doubles the cost — on a starved windows CI runner that
// tripped vitest's 10 s hook budget (run 34033122353, a suite holding a sqlite handle per test).
// The sweep after the forks exit is the retry. The hook also carries its own generous timeout:
// cleanup may be slow, it must never fail a green suite.
const TEARDOWN_TIMEOUT_MS = 120_000
afterAll(async () => {
  if (sqlite) closeTrackedHandles(sqlite)
  await cleanupRecordedRoots({ attempts: 1 })
}, TEARDOWN_TIMEOUT_MS)
