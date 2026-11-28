// Staging: the drive side of an update file's import and of the start (app-update W-5; F-5, F-18's staging half;
// docs/app-updates.md §3.5, §3.6, §4.2, §4.5, §4.6, §4.7). Typed, stateless functions over the drive root their caller
// names, each answering a typed verdict of §4.7 and §5.8 (import-types.ts), never copy, never a path in an answer's
// facts, never a throw for any drive state:
// - checkDriveBeforeDialog: §4.5's order from `updates/` to the 64 MiB margin (`updates/` found or made with one plain
//   mkdir, `updates/staging/` where it exists, `updates/applying/`, the writability probe of table A.1, the margin);
// - checkBeforeDataPass: after the reader's `checked` answer, the Windows path length over the members present,
//   `updates/staging/<v>/` and `.incoming-<v>/` real folders where they exist, and the free-space formula;
// - startDataPass: removes those two folders, then makes `updates/staging/` when it is missing, `.incoming-<v>/`, `<v>/`
//   and `<v>/files/` (each one plain mkdir, then tested), the folders the reader's data pass writes into;
// - commitStaged: `<v>/` tested again, every other `<w>/` and `.incoming-<w>/` that is a real folder removed, the
//   cleared line (last-result.ts), the envelope as `hilbertraum-release.dsse.json`, `staged.txt`, then `staged.json`
//   last (F-5's bytes), `.incoming-<v>/` removed;
//   removeStagingFolders: the removal after a refusal or a cancel from the data pass on;
// - planSweep and carryOutSweep: the start-up sweep's reads and decisions, then its removals (the start step's
//   asynchronous part); sweptLogFields: its `staging-swept` lines;
// - discardStaged: "Don't install this update", the drive half of `updates:discardStaged`.
//
// The link rule (§4.5 "Links under updates/", a damage limit, not a boundary; #1047 is the same family): a name is found
// by listing its parent (the entry spelled as asked, else the one entry equal after the ASCII fold of member-name.ts, and
// that one only when an lstat of the asked name finds it); a real folder is one lstat reports as a folder and the
// awaited form of `folderContainment` (workspace-vault.ts: an lstat walk from the drive root, then the native realpath of
// both ends) finds where its path says, so a Windows junction Node's lstat reads as a folder counts as a link too; a
// listing or a stat that fails other than with ENOENT proves nothing. Nothing is ever listed, read, written or removed
// through a link. A removal is the lstat walk below, never a recursive rm (Node's recursive rm enters such a junction,
// T6.0 S-2): its `staged.json` first, then each entry by lstat, a sub-folder entered only when it is a real folder, a
// link or a junction removed by its own name (unlink, or rmdir of a junction that reads as a folder, which removes the
// link alone), a file unlinked. The sweep and every walk run awaited file-system calls with a turn of the event loop
// between entries, so the main process is never held for longer than one call's own work.
//
// What it does not do: the key set, the policy, the order of a run's checks, the dialog, the reader, the old-file
// stop, the status, the start step's synchronous part, its wait and every update.log line are the update service's
// (T6.2 part 2); the channels are T6.3's. It writes nothing outside `updates/`, and before the data pass nothing there
// but `updates/` itself when it is missing and the probe's own name, which the probe deletes again. It does not see a
// mount point under `updates/` (a bind mount, a FUSE mount or a disk image attached there reads as a plain folder, and
// some of these need no root; T6.9 security L-2), and on Windows, which has no O_NOFOLLOW, a link planted between an lstat
// and an open is caught only by the descriptor's check. It takes the file-system calls from its caller (NODE_STAGING_FS: node's own,
// with fs-retry.ts's rename), and the system it applies Windows' rules for (`platform`).

import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, statfs, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { RENAME_RETRY_BUDGET_MS, removeRetry, renameMayClear, renameWithRetry } from '../fs-retry'
import { READ_SLICE_BYTES } from './bundle'
import { readJsonObject } from './envelope'
import { clearMarkOf, type LastResultFileHandle, type LastResultFileSystem, type LastResultStats } from './last-result'
import { ENVELOPE_MEMBER_NAME, foldMemberName, hasFoldedDuplicate, isMemberName } from './member-name'
import type { UpdateLogField } from './update-log'
import { compareSemver, parseSemver } from './version'
import type { AcceptedFile } from '../../../shared/updates/types'
import type {
  DamagedOnDriveNotice,
  DiscardEnd,
  ImportIoCause,
  StagingCheckRefusal,
  StagingLinkName,
  StagingRefused,
  SweepFacts,
  SweepReason,
  SweepRemovalFailure
} from '../../../shared/updates/import-types'

// ---- the names (table A.1, §4.2)

/** The drive's update folder. */
export const UPDATES_FOLDER = 'updates'
const STAGING_FOLDER = 'staging'
const APPLYING_FOLDER = 'applying'
const PROBE_NAME = '.write-probe'
const INCOMING_PREFIX = '.incoming-'
const FILES_FOLDER = 'files'
const STAGED_TXT = 'staged.txt'
const STAGED_JSON = 'staged.json'

// ---- the values (§4.5, §4.6)

/** `staged.json`'s size cap (§4.6): 62 × 65,536 bytes. */
export const STAGED_JSON_MAX_BYTES = 4_063_232
/** The free-space margin of every import (§5.4, the formula's third term at 1 MiB writes): 64 MiB. */
export const MARGIN_BYTES = 67_108_864
/** The cluster size taken when statfs reports a bsize of 0 (§4.5 "Free space"). */
const ZERO_BSIZE_CLUSTER_BYTES = 1_048_576
/** The run-ahead term: 64 × the write size (P6 writes READ_SLICE_BYTES at a time). */
const RUN_AHEAD_WRITES = 64
/** `MAX_PATH` 260 with its NUL (§4.5 "Path length (Windows)"). */
const WINDOWS_PATH_MAX_CHARS = 259
/** `<root>updates\staging\` and `\files\` around `<v>` (the root carries its trailing separator). */
const STAGING_PATH_HEAD_CHARS = 'updates\\staging\\'.length
const STAGING_PATH_TAIL_CHARS = '\\files\\'.length
const MEMBER_MAX_SIZE = 8_589_934_591
const VERSION_MAX_BYTES = 64
/** V's cap in update.log (§5.3): a valid version of 25 to 64 bytes is logged as `unknown`. */
const LOG_VERSION_MAX_BYTES = 24
const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/
const PROBE_BYTE = Buffer.from('1', 'latin1')
/** renameWithRetry's waits (services/fs-retry.ts), for the probe's removal and open "as §4.5's moves are" (table A.1). */
const MOVE_FIRST_WAIT_MS = 50
const MOVE_LONGEST_WAIT_MS = 1_000
/** The codes a recursive rm retries (removeRetry's budget, services/fs-retry.ts): a held name on Windows. */
const REMOVE_HELD_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])
/** The sweep's reasons, in the order of its lines (§4.5 "The start-up sweep"). */
const SWEEP_REASONS: readonly SweepReason[] = ['incoming', 'no-marker', 'invalid-marker', 'member-missing', 'not-a-folder', 'link']

// ---- the file-system calls, handed in

/** An lstat's or a descriptor's stat (bigint: a file id on Windows exceeds 2^53). */
export type StagingStats = LastResultStats
/** The calls made on an open file (a node:fs/promises FileHandle's). */
export type StagingFileHandle = LastResultFileHandle

/** The file-system calls staging makes; `realpath` is the native one (it resolves every reparse point). */
export interface StagingFileSystem extends LastResultFileSystem {
  readdir(path: string): Promise<string[]>
  realpath(path: string): Promise<string>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  /** A move in staging: fs-retry.ts's renameWithRetry (§4.5 "Moves"). */
  rename(from: string, to: string): Promise<void>
  statfs(path: string): Promise<{ bsize: number; bavail: number }>
}

/** node:fs/promises, with bigint stats and the retrying rename: what the update service hands staging. */
export const NODE_STAGING_FS: StagingFileSystem = {
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path, { bigint: true }),
  realpath: (path) => realpath(path),
  mkdir: async (path) => {
    await mkdir(path)
  },
  rmdir: (path) => rmdir(path),
  unlink: (path) => unlink(path),
  open: async (path, flags) => {
    const handle = await open(path, flags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      write: (buffer, offset, length) => handle.write(buffer, offset, length),
      sync: () => handle.sync(),
      close: () => handle.close()
    }
  },
  rename: (from, to) => renameWithRetry(from, to),
  statfs: async (path) => {
    const info = await statfs(path)
    return { bsize: info.bsize, bavail: info.bavail }
  }
}

/** Where staging works: the drive root its caller resolved, the system whose rules apply, and the calls it makes. */
export interface StagingContext {
  readonly root: string
  readonly platform: NodeJS.Platform
  readonly fs: StagingFileSystem
}

// ---- small helpers

/** The thrown value's own `code` and `syscall`, each only when it is a string (update.log's `err` and `syscall`). */
function causeOf(error: unknown): ImportIoCause {
  const field = (key: string): string | null => {
    const value = typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' ? value : null
  }
  return { code: field('code'), syscall: field('syscall') }
}
const codeOf = (error: unknown): string | null => causeOf(error).code

/** One turn of the event loop: the sweep and the walks never hold the main process between two entries. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** O_NOFOLLOW and O_NONBLOCK on macOS and Linux (§4.6 "The read"). */
const posixFlags = (platform: NodeJS.Platform): number => (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

/** A path compared as workspace-vault.ts's pathKey compares one: resolved, and folded on Windows. */
const pathKey = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

async function closeQuietly(handle: StagingFileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // The answer is already decided.
  }
}

/** On Windows, `op` tried again while it meets a held handle, as fs-retry.ts's renameWithRetry tries a move. */
async function asMovesAre<T>(ctx: StagingContext, op: () => Promise<T>): Promise<T> {
  let waited = 0
  let wait = MOVE_FIRST_WAIT_MS
  for (;;) {
    try {
      return await op()
    } catch (error) {
      if (!renameMayClear(error, ctx.platform) || waited + wait > RENAME_RETRY_BUDGET_MS) throw error
      await sleep(wait)
      waited += wait
      wait = Math.min(wait * 2, MOVE_LONGEST_WAIT_MS)
    }
  }
}

/** One removal call; on Windows, when `retry`, tried again with removeRetry's budget (EBUSY, EPERM, ENOTEMPTY). A name
 *  already gone is removed. */
async function removeCall(ctx: StagingContext, retry: boolean, op: () => Promise<void>): Promise<void> {
  const { maxRetries, retryDelay } = removeRetry(ctx.platform)
  const tries = retry ? maxRetries : 0
  for (let attempt = 0; ; attempt++) {
    try {
      await op()
      return
    } catch (error) {
      const code = codeOf(error)
      if (code === 'ENOENT') return
      if (attempt >= tries || code === null || !REMOVE_HELD_CODES.has(code)) throw error
      await sleep(retryDelay * (attempt + 1))
    }
  }
}

// ---- the verdicts

const refused = (refusal: StagingCheckRefusal, cause: ImportIoCause | null = null, link: StagingLinkName | null = null): StagingRefused => ({
  kind: 'refused',
  refusal,
  cause,
  link
})
const cantWrite = (link: StagingLinkName | null, cause: ImportIoCause | null = null): StagingRefused => refused({ code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause, link)
const readOnly = (cause: ImportIoCause | null): StagingRefused => refused({ code: 'UPD-DRIVE-READ-ONLY', params: {} }, cause)
const driveFull = (requiredBytes: number | null, freeBytes: number | null, cause: ImportIoCause | null = null): StagingRefused =>
  refused({ code: 'UPD-DRIVE-FULL', params: { requiredBytes, freeBytes } }, cause)
const inProgress = (): StagingRefused => refused({ code: 'UPD-IN-PROGRESS', params: {} })

/** A drive's write, move or remove error while staging (§4.5 "Errors while staging"): ENOSPC, EFBIG, or any other. */
function writeError(cause: ImportIoCause | null): StagingRefused {
  if (cause?.code === 'ENOSPC') return driveFull(null, null, cause)
  if (cause?.code === 'EFBIG') return refused({ code: 'UPD-FILE-TOO-BIG-FOR-DRIVE', params: {} }, cause)
  return cantWrite(null, cause)
}

// ---- which entry a name is, and whether it is a real folder (§4.5 "Links under updates/")

type Found =
  | { readonly kind: 'absent' }
  | { readonly kind: 'entry'; readonly name: string }
  | { readonly kind: 'unknown'; readonly cause: ImportIoCause | null }

type FolderTest = { readonly kind: 'real' } | { readonly kind: 'not-real' } | { readonly kind: 'unknown'; readonly cause: ImportIoCause | null }

/** What one call of a step has learned of the disk: the drive root's realpath (null: it failed, with why). */
interface Memo {
  realRoot?: string | null
  rootCause?: ImportIoCause
  /** One buffer for the sweep's staged.json reads (they run one at a time). */
  markerBuffer?: Buffer
}

/** The entry of `names` (the listing of `parent`) that is `asked`: spelled so, else the one fold-equal entry, and that one
 *  only when an lstat of the asked name finds it; an lstat that finds what the listing does not show proves nothing. */
async function entryOf(ctx: StagingContext, parent: string, names: readonly string[], asked: string): Promise<Found> {
  if (names.includes(asked)) return { kind: 'entry', name: asked }
  const folded = foldMemberName(asked)
  const candidates = names.filter((name) => foldMemberName(name) === folded)
  try {
    await ctx.fs.lstat(join(parent, asked))
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown', cause: causeOf(error) }
  }
  return candidates.length === 1 ? { kind: 'entry', name: candidates[0]! } : { kind: 'unknown', cause: null }
}

/** `asked` in `parent`, by listing it (a parent that is not there holds nothing). */
async function findIn(ctx: StagingContext, parent: string, asked: string): Promise<Found> {
  let names: string[]
  try {
    names = await ctx.fs.readdir(parent)
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown', cause: causeOf(error) }
  }
  return entryOf(ctx, parent, names, asked)
}

/**
 * The awaited form of workspace-vault.ts's `folderContainment(root, folder)`: every name from the drive root down to
 * `folder` is a folder by lstat (never a link), and the native realpath of `folder` is the root's with the same names
 * below it. `real` (inside), `not-real` (outside: a link on the way, a junction lstat reads as a folder, a folder that
 * resolves elsewhere), or `unknown` (a stat or a realpath that failed: a test that proves nothing).
 */
async function containmentOf(ctx: StagingContext, folder: string, memo: Memo): Promise<FolderTest> {
  const rel = relative(ctx.root, folder)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { kind: 'not-real' }
  let dir = ctx.root
  for (const part of rel === '' ? [] : rel.split(sep)) {
    dir = join(dir, part)
    let info: StagingStats
    try {
      info = await ctx.fs.lstat(dir)
    } catch (error) {
      return { kind: 'unknown', cause: causeOf(error) }
    }
    if (!info.isDirectory()) return { kind: 'not-real' }
  }
  if (memo.realRoot === undefined) {
    try {
      memo.realRoot = await ctx.fs.realpath(ctx.root)
    } catch (error) {
      memo.realRoot = null
      memo.rootCause = causeOf(error)
    }
  }
  if (memo.realRoot === null) return { kind: 'unknown', cause: memo.rootCause ?? null }
  let real: string
  try {
    real = await ctx.fs.realpath(folder)
  } catch (error) {
    return { kind: 'unknown', cause: causeOf(error) }
  }
  return pathKey(real) === pathKey(join(memo.realRoot, rel)) ? { kind: 'real' } : { kind: 'not-real' }
}

/** Whether the entry at `path` is a real folder: a folder by lstat (a link, a plain file or anything else is none), found
 *  where its path says. */
async function testFolder(ctx: StagingContext, path: string, memo: Memo): Promise<FolderTest> {
  let info: StagingStats
  try {
    info = await ctx.fs.lstat(path)
  } catch (error) {
    return { kind: 'unknown', cause: causeOf(error) }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return { kind: 'not-real' }
  return containmentOf(ctx, path, memo)
}

// ---- the removal walk (§4.5 "Every removal")

/** A removal that did not end: the top is not a real folder or its test proved nothing (either way left as it is), or a
 *  call failed. */
export interface RemovalFailure {
  /** The top is not a real folder (a link, a folder found elsewhere, anything else at the name). */
  readonly link: boolean
  /** The top's own test proved nothing (its lstat or its real-folder test failed other than with ENOENT). */
  readonly unproven: boolean
  readonly cause: ImportIoCause | null
}

/** A sub-folder whose real-folder test proved nothing: the walk ends there, with that test's cause. */
class Unproven {
  readonly cause: ImportIoCause | null
  constructor(cause: ImportIoCause | null) {
    this.cause = cause
  }
}

/** Every entry of the real folder `dir` by lstat, then `dir` itself; a link removed by its name and never entered. */
async function walkRemove(ctx: StagingContext, dir: string, retry: boolean, memo: Memo): Promise<void> {
  const names = await ctx.fs.readdir(dir)
  for (const name of names) {
    await nextTurn()
    const entry = join(dir, name)
    let info: StagingStats
    try {
      info = await ctx.fs.lstat(entry)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) await removeCall(ctx, retry, () => ctx.fs.unlink(entry))
    else if (info.isDirectory()) {
      const at = await containmentOf(ctx, entry, memo)
      if (at.kind === 'real') await walkRemove(ctx, entry, retry, memo)
      // A junction lstat reads as a folder: one rmdir removes the link alone (a real folder there would fail, never be entered).
      else if (at.kind === 'not-real') await removeCall(ctx, retry, () => ctx.fs.rmdir(entry))
      else throw new Unproven(at.cause)
    } else await removeCall(ctx, retry, () => ctx.fs.unlink(entry))
  }
  await removeCall(ctx, retry, () => ctx.fs.rmdir(dir))
}

/**
 * Removes the folder at `path`, a `<w>/` or an `.incoming-<w>/` release 1 made under `updates/staging/`: its
 * `staged.json` first when there is one (a cut removal never leaves a valid one), then the walk. Null when it is gone (or
 * was never there); a failure when the name is not a real folder or its test proves nothing (both left as they are), or
 * a call failed. `retry`: on Windows,
 * removeRetry's budget per call (the data pass, the commit, the discard); the start step's removals take none.
 */
async function removeFolderTree(ctx: StagingContext, path: string, retry: boolean, memo: Memo): Promise<RemovalFailure | null> {
  try {
    await ctx.fs.lstat(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    return { link: false, unproven: true, cause: causeOf(error) }
  }
  const test = await testFolder(ctx, path, memo)
  if (test.kind === 'not-real') return { link: true, unproven: false, cause: null }
  if (test.kind === 'unknown') return { link: false, unproven: true, cause: test.cause }
  try {
    const marker = join(path, STAGED_JSON)
    let info: StagingStats | null
    try {
      info = await ctx.fs.lstat(marker)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
      info = null
    }
    if (info !== null && (info.isSymbolicLink() || !info.isDirectory())) await removeCall(ctx, retry, () => ctx.fs.unlink(marker))
    await walkRemove(ctx, path, retry, memo)
    return null
  } catch (error) {
    return { link: false, unproven: false, cause: error instanceof Unproven ? error.cause : causeOf(error) }
  }
}

// ---- before the file dialog (§4.5's order; §3.6 items 3 and 4; table A.1)

/** The drive's update folders as the checks before the dialog found them. */
export interface UpdatesDrive {
  /** `updates/`, under the name the listing gave (a real folder). */
  readonly updatesDir: string
  /** `updates/staging/` under the name the listing gave, or where the data pass will make it. */
  readonly stagingDir: string
  /** Whether `updates/staging/` existed (then a real folder). */
  readonly stagingFound: boolean
}

/** The free bytes statfs reports for `path` (a bsize of 0 counts as 1 MiB clusters), with the cluster; null when it fails. */
async function freeSpaceOf(ctx: StagingContext, path: string): Promise<{ free: number; cluster: number } | null> {
  let info: { bsize: number; bavail: number }
  try {
    info = await ctx.fs.statfs(path)
  } catch {
    return null
  }
  const cluster = info.bsize > 0 ? info.bsize : ZERO_BSIZE_CLUSTER_BYTES
  return { free: Math.min(Number(info.bavail) * cluster, Number.MAX_SAFE_INTEGER), cluster }
}

/** `updates/` under the drive root, found by the listing rule, or made with one plain mkdir; then a real folder. */
async function findOrMakeUpdates(ctx: StagingContext, memo: Memo): Promise<{ readonly dir: string } | StagingRefused> {
  const tested = async (dir: string): Promise<{ readonly dir: string } | StagingRefused> => {
    const test = await testFolder(ctx, dir, memo)
    return test.kind === 'real' ? { dir } : cantWrite('updates', test.kind === 'unknown' ? test.cause : null)
  }
  const found = await findIn(ctx, ctx.root, UPDATES_FOLDER)
  if (found.kind === 'unknown') return cantWrite('updates', found.cause)
  if (found.kind === 'entry') return tested(join(ctx.root, found.name))
  const dir = join(ctx.root, UPDATES_FOLDER)
  try {
    await ctx.fs.mkdir(dir)
  } catch (error) {
    const cause = causeOf(error)
    if (cause.code === 'ENOSPC') return driveFull(null, null, cause)
    if (cause.code !== 'EEXIST') return readOnly(cause)
    // Something appeared between the listing and the mkdir: the listing runs again, once.
    const again = await findIn(ctx, ctx.root, UPDATES_FOLDER)
    if (again.kind === 'entry') return tested(join(ctx.root, again.name))
    return cantWrite('updates', again.kind === 'unknown' && again.cause !== null ? again.cause : cause)
  }
  return tested(dir)
}

/** Table A.1's probe at `updates/.write-probe`: null when the drive takes a write, else its refusal. */
async function probeDrive(ctx: StagingContext, updatesDir: string): Promise<StagingRefused | null> {
  const name = join(updatesDir, PROBE_NAME)
  const failed = (error: unknown): StagingRefused => {
    const cause = causeOf(error)
    if (cause.code === 'EEXIST' || cause.code === 'ENOTEMPTY') return cantWrite('probe', cause)
    if (cause.code === 'ENOSPC') return driveFull(null, null, cause)
    return readOnly(cause)
  }
  // A file or a link at the name removed by its name, a folder by one rmdir (an empty folder, or a junction lstat reads
  // as one), never followed; nothing there (ENOENT) is no failure.
  try {
    await asMovesAre(ctx, async () => {
      let info: StagingStats
      try {
        info = await ctx.fs.lstat(name)
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return
        throw error
      }
      try {
        if (info.isDirectory() && !info.isSymbolicLink()) await ctx.fs.rmdir(name)
        else await ctx.fs.unlink(name)
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
      }
    })
  } catch (error) {
    return failed(error)
  }
  let handle: StagingFileHandle
  try {
    handle = await asMovesAre(ctx, () => ctx.fs.open(name, 'wx'))
  } catch (error) {
    return failed(error)
  }
  let failure: StagingRefused | null = null
  try {
    const { bytesWritten } = await handle.write(PROBE_BYTE, 0, PROBE_BYTE.length)
    if (bytesWritten !== PROBE_BYTE.length) failure = readOnly(null)
  } catch (error) {
    failure = failed(error)
  }
  try {
    await handle.close()
  } catch (error) {
    failure ??= failed(error)
  }
  try {
    await asMovesAre(ctx, () => ctx.fs.unlink(name))
  } catch {
    // Retried as the moves are, then ignored (§5.4): a scanner that holds the new file is no read-only drive.
  }
  return failure
}

/**
 * §4.5's order from `updates/` to the 64 MiB margin, before the file dialog opens: `updates/` (a missing one made with
 * one plain mkdir: EEXIST lists again once, ENOSPC is UPD-DRIVE-FULL with null parameters, any other failure
 * UPD-DRIVE-READ-ONLY), `updates/` and an existing `updates/staging/` real folders (else UPD-CANT-WRITE-DRIVE,
 * `link=updates` or `staging`), `updates/applying/` present (an lstat that does not answer ENOENT: UPD-IN-PROGRESS), the
 * probe (an occupied name UPD-CANT-WRITE-DRIVE `link=probe`, ENOSPC UPD-DRIVE-FULL, any other failure
 * UPD-DRIVE-READ-ONLY), and free bytes of at least 64 MiB (UPD-DRIVE-FULL with the margin and the free bytes; a statfs
 * that fails passes). Never throws.
 */
export async function checkDriveBeforeDialog(ctx: StagingContext): Promise<{ readonly kind: 'ready'; readonly drive: UpdatesDrive } | StagingRefused> {
  const memo: Memo = {}
  const updates = await findOrMakeUpdates(ctx, memo)
  if ('kind' in updates) return updates
  const updatesDir = updates.dir
  const staging = await findIn(ctx, updatesDir, STAGING_FOLDER)
  if (staging.kind === 'unknown') return cantWrite('staging', staging.cause)
  let stagingDir = join(updatesDir, STAGING_FOLDER)
  if (staging.kind === 'entry') {
    stagingDir = join(updatesDir, staging.name)
    const test = await testFolder(ctx, stagingDir, memo)
    if (test.kind !== 'real') return cantWrite('staging', test.kind === 'unknown' ? test.cause : null)
  }
  try {
    await ctx.fs.lstat(join(updatesDir, APPLYING_FOLDER))
    return inProgress()
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') return inProgress()
  }
  const probe = await probeDrive(ctx, updatesDir)
  if (probe !== null) return probe
  const space = await freeSpaceOf(ctx, updatesDir)
  if (space !== null && space.free < MARGIN_BYTES) return driveFull(MARGIN_BYTES, space.free)
  return { kind: 'ready', drive: { updatesDir, stagingDir, stagingFound: staging.kind === 'entry' } }
}

// ---- after the reader's checked answer (§4.5's order: the path length, the staging folders, free space)

/** A member the header walk found (the reader's `present`): its name and size. */
export interface PresentMember {
  readonly name: string
  readonly size: number
}

/** `updates/staging/<v>/` and `.incoming-<v>/` as the listing gave their names (null: not there). */
export interface StagingTargets {
  readonly versionName: string | null
  readonly incomingName: string | null
}

/** The bytes the regular files under the real folder `dir` hold, by lstat; a link, or a folder found elsewhere, counts
 *  0 bytes and is never entered (§4.5 "Free space"). */
async function heldBytes(ctx: StagingContext, dir: string, memo: Memo): Promise<number> {
  let names: string[]
  try {
    names = await ctx.fs.readdir(dir)
  } catch {
    return 0
  }
  let held = 0
  for (const name of names) {
    await nextTurn()
    const entry = join(dir, name)
    let info: StagingStats
    try {
      info = await ctx.fs.lstat(entry)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    if (info.isFile()) held += Number(info.size)
    else if (info.isDirectory() && (await containmentOf(ctx, entry, memo)).kind === 'real') held += await heldBytes(ctx, entry, memo)
  }
  return held
}

/**
 * The checks between the reader's `checked` answer and the old-file stop, in §4.5's order: on Windows the length of
 * `<root>updates\staging\<v>\files\` and the longest name among the members present at most 259 characters (else
 * UPD-PATH-TOO-LONG); `updates/staging/<v>/` and `.incoming-<v>/`, found by the listing rule (the folder-name fold),
 * real folders where they exist (else UPD-CANT-WRITE-DRIVE, `link=version` or `incoming`); then free bytes (statfs's,
 * plus what those two folders hold now, which the data pass removes first) of at least Σ ⌈size ÷ c⌉ × c over the members
 * present, plus c, plus max(64 MiB, 64 × the write size) (else UPD-DRIVE-FULL with both numbers; a statfs that fails
 * passes). Nothing is written. Never throws.
 */
export async function checkBeforeDataPass(
  ctx: StagingContext,
  drive: UpdatesDrive,
  update: { readonly version: string; readonly present: readonly PresentMember[] }
): Promise<{ readonly kind: 'ready'; readonly targets: StagingTargets } | StagingRefused> {
  const { version, present } = update
  if (ctx.platform === 'win32') {
    const rootText = /[\\/]$/.test(ctx.root) ? ctx.root : `${ctx.root}\\`
    const longest = present.reduce((most, member) => Math.max(most, member.name.length), 0)
    if (rootText.length + STAGING_PATH_HEAD_CHARS + version.length + STAGING_PATH_TAIL_CHARS + longest > WINDOWS_PATH_MAX_CHARS) {
      return refused({ code: 'UPD-PATH-TOO-LONG', params: {} })
    }
  }
  const memo: Memo = {}
  const names: Record<'version' | 'incoming', string | null> = { version: null, incoming: null }
  if (drive.stagingFound) {
    let listed: string[] = []
    try {
      listed = await ctx.fs.readdir(drive.stagingDir)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') return cantWrite('version', causeOf(error))
    }
    for (const [link, asked] of [['version', version], ['incoming', `${INCOMING_PREFIX}${version}`]] as const) {
      const found = await entryOf(ctx, drive.stagingDir, listed, asked)
      if (found.kind === 'unknown') return cantWrite(link, found.cause)
      if (found.kind === 'absent') continue
      const test = await testFolder(ctx, join(drive.stagingDir, found.name), memo)
      if (test.kind !== 'real') return cantWrite(link, test.kind === 'unknown' ? test.cause : null)
      names[link] = found.name
    }
  }
  const space = await freeSpaceOf(ctx, drive.updatesDir)
  if (space !== null) {
    const c = space.cluster
    let held = 0
    for (const name of [names.version, names.incoming]) if (name !== null) held += await heldBytes(ctx, join(drive.stagingDir, name), memo)
    const free = Math.min(space.free + held, Number.MAX_SAFE_INTEGER)
    const need = present.reduce((sum, member) => sum + Math.ceil(member.size / c) * c, 0) + c + Math.max(MARGIN_BYTES, RUN_AHEAD_WRITES * READ_SLICE_BYTES)
    if (free < need) return driveFull(Math.min(need, Number.MAX_SAFE_INTEGER), free)
  }
  return { kind: 'ready', targets: { versionName: names.version, incomingName: names.incoming } }
}

// ---- the data pass's start (§4.5 "The data pass starts")

/** The folders of one data pass: what the reader's `stage` writes into, and what the commit and a cleanup act on. */
export interface StagingFolders {
  readonly version: string
  readonly updatesDir: string
  readonly stagingDir: string
  /** `updates/staging/.incoming-<v>/`: the reader's `incomingDir`. */
  readonly incomingDir: string
  /** `updates/staging/<v>/`. */
  readonly versionDir: string
  /** `updates/staging/<v>/files/`: the reader's `filesDir`. */
  readonly filesDir: string
}

/** One plain mkdir of a folder staging makes, then the real-folder test before anything is written into it. On Windows
 *  the mkdir is tried again as the moves are while a held name refuses it (§4.5 "Moves": exFAT keeps a removed folder's
 *  name pending while another program holds it, so a re-import's mkdir right after its removal can answer EPERM for a
 *  moment; T6.9 lens 2 m-1); EEXIST answers at once, and each attempt stays one plain mkdir. */
async function makeFolder(ctx: StagingContext, path: string, link: StagingLinkName, memo: Memo): Promise<StagingRefused | null> {
  try {
    await asMovesAre(ctx, () => ctx.fs.mkdir(path))
  } catch (error) {
    const cause = causeOf(error)
    return cause.code === 'EEXIST' ? cantWrite(link, cause) : writeError(cause)
  }
  const test = await testFolder(ctx, path, memo)
  return test.kind === 'real' ? null : cantWrite(link, test.kind === 'unknown' ? test.cause : null)
}

/**
 * The data pass's start: `updates/staging/<v>/` and `.incoming-<v>/` (the names `checkBeforeDataPass` found) removed by
 * the removal walk, with Windows' retries; then `updates/staging/` made when it was missing, `.incoming-<v>/`, `<v>/` and
 * `<v>/files/`, each with one plain mkdir (on Windows tried again as the moves are) and tested. A failure answers as an
 * error while staging (§4.5), once both
 * folders are removed as far as they can be (a removal that failed was tried on both names; what a failed mkdir left is
 * removed by removeStagingFolders, which leaves a link it meets). Never throws.
 */
export async function startDataPass(
  ctx: StagingContext,
  drive: UpdatesDrive,
  targets: StagingTargets,
  version: string
): Promise<{ readonly kind: 'ready'; readonly folders: StagingFolders } | StagingRefused> {
  const memo: Memo = {}
  let removal: StagingRefused | null = null
  for (const [link, name] of [['version', targets.versionName], ['incoming', targets.incomingName]] as const) {
    if (name === null) continue
    const failure = await removeFolderTree(ctx, join(drive.stagingDir, name), true, memo)
    if (failure !== null) removal ??= failure.link ? cantWrite(link) : writeError(failure.cause)
  }
  if (removal !== null) return removal
  if (!drive.stagingFound) {
    const failure = await makeFolder(ctx, drive.stagingDir, 'staging', memo)
    if (failure !== null) return failure
  }
  const folders: StagingFolders = {
    version,
    updatesDir: drive.updatesDir,
    stagingDir: drive.stagingDir,
    incomingDir: join(drive.stagingDir, `${INCOMING_PREFIX}${version}`),
    versionDir: join(drive.stagingDir, version),
    filesDir: join(drive.stagingDir, version, FILES_FOLDER)
  }
  for (const [path, link] of [[folders.incomingDir, 'incoming'], [folders.versionDir, 'version'], [folders.filesDir, 'version']] as const) {
    const failure = await makeFolder(ctx, path, link, memo)
    if (failure === null) continue
    await removeStagingFolders(ctx, folders)
    return failure
  }
  return { kind: 'ready', folders }
}

/**
 * After a refusal or a cancel from the data pass on, or a refused commit (§4.5 "A refusal or a cancel from the data pass
 * on", "Errors while staging"): removes `.incoming-<v>/` and `<v>/` as far as it can, with Windows' retries. Null when
 * both are gone; else the first failure, for app.log. Never throws.
 */
export async function removeStagingFolders(ctx: StagingContext, folders: StagingFolders): Promise<RemovalFailure | null> {
  const memo: Memo = {}
  const incoming = await removeFolderTree(ctx, folders.incomingDir, true, memo)
  const version = await removeFolderTree(ctx, folders.versionDir, true, memo)
  return incoming ?? version
}

// ---- the commit (§4.5 "The commit"; §4.6, F-5)

/** `staged.txt` (§4.6): `<size> <name>` and LF per member present, in `files[]` order. */
const stagedTxtBytes = (files: readonly AcceptedFile[]): Buffer => Buffer.from(files.map((f) => `${f.size} ${f.name}\n`).join(''), 'latin1')

/** `staged.json` (§4.6 "The writer's bytes"): keys `format`, `version`, `files`; each entry's `name`, `size`, `sha256`,
 *  then `group` when the payload gave one; no whitespace, no line end, UTF-8 without a byte-order mark. */
const stagedJsonBytes = (version: string, files: readonly AcceptedFile[]): Buffer =>
  Buffer.from(
    JSON.stringify({
      format: 1,
      version,
      files: files.map((f) => (f.group === null ? { name: f.name, size: f.size, sha256: f.sha256 } : { name: f.name, size: f.size, sha256: f.sha256, group: f.group }))
    }),
    'utf8'
  )

/** A write that moved fewer bytes, which threw nothing. */
const SHORT_WRITE = Symbol('short write')

/** A folder opened for its fsync (macOS, Linux): read-only, with O_DIRECTORY (the open fails on anything that is no
 *  folder), O_NOFOLLOW (on a symbolic link at the name) and O_NONBLOCK (it never waits on a pipe), each where node:fs has
 *  it. */
const FOLDER_SYNC_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** One marker: to its `.tmp` name (whatever is there removed by its name first, a folder left; then `wx`), written,
 *  fsynced, closed, renamed into place; on macOS and Linux the folder fsynced after. Throws on any failure. */
async function writeMarker(ctx: StagingContext, dir: string, name: string, bytes: Uint8Array): Promise<void> {
  const tmp = join(dir, `${name}.tmp`)
  try {
    const info = await ctx.fs.lstat(tmp)
    if (info.isSymbolicLink() || !info.isDirectory()) await ctx.fs.unlink(tmp)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
  }
  const handle = await ctx.fs.open(tmp, 'wx')
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let written = 0; written < buffer.length; ) {
      const { bytesWritten } = await handle.write(buffer, written, buffer.length - written)
      if (!(bytesWritten > 0)) throw SHORT_WRITE
      written += bytesWritten
    }
    await handle.sync()
  } finally {
    await closeQuietly(handle)
  }
  await ctx.fs.rename(tmp, join(dir, name))
  // A folder's fsync is what the running system offers (Windows opens no folder for it), whatever rules `ctx` applies.
  if (process.platform !== 'win32') {
    const folder = await ctx.fs.open(dir, FOLDER_SYNC_FLAGS)
    try {
      await folder.sync()
    } finally {
      await closeQuietly(folder)
    }
  }
}

/**
 * The commit, once the reader staged every member present into `<v>/files/` (§4.5 "The commit", in the order that
 * leaves no staged update or exactly one that nothing marks): `<v>/` tested again first, its walk covering `updates/` and
 * `updates/staging/` (not a real folder: UPD-CANT-WRITE-DRIVE `link=version`, nothing written; the data pass ran for
 * minutes since its own test); every other real folder in `updates/staging/` removed (at most one staged update; a link,
 * a file, or an entry whose test proves nothing, such as a held lstat, is left, and the commit goes on: §4.5 "Links
 * under updates/"); the `cleared` line when `last-result.txt` marks `<v>` (last-result.ts; a failed append refuses
 * UPD-CANT-WRITE-DRIVE); `envelope` (member 0's bytes as verified) as `hilbertraum-release.dsse.json`, then `staged.txt`,
 * then, last, `staged.json` (F-5's bytes); then `.incoming-<v>/` removed (one that stays after its retries is left for the
 * next start's sweep: the update is staged). A refusal answers as an error while staging, for the caller to remove the
 * two folders. Never throws.
 */
export async function commitStaged(
  ctx: StagingContext,
  folders: StagingFolders,
  staged: { readonly envelope: Uint8Array; readonly files: readonly AcceptedFile[] }
): Promise<{ readonly kind: 'committed'; readonly cleared: boolean; readonly incomingLeft: RemovalFailure | null } | StagingRefused> {
  const memo: Memo = {}
  const target = await testFolder(ctx, folders.versionDir, memo)
  if (target.kind !== 'real') return cantWrite('version', target.kind === 'unknown' ? target.cause : null)
  let names: string[]
  try {
    names = await ctx.fs.readdir(folders.stagingDir)
  } catch (error) {
    return writeError(causeOf(error))
  }
  const own = new Set([basename(folders.versionDir), basename(folders.incomingDir)])
  for (const name of names) {
    if (own.has(name)) continue
    await nextTurn()
    const path = join(folders.stagingDir, name)
    let info: StagingStats
    try {
      info = await ctx.fs.lstat(path)
    } catch {
      continue // gone, or a stat that proves nothing (a held name): left as it is
    }
    if (info.isSymbolicLink() || !info.isDirectory()) continue
    const failure = await removeFolderTree(ctx, path, true, memo)
    if (failure !== null && !failure.link && !failure.unproven) return writeError(failure.cause)
  }
  const cleared = await clearMarkOf(folders.updatesDir, folders.version, ctx.fs, ctx.platform)
  if (cleared.kind === 'failed') return cantWrite(null, cleared.cause)
  try {
    await writeMarker(ctx, folders.versionDir, ENVELOPE_MEMBER_NAME, staged.envelope)
    await writeMarker(ctx, folders.versionDir, STAGED_TXT, stagedTxtBytes(staged.files))
    await writeMarker(ctx, folders.versionDir, STAGED_JSON, stagedJsonBytes(folders.version, staged.files))
  } catch (error) {
    return writeError(error === SHORT_WRITE ? null : causeOf(error))
  }
  const incomingLeft = await removeFolderTree(ctx, folders.incomingDir, true, memo)
  return { kind: 'committed', cleared: cleared.kind === 'cleared', incomingLeft }
}

// ---- staged.json (§4.6 "The read", "Valid")

type MarkerRead = { readonly kind: 'bytes'; readonly bytes: Buffer } | { readonly kind: 'no-marker' | 'invalid-marker' | 'unknown' }

/** §4.6's read: by lstat a regular file with one name of at most the cap, else not valid and never opened; opened
 *  read-only (O_NOFOLLOW, O_NONBLOCK on macOS and Linux), checked on its descriptor, read to one byte past the cap. */
async function readMarker(ctx: StagingContext, path: string, memo: Memo): Promise<MarkerRead> {
  let named: StagingStats
  try {
    named = await ctx.fs.lstat(path)
  } catch (error) {
    return { kind: codeOf(error) === 'ENOENT' ? 'no-marker' : 'unknown' }
  }
  if (named.isSymbolicLink() || !named.isFile() || named.nlink > 1n || named.size > BigInt(STAGED_JSON_MAX_BYTES)) return { kind: 'invalid-marker' }
  let handle: StagingFileHandle
  try {
    handle = await ctx.fs.open(path, constants.O_RDONLY | posixFlags(ctx.platform))
  } catch (error) {
    return { kind: codeOf(error) === 'ENOENT' ? 'no-marker' : 'unknown' }
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink > 1n || opened.ino !== named.ino || opened.dev !== named.dev) return { kind: 'invalid-marker' }
    const buffer = (memo.markerBuffer ??= Buffer.allocUnsafe(STAGED_JSON_MAX_BYTES + 1))
    let got = 0
    while (got < buffer.length) {
      const { bytesRead } = await handle.read(buffer, got, buffer.length - got, got)
      if (!(bytesRead > 0)) break
      got += bytesRead
    }
    if (got > STAGED_JSON_MAX_BYTES) return { kind: 'invalid-marker' }
    return { kind: 'bytes', bytes: Buffer.from(buffer.subarray(0, got)) }
  } catch {
    return { kind: 'unknown' }
  } finally {
    await closeQuietly(handle)
  }
}

/** An own property of a parsed object. */
const own = (object: object, key: string): unknown => (Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined)

/**
 * §4.6 "Valid": `format` `=== 1`; `version` a SemVer string of at most 64 bytes equal byte for byte to the folder's name
 * as the listing gave it; `files` an array of at least one object, each with a `name` that keeps the member-name rule
 * (member-name.ts, F-18), a safe-integer `size` from 0 to 8,589,934,591, a `sha256` of 64 lower-case hex characters, and
 * a `group` absent or a string of at least one character; no two names equal after the fold. The listed members, or null.
 */
function validMarker(bytes: Buffer, folderName: string): ReadonlyArray<{ readonly name: string; readonly size: number }> | null {
  const doc = readJsonObject(bytes)
  if (doc === null || own(doc, 'format') !== 1) return null
  const version = own(doc, 'version')
  if (typeof version !== 'string' || Buffer.byteLength(version, 'utf8') > VERSION_MAX_BYTES || parseSemver(version) === null || version !== folderName) return null
  const files = own(doc, 'files')
  if (!Array.isArray(files) || files.length === 0) return null
  const listed: Array<{ name: string; size: number }> = []
  for (const entry of files as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const name = own(entry, 'name')
    const size = own(entry, 'size')
    const hash = own(entry, 'sha256')
    if (!isMemberName(name)) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MEMBER_MAX_SIZE) return null
    if (typeof hash !== 'string' || !SHA256_LOWER_HEX.test(hash)) return null
    if (Object.hasOwn(entry, 'group')) {
      const group = own(entry, 'group')
      if (typeof group !== 'string' || group.length === 0) return null
    }
    listed.push({ name, size })
  }
  return hasFoldedDuplicate(listed.map((f) => f.name)) ? null : listed
}

// ---- the start-up sweep (§4.5 "The start step" (3)-(5), "The start-up sweep")

interface SweepRemoval {
  readonly path: string
  readonly reason: SweepReason
  readonly folder: boolean
}

/** The sweep's reads and decisions (SweepFacts), and the removals it decided, for carryOutSweep. */
export interface SweepPlan extends SweepFacts {
  readonly removals: readonly SweepRemoval[]
}

/** What one `<w>/` with a `staged.json` is (§4.5 "The start-up sweep"): a survivor, a reason, or unknown (left). An
 *  ENOENT that would decide a removal (`no-marker`, `member-missing`) is confirmed by one more real-folder test of `<w>/`
 *  (a drive that drops out answers ENOENT too): when that test fails or proves nothing, the entry is unknown (T6.9 lens 2
 *  m-6). */
async function judgeStaged(ctx: StagingContext, dir: string, name: string, memo: Memo): Promise<'valid' | 'no-marker' | 'invalid-marker' | 'member-missing' | 'unknown'> {
  const confirmed = async (reason: 'no-marker' | 'member-missing'): Promise<'no-marker' | 'member-missing' | 'unknown'> =>
    (await testFolder(ctx, dir, memo)).kind === 'real' ? reason : 'unknown'
  const read = await readMarker(ctx, join(dir, STAGED_JSON), memo)
  // readMarker answers no-marker for an ENOENT only (of the lstat or of the open).
  if (read.kind === 'no-marker') return confirmed('no-marker')
  if (read.kind !== 'bytes') return read.kind
  const listed = validMarker(read.bytes, name)
  if (listed === null) return 'invalid-marker'
  const files = join(dir, FILES_FOLDER)
  const test = await testFolder(ctx, files, memo)
  if (test.kind === 'unknown') return test.cause?.code === 'ENOENT' ? confirmed('member-missing') : 'unknown'
  if (test.kind === 'not-real') return 'member-missing'
  for (const member of listed) {
    await nextTurn()
    let info: StagingStats
    try {
      info = await ctx.fs.lstat(join(files, member.name))
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return confirmed('member-missing')
      return 'unknown'
    }
    if (!info.isFile() || info.size !== BigInt(member.size)) return 'member-missing'
  }
  return 'valid'
}

const noCounts = (): Record<SweepReason, number> => ({ incoming: 0, 'no-marker': 0, 'invalid-marker': 0, 'member-missing': 0, 'not-a-folder': 0, link: 0 })

/**
 * The start-up sweep's reads and decisions, once the start step's synchronous part found `updates/` (`updatesDir`, under
 * the name the listing gave) a real folder and `updates/applying/` absent; never while `updates/applying/` exists (an
 * lstat that does not answer ENOENT: nothing swept, nothing staged). Each entry of `updates/staging/`, by lstat: a
 * link (or a folder found elsewhere) is left (`link`); neither a folder nor a link is unlinked (`not-a-folder`); an
 * `.incoming-*` folder is removed (`incoming`); a `<w>/` without `staged.json`, with one that is not valid, or with a
 * listed file under `files/` missing, of another size or no regular file, is removed (`no-marker`, `invalid-marker`,
 * `member-missing`, which sets the one-time notice; an ENOENT that decides one of these two only once a further test
 * finds `<w>/` still a real folder); a stat, a read or a real-folder test that proves nothing leaves the entry, counted
 * under no reason. `updates/staging/` not a real folder: nothing is swept (`link`, 1). The staged update
 * is the highest survivor in F-4's order. Reads only; never throws.
 */
export async function planSweep(ctx: StagingContext, updatesDir: string): Promise<SweepPlan> {
  const counts = noCounts()
  const removals: SweepRemoval[] = []
  const nothing = (): SweepPlan => ({ counts, staged: null, notice: null, removals })
  const memo: Memo = {}
  // Never while updates/applying/ exists (the apply moves members out of staging): the start step's (2) decides that
  // first; the sweep keeps the rule itself, so an apply begun meanwhile is never swept from under.
  try {
    await ctx.fs.lstat(join(updatesDir, APPLYING_FOLDER))
    return nothing()
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') return nothing()
  }
  const found = await findIn(ctx, updatesDir, STAGING_FOLDER)
  if (found.kind !== 'entry') return nothing()
  const stagingDir = join(updatesDir, found.name)
  const test = await testFolder(ctx, stagingDir, memo)
  if (test.kind === 'not-real') counts.link = 1
  if (test.kind !== 'real') return nothing()
  let names: string[]
  try {
    names = await ctx.fs.readdir(stagingDir)
  } catch {
    return nothing()
  }
  const survivors: string[] = []
  const decide = (reason: SweepReason, path: string, folder: boolean): void => {
    counts[reason]++
    removals.push({ path, reason, folder })
  }
  for (const name of names) {
    await nextTurn()
    const path = join(stagingDir, name)
    let info: StagingStats
    try {
      info = await ctx.fs.lstat(path)
    } catch {
      continue // gone, or a stat that proves nothing: left for this start
    }
    if (info.isSymbolicLink()) {
      counts.link++
      continue
    }
    if (!info.isDirectory()) {
      decide('not-a-folder', path, false)
      continue
    }
    const at = await containmentOf(ctx, path, memo)
    if (at.kind === 'not-real') counts.link++
    if (at.kind !== 'real') continue
    if (name.startsWith(INCOMING_PREFIX)) {
      decide('incoming', path, true)
      continue
    }
    const judged = await judgeStaged(ctx, path, name, memo)
    if (judged === 'valid') survivors.push(name)
    else if (judged !== 'unknown') decide(judged, path, true)
  }
  let staged: string | null = null
  for (const version of survivors) if (staged === null || compareSemver(parseSemver(version)!, parseSemver(staged)!) > 0) staged = version
  const notice: DamagedOnDriveNotice | null = counts['member-missing'] > 0 ? { code: 'UPD-FILE-DAMAGED-ON-DRIVE', params: {} } : null
  return { counts, staged: staged === null ? null : { version: staged }, notice, removals }
}

/**
 * The removals the sweep decided, with no retry (a held entry is left for the next start, which decides the same), each
 * by the removal walk or, for a stray file, by its name; a turn of the event loop between entries. Answers the removals
 * that failed, for app.log (never update.log). Never throws.
 */
export async function carryOutSweep(ctx: StagingContext, plan: SweepPlan): Promise<SweepRemovalFailure[]> {
  const memo: Memo = {}
  const failures: SweepRemovalFailure[] = []
  for (const removal of plan.removals) {
    await nextTurn()
    if (removal.folder) {
      const failure = await removeFolderTree(ctx, removal.path, false, memo)
      if (failure !== null) failures.push({ reason: removal.reason, cause: failure.cause })
      continue
    }
    try {
      await removeCall(ctx, false, () => ctx.fs.unlink(removal.path))
    } catch (error) {
      failures.push({ reason: removal.reason, cause: causeOf(error) })
    }
  }
  return failures
}

/** The `staging-swept` lines' fields (§4.5's events), one per reason that counted an entry, in the record's order. */
export function sweptLogFields(facts: SweepFacts): UpdateLogField[][] {
  return SWEEP_REASONS.filter((reason) => facts.counts[reason] > 0).map((reason): UpdateLogField[] => [
    ['n', String(facts.counts[reason])],
    ['reason', reason],
    ...(reason === 'member-missing' ? ([['code', 'UPD-FILE-DAMAGED-ON-DRIVE']] as UpdateLogField[]) : [])
  ])
}

// ---- "Don't install this update" (§3.5 updates:discardStaged, §4.5)

/** The request's own string `version`, or null (a junk argument): compared byte for byte, never used to build a path.
 *  The update service reads it once and hands the discard `{ version }` or null. */
export function requestedVersion(request: unknown): string | null {
  try {
    if (typeof request !== 'object' || request === null || !Object.hasOwn(request, 'version')) return null
    const version = (request as Record<string, unknown>).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * The discard's drive half, once the service has answered a root that is no prepared drive, a run going and P7's
 * older-than-drive start: `updates/applying/` present (one lstat, as status reads it; nothing is read under an
 * `updates/` that is not a real folder) → UPD-IN-PROGRESS; no staged update of the requested version (`staged`: the
 * service's, from the sweep and this process's commits and discards) → `not-staged`; else that version's
 * `updates/staging/<v>/` removed by the removal walk, its `staged.json` first, with Windows' retries → `discarded`; a
 * removal that fails, or a link at the name → UPD-CANT-WRITE-DRIVE. Never throws.
 */
export async function discardStaged(ctx: StagingContext, staged: { readonly version: string } | null, request: unknown): Promise<DiscardEnd> {
  const notStaged: DiscardEnd = { kind: 'not-staged' }
  const cantWriteDrive = (cause: ImportIoCause | null): DiscardEnd => ({ kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause })
  const memo: Memo = {}
  const updates = await findIn(ctx, ctx.root, UPDATES_FOLDER)
  if (updates.kind !== 'entry') return notStaged
  const updatesDir = join(ctx.root, updates.name)
  if ((await testFolder(ctx, updatesDir, memo)).kind !== 'real') return notStaged
  try {
    await ctx.fs.lstat(join(updatesDir, APPLYING_FOLDER))
    return { kind: 'refused', refusal: { code: 'UPD-IN-PROGRESS', params: {} }, cause: null }
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') return { kind: 'refused', refusal: { code: 'UPD-IN-PROGRESS', params: {} }, cause: null }
  }
  if (staged === null || requestedVersion(request) !== staged.version) return notStaged
  const staging = await findIn(ctx, updatesDir, STAGING_FOLDER)
  if (staging.kind === 'absent') return notStaged
  if (staging.kind === 'unknown') return cantWriteDrive(staging.cause)
  const stagingDir = join(updatesDir, staging.name)
  const test = await testFolder(ctx, stagingDir, memo)
  if (test.kind !== 'real') return cantWriteDrive(test.kind === 'unknown' ? test.cause : null)
  const entry = await findIn(ctx, stagingDir, staged.version)
  if (entry.kind === 'absent') return notStaged
  if (entry.kind === 'unknown') return cantWriteDrive(entry.cause)
  const failure = await removeFolderTree(ctx, join(stagingDir, entry.name), true, memo)
  return failure === null ? { kind: 'discarded', version: staged.version } : cantWriteDrive(failure.cause)
}

/** The `staging-discarded` line's fields (§4.5's events): the discarded folder's version (data-fed, its staged.json's). */
export function discardedLogFields(version: string): UpdateLogField[] {
  return [['version', logVersion(version)]]
}

// ---- update.log's version (§4.5 "What the formatter writes")

/** A version as an import line's caller passes it (§4.5): as it is up to V's 24 bytes, else the sentinel `unknown` (a
 *  valid version of 25 to 64 bytes; the formatter drops anything that fails V). */
export function logVersion(version: string): string {
  return Buffer.byteLength(version, 'utf8') <= LOG_VERSION_MAX_BYTES ? version : 'unknown'
}
