import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readKitSupport, type KitSupportRead } from '../../src/main/services/updates/kit-support'
import { DESKTOP_ROOT, REPO_ROOT } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'
import { makeUnreadable } from '../helpers/unreadable-dir'

// F-13's write-once config/kit-support.txt (app-update plan W-17, G-13 (b); docs/app-updates.md §8.4): the month a
// Kit's support ends, which release 1 and every later version read on every Kit for ever. The expected values are the
// golden's (tests/fixtures/readers/f13-drive-release/kit-support.json), written by hand from the plan, the record and the
// T3.3b sheet, never from the reader's or the helper's output. The reader runs in this process. The helper runs as the
// Kit builders run it, `node --no-warnings scripts/lib/write-kit-support.mjs`, in a real child, so every CI leg also
// proves that plain Node loads the TypeScript format module through type stripping. No test runs a builder's writing
// step (it downloads first): the builders' calls are held by script-drift.test.ts and script-orchestration.test.ts.

type Part = { text: string } | { base64: string } | { repeat: string; times: number }
type At =
  | 'file'
  | 'absent'
  | 'no-config'
  | 'config-is-file'
  | 'config-link'
  | 'folder'
  | 'file-link'
  | 'dangling-link'
  | 'folder-link'
  | 'fifo'
  | 'deny-read'
  | 'no-target'
  | 'target-is-file'
interface ReadVector {
  id: string
  name: string
  at?: At
  parts?: Part[]
  expect: KitSupportRead | { kind: 'unreadable' }
  codes?: string[]
}
interface WriteVector {
  id: string
  name: string
  at?: At
  parts?: Part[]
  supportEnd: string
  check?: boolean
  exit: number
  stamp: 'builder' | 'untouched' | 'none'
  stdout?: string
  stderr?: string
}
interface ValueVector {
  value: string
  exit: number
  stdout?: string
  stderr?: string
}
interface Golden {
  read: ReadVector[]
  builder: { month: string; text: string; bytes: number }
  writes: { vectors: WriteVector[] }
  values: { vectors: ValueVector[] }
}

const GOLDEN = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f13-drive-release', 'kit-support.json'), 'utf8')) as Golden
const HELPER = join(REPO_ROOT, 'scripts', 'lib', 'write-kit-support.mjs')
const STAMP = 'kit-support.txt'

const isWindows = process.platform === 'win32'
const isPosixRoot = process.getuid?.() === 0

const bytesOf = (parts: Part[]): Buffer =>
  Buffer.concat(
    parts.map((p) =>
      'text' in p ? Buffer.from(p.text, 'utf8') : 'base64' in p ? Buffer.from(p.base64, 'base64') : Buffer.from(p.repeat.repeat(p.times), 'utf8')
    )
  )

const scratch = (label: string): string => mkdtempSync(join(tmpdir(), `hr-kit-support-${label}-`))
const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** A symbolic link to a file needs the privilege on Windows (Developer Mode or admin); the rows that need one skip without it. */
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
if (!canFileLink) console.warn('kit-support.test: no symbolic links to files here (Windows without the privilege): those rows skip')

/** Why this machine cannot place `at`, or null. Named for the orchestrator's CI skip-count check. */
function cannotPlace(at: At): string | null {
  if (at === 'file-link' && !canFileLink) return 'no file symlinks'
  if (at === 'fifo' && isWindows) return 'no named pipes on Windows'
  if (at === 'deny-read' && isPosixRoot) return 'root reads any mode'
  return null
}

interface Drive {
  /** What the helper is handed as --target (the drive root; for `no-target` a path that is not there). */
  target: string
  /** config/kit-support.txt under the target, or under the folder a linked config/ names. */
  stamp: string
  /** The folder a `config-link` names (config/ itself is the link), else null. */
  linkedConfig: string | null
  undo: () => void
}

/** A scratch drive root with what `at` says at config/kit-support.txt. A `dangling-link` is a junction to a removed
 *  folder on Windows (no privilege needed) and a symbolic link to nothing elsewhere: both are links lstat sees. */
function driveFor(at: At, parts: Part[] | undefined): Drive {
  const base = scratch('drive')
  const bytes = parts === undefined ? Buffer.alloc(0) : bytesOf(parts)
  const plain = (target: string, linkedConfig: string | null = null, undo: () => void = () => undefined): Drive => ({
    target,
    stamp: join(linkedConfig ?? join(target, 'config'), STAMP),
    linkedConfig,
    undo
  })
  if (at === 'no-target') return plain(join(base, 'not-there'))
  if (at === 'target-is-file') {
    writeFileSync(join(base, 'a-file'), 'not a folder')
    return plain(join(base, 'a-file'))
  }
  if (at === 'no-config') return plain(base)
  if (at === 'config-is-file') {
    writeFileSync(join(base, 'config'), 'not a folder')
    return plain(base)
  }
  if (at === 'config-link') {
    const real = join(base, 'config-target')
    mkdirSync(real)
    if (parts !== undefined) writeFileSync(join(real, STAMP), bytes)
    symlinkSync(real, join(base, 'config'), 'junction') // `junction` is ignored outside Windows: a folder symlink
    return plain(base, real)
  }
  const config = join(base, 'config')
  mkdirSync(config)
  const drive = plain(base)
  switch (at) {
    case 'absent':
      break
    case 'file':
      writeFileSync(drive.stamp, bytes)
      break
    case 'folder':
      mkdirSync(drive.stamp)
      break
    case 'file-link':
      writeFileSync(join(config, 'target.txt'), bytes)
      symlinkSync(join(config, 'target.txt'), drive.stamp, 'file')
      break
    case 'dangling-link':
      if (isWindows) {
        mkdirSync(join(base, 'gone'))
        symlinkSync(join(base, 'gone'), drive.stamp, 'junction')
        rmSync(join(base, 'gone'), { recursive: true })
      } else symlinkSync(join(config, 'gone.txt'), drive.stamp, 'file')
      break
    case 'folder-link':
      mkdirSync(join(base, 'target-folder'))
      symlinkSync(join(base, 'target-folder'), drive.stamp, 'junction')
      break
    case 'fifo': {
      const r = spawnSync('mkfifo', [drive.stamp], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`mkfifo failed: ${r.stderr}`)
      break
    }
    case 'deny-read':
      writeFileSync(drive.stamp, bytes)
      drive.undo = makeUnreadable(drive.stamp) // RD on Windows (read data), mode 000 elsewhere
      break
  }
  return drive
}

const atOf = (v: { at?: At; parts?: Part[] }): At => v.at ?? (v.parts === undefined ? 'absent' : 'file')

describe('F-13 golden: readKitSupport reads config/kit-support.txt as release 1 does for ever', () => {
  it.for(GOLDEN.read.map((v) => [`${v.id} ${v.name}`, v] as const))('%s', ([, v], ctx) => {
    const at = atOf(v)
    if (cannotPlace(at)) ctx.skip()
    const drive = driveFor(at, v.parts)
    let got: KitSupportRead
    try {
      got = readKitSupport(drive.target)
    } finally {
      drive.undo()
    }
    if (v.codes) {
      // An errno token only, never a message (which names the path; F-11's content-free rule).
      expect(Object.keys(got).sort()).toEqual(['code', 'kind'])
      expect(got.kind).toBe('unreadable')
      expect(v.codes).toContain((got as { code: unknown }).code)
    } else expect(got).toStrictEqual(v.expect)
  })
})

// ---- the helper -------------------------------------------------------------------------------------------------

interface Run {
  status: number | null
  stdout: string
  /** stderr's lines. Run under --no-warnings, as the builders run it, they are the helper's own. */
  lines: string[]
}

const linesOf = (text: string): string[] => text.split(/\r?\n/).filter((l) => l !== '')

/** The helper as the builders run it (`node --no-warnings`), or the copy `helper`, from a working folder of its own. */
function runHelper(args: string[], opts: { nodeArgs?: string[]; helper?: string } = {}): Run {
  const r = spawnSync(process.execPath, ['--no-warnings', ...(opts.nodeArgs ?? []), opts.helper ?? HELPER, ...args], {
    cwd: scratch('cwd'),
    encoding: 'utf8',
    timeout: testBudgetMs(60_000),
    windowsHide: true
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, lines: linesOf(r.stderr) }
}

const PINNED = new Date('2026-01-02T03:04:05Z')

/** What is at the stamp's name before the run, for an `untouched` compare. A regular file's mtime is pinned first. */
function snapshot(drive: Drive): { kind: 'file' | 'folder' | 'link' | 'none'; bytes: Buffer | null } {
  const info = lstatOrNull(drive.stamp)
  if (info === null) return { kind: 'none', bytes: null }
  if (info.isSymbolicLink()) return { kind: 'link', bytes: null }
  if (info.isDirectory()) return { kind: 'folder', bytes: null }
  utimesSync(drive.stamp, PINNED, PINNED)
  return { kind: 'file', bytes: readFileSync(drive.stamp) }
}

function expectUntouched(drive: Drive, before: ReturnType<typeof snapshot>, v: WriteVector): void {
  const info = lstatOrNull(drive.stamp)
  if (before.kind === 'none') {
    expect(info, 'still nothing at the name').toBeNull()
    return
  }
  expect(info, 'still there').not.toBeNull()
  if (before.kind === 'link') expect(info!.isSymbolicLink()).toBe(true)
  if (before.kind === 'folder') expect(info!.isDirectory()).toBe(true)
  if (before.kind === 'file') {
    expect(readFileSync(drive.stamp)).toEqual(before.bytes)
    expect(info!.mtimeMs, 'never rewritten').toBe(PINNED.getTime())
  }
  if (atOf(v) === 'file-link') expect(readFileSync(join(drive.target, 'config', 'target.txt'))).toEqual(bytesOf(v.parts!))
}

function expectRun(run: Run, want: { exit: number; stdout?: string; stderr?: string }): void {
  expect(run.status, run.lines.join('\n')).toBe(want.exit)
  expect(run.stdout).toBe(want.stdout === undefined ? '' : `${want.stdout}\n`)
  expect(run.lines).toEqual(want.stderr === undefined ? [] : [expect.stringContaining(want.stderr)])
  for (const line of [...linesOf(run.stdout), ...run.lines]) expect(line.startsWith('kit-support.txt: '), line).toBe(true)
}

describe('F-13 golden: the helper writes config/kit-support.txt once, as the Kit builders run it (W-17)', () => {
  it.for(GOLDEN.writes.vectors.map((v) => [`${v.id} ${v.name}`, v] as const))('%s', { timeout: testBudgetMs(60_000) }, ([, v], ctx) => {
    const at = atOf(v)
    if (cannotPlace(at)) ctx.skip()
    const drive = driveFor(at, v.parts)
    const before = snapshot(drive)
    let run: Run
    try {
      run = runHelper(['--target', drive.target, '--support-end', v.supportEnd, ...(v.check ? ['--check'] : [])])
    } finally {
      drive.undo()
    }
    expectRun(run, v)
    if (v.stamp === 'builder') {
      expect(v.supportEnd).toBe(GOLDEN.builder.month) // the golden's builder bytes are for this month
      const bytes = readFileSync(drive.stamp)
      expect(bytes).toEqual(Buffer.from(GOLDEN.builder.text, 'utf8'))
      expect(bytes.length).toBe(GOLDEN.builder.bytes)
      // What the helper wrote, release 1's own reader reads back as that month.
      expect(readKitSupport(drive.target)).toStrictEqual({ kind: 'month', month: v.supportEnd })
    } else if (v.stamp === 'untouched') expectUntouched(drive, before, v)
    else {
      expect(lstatOrNull(drive.stamp), 'nothing at the name').toBeNull()
      if (drive.linkedConfig !== null) expect(readdirSync(drive.linkedConfig), 'nothing in the folder the link names').toEqual([])
      if (at === 'no-target') expect(lstatOrNull(drive.target), 'the target was not made').toBeNull()
    }
  })

  it.for(GOLDEN.values.vectors.map((v) => [JSON.stringify(v.value), v] as const))('the support end %s', { timeout: testBudgetMs(60_000) }, ([, v]) => {
    const drive = driveFor('absent', undefined)
    expectRun(runHelper(['--target', drive.target, '--support-end', v.value, '--check']), v)
    expect(lstatOrNull(drive.stamp)).toBeNull()
  })
})

// The clock rule (the sheet §4): a support end before this computer's current UTC month is refused, this month and
// later are not. The values are built from this test's own clock, so the golden's fixed values never go stale.
describe('the support end is never before this month, by this computer clock in UTC', () => {
  const monthOf = (d: Date): string => `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  const shifted = (months: number): string => {
    const now = new Date()
    return monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1)))
  }

  it('five years ahead is written, in the builder bytes', () => {
    const value = shifted(60)
    const drive = driveFor('absent', undefined)
    expectRun(runHelper(['--target', drive.target, '--support-end', value]), { exit: 0, stdout: `kit-support.txt: ${value}` })
    expect(readFileSync(drive.stamp, 'latin1')).toBe(`${value}\n`)
  }, testBudgetMs(60_000))

  it('the month before this one is refused, and the line names this month', (ctx) => {
    const now = shifted(0)
    const value = shifted(-1)
    const drive = driveFor('absent', undefined)
    const run = runHelper(['--target', drive.target, '--support-end', value])
    if (shifted(0) !== now) ctx.skip() // the month changed during the run: the line names the new one
    expectRun(run, { exit: 2, stderr: `kit-support.txt: the support end ${value} is before this month (${now} by this computer's clock); nothing written` })
    expect(lstatOrNull(drive.stamp)).toBeNull()
  }, testBudgetMs(60_000))

  it('this month itself is accepted', (ctx) => {
    const now = shifted(0)
    const drive = driveFor('absent', undefined)
    const run = runHelper(['--target', drive.target, '--support-end', now])
    if (shifted(0) !== now) ctx.skip() // the month changed during the run: the boundary moved under it
    expectRun(run, { exit: 0, stdout: `kit-support.txt: ${now}` })
  }, testBudgetMs(60_000))
})

/**
 * The helper as plain Node loads it, in a child whose `node:fs` answers as told: `HR_HIDE`, the stamp's name `lstat`s
 * as absent (what the check saw before something was put there); `HR_FSYNC_FAILS`, the flush fails with EIO. The
 * helper's own open, write and unlink stay real.
 */
const CHILD_RUN = [
  "import fs from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  'const env = process.env',
  'const { lstatSync } = fs',
  "const injected = (code) => Object.assign(new Error('injected'), { code })",
  "if (env.HR_HIDE) fs.lstatSync = (path, ...rest) => { if (path === env.HR_HIDE) throw injected('ENOENT'); return lstatSync(path, ...rest) }",
  "if (env.HR_FSYNC_FAILS) fs.fsyncSync = () => { throw injected('EIO') }",
  'syncBuiltinESMExports()',
  'process.argv = [process.argv[0], env.HR_HELPER, ...JSON.parse(env.HR_ARGS)]',
  'await import(env.HR_HELPER_URL)'
].join('\n')

function runInChild(args: string[], opts: { hide?: string; fsyncFails?: boolean }): Run {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '--eval', CHILD_RUN], {
    env: {
      ...process.env,
      HR_HELPER: HELPER,
      HR_HELPER_URL: pathToFileURL(HELPER).href,
      HR_ARGS: JSON.stringify(args),
      HR_HIDE: opts.hide ?? '',
      HR_FSYNC_FAILS: opts.fsyncFails ? '1' : ''
    },
    cwd: scratch('cwd'),
    encoding: 'utf8',
    timeout: testBudgetMs(60_000),
    windowsHide: true
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, lines: linesOf(r.stderr) }
}

describe('the helper never writes over what is there, and never leaves half a stamp', () => {
  // Brief decision 3: created exclusively. Something put at the name after the helper looked (the child's lstat still
  // says "nothing there") is never overwritten: the exclusive create refuses it.
  it('a file put there after the check is refused at the create, its bytes untouched', () => {
    const drive = driveFor('file', [{ text: '2098-11\n' }])
    const run = runInChild(['--target', drive.target, '--support-end', GOLDEN.builder.month], { hide: drive.stamp })
    expectRun(run, { exit: 1, stderr: 'kit-support.txt: writing config/kit-support.txt failed (EEXIST); nothing written' })
    expect(readFileSync(drive.stamp, 'latin1')).toBe('2098-11\n')
  }, testBudgetMs(60_000))

  // A stamp cut short would read as damaged, and write-once would then refuse every later run: a write that fails
  // after the create removes the file it made.
  it('a flush that fails after the create leaves no file', () => {
    const drive = driveFor('absent', undefined)
    const run = runInChild(['--target', drive.target, '--support-end', GOLDEN.builder.month], { fsyncFails: true })
    expectRun(run, { exit: 1, stderr: 'kit-support.txt: writing config/kit-support.txt failed (EIO); nothing written' })
    expect(lstatOrNull(drive.stamp)).toBeNull()
  }, testBudgetMs(60_000))

  // The write is read back by release 1's own reader. A drive that does not give back what was written (here the
  // child's lstat never sees the new file) ends the run with exit 1, and the line says the stamp was written.
  it('a stamp that does not read back as written: exit 1, and the line says it was written', () => {
    const drive = driveFor('absent', undefined)
    const run = runInChild(['--target', drive.target, '--support-end', GOLDEN.builder.month], { hide: drive.stamp })
    expectRun(run, { exit: 1, stderr: 'kit-support.txt: config/kit-support.txt was written but could not be read back as written; check the drive' })
    expect(readFileSync(drive.stamp)).toEqual(Buffer.from(GOLDEN.builder.text, 'utf8'))
  }, testBudgetMs(60_000))
})

describe('the helper refuses what it cannot run with, in one line of its own', () => {
  it('a Node without type stripping is refused before anything is read or written', () => {
    const drive = driveFor('absent', undefined)
    const run = runHelper(['--target', drive.target, '--support-end', GOLDEN.builder.month], { nodeArgs: ['--no-experimental-strip-types'] })
    expectRun(run, { exit: 1, stderr: 'has no type stripping, so it cannot load the format module; use Node 22.18 or later; nothing written' })
    expect(lstatOrNull(drive.stamp)).toBeNull()
  }, testBudgetMs(60_000))

  // A partial checkout: the helper beside its ts-sibling-imports, the format module missing.
  it('a format module that cannot be loaded is refused, nothing written', () => {
    const repo = scratch('helper-copy')
    const lib = join(repo, 'scripts', 'lib')
    mkdirSync(lib, { recursive: true })
    for (const name of ['write-kit-support.mjs', 'ts-sibling-imports.mjs']) copyFileSync(join(REPO_ROOT, 'scripts', 'lib', name), join(lib, name))
    const drive = driveFor('absent', undefined)
    const run = runHelper(['--target', drive.target, '--support-end', GOLDEN.builder.month], { helper: join(lib, 'write-kit-support.mjs') })
    expectRun(run, { exit: 1, stderr: 'kit-support.txt: the format module could not be loaded (ERR_MODULE_NOT_FOUND); nothing written' })
    expect(lstatOrNull(drive.stamp)).toBeNull()
  }, testBudgetMs(60_000))

  it.each<[string, string[]]>([
    ['no arguments', []],
    ['no --support-end', ['--target', 'x']],
    ['no --target', ['--support-end', '2097-03']],
    ['--support-end without a value', ['--target', 'x', '--support-end']],
    ['an empty --support-end', ['--target', 'x', '--support-end', '']],
    ['--target followed by a flag', ['--target', '--check', '--support-end', '2097-03']],
    ['an unknown flag', ['--target', 'x', '--support-end', '2097-03', '--force']],
    ['--check twice', ['--target', 'x', '--support-end', '2097-03', '--check', '--check']],
    ['two targets', ['--target', 'x', '--target', 'y', '--support-end', '2097-03']]
  ])('exits 2 on a usage error: %s', (_label, args) => {
    expectRun(runHelper(args), { exit: 2, stderr: 'kit-support.txt: usage: node scripts/lib/write-kit-support.mjs --target <drive root> --support-end <YYYY-MM> [--check]' })
  }, testBudgetMs(60_000))
})
