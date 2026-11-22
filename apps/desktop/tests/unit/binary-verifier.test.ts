import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  verifyBinaryBeforeSpawn,
  initBinaryVerification,
  setBinaryVerificationPosture,
  REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES
} from '../../src/main/services/binary-verifier'
import { markerBinaryKey, writeRuntimeMarker } from '../../src/main/services/assets'
import { sha256File } from '../../src/main/services/models'
import { allowReading, denyReading, verifierInert } from '../helpers/binary-fixtures'

// vuln-scan 2026-06-21 item B — re-hash sidecar binaries before spawn.

afterEach(() => verifierInert())

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

  it('an upper-case hash in the marker is the same hash, not a tamper', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'real-binary-bytes')
    const recorded = (await sha256File(bin)).toUpperCase()
    writeRuntimeMarker(dir, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { [markerBinaryKey(dir, bin)]: recorded }
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
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
    // #1012: the family's own files are not the net's to answer for — a family file that no longer
    // matches its hash (here the main program) leaves the net's verdict alone.
    writeFileSync(join(dir, 'llama-server.exe'), 'main-binary')
    writeRuntimeMarker(dir, {
      ...MARKER,
      binaries: { 'llama-server.exe': 'f'.repeat(64), 'cpu/llama-server.exe': await sha256File(bin) }
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  it("a cpu/ binary with its OWN marker is checked against that one, not the family's", async () => {
    initBinaryVerification(false)
    const { dir, bin } = cpuBinary()
    // #1012: the main program beside it, whose marker matches it but carries a stale `cpu/` key.
    const main = join(dir, 'llama-server.exe')
    writeFileSync(main, 'main-binary')
    writeRuntimeMarker(dir, {
      ...MARKER,
      binaries: {
        'llama-server.exe': await sha256File(main),
        // Each would be a mismatch: the net's folder, and the two folders of the net's own swap (#986).
        'cpu/llama-server.exe': 'e'.repeat(64),
        'cpu.new/llama-server.exe': 'e'.repeat(64),
        'cpu.old/llama-server.exe': 'e'.repeat(64)
      }
    })
    writeRuntimeMarker(join(dir, 'cpu'), { ...MARKER, binaries: { 'llama-server.exe': await sha256File(bin) } })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
    // …and the main program's verdict leaves the nested net's keys to the net (#1012).
    expect(await verifyBinaryBeforeSpawn(main)).toBe('ok')
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
    // A real read refusal, on every OS: the file is there but denies reading (EPERM / EACCES from the
    // hash's read stream — what an antivirus hold gives). (#1012 round 5: a folder at the path is no
    // longer this case; the verifier reads that as a missing file.)
    denyReading(bin)
    await expect(sha256File(bin)).rejects.toThrow() // the premise: this cannot be hashed
    // #1012 review R-2: its own verdict, never a tamper — the probe and the ladder treat it as no evidence.
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('unreadable')
    // The failure cleared: because it was NOT cached, the next attempt re-hashes the
    // real file and succeeds — the session is not stranded on MockRuntime.
    allowReading(bin)
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

// #1012: since #998 the marker records every file of an engine copy. The program a sidecar spawns can be
// a 9.7 KB shim (llama.cpp b12110 on Windows) whose code is in the libraries beside it, so the verifier
// checks every file the copy's own marker records, not only the program.
describe("every file the copy's own marker records (#1012)", () => {
  const MARKER = { version: 'b12110', backend: 'vulkan', os: 'win', arch: 'x64' } as const
  const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

  /** Write `files` (key → bytes) into `dir` with a marker recording each one's true hash. Synchronous. */
  function writeCopy(dir: string, files: Record<string, string>): void {
    for (const [key, bytes] of Object.entries(files)) {
      const p = join(dir, ...key.split('/'))
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, bytes)
    }
    writeRuntimeMarker(dir, {
      ...MARKER,
      binaries: Object.fromEntries(Object.entries(files).map(([key, bytes]) => [key, sha(bytes)]))
    })
  }

  it('a changed library the marker records is refused (mismatch)', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    writeCopy(dir, { 'llama-server.exe': 'shim', 'llama-server-impl.dll': 'the server' })
    writeFileSync(join(dir, 'llama-server-impl.dll'), 'another server')
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('mismatch')
  })

  it('a recorded library that is gone is missing, never a tamper, and is not cached', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeCopy(dir, { 'llama-server.exe': 'shim', 'ggml-vulkan.dll': 'the card backend' })
    rmSync(join(dir, 'ggml-vulkan.dll'))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('missing')
    // Put back (restored from a quarantine, say): the next spawn reads the copy again.
    writeFileSync(join(dir, 'ggml-vulkan.dll'), 'the card backend')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  // Code review round 5: a folder where a recorded file should be never heals by waiting (EISDIR). It is
  // no file of the copy: `missing`, so the user gets the reinstall offer — not "try again in a minute".
  it('a folder at a recorded library path is missing, not unreadable', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    writeCopy(dir, { 'llama-server.exe': 'shim', 'ggml-vulkan.dll': 'the card backend' })
    rmSync(join(dir, 'ggml-vulkan.dll'))
    mkdirSync(join(dir, 'ggml-vulkan.dll'))
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('missing')
  })

  // The knowledge-pack tools start despite a missing file (owner call on #1012), so `missing` must
  // never hide a changed one.
  // (Code review round 3: the missing file is one the tools start without — `missing-other` — which is
  // the only verdict a changed file could hide behind; a missing library stops every seam anyway.)
  it('a changed file is refused even while another recorded file is missing', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    writeCopy(dir, { 'kiwix-serve.exe': 'serve', 'LICENSE': 'licence text', 'icuuc74.dll': 'icu common' })
    rmSync(join(dir, 'LICENSE')) // a file no loader looks for; it sorts first, so the change is reached after it
    writeFileSync(join(dir, 'icuuc74.dll'), 'other common')
    expect(await verifyBinaryBeforeSpawn(join(dir, 'kiwix-serve.exe'))).toBe('mismatch')
  })

  // Code review round 3: a missing program or library refuses the copy at every seam, so the check stops
  // there instead of reading the rest (a quarantined DLL no longer costs the whole copy on each start
  // attempt). Observable: a file changed AFTER it in the check's order is not reached.
  it('the check stops at the first missing program or library', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    writeCopy(dir, { 'llama-server.exe': 'shim', 'ggml.dll': 'ggml', 'llama-bench.exe': 'bench' })
    rmSync(join(dir, 'ggml.dll'))
    writeFileSync(join(dir, 'llama-bench.exe'), 'another bench') // sorts after ggml.dll
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('missing')
  })

  // Code review round 3: every key is checked for containment, BEFORE a nested net's keys are set aside —
  // `cpu/../../x` names no file of the net.
  it('a key that leaves the folder through a nested net folder is refused, not set aside', async () => {
    initBinaryVerification(false)
    const outside = join(tmp(), 'planted.dll')
    writeFileSync(outside, 'planted')
    const dir = tmp()
    writeCopy(dir, { 'llama-server.exe': 'shim' })
    const escaping = `cpu/../${markerBinaryKey(dir, outside)}`
    writeRuntimeMarker(dir, { ...MARKER, binaries: { 'llama-server.exe': sha('shim'), [escaping]: sha('planted') } })
    expect(escaping.startsWith('cpu/../../')).toBe(true) // the premise: a nested-net prefix, then out of the folder
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('mismatch')
  })

  it("a marker key outside the copy's folder is refused, even with that file's true hash", async () => {
    initBinaryVerification(false)
    const outside = join(tmp(), 'planted.dll')
    writeFileSync(outside, 'planted')
    const dir = tmp()
    writeCopy(dir, { 'llama-server.exe': 'shim' })
    writeRuntimeMarker(dir, {
      ...MARKER,
      binaries: { 'llama-server.exe': sha('shim'), [markerBinaryKey(dir, outside)]: sha('planted') }
    })
    expect(markerBinaryKey(dir, outside).startsWith('../')).toBe(true) // the premise: the key leaves the folder
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('mismatch')
  })

  // An engine install (#986's swap, a #532 reinstall, a script re-run) can put a new copy in place while a
  // spawn is still hashing the old one: the hash then mixes two copies. Whatever that spawn is told, the
  // next one must judge the new copy against its own marker — not a tamper verdict cached for the session.
  it('an engine copy replaced while it is being hashed leaves no verdict behind', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeCopy(dir, { 'llama-server.exe': 'shim b1', 'llama.dll': 'library b1' })
    const during = verifyBinaryBeforeSpawn(bin)
    writeCopy(dir, { 'llama-server.exe': 'shim b2', 'llama.dll': 'library b2' })
    // The call read the old marker before the new copy landed: its hash mixed the two copies. Not a
    // tamper (review R-2): retried, never cached.
    expect(await during).toBe('unreadable')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  // Review R-1 / R-6: which missing file stops a start. The program and the libraries are what the OS
  // loader (or llama.cpp's backend loader) would look for elsewhere — the working directory included,
  // where a planted copy could be found — so `missing`. Any other recorded file (a tool the app never
  // runs, a licence text) is `missing-other`: the engines refuse both, the knowledge-pack tools only
  // the first.
  it.each([
    { gone: ['libggml-base.so.0'], verdict: 'missing' },
    { gone: ['libllama.dylib'], verdict: 'missing' },
    { gone: ['llama-server.exe'], verdict: 'missing' }, // the spawned program itself (R-6)
    { gone: ['llama-bench.exe'], verdict: 'missing-other' },
    { gone: ['LICENSE-LLVM-OpenMP'], verdict: 'missing-other' },
    { gone: ['ggml.dll', 'llama-bench.exe'], verdict: 'missing' }, // a library among them decides
    { gone: ['LICENSE-LLVM-OpenMP', 'ggml.dll'], verdict: 'missing' } // …also when another missing file comes first
  ])('recorded files gone: $gone → $verdict', async ({ gone, verdict }) => {
    initBinaryVerification(false)
    const dir = tmp()
    const names = ['llama-server.exe', 'ggml.dll', 'libggml-base.so.0', 'libllama.dylib', 'llama-bench.exe', 'LICENSE-LLVM-OpenMP']
    writeCopy(dir, Object.fromEntries(names.map((name) => [name, `bytes of ${name}`])))
    for (const name of gone) rmSync(join(dir, name))
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe(verdict)
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
