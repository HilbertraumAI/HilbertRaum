import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeBinaryVerification,
  verifyBinaryBeforeSpawn,
  initBinaryVerification,
  _resetBinaryVerificationForTests
} from '../../src/main/services/binary-verifier'
import {
  markerBinaryKey,
  writeRuntimeMarker,
  type RuntimeInstallMarker as Marker
} from '../../src/main/services/assets'
import { sha256File } from '../../src/main/services/models'

// vuln-scan 2026-06-21 item B — re-hash sidecar binaries before spawn.

afterEach(() => _resetBinaryVerificationForTests())

const tmp = (p = 'hilbertraum-verify-'): string => mkdtempSync(join(tmpdir(), p))

/** A `readMarkerAt` stub returning the given marker only for `dir`. */
function markerAt(dir: string, marker: Marker | null): (d: string) => Marker | null {
  return (d) => (d === dir ? marker : null)
}

describe('markerBinaryKey', () => {
  it('is the binary path relative to the extract dir, posix-separated', () => {
    expect(markerBinaryKey('/r/llama.cpp/win', '/r/llama.cpp/win/llama-server.exe')).toBe('llama-server.exe')
    // A subdir binary keeps its relative prefix (always `/`, even on win32 inputs).
    expect(markerBinaryKey('C:\\r\\win', 'C:\\r\\win\\cpu\\llama-server.exe').replace(/\\/g, '/')).toBe(
      'cpu/llama-server.exe'
    )
  })
})

describe('computeBinaryVerification (matrix)', () => {
  const dir = '/drive/runtime/llama.cpp/win'
  const bin = `${dir}/llama-server.exe`
  const H = 'a'.repeat(64)
  const marker: Marker = { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64', binaries: { 'llama-server.exe': H } }

  it('match → ok', async () => {
    const res = await computeBinaryVerification(bin, { readMarkerAt: markerAt(dir, marker), hashFile: async () => H })
    expect(res).toBe('ok')
  })

  it('hash mismatch → mismatch (tamper refused)', async () => {
    const res = await computeBinaryVerification(bin, {
      readMarkerAt: markerAt(dir, marker),
      hashFile: async () => 'b'.repeat(64)
    })
    expect(res).toBe('mismatch')
  })

  it('marker present but no hash for this binary → skip-legacy', async () => {
    const legacy: Marker = { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' }
    const res = await computeBinaryVerification(bin, {
      readMarkerAt: markerAt(dir, legacy),
      hashFile: async () => H
    })
    expect(res).toBe('skip-legacy')
  })

  it('no marker at all → skip-legacy', async () => {
    const res = await computeBinaryVerification(bin, { readMarkerAt: () => null, hashFile: async () => H })
    expect(res).toBe('skip-legacy')
  })

  it('unreadable binary fails SAFE → mismatch', async () => {
    const res = await computeBinaryVerification(bin, {
      readMarkerAt: markerAt(dir, marker),
      hashFile: async () => {
        throw new Error('EACCES')
      }
    })
    expect(res).toBe('mismatch')
  })

  it('walks UP to the family marker for a cpu/ safety-net binary', async () => {
    const cpuBin = `${dir}/cpu/llama-server.exe`
    // The cpu dir has no marker; the family dir records the cpu binary under its relative key.
    const familyMarker: Marker = {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { 'cpu/llama-server.exe': H }
    }
    const res = await computeBinaryVerification(cpuBin, {
      readMarkerAt: markerAt(dir, familyMarker),
      hashFile: async () => H
    })
    expect(res).toBe('ok')
  })
})

describe('verifyBinaryBeforeSpawn (enforcement gate + session cache)', () => {
  it('is inert before init (skip-dev) and in a dev build', async () => {
    expect(await verifyBinaryBeforeSpawn('/anything/llama-server')).toBe('skip-dev')
    initBinaryVerification(true) // dev
    expect(await verifyBinaryBeforeSpawn('/anything/llama-server')).toBe('skip-dev')
  })

  it('packaged build with a matching marker → ok; a tampered marker → mismatch', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'real-binary-bytes')
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: await sha256File(bin) }
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')

    // A different binary path whose recorded hash does not match its bytes → mismatch.
    const dir2 = tmp()
    const bin2 = join(dir2, 'llama-server.exe')
    writeFileSync(bin2, 'tampered-bytes')
    writeRuntimeMarker(dir2, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir2, bin2)]: 'c'.repeat(64) }
    })
    expect(await verifyBinaryBeforeSpawn(bin2)).toBe('mismatch')
  })

  it('packaged build, no marker on the drive → skip-legacy (un-upgraded drive still launches)', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'x')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('skip-legacy')
  })

  it('caches one decision per path for the session (probe + start race the same path)', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'real')
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: await sha256File(bin) }
    })
    const first = verifyBinaryBeforeSpawn(bin)
    const second = verifyBinaryBeforeSpawn(bin)
    expect(second).toBe(first) // same cached promise — verified (hashed) exactly once
    expect(await first).toBe('ok')
    // Even after the file is tampered, the cached decision stands for the rest of the session.
    writeFileSync(bin, 'now-tampered-but-already-verified')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })
})
