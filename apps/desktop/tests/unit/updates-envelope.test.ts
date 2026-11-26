import { afterEach, describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  pae,
  parseKeySet,
  readJsonObject,
  verifyEnvelope,
  type EnvelopeResult,
  type KeySetRead,
  type UpdateKey
} from '../../src/main/services/updates/envelope'
import { embeddedKeySet } from '../../src/main/services/updates/keys'
import { DESKTOP_ROOT, REPO_ROOT } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'
import { envelopeBytes, setVectors, vectorFile } from '../helpers/update-vectors'

// The update file's signed envelope and the embedded key set (app-update W-1, F-1, F-3; T4.1): DSSE's PAE and Ed25519
// over node:crypto, the caps, the base64 grammar, `keyid` as a hint and the UnknownSigner rule, the `payloadType`
// decided after a signature verified, keys.json and its one parser. Every row is a row of the record's tables
// (docs/app-updates.md §2.3 "The envelope's values", §2.7 "keys.json and the embedded key set", §2.10 "The verdicts").
// Release 1 answers these for ever.
//
// Keys (plan C8, record §2.7): every key pair below is made here, at run time, and its private half lives in this
// process's memory only. The one fixed key (FIXED) is 32 chosen bytes behind the SPKI prefix, a public key only; its
// base64 and its id were computed with .NET (PowerShell 5.1's Convert.ToBase64String and SHA256, then Get-FileHash), not
// with node, so the id form has a second tool behind it. Expected PAE bytes are written out by hand from §2.3's
// definition, with the counts counted by hand. The golden vectors of F-1 and F-3 (tests/fixtures/updates/vectors/,
// record §10.7) run in their own blocks near the end: spec/'s three files, and the envelope stage of every vector with
// an envelope (its payload stage is updates-payload.test.ts's).

/** The key-set marker with its colon: fine in a test, never in a main source (record §2.7, "The embedded form"). */
const MARKER = 'hilbertraum-key-set-1:'
const RELEASE_TYPE = 'application/vnd.hilbertraum.release+json'
const MODEL_PACK_TYPE = 'application/vnd.hilbertraum.model-pack+json'
const RUNNING = '0.1.66'
const CAP = 4_194_304

interface TestKey {
  /** The 44-byte SPKI DER in standard base64 with padding (§2.7). */
  spki: string
  /** Lower-case hex SHA-256 of the 44 bytes (§2.7). */
  id: string
  privateKey: KeyObject
}

function newKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return { spki: der.toString('base64'), id: createHash('sha256').update(der).digest('hex'), privateKey }
}

/** Two embedded keys and one unknown one. */
const A = newKey()
const B = newKey()
const U = newKey()

/** A fixed public key (see the header): the SPKI prefix, then fb ef be x5, ff ff ff x5, 01 02. */
const FIXED_SPKI = 'MCowBQYDK2VwAyEA++++++++++++++++++++////////////////////AQI='
const FIXED_ID = 'b3700070e8ff628e8c34ee512d19b03f1755a873a0e46f658bb17d1c946e66d3'

/** The verifier's key set, read by the one parser. */
function keySet(...keys: Array<{ spki: string }>): readonly UpdateKey[] {
  const read = parseKeySet(MARKER + keys.map((k) => k.spki).join(','))
  if (!read.valid) throw new Error(`the test's key set does not read: ${read.fault}`)
  return read.keys
}
const KEYS = keySet(A, B)

/** The test's own PAE (record §2.3), so a signature here is not made with the code under test. */
function testPae(type: string, payload: Buffer): Buffer {
  const t = Buffer.from(type, 'utf8')
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${payload.length} `), payload])
}

const PAYLOAD = Buffer.from('{"format":1,"product":"hilbertraum","kind":"release"}')

function signature(k: TestKey, type: string = RELEASE_TYPE, payload: Buffer = PAYLOAD): Buffer {
  return sign(null, testPae(type, payload), k.privateKey)
}

/** A signature entry: `sig` in standard base64, and `keyid` the signer's id unless given (`undefined` leaves it out). */
function entry(k: TestKey, opts: { type?: string; payload?: Buffer; keyid?: unknown } = {}): Record<string, unknown> {
  const e: Record<string, unknown> = { sig: signature(k, opts.type, opts.payload).toString('base64') }
  const keyid = 'keyid' in opts ? opts.keyid : k.id
  if (keyid !== undefined) e.keyid = keyid
  return e
}

/** An envelope signed by `k` (or carrying the given entries), as an object. */
function envelope(opts: { type?: unknown; payload?: Buffer; encoded?: unknown; signatures?: unknown; by?: TestKey } = {}): Record<string, unknown> {
  const payload = opts.payload ?? PAYLOAD
  const type = 'type' in opts ? opts.type : RELEASE_TYPE
  return {
    payloadType: type,
    payload: 'encoded' in opts ? opts.encoded : payload.toString('base64'),
    signatures: opts.signatures ?? [entry(opts.by ?? A, { type: typeof type === 'string' ? type : RELEASE_TYPE, payload })]
  }
}

const bytesOf = (value: object | string): Buffer => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

/** What a row compares: the verified payload's bytes, or the refusal's code and parameters. */
function outcome(r: EnvelopeResult): unknown {
  return r.verified ? { verified: r.payload.toString('hex') } : { code: r.refusal.code, params: r.refusal.params }
}
const run = (bytes: Uint8Array, keys: readonly UpdateKey[] = KEYS): unknown => outcome(verifyEnvelope(bytes, keys, RUNNING))

const VERIFIED = (payload: Buffer = PAYLOAD) => ({ verified: payload.toString('hex') })
const NOT_AVAILABLE = { code: 'UPD-NOT-AVAILABLE', params: {} }
const TOO_NEW = { code: 'UPD-TOO-NEW', params: { runningVersion: RUNNING } }
const DAMAGED = { code: 'UPD-FILE-DAMAGED', params: {} }
const NOT_GENUINE = { code: 'UPD-NOT-GENUINE', params: {} }
const UNKNOWN_SIGNER = { code: 'UPD-UNKNOWN-SIGNER', params: { runningVersion: RUNNING } }
const FOR_NEWER = { code: 'UPD-FOR-NEWER-HILBERTRAUM', params: { runningVersion: RUNNING } }
const NOT_AN_UPDATE = { code: 'UPD-NOT-AN-UPDATE', params: {} }

/** A valid signature by A over another payload: 64 bytes that verify under no key for this envelope. */
const badEntry = (keyid?: unknown): Record<string, unknown> => entry(A, { payload: Buffer.from('another payload'), keyid })

describe('pae: DSSEv1 PAE over byte counts (record §2.3, "Verification")', () => {
  // Counted by hand: the release type is 11 + 1 + 4 + 11 + 1 + 7 + 5 = 40 bytes; `{"format":1}` is 12; é and ü are two
  // bytes each in UTF-8 (one UTF-16 unit), the emoji four (two units).
  it.each<[string, string, Buffer, Buffer]>([
    ['the release type', RELEASE_TYPE, Buffer.from('{"format":1}'), Buffer.from('DSSEv1 40 application/vnd.hilbertraum.release+json 12 {"format":1}')],
    ['an empty type and payload: each count is 0', '', Buffer.alloc(0), Buffer.from('DSSEv1 0  0 ')],
    ['two-byte characters count two', 'a/\u{e9}', Buffer.from('\u{fc}'), Buffer.from('DSSEv1 4 a/\u{e9} 2 \u{fc}')],
    ['a supplementary character counts four', 'x', Buffer.from('\u{1F600}'), Buffer.from('DSSEv1 1 x 4 \u{1F600}')],
    ['bytes that are no UTF-8 stay as they are', 'x', Buffer.from([0xff, 0x00]), Buffer.concat([Buffer.from('DSSEv1 1 x 2 '), Buffer.from([0xff, 0x00])])],
    ['a four-digit count, no leading zero', 'x', Buffer.alloc(1000, 0x61), Buffer.from(`DSSEv1 1 x 1000 ${'a'.repeat(1000)}`)]
  ])('%s', (_label, type, payload, expected) => {
    expect(pae(type, payload).toString('hex')).toBe(expected.toString('hex'))
  })
})

describe('parseKeySet: the one parser of keys.json\u{2019}s key_set (record §2.7)', () => {
  const sixteen = Array.from({ length: 16 }, newKey)

  it.each<[string, string, string[]]>([
    ['the empty set', MARKER, []],
    ['the fixed key, its id computed by a second tool', MARKER + FIXED_SPKI, [FIXED_ID]],
    ['one key', MARKER + A.spki, [A.id]],
    ['two keys, in the string\u{2019}s order', `${MARKER}${B.spki},${A.spki}`, [B.id, A.id]],
    ['three keys', `${MARKER}${A.spki},${B.spki},${U.spki}`, [A.id, B.id, U.id]],
    ['sixteen keys, the most a set holds', MARKER + sixteen.map((k) => k.spki).join(','), sixteen.map((k) => k.id)]
  ])('reads %s', (_label, text, ids) => {
    const read = parseKeySet(text)
    expect(read.valid && read.keys.map((k) => k.id)).toEqual(ids)
  })

  const spkiOf = (prefixHex: string, keyBytes: number): string =>
    Buffer.concat([Buffer.from(prefixHex, 'hex'), Buffer.alloc(keyBytes, 0x5a)]).toString('base64')
  const ED25519_PREFIX = '302a300506032b6570032100'
  const seventeen = [...sixteen, newKey()]

  it.each<[string, unknown, string]>([
    ['no key_set (undefined)', undefined, 'not-a-string'],
    ['null', null, 'not-a-string'],
    ['a number', 1, 'not-a-string'],
    ['a list', [MARKER], 'not-a-string'],
    ['the empty string', '', 'marker'],
    ['the marker without its colon', 'hilbertraum-key-set-1', 'marker'],
    ['another format number', 'hilbertraum-key-set-2:', 'marker'],
    ['a longer format number', 'hilbertraum-key-set-10:', 'marker'],
    ['the marker in another case', 'Hilbertraum-key-set-1:', 'marker'],
    ['a space before the marker', ` ${MARKER}`, 'marker'],
    ['the marker after another one', `x:${MARKER}`, 'marker'],
    ['more than sixteen keys', MARKER + seventeen.map((k) => k.spki).join(','), 'too-many'],
    ['a key in the URL-safe alphabet', MARKER + FIXED_SPKI.replace(/\+/g, '-').replace(/\//g, '_'), 'not-base64'],
    ['a key in both alphabets', MARKER + FIXED_SPKI.replace('+', '-'), 'not-base64'],
    ['a key without its padding', MARKER + FIXED_SPKI.slice(0, -1), 'not-base64'],
    ['a key with non-zero pad bits', MARKER + FIXED_SPKI.replace('AQI=', 'AQJ='), 'not-base64'],
    ['spaces after the comma', `${MARKER}${A.spki},    ${B.spki}`, 'not-base64'],
    ['line ends after the last key', `${MARKER}${A.spki}\r\n\r\n`, 'not-base64'],
    ['an empty entry after a trailing comma', `${MARKER}${A.spki},`, 'not-ed25519-spki'],
    ['an empty entry before the first key', `${MARKER},${A.spki}`, 'not-ed25519-spki'],
    ['43 bytes', MARKER + spkiOf(ED25519_PREFIX, 31), 'not-ed25519-spki'],
    ['45 bytes', MARKER + spkiOf(ED25519_PREFIX, 33), 'not-ed25519-spki'],
    ['an X25519 key (another algorithm byte)', MARKER + spkiOf('302a300506032b656e032100', 32), 'not-ed25519-spki'],
    ['a prefix with another length byte', MARKER + spkiOf('302b300506032b6570032100', 32), 'not-ed25519-spki'],
    ['one key twice', `${MARKER}${A.spki},${A.spki}`, 'repeated'],
    ['a key repeated after another', `${MARKER}${A.spki},${B.spki},${A.spki}`, 'repeated']
  ])('refuses %s: the whole set is invalid', (_label, value, fault) => {
    expect(parseKeySet(value)).toEqual({ valid: false, fault })
  })

  // Weak keys (record §2.7, "A weak key"; the owner, 2026-11-26, after T4.4c): the 32 key bytes read little-endian with
  // the top bit (the sign bit, 0x80 of the last byte) cleared are the key's y. A y that is not below p = 2^255 - 19, or
  // one of the five y values of Ed25519's eight small-order points (0, 1, p - 1 and the record's two order-8 numbers),
  // with either sign bit, makes the whole set invalid. Each encoding is written out here by hand from that rule, not
  // with the parser's arithmetic: 2^255 - 1 is 31 bytes ff and a last byte 7f, so p is ed (ff - 18), 30 bytes ff, 7f;
  // p - 1 ec, p + 1 ee, p + 2 ef, p - 2 eb; 2^255 - 2 is fe, 30 bytes ff, 7f. The order-8 numbers are the record's
  // bytes as it writes them. An independent decoder (RFC 8032 §5.1.3, then [8]P, T4.1 fix round 3) found that the ten
  // encodings of the five values reach all eight small-order points; y = 1 and y = p - 1 with the sign bit set decode
  // to no point, and are weak by the rule all the same.
  const keyOf = (keyHex: string): string => Buffer.concat([Buffer.from(ED25519_PREFIX, 'hex'), Buffer.from(keyHex, 'hex')]).toString('base64')
  const FF30 = 'ff'.repeat(30)
  const ORDER_8_A = '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc'
  const ORDER_8_B = 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03'

  it.each<[string, string]>([
    ['y = 0 (the two order-4 points), sign bit clear', '00'.repeat(32)],
    ['y = 0, sign bit set', `${'00'.repeat(31)}80`],
    ['y = 1 (the neutral point), sign bit clear', `01${'00'.repeat(31)}`],
    ['y = 1, sign bit set', `01${'00'.repeat(30)}80`],
    ['y = p - 1 (the order-2 point), sign bit clear', `ec${FF30}7f`],
    ['y = p - 1, sign bit set', `ec${FF30}ff`],
    ['the first order-8 y, sign bit clear', `${ORDER_8_A}05`],
    ['the first order-8 y, sign bit set', `${ORDER_8_A}85`],
    ['the second order-8 y, sign bit clear', `${ORDER_8_B}7a`],
    ['the second order-8 y, sign bit set', `${ORDER_8_B}fa`],
    ['y = p (no canonical encoding), sign bit clear', `ed${FF30}7f`],
    ['y = p, sign bit set', `ed${FF30}ff`],
    ['y = p + 1, sign bit clear', `ee${FF30}7f`],
    ['y = p + 1, sign bit set', `ee${FF30}ff`],
    // Two values strictly between p + 1 and 2^255 - 1 (T4.4d M-1), so "not below p" is never read as a list of encodings.
    ['y = p + 2, sign bit clear', `ef${FF30}7f`],
    ['y = p + 2, sign bit set', `ef${FF30}ff`],
    ['y = 2^255 - 2, sign bit clear', `fe${FF30}7f`],
    ['y = 2^255 - 2, sign bit set', `fe${FF30}ff`],
    ['y = 2^255 - 1, sign bit clear', `ff${FF30}7f`],
    ['y = 2^255 - 1, sign bit set', `ff${FF30}ff`]
  ])('refuses a weak key, %s: the whole set is invalid', (_label, keyHex) => {
    expect(Buffer.from(keyHex, 'hex').length).toBe(32)
    expect(parseKeySet(MARKER + keyOf(keyHex))).toEqual({ valid: false, fault: 'weak-key' })
  })

  it('one weak key (an order-8 one) between two good keys: the whole set is invalid', () => {
    expect(parseKeySet(`${MARKER}${A.spki},${keyOf(`${ORDER_8_A}05`)},${B.spki}`)).toEqual({ valid: false, fault: 'weak-key' })
  })

  const idOfDer = (spki: string): string => createHash('sha256').update(Buffer.from(spki, 'base64')).digest('hex')

  it.each<[string, string]>([
    ['y = p - 2 (the largest y below p that is not weak), sign bit clear', `eb${FF30}7f`],
    ['y = p - 2, sign bit set', `eb${FF30}ff`]
  ])('reads a key that is not weak: %s', (_label, keyHex) => {
    const spki = keyOf(keyHex)
    const read = parseKeySet(MARKER + spki)
    expect(read.valid && read.keys.map((k) => k.id)).toEqual([idOfDer(spki)])
  })

  it('reads every key an Ed25519 key generator makes: 200 keys, each alone in a set, both sign bits among them', () => {
    const made = Array.from({ length: 200 }, newKey)
    const signs = new Set(made.map((k) => Buffer.from(k.spki, 'base64')[43] >> 7))
    expect(signs).toEqual(new Set([0, 1]))
    const refused = made.filter((k) => {
      const read = parseKeySet(MARKER + k.spki)
      return !(read.valid && read.keys.length === 1 && read.keys[0].id === k.id)
    })
    expect(refused.map((k) => k.spki)).toEqual([])
  })
})

describe('keys.json and keys.ts: the key set this build embeds (record §2.7)', () => {
  const KEYS_JSON = join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'keys.json')
  const KEYS_JSON_SPEC = '../../src/main/services/updates/keys.json'

  it('the committed keys.json reads as a valid set as the file readers read it; while empty, its bytes are §2.7\u{2019}s', () => {
    const bytes = readFileSync(KEYS_JSON)
    const json = readJsonObject(bytes) // no byte-order mark, UTF-8, JSON, an object
    expect(json).not.toBeNull()
    const read = parseKeySet(Object.hasOwn(json!, 'key_set') ? json!.key_set : undefined)
    expect(read.valid).toBe(true)
    // The owner's ceremony (O2) fills the set; until then it is exactly the empty set's text.
    if (read.valid && read.keys.length === 0) expect(bytes.toString('utf8')).toBe(`{\n  "key_set": "${MARKER}"\n}\n`)
    expect(embeddedKeySet.valid).toBe(true)
    expect(embeddedKeySet.keys.map((k) => k.id)).toEqual(read.valid ? read.keys.map((k) => k.id) : null)
  })

  afterEach(() => {
    vi.doUnmock(KEYS_JSON_SPEC)
    vi.resetModules()
  })

  /** keys.ts, loaded fresh over a keys.json that holds `value`. */
  async function embeddedOver(value: unknown): Promise<{ ids: string[]; valid: boolean }> {
    vi.resetModules()
    vi.doMock(KEYS_JSON_SPEC, () => ({ default: value }))
    const { embeddedKeySet: set } = await import('../../src/main/services/updates/keys')
    return { ids: set.keys.map((k) => k.id), valid: set.valid }
  }

  it('embeds the keys a valid set holds, in order', async () => {
    expect(await embeddedOver({ key_set: `${MARKER}${B.spki},${A.spki}` })).toEqual({ ids: [B.id, A.id], valid: true })
  })

  it.each<[string, unknown]>([
    ['a set that does not read (another marker)', { key_set: 'hilbertraum-key-set-2:' }],
    ['no key_set', { keySet: `${MARKER}${A.spki}` }],
    ['null at the top', null]
  ])('fails closed on %s: no key, and the flag says the set was invalid', async (_label, value) => {
    expect(await embeddedOver(value)).toEqual({ ids: [], valid: false })
  })
})

describe('readJsonObject: the strict reading of the envelope (and of the payload, §2.4) (record §2.3, "Text", "JSON")', () => {
  const read = (bytes: Buffer): unknown => readJsonObject(bytes)
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  const inString = (raw: number[]): Buffer => Buffer.concat([Buffer.from('{"a":"'), Buffer.from(raw), Buffer.from('"}')])

  it.each<[string, Buffer]>([
    ['a byte-order mark first', Buffer.concat([BOM, Buffer.from('{"a":1}')])],
    ['an overlong form (C0 AF)', inString([0xc0, 0xaf])],
    ['an encoded surrogate (ED A0 80)', inString([0xed, 0xa0, 0x80])],
    ['a code point above U+10FFFF (F4 90 80 80)', inString([0xf4, 0x90, 0x80, 0x80])],
    ['a lone continuation byte', inString([0x80])],
    ['a cut sequence', inString([0xe2, 0x82])],
    ['no JSON', Buffer.from('not json')],
    ['0 bytes', Buffer.alloc(0)],
    ['a cut JSON text', Buffer.from('{"a":')],
    ['a list at the top', Buffer.from('[{"a":1}]')],
    ['a number at the top', Buffer.from('1')],
    ['a string at the top', Buffer.from('"a"')]
  ])('refuses %s', (_label, bytes) => {
    expect(read(bytes)).toBeNull()
  })

  it.each<[string, Buffer, unknown]>([
    ['three-byte UTF-8 (the euro sign)', inString([0xe2, 0x82, 0xac]), { a: '\u{20ac}' }],
    ['a byte-order mark inside a string', inString([0xef, 0xbb, 0xbf]), { a: '\u{feff}' }]
  ])('reads %s', (_label, bytes, value) => {
    expect(read(bytes)).toEqual(value)
  })
})

describe('verifyEnvelope: the key set and the size cap come first (record §2.3)', () => {
  const VALID = bytesOf(envelope())
  const atCap = Buffer.concat([VALID, Buffer.alloc(CAP - VALID.length, 0x20)]) // JSON allows trailing whitespace

  it('verifies a signed envelope, and hands on its payload bytes', () => {
    expect(run(VALID)).toEqual(VERIFIED())
  })

  it.each<[string, Buffer]>([
    ['a signed envelope', VALID],
    ['bytes over the cap', Buffer.alloc(CAP + 1, 0x20)],
    ['bytes that are no envelope', Buffer.from([0xff, 0xfe])]
  ])('an empty key set answers UPD-NOT-AVAILABLE before it reads %s', (_label, bytes) => {
    expect(run(bytes, [])).toEqual(NOT_AVAILABLE)
  })

  // The release tools are untyped .mjs callers (T4.1's review, m-2): one may hand over parseKeySet's whole read instead
  // of its `keys`, or nothing. That is no key array, so it holds no key: UPD-NOT-AVAILABLE before a byte is read, for
  // a signed envelope, for bytes that are no envelope and for bytes over the cap (the key set comes before the size,
  // T4.1's re-check N-2), and never a throw.
  it.each<[string, unknown]>([
    ['an object', {}],
    ['undefined', undefined],
    ['parseKeySet\u{2019}s whole read of a valid set', parseKeySet(MARKER + A.spki)],
    ['parseKeySet\u{2019}s whole read of an invalid set', parseKeySet('hilbertraum-key-set-2:')]
  ])('a keys argument that is no array (%s) answers UPD-NOT-AVAILABLE, never a throw', (_label, keys) => {
    for (const bytes of [VALID, Buffer.from([0xff, 0xfe]), Buffer.alloc(CAP + 1, 0x20)]) {
      // verifyEnvelope itself, not `run`: its default argument would replace `undefined` with the test's keys.
      expect(outcome(verifyEnvelope(bytes, keys as unknown as readonly UpdateKey[], RUNNING))).toEqual(NOT_AVAILABLE)
    }
  })

  it('an envelope of exactly 4,194,304 bytes is read', () => {
    expect(atCap.length).toBe(CAP)
    expect(run(atCap)).toEqual(VERIFIED())
  })

  it.each<[string, Buffer]>([
    ['a signed envelope one byte over', Buffer.concat([atCap, Buffer.from(' ')])],
    ['bytes over the cap that are no UTF-8 and no JSON', Buffer.alloc(CAP + 1, 0xff)]
  ])('UPD-TOO-NEW before the decode and the parse: %s', (_label, bytes) => {
    expect(run(bytes)).toEqual(TOO_NEW)
  })
})

describe('verifyEnvelope: text, JSON and fields (record §2.3)', () => {
  /** A signed envelope with raw bytes inside a string of an unknown key, ahead of its fields. */
  const withRaw = (raw: number[]): Buffer => {
    const text = JSON.stringify({ note: '@', ...envelope() })
    const at = text.indexOf('@')
    return Buffer.concat([Buffer.from(text.slice(0, at)), Buffer.from(raw), Buffer.from(text.slice(at + 1))])
  }

  it.each<[string, Buffer]>([
    ['a byte-order mark first', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf(envelope())])],
    ['bytes that are no UTF-8 inside an ignored key', withRaw([0xed, 0xa0, 0x80])],
    ['no JSON', Buffer.from('{"payloadType":')],
    ['a list at the top', bytesOf([envelope()])],
    ['null at the top', Buffer.from('null')]
  ])('UPD-FILE-DAMAGED for %s (the reader above)', (_label, bytes) => {
    expect(run(bytes)).toEqual(DAMAGED)
  })

  it('UTF-8 inside an ignored key is read (the control of the row above)', () => {
    expect(run(withRaw([0xe2, 0x82, 0xac]))).toEqual(VERIFIED())
  })

  const without = (key: string): Record<string, unknown> => {
    const e = envelope()
    delete e[key]
    return e
  }
  const loneSurrogate = String.fromCharCode(0xd800)

  it.each<[string, Record<string, unknown>]>([
    ['no signatures', without('signatures')],
    ['signatures null', { ...envelope(), signatures: null }],
    ['signatures an object', { ...envelope(), signatures: { 0: entry(A) } }],
    ['signatures a string', { ...envelope(), signatures: JSON.stringify([entry(A)]) }],
    ['no payloadType', without('payloadType')],
    ['payloadType null', envelope({ type: null })],
    ['payloadType a number', envelope({ type: 1 })],
    ['payloadType a list', envelope({ type: [RELEASE_TYPE] })],
    ['payloadType with a lone surrogate', envelope({ type: loneSurrogate })],
    ['no payload', without('payload')],
    ['payload null', envelope({ encoded: null })],
    ['payload a number', envelope({ encoded: 1234 })],
    ['payload a list', envelope({ encoded: [PAYLOAD.toString('base64')] })]
  ])('UPD-FILE-DAMAGED for %s', (_label, env) => {
    expect(run(bytesOf(env))).toEqual(DAMAGED)
  })

  it('an empty payloadType is legal: it verifies, then is no update type (UPD-NOT-AN-UPDATE)', () => {
    expect(run(bytesOf(envelope({ type: '' })))).toEqual(NOT_AN_UPDATE)
  })

  it('unknown keys are ignored, an own __proto__ key among them', () => {
    const text = `{"__proto__":{"payloadType":"x","signatures":[]},"note":[1,{"b":2}],${JSON.stringify(envelope()).slice(1)}`
    expect(run(Buffer.from(text))).toEqual(VERIFIED())
  })

  // Keys are compared after JSON's escapes are decoded, and with a duplicate key the last one counts (§2.3, "JSON"):
  // `JSON.parse` does both. A reading of the text itself (a pre-scan, a streaming parser) would answer otherwise.
  /** `name` with its last character written as JSON's six-character escape: a backslash, `u`, four hex digits. */
  const escapeLast = (name: string): string =>
    `${name.slice(0, -1)}${String.fromCharCode(0x5c)}u${name.charCodeAt(name.length - 1).toString(16).padStart(4, '0')}`
  /** A signed envelope's text with each of `names` written with an escape wherever it is a key. */
  const withEscapedNames = (names: string[]): string =>
    names.reduce((text, name) => text.split(`"${name}":`).join(`"${escapeLast(name)}":`), JSON.stringify(envelope()))

  it.each<[string, string[]]>([
    ['payloadType', ['payloadType']],
    ['payload', ['payload']],
    ['signatures', ['signatures']],
    ['an entry\u{2019}s sig', ['sig']],
    ['all four at once', ['payloadType', 'payload', 'signatures', 'sig']]
  ])('a key name written with a JSON escape is that key: %s, and the envelope verifies', (_label, names) => {
    const text = withEscapedNames(names)
    for (const name of names) expect(text.includes(`"${name}":`), name).toBe(false) // the name is there only escaped
    expect(run(Buffer.from(text))).toEqual(VERIFIED())
  })

  const OTHER = Buffer.from('{"format":1,"product":"hilbertraum","kind":"other"}')

  it('a duplicate payload key, the last one the signed bytes: verified, and the bytes handed on are the last one\u{2019}s', () => {
    const text = `{"payload":${JSON.stringify(OTHER.toString('base64'))},${JSON.stringify(envelope()).slice(1)}`
    expect(run(Buffer.from(text))).toEqual(VERIFIED())
  })

  it('a duplicate payload key, the last one other bytes than the signed ones: UPD-UNKNOWN-SIGNER (no entry names a key)', () => {
    const signed = JSON.stringify(envelope({ signatures: [entry(A, { keyid: undefined })] }))
    const text = `${signed.slice(0, -1)},"payload":${JSON.stringify(OTHER.toString('base64'))}}`
    expect(run(Buffer.from(text))).toEqual(UNKNOWN_SIGNER)
  })

  // One key spelled both ways in one envelope (T4.1's re-check, N-1): the last one counts whichever spelling it has, so
  // a reading of the text that knows only the literal name, and takes its last one, answers both rows otherwise.
  const escapedPayloadKey = `"${escapeLast('payload')}":`
  const literalPayloadKeys = (text: string): number => text.split('"payload":').length - 1

  it('a literal payload key first (other bytes), an escaped one last (the signed bytes): verified with the last one\u{2019}s bytes', () => {
    const signed = JSON.stringify(envelope()).split('"payload":').join(escapedPayloadKey)
    const text = `{"payload":${JSON.stringify(OTHER.toString('base64'))},${signed.slice(1)}`
    expect(literalPayloadKeys(text)).toBe(1) // the first one only; the signed one is there only escaped
    expect(run(Buffer.from(text))).toEqual(VERIFIED())
  })

  it('a literal payload key first (the signed bytes), an escaped one last (other bytes): UPD-UNKNOWN-SIGNER (no entry names a key)', () => {
    const signed = JSON.stringify(envelope({ signatures: [entry(A, { keyid: undefined })] }))
    const text = `${signed.slice(0, -1)},${escapedPayloadKey}${JSON.stringify(OTHER.toString('base64'))}}`
    expect(literalPayloadKeys(text)).toBe(1) // the signed one only; the other one is there only escaped
    expect(run(Buffer.from(text))).toEqual(UNKNOWN_SIGNER)
  })

  it('the parsed value is never walked whole: 10,000 levels of nesting in an ignored key', () => {
    const text = `{"deep":${'['.repeat(10_000)}${']'.repeat(10_000)},${JSON.stringify(envelope()).slice(1)}`
    expect(run(Buffer.from(text))).toEqual(VERIFIED())
  })

  /** Run `body` while Object.prototype carries `name`: an own-keys-only reader never sees it. */
  function withInherited(name: string, value: unknown, body: () => unknown): unknown {
    Object.defineProperty(Object.prototype, name, { value, configurable: true, writable: true, enumerable: false })
    try {
      return body()
    } finally {
      delete (Object.prototype as Record<string, unknown>)[name]
    }
  }

  it.each<[string, string, unknown, () => Buffer, unknown]>([
    ['signatures', 'signatures', [entry(A)], () => bytesOf(without('signatures')), DAMAGED],
    ['payloadType', 'payloadType', RELEASE_TYPE, () => bytesOf(without('payloadType')), DAMAGED],
    ['payload', 'payload', PAYLOAD.toString('base64'), () => bytesOf(without('payload')), DAMAGED],
    ["an entry's sig", 'sig', entry(A).sig, () => bytesOf(envelope({ signatures: [{}] })), UNKNOWN_SIGNER],
    ["an entry's keyid", 'keyid', A.id, () => bytesOf(envelope({ signatures: [badEntry()] })), UNKNOWN_SIGNER]
  ])('only own keys count: an inherited %s is not read', (_label, name, value, bytes, expected) => {
    const b = bytes()
    expect(withInherited(name, value, () => run(b))).toEqual(expected)
  })

  it('the payload is handed on as its bytes: not parsed, not re-encoded', () => {
    const raw = Buffer.from([0xff, 0x00, 0xfe, 0x7b])
    expect(run(bytesOf(envelope({ payload: raw })))).toEqual(VERIFIED(raw))
  })

  // T4.4d m-6: node decodes a short base64 text into a slice of its shared buffer pool, beside unrelated small buffers
  // of the process. The verified payload is the only view of its memory: its buffer starts at it and holds it alone.
  it('a small verified payload lives in a buffer of its own, not in a slice of a shared one', () => {
    const r = verifyEnvelope(bytesOf(envelope()), KEYS, RUNNING)
    expect(r.verified && r.payload.equals(PAYLOAD)).toBe(true)
    const payload = r.verified ? r.payload : Buffer.alloc(0)
    expect({ byteOffset: payload.byteOffset, bufferBytes: payload.buffer.byteLength }).toEqual({ byteOffset: 0, bufferBytes: PAYLOAD.length })
  })
})

describe('verifyEnvelope: at most 64 signatures, counted after the parse and before any verification (record §2.3)', () => {
  const skipped = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, () => ({}))

  it('64 entries are read: the last one verifies', () => {
    expect(run(bytesOf(envelope({ signatures: [...skipped(63), entry(A)] })))).toEqual(VERIFIED())
  })

  it('65 entries are UPD-TOO-NEW, even when the first one verifies', () => {
    expect(run(bytesOf(envelope({ signatures: [entry(A), ...skipped(64)] })))).toEqual(TOO_NEW)
  })

  it('the count comes before the payloadType is read (the table\u{2019}s order)', () => {
    const e = envelope({ signatures: skipped(65) })
    delete e.payloadType
    expect(run(bytesOf(e))).toEqual(TOO_NEW)
  })

  it('the parsed value is counted: a duplicate signatures key, the last one counting', () => {
    const first = JSON.stringify(Array.from({ length: 65 }, () => ({ sig: 'AAAA' })))
    expect(run(Buffer.from(`{"signatures":${first},${JSON.stringify(envelope()).slice(1)}`))).toEqual(VERIFIED())
  })

  it('no signature at all is UPD-UNKNOWN-SIGNER (owner 2026-11-26)', () => {
    expect(run(bytesOf(envelope({ signatures: [] })))).toEqual(UNKNOWN_SIGNER)
  })
})

describe('verifyEnvelope: the base64 grammar of payload and sig (record §2.3)', () => {
  // Buffer.from(…, 'base64') reads every one of these; the grammar is checked by hand first. Each refused text is signed
  // over the bytes node's lenient decoder gives it, so only the grammar can refuse it.
  it.each<[string, string, string]>([
    ['standard, with + and /', '+/+/', 'fbffbf'],
    ['URL-safe, with - and _', '-_-_', 'fbffbf'],
    ['one padding character', '+/8=', 'fbff'],
    ['one padding character, URL-safe', '-_8=', 'fbff'],
    ['two padding characters', '+w==', 'fb'],
    ['the empty string: 0 bytes', '', '']
  ])('a payload in %s verifies', (_label, encoded, hex) => {
    const payload = Buffer.from(hex, 'hex')
    expect(run(bytesOf(envelope({ payload, encoded })))).toEqual(VERIFIED(payload))
  })

  it.each<[string, string]>([
    ['without its padding', '+/8'],
    ['with a length that is no multiple of 4', '+/+/+'],
    ['in both alphabets', '-/8='],
    ['in both alphabets, the other pair', '+_8='],
    ['with spaces inside', '+/+/    +/+/'],
    ['with line breaks inside', '+/+/\r\n\r\n+/+/'],
    ['with spaces after the padding', '+/8=    '],
    ['with = inside', '+w==+w=='],
    ['with a character of neither alphabet', '+/8.'],
    ['with non-zero pad bits, one padding character', '+/9='],
    ['with non-zero pad bits, two padding characters', '+x=='],
    // T4.4d M-2: the rows above set the lowest unused bit, in the standard alphabet; these set only the highest one
    // (C = 0b000010 has two unused bits, I = 0b001000 four), and a pad bit in the URL-safe alphabet (9 = 0b111101).
    ['with only the highest pad bit set, one padding character', 'AAC='],
    ['with only the highest pad bit set, two padding characters', 'AI=='],
    ['in the URL-safe alphabet with non-zero pad bits', '-_9=']
  ])('a payload %s is UPD-FILE-DAMAGED', (_label, encoded) => {
    const payload = Buffer.from(encoded, 'base64') // what a lenient decoder reads
    expect(run(bytesOf(envelope({ payload, encoded })))).toEqual(DAMAGED)
  })

  // One payload whose signature by A holds both `+` and `/`, so every form below can be made from it.
  const sigPayload = ((): Buffer => {
    for (let i = 0; i < 1000; i++) {
      const p = Buffer.from(`{"format":1,"n":${i}}`)
      const s = signature(A, RELEASE_TYPE, p).toString('base64')
      if (s.includes('+') && s.includes('/')) return p
    }
    throw new Error('no signature with both + and / in 1000 tries')
  })()
  const S = signature(A, RELEASE_TYPE, sigPayload).toString('base64')
  const SEXTETS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const withSig = (sig: string): Buffer => bytesOf(envelope({ payload: sigPayload, signatures: [{ sig }] }))

  it.each<[string, string]>([
    ['standard base64 with padding', S],
    ['URL-safe base64 with padding', S.replace(/\+/g, '-').replace(/\//g, '_')]
  ])('a sig in %s verifies', (_label, sig) => {
    expect(run(withSig(sig))).toEqual(VERIFIED(sigPayload))
  })

  it.each<[string, string]>([
    ['without its padding', S.slice(0, -2)],
    ['in both alphabets', S.replace('+', '-')],
    ['with spaces inside', `${S.slice(0, 44)}    ${S.slice(44)}`],
    ['with line breaks inside', `${S.slice(0, 44)}\r\n\r\n${S.slice(44)}`],
    ['with non-zero pad bits', `${S.slice(0, 85)}${SEXTETS[SEXTETS.indexOf(S[85]) | 1]}==`]
  ])('a sig %s does not count: no keyid, so UPD-UNKNOWN-SIGNER', (_label, sig) => {
    expect(Buffer.from(sig, 'base64').equals(Buffer.from(S, 'base64'))).toBe(true) // a lenient decoder reads the signature
    expect(run(withSig(sig))).toEqual(UNKNOWN_SIGNER)
  })
})

describe('verifyEnvelope: signature entries, every key, keyid a hint (record §2.3)', () => {
  const sig = (): string => entry(A).sig as string
  const longer = (extra: Buffer): string => Buffer.concat([signature(A), extra]).toString('base64')

  it.each<[string, unknown]>([
    ['a string', 'x'],
    ['a number', 1],
    ['null', null],
    ['a list', [sig()]],
    ['an object without sig', {}],
    ['sig a number', { sig: 1 }],
    ['sig outside the grammar', { sig: 'not base64!' }],
    ['sig of 63 bytes', { sig: signature(A).subarray(0, 63).toString('base64') }],
    ['sig of 0 bytes', { sig: '' }]
  ])('an entry that does not count is skipped, never a refusal: %s, then a signature that verifies', (_label, junk) => {
    expect(run(bytesOf(envelope({ signatures: [junk, entry(A)] })))).toEqual(VERIFIED())
  })

  it.each<[string, string]>([
    ['65 bytes whose first 64 verify', longer(Buffer.from([0]))],
    ['128 bytes: the signature twice', longer(signature(A))]
  ])('a sig of %s is no Ed25519 signature: skipped', (_label, s) => {
    expect(run(bytesOf(envelope({ signatures: [{ sig: s }] })))).toEqual(UNKNOWN_SIGNER)
  })

  it.each<[string, unknown]>([
    ['an unknown key\u{2019}s id', U.id],
    ['no keyid', undefined],
    ['the other embedded key\u{2019}s id', B.id],
    ['a number', 7],
    ['the empty string', '']
  ])('a signature that verifies counts whatever its keyid: %s', (_label, keyid) => {
    expect(run(bytesOf(envelope({ signatures: [entry(A, { keyid })] })))).toEqual(VERIFIED())
  })

  it.each<[string, readonly UpdateKey[], TestKey]>([
    ['the second of two keys', keySet(A, B), B],
    ['the last of three keys', keySet(U, B, A), A]
  ])('every key is tried: a signature by %s verifies', (_label, keys, by) => {
    expect(run(bytesOf(envelope({ by })), keys)).toEqual(VERIFIED())
  })

  it.each<[string, unknown[]]>([
    ['a bad signature first, then a good one', [badEntry(A.id), entry(A)]],
    ['an unknown key\u{2019}s good signature, then a known key\u{2019}s', [entry(U), entry(B)]]
  ])('two signatures: %s verifies', (_label, signatures) => {
    expect(run(bytesOf(envelope({ signatures })))).toEqual(VERIFIED())
  })

  it.each<[string, unknown[]]>([
    ['a bad signature naming an embedded key', [badEntry(A.id)]],
    ['a skipped sig (65 bytes) naming an embedded key', [{ sig: longer(Buffer.from([0])), keyid: B.id }]],
    ['an entry with no sig naming an embedded key', [{ keyid: A.id }]],
    ['an unknown key\u{2019}s good signature and an entry naming an embedded key', [entry(U), badEntry(A.id)]],
    ['an embedded key\u{2019}s id first, then a made-up one', [badEntry(B.id), badEntry('ab'.repeat(32))]]
  ])('no signature verifies and %s: UPD-NOT-GENUINE', (_label, signatures) => {
    expect(run(bytesOf(envelope({ signatures })))).toEqual(NOT_GENUINE)
  })

  it.each<[string, unknown[]]>([
    ['bad signatures under made-up ids', [badEntry('ab'.repeat(32)), badEntry('not an id')]],
    ['a bad signature without keyid', [badEntry()]],
    ['a bad signature under an empty keyid', [badEntry('')]],
    ['a bad signature under a keyid that is a number', [badEntry(7)]],
    ['a bad signature under an embedded id in upper case', [badEntry(A.id.toUpperCase())]],
    ['an unknown key\u{2019}s good signature under its own id', [entry(U)]]
  ])('no signature verifies and no entry names an embedded key, %s: UPD-UNKNOWN-SIGNER', (_label, signatures) => {
    expect(run(bytesOf(envelope({ signatures })))).toEqual(UNKNOWN_SIGNER)
  })
})

describe('verifyEnvelope: the payloadType is decided after a signature verified (record §2.3, §4.3)', () => {
  it.each<[string, string, TestKey, unknown]>([
    ['the release type from a known key', RELEASE_TYPE, A, VERIFIED()],
    ['another HilbertRaum type from a known key', MODEL_PACK_TYPE, A, FOR_NEWER],
    ['the bare HilbertRaum prefix from a known key', 'application/vnd.hilbertraum.', B, FOR_NEWER],
    ['the release type in another case from a known key', 'Application/vnd.hilbertraum.release+json', A, NOT_AN_UPDATE],
    ['another product\u{2019}s type from a known key', 'application/vnd.in-toto+json', A, NOT_AN_UPDATE],
    ['another HilbertRaum type from an unknown key', MODEL_PACK_TYPE, U, UNKNOWN_SIGNER],
    ['the release type from an unknown key', RELEASE_TYPE, U, UNKNOWN_SIGNER],
    ['another product\u{2019}s type from an unknown key', 'application/json', U, UNKNOWN_SIGNER]
  ])('%s', (_label, type, by, expected) => {
    expect(run(bytesOf(envelope({ type, by })))).toEqual(expected)
  })

  it('another HilbertRaum type whose signature fails, naming an embedded key: UPD-NOT-GENUINE', () => {
    expect(run(bytesOf(envelope({ type: MODEL_PACK_TYPE, signatures: [badEntry(A.id)] })))).toEqual(NOT_GENUINE)
  })

  it.each<[string, () => Record<string, unknown>]>([
    ['payloadType', () => ({ ...envelope(), payloadType: MODEL_PACK_TYPE })],
    ['payload', () => ({ ...envelope(), payload: Buffer.from('{"format":1,"product":"hilbertraum","kind":"release "}').toString('base64') })],
    ['sig', () => ({ ...envelope(), signatures: [{ keyid: A.id, sig: (() => { const s = signature(A); s[0] ^= 1; return s.toString('base64') })() }] })]
  ])('a tampered %s: the signature fails, UPD-NOT-GENUINE', (_label, env) => {
    expect(run(bytesOf(env()))).toEqual(NOT_GENUINE)
  })
})

// ---- The committed contract vectors (record §10.7): written from the DSSE specification, RFC 8032 and the record by
// another task, never from this code (C14), and locked by the golden manifest. A vector that disagrees with the code is
// never edited here: the disagreement goes to the orchestrator.

interface PaeVector {
  id: string
  payloadType: string
  /** Base64. */
  body: string
  /** Base64. */
  pae: string
}

interface Ed25519Vector {
  id: string
  spki: string
  keyId: string
  /** Hex. */
  message: string
  /** Hex, 64 bytes. */
  signature: string
}

type KeySetVector = { id: string; expect: { valid: true; ids: string[] } | { valid: false } } & ({ keySet: string } | { keysJson: string })

describe('the spec vectors: DSSE\u{2019}s PAE (spec/pae.json; record §2.3 "Verification")', () => {
  it.each(vectorFile<PaeVector>('spec', 'pae.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(pae(v.payloadType, Buffer.from(v.body, 'base64')).toString('base64')).toBe(v.pae)
  })
})

describe('the spec vectors: RFC 8032 §7.1\u{2019}s Ed25519 (spec/ed25519.json; record §2.3 "Verification", §2.7)', () => {
  it.each(vectorFile<Ed25519Vector>('spec', 'ed25519.json').map((v) => [v.id, v] as const))(
    '%s: its SPKI reads with its id, its signature verifies over its message, and over a message one byte different it does not',
    (_id, v) => {
      const read = parseKeySet(MARKER + v.spki)
      const keys = read.valid ? read.keys : []
      expect(keys.map((k) => k.id)).toEqual([v.keyId])
      const message = Buffer.from(v.message, 'hex')
      const signed = Buffer.from(v.signature, 'hex')
      expect(verify(null, message, keys[0].key, signed)).toBe(true)
      // The last byte's low bit flipped; TEST 1's message is empty, so it gains one byte.
      const other = message.length === 0 ? Buffer.from([0]) : Buffer.concat([message.subarray(0, -1), Buffer.from([message[message.length - 1] ^ 1])])
      expect(verify(null, other, keys[0].key, signed)).toBe(false)
    }
  )
})

describe('the spec vectors: the key set (spec/key-set.json; record §2.7)', () => {
  // A `keysJson` text stands for its UTF-8 bytes (a byte-order mark is written as its JSON escape, so the bytes start
  // EF BB BF), read as the file readers read keys.json (§2.7 "The file readers"; the committed file's row above).
  const answer = (v: KeySetVector): unknown => {
    let read: KeySetRead | null
    if ('keySet' in v) read = parseKeySet(v.keySet)
    else {
      const json = readJsonObject(Buffer.from(v.keysJson, 'utf8'))
      read = json === null ? null : parseKeySet(Object.hasOwn(json, 'key_set') ? json.key_set : undefined)
    }
    return read?.valid ? { valid: true, ids: read.keys.map((k) => k.id) } : { valid: false }
  }

  it.each(vectorFile<KeySetVector>('spec', 'key-set.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(answer(v)).toEqual(v.expect)
  })
})

/**
 * The sets whose vectors this file runs through the envelope check (§10.7 "File shape and routing"). The set reader
 * (tests/helpers/update-vectors.ts) lists a set's `vectors*.json` by name (spec/: its three own files, whose vectors
 * have no envelope), guards each vector's form, and throws when a listed set does not exist or holds no vector.
 */
const ENVELOPE_SETS = ['spec', 'negative', 'positive']

/**
 * Whether some `sig` of the envelope is a signature by one of `spkis` over the release type's PAE of `payload`: the
 * test's own parse, PAE and key loading, so "the bytes handed on are the signed ones" does not lean on the code.
 */
function signedByAVectorKey(bytes: Buffer, spkis: string[], payload: Buffer): boolean {
  const parsed = JSON.parse(bytes.toString('utf8')) as { signatures?: unknown }
  const entries: unknown[] = Array.isArray(parsed.signatures) ? parsed.signatures : []
  const keys = spkis.map((s) => createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' }))
  const message = testPae(RELEASE_TYPE, payload)
  return entries.some((e) => {
    const sig = typeof e === 'object' && e !== null ? (e as { sig?: unknown }).sig : undefined
    if (typeof sig !== 'string') return false
    return keys.some((k) => {
      try {
        return verify(null, message, k, Buffer.from(sig, 'base64'))
      } catch {
        return false
      }
    })
  })
}

describe('the contract vectors: the envelope stage of every vector with an envelope (record §10.7; §2.3, §2.10)', () => {
  // Routed by form, never by file or stage (§10.7 "File shape and routing"): an envelope runs the envelope check here,
  // whatever its `expect.stage`; a `version` alone is the version rule's (updates-version.test.ts).
  const runs = ENVELOPE_SETS.flatMap((set) =>
    setVectors(set)
      .filter(({ vector }) => vector.envelope !== undefined)
      .map(({ file, vector }) => [`${set}/${file} ${vector.id}`, vector] as const)
  )
  if (runs.length === 0) throw new Error('the listed sets hold no vector with an envelope')

  it.each(runs)('%s', (_label, v) => {
    const read = parseKeySet(MARKER + (v.keys ?? []).join(','))
    expect(read.valid, 'the vector\u{2019}s keys read as a key set').toBe(true)
    const bytes = envelopeBytes(v.envelope!)
    const r = verifyEnvelope(bytes, read.valid ? read.keys : [], v.host.runningVersion as string)
    if (v.expect.stage === 'envelope') {
      expect(outcome(r)).toEqual({ code: v.expect.code, params: v.expect.params })
    } else {
      // The envelope passed; what the payload answers is updates-payload.test.ts's. Here only: it verified, and the
      // bytes it hands on are bytes one of the vector's keys signed.
      expect(r.verified, r.verified ? '' : JSON.stringify(outcome(r))).toBe(true)
      expect(r.verified && signedByAVectorKey(bytes, v.keys ?? [], r.payload)).toBe(true)
    }
  })
})

// The release tools load envelope.ts through Node's own type stripping (Δ-75 row 4), with P3's sibling-import hook
// (scripts/lib/ts-sibling-imports.mjs): so it imports no JSON, no `electron` and no `@shared` path, and holds only
// TypeScript that stripping can erase. The typecheck sees none of that; this row loads it so.
describe('envelope.ts loads under Node type stripping', () => {
  it('a plain node process with the hook loads it alone and verifies an envelope it signs', () => {
    const url = (...p: string[]) => JSON.stringify(pathToFileURL(join(...p)).href)
    const script = [
      `const { registerTsSiblingImports } = await import(${url(REPO_ROOT, 'scripts', 'lib', 'ts-sibling-imports.mjs')})`,
      'registerTsSiblingImports()',
      `const m = await import(${url(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'envelope.ts')})`,
      "const { generateKeyPairSync, sign } = await import('node:crypto')",
      "const { publicKey, privateKey } = generateKeyPairSync('ed25519')",
      `const set = m.parseKeySet(${JSON.stringify(MARKER)} + publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))`,
      "const payload = Buffer.from('{}')",
      "const sig = sign(null, m.pae(m.RELEASE_PAYLOAD_TYPE, payload), privateKey).toString('base64')",
      "const bytes = Buffer.from(JSON.stringify({ payloadType: m.RELEASE_PAYLOAD_TYPE, payload: payload.toString('base64'), signatures: [{ sig }] }))",
      "console.log(JSON.stringify([set.valid, m.verifyEnvelope(bytes, set.keys, '1.0.0').verified, m.verifyEnvelope(bytes, [], '1.0.0').refusal.code]))"
    ].join('\n')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: testBudgetMs(60_000)
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('[true,true,"UPD-NOT-AVAILABLE"]')
  })
})
