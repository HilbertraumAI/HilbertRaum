import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { markerBinaryKey, writeRuntimeMarker } from '../../src/main/services/assets'
import { initBinaryVerification, setBinaryVerificationPosture } from '../../src/main/services/binary-verifier'
import { sha256File } from '../../src/main/services/models'
import { tempRoot } from './db-fixtures'

// Real on-disk binaries for the suites that drive the REAL pre-spawn verifier, across the runtime, voice
// and knowledge-pack spawn seams: `initBinaryVerification(false)` turns enforcement on, as a packaged build does.

/** What an install marker records for a binary: its true hash, a wrong hash, or no hashes (a
 *  bundle placed by hand). The real verifier answers `ok`, `mismatch` and `skip-legacy`. */
export type MarkerVerdict = 'ok' | 'mismatch' | 'legacy'

/** A real on-disk binary `name` under a real install marker, in a fresh dir. Returns the binary's path. */
export async function binaryWithMarker(name: string, verdict: MarkerVerdict): Promise<string> {
  const dir = tempRoot('binary-marker')
  const bin = join(dir, name)
  writeFileSync(bin, 'real-binary-bytes')
  const marker = { version: 'btest', backend: 'cpu', os: 'win' as const, arch: 'x64' }
  if (verdict === 'legacy') {
    writeRuntimeMarker(dir, marker)
  } else {
    const hash = verdict === 'ok' ? await sha256File(bin) : 'c'.repeat(64)
    writeRuntimeMarker(dir, { ...marker, binaries: { [markerBinaryKey(dir, bin)]: hash } })
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
