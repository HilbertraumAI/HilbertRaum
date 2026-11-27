// App-update T6.0b (docs/app-updates.md §4.3, table A.2; plan C14): the byte-level ustar writer of tests/helpers/archives.ts
// and the hostile update files tests/helpers/update-bundles.ts builds from the case table. These files are the test
// inputs of the import (T6.1, T6.2), written before it: this suite proves the inputs are what the table says, so a red
// import row is the import's, not the fixture's. Expected values come from data fixtures (tests/fixtures/updates/import/):
// ustar-writer.json holds table A.2's writer bytes, cases.json each built file's size, first bytes and masked sha256,
// stated by the table's own authoring tool, not by the helper under test.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HRUPDATE_PREFIX, USTAR_FIELDS, makeTarGz, makeUstarFile, ustarChecksum, ustarHeader, ustarMember, type UstarField } from '../helpers/archives'
import { buildCaseFile, loadImportCases, makeBundleSigners, maskedSha256 } from '../helpers/update-bundles'
import { DESKTOP_ROOT } from '../helpers/repo-files'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const IMPORT_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'import')

describe('makeTarGz keeps its bytes (T6.0b: archives.ts gained a second writer)', () => {
  it('writes the same tar bytes for a fixed input as before the byte-level writer was added', () => {
    // The sha256 was taken on the file as it stood at f7dae3ba, before the edit. It pins the tar bytes inside the gzip
    // wrapper: zlib writes the building system's OS byte into the gzip header, so the wrapper differs between CI legs.
    const tar = gunzipSync(
      makeTarGz([
        { name: 'bin/', dir: true },
        { name: 'bin/tool', data: Buffer.from('#!/bin/sh\necho tool\n'), mode: 0o755 },
        { name: 'bin/link', symlink: 'tool' },
        { name: 'empty.txt', data: Buffer.alloc(0) },
        { name: 'block-and-one.txt', data: Buffer.alloc(513, 0x61) }
      ])
    )
    expect(tar.length).toBe(5120)
    expect(sha256(tar)).toBe('683abcee42b5c9da3709ad3135dfe5888fd23b7f1db2e11ce1ae817d035f2a6a')
  })
})

describe("the byte-level ustar writer writes table A.2's writer bytes (record §4.3)", () => {
  type WriterGolden = {
    example: { name: string; size: number; checksumText: string; headerSha256: string }
    fields: Array<{ field: UstarField; at: number; length: number; hex: string }>
    reservedPrefix: { hex: string }
  }
  const golden = JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'ustar-writer.json'), 'utf8')) as WriterGolden
  const header = ustarHeader({ name: golden.example.name, size: golden.example.size })

  it.each(golden.fields)('the good header: $field at byte $at', ({ field, at, length, hex }) => {
    expect(USTAR_FIELDS[field]).toEqual([at, length])
    expect(header.subarray(at, at + length).toString('hex')).toBe(hex)
  })

  it('the good header as a whole, its checksum, a member and the end', () => {
    expect(header.length).toBe(512)
    expect(sha256(header)).toBe(golden.example.headerSha256)
    expect(ustarChecksum(header).toString(8).padStart(6, '0')).toBe(golden.example.checksumText)
    const data = Buffer.alloc(golden.example.size, 0x6e)
    // A size that is a multiple of 512 takes no padding; one byte more takes 511 zero bytes; an empty member none.
    expect(ustarMember({ name: golden.example.name }, data)).toEqual(Buffer.concat([header, data]))
    const longer = ustarMember({ name: 'a.txt' }, Buffer.alloc(513, 0x61))
    expect(longer.length).toBe(512 + 1024)
    expect(longer.subarray(512 + 513).every((b) => b === 0)).toBe(true)
    expect(ustarMember({ name: 'empty.txt' }, Buffer.alloc(0)).length).toBe(512)
    const file = makeUstarFile({ members: [header, data] })
    expect(file.subarray(0, 1024)).toEqual(Buffer.concat([header, data]))
    expect(file.length).toBe(1024 + 1024)
    expect(file.subarray(1024).every((b) => b === 0)).toBe(true)
    expect(HRUPDATE_PREFIX.toString('hex')).toBe(golden.reservedPrefix.hex)
  })

  it('every header field can be set to any bytes, and nothing else moves', () => {
    for (const [field, [at, length]] of Object.entries(USTAR_FIELDS) as Array<[UstarField, readonly [number, number]]>) {
      const bytes = Buffer.alloc(length, 0xa5)
      const set = ustarHeader({ name: golden.example.name, size: golden.example.size, [field]: bytes })
      expect(set.subarray(at, at + length), field).toEqual(bytes)
      const rest = Buffer.from(set)
      const good = Buffer.from(header)
      // Outside the field only the computed checksum may differ (and it is computed over the header as written).
      for (const range of [[at, length], USTAR_FIELDS.checksum]) {
        rest.fill(0, range[0], range[0] + range[1])
        good.fill(0, range[0], range[0] + range[1])
      }
      expect(rest, field).toEqual(good)
      if (field !== 'checksum') expect(set.subarray(148, 156).toString('latin1'), field).toBe(`${ustarChecksum(set).toString(8).padStart(6, '0')}\0 `)
    }
    // A text value is written at the field's start and the rest of the field is NUL; a size may be a number.
    expect(ustarHeader({ name: 'x', size: 8, uname: 'root' }).subarray(265, 297)).toEqual(Buffer.concat([Buffer.from('root'), Buffer.alloc(28)]))
    expect(ustarHeader({ name: 'x', size: 0o777 }).subarray(124, 136).toString('latin1')).toBe('00000000777\0')
    expect(() => ustarHeader({ name: 'x'.repeat(101), size: 0 })).toThrow()
  })

  it('the end as two zero blocks, one or none, bytes after it, a prefix, a zero-filled tail and a cut at any byte', () => {
    const member = ustarMember({ name: 'a.txt' }, Buffer.from('abc'))
    expect(makeUstarFile({ members: [member], end: 'one' }).length).toBe(1024 + 512)
    expect(makeUstarFile({ members: [member], end: 'none' })).toEqual(member)
    const after = makeUstarFile({ members: [member], after: Buffer.from('xy') })
    expect(after.length).toBe(1024 + 1024 + 2)
    expect(after.subarray(-2).toString('latin1')).toBe('xy')
    const prefixed = makeUstarFile({ prefix: HRUPDATE_PREFIX, members: [member] })
    expect(prefixed.subarray(0, 8).toString('latin1')).toBe('HRUPDATE')
    expect(prefixed.subarray(8)).toEqual(makeUstarFile({ members: [member] }))
    const whole = makeUstarFile({ members: [member] })
    for (const cut of [0, 1, 511, 512, 513, 515, 1023, 1024, 2047]) expect(makeUstarFile({ members: [member], cut }), String(cut)).toEqual(whole.subarray(0, cut))
    const zeroed = makeUstarFile({ members: [member], zeroFrom: 513 })
    expect(zeroed.length).toBe(whole.length)
    expect(zeroed.subarray(0, 513)).toEqual(whole.subarray(0, 513))
    expect(zeroed.subarray(513).every((b) => b === 0)).toBe(true)
  })
})

describe('every case of the import table builds the file the table states (tests/fixtures/updates/import/cases.json)', () => {
  const table = loadImportCases()
  const signers = makeBundleSigners() // made here, in memory; nothing of them is written
  const built = [...table.cases, ...table.open].filter((c) => c.build !== undefined && c.build !== null)

  it('the table holds cases with a file, and every id is unique', () => {
    expect(built.length).toBeGreaterThan(150)
    const ids = [...table.cases, ...table.open].map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(built.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const file = buildCaseFile(table, c.build!, signers)
    expect(file.bytes.length).toBe(c.file!.size)
    expect(file.bytes.subarray(0, 16).toString('hex')).toBe(c.file!.head)
    expect(maskedSha256(file)).toBe(c.file!.maskedSha256)
  })

  it('a built envelope is signed by the key the test made: Ed25519 over the DSSE pre-authentication encoding', async () => {
    const { createPublicKey, verify } = await import('node:crypto')
    const std = table.cases.find((c) => c.id === 'accept-std')!
    const file = buildCaseFile(table, std.build!, signers)
    const [at, length] = file.envelope!
    const envelope = JSON.parse(file.bytes.subarray(at, at + length).toString('utf8')) as { payloadType: string; payload: string; signatures: Array<{ keyid: string; sig: string }> }
    const payload = Buffer.from(envelope.payload, 'base64')
    // The DSSE specification's encoding, written out here: "DSSEv1", the type's byte count, the type, the body's count, the body.
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(envelope.payloadType)} ${envelope.payloadType} ${payload.length} `), payload])
    const key = createPublicKey({ key: signers.test.spki, format: 'der', type: 'spki' })
    expect(envelope.signatures).toHaveLength(1)
    expect(envelope.signatures[0]!.keyid).toBe(signers.test.id)
    expect(verify(null, pae, key, Buffer.from(envelope.signatures[0]!.sig, 'base64'))).toBe(true)
    expect(payload.toString('utf8')).toBe(table.payloads.std)
    // The same case signed by the other key does not verify under the test key.
    const other = buildCaseFile(table, table.cases.find((c) => c.id === 'm0-unknown-signer')!.build!, signers)
    const otherEnvelope = JSON.parse(other.bytes.subarray(other.envelope![0], other.envelope![0] + other.envelope![1]).toString('utf8')) as typeof envelope
    expect(otherEnvelope.signatures[0]!.keyid).toBe(signers.other.id)
    expect(verify(null, pae, key, Buffer.from(otherEnvelope.signatures[0]!.sig, 'base64'))).toBe(false)
  })
})
