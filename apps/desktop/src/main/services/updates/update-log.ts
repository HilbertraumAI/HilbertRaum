import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateRuntimeSources, type RuntimeFamily } from '../../../shared/runtime-sources'
import type { BackendStartFailure } from '../../../shared/types'
import { bareSyscall } from '../failure-for-log'
import { log } from '../logging'
import type { ResolvedPaths } from '../workspace'
import { folderContainment, openWriteTemp, sameShreddableFile } from '../workspace-vault'
import { readDriveRelease, type DriveReleaseRead } from './drive-release'
import { parseSemver } from './version'

// `<drive>/updates/update.log`: the plaintext support log on the drive (app-update plan W-14, W-68; F-11, frozen;
// docs/app-updates.md 8.2 and 5.3 table B.2). Release 1's app, its start files, the apply scripts and every later version
// append to this one file for ever, and support reads it before any unlock, so it is content-free by its grammar: a
// line is `r1-app <os> <event> <key>=<value> ... t=<UTC time>`, every value 1 to 64 bytes of [0-9A-Za-z._+-], so no
// path, host, user name, message or free text can pass. An error is logged only by its code and its bare system call
// (P3 entry decision 3), never by a message. The golden: tests/fixtures/readers/f11-update-log/.
//
// What this module writes (P3 entry decision 9 (c)):
// - `startup`, once per start of a prepared drive (main/index.ts `initBackend`): the app version, the engine pins of the
//   app's own bundled runtime-sources.yaml, the drive-release record's state (T3.3a's reader, F-13: this line is where
//   its "is logged" happens), config/drive.json's drive_format_version and the SQLite version (W-68);
// - `start-failed`, in the start runner's catch (main/backend-start.ts): the failure's cause, code and system call;
// - any later event (the unlock line of T3.10, P6's and P7's events) through `appendUpdateLogLine`, which checks every
//   key and value again.
//
// Where and how (decision 9 (a), (b)): only on a prepared drive (`config/drive.json` there); never through a link
// (`updates` must be a real folder at its name, `update.log` absent or a regular file with one name, opened once and
// checked on its descriptor); one write of LF, the line, LF (record 5.1 G0: a torn earlier append never joins it); a
// size cap with a trim that only the app makes. A skip or a failure is swallowed, counted and reported in app.log by a
// fixed reason and the error's code; nothing here ever throws to its caller, so a read-only or full drive never stops
// a start.

/** The app's writer token (record 5.3). A later app writes its own; release 1 never reads writer tokens. */
const WRITER = 'r1-app'
const UPDATES_DIR = 'updates'
const LOG_NAME = 'update.log'
/** The only folder whose presence stops a trim: an apply may be appending (record 5.2). */
const APPLYING_DIR = 'applying'

/** A line's bytes, without its two LFs (record 5.1 G0: a writer's line is at most 256 bytes). */
const LINE_MAX_BYTES = 256
/** The size cap (the T3.2 sheet's Q9): over it, an app append trims the file to its newest KEEP_BYTES. The whole file
 *  then fits the 65,536-byte window every reader takes from an append-only file (G0), and the kept part still holds
 *  more than 120 lines of the longest kind. */
const MAX_BYTES = 65_536
const KEEP_BYTES = 32_768

/** The largest config/drive.json read for the line (the sheet's (a)); larger is `unreadable`. */
const DRIVE_JSON_MAX_BYTES = 65_536
/** The largest bundled runtime-sources.yaml read for the line (the app's own copy is ~19 KB). */
const RUNTIME_SOURCES_MAX_BYTES = 1_048_576

const OS_TOKEN = /^[a-z0-9]{1,8}$/
const EVENT = /^[a-z][a-z0-9-]{0,31}$/
const KEY = /^[a-z][a-z0-9_]{0,31}$/
const VALUE = /^[0-9A-Za-z._+-]{1,64}$/
/** The writer's own time key: never a caller's field. */
const TIME_KEY = 't'
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
/** A version in this log (V): SemVer 2.0.0 (T3.1's parse), at most 24 bytes. */
const VERSION_MAX_BYTES = 24
/** An engine pin (P), which must also hold a digit: so the sentinels, which hold none, never pass as one. */
const PIN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,15}$/
const DIGIT = /[0-9]/
/** An integer (I). */
const INTEGER = /^[0-9]{1,6}$/
/** The SQLite version (S). */
const SQLITE_VERSION = /^[0-9]{1,3}(\.[0-9]{1,3}){2,3}$/
/** An error code (E): an errno code, a Node code, or SQLite's result code as the start failure spells it. */
const ERROR_CODE = /^(?:E[A-Z0-9]{1,30}|ERR_[A-Z0-9_]{1,36}|SQLITE_[0-9]{1,5})$/
const ERROR_CODE_MAX_BYTES = 40
/** A bare system call (C), at most 16 bytes. */
const SYSCALL_MAX_BYTES = 16
const CAUSES: ReadonlySet<string> = new Set(['drive_not_writable', 'drive_full', 'other'])

/** The engine families whose pins the startup line carries, with their keys (`ocr` is no engine). */
const PIN_FIELDS: ReadonlyArray<readonly [RuntimeFamily, string]> = [
  ['llama_cpp', 'llama'],
  ['whisper_cpp', 'whisper'],
  ['kiwix_tools', 'kiwix']
]

/** One `key=value` field. */
export type UpdateLogField = readonly [key: string, value: string]

/** A source file as the startup line reads it: not there, there but not readable now, or its text. */
export type TextRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'text'; text: string }

/** What the startup line is made of, read before it is formatted. */
export interface StartupFacts {
  /** `app.getVersion()`. */
  appVersion: unknown
  /** The app's own bundled `runtime-sources.yaml` (#842), never the drive's or an override. */
  runtimeSources: TextRead
  /** T3.3a's reader on `config/drive-release.json`. */
  driveRelease: DriveReleaseRead
  /** `config/drive.json`. */
  driveJson: TextRead
  /** `process.versions.sqlite`. */
  sqlite: unknown
}

/** What the failed-start line is made of. */
export interface StartFailedFacts {
  /** The app version the start runner was handed (the startup line may never have been written). */
  appVersion: unknown
  /** What the runner hands the gate (`startFailureFrom`): its cause and code. */
  failure: BackendStartFailure
  /** What the start threw: only its bare system call is read, and under `try`. */
  thrown: unknown
}

/** The drive the line goes to. */
export type UpdateLogPaths = Pick<ResolvedPaths, 'rootPath' | 'isPreparedDrive'>

/** Why a line was not written (app.log only; not part of F-11). */
type SkipReason = 'link' | 'not-a-folder' | 'not-a-file' | 'folder-unknown' | 'write-failed' | 'invalid-line'

/** A refusal or a failure of one append: its reason, and the error behind it (read only for its code). */
class Skip extends Error {
  readonly reason: SkipReason
  readonly failure: unknown
  constructor(reason: SkipReason, failure?: unknown) {
    super(reason)
    this.reason = reason
    this.failure = failure
  }
}

let skipped = 0
let trimsFailed = 0

/** The code of a failed call, when it passes E: never the message, which names the path. Never throws. */
function errorCode(err: unknown): string | null {
  try {
    const code = (err as { code?: unknown } | null)?.code
    return typeof code === 'string' && code.length <= ERROR_CODE_MAX_BYTES && ERROR_CODE.test(code) ? code : null
  } catch {
    return null
  }
}

/** The bare system call of a failed call, when it passes C. Never throws (a getter may). */
function systemCall(err: unknown): string | null {
  try {
    const call = bareSyscall((err as { syscall?: unknown } | null)?.syscall)
    return call !== null && call.length <= SYSCALL_MAX_BYTES ? call : null
  } catch {
    return null
  }
}

function reportSkip(event: string, reason: SkipReason, err?: unknown): void {
  skipped++
  try {
    log.warn('Update log: line skipped', {
      event: EVENT.test(event) ? event : null,
      reason,
      code: errorCode(err),
      syscall: systemCall(err),
      skipped
    })
  } catch {
    /* the log is best-effort too */
  }
}

function reportTrimFailure(err: unknown): void {
  trimsFailed++
  try {
    log.warn('Update log: trim failed, tried again at the next line', {
      code: errorCode(err),
      syscall: systemCall(err),
      trimsFailed
    })
  } catch {
    /* the log is best-effort too */
  }
}

/** `t=`'s value: the UTC time to the second, the milliseconds dropped (never rounded); null when it fails its rule. */
function timeToken(now: Date): string | null {
  try {
    const time = `${now.toISOString().slice(0, 19)}Z`
    return TIME.test(time) ? time : null
  } catch {
    return null // an invalid date
  }
}

/**
 * The one formatter every app line goes through: `r1-app <os> <event> <fields> t=<time>`. Every key and value is checked
 * again (a field that fails is dropped, as is a second field of one key and a caller's `t`); the time is omitted when it
 * fails its rule. Null, no line at all, for an event that fails its rule or a line that would still exceed 256 bytes.
 */
export function formatUpdateLogLine(
  event: string,
  fields: readonly UpdateLogField[],
  ctx: { platform: string; now: Date }
): string | null {
  if (typeof event !== 'string' || !EVENT.test(event)) return null
  const tokens = [WRITER, typeof ctx.platform === 'string' && OS_TOKEN.test(ctx.platform) ? ctx.platform : 'unknown', event]
  const seen = new Set<string>()
  for (const [key, value] of fields) {
    if (typeof key !== 'string' || typeof value !== 'string') continue
    if (!KEY.test(key) || key === TIME_KEY || seen.has(key) || !VALUE.test(value)) continue
    seen.add(key)
    tokens.push(`${key}=${value}`)
  }
  const time = timeToken(ctx.now)
  if (time !== null) tokens.push(`${TIME_KEY}=${time}`)
  const line = tokens.join(' ')
  return line.length <= LINE_MAX_BYTES ? line : null // ASCII only, so its length in characters is its length in bytes
}

/** V: a SemVer 2.0.0 string of at most 24 bytes (parseSemver takes ASCII only). */
function isLogVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= VERSION_MAX_BYTES && parseSemver(value) !== null
}

/** The three pins from the bundled yaml, or the sentinel each gets. */
function enginePins(read: TextRead): (family: RuntimeFamily) => string {
  if (read.kind === 'absent') return () => 'absent'
  if (read.kind === 'unreadable') return () => 'unreadable'
  let families: Partial<Record<RuntimeFamily, { version: unknown }>>
  try {
    const result = validateRuntimeSources(parseYaml(read.text))
    if (!result.ok) return () => 'unreadable'
    families = result.families ?? {}
  } catch {
    return () => 'unreadable' // not YAML
  }
  return (family) => {
    const block = families[family]
    if (block === undefined) return 'absent'
    const pin = block.version
    return typeof pin === 'string' && PIN.test(pin) && DIGIT.test(pin) ? pin : 'unreadable'
  }
}

/** `release` and `release_format` from the drive-release reader's answer (F-13: logged, never acted on). */
function releaseFields(read: DriveReleaseRead): UpdateLogField[] {
  if (read.kind === 'absent') return [['release', 'absent']]
  if (read.kind !== 'record') return [['release', 'unreadable']] // a read that failed now, or a damaged file
  const app = read.appVersion
  const fields: UpdateLogField[] = [
    ['release', app.state !== 'valid' ? 'absent' : isLogVersion(app.value) ? app.value : 'unreadable']
  ]
  if (read.format.state === 'valid' && INTEGER.test(String(read.format.value))) fields.push(['release_format', String(read.format.value)])
  return fields
}

/** `drive_format`: config/drive.json's `drive_format_version`, read as loadPolicy reads the file (no byte-order mark). */
function driveFormat(read: TextRead): string {
  if (read.kind !== 'text') return 'unreadable' // a prepared drive has the file: gone or unreadable now
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return 'unreadable'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unreadable'
  if (!Object.hasOwn(parsed, 'drive_format_version')) return 'absent'
  const value = (parsed as Record<string, unknown>).drive_format_version
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'absent'
  const text = String(value)
  return INTEGER.test(text) ? text : 'unreadable'
}

/** The startup line's fields, in their fixed order (F-11). */
export function startupFields(facts: StartupFacts): UpdateLogField[] {
  const pin = enginePins(facts.runtimeSources)
  return [
    ['version', isLogVersion(facts.appVersion) ? facts.appVersion : 'unknown'],
    ...PIN_FIELDS.map(([family, key]): UpdateLogField => [key, pin(family)]),
    ...releaseFields(facts.driveRelease),
    ['drive_format', driveFormat(facts.driveJson)],
    ['sqlite', typeof facts.sqlite === 'string' && SQLITE_VERSION.test(facts.sqlite) ? facts.sqlite : 'unknown']
  ]
}

/** The failed-start line's fields, in their fixed order (F-11; decision 3: the code and the bare system call only). */
export function startFailedFields(facts: StartFailedFacts): UpdateLogField[] {
  const fields: UpdateLogField[] = [
    ['version', isLogVersion(facts.appVersion) ? facts.appVersion : 'unknown'],
    ['cause', CAUSES.has(facts.failure.cause) ? facts.failure.cause : 'other']
  ]
  const code = facts.failure.code
  if (typeof code === 'string' && code.length <= ERROR_CODE_MAX_BYTES && ERROR_CODE.test(code)) fields.push(['err', code])
  const call = systemCall(facts.thrown)
  if (call !== null) fields.push(['syscall', call])
  return fields
}

// ---- the file

/** Open flags: read (for the trim) + append + create. POSIX adds O_NOFOLLOW (a link at the name fails the open) and
 *  O_NONBLOCK (a pipe planted there cannot hang the start); Windows has neither (the sheet's named residual). */
const OPEN_FLAGS =
  constants.O_RDWR |
  constants.O_APPEND |
  constants.O_CREAT |
  (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

function isNoEntry(err: unknown): boolean {
  return errorCode(err) === 'ENOENT'
}

/** `<root>/updates`, a real folder at its name: made (one plain mkdir) when it is not there, refused when it is a link,
 *  a junction, a file, or anything `folderContainment` does not find where its path says. */
function updatesFolder(rootPath: string): string {
  const dir = join(rootPath, UPDATES_DIR)
  let named
  try {
    named = lstatSync(dir)
  } catch (err) {
    if (!isNoEntry(err)) throw new Skip('write-failed', err)
    try {
      mkdirSync(dir)
    } catch (mkdirErr) {
      if (errorCode(mkdirErr) !== 'EEXIST') throw new Skip('write-failed', mkdirErr)
    }
    try {
      named = lstatSync(dir)
    } catch (again) {
      throw new Skip('write-failed', again)
    }
  }
  if (named.isSymbolicLink()) throw new Skip('link')
  if (!named.isDirectory()) throw new Skip('not-a-folder')
  const at = folderContainment(rootPath, dir)
  if (at === 'outside') throw new Skip('link') // a junction Node reads as a folder, or a folder that resolves elsewhere
  if (at === 'unknown') throw new Skip('folder-unknown')
  return dir
}

/** The newest KEEP_BYTES of the file, read from its descriptor by position (never the whole file), from the byte after
 *  the first LF in them; no LF: nothing. Bytes, never decoded: cmd's code-page bytes and CRs stay as they are. */
function keptTail(fd: number, size: number): Buffer {
  const window = Buffer.alloc(Math.min(KEEP_BYTES, size))
  const start = size - window.length
  let got = 0
  while (got < window.length) {
    const n = readSync(fd, window, got, window.length - got, start + got)
    if (n === 0) break
    got += n
  }
  const read = window.subarray(0, got)
  const lf = read.indexOf(0x0a)
  return lf < 0 ? Buffer.alloc(0) : read.subarray(lf + 1)
}

/** Replace `update.log` by `kept`: a new temp (`openWriteTemp`: whatever is at its name is removed by the name, never
 *  followed; a folder there fails), fsync, rename. A failure keeps the old file and is counted; the next append tries
 *  again. */
function replaceWith(file: string, kept: Buffer): void {
  const tmp = `${file}.tmp`
  let fd: number | null = null
  let created = false
  try {
    fd = openWriteTemp(tmp)
    created = true
    let written = 0
    while (written < kept.length) {
      const n = writeSync(fd, kept, written, kept.length - written)
      if (n <= 0) throw new Error('short write')
      written += n
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* closing what failed */
      }
    }
    if (created) {
      try {
        unlinkSync(tmp) // the regular file this call created, by its name
      } catch {
        /* left for the next trim's openWriteTemp, which removes it first */
      }
    }
    reportTrimFailure(err)
  }
}

/** True only when `updates/applying/` is proven absent: anything there, or a stat that proves nothing, blocks a trim. */
function applyingAbsent(dir: string): boolean {
  try {
    lstatSync(join(dir, APPLYING_DIR))
    return false
  } catch (err) {
    return isNoEntry(err)
  }
}

/** Append `LF line LF` to `<root>/updates/update.log`, then trim when over the cap. Throws `Skip` for a refusal. */
function appendLine(rootPath: string, line: string): void {
  const dir = updatesFolder(rootPath)
  const file = join(dir, LOG_NAME)
  let named
  try {
    named = lstatSync(file, { bigint: true })
  } catch (err) {
    if (!isNoEntry(err)) throw new Skip('write-failed', err)
    named = null
  }
  if (named !== null) {
    if (named.isSymbolicLink()) throw new Skip('link')
    if (!named.isFile()) throw new Skip('not-a-file')
    if (named.nlink > 1n) throw new Skip('link') // a hard link: another name shares the file (0 counts as one)
  }
  let fd: number
  try {
    fd = openSync(file, OPEN_FLAGS)
  } catch (err) {
    throw new Skip(errorCode(err) === 'ELOOP' ? 'link' : 'write-failed', err)
  }
  let kept: Buffer | null = null
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile()) throw new Skip('not-a-file')
    // The name was not swapped between the lstat and the open: the same file, still with one name (the vault's own
    // test, #1014); a file this open created has no earlier lstat, only its link count.
    if (named !== null ? !sameShreddableFile(named, opened) : opened.nlink > 1n) throw new Skip('link')
    const bytes = Buffer.from(`\n${line}\n`, 'ascii')
    let written: number
    try {
      written = writeSync(fd, bytes)
    } catch (err) {
      throw new Skip('write-failed', err)
    }
    if (written !== bytes.length) throw new Skip('write-failed') // a short write (a full drive): the next LF ends it
    const size = Number(fstatSync(fd, { bigint: true }).size)
    if (size > MAX_BYTES && applyingAbsent(dir)) {
      try {
        kept = keptTail(fd, size)
      } catch (err) {
        reportTrimFailure(err)
      }
    }
  } finally {
    closeSync(fd)
  }
  if (kept !== null) replaceWith(file, kept)
}

/**
 * Append one `r1-app` event to the drive's `updates/update.log` (the generic appender: the startup and failed-start
 * lines, and later T3.10's unlock line and P6's and P7's events). Only on a prepared drive; a refusal or a failure is
 * counted and reported in app.log. Never throws.
 */
export function appendUpdateLogLine(paths: UpdateLogPaths, event: string, fields: readonly UpdateLogField[]): void {
  try {
    if (!paths.isPreparedDrive) return
    const line = formatUpdateLogLine(event, fields, { platform: process.platform, now: new Date() })
    if (line === null) {
      reportSkip(event, 'invalid-line')
      return
    }
    appendLine(paths.rootPath, line)
  } catch (err) {
    if (err instanceof Skip) reportSkip(event, err.reason, err.failure)
    else reportSkip(event, 'write-failed', err)
  }
}

/** A small source file for the line: one lstat, then one open checked on its descriptor; never a link, a pipe or more
 *  than `max` bytes. */
function readText(path: string, max: number): TextRead {
  let fd: number
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size > max) return { kind: 'unreadable' }
    fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)))
  } catch (err) {
    const code = errorCode(err)
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'unreadable' }
    const buffer = Buffer.alloc(max + 1)
    let got = 0
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, got)
      if (n === 0) break
      got += n
    }
    return got > max ? { kind: 'unreadable' } : { kind: 'text', text: buffer.subarray(0, got).toString('utf8') }
  } catch {
    return { kind: 'unreadable' }
  } finally {
    closeSync(fd)
  }
}

/**
 * The startup line (F-11): once per start, in `initBackend` after logging exists and before the policy and the
 * workspace's start (main/index.ts). Only on a prepared drive; reads the bundled yaml, config/drive.json and the
 * drive-release record, each capped. Never throws.
 */
export function writeStartupLine(
  paths: Pick<ResolvedPaths, 'rootPath' | 'configPath' | 'isPreparedDrive'>,
  opts: { appVersion: string; bundledManifestsDir: string | null }
): void {
  try {
    if (!paths.isPreparedDrive) return
    const facts: StartupFacts = {
      appVersion: opts.appVersion,
      runtimeSources:
        opts.bundledManifestsDir === null
          ? { kind: 'absent' }
          : readText(join(opts.bundledManifestsDir, 'runtime-sources.yaml'), RUNTIME_SOURCES_MAX_BYTES),
      driveRelease: readDriveRelease(paths.rootPath),
      driveJson: readText(join(paths.configPath, 'drive.json'), DRIVE_JSON_MAX_BYTES),
      sqlite: process.versions.sqlite
    }
    appendUpdateLogLine(paths, 'startup', startupFields(facts))
  } catch (err) {
    reportSkip('startup', 'write-failed', err)
  }
}

/**
 * The failed-start line (F-11): in the start runner's catch (main/backend-start.ts), best-effort, since the drive may be
 * what failed. Nothing without a layout or off a prepared drive. Never throws.
 */
export function writeStartFailedLine(
  paths: UpdateLogPaths | null,
  opts: { appVersion: string; thrown: unknown; failure: BackendStartFailure }
): void {
  try {
    if (paths === null) return
    appendUpdateLogLine(paths, 'start-failed', startFailedFields(opts))
  } catch (err) {
    reportSkip('start-failed', 'write-failed', err)
  }
}
