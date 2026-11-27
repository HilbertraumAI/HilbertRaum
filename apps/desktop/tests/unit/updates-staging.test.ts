import { afterEach, describe, expect, it, vi } from 'vitest'

// Staging, the drive side of an update import and of the start (app-update T6.2 part 1; F-5, F-18's staging half, F-21's
// refusal; docs/app-updates.md §3.5, §3.6, §4.2, §4.5, §4.6, §4.7): staging.ts's own API over the import's case table
// (tests/fixtures/updates/import/cases.json, T6.0b) on a real scratch file system, the F-5 goldens (f5-staged.json) and
// rows of its own for the link rule, the retries and the yields. Every expected value comes from the fixtures, written
// from the record before this code existed (their PROVENANCE.md files); none comes from the code under test. The test
// plays the update service's part (T6.2 part 2): it calls staging's checks in the record's order around the reader
// (bundle.ts, T6.1), hands the reader the two folders the data pass's start made, and formats the update.log lines from
// the facts each verdict carries. The cases whose deciding step is the service's (the key set, the policy, the order of
// the checks, a run already going, the dialog, the old-file token, cancel, the status, the start's synchronous part and
// its timing) are listed below for part 2 and T6.3. Links are made by the test: a folder link is a junction on Windows (no
// privilege needed) and, where this machine allows one, a symbolic link; a symbolic link to a file needs Windows'
// symbolic-link privilege, so those cases run where it can be made (CI's ubuntu and macOS legs at least).
//
// Two seams, both module imports replaced by vi.mock and nothing else: node:timers/promises' setTimeout (the retry waits
// of fs-retry.ts's schedule and of the probe return at once and are recorded) and node:crypto's randomBytes (a queue of
// scripted answers for the cleared line's token, the real function once the queue is empty).
const seams = vi.hoisted(() => ({ waits: [] as number[], tokens: [] as Buffer[] }))
vi.mock('node:timers/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:timers/promises')>()
  const mocked = {
    ...orig,
    setTimeout: async (ms?: number) => {
      seams.waits.push(Number(ms))
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>()
  const randomBytes = ((size: number) => seams.tokens.shift() ?? orig.randomBytes(size)) as typeof orig.randomBytes
  const mocked = { ...orig, randomBytes }
  return { ...mocked, default: mocked }
})

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openFile, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { readUpdateFile, type BundleFileSystem, type CheckedUpdateFile } from '../../src/main/services/updates/bundle'
import type { UpdateKey } from '../../src/main/services/updates/envelope'
import { formatRegisteredLine } from '../../src/main/services/updates/update-log'
import {
  NODE_STAGING_FS,
  carryOutSweep,
  checkBeforeDataPass,
  checkDriveBeforeDialog,
  commitStaged,
  discardStaged,
  discardedLogFields,
  planSweep,
  removeStagingFolders,
  startDataPass,
  sweptLogFields,
  type StagingContext,
  type StagingFileHandle,
  type StagingFileSystem,
  type StagingFolders,
  type UpdatesDrive
} from '../../src/main/services/updates/staging'
import type { StagingRefused } from '../../src/shared/updates/import-types'
import { buildCaseFile, bytesOf, IMPORT_FIXTURES, loadImportCases, makeBundleSigners, type BytesSpec, type ImportCase } from '../helpers/update-bundles'
import { hostOf, keySet, payloadInput, type Host } from '../helpers/update-inputs'
import { FOLDER_LINKS, type FolderLink } from '../helpers/folder-links'
import { DESKTOP_ROOT } from '../helpers/repo-files'

const UPDATES_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates')
const table = loadImportCases()
const signers = makeBundleSigners() // in memory; nothing of them is written
const isWindows = process.platform === 'win32'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const TEST_KEYS = keySet([signers.test.spki.toString('base64')])

afterEach(() => {
  seams.waits = []
  seams.tokens = []
})

// ---- the case table's host (cases.json `schema.host`) and the payload check's input: the shared inputs of
// tests/helpers/update-inputs.ts

/** What the service hands the reader (T6.1): node:fs/promises itself. */
const BUNDLE_FS: BundleFileSystem = { open: (path, flags) => openFile(path, flags), rename, unlink }

// ---- a scratch drive, planted as a case's `drive` says

interface Drive {
  dir: string
  root: string
  outside: string
  /** A case path (`updates/…`, `<outside>/…`) on this drive. */
  at(path: string): string
  /** A path on this drive as a case writes it, for messages and rules. */
  rel(path: string): string
}

/** A drive root whose text with its trailing separator is `length` characters (hostSet.rootLength), or any short one. */
function rootOf(dir: string, length: number | undefined): string {
  if (length === undefined) return join(dir, 'drive')
  let root = dir
  while (root.length + 1 + 1 < length - 1) {
    const room = length - 1 - root.length - 1
    root = join(root, 'r'.repeat(Math.min(room, 200)))
  }
  expect(root.length + 1, `a root of ${length} characters`).toBe(length)
  return root
}

function makeDrive(host: Host): Drive {
  const dir = mkdtempSync(join(tmpdir(), 'hr-updates-staging-'))
  const root = rootOf(dir, host.rootLength)
  const outside = join(dir, 'outside')
  mkdirSync(join(root, 'config'), { recursive: true })
  if (host.prepared !== false) writeFileSync(join(root, 'config', 'drive.json'), '{}')
  mkdirSync(outside)
  const at = (path: string): string =>
    path.startsWith('<outside>/') ? join(outside, ...path.slice('<outside>/'.length).split('/')) : join(root, ...path.split('/'))
  const rel = (path: string): string => relative(root, path).split(sep).join('/')
  return { dir, root, outside, at, rel }
}

/** A data name of the table, or a bytes spec. */
const dataOf = (spec: unknown): Buffer => bytesOf((typeof spec === 'string' ? table.data[spec] : spec) as BytesSpec)

/** The standard payload's `files[]`: the entries a planted staged update lists (its groups included). */
const STD_FILES = (JSON.parse(table.payloads.std as string) as { files: Array<{ name: string; size: number; sha256: string; group?: string }> }).files

/**
 * `{staged: <v>, bundle: <set>}` (cases.json `schema.drive`): updates/staging/<v>/ with files/<each member of the set
 * after the envelope>, the 2-byte envelope `{}`, and staged.txt and staged.json written here by record §4.6's rules (the
 * standard payload's entries for the members present, in its order, each `group` it gives).
 */
function plantStaged(drive: Drive, version: string, set: string): void {
  const members = table.sets[set]!.slice(1)
  const entries = STD_FILES.filter((f) => members.some((m) => m.name === f.name))
  const dir = drive.at(`updates/staging/${version}`)
  mkdirSync(join(dir, 'files'), { recursive: true })
  for (const m of members) {
    const bytes = dataOf(m.data)
    expect(sha256(bytes), m.name).toBe(entries.find((e) => e.name === m.name)!.sha256)
    writeFileSync(join(dir, 'files', m.name), bytes)
  }
  writeFileSync(join(dir, 'hilbertraum-release.dsse.json'), '{}')
  writeFileSync(join(dir, 'staged.txt'), entries.map((e) => `${e.size} ${e.name}\n`).join(''))
  const listed = entries.map(({ name, size, sha256: hash, group }) => (group === undefined ? { name, size, sha256: hash } : { name, size, sha256: hash, group }))
  writeFileSync(join(dir, 'staged.json'), JSON.stringify({ format: 1, version, files: listed }))
}

/** A folder link of the case's kind on this machine: the junction on Windows (the default), a symbolic link elsewhere. */
const DEFAULT_FOLDER_LINK: FolderLink = (target, link) => symlinkSync(target, link, isWindows ? 'junction' : 'dir')

function plant(drive: Drive, c: ImportCase, folderLink: FolderLink = DEFAULT_FOLDER_LINK): void {
  for (const item of (c.drive ?? []) as Array<Record<string, unknown>>) {
    if (typeof item.staged === 'string') {
      plantStaged(drive, item.staged, item.bundle as string)
      continue
    }
    const at = drive.at((item.dir ?? item.file ?? item.link ?? item.hardlink) as string)
    if (typeof item.dir === 'string') {
      mkdirSync(at, { recursive: true })
      continue
    }
    mkdirSync(dirname(at), { recursive: true })
    if (typeof item.file === 'string') writeFileSync(at, dataOf(item.data))
    else if (typeof item.link === 'string' && item.target === 'dir') folderLink(drive.at(item.to as string), at)
    else if (typeof item.link === 'string') symlinkSync(drive.at(item.to as string), at, 'file')
    else linkSync(drive.at(item.to as string), at)
  }
}

/** A tree as lstat sees it, never through a link: a link by its target text, a folder by its entries, a file by its sha256. */
function snapshot(path: string): unknown {
  let info
  try {
    info = lstatSync(path)
  } catch {
    return 'absent'
  }
  if (info.isSymbolicLink()) return { link: readlinkSync(path) }
  if (info.isDirectory()) return { dir: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) }
  return { file: sha256(readFileSync(path)) }
}

const isAbsent = (path: string): boolean => {
  try {
    lstatSync(path)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

const canLinkFile = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-updates-staging-can-'))
  try {
    writeFileSync(join(dir, 'f'), '')
    symlinkSync(join(dir, 'f'), join(dir, 'l'), 'file')
    return true
  } catch {
    return false
  }
})()
const needsFileLink = (c: ImportCase): boolean => (c.drive ?? []).some((item) => typeof item.link === 'string' && item.target === 'file')
const hasFolderLink = (c: ImportCase): boolean => (c.drive ?? []).some((item) => typeof item.link === 'string' && item.target === 'dir')

// ---- the file-system calls staging is handed: node's own, through a recorder that causes a case's faults

const injected = (code: string, syscall: string): Error => Object.assign(new Error(`injected ${code}`), { code, syscall })

type FsCall = 'readdir' | 'lstat' | 'realpath' | 'mkdir' | 'rmdir' | 'unlink' | 'open' | 'rename' | 'statfs' | 'read' | 'write' | 'sync' | 'close'

interface Rule {
  call: FsCall
  /** The case path (drive-relative, `/`) the call is made on (for a rename: its source). */
  when: (rel: string) => boolean
  /** Thrown instead of the call (after `before`, when both are given); without it the call goes through. */
  error?: Error
  /** Run right before the real call: the drive changes under it (a name removed, swapped or made meanwhile). */
  before?: (path: string) => void
  /** For a write: at most this many bytes are written (0: none), the call itself real. */
  short?: number
  /** Applied this many times, then the call goes through untouched (default: always). */
  times?: number
}

interface Recorded {
  fs: StagingFileSystem
  /** Every call, in order: `<call> <drive-relative path>`. */
  calls: string[]
  /** Every path a call wrote, created, moved or removed (drive-relative). */
  writes: string[]
  /** Every open, with the flags it was given. */
  opens: Array<{ rel: string; flags: number | string }>
}

const WRITE_FLAG = /[wax+]/
function writesBy(flags: number | string): boolean {
  if (typeof flags === 'string') return WRITE_FLAG.test(flags)
  return (flags & 3) !== 0 || (flags & 64) !== 0 // O_WRONLY or O_RDWR, or O_CREAT
}

function recorded(drive: Drive, rules: readonly Rule[] = [], statfs?: { bsize: number; bavail: number }): Recorded {
  const calls: string[] = []
  const writes: string[] = []
  const opens: Recorded['opens'] = []
  const left = new Map(rules.map((rule) => [rule, rule.times ?? Infinity]))
  /** Records the call and applies the first rule that matches: its `before`, then its error; answers the rule (for `short`). */
  const check = (call: FsCall, path: string): Rule | null => {
    const rel = drive.rel(path)
    calls.push(`${call} ${rel}`)
    for (const rule of rules) {
      if (rule.call !== call || !rule.when(rel) || left.get(rule)! <= 0) continue
      left.set(rule, left.get(rule)! - 1)
      rule.before?.(path)
      if (rule.error !== undefined) throw rule.error
      return rule
    }
    return null
  }
  const real = NODE_STAGING_FS
  const fs: StagingFileSystem = {
    async readdir(path) {
      check('readdir', path)
      return real.readdir(path)
    },
    async lstat(path) {
      check('lstat', path)
      return real.lstat(path)
    },
    async realpath(path) {
      check('realpath', path)
      return real.realpath(path)
    },
    async mkdir(path) {
      check('mkdir', path)
      writes.push(drive.rel(path))
      return real.mkdir(path)
    },
    async rmdir(path) {
      check('rmdir', path)
      writes.push(drive.rel(path))
      return real.rmdir(path)
    },
    async unlink(path) {
      check('unlink', path)
      writes.push(drive.rel(path))
      return real.unlink(path)
    },
    async rename(from, to) {
      check('rename', from)
      writes.push(drive.rel(from), drive.rel(to))
      return real.rename(from, to)
    },
    async statfs(path) {
      check('statfs', path)
      return statfs ?? real.statfs(path)
    },
    async open(path, flags) {
      check('open', path)
      opens.push({ rel: drive.rel(path), flags })
      if (writesBy(flags)) writes.push(drive.rel(path))
      const handle = await real.open(path, flags)
      const wrapped: StagingFileHandle = {
        stat: () => handle.stat(),
        async read(buffer, offset, length, position) {
          check('read', path)
          return handle.read(buffer, offset, length, position)
        },
        async write(buffer, offset, length) {
          const rule = check('write', path)
          return handle.write(buffer, offset, rule?.short === undefined ? length : Math.min(length, rule.short))
        },
        async sync() {
          check('sync', path)
          return handle.sync()
        },
        async close() {
          // The handle is closed for real first, so a close a rule fails leaves no open file behind.
          await handle.close()
          check('close', path)
        }
      }
      return wrapped
    }
  }
  return { fs, calls, writes, opens }
}

/** Nothing is written outside `updates/` (the brief core): every path a call wrote lies under it (in any letter case, as
 *  a file system that folds case finds `Updates/`). */
function expectWritesUnderUpdates(rec: Recorded): void {
  for (const path of rec.writes) expect(/^updates(\/|$)/i.test(path), `written outside updates/: ${path}`).toBe(true)
}

// ---- how each case with an `inject` is caused here (the coverage row fails on a gap)

interface Setup {
  rules?: (c: ImportCase, drive: Drive) => Rule[]
  tokens?: Buffer[]
  /** The thrown error the refusal carries where the case's line cannot be written (its `note` names the fields). */
  cause?: { code: string; syscall: string }
  /** The sweep's removals that fail (reported in app.log only). */
  failures?: number
}

/** The fault a case's `inject` names, with the code and the system call the case gives. */
function namedFault(c: ImportCase): Error {
  const inject = c.inject?.[0] as { code?: string; syscall?: string } | undefined
  expect(inject?.code, `${c.id} names no code`).toBeTypeOf('string')
  return injected(inject!.code!, inject!.syscall!)
}
const at = (call: FsCall, test: (rel: string) => boolean) => (c: ImportCase): Rule[] => [{ call, when: test, error: namedFault(c) }]
const isProbe = (rel: string): boolean => rel === 'updates/.write-probe'

const SETUPS: Readonly<Record<string, Setup>> = {
  'pre-updates-mkdir-enospc': { rules: at('mkdir', (rel) => rel === 'updates'), cause: { code: 'ENOSPC', syscall: 'mkdir' } },
  'pre-updates-mkdir-erofs': { rules: at('mkdir', (rel) => rel === 'updates'), cause: { code: 'EROFS', syscall: 'mkdir' } },
  // Nothing is at updates/, so every lstat and listing answers ENOENT as the case says; only the mkdir is told EEXIST.
  'pre-updates-mkdir-eexist-then-nothing': { rules: at('mkdir', (rel) => rel === 'updates'), cause: { code: 'EEXIST', syscall: 'mkdir' } },
  'pre-probe-enospc': { rules: at('write', isProbe) },
  'pre-probe-erofs': { rules: at('open', isProbe) },
  'pre-probe-other-failure': { rules: at('open', isProbe) },
  'pre-order-probe-before-margin': { rules: at('open', isProbe) },
  'probe-final-delete-fails-ignored': { rules: at('unlink', isProbe) },
  'pre-staging-listing-fails': { rules: at('readdir', (rel) => rel === 'updates') },
  'pre-updates-listing-fails': { rules: at('readdir', (rel) => rel === '') },
  'space-statfs-fails': { rules: at('statfs', () => true) },
  'commit-cleared-append-fails': { rules: at('write', (rel) => rel === 'updates/last-result.txt') },
  'commit-marker-write-fails': { rules: at('rename', (rel) => rel === 'updates/staging/1.1.0/staged.json.tmp') },
  // The first draw is the last valid line's token (and last-result.seen's): it is drawn again.
  'commit-cleared-token-avoids-seen': { tokens: [Buffer.from('0123456789abcdef', 'hex')] },
  'start-removal-fails': {
    rules: (c) => (['unlink', 'rmdir'] as const).map((call) => ({ call, when: (rel: string) => rel.startsWith('updates/staging/'), error: namedFault(c) })),
    failures: 1
  },
  'start-stat-fails-entry-left': { rules: at('read', (rel) => rel === 'updates/staging/1.1.0/staged.json') },
  'discard-removal-fails': { rules: at('unlink', (rel) => rel.startsWith('updates/staging/1.1.0/files/')) }
}

// ---- comparing a run with a case's `expect`

interface After {
  staged?: string | null
  stagedTxt?: string
  stagedJson?: string
  names?: string[]
  stagingEntries?: string[]
  absent?: string[]
  unchanged?: string[]
  lastResult?: { appended: string | null; pattern?: string; tokenNot?: string[] }
}
interface Expect {
  answer?: string
  code?: string
  params?: Record<string, unknown>
  dialog?: boolean | 'closed'
  log?: { event: string; fields: Record<string, string> } | null
  after?: After
  status?: { staged: { version: string } | null; notice: unknown; inProgress?: boolean }
  lines?: string[]
  removed?: string[]
  unchanged?: string[]
}

/** What the drive held before the run, for `unchanged` and `lastResult`. */
function before(drive: Drive, e: Expect): { trees: Map<string, unknown>; lastResult: Buffer | null } {
  const trees = new Map<string, unknown>()
  for (const path of [...(e.after?.unchanged ?? []), ...(e.unchanged ?? [])]) trees.set(path, snapshot(drive.at(path)))
  const lastResult = isAbsent(drive.at('updates/last-result.txt')) ? null : readFileSync(drive.at('updates/last-result.txt'))
  return { trees, lastResult }
}

/** The version staged on the drive by its marker (read here, not by staging.ts): the one `staged.json` under updates/staging/. */
function stagedVersions(drive: Drive): string[] {
  const staging = drive.at('updates/staging')
  if (isAbsent(staging) || !lstatSync(staging).isDirectory()) return []
  return readdirSync(staging).flatMap((name) => {
    const marker = join(staging, name, 'staged.json')
    try {
      return [(JSON.parse(readFileSync(marker, 'utf8')) as { version: string }).version]
    } catch {
      return []
    }
  })
}

function expectAfter(drive: Drive, e: Expect, was: ReturnType<typeof before>): void {
  const after = e.after ?? {}
  for (const path of [...(after.absent ?? []), ...(e.removed ?? [])]) expect(isAbsent(drive.at(path)), `${path} is absent`).toBe(true)
  for (const [path, tree] of was.trees) expect(snapshot(drive.at(path)), `${path} is unchanged`).toEqual(tree)
  if (after.staged !== undefined) expect(stagedVersions(drive)).toEqual(after.staged === null ? [] : [after.staged])
  const stagedDir = (name: string): string => drive.at(`updates/staging/${after.staged}/${name}`)
  if (after.stagedTxt !== undefined) expect(readFileSync(stagedDir('staged.txt'), 'latin1')).toBe(after.stagedTxt)
  if (after.stagedJson !== undefined) expect(readFileSync(stagedDir('staged.json'), 'latin1')).toBe(after.stagedJson)
  if (after.names !== undefined) expect(readdirSync(drive.at(`updates/staging/${after.staged}`)).sort()).toEqual([...after.names].sort())
  if (after.stagingEntries !== undefined) expect(readdirSync(drive.at('updates/staging')).sort()).toEqual([...after.stagingEntries].sort())
  if (after.lastResult !== undefined) {
    const now = readFileSync(drive.at('updates/last-result.txt'))
    expect(now.subarray(0, was.lastResult!.length).equals(was.lastResult!)).toBe(true)
    const appended = now.subarray(was.lastResult!.length).toString('latin1')
    if (after.lastResult.appended === null) expect(appended).toBe('')
    else {
      expect(appended).toMatch(new RegExp(after.lastResult.pattern!))
      for (const token of after.lastResult.tokenNot ?? []) expect(appended).not.toContain(token)
    }
  }
}

/** A refusal of staging's: the code and its parameters, and the facts its line takes (`link`, `err`, `syscall`). */
function expectRefusal(c: ImportCase, end: { kind: string } | StagingRefused, file: CheckedUpdateFile | null): void {
  const e = c.expect as Expect
  expect(end.kind, `${c.id}: ${JSON.stringify(end)}`).toBe('refused')
  if (end.kind !== 'refused') return
  const refused = end as StagingRefused
  expect({ code: refused.refusal.code, params: refused.refusal.params }).toEqual({ code: e.code, params: e.params })
  const setup = SETUPS[c.id]
  const fields = e.log?.fields
  if (fields === undefined) {
    // No line where the case's drive cannot take one (updates/ missing or not a real folder): the facts are still the
    // refusal's, as the case's note names them, and the name that blocked it is updates/ itself.
    expect(refused.cause, c.id).toEqual(setup?.cause === undefined ? null : setup.cause)
    expect(refused.link).toBe(refused.refusal.code === 'UPD-CANT-WRITE-DRIVE' ? 'updates' : null)
    return
  }
  expect(refused.link, `${c.id}: link`).toBe(fields.link ?? null)
  const cause = refused.cause
  if (fields.err === '<thrown>') {
    expect(cause?.code, `${c.id}: err`).toMatch(/^E[A-Z]+$/)
    expect(cause?.syscall, `${c.id}: syscall`).toMatch(/^[a-z_]+$/)
  } else {
    expect(cause?.code ?? undefined, `${c.id}: err`).toBe(fields.err)
    expect(cause?.syscall ?? undefined, `${c.id}: syscall`).toBe(fields.syscall)
  }
  // The run's own facts (the reader's, T6.1): the version of the file the checks after the dialog refused.
  if (file !== null) expect(file.payload.version).toBe(fields.version)
  else expect(fields.version).toBeUndefined()
}

// ---- running one case

/** The update file of a case, written beside the drive (never on it). */
function caseFile(drive: Drive, c: ImportCase): string {
  const folder = join(drive.dir, 'download')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'update.hrupdate')
  const built = buildCaseFile(table, c.build!, signers)
  expect(built.bytes.length).toBe(c.file!.size)
  writeFileSync(path, built.bytes)
  return path
}

async function runImport(c: ImportCase, folderLink?: FolderLink): Promise<void> {
  const host = hostOf(c)
  const e = c.expect as Expect
  const drive = makeDrive(host)
  plant(drive, c, folderLink)
  const was = before(drive, e)
  const setup = SETUPS[c.id] ?? {}
  seams.tokens = [...(setup.tokens ?? [])]
  const rec = recorded(drive, setup.rules?.(c, drive) ?? [], host.statfs)
  const ctx: StagingContext = { root: drive.root, platform: host.os, fs: rec.fs }

  const pre = await checkDriveBeforeDialog(ctx)
  if (e.dialog === false) expectRefusal(c, pre, null)
  else if (c.build === null) {
    // The probe passed and cleaned up: the run goes on to the dialog (part 2's service), which the case closes.
    expect({ kind: pre.kind, answer: e.answer }).toEqual({ kind: 'ready', answer: 'closed' })
  } else {
    expect(pre.kind, `${c.id}: ${JSON.stringify(pre)}`).toBe('ready')
    const drivePart = (pre as { drive: UpdatesDrive }).drive
    const read = await readUpdateFile(caseFile(drive, c), { keys: TEST_KEYS, input: payloadInput(host), fs: BUNDLE_FS, cancelled: () => false })
    expect(read.kind, c.id).toBe('checked')
    if (read.kind !== 'checked') return
    const file = read.file
    try {
      const version = file.payload.version
      const post = await checkBeforeDataPass(ctx, drivePart, { version, present: file.present })
      if (post.kind === 'refused') expectRefusal(c, post, file)
      else {
        const start = await startDataPass(ctx, drivePart, post.targets, version)
        expect(start.kind, `${c.id}: ${JSON.stringify(start)}`).toBe('ready')
        const folders = (start as { folders: StagingFolders }).folders
        const stage = await file.stage({ incomingDir: folders.incomingDir, filesDir: folders.filesDir, cancelled: () => false, progress: () => undefined })
        expect(stage.kind, c.id).toBe('staged')
        const files = stage.kind === 'staged' ? stage.files : []
        const commit = await commitStaged(ctx, folders, { envelope: file.envelope, files })
        if (commit.kind === 'refused') {
          await removeStagingFolders(ctx, folders)
          expectRefusal(c, commit, file)
        } else {
          expect(e.answer, c.id).toBe('staged')
          expect(String(files.length)).toBe(e.log!.fields.files)
        }
      }
    } finally {
      await file.close()
    }
  }
  expectAfter(drive, e, was)
  expectWritesUnderUpdates(rec)
}

async function runStart(c: ImportCase, folderLink?: FolderLink): Promise<void> {
  const host = hostOf(c)
  const e = c.expect as Expect
  const drive = makeDrive(host)
  plant(drive, c, folderLink)
  const was = before(drive, e)
  const setup = SETUPS[c.id] ?? {}
  const rec = recorded(drive, setup.rules?.(c, drive) ?? [])
  const ctx: StagingContext = { root: drive.root, platform: host.os, fs: rec.fs }
  // The start step's synchronous part (part 2) found updates/ a real folder and updates/applying/ absent.
  expect(e.status!.inProgress).toBe(false)
  const plan = await planSweep(ctx, drive.at('updates'))
  expect({ staged: plan.staged, notice: plan.notice }).toEqual({ staged: e.status!.staged, notice: e.status!.notice })
  const failures = await carryOutSweep(ctx, plan)
  expect(failures.length, `${c.id}: removals that failed`).toBe(setup.failures ?? 0)
  const lines = sweptLogFields(plan).map((fields) => formatRegisteredLine('staging-swept', fields, { platform: host.os, now: new Date(host.now) }))
  expect(lines).toEqual(e.lines)
  expectAfter(drive, e, was)
  for (const path of rec.writes) expect(/^updates\/staging\//.test(path), `the sweep wrote ${path}`).toBe(true)
}

async function runDiscard(c: ImportCase, folderLink?: FolderLink): Promise<void> {
  const host = hostOf(c)
  const e = c.expect as Expect
  const drive = makeDrive(host)
  plant(drive, c, folderLink)
  const was = before(drive, e)
  const setup = SETUPS[c.id] ?? {}
  const rec = recorded(drive, setup.rules?.(c, drive) ?? [])
  const ctx: StagingContext = { root: drive.root, platform: host.os, fs: rec.fs }
  // The staged update the start step noted: the planted one (the service's state, part 2).
  const planted = (c.drive ?? []).find((item) => typeof item.staged === 'string')?.staged as string | undefined
  const request = JSON.parse(/^discardStaged\((.*)\)$/.exec(c.calls![0]!)![1]!) as unknown
  const end = await discardStaged(ctx, planted === undefined ? null : { version: planted }, request)
  const answer = end.kind === 'refused' ? { answer: 'refused', code: end.refusal.code, params: end.refusal.params } : { answer: end.kind }
  expect(answer).toEqual(e.answer === 'refused' ? { answer: 'refused', code: e.code, params: e.params } : { answer: e.answer })
  const lines = end.kind === 'discarded' ? [formatRegisteredLine('staging-discarded', discardedLogFields(end.version), { platform: host.os, now: new Date(host.now) })] : []
  expect(lines).toEqual(e.lines)
  expectAfter(drive, e, was)
  expectWritesUnderUpdates(rec)
}

// ---- which cases run here, and which the update service runs: tests/fixtures/updates/import/case-owners.json (T6.2
// part 2; the deciding steps in impl/p6/T6.2/case-split-1.md and case-split-2.md)

const OWNERS = (JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'case-owners.json'), 'utf8')) as { owners: Record<string, string> }).owners
/** The cases whose deciding step is one of staging.ts's functions. */
const RUN_HERE: readonly string[] = table.cases.filter((c) => OWNERS[c.id] === 'staging').map((c) => c.id)
/**
 * The cases the update service runs (updates-service.test.ts): the key set, not a drive, the policy, the order of the
 * checks, the repeated refusal, the start's synchronous part and its wait, a run going, the old-file token, the dialog,
 * the argument, cancel, busy.
 */
const LEFT_TO_SERVICE: readonly string[] = table.cases.filter((c) => OWNERS[c.id] === 'service').map((c) => c.id)

/** T6.1's split rule (updates-bundle.test.ts): the cases the reader leaves. */
const SERVICE_PREFIXES = ['pre-', 'probe-', 'start-', 'discard-', 'commit-', 'space-', 'link-', 'path-', 'token-', 'busy-', 'cancel-']
const SERVICE_CASES = new Set([
  'dialog-closed', 'argument-without-own-token-opens-the-dialog', 'accept-updates-folder-other-case', 'accept-replaces-staged-same-version',
  'accept-commit-removes-other-versions', 'accept-case-only-version-replaces', 'pay-issued-365d-1s-confirmed'
])
const LEFT_BY_THE_READER = table.cases.filter((c) => SERVICE_PREFIXES.some((p) => c.id.startsWith(p)) || SERVICE_CASES.has(c.id)).map((c) => c.id)

const caseOf = (id: string): ImportCase => table.cases.find((c) => c.id === id)!
/** `accept-updates-folder-other-case` holds where the file system folds case: the record's NTFS reading, on Windows. */
const FOLDS_CASE_ONLY = new Set(['accept-updates-folder-other-case'])
const runnable = (c: ImportCase): boolean => (!needsFileLink(c) || canLinkFile) && (!FOLDS_CASE_ONLY.has(c.id) || isWindows)
const HERE = RUN_HERE.map(caseOf)

async function runCase(c: ImportCase, folderLink?: FolderLink): Promise<void> {
  if (c.kind === 'start') return runStart(c, folderLink)
  if (c.kind === 'discard') return runDiscard(c, folderLink)
  return runImport(c, folderLink)
}

describe('the import case table through staging.ts (tests/fixtures/updates/import/cases.json; record §4.2, §4.5, §4.6, §4.7)', () => {
  it('the split is pinned: of the 159 cases the reader leaves, 126 run here and 33 in the service\u{2019}s file, each once, as case-owners.json gives them', () => {
    expect({ left: LEFT_BY_THE_READER.length, here: RUN_HERE.length, service: LEFT_TO_SERVICE.length }).toEqual({ left: 159, here: 126, service: 33 })
    expect(new Set([...RUN_HERE, ...LEFT_TO_SERVICE]).size).toBe(159)
    expect([...RUN_HERE, ...LEFT_TO_SERVICE].sort()).toEqual([...LEFT_BY_THE_READER].sort())
    expect(HERE.every((c) => c !== undefined && (c.kind === 'import' || c.kind === 'start' || c.kind === 'discard'))).toBe(true)
    // Every injected fault among them has its setup here.
    expect(HERE.filter((c) => c.inject !== undefined && SETUPS[c.id] === undefined).map((c) => c.id)).toEqual([])
  })

  it('a planted staged update is what record §4.6 writes: the standard set\u{2019}s staged.json is the expected one byte for byte', () => {
    const drive = makeDrive(hostOf(caseOf('accept-replaces-staged-same-version')))
    plantStaged(drive, '1.1.0', 'std')
    expect(readFileSync(drive.at('updates/staging/1.1.0/staged.json'), 'latin1')).toBe((caseOf('space-at-the-formula').expect as Expect).after!.stagedJson)
    expect(readFileSync(drive.at('updates/staging/1.1.0/staged.txt'), 'latin1')).toBe((caseOf('space-at-the-formula').expect as Expect).after!.stagedTxt)
  })

  it.each(HERE.filter(runnable).map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    await runCase(c)
  })

  // The cases a symbolic link to a file decides (CI's ubuntu and macOS legs, or a Windows box with the privilege).
  it.runIf(!canLinkFile)('the cases that need a symbolic link to a file are the four this box cannot make', () => {
    expect(HERE.filter(needsFileLink).map((c) => c.id).sort()).toEqual(
      ['commit-last-result-is-a-link', 'probe-link-removed-not-followed', 'start-invalid-marker-is-a-link', 'start-member-is-a-link'].sort()
    )
  })
})

// ---- the link rule: every case with a folder link again with every other folder link this machine can make

describe('every case with a folder link, once per other kind of folder link (record §4.5 "Links under updates/"; T6.0 S-2)', () => {
  // FOLDER_LINKS (tests/helpers/folder-links.ts): a junction on Windows, the two junction forms Node's lstat reads as a
  // plain folder (a volume GUID path, a \Device path), and a symbolic link to a folder where this machine allows one. The
  // junction is the table's own run above; each other kind is run here.
  const defaultKind = isWindows ? 'a junction' : 'a symbolic link'
  const kinds = FOLDER_LINKS.filter(([label, , can]) => can && label !== defaultKind)
  const rows = HERE.filter((c) => hasFolderLink(c) && runnable(c)).flatMap((c) => kinds.map(([label, make]) => [c.id, label, c, make] as const))
  if (rows.length > 0) {
    it.each(rows)('%s with %s', async (_id, _label, c, make) => {
      await runCase(c, make)
    })
  } else {
    it.skip('no other kind of folder link can be made on this machine', () => undefined)
  }
})

// ---- the staging rows of their own

/** A fresh scratch drive (the win32 host's), with nothing planted. */
const freshDrive = (): Drive => makeDrive(table.hosts.win32 as unknown as Host)
const contextOf = (drive: Drive, rec: Recorded, platform: NodeJS.Platform = 'win32'): StagingContext => ({ root: drive.root, platform, fs: rec.fs })
const FOLDER_KINDS = FOLDER_LINKS.filter(([, , can]) => can).map(([label, make]) => [label, make] as const)

/** A link target outside the drive with one file in it, and its snapshot. */
function linkTarget(drive: Drive, name: string): { path: string; tree: unknown } {
  const path = join(drive.outside, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'keep.txt'), `keep ${name}`)
  return { path, tree: snapshot(path) }
}

/**
 * A staged update of version 1.1.0 (the standard set) with a folder link at every level the removal walk visits:
 * `<v>/link-a`, `<v>/files/link-b`, and `<v>/files/sub/link-c` under a real sub-folder; a symbolic link to a file in
 * `files/` where this machine can make one. Returns the targets, each with its snapshot.
 */
function linksAtEveryLevel(drive: Drive, make: FolderLink, folder: string): Array<{ path: string; tree: unknown }> {
  const targets = ['a', 'b', 'c'].map((name) => linkTarget(drive, name))
  const dir = drive.at(`updates/staging/${folder}`)
  mkdirSync(join(dir, 'files', 'sub'), { recursive: true })
  make(targets[0]!.path, join(dir, 'link-a'))
  make(targets[1]!.path, join(dir, 'files', 'link-b'))
  make(targets[2]!.path, join(dir, 'files', 'sub', 'link-c'))
  if (canLinkFile) {
    const file = join(drive.outside, 'file.txt')
    writeFileSync(file, 'keep the file')
    symlinkSync(file, join(dir, 'files', 'file-link'), 'file')
    targets.push({ path: file, tree: snapshot(file) })
  }
  return targets
}

describe('the removal walk and the sweep never follow a link (record §4.5 "Links under updates/", T6.0 S-2, contract item 3)', () => {
  it.each(FOLDER_KINDS)('discarding a staged update removes %s at every level by its own name, never what it reaches', async (_label, make) => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const targets = linksAtEveryLevel(drive, make, '1.1.0')
    const rec = recorded(drive)
    expect(await discardStaged(contextOf(drive, rec), { version: '1.1.0' }, { version: '1.1.0' })).toEqual({ kind: 'discarded', version: '1.1.0' })
    expect(isAbsent(drive.at('updates/staging/1.1.0'))).toBe(true)
    for (const t of targets) expect(snapshot(t.path), t.path).toEqual(t.tree)
    expectWritesUnderUpdates(rec)
  })

  it.each(FOLDER_KINDS)('the sweep removes a cut <w>/ and an .incoming-<w>/ holding %s at every level, never what it reaches', async (_label, make) => {
    const drive = freshDrive()
    const targets = [...linksAtEveryLevel(drive, make, '1.1.0'), ...linksAtEveryLevel(drive, make, '.incoming-1.2.0')]
    const rec = recorded(drive)
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect(plan.counts).toMatchObject({ incoming: 1, 'no-marker': 1, link: 0 })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(readdirSync(drive.at('updates/staging'))).toEqual([])
    for (const t of targets) expect(snapshot(t.path), t.path).toEqual(t.tree)
    for (const path of rec.writes) expect(path.startsWith('updates/staging/'), path).toBe(true)
  })

  it.each(FOLDER_KINDS)('%s at the name of <v>/: the discard refuses UPD-CANT-WRITE-DRIVE and leaves the link and its target', async (_label, make) => {
    const drive = freshDrive()
    const target = linkTarget(drive, 'elsewhere')
    writeFileSync(join(target.path, 'staged.json'), '{}')
    const tree = snapshot(target.path)
    mkdirSync(drive.at('updates/staging'), { recursive: true })
    make(target.path, drive.at('updates/staging/1.1.0'))
    const link = lstatSync(drive.at('updates/staging/1.1.0')).isSymbolicLink() ? readlinkSync(drive.at('updates/staging/1.1.0')) : null
    const rec = recorded(drive)
    const end = await discardStaged(contextOf(drive, rec), { version: '1.1.0' }, { version: '1.1.0' })
    expect(end).toEqual({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: null })
    expect(isAbsent(drive.at('updates/staging/1.1.0'))).toBe(false)
    if (link !== null) expect(readlinkSync(drive.at('updates/staging/1.1.0'))).toBe(link)
    expect(snapshot(target.path)).toEqual(tree)
    expect(rec.writes).toEqual([])
  })

  it.each(FOLDER_KINDS)('updates/staging/ that is %s: nothing is swept or listed through it (reason=link, n=1)', async (_label, make) => {
    const drive = freshDrive()
    const target = linkTarget(drive, 'elsewhere')
    mkdirSync(join(target.path, '.incoming-1.1.0'))
    mkdirSync(drive.at('updates'))
    make(target.path, drive.at('updates/staging'))
    const tree = snapshot(target.path)
    const rec = recorded(drive)
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect(plan.counts).toEqual({ incoming: 0, 'no-marker': 0, 'invalid-marker': 0, 'member-missing': 0, 'not-a-folder': 0, link: 1 })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(snapshot(target.path)).toEqual(tree)
    expect(rec.calls.filter((call) => call.startsWith('readdir ')).map((call) => call.slice(8))).toEqual(['updates'])
    expect(rec.writes).toEqual([])
  })

  it.each(FOLDER_KINDS.flatMap(([label, make]) => [['updates', label, make], ['updates/staging', label, make]] as const))(
    '%s that is %s refuses the import before the dialog, and the probe writes nothing through it',
    async (name, _label, make) => {
      const drive = freshDrive()
      const target = linkTarget(drive, 'elsewhere')
      mkdirSync(dirname(drive.at(name)), { recursive: true })
      make(target.path, drive.at(name))
      const rec = recorded(drive)
      const end = await checkDriveBeforeDialog(contextOf(drive, rec))
      expect(end).toEqual({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: null, link: name === 'updates' ? 'updates' : 'staging' })
      expect(snapshot(target.path)).toEqual(target.tree)
      expect(rec.writes).toEqual([])
    }
  )

  // Contract item 3's source row (T6.0 S-2): Node's recursive rm enters a Windows junction that lstat reads as a folder, so
  // the new modules remove only by their lstat walk. The cheapest guard of that rule is the text itself.
  it('no recursive rm in staging.ts or last-result.ts', () => {
    for (const name of ['staging.ts', 'last-result.ts']) {
      // The code alone: the header's prose names the rule it keeps.
      const code = readFileSync(join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(code, name).not.toMatch(/\brm(?:Sync)?\s*\(|\brecursive\s*:/)
      expect(code, name).not.toMatch(/^import [^\n]*\brm\b/m)
    }
  })
})

// ---- the asynchronous part never holds the main process: a yield between entries

/** An in-memory tree of empty folders whose every call answers at once (a resolved promise), so only the walk's own
 *  yields let the event loop run (T6.1 S-b: such a fake must never meet a loop that does not yield). */
function memoryFolders(root: string, folders: readonly string[]): StagingFileSystem {
  const dirs = new Set([root, ...folders.map((f) => join(root, ...f.split('/')))])
  const dirStats = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0n, nlink: 1n, ino: 1n, dev: 1n }
  const noEntry = (syscall: string): Error => injected('ENOENT', syscall)
  return {
    readdir: async (path) => [...dirs].filter((d) => dirname(d) === path && d !== path).map((d) => d.slice(path.length + 1)),
    lstat: async (path) => {
      if (!dirs.has(path)) throw noEntry('lstat')
      return dirStats
    },
    realpath: async (path) => path,
    mkdir: async () => {
      throw injected('EROFS', 'mkdir')
    },
    rmdir: async (path) => {
      if ([...dirs].some((d) => dirname(d) === path && d !== path)) throw injected('ENOTEMPTY', 'rmdir')
      if (!dirs.delete(path)) throw noEntry('rmdir')
    },
    unlink: async () => {
      throw noEntry('unlink')
    },
    open: async () => {
      throw noEntry('open')
    },
    rename: async () => {
      throw noEntry('rename')
    },
    statfs: async () => {
      throw injected('ENOSYS', 'statfs')
    }
  }
}

/** How many turns of the event loop pass while `work` runs. */
async function turnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0
  let done = false
  const tick = (): void => {
    if (done) return
    turns++
    setImmediate(tick)
  }
  setImmediate(tick)
  await work()
  done = true
  return turns
}

describe('the sweep and the removal walk yield to the event loop between entries (record §4.5 "The start step"; T6.0 fix 3, P-1)', () => {
  const N = 40
  const root = join(tmpdir(), 'hr-updates-staging-memory', 'drive')

  it(`the sweep\u{2019}s reads and its removals of ${N} cut .incoming folders let the event loop run between entries`, async () => {
    const fs = memoryFolders(root, ['updates', 'updates/staging', ...Array.from({ length: N }, (_, i) => `updates/staging/.incoming-1.0.${i}`)])
    const ctx: StagingContext = { root, platform: 'win32', fs }
    let plan: Awaited<ReturnType<typeof planSweep>> | null = null
    expect(await turnsDuring(async () => (plan = await planSweep(ctx, join(root, 'updates'))))).toBeGreaterThanOrEqual(N)
    expect(plan!.counts.incoming).toBe(N)
    expect(await turnsDuring(() => carryOutSweep(ctx, plan!))).toBeGreaterThanOrEqual(N)
    expect(await fs.readdir(join(root, 'updates', 'staging'))).toEqual([])
  })

  it(`the discard\u{2019}s removal walk of a folder of ${N} sub-folders lets the event loop run between entries`, async () => {
    const fs = memoryFolders(root, ['updates', 'updates/staging', 'updates/staging/1.1.0', ...Array.from({ length: N }, (_, i) => `updates/staging/1.1.0/d${i}`)])
    const ctx: StagingContext = { root, platform: 'win32', fs }
    let end: Awaited<ReturnType<typeof discardStaged>> | null = null
    expect(await turnsDuring(async () => (end = await discardStaged(ctx, { version: '1.1.0' }, { version: '1.1.0' })))).toBeGreaterThanOrEqual(N)
    expect(end).toEqual({ kind: 'discarded', version: '1.1.0' })
  })
})

// ---- the retries (record §4.2 updates/.write-probe: "as §4.5's moves are"; §4.5 "Links under updates/": removeRetry's budget)

describe('Windows retries a held name; macOS and Linux do not (record §4.2, §4.5; services/fs-retry.ts)', () => {
  const held = (call: FsCall, times: number, code = 'EBUSY', syscall = call): Rule => ({ call, when: isProbe, error: injected(code, syscall), times })

  it.each(['win32', 'linux'] as const)('a leftover at the probe\u{2019}s name held three times (EBUSY), on %s', async (platform) => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates'))
    writeFileSync(drive.at('updates/.write-probe'), 'old')
    const rec = recorded(drive, [held('unlink', 3)])
    const end = await checkDriveBeforeDialog(contextOf(drive, rec, platform))
    if (platform === 'win32') {
      expect(end.kind).toBe('ready')
      expect(seams.waits).toEqual([50, 100, 200])
      expect(isAbsent(drive.at('updates/.write-probe'))).toBe(true)
    } else {
      expect(end).toEqual({ kind: 'refused', refusal: { code: 'UPD-DRIVE-READ-ONLY', params: {} }, cause: { code: 'EBUSY', syscall: 'unlink' }, link: null })
      expect(seams.waits).toEqual([])
    }
  })

  // E:'s measurement (impl/p6/T6.2/e-measurements.md): on exFAT a leftover a scanner holds with FILE_SHARE_DELETE stays
  // at its name after its unlink, and the open answers EPERM until the holder lets go.
  it('an open that stays EPERM (a name pending delete) is tried for the moves\u{2019} budget, then answers UPD-DRIVE-READ-ONLY', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates'))
    const rec = recorded(drive, [held('open', Infinity, 'EPERM')])
    const end = await checkDriveBeforeDialog(contextOf(drive, rec, 'win32'))
    expect(end).toEqual({ kind: 'refused', refusal: { code: 'UPD-DRIVE-READ-ONLY', params: {} }, cause: { code: 'EPERM', syscall: 'open' }, link: null })
    const waited = seams.waits.reduce((sum, ms) => sum + ms, 0)
    expect(waited).toBeLessThanOrEqual(12_000)
    expect(waited).toBeGreaterThan(11_000)
    expect(Math.max(...seams.waits)).toBe(1_000)
    expect(rec.calls.filter((call) => call === 'open updates/.write-probe').length).toBe(seams.waits.length + 1)
  })

  it('the probe\u{2019}s final delete held for the whole budget is ignored: the drive is no read-only drive', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates'))
    const rec = recorded(drive, [held('unlink', Infinity)])
    expect((await checkDriveBeforeDialog(contextOf(drive, rec, 'win32'))).kind).toBe('ready')
    expect(seams.waits.length).toBeGreaterThan(5)
  })

  it.each(['win32', 'linux'] as const)('a discard whose unlink is held twice (EPERM), on %s: removeRetry\u{2019}s waits on Windows only', async (platform) => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive, [{ call: 'unlink', when: (rel) => rel === 'updates/staging/1.1.0/files/notes.txt', error: injected('EPERM', 'unlink'), times: 2 }])
    const end = await discardStaged(contextOf(drive, rec, platform), { version: '1.1.0' }, { version: '1.1.0' })
    if (platform === 'win32') {
      expect(end).toEqual({ kind: 'discarded', version: '1.1.0' })
      expect(seams.waits).toEqual([100, 200])
    } else {
      expect(end).toEqual({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: { code: 'EPERM', syscall: 'unlink' } })
      expect(seams.waits).toEqual([])
    }
  })

  it('the start step\u{2019}s removals take no retry: a held entry is left for the next start and reported', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates/staging/.incoming-1.1.0'), { recursive: true })
    writeFileSync(drive.at('updates/staging/.incoming-1.1.0/a.exe'), 'x')
    const rec = recorded(drive, [{ call: 'unlink', when: (rel) => rel.endsWith('a.exe'), error: injected('EBUSY', 'unlink'), times: 1 }])
    const ctx = contextOf(drive, rec, 'win32')
    const plan = await planSweep(ctx, drive.at('updates'))
    expect(await carryOutSweep(ctx, plan)).toEqual([{ reason: 'incoming', cause: { code: 'EBUSY', syscall: 'unlink' } }])
    expect(seams.waits).toEqual([])
    expect(isAbsent(drive.at('updates/staging/.incoming-1.1.0/a.exe'))).toBe(false)
  })
})

// ---- the sweep's other readings

describe('the sweep\u{2019}s readings the table holds no case for (record §4.5 "The start-up sweep")', () => {
  it('an entry whose real-folder test proves nothing (its realpath fails) is left, counted under no reason, and never the staged update', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    mkdirSync(drive.at('updates/staging/.incoming-1.2.0'))
    const rec = recorded(drive, [{ call: 'realpath', when: (rel) => rel === 'updates/staging/1.1.0', error: injected('EIO', 'realpath') }])
    const ctx = contextOf(drive, rec)
    const tree = snapshot(drive.at('updates/staging/1.1.0'))
    const plan = await planSweep(ctx, drive.at('updates'))
    expect({ staged: plan.staged, counts: plan.counts }).toEqual({
      staged: null,
      counts: { incoming: 1, 'no-marker': 0, 'invalid-marker': 0, 'member-missing': 0, 'not-a-folder': 0, link: 0 }
    })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(snapshot(drive.at('updates/staging/1.1.0'))).toEqual(tree)
    expect(isAbsent(drive.at('updates/staging/.incoming-1.2.0'))).toBe(true)
  })

  it.each([
    ['a folder', (path: string) => mkdirSync(path)],
    ['a plain file', (path: string) => writeFileSync(path, 'x')]
  ])('never while updates/applying/ exists (%s at the name): nothing is swept and nothing is the staged update', async (_label, make) => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    mkdirSync(drive.at('updates/staging/.incoming-1.2.0'))
    make(drive.at('updates/applying'))
    const tree = snapshot(drive.at('updates/staging'))
    const rec = recorded(drive)
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect({ staged: plan.staged, notice: plan.notice, lines: sweptLogFields(plan) }).toEqual({ staged: null, notice: null, lines: [] })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(snapshot(drive.at('updates/staging'))).toEqual(tree)
    expect(rec.calls.some((call) => call.startsWith('readdir updates/staging'))).toBe(false)
  })

  // Which entry a name is (§4.5 "Links under updates/"): the one fold-equal entry, and that one only when an lstat of the
  // asked name finds it. A file system that folds case (NTFS here) finds `Staging/` for `staging`; one that does not
  // (ext4: the in-memory tree below, whose names are exact) answers ENOENT, and the variant is another folder, never touched.
  it.runIf(isWindows)('on a file system that folds case, updates/Staging/ is updates/staging/: its leftovers are swept', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates/Staging/.incoming-1.0.0'), { recursive: true })
    const rec = recorded(drive)
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect(plan.counts.incoming).toBe(1)
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(readdirSync(drive.at('updates/Staging'))).toEqual([])
  })

  it('on a file system that does not fold case, updates/Staging/ is another folder: nothing in it is read or swept', async () => {
    const root = join(tmpdir(), 'hr-updates-staging-memory', 'drive')
    const fs = memoryFolders(root, ['updates', 'updates/Staging', 'updates/Staging/.incoming-1.0.0'])
    const plan = await planSweep({ root, platform: 'linux', fs }, join(root, 'updates'))
    expect({ counts: plan.counts, removals: plan.removals.length }).toEqual({
      counts: { incoming: 0, 'no-marker': 0, 'invalid-marker': 0, 'member-missing': 0, 'not-a-folder': 0, link: 0 },
      removals: 0
    })
    expect(await fs.readdir(join(root, 'updates', 'Staging'))).toEqual(['.incoming-1.0.0'])
  })

  // §4.6 "Valid": `version` a SemVer of at most 64 bytes equal to the folder's name. The table's cases give a version that
  // differs from its folder; these give the folder's own name, so only the version's own rule decides.
  it.each([['a word', 'latest'], ['two parts', '1.1'], ['a SemVer of 65 bytes', `1.0.0-${'a'.repeat(59)}`]])(
    'a staged.json whose version is its folder\u{2019}s name but %s is not valid (invalid-marker)',
    async (_label, version) => {
      const drive = freshDrive()
      const dir = drive.at(`updates/staging/${version}`)
      mkdirSync(join(dir, 'files'), { recursive: true })
      const notes = dataOf('notes')
      writeFileSync(join(dir, 'files', 'notes.txt'), notes)
      writeFileSync(join(dir, 'staged.json'), JSON.stringify({ format: 1, version, files: [{ name: 'notes.txt', size: notes.length, sha256: sha256(notes) }] }))
      const plan = await planSweep(contextOf(drive, recorded(drive)), drive.at('updates'))
      expect({ staged: plan.staged, invalid: plan.counts['invalid-marker'] }).toEqual({ staged: null, invalid: 1 })
    }
  )

  it('a removal starts with staged.json, so a cut removal never leaves a valid one (record §4.5 "Every removal")', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive)
    expect((await discardStaged(contextOf(drive, rec), { version: '1.1.0' }, { version: '1.1.0' })).kind).toBe('discarded')
    expect(rec.writes[0]).toBe('updates/staging/1.1.0/staged.json')
  })
})

// ---- the data pass's start: a failure removes both folders as far as it can (record §4.5 "Errors while staging")

describe('a failure at the data pass\u{2019}s start leaves the two staging folders removed as far as they can be (record §4.5)', () => {
  const PRESENT = [{ name: 'apply.cmd', size: 22 }]

  async function startOn(drive: Drive, rec: Recorded, platform: NodeJS.Platform) {
    const ctx = contextOf(drive, rec, platform)
    const pre = await checkDriveBeforeDialog(ctx)
    if (pre.kind !== 'ready') throw new Error(JSON.stringify(pre))
    const post = await checkBeforeDataPass(ctx, pre.drive, { version: '1.1.0', present: PRESENT })
    if (post.kind !== 'ready') throw new Error(JSON.stringify(post))
    return startDataPass(ctx, pre.drive, post.targets, '1.1.0')
  }

  it('a mkdir that fails (EIO at <v>/files/) answers UPD-CANT-WRITE-DRIVE and leaves neither .incoming-<v>/ nor <v>/', async () => {
    const drive = freshDrive()
    const rec = recorded(drive, [{ call: 'mkdir', when: (rel) => rel === 'updates/staging/1.1.0/files', error: injected('EIO', 'mkdir') }])
    expect(await startOn(drive, rec, 'win32')).toEqual({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: { code: 'EIO', syscall: 'mkdir' }, link: null })
    expect(isAbsent(drive.at('updates/staging/.incoming-1.1.0'))).toBe(true)
    expect(isAbsent(drive.at('updates/staging/1.1.0'))).toBe(true)
  })

  it('a removal that fails at the start (a held staged.json, no retry on Linux) is tried on both names, then answers', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    mkdirSync(drive.at('updates/staging/.incoming-1.1.0'))
    writeFileSync(drive.at('updates/staging/.incoming-1.1.0/apply.cmd'), 'x')
    const rec = recorded(drive, [{ call: 'unlink', when: (rel) => rel === 'updates/staging/1.1.0/staged.json', error: injected('EPERM', 'unlink') }])
    expect(await startOn(drive, rec, 'linux')).toEqual({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: { code: 'EPERM', syscall: 'unlink' }, link: null })
    expect(isAbsent(drive.at('updates/staging/.incoming-1.1.0'))).toBe(true)
    expect(isAbsent(drive.at('updates/staging/1.1.0/staged.json'))).toBe(false)
  })

  // T6.2 review A M-3 (A28-A31): each folder the start makes is tested before anything is written into it, and a failure
  // answers as record §4.5 "Errors while staging" says, with the name that blocked it only for UPD-CANT-WRITE-DRIVE.
  it.each([
    [
      'its mkdir of .incoming-<v>/ fails EEXIST (something appeared at the name)',
      { call: 'mkdir', when: (rel: string) => rel === 'updates/staging/.incoming-1.1.0', error: injected('EEXIST', 'mkdir') },
      { code: 'UPD-CANT-WRITE-DRIVE', params: {} },
      { code: 'EEXIST', syscall: 'mkdir' },
      'incoming'
    ],
    [
      'the test of the .incoming-<v>/ it just made proves nothing (its realpath fails EIO)',
      { call: 'realpath', when: (rel: string) => rel === 'updates/staging/.incoming-1.1.0', error: injected('EIO', 'realpath'), times: 1 },
      { code: 'UPD-CANT-WRITE-DRIVE', params: {} },
      { code: 'EIO', syscall: 'realpath' },
      'incoming'
    ],
    [
      'its mkdir of <v>/files/ fails ENOSPC',
      { call: 'mkdir', when: (rel: string) => rel === 'updates/staging/1.1.0/files', error: injected('ENOSPC', 'mkdir') },
      { code: 'UPD-DRIVE-FULL', params: { requiredBytes: null, freeBytes: null } },
      { code: 'ENOSPC', syscall: 'mkdir' },
      null
    ],
    [
      'its mkdir of <v>/files/ fails EFBIG',
      { call: 'mkdir', when: (rel: string) => rel === 'updates/staging/1.1.0/files', error: injected('EFBIG', 'mkdir') },
      { code: 'UPD-FILE-TOO-BIG-FOR-DRIVE', params: {} },
      { code: 'EFBIG', syscall: 'mkdir' },
      null
    ]
  ] as const)('%s: the refusal of record §4.5, and neither folder is left', async (_label, rule, refusal, cause, link) => {
    const drive = freshDrive()
    const rec = recorded(drive, [rule as Rule])
    expect(await startOn(drive, rec, 'win32')).toEqual({ kind: 'refused', refusal, cause, link })
    expect(isAbsent(drive.at('updates/staging/.incoming-1.1.0'))).toBe(true)
    expect(isAbsent(drive.at('updates/staging/1.1.0'))).toBe(true)
  })

  // T6.2 review A M-3 (A02): a removal whose test of <v>/ proves nothing is a failed removal, answered by its cause.
  it('a removal at the start whose test of <v>/ proves nothing (its realpath fails EIO) answers UPD-CANT-WRITE-DRIVE with that cause and no link name', async () => {
    let armed = false
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive, [{ call: 'realpath', when: (rel) => armed && rel === 'updates/staging/1.1.0', error: injected('EIO', 'realpath') }])
    const ctx = contextOf(drive, rec)
    const pre = await checkDriveBeforeDialog(ctx)
    if (pre.kind !== 'ready') throw new Error(JSON.stringify(pre))
    const post = await checkBeforeDataPass(ctx, pre.drive, { version: '1.1.0', present: PRESENT })
    if (post.kind !== 'ready') throw new Error(JSON.stringify(post))
    armed = true
    expect(await startDataPass(ctx, pre.drive, post.targets, '1.1.0')).toEqual({
      kind: 'refused',
      refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} },
      cause: { code: 'EIO', syscall: 'realpath' },
      link: null
    })
    expect(isAbsent(drive.at('updates/staging/1.1.0/staged.json'))).toBe(false)
  })

  // T6.2 review A M-3 (A41): both names are tried; the answer is the first failure's.
  it('both removals at the start fail: each name is tried, and the answer carries the first one\u{2019}s cause', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    mkdirSync(drive.at('updates/staging/.incoming-1.1.0'))
    writeFileSync(drive.at('updates/staging/.incoming-1.1.0/apply.cmd'), 'x')
    const rec = recorded(drive, [
      { call: 'unlink', when: (rel) => rel === 'updates/staging/1.1.0/staged.json', error: injected('EIO', 'unlink') },
      { call: 'unlink', when: (rel) => rel === 'updates/staging/.incoming-1.1.0/apply.cmd', error: injected('EROFS', 'unlink') }
    ])
    expect(await startOn(drive, rec, 'linux')).toEqual({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: { code: 'EIO', syscall: 'unlink' }, link: null })
    expect(rec.calls).toContain('unlink updates/staging/.incoming-1.1.0/apply.cmd')
  })
})

// ---- the commit (F-5): the golden update files' bytes, and the order that makes a kill safe

interface GoldenStaged {
  file: string
  envelope: { name: string; size: number; sha256: string }
  version: string
  membersInFileOrder: Array<{ name: string; size: number; sha256: string }>
  stagedTxt: string
  stagedJson: string
}
const F5 = JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'import', 'f5-staged.json'), 'utf8')) as { staged: GoldenStaged[] }
const GOLDEN_KEYS = JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'golden-keys.json'), 'utf8')) as { keys: string[] }
/** f5-staged.json's `hostForAccept`: a running version below 1.2.0, the clock near 2026-11-27T12:00:00Z, Windows. */
const GOLDEN_HOST: Host = { ...(table.hosts.win32 as unknown as Host), now: '2026-11-28T00:00:00Z' }

/** One import through staging's steps, as the service runs them (§4.5's order), of a file already on disk. */
async function stageFile(drive: Drive, rec: Recorded, path: string, keys: readonly UpdateKey[], host: Host): Promise<{ folders: StagingFolders; file: CheckedUpdateFile }> {
  const ctx = contextOf(drive, rec, host.os)
  const pre = await checkDriveBeforeDialog(ctx)
  if (pre.kind !== 'ready') throw new Error(JSON.stringify(pre))
  const read = await readUpdateFile(path, { keys, input: payloadInput(host), fs: BUNDLE_FS, cancelled: () => false })
  if (read.kind !== 'checked') throw new Error(JSON.stringify(read.kind))
  const post = await checkBeforeDataPass(ctx, pre.drive, { version: read.file.payload.version, present: read.file.present })
  if (post.kind !== 'ready') throw new Error(JSON.stringify(post))
  const start = await startDataPass(ctx, pre.drive, post.targets, read.file.payload.version)
  if (start.kind !== 'ready') throw new Error(JSON.stringify(start))
  return { folders: start.folders, file: read.file }
}

describe('the commit writes F-5\u{2019}s bytes, staged.json last (f5-staged.json; record §4.5 "The commit", §4.6)', () => {
  it.each(F5.staged.map((s) => [s.file, s] as const))('%s', async (name, golden) => {
    const drive = freshDrive()
    const rec = recorded(drive)
    const { folders, file } = await stageFile(drive, rec, join(UPDATES_FIXTURES, name), keySet(GOLDEN_KEYS.keys), GOLDEN_HOST)
    try {
      const stage = await file.stage({ incomingDir: folders.incomingDir, filesDir: folders.filesDir, cancelled: () => false, progress: () => undefined })
      if (stage.kind !== 'staged') throw new Error(stage.kind)
      expect(await commitStaged(contextOf(drive, rec), folders, { envelope: file.envelope, files: stage.files })).toMatchObject({ kind: 'committed', cleared: false })
    } finally {
      await file.close()
    }
    const dir = drive.at(`updates/staging/${golden.version}`)
    expect(readFileSync(join(dir, 'staged.txt'), 'latin1')).toBe(golden.stagedTxt)
    expect(readFileSync(join(dir, 'staged.json'), 'latin1')).toBe(golden.stagedJson)
    expect(golden.stagedJson.endsWith('\n')).toBe(false)
    const envelope = readFileSync(join(dir, golden.envelope.name))
    expect({ size: envelope.length, sha256: sha256(envelope) }).toEqual({ size: golden.envelope.size, sha256: golden.envelope.sha256 })
    expect(readdirSync(dir).sort()).toEqual(['files', 'hilbertraum-release.dsse.json', 'staged.json', 'staged.txt'])
    for (const m of golden.membersInFileOrder) expect(sha256(readFileSync(join(dir, 'files', m.name))), m.name).toBe(m.sha256)
    expect(readdirSync(drive.at('updates/staging'))).toEqual([golden.version])
    // Each marker is written to its .tmp name, fsynced, and renamed into place; staged.json is the last name the commit makes.
    const renamed = rec.calls.filter((call) => call.startsWith('rename ')).map((call) => call.slice(call.lastIndexOf('/') + 1))
    expect(renamed).toEqual(['hilbertraum-release.dsse.json.tmp', 'staged.txt.tmp', 'staged.json.tmp'])
    for (const tmp of renamed) {
      const path = `updates/staging/${golden.version}/${tmp}`
      expect(rec.calls.indexOf(`sync ${path}`), `${tmp} is fsynced before its rename`).toBeGreaterThan(rec.calls.indexOf(`write ${path}`))
      expect(rec.calls.indexOf(`sync ${path}`)).toBeLessThan(rec.calls.indexOf(`rename ${path}`))
    }
  })

  it('the order that leaves no staged update or exactly one that nothing marks: others removed, cleared line, markers, .incoming last', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.0.5', 'std')
    mkdirSync(drive.at('updates'), { recursive: true })
    writeFileSync(drive.at('updates/last-result.txt'), '\nfallback 1.1.0 0123456789abcdef\n')
    const path = caseFile(drive, caseOf('accept-std'))
    const rec = recorded(drive)
    const { folders, file } = await stageFile(drive, rec, path, TEST_KEYS, table.hosts.win32 as unknown as Host)
    try {
      const stage = await file.stage({ incomingDir: folders.incomingDir, filesDir: folders.filesDir, cancelled: () => false, progress: () => undefined })
      if (stage.kind !== 'staged') throw new Error(stage.kind)
      const from = rec.calls.length
      expect(await commitStaged(contextOf(drive, rec), folders, { envelope: file.envelope, files: stage.files })).toMatchObject({ kind: 'committed', cleared: true })
      const steps = rec.calls.slice(from)
      const first = (pattern: RegExp): number => steps.findIndex((call) => pattern.test(call))
      const last = (pattern: RegExp): number => steps.length - 1 - [...steps].reverse().findIndex((call) => pattern.test(call))
      const order = [
        last(/^rmdir updates\/staging\/1\.0\.5$/),
        first(/^write updates\/last-result\.txt$/),
        first(/^rename updates\/staging\/1\.1\.0\/hilbertraum-release\.dsse\.json\.tmp$/),
        first(/^rename updates\/staging\/1\.1\.0\/staged\.txt\.tmp$/),
        first(/^rename updates\/staging\/1\.1\.0\/staged\.json\.tmp$/),
        first(/^rmdir updates\/staging\/\.incoming-1\.1\.0$/)
      ]
      expect(order.every((at) => at >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    } finally {
      await file.close()
    }
  })

  it('a refusal from the data pass on removes both staging folders; another version staged earlier stays (record §4.5)', async () => {
    const c = caseOf('data-hash-mismatch-keeps-other-version')
    const drive = makeDrive(hostOf(c))
    plant(drive, c)
    const e = c.expect as Expect
    const was = before(drive, e)
    const rec = recorded(drive)
    const { folders, file } = await stageFile(drive, rec, caseFile(drive, c), TEST_KEYS, hostOf(c))
    try {
      const stage = await file.stage({ incomingDir: folders.incomingDir, filesDir: folders.filesDir, cancelled: () => false, progress: () => undefined })
      expect(stage.kind === 'refused' && stage.refusal.code).toBe(e.code)
      expect(await removeStagingFolders(contextOf(drive, rec), folders)).toBeNull()
    } finally {
      await file.close()
    }
    expectAfter(drive, e, was)
    expectWritesUnderUpdates(rec)
  })
})

// ---- fix round 1 of the T6.2 reviews (impl/p6/T6.2/review-disposition.md F3, F4, F6): the branches review A's further
// mutations reached (its M-3 table) and the commit's own test of <v>/ (its M-2). Expected values from the record row each
// names; the case table holds none of these drive states.

const CANT_WRITE = { code: 'UPD-CANT-WRITE-DRIVE', params: {} }
const READ_ONLY = { code: 'UPD-DRIVE-READ-ONLY', params: {} }
const FULL_NO_NUMBERS = { code: 'UPD-DRIVE-FULL', params: { requiredBytes: null, freeBytes: null } }
const NO_COUNTS = { incoming: 0, 'no-marker': 0, 'invalid-marker': 0, 'member-missing': 0, 'not-a-folder': 0, link: 0 }
/** `staged.json`'s cap (record §4.6: 62 × 65,536 bytes). */
const MARKER_CAP = 4_063_232
/** The flags of record §4.5 and §4.6 exist on macOS and Linux only (Windows has no O_NOFOLLOW): those rows run there. */
const POSIX_FLAGS = process.platform !== 'win32' && constants.O_NOFOLLOW !== undefined && constants.O_NONBLOCK !== undefined && constants.O_DIRECTORY !== undefined
const WIN32_HOST = (): Host => table.hosts.win32 as unknown as Host
/** Windows: can a new empty folder take the per-folder case-sensitivity attribute here (fsutil; no privilege needed on
 *  the box this was written on)? */
const canCaseSensitive = ((): boolean => {
  if (!isWindows) return false
  try {
    execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', mkdtempSync(join(tmpdir(), 'hr-updates-staging-cs-')), 'enable'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const ACCEPT_STD = (): Expect => caseOf('accept-std').expect as Expect
type Files = Parameters<typeof commitStaged>[2]['files']

/** accept-std's file staged by staging's steps up to the commit (§4.5's order), every call recorded. The caller closes `file`. */
async function untilCommit(drive: Drive, rec: Recorded): Promise<{ ctx: StagingContext; folders: StagingFolders; file: CheckedUpdateFile; files: Files }> {
  const { folders, file } = await stageFile(drive, rec, caseFile(drive, caseOf('accept-std')), TEST_KEYS, WIN32_HOST())
  const stage = await file.stage({ incomingDir: folders.incomingDir, filesDir: folders.filesDir, cancelled: () => false, progress: () => undefined })
  if (stage.kind !== 'staged') {
    await file.close()
    throw new Error(stage.kind)
  }
  return { ctx: contextOf(drive, rec), folders, file, files: stage.files }
}

describe('the commit tests <v>/ again before it writes, leaves what it cannot prove, and fails as errors while staging do (record §4.5 "The commit", "Links under updates/", "Errors while staging"; T6.2 review A M-2, M-3, m-3)', () => {
  // Review A h8: the data pass runs for minutes; <v>/ is checked again before anything is written into it.
  it.each(FOLDER_KINDS)('<v>/ swapped for %s after the data pass\u{2019}s start: refused UPD-CANT-WRITE-DRIVE link=version, nothing written', async (_label, make) => {
    const drive = freshDrive()
    const rec = recorded(drive)
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      const target = linkTarget(drive, 'elsewhere')
      mkdirSync(join(target.path, 'files'))
      const tree = snapshot(target.path)
      renameSync(folders.versionDir, join(drive.outside, 'moved'))
      make(target.path, folders.versionDir)
      const from = rec.writes.length
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: null, link: 'version' })
      expect(rec.writes.slice(from)).toEqual([])
      expect(snapshot(target.path)).toEqual(tree)
    } finally {
      await file.close()
    }
  })

  // Review A's A18 (told apart by a scratch input, impl/p6/T6.2/fix-1/equiv/): the real-folder test walks every name from
  // the root by lstat, so a link on the way is met even where its target's path differs only in letter case, which the
  // realpath comparison folds. A case-sensitive NTFS folder holds `updates` and `Updates` as two names.
  it.runIf(canCaseSensitive)('updates/ swapped after the data pass\u{2019}s start for a junction to its case twin Updates/ (a case-sensitive folder): refused link=version, nothing written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-updates-staging-'))
    const root = join(dir, 'drive')
    mkdirSync(root)
    execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', root, 'enable'], { stdio: 'ignore' })
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const drive: Drive = { dir, root, outside, at: (path) => join(root, ...path.split('/')), rel: (path) => relative(root, path).split(sep).join('/') }
    const rec = recorded(drive)
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      renameSync(drive.at('updates'), join(root, 'Updates'))
      symlinkSync(join(root, 'Updates'), drive.at('updates'), 'junction')
      const from = rec.writes.length
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: null, link: 'version' })
      expect(rec.writes.slice(from)).toEqual([])
    } finally {
      await file.close()
    }
  })

  it('a test of <v>/ that proves nothing at the commit (its realpath fails EIO): refused with that cause, link=version, nothing written', async () => {
    let armed = false
    const drive = freshDrive()
    const rec = recorded(drive, [{ call: 'realpath', when: (rel) => armed && rel === 'updates/staging/1.1.0', error: injected('EIO', 'realpath') }])
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      armed = true
      const from = rec.writes.length
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toEqual({
        kind: 'refused',
        refusal: CANT_WRITE,
        cause: { code: 'EIO', syscall: 'realpath' },
        link: 'version'
      })
      expect(rec.writes.slice(from)).toEqual([])
    } finally {
      await file.close()
    }
  })

  // Review A m-3, as the disposition rules it (F6): an entry whose test proves nothing is left, and the commit goes on.
  it.each([
    ['an lstat held (EPERM)', 'lstat', injected('EPERM', 'lstat')],
    ['an lstat that fails EIO', 'lstat', injected('EIO', 'lstat')],
    ['a real-folder test that proves nothing (its realpath fails EIO)', 'realpath', injected('EIO', 'realpath')]
  ] as const)('another version whose entry gives %s is left as it is, and the commit goes on', async (_label, call, error) => {
    const drive = freshDrive()
    plantStaged(drive, '1.0.5', 'std')
    plantStaged(drive, '0.9.0', 'std')
    const tree = snapshot(drive.at('updates/staging/0.9.0'))
    const rec = recorded(drive, [{ call, when: (rel) => rel === 'updates/staging/0.9.0', error }])
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toMatchObject({ kind: 'committed' })
    } finally {
      await file.close()
    }
    expect(snapshot(drive.at('updates/staging/0.9.0'))).toEqual(tree)
    expect(readdirSync(drive.at('updates/staging')).sort()).toEqual(['0.9.0', '1.1.0'])
  })

  // Review A h7 and A01: a link among the other versions (also one lstat reads as a folder) and a stray file are left.
  it.each(FOLDER_KINDS)('another entry that is %s, and a stray file, are left as they are; the real other version goes', async (_label, make) => {
    const drive = freshDrive()
    plantStaged(drive, '1.0.5', 'std')
    const target = linkTarget(drive, 'elsewhere')
    make(target.path, drive.at('updates/staging/0.8.0'))
    writeFileSync(drive.at('updates/staging/stray.txt'), 'stray')
    const link = lstatSync(drive.at('updates/staging/0.8.0')).isSymbolicLink() ? readlinkSync(drive.at('updates/staging/0.8.0')) : null
    const rec = recorded(drive)
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toMatchObject({ kind: 'committed' })
    } finally {
      await file.close()
    }
    expect(readdirSync(drive.at('updates/staging')).sort()).toEqual(['0.8.0', '1.1.0', 'stray.txt'])
    if (link !== null) expect(readlinkSync(drive.at('updates/staging/0.8.0'))).toBe(link)
    expect(snapshot(target.path)).toEqual(target.tree)
  })

  it('a marker\u{2019}s .tmp left at its name meanwhile is removed by its name first: committed, staged.txt as accept-std\u{2019}s (review A A03)', async () => {
    const drive = freshDrive()
    const rec = recorded(drive)
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      writeFileSync(join(folders.versionDir, 'staged.txt.tmp'), 'left over')
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toMatchObject({ kind: 'committed' })
    } finally {
      await file.close()
    }
    expect(readFileSync(drive.at('updates/staging/1.1.0/staged.txt'), 'latin1')).toBe(ACCEPT_STD().after!.stagedTxt)
    expect(readdirSync(drive.at('updates/staging/1.1.0')).sort()).toEqual(['files', 'hilbertraum-release.dsse.json', 'staged.json', 'staged.txt'])
  })

  it('a short write of a marker (7 bytes) is completed by the next writes: staged.json as accept-std\u{2019}s, byte for byte (review A A04)', async () => {
    const drive = freshDrive()
    const rec = recorded(drive, [{ call: 'write', when: (rel) => rel === 'updates/staging/1.1.0/staged.json.tmp', short: 7, times: 1 }])
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toMatchObject({ kind: 'committed' })
    } finally {
      await file.close()
    }
    expect(readFileSync(drive.at('updates/staging/1.1.0/staged.json'), 'latin1')).toBe(ACCEPT_STD().after!.stagedJson)
  })

  it('a marker\u{2019}s write that moves no byte refuses the commit: UPD-CANT-WRITE-DRIVE with no cause, staged.json never made (review A A05)', async () => {
    const drive = freshDrive()
    const rec = recorded(drive, [{ call: 'write', when: (rel) => rel === 'updates/staging/1.1.0/staged.json.tmp', short: 0 }])
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: null, link: null })
    } finally {
      await file.close()
    }
    expect(isAbsent(drive.at('updates/staging/1.1.0/staged.json'))).toBe(true)
  })

  it.each([
    ['ENOSPC', FULL_NO_NUMBERS],
    ['EFBIG', { code: 'UPD-FILE-TOO-BIG-FOR-DRIVE', params: {} }]
  ] as const)('a marker\u{2019}s write that fails %s answers as record §4.5 "Errors while staging" says (review A A30, A31)', async (code, refusal) => {
    const drive = freshDrive()
    const rec = recorded(drive, [{ call: 'write', when: (rel) => rel === 'updates/staging/1.1.0/staged.txt.tmp', error: injected(code, 'write') }])
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toEqual({ kind: 'refused', refusal, cause: { code, syscall: 'write' }, link: null })
    } finally {
      await file.close()
    }
  })

  it('the commit\u{2019}s own listing of updates/staging/ that fails EIO refuses it with that cause, before anything is removed (review A A42)', async () => {
    let armed = false
    const drive = freshDrive()
    plantStaged(drive, '1.0.5', 'std')
    const rec = recorded(drive, [{ call: 'readdir', when: (rel) => armed && rel === 'updates/staging', error: injected('EIO', 'scandir') }])
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    try {
      armed = true
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: { code: 'EIO', syscall: 'scandir' }, link: null })
    } finally {
      await file.close()
    }
    expect(isAbsent(drive.at('updates/staging/1.0.5/staged.json'))).toBe(false)
  })

  // Record §4.5 "The commit": "on macOS and Linux the folder fsynced after" each rename; the open of the folder for it is
  // read-only, O_DIRECTORY, O_NOFOLLOW and O_NONBLOCK (review A M-2, A44). CI's ubuntu and macOS legs run it.
  it.runIf(POSIX_FLAGS)('on macOS and Linux each marker\u{2019}s rename is followed by the folder\u{2019}s fsync, the folder opened read-only with O_DIRECTORY, O_NOFOLLOW and O_NONBLOCK', async () => {
    const drive = freshDrive()
    const rec = recorded(drive)
    const { ctx, folders, file, files } = await untilCommit(drive, rec)
    const from = rec.calls.length
    const opensFrom = rec.opens.length
    try {
      expect(await commitStaged(ctx, folders, { envelope: file.envelope, files })).toMatchObject({ kind: 'committed' })
    } finally {
      await file.close()
    }
    const steps = rec.calls.slice(from)
    const folder = 'updates/staging/1.1.0'
    for (const name of ['hilbertraum-release.dsse.json', 'staged.txt', 'staged.json']) {
      const renamed = steps.indexOf(`rename ${folder}/${name}.tmp`)
      const opened = steps.indexOf(`open ${folder}`, renamed)
      expect(renamed, name).toBeGreaterThanOrEqual(0)
      expect(opened, `${name}: the folder opened after the rename`).toBeGreaterThan(renamed)
      expect(steps.indexOf(`sync ${folder}`, opened), `${name}: the folder fsynced`).toBeGreaterThan(opened)
    }
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    expect(rec.opens.slice(opensFrom).filter((o) => o.rel === folder).map((o) => o.flags)).toEqual([flags, flags, flags])
  })
})

describe('the sweep: a read that proves nothing leaves the entry, a missing files/ is member-missing, staged.json is read as §4.6 says (record §4.5 "The start-up sweep", §4.6 "The read"; T6.2 review A M-3)', () => {
  // A09, A10, A12, A13: a stat, an open or a real-folder test that fails other than with ENOENT proves nothing.
  it.each([
    ['the lstat of staged.json fails EIO', 'lstat', 'updates/staging/1.1.0/staged.json'],
    ['the open of staged.json fails EIO', 'open', 'updates/staging/1.1.0/staged.json'],
    ['a listed member\u{2019}s lstat fails EIO', 'lstat', 'updates/staging/1.1.0/files/notes.txt'],
    ['the lstat of files/ fails EIO (its real-folder test proves nothing)', 'lstat', 'updates/staging/1.1.0/files']
  ] as const)('%s: the entry is left, counted under no reason, and never the staged update', async (_label, call, at) => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const tree = snapshot(drive.at('updates/staging/1.1.0'))
    const rec = recorded(drive, [{ call, when: (rel) => rel === at, error: injected('EIO', call) }])
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect({ staged: plan.staged, notice: plan.notice, counts: plan.counts, removals: plan.removals.length }).toEqual({ staged: null, notice: null, counts: NO_COUNTS, removals: 0 })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(snapshot(drive.at('updates/staging/1.1.0'))).toEqual(tree)
  })

  // A14: "a files/ that is not a real folder counts as every member missing" (§4.5), an absent one included.
  it('a valid staged.json whose files/ is missing: member-missing, removed, and the notice set', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    renameSync(drive.at('updates/staging/1.1.0/files'), join(drive.outside, 'files'))
    const ctx = contextOf(drive, recorded(drive))
    const plan = await planSweep(ctx, drive.at('updates'))
    expect({ staged: plan.staged, notice: plan.notice, counts: plan.counts }).toEqual({
      staged: null,
      notice: { code: 'UPD-FILE-DAMAGED-ON-DRIVE', params: {} },
      counts: { ...NO_COUNTS, 'member-missing': 1 }
    })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(isAbsent(drive.at('updates/staging/1.1.0'))).toBe(true)
  })

  // A15: an entry whose own lstat fails is left for this start, never taken for a stray file.
  it('an entry of updates/staging/ whose lstat fails EIO is left for this start, never unlinked as a stray file', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates/staging/.incoming-1.2.0'), { recursive: true })
    writeFileSync(drive.at('updates/staging/.incoming-1.2.0/a.exe'), 'x')
    const rec = recorded(drive, [{ call: 'lstat', when: (rel) => rel === 'updates/staging/.incoming-1.2.0', error: injected('EIO', 'lstat') }])
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect({ counts: plan.counts, removals: plan.removals.length }).toEqual({ counts: NO_COUNTS, removals: 0 })
    expect(await carryOutSweep(ctx, plan)).toEqual([])
    expect(isAbsent(drive.at('updates/staging/.incoming-1.2.0/a.exe'))).toBe(false)
  })

  // A48: a removal that fails is reported (app.log), the entry left for the next start.
  it('a stray file whose unlink fails EIO is reported with its reason and cause, and left', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates/staging'), { recursive: true })
    writeFileSync(drive.at('updates/staging/stray.txt'), 'x')
    const rec = recorded(drive, [{ call: 'unlink', when: (rel) => rel === 'updates/staging/stray.txt', error: injected('EIO', 'unlink') }])
    const ctx = contextOf(drive, rec)
    const plan = await planSweep(ctx, drive.at('updates'))
    expect(plan.counts).toEqual({ ...NO_COUNTS, 'not-a-folder': 1 })
    expect(await carryOutSweep(ctx, plan)).toEqual([{ reason: 'not-a-folder', cause: { code: 'EIO', syscall: 'unlink' } }])
    expect(isAbsent(drive.at('updates/staging/stray.txt'))).toBe(false)
  })

  // A06: "checked on its descriptor" (§4.6): the file opened must be the one the lstat saw.
  it('a staged.json swapped between its lstat and its open is not the file the lstat saw: invalid-marker, removed', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const marker = drive.at('updates/staging/1.1.0/staged.json')
    const bytes = readFileSync(marker)
    // The old file is kept under another name, so the new one cannot take its file id.
    const swap = (path: string): void => {
      renameSync(path, join(drive.outside, 'old-staged.json'))
      writeFileSync(path, bytes)
    }
    const rec = recorded(drive, [{ call: 'open', when: (rel) => rel === 'updates/staging/1.1.0/staged.json', before: swap, times: 1 }])
    const plan = await planSweep(contextOf(drive, rec), drive.at('updates'))
    expect({ staged: plan.staged, counts: plan.counts }).toEqual({ staged: null, counts: { ...NO_COUNTS, 'invalid-marker': 1 } })
  })

  // A07: "by lstat a regular file ... of at most the cap, else not valid and never opened" (§4.6).
  it('a staged.json over the cap by its lstat is never opened: invalid-marker', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    writeFileSync(drive.at('updates/staging/1.1.0/staged.json'), Buffer.alloc(MARKER_CAP + 1, 0x20))
    const rec = recorded(drive)
    const plan = await planSweep(contextOf(drive, rec), drive.at('updates'))
    expect(plan.counts).toEqual({ ...NO_COUNTS, 'invalid-marker': 1 })
    expect(rec.opens.filter((o) => o.rel === 'updates/staging/1.1.0/staged.json')).toEqual([])
  })

  // A08: the read on the descriptor decides too ("read to one byte past the cap"): a file that grows after its lstat.
  it('a staged.json of exactly the cap is valid; one that grows past the cap between its lstat and its read is not', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const marker = drive.at('updates/staging/1.1.0/staged.json')
    const text = readFileSync(marker, 'latin1')
    writeFileSync(marker, text + ' '.repeat(MARKER_CAP - text.length), 'latin1')
    expect((await planSweep(contextOf(drive, recorded(drive)), drive.at('updates'))).staged).toEqual({ version: '1.1.0' })
    const rec = recorded(drive, [{ call: 'open', when: (rel) => rel === 'updates/staging/1.1.0/staged.json', before: (path) => appendFileSync(path, ' '), times: 1 }])
    const plan = await planSweep(contextOf(drive, rec), drive.at('updates'))
    expect({ staged: plan.staged, counts: plan.counts }).toEqual({ staged: null, counts: { ...NO_COUNTS, 'invalid-marker': 1 } })
  })

  // A45: §4.6 "The read": opened read-only with O_NOFOLLOW and O_NONBLOCK on macOS and Linux. CI's ubuntu and macOS legs.
  it.runIf(POSIX_FLAGS)('on macOS and Linux staged.json is opened read-only with O_NOFOLLOW and O_NONBLOCK', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive)
    expect((await planSweep(contextOf(drive, rec, process.platform), drive.at('updates'))).staged).toEqual({ version: '1.1.0' })
    expect(rec.opens.filter((o) => o.rel === 'updates/staging/1.1.0/staged.json').map((o) => o.flags)).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK])
  })
})

describe('the probe\u{2019}s readings (record §4.2 table A.1; notes-1 reading 2; T6.2 review A M-3: A25-A27)', () => {
  it.each([
    ['its write moves no byte', { call: 'write', when: isProbe, short: 0 }, READ_ONLY, null],
    ['its close fails EIO', { call: 'close', when: isProbe, error: injected('EIO', 'close') }, READ_ONLY, { code: 'EIO', syscall: 'close' }],
    ['its close fails ENOSPC', { call: 'close', when: isProbe, error: injected('ENOSPC', 'close') }, FULL_NO_NUMBERS, { code: 'ENOSPC', syscall: 'close' }],
    ['the lstat of its name fails EIO', { call: 'lstat', when: isProbe, error: injected('EIO', 'lstat') }, READ_ONLY, { code: 'EIO', syscall: 'lstat' }]
  ] as const)('%s: the refusal before the dialog', async (_label, rule, refusal, cause) => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates'))
    const rec = recorded(drive, [rule as Rule])
    expect(await checkDriveBeforeDialog(contextOf(drive, rec, 'linux'))).toEqual({ kind: 'refused', refusal, cause, link: null })
  })
})

describe('the discard\u{2019}s answers on a drive that is not as staging left it (record §3.5 updates:discardStaged, §4.5; notes-1 reading 8; T6.2 review A M-3)', () => {
  const discard = (drive: Drive, rec: Recorded, request: unknown = { version: '1.1.0' }) => discardStaged(contextOf(drive, rec), { version: '1.1.0' }, request)

  it('updates/staging/ that is a plain file: UPD-CANT-WRITE-DRIVE, nothing removed (A32)', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates'))
    writeFileSync(drive.at('updates/staging'), 'x')
    const rec = recorded(drive)
    expect(await discard(drive, rec)).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: null })
    expect(rec.writes).toEqual([])
  })

  it('a listing of updates/staging/ that fails EIO: UPD-CANT-WRITE-DRIVE with its cause, nothing removed (A33)', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive, [{ call: 'readdir', when: (rel) => rel === 'updates/staging', error: injected('EIO', 'scandir') }])
    expect(await discard(drive, rec)).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: { code: 'EIO', syscall: 'scandir' } })
    expect(rec.writes).toEqual([])
  })

  it.each(FOLDER_KINDS)('updates/ that is %s: not-staged, and nothing under it is read or removed (A34)', async (_label, make) => {
    const drive = freshDrive()
    const target = linkTarget(drive, 'elsewhere')
    mkdirSync(join(target.path, 'staging', '1.1.0', 'files'), { recursive: true })
    writeFileSync(join(target.path, 'staging', '1.1.0', 'staged.json'), '{}')
    const tree = snapshot(target.path)
    make(target.path, drive.at('updates'))
    const rec = recorded(drive)
    expect(await discard(drive, rec)).toEqual({ kind: 'not-staged' })
    expect(rec.calls.filter((call) => / updates\//.test(call))).toEqual([])
    expect(snapshot(target.path)).toEqual(tree)
  })

  it('a request whose version is inherited, not its own, names no version: not-staged, nothing removed (A35)', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive)
    expect(await discard(drive, rec, Object.create({ version: '1.1.0' }) as unknown)).toEqual({ kind: 'not-staged' })
    expect(rec.writes).toEqual([])
  })

  it('a first lstat of <v>/ that fails EIO is no proof it is gone: UPD-CANT-WRITE-DRIVE with its cause, the folder kept (A47)', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive, [{ call: 'lstat', when: (rel) => rel === 'updates/staging/1.1.0', error: injected('EIO', 'lstat') }])
    expect(await discard(drive, rec)).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: { code: 'EIO', syscall: 'lstat' } })
    expect(isAbsent(drive.at('updates/staging/1.1.0/staged.json'))).toBe(false)
  })

  it('a member gone before its unlink, and one gone before its lstat (another remover meanwhile): still discarded (A20, A21)', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const rec = recorded(drive, [
      { call: 'unlink', when: (rel) => rel === 'updates/staging/1.1.0/files/apply.cmd', before: (path) => unlinkSync(path), times: 1 },
      { call: 'lstat', when: (rel) => rel === 'updates/staging/1.1.0/files/notes.txt', before: (path) => unlinkSync(path), times: 1 }
    ])
    expect(await discard(drive, rec)).toEqual({ kind: 'discarded', version: '1.1.0' })
    expect(isAbsent(drive.at('updates/staging/1.1.0'))).toBe(true)
  })

  it('a sub-folder whose real-folder test proves nothing (its realpath fails EIO) ends the walk: refused with that cause, never removed (A22)', async () => {
    const drive = freshDrive()
    plantStaged(drive, '1.1.0', 'std')
    const members = readdirSync(drive.at('updates/staging/1.1.0/files')).sort()
    const rec = recorded(drive, [{ call: 'realpath', when: (rel) => rel === 'updates/staging/1.1.0/files', error: injected('EIO', 'realpath') }])
    expect(await discard(drive, rec)).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: { code: 'EIO', syscall: 'realpath' } })
    expect(readdirSync(drive.at('updates/staging/1.1.0/files')).sort()).toEqual(members)
  })
})

describe('which entry a name is, and the listings after the dialog (record §4.5 "Links under updates/"; notes-1 readings 3, 4; T6.2 review A M-3)', () => {
  // A39: notes-1 reading 4.
  it('a listing of updates/staging/ that fails after the dialog answers UPD-CANT-WRITE-DRIVE link=version with its cause', async () => {
    const drive = freshDrive()
    mkdirSync(drive.at('updates/staging'), { recursive: true })
    const rec = recorded(drive, [{ call: 'readdir', when: (rel) => rel === 'updates/staging', error: injected('EIO', 'scandir') }])
    const ctx = contextOf(drive, rec)
    const pre = await checkDriveBeforeDialog(ctx)
    if (pre.kind !== 'ready') throw new Error(JSON.stringify(pre))
    expect(await checkBeforeDataPass(ctx, pre.drive, { version: '1.1.0', present: [{ name: 'apply.cmd', size: 22 }] })).toEqual({
      kind: 'refused',
      refusal: CANT_WRITE,
      cause: { code: 'EIO', syscall: 'scandir' },
      link: 'version'
    })
  })

  // A46: the second listing's entry is tested like the first one's.
  it.each(FOLDER_KINDS)('updates/ that appears as %s between the listing and the mkdir: the second listing finds it and tests it, link=updates, nothing written through it', async (_label, make) => {
    const drive = freshDrive()
    const target = linkTarget(drive, 'elsewhere')
    const rec = recorded(drive, [{ call: 'mkdir', when: (rel) => rel === 'updates', before: (path) => make(target.path, path), times: 1 }])
    expect(await checkDriveBeforeDialog(contextOf(drive, rec))).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: null, link: 'updates' })
    expect(snapshot(target.path)).toEqual(target.tree)
    expect(rec.writes).toEqual(['updates'])
  })

  // A17: "the one entry whose name equals the asked name after the fold" (§4.5): two such entries prove nothing. Only a
  // file system that matches names by another rule shows two while an lstat of the asked name finds one: the in-memory
  // tree below, whose lstat folds the asked name onto one of them.
  it('two entries equal to staging after the fold, while an lstat of staging finds one, prove nothing: UPD-CANT-WRITE-DRIVE link=staging', async () => {
    const root = join(tmpdir(), 'hr-updates-staging-memory', 'drive')
    const tree = memoryFolders(root, ['updates', 'updates/Staging', 'updates/STAGING'])
    const fs: StagingFileSystem = { ...tree, lstat: (path) => tree.lstat(basename(path) === 'staging' ? join(dirname(path), 'Staging') : path) }
    expect(await checkDriveBeforeDialog({ root, platform: 'linux', fs })).toEqual({ kind: 'refused', refusal: CANT_WRITE, cause: null, link: 'staging' })
  })
})
