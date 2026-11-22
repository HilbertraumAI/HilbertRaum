import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
 *  library that cannot be read — a folder at its path (`unreadable`), or the binary itself gone
 *  from the disk (`program-gone`). The real verifier answers each by its own name; `legacy` is
 *  `skip-legacy` and `program-gone` is `missing`. */
export type MarkerVerdict = 'ok' | 'mismatch' | 'legacy' | 'missing' | 'missing-other' | 'unreadable' | 'program-gone'

/** The bytes the marker records for `engine-library.dll` (#1012), so a test can put the library back. */
const LIBRARY_NAME = 'engine-library.dll'
const LIBRARY_BYTES = 'engine-library-bytes'

/**
 * #1012: put back the library a `missing` / `unreadable` fixture lacks — a real file with the bytes its
 * marker records — so the copy verifies `ok` again (the quarantine restored, the lock released).
 */
export function restoreEngineLibrary(bin: string): void {
  const p = join(dirname(bin), LIBRARY_NAME)
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
    if (verdict === 'missing' || verdict === 'unreadable') {
      extra[LIBRARY_NAME] = createHash('sha256').update(LIBRARY_BYTES).digest('hex')
    }
    if (verdict === 'missing-other') extra['unused-tool.exe'] = 'd'.repeat(64)
    if (verdict === 'unreadable') mkdirSync(join(dir, LIBRARY_NAME)) // a read fails with EISDIR, not ENOENT
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
