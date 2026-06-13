import {
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { encrypt, decrypt, serializeBlob, deserializeBlob } from './security/crypto'
import { shredFile } from './workspace-vault'

// Local-only rotating logger (spec §7.11 — diagnostics logs stay on device, never uploaded).
//
// app.log can carry file names/paths and model ids (never document or chat text — that is a
// hard rule, enforced at call sites), so on an ENCRYPTED workspace the log is encrypted at
// rest exactly like the database and the document cache (spec §3.5). On a plaintext_dev
// workspace the log stays a plain rotating file (matching the unencrypted dev DB).
//
// The wrinkle is timing: logging starts at app launch, BEFORE the vault is unlocked, so the
// key does not exist yet (startup, policy load, and the unlock attempts themselves all log).
// We therefore BUFFER every line in memory from the start. When the workspace resolves we
// either:
//   - call `attachVaultKey(key)` (encrypted unlock/create) → flush the buffer into
//     `app.log.enc` and keep writing encrypted; or
//   - call `usesPlaintextLog()` (plaintext_dev) → flush the buffer into a plain `app.log`
//     and keep appending in plaintext.
// Until one of those is called nothing touches disk — pre-unlock lines live only in memory
// and are lost if the app is killed while still locked (an accepted trade for "no sensitive
// bytes on disk before the user has authenticated"). The same is true of a session spent
// entirely at the unlock gate (never unlocked): it stays in `buffering` and is discarded on
// quit, by the same trade.
//
// DURABILITY (encrypted mode): to avoid re-encrypting ~1 MB on every info/warn line, only an
// `error` line forces an immediate flush; info/warn ride the next error, a rotation, or the
// lock/quit flush. A `lock()`/quit (or an uncaughtException) flushes via detachVaultKey, but
// a hard kill (SIGKILL, OOM, power loss, drive removal) loses the info/warn accumulated since
// the last flush — wider than the pre-unlock window above, and the price of not thrashing the
// drive on the hot path.
//
// ROTATION keeps ONE prior generation: at MAX_BYTES the buffer is sealed to `app.1.log.enc`
// and the live buffer/`app.log.enc` reset. `app.1.log.enc` is recovery-only — readLogTail and
// loadEncrypted read only the live `.enc`/buffer, so the Diagnostics tail shows the current
// generation. This mirrors the plaintext rotation (the tail reads only `app.log`).

type Level = 'info' | 'warn' | 'error'

const MAX_BYTES = 1_000_000 // rotate at ~1 MB
/** Hard cap on the in-memory buffer so a chatty session can't grow it without bound. Set
 *  above MAX_BYTES so the encrypted log can actually ROTATE at MAX_BYTES (a generation is
 *  moved to `app.1.log.enc`) before the cap ever drops lines; the cap is only the backstop
 *  for the pre-unlock window, where rotation can't run (no key yet). */
const BUFFER_MAX_BYTES = 2 * MAX_BYTES

let logDir: string | null = null
/** Plaintext log path — used only on a plaintext_dev workspace. */
let plainLogFile: string | null = null
/** Encrypted-at-rest log path — used only on an encrypted workspace once unlocked. */
let encLogFile: string | null = null

type Mode = 'buffering' | 'plaintext' | 'encrypted'
let mode: Mode = 'buffering'

/** The vault key while an encrypted workspace is unlocked; null otherwise. Never persisted. */
let vaultKey: Buffer | null = null

/**
 * The full current-log text held in memory. The source of truth in `buffering` and
 * `encrypted` modes (the on-disk `.enc` is a snapshot of this); unused in `plaintext` mode
 * (the plain file is the source of truth there). Trimmed to BUFFER_MAX_BYTES on append.
 */
let buffer = ''

export function initLogging(directory: string): void {
  mkdirSync(directory, { recursive: true })
  logDir = directory
  plainLogFile = join(directory, 'app.log')
  encLogFile = join(directory, 'app.log.enc')
  mode = 'buffering'
  vaultKey = null
  buffer = ''
}

/** Drop whole lines from the FRONT of `text` until it is within `maxBytes` UTF-8 bytes, so the
 *  result never starts mid-line. Byte-based (not `.length`): a multibyte path/name is 1 char
 *  but several bytes, and the on-disk `.enc` and the pre-unlock backstop are byte budgets. */
function trimToByteCap(text: string, maxBytes: number): string {
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const cut = text.indexOf('\n')
    if (cut === -1) return '' // a single line longer than the cap: drop it whole
    text = text.slice(cut + 1)
  }
  return text
}

/** Append a finished line to the in-memory buffer, trimming to the size cap (drop oldest). */
function pushToBuffer(line: string): void {
  buffer += line
  buffer = trimToByteCap(buffer, BUFFER_MAX_BYTES)
}

/** Write `blob` to `path` atomically: temp file + fsync + rename. */
function writeFileAtomicSync(path: string, blob: Buffer): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, blob)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Encrypt `buffer` and write it to `app.log.enc` atomically (temp + fsync + rename). */
function persistEncrypted(): void {
  if (!encLogFile || !vaultKey) return
  try {
    writeFileAtomicSync(encLogFile, serializeBlob(encrypt(vaultKey, Buffer.from(buffer, 'utf8'))))
  } catch {
    /* never crash the app because logging failed */
  }
}

/** Decrypt an existing `app.log.enc` into `buffer`, or leave the buffer as-is on failure. */
function loadEncrypted(): void {
  if (!encLogFile || !vaultKey || !existsSync(encLogFile)) return
  try {
    const prior = decrypt(vaultKey, deserializeBlob(readFileSync(encLogFile))).toString('utf8')
    // Pre-unlock buffered lines (this session) come AFTER the persisted history. Trim on a
    // line boundary (not a raw byte slice) so the merged buffer never starts mid-line.
    buffer = trimToByteCap(prior + buffer, BUFFER_MAX_BYTES)
  } catch {
    /* a corrupt/foreign-key log is not recoverable — start fresh rather than throw */
  }
}

/**
 * The encrypted workspace just unlocked: adopt its key, fold any persisted history in with
 * this session's buffered lines, switch to encrypted mode, and flush. Called from the
 * unlock/create path. Re-callable after a lock (re-attaches the same or a new key).
 */
export function attachVaultKey(key: Buffer): void {
  if (!encLogFile) return
  vaultKey = key
  mode = 'encrypted'
  loadEncrypted()
  persistEncrypted()
  // Migration: an OLDER build (or a crash before this build's first lock) may have left a
  // plaintext `app.log`/`app.1.log` on an encrypted drive. Shred it now that the log is
  // encrypted — those diagnostics belong inside the vault, not beside it. Best-effort.
  if (plainLogFile && logDir) {
    shredFile(plainLogFile)
    shredFile(join(logDir, 'app.1.log'))
  }
}

/**
 * The workspace locked (or the app is quitting an encrypted vault): flush the buffer one last
 * time, then drop the key and fall back to in-memory buffering. The `.enc` file and the
 * in-memory buffer both survive, so a later re-unlock continues the same log.
 */
export function detachVaultKey(): void {
  if (mode === 'encrypted') persistEncrypted()
  vaultKey = null
  mode = 'buffering'
}

/**
 * A password change rotated the at-rest key (v1→v2 regenerates the data key; v2 keeps it).
 * Re-seal the SAME in-memory buffer under the now-current key — do NOT re-load from disk:
 * the buffer already holds the full session-plus-history log (loaded at unlock), so a
 * `loadEncrypted` here would either fail-and-discard under a rotated key, or succeed and
 * DOUBLE the history under an unchanged one. Must be called while still encrypted (the key
 * has changed underneath the controller, not been dropped). No-op off the encrypted path.
 */
export function rekeyVaultLog(key: Buffer): void {
  if (!encLogFile || mode !== 'encrypted') return
  vaultKey = key
  persistEncrypted()
}

/**
 * The workspace is plaintext_dev (no key will ever exist): flush the buffered lines into a
 * plain `app.log` and append in plaintext from here on. Matches the unencrypted dev DB.
 */
export function usesPlaintextLog(): void {
  if (!plainLogFile) return
  mode = 'plaintext'
  vaultKey = null
  try {
    rotatePlainIfNeeded()
    if (buffer.length > 0) appendFileSync(plainLogFile, buffer)
  } catch {
    /* best-effort flush of the pre-unlock buffer */
  }
  buffer = ''
}

function rotatePlainIfNeeded(): void {
  if (!plainLogFile || !logDir) return
  try {
    if (existsSync(plainLogFile) && statSync(plainLogFile).size > MAX_BYTES) {
      renameSync(plainLogFile, join(logDir, 'app.1.log'))
    }
  } catch {
    /* rotation is best-effort */
  }
}

/** Rotate the encrypted log: re-encrypt the current buffer to `app.1.log.enc`, then reset. */
function rotateEncryptedIfNeeded(): void {
  if (!encLogFile || !logDir || !vaultKey) return
  if (Buffer.byteLength(buffer, 'utf8') <= MAX_BYTES) return
  try {
    const blob = serializeBlob(encrypt(vaultKey, Buffer.from(buffer, 'utf8')))
    // Atomic, like persistEncrypted — a crash mid-write must not corrupt the rotated copy.
    writeFileAtomicSync(join(logDir, 'app.1.log.enc'), blob)
    buffer = ''
    // Drop the live `.enc`; the next persistEncrypted re-creates it from the empty buffer.
    if (existsSync(encLogFile)) rmSync(encLogFile, { force: true })
  } catch {
    /* rotation is best-effort */
  }
}

function write(level: Level, message: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${
    meta !== undefined ? ' ' + safeJson(meta) : ''
  }\n`
  // Always echo to the console for dev visibility.
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
  else console.log(line.trimEnd())

  if (mode === 'plaintext') {
    if (!plainLogFile) return
    rotatePlainIfNeeded()
    try {
      appendFileSync(plainLogFile, line)
    } catch {
      /* never crash the app because logging failed */
    }
    return
  }

  // buffering (pre-unlock) and encrypted both accumulate in memory.
  pushToBuffer(line)
  if (mode === 'encrypted') {
    rotateEncryptedIfNeeded()
    // Persist on every error so a crash keeps the failure; info/warn ride the next error,
    // a rotation, or the lock/quit flush (re-encrypting ~1 MB per info line is wasteful).
    if (level === 'error') persistEncrypted()
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  info: (m: string, meta?: unknown) => write('info', m, meta),
  warn: (m: string, meta?: unknown) => write('warn', m, meta),
  error: (m: string, meta?: unknown) => write('error', m, meta)
}

/**
 * The last `maxLines` lines of the local log, for the Diagnostics screen (spec §7.11
 * "show recent local logs"). Read-only, local-only, never uploaded. Reads the plain file in
 * plaintext mode; reads the in-memory buffer otherwise (the on-disk copy is encrypted).
 */
export function readLogTail(maxLines = 200): string[] {
  let text: string
  if (mode === 'plaintext') {
    if (!plainLogFile || !existsSync(plainLogFile)) return []
    try {
      text = readFileSync(plainLogFile, 'utf8')
    } catch {
      return []
    }
  } else {
    text = buffer
  }
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-maxLines)
}
