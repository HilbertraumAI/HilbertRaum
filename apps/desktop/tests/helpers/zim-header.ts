import { writeFileSync } from 'node:fs'
import { ZIM_HEADER_BYTES, ZIM_MAGIC } from '../../src/main/services/zim/identity'

// REAL 80-byte ZIM headers for the knowledge-pack suites (#301 P3b; plan §10.1 "header-reader
// fixtures have actual magic / 80 bytes / UUID, including malformed negatives").
//
// Why real bytes and not a stub: the whole point of finding M5 is that a pack's identity is
// what the FILE says, not what its name says. A fixture that only pretends to have a header
// would let a reader that never opens the file — or one that swaps the UUID's byte order —
// pass. Every fixture here is written by the same code path the production reader parses, and
// the malformed ones are the exact three negatives the reader must reject.

export interface ZimFixtureOptions {
  /** Bytes appended AFTER the 80-byte header (a "body"), so the file is not header-sized. */
  trailing?: Buffer | string
  /** Header version, purely cosmetic for our reader — recorded so a fixture can pin it. */
  major?: number
  minor?: number
}

/** The 16 raw bytes of a `8-4-4-4-12` hex UUID, IN ORDER (no GUID field swapping — §2.4). */
export function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a lowercase hex uuid: ${uuid}`)
  return Buffer.from(hex, 'hex')
}

/**
 * Write a real ZIM archive stub at `path`: the little-endian magic at offset 0, major/minor at
 * 4/6, the 16 UUID bytes at 8–23, zeros for every other header field, plus optional trailing
 * bytes. Returns `path` so a test can inline it.
 */
export function writeZimFixture(path: string, uuid: string, opts: ZimFixtureOptions = {}): string {
  const header = Buffer.alloc(ZIM_HEADER_BYTES)
  header.writeUInt32LE(ZIM_MAGIC, 0)
  header.writeUInt16LE(opts.major ?? 6, 4)
  header.writeUInt16LE(opts.minor ?? 1, 6)
  uuidBytes(uuid).copy(header, 8)
  const trailing =
    opts.trailing === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(opts.trailing)
        ? opts.trailing
        : Buffer.from(opts.trailing, 'utf8')
  writeFileSync(path, Buffer.concat([header, trailing]))
  return path
}

/**
 * The three negatives `readZimHeader` must reject:
 * - `'short'` — 79 bytes with a VALID magic (so only the length can be what refuses it),
 * - `'magic'` — a full 80 bytes whose first u32 is not `0x044D495A`,
 * - `'empty'` — a zero-byte file (the "the download never finished" shape).
 */
export function malformedZimFixture(path: string, kind: 'short' | 'magic' | 'empty'): string {
  if (kind === 'empty') {
    writeFileSync(path, Buffer.alloc(0))
    return path
  }
  const buf = Buffer.alloc(ZIM_HEADER_BYTES)
  if (kind === 'short') {
    buf.writeUInt32LE(ZIM_MAGIC, 0)
    writeFileSync(path, buf.subarray(0, ZIM_HEADER_BYTES - 1))
    return path
  }
  buf.writeUInt32LE(0xdeadbeef, 0)
  writeFileSync(path, buf)
  return path
}

/**
 * A deterministic UUID from a short label — readable in assertions and stable across runs.
 * `packUuid('alpha')` → `0000...-alpha`-flavoured hex; the ORDER of the generated ids is what
 * the collision rule (ascending UUID string) is asserted against, so tests choose labels whose
 * ids sort the way the case needs.
 */
export function packUuid(prefix: string, label: string): string {
  const tail = Buffer.from(label, 'utf8').toString('hex').padEnd(12, '0').slice(0, 12)
  const head = prefix.padEnd(8, '0').slice(0, 8)
  return `${head}-1111-4222-8333-${tail}`
}
