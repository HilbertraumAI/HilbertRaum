import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { open as openFile, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { READ_SLICE_BYTES, readUpdateFile, type BundleFileHandle, type BundleFileSystem, type CheckedUpdateFile, type UpdateFileRead } from '../../src/main/services/updates/bundle'
import { parseKeySet, type UpdateKey } from '../../src/main/services/updates/envelope'
import type { PayloadInput } from '../../src/main/services/updates/payload'
import { parseSemver } from '../../src/main/services/updates/version'
import { rootArtifactOf, type RootApp } from '../../src/main/services/updates/drive-release'
import type { AcceptedFile, AcceptedPayload } from '../../src/shared/updates/types'
import type { ImportIoCause, StagingEnd } from '../../src/shared/updates/import-types'
import { makeUstarFile, ustarChecksum, ustarMember } from '../helpers/archives'
import { buildCaseFile, envelopeBytes, loadImportCases, makeBundleSigners, type ImportCase } from '../helpers/update-bundles'
import { DESKTOP_ROOT, REPO_ROOT } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'

// The update file's reader (app-update T6.1; F-16's reader side, G-5 (c); docs/app-updates.md §4.3, §4.4, §4.5, §4.7):
// bundle.ts's own API over the import's case table (tests/fixtures/updates/import/cases.json, T6.0b), the two golden
// update files and a few rows of its own. Every expected value comes from the fixtures, written from the record before
// this code existed (their PROVENANCE.md files); none comes from the code under test. A case's whole answer is the update
// service's (T6.2, T6.3): here each case whose deciding step is one of the reader's runs through the reader, and its
// answer, the facts its update.log line needs (version, stale_drive_version, err, syscall) and, for a staged case, the
// members staged are compared with the case. The cases whose deciding step is the service's (the checks before the
// dialog, the policy, links under updates/, the path length, free space, the old-file stop, the commit, the sweep, the
// channels) are left to T6.2 and T6.3 by the id prefixes below. The test plays the service's part: it makes the two
// staging folders and hands the reader node:fs/promises through a recorder that counts handles and causes the faults a
// case names. No key is written: the signers are made in memory (update-bundles.ts), and the golden key set is public.
// Non-ASCII test strings are written as `\u{…}` escapes.

const MARKER = 'hilbertraum-key-set-1:'
const UPDATES_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates')
const table = loadImportCases()
const signers = makeBundleSigners() // in memory; nothing of them is written

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function keySet(spkiBase64: readonly string[]): readonly UpdateKey[] {
  const read = parseKeySet(MARKER + spkiBase64.join(','))
  expect(read.valid).toBe(true)
  return read.valid ? read.keys : []
}
const TEST_KEYS = keySet([signers.test.spki.toString('base64')])

// ---- the case table's host (cases.json `schema.host`) as the payload check's input (payload.ts's PayloadInput)

interface Host {
  os: 'win32' | 'darwin' | 'linux'
  osVersion: string | null
  glibc: string | null
  runningVersion: string
  driveAppVersion: string | null
  rootApps: string[] | null
  now: string
  uiLanguage: string
  keys: string[]
  policy: { install: string; maxVersion: string | null }
}

function hostOf(c: ImportCase): Host {
  const host = table.hosts[c.host ?? '']
  expect(host, `${c.id}: host ${String(c.host)}`).toBeDefined()
  return { ...host, ...c.hostSet } as unknown as Host
}
const namedHost = (os: 'win32' | 'darwin' | 'linux'): Host => table.hosts[os] as unknown as Host

function semver(text: string): NonNullable<ReturnType<typeof parseSemver>> {
  const parsed = parseSemver(text)
  expect(parsed, text).not.toBeNull()
  return parsed!
}

/** What the service reads once per import (payload.ts's PayloadInput); the root apps as rootApps would list the names. */
function payloadInput(host: Host): PayloadInput {
  const rootApps: RootApp[] | null =
    host.rootApps === null
      ? null
      : host.rootApps.map((name) => {
          const artifact = rootArtifactOf(name, 'file')
          expect(artifact, `${name} should be a root app`).not.toBeNull()
          return { name, kind: 'file', ...artifact! }
        })
  const common = {
    runningVersion: semver(host.runningVersion),
    driveAppVersion: host.driveAppVersion,
    rootApps,
    maxVersion: host.policy.maxVersion === null ? null : semver(host.policy.maxVersion),
    now: Date.parse(host.now),
    uiLanguage: host.uiLanguage
  }
  return host.os === 'linux' ? { ...common, os: 'linux', osVersion: null, glibc: host.glibc } : { ...common, os: host.os, osVersion: host.osVersion!, glibc: null }
}

// ---- scratch folders, and the service's part: node:fs/promises through a recorder

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hr-updates-bundle-'))
  scratchDirs.push(dir)
  return dir
}

const injected = (code: string, syscall: string): Error => Object.assign(new Error(`injected ${code}`), { code, syscall })

/** Faults a row asks for; each is thrown, or applied, where its name says. */
interface Faults {
  openUpdateFile?: unknown
  stat?: unknown
  afterStat?: () => void
  /** Called after each read of the update file, with where it read and how much it got. */
  afterRead?: (position: number, bytesRead: number) => void
  /** Thrown by the reads of the update file in the data pass, after the first `readInDataPassAfter` of them (0 by default). */
  readInDataPass?: unknown
  readInDataPassAfter?: number
  /** Reads at or beyond this position return 0 bytes (the file shrank after the open). */
  readZeroFrom?: number
  /** Each read and each write moves at most this many bytes. */
  chunk?: number
  openMember?: unknown
  write?: unknown
  writeNothing?: boolean
  sync?: unknown
  close?: unknown
  rename?: unknown
  /** Called after each move the reader makes. */
  afterRename?: () => void
  unlink?: unknown
}

/** A turn of the event loop, so a call that moves nothing cannot keep a broken loop from meeting the test's timeout. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface Recorder {
  fs: BundleFileSystem
  readonly faults: Faults
  /** Handles opened and closed (the update file's and each member's). */
  opened: number
  closed: number
  /** Set by the test when it starts the data pass. */
  dataPass: boolean
  /** Each read of the update file: where, how many bytes it asked for, in the data pass or before it. */
  readonly reads: Array<{ position: number; length: number; dataPass: boolean }>
  /** Each path the reader created, moved or removed on the drive. */
  readonly drivePaths: string[]
}

/** What the service hands the reader: node:fs/promises itself (the typecheck holds its FileHandle to BundleFileHandle). */
const NODE_FS: BundleFileSystem = { open: (path, flags) => openFile(path, flags), rename, unlink }

function recorder(faults: Faults = {}): Recorder {
  const rec: Recorder = { fs: NODE_FS, faults, opened: 0, closed: 0, dataPass: false, reads: [], drivePaths: [] }
  const wrap = (real: BundleFileHandle, member: boolean): BundleFileHandle => ({
    async stat() {
      if (faults.stat !== undefined) throw faults.stat
      const stats = await real.stat()
      faults.afterStat?.()
      return stats
    },
    async read(buffer, offset, length, position) {
      if (rec.dataPass && faults.readInDataPass !== undefined && rec.reads.filter((r) => r.dataPass).length >= (faults.readInDataPassAfter ?? 0)) throw faults.readInDataPass
      rec.reads.push({ position, length, dataPass: rec.dataPass })
      if (faults.readZeroFrom !== undefined && position >= faults.readZeroFrom) {
        await nextTurn()
        return { bytesRead: 0 }
      }
      const result = await real.read(buffer, offset, faults.chunk === undefined ? length : Math.min(length, faults.chunk), position)
      faults.afterRead?.(position, result.bytesRead)
      return result
    },
    async write(buffer, offset, length) {
      if (faults.write !== undefined) throw faults.write
      if (faults.writeNothing) {
        await nextTurn()
        return { bytesWritten: 0 }
      }
      return real.write(buffer, offset, faults.chunk === undefined ? length : Math.min(length, faults.chunk))
    },
    async sync() {
      if (faults.sync !== undefined) throw faults.sync
      await real.sync()
    },
    async close() {
      rec.closed++
      await real.close()
      if (member && faults.close !== undefined) throw faults.close
    }
  })
  rec.fs = {
    async open(path, flags) {
      const member = flags === 'wx'
      if (member) {
        rec.drivePaths.push(path)
        if (faults.openMember !== undefined) throw faults.openMember
      } else if (faults.openUpdateFile !== undefined) {
        throw faults.openUpdateFile
      }
      const real = await NODE_FS.open(path, flags)
      rec.opened++
      return wrap(real, member)
    },
    async rename(from, to) {
      rec.drivePaths.push(from, to)
      if (faults.rename !== undefined) throw faults.rename
      await NODE_FS.rename(from, to)
      faults.afterRename?.()
    },
    async unlink(path) {
      rec.drivePaths.push(path)
      if (faults.unlink !== undefined) throw faults.unlink
      await NODE_FS.unlink(path)
    }
  }
  return rec
}

/** The staging folders the service makes before the data pass (§4.5 "Links under updates/"): only these two are written. */
interface Staging {
  incomingDir: string
  filesDir: string
}
function makeStaging(dir: string, version: string): Staging {
  const staging = join(dir, 'drive', 'updates', 'staging')
  const incomingDir = join(staging, `.incoming-${version}`)
  const filesDir = join(staging, version, 'files')
  mkdirSync(incomingDir, { recursive: true })
  mkdirSync(filesDir, { recursive: true })
  return { incomingDir, filesDir }
}

/** Every file under `root`. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

/** The reader writes only below the two folders the service named, and nothing before the data pass. */
function expectWritesInside(rec: Recorder, dir: string, staging: Staging | null): void {
  const inside = (path: string): boolean => staging !== null && (dirname(path) === staging.incomingDir || dirname(path) === staging.filesDir)
  for (const path of rec.drivePaths) expect(inside(path), `the reader touched ${relative(dir, path)}`).toBe(true)
  for (const path of filesUnder(join(dir, 'drive'))) expect(inside(path), `a file at ${relative(dir, path)}`).toBe(true)
}

/** A verdict without the checked file's buffers, for comparisons and messages. */
const verdict = (end: UpdateFileRead | StagingEnd | null): unknown =>
  end === null ? null : end.kind === 'refused' ? { kind: end.kind, code: end.refusal.code, params: end.refusal.params, cause: end.cause } : { kind: end.kind }

function checkedFile(read: UpdateFileRead, what: string): CheckedUpdateFile {
  expect(read.kind, `${what}: ${JSON.stringify(verdict(read))}`).toBe('checked')
  if (read.kind !== 'checked') throw new Error(`${what} was not checked`)
  return read.file
}

// ---- running one case: the read, then (when it is checked) the data pass, as the service would

interface Run {
  read: UpdateFileRead
  stage: StagingEnd | null
  staging: Staging | null
  rec: Recorder
  progress: number[]
}

interface CaseSetup {
  /** The update file lies in this folder of the scratch folder (the drive is another one). */
  folder?: string
  /** No file is written at the picked path. */
  missing?: boolean
  fifo?: boolean
  faults?: (c: ImportCase, path: string) => Faults
  /** Between the read and the data pass (the file changes meanwhile). */
  beforeDataPass?: (path: string, file: Buffer) => void
  cancelRead?: (rec: Recorder) => boolean
  cancelDataPass?: (progress: readonly number[]) => boolean
}

/** A Cyrillic folder name with `&` and `%` (record §4.5 "The update file's open"), beside the drive, not on it. */
const NON_ASCII_FOLDER = `\u{41E}\u{431}\u{43D}\u{43E}\u{432}\u{43B}\u{435}\u{43D}\u{438}\u{435} & 100%`

/** The fault a case's `inject` names, with the code and the system call the case gives. */
function namedFault(c: ImportCase): Error {
  const inject = c.inject?.[0] as { code?: string; syscall?: string } | undefined
  expect(inject?.code, `${c.id} names no code`).toBeTypeOf('string')
  return injected(inject!.code!, inject!.syscall!)
}

/** How each case with an `inject` (and each run of several calls) is caused here; the coverage row fails on a gap. */
const SETUPS: Readonly<Record<string, CaseSetup>> = {
  'open-missing-file': { missing: true },
  'open-fstat-fails': { faults: (c) => ({ stat: namedFault(c) }) },
  'open-named-pipe': { fifo: true },
  'open-non-ascii-path': { folder: NON_ASCII_FOLDER },
  // The length is the descriptor's at the open (its fstat): the rest of the standard file is appended right after it.
  'open-file-grows-after-the-open': {
    faults: (c, path) => ({
      afterStat: () => {
        const whole = buildCaseFile(table, table.cases.find((s) => s.id === 'accept-std')!.build!, signers).bytes
        const cut = c.build!.cut!
        expect(readFileSync(path).equals(whole.subarray(0, cut))).toBe(true)
        appendFileSync(path, whole.subarray(cut))
      }
    })
  },
  // One ignored byte (uname's first) of the first later header, and its checksum, are rewritten after the walk.
  'data-header-changed-after-walk': {
    beforeDataPass: (path, file) => {
      const envelopeSize = Number.parseInt(file.subarray(124, 135).toString('latin1'), 8)
      const at = 512 + Math.ceil(envelopeSize / 512) * 512
      const header = Buffer.from(file.subarray(at, at + 512))
      header[265] = 0x41
      header.write(`${ustarChecksum(header).toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
      const fd = openSync(path, 'r+')
      writeSync(fd, header, 0, 512, at)
      closeSync(fd)
    }
  },
  'data-enospc': { faults: (c) => ({ write: namedFault(c) }) },
  'data-efbig': { faults: (c) => ({ write: namedFault(c) }) },
  'data-read-error': { faults: (c) => ({ readInDataPass: namedFault(c) }) },
  'data-write-error': { faults: (c) => ({ openMember: namedFault(c) }) },
  'data-move-error': { faults: (c) => ({ rename: namedFault(c) }) },
  // The root's listing failed: the service caught rootApps' throw and passes null (record §2.5 "Inputs"), as the host says.
  'ver-drive-ahead-root-not-listed': {},
  'data-cancel-before-payload': { cancelRead: (rec) => rec.opened > 0 },
  'data-cancel-while-copying': { cancelDataPass: (progress) => progress.length > 0 }
}

async function runCase(c: ImportCase): Promise<Run> {
  const setup = SETUPS[c.id] ?? {}
  const host = hostOf(c)
  expect(host.keys, `${c.id}: the reader runs with the test key`).toEqual(['test'])
  const dir = scratch()
  const folder = join(dir, setup.folder ?? 'download')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'update.hrupdate')
  let file: Buffer = Buffer.alloc(0)
  if (setup.fifo) {
    const made = spawnSync('mkfifo', [path], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
  } else if (!setup.missing) {
    file = buildCaseFile(table, c.build!, signers).bytes
    expect(file.length).toBe(c.file!.size)
    writeFileSync(path, file)
  }
  const rec = recorder()
  Object.assign(rec.faults, setup.faults?.(c, path))
  const read = await readUpdateFile(path, { keys: TEST_KEYS, input: payloadInput(host), fs: rec.fs, cancelled: () => setup.cancelRead?.(rec) ?? false })
  const run: Run = { read, stage: null, staging: null, rec, progress: [] }
  if (read.kind === 'checked') {
    // Nothing was written before the data pass: the header walk runs before any member is written (§4.3).
    expect(rec.drivePaths).toEqual([])
    setup.beforeDataPass?.(path, file)
    run.staging = makeStaging(dir, read.file.payload.version)
    rec.dataPass = true
    run.stage = await read.file.stage({
      ...run.staging,
      cancelled: () => setup.cancelDataPass?.(run.progress) ?? false,
      progress: (done) => void run.progress.push(done)
    })
    await read.file.close()
  }
  expect(rec.closed, `${c.id}: every handle the reader opened is closed`).toBe(rec.opened)
  expectWritesInside(rec, dir, run.staging)
  return run
}

// ---- comparing a run with a case's `expect`

interface Expect {
  answer?: string
  code?: string
  params?: Record<string, unknown>
  update?: { version: string; issued: string | null; summary: string | null }
  notices?: Array<{ code: string; params: Record<string, unknown> }>
  notice?: { code: string; params: { issued: string } }
  log?: { event: string; fields: Record<string, string> } | null
  after?: { absent?: string[]; unchanged?: string[]; stagedJson?: string }
  answers?: Array<{ answer: string }>
  lines?: string[]
}

/** The update.log fields the reader's facts decide (§4.5's events), as the service hands them to the formatter. */
function logFacts(payload: AcceptedPayload | null, stale: boolean | null, refusal: { params: object } | null, cause: ImportIoCause | null): Record<string, string> {
  const out: Record<string, string> = {}
  const own = refusal !== null && Object.hasOwn(refusal.params, 'version') ? (refusal.params as { version: string }).version : undefined
  const version = payload?.version ?? own
  // The caller passes the sentinel `unknown` for a version of 25 to 64 bytes (record §4.5, "What the formatter writes").
  if (version !== undefined) out.version = Buffer.byteLength(version) > 24 ? 'unknown' : version
  if (stale !== null) out.stale_drive_version = stale ? 'yes' : 'no'
  if (cause?.code) out.err = cause.code
  if (cause?.syscall) out.syscall = cause.syscall
  return out
}

const READER_FIELDS = ['version', 'stale_drive_version', 'err', 'syscall']
const pick = (fields: Record<string, string>, keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => keys.includes(key)))

/** The warnings an accepted payload carries (§2.10: its flags), sorted by code for the comparison. */
function noticesOf(payload: AcceptedPayload): Array<{ code: string; params: Record<string, unknown> }> {
  const out: Array<{ code: string; params: Record<string, unknown> }> = []
  if (payload.flags.issuedInFuture) out.push({ code: 'UPD-ISSUED-IN-FUTURE', params: { issued: payload.issued } })
  if (payload.flags.otherSystemFloors.length > 0) out.push({ code: 'UPD-OTHER-SYSTEM-FLOOR', params: { floors: payload.flags.otherSystemFloors } })
  return out
}
const byCode = <T extends { code: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.code.localeCompare(b.code))

const asStaged = (files: ReadonlyArray<Pick<AcceptedFile, 'name' | 'size' | 'sha256' | 'group'>>) => files.map(({ name, size, sha256, group }) => ({ name, size, sha256, group }))
/** A `staged.json` text's `files` (record §4.6: `group` only where the payload gave one). */
const stagedJsonFiles = (text: string) =>
  (JSON.parse(text) as { files: Array<{ name: string; size: number; sha256: string; group?: string }> }).files.map((f) => ({ ...f, group: f.group ?? null }))

function expectAccepted(c: ImportCase, run: Run, e: Expect): AcceptedPayload {
  const payload = checkedFile(run.read, c.id).payload
  expect({ version: payload.version, issued: payload.issued, summary: payload.summary }).toEqual(e.update)
  expect(byCode(noticesOf(payload))).toEqual(byCode(e.notices ?? []))
  return payload
}

function expectCase(c: ImportCase, run: Run): void {
  const e = c.expect as Expect
  if (c.kind === 'calls') {
    // A cancel (§3.5 updates:cancel): the run's own answer, and the version its import-cancelled line carries.
    expect(e.answers?.[0]?.answer).toBe('cancelled')
    const version = /\bversion=(\S+)/.exec(e.lines?.[0] ?? '')?.[1]
    expect(verdict(run.stage ?? run.read)).toEqual({ kind: 'cancelled' })
    const payload = run.read.kind === 'checked' ? run.read.file.payload : run.read.payload
    expect(payload?.version).toBe(version)
    if (run.staging !== null) expect(readdirSync(run.staging.filesDir), 'nothing is moved after the cancel').toEqual([])
    return
  }
  if (e.answer === 'confirm') {
    // The old-file stop is the service's (§4.5's order: after its own checks); the reader hands it the flag.
    const payload = expectAccepted(c, run, e)
    expect(payload.flags.oldFile).toBe(true)
    expect(e.notice).toEqual({ code: 'UPD-OLD-FILE', params: { issued: payload.issued } })
    expect(logFacts(payload, payload.flags.staleDriveVersion, null, null)).toEqual(pick(e.log!.fields, READER_FIELDS))
    return
  }
  if (e.answer === 'staged') {
    const payload = expectAccepted(c, run, e)
    expect(payload.flags.oldFile).toBe(false)
    expect(verdict(run.stage)).toEqual({ kind: 'staged' })
    const staged = run.stage?.kind === 'staged' ? run.stage.files : []
    const expected = stagedJsonFiles(e.after!.stagedJson!)
    expect(asStaged(staged)).toEqual(expected)
    expect({
      ...logFacts(payload, payload.flags.staleDriveVersion, null, null),
      files: String(staged.length),
      old_file: 'no',
      issued_in_future: payload.flags.issuedInFuture ? 'yes' : 'no',
      other_floors: payload.flags.otherSystemFloors.length > 0 ? 'yes' : 'no'
    }).toEqual(pick(e.log!.fields, [...READER_FIELDS, 'files', 'old_file', 'issued_in_future', 'other_floors']))
    // On the drive: each member under its name in files/, its bytes as listed; .incoming-<v>/ emptied by the moves.
    const { incomingDir, filesDir } = run.staging!
    expect(readdirSync(filesDir).sort()).toEqual(expected.map((f) => f.name).sort())
    for (const f of expected) {
      const bytes = readFileSync(join(filesDir, f.name))
      expect({ name: f.name, size: bytes.length, sha256: sha256(bytes) }).toEqual({ name: f.name, size: f.size, sha256: f.sha256 })
    }
    expect(readdirSync(incomingDir)).toEqual([])
    return
  }
  expect(e.answer).toBe('refused')
  // The case's drive afterwards says where the refusal falls: one from the data pass on removes this version's
  // updates/staging/<v>/ (`absent`), one before it removes nothing (§4.5's order, "A refusal or a cancel from the data
  // pass on").
  const fromDataPass = (e.after?.absent ?? []).some((p) => /^updates\/staging\/[^.]/.test(p))
  const end = fromDataPass ? run.stage : run.read
  if (fromDataPass) checkedFile(run.read, c.id)
  expect(end?.kind, `${c.id}: ${JSON.stringify(verdict(run.read))} then ${JSON.stringify(verdict(run.stage))}`).toBe('refused')
  if (end?.kind !== 'refused') return
  expect({ code: end.refusal.code, params: end.refusal.params }).toEqual({ code: e.code, params: e.params })
  const payload = run.read.kind === 'checked' ? run.read.file.payload : run.read.payload
  const stale = run.read.kind === 'checked' ? run.read.file.payload.flags.staleDriveVersion : run.read.staleDriveVersion
  expect(logFacts(payload, stale, end.refusal, end.cause)).toEqual(pick(e.log!.fields, READER_FIELDS))
  if (run.staging !== null && payload !== null) {
    // A member whose hash did not match is deleted, never moved (§4.5 "Where a member is written").
    const listed = new Map(payload.files.map((f) => [f.name, f]))
    for (const at of [...filesUnder(run.staging.incomingDir), ...filesUnder(run.staging.filesDir)]) {
      const entry = listed.get(basename(at))
      expect(entry, at).toBeDefined()
      const bytes = readFileSync(at)
      if (bytes.length === entry!.size) expect(sha256(bytes), `${basename(at)} is left with other bytes`).toBe(entry!.sha256)
    }
  }
}

// ---- which cases are the reader's

/** The service's steps (T6.2, T6.3): their cases are left to the service's tests (impl/p6/T6.1/case-split.md). */
const SERVICE_PREFIXES = ['pre-', 'probe-', 'start-', 'discard-', 'commit-', 'space-', 'link-', 'path-', 'token-', 'busy-', 'cancel-']
const SERVICE_CASES = new Set([
  'dialog-closed',
  'argument-without-own-token-opens-the-dialog',
  'accept-updates-folder-other-case',
  'accept-replaces-staged-same-version',
  'accept-commit-removes-other-versions',
  'accept-case-only-version-replaces',
  'pay-issued-365d-1s-confirmed'
])
const READER_CASES = table.cases.filter((c) => !SERVICE_PREFIXES.some((prefix) => c.id.startsWith(prefix)) && !SERVICE_CASES.has(c.id))
/** A FIFO exists on macOS and Linux only; O_NONBLOCK keeps its open from holding. These rows run in CI. */
const POSIX_ONLY = new Set(['open-named-pipe'])

describe('the import case table through the reader (tests/fixtures/updates/import/cases.json; record §4.3, §4.5, §4.7)', () => {
  it('the reader-side cases are found, and every injected fault and every run of several calls among them has a setup', () => {
    expect(READER_CASES.length).toBeGreaterThan(200)
    expect(READER_CASES.every((c) => c.kind === 'import' || c.kind === 'calls')).toBe(true)
    expect(READER_CASES.filter((c) => (c.inject !== undefined || c.kind === 'calls') && SETUPS[c.id] === undefined).map((c) => c.id)).toEqual([])
  })

  it.each(READER_CASES.filter((c) => !POSIX_ONLY.has(c.id)).map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    expectCase(c, await runCase(c))
  })

  describe.runIf(process.platform !== 'win32')('on macOS and Linux', () => {
    it.each(READER_CASES.filter((c) => POSIX_ONLY.has(c.id)).map((c) => [c.id, c] as const))('%s', async (_id, c) => {
      expectCase(c, await runCase(c))
    })
  })
})

// ---- the golden update files (F-16): read back member by member under their key set

interface GoldenStaged {
  file: string
  envelope: { size: number; sha256: string }
  version: string
  issued: string
  membersInFileOrder: Array<{ name: string; at: number; size: number; sha256: string }>
  stagedJson: string
}
const F5 = JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'import', 'f5-staged.json'), 'utf8')) as { staged: GoldenStaged[] }
const GOLDEN_KEYS = JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'golden-keys.json'), 'utf8')) as { keys: string[] }
const golden = (name: string): GoldenStaged => F5.staged.find((s) => s.file === name)!

describe('the golden update files read back member by member (tests/fixtures/updates/golden*.hrupdate; F-16, F-5)', () => {
  it.each([
    ['golden.hrupdate', 'win32'],
    ['golden.hrupdate', 'darwin'],
    ['golden.hrupdate', 'linux'],
    ['golden-win32-only.hrupdate', 'win32']
  ] as const)('%s stages on %s, each member byte for byte', async (name, os) => {
    const expected = golden(name)
    const bytes = readFileSync(join(UPDATES_FIXTURES, name))
    const dir = scratch()
    const rec = recorder()
    const read = await readUpdateFile(join(UPDATES_FIXTURES, name), { keys: keySet(GOLDEN_KEYS.keys), input: payloadInput(namedHost(os)), fs: rec.fs, cancelled: () => false })
    const file = checkedFile(read, name)
    expect({ version: file.payload.version, issued: file.payload.issued }).toEqual({ version: expected.version, issued: expected.issued })
    // Member 0, which the commit keeps as hilbertraum-release.dsse.json: the file's own bytes.
    expect(file.envelope.equals(bytes.subarray(512, 512 + expected.envelope.size))).toBe(true)
    expect(sha256(file.envelope)).toBe(expected.envelope.sha256)
    const listed = stagedJsonFiles(expected.stagedJson)
    expect(asStaged(file.present)).toEqual(listed)
    expect(file.totalBytes).toBe(listed.reduce((sum, f) => sum + f.size, 0))
    const staging = makeStaging(dir, file.payload.version)
    rec.dataPass = true
    const stage = await file.stage({ ...staging, cancelled: () => false, progress: () => undefined })
    await file.close()
    expect(verdict(stage)).toEqual({ kind: 'staged' })
    expect(asStaged(stage.kind === 'staged' ? stage.files : [])).toEqual(listed)
    expect(readdirSync(staging.filesDir).sort()).toEqual(expected.membersInFileOrder.map((m) => m.name).sort())
    for (const m of expected.membersInFileOrder) {
      const staged = readFileSync(join(staging.filesDir, m.name))
      expect(staged.equals(bytes.subarray(m.at + 512, m.at + 512 + m.size)), m.name).toBe(true)
      expect(sha256(staged)).toBe(m.sha256)
    }
    expect(rec.closed).toBe(rec.opened)
    expectWritesInside(rec, dir, staging)
  })

  // f5-staged.json's contract: "golden-win32-only.hrupdate is UPD-NO-HELPER on macOS and Linux" (record §4.4).
  it.each(['darwin', 'linux'] as const)('golden-win32-only.hrupdate is UPD-NO-HELPER on %s', async (os) => {
    const rec = recorder()
    const read = await readUpdateFile(join(UPDATES_FIXTURES, 'golden-win32-only.hrupdate'), { keys: keySet(GOLDEN_KEYS.keys), input: payloadInput(namedHost(os)), fs: rec.fs, cancelled: () => false })
    expect(verdict(read)).toEqual({ kind: 'refused', code: 'UPD-NO-HELPER', params: {}, cause: null })
    expect(read.kind === 'refused' ? read.payload?.version : null).toBe('1.2.0')
    expect(rec.closed).toBe(rec.opened)
    expect(rec.drivePaths).toEqual([])
  })
})

// ---- the reader's own rows

/** A case's file, written to a scratch folder. */
function caseFile(caseId: string): { dir: string; path: string; file: ReturnType<typeof buildCaseFile> } {
  const dir = scratch()
  mkdirSync(join(dir, 'download'))
  const path = join(dir, 'download', 'update.hrupdate')
  const file = buildCaseFile(table, table.cases.find((c) => c.id === caseId)!.build!, signers)
  writeFileSync(path, file.bytes)
  return { dir, path, file }
}

/** A case's file read with `faults` on the win32 host, then staged when it is checked. */
async function faultedRun(faults: Faults, caseId = 'accept-std'): Promise<Run> {
  const { dir, path } = caseFile(caseId)
  const rec = recorder(faults)
  const read = await readUpdateFile(path, { keys: TEST_KEYS, input: payloadInput(namedHost('win32')), fs: rec.fs, cancelled: () => false })
  const run: Run = { read, stage: null, staging: null, rec, progress: [] }
  if (read.kind === 'checked') {
    run.staging = makeStaging(dir, read.file.payload.version)
    rec.dataPass = true
    run.stage = await read.file.stage({ ...run.staging, cancelled: () => false, progress: () => undefined })
    await read.file.close()
  }
  expect(rec.closed).toBe(rec.opened)
  expectWritesInside(rec, dir, run.staging)
  return run
}

describe('CF-51: the payload checked is verifyEnvelope\u{2019}s own result, over member 0 read once (record §2.3 "payload", §4.3 "Member 0")', () => {
  it('member 0 rewritten on disk right after the reader read it changes neither the answer nor the envelope kept', async () => {
    const { path, file } = caseFile('accept-std')
    const [at, length] = file.envelope!
    const original = Buffer.from(file.bytes.subarray(at, at + length))
    let rewritten = false
    const rec = recorder({
      afterRead: (position, bytesRead) => {
        if (rewritten || position > at || position + bytesRead < at + length) return
        const fd = openSync(path, 'r+')
        writeSync(fd, Buffer.alloc(length, 0x20), 0, length, at) // no envelope any more: a second read of it would be refused
        closeSync(fd)
        rewritten = true
      }
    })
    const checked = checkedFile(await readUpdateFile(path, { keys: TEST_KEYS, input: payloadInput(namedHost('win32')), fs: rec.fs, cancelled: () => false }), 'accept-std')
    expect(rewritten).toBe(true)
    expect(checked.payload.version).toBe('1.1.0')
    expect(checked.envelope.equals(original)).toBe(true)
    await checked.close()
  })
})

describe('the data pass reads 1 MiB at a time and reports the bytes staged (record §4.5 "Reads", "Progress"; §4.3 "The header walk")', () => {
  it('a 2.5 MiB member is read in slices of at most 1 MiB, progress counts each slice, and the walk reads no member data', async () => {
    const big = Buffer.from(Array.from({ length: 2_621_440 }, (_, i) => (i * 7 + 3) & 0xff))
    const apply = Buffer.from('@echo off\r\nexit /b 0\r\n', 'latin1')
    const payload = JSON.stringify({
      format: 1,
      product: 'hilbertraum',
      kind: 'release',
      channel: 'stable',
      version: '1.1.0',
      files: [
        { name: 'apply.cmd', size: apply.length, sha256: sha256(apply) },
        { name: 'big.bin', size: big.length, sha256: sha256(big) }
      ]
    })
    const envelope = envelopeBytes(Buffer.from(payload, 'utf8'), {}, signers)
    const bytes = makeUstarFile({ members: [ustarMember({ name: 'hilbertraum-release.dsse.json' }, envelope), ustarMember({ name: 'apply.cmd' }, apply), ustarMember({ name: 'big.bin' }, big)] })
    const dir = scratch()
    const path = join(dir, 'update.hrupdate')
    writeFileSync(path, bytes)
    const rec = recorder()
    const file = checkedFile(await readUpdateFile(path, { keys: TEST_KEYS, input: payloadInput(namedHost('win32')), fs: rec.fs, cancelled: () => false }), 'big')
    // Before the data pass: the first block, member 0 and its padding, one 512-byte header per member, the two end blocks.
    expect(rec.reads.reduce((sum, r) => sum + r.length, 0)).toBeLessThanOrEqual(512 + Math.ceil(envelope.length / 512) * 512 + 2 * 512 + 1024)
    expect(file.totalBytes).toBe(apply.length + big.length)
    const staging = makeStaging(dir, '1.1.0')
    const progress: number[] = []
    rec.dataPass = true
    const stage = await file.stage({ ...staging, cancelled: () => false, progress: (done) => void progress.push(done) })
    await file.close()
    expect(verdict(stage)).toEqual({ kind: 'staged' })
    expect(READ_SLICE_BYTES).toBe(1_048_576)
    expect(Math.max(...rec.reads.filter((r) => r.dataPass).map((r) => r.length))).toBe(READ_SLICE_BYTES)
    expect(progress).toEqual([apply.length, apply.length + 1_048_576, apply.length + 2_097_152, apply.length + big.length])
    expect(readFileSync(join(staging.filesDir, 'big.bin')).equals(big)).toBe(true)
    expect(rec.closed).toBe(rec.opened)
  })
})

describe('a file-system call that fails is a typed verdict, never a throw (record §4.5 "The update file\u{2019}s open", "Errors while staging")', () => {
  const NO_FIELDS = { code: null, syscall: null }
  it.each([
    ['the open rejects with a value that is no error', { openUpdateFile: 'gone' }, { kind: 'refused', code: 'UPD-CANT-READ-FILE', params: {}, cause: NO_FIELDS }, null],
    // The length is the descriptor's at the open; a read that ends before it means the file changed meanwhile (§4.3).
    ['a read of member 0 that ends before the length the open gave', { readZeroFrom: 512 }, { kind: 'refused', code: 'UPD-FILE-DAMAGED', params: {}, cause: null }, null],
    ['reads and writes that move 100 bytes at a time are continued', { chunk: 100 }, { kind: 'checked' }, { kind: 'staged' }],
    ['a write that moves no byte', { writeNothing: true }, { kind: 'checked' }, { kind: 'refused', code: 'UPD-CANT-WRITE-DRIVE', params: {}, cause: null }],
    [
      'the fsync of a member fails ENOSPC',
      { sync: injected('ENOSPC', 'fsync') },
      { kind: 'checked' },
      { kind: 'refused', code: 'UPD-DRIVE-FULL', params: { requiredBytes: null, freeBytes: null }, cause: { code: 'ENOSPC', syscall: 'fsync' } }
    ],
    ['the close of a member fails EIO', { close: injected('EIO', 'close') }, { kind: 'checked' }, { kind: 'refused', code: 'UPD-CANT-WRITE-DRIVE', params: {}, cause: { code: 'EIO', syscall: 'close' } }],
    // The case table's data-read-error fails the data pass's first read (a header); this one a member's own bytes.
    [
      'a read of the update file fails EIO inside a member\u{2019}s data',
      { readInDataPass: injected('EIO', 'read'), readInDataPassAfter: 1 },
      { kind: 'checked' },
      { kind: 'refused', code: 'UPD-CANT-READ-FILE', params: {}, cause: { code: 'EIO', syscall: 'read' } }
    ]
  ] as const)('%s', async (_label, faults, readVerdict, stageVerdict) => {
    const run = await faultedRun(faults as Faults)
    expect(verdict(run.read)).toEqual(readVerdict)
    expect(verdict(run.stage)).toEqual(stageVerdict)
    if (run.stage?.kind === 'staged') {
      for (const f of run.stage.files) expect(sha256(readFileSync(join(run.staging!.filesDir, f.name))), f.name).toBe(f.sha256)
    }
  })

  it('a member whose hash does not match is refused UPD-FILE-DAMAGED, also when its removal fails, and is never moved', async () => {
    const run = await faultedRun({ unlink: injected('EPERM', 'unlink') }, 'data-hash-mismatch')
    expect(verdict(run.stage)).toEqual({ kind: 'refused', code: 'UPD-FILE-DAMAGED', params: {}, cause: null })
    expect(readdirSync(run.staging!.filesDir)).not.toContain('notes.txt')
  })
})

describe('a cancel stops the data pass at its next check point (record §3.5 updates:cancel, §4.5 "A refusal or a cancel from the data pass on")', () => {
  it('a cancel that comes while a member is moved stops the pass before the next member is opened', async () => {
    const { dir, path } = caseFile('accept-std')
    let moved = false
    const rec = recorder({ afterRename: () => void (moved = true) })
    const file = checkedFile(await readUpdateFile(path, { keys: TEST_KEYS, input: payloadInput(namedHost('win32')), fs: rec.fs, cancelled: () => false }), 'accept-std')
    const staging = makeStaging(dir, file.payload.version)
    rec.dataPass = true
    const stage = await file.stage({ ...staging, cancelled: () => moved, progress: () => undefined })
    await file.close()
    expect(verdict(stage)).toEqual({ kind: 'cancelled' })
    // The standard set's first member in file order is apply.cmd: opened, written, moved; nothing after it is opened.
    expect(readdirSync(staging.filesDir)).toEqual(['apply.cmd'])
    expect(rec.drivePaths.filter((p) => dirname(p) === staging.incomingDir).map((p) => basename(p))).toEqual(['apply.cmd', 'apply.cmd'])
    expect(rec.closed).toBe(rec.opened)
  })
})

describe('a file shorter than one block is incomplete only when each byte it holds starts a valid member-0 header (record §4.7 rows 1 and 2, T6.0 fix 4)', () => {
  // The writer's own member-0 header (table A.2's bytes) from the standard case's file; a row edits one field, then cuts.
  const header = (): Buffer => Buffer.from(buildCaseFile(table, table.cases.find((c) => c.id === 'accept-std')!.build!, signers).bytes.subarray(0, 512))
  it.each([
    ['400 bytes of it: the prefix field reached, and zero', 400, (h: Buffer) => h, 'UPD-DOWNLOAD-INCOMPLETE'],
    ['the same 400 bytes with a byte in the prefix field', 400, (h: Buffer) => (h.fill(0x41, 350, 351), h), 'UPD-NOT-AN-UPDATE'],
    ['300 bytes with 12 digits in the size field', 300, (h: Buffer) => (h.write('000000004000', 124, 12, 'latin1'), h), 'UPD-NOT-AN-UPDATE'],
    ['300 bytes with a letter after the size field\u{2019}s digits', 300, (h: Buffer) => (h.write('0000004000x', 124, 11, 'latin1'), h), 'UPD-NOT-AN-UPDATE']
  ] as const)('%s', async (_label, cut, edit, code) => {
    const dir = scratch()
    const path = join(dir, 'update.hrupdate')
    writeFileSync(path, edit(header()).subarray(0, cut))
    const rec = recorder()
    const read = await readUpdateFile(path, { keys: TEST_KEYS, input: payloadInput(namedHost('win32')), fs: rec.fs, cancelled: () => false })
    expect(verdict(read)).toEqual({ kind: 'refused', code, params: {}, cause: null })
    expect(rec.closed).toBe(rec.opened)
  })
})

// The release tools' import-reader snapshot (W-53) and P5's check-draft load the reader through Node's own type
// stripping with the sibling-import hook (scripts/lib/ts-sibling-imports.mjs): so bundle.ts imports only its siblings,
// types and node: built-ins, and holds only TypeScript that stripping can erase. The typecheck sees none of that.
describe('bundle.ts loads under Node type stripping', () => {
  it('a plain node process with the hook reads the golden update file and stages it', () => {
    const dir = scratch()
    const staging = makeStaging(dir, '1.2.0')
    const url = (...p: string[]): string => JSON.stringify(pathToFileURL(join(...p)).href)
    const updates = (name: string): string => url(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', name)
    const script = [
      `const { registerTsSiblingImports } = await import(${url(REPO_ROOT, 'scripts', 'lib', 'ts-sibling-imports.mjs')})`,
      'registerTsSiblingImports()',
      `const b = await import(${updates('bundle.ts')})`,
      `const e = await import(${updates('envelope.ts')})`,
      `const v = await import(${updates('version.ts')})`,
      "const fsp = await import('node:fs/promises')",
      `const keys = e.parseKeySet(${JSON.stringify(MARKER + GOLDEN_KEYS.keys.join(','))}).keys`,
      "const input = { runningVersion: v.parseSemver('1.0.0'), driveAppVersion: null, rootApps: [], maxVersion: null, now: Date.parse('2026-11-27T10:00:00Z'), uiLanguage: 'en', os: 'win32', osVersion: '10.0.26300', glibc: null }",
      'const fs = { open: (p, f) => fsp.open(p, f), rename: (a, t) => fsp.rename(a, t), unlink: (p) => fsp.unlink(p) }',
      `const read = await b.readUpdateFile(${JSON.stringify(join(UPDATES_FIXTURES, 'golden.hrupdate'))}, { keys, input, fs, cancelled: () => false })`,
      "if (read.kind !== 'checked') { console.log(JSON.stringify(read)); process.exit(2) }",
      `const staged = await read.file.stage({ incomingDir: ${JSON.stringify(staging.incomingDir)}, filesDir: ${JSON.stringify(staging.filesDir)}, cancelled: () => false, progress: () => {} })`,
      'await read.file.close()',
      'console.log(JSON.stringify([read.file.payload.version, staged.kind, staged.files.map((f) => f.name)]))'
    ].join('\n')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: testBudgetMs(60_000)
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    const listed = stagedJsonFiles(golden('golden.hrupdate').stagedJson).map((f) => f.name)
    expect(r.stdout.trim()).toBe(JSON.stringify(['1.2.0', 'staged', listed]))
    expect(readdirSync(staging.filesDir).sort()).toEqual([...listed].sort())
  })
})
