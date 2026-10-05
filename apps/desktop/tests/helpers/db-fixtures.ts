// Temp-root + fresh-DB helpers for the skills suites. Constraint: every temp root is minted HERE (directly under
// os.tmpdir(), prefixed `hilbertraum-`) so the `setup-temp-roots.ts` sweep removes it; no other helper calls mkdtemp.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
