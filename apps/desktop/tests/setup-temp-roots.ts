// Vitest setup (issue #335), applied to every test file after `tests/setup.ts`: the temp-root
// hygiene the Performance fixture does for its own suites (`performance-fixture.ts`, TH2),
// applied by the harness to every file — see `tests/helpers/temp-roots.ts` for the design.
//
// The `mkdtemp` family is wrapped on the CommonJS `fs` object and the ESM live bindings are
// re-synced (`syncBuiltinESMExports`), so a test file's `import { mkdtempSync } from 'node:fs'`
// — or `mkdtemp` from 'node:fs/promises' — reaches the wrapper (verified under the forks pool).
// Only directories minted DIRECTLY under `os.tmpdir()` with a test prefix are recorded; the
// wrapper never changes what the call returns or throws.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll } from 'vitest'
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

// One teardown per file: remove what this file minted; what cannot be removed (an open sqlite
// handle on Windows) is deferred to the post-run sweep in `tests/global-temp-roots.ts`. Never
// throws, never fails a green suite.
//
// ONE attempt per root here, no in-hook retry: a handle the suite never closed does not clear
// in 25 ms, and a second recursive delete of a locked root only doubles the cost — on a starved
// windows CI runner that tripped vitest's 10 s hook budget (run 34033122353, a suite holding a
// sqlite handle per test). The sweep after the forks exit is the retry. The hook also carries
// its own generous timeout: cleanup may be slow, it must never fail a green suite.
const TEARDOWN_TIMEOUT_MS = 120_000
afterAll(async () => {
  await cleanupRecordedRoots({ attempts: 1 })
}, TEARDOWN_TIMEOUT_MS)
