// Temp-root, fresh-DB and raw/legacy-DB helpers for the suites that need a scratch workspace DB. Constraint: every temp root is minted HERE (directly under
// os.tmpdir(), prefixed `hilbertraum-`) so the `setup-temp-roots.ts` sweep removes it; no other helper calls mkdtemp.
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, type Db } from '../../src/main/services/db'
import { TEMP_ROOT_PREFIXES } from './temp-roots'

/**
 * A fresh temp root DIRECTLY under os.tmpdir() named `hilbertraum-<label>-XXXXXX`. The prefix is load-bearing:
 * `tests/setup-temp-roots.ts` only removes roots whose name starts with one of `TEMP_ROOT_PREFIXES` (#335).
 */
export function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `${TEMP_ROOT_PREFIXES[0]}${label}-`))
}

/** A fresh workspace DB `<tempRoot(label)>/test.sqlite` (handle closed by the #460 sweep). */
export function openFreshDb(label: string): Db {
  return openDatabase(join(tempRoot(label), 'test.sqlite'))
}

/**
 * A raw `node:sqlite` handle on `path`, outside `openDatabase` (no migrations run): for building or inspecting a file
 * the way an older binary sees it. `DatabaseSync` is read off the CommonJS module object at CALL time, so the #460
 * tracker (`tests/setup-temp-roots.ts`) records the handle; a bare `import 'node:sqlite'` does not resolve under Vite.
 */
export function openRawDb(path: string): DatabaseSync {
  const { DatabaseSync: Raw } = createRequire(process.execPath)('node:sqlite') as typeof import('node:sqlite')
  return new Raw(path)
}

/**
 * The path of a workspace DB an OLDER schema wrote: `build` runs against a raw handle (no migrations), which is
 * closed before the path is returned. `openDatabase(path)` then runs the upgrade under test.
 */
export function legacyDbPath(label: string, build: (raw: DatabaseSync) => void): string {
  const path = join(tempRoot(label), 'old.sqlite')
  const raw = openRawDb(path)
  try {
    build(raw)
  } finally {
    raw.close()
  }
  return path
}
