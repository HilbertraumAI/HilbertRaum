// The update file's reader (app-update W-5; F-16's reader side, G-5 (c); docs/app-updates.md §4.3, §4.4, §4.5, §4.7):
// release 1 reads every later update file with this code for ever. It runs the container's steps of the order of an
// update file's import (§4.5, its first row): the file's open (asynchronous, read-only, O_NONBLOCK on macOS and Linux, a regular file
// by fstat on the descriptor, its length fixed there), the `HRUPDATE` prefix, member 0's header, member 0 read whole and
// verified (verifyEnvelope, on this thread, CF-47), the payload (checkPayload, handed verifyEnvelope's own result in the
// same turn, CF-51), the header walk (one 512-byte read per header, no member data), and this system's apply script
// listed and present. Then, once the caller has passed its own checks (the path length, the staging folders, free space,
// the old-file question), the data pass: one sequential pass over the members, each header read again and compared with
// the walk's, each member written under its member name into the `.incoming-<v>/` folder the caller names (opened `wx`),
// hashed while it is written, its padding checked, fsynced, closed, and on a hash match moved under the same name into
// the `<v>/files/` folder the caller names. Every answer is a typed verdict of §4.7 and §5.8 (import-types.ts), never
// copy, never a path, never a throw for any bytes or any failing file-system call.
//
// What it does not do: the checks before the file dialog, the policy, the links rule under updates/, the path length,
// free space, the old-file stop, making or removing any folder, the commit and its markers, the sweep (the update service,
// T6.2); logging (the service writes the update.log line of each run from the facts each verdict carries). It writes nothing before the
// data pass, and in it only the members, under their names, directly inside the two folders it is handed; it never
// removes a folder (a member whose hash does not match is unlinked by its name; whatever a refusal or a cancel leaves in
// the two folders is the caller's to remove, §4.5 "A refusal or a cancel from the data pass on"). It never follows the
// update file's member names anywhere else: a name is used only after it matched a signed `files[]` name byte for byte,
// and every such name keeps the member-name rule (no separator, no `..`; member-name.ts, checked by payload.ts). It does
// not check that the picked file is the one the user meant, nor that nothing else changes the file while it is read: a
// file changed after the walk is refused where a read or a hash differs, and member 0 is read once, so the payload
// checked and the envelope kept are the bytes verified. The verification's cost on a hostile file is bounded by the
// envelope's caps (§4.5 "The verification's cost").
//
// The release tools' import-reader snapshot (W-53) loads this file through Node's own type stripping with the
// sibling-import hook (scripts/lib/ts-sibling-imports.mjs): so it imports only its siblings, types and node: built-ins,
// holds only TypeScript that stripping can erase (no `enum`, no namespace, no parameter property), and takes every
// host value as an argument: the key set, the payload check's input (the system, the clock and the rest), the cancel
// and progress hooks, and the file-system calls (the service hands it node:fs/promises and fs-retry.ts's rename).

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { ENVELOPE_MAX_BYTES, verifyEnvelope } from './envelope'
import type { UpdateKey } from './envelope'
import { checkPayload } from './payload'
import type { PayloadInput } from './payload'
import { ENVELOPE_MEMBER_NAME, foldMemberName } from './member-name'
import type { AcceptedFile, AcceptedPayload, UpdateSystem } from '../../../shared/updates/types'
import type { ContainerEnd, ContainerRefusal, ImportIoCause, StagingEnd, StagingRefusal } from '../../../shared/updates/import-types'

/** The reserved first 8 bytes of a future container (§4.3, "The reserved prefix"): UPD-TOO-NEW before any header. */
export const UPDATE_FILE_PREFIX = 'HRUPDATE'

/** ustar's block (§4.3): each header, the unit of each member's padding, each of the two end blocks. */
export const BLOCK_BYTES = 512

/** P6's read size (§4.5 "Reads"): the data pass reads this much at a time into one reused buffer. */
export const READ_SLICE_BYTES = 1_048_576

/** The apply script this system's import needs listed and present, byte for byte (§4.4 "Names release 1 looks for"). */
export const APPLY_SCRIPT_NAMES: Readonly<Record<UpdateSystem, string>> = { win32: 'apply.cmd', darwin: 'apply.sh', linux: 'apply.sh' }

// ---- the header (§4.3, table A.2): each field's place

const NAME_LENGTH = 100
const SIZE_AT = 124
const SIZE_LENGTH = 12
const SIZE_DIGITS = 11
const CHECKSUM_AT = 148
const CHECKSUM_LENGTH = 8
const CHECKSUM_DIGITS = 7
const TYPE_AT = 156
const REGULAR_FILE = 0x30 // `0`
const LINK_NAME: readonly [number, number] = [157, 257]
/** `ustar` NUL, then the version `00`: bytes 257 to 264. */
const MAGIC_AT = 257
const MAGIC = Buffer.from('ustar\u{0}00', 'latin1')
const PREFIX: readonly [number, number] = [345, 500]
const MEMBER_ZERO_NAME = Buffer.from(ENVELOPE_MEMBER_NAME, 'latin1')

const isOctalDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x37
const isNulOrSpace = (byte: number): boolean => byte === 0x00 || byte === 0x20

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false
  return true
}

/** A member's bytes and its zero padding: its size rounded up to whole blocks. */
const padded = (size: number): number => Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES

/**
 * A numeric field's value (§4.3 "Checksum", "Size"), or null: 1 to `digits` octal digits from the field's first byte,
 * then only NUL or space bytes to its end (no leading space, no sign, no base-256 form).
 */
function octalField(block: Uint8Array, at: number, length: number, digits: number): number | null {
  let value = 0
  let i = at
  for (; i < at + length && isOctalDigit(block[i]); i++) value = value * 8 + (block[i] - 0x30)
  if (i === at || i - at > digits) return null
  for (; i < at + length; i++) if (!isNulOrSpace(block[i])) return null
  return value
}

/** The unsigned sum of the header's 512 bytes with the checksum field counted as eight spaces (§4.3 "Checksum"). */
function headerSum(block: Uint8Array): number {
  let sum = CHECKSUM_LENGTH * 0x20
  for (let i = 0; i < BLOCK_BYTES; i++) if (i < CHECKSUM_AT || i >= CHECKSUM_AT + CHECKSUM_LENGTH) sum += block[i]
  return sum
}

interface Header {
  /** The name field's bytes before its first NUL, one character per byte. */
  readonly name: string
  readonly size: number
}

/**
 * A header by §4.3's rows, in the order "Header check order" gives (magic and version, checksum, type, name, size), the
 * link name and the prefix checked with the name: the header, or the first check that fails (`field` for the type, the
 * name, the link name, the prefix and the size alike).
 */
function readHeader(block: Buffer): Header | 'magic' | 'checksum' | 'field' {
  for (let i = 0; i < MAGIC.length; i++) if (block[MAGIC_AT + i] !== MAGIC[i]) return 'magic'
  if (octalField(block, CHECKSUM_AT, CHECKSUM_LENGTH, CHECKSUM_DIGITS) !== headerSum(block)) return 'checksum'
  if (block[TYPE_AT] !== REGULAR_FILE) return 'field'
  let nameEnd = 0
  while (nameEnd < NAME_LENGTH && block[nameEnd] !== 0) nameEnd++
  if (nameEnd === NAME_LENGTH || !allZero(block, nameEnd, NAME_LENGTH)) return 'field'
  if (!allZero(block, LINK_NAME[0], LINK_NAME[1]) || !allZero(block, PREFIX[0], PREFIX[1])) return 'field'
  const size = octalField(block, SIZE_AT, SIZE_LENGTH, SIZE_DIGITS)
  if (size === null) return 'field'
  return { name: block.toString('latin1', 0, nameEnd), size }
}

/**
 * Whether a file shorter than one block is the start of a valid member-0 header (§4.7, row 1), tested on every byte it
 * holds, field by field: member 0's name and NULs to byte 99; the size and checksum fields the start of a value their
 * rows accept (octal digits from the first byte, then NUL or space bytes); the type `0`; the link name and the prefix
 * zero; the magic `ustar` NUL and the version `00`; the ignored fields anything. The checksum's sum is not computed.
 */
function isMemberZeroHeaderStart(bytes: Buffer): boolean {
  const n = bytes.length
  const exactly = (at: number, expected: Uint8Array): boolean => {
    for (let i = 0; i < expected.length && at + i < n; i++) if (bytes[at + i] !== expected[i]) return false
    return true
  }
  const zero = (from: number, to: number): boolean => allZero(bytes, from, Math.min(to, n))
  const octalStart = (at: number, length: number, digits: number): boolean => {
    const end = Math.min(at + length, n)
    let i = at
    while (i < end && isOctalDigit(bytes[i])) i++
    if (i - at > digits || (i === at && end > at)) return false
    for (; i < end; i++) if (!isNulOrSpace(bytes[i])) return false
    return true
  }
  return (
    exactly(0, MEMBER_ZERO_NAME) &&
    zero(MEMBER_ZERO_NAME.length, NAME_LENGTH) &&
    octalStart(SIZE_AT, SIZE_LENGTH, SIZE_DIGITS) &&
    octalStart(CHECKSUM_AT, CHECKSUM_LENGTH, CHECKSUM_DIGITS) &&
    (n <= TYPE_AT || bytes[TYPE_AT] === REGULAR_FILE) &&
    zero(LINK_NAME[0], LINK_NAME[1]) &&
    exactly(MAGIC_AT, MAGIC) &&
    zero(PREFIX[0], PREFIX[1])
  )
}

// ---- the file-system calls, handed in

/** The calls the reader makes on an open file: the part of a node:fs/promises FileHandle it uses. */
export interface BundleFileHandle {
  stat(): Promise<{ isFile(): boolean; readonly size: number }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

/**
 * The file-system calls the reader makes (the service hands it `fs.promises.open`, `renameWithRetry` of
 * services/fs-retry.ts, §4.5 "Moves", and `fs.promises.unlink`). `open` is given numeric flags for the update file
 * and `wx` for a member.
 */
export interface BundleFileSystem {
  open(path: string, flags: number | string): Promise<BundleFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface ReadOptions {
  /** The embedded key set (keys.ts's, parseKeySet's keys). */
  readonly keys: readonly UpdateKey[]
  /** The host the payload is checked on, read once per import (payload.ts); its `os` also names the apply script. */
  readonly input: PayloadInput
  readonly fs: BundleFileSystem
  /** Asked at each check point between two checks (§3.5 updates:cancel); true ends the read as `cancelled`. */
  readonly cancelled: () => boolean
}

export interface StageOptions {
  /** `updates/staging/.incoming-<v>/`, made and checked by the caller: each member is written here under its name. */
  readonly incomingDir: string
  /** `updates/staging/<v>/files/`, made and checked by the caller: a member whose hash matches is moved here. */
  readonly filesDir: string
  /** Asked before each member and after each slice (§3.5 updates:cancel); true ends the data pass as `cancelled`. */
  readonly cancelled: () => boolean
  /** Told the bytes staged so far after each slice is written (§4.5 "Progress"; of `totalBytes`). */
  readonly progress: (doneBytes: number) => void
}

/** An update file whose container, envelope and payload passed, open for the data pass. */
export interface CheckedUpdateFile {
  readonly payload: AcceptedPayload
  /** Member 0's bytes as read and verified: the commit keeps them as `hilbertraum-release.dsse.json` (§4.2). */
  readonly envelope: Buffer
  /** The `files[]` members the header walk found, in `files[]` order (the path length's, free space's and staging's). */
  readonly present: readonly AcceptedFile[]
  /** The sum of their sizes: the progress total (§4.5 "Progress"). */
  readonly totalBytes: number
  /** The data pass, once, before `close`. */
  stage(options: StageOptions): Promise<StagingEnd>
  /** Closes the update file; the caller calls it once it is done with the file, whatever the data pass answered. */
  close(): Promise<void>
}

export type UpdateFileRead = { readonly kind: 'checked'; readonly file: CheckedUpdateFile } | ContainerEnd

// ---- reads and writes

/** Reads `length` bytes at `position` into `buffer` (more calls when one returns less); false when the file ends first. */
async function readFully(handle: BundleFileHandle, buffer: Buffer, length: number, position: number): Promise<boolean> {
  let got = 0
  while (got < length) {
    const { bytesRead } = await handle.read(buffer, got, length - got, position + got)
    if (!(bytesRead > 0)) return false
    got += bytesRead
  }
  return true
}

/** Writes `length` bytes of `buffer` (more calls when one writes less); false when a call writes nothing. */
async function writeFully(handle: BundleFileHandle, buffer: Buffer, length: number): Promise<boolean> {
  let written = 0
  while (written < length) {
    const { bytesWritten } = await handle.write(buffer, written, length - written)
    if (!(bytesWritten > 0)) return false
    written += bytesWritten
  }
  return true
}

async function closeQuietly(handle: BundleFileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Nothing more to do with this handle; the verdict is already decided.
  }
}

/** The thrown value's own `code` and `syscall`, each only when it is a string (update.log's `err` and `syscall`). */
function causeOf(error: unknown): ImportIoCause {
  const field = (key: string): string | null => {
    const value = typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' ? value : null
  }
  return { code: field('code'), syscall: field('syscall') }
}

/** A failure of the update file's own read in the data pass, told apart from the drive's (§4.5 "Errors while staging"). */
interface UpdateFileFailure {
  readonly updateFile: unknown
}
async function fromUpdateFile<T>(read: Promise<T>): Promise<T> {
  try {
    return await read
  } catch (error) {
    throw { updateFile: error } as UpdateFileFailure
  }
}
const isUpdateFileFailure = (value: unknown): value is UpdateFileFailure => typeof value === 'object' && value !== null && Object.hasOwn(value, 'updateFile')

/** A drive's write, move or remove error (§4.5 "Errors while staging"): ENOSPC, EFBIG, or any other. */
function driveRefusal(cause: ImportIoCause): StagingRefusal {
  if (cause.code === 'ENOSPC') return { code: 'UPD-DRIVE-FULL', params: { requiredBytes: null, freeBytes: null } }
  if (cause.code === 'EFBIG') return { code: 'UPD-FILE-TOO-BIG-FOR-DRIVE', params: {} }
  return { code: 'UPD-CANT-WRITE-DRIVE', params: {} }
}

// ---- the header walk (§4.3 "The header walk", §4.7)

interface WalkedMember {
  readonly file: AcceptedFile
  readonly headerAt: number
  /** The header as the walk read it: the data pass reads it again and compares (§4.3 "Then the data pass"). */
  readonly header: Buffer
}

/** Whether a member without a group is missing, or a group is partly present (§4.3 "Members after member 0"). */
function lacksMembers(files: readonly AcceptedFile[], seen: ReadonlySet<string>): boolean {
  const groups = new Map<string, { listed: number; seen: number }>()
  for (const file of files) {
    const present = seen.has(foldMemberName(file.name))
    if (file.group === null) {
      if (!present) return true
      continue
    }
    const group = groups.get(file.group) ?? { listed: 0, seen: 0 }
    group.listed++
    if (present) group.seen++
    groups.set(file.group, group)
  }
  for (const group of groups.values()) if (group.seen > 0 && group.seen < group.listed) return true
  return false
}

/**
 * Every header after member 0, by seeking (one block per member, no member data), up to the end: member 0's padding
 * first, then each header by §4.3's checks, the members against `files[]` (listed byte for byte, at most once after the
 * fold, the header size the listed size), the end against the file's length. The first failing check in file order
 * decides (§4.7): the file ending before a header, inside a member or before the two zero blocks is
 * UPD-DOWNLOAD-INCOMPLETE, and so is a zero block where a header should be while a member is missing, unless it starts a
 * complete end (exactly two zero blocks that end at the file's length); a complete end with a member missing, a zero
 * block followed by one that is not zero, bytes after the end and any other failure are UPD-FILE-DAMAGED.
 */
async function walkHeaders(
  handle: BundleFileHandle,
  length: number,
  envelopeSize: number,
  files: readonly AcceptedFile[]
): Promise<{ readonly members: WalkedMember[] } | { readonly refusal: ContainerRefusal }> {
  const damaged = { refusal: { code: 'UPD-FILE-DAMAGED', params: {} } } as const
  const incomplete = { refusal: { code: 'UPD-DOWNLOAD-INCOMPLETE', params: {} } } as const
  const padding = Buffer.alloc(padded(envelopeSize) - envelopeSize)
  if (!(await readFully(handle, padding, padding.length, BLOCK_BYTES + envelopeSize)) || !allZero(padding, 0, padding.length)) return damaged
  const listed = new Map(files.map((file) => [file.name, file]))
  const seen = new Set<string>()
  const members: WalkedMember[] = []
  const block = Buffer.alloc(BLOCK_BYTES)
  let at = BLOCK_BYTES + padded(envelopeSize)
  for (;;) {
    if (length - at < BLOCK_BYTES) return incomplete
    if (!(await readFully(handle, block, BLOCK_BYTES, at))) return damaged
    if (allZero(block, 0, BLOCK_BYTES)) {
      const lacking = lacksMembers(files, seen)
      if (at + 2 * BLOCK_BYTES > length) return incomplete
      if (!(await readFully(handle, block, BLOCK_BYTES, at + BLOCK_BYTES))) return damaged
      if (allZero(block, 0, BLOCK_BYTES) && at + 2 * BLOCK_BYTES === length) return lacking ? damaged : { members }
      return lacking ? incomplete : damaged
    }
    const header = readHeader(block)
    if (typeof header === 'string') return damaged
    const file = listed.get(header.name)
    const folded = foldMemberName(header.name)
    if (file === undefined || seen.has(folded) || header.size !== file.size) return damaged
    const next = at + BLOCK_BYTES + padded(header.size)
    if (next > length) return incomplete
    seen.add(folded)
    members.push({ file, headerAt: at, header: Buffer.from(block) })
    at = next
  }
}

// ---- the read: from the open to the apply script (§4.5's order)

/**
 * Opens the update file at `path` and runs §4.5's order from the file's open to this system's apply script. The answer
 * is `checked` (the file stays open for the data pass: the caller calls `close`), or the first refusal with what the
 * read had learned (the accepted payload, the payload check's `staleDriveVersion`), or `cancelled`. Never throws.
 */
export async function readUpdateFile(path: string, options: ReadOptions): Promise<UpdateFileRead> {
  const { keys, input, fs, cancelled } = options
  let payload: AcceptedPayload | null = null
  let staleDriveVersion: boolean | null = null
  const refuse = (refusal: ContainerRefusal, cause: ImportIoCause | null = null): UpdateFileRead => ({ kind: 'refused', refusal, cause, payload, staleDriveVersion })
  const stop = (): UpdateFileRead => ({ kind: 'cancelled', payload, staleDriveVersion })
  const tooNew = (): UpdateFileRead => refuse({ code: 'UPD-TOO-NEW', params: { runningVersion: input.runningVersion.text } })
  const damaged = (): UpdateFileRead => refuse({ code: 'UPD-FILE-DAMAGED', params: {} })
  const notAnUpdate = (): UpdateFileRead => refuse({ code: 'UPD-NOT-AN-UPDATE', params: {} })
  const incomplete = (): UpdateFileRead => refuse({ code: 'UPD-DOWNLOAD-INCOMPLETE', params: {} })
  let handle: BundleFileHandle | null = null
  let handedOn = false
  try {
    // The open (§4.5 "The update file's open"): asynchronous, read-only, O_NONBLOCK on macOS and Linux so a named pipe
    // at the name cannot hold it; a regular file by fstat on the descriptor; the length is the descriptor's now.
    handle = await fs.open(path, input.os === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK)
    const stats = await handle.stat()
    if (!stats.isFile()) return notAnUpdate()
    const length = stats.size
    if (cancelled()) return stop()

    // The prefix and member 0's header (§4.3 "The reserved prefix", "Header check order", "Member 0"; §4.7 rows 1–4).
    const first = Buffer.alloc(Math.min(BLOCK_BYTES, length))
    if (!(await readFully(handle, first, first.length, 0))) return damaged()
    if (length >= UPDATE_FILE_PREFIX.length && first.toString('latin1', 0, UPDATE_FILE_PREFIX.length) === UPDATE_FILE_PREFIX) return tooNew()
    if (length < BLOCK_BYTES) return isMemberZeroHeaderStart(first) ? incomplete() : notAnUpdate()
    const header = readHeader(first)
    if (header === 'checksum') return damaged()
    if (typeof header === 'string' || header.name !== ENVELOPE_MEMBER_NAME) return notAnUpdate()
    if (header.size > ENVELOPE_MAX_BYTES) return tooNew()
    if (BLOCK_BYTES + padded(header.size) > length) return incomplete()
    if (cancelled()) return stop()

    // Member 0, read whole and once, then verified before anything after it is read (§4.3 "Member 0", §2.3).
    const envelope = Buffer.alloc(header.size)
    if (!(await readFully(handle, envelope, header.size, BLOCK_BYTES))) return damaged()
    if (cancelled()) return stop()
    // CF-51: the payload check is handed verifyEnvelope's own result, in the same turn (no await between them).
    const verified = verifyEnvelope(envelope, keys, input.runningVersion.text)
    if (!verified.verified) return refuse(verified.refusal)
    const checked = checkPayload(verified, input)
    staleDriveVersion = checked.accepted ? checked.payload.flags.staleDriveVersion : checked.staleDriveVersion
    if (!checked.accepted) return refuse(checked.refusal)
    payload = checked.payload
    if (cancelled()) return stop()

    // The header walk (§4.3), then this system's apply script, listed and present (§4.4; a script of an absent group
    // does not count).
    const walked = await walkHeaders(handle, length, header.size, payload.files)
    if ('refusal' in walked) return refuse(walked.refusal)
    const script = APPLY_SCRIPT_NAMES[input.os]
    if (!walked.members.some((member) => member.file.name === script)) return refuse({ code: 'UPD-NO-HELPER', params: {} })
    if (cancelled()) return stop()

    handedOn = true
    return { kind: 'checked', file: checkedUpdateFile(handle, fs, payload, envelope, walked.members) }
  } catch (error) {
    // The update file's open, its fstat or a read failed (§4.5 "Errors while staging": a read error is UPD-CANT-READ-FILE).
    return refuse({ code: 'UPD-CANT-READ-FILE', params: {} }, causeOf(error))
  } finally {
    if (!handedOn && handle !== null) await closeQuietly(handle)
  }
}

// ---- the data pass (§4.5 "Where a member is written", "Moves", "Errors while staging"; §4.3 "Then the data pass")

function checkedUpdateFile(
  handle: BundleFileHandle,
  fs: BundleFileSystem,
  payload: AcceptedPayload,
  envelope: Buffer,
  members: readonly WalkedMember[]
): CheckedUpdateFile {
  const found = new Set(members.map((member) => member.file.name))
  const present = payload.files.filter((file) => found.has(file.name))
  let closed = false
  return {
    payload,
    envelope,
    present,
    totalBytes: present.reduce((sum, file) => sum + file.size, 0),
    stage: (options) => stageMembers(handle, fs, members, present, options),
    close: async () => {
      if (closed) return
      closed = true
      await closeQuietly(handle)
    }
  }
}

/**
 * One sequential pass over the members in file order: each header read again and compared with the walk's; each member
 * written to `<incomingDir>/<name>` (opened `wx`) a slice at a time, every slice hashed and written before the next is
 * read, its padding read and checked, fsynced and closed; on a hash match moved to `<filesDir>/<name>`, on a mismatch
 * unlinked and refused. Never throws: a failed read of the update file is UPD-CANT-READ-FILE, a failed write, move or
 * remove ENOSPC → UPD-DRIVE-FULL, EFBIG → UPD-FILE-TOO-BIG-FOR-DRIVE, any other → UPD-CANT-WRITE-DRIVE.
 */
async function stageMembers(
  handle: BundleFileHandle,
  fs: BundleFileSystem,
  members: readonly WalkedMember[],
  present: readonly AcceptedFile[],
  options: StageOptions
): Promise<StagingEnd> {
  const damaged: StagingEnd = { kind: 'refused', refusal: { code: 'UPD-FILE-DAMAGED', params: {} }, cause: null }
  const cancelled: StagingEnd = { kind: 'cancelled' }
  const slice = Buffer.allocUnsafe(READ_SLICE_BYTES)
  const header = Buffer.alloc(BLOCK_BYTES)
  let done = 0
  try {
    for (const member of members) {
      if (options.cancelled()) return cancelled
      if (!(await fromUpdateFile(readFully(handle, header, BLOCK_BYTES, member.headerAt))) || !header.equals(member.header)) return damaged
      const { name, size, sha256 } = member.file
      const incoming = join(options.incomingDir, name)
      const out = await fs.open(incoming, 'wx')
      let open = true
      try {
        const hash = createHash('sha256')
        let position = member.headerAt + BLOCK_BYTES
        for (let left = size; left > 0; ) {
          const n = Math.min(READ_SLICE_BYTES, left)
          if (!(await fromUpdateFile(readFully(handle, slice, n, position)))) return damaged
          hash.update(slice.subarray(0, n))
          if (!(await writeFully(out, slice, n))) return { kind: 'refused', refusal: { code: 'UPD-CANT-WRITE-DRIVE', params: {} }, cause: null }
          position += n
          left -= n
          done += n
          options.progress(done)
          if (options.cancelled()) return cancelled
        }
        const pad = padded(size) - size
        if (pad > 0 && (!(await fromUpdateFile(readFully(handle, slice, pad, position))) || !allZero(slice, 0, pad))) return damaged
        await out.sync()
        open = false
        await out.close()
        if (hash.digest('hex') !== sha256) {
          try {
            await fs.unlink(incoming)
          } catch {
            // Left for the caller's removal of .incoming-<v>/; the answer is the mismatch either way.
          }
          return damaged
        }
      } finally {
        if (open) await closeQuietly(out)
      }
      await fs.rename(incoming, join(options.filesDir, name))
    }
    return { kind: 'staged', files: present }
  } catch (error) {
    if (isUpdateFileFailure(error)) return { kind: 'refused', refusal: { code: 'UPD-CANT-READ-FILE', params: {} }, cause: causeOf(error.updateFile) }
    const cause = causeOf(error)
    return { kind: 'refused', refusal: driveRefusal(cause), cause }
  }
}
