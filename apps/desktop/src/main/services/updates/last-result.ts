// `<drive>/updates/last-result.txt` (app-update F-20's grammar, table B.2; docs/app-updates.md §4.5 "The cleared line",
// §5.3, §5.8; CF-53): the small reader and appender the commit uses for its `cleared` line, in the module P7 extends and
// never copies. The file is append-only for ever: release 1's app, its start files, every apply script and every later
// version write to it, nothing deletes or shortens it, and the last valid line decides.
//
// The read: never through a link (`lstat`: absent, or a regular file with one name, else absent for this read; opened
// read-only, with O_NOFOLLOW and O_NONBLOCK on macOS and Linux, and checked on its descriptor: the same file, still with
// one name); its last 65,536 bytes, and when the file is longer everything up to and including the first LF in that
// window dropped; then G0's line rules: a line is the bytes between two LFs (the last may end without one), one CR at its
// end is removed first, a line holding a byte outside 0x20-0x7E and TAB or over 1,024 bytes is ignored, spaces and TABs
// are trimmed, empty lines skipped, fields split at runs of spaces and TABs; a valid line has at least three fields, a
// code `[a-z][a-z0-9-]{0,31}`, a SemVer version of at most 64 bytes and a token of 1 to 64 bytes. A read that fails
// means no mark (G0: absent for that read).
//
// The append (P6 writes `cleared` lines only): when the last valid line names the version byte for byte with a code
// outside `applied` and `cleared`, one write of LF, `cleared <v> <token>`, LF, to the file opened as update.log is (absent
// or a regular file with one name; append and create, O_NOFOLLOW and O_NONBLOCK on macOS and Linux; checked on its
// descriptor), then an fsync. The token is 16 lower-case hex characters from crypto.randomBytes(8), drawn again while it
// equals the last valid line's token or the token of `updates/last-result.seen`'s line (read by the same rules). A
// failed append answers its error, for the commit to refuse.
//
// What it does not do: on Windows, which has no O_NOFOLLOW, a link planted between the lstat and the open is followed;
// the descriptor check then refuses a file that is not the one the lstat saw. It holds no path in any answer and logs
// nothing. It takes the file-system calls from its caller (staging.ts hands its own), so a row can cause a failure.

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { parseSemver } from './version'
import type { ImportIoCause } from '../../../shared/updates/import-types'

/** The file's name in `updates/` (§5.2). */
export const LAST_RESULT_FILE = 'last-result.txt'
/** The line R1 last showed (§5.3 `last-result.seen`): its token is one the cleared line's token avoids. */
export const LAST_RESULT_SEEN_FILE = 'last-result.seen'
/** The window every reader takes from an append-only file (G0). */
export const LAST_RESULT_WINDOW_BYTES = 65_536

const LINE_MAX_BYTES = 1_024
const CODE = /^[a-z][a-z0-9-]{0,31}$/
const FIELD_MAX_BYTES = 64
/** The success set (§5.8): every other code marks its version "don't offer again". */
const SUCCESS_CODES: ReadonlySet<string> = new Set(['applied', 'cleared'])
const TOKEN_BYTES = 8

/** A valid line's first three fields (§5.3). */
export interface LastResultLine {
  readonly code: string
  readonly version: string
  readonly token: string
}

/** What an lstat or a descriptor's stat tells: the kinds, the size, and the identity (bigint, as Windows needs). */
export interface LastResultStats {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  readonly size: bigint
  readonly nlink: bigint
  readonly ino: bigint
  readonly dev: bigint
}

/** The calls made on an open file: the part of a node:fs/promises FileHandle used here. */
export interface LastResultFileHandle {
  stat(): Promise<LastResultStats>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

/** The file-system calls this module makes (staging.ts's StagingFileSystem holds them). */
export interface LastResultFileSystem {
  lstat(path: string): Promise<LastResultStats>
  open(path: string, flags: number | string): Promise<LastResultFileHandle>
}

/** O_NOFOLLOW (a link at the name fails the open) and O_NONBLOCK (a pipe there cannot hold it) on macOS and Linux. */
const posixFlags = (platform: NodeJS.Platform): number => (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

/** The thrown value's own `code` and `syscall`, each only when it is a string. */
function causeOf(error: unknown): ImportIoCause {
  const field = (key: string): string | null => {
    const value = typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' ? value : null
  }
  return { code: field('code'), syscall: field('syscall') }
}

/** One line by G0's rules and §5.3's, or null: one CR at its end removed first, then the byte and length rules. */
function parseLine(raw: Buffer): LastResultLine | null {
  const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw
  if (line.length > LINE_MAX_BYTES) return null
  for (const byte of line) if (byte !== 0x09 && (byte < 0x20 || byte > 0x7e)) return null
  const text = line.toString('latin1').replace(/^[ \t]+|[ \t]+$/g, '')
  if (text === '') return null
  const fields = text.split(/[ \t]+/)
  if (fields.length < 3) return null
  const [code, version, token] = fields as [string, string, string]
  if (!CODE.test(code) || version.length > FIELD_MAX_BYTES || parseSemver(version) === null || token.length > FIELD_MAX_BYTES) return null
  return { code, version, token }
}

/**
 * The last valid line of the bytes a read took (`window`: the file's last 65,536 bytes; `cut`: the file is longer, so
 * everything up to and including the window's first LF is dropped), or null.
 */
function lastValidLineOf(window: Buffer, cut: boolean): LastResultLine | null {
  let bytes = window
  if (cut) {
    const lf = bytes.indexOf(0x0a)
    if (lf < 0) return null
    bytes = bytes.subarray(lf + 1)
  }
  let last: LastResultLine | null = null
  for (let start = 0; start <= bytes.length; ) {
    const lf = bytes.indexOf(0x0a, start)
    const end = lf < 0 ? bytes.length : lf
    last = parseLine(bytes.subarray(start, end)) ?? last
    if (lf < 0) break
    start = lf + 1
  }
  return last
}

/** The same file the lstat saw (device and file id), a regular file, still with one name. */
const sameFile = (named: LastResultStats, opened: LastResultStats): boolean =>
  opened.isFile() && opened.nlink <= 1n && opened.ino === named.ino && opened.dev === named.dev

async function closeQuietly(handle: LastResultFileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // The answer is already decided.
  }
}

/**
 * The last valid line of the file at `path` (`last-result.txt`, or `last-result.seen` read by the same rules), or null:
 * no file, a link, a file with a second name or anything but a regular file at the name, no valid line, or a read that
 * failed. Never throws.
 */
export async function readLastValidLine(path: string, fs: LastResultFileSystem, platform: NodeJS.Platform): Promise<LastResultLine | null> {
  let handle: LastResultFileHandle
  let named: LastResultStats
  try {
    named = await fs.lstat(path)
    if (named.isSymbolicLink() || !named.isFile() || named.nlink > 1n) return null
    handle = await fs.open(path, constants.O_RDONLY | posixFlags(platform))
  } catch {
    return null
  }
  try {
    const opened = await handle.stat()
    if (!sameFile(named, opened)) return null
    const size = Number(opened.size)
    const window = Buffer.alloc(Math.min(LAST_RESULT_WINDOW_BYTES, size))
    let got = 0
    while (got < window.length) {
      const { bytesRead } = await handle.read(window, got, window.length - got, size - window.length + got)
      if (!(bytesRead > 0)) break
      got += bytesRead
    }
    return lastValidLineOf(window.subarray(0, got), size > LAST_RESULT_WINDOW_BYTES)
  } catch {
    return null
  } finally {
    await closeQuietly(handle)
  }
}

/** Whether `line` marks `version` (§4.5 "Marks <v>"): its version equals it byte for byte and its code is no success. */
export function marksVersion(line: LastResultLine | null, version: string): boolean {
  return line !== null && line.version === version && !SUCCESS_CODES.has(line.code)
}

/** The commit's step's answer: nothing marked, the line appended (with its token), or the append that failed. */
export type ClearEnd =
  | { readonly kind: 'not-marked' }
  | { readonly kind: 'cleared'; readonly token: string }
  | { readonly kind: 'failed'; readonly cause: ImportIoCause | null }

/** A failure that threw nothing (a write that moved fewer bytes, a file that is not the one the lstat saw). */
const NOTHING_THROWN = Symbol('nothing thrown')

/** One append of `bytes` to the file at `path`, opened as update.log is, then an fsync. Throws on any failure. */
async function appendOnce(path: string, bytes: Buffer, fs: LastResultFileSystem, platform: NodeJS.Platform): Promise<void> {
  let named: LastResultStats | null
  try {
    named = await fs.lstat(path)
  } catch (error) {
    if (causeOf(error).code !== 'ENOENT') throw error
    named = null
  }
  if (named !== null && (named.isSymbolicLink() || !named.isFile() || named.nlink > 1n)) throw NOTHING_THROWN
  const handle = await fs.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | posixFlags(platform))
  try {
    const opened = await handle.stat()
    if (named !== null ? !sameFile(named, opened) : !opened.isFile() || opened.nlink > 1n) throw NOTHING_THROWN
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length)
    if (bytesWritten !== bytes.length) throw NOTHING_THROWN
    await handle.sync()
  } finally {
    await closeQuietly(handle)
  }
}

/**
 * The commit's `cleared` step (§4.5 "The commit", "The cleared line"; §5.7 "A re-import clears the mark"): when
 * `updates/last-result.txt` in `updatesDir` marks `version`, appends `cleared <version> <token>`; else appends nothing.
 * A read that finds no mark (no file, a link, a second name, a read that failed for a moment) appends nothing: the update
 * can then stay marked until a later re-import (a recorded limit). Never throws.
 */
export async function clearMarkOf(updatesDir: string, version: string, fs: LastResultFileSystem, platform: NodeJS.Platform): Promise<ClearEnd> {
  const file = join(updatesDir, LAST_RESULT_FILE)
  const last = await readLastValidLine(file, fs, platform)
  if (!marksVersion(last, version)) return { kind: 'not-marked' }
  const seen = await readLastValidLine(join(updatesDir, LAST_RESULT_SEEN_FILE), fs, platform)
  const avoid = new Set([last!.token, ...(seen === null ? [] : [seen.token])])
  let token = randomBytes(TOKEN_BYTES).toString('hex')
  while (avoid.has(token)) token = randomBytes(TOKEN_BYTES).toString('hex')
  try {
    await appendOnce(file, Buffer.from(`\ncleared ${version} ${token}\n`, 'latin1'), fs, platform)
    return { kind: 'cleared', token }
  } catch (error) {
    return { kind: 'failed', cause: error === NOTHING_THROWN ? null : causeOf(error) }
  }
}
