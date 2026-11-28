import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateRuntimeSources, type RuntimeFamily } from '../../../shared/runtime-sources'
import type { BackendStartFailure } from '../../../shared/types'
import { bareSyscall } from '../failure-for-log'
import { log } from '../logging'
import type { ResolvedPaths } from '../workspace'
import { folderContainment, openWriteTemp, sameShreddableFile, type OpenFacts } from '../workspace-vault'
import { readDriveRelease, type DriveReleaseRead } from './drive-release'
import { parseSemver } from './version'

// `<drive>/updates/update.log`: the plaintext support log on the drive (app-update plan W-14, W-68; F-11, frozen;
// docs/app-updates.md 8.2 and 5.3 table B.2). Release 1's app, its start files, the apply scripts and every later version
// append to this one file for ever, and support reads it before any unlock, so the app's lines are content-free by each
// event's typed fields (Δ-66): a line is `r1-app <os> <event> <key>=<value> ... t=<UTC time>`, and the appender writes
// only the events registered in `UPDATE_LOG_EVENTS`, each field only when its key is in the event's schema and its value
// passes the one rule that key names (a version, a pin, an integer, the SQLite version, an error code, a system call, a
// signed integer, the stamp's applied-through token, or a closed list of words). The frame's own value rule (1 to 64
// bytes of [0-9A-Za-z._+-]) stops paths, spaces, quotes and non-ASCII text, but not a one-word file, host or account
// name, so no key takes a free value: most rules refuse such a word, and a key whose rule is word-shaped is filled only
// from its own source or is named below as data-fed. Word-shaped: a pin P (`Steuer_2026.xlsx`), a system call C
// (`peter`), and in their own shapes a version V (`1.0.0-peter`) and an error code E (`EMMA`); the applied-through
// token A (any 16-byte word) is word-shaped outright. Registering an event is where that is reviewed. An error is logged
// only by its code and its bare system call (P3 entry decision 3), never by a message. The golden:
// tests/fixtures/readers/f11-update-log/ (vectors.json; the unlock line's vectors-unlock.json).
//
// Data-fed keys (their value is read from a file another program or build wrote, bounded by its rule; T3.2 review 1,
// recheck N-1): `startup`'s `release` (V) and `release_format` (I), from config/drive-release.json, and `drive_format`
// (I), from config/drive.json; `unlock`'s `writer` (V) and `applied` (A), from the workspace file's last_writer stamp,
// and `user_version` (N) and `found` (I), from its header or a newer-format refusal; (P6, T6.2) `staging-discarded`'s
// `version` (V), and the `version` of any line about a staged update found at a start, from a staged.json under
// updates/staging/ (release 1's or a later version's), which release 1 does not verify again. Every other key is filled
// from the app's own source: its version, its bundled runtime-sources.yaml (the pins, P), `process.versions.sqlite`, a
// thrown error's code (E) and system call (C), a run's own verified payload (an import line's `version`), counts (I), and
// closed lists.
//
// What this module writes (P3 entry decision 9 (c)):
// - `startup`, once per start of a prepared drive (main/index.ts `initBackend`): the app version, the engine pins of the
//   app's own bundled runtime-sources.yaml, the drive-release record's state (T3.3a's reader, F-13: this line is where
//   its "is logged" happens), config/drive.json's drive_format_version and the SQLite version (W-68);
// - `start-failed`, in the start runner's catch (main/backend-start.ts): the failure's cause, code and system call;
// - `unlock` (T3.10, CF-23), after every unlock attempt (ipc/registerWorkspaceIpc.ts), and for the start's plaintext
//   open (dev builds only): the outcome, the workspace file's own user_version and the last_writer stamp the open found,
//   and a refusal's content-free facts, each result with its own fields;
// - a later event (P6's and P7's events) only once it is registered in `UPDATE_LOG_EVENTS`, in this module, as data:
//   its keys in their order and the rule of each; `appendUpdateLogLine` then writes it.
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
/** An error code (E): an errno code, a Node code, SQLite's result code as the start failure spells it, or libuv's
 *  `UNKNOWN`, its code for a Windows error it does not map (seen on failing USB media; T3.2 review 1, m-6). */
const ERROR_CODE = /^(?:E[A-Z0-9]{1,30}|ERR_[A-Z0-9_]{1,36}|SQLITE_[0-9]{1,5}|UNKNOWN)$/
const ERROR_CODE_MAX_BYTES = 40
/** libuv's code for an unmapped error: the start gate shows no such code (start-failure.ts), the line keeps it. */
const LIBUV_UNKNOWN = 'UNKNOWN'
/** A bare system call (C), at most 16 bytes. */
const SYSCALL_MAX_BYTES = 16
/** The failed-start line's causes: the gate's three (`StartFailureCause`). */
const CAUSE_WORDS = ['drive_not_writable', 'drive_full', 'other'] as const
const CAUSES: ReadonlySet<string> = new Set(CAUSE_WORDS)
/** A signed integer (N): SQLite's `user_version` is a signed 32-bit number. The numeric shape only (T3.2 recheck N-2). */
const SIGNED_INTEGER = /^-?[0-9]{1,10}$/
/** The stamp's applied-through token (A): word-shaped and data-fed, the second field of the workspace file's last_writer
 *  stamp (release 1 writes `interim`; P10's T10.3 defines the later values). A longer or other-shaped token is omitted. */
const APPLIED_THROUGH = /^[0-9A-Za-z._-]{1,16}$/
/** The unlock line's results (T3.10): `ok`, or the reason of the answer the gate was given (`WorkspaceActionResult`'s
 *  unlock reasons, frozen as log tokens here); any other value is `error`. */
const UNLOCK_RESULTS = [
  'ok',
  'wrong_password',
  'vault_damaged',
  'workspace_schema_unreadable',
  'vault_open_failed',
  'vault_missing',
  'vault_descriptor_missing',
  'vault_descriptor_unreadable',
  'vault_recovery_blocked',
  'workspace_newer',
  'error'
] as const
type UnlockResult = (typeof UNLOCK_RESULTS)[number]
/** `vault_damaged`'s kinds (`VaultDamagedError.damage`). */
const DAMAGE_WORDS = ['failed-authentication', 'not-a-database'] as const
/** `workspace_newer`'s artifacts: the vault format's (`VaultNewerWhat`), checked before the password, and the database. */
const VAULT_FORMAT_WORDS = ['descriptor', 'kdf', 'frame', 'journal'] as const
const NEWER_WORDS = ['database', ...VAULT_FORMAT_WORDS] as const

/** The codes an import answers (record 4.5's events, table B.9), and `UPD-OLD-FILE` for a run that ends by asking;
 *  `UPD-NOT-A-DRIVE` stands in the list though no file receives it (off a prepared drive nothing is written). */
const IMPORT_REFUSED_CODES = [
  'UPD-NOT-AVAILABLE',
  'UPD-NOT-A-DRIVE',
  'UPD-POLICY-MANAGED',
  'UPD-POLICY-INVALID',
  'UPD-IN-PROGRESS',
  'UPD-DRIVE-READ-ONLY',
  'UPD-DRIVE-FULL',
  'UPD-TOO-NEW',
  'UPD-FILE-DAMAGED',
  'UPD-NOT-GENUINE',
  'UPD-UNKNOWN-SIGNER',
  'UPD-FOR-NEWER-HILBERTRAUM',
  'UPD-NOT-AN-UPDATE',
  'UPD-WRONG-CHANNEL',
  'UPD-NEEDS-IN-BETWEEN',
  'UPD-SAME-OR-OLDER',
  'UPD-ABOVE-MAX-VERSION',
  'UPD-CANT-CHECK-LINUX-FLOOR',
  'UPD-OS-TOO-OLD',
  'UPD-DOWNLOAD-INCOMPLETE',
  'UPD-NO-HELPER',
  'UPD-PATH-TOO-LONG',
  'UPD-FILE-TOO-BIG-FOR-DRIVE',
  'UPD-CANT-READ-FILE',
  'UPD-CANT-WRITE-DRIVE',
  'UPD-OLD-FILE'
] as const
/** Which name blocked an import (`link`, with UPD-CANT-WRITE-DRIVE only; the pairing is the service's duty). */
const IMPORT_LINK_WORDS = ['updates', 'staging', 'version', 'incoming', 'probe'] as const
/** The start-up sweep's reasons (record 4.5 "The start-up sweep"). */
const SWEEP_REASON_WORDS = ['incoming', 'no-marker', 'invalid-marker', 'member-missing', 'not-a-folder', 'link'] as const
const YES_NO = ['yes', 'no'] as const

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
  /** What the start threw: only its bare system call, and its code when that is libuv's `UNKNOWN`, are read, under
   *  `try`. */
  thrown: unknown
}

/** The drive the line goes to. */
export type UpdateLogPaths = Pick<ResolvedPaths, 'rootPath' | 'isPreparedDrive'>

/** Why a line was not written (app.log only; not part of F-11). */
type SkipReason =
  | 'link'
  | 'not-a-folder'
  | 'not-a-file'
  | 'folder-unknown'
  | 'write-failed'
  | 'invalid-line'
  | 'unregistered-event'

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

/** E: an error code of at most 40 bytes. */
function isErrorCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ERROR_CODE_MAX_BYTES && ERROR_CODE.test(value)
}

/** The code of a failed call, when it passes E: never the message, which names the path. Never throws. */
function errorCode(err: unknown): string | null {
  try {
    const code = (err as { code?: unknown } | null)?.code
    return isErrorCode(code) ? code : null
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
      event: typeof event === 'string' && EVENT.test(event) ? event : null,
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
 * The frame every app line goes through last: `r1-app <os> <event> <fields> t=<time>`. Every key and value is checked
 * again (a field that fails is dropped, as is a second field of one key and a caller's `t`); the time is omitted when it
 * fails its rule. Null, no line at all, for an event that fails its rule or a line that would still exceed 256 bytes.
 * The frame alone does not make a line content-free (a one-word file name passes it), and it writes nothing: the
 * appender writes only a registered event's typed fields ({@link formatRegisteredLine}).
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

// ---- the registered events (F-11, Δ-66: content-free by each event's typed fields)

/** The token rules of F-11 a registered key may name: version, pin, integer, SQLite version, error code, system call;
 *  (T3.10) a signed integer and the stamp's applied-through token. */
export type UpdateLogTokenRule = 'V' | 'P' | 'I' | 'S' | 'E' | 'C' | 'N' | 'A'
/** The sentinels of F-11: fixed words that hold no digit, so never a value any rule admits. */
export type UpdateLogSentinel = 'unknown' | 'absent' | 'unreadable' | 'none'

/** One key of a registered event and the one rule its value passes: a token rule (with the sentinels this key admits,
 *  and no other), or a closed list of literal words. */
export type UpdateLogFieldSpec =
  | { readonly key: string; readonly rule: UpdateLogTokenRule; readonly sentinels?: readonly UpdateLogSentinel[] }
  | { readonly key: string; readonly oneOf: readonly string[] }

/** What each token rule admits (F-11; the golden's `tokens`). */
const TOKEN_RULES: Readonly<Record<UpdateLogTokenRule, (value: string) => boolean>> = {
  V: isLogVersion,
  P: (value) => PIN.test(value) && DIGIT.test(value),
  I: (value) => INTEGER.test(value),
  S: (value) => SQLITE_VERSION.test(value),
  E: isErrorCode,
  C: (value) => value.length <= SYSCALL_MAX_BYTES && bareSyscall(value) !== null,
  N: (value) => SIGNED_INTEGER.test(value),
  A: (value) => APPLIED_THROUGH.test(value)
}

/** A pin's sentinels: no file or no block (`absent`), a file that could not be read or a pin that fails P. */
const PIN_SENTINELS = ['absent', 'unreadable'] as const

const EVENTS = {
  /** W-14, W-68: what the drive was started with. */
  startup: [
    { key: 'version', rule: 'V', sentinels: ['unknown'] },
    { key: 'llama', rule: 'P', sentinels: PIN_SENTINELS },
    { key: 'whisper', rule: 'P', sentinels: PIN_SENTINELS },
    { key: 'kiwix', rule: 'P', sentinels: PIN_SENTINELS },
    { key: 'release', rule: 'V', sentinels: ['absent', 'unreadable'] },
    { key: 'release_format', rule: 'I' },
    { key: 'drive_format', rule: 'I', sentinels: ['absent', 'unreadable'] },
    { key: 'sqlite', rule: 'S', sentinels: ['unknown'] }
  ],
  /** W-14, W-82: a start that threw (P3 entry decision 3: the code and the bare system call only). */
  'start-failed': [
    { key: 'version', rule: 'V', sentinels: ['unknown'] },
    { key: 'cause', oneOf: CAUSE_WORDS },
    { key: 'err', rule: 'E' },
    { key: 'syscall', rule: 'C' }
  ],
  /** W-14, T3.10 (CF-23): an unlock attempt's outcome and what it found (`unlockFields` picks each result's fields).
   *  Data-fed: `user_version` and `found` (the file's header, a newer-format refusal), `writer` and `applied` (its
   *  last_writer stamp). */
  unlock: [
    { key: 'result', oneOf: UNLOCK_RESULTS },
    { key: 'user_version', rule: 'N' },
    { key: 'writer', rule: 'V', sentinels: ['none', 'unreadable'] },
    { key: 'applied', rule: 'A' },
    { key: 'damage', oneOf: DAMAGE_WORDS },
    { key: 'what', oneOf: NEWER_WORDS },
    { key: 'found', rule: 'I' },
    { key: 'err', rule: 'E' },
    { key: 'syscall', rule: 'C' }
  ],
  /** P6 (T6.2; record 4.5's events): a run that ended in a refusal, or by asking (UPD-OLD-FILE). `version` is the run's own
   *  verified payload's, or the refusal's own version parameter, `unknown` for 25 to 64 bytes; `err` and `syscall` the
   *  thrown error's, for the codes an I/O error gives; `link` the name that blocked it. */
  'import-refused': [
    { key: 'code', oneOf: IMPORT_REFUSED_CODES },
    { key: 'version', rule: 'V', sentinels: ['unknown'] },
    { key: 'stale_drive_version', oneOf: YES_NO },
    { key: 'err', rule: 'E' },
    { key: 'syscall', rule: 'C' },
    { key: 'link', oneOf: IMPORT_LINK_WORDS }
  ],
  /** P6: a run that staged its update; `files` the `files[]` members staged, member 0 not counted. */
  'import-staged': [
    { key: 'version', rule: 'V', sentinels: ['unknown'] },
    { key: 'stale_drive_version', oneOf: YES_NO },
    { key: 'files', rule: 'I' },
    { key: 'old_file', oneOf: ['confirmed', 'no'] },
    { key: 'issued_in_future', oneOf: YES_NO },
    { key: 'other_floors', oneOf: YES_NO }
  ],
  /** P6: a run the user cancelled after the file was read; `version` when the payload was accepted before the cancel. */
  'import-cancelled': [{ key: 'version', rule: 'V', sentinels: ['unknown'] }],
  /** P6: the start-up sweep, one line per reason that counted an entry; `code` with `member-missing` only. */
  'staging-swept': [
    { key: 'n', rule: 'I' },
    { key: 'reason', oneOf: SWEEP_REASON_WORDS },
    { key: 'code', oneOf: ['UPD-FILE-DAMAGED-ON-DRIVE'] }
  ],
  /** P6: "Don't install this update". Data-fed: `version`, the discarded folder's staged.json's. */
  'staging-discarded': [{ key: 'version', rule: 'V', sentinels: ['unknown'] }]
} as const satisfies Readonly<Record<string, readonly UpdateLogFieldSpec[]>>

/** A registered event's name: the only events the appender writes. */
export type UpdateLogEvent = keyof typeof EVENTS

/**
 * The registered events (F-11, Δ-66), each with its keys in their fixed order and the one rule each names: the only
 * lines the app writes to update.log. A later event (T3.10's `unlock`, P6's and P7's events) joins this table, in this
 * module, as data: its keys and their rules, never a free value. Frozen, so nothing changes it at run time.
 */
export const UPDATE_LOG_EVENTS: Readonly<Record<UpdateLogEvent, readonly UpdateLogFieldSpec[]>> = frozenTable(EVENTS)

function frozenTable<T extends Readonly<Record<string, readonly UpdateLogFieldSpec[]>>>(table: T): T {
  for (const schema of Object.values(table)) {
    for (const spec of schema) {
      Object.freeze('oneOf' in spec ? spec.oneOf : spec.sentinels)
      Object.freeze(spec)
    }
    Object.freeze(schema)
  }
  return Object.freeze(table)
}

/** Is `event` registered? Looked up by the table's own keys only (never `constructor` or `toString`). */
function isRegistered(event: unknown): event is UpdateLogEvent {
  return typeof event === 'string' && Object.hasOwn(UPDATE_LOG_EVENTS, event)
}

function admits(spec: UpdateLogFieldSpec, value: string): boolean {
  if ('oneOf' in spec) return spec.oneOf.includes(value)
  return (spec.sentinels as readonly string[] | undefined)?.includes(value) === true || TOKEN_RULES[spec.rule](value)
}

/**
 * The line of a registered event (F-11, Δ-66): for each key of its schema, in order, the first value of that key the
 * key's rule admits; every other field (a key the schema does not name, a value its rule refuses, a later value of a key
 * already taken) dropped; then the frame ({@link formatUpdateLogLine}). Null, no line at all, for an event nobody
 * registered or a line the frame refuses. Writes nothing: {@link appendUpdateLogLine} does.
 */
export function formatRegisteredLine(
  event: UpdateLogEvent,
  fields: readonly UpdateLogField[],
  ctx: { platform: string; now: Date }
): string | null {
  if (!isRegistered(event)) return null
  const typed: UpdateLogField[] = []
  for (const spec of UPDATE_LOG_EVENTS[event]) {
    const found = fields.find(([key, value]) => key === spec.key && typeof value === 'string' && admits(spec, value))
    if (found !== undefined) typed.push([spec.key, found[1]])
  }
  return formatUpdateLogLine(event, typed, ctx)
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

/** The failed-start line's fields, in their fixed order (F-11; decision 3: the code and the bare system call only).
 *  `err` is the gate's code when it passes E; libuv's `UNKNOWN`, which the gate does not show, is taken from what the
 *  start threw (m-6). */
export function startFailedFields(facts: StartFailedFacts): UpdateLogField[] {
  const fields: UpdateLogField[] = [
    ['version', isLogVersion(facts.appVersion) ? facts.appVersion : 'unknown'],
    ['cause', CAUSES.has(facts.failure.cause) ? facts.failure.cause : 'other']
  ]
  const code = facts.failure.code
  if (isErrorCode(code)) fields.push(['err', code])
  else if (errorCode(facts.thrown) === LIBUV_UNKNOWN) fields.push(['err', LIBUV_UNKNOWN])
  const call = systemCall(facts.thrown)
  if (call !== null) fields.push(['syscall', call])
  return fields
}

/** What the unlock line is made of (T3.10): an attempt's outcome, what its open found, what it threw. */
export interface UnlockFacts {
  /** `ok`, or the reason of the answer the gate was given; anything else is logged as `error`. */
  readonly result: unknown
  /** What the open handed out (`WorkspaceController.takeOpenFacts`); null when nothing was decrypted or opened. */
  readonly open: OpenFacts | null
  /** What a refused or failed attempt threw, read only for its content-free fields, each read under `try`; undefined for
   *  a success. */
  readonly thrown: unknown
}

/** Each result's fields (the golden's `per_result`; the schema gives their order): fields that cannot occur together
 *  never share a line, so every result's longest line fits the frame, which all nine keys at their caps would not.
 *  `vault_open_failed` carries no system call (the open's failures are SQLite's); `vault_missing` no `keptCopyDiscarded`
 *  (a later version may add a key). */
const UNLOCK_FIELDS: Readonly<Record<UnlockResult, ReadonlySet<string>>> = {
  ok: new Set(['user_version', 'writer', 'applied']),
  wrong_password: new Set(),
  vault_damaged: new Set(['user_version', 'damage']),
  workspace_schema_unreadable: new Set(['user_version']),
  vault_open_failed: new Set(['user_version', 'writer', 'applied', 'err']),
  vault_missing: new Set(),
  vault_descriptor_missing: new Set(),
  vault_descriptor_unreadable: new Set(),
  vault_recovery_blocked: new Set(['err']),
  workspace_newer: new Set(['user_version', 'what', 'found']),
  error: new Set(['user_version', 'writer', 'applied', 'err', 'syscall'])
}

/** One property of a thrown value, or undefined. Never throws (a getter or a Proxy may). */
function propertyOf(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  } catch {
    return undefined
  }
}

/** The text of an integer number (N's input; the rule then checks its shape), or null. */
function integerText(value: unknown): string | null {
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : null
}

/** A newer-format refusal's `found` as text (I's input), or null: a number or a string the file chose, which only the
 *  integer rule lets through. */
function foundText(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null
}

/** E for the line: SQLite's result code as `SQLITE_<n>` when the value carries an integer `errcode` 0-65535
 *  (start-failure.ts's rule: node:sqlite's `code` is always ERR_SQLITE_ERROR), else its `code`. Never throws. */
function sqliteOrErrorCode(err: unknown): string | null {
  const errcode = propertyOf(err, 'errcode')
  if (typeof errcode === 'number' && Number.isInteger(errcode) && errcode >= 0 && errcode <= 0xffff) return `SQLITE_${errcode}`
  return errorCode(err)
}

/** `writer` and `applied` from the stamp the open found: none when it never got that far; `none` for no stamp;
 *  `unreadable` when F-10's reader says so or its version fails V; else the version and the applied-through token. */
function stampFields(lastWriter: OpenFacts['lastWriter']): UpdateLogField[] {
  if (lastWriter === undefined) return []
  if (lastWriter === null) return [['writer', 'none']]
  if (lastWriter === 'unreadable' || !isLogVersion(lastWriter.appVersion)) return [['writer', 'unreadable']]
  return [
    ['writer', lastWriter.appVersion],
    ['applied', lastWriter.appliedThrough]
  ]
}

/**
 * The unlock line's fields (F-11, T3.10; the golden's per-result table): `result` (`ok`, or the answer's reason; any
 * other value `error`), then only the fields of that result. `user_version` is the workspace file's own (the header's,
 * before the migrations), or a newer database's `found`, which wins; `writer`/`applied` the stamp the open found before
 * its overwrite (CF-23: parsed, so the raw value never reaches here); `damage`, `what`/`found`, `err` and `syscall` are
 * read from what was thrown, by name and type only, each read under `try`. Every value then goes through its key's rule.
 */
export function unlockFields(facts: UnlockFacts): UpdateLogField[] {
  const result: UnlockResult =
    typeof facts.result === 'string' && (UNLOCK_RESULTS as readonly string[]).includes(facts.result)
      ? (facts.result as UnlockResult)
      : 'error'
  const keys = UNLOCK_FIELDS[result]
  const { open, thrown } = facts
  const fields: UpdateLogField[] = [['result', result]]
  const add = (key: string, value: string | null): void => {
    if (value !== null && keys.has(key)) fields.push([key, value])
  }
  if (result === 'workspace_newer') {
    const what = propertyOf(thrown, 'what')
    const found = propertyOf(thrown, 'found')
    if (typeof what === 'string' && (VAULT_FORMAT_WORDS as readonly string[]).includes(what)) {
      add('what', what) // the vault's format, refused before the password: no file was decrypted
    } else {
      add('user_version', integerText(found) ?? integerText(open?.userVersion))
      add('what', 'database')
    }
    add('found', foundText(found))
    return fields
  }
  add('user_version', integerText(open?.userVersion))
  for (const [key, value] of stampFields(open?.lastWriter)) add(key, value)
  const damage = propertyOf(thrown, 'damage')
  add('damage', typeof damage === 'string' ? damage : null)
  if (result === 'vault_open_failed') {
    const failure = propertyOf(thrown, 'failure') // never its `kind` or `sqlite`, which carry free text
    add('err', sqliteOrErrorCode({ errcode: propertyOf(failure, 'sqliteCode'), code: propertyOf(failure, 'code') }))
  } else if (result === 'vault_recovery_blocked') {
    add('err', errorCode({ code: propertyOf(thrown, 'code') }))
  } else {
    add('err', sqliteOrErrorCode(thrown))
  }
  add('syscall', systemCall(thrown))
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
 * Append one registered `r1-app` event to the drive's `updates/update.log` (the startup and failed-start lines, and,
 * once registered in {@link UPDATE_LOG_EVENTS}, T3.10's unlock line and P6's and P7's events), its fields typed by the
 * event's schema ({@link formatRegisteredLine}). An event nobody registered is no line, counted and reported in app.log
 * on any root. Only on a prepared drive; a refusal or a failure is counted and reported in app.log. Never throws.
 * Answers true only when the append returned, so the line is in the file; false for every line not written (the update
 * service's repeated-refusal rule counts only a line written, record §4.5 N-7). A failure after the bytes went (the
 * close) answers false too: for that rule, one line more. The other callers ignore the answer.
 */
export function appendUpdateLogLine(paths: UpdateLogPaths, event: UpdateLogEvent, fields: readonly UpdateLogField[]): boolean {
  try {
    if (!isRegistered(event)) {
      reportSkip(event, 'unregistered-event')
      return false
    }
    if (!paths.isPreparedDrive) return false
    const line = formatRegisteredLine(event, fields, { platform: process.platform, now: new Date() })
    if (line === null) {
      reportSkip(event, 'invalid-line')
      return false
    }
    appendLine(paths.rootPath, line)
    return true
  } catch (err) {
    if (err instanceof Skip) reportSkip(event, err.reason, err.failure)
    else reportSkip(event, 'write-failed', err)
    return false
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

/**
 * The unlock line (F-11, T3.10): once per unlock attempt the handler answered (ipc/registerWorkspaceIpc.ts; never for
 * one that checked nothing), and for the start's plaintext open. Nothing without the drive (`paths` left out: the test
 * contexts) or off a prepared drive. Never throws, never waits: one append, no fsync.
 */
export function writeUnlockLine(paths: UpdateLogPaths | undefined, facts: UnlockFacts): void {
  try {
    if (paths === undefined) return
    appendUpdateLogLine(paths, 'unlock', unlockFields(facts))
  } catch (err) {
    reportSkip('unlock', 'write-failed', err)
  }
}
