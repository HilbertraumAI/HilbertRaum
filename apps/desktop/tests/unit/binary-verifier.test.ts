import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  verifyBinaryBeforeSpawn,
  initBinaryVerification,
  invalidateBinaryVerification,
  setBinaryVerificationPosture,
  REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES,
  type BinaryVerifyResult
} from '../../src/main/services/binary-verifier'
import { markerBinaryKey, runtimeMarkerPath, writeRuntimeMarker } from '../../src/main/services/assets'
import { log } from '../../src/main/services/logging'
import { sha256File } from '../../src/main/services/models'
import { allowReading, denyReading, verifierInert } from '../helpers/binary-fixtures'

// vuln-scan 2026-06-21 item B — re-hash sidecar binaries before spawn.

// T3.12 fix round (R1 M-4, R2 m-1): the `stat` or the read of ONE recorded file fails with an injected error code
// (`readFaults.at`). No portable file system path fails with EIO, or with a hold, on demand. The pass-through
// `node:fs/promises` and `node:fs` mocks (the repo's fault-injection rule, as sha256-file-close.test.ts) hand every other
// call, and every other path, to the real function.
const readFaults = vi.hoisted(() => ({
  at: null as null | { path: string; phase: 'stat' | 'read'; code: string | null },
  /** The error a failing call gives: with `code`, or (null) with none at all. */
  error: (code: string | null): Error => Object.assign(new Error(`${code ?? 'an error with no code'}: injected`), code === null ? {} : { code })
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const stat = async (...args: Parameters<typeof actual.stat>): ReturnType<typeof actual.stat> => {
    const fault = readFaults.at
    if (fault?.phase === 'stat' && String(args[0]) === fault.path) throw readFaults.error(fault.code)
    return actual.stat(...args)
  }
  const mocked = { ...actual, stat }
  return { ...mocked, default: mocked }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  type ReadOptions = Exclude<Parameters<typeof actual.createReadStream>[1], string | undefined>
  const createReadStream = (path: Parameters<typeof actual.createReadStream>[0], options?: ReadOptions): ReturnType<typeof actual.createReadStream> => {
    const fault = readFaults.at
    if (fault?.phase !== 'read' || String(path) !== fault.path) return actual.createReadStream(path, options)
    // The file opens as usual; its first read fails (the hash's read stream, `sha256File`).
    const read = (...args: unknown[]): void => {
      const done = args[args.length - 1] as (err: Error) => void
      process.nextTick(() => done(readFaults.error(fault.code)))
    }
    return actual.createReadStream(path, { ...(options ?? {}), fs: { open: actual.open, read, close: actual.close } } as ReadOptions)
  }
  const mocked = { ...actual, createReadStream }
  return { ...mocked, default: mocked }
})

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

  // Code review round 6: a copy that will be refused is not hashed at all. Every recorded file is looked
  // at (a `stat`) before any is read, so a missing library ends the check before the program is hashed.
  // Observable without a seam: the program itself refuses to be read, so a hash of it would answer
  // `unreadable`.
  it('a missing library is missing before any file is hashed', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    writeCopy(dir, { 'llama-server.exe': 'shim', 'ggml.dll': 'ggml' })
    rmSync(join(dir, 'ggml.dll'))
    denyReading(join(dir, 'llama-server.exe')) // hashed first, if anything were hashed
    try {
      expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('missing')
    } finally {
      allowReading(join(dir, 'llama-server.exe'))
    }
  })

  // Code review round 6: a marker that is there but cannot be read just now is no legacy drive. It is
  // `unreadable` (re-checked), never `skip-legacy` (which would be cached, and refused on a Kit that
  // refuses hash-less markers). A cpu/ net whose own marker cannot be read does not fall back to the
  // family marker either.
  it.each([
    { name: "the copy's own marker", net: false },
    { name: "a cpu/ net's own marker (no fall back to the family marker)", net: true }
  ])('$name held unreadable: unreadable, then ok once it can be read', async ({ net }) => {
    initBinaryVerification(false)
    const family = tmp()
    const dir = net ? join(family, 'cpu') : family
    writeCopy(dir, { 'llama-server.exe': 'shim' })
    // The family marker would answer for the net's program if the walk fell back to it.
    if (net) writeRuntimeMarker(family, { ...MARKER, binaries: { 'cpu/llama-server.exe': sha('shim') } })
    const markerFile = runtimeMarkerPath(dir)
    denyReading(markerFile)
    try {
      expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('unreadable')
    } finally {
      allowReading(markerFile)
    }
    expect(await verifyBinaryBeforeSpawn(join(dir, 'llama-server.exe'))).toBe('ok')
  })

  // The knowledge-pack tools start despite a missing file (owner call on #1012), so `missing` must
  // never hide a changed one.
  // (Code review round 3: the missing file is one the tools start without — `missing-other` — which is
  // the only verdict a changed file could hide behind; a missing library stops every seam anyway.)
  // (Code review round 7: the tools say so — `startsOnMissingOther` — and only they hash past it.)
  it('a changed file is refused even while another recorded file is missing', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    writeCopy(dir, { 'kiwix-serve.exe': 'serve', 'LICENSE': 'licence text', 'icuuc74.dll': 'icu common' })
    rmSync(join(dir, 'LICENSE')) // a file no loader looks for; it sorts first, so the change is reached after it
    writeFileSync(join(dir, 'icuuc74.dll'), 'other common')
    expect(await verifyBinaryBeforeSpawn(join(dir, 'kiwix-serve.exe'), { startsOnMissingOther: true })).toBe('mismatch')
  })

  // Code review round 7: the engines refuse `missing-other` as damaged files whatever the hash says, so
  // they are told right after the `stat` pass. Observable without a seam: the program refuses to be read,
  // so a hash of it would answer `unreadable`. Still re-checked: the file put back is found.
  it('an engine caller gets missing-other with nothing hashed, and it is not cached', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeCopy(dir, { 'llama-server.exe': 'shim', 'ggml.dll': 'ggml', 'llama-cli.exe': 'cli' })
    rmSync(join(dir, 'llama-cli.exe')) // quarantined, say: a program the app never runs
    denyReading(bin) // hashed first, if anything were hashed
    try {
      expect(await verifyBinaryBeforeSpawn(bin)).toBe('missing-other')
    } finally {
      allowReading(bin)
    }
    writeFileSync(join(dir, 'llama-cli.exe'), 'cli') // restored from the quarantine
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  // Code review round 7: a caller that starts on `missing-other` (the knowledge-pack tools) still hashes
  // every present file, and the verdict it then starts on is kept for the session like `ok`.
  it('a caller that starts on missing-other: every present file is hashed, and the verdict is cached like ok', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'kiwix-manage.exe')
    const starts = { startsOnMissingOther: true }
    writeCopy(dir, { 'kiwix-manage.exe': 'manage', 'icuuc74.dll': 'icu common', 'kiwix-search.exe': 'search' })
    rmSync(join(dir, 'kiwix-search.exe'))
    // Hashed: a present library that refuses to be read makes the answer `unreadable` (not cached).
    denyReading(join(dir, 'icuuc74.dll'))
    try {
      expect(await verifyBinaryBeforeSpawn(bin, starts)).toBe('unreadable')
    } finally {
      allowReading(join(dir, 'icuuc74.dll'))
    }
    expect(await verifyBinaryBeforeSpawn(bin, starts)).toBe('missing-other')
    // Served from the session cache: a re-hash would now find the changed library.
    writeFileSync(join(dir, 'icuuc74.dll'), 'other common')
    expect(await verifyBinaryBeforeSpawn(bin, starts)).toBe('missing-other')
    // …as an in-app install's eviction shows.
    invalidateBinaryVerification(bin)
    expect(await verifyBinaryBeforeSpawn(bin, starts)).toBe('mismatch')
  })

  // Code review round 7: an engine's unhashed `missing-other` must never answer a caller that starts on it,
  // not even a call that overlaps it on the same path (a shared pending hash, as the probe and the start).
  it('a verdict reached without the hash never answers a caller that starts on missing-other', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const bin = join(dir, 'kiwix-serve.exe')
    writeCopy(dir, { 'kiwix-serve.exe': 'serve', 'icuuc74.dll': 'icu common', 'kiwix-search.exe': 'search' })
    rmSync(join(dir, 'kiwix-search.exe'))
    writeFileSync(join(dir, 'icuuc74.dll'), 'other common')
    expect(
      await Promise.all([verifyBinaryBeforeSpawn(bin), verifyBinaryBeforeSpawn(bin, { startsOnMissingOther: true })])
    ).toEqual(['missing-other', 'mismatch'])
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

  // T3.12 fix round (R1 M-4, R2 m-1): what a failed `stat` or read of a recorded file says. A read error of the medium
  // (EIO: a worn stick) is no hold: the copy is not what was installed, so the file counts as missing (here a library:
  // `missing`), which the engines refuse with the reinstall offer. A name the OS refuses (a NUL in it, too long, a link loop, an invalid argument) never heals by
  // waiting: the record is damaged. Everything else is a hold or a code nothing here knows: `unreadable`, retried (the
  // recorded design, review R-2). None of the three is kept for the session: the next attempt reads the copy again.
  describe('a recorded file whose stat or read fails, by its error code (T3.12 fix round)', () => {
    afterEach(() => {
      readFaults.at = null
    })
    const CODES: Array<[string | null, BinaryVerifyResult]> = [
      ['EIO', 'missing'],
      ['ERR_INVALID_ARG_VALUE', 'marker-damaged'],
      ['ENAMETOOLONG', 'marker-damaged'],
      ['ELOOP', 'marker-damaged'],
      ['EINVAL', 'marker-damaged'],
      ['EBUSY', 'unreadable'],
      ['EPERM', 'unreadable'],
      ['EACCES', 'unreadable'],
      ['EAGAIN', 'unreadable'],
      ['EMFILE', 'unreadable'],
      ['ENFILE', 'unreadable'],
      ['UNKNOWN', 'unreadable'], // libuv's code for an error it does not map (Windows)
      [null, 'unreadable'] // an error with no code at all
    ]
    it.each((['stat', 'read'] as const).flatMap((phase) => CODES.map(([code, verdict]) => ({ phase, code, verdict }))))(
      'its $phase fails with $code: $verdict, and the next attempt reads the copy again',
      async ({ phase, code, verdict }) => {
        initBinaryVerification(false)
        const dir = tmp()
        const bin = join(dir, 'llama-server.exe')
        writeCopy(dir, { 'llama-server.exe': 'shim', 'ggml.dll': 'ggml' })
        readFaults.at = { path: join(dir, 'ggml.dll'), phase, code }
        expect(await verifyBinaryBeforeSpawn(bin)).toBe(verdict)
        readFaults.at = null
        expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
      }
    )

    // A file the drive fails to read counts exactly like one that is not there, by what it is (the coordinator's ruling on
    // the fix round's Q1): the library above is `missing`; a file no loader looks for is `missing-other`, which the
    // engines refuse and the knowledge-pack tools start on (owner Q2 (b)).
    it.each(['stat', 'read'] as const)(
      'a read error of the medium (%s) on a file no loader looks for is missing-other, for the engines and for a caller that starts on it',
      async (phase) => {
        initBinaryVerification(false)
        const dir = tmp()
        const bin = join(dir, 'kiwix-serve.exe')
        writeCopy(dir, { 'kiwix-serve.exe': 'serve', LICENSE: 'licence text' })
        readFaults.at = { path: join(dir, 'LICENSE'), phase, code: 'EIO' }
        expect(await verifyBinaryBeforeSpawn(bin, { startsOnMissingOther: true })).toBe('missing-other')
        expect(await verifyBinaryBeforeSpawn(bin)).toBe('missing-other')
      }
    )
  })
})

// T3.12 fix round (R1 m-3, R2 m-4): no throw leaves the check. One nobody foresaw (here the log line itself fails) ends
// the verification as `unreadable`, never a rejected promise kept in the session cache, and it is dropped like
// `unreadable`: the next attempt checks the copy again.
describe('a throw inside the check (T3.12 fix round)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  it.each([
    { where: 'while the copy is checked', commercial: false, level: 'info' as const },
    { where: 'while its verdict is settled (a commercial drive)', commercial: true, level: 'warn' as const }
  ])('$where: unreadable, and the next attempt checks the copy again', async ({ commercial, level }) => {
    initBinaryVerification(false)
    setBinaryVerificationPosture({ commercial })
    const dir = tmp()
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'legacy-binary')
    // A hash-less marker: logged while the copy is checked (info), and again on a commercial drive (warn).
    writeRuntimeMarker(dir, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
    vi.spyOn(log, level).mockImplementationOnce(() => {
      throw new Error('an unforeseen failure')
    })
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('unreadable')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('skip-legacy')
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

// #1028: an install marker that is there but cannot be read as one (cut short by an interrupted copy, garbled) used to
// read as no marker at all: the copy was `skip-legacy`, cached for the session, and its engine started unchecked; a `cpu/`
// net's own marker fell back to the family marker one folder up. It is `marker-damaged` now — the engines refuse it as
// damaged files, with the "Install again" offer — and it is read again on every attempt. Which texts are damaged is
// `readRuntimeMarker`'s table (assets.test.ts); these rows hold the walk, the cache and the postures to the verdict.
describe('an install marker that is there but cannot be read as one (#1028)', () => {
  const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
  const FIELDS = { version: 'b12110', backend: 'vulkan', os: 'win', arch: 'x64' } as const
  const cut = (text: string): string => text.slice(0, Math.floor(text.length / 2))
  const withMap = (binaries: unknown): string => JSON.stringify({ ...FIELDS, binaries })

  /** The program and a library beside it in `dir`, under a whole marker that records both. Returns the program and the marker's text. */
  function copyIn(dir: string): { bin: string; whole: string } {
    const bin = join(dir, 'llama-server.exe')
    writeFileSync(bin, 'the program')
    writeFileSync(join(dir, 'ggml.dll'), 'the library')
    writeRuntimeMarker(dir, { ...FIELDS, binaries: { 'llama-server.exe': sha('the program'), 'ggml.dll': sha('the library') } })
    return { bin, whole: readFileSync(runtimeMarkerPath(dir), 'utf8') }
  }

  it.each<[string, (whole: string) => string]>([
    ['cut short (an interrupted copy)', (whole) => cut(whole)],
    ['that is empty', () => ''],
    ['that is JSON but no object', () => '[]'],
    ['without its os field', () => JSON.stringify({ version: 'b12110', backend: 'vulkan', arch: 'x64' })],
    ['recording a file under a value that is not a SHA-256', () => withMap({ 'llama-server.exe': sha('the program'), 'ggml.dll': { sha256: sha('the library') } })],
    // A one-letter garble of the program's key: the map records the copy's files, but not the program it was asked about.
    ['recording the library but not the program', () => withMap({ 'llama-servar.exe': sha('the program'), 'ggml.dll': sha('the library') })],
    // Review round 2 (L-3): the smallest such map — a marker written before #998 records the program alone, so a garble of
    // its one key leaves a map of one file that is not the program.
    ['recording one file, not the program (a program-only marker, its key garbled)', () => withMap({ 'llama-servar.exe': sha('the program') })]
  ])("in the program's own folder, a marker %s is marker-damaged, never skip-legacy", async (_name, text) => {
    initBinaryVerification(false)
    const dir = tmp()
    const { bin, whole } = copyIn(dir)
    writeFileSync(runtimeMarkerPath(dir), text(whole))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('marker-damaged')
  })

  // Code review (CR-2): every key is checked for containment before the program's own is looked up, so a marker that
  // records a file outside its folder stays a tamper (`mismatch`: the log line, the knowledge-pack tools' `integrity`
  // kind) even when it does not record the program — never the softer `marker-damaged`.
  it('a marker that records a file outside its folder but not the program is refused as a tamper (mismatch)', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const { bin } = copyIn(dir)
    writeFileSync(runtimeMarkerPath(dir), withMap({ '../outside.dll': sha('the library'), 'ggml.dll': sha('the library') }))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('mismatch')
  })

  it('a folder at the marker path is marker-damaged: it never heals by waiting, so it is no read that failed just now', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const { bin } = copyIn(dir)
    rmSync(runtimeMarkerPath(dir))
    mkdirSync(runtimeMarkerPath(dir))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('marker-damaged')
  })

  it.each<[string, (whole: string) => string]>([
    // No writer writes one, but an editor may, and both fetch-runtime twins read past it.
    ['a UTF-8 byte-order mark before it', (whole) => String.fromCharCode(0xfeff) + whole],
    // Release 1's reader must keep accepting what a later writer adds at the top level (a signing record, G-28).
    ['an unknown top-level field holding an object', (whole) => JSON.stringify({ ...JSON.parse(whole), signature: { alg: 'x', of: ['ggml.dll'] } })]
  ])('a whole marker with %s is read, and the copy verifies ok', async (_name, text) => {
    initBinaryVerification(false)
    const dir = tmp()
    const { bin, whole } = copyIn(dir)
    writeFileSync(runtimeMarkerPath(dir), text(whole))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  // The family marker records the net under `cpu/`, with its true hash (it would answer ok) or a wrong one (mismatch):
  // neither may stand in for the net's own marker.
  it.each([
    ['its true hash', true],
    ['a wrong hash', false]
  ])("a cpu/ net's own marker cut short never falls back to the family marker (which records the net with %s)", async (_name, trueHash) => {
    initBinaryVerification(false)
    const dir = tmp()
    copyIn(dir)
    mkdirSync(join(dir, 'cpu'))
    const { bin, whole } = copyIn(join(dir, 'cpu'))
    writeRuntimeMarker(dir, {
      ...FIELDS,
      binaries: {
        'llama-server.exe': sha('the program'),
        'ggml.dll': sha('the library'),
        'cpu/llama-server.exe': trueHash ? sha('the program') : 'e'.repeat(64)
      }
    })
    writeFileSync(runtimeMarkerPath(join(dir, 'cpu')), cut(whole))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('marker-damaged')
  })

  it('a cpu/ net with no marker of its own: over a damaged family marker marker-damaged, over a whole one that records no cpu/ file skip-legacy', async () => {
    initBinaryVerification(false)
    const damagedFamily = tmp()
    const { whole } = copyIn(damagedFamily)
    mkdirSync(join(damagedFamily, 'cpu'))
    writeFileSync(join(damagedFamily, 'cpu', 'llama-server.exe'), 'the net')
    writeFileSync(runtimeMarkerPath(damagedFamily), cut(whole))
    expect(await verifyBinaryBeforeSpawn(join(damagedFamily, 'cpu', 'llama-server.exe'))).toBe('marker-damaged')

    const wholeFamily = tmp()
    copyIn(wholeFamily)
    mkdirSync(join(wholeFamily, 'cpu'))
    writeFileSync(join(wholeFamily, 'cpu', 'llama-server.exe'), 'the net')
    expect(await verifyBinaryBeforeSpawn(join(wholeFamily, 'cpu', 'llama-server.exe'))).toBe('skip-legacy')
  })

  // Review round 2 (L-3): the family marker records files of the net (under `cpu/`) but not the net's program — the net
  // copy is recorded, so its program's missing key is damage, not a legacy drive.
  it("a cpu/ net with no marker of its own, over a family marker that records the net's files but not its program, is marker-damaged", async () => {
    initBinaryVerification(false)
    const dir = tmp()
    copyIn(dir)
    mkdirSync(join(dir, 'cpu'))
    writeFileSync(join(dir, 'cpu', 'llama-server.exe'), 'the net')
    writeFileSync(join(dir, 'cpu', 'ggml.dll'), 'the net library')
    writeRuntimeMarker(dir, {
      ...FIELDS,
      binaries: { 'llama-server.exe': sha('the program'), 'ggml.dll': sha('the library'), 'cpu/ggml.dll': sha('the net library') }
    })
    expect(await verifyBinaryBeforeSpawn(join(dir, 'cpu', 'llama-server.exe'))).toBe('marker-damaged')
  })

  it('is not cached: the whole marker put back without a reinstall is read by the next attempt, and a changed program is caught', async () => {
    initBinaryVerification(false)
    const dir = tmp()
    const { bin, whole } = copyIn(dir)
    writeFileSync(runtimeMarkerPath(dir), cut(whole))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('marker-damaged')
    writeFileSync(runtimeMarkerPath(dir), whole)
    writeFileSync(bin, 'changed while the marker was cut short')
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('mismatch')
  })

  it('on a commercial drive that refuses hash-less markers it is marker-damaged too, never the cached refusal of a hash-less one', async () => {
    initBinaryVerification(false)
    setBinaryVerificationPosture({ commercial: true, refuseHashlessMarkers: true })
    const dir = tmp()
    const { bin, whole } = copyIn(dir)
    writeFileSync(runtimeMarkerPath(dir), cut(whole))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('marker-damaged')
    writeFileSync(runtimeMarkerPath(dir), whole)
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('ok')
  })

  it('a dev build reads no marker at all (skip-dev)', async () => {
    initBinaryVerification(true)
    const dir = tmp()
    const { bin, whole } = copyIn(dir)
    writeFileSync(runtimeMarkerPath(dir), cut(whole))
    expect(await verifyBinaryBeforeSpawn(bin)).toBe('skip-dev')
  })
})

// T3.12 fix round (R1 M-3, R1 m-2, R2 m-1; F-24): the copy's shape, golden. vectors.json (T2.10) holds the marker's text;
// copy-shapes.json holds what release 1's check makes of the copy beside it: the files it reads and the ones it leaves
// alone (every later writer leans on "never refused for a file its marker does not record"), a map that records no file
// of the copy, and names no file can have. Hand-written from the two reviews (its PROVENANCE.md), locked by
// golden-fixtures.sha256.
describe('F-24 golden copy shapes: which files of an engine copy release 1 checks (T3.12 fix round)', () => {
  interface CopyShape {
    name: string
    files: Record<string, string>
    binaries: Record<string, string>
    longKeys?: Array<{ repeat: string; times: number; then: string; sha256: string }>
    selfLinks?: string[]
    verdict: BinaryVerifyResult
    why: string
  }
  const SHAPES = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'readers', 'f24-markers', 'copy-shapes.json'), 'utf8')
  ) as { program: string; fields: { version: string; backend: string; os: 'win'; arch: string }; sha256: Record<string, string>; vectors: CopyShape[] }
  const at = (dir: string, key: string): string => join(dir, ...key.split('/'))

  it('every true hash the set records is the SHA-256 of its text', () => {
    for (const [text, hash] of Object.entries(SHAPES.sha256)) expect(createHash('sha256').update(text).digest('hex'), text).toBe(hash)
  })

  it.each(SHAPES.vectors.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    initBinaryVerification(false)
    const dir = tmp()
    for (const [key, text] of Object.entries(v.files)) {
      mkdirSync(dirname(at(dir, key)), { recursive: true })
      writeFileSync(at(dir, key), text)
    }
    const links = (v.selfLinks ?? []).map((key) => at(dir, key))
    for (const link of links) symlinkSync(link, link, process.platform === 'win32' ? 'junction' : 'file')
    const longKeys = (v.longKeys ?? []).map((k) => [k.repeat.repeat(k.times) + k.then, k.sha256] as const)
    writeRuntimeMarker(dir, { ...SHAPES.fields, binaries: { ...v.binaries, ...Object.fromEntries(longKeys) } })
    try {
      expect(await verifyBinaryBeforeSpawn(join(dir, SHAPES.program))).toBe(v.verdict)
    } finally {
      for (const link of links) unlinkSync(link)
    }
  })
})
