// `config/kit-support.txt`: the month a Kit's support period ends (app-update plan W-17, G-13 (b); F-13,
// docs/app-updates.md §8.4, §5.9 "Support end"). Only the Kit builder writes it, once per Kit, through
// scripts/lib/write-kit-support.mjs, which loads this file through Node's own type stripping; so it imports only `node:`
// built-ins and holds only TypeScript that stripping can erase (no `enum`, no namespace, no parameter property). Release 1
// and every later version read it on every Kit for ever, so the read half is frozen: `readKitSupport`, its result shape
// and what it accepts. The golden is tests/fixtures/readers/f13-drive-release/kit-support.json.
//
// What the builder writes: the month as `YYYY-MM` (ISO 8601's calendar month, ASCII digits, a month 01-12) and one LF,
// 8 bytes, no byte-order mark. What a reader accepts, so that an owner's later hand edit (Notepad's CR LF or byte-order
// mark) still reads: a regular file of at most 64 bytes holding one leading byte-order mark or none, then the month, then
// nothing, one LF or one CR LF. Anything else is damaged and is never guessed at. The reader checks the form only, never a
// range: what a past month means is the support computation's (F-12, P6).
//
// The reader logs nothing, caches nothing and never throws. Nothing in the app writes this file.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** Where the stamp lives, from the drive root. */
export const KIT_SUPPORT_REL = 'config/kit-support.txt'

/** The largest stamp a reader reads: a larger file is damaged, so no reader takes an arbitrary file into memory. */
const KIT_SUPPORT_MAX_BYTES = 64

/** Why a stamp that is there is no month this reader can read. */
export type KitSupportFault = 'not-a-file' | 'empty' | 'too-large' | 'not-a-month'

/**
 * What is at `config/kit-support.txt` (frozen, F-13):
 *  - `absent`: no file (ENOENT, ENOTDIR): a DIY drive, or a Kit built before the stamp existed;
 *  - `unreadable`: it is there, but the read failed just now; `code` is the errno token, validated as one, never the
 *    message, which names the path;
 *  - `damaged`: it is there but holds no month this reader can read (shown as `unreadable`, record §5.9);
 *  - `month`: the support end, `YYYY-MM`.
 */
export type KitSupportRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; code: string | null }
  | { kind: 'damaged'; fault: KitSupportFault }
  | { kind: 'month'; month: string }

/** A month exactly as the stamp holds it: `YYYY-MM`, 7 ASCII characters, a month 01-12. Never trimmed. */
const MONTH = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/

/** Whether `value` is a month as the stamp holds it (`YYYY-MM`, ASCII digits, 01-12), matched whole, never trimmed. */
export function isSupportMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH.test(value)
}

/** The builder's bytes for a month: `YYYY-MM` and one LF, 8 bytes, no byte-order mark. */
export function formatKitSupport(month: string): string {
  return `${month}\n`
}

/** The month a stamp's bytes hold, or why they hold none: one leading byte-order mark or none, the month, then nothing, LF or CR LF. */
function parseKitSupport(bytes: Buffer): string | KitSupportFault {
  if (bytes.length === 0) return 'empty'
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  // latin1 maps each byte to one character, so a byte outside ASCII can never pass for a digit.
  const text = bytes.subarray(bom ? 3 : 0).toString('latin1')
  const line = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text
  return isSupportMonth(line) ? line : 'not-a-month'
}

/** The errno code of a failed read (`ENOENT`, `EACCES`, …), validated as one: never the message, which names the path. */
function errnoToken(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null
}

/** A failed `lstat` or read: not there at all, or there but not readable just now. */
function readFailure(err: unknown): KitSupportRead {
  const code = errnoToken(err)
  return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable', code }
}

/** Read only; on POSIX also O_NOFOLLOW and O_NONBLOCK, as the record's reader opens (drive-release.ts). */
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

/**
 * What the drive at `rootPath` holds at `config/kit-support.txt` (F-13). Sync, never throws, no cache, logs nothing.
 * One `lstat` first: anything but a regular file at the name is damaged and never opened or followed (a link to a stamp
 * included; a pipe would block the main thread). A `config/` that is itself a link is followed, as the record's reader
 * follows it. Larger than 64 bytes is damaged and never opened; what was opened is checked again on its descriptor, and
 * a file that grew since is read to one byte past the limit and is damaged too.
 */
export function readKitSupport(rootPath: string): KitSupportRead {
  const path = join(rootPath, ...KIT_SUPPORT_REL.split('/'))
  let fd: number
  try {
    const info = lstatSync(path)
    if (!info.isFile()) return { kind: 'damaged', fault: 'not-a-file' }
    if (info.size === 0) return { kind: 'damaged', fault: 'empty' }
    if (info.size > KIT_SUPPORT_MAX_BYTES) return { kind: 'damaged', fault: 'too-large' }
    fd = openSync(path, OPEN_FLAGS)
  } catch (err) {
    return readFailure(err)
  }
  const buffer = Buffer.alloc(KIT_SUPPORT_MAX_BYTES + 1)
  let length = 0
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'damaged', fault: 'not-a-file' }
    for (let n = 1; n > 0 && length < buffer.length; length += n) n = readSync(fd, buffer, length, buffer.length - length, length)
  } catch (err) {
    return readFailure(err)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // The read's answer stands: closing a descriptor opened for reading loses nothing when the close fails.
    }
  }
  if (length > KIT_SUPPORT_MAX_BYTES) return { kind: 'damaged', fault: 'too-large' }
  const parsed = parseKitSupport(buffer.subarray(0, length))
  return isSupportMonth(parsed) ? { kind: 'month', month: parsed } : { kind: 'damaged', fault: parsed as KitSupportFault }
}
