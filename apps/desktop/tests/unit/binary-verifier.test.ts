import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyBinaryBeforeSpawn,
  initBinaryVerification,
  setBinaryVerificationPosture,
  REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES,
  _resetBinaryVerificationForTests
} from '../../src/main/services/binary-verifier'
import { markerBinaryKey, writeRuntimeMarker } from '../../src/main/services/assets'
import { sha256File } from '../../src/main/services/models'

// vuln-scan 2026-06-21 item B — re-hash sidecar binaries before spawn.

afterEach(() => _resetBinaryVerificationForTests())

const tmp = (p = 'hilbertraum-verify-'): string => mkdtempSync(join(tmpdir(), p))

describe('markerBinaryKey', () => {
  it('is the binary path relative to the extract dir, posix-separated', () => {
    expect(markerBinaryKey('/r/llama.cpp/win', '/r/llama.cpp/win/llama-server.exe')).toBe('llama-server.exe')
    // A subdir binary keeps its relative prefix (always `/`, even on win32 inputs).
    expect(markerBinaryKey('C:\\r\\win', 'C:\\r\\win\\cpu\\llama-server.exe')).toBe('cpu/llama-server.exe')
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

  function cpuBinary(): { dir: string; bin: string } {
    const dir = tmp()
    mkdirSync(join(dir, 'cpu'))
    const bin = join(dir, 'cpu', 'llama-server.exe')
    writeFileSync(bin, 'cpu-binary')
    return { dir, bin }
  }
  const MARKER = { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' } as const

  it('walks UP to the family marker for a cpu/ safety-net binary', async () => {
    initBinaryVerification(false)
    const { dir, bin } = cpuBinary()
    // The cpu dir has no marker; the family dir records the cpu binary under its relative key.
    writeRuntimeMarker(dir, { ...MARKER, binaries: { 'cpu/llama-server.exe': await sha256File(bin) } })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  it("a cpu/ binary with its OWN marker is checked against that one, not the family's", async () => {
    initBinaryVerification(false)
    const { dir, bin } = cpuBinary()
    writeRuntimeMarker(dir, { ...MARKER, binaries: { 'cpu/llama-server.exe': 'e'.repeat(64) } }) // would be a mismatch
    writeRuntimeMarker(join(dir, 'cpu'), { ...MARKER, binaries: { 'llama-server.exe': await sha256File(bin) } })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  it('does NOT cache a transient unreadable-binary failure — the next spawn re-hashes (Windows AV/indexer lock)', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'real')
    const good = await sha256File(bin)
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: good }
    })
    // A real read failure, on every OS: a directory where the binary should be (EISDIR from the hash's read stream).
    rmSync(bin)
    mkdirSync(bin)
    await expect(sha256File(bin)).rejects.toThrow() // the premise: this cannot be hashed
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('mismatch')
    // The failure cleared: because it was NOT cached, the next attempt re-hashes the
    // real file and succeeds — the session is not stranded on MockRuntime.
    rmSync(bin, { recursive: true })
    writeFileSync(bin, 'real')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
    // And THAT definitive verdict now sticks (cached), even if the bytes later change.
    writeFileSync(bin, 'tampered-after-verify')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  it('caches a real hash mismatch (tamper) for the session — only unreadable is retried', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'real')
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: 'd'.repeat(64) } // recorded hash ≠ bytes
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('mismatch')
    // Even fixing the marker can't un-stick a cached tamper verdict this session.
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: await sha256File(bin) }
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('mismatch')
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

// #234: a hashless marker on a COMMERCIAL drive can be refused at spawn. The refusal is
// wired but shipped OFF (the constant) until the owner rules on already-sold kits; DIY
// drives keep the documented tolerance either way.
describe('commercial posture: hashless markers (#234)', () => {
  function hashlessInstall(): string {
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'legacy-binary')
    writeRuntimeMarker(dir, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
    return bin
  }

  it('ships with the spawn-time refusal OFF', () => {
    expect(REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES).toBe(false)
  })

  it('DIY posture: a hashless marker stays skip-legacy even with the refusal enabled', async () => {
    initBinaryVerification(false)
    setBinaryVerificationPosture({ commercial: false, refuseHashlessMarkers: true })
    expect(await verifyBinaryBeforeSpawn(hashlessInstall())).toBe('skip-legacy')
  })

  it('commercial posture + refusal enabled: a hashless marker is REFUSED (mismatch)', async () => {
    initBinaryVerification(false)
    setBinaryVerificationPosture({ commercial: true, refuseHashlessMarkers: true })
    expect(await verifyBinaryBeforeSpawn(hashlessInstall())).toBe('mismatch')
  })

  it('commercial posture with the shipped default (refusal off): tolerated as skip-legacy', async () => {
    initBinaryVerification(false)
    setBinaryVerificationPosture({ commercial: true })
    expect(await verifyBinaryBeforeSpawn(hashlessInstall())).toBe('skip-legacy')
  })

  it('the refusal never touches a binary whose recorded hash matches (ok) or a dev build (skip-dev)', async () => {
    initBinaryVerification(false)
    setBinaryVerificationPosture({ commercial: true, refuseHashlessMarkers: true })
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'hashed-binary')
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: await sha256File(bin) }
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')

    initBinaryVerification(true)
    setBinaryVerificationPosture({ commercial: true, refuseHashlessMarkers: true })
    expect(await verifyBinaryBeforeSpawn(hashlessInstall())).toBe('skip-dev')
  })
})
