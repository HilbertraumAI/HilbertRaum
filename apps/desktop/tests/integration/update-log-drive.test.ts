import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// F-11 on a real drive (app-update plan W-14, Appendix B; docs/app-updates.md 8.2, 5.3 table B.2; the T3.2 sheet's (b)):
// where the app's `update.log` lines land, what the writer refuses, and the size cap. The lines are the golden's
// (tests/fixtures/readers/f11-update-log/vectors.json), written by hand; the pure rules behind them are
// tests/unit/update-log.test.ts. Every refusal is the same for support: no line, nothing written anywhere else, the start
// goes on, and app.log says why by a fixed reason and the error's code, never a path.
//
// Rows only macOS and Linux run (CI): the directory and file symbolic links (Windows: a junction needs no privilege,
// a file symlink does), `chmod` denials (skipped as root), O_NOFOLLOW and the named pipe. Windows only: icacls.

// Counts the bytes the trim reads (I12): a regression that reads the whole file reads megabytes. The wrappers call
// straight through; nothing else changes.
const reads = vi.hoisted(() => ({ counting: false, bytes: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readSync = ((...args: Parameters<typeof actual.readSync>) => {
    const n = actual.readSync(...args)
    if (reads.counting) reads.bytes += n
    return n
  }) as typeof actual.readSync
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = actual.readFileSync(...args)
    if (reads.counting) reads.bytes += out.length
    return out
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readSync, readFileSync }, readSync, readFileSync }
})

import { appendUpdateLogLine, writeStartupLine } from '../../src/main/services/updates/update-log'
import { initLogging, readLogTail } from '../../src/main/services/logging'
import { resolvePaths, type ResolvedPaths } from '../../src/main/services/workspace'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import { denyNewFolders } from '../helpers/unreadable-dir'

interface Golden {
  accept: { vectors: Array<{ name: string; bytes_b64?: string; line?: string }> }
  cap: { line_max_bytes: number; max_bytes: number; keep_bytes: number }
  emit: {
    startup: { yaml: Record<string, string>; vectors: Array<{ name: string; line: string }> }
    generic: { vectors: Array<{ name: string; event: string; fields: Array<[string, string]>; line: string | null }> }
  }
}
const GOLDEN = JSON.parse(
  readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log', 'vectors.json'), 'utf8')
) as Golden
const NOW = '2026-11-25T10:00:00.123Z'
const isWindows = process.platform === 'win32'
const isPosixRoot = process.getuid?.() === 0
const EVERYONE = '*S-1-1-0'

const accept = (name: string): Buffer => {
  const v = GOLDEN.accept.vectors.find((x) => x.name === name)!
  return v.bytes_b64 !== undefined ? Buffer.from(v.bytes_b64, 'base64') : Buffer.from(v.line ?? '', 'utf8')
}
const generic = (name: string) => GOLDEN.emit.generic.vectors.find((v) => v.name === name)!
const startupLine = (name: string): string => GOLDEN.emit.startup.vectors.find((v) => v.name === name)!.line
/** The golden's lines are written on win32; this machine writes its own OS token. */
const onThisOs = (line: string): string => line.replace(/^r1-app win32 /, `r1-app ${process.platform} `)
/** One app append: LF, the line, LF. */
const framed = (line: string): Buffer => Buffer.from(`\n${line}\n`, 'utf8')

/** Byte-for-byte equality, reported by length and first difference (a diff of a 3 MB buffer is no use to anyone). */
function expectSameBytes(actual: Buffer, expected: Buffer): void {
  if (actual.equals(expected)) return
  let at = 0
  while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++
  const around = (b: Buffer): string => JSON.stringify(b.subarray(Math.max(0, at - 40), at + 40).toString('latin1'))
  expect.fail(`bytes differ: ${actual.length} bytes, expected ${expected.length}; first difference at ${at}: ${around(actual)} vs ${around(expected)}`)
}

const NOTICE = generic('g01')
const NOTICE_BYTES = framed(onThisOs(NOTICE.line!))

const scratch = (label: string): string => mkdtempSync(join(tmpdir(), `hr-update-log-${label}-`))
/** A prepared drive root (config/drive.json = {}), resolved as the start resolves it. */
function preparedRoot(label: string): ResolvedPaths {
  const root = scratch(label)
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config', 'drive.json'), '{}')
  return resolvePaths({ envRoot: root, fallbackRoot: root })
}
const updatesDir = (p: ResolvedPaths): string => join(p.rootPath, 'updates')
const logFile = (p: ResolvedPaths): string => join(updatesDir(p), 'update.log')
const appendNotice = (p: ResolvedPaths): void => appendUpdateLogLine(p, NOTICE.event, NOTICE.fields)

/** The app.log lines the writer left for support: its fields, parsed. */
function writerLines(message: string): Array<Record<string, unknown>> {
  return readLogTail()
    .filter((l) => l.includes(message))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>)
}
const skips = (): Array<Record<string, unknown>> => writerLines('Update log: line skipped')
const trimFailures = (): Array<Record<string, unknown>> => writerLines('Update log: trim failed')

/** A skip line holds the reason, the code and the bare system call, and no part of the root. */
function expectOneSkip(p: ResolvedPaths, fields: Record<string, unknown>): void {
  const lines = skips()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject(fields)
  expect(typeof lines[0]!.skipped).toBe('number')
  const raw = readLogTail().find((l) => l.includes('Update log: line skipped'))!
  expect(raw).not.toContain(basename(p.rootPath))
}

/** Can this machine make a symbolic link to a file (Windows: Developer Mode or admin)? The rows that need one skip. */
const canFileLink = ((): boolean => {
  const dir = scratch('can-link')
  try {
    writeFileSync(join(dir, 't'), '')
    symlinkSync(join(dir, 't'), join(dir, 'l'), 'file')
    return true
  } catch {
    return false
  }
})()
if (!canFileLink) console.warn('update-log-drive.test: no symbolic links to files here (Windows without the privilege): those rows skip')

function icacls(args: string[]): void {
  const r = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`icacls ${args.join(' ')} failed: ${r.stdout ?? ''}${r.stderr ?? ''}`)
}
/** Take the right to append to `file` away (Windows: deny Everyone "append data"; POSIX: r--r--r--); returns the undo. */
function denyAppend(file: string): () => void {
  if (isWindows) {
    icacls([file, '/deny', `${EVERYONE}:(AD)`])
    return () => icacls([file, '/remove:d', EVERYONE])
  }
  chmodSync(file, 0o444)
  return () => chmodSync(file, 0o644)
}

/** A log over the cap: app lines, then the cmd line with code-page bytes and CR LF (accept a4) near the end. */
function overCap(): Buffer {
  const line = Buffer.from(`\n${onThisOs(startupLine('s01'))}\n`, 'utf8')
  const parts: Buffer[] = []
  let size = 0
  while (size < GOLDEN.cap.max_bytes + 4_000) {
    parts.push(line)
    size += line.length
  }
  parts.push(Buffer.from('\r\n'), accept('a4'), line)
  return Buffer.concat(parts)
}
/** The cap's rule in the golden's words: the newest keep_bytes, from the byte after the first LF in them. */
function trimmed(bytes: Buffer): Buffer {
  const window = bytes.subarray(bytes.length - GOLDEN.cap.keep_bytes)
  const lf = window.indexOf(0x0a)
  return lf < 0 ? Buffer.alloc(0) : window.subarray(lf + 1)
}

beforeEach(() => {
  initLogging(join(scratch('logs'), 'logs')) // a fresh, empty in-memory buffer
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
  reads.counting = false
  reads.bytes = 0
})

describe('update.log on a prepared drive: where the line lands (F-11, W-14)', () => {
  it('I1: a missing updates/ is made, the line is framed LF line LF, and the next append keeps every earlier byte', () => {
    const p = preparedRoot('frame')
    appendNotice(p)
    expectSameBytes(readFileSync(logFile(p)), NOTICE_BYTES)
    expect(skips()).toEqual([])
    // Another writer's line is already there: cmd's CR LF and its code-page bytes stay byte for byte.
    const q = preparedRoot('after-cmd')
    mkdirSync(updatesDir(q))
    writeFileSync(logFile(q), accept('a4'))
    appendNotice(q)
    expectSameBytes(readFileSync(logFile(q)), Buffer.concat([accept('a4'), NOTICE_BYTES]))
  })

  it('I2: a root that is no prepared drive (the standalone fallback) gets nothing, and nothing is counted', () => {
    const root = scratch('fallback')
    const p = resolvePaths({ envRoot: undefined, fallbackRoot: root })
    expect(p.isPreparedDrive).toBe(false)
    appendNotice(p)
    writeStartupLine(p, { appVersion: '0.1.66', bundledManifestsDir: null })
    expect(existsSync(updatesDir(p))).toBe(false)
    expect(skips()).toEqual([])
  })

  it('I11: a 0-byte file and a file without a final line end: the line follows on its own line, nothing joins it', () => {
    const empty = preparedRoot('zero-bytes')
    mkdirSync(updatesDir(empty))
    writeFileSync(logFile(empty), '')
    appendNotice(empty)
    expectSameBytes(readFileSync(logFile(empty)), NOTICE_BYTES)
    const torn = preparedRoot('torn')
    mkdirSync(updatesDir(torn))
    writeFileSync(logFile(torn), accept('a9'))
    appendNotice(torn)
    expectSameBytes(readFileSync(logFile(torn)), Buffer.concat([accept('a9'), NOTICE_BYTES]))
  })
})

describe('update.log never goes through a link or into something that is no file (decision row 9 (a))', () => {
  it('I3: updates/ a junction (Windows) or a folder link: no line, nothing in the folder it reaches, counted', () => {
    const p = preparedRoot('updates-link')
    const elsewhere = scratch('elsewhere')
    symlinkSync(elsewhere, updatesDir(p), 'junction') // a folder symlink outside Windows
    appendNotice(p)
    expect(existsSync(join(elsewhere, 'update.log'))).toBe(false)
    expectOneSkip(p, { event: 'notice', reason: 'link' })
    appendNotice(p)
    const [first, second] = skips()
    expect(second!.skipped).toBe((first!.skipped as number) + 1) // the session's count goes on
  })

  it('I5: a file at updates: no line, the file unchanged', () => {
    const p = preparedRoot('updates-file')
    writeFileSync(updatesDir(p), 'not a folder')
    appendNotice(p)
    expect(readFileSync(updatesDir(p), 'utf8')).toBe('not a folder')
    expectOneSkip(p, { reason: 'not-a-folder' })
  })

  it('I4: a folder at update.log: no line, the folder left as it is', () => {
    const p = preparedRoot('log-folder')
    mkdirSync(logFile(p), { recursive: true })
    appendNotice(p)
    expect(lstatSync(logFile(p)).isDirectory()).toBe(true)
    expectOneSkip(p, { reason: 'not-a-file' })
  })

  it('I4: update.log a hard link to a file elsewhere: no line, the other file unchanged', () => {
    const p = preparedRoot('log-hardlink')
    mkdirSync(updatesDir(p))
    const other = join(scratch('other'), 'precious.txt')
    writeFileSync(other, 'someone else’s file')
    linkSync(other, logFile(p))
    appendNotice(p)
    expect(readFileSync(other, 'utf8')).toBe('someone else’s file')
    expectOneSkip(p, { reason: 'link' })
  })

  it.skipIf(!canFileLink)('I4: update.log a symbolic link to a file elsewhere: no line, the other file unchanged', () => {
    const p = preparedRoot('log-symlink')
    mkdirSync(updatesDir(p))
    const other = join(scratch('other'), 'precious.txt')
    writeFileSync(other, 'someone else’s file')
    symlinkSync(other, logFile(p), 'file')
    appendNotice(p)
    expect(readFileSync(other, 'utf8')).toBe('someone else’s file')
    expectOneSkip(p, { reason: 'link' })
  })
})

describe('update.log on a drive that refuses the write: the start goes on (W-14: swallowed and counted)', () => {
  it.skipIf(isPosixRoot)('I6: a root that refuses new folders before updates/ exists: no throw, no line, counted', () => {
    const p = preparedRoot('deny-folders')
    const undo = denyNewFolders(p.rootPath)
    try {
      expect(() => appendNotice(p)).not.toThrow()
    } finally {
      undo()
    }
    expect(existsSync(updatesDir(p))).toBe(false)
    expectOneSkip(p, { reason: 'write-failed', code: isWindows ? 'EPERM' : 'EACCES', syscall: 'mkdir' })
  })

  it.skipIf(isPosixRoot)('I7: an update.log that refuses appending: no throw, the file unchanged, counted', () => {
    const p = preparedRoot('deny-append')
    mkdirSync(updatesDir(p))
    writeFileSync(logFile(p), accept('a4'))
    const undo = denyAppend(logFile(p))
    try {
      expect(() => appendNotice(p)).not.toThrow()
    } finally {
      undo()
    }
    expectSameBytes(readFileSync(logFile(p)), accept('a4'))
    expectOneSkip(p, { reason: 'write-failed', code: isWindows ? 'EPERM' : 'EACCES', syscall: 'open' })
  })
})

describe('the size cap: 65,536 bytes, a trim keeps the newest 32,768 from a line boundary (the T3.2 sheet (b), Q9)', () => {
  it('I8: over the cap, the file is cut at an LF byte, the kept bytes are the old tail byte for byte, no temp is left', () => {
    const p = preparedRoot('trim')
    mkdirSync(updatesDir(p))
    const before = overCap()
    writeFileSync(logFile(p), before)
    appendNotice(p)
    const after = readFileSync(logFile(p))
    expectSameBytes(after, trimmed(Buffer.concat([before, NOTICE_BYTES])))
    expect(after.length).toBeLessThanOrEqual(GOLDEN.cap.keep_bytes)
    expectSameBytes(after.subarray(after.length - NOTICE_BYTES.length), NOTICE_BYTES)
    expect(after.includes(accept('a4'))).toBe(true) // cmd's code-page bytes are never decoded
    expect(existsSync(`${logFile(p)}.tmp`)).toBe(false)
    expect(trimFailures()).toEqual([])
  })

  it('I8: at the cap exactly, nothing is trimmed', () => {
    const p = preparedRoot('at-cap')
    mkdirSync(updatesDir(p))
    const before = Buffer.alloc(GOLDEN.cap.max_bytes - NOTICE_BYTES.length, 0x2e)
    writeFileSync(logFile(p), before)
    appendNotice(p)
    expectSameBytes(readFileSync(logFile(p)), Buffer.concat([before, NOTICE_BYTES]))
  })

  it('I9: while updates/applying/ exists (an apply may be appending), the app never trims', () => {
    const p = preparedRoot('applying')
    mkdirSync(join(updatesDir(p), 'applying'), { recursive: true })
    const before = overCap()
    writeFileSync(logFile(p), before)
    appendNotice(p)
    expectSameBytes(readFileSync(logFile(p)), Buffer.concat([before, NOTICE_BYTES]))
  })

  it('I10: a folder at update.log.tmp: the line stays, the trim fails and is counted, and the next append trims', () => {
    const p = preparedRoot('tmp-folder')
    mkdirSync(join(updatesDir(p), 'update.log.tmp'), { recursive: true })
    const before = overCap()
    writeFileSync(logFile(p), before)
    appendNotice(p)
    expectSameBytes(readFileSync(logFile(p)), Buffer.concat([before, NOTICE_BYTES]))
    expect(lstatSync(`${logFile(p)}.tmp`).isDirectory()).toBe(true)
    expect(trimFailures()).toHaveLength(1)
    expect(skips()).toEqual([])
    rmdirSync(`${logFile(p)}.tmp`)
    appendNotice(p)
    expectSameBytes(readFileSync(logFile(p)), trimmed(Buffer.concat([before, NOTICE_BYTES, NOTICE_BYTES])))
  })

  it('I10: a hard link at update.log.tmp is removed by its name; the file it shares is untouched', () => {
    const p = preparedRoot('tmp-link')
    mkdirSync(updatesDir(p))
    const other = join(scratch('other'), 'precious.txt')
    writeFileSync(other, 'someone else’s file')
    linkSync(other, `${logFile(p)}.tmp`)
    const before = overCap()
    writeFileSync(logFile(p), before)
    appendNotice(p)
    expect(readFileSync(other, 'utf8')).toBe('someone else’s file')
    expectSameBytes(readFileSync(logFile(p)), trimmed(Buffer.concat([before, NOTICE_BYTES])))
    expect(existsSync(`${logFile(p)}.tmp`)).toBe(false)
  })

  it('I12: a 3 MB file costs what a small one does: the trim reads only the kept tail', () => {
    const p = preparedRoot('huge')
    mkdirSync(updatesDir(p))
    const line = Buffer.from(`\n${onThisOs(startupLine('s01'))}\n`, 'utf8')
    const before = Buffer.concat(Array.from({ length: Math.ceil(3_000_000 / line.length) }, () => line))
    writeFileSync(logFile(p), before)
    reads.counting = true
    appendNotice(p)
    reads.counting = false
    expect(reads.bytes).toBeLessThanOrEqual(GOLDEN.cap.keep_bytes)
    expectSameBytes(readFileSync(logFile(p)), trimmed(Buffer.concat([before, NOTICE_BYTES])))
  })
})

describe('the startup line on a real drive: each source file’s state reaches its field (W-14, W-68)', () => {
  const YAML = GOLDEN.emit.startup.yaml['three-families']!
  /** The app's own bundled folder with the golden's three-family yaml. */
  function bundled(): string {
    const dir = scratch('bundled')
    writeFileSync(join(dir, 'runtime-sources.yaml'), YAML)
    return dir
  }
  const KIT_DRIVE_JSON = '{"product":"HilbertRaum","drive_format_version":1}'
  const KIT_RECORD = '{\n  "format": 1,\n  "app_version": "0.1.66"\n}\n'
  /** A file's text, a folder at its name, or nothing there. */
  type At = string | 'folder' | 'none'
  interface StartupCase {
    label: string
    golden: string
    driveJson: At
    record: At
    yaml: 'bundled' | 'no-folder' | 'empty-folder'
  }

  it.each<StartupCase>([
    { label: 'a Kit: the pins, the record and the drive format', golden: 's01', driveJson: KIT_DRIVE_JSON, record: KIT_RECORD, yaml: 'bundled' },
    { label: 'a dev scratch root: drive.json is {} and there is no record', golden: 's02', driveJson: '{}', record: 'none', yaml: 'bundled' },
    { label: 'no bundled folder: every pin absent', golden: 's03', driveJson: KIT_DRIVE_JSON, record: KIT_RECORD, yaml: 'no-folder' },
    { label: 'a bundled folder without the yaml: every pin absent', golden: 's03', driveJson: KIT_DRIVE_JSON, record: KIT_RECORD, yaml: 'empty-folder' },
    {
      label: 'a drive.json over 65,536 bytes: drive_format unreadable',
      golden: 's28',
      driveJson: `{"drive_format_version":1,"pad":"${'x'.repeat(65_536)}"}`,
      record: KIT_RECORD,
      yaml: 'bundled'
    },
    // The start finds a prepared drive by the marker's name (`existsSync`), so a folder there is still one.
    { label: 'a folder at drive.json: drive_format unreadable', golden: 's28', driveJson: 'folder', record: KIT_RECORD, yaml: 'bundled' },
    { label: 'a folder at drive-release.json: release unreadable', golden: 's11', driveJson: KIT_DRIVE_JSON, record: 'folder', yaml: 'bundled' }
  ])('$label', (c) => {
    const root = scratch('startup')
    mkdirSync(join(root, 'config'))
    const place = (name: string, at: At): void => {
      if (at === 'folder') mkdirSync(join(root, 'config', name))
      else if (at !== 'none') writeFileSync(join(root, 'config', name), at)
    }
    place('drive.json', c.driveJson)
    place('drive-release.json', c.record)
    const p = resolvePaths({ envRoot: root, fallbackRoot: root })
    expect(p.isPreparedDrive).toBe(true)
    const bundledManifestsDir = c.yaml === 'bundled' ? bundled() : c.yaml === 'empty-folder' ? scratch('bundled-empty') : null
    writeStartupLine(p, { appVersion: '0.1.66', bundledManifestsDir })
    // The SQLite version is this process's own (the golden's is vitest's Node on the box it was written on).
    const expected = onThisOs(startupLine(c.golden)).replace(/ sqlite=\S+/, ` sqlite=${process.versions.sqlite}`)
    expectSameBytes(readFileSync(logFile(p)), framed(expected))
    expect(skips()).toEqual([])
  })
})
