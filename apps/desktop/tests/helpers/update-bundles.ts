// Builds the update files of the import's case table (app-update T6.0b; docs/app-updates.md §2.3, §4.3; plan C14, C8):
// each hostile or good file of tests/fixtures/updates/import/cases.json, at test time, from the byte-level writer of
// archives.ts and a key pair the test makes. It holds no expected value: every answer, and each built file's size, first
// bytes and masked sha256, live in the table. It imports nothing from src/: its DSSE encoding and its envelope text are
// written out here, so a built file is not the output of the code that reads it.
//
// No private key is ever written: `makeBundleSigners` makes two pairs in memory (the one the test embeds as its key set,
// and one no key set holds), and they end with the test process.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeUstarFile, ustarMember, type UstarField, type UstarHeaderFields } from './archives'
import { DESKTOP_ROOT } from './repo-files'

/** Bytes as the table writes them: latin1 text, or one of the forms below (cases.json, `schema.bytes`). */
export type BytesSpec =
  | string
  | { text: string }
  | { hex: string }
  | { fill: string; length: number }
  | { counter: { length: number; mul: number; add: number } }
  | { seq: { count: number; pad: number; before: string; after: string } }
  | { parts: BytesSpec[] }

export interface EnvelopeSpec {
  payload?: string
  payloadType?: string
  sign?: 'test' | 'other' | 'none'
  keyid?: 'signer' | 'test' | 'absent'
  tamperSig?: boolean
  junkSignatures?: number
  padTo?: number
  raw?: BytesSpec
}

export interface MemberSpec {
  name: string
  data?: string | BytesSpec
  envelope?: EnvelopeSpec
  header?: { [F in UstarField]?: BytesSpec }
  size?: number
  pad?: BytesSpec
}

export interface BuildSpec {
  raw?: BytesSpec
  payload?: string
  members?: string | MemberSpec[]
  prefix?: BytesSpec
  end?: 'two' | 'one' | 'none'
  after?: BytesSpec
  zeroFrom?: number
  cut?: number
}

/** What the table says a built file must be. */
export interface FileFacts {
  size: number
  head: string
  maskedSha256: string
}

/** One row of the table. `expect`, `host`, `drive` and `inject` are the import tests' to read; their shapes are the table's `schema`. */
export interface ImportCase {
  id: string
  kind?: 'import' | 'calls' | 'start' | 'discard'
  why?: string
  host?: string
  hostSet?: Record<string, unknown>
  drive?: Array<Record<string, unknown>>
  inject?: Array<Record<string, unknown>>
  calls?: string[]
  build?: BuildSpec | null
  file?: FileFacts | null
  expect?: Record<string, unknown>
  question?: string
  readings?: string[]
}

export interface ImportCaseTable {
  schema: Record<string, string>
  hosts: Record<string, Record<string, unknown>>
  data: Record<string, BytesSpec>
  payloads: Record<string, string | BytesSpec>
  sets: Record<string, MemberSpec[]>
  cases: ImportCase[]
  open: ImportCase[]
}

export const IMPORT_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'import')

export function loadImportCases(): ImportCaseTable {
  return JSON.parse(readFileSync(join(IMPORT_FIXTURES, 'cases.json'), 'utf8')) as ImportCaseTable
}

/** A key pair made at test time. `spki` (the public key's DER) and `id` are what a test embeds; the private half stays here. */
export interface BundleSigner {
  readonly privateKey: KeyObject
  readonly spki: Buffer
  readonly id: string
}

export function makeBundleSigner(): BundleSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return { privateKey, spki, id: createHash('sha256').update(spki).digest('hex') } // a key's id: the sha256 of its SPKI DER, lower-case hex
}

/** `test`: the key the import under test is given as its key set. `other`: a key no key set holds. */
export function makeBundleSigners(): { test: BundleSigner; other: BundleSigner } {
  return { test: makeBundleSigner(), other: makeBundleSigner() }
}

export function bytesOf(spec: BytesSpec): Buffer {
  if (typeof spec === 'string') return Buffer.from(spec, 'latin1')
  if ('text' in spec) return Buffer.from(spec.text, 'utf8')
  if ('hex' in spec) return Buffer.from(spec.hex, 'hex')
  if ('fill' in spec) return Buffer.alloc(spec.length, Buffer.from(spec.fill, 'hex'))
  if ('counter' in spec) {
    const { length, mul, add } = spec.counter
    return Buffer.from(Array.from({ length }, (_, i) => (i * mul + add) & 0xff))
  }
  if ('seq' in spec) {
    const { count, pad, before, after } = spec.seq
    return Buffer.from(Array.from({ length: count }, (_, i) => `${before}${String(i).padStart(pad, '0')}${after}`).join(''), 'utf8')
  }
  return Buffer.concat(spec.parts.map(bytesOf))
}

export const RELEASE_PAYLOAD_TYPE = 'application/vnd.hilbertraum.release+json'

/** DSSE's pre-authentication encoding (record §2.3): `DSSEv1`, the type's byte count, the type, the body's byte count, the body. */
export function dssePae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, 'utf8')
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, 'latin1'), type, Buffer.from(` ${payload.length} `, 'latin1'), payload])
}

/** The payload a name of the table stands for, as its exact bytes. */
export function payloadBytes(table: ImportCaseTable, name: string): Buffer {
  const payload = table.payloads[name]
  if (payload === undefined) throw new Error(`cases.json has no payload "${name}"`)
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : bytesOf(payload)
}

/** Member 0's data: the envelope in the table's fixed text form (cases.json, `schema.envelope`), signed as the spec says. */
export function envelopeBytes(payload: Buffer, spec: EnvelopeSpec, signers: { test: BundleSigner; other: BundleSigner }): Buffer {
  if (spec.raw !== undefined) return bytesOf(spec.raw)
  const payloadType = spec.payloadType ?? RELEASE_PAYLOAD_TYPE
  const entries: string[] = []
  for (let i = 0; i < (spec.junkSignatures ?? 0); i++) entries.push(`{"keyid":"","sig":"${'A'.repeat(86)}=="}`)
  const who = spec.sign ?? 'test'
  if (who !== 'none') {
    const signer = signers[who]
    const signature = sign(null, dssePae(payloadType, payload), signer.privateKey)
    if (spec.tamperSig) signature[0] ^= 1
    const sig = signature.toString('base64')
    const keyid = spec.keyid ?? 'signer'
    entries.push(keyid === 'absent' ? `{"sig":"${sig}"}` : `{"keyid":"${keyid === 'test' ? signers.test.id : signer.id}","sig":"${sig}"}`)
  }
  let text = `{"payloadType":${JSON.stringify(payloadType)},"payload":"${payload.toString('base64')}","signatures":[${entries.join(',')}]`
  if (spec.padTo !== undefined) {
    const fill = spec.padTo - Buffer.byteLength(text, 'utf8') - ',"pad":""}'.length
    if (fill < 0) throw new Error(`padTo ${spec.padTo} is below the envelope's own length`)
    text += `,"pad":"${'a'.repeat(fill)}"`
  }
  return Buffer.from(`${text}}`, 'utf8')
}

export interface BuiltFile {
  bytes: Buffer
  /** Where member 0's data lies in the file (offset, length), or null when the file has no envelope member. */
  envelope: [number, number] | null
}

/** The file a case's `build` describes. */
export function buildCaseFile(table: ImportCaseTable, build: BuildSpec, signers: { test: BundleSigner; other: BundleSigner }): BuiltFile {
  if (build.raw !== undefined) return { bytes: bytesOf(build.raw), envelope: null }
  const members = typeof build.members === 'string' ? table.sets[build.members] : build.members
  if (members === undefined) throw new Error('a build names no members')
  const prefix = build.prefix === undefined ? undefined : bytesOf(build.prefix)
  let at = prefix?.length ?? 0
  let envelope: [number, number] | null = null
  const blocks = members.map((member) => {
    let data: Buffer
    if (member.envelope !== undefined) {
      const name = member.envelope.payload ?? build.payload
      data = envelopeBytes(member.envelope.raw !== undefined || name === undefined ? Buffer.alloc(0) : payloadBytes(table, name), member.envelope, signers)
      envelope ??= [at + 512, data.length]
    } else {
      if (member.data === undefined) throw new Error(`member ${member.name} has no data`)
      const spec = typeof member.data === 'string' ? table.data[member.data] : member.data
      if (spec === undefined) throw new Error(`cases.json has no data "${String(member.data)}"`)
      data = bytesOf(spec)
    }
    const fields: UstarHeaderFields = { name: member.name }
    if (member.size !== undefined) fields.size = member.size
    for (const [field, value] of Object.entries(member.header ?? {}) as Array<[UstarField, BytesSpec]>) fields[field] = bytesOf(value)
    const block = ustarMember(fields, data, member.pad === undefined ? undefined : bytesOf(member.pad))
    at += block.length
    return block
  })
  const bytes = makeUstarFile({ prefix, members: blocks, end: build.end, after: build.after === undefined ? undefined : bytesOf(build.after), zeroFrom: build.zeroFrom, cut: build.cut })
  return { bytes, envelope }
}

/** The sha256 of a built file with member 0's data bytes set to zero: the part no key and no signature changes. */
export function maskedSha256(file: BuiltFile): string {
  const masked = Buffer.from(file.bytes)
  if (file.envelope) masked.fill(0, Math.min(file.envelope[0], masked.length), Math.min(file.envelope[0] + file.envelope[1], masked.length))
  return createHash('sha256').update(masked).digest('hex')
}
