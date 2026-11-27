import { afterEach, describe, expect, it, vi } from 'vitest'

// The commit's `cleared` line (app-update T6.2, CF-53; docs/app-updates.md §4.5 "The cleared line", §5.3 table B.2
// `last-result.txt`, §5.8): updates/last-result.ts, the small reader and appender P7 extends. Every expected reading is
// the golden's (tests/fixtures/updates/import/last-result.json, T6.0b, written from the record before the module
// existed); each vector's bytes are written to a scratch drive and read back through the module's own file read, so the
// 65,536-byte window and its first-line rule are read off a real file. The token is drawn from crypto.randomBytes(8),
// which the seam below can script (a queue of answers, the real function once it is empty); nothing else is replaced.
const seams = vi.hoisted(() => ({ tokens: [] as Buffer[], draws: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>()
  const randomBytes = ((size: number) => {
    seams.draws++
    return seams.tokens.shift() ?? orig.randomBytes(size)
  }) as typeof orig.randomBytes
  const mocked = { ...orig, randomBytes }
  return { ...mocked, default: mocked }
})

import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAST_RESULT_FILE, LAST_RESULT_SEEN_FILE, clearMarkOf, marksVersion, readLastValidLine, type LastResultFileSystem } from '../../src/main/services/updates/last-result'
import { NODE_STAGING_FS } from '../../src/main/services/updates/staging'
import { bytesOf, IMPORT_FIXTURES, type BytesSpec } from '../helpers/update-bundles'

interface Vector {
  id: string
  why: string
  file: BytesSpec | null
  version: string
  expect: { lastValid: { code: string; version: string; token: string } | null; marks: boolean }
}
const GOLDEN = JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'last-result.json'), 'utf8')) as { append: { pattern: string }; vectors: Vector[] }

afterEach(() => {
  seams.tokens = []
  seams.draws = 0
})

/** A scratch drive's `updates/` folder (the temp-root sweep removes it). */
function updatesFolder(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'hr-updates-last-result-')), 'updates')
  mkdirSync(dir)
  return dir
}

/** The appended line's form, `^\ncleared <v> [0-9a-f]{16}\n$`, for one version. */
const appendedForm = (version: string): RegExp =>
  new RegExp(GOLDEN.append.pattern.replace('<v>', version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

/** Each call the module makes, for the rows that need the order of an append's calls or a failing write. */
function recording(faults: { write?: Error } = {}): { fs: LastResultFileSystem; calls: string[] } {
  const calls: string[] = []
  const fs: LastResultFileSystem = {
    lstat: (path) => NODE_STAGING_FS.lstat(path),
    async open(path, flags) {
      const handle = await NODE_STAGING_FS.open(path, flags)
      const name = path.slice(path.lastIndexOf(path.includes('\\') ? '\\' : '/') + 1)
      calls.push(`open ${name}`)
      return {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        async write(buffer, offset, length) {
          calls.push(`write ${name}`)
          if (faults.write !== undefined) throw faults.write
          return handle.write(buffer, offset, length)
        },
        async sync() {
          calls.push(`sync ${name}`)
          await handle.sync()
        },
        async close() {
          calls.push(`close ${name}`)
          await handle.close()
        }
      }
    }
  }
  return { fs, calls }
}

const PLATFORM = process.platform

describe('the last valid line of updates/last-result.txt, and whether it marks the version (last-result.json; record §4.5 "The cleared line", §5.3)', () => {
  it.each(GOLDEN.vectors.map((v) => [v.id, v] as const))('%s', async (_id, v) => {
    const dir = updatesFolder()
    const file = join(dir, LAST_RESULT_FILE)
    const before = v.file === null ? null : bytesOf(v.file)
    if (before !== null) writeFileSync(file, before)
    const line = await readLastValidLine(file, NODE_STAGING_FS, PLATFORM)
    expect(line).toEqual(v.expect.lastValid)
    expect(marksVersion(line, v.version)).toBe(v.expect.marks)

    // The commit's step: a file that marks <v> gets one `cleared <v> <token>` line appended after an empty line; any
    // other file is left byte for byte, and no file is made where there was none.
    const end = await clearMarkOf(dir, v.version, NODE_STAGING_FS, PLATFORM)
    expect(end.kind).toBe(v.expect.marks ? 'cleared' : 'not-marked')
    if (before === null) {
      expect(() => readFileSync(file)).toThrow()
      return
    }
    const after = readFileSync(file)
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    const appended = after.subarray(before.length).toString('latin1')
    if (end.kind === 'cleared') {
      expect(appended).toMatch(appendedForm(v.version))
      expect(appended).toBe(`\ncleared ${v.version} ${end.token}\n`)
    } else expect(appended).toBe('')
  })
})

describe('the cleared line: its token, its file and its failure (record §4.5 "The cleared line")', () => {
  const MARKING = '\nfallback 1.1.0 0123456789abcdef\n'

  it('the token is drawn again while it equals the last valid line\u{2019}s token or last-result.seen\u{2019}s third field', async () => {
    const dir = updatesFolder()
    writeFileSync(join(dir, LAST_RESULT_FILE), MARKING)
    writeFileSync(join(dir, LAST_RESULT_SEEN_FILE), 'helper-blocked 1.1.0 fedcba9876543210 os=win32 boot=1\n')
    seams.tokens = [Buffer.from('0123456789abcdef', 'hex'), Buffer.from('fedcba9876543210', 'hex'), Buffer.from('00112233445566ff', 'hex')]
    const end = await clearMarkOf(dir, '1.1.0', NODE_STAGING_FS, PLATFORM)
    expect(end).toEqual({ kind: 'cleared', token: '00112233445566ff' })
    expect(seams.draws).toBe(3)
    expect(readFileSync(join(dir, LAST_RESULT_FILE), 'latin1')).toBe(`${MARKING}\ncleared 1.1.0 00112233445566ff\n`)
  })

  it('an absent or damaged last-result.seen leaves nothing to avoid but the last valid line\u{2019}s token', async () => {
    const dir = updatesFolder()
    writeFileSync(join(dir, LAST_RESULT_FILE), MARKING)
    writeFileSync(join(dir, LAST_RESULT_SEEN_FILE), 'not a line\n')
    seams.tokens = [Buffer.from('fedcba9876543210', 'hex')]
    expect(await clearMarkOf(dir, '1.1.0', NODE_STAGING_FS, PLATFORM)).toEqual({ kind: 'cleared', token: 'fedcba9876543210' })
    expect(seams.draws).toBe(1)
  })

  it('a last-result.txt with a second name (a hard link) is read as absent: no mark, nothing appended to either name', async () => {
    const dir = updatesFolder()
    const file = join(dir, LAST_RESULT_FILE)
    writeFileSync(file, MARKING)
    linkSync(file, join(dir, 'second-name.txt'))
    expect(await readLastValidLine(file, NODE_STAGING_FS, PLATFORM)).toBeNull()
    expect(await clearMarkOf(dir, '1.1.0', NODE_STAGING_FS, PLATFORM)).toEqual({ kind: 'not-marked' })
    expect(readFileSync(file, 'latin1')).toBe(MARKING)
  })

  // A symbolic link to a file needs Windows' symbolic-link privilege (Developer Mode); the row runs where it can be made.
  const canLinkFile = ((): boolean => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-updates-last-result-can-'))
    try {
      writeFileSync(join(dir, 'f'), '')
      symlinkSync(join(dir, 'f'), join(dir, 'l'), 'file')
      return true
    } catch {
      return false
    }
  })()
  it.runIf(canLinkFile)('a symbolic link at the name is never followed: no mark, its target keeps its bytes', async () => {
    const dir = updatesFolder()
    const target = join(dir, '..', 'result.txt')
    writeFileSync(target, MARKING)
    symlinkSync(target, join(dir, LAST_RESULT_FILE), 'file')
    expect(await clearMarkOf(dir, '1.1.0', NODE_STAGING_FS, PLATFORM)).toEqual({ kind: 'not-marked' })
    expect(readFileSync(target, 'latin1')).toBe(MARKING)
  })

  it('the append is one write of LF, the line, LF, then an fsync, then the close', async () => {
    const dir = updatesFolder()
    writeFileSync(join(dir, LAST_RESULT_FILE), MARKING)
    const { fs, calls } = recording()
    expect((await clearMarkOf(dir, '1.1.0', fs, PLATFORM)).kind).toBe('cleared')
    expect(calls.filter((c) => c.endsWith(LAST_RESULT_FILE)).slice(-4)).toEqual([
      `open ${LAST_RESULT_FILE}`,
      `write ${LAST_RESULT_FILE}`,
      `sync ${LAST_RESULT_FILE}`,
      `close ${LAST_RESULT_FILE}`
    ])
  })

  it('a failed append answers its error (the commit refuses UPD-CANT-WRITE-DRIVE), leaves the file as it was and closes it', async () => {
    const dir = updatesFolder()
    writeFileSync(join(dir, LAST_RESULT_FILE), MARKING)
    const { fs, calls } = recording({ write: Object.assign(new Error('injected EIO'), { code: 'EIO', syscall: 'write' }) })
    expect(await clearMarkOf(dir, '1.1.0', fs, PLATFORM)).toEqual({ kind: 'failed', cause: { code: 'EIO', syscall: 'write' } })
    expect(readFileSync(join(dir, LAST_RESULT_FILE), 'latin1')).toBe(MARKING)
    expect(calls.filter((c) => c.startsWith('open')).length).toBe(calls.filter((c) => c.startsWith('close')).length)
  })
})
