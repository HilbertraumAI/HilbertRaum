// Archive writers, so a test can build the zip or tar.gz it needs in code instead of committing a binary fixture: a STORED
// zip (the .docx fixtures, the Windows runtime builds) and a ustar .tar.gz (the macOS/Linux runtime builds). Both are small
// on purpose and need no npm dependency; each reads back with the real tools (mammoth, unzip, Expand-Archive, GNU tar,
// bsdtar).
import { gzipSync } from 'node:zlib'

function crc32(buf: Buffer): number {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (~crc) >>> 0
}

export interface ZipEntry {
  name: string
  data: Buffer
}

/** Write a ZIP archive using the STORED (no compression) method. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = stored
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18) // compressed size
    local.writeUInt32LE(e.data.length, 22) // uncompressed size
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    locals.push(local, name, e.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centrals.push(central, name)

    offset += local.length + name.length + e.data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const centralSize = centralBuf.length
  const centralOffset = offset

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, end])
}

/**
 * A zip whose central directory names `count` members of `sizeEach` uncompressed bytes each and holds none of their
 * data (#986): what the engine installer's room check reads (the directory alone), so a test can claim more than any
 * disk has free without writing it. Never extractable; an installer that refuses it for room never tries.
 */
export function makeSizeOnlyZip(count: number, sizeEach: number): Buffer {
  const centrals: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const name = Buffer.from(`part-${i}.bin`, 'utf8')
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(sizeEach, 20) // compressed size
    central.writeUInt32LE(sizeEach, 24) // uncompressed size
    central.writeUInt16LE(name.length, 28)
    centrals.push(central, name)
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(0, 16) // the directory starts the file
  return Buffer.concat([centralBuf, end])
}

/** One tar member: a file, a directory (`name` ends in `/`), or a symlink to `symlink` (relative to its own directory). */
export type TarEntry = { name: string; data: Buffer; mode?: number } | { name: string; dir: true } | { name: string; symlink: string }

/**
 * Write a gzipped ustar archive in the given member order, so a test can list a link before its target, as the llama.cpp
 * release tarballs do. Names stay under ustar's 100 bytes; nothing here needs the prefix field.
 */
export function makeTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const data = 'data' in e ? e.data : Buffer.alloc(0)
    const header = Buffer.alloc(512)
    const put = (s: string, at: number, len: number): void => void header.write(s, at, len, 'latin1')
    const octal = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`
    const mode = 'dir' in e ? 0o755 : 'symlink' in e ? 0o777 : (e.mode ?? 0o644)
    put(e.name, 0, 100)
    put(octal(mode, 8), 100, 8)
    put(octal(0, 8), 108, 8) // uid
    put(octal(0, 8), 116, 8) // gid
    put(octal(data.length, 12), 124, 12)
    put(octal(1_700_000_000, 12), 136, 12) // mtime
    put('        ', 148, 8) // the checksum is summed over spaces in its own field
    put('dir' in e ? '5' : 'symlink' in e ? '2' : '0', 156, 1)
    if ('symlink' in e) put(e.symlink, 157, 100)
    put('ustar\0', 257, 6)
    put('00', 263, 2)
    put(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `, 148, 8)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024)) // two zero blocks end the archive
  return gzipSync(Buffer.concat(blocks))
}

// ---- The byte-level ustar writer (app-update T6.0b; docs/app-updates.md §4.3, table A.2; F-16) ----------------------
// The update file is a strict subset of ustar, and release 1's reader is judged against files written here, byte by
// byte: good ones in the writer's own bytes (table A.2: not `makeTarGz`'s, whose mtime and missing devmajor/devminor
// are another archiver's) and hostile ones with any field set to anything. Nothing is gzipped and nothing streams; the
// 2 GiB file of the performance row is not built here. P5's release writer is never used for a golden (plan C14).

/** Each ustar header field's offset and length. `padding` is bytes 500–511. */
export const USTAR_FIELDS = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  checksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
  padding: [500, 12]
} as const satisfies Record<string, readonly [number, number]>
export type UstarField = keyof typeof USTAR_FIELDS

/**
 * What a header holds. A field left out takes the writer's own bytes (table A.2); one given is written as is at the
 * field's start, the rest of the field NUL (a string is latin1 text). `size` may be a number: 11 octal digits and NUL.
 * A `checksum` left out is computed last, over the header as written; one given is written as is, right or wrong.
 */
export type UstarHeaderFields = { [F in Exclude<UstarField, 'size'>]?: Buffer | string } & { size?: Buffer | string | number }

/** The writer's bytes for the fields the reader ignores, the type and the magic (record §4.3, "Ignored fields"). */
const USTAR_WRITER_BYTES: { [F in UstarField]?: string } = {
  mode: '0000644\0',
  uid: '0000000\0',
  gid: '0000000\0',
  mtime: '00000000000\0',
  typeflag: '0',
  magic: 'ustar\0',
  version: '00',
  devmajor: '0000000\0',
  devminor: '0000000\0'
}

/** The unsigned sum of a header's 512 bytes with the checksum field counted as eight spaces. */
export function ustarChecksum(header: Buffer): number {
  const [at, length] = USTAR_FIELDS.checksum
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= at && i < at + length ? 0x20 : header[i]
  return sum
}

/** One 512-byte header. Throws when a value is longer than its field. */
export function ustarHeader(fields: UstarHeaderFields): Buffer {
  const header = Buffer.alloc(512)
  const put = (field: UstarField, value: Buffer | string): void => {
    const [at, length] = USTAR_FIELDS[field]
    const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value
    if (bytes.length > length) throw new Error(`ustar ${field}: ${bytes.length} bytes do not fit its ${length}`)
    header.fill(0, at, at + length)
    bytes.copy(header, at)
  }
  for (const [field, value] of Object.entries(USTAR_WRITER_BYTES) as Array<[UstarField, string]>) put(field, value)
  for (const [field, value] of Object.entries(fields) as Array<[UstarField, Buffer | string | number | undefined]>) {
    if (value === undefined || field === 'checksum') continue
    put(field, typeof value === 'number' ? `${value.toString(8).padStart(11, '0')}\0` : value)
  }
  put('checksum', fields.checksum ?? `${ustarChecksum(header).toString(8).padStart(6, '0')}\0 `)
  return header
}

/** A member: its header (the size is the data's unless given), the data, then zero bytes to a multiple of 512 or `pad` as is. */
export function ustarMember(fields: UstarHeaderFields, data: Buffer, pad?: Buffer): Buffer {
  return Buffer.concat([ustarHeader({ size: data.length, ...fields }), data, pad ?? Buffer.alloc((512 - (data.length % 512)) % 512)])
}

/** The reserved first 8 bytes of a future container (record §4.3, "The reserved prefix"). */
export const HRUPDATE_PREFIX = Buffer.from('HRUPDATE', 'latin1')

export interface UstarFileParts {
  /** Bytes before the first header. */
  prefix?: Buffer
  /** Members and raw blocks, written in order as they are. */
  members: Buffer[]
  /** The end: two zero blocks (the default), one, or none. */
  end?: 'two' | 'one' | 'none'
  /** Bytes after the end. */
  after?: Buffer
  /** Every byte from this offset on is set to zero (a preallocated download that stopped there), before `cut`. */
  zeroFrom?: number
  /** Only the first `cut` bytes are kept. */
  cut?: number
}

/** A whole file from its parts, hostile ones included. */
export function makeUstarFile(parts: UstarFileParts): Buffer {
  const end = Buffer.alloc({ two: 1024, one: 512, none: 0 }[parts.end ?? 'two'])
  let file = Buffer.concat([parts.prefix ?? Buffer.alloc(0), ...parts.members, end, parts.after ?? Buffer.alloc(0)])
  if (parts.zeroFrom !== undefined) file.fill(0, Math.min(parts.zeroFrom, file.length))
  if (parts.cut !== undefined) file = file.subarray(0, parts.cut)
  return file
}
