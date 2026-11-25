import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { archiveMemberSizes, archiveMembers, extractedArchiveBytes } from '../../src/main/services/archive-size'
import { makeSizeOnlyZip, makeTarGz, makeZip } from '../helpers/archives'

// #986: the engine installer refuses a job the drive has no room to unpack, before anything is
// touched. The figure comes from the verified archive itself: a zip's central directory, a tar.gz's
// ustar headers through gunzip; every file rounded up to the volume's allocation unit, every folder
// one unit. A shape the reader cannot size is null (no check), never a guess.

const dir = mkdtempSync(join(tmpdir(), 'hr-archive-size-'))
let n = 0
function archive(bytes: Buffer): string {
  const p = join(dir, `a-${n++}`)
  writeFileSync(p, bytes)
  return p
}
const data = (len: number): Buffer => Buffer.alloc(len, 0x61)

describe('extractedArchiveBytes (#986)', () => {
  it('sums a zip central directory, each file rounded up to the unit and each folder one unit', async () => {
    const zip = archive(
      makeZip([
        { name: 'llama-server.exe', data: data(5000) },
        { name: 'ggml.dll', data: data(1) },
        { name: 'empty.txt', data: data(0) },
        { name: 'Release/nested.txt', data: data(4096) }
      ])
    )
    // 8192 + 4096 + 0 + 4096 for the files, 4096 for the implied `Release/`.
    expect(await extractedArchiveBytes(zip, 4096)).toBe(20_480)
    // A 128 KiB exFAT unit (a stick above 32 GB): the same four files take 3 units, the folder one.
    expect(await extractedArchiveBytes(zip, 131_072)).toBe(4 * 131_072)
  })

  it('reads the sizes the directory states, not the bytes the file holds', async () => {
    expect(await extractedArchiveBytes(archive(makeSizeOnlyZip(3, 1_000_000)), 1)).toBe(3_000_000)
  })

  it('sums a tar.gz from its ustar headers: files rounded, folders one unit, links nothing', async () => {
    const tgz = archive(
      makeTarGz([
        { name: 'build/', dir: true },
        { name: 'build/bin/', dir: true },
        { name: 'build/bin/llama-server', data: data(5000), mode: 0o755 },
        { name: 'build/bin/libllama.so.0', symlink: 'libllama.so' },
        { name: 'build/bin/libllama.so', data: data(10) }
      ])
    )
    expect(await extractedArchiveBytes(tgz, 4096)).toBe(8192 + 4096 + 2 * 4096)
  })

  // #986 review 3: `tar -C dir .` writes `./build/` as well as `./build/x`; the folder counts once.
  it('counts a folder once when the archive spells it with a leading ./', async () => {
    const tgz = archive(
      makeTarGz([
        { name: './', dir: true },
        { name: './build/', dir: true },
        { name: './build/llama-server', data: data(10) }
      ])
    )
    expect(await extractedArchiveBytes(tgz, 4096)).toBe(4096 + 4096)
  })

  it('takes a GNU long name and a pax size override into account', async () => {
    const header = (name: string, type: string, size: number): Buffer => {
      const h = Buffer.alloc(512)
      h.write(name, 0, 100, 'latin1')
      h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
      h.write(type, 156, 1, 'latin1')
      h.write('ustar\0', 257, 6, 'latin1')
      return h
    }
    const padded = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
    const longName = Buffer.from(`${'deep/'.repeat(30)}file.bin\0`, 'latin1')
    const pax = Buffer.from('14 size=70000\n', 'utf8')
    const tgz = archive(
      gzipSync(
        Buffer.concat([
          header('././@LongLink', 'L', longName.length),
          padded(longName),
          header('truncated', '0', 3),
          padded(data(3)),
          header('PaxHeader', 'x', pax.length),
          padded(pax),
          // The pax header says 70,000 bytes, the ustar field 0: the pax figure is the member's size.
          header('big.bin', '0', 0),
          padded(data(70_000)),
          Buffer.alloc(1024)
        ])
      )
    )
    // 3 → 1 unit; 70,000 → 18 units of 4096; 30 folders from the long name.
    expect(await extractedArchiveBytes(tgz, 4096)).toBe(4096 + 18 * 4096 + 30 * 4096)
  })

  it.each([
    ['neither a zip nor a gzip', Buffer.from('llama-server-release-archive-bytes')],
    ['an empty file', Buffer.alloc(0)],
    ['a zip with no end of central directory', makeZip([{ name: 'a', data: data(10) }]).subarray(0, 40)],
    ['a gzip that is not a whole tar', gzipSync(Buffer.concat([Buffer.alloc(512, 0x31), data(100)]))]
  ])('is null for %s (no check rather than a guess)', async (_label, bytes) => {
    expect(await extractedArchiveBytes(archive(bytes), 4096)).toBeNull()
  })

  it('is null for a Zip64 archive and for a member whose size is the Zip64 mark', async () => {
    const zip = makeSizeOnlyZip(1, 0xffffffff)
    expect(await extractedArchiveBytes(archive(zip), 4096)).toBeNull()
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    const plain = makeSizeOnlyZip(1, 10)
    const withLocator = Buffer.concat([plain.subarray(0, plain.length - 22), locator, plain.subarray(plain.length - 22)])
    // The directory offset still reads 0, so only the locator makes it Zip64.
    expect(await extractedArchiveBytes(archive(withLocator), 4096)).toBeNull()
  })

  it('is null for a file that does not exist', async () => {
    expect(await extractedArchiveBytes(join(dir, 'missing.zip'), 4096)).toBeNull()
  })
})

// #998: the engine install checks that every member the verified archive lists is in the unpacked copy (a
// scanner can take a fresh file before the copy is marked). The same readers list the names: files and links,
// never folders, as the archive writes them. A listing that could name a file wrongly is null (no check).
describe('archiveMembers (#998)', () => {
  it('lists every zip member that is not a folder, in archive order', async () => {
    const zip = archive(
      makeZip([
        { name: 'llama-server.exe', data: data(5) },
        { name: 'Release/', data: data(0) },
        { name: 'Release/ggml.dll', data: data(1) },
        { name: 'empty.txt', data: data(0) }
      ])
    )
    expect(await archiveMembers(zip)).toEqual(['llama-server.exe', 'Release/ggml.dll', 'empty.txt'])
  })

  it('lists a tar.gz member by its name, links and hard links included, folders left out', async () => {
    const tgz = archive(
      makeTarGz([
        { name: './build/', dir: true },
        { name: './build/llama-server', data: data(5), mode: 0o755 },
        { name: './build/libllama.so', symlink: 'libllama.so.0' },
        { name: './build/libllama.so.0', data: data(10) }
      ])
    )
    expect((await archiveMembers(tgz))?.sort()).toEqual(['./build/libllama.so', './build/libllama.so.0', './build/llama-server'])
  })

  // #998 round 1: macOS bsdtar reads AppleDouble members back into extended attributes, so they never land
  // on the disk there; listed, they would fail every macOS install. A Finder .DS_Store is never an engine file.
  it('leaves macOS metadata out: AppleDouble files, a __MACOSX folder, .DS_Store', async () => {
    const zip = archive(
      makeZip([
        { name: 'llama-server', data: data(5) },
        { name: '._llama-server', data: data(1) },
        { name: '__MACOSX/._llama-server', data: data(1) },
        { name: 'lib/._libllama.dylib', data: data(1) },
        { name: 'lib/libllama.dylib', data: data(1) },
        { name: '.DS_Store', data: data(1) }
      ])
    )
    expect(await archiveMembers(zip)).toEqual(['llama-server', 'lib/libllama.dylib'])
  })

  it.each([
    ['a zip member named outside plain ASCII', makeZip([{ name: 'ok.dll', data: data(1) }, { name: 'caf\u00e9.dll', data: data(1) }])],
    ['neither a zip nor a gzip', Buffer.from('llama-server-release-archive-bytes')],
    ['a gzip that is not a whole tar', gzipSync(Buffer.concat([Buffer.alloc(512, 0x31), data(100)]))],
    ['a Zip64 archive', makeSizeOnlyZip(1, 0xffffffff)]
  ])('is null for %s (the install then skips its check)', async (_label, bytes) => {
    expect(await archiveMembers(archive(bytes))).toBeNull()
  })
})

// #1045 round 2: a failed tar is mended only when every regular member on the disk is the size the archive gives
// (a member tar wrote short on an I/O error or a full drive was recorded as whole). The same reader as the member
// list, so the same names: each regular member's size, never a link's, a folder's or macOS metadata's.
describe('archiveMemberSizes (#1045)', () => {
  it('gives each regular member of a tar.gz its size: links, folders and macOS metadata have none', async () => {
    const tgz = archive(
      makeTarGz([
        { name: 'build/', dir: true },
        { name: 'build/llama-server', data: data(5000), mode: 0o755 },
        { name: 'build/libllama.so', symlink: 'libllama.so.0' },
        { name: 'build/libllama.so.0', data: data(10) },
        { name: 'build/empty.txt', data: data(0) },
        { name: 'build/._llama-server', data: data(3) }
      ])
    )
    expect(await archiveMemberSizes(tgz)).toEqual(
      new Map([
        ['build/llama-server', 5000],
        ['build/libllama.so.0', 10],
        ['build/empty.txt', 0]
      ])
    )
  })

  it('is null where the member list is: a name outside plain ASCII, an archive it cannot read', async () => {
    expect(await archiveMemberSizes(archive(makeTarGz([{ name: 'café.so', data: data(1) }])))).toBeNull()
    expect(await archiveMemberSizes(archive(Buffer.from('llama-server-release-archive-bytes')))).toBeNull()
  })
})
