// `config/drive-release.json`: what a drive was built with (app-update plan W-20; F-13, docs/app-updates.md §8.5 and
// table B.11 in §5.10). Release 1 reads this file on every Kit for ever, so the read half is frozen: the reader below,
// its result shape and the field meanings every later writer keeps. The write half is the builders' helper
// (scripts/lib/write-drive-release.mjs), which loads this file through Node's own type stripping; so it imports only
// `node:` built-ins and T3.1's `./version`, and holds only TypeScript that stripping can erase (no `enum`, no
// namespace, no parameter property). The golden is tests/fixtures/readers/f13-drive-release/.
//
// What release 1 reads: `app_version`, for the update version rule (§2.5); `format`, returned for the log and never
// acted on, so a later format bump never stops release 1 (a breaking layout takes a new file name);
// `highest_version_seen`, a reserved name returned for the log and never acted on. An absent file or field means no
// constraint; a file that is there but damaged, and a field of the wrong type, count as absent too and are told apart
// only so that the startup line can log them. Every other field, `systems` and `files` included, is never read.
//
// The reader logs nothing, caches nothing and never throws. The startup line (T3.2) is where F-13's "is logged" happens.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { parseSemver } from './version'

/** Where the record lives, from the drive root. */
export const DRIVE_RELEASE_REL = 'config/drive-release.json'

/** The largest record release 1 reads (B.11): a larger file is damaged, so no reader takes an arbitrary file into memory. */
export const DRIVE_RELEASE_MAX_BYTES = 1_048_576

/** The `format` the helper writes. Informational only: no reader acts on it (F-13). */
export const DRIVE_RELEASE_FORMAT = 1

/** A version is at most 64 bytes (record §5.1); the SemVer grammar itself allows up to 256 characters. */
export const RELEASE_VERSION_MAX_BYTES = 64

/**
 * Why a record that is there is no record this reader can read: something other than a regular file at the name (a
 * folder, a pipe, a link of any kind, never followed), 0 bytes, larger than the limit, text that is not JSON, JSON that
 * is not an object.
 */
export type DriveReleaseFault = 'not-a-file' | 'empty' | 'too-large' | 'not-json' | 'not-an-object'

/** One field of a record: not there, there with the wrong type or no valid value (counts as absent), or valid. */
export type DriveReleaseValue<T> = { state: 'absent' } | { state: 'invalid' } | { state: 'valid'; value: T }

/**
 * What is at `config/drive-release.json` (frozen, F-13; the W-53 snapshot of release 1's reader returns this shape):
 *  - `absent`: no file (ENOENT, ENOTDIR);
 *  - `unreadable`: it is there, but the read failed just now (a denied read, an antivirus hold); `code` is the errno
 *    token, validated as one, never the message, which names the path;
 *  - `damaged`: it is there but is no record this reader can read;
 *  - `record`: the three fields release 1 knows. Only `appVersion` may reach a decision, through `driveAppVersion`.
 */
export type DriveReleaseRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; code: string | null }
  | { kind: 'damaged'; fault: DriveReleaseFault }
  | {
      kind: 'record'
      appVersion: DriveReleaseValue<string>
      /** Logged, never acted on. */
      format: DriveReleaseValue<number>
      /** Reserved (G-19 (b)): logged, never acted on. */
      highestVersionSeen: DriveReleaseValue<string>
    }

/** The record's text as the helper (and a later app writer) reads it: the parsed object, own fields only, in order. */
export type DriveReleaseFile =
  | { kind: 'absent' }
  | { kind: 'unreadable'; code: string | null }
  | { kind: 'damaged'; fault: DriveReleaseFault }
  | { kind: 'object'; fields: Record<string, unknown> }

/** A version as the record and the artifact names carry it: SemVer 2.0.0 (T3.1's parse), ASCII, at most 64 bytes. */
export function isReleaseVersion(value: unknown): value is string {
  // parseSemver accepts ASCII only, so the length in characters is the length in bytes.
  return typeof value === 'string' && value.length <= RELEASE_VERSION_MAX_BYTES && parseSemver(value) !== null
}

/** The errno code of a failed read (`ENOENT`, `EBUSY`, …), validated as one: never the message, which names the path. */
function errnoToken(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null
}

/** A failed `lstat` or read: not there at all, or there but not readable just now. */
function readFailure(err: unknown): DriveReleaseFile {
  const code = errnoToken(err)
  return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable', code }
}

/**
 * Parse a record's text: its own fields, or why it is none. Never throws. One leading byte-order mark is read past
 * (no writer writes one, but an editor may); a second one is no JSON whitespace, so the text is no JSON.
 */
export function parseDriveReleaseText(text: string): Record<string, unknown> | DriveReleaseFault {
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return 'not-json' // a RangeError of a parser that gives up on depth included
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not-an-object'
  return raw as Record<string, unknown>
}

/**
 * How the record is opened: read only, and on POSIX also O_NOFOLLOW (a link put at the name after the `lstat` fails the
 * open) and O_NONBLOCK (a pipe put there cannot hold the start; a regular file reads as before). Windows has neither
 * flag, so there the open follows a link put at the name in between to what it names. The same flags as the update
 * log's own source reads (update-log.ts).
 */
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

/**
 * Read the record at `<rootPath>/config/drive-release.json` as text and parse it. Never throws. One `lstat` first:
 * anything but a regular file at the name is damaged and never opened or followed (a link to a record included, the
 * #1047 rule at a fixed name; a pipe would block the main thread). Larger than the limit is damaged and never opened;
 * a file that grew since is read to one byte past the limit and is damaged too. What was opened is checked again, on
 * its descriptor: anything put at the name between the `lstat` and the open that is no regular file is damaged too
 * (what remains of that window: on Windows a link put there is followed to the file it names, and a file cut to 0 bytes
 * there reads as `not-json`). The text is decoded leniently: a byte that is not UTF-8 becomes U+FFFD, which no version
 * holds.
 */
export function readDriveReleaseFile(rootPath: string): DriveReleaseFile {
  const path = join(rootPath, ...DRIVE_RELEASE_REL.split('/'))
  let fd: number
  try {
    const info = lstatSync(path)
    if (!info.isFile()) return { kind: 'damaged', fault: 'not-a-file' }
    if (info.size === 0) return { kind: 'damaged', fault: 'empty' }
    if (info.size > DRIVE_RELEASE_MAX_BYTES) return { kind: 'damaged', fault: 'too-large' }
    fd = openSync(path, OPEN_FLAGS)
  } catch (err) {
    return readFailure(err)
  }
  let bytes: Buffer
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) return { kind: 'damaged', fault: 'not-a-file' }
    bytes = readAtMost(fd, Math.min(opened.size, DRIVE_RELEASE_MAX_BYTES) + 1, DRIVE_RELEASE_MAX_BYTES + 1)
  } catch (err) {
    return readFailure(err)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // The read's answer stands: closing a descriptor opened for reading loses nothing when the close fails.
    }
  }
  if (bytes.length > DRIVE_RELEASE_MAX_BYTES) return { kind: 'damaged', fault: 'too-large' }
  const parsed = parseDriveReleaseText(bytes.toString('utf8'))
  return typeof parsed === 'string' ? { kind: 'damaged', fault: parsed } : { kind: 'object', fields: parsed }
}

/** Up to `limit` bytes of an open file from its start, growing the buffer from `first` as the file turns out longer. */
function readAtMost(fd: number, first: number, limit: number): Buffer {
  let buffer = Buffer.alloc(Math.min(first, limit))
  let length = 0
  for (;;) {
    if (length === buffer.length) {
      if (buffer.length >= limit) break
      const larger = Buffer.alloc(Math.min(buffer.length * 2, limit))
      buffer.copy(larger)
      buffer = larger
    }
    const n = readSync(fd, buffer, length, buffer.length - length, length)
    if (n === 0) break
    length += n
  }
  return buffer.subarray(0, length)
}

/** A record's own field: never one reached through the prototype (an own `__proto__` key is an unknown field). */
function ownField(fields: Record<string, unknown>, key: string): { present: false } | { present: true; value: unknown } {
  return Object.hasOwn(fields, key) ? { present: true, value: fields[key] } : { present: false }
}

function versionField(fields: Record<string, unknown>, key: string): DriveReleaseValue<string> {
  const field = ownField(fields, key)
  if (!field.present) return { state: 'absent' }
  return isReleaseVersion(field.value) ? { state: 'valid', value: field.value } : { state: 'invalid' }
}

function formatField(fields: Record<string, unknown>): DriveReleaseValue<number> {
  const field = ownField(fields, 'format')
  if (!field.present) return { state: 'absent' }
  const v = field.value
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? { state: 'valid', value: v } : { state: 'invalid' }
}

/** What is at the drive's `config/drive-release.json` (F-13). Sync, never throws, no cache, logs nothing. */
export function readDriveRelease(rootPath: string): DriveReleaseRead {
  const file = readDriveReleaseFile(rootPath)
  if (file.kind !== 'object') return file
  return {
    kind: 'record',
    appVersion: versionField(file.fields, 'app_version'),
    format: formatField(file.fields),
    highestVersionSeen: versionField(file.fields, 'highest_version_seen')
  }
}

/** The only value of the record a decision may use: its valid `app_version`, else null (no constraint). */
export function driveAppVersion(read: DriveReleaseRead): string | null {
  return read.kind === 'record' && read.appVersion.state === 'valid' ? read.appVersion.value : null
}

// ---- the drive root's apps (the helper's `app_version` and `systems`; not frozen here: P6 freezes the root names, F-18)

/** Systems as Node spells them (record §5.1). */
export type DriveSystem = 'darwin' | 'linux' | 'win32'

/** What a root entry is, by `lstat`: a link of any kind is `other`, never followed. */
export type RootEntryKind = 'file' | 'folder' | 'other'

/** A drive-root entry that release 1's start files count as an app, and the version its name carries (or null). */
export interface RootArtifact {
  system: DriveSystem
  version: string | null
}

/** A root app with its name and kind, as `rootApps` lists them. */
export interface RootApp extends RootArtifact {
  name: string
  kind: RootEntryKind
}

/** The start files a Kit carries at its root (`launchers/`, `build-commercial-drive`'s list), recorded in `files`. */
export const START_FILE_NAMES: readonly string[] = ['Start HilbertRaum.cmd', 'Start HilbertRaum.command', 'start-hilbertraum.sh', 'READ ME FIRST.txt']

/**
 * Release 1's root globs for app files (record §4.4), each with its own start file's case rule (T6.2, CF-33): the
 * segment between prefix and suffix is the carried version. `foldCase`: the Windows start file's `for` glob matches
 * without case on the file systems a Kit uses, so its name is compared after an ASCII fold of the glob's fixed parts
 * (the glob below is written folded); the macOS and Linux start files are bash globs, which match byte for byte. The
 * star matches any characters, line ends included, as cmd's and bash's `*` do (the `s` flag; T6.9 lens 1 m-2).
 */
const APP_FILE_NAMES: ReadonlyArray<readonly [DriveSystem, RegExp, boolean]> = [
  ['win32', /^hilbertraum-(.*)-portable\.exe$/s, true],
  ['darwin', /^HilbertRaum-(.*)-mac-arm64\.app\.zip$/s, false],
  ['linux', /^HilbertRaum-(.*)\.AppImage$/s, false]
]

/** The globs' common prefix, `HilbertRaum-`: where each name's version segment starts. */
const GLOB_PREFIX_LENGTH = 'HilbertRaum-'.length

/** `A`-`Z` folded to `a`-`z` and nothing else (never a locale's rule: a dotless i upper-cases to `I`). Keeps the length,
 *  so a segment found in the folded name lies at the same place in the name. */
const asciiFold = (text: string): string => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

/**
 * Whether a drive-root entry is an app by release 1's root globs (record §4.4), and which version its name carries.
 * A file `HilbertRaum-V-portable.exe`, `HilbertRaum-V-mac-arm64.app.zip` or `HilbertRaum-V.AppImage` carries V when V
 * is a version, never by prefix or substring (`HilbertRaum-1.4.0-rc.1-portable.exe` carries `1.4.0-rc.1`, never
 * `1.4.0`); a name inside a glob whose segment is no version is an app of no known version. Case (T6.2, CF-33): each
 * system's own start file decides, so a `win32` name matches after an ASCII fold of the glob's fixed parts
 * (`hilbertraum-1.4.0-PORTABLE.EXE` carries `1.4.0`; the segment is taken as written and is a version only as written),
 * and a `darwin` or `linux` name, and a folder's `.app`, byte for byte. A folder `*.app` (not a hidden one: bash's `*`
 * skips a leading dot) is a macOS app of no known version, as the start file finds it. Links and anything else are no
 * app.
 */
export function rootArtifactOf(name: string, kind: RootEntryKind): RootArtifact | null {
  if (kind === 'folder') return name.endsWith('.app') && !name.startsWith('.') ? { system: 'darwin', version: null } : null
  if (kind !== 'file') return null
  for (const [system, glob, foldCase] of APP_FILE_NAMES) {
    const m = glob.exec(foldCase ? asciiFold(name) : name)
    if (m === null) continue
    // Every glob opens with the 12 characters of `HilbertRaum-`, so the segment starts there in the name as written.
    const segment = name.slice(GLOB_PREFIX_LENGTH, GLOB_PREFIX_LENGTH + m[1].length)
    return { system, version: isReleaseVersion(segment) ? segment : null }
  }
  return null
}

/** The apps at a drive root, by `rootArtifactOf`. Throws when the root cannot be listed (the helper refuses then). */
export function rootApps(rootPath: string): RootApp[] {
  const apps: RootApp[] = []
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const kind: RootEntryKind = entry.isFile() ? 'file' : entry.isDirectory() ? 'folder' : 'other'
    const artifact = rootArtifactOf(entry.name, kind)
    if (artifact) apps.push({ name: entry.name, kind, ...artifact })
  }
  return apps
}

/** The `app_version` a writer that did not place the apps records (W-20; §8.5), and why. */
export type AppVersionChoice =
  | { value: string; why: 'single' | 'kept' }
  | { value: null; why: 'no-app' | 'no-single-version' }

/**
 * W-20's rule for a writer that did not place the apps itself (`prepare-drive`, the Kit builder's last step): the one
 * version when exactly one app per system is at the root and every one carries it; otherwise the existing record's
 * `app_version`, when a root app still carries exactly that version (so a re-run never drops a lagging system's floor,
 * and the kept value is never ahead of the root: the T3.3a sheet's Q2, accepted); otherwise none (no constraint).
 * Every app carrying one version already means one app per system: the version is part of the name, so two apps of
 * one system never carry the same one.
 */
export function chooseAppVersion(apps: readonly RootApp[], existing: unknown): AppVersionChoice {
  if (apps.length === 0) return { value: null, why: 'no-app' }
  const versions = new Set(apps.map((app) => app.version))
  const [only] = versions
  if (versions.size === 1 && only !== null) return { value: only, why: 'single' }
  if (isReleaseVersion(existing) && apps.some((app) => app.version === existing)) return { value: existing, why: 'kept' }
  return { value: null, why: 'no-single-version' }
}

/** The systems that have an app at the root, each once, in code-unit order. */
export function rootSystems(apps: readonly RootApp[]): DriveSystem[] {
  return [...new Set(apps.map((app) => app.system))].sort() // the default order compares UTF-16 code units
}

// ---- the record's bytes (every writer: UTF-8 without a byte-order mark, LF; unknown fields kept; B.11)

/** The fields a writer of this shape owns; every other field of an existing record is kept, in its order. */
const OWNED_FIELDS: ReadonlySet<string> = new Set(['format', 'app_version', 'systems', 'files'])

/** What the helper records: the root's apps' version (or none), the systems with an app, and the recorded files. */
export interface DriveReleaseRecord {
  appVersion: string | null
  systems: readonly string[]
  files: ReadonlyArray<{ path: string; sha256: string }>
}

/**
 * The record's text: `format`, `app_version` (omitted when null), `systems`, `files`, then every kept field of an
 * existing record (`kept`, its own entries in `JSON.parse`'s order; owned names among them are dropped), two-space
 * indent, LF, one LF at the end, no byte-order mark. The top level is written field by field, so the owned fields come
 * first even when a kept field's name is a number, and an own `__proto__` field stays a field. Null when the text would
 * be larger than release 1 reads (B.11). Throws when a kept value is nested too deep to write.
 */
export function serializeDriveRelease(record: DriveReleaseRecord, kept: ReadonlyArray<readonly [string, unknown]> = []): string | null {
  const fields: Array<readonly [string, unknown]> = [['format', DRIVE_RELEASE_FORMAT]]
  if (record.appVersion !== null) fields.push(['app_version', record.appVersion])
  fields.push(['systems', [...record.systems]], ['files', record.files.map((f) => ({ path: f.path, sha256: f.sha256 }))])
  for (const field of kept) if (!OWNED_FIELDS.has(field[0])) fields.push(field)
  const body = fields.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`)
  const text = `{\n${body.join(',\n')}\n}\n`
  return Buffer.byteLength(text, 'utf8') > DRIVE_RELEASE_MAX_BYTES ? null : text
}
