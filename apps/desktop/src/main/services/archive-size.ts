import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'

// How much room an engine archive takes once unpacked (#986). The engine install checks it against
// the drive's free space before anything is touched, so a full drive refuses the install with the
// figure instead of failing half-way. Read from the verified archive itself, so the figure needs no
// manifest field and cannot go stale: a zip (the Windows release assets) lists every member's size in
// its central directory; a tar.gz (the macOS and Linux assets) is read through gunzip and its ustar
// headers summed. Measured on llama.cpp b11183's Windows Vulkan zip: the central directory's sum,
// 92,515,613 bytes in 52 files, is exactly what the extraction writes.
//
// Each file is rounded up to the volume's allocation unit (`clusterBytes`, statfs `bsize`): exFAT on a
// stick above 32 GB allocates 128 KiB per file, so a few hundred small files cost far more than their
// bytes. Each folder costs one unit. The answer is null, and the caller skips the check, when the
// archive is neither format or cannot be read to the end; a Zip64 archive (none of the pinned ones is
// one) is not read either.
//
// The same two readers list the archive's members (#998): every name that is not a folder, files and
// links alike, so the engine install can check that what the archive holds is what the extraction left
// (an antivirus can take a fresh file before the install is marked). A name that is not plain ASCII is
// not listed: how tar spells it on the disk (code page, normalisation) cannot be known here, and a
// listing that might name a file wrongly would refuse a good install. None of the pinned archives has one.

/** What one read of an archive found: its unpacked room, and its non-folder member names as written. */
interface ArchiveListing {
  bytes: number
  members: string[]
  /** #1045: each regular member's size in bytes, by its name as written (a later member of a name replaces it). */
  sizes: Map<string, number>
  /** False when a member name is not plain ASCII (the listing is then not used, `archiveMembers`). */
  plainNames: boolean
}

/** The room the archive at `path` takes unpacked on a volume with `clusterBytes` units, or null. */
export async function extractedArchiveBytes(path: string, clusterBytes: number): Promise<number | null> {
  const unit = Number.isFinite(clusterBytes) && clusterBytes > 0 ? clusterBytes : 4096
  return (await readArchive(path, unit))?.bytes ?? null
}

/**
 * Every member of the archive at `path` that is not a folder (#998): files, links and hard links, by the
 * name the archive gives them (`/` separators; a leading `./` and the release folder a flatten strips are
 * the caller's to map), without macOS metadata (`isMacMetadataName`). Null when the archive is neither
 * format, cannot be read to the end, is a Zip64 archive, or names a member in anything but plain ASCII: the
 * caller then skips its check.
 */
export async function archiveMembers(path: string): Promise<string[] | null> {
  const listing = await readArchive(path, 4096)
  return listing && listing.plainNames ? listing.members : null
}

/**
 * #1045 round 2: each regular member's size in bytes, by the name `archiveMembers` lists it under: a tar.gz's files
 * (ustar types `0` and `7`, a pax `size` taking precedence), a zip's every member that is not a folder (its central
 * directory names no kind). Links, hard links and folders have none; macOS metadata is left out as there. Null exactly
 * when `archiveMembers` is: the engine install's mend of a failed tar (`runtime-download.ts`) then does not run.
 */
export async function archiveMemberSizes(path: string): Promise<Map<string, number> | null> {
  const listing = await readArchive(path, 4096)
  return listing && listing.plainNames ? listing.sizes : null
}

async function readArchive(path: string, unit: number): Promise<ArchiveListing | null> {
  const head = await readHead(path)
  if (head === null) return null
  if (head[0] === 0x50 && head[1] === 0x4b) return zipListing(path, unit)
  if (head[0] === 0x1f && head[1] === 0x8b) return tarGzListing(path, unit)
  return null
}

/** Printable ASCII only: a name whose spelling on the disk this code can be sure of. */
const PLAIN_NAME = /^[\x20-\x7e]+$/

/**
 * macOS metadata, never an engine file (#998 round 1): an AppleDouble file (`._name`), anything under a
 * `__MACOSX/` folder, a Finder `.DS_Store`. macOS bsdtar reads the first two back into extended attributes
 * by default, so they never land on the disk there; elsewhere they do. Neither the member list nor a
 * marker counts them (the fetch-runtime twins skip the same names).
 */
export function isMacMetadataName(path: string): boolean {
  const parts = path.split(/[\\/]/).filter((p) => p !== '' && p !== '.')
  return parts.some((p) => p === '__MACOSX' || p.startsWith('._')) || parts[parts.length - 1] === '.DS_Store'
}

/** The listing of `names` (files and links), with the room `bytes` they take and the regular members' `sizes`. */
function listing(bytes: number, names: string[], sizes: Map<string, number>): ArchiveListing {
  const members = names.filter((n) => !isMacMetadataName(n))
  for (const name of sizes.keys()) if (isMacMetadataName(name)) sizes.delete(name)
  return { bytes, members, sizes, plainNames: members.every((n) => PLAIN_NAME.test(n)) }
}

const roundUp = (bytes: number, unit: number): number => Math.ceil(bytes / unit) * unit

/** Every parent folder of the member paths, plus the members that are folders themselves. */
function folderCount(names: Iterable<string>, explicitDirs: Iterable<string>): number {
  const dirs = new Set<string>()
  // One spelling for both: `tar -C dir .` writes `./build/` as well as `./build/x`, which must count once.
  const clean = (p: string): string => p.replace(/^(\.\/)+/, '')
  for (const d of explicitDirs) dirs.add(clean(d).replace(/\/+$/, ''))
  for (const name of names) {
    const parts = clean(name).split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  dirs.delete('')
  dirs.delete('.')
  return dirs.size
}

async function readHead(path: string): Promise<Buffer | null> {
  try {
    const fh = await open(path, 'r')
    try {
      const head = Buffer.alloc(2)
      const { bytesRead } = await fh.read(head, 0, 2, 0)
      return bytesRead === 2 ? head : null
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CENTRAL_SIG = 0x02014b50

/** The zip's members from its central directory (EOCD at the end, within its 64 KiB comment). */
async function zipListing(path: string, unit: number): Promise<ArchiveListing | null> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) return null
    const entries = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null
    if (cdOffset + cdSize > size) return null
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    let at = 0
    let total = 0
    const names: string[] = []
    const dirs: string[] = []
    const sizes = new Map<string, number>()
    for (let n = 0; n < entries; n++) {
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL_SIG) return null
      const uncompressed = cd.readUInt32LE(at + 24)
      if (uncompressed === 0xffffffff) return null
      const nameLen = cd.readUInt16LE(at + 28)
      const extraLen = cd.readUInt16LE(at + 30)
      const commentLen = cd.readUInt16LE(at + 32)
      // Separators as tar writes them; the names count folders and are listed (#998), nothing is opened by them.
      const name = cd.toString('latin1', at + 46, at + 46 + nameLen).replace(/\\/g, '/')
      if (name.endsWith('/')) dirs.push(name)
      else {
        names.push(name)
        sizes.set(name, uncompressed)
        total += roundUp(uncompressed, unit)
      }
      at += 46 + nameLen + extraLen + commentLen
    }
    return listing(total + folderCount(names, dirs) * unit, names, sizes)
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Parse an octal (or GNU base-256) ustar number field. */
function tarNumber(field: Buffer): number {
  if (field[0] & 0x80) {
    let n = 0
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]
    return n
  }
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim()
  return text === '' ? 0 : parseInt(text, 8)
}

/**
 * The tar.gz's members from its ustar headers, read through gunzip. A GNU long name (`L`) or a pax
 * header (`x`, its `path` and `size`) names the member after it; a long link name (`K`) and a global
 * pax header (`g`) are passed over.
 */
function tarGzListing(path: string, unit: number): Promise<ArchiveListing | null> {
  return new Promise((resolvePromise) => {
    let total = 0
    const names: string[] = []
    const dirs: string[] = []
    /** #998: links and hard links: members of their own, taking no room. */
    const links: string[] = []
    /** #1045: the regular members' sizes. */
    const sizes = new Map<string, number>()
    let pending: Buffer = Buffer.alloc(0)
    /** Data bytes (block-padded) still to pass over. */
    let skip = 0
    /** The meta member being read (`L` or `x`), its bytes so far and how many are still to come. */
    let meta: { type: 'L' | 'x'; parts: Buffer[]; left: number } | null = null
    /** What the meta members said about the next real member. */
    let next: { name?: string; size?: number } = {}
    let ended = false
    let done = false

    const source = createReadStream(path)
    const gunzip = createGunzip()
    const finish = (value: ArchiveListing | null): void => {
      if (done) return
      done = true
      source.destroy()
      gunzip.destroy()
      resolvePromise(value)
    }
    const sum = (): ArchiveListing => listing(total + folderCount(names, dirs) * unit, [...names, ...links], sizes)

    const takeHeader = (h: Buffer): void => {
      if (h.every((b) => b === 0)) {
        ended = true
        return
      }
      const type = String.fromCharCode(h[156] || 0x30)
      const size = type === 'L' || type === 'x' ? tarNumber(h.subarray(124, 136)) : (next.size ?? tarNumber(h.subarray(124, 136)))
      skip = Math.ceil(size / 512) * 512
      if (type === 'L' || type === 'x') {
        meta = { type, parts: [], left: size }
        return
      }
      if (type === 'K' || type === 'g') return
      const prefix = h.toString('latin1', 345, 500).replace(/\0.*$/s, '')
      const base = h.toString('latin1', 0, 100).replace(/\0.*$/s, '')
      const name = next.name ?? (prefix ? `${prefix}/${base}` : base)
      if (type === '0' || type === '7') {
        names.push(name)
        sizes.set(name, size)
        total += roundUp(size, unit)
      } else if (type === '5') {
        dirs.push(name)
      } else if (type === '1' || type === '2') {
        links.push(name)
      }
      // Links and devices take no room of their own.
      next = {}
    }

    const takeMeta = (piece: Buffer): void => {
      if (!meta || meta.left <= 0) return
      const part = piece.subarray(0, Math.min(piece.length, meta.left))
      meta.parts.push(part)
      meta.left -= part.length
      if (meta.left > 0) return
      const text = Buffer.concat(meta.parts).toString('utf8')
      if (meta.type === 'L') next.name = text.replace(/\0.*$/s, '')
      else {
        for (const record of text.split('\n')) {
          const m = /^\d+ (size|path)=(.*)$/s.exec(record)
          if (m?.[1] === 'size') next.size = Number(m[2])
          else if (m?.[1] === 'path') next.name = m[2]
        }
      }
      meta = null
    }

    source.on('error', () => finish(null))
    gunzip.on('error', () => finish(null))
    gunzip.on('data', (chunk: Buffer) => {
      if (ended) return
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      while (!ended) {
        if (skip > 0) {
          if (pending.length === 0) break
          const n = Math.min(skip, pending.length)
          takeMeta(pending.subarray(0, n))
          pending = pending.subarray(n)
          skip -= n
          continue
        }
        if (pending.length < 512) break
        const header = pending.subarray(0, 512)
        pending = pending.subarray(512)
        takeHeader(header)
      }
      if (ended) finish(sum())
    })
    // No end-of-archive blocks is still a whole archive; a member cut short is not.
    gunzip.on('end', () => finish(ended || skip === 0 ? sum() : null))
    source.pipe(gunzip)
  })
}
