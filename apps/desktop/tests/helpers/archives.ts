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
