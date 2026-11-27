import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The update service (app-update T6.2 part 2; F-5, F-14's service half, F-21's refusal; docs/app-updates.md §3.5, §3.6,
// §4.5): the one object the four update channels register (T6.3) and the start step, on a real scratch file system
// (record §10.1, the integration tier). The service's own API is driven: `importFile`, `status`, `cancel` and
// `discardStaged`, with the file dialog a stub that answers a path, closed, or holds until the row lets it go. Every case of
// tests/fixtures/updates/import/cases.json that case-owners.json gives the service runs here, through that API, against
// its `expect` (T6.0b, written from the record before this code existed); the reader's and staging's own cases run in
// updates-bundle.test.ts and updates-staging.test.ts. The rows of their own state their expected values from the fixtures
// (F-5's f5-staged.json, F-11's vectors-import.json, last-result.json) or, where none holds the value, from the record row
// each one names.
//
// The update.log lines are the ones P3's appender writes on the drive: the time comes from a faked `Date` set to the
// case's clock, and the OS token is the running system's (the appender reads process.platform; the record's lines are
// win32's, so a line is compared with its OS token taken as this system's).
//
// Three seams, each a module import replaced by vi.mock and nothing else: node:timers/promises' setTimeout (the retry
// waits of fs-retry.ts's schedule and of the probe return at once), and bundle.ts's readUpdateFile, which calls the real
// reader and records the options the service hands it and each checked file's `stage` and `close` calls (T6.1 review m-3,
// m-5). No key is written: the signers are made in memory (update-bundles.ts), and the golden key set is public.
// Non-ASCII test strings are written as `\u{...}` escapes.
const seams = vi.hoisted(() => ({
  reads: [] as Array<{ cancelled: () => boolean }>,
  files: [] as Array<{ stage: number; close: number; order: string[]; options: { cancelled: () => boolean; progress: (done: number) => void } | null }>,
  /** Awaited before the real data pass starts, when a row sets it. */
  beforeStage: null as (() => Promise<void>) | null
}))
vi.mock('node:timers/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:timers/promises')>()
  const mocked = { ...orig, setTimeout: async () => undefined }
  return { ...mocked, default: mocked }
})
vi.mock('../../src/main/services/updates/bundle', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/services/updates/bundle')>()
  const readUpdateFile: typeof orig.readUpdateFile = async (path, options) => {
    seams.reads.push(options)
    const read = await orig.readUpdateFile(path, options)
    if (read.kind !== 'checked') return read
    const calls = { stage: 0, close: 0, order: [] as string[], options: null as (typeof seams.files)[number]['options'] }
    seams.files.push(calls)
    const file = read.file
    return {
      kind: 'checked',
      file: {
        payload: file.payload,
        envelope: file.envelope,
        present: file.present,
        totalBytes: file.totalBytes,
        stage: async (stageOptions) => {
          calls.stage++
          calls.order.push('stage')
          calls.options = stageOptions
          await seams.beforeStage?.()
          return file.stage(stageOptions)
        },
        close: async () => {
          calls.close++
          calls.order.push('close')
          return file.close()
        }
      }
    }
  }
  return { ...orig, readUpdateFile }
})

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { open as openFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { renameWithRetry } from '../../src/main/services/fs-retry'
import { readUpdatePolicy } from '../../src/main/services/policy'
import type { BundleFileHandle, BundleFileSystem } from '../../src/main/services/updates/bundle'
import { readDriveRelease, rootApps } from '../../src/main/services/updates/drive-release'
import type { UpdateKey } from '../../src/main/services/updates/envelope'
import { readKitSupport } from '../../src/main/services/updates/kit-support'
import { createUpdateService, NODE_START_FS, type StartFileSystem, type UpdateService, type UpdateServiceDeps } from '../../src/main/services/updates/service'
import { NODE_STAGING_FS, type StagingFileHandle, type StagingFileSystem } from '../../src/main/services/updates/staging'
import { appendUpdateLogLine } from '../../src/main/services/updates/update-log'
import type { UpdatesStatus } from '../../src/shared/updates/import-types'
import { FOLDER_LINKS, type FolderLink } from '../helpers/folder-links'
import { hangBudgetMs } from '../helpers/hang-budget'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import { buildCaseFile, bytesOf, IMPORT_FIXTURES, loadImportCases, makeBundleSigners, type BuildSpec, type BytesSpec, type ImportCase } from '../helpers/update-bundles'
import { hostOf, keySet, semver, type Host } from '../helpers/update-inputs'

const UPDATES_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates')
const table = loadImportCases()
const OWNERS = (JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'case-owners.json'), 'utf8')) as { owners: Record<string, string> }).owners
const signers = makeBundleSigners() // in memory; nothing of them is written
const TEST_KEYS = keySet([signers.test.spki.toString('base64')])
const isWindows = process.platform === 'win32'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const caseOf = (id: string): ImportCase => {
  const c = table.cases.find((k) => k.id === id)
  expect(c, id).toBeDefined()
  return c!
}
const WIN32: Host = hostOf({ id: 'a row of its own', host: 'win32' })
/** What the build-date reader answers in these rows (record §5.10's reader is T6.4a's; the service hands it on). */
const BUILD_DATE = '2026-10-01T12:00:00Z'
/** A payload's own text (cases.json `payloads`), read for the values it carries. */
const payloadOf = (name: string): { version: string; issued: string; requires?: Record<string, string> } => JSON.parse(table.payloads[name] as string)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  seams.reads = []
  seams.files = []
  seams.beforeStage = null
})
afterEach(() => {
  vi.useRealTimers()
})

// ---- small waits on observable state (never a fixed sleep)

interface Gate {
  readonly reached: Promise<void>
  hit(): Promise<void>
  release(): void
}
function gate(): Gate {
  let reach!: () => void
  let open!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const opened = new Promise<void>((resolve) => (open = resolve))
  return {
    reached,
    hit: async () => {
      reach()
      await opened
    },
    release: () => open()
  }
}
const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}
/** A promise and whether it has settled yet. */
function tracked<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true)
  )
  return { promise, settled: () => done }
}

// ---- a scratch drive, planted as a case's `drive` and `host` say (cases.json `schema.drive`, `schema.host`)

interface Drive {
  dir: string
  root: string
  outside: string
  userData: string
  at(path: string): string
  rel(path: string): string
}

/** policy.json for what readUpdatePolicy answers (record §8.1): no file for allowed without a cap. */
function policyText(policy: Host['policy']): string | null {
  if (policy.install === 'managed') return '{"updates":{"allow_user_install":false}}'
  if (policy.install === 'invalid') return '{"updates":{"allow_user_install":"no"}}'
  return policy.maxVersion === null ? null : JSON.stringify({ updates: { max_version: policy.maxVersion } })
}

function setPolicy(drive: Drive, policy: Host['policy']): void {
  const path = drive.at('config/policy.json')
  const text = policyText(policy)
  if (text === null) rmSync(path, { force: true })
  else writeFileSync(path, text)
  const read = readUpdatePolicy(drive.at('config'))
  expect({ install: read.install, maxVersion: read.maxVersion?.text ?? null }).toEqual(policy)
}

function makeDrive(host: Host, parent?: string): Drive {
  const dir = parent ?? mkdtempSync(join(tmpdir(), 'hr-updates-service-'))
  const root = join(dir, 'drive')
  const outside = join(dir, 'outside')
  const userData = join(dir, 'user-data')
  for (const folder of [join(root, 'config'), outside, userData]) mkdirSync(folder, { recursive: true })
  const at = (path: string): string =>
    path.startsWith('<outside>/') ? join(outside, ...path.slice('<outside>/'.length).split('/')) : join(root, ...path.split('/'))
  const rel = (path: string): string => relative(root, path).split(sep).join('/')
  const drive = { dir, root, outside, userData, at, rel }
  if (host.prepared !== false) writeFileSync(join(root, 'config', 'drive.json'), '{}')
  if (host.driveAppVersion !== null) writeFileSync(join(root, 'config', 'drive-release.json'), JSON.stringify({ format: 1, app_version: host.driveAppVersion }))
  for (const name of host.rootApps ?? []) writeFileSync(join(root, name), '')
  if (host.prepared !== false) setPolicy(drive, host.policy)
  return drive
}

const dataOf = (spec: unknown): Buffer => bytesOf((typeof spec === 'string' ? table.data[spec] : spec) as BytesSpec)
const STD_FILES = (JSON.parse(table.payloads.std as string) as { files: Array<{ name: string; size: number; sha256: string; group?: string }> }).files

/** `{staged: <v>, bundle: <set>}`: updates/staging/<v>/ as record §4.6 writes it (the standard payload's entries). */
function plantStaged(drive: Drive, version: string, set: string): void {
  const members = table.sets[set]!.slice(1)
  const entries = STD_FILES.filter((f) => members.some((m) => m.name === f.name))
  const dir = drive.at(`updates/staging/${version}`)
  mkdirSync(join(dir, 'files'), { recursive: true })
  for (const m of members) writeFileSync(join(dir, 'files', m.name), dataOf(m.data))
  writeFileSync(join(dir, 'hilbertraum-release.dsse.json'), '{}')
  writeFileSync(join(dir, 'staged.txt'), entries.map((e) => `${e.size} ${e.name}\n`).join(''))
  const listed = entries.map(({ name, size, sha256: hash, group }) => (group === undefined ? { name, size, sha256: hash } : { name, size, sha256: hash, group }))
  writeFileSync(join(dir, 'staged.json'), JSON.stringify({ format: 1, version, files: listed }))
}

const JUNCTION_OR_LINK: FolderLink = FOLDER_LINKS[0]![1]

function plant(drive: Drive, items: ReadonlyArray<Record<string, unknown>>, folderLink: FolderLink = JUNCTION_OR_LINK): void {
  for (const item of items) {
    if (typeof item.staged === 'string') {
      plantStaged(drive, item.staged, item.bundle as string)
      continue
    }
    const at = drive.at((item.dir ?? item.file ?? item.link) as string)
    if (typeof item.dir === 'string') {
      mkdirSync(at, { recursive: true })
      continue
    }
    mkdirSync(dirname(at), { recursive: true })
    if (typeof item.file === 'string') writeFileSync(at, dataOf(item.data))
    else if (typeof item.link === 'string' && item.target === 'dir') folderLink(drive.at(item.to as string), at)
    else throw new Error(`a drive item this file does not plant: ${JSON.stringify(item)}`)
  }
}

/** A tree as lstat sees it, never through a link. */
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
const isAbsent = (path: string): boolean => snapshot(path) === 'absent'

/** The versions staged on the drive, by their markers (read here, not by the code under test). */
function stagedVersions(drive: Drive): string[] {
  const staging = drive.at('updates/staging')
  if (isAbsent(staging) || !lstatSync(staging).isDirectory()) return []
  return readdirSync(staging).flatMap((name) => {
    try {
      return [(JSON.parse(readFileSync(join(staging, name, 'staged.json'), 'utf8')) as { version: string }).version]
    } catch {
      return []
    }
  })
}

// ---- the file-system calls the service is handed, through recorders that cause a row's faults and holds

const injected = (code: string, syscall: string): Error => Object.assign(new Error(`injected ${code}`), { code, syscall })

interface Rule {
  call: string
  when: (rel: string) => boolean
  error?: Error
  /** Held until the row releases it (the first matching call only). */
  hold?: Gate
  times?: number
}

interface Recorder<T> {
  fs: T
  /** Every call, in order: `<call> <drive-relative path>` (`.` for the root). */
  calls: string[]
}

function armed(drive: Drive, rules: readonly Rule[], calls: string[]): (call: string, path: string) => Promise<void> | void {
  const left = new Map(rules.map((rule) => [rule, rule.times ?? (rule.hold ? 1 : Infinity)]))
  return (call, path) => {
    const rel = drive.rel(path) || '.'
    calls.push(`${call} ${rel}`)
    for (const rule of rules) {
      if (rule.call !== call || !rule.when(rel) || left.get(rule)! <= 0) continue
      left.set(rule, left.get(rule)! - 1)
      if (rule.hold) return rule.hold.hit()
      throw rule.error
    }
  }
}

/** The start step's synchronous calls (NODE_START_FS) and status's, recorded; a rule may fail one. */
function startRecorder(drive: Drive, rules: readonly Rule[] = [], calls: string[] = []): Recorder<StartFileSystem> {
  const check = armed(drive, rules.filter((r) => !r.hold), calls)
  return {
    calls,
    fs: {
      readdirSync: (path) => (check('readdirSync', path), NODE_START_FS.readdirSync(path)),
      lstatSync: (path) => (check('lstatSync', path), NODE_START_FS.lstatSync(path))
    }
  }
}

/** Staging's calls (NODE_STAGING_FS), recorded; a rule fails or holds one; `statfs` answers the row's numbers. */
function stagingRecorder(drive: Drive, rules: readonly Rule[] = [], statfs: { value?: { bsize: number; bavail: number } } = {}): Recorder<StagingFileSystem> & { writes: string[] } {
  const calls: string[] = []
  const writes: string[] = []
  const check = armed(drive, rules, calls)
  const real = NODE_STAGING_FS
  const wrote = (...paths: string[]): void => void writes.push(...paths.map((p) => drive.rel(p)))
  return {
    calls,
    writes,
    fs: {
      readdir: async (path) => (await check('readdir', path), real.readdir(path)),
      lstat: async (path) => (await check('lstat', path), real.lstat(path)),
      realpath: async (path) => (await check('realpath', path), real.realpath(path)),
      mkdir: async (path) => (await check('mkdir', path), wrote(path), real.mkdir(path)),
      rmdir: async (path) => (await check('rmdir', path), wrote(path), real.rmdir(path)),
      unlink: async (path) => (await check('unlink', path), wrote(path), real.unlink(path)),
      rename: async (from, to) => (await check('rename', from), wrote(from, to), real.rename(from, to)),
      statfs: async (path) => (await check('statfs', path), statfs.value ?? real.statfs(path)),
      open: async (path, flags) => {
        await check('open', path)
        if (typeof flags === 'string' ? /[wax+]/.test(flags) : (flags & 3) !== 0 || (flags & 64) !== 0) wrote(path)
        const handle = await real.open(path, flags)
        const wrapped: StagingFileHandle = {
          stat: () => handle.stat(),
          read: async (buffer, offset, length, position) => (await check('read', path), handle.read(buffer, offset, length, position)),
          write: async (buffer, offset, length) => (await check('write', path), handle.write(buffer, offset, length)),
          sync: async () => (await check('sync', path), handle.sync()),
          close: () => handle.close()
        }
        return wrapped
      }
    }
  }
}

/** What the service hands the reader (T6.1): node:fs/promises' open, fs-retry's rename and unlink, recorded: each
 *  update-file handle with its closes, each member opened. A rule fails or holds a call. */
function bundleRecorder(drive: Drive, rules: readonly Rule[] = []): Recorder<BundleFileSystem> & { updateFiles: Array<{ closed: number }>; members: string[] } {
  const calls: string[] = []
  const updateFiles: Array<{ closed: number }> = []
  const members: string[] = []
  const check = armed(drive, rules, calls)
  const wrap = (handle: BundleFileHandle, path: string, onClose: () => void): BundleFileHandle => ({
    stat: () => handle.stat(),
    read: async (buffer, offset, length, position) => (await check('read', path), handle.read(buffer, offset, length, position)),
    write: async (buffer, offset, length) => (await check('write', path), handle.write(buffer, offset, length)),
    sync: () => handle.sync(),
    close: async () => {
      onClose()
      return handle.close()
    }
  })
  return {
    calls,
    updateFiles,
    members,
    fs: {
      open: async (path, flags) => {
        await check('open', path)
        const handle = (await openFile(path, flags)) as unknown as BundleFileHandle
        if (typeof flags === 'number') {
          const file = { closed: 0 }
          updateFiles.push(file)
          return wrap(handle, path, () => file.closed++)
        }
        members.push(basename(path))
        return wrap(handle, path, () => undefined)
      },
      rename: async (from, to) => (await check('rename', from), renameWithRetry(from, to)),
      unlink: async (path) => (await check('unlink', path), unlink(path))
    }
  }
}

// ---- the dialog stub

type DialogAnswer = 'file' | 'closed' | 'hold' | 'throw' | { path: string }
interface Dialog {
  opened: number
  queue: DialogAnswer[]
  reached: Promise<void>
  release(path: string | null): void
}
function dialogStub(file: () => string | null): { dialog: Dialog; chooseFile: (caller: unknown) => Promise<string | null> } {
  let reach!: () => void
  let answer!: (path: string | null) => void
  const dialog: Dialog = {
    opened: 0,
    queue: [],
    reached: new Promise<void>((resolve) => (reach = resolve)),
    release: (path) => answer(path)
  }
  const chooseFile = async (): Promise<string | null> => {
    dialog.opened++
    const next = dialog.queue.shift() ?? 'closed'
    if (next === 'throw') throw new Error('the dialog could not open')
    if (next === 'closed') return null
    if (next === 'file') return file()
    if (next === 'hold') {
      const held = new Promise<string | null>((resolve) => (answer = resolve))
      reach()
      return held
    }
    return next.path
  }
  return { dialog, chooseFile }
}

// ---- one service on one scratch drive

interface HarnessOptions {
  keys?: readonly UpdateKey[]
  startRules?: Rule[]
  /** The array the start recorder writes its calls into (for a hook that runs inside the start step). */
  startCalls?: string[]
  stagingRules?: Rule[]
  bundleRules?: Rule[]
  folderLink?: FolderLink
  startHook?: UpdateServiceDeps['startHook']
  /** A layout of null: a failure state that has none (record §3.5 "A root that is no prepared drive"). */
  noLayout?: boolean
  /** A drive made by the row before the service is built. */
  drive?: Drive
  build?: BuildSpec | null
  dialog?: DialogAnswer[]
}

interface Harness {
  host: Host
  drive: Drive
  service: UpdateService
  start: Recorder<StartFileSystem>
  staging: ReturnType<typeof stagingRecorder>
  bundle: ReturnType<typeof bundleRecorder>
  statfs: { value?: { bsize: number; bavail: number } }
  reads: string[]
  appended: string[]
  dialog: Dialog
  mono: { value: number }
  /** The built update file's path (beside the drive, never on it), or null. */
  file: string | null
  lines(): string[]
}

function writeBuild(drive: Drive, build: BuildSpec, name = 'update.hrupdate'): string {
  const folder = join(drive.dir, 'download')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(path, buildCaseFile(table, build, signers).bytes)
  return path
}

function harness(host: Host, items: ReadonlyArray<Record<string, unknown>> = [], options: HarnessOptions = {}): Harness {
  vi.setSystemTime(new Date(host.now))
  const drive = options.drive ?? makeDrive(host)
  plant(drive, items, options.folderLink)
  const file = options.build ? writeBuild(drive, options.build) : null
  const start = startRecorder(drive, options.startRules, options.startCalls)
  const statfs: Harness['statfs'] = { value: host.statfs }
  const staging = stagingRecorder(drive, options.stagingRules, statfs)
  const bundle = bundleRecorder(drive, options.bundleRules)
  const reads: string[] = []
  const appended: string[] = []
  const mono = { value: 1_000 }
  const { dialog, chooseFile } = dialogStub(() => file)
  dialog.queue.push(...(options.dialog ?? []))
  const service = createUpdateService({
    paths: options.noLayout ? null : { rootPath: drive.root, configPath: drive.at('config'), isPreparedDrive: host.prepared !== false },
    keys: options.keys ?? (host.keys.length === 0 ? [] : TEST_KEYS),
    runningVersion: semver(host.runningVersion),
    host: { platform: host.os, osVersion: () => host.osVersion, glibc: () => host.glibc, uiLanguage: () => host.uiLanguage },
    clock: { now: () => Date.now(), monotonic: () => mono.value },
    reads: {
      policy: (dir) => (reads.push('policy'), readUpdatePolicy(dir)),
      driveRelease: (root) => (reads.push('driveRelease'), readDriveRelease(root)),
      rootApps: (root) => (reads.push('rootApps'), rootApps(root)),
      kitSupport: (root) => (reads.push('kitSupport'), readKitSupport(root)),
      buildDate: () => BUILD_DATE
    },
    chooseFile,
    appendLog: (paths, event, fields) => {
      appended.push(event)
      appendUpdateLogLine(paths, event, fields)
    },
    fs: { bundle: bundle.fs, staging: staging.fs, start: start.fs },
    startHook: options.startHook
  })
  const lines = (): string[] => {
    const log = drive.at('updates/update.log')
    return isAbsent(log) ? [] : readFileSync(log, 'latin1').split('\n').filter((line) => line !== '')
  }
  return { host, drive, service, start, staging, bundle, statfs, reads, appended, dialog, mono, file, lines }
}

/** A line of the record (written for win32) as this system's appender writes it: its OS token is process.platform. */
const onThisSystem = (line: string, os = 'win32'): string => line.replace(`r1-app ${os} `, `r1-app ${process.platform} `)

/** Nothing is written outside `updates/` on the drive (the brief core). */
function expectWritesUnderUpdates(h: Harness): void {
  for (const path of h.staging.writes) expect(/^updates(\/|$)/i.test(path), `written outside updates/: ${path}`).toBe(true)
}

// ---- an answer in the case table's form (cases.json `schema.expect`)

type Answer = Awaited<ReturnType<UpdateService['importFile']>> | Awaited<ReturnType<UpdateService['cancel']>> | Awaited<ReturnType<UpdateService['discardStaged']>>

function tableForm(answer: Answer): Record<string, unknown> {
  if (answer.kind === 'refused') return { answer: 'refused', code: answer.refusal.code, params: answer.refusal.params }
  if (answer.kind === 'staged') return { answer: 'staged', update: answer.update, notices: answer.notices }
  if (answer.kind === 'confirm') return { answer: 'confirm', token: answer.token, update: answer.update, notice: answer.notice, notices: answer.notices }
  if (answer.kind === 'discarded') return { answer: 'discarded', version: answer.version }
  return { answer: answer.kind }
}

function statusForm(s: UpdatesStatus): Record<string, unknown> {
  if (s.drive.kind === 'none') return { drive: 'none' }
  const { updatesFolder, staged, notice, inProgress, sweeping } = s.drive
  return { updatesFolder, staged, notice, inProgress, sweeping }
}

/** `expected` without the keys the table states in words (`token: "not T"`, `dialog`), which the runner checks itself. */
function comparable(expected: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, dialog: _dialog, ...rest } = expected
  return rest
}

interface Expect {
  answer?: string
  code?: string
  params?: Record<string, unknown>
  dialog?: boolean | 'closed'
  log?: { line: string } | null
  after?: { staged?: string | null; absent?: string[]; unchanged?: string[]; nothingWritten?: string[] }
  answers?: Array<Record<string, unknown>>
  lines?: string[]
  status?: Record<string, unknown>
  removed?: string[]
  unchanged?: string[]
}

function before(drive: Drive, e: Expect): Map<string, unknown> {
  const trees = new Map<string, unknown>()
  for (const path of [...(e.after?.unchanged ?? []), ...(e.unchanged ?? [])]) trees.set(path, snapshot(drive.at(path)))
  for (const path of e.after?.nothingWritten ?? []) trees.set(path, snapshot(path === '<userData>' ? drive.userData : drive.root))
  return trees
}

function expectAfter(h: Harness, e: Expect, trees: Map<string, unknown>): void {
  const after = e.after ?? {}
  for (const path of [...(after.absent ?? []), ...(e.removed ?? [])]) expect(isAbsent(h.drive.at(path)), `${path} is absent`).toBe(true)
  for (const [path, tree] of trees) {
    const at = path === '<userData>' ? h.drive.userData : path === '<root>' ? h.drive.root : h.drive.at(path)
    expect(snapshot(at), `${path} is unchanged`).toEqual(tree)
  }
  if (after.staged !== undefined) expect(stagedVersions(h.drive)).toEqual(after.staged === null ? [] : [after.staged])
  if (after.nothingWritten !== undefined) {
    // F-21: nothing read or written under the root (or the user-data folder, which the service is never even handed).
    expect({ start: h.start.calls, staging: h.staging.calls, bundle: h.bundle.calls, reads: h.reads, appended: h.appended }).toEqual({ start: [], staging: [], bundle: [], reads: [], appended: [] })
  }
  expectWritesUnderUpdates(h)
}

// ---- the cases the service owns (case-owners.json), each run through the service's API

/** One import call: the dialog picks the built file (or is closed when the case builds none). */
async function runImport(c: ImportCase): Promise<void> {
  const e = c.expect as Expect
  const h = harness(hostOf(c), c.drive ?? [], { build: c.build, dialog: [c.build ? 'file' : 'closed'] })
  const trees = before(h.drive, e)
  const answer = tableForm(await h.service.importFile())
  expect(answer).toMatchObject(comparable({ answer: e.answer, ...(e.code ? { code: e.code, params: e.params } : {}) }))
  expect(h.dialog.opened, `${c.id}: the dialog`).toBe(e.dialog === false ? 0 : 1)
  expect(h.lines()).toEqual(e.log ? [onThisSystem(e.log.line)] : [])
  expectAfter(h, e, trees)
}

/** The start step on the planted drive, then the status it leaves. */
async function runStart(c: ImportCase, folderLink?: FolderLink): Promise<void> {
  const e = c.expect as Expect
  const h = harness(hostOf(c), c.drive ?? [], { folderLink })
  const trees = before(h.drive, e)
  expect(statusForm(await h.service.status())).toMatchObject(e.status!)
  expect(h.lines()).toEqual((e.lines ?? []).map((line) => onThisSystem(line)))
  // `removed: []`: the start removed nothing, and so wrote nothing (the sweep writes only by its removals).
  if (e.removed !== undefined && e.removed.length === 0) expect(h.staging.writes).toEqual([])
  expectAfter(h, e, trees)
  if (hostOf(c).prepared === false) expect({ start: h.start.calls, staging: h.staging.calls, reads: h.reads }).toEqual({ start: [], staging: [], reads: [] })
}

/** One discard call with the case's argument. */
async function runDiscard(c: ImportCase): Promise<void> {
  const e = c.expect as Expect
  const h = harness(hostOf(c), c.drive ?? [])
  const trees = before(h.drive, e)
  const argument = JSON.parse(/^discardStaged\((.*)\)$/.exec(c.calls![0]!)![1]!) as unknown
  expect(tableForm(await h.service.discardStaged(argument))).toEqual({ answer: e.answer, code: e.code, params: e.params })
  expect(h.lines()).toEqual(e.lines ?? [])
  expectAfter(h, e, trees)
  if (hostOf(c).prepared === false) expect({ start: h.start.calls, staging: h.staging.calls, reads: h.reads }).toEqual({ start: [], staging: [], reads: [] })
}

type Step = (h: Harness) => Promise<Record<string, unknown> | null>
/** A run whose answer is checked at the end; `pending` stands for it while it has not answered. */
interface Scripted {
  /** The 10 s wait's timer is faked before the service is built (its timer starts with the sweep). */
  fakeTimeout?: boolean
  options?: (c: ImportCase) => HarnessOptions
  /** The calls of the case, in order; each answers its table form (null for a step that is no channel call). */
  run: (h: Harness, c: ImportCase) => Promise<Array<Record<string, unknown> | null>>
}

const importAnswer = async (h: Harness, argument?: unknown): Promise<Record<string, unknown>> => tableForm(await h.service.importFile(argument))
const statusAnswer = async (h: Harness): Promise<Record<string, unknown>> => ({ status: statusForm(await h.service.status()) })
const tokenOf = (answer: Record<string, unknown>): string => {
  expect(answer.answer, JSON.stringify(answer)).toBe('confirm')
  expect(answer.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  return answer.token as string
}
const otherCaseBuild = (id: string): BuildSpec => caseOf(id).build!

const SCRIPTS: Readonly<Record<string, Scripted>> = {
  'pre-repeat-same-refusal-one-line': { run: async (h) => [await importAnswer(h), await importAnswer(h), await importAnswer(h)] },
  'pre-repeat-after-another-refusal-logs-again': {
    run: async (h) => {
      const first = await importAnswer(h)
      setPolicy(h.drive, { install: 'allowed', maxVersion: null })
      mkdirSync(h.drive.at('updates/applying'))
      const second = await importAnswer(h)
      setPolicy(h.drive, { install: 'managed', maxVersion: null })
      return [first, null, second, null, await importAnswer(h)]
    }
  },
  'pre-repeat-with-a-discard-line-between': {
    run: async (h) => [await importAnswer(h), tableForm(await h.service.discardStaged({ version: '1.1.0' })), await importAnswer(h)]
  },
  'pre-repeat-after-same-code-past-the-dialog': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      h.statfs.value = { bsize: 4096, bavail: 16383 }
      return [first, null, await importAnswer(h), await importAnswer(h)]
    }
  },
  'argument-without-own-token-opens-the-dialog': {
    run: async (h) => {
      const answers = [await importAnswer(h, 'x'), await importAnswer(h, { other: 1, path: 'C:/x.hrupdate' }), await importAnswer(h, {})]
      expect(h.dialog.opened).toBe(3)
      return answers
    }
  },
  'pay-issued-365d-1s-confirmed': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      const second = await importAnswer(h, { confirmToken: tokenOf(first) })
      expect(h.dialog.opened, 'the second call opens no dialog').toBe(1)
      return [first, second]
    }
  },
  'token-unknown': {
    run: async (h) => {
      const answers = [await importAnswer(h, { confirmToken: '00000000-0000-4000-8000-000000000000' }), await importAnswer(h, { confirmToken: 7 })]
      expect(h.dialog.opened).toBe(0)
      return answers
    }
  },
  'token-spent-by-early-refusal': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      const token = tokenOf(first)
      mkdirSync(h.drive.at('updates/applying'))
      const second = await importAnswer(h, { confirmToken: token })
      rmdirSync(h.drive.at('updates/applying'))
      return [first, null, second, null, await importAnswer(h, { confirmToken: token })]
    }
  },
  'token-spent-by-dialog-call': {
    options: () => ({ dialog: ['file', 'closed'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      const token = tokenOf(first)
      return [first, await importAnswer(h), await importAnswer(h, { confirmToken: token })]
    }
  },
  'token-redeem-file-no-longer-old': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      vi.setSystemTime(new Date('2026-11-26T10:00:00Z'))
      return [first, null, await importAnswer(h, { confirmToken: tokenOf(first) })]
    }
  },
  'token-redeem-file-now-another-version': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      const token = tokenOf(first)
      writeFileSync(h.file!, buildCaseFile(table, otherCaseBuild('pay-old-file-other-version'), signers).bytes)
      const second = await importAnswer(h, { confirmToken: token })
      expect(tokenOf(second), 'a new token').not.toBe(token)
      return [first, null, second, await importAnswer(h, { confirmToken: token })]
    }
  },
  'cancel-while-checking-before-the-dialog': {
    options: (c) => {
      const inject = c.inject![0] as { code: string; syscall: string }
      return {
        stagingRules: [
          { call: 'open', when: (rel) => rel === 'updates/.write-probe', error: injected(inject.code, inject.syscall), times: 1 },
          { call: 'open', when: (rel) => rel === 'updates/.write-probe', hold: held }
        ]
      }
    },
    run: async (h) => {
      const run = tracked(h.service.importFile())
      await held.reached
      expect((await h.service.status()).import.state).toBe('checking')
      const cancel = tableForm(await h.service.cancel())
      held.release()
      const answer = tableForm(await run.promise)
      expect(h.dialog.opened).toBe(0)
      return [answer, cancel]
    }
  },
  'cancel-while-choosing': {
    options: () => ({ dialog: ['hold'] }),
    run: async (h) => {
      const run = tracked(h.service.importFile())
      await h.dialog.reached
      expect((await h.service.status()).import.state).toBe('choosing')
      const cancel = tableForm(await h.service.cancel())
      // The dialog returns a path (one nothing is at): a cancelled run reads nothing.
      h.dialog.release(join(h.drive.dir, 'download', 'picked.hrupdate'))
      const answer = tableForm(await run.promise)
      expect(h.bundle.calls).toEqual([])
      return [answer, cancel, null]
    }
  },
  'cancel-while-committing': {
    options: () => ({ dialog: ['file'], stagingRules: [{ call: 'readdir', when: (rel) => rel === 'updates/staging', hold: held }] }),
    run: async (h) => {
      const run = tracked(h.service.importFile())
      await held.reached
      expect((await h.service.status()).import.state).toBe('committing')
      const cancel = tableForm(await h.service.cancel())
      held.release()
      return [tableForm(await run.promise), cancel]
    }
  },
  'cancel-idle': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => {
      const first = await importAnswer(h)
      const token = tokenOf(first)
      return [first, tableForm(await h.service.cancel()), await importAnswer(h, { confirmToken: token })]
    }
  },
  'busy-second-call': {
    options: () => ({ dialog: ['hold'] }),
    run: async (h) => {
      const run = tracked(h.service.importFile())
      await h.dialog.reached
      const second = await importAnswer(h)
      const third = await importAnswer(h, { confirmToken: 'anything' })
      const first = run.settled() ? tableForm(await run.promise) : { answer: 'pending' }
      expect(h.dialog.opened, 'the busy calls open no dialog').toBe(1)
      h.dialog.release(null)
      expect(tableForm(await run.promise)).toEqual({ answer: 'closed' })
      return [first, second, third]
    }
  },
  'start-applying-stat-fails': {
    options: (c) => {
      const inject = c.inject![0] as { code: string; syscall: string }
      return { startRules: [{ call: 'lstatSync', when: (rel) => rel === 'updates/applying', error: injected(inject.code, inject.syscall), times: 1 }] }
    },
    run: async (h) => [null, await statusAnswer(h), tableForm(await h.service.discardStaged({ version: '1.1.0' }))]
  },
  'start-notice-until-a-commit': {
    options: () => ({ dialog: ['file'] }),
    run: async (h) => [null, await statusAnswer(h), await importAnswer(h), await statusAnswer(h)]
  },
  'start-wait-ends-after-10-s': {
    fakeTimeout: true,
    options: () => ({ stagingRules: [{ call: 'readdir', when: (rel) => rel === 'updates/staging', hold: held }] }),
    run: async (h) => {
      await held.reached // the asynchronous part is in its reads, its 10 s counted from its start
      const waiting = tracked(h.service.status())
      await vi.advanceTimersByTimeAsync(9_999)
      expect(waiting.settled(), 'a call waits while the sweep goes on').toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const status = { status: statusForm(await waiting.promise) }
      const answers = [status, await importAnswer(h), tableForm(await h.service.discardStaged({ version: '1.1.0' })), tableForm(await h.service.cancel())]
      held.release()
      vi.useRealTimers()
      await vi.waitFor(async () => expect((await h.service.status()).drive).toMatchObject({ sweeping: false }), { timeout: hangBudgetMs(5_000) })
      return [null, ...answers, null, await statusAnswer(h)]
    }
  },
  'discard-while-a-run-goes': {
    options: () => ({ dialog: ['hold'] }),
    run: async (h) => {
      const run = tracked(h.service.importFile())
      await h.dialog.reached
      const discard = tableForm(await h.service.discardStaged({ version: '1.1.0' }))
      const first = run.settled() ? tableForm(await run.promise) : { answer: 'pending' }
      h.dialog.release(null)
      await run.promise
      return [first, discard]
    }
  }
}
/** The hold a script's rule and its run share (a fresh one per case, set before the harness is built). */
let held: Gate = gate()

async function runCalls(c: ImportCase): Promise<void> {
  const script = SCRIPTS[c.id]!
  const e = c.expect as Expect
  held = gate()
  if (script.fakeTimeout) {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  }
  const options = { build: c.build, ...script.options?.(c) }
  const h = harness(hostOf(c), c.drive ?? [], options)
  const trees = before(h.drive, e)
  const answers = await script.run(h, c)
  expect(answers.length, `${c.id}: one entry per step of calls`).toBe(c.calls!.length)
  const channelAnswers = answers.filter((a): a is Record<string, unknown> => a !== null)
  expect(channelAnswers.length).toBe(e.answers!.length)
  e.answers!.forEach((expected, i) => {
    expect(channelAnswers[i], `${c.id}: answer ${i}`).toMatchObject(comparable(expected))
    if (expected.dialog === false) expect(h.dialog.opened).toBe(0)
  })
  expect(h.lines()).toEqual(e.lines!.map((line) => onThisSystem(line)))
  expectAfter(h, e, trees)
}

const SERVICE_CASES = table.cases.filter((c) => OWNERS[c.id] === 'service')

async function runCase(c: ImportCase): Promise<void> {
  if (c.kind === 'calls') return runCalls(c)
  if (c.kind === 'start') return runStart(c)
  if (c.kind === 'discard') return runDiscard(c)
  return runImport(c)
}

describe('the cases the service owns (case-owners.json; cases.json; record §3.5, §3.6, §4.5)', () => {
  it('runs exactly the ids case-owners.json gives the service: 33, each with its runner (and the fixture gives every case one owner)', () => {
    expect(Object.keys(OWNERS).sort()).toEqual(table.cases.map((c) => c.id).sort())
    expect(new Set(Object.values(OWNERS))).toEqual(new Set(['bundle', 'staging', 'service']))
    expect(SERVICE_CASES.length).toBe(33)
    const unrunnable = SERVICE_CASES.filter((c) => (c.kind === 'calls' ? SCRIPTS[c.id] === undefined : !['import', 'start', 'discard'].includes(c.kind ?? 'import')))
    expect(unrunnable.map((c) => c.id)).toEqual([])
    expect(Object.keys(SCRIPTS).filter((id) => OWNERS[id] !== 'service')).toEqual([])
  })

  it.each(SERVICE_CASES.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    await runCase(c)
  })

  // The start step's real-folder test of updates/ (the links row) with every folder link this machine can make.
  const links = FOLDER_LINKS.filter(([, , can]) => can).slice(1)
  if (links.length > 0) {
    it.each(links.map(([label, make]) => [label, make] as const))('start-updates-not-real with %s', async (_label, make) => {
      await runStart(caseOf('start-updates-not-real'), make)
    })
  } else {
    it.skip('no other kind of folder link can be made on this machine', () => undefined)
  }
})

// ---- the golden update file on a real drive (contract item 2; F-5, F-11, F-16)

interface GoldenStaged {
  file: string
  envelope: { size: number; sha256: string }
  version: string
  issued: string
  membersInFileOrder: Array<{ name: string; size: number; sha256: string }>
  stagedTxt: string
  stagedJson: string
}
const F5 = JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'f5-staged.json'), 'utf8')) as { staged: GoldenStaged[] }
const GOLDEN = F5.staged.find((s) => s.file === 'golden.hrupdate')!
const GOLDEN_KEYS = keySet((JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'golden-keys.json'), 'utf8')) as { keys: string[] }).keys)
const IMPORT_VECTORS = (
  JSON.parse(readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log', 'vectors-import.json'), 'utf8')) as {
    emit: { vectors: Array<{ name: string; line: string }> }
  }
).emit.vectors
const vector = (name: string): string => IMPORT_VECTORS.find((v) => v.name === name)!.line
/** The golden's own summaries (its payload, read here from member 0's bytes), for the answer's `summary`. */
const GOLDEN_SUMMARY = (() => {
  const bytes = readFileSync(join(UPDATES_FIXTURES, 'golden.hrupdate'))
  const envelope = JSON.parse(bytes.subarray(512, 512 + GOLDEN.envelope.size).toString('utf8')) as { payload: string }
  return (JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as { summary: Record<string, string> }).summary
})()
/** Vector i56 ("a plain staged update") with the golden's version and member count: the line one import of it writes. */
const goldenStagedLine = (staleDrive = 'no'): string =>
  vector('i56')
    .replace('version=1.1.0', `version=${GOLDEN.version}`)
    .replace('stale_drive_version=no', `stale_drive_version=${staleDrive}`)
    .replace('files=5', `files=${GOLDEN.membersInFileOrder.length}`)

/** A source folder on another folder than the drive, in Cyrillic with `&` and `%` (the brief core). */
const SOURCE_FOLDER = '\u{41E}\u{431}\u{43D}\u{43E}\u{432}\u{43B}\u{435}\u{43D}\u{438}\u{435} & 100%'

function goldenHarness(host: Host, options: HarnessOptions = {}): Harness & { source: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hr-updates-service-golden-'))
  const drive = makeDrive(host, dir)
  const source = join(dir, SOURCE_FOLDER, 'golden.hrupdate')
  mkdirSync(dirname(source))
  writeFileSync(source, readFileSync(join(UPDATES_FIXTURES, 'golden.hrupdate')))
  const h = harness(host, [], { keys: GOLDEN_KEYS, drive, dialog: [{ path: source }], ...options })
  return { ...h, source }
}

describe('one import of the golden update file on a real scratch drive (contract item 2; F-5, F-11, F-16)', () => {
  const hosts: Array<[string, Host]> = [
    ['win32', WIN32],
    ['darwin, in German', { ...hostOf({ id: 'darwin', host: 'darwin' }), uiLanguage: 'de' }],
    ['linux', hostOf({ id: 'linux', host: 'linux' })]
  ]
  it.each(hosts)('on %s: F-5\u{2019}s bytes staged, the F-11 line written, no path and no file name in any line', async (_label, host) => {
    const h = goldenHarness(host)
    const answer = await h.service.importFile()
    expect(answer).toEqual({
      kind: 'staged',
      update: { version: GOLDEN.version, issued: GOLDEN.issued, summary: GOLDEN_SUMMARY[host.uiLanguage] ?? GOLDEN_SUMMARY.en },
      notices: []
    })
    const dir = h.drive.at(`updates/staging/${GOLDEN.version}`)
    expect(readdirSync(h.drive.at('updates/staging'))).toEqual([GOLDEN.version])
    expect(readdirSync(dir).sort()).toEqual(['files', 'hilbertraum-release.dsse.json', 'staged.json', 'staged.txt'])
    expect(readFileSync(join(dir, 'staged.txt'), 'latin1')).toBe(GOLDEN.stagedTxt)
    expect(readFileSync(join(dir, 'staged.json'), 'latin1')).toBe(GOLDEN.stagedJson)
    const envelope = readFileSync(join(dir, 'hilbertraum-release.dsse.json'))
    expect({ size: envelope.length, sha256: sha256(envelope) }).toEqual({ size: GOLDEN.envelope.size, sha256: GOLDEN.envelope.sha256 })
    expect(readdirSync(join(dir, 'files')).sort()).toEqual(GOLDEN.membersInFileOrder.map((m) => m.name).sort())
    for (const m of GOLDEN.membersInFileOrder) expect(sha256(readFileSync(join(dir, 'files', m.name))), m.name).toBe(m.sha256)
    expect(stagedVersions(h.drive)).toEqual([GOLDEN.version])
    const lines = h.lines()
    expect(lines).toHaveLength(1)
    // Every line, scanned: no part of the scratch path (in either separator, any case) and no file or folder name.
    const forbidden = [
      h.drive.dir,
      h.drive.dir.split(sep).join('/'),
      ...h.drive.dir.split(/[\\/]/).filter((part) => part.length > 3),
      SOURCE_FOLDER,
      'golden',
      '.hrupdate',
      'hilbertraum-release',
      'staged.',
      ...GOLDEN.membersInFileOrder.map((m) => m.name)
    ]
    for (const line of lines) {
      expect(line, 'ASCII only').toMatch(/^[\x20-\x7e]+$/)
      for (const text of forbidden) expect(line.toLowerCase().includes(text.toLowerCase()), `${line} holds ${text}`).toBe(false)
    }
    expect(lines).toEqual([onThisSystem(goldenStagedLine())])
    expectWritesUnderUpdates(h)
  })
})

// ---- the payload check's input as the service builds it once per import (CF-50) and the reads it rests on

describe('the payload check\u{2019}s input: the host, the policy\u{2019}s cap and the drive record, read once per import (CF-50; record §2.5, §2.10, §3.6)', () => {
  // Expected values by hand from record §2.10's parameters and the golden payload (version 1.2.0; requires win32
  // 10.0.19045, linux 2.31), with §4.5's events for the line.
  const rows: Array<[string, Host, Record<string, unknown>, string]> = [
    [
      'a policy cap below the update: UPD-ABOVE-MAX-VERSION with the cap\u{2019}s text',
      { ...WIN32, policy: { install: 'allowed', maxVersion: '1.1.0' } },
      { kind: 'refused', refusal: { code: 'UPD-ABOVE-MAX-VERSION', params: { version: '1.2.0', maxVersion: '1.1.0' } } },
      'r1-app win32 import-refused code=UPD-ABOVE-MAX-VERSION version=1.2.0 stale_drive_version=no t=2026-11-27T10:00:00Z'
    ],
    [
      'the drive\u{2019}s app_version ahead, carried by a root app: UPD-SAME-OR-OLDER with the drive\u{2019}s version',
      { ...WIN32, driveAppVersion: '1.3.0', rootApps: ['HilbertRaum-1.3.0-portable.exe'] },
      { kind: 'refused', refusal: { code: 'UPD-SAME-OR-OLDER', params: { version: '1.2.0', runningVersion: '1.0.0', driveVersion: '1.3.0' } } },
      'r1-app win32 import-refused code=UPD-SAME-OR-OLDER version=1.2.0 stale_drive_version=no t=2026-11-27T10:00:00Z'
    ],
    [
      'the drive\u{2019}s app_version ahead and carried by no root app: stale, so staged, with stale_drive_version=yes',
      { ...WIN32, driveAppVersion: '1.3.0' },
      { kind: 'staged' },
      goldenStagedLine('yes')
    ],
    [
      'Windows below the floor: UPD-OS-TOO-OLD with the host\u{2019}s version as the host gave it',
      { ...WIN32, osVersion: '10.0.19044' },
      { kind: 'refused', refusal: { code: 'UPD-OS-TOO-OLD', params: { runningVersion: '1.0.0', system: 'win32', floor: '10.0.19045', hostVersion: '10.0.19044' } } },
      'r1-app win32 import-refused code=UPD-OS-TOO-OLD stale_drive_version=no t=2026-11-27T10:00:00Z'
    ],
    [
      'Linux below the floor: UPD-OS-TOO-OLD with the runtime glibc',
      { ...hostOf({ id: 'linux', host: 'linux' }), glibc: '2.30' },
      { kind: 'refused', refusal: { code: 'UPD-OS-TOO-OLD', params: { runningVersion: '1.0.0', system: 'linux', floor: '2.31', hostVersion: '2.30' } } },
      'r1-app linux import-refused code=UPD-OS-TOO-OLD stale_drive_version=no t=2026-11-27T10:00:00Z'
    ]
  ]
  it.each(rows)('%s', async (_label, host, answer, line) => {
    const h = goldenHarness(host)
    expect(await h.service.importFile()).toMatchObject(answer)
    expect(h.lines()).toEqual([onThisSystem(line, host.os)])
    expect(h.reads.filter((r) => r !== 'kitSupport')).toEqual(['policy', 'driveRelease', 'rootApps'])
  })
})

// ---- the order of an import (contract item 4; record §4.5 "Order of an import", §3.6)

describe('the order of an import (record §4.5 "Order of an import", §3.6; contract item 4)', () => {
  it('before the key set: a call that redeems a token answers expired even when the build embeds no key; then UPD-NOT-AVAILABLE, logged', async () => {
    const h = harness(WIN32, [], { keys: [] })
    expect(await h.service.importFile({ confirmToken: 'x' })).toEqual({ kind: 'expired' })
    expect(h.lines()).toEqual([])
    expect(await h.service.importFile()).toEqual({ kind: 'refused', refusal: { code: 'UPD-NOT-AVAILABLE', params: {} } })
    expect(h.lines()).toEqual([onThisSystem(vector('i1'))])
    expect({ reads: h.reads, dialog: h.dialog.opened }).toEqual({ reads: [], dialog: 0 })
  })

  it('a sweep that outlasts the wait answers busy before anything, an empty key set included', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    held = gate()
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }], { keys: [], stagingRules: [{ call: 'readdir', when: (rel) => rel === 'updates/staging', hold: held }] })
    await held.reached
    const answer = tracked(h.service.importFile())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await answer.promise).toEqual({ kind: 'busy' })
    held.release()
    vi.useRealTimers()
    await vi.waitFor(async () => expect((await h.service.status()).drive).toMatchObject({ sweeping: false }), { timeout: hangBudgetMs(5_000) })
    expect(await h.service.importFile()).toEqual({ kind: 'refused', refusal: { code: 'UPD-NOT-AVAILABLE', params: {} } })
  })

  it('updates/applying/ present: UPD-IN-PROGRESS before the dialog opens, and nothing is read', async () => {
    const h = harness(WIN32, [{ dir: 'updates/applying' }], { build: caseOf('pay-issued-365d-1s-confirmed').build, dialog: ['file'] })
    expect(await h.service.importFile()).toEqual({ kind: 'refused', refusal: { code: 'UPD-IN-PROGRESS', params: {} } })
    expect({ dialog: h.dialog.opened, bundle: h.bundle.calls }).toEqual({ dialog: 0, bundle: [] })
  })

  it('the checks before the data pass come before the old-file stop: an old file under the free-space formula is refused, never asked', async () => {
    // Record §4.5's order; the numbers as space-order-before-old-file states them for this file and drive.
    const h = harness({ ...WIN32, statfs: { bsize: 4096, bavail: 16389 } }, [], { build: caseOf('pay-issued-365d-1s-confirmed').build, dialog: ['file'] })
    expect(await h.service.importFile()).toEqual({ kind: 'refused', refusal: { code: 'UPD-DRIVE-FULL', params: { requiredBytes: 67133440, freeBytes: 67129344 } } })
    expect(h.lines()).toEqual([onThisSystem('r1-app win32 import-refused code=UPD-DRIVE-FULL version=1.1.0 stale_drive_version=no t=2026-11-27T10:00:00Z')])
  })

  it('a re-import replaces the version\u{2019}s staging folder and clears its failed mark (record §4.5 "The cleared line", CF-53)', async () => {
    const replaced = caseOf('accept-replaces-staged-same-version').expect as { after: { stagedJson: string; stagedTxt: string } }
    const append = (JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'last-result.json'), 'utf8')) as { append: { pattern: string } }).append
    const marked = '\nfallback 1.1.0 0123456789abcdef\n'
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'win-only' }, { file: 'updates/last-result.txt', data: { text: marked } }], {
      build: caseOf('accept-replaces-staged-same-version').build,
      dialog: ['file']
    })
    expect((await h.service.status()).drive).toMatchObject({ staged: { version: '1.1.0' } })
    expect(await h.service.importFile()).toMatchObject({ kind: 'staged', update: { version: '1.1.0' } })
    expect(readFileSync(h.drive.at('updates/staging/1.1.0/staged.json'), 'latin1')).toBe(replaced.after.stagedJson)
    expect(readFileSync(h.drive.at('updates/staging/1.1.0/staged.txt'), 'latin1')).toBe(replaced.after.stagedTxt)
    const lastResult = readFileSync(h.drive.at('updates/last-result.txt'), 'latin1')
    expect(lastResult.startsWith(marked)).toBe(true)
    expect(lastResult.slice(marked.length)).toMatch(new RegExp(append.pattern.replace('<v>', '1\\.1\\.0')))
    expect(h.lines()).toEqual([onThisSystem(vector('i56'))])
  })
})

// ---- the start step (contract item 5; record §4.5 "The start step", §3.5 "The service and its start")

describe('the start step: a synchronous part of lstats, then the sweep on a later turn, and one wait for it (record §4.5 "The start step")', () => {
  it('the synchronous part lists the root and lstats updates/ and updates/applying/ only; the sweep\u{2019}s calls come after it returned', async () => {
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }])
    expect(h.start.calls).toEqual(['readdirSync .', 'lstatSync updates', 'lstatSync updates/applying'])
    expect(h.staging.calls, 'nothing of the sweep before the start step returned').toEqual([])
    expect(statusForm(await h.service.status())).toMatchObject({ staged: { version: '1.1.0' }, sweeping: false })
    expect(h.staging.calls.length).toBeGreaterThan(0)
  })

  it('P7\u{2019}s place runs after the test of updates/ and before step (2) and the sweep: a hook that removes updates/applying/ lets the sweep run (CF-54)', async () => {
    const startCalls: string[] = []
    const order: string[] = []
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }, { dir: 'updates/applying' }], {
      startCalls,
      startHook: ({ updatesDir }) => {
        order.push(...startCalls, 'hook')
        rmdirSync(join(updatesDir, 'applying'))
      }
    })
    expect(order).toEqual(['readdirSync .', 'lstatSync updates', 'hook'])
    expect(h.start.calls).toEqual(['readdirSync .', 'lstatSync updates', 'lstatSync updates/applying'])
    expect(statusForm(await h.service.status())).toMatchObject({ staged: { version: '1.1.0' }, inProgress: false })
    const none: string[] = []
    const missing = harness(WIN32, [], { startHook: () => void none.push('hook') })
    await missing.service.status()
    expect(none, 'no updates/: nothing more of the start step runs').toEqual([])
  })

  it('a call made while the sweep goes on waits for its end when it comes before 10 s, then answers current', async () => {
    held = gate()
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }], { stagingRules: [{ call: 'readdir', when: (rel) => rel === 'updates/staging', hold: held }] })
    await held.reached
    const status = tracked(h.service.status())
    await turns(20)
    expect(status.settled()).toBe(false)
    held.release()
    expect(statusForm(await status.promise)).toMatchObject({ staged: { version: '1.1.0' }, notice: null, sweeping: false })
  })

  it('the drive part is read at most once per 250 ms; staged, notice and sweeping are current; a commit and a discard end the reads', async () => {
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }], { build: caseOf('accept-replaces-staged-same-version').build, dialog: ['file'] })
    const policyReads = (): number => h.reads.filter((r) => r === 'policy').length
    const policy = async (): Promise<unknown> => {
      const drive = (await h.service.status()).drive
      return drive.kind === 'prepared' ? drive.policy : null
    }
    expect(await policy()).toEqual({ install: 'allowed', maxVersion: null, file: 'unreadable' })
    setPolicy(h.drive, { install: 'allowed', maxVersion: '9.9.9' })
    h.mono.value += 249
    expect(await policy(), 'inside 250 ms: the last reads').toEqual({ install: 'allowed', maxVersion: null, file: 'unreadable' })
    expect(policyReads()).toBe(1)
    h.mono.value += 1
    expect(await policy()).toEqual({ install: 'allowed', maxVersion: '9.9.9', file: 'read' })
    expect(policyReads()).toBe(2)
    // A discard ends the reads, and staged is current at once.
    setPolicy(h.drive, { install: 'allowed', maxVersion: null })
    expect(await h.service.discardStaged({ version: '1.1.0' })).toEqual({ kind: 'discarded', version: '1.1.0' })
    const afterDiscard = (await h.service.status()).drive
    expect(afterDiscard).toMatchObject({ staged: null, policy: { install: 'allowed', maxVersion: null, file: 'unreadable' } })
    expect(policyReads()).toBe(3)
    // While a run goes, the policy is the run's own read, also when the drive is read again meanwhile.
    seams.beforeStage = async () => {
      setPolicy(h.drive, { install: 'allowed', maxVersion: '9.9.9' })
      h.mono.value += 250
      expect(await policy(), 'the run\u{2019}s own read').toEqual({ install: 'allowed', maxVersion: null, file: 'unreadable' })
    }
    expect(await h.service.importFile()).toMatchObject({ kind: 'staged' })
    // A commit ends the reads: the file changed again, and the clock has not moved since the last read.
    setPolicy(h.drive, { install: 'allowed', maxVersion: '9.9.8' })
    const afterCommit = (await h.service.status()).drive
    expect(afterCommit).toMatchObject({ staged: { version: '1.1.0' }, policy: { install: 'allowed', maxVersion: '9.9.8', file: 'read' } })
  })
})

// ---- what the service hands the reader, and what it does with the checked file (contract item 3; T6.1 review m-3, m-5)

const STD_BUILD = (): BuildSpec => caseOf('accept-replaces-staged-same-version').build!
const STD_TOTAL = STD_FILES.reduce((sum, f) => sum + f.size, 0)

describe('the hooks handed to the reader never throw, and the checked file is staged once before it is closed (T6.1 review m-3, m-5)', () => {
  it('progress shows while copying; a status write that fails inside progress is caught there; cancelled() never throws', async () => {
    const h = harness(WIN32, [], { build: STD_BUILD(), dialog: ['file'] })
    const copying = gate()
    seams.beforeStage = () => copying.hit()
    const run = tracked(h.service.importFile())
    await copying.reached
    const { cancelled, progress } = seams.files[0]!.options!
    expect(seams.reads[0]!.cancelled()).toBe(false)
    progress(100)
    expect((await h.service.status()).import).toEqual({
      state: 'copying',
      done: 100,
      total: STD_TOTAL,
      update: { version: '1.1.0', issued: '2026-11-20T08:00:00Z', summary: null },
      notices: []
    })
    const hostile = { valueOf: () => { throw new Error('a status write that fails') } } as unknown as number
    expect(() => progress(hostile)).not.toThrow()
    expect(cancelled()).toBe(false)
    copying.release()
    expect(await run.promise).toMatchObject({ kind: 'staged' })
    expect(() => progress(5)).not.toThrow()
    expect(() => cancelled()).not.toThrow()
    expect((await h.service.status()).import).toEqual({ state: 'idle' })
  })

  // Each end of a run: the answer, its one line (record §4.5's events, by hand), how often the checked file was staged
  // and closed, and every handle of the update file closed once.
  interface End {
    build?: () => BuildSpec
    host?: Host
    options?: () => HarnessOptions
    during?: (h: Harness) => Promise<void>
    answer: Record<string, unknown>
    line: string | null
    stage: number
    checked: boolean
  }
  const CANT_WRITE = { kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} } }
  const ends: Array<[string, End]> = [
    ['staged', { answer: { kind: 'staged' }, line: vector('i56'), stage: 1, checked: true }],
    [
      'refused before the data pass (the free-space formula)',
      {
        host: { ...WIN32, statfs: { bsize: 4096, bavail: 16385 } },
        answer: { kind: 'refused', refusal: { code: 'UPD-DRIVE-FULL' } },
        line: 'r1-app win32 import-refused code=UPD-DRIVE-FULL version=1.1.0 stale_drive_version=no t=2026-11-27T10:00:00Z',
        stage: 0,
        checked: true
      }
    ],
    [
      'the old-file stop',
      {
        build: () => caseOf('pay-issued-365d-1s-confirmed').build!,
        answer: { kind: 'confirm' },
        line: 'r1-app win32 import-refused code=UPD-OLD-FILE version=1.1.0 stale_drive_version=no t=2026-11-27T10:00:00Z',
        stage: 0,
        checked: true
      }
    ],
    [
      'cancelled after the read, before the data pass',
      {
        options: () => ({ stagingRules: [{ call: 'statfs', when: () => true, hold: held, times: 1 }, { call: 'statfs', when: () => true, hold: held2 }] }),
        during: async (h) => {
          held.release() // the margin before the dialog
          await held2.reached // free space before the data pass
          expect(await h.service.cancel()).toEqual({ kind: 'stopping' })
          held2.release()
        },
        answer: { kind: 'cancelled' },
        line: vector('i68'),
        stage: 0,
        checked: true
      }
    ],
    [
      'refused in the data pass (a member\u{2019}s write fails EIO)',
      {
        options: () => ({ bundleRules: [{ call: 'write', when: (rel) => rel.startsWith('updates/staging/.incoming-'), error: injected('EIO', 'write'), times: 1 }] }),
        answer: CANT_WRITE,
        line: 'r1-app win32 import-refused code=UPD-CANT-WRITE-DRIVE version=1.1.0 stale_drive_version=no err=EIO syscall=write t=2026-11-27T10:00:00Z',
        stage: 1,
        checked: true
      }
    ],
    [
      'cancelled in the data pass',
      {
        options: () => ({ bundleRules: [{ call: 'open', when: (rel) => rel.startsWith('updates/staging/.incoming-'), hold: held }] }),
        during: async (h) => {
          await held.reached
          expect(await h.service.cancel()).toEqual({ kind: 'stopping' })
          held.release()
        },
        answer: { kind: 'cancelled' },
        line: vector('i68'),
        stage: 1,
        checked: true
      }
    ],
    [
      'refused at the commit (the rename of staged.json.tmp fails EIO)',
      {
        options: () => ({ stagingRules: [{ call: 'rename', when: (rel) => rel === 'updates/staging/1.1.0/staged.json.tmp', error: injected('EIO', 'rename') }] }),
        answer: CANT_WRITE,
        line: 'r1-app win32 import-refused code=UPD-CANT-WRITE-DRIVE version=1.1.0 stale_drive_version=no err=EIO syscall=rename t=2026-11-27T10:00:00Z',
        stage: 1,
        checked: true
      }
    ],
    [
      'staged with the warning for a file issued more than 24 hours ahead (shown and logged)',
      {
        build: () => ({ payload: 'issued-24h-1s', members: 'std' }),
        answer: { kind: 'staged', notices: [{ code: 'UPD-ISSUED-IN-FUTURE', params: { issued: payloadOf('issued-24h-1s').issued } }] },
        line: 'r1-app win32 import-staged version=1.1.0 stale_drive_version=no files=5 old_file=no issued_in_future=yes other_floors=no t=2026-11-27T10:00:00Z',
        stage: 1,
        checked: true
      }
    ],
    [
      'staged with the warning about the floor of another system the drive carries (shown and logged)',
      {
        host: { ...WIN32, rootApps: ['HilbertRaum-1.0.0-portable.exe', 'HilbertRaum-1.0.0-mac-arm64.app.zip'] },
        build: () => ({ payload: 'darwin-floor', members: 'std' }),
        answer: { kind: 'staged', notices: [{ code: 'UPD-OTHER-SYSTEM-FLOOR', params: { floors: [{ system: 'darwin', floor: payloadOf('darwin-floor').requires!.darwin }] } }] },
        line: 'r1-app win32 import-staged version=1.1.0 stale_drive_version=no files=5 old_file=no issued_in_future=no other_floors=yes t=2026-11-27T10:00:00Z',
        stage: 1,
        checked: true
      }
    ],
    [
      'refused by the reader with a version of 25 to 64 bytes: logged as unknown',
      {
        host: { ...WIN32, driveAppVersion: null },
        build: () => ({ payload: 'ver-long-older', members: 'std' }),
        answer: { kind: 'refused', refusal: { code: 'UPD-SAME-OR-OLDER', params: { version: payloadOf('ver-long-older').version, runningVersion: '1.0.0', driveVersion: null } } },
        line: 'r1-app win32 import-refused code=UPD-SAME-OR-OLDER version=unknown stale_drive_version=no t=2026-11-27T10:00:00Z',
        stage: 0,
        checked: false
      }
    ],
    [
      'refused before the dialog by a listing that fails: the link and the error logged (vector i108)',
      {
        options: () => ({ stagingRules: [{ call: 'readdir', when: (rel) => rel === 'updates', error: injected('EIO', 'scandir') }] }),
        answer: CANT_WRITE,
        line: vector('i108'),
        stage: 0,
        checked: false
      }
    ],
    [
      'refused by the reader (signed by a key the build does not embed)',
      {
        build: () => caseOf('m0-unknown-signer').build!,
        answer: { kind: 'refused', refusal: { code: 'UPD-UNKNOWN-SIGNER', params: { runningVersion: '1.0.0' } } },
        line: 'r1-app win32 import-refused code=UPD-UNKNOWN-SIGNER t=2026-11-27T10:00:00Z',
        stage: 0,
        checked: false
      }
    ],
    [
      'refused by the reader (the open fails ENOENT: the file went away after the dialog)',
      {
        options: () => ({ bundleRules: [{ call: 'open', when: (rel) => rel.endsWith('update.hrupdate'), error: injected('ENOENT', 'open') }] }),
        answer: { kind: 'refused', refusal: { code: 'UPD-CANT-READ-FILE', params: {} } },
        line: 'r1-app win32 import-refused code=UPD-CANT-READ-FILE err=ENOENT syscall=open t=2026-11-27T10:00:00Z',
        stage: 0,
        checked: false
      }
    ],
    [
      'cancelled while the reader runs (after the open, before the payload is known)',
      {
        options: () => ({ bundleRules: [{ call: 'open', when: (rel) => rel.endsWith('update.hrupdate'), hold: held }] }),
        during: async (h) => {
          await held.reached
          expect(await h.service.cancel()).toEqual({ kind: 'stopping' })
          held.release()
        },
        answer: { kind: 'cancelled' },
        line: vector('i69'),
        stage: 0,
        checked: false
      }
    ]
  ]
  let held2: Gate = gate()
  it.each(ends)('%s', async (_label, end) => {
    held = gate()
    held2 = gate()
    const h = harness(end.host ?? WIN32, [], { build: (end.build ?? STD_BUILD)(), dialog: ['file'], ...end.options?.() })
    const run = tracked(h.service.importFile())
    await end.during?.(h)
    expect(await run.promise).toMatchObject(end.answer)
    expect(h.lines()).toEqual(end.line === null ? [] : [onThisSystem(end.line)])
    if (end.checked) {
      expect(seams.files).toHaveLength(1)
      const calls = seams.files[0]!
      expect({ stage: calls.stage, close: calls.close }).toEqual({ stage: end.stage, close: 1 })
      expect(calls.order.at(-1), 'closed last').toBe('close')
    } else expect(seams.files).toEqual([])
    expect(h.bundle.updateFiles.map((f) => f.closed), 'every handle of the update file closed once').toEqual(h.bundle.updateFiles.map(() => 1))
    if (end.answer.kind !== 'staged') {
      expect(isAbsent(h.drive.at('updates/staging/1.1.0')), '<v>/ is not left').toBe(true)
      expect(isAbsent(h.drive.at('updates/staging/.incoming-1.1.0')), '.incoming-<v>/ is not left').toBe(true)
    }
    expectWritesUnderUpdates(h)
  })
})

// ---- rows of their own (record §3.5)

describe('the service\u{2019}s other answers (record §3.5 "The channels\u{2019} values")', () => {
  it('a root that is no prepared drive, and a failure state with no layout: drive none, UPD-NOT-A-DRIVE, nothing read (F-21)', async () => {
    for (const h of [harness({ ...WIN32, prepared: false }), harness(WIN32, [], { noLayout: true })]) {
      expect((await h.service.status()).drive).toEqual({ kind: 'none' })
      expect(await h.service.importFile()).toEqual({ kind: 'refused', refusal: { code: 'UPD-NOT-A-DRIVE', params: { runningVersion: '1.0.0' } } })
      expect(await h.service.discardStaged({ version: '1.1.0' })).toEqual({ kind: 'refused', refusal: { code: 'UPD-NOT-A-DRIVE', params: { runningVersion: '1.0.0' } } })
      expect(await h.service.cancel()).toEqual({ kind: 'idle' })
      expect({ start: h.start.calls, staging: h.staging.calls, bundle: h.bundle.calls, reads: h.reads, appended: h.appended, dialog: h.dialog.opened }).toEqual({
        start: [],
        staging: [],
        bundle: [],
        reads: [],
        appended: [],
        dialog: 0
      })
    }
  })

  it('status carries the running version, whether a key is embedded, the build date and the support end (absent, a month, unreadable)', async () => {
    // Record §3.5 updates:status; supportEnd is readKitSupport's answer, a damaged stamp shown as unreadable (§5.9).
    const h = harness(WIN32)
    const status = await h.service.status()
    expect({ runningVersion: status.runningVersion, available: status.available, buildDate: status.buildDate }).toEqual({ runningVersion: '1.0.0', available: true, buildDate: BUILD_DATE })
    const supportEnd = async (): Promise<unknown> => {
      h.mono.value += 250
      const drive = (await h.service.status()).drive
      return drive.kind === 'prepared' ? drive.supportEnd : null
    }
    expect(await supportEnd()).toEqual({ state: 'absent' })
    writeFileSync(h.drive.at('config/kit-support.txt'), '2027-06\n')
    expect(await supportEnd()).toEqual({ state: 'month', month: '2027-06' })
    writeFileSync(h.drive.at('config/kit-support.txt'), 'June 2027\n')
    expect(await supportEnd()).toEqual({ state: 'unreadable' })
    expect((await harness(WIN32, [], { keys: [] }).service.status()).available).toBe(false)
  })

  it('updates/ that stops being a real folder: status says not-real and shows no staged update (record §3.5 "updatesFolder")', async () => {
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }])
    expect(statusForm(await h.service.status())).toMatchObject({ updatesFolder: 'real', staged: { version: '1.1.0' } })
    mkdirSync(h.drive.at('<outside>/moved'))
    renameSync(h.drive.at('updates'), h.drive.at('<outside>/moved/updates'))
    JUNCTION_OR_LINK(h.drive.at('<outside>/moved/updates'), h.drive.at('updates'))
    h.mono.value += 250
    expect(statusForm(await h.service.status())).toMatchObject({ updatesFolder: 'not-real', staged: null, inProgress: false })
  })

  it('a dialog that cannot open counts as closed: nothing read, no line', async () => {
    const h = harness(WIN32, [], { build: STD_BUILD(), dialog: ['throw'] })
    expect(await h.service.importFile()).toEqual({ kind: 'closed' })
    expect({ bundle: h.bundle.calls, lines: h.lines() }).toEqual({ bundle: [], lines: [] })
  })

  it('the audit hook hears update_staged once per commit, never a refusal; one that throws changes no answer; none is set in a failure state', async () => {
    const heard: unknown[] = []
    const h = harness(WIN32, [], { build: STD_BUILD(), dialog: ['file', 'file'] })
    await h.service.importFile() // no hook yet: the failure state's case
    h.service.setAuditHook((event) => void heard.push(event))
    expect(await h.service.importFile()).toMatchObject({ kind: 'staged' })
    expect(heard).toEqual([{ event: 'update_staged', version: '1.1.0' }])
    setPolicy(h.drive, { install: 'managed', maxVersion: null })
    await h.service.importFile()
    expect(heard).toHaveLength(1)
    const throwing = harness(WIN32, [], { build: STD_BUILD(), dialog: ['file'] })
    throwing.service.setAuditHook(() => {
      throw new Error('the audit log is gone')
    })
    expect(await throwing.service.importFile()).toMatchObject({ kind: 'staged' })
    expect(throwing.lines()).toEqual([onThisSystem(vector('i56'))])
  })

  it('a discard occupies the service: an import and a second discard answer busy until it ends', async () => {
    held = gate()
    const h = harness(WIN32, [{ staged: '1.1.0', bundle: 'std' }], { stagingRules: [{ call: 'unlink', when: (rel) => rel === 'updates/staging/1.1.0/staged.json', hold: held }] })
    expect((await h.service.status()).drive).toMatchObject({ staged: { version: '1.1.0' } })
    const discard = tracked(h.service.discardStaged({ version: '1.1.0' }))
    await held.reached
    expect(await h.service.importFile()).toEqual({ kind: 'busy' })
    expect(await h.service.discardStaged({ version: '1.1.0' })).toEqual({ kind: 'busy' })
    held.release()
    expect(await discard.promise).toEqual({ kind: 'discarded', version: '1.1.0' })
    expect(h.lines()).toEqual([onThisSystem(vector('i83'))])
  })
})
