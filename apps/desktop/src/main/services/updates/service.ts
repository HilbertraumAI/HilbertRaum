// The update service (app-update W-4, W-5, W-82; F-5, F-14's service half, F-21's refusal; docs/app-updates.md §3.5,
// §3.6, §4.5): one object per process behind the four update channels callable while locked (T6.3 registers its four
// methods as `updates:importFile`, `updates:status`, `updates:cancel` and `updates:discardStaged`), built with its start
// step. It runs an update file's import in the record's order over the reader (bundle.ts) and the drive's functions
// (staging.ts), holds the run's state, the one-time old-file token, the staged update and the sweep's notice, and writes
// every update.log line of the import from the facts each verdict carries. Every answer is a typed code with its
// parameters (shared/updates/import-types.ts), never copy, never an address, never a path.
//
// The order of a call to importFile (record §4.5, its first row): a run already going, a discard, or the start step's
// sweep still going when the channels' wait ends: `busy`; a call that hands back a token: not live, `expired`, live,
// spent now; (0) P7's place; an empty key set: UPD-NOT-AVAILABLE; a root that is no prepared drive: UPD-NOT-A-DRIVE
// (nothing read or written under it, F-21); the policy, read from disk once for the run (managed, invalid; its cap is
// the payload check's); the drive's checks before the dialog (staging.ts); the dialog (main's own, handed in); the
// reader's checks (bundle.ts); the checks before the data pass (staging.ts); the old-file stop (a new token, nothing
// removed); the data pass; the commit. A run checks for a cancel when the dialog returns and between two checks; the
// reader asks the same hook at its own points. A refusal before the dialog writes its line only when the last import
// line of this process was not the same code from a check before the dialog (N-7).
//
// The start step (record §4.5 "The start step", CF-54): on a prepared drive only, never throwing. Its synchronous part
// lists the root and lstats `updates/` (the links row: a real folder by lstat and workspace-vault.ts's
// folderContainment), runs P7's place (step (1), the removal of a finished or dead `updates/applying/`, empty in
// PR-6a), and lstats `updates/applying/` (step (2): present, or a stat that fails other than with ENOENT, means no sweep
// for this process). Its asynchronous part, the sweep (staging.ts's planSweep and carryOutSweep, awaited calls that
// yield between entries), starts on a later turn of the event loop, so after initBackend has returned or thrown; every
// method waits for it until it ends or 10 s after it started, whichever comes first, and a call after that never waits.
//
// What it does not do: open the file dialog (main hands its own in), register a channel or check a sender (T6.3), read
// or write anything under `workspace/`, or read anything under a root that is no prepared drive. It writes on the drive
// only through staging.ts, the reader's data pass into the folders staging made, and the update.log appender. It takes
// every host value from its caller (the paths, the key set, the running version, the system and its version, the
// clock, the reads, the dialog, the appender and the file-system calls), so it runs in Node without Electron.

import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { bareSyscall } from '../failure-for-log'
import { renameWithRetry } from '../fs-retry'
import { log } from '../logging'
import type { UpdatePolicy } from '../policy'
import type { ResolvedPaths } from '../workspace'
import { folderContainment } from '../workspace-vault'
import { readUpdateFile, type BundleFileSystem, type CheckedUpdateFile } from './bundle'
import { driveAppVersion, type DriveReleaseRead, type RootApp } from './drive-release'
import type { UpdateKey } from './envelope'
import type { KitSupportRead } from './kit-support'
import { foldMemberName } from './member-name'
import type { PayloadInput } from './payload'
import {
  UPDATES_FOLDER,
  carryOutSweep,
  checkBeforeDataPass,
  checkDriveBeforeDialog,
  commitStaged,
  discardStaged as discardOnDrive,
  discardedLogFields,
  logVersion,
  planSweep,
  removeStagingFolders,
  startDataPass,
  sweptLogFields,
  type RemovalFailure,
  type StagingContext,
  type StagingFileSystem,
  type UpdatesDrive
} from './staging'
import type { UpdateLogEvent, UpdateLogField, UpdateLogPaths } from './update-log'
import type { Semver } from './version'
import type { AcceptedPayload, UpdateSystem } from '../../../shared/updates/types'
import type {
  CancelAnswer,
  DamagedOnDriveNotice,
  DiscardStagedAnswer,
  ImportFileAnswer,
  ImportIoCause,
  ImportOnlyRefusal,
  ImportRefusal,
  ImportRunStatus,
  ImportUpdateFacts,
  ImportWarning,
  StagingLinkName,
  SupportEndStatus,
  UpdatePolicyStatus,
  UpdatesDriveStatus,
  UpdatesStatus
} from '../../../shared/updates/import-types'

/** The channels' one wait for the start step's sweep, from its start (record §4.5 "The start step"). */
export const START_WAIT_MS = 10_000
/** The drive part of `status` is read at most once per this many milliseconds of the monotonic clock (§3.5). */
export const DRIVE_READS_MS = 250

const APPLYING_FOLDER = 'applying'
/** The codes an I/O error gives: only their lines carry `err` and `syscall` (§4.5's events). */
const IO_CODES: ReadonlySet<string> = new Set(['UPD-DRIVE-READ-ONLY', 'UPD-DRIVE-FULL', 'UPD-FILE-TOO-BIG-FOR-DRIVE', 'UPD-CANT-READ-FILE', 'UPD-CANT-WRITE-DRIVE'])

// ---- what the service is handed

/** The synchronous calls of the start step and of `status`'s drive reads: lstats and one listing, never a write. */
export interface StartFileSystem {
  readdirSync(path: string): string[]
  lstatSync(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean }
}

/** node:fs's own, as main hands them in. */
export const NODE_START_FS: StartFileSystem = {
  readdirSync: (path) => readdirSync(path),
  lstatSync: (path) => lstatSync(path)
}

/** What the reader is handed (bundle.ts may import only its siblings): node:fs/promises, with fs-retry.ts's rename. */
export const NODE_BUNDLE_FS: BundleFileSystem = {
  open: (path, flags) => open(path, flags),
  rename: (from, to) => renameWithRetry(from, to),
  unlink: (path) => unlink(path)
}

/** The computer the import runs on (CF-50): the system whose rules apply, and what the payload check reads of it. */
export interface UpdateHost {
  /** process.platform. */
  readonly platform: NodeJS.Platform
  /** process.getSystemVersion() on Windows and macOS (read once per import). */
  osVersion(): string | null
  /** The runtime glibc on Linux (process.report's glibcVersionRuntime), or null. */
  glibc(): string | null
  /** The UI language, one of release 1's ten codes (the summary shown). */
  uiLanguage(): string
}

export interface UpdateClock {
  /** The wall clock in milliseconds (Date.now): the payload check's `now`, read once per import. */
  now(): number
  /** A monotonic clock in milliseconds (performance.now): the 250 ms of status's drive reads. */
  monotonic(): number
}

/** The reads the service makes on the drive, each its module's own (policy.ts, drive-release.ts, kit-support.ts). */
export interface UpdateReads {
  /** readUpdatePolicy(configPath): read from disk at every call. */
  policy(configPath: string): UpdatePolicy
  /** readDriveRelease(rootPath). */
  driveRelease(rootPath: string): DriveReleaseRead
  /** rootApps(rootPath): throws when the root cannot be listed (the payload check then takes null). */
  rootApps(rootPath: string): readonly RootApp[]
  /** readKitSupport(rootPath). */
  kitSupport(rootPath: string): KitSupportRead
  /** The build date (record §5.10's reader), or null. */
  buildDate(): string | null
}

/** A content-free event for the workspace's audit log (record §8.6, W-18): what the audit sink is told. */
export interface UpdateAuditEvent {
  readonly event: 'update_staged'
  readonly version: string
}
export type UpdateAuditHook = (event: UpdateAuditEvent) => void

export interface UpdateServiceDeps {
  /** The layout (resolvePaths), or null in a failure state that has none: answered as a root that is no prepared drive. */
  readonly paths: Pick<ResolvedPaths, 'rootPath' | 'configPath' | 'isPreparedDrive'> | null
  /** The embedded key set (keys.ts, parseKeySet's keys); empty: every import answers UPD-NOT-AVAILABLE. */
  readonly keys: readonly UpdateKey[]
  /** The app's own version, parsed. */
  readonly runningVersion: Semver
  readonly host: UpdateHost
  readonly clock: UpdateClock
  readonly reads: UpdateReads
  /** Main's file dialog for the window that called (one file, the update file filters): a path, or null when closed. A
   *  dialog that cannot open counts as closed. */
  readonly chooseFile: (caller: unknown) => Promise<string | null>
  /** update-log.ts's appendUpdateLogLine. */
  readonly appendLog: (paths: UpdateLogPaths, event: UpdateLogEvent, fields: readonly UpdateLogField[]) => void
  readonly fs: { readonly bundle: BundleFileSystem; readonly staging: StagingFileSystem; readonly start: StartFileSystem }
  /** P7's place in the start step (CF-54): runs once `updates/` is found a real folder, before step (2) and the sweep,
   *  so before any channel answers. Empty in PR-6a. */
  readonly startHook?: (facts: { readonly updatesDir: string }) => void
}

/** The four channels' methods (record §3.5), and the audit sink the normal start sets and the failure state never sets. */
export interface UpdateService {
  importFile(argument?: unknown, caller?: unknown): Promise<ImportFileAnswer>
  status(): Promise<UpdatesStatus>
  cancel(): Promise<CancelAnswer>
  discardStaged(argument?: unknown): Promise<DiscardStagedAnswer>
  setAuditHook(hook: UpdateAuditHook | null): void
}

// ---- small helpers

const IDLE: ImportRunStatus = Object.freeze({ state: 'idle' })
const CHECKING: ImportRunStatus = Object.freeze({ state: 'checking' })
const CHOOSING: ImportRunStatus = Object.freeze({ state: 'choosing' })
const BUSY = Object.freeze({ kind: 'busy' as const })
const EXPIRED = Object.freeze({ kind: 'expired' as const })
const CLOSED = Object.freeze({ kind: 'closed' as const })
const NO_DRIVE: UpdatesDriveStatus = Object.freeze({ kind: 'none' })

/** An error's code when it is one (an errno or a Node code, never a message), for app.log. */
function codeOf(error: unknown): string | null {
  try {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : null
  } catch {
    return null
  }
}

function syscallOf(error: unknown): string | null {
  try {
    return bareSyscall(typeof error === 'object' && error !== null ? (error as { syscall?: unknown }).syscall : undefined)
  } catch {
    return null
  }
}

/** app.log, by a fixed reason and the error's code and bare system call, never a path. */
function report(reason: string, error: unknown): void {
  try {
    log.warn(`Update service: ${reason}`, { code: codeOf(error), syscall: syscallOf(error) })
  } catch {
    /* the log is best-effort */
  }
}

function reportCause(reason: string, cause: ImportIoCause | null, extra: Record<string, unknown> = {}): void {
  try {
    log.warn(`Update service: ${reason}`, { ...extra, code: codeOf(cause), syscall: bareSyscall(cause?.syscall) })
  } catch {
    /* the log is best-effort */
  }
}

function quietly<T>(fallback: T, read: () => T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

const yesNo = (flag: boolean): string => (flag ? 'yes' : 'no')

/** The system whose payload rules apply: release 1's three (anything else is checked as Linux is). */
const systemOf = (platform: NodeJS.Platform): UpdateSystem => (platform === 'win32' || platform === 'darwin' ? platform : 'linux')

type UpdatesFound = { readonly kind: 'absent' } | { readonly kind: 'real'; readonly dir: string } | { readonly kind: 'not-real' }
const ABSENT: UpdatesFound = { kind: 'absent' }
const NOT_REAL: UpdatesFound = { kind: 'not-real' }

/**
 * `updates/` under the drive root by the links row (record §4.5 "Links under updates/"): the entry spelled `updates` in
 * the root's listing, else the one entry equal after the ASCII fold, and that one only when an lstat of `updates` finds
 * it; then a real folder by lstat and folderContainment. A listing or a stat that proves nothing, and anything at the
 * name that is no real folder, are `not-real`.
 */
function findUpdates(fs: StartFileSystem, root: string): UpdatesFound {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? ABSENT : NOT_REAL
  }
  let name = UPDATES_FOLDER
  if (!names.includes(UPDATES_FOLDER)) {
    const folded = names.filter((entry) => foldMemberName(entry) === UPDATES_FOLDER)
    try {
      fs.lstatSync(join(root, UPDATES_FOLDER))
    } catch (error) {
      return codeOf(error) === 'ENOENT' ? ABSENT : NOT_REAL
    }
    if (folded.length !== 1) return NOT_REAL
    name = folded[0]!
  }
  const dir = join(root, name)
  let info: { isDirectory(): boolean; isSymbolicLink(): boolean }
  try {
    info = fs.lstatSync(dir)
  } catch {
    return NOT_REAL
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return NOT_REAL
  return folderContainment(root, dir) === 'inside' ? { kind: 'real', dir } : NOT_REAL
}

/** `updates/applying/` present: an lstat that does not answer ENOENT (any entry, or a stat that fails otherwise). */
function applyingPresent(fs: StartFileSystem, updatesDir: string): boolean {
  try {
    fs.lstatSync(join(updatesDir, APPLYING_FOLDER))
    return true
  } catch (error) {
    return codeOf(error) !== 'ENOENT'
  }
}

const policyStatus = (policy: UpdatePolicy): UpdatePolicyStatus => ({ install: policy.install, maxVersion: policy.maxVersion?.text ?? null, file: policy.file })

function supportEndOf(read: KitSupportRead): SupportEndStatus {
  if (read.kind === 'month') return { state: 'month', month: read.month }
  return read.kind === 'absent' ? { state: 'absent' } : { state: 'unreadable' }
}

const updateFacts = (payload: AcceptedPayload): ImportUpdateFacts => ({ version: payload.version, issued: payload.issued, summary: payload.summary })

/** The warnings shown while the update is copied and with the answer (§3.5's order: the future date, the other floors). */
function warningsOf(payload: AcceptedPayload): ImportWarning[] {
  const notices: ImportWarning[] = []
  if (payload.flags.issuedInFuture && payload.issued !== null) notices.push({ code: 'UPD-ISSUED-IN-FUTURE', params: { issued: payload.issued } })
  if (payload.flags.otherSystemFloors.length > 0) notices.push({ code: 'UPD-OTHER-SYSTEM-FLOOR', params: { floors: payload.flags.otherSystemFloors } })
  return notices
}

/** The version a refusal names itself (UPD-SAME-OR-OLDER, UPD-ABOVE-MAX-VERSION), for its line. */
function refusalVersion(refusal: ImportRefusal): string | null {
  return refusal.code === 'UPD-SAME-OR-OLDER' || refusal.code === 'UPD-ABOVE-MAX-VERSION' ? refusal.params.version : null
}

interface LineFacts {
  readonly version?: string | null
  readonly stale?: boolean | null
  readonly cause?: ImportIoCause | null
  readonly link?: StagingLinkName | null
}

/** `import-refused`'s fields (§4.5's events): the code; the version the run knows (V, or `unknown` for 25 to 64 bytes);
 *  `stale_drive_version` once the payload check ran; `err` and `syscall` for the codes an I/O error gives; `link` with
 *  UPD-CANT-WRITE-DRIVE only. */
function refusedFields(code: string, facts: LineFacts): UpdateLogField[] {
  const fields: UpdateLogField[] = [['code', code]]
  if (facts.version !== undefined && facts.version !== null) fields.push(['version', logVersion(facts.version)])
  if (facts.stale !== undefined && facts.stale !== null) fields.push(['stale_drive_version', yesNo(facts.stale)])
  if (IO_CODES.has(code) && facts.cause) {
    if (facts.cause.code !== null) fields.push(['err', facts.cause.code])
    const call = bareSyscall(facts.cause.syscall)
    if (call !== null) fields.push(['syscall', call])
  }
  if (code === 'UPD-CANT-WRITE-DRIVE' && facts.link) fields.push(['link', facts.link])
  return fields
}

// ---- the service

/** The live old-file confirmation (§3.5): bound to the picked file and the payload's version and `issued` text. */
interface Token {
  readonly value: string
  readonly path: string
  readonly version: string
  readonly issued: string
}

interface Run {
  status: ImportRunStatus
  cancel: boolean
  /** The run's own policy read (status shows it while the run goes). */
  policy: UpdatePolicy | null
}

interface DriveReads {
  readonly updatesFolder: 'real' | 'not-real'
  readonly inProgress: boolean
  readonly policy: UpdatePolicyStatus
  readonly supportEnd: SupportEndStatus
}

type PreparedPaths = NonNullable<UpdateServiceDeps['paths']>

class Service implements UpdateService {
  private readonly deps: UpdateServiceDeps
  /** The layout when it is a prepared drive; null otherwise (nothing under the root is read, F-21). */
  private readonly drive: PreparedPaths | null
  private run: Run | null = null
  private discarding = false
  private sweeping = false
  private staged: { readonly version: string } | null = null
  private notice: DamagedOnDriveNotice | null = null
  private token: Token | null = null
  /** The last import line this process wrote, for the repeated-refusal rule (N-7). */
  private lastImportLine: { readonly code: string | null; readonly beforeDialog: boolean } | null = null
  private driveReads: { readonly at: number; readonly reads: DriveReads } | null = null
  private audit: UpdateAuditHook | null = null
  /** The channels' one wait: resolved at once, or when the sweep ends or 10 s after it started. */
  private wait: Promise<void> = Promise.resolve()

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps
    this.drive = deps.paths !== null && deps.paths.isPreparedDrive ? deps.paths : null
    this.start()
  }

  // ---- the start step

  private start(): void {
    try {
      const drive = this.drive
      if (drive === null) return
      const found = findUpdates(this.deps.fs.start, drive.rootPath)
      if (found.kind !== 'real') return
      // (1) P7's place: a finished or dead updates/applying/ is removed here, before step (2) and the sweep (CF-54).
      this.deps.startHook?.({ updatesDir: found.dir })
      // (2) never a sweep while updates/applying/ exists (or its stat proves nothing): staged stays null for the process.
      if (applyingPresent(this.deps.fs.start, found.dir)) return
      this.sweeping = true
      this.wait = new Promise<void>((resolve) => {
        setImmediate(() => {
          const timer = setTimeout(resolve, START_WAIT_MS)
          ;(timer as { unref?: () => void }).unref?.()
          void this.sweep(drive, found.dir).finally(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      })
    } catch (error) {
      this.sweeping = false
      report('the start step failed', error)
    }
  }

  /** (3) the sweep's reads and decisions, (4) the staged update and the notice, (5) its removals, then its lines. */
  private async sweep(drive: PreparedPaths, updatesDir: string): Promise<void> {
    try {
      const ctx = this.context(drive)
      const plan = await planSweep(ctx, updatesDir)
      this.staged = plan.staged
      this.notice = plan.notice
      for (const failure of await carryOutSweep(ctx, plan)) reportCause('a removal the start-up sweep decided failed', failure.cause, { reason: failure.reason })
      for (const fields of sweptLogFields(plan)) this.appendLine('staging-swept', fields)
    } catch (error) {
      this.staged = null
      this.notice = null
      report('the start-up sweep failed', error)
    } finally {
      this.sweeping = false
    }
  }

  // ---- updates:importFile

  async importFile(argument?: unknown, caller?: unknown): Promise<ImportFileAnswer> {
    await this.wait
    if (this.occupied()) return BUSY
    const redeem = this.takeToken(argument)
    if (redeem === 'expired') return EXPIRED
    const run: Run = { status: CHECKING, cancel: false, policy: null }
    this.run = run
    try {
      return await this.runImport(run, redeem, caller)
    } finally {
      this.run = null
    }
  }

  /** null: the call opens the dialog; a token: the live one, spent now; `expired`: an own `confirmToken` not live. */
  private takeToken(argument: unknown): Token | null | 'expired' {
    let asked: unknown
    try {
      if (typeof argument !== 'object' || argument === null || !Object.hasOwn(argument, 'confirmToken')) return null
      asked = (argument as Record<string, unknown>).confirmToken
    } catch {
      return 'expired'
    }
    const live = this.token
    if (live === null || typeof asked !== 'string' || asked !== live.value) return 'expired'
    this.token = null
    return live
  }

  private async runImport(run: Run, redeem: Token | null, caller: unknown): Promise<ImportFileAnswer> {
    // (0) P7's place: a start that answers UPD-OLDER-THAN-DRIVE refuses here and writes no line (no such check in PR-6a).
    if (this.deps.keys.length === 0) return this.refuseBeforeDialog({ code: 'UPD-NOT-AVAILABLE', params: {} })
    const drive = this.drive
    if (drive === null) return { kind: 'refused', refusal: this.notADrive() }
    const policy = this.deps.reads.policy(drive.configPath)
    run.policy = policy
    if (policy.install === 'managed') return this.refuseBeforeDialog({ code: 'UPD-POLICY-MANAGED', params: {} })
    if (policy.install === 'invalid') return this.refuseBeforeDialog({ code: 'UPD-POLICY-INVALID', params: {} })
    const ctx = this.context(drive)
    const pre = await checkDriveBeforeDialog(ctx)
    if (pre.kind === 'refused') return this.refuseBeforeDialog(pre.refusal, { cause: pre.cause, link: pre.link })
    if (run.cancel) return this.cancelledBeforeRead()
    let path: string
    if (redeem !== null) path = redeem.path
    else {
      run.status = CHOOSING
      this.token = null // a call that opens the dialog spends the live token
      const picked = await this.choose(caller)
      if (run.cancel) return this.cancelledBeforeRead()
      if (picked === null) return CLOSED
      path = picked
      run.status = CHECKING
    }
    const read = await readUpdateFile(path, {
      keys: this.deps.keys,
      input: this.payloadInput(policy, drive.rootPath),
      fs: this.deps.fs.bundle,
      cancelled: () => run.cancel === true
    })
    if (read.kind === 'cancelled') return this.cancelled(read.payload?.version ?? null)
    if (read.kind === 'refused') {
      const version = read.payload?.version ?? refusalVersion(read.refusal)
      return this.refuseRead(read.refusal, { version, stale: read.staleDriveVersion, cause: read.cause })
    }
    try {
      return await this.stage(run, read.file, ctx, pre.drive, redeem, path)
    } finally {
      await quietlyAsync(() => read.file.close())
    }
  }

  /** From the reader's checked answer to the commit: the checks before the data pass, the old-file stop, the data pass. */
  private async stage(run: Run, file: CheckedUpdateFile, ctx: StagingContext, drive: UpdatesDrive, redeem: Token | null, path: string): Promise<ImportFileAnswer> {
    const payload = file.payload
    const version = payload.version
    const stale = payload.flags.staleDriveVersion
    const update = updateFacts(payload)
    const notices = warningsOf(payload)
    // The reader asked for a cancel as its last step; the next check point follows the checks before the data pass.
    const post = await checkBeforeDataPass(ctx, drive, { version, present: file.present })
    if (post.kind === 'refused') return this.refuseRead(post.refusal, { version, stale, cause: post.cause, link: post.link })
    if (run.cancel) return this.cancelled(version)
    const confirmed = payload.flags.oldFile && redeem !== null && redeem.version === version && redeem.issued === payload.issued
    if (payload.flags.oldFile && payload.issued !== null && !confirmed) {
      // The old-file stop: nothing removed, a new token (minting one spends the one before), and the question.
      const token: Token = { value: randomUUID(), path, version, issued: payload.issued }
      this.token = token
      this.importLine('import-refused', refusedFields('UPD-OLD-FILE', { version, stale }), 'UPD-OLD-FILE', false)
      return { kind: 'confirm', token: token.value, update, notice: { code: 'UPD-OLD-FILE', params: { issued: payload.issued } }, notices }
    }
    run.status = Object.freeze({ state: 'copying', done: 0, total: file.totalBytes, update, notices })
    const start = await startDataPass(ctx, drive, post.targets, version)
    if (start.kind === 'refused') return this.refuseRead(start.refusal, { version, stale, cause: start.cause, link: start.link })
    const end = await file.stage({
      incomingDir: start.folders.incomingDir,
      filesDir: start.folders.filesDir,
      cancelled: () => run.cancel === true,
      progress: (done) => {
        try {
          const now = run.status
          if (now.state === 'copying') run.status = Object.freeze({ ...now, done: Math.min(Math.max(done, 0), now.total) })
        } catch {
          // A status write that fails here must never reach the reader, which would answer the throw as the I/O step it
          // interrupted (T6.1 review m-3): the bytes shown wait for the next slice.
        }
      }
    })
    if (end.kind !== 'staged') {
      this.reportLeft('the data pass', await removeStagingFolders(ctx, start.folders))
      if (end.kind === 'cancelled') return this.cancelled(version)
      return this.refuseRead(end.refusal, { version, stale, cause: end.cause })
    }
    run.status = Object.freeze({ state: 'committing', update, notices })
    const commit = await commitStaged(ctx, start.folders, { envelope: file.envelope, files: end.files })
    if (commit.kind === 'refused') {
      this.reportLeft('the commit', await removeStagingFolders(ctx, start.folders))
      return this.refuseRead(commit.refusal, { version, stale, cause: commit.cause, link: commit.link })
    }
    this.reportLeft('the commit', commit.incomingLeft)
    this.staged = { version }
    this.notice = null
    this.driveReads = null
    this.importLine(
      'import-staged',
      [
        ['version', logVersion(version)],
        ['stale_drive_version', yesNo(stale)],
        ['files', String(end.files.length)],
        ['old_file', confirmed ? 'confirmed' : 'no'],
        ['issued_in_future', yesNo(notices.some((n) => n.code === 'UPD-ISSUED-IN-FUTURE'))],
        ['other_floors', yesNo(notices.some((n) => n.code === 'UPD-OTHER-SYSTEM-FLOOR'))]
      ],
      null,
      false
    )
    this.tellAudit({ event: 'update_staged', version })
    return { kind: 'staged', update, notices }
  }

  /** The payload check's input, built once per run (CF-50): the host's system and its version (Windows, macOS) or its
   *  glibc (Linux), the policy's cap, the drive record's app_version and the root's apps (null when the root cannot be
   *  listed), the clock now. */
  private payloadInput(policy: UpdatePolicy, root: string): PayloadInput {
    const release = this.deps.reads.driveRelease(root)
    let apps: readonly RootApp[] | null
    try {
      apps = this.deps.reads.rootApps(root)
    } catch {
      apps = null
    }
    const common = {
      runningVersion: this.deps.runningVersion,
      driveAppVersion: driveAppVersion(release),
      rootApps: apps,
      maxVersion: policy.maxVersion,
      now: this.deps.clock.now(),
      uiLanguage: quietly('en', () => this.deps.host.uiLanguage())
    }
    const os = systemOf(this.deps.host.platform)
    if (os === 'linux') {
      const glibc = quietly(null, () => this.deps.host.glibc())
      return { ...common, os, osVersion: null, glibc: typeof glibc === 'string' ? glibc : null }
    }
    const osVersion = quietly(null, () => this.deps.host.osVersion())
    return { ...common, os, osVersion: typeof osVersion === 'string' ? osVersion : '', glibc: null }
  }

  private async choose(caller: unknown): Promise<string | null> {
    try {
      const picked = await this.deps.chooseFile(caller)
      return typeof picked === 'string' && picked !== '' ? picked : null
    } catch {
      return null // a dialog that cannot open counts as closed
    }
  }

  // ---- updates:status

  async status(): Promise<UpdatesStatus> {
    await this.wait
    const run = this.run
    return {
      runningVersion: this.deps.runningVersion.text,
      available: this.deps.keys.length > 0,
      import: run?.status ?? IDLE,
      buildDate: quietly(null, () => this.deps.reads.buildDate()),
      drive: this.driveStatus(run)
    }
  }

  private driveStatus(run: Run | null): UpdatesDriveStatus {
    const drive = this.drive
    if (drive === null) return NO_DRIVE
    const now = this.deps.clock.monotonic()
    let cached = this.driveReads
    if (cached === null || !(now - cached.at < DRIVE_READS_MS)) {
      cached = { at: now, reads: this.readDrive(drive, run) }
      this.driveReads = cached
    }
    const { updatesFolder, inProgress, policy, supportEnd } = cached.reads
    return {
      kind: 'prepared',
      updatesFolder,
      policy: run?.policy ? policyStatus(run.policy) : policy,
      inProgress,
      staged: updatesFolder === 'real' ? this.staged : null,
      notice: this.notice,
      sweeping: this.sweeping,
      supportEnd
    }
  }

  /** The drive part's reads: `updates/` by the links row, `updates/applying/` by one lstat, the policy (the run's own
   *  while a run goes, never read again for it) and the support end. */
  private readDrive(drive: PreparedPaths, run: Run | null): DriveReads {
    const found = findUpdates(this.deps.fs.start, drive.rootPath)
    return {
      updatesFolder: found.kind === 'not-real' ? 'not-real' : 'real',
      inProgress: found.kind === 'real' && applyingPresent(this.deps.fs.start, found.dir),
      policy: policyStatus(run?.policy ?? this.deps.reads.policy(drive.configPath)),
      supportEnd: supportEndOf(this.deps.reads.kitSupport(drive.rootPath))
    }
  }

  // ---- updates:cancel

  async cancel(): Promise<CancelAnswer> {
    await this.wait
    const run = this.run
    if (run === null) {
      this.token = null
      return { kind: 'idle' }
    }
    if (run.status.state === 'committing') return { kind: 'committing' }
    run.cancel = true
    return { kind: 'stopping' }
  }

  // ---- updates:discardStaged

  async discardStaged(argument?: unknown): Promise<DiscardStagedAnswer> {
    await this.wait
    const drive = this.drive
    if (drive === null) return { kind: 'refused', refusal: this.notADrive() }
    if (this.occupied()) return BUSY
    // P7's place: a start that answers UPD-OLDER-THAN-DRIVE refuses here and writes no line (no such check in PR-6a).
    this.discarding = true
    try {
      const end = await discardOnDrive(this.context(drive), this.staged, argument)
      this.driveReads = null
      if (end.kind === 'discarded') {
        this.staged = null
        this.appendLine('staging-discarded', discardedLogFields(end.version))
        return { kind: 'discarded', version: end.version }
      }
      if (end.kind === 'not-staged') return { kind: 'not-staged' }
      if (end.cause !== null) reportCause('a discard failed', end.cause)
      return { kind: 'refused', refusal: end.refusal }
    } finally {
      this.discarding = false
    }
  }

  setAuditHook(hook: UpdateAuditHook | null): void {
    this.audit = hook
  }

  // ---- the answers and their lines

  private occupied(): boolean {
    return this.run !== null || this.discarding || this.sweeping
  }

  private notADrive(): Extract<ImportOnlyRefusal, { code: 'UPD-NOT-A-DRIVE' }> {
    return { code: 'UPD-NOT-A-DRIVE', params: { runningVersion: this.deps.runningVersion.text } }
  }

  private context(drive: PreparedPaths): StagingContext {
    return { root: drive.rootPath, platform: this.deps.host.platform, fs: this.deps.fs.staging }
  }

  private refuseBeforeDialog(refusal: ImportRefusal, facts: LineFacts = {}): ImportFileAnswer {
    this.importLine('import-refused', refusedFields(refusal.code, facts), refusal.code, true)
    return { kind: 'refused', refusal }
  }

  private refuseRead(refusal: ImportRefusal, facts: LineFacts): ImportFileAnswer {
    this.importLine('import-refused', refusedFields(refusal.code, facts), refusal.code, false)
    return { kind: 'refused', refusal }
  }

  /** A cancel before the file was read writes no line (§3.5 updates:cancel). */
  private cancelledBeforeRead(): ImportFileAnswer {
    return { kind: 'cancelled' }
  }

  /** A cancel once the file was read: `import-cancelled`, with the version when the payload was accepted. */
  private cancelled(version: string | null): ImportFileAnswer {
    this.importLine('import-cancelled', version === null ? [] : [['version', logVersion(version)]], null, false)
    return { kind: 'cancelled' }
  }

  /** One import line, unless it is a refusal before the dialog of the same code as the last import line, which was one
   *  too (N-7: a page that repeats a refused call adds one line, not one per call). Only on a prepared drive. */
  private importLine(event: 'import-refused' | 'import-staged' | 'import-cancelled', fields: readonly UpdateLogField[], code: string | null, beforeDialog: boolean): void {
    if (this.drive === null) return
    const last = this.lastImportLine
    if (beforeDialog && last !== null && last.beforeDialog && last.code === code) return
    this.appendLine(event, fields)
    this.lastImportLine = { code, beforeDialog }
  }

  private appendLine(event: UpdateLogEvent, fields: readonly UpdateLogField[]): void {
    const drive = this.drive
    if (drive === null) return
    try {
      this.deps.appendLog(drive, event, fields)
    } catch (error) {
      report('an update.log line could not be handed on', error)
    }
  }

  private reportLeft(step: string, failure: RemovalFailure | null): void {
    if (failure !== null) reportCause('a staging folder was left after a failed removal', failure.cause, { step, link: failure.link })
  }

  private tellAudit(event: UpdateAuditEvent): void {
    const hook = this.audit
    if (hook === null) return
    try {
      hook(event)
    } catch (error) {
      report('the audit hook threw', error)
    }
  }
}

async function quietlyAsync(work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch {
    /* the answer is already decided */
  }
}

/** The update service of this process, its start step run (record §3.5 "The service and its start"). Never throws. */
export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  return new Service(deps)
}
