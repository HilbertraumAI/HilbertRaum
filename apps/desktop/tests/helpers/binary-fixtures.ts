import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { markerBinaryKey, writeRuntimeMarker } from '../../src/main/services/assets'
import { initBinaryVerification, setBinaryVerificationPosture } from '../../src/main/services/binary-verifier'
import { sha256File } from '../../src/main/services/models'
import { tempRoot } from './db-fixtures'

// Real on-disk binaries for the suites that drive the REAL pre-spawn verifier, across the runtime, voice
// and knowledge-pack spawn seams: `initBinaryVerification(false)` turns enforcement on, as a packaged build does.

/** What an install marker records for a binary (#1012 adds the last four, each beside the binary's
 *  true hash): its true hash, a wrong hash, no hashes (a bundle placed by hand), a library that is
 *  not on the disk (`missing`), an unused program that is not on the disk (`missing-other`), a
 *  library that is there but refuses to be read (`unreadable`, see `denyReading`), the binary
 *  itself gone from the disk (`program-gone`), a library whose bytes differ from the recorded ones
 *  (`library-changed`: a corrupted or replaced DLL), or both of the last two kinds of damage at once
 *  (`missing-other-library-changed`: an unused program gone AND a library changed). The real verifier
 *  answers each by its own name; `legacy` is `skip-legacy`, `program-gone` is `missing` and
 *  `library-changed` is `mismatch`. `missing-other-library-changed` is `mismatch` for a caller that
 *  starts on `missing-other` (the knowledge-pack tools), `missing-other` for the engines. */
export type MarkerVerdict =
  | 'ok'
  | 'mismatch'
  | 'legacy'
  | 'missing'
  | 'missing-other'
  | 'unreadable'
  | 'program-gone'
  | 'library-changed'
  | 'missing-other-library-changed'

/** The bytes the marker records for `engine-library.dll` (#1012), so a test can put the library back. */
const LIBRARY_NAME = 'engine-library.dll'
const LIBRARY_BYTES = 'engine-library-bytes'

/** "Everyone", by SID, so the deny entry also covers the user running the tests (deny wins over allow). */
const EVERYONE = '*S-1-1-0'

/**
 * #1012 code review round 5: make a regular file refuse to be READ, for real — a deny-read-data ACL on
 * Windows (`icacls`), mode 000 elsewhere. The production read (`sha256File`) then fails with EPERM /
 * EACCES: what an antivirus hold or a deny-read ACL gives, and never ENOENT. (A folder at the path no
 * longer serves: since round 5 the verifier reads that as a missing file.) `stat` still works, and the
 * file stays deletable, so the temp-root sweep removes it. Fails loudly when the file stays readable
 * (tests run as root on POSIX).
 */
export function denyReading(p: string): void {
  if (process.platform === 'win32') {
    const r = spawnSync('icacls', [p, '/deny', `${EVERYONE}:(RD)`], { windowsHide: true, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`icacls /deny failed (${String(r.status)}): ${r.stdout}${r.stderr}`)
  } else {
    chmodSync(p, 0o000)
  }
  try {
    readFileSync(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return
    throw err
  }
  throw new Error('denyReading: the file is still readable (are the tests running as root?)')
}

/** Undo {@link denyReading}. */
export function allowReading(p: string): void {
  if (process.platform === 'win32') {
    spawnSync('icacls', [p, '/remove:d', EVERYONE], { windowsHide: true })
  } else {
    chmodSync(p, 0o644)
  }
}

/**
 * #1012: put back the library a `missing` / `unreadable` fixture lacks — a readable file with the bytes
 * its marker records — so the copy verifies `ok` again (the quarantine restored, the hold released).
 */
export function restoreEngineLibrary(bin: string): void {
  const p = join(dirname(bin), LIBRARY_NAME)
  if (existsSync(p)) allowReading(p)
  rmSync(p, { recursive: true, force: true })
  writeFileSync(p, LIBRARY_BYTES)
}

/** A real on-disk binary `name` under a real install marker, in a fresh dir. Returns the binary's path. */
export async function binaryWithMarker(name: string, verdict: MarkerVerdict): Promise<string> {
  const dir = tempRoot('binary-marker')
  const bin = join(dir, name)
  writeFileSync(bin, 'real-binary-bytes')
  const marker = { version: 'btest', backend: 'cpu', os: 'win' as const, arch: 'x64' }
  if (verdict === 'legacy') {
    writeRuntimeMarker(dir, marker)
  } else {
    const hash = verdict === 'mismatch' ? 'c'.repeat(64) : await sha256File(bin)
    const extra: Record<string, string> = {}
    const libraryChanged = verdict === 'library-changed' || verdict === 'missing-other-library-changed'
    if (verdict === 'missing' || verdict === 'unreadable' || libraryChanged) {
      extra[LIBRARY_NAME] = createHash('sha256').update(LIBRARY_BYTES).digest('hex')
    }
    if (verdict === 'missing-other' || verdict === 'missing-other-library-changed') extra['unused-tool.exe'] = 'd'.repeat(64)
    if (libraryChanged) writeFileSync(join(dir, LIBRARY_NAME), 'other library bytes') // e.g. cut short by a copy
    if (verdict === 'unreadable') {
      const library = join(dir, LIBRARY_NAME)
      writeFileSync(library, LIBRARY_BYTES)
      denyReading(library) // a real read refusal (EPERM / EACCES), not ENOENT
    }
    writeRuntimeMarker(dir, { ...marker, binaries: { [markerBinaryKey(dir, bin)]: hash, ...extra } })
    if (verdict === 'program-gone') rmSync(bin)
  }
  return bin
}

/**
 * Undoes `initBinaryVerification(false)` and any drive posture through the two production setters. The
 * session cache keeps its verdicts, which no row can see: each one's binary has a fresh path.
 */
export function verifierInert(): void {
  initBinaryVerification(true)
  setBinaryVerificationPosture({ commercial: false })
}
