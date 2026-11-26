#!/usr/bin/env node
// Writes the `spec/` contract vectors of the app-update trust core (docs/app-updates.md section 10.7; F-1, F-3):
// pae.json, ed25519.json and key-set.json. Plain Node, no dependency, no import from the repository.
//
//   node generate.mjs --rfc <rfc8032.txt> --dsse <dsse protocol.md> --out <an empty folder>
//
// The two sources are not in the repository (PROVENANCE.md names their versions and sha256). Every value of
// pae.json's first vector and of ed25519.json is read from them; this file computes only the two derived values
// section 10.7 asks for (`spki`, `keyId`), which PROVENANCE.md records again from a second tool.
//
// The committed files are the golden. This script documents how they were made: pae.json and ed25519.json come out
// byte for byte the same on every run; key-set.json's sixteen-key and seventeen-key vectors and its three
// not-weak-generated-key vectors use key pairs made at run time (their private halves are never exported, written or
// printed), so a new run gives other keys there.
// RFC 8032's secret-key lines are never read into a value: the parser takes the blocks it names and no other.
//
// The weak-key vectors (section 2.7 'A weak key') take every expected value from that row's rule, applied here with
// BigInt arithmetic over the little-endian key bytes: no crypto library decides whether a key is weak.

import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? null : (process.argv[i + 1] ?? null)
}
const rfcPath = arg('--rfc')
const dssePath = arg('--dsse')
const outDir = arg('--out')
if (!rfcPath || !dssePath || !outDir) {
  console.error('usage: node generate.mjs --rfc <rfc8032.txt> --dsse <dsse protocol.md> --out <an empty folder>')
  process.exit(2)
}
if (existsSync(outDir) && readdirSync(outDir).some((n) => n.endsWith('.json'))) {
  console.error('the output folder already holds vectors: they are the golden, write somewhere else')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
// JSON with every character outside printable ASCII written as an escape: the vector files stay plain ASCII.
const asciiJson = (value) => JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const fileText = (vectors) => '[\n' + vectors.map(asciiJson).join(',\n') + '\n]\n'
function checkIds(vectors) {
  const seen = new Set()
  for (const v of vectors) {
    if (!/^[a-z0-9-]+$/.test(v.id) || seen.has(v.id)) throw new Error('bad or repeated id ' + v.id)
    if (v.why.includes('\n')) throw new Error('why is one line: ' + v.id)
    seen.add(v.id)
  }
}

// ---- section 2.7: the SubjectPublicKeyInfo of an Ed25519 key is the fixed 12 bytes below, then the 32 key bytes
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const spkiOf = (raw32) => Buffer.concat([SPKI_PREFIX, raw32])
const MARKER = 'hilbertraum-key-set-1:'

// ---- pae.json -------------------------------------------------------------------------------------------------
const dsse = readFileSync(dssePath, 'utf8').replace(/\r\n/g, '\n')
function fenced(label) {
  const at = dsse.indexOf('\n' + label + '\n', dsse.indexOf('## Test Vectors'))
  if (at < 0) throw new Error('DSSE protocol.md: no block ' + label)
  const open = dsse.indexOf('```none\n', at) + '```none\n'.length
  return dsse.slice(open, dsse.indexOf('\n```', open))
}
const dsseBody = fenced('SERIALIZED_BODY:')
const dsseType = fenced('PAYLOAD_TYPE:')
const dssePae = fenced('PAE:')
// The printed PAE line is the expected value; the formula is only held against it here.
if (dssePae !== `DSSEv1 ${Buffer.byteLength(dsseType)} ${dsseType} ${Buffer.byteLength(dsseBody)} ${dsseBody}`) {
  throw new Error('DSSE protocol.md: the printed PAE is not the definition applied to the printed type and body')
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const utf8 = (text) => Buffer.from(text, 'utf8')
const paeVectors = [
  {
    id: 'dsse-protocol-example',
    why: "DSSE protocol.md (commit 75a79b6e), 'Test Vectors': the PAE line as printed, for the printed PAYLOAD_TYPE and SERIALIZED_BODY (its signature example is ECDSA and is not used)",
    payloadType: dsseType,
    body: b64(utf8(dsseBody)),
    pae: b64(utf8(dssePae))
  },
  {
    id: 'derived-empty-type-and-body',
    why: "DSSE protocol.md, the PAE definition, written out by hand: both lengths are '0' and both values empty, so the bytes are 'DSSEv1 0  0 ' (two spaces between the zeros, one after the last); app-updates.md section 2.3 'Verification' ('0' for none)",
    payloadType: '',
    body: '',
    pae: b64(utf8('DSSEv1 0  0 '))
  },
  {
    id: 'derived-lengths-are-byte-counts',
    why: "DSSE protocol.md, 'LEN(s) = ASCII decimal encoding of the byte length of s', written out by hand: the type U+00E4 U+1F600 is 2 + 4 = 6 UTF-8 bytes (2 code points, 3 UTF-16 units), the body U+20AC is 3 bytes; app-updates.md section 2.3 'Verification' (byte counts)",
    payloadType: '\u{e4}\u{1f600}',
    body: b64(utf8('\u{20ac}')),
    pae: b64(utf8('DSSEv1 6 \u{e4}\u{1f600} 3 \u{20ac}'))
  },
  {
    id: 'derived-body-is-bytes',
    why: "DSSE protocol.md, 'SERIALIZED_BODY: Arbitrary byte sequence', written out by hand: the body is the two bytes 00 ff (no UTF-8 text), the type the one byte 't'",
    payloadType: 't',
    body: b64(Buffer.from([0x00, 0xff])),
    pae: b64(Buffer.concat([utf8('DSSEv1 1 t 2 '), Buffer.from([0x00, 0xff])]))
  },
  {
    id: 'derived-length-of-ten-and-more',
    why: "DSSE protocol.md, 'with no leading zeros', written out by hand: a type of 10 bytes and a body of 100 bytes give the lengths '10' and '100'",
    payloadType: 'abcdefghij',
    body: b64(utf8('x'.repeat(100))),
    pae: b64(utf8('DSSEv1 10 abcdefghij 100 ' + 'x'.repeat(100)))
  }
]

// ---- ed25519.json: RFC 8032 section 7.1 -----------------------------------------------------------------------
const rfc = readFileSync(rfcPath, 'latin1').replace(/\r\n/g, '\n')
const start = rfc.lastIndexOf('7.1.  Test Vectors for Ed25519\n')
const end = rfc.lastIndexOf('7.2.  Test Vectors for Ed25519ctx')
if (start < 0 || end < start) throw new Error('RFC 8032: section 7.1 not found')
const HEX_LINE = /^ {3}[0-9a-f]+$/
function rfcTest(name) {
  const from = rfc.indexOf('-----TEST ' + name + '\n', start)
  if (from < 0 || from > end) throw new Error('RFC 8032: no TEST ' + name)
  const next = rfc.indexOf('\n   -----', from + 1)
  const lines = rfc.slice(from, next < 0 || next > end ? end : next).split('\n')
  // The hex lines that follow one label, up to the next label; page breaks and blank lines between them are skipped.
  function block(label) {
    const at = lines.findIndex((l) => l.trim().startsWith(label))
    if (at < 0) throw new Error(`RFC 8032 TEST ${name}: no ${label}`)
    let hex = ''
    for (let i = at + 1; i < lines.length; i++) {
      if (/^ {3}[A-Z][A-Z ]+[:(]/.test(lines[i])) break
      if (HEX_LINE.test(lines[i])) hex += lines[i].trim()
    }
    return { hex, label: lines[at].trim() }
  }
  const publicKey = block('PUBLIC KEY:').hex
  const message = block('MESSAGE (length')
  const signature = block('SIGNATURE:').hex
  const declared = Number(/length (\d+) byte/.exec(message.label)[1])
  if (publicKey.length !== 64 || signature.length !== 128 || message.hex.length !== declared * 2) {
    throw new Error(`RFC 8032 TEST ${name}: a block has another length than the RFC states`)
  }
  return { publicKey, message: message.hex, signature }
}
const RFC_TESTS = [
  ['rfc8032-test-1', '1', 'the empty message'],
  ['rfc8032-test-2', '2', 'a message of 1 byte'],
  ['rfc8032-test-3', '3', 'a message of 2 bytes'],
  ['rfc8032-test-1024', '1024', 'a message of 1,023 bytes'],
  ['rfc8032-test-sha-abc', 'SHA(abc)', 'a message of 64 bytes, SHA-512 of abc']
]
const edVectors = RFC_TESTS.map(([id, name, what]) => {
  const t = rfcTest(name)
  const spki = spkiOf(Buffer.from(t.publicKey, 'hex'))
  // The RFC's own signature must verify under the key as this file writes it: a check of the transcription.
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  if (!verify(null, Buffer.from(t.message, 'hex'), key, Buffer.from(t.signature, 'hex'))) {
    throw new Error(`RFC 8032 TEST ${name}: the signature does not verify`)
  }
  return {
    id,
    why: `RFC 8032 section 7.1, TEST ${name} (${what}): PUBLIC KEY, MESSAGE and SIGNATURE as printed; spki and keyId as app-updates.md section 2.7 defines them ('Shape', 'A key's id')`,
    publicKey: t.publicKey,
    spki: spki.toString('base64'),
    keyId: sha256hex(spki),
    message: t.message,
    signature: t.signature
  }
})

// ---- key-set.json: section 2.7 --------------------------------------------------------------------------------
const K = edVectors.map((v) => v.spki) // RFC 8032's five public keys, as key-set entries
const ID = edVectors.map((v) => v.keyId)
const S27 = 'app-updates.md section 2.7'
/** A public key made now; its private half is dropped with this function's frame, never exported. */
function freshEntry() {
  const spki = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })
  if (isWeak(spki.subarray(12))) throw new Error('a generated key is weak: section 2.7 says that cannot happen')
  return { entry: spki.toString('base64'), id: sha256hex(spki) }
}

// ---- section 2.7 'A weak key': the rule, as the row words it ---------------------------------------------------
// "read the 32 key bytes as a little-endian number and clear its top bit (bit 255): that is the key's y. The key is
// weak [...] when y is not below p = 2^255 - 19 [...], or when y is one of the five values that the eight
// small-order points of Ed25519 have: 0, 1, p - 1, and the two numbers whose 32-byte little-endian forms (top bit
// clear) are 26e8...fc05 and c717...037a, either sign bit."
const P = (1n << 255n) - 19n
const TOP_BIT = 1n << 255n
function littleEndian(bytes) {
  if (bytes.length !== 32) throw new Error('a key is 32 bytes')
  let n = 0n
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}
const ORDER_8_A = littleEndian(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'))
const ORDER_8_B = littleEndian(Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex'))
const yOf = (bytes) => littleEndian(bytes) & (TOP_BIT - 1n)
function isWeak(bytes) {
  const y = yOf(bytes)
  return y >= P || y === 0n || y === 1n || y === P - 1n || y === ORDER_8_A || y === ORDER_8_B
}
/** The 32 key bytes that encode `y` (below 2^255) with the sign bit (bit 255) clear or set. */
function keyBytes(y, signSet) {
  if (y < 0n || y >= TOP_BIT) throw new Error('y has 255 bits')
  let n = signSet ? y | TOP_BIT : y
  const bytes = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return bytes
}
// Whether some curve point has this y (RFC 8032 section 5.1.3: x^2 = (y^2 - 1) / (d y^2 + 1) must be a square).
// Used only in a vector's `why`: the row's rule does not ask whether a key is a curve point.
function modPow(base, exp) {
  let r = 1n
  let b = ((base % P) + P) % P
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P
    b = (b * b) % P
  }
  return r
}
const D = (P - ((121665n * modPow(121666n, P - 2n)) % P)) % P
function isCurveY(y) {
  const u = (((y * y - 1n) % P) + P) % P
  const v = (D * y * y + 1n) % P
  const xx = (u * modPow(v, P - 2n)) % P
  return xx === 0n || modPow(xx, (P - 1n) / 2n) === 1n
}

const fresh = Array.from({ length: 15 }, freshEntry)
const sixteen = [...K.map((entry, i) => ({ entry, id: ID[i] })), ...fresh.slice(0, 11)]
const seventeen = [...sixteen, fresh[11]]
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const urlKey = K.find((k) => /[+/]/.test(k))
if (!urlKey) throw new Error('none of the five keys has + or / in its base64')
const raw1 = Buffer.from(edVectors[0].publicKey, 'hex')
const entryOf = (bytes) => Buffer.from(bytes).toString('base64')
const anyBytes = (bytes) => ({ entry: entryOf(spkiOf(bytes)), id: sha256hex(spkiOf(bytes)) })
const valid = (ids) => ({ valid: true, ids })
const INVALID = { valid: false }
const set = (id, why, keySet, expect) => ({ id, why, keySet, expect })
const file = (id, why, keysJson, expect) => ({ id, why, keysJson, expect })

const WEAK = `${S27} 'A weak key'`
const signText = (signSet) => (signSet ? 'sign bit set' : 'sign bit clear')
/**
 * A set of one key whose 32 bytes encode `y` with the sign bit as given. The expected value is the row's rule
 * applied to the bytes as written; `weak` is what this file's writer expects, and a difference stops the run.
 */
function oneKey(id, weak, y, signSet, what) {
  const bytes = keyBytes(y, signSet)
  if (isWeak(bytes) !== weak) throw new Error(`${id}: the rule says ${isWeak(bytes) ? 'weak' : 'not weak'}`)
  const key = anyBytes(bytes)
  const hex = bytes.toString('hex')
  if (weak) return set(id, `${WEAK}: ${what}, ${signText(signSet)} (key bytes ${hex}): a weak key, so the whole set is invalid`, MARKER + key.entry, INVALID)
  // A key that reads must load (section 2.7, the createPublicKey clause); held here for this run's Node only.
  createPublicKey({ key: spkiOf(bytes), format: 'der', type: 'spki' })
  const point = isCurveY(y) ? 'a curve point has this y' : 'no curve point has this y, which the row does not ask'
  return set(id, `${WEAK}: ${what}, ${signText(signSet)} (key bytes ${hex}; ${point}): y is below p and none of the five values, so the key is not weak and reads`, MARKER + key.entry, valid([key.id]))
}
const Y_MAX = TOP_BIT - 1n
const weakOrder8A = anyBytes(keyBytes(ORDER_8_A, false))
const weakOne = anyBytes(keyBytes(1n, false))
const weakP = anyBytes(keyBytes(P, false))
for (const k of [weakOrder8A, weakOne, weakP]) {
  if (!isWeak(Buffer.from(k.entry, 'base64').subarray(12))) throw new Error('a key meant to be weak is not')
}
const generated = fresh.slice(12, 15)
// Every key of a vector that reads is not weak by the rule: RFC 8032's five too.
for (const v of edVectors) {
  if (isWeak(Buffer.from(v.publicKey, 'hex'))) throw new Error(`${v.id}: the RFC's key is weak by the rule`)
}

const keySetVectors = [
  // -- sets that read
  set('empty-set', `${S27} 'Shape' and 'The empty set': the marker followed by zero keys`, MARKER, valid([])),
  set('one-key-rfc8032-test-1', `${S27} 'Shape', 'A key's id': RFC 8032 TEST 1's public key alone; its id is the lower-case hex SHA-256 of its 44 SPKI bytes, computed a second time with sha256sum and certutil (PROVENANCE.md)`, MARKER + K[0], valid([ID[0]])),
  set('two-keys', `${S27} 'Shape': two keys joined by one comma (RFC 8032 TEST 1 and TEST 2); ids in the string's order`, MARKER + [K[0], K[1]].join(','), valid([ID[0], ID[1]])),
  set('three-keys', `${S27} 'Shape': three keys, as release 1 embeds (RFC 8032 TEST 1, 2 and 3)`, MARKER + [K[0], K[1], K[2]].join(','), valid([ID[0], ID[1], ID[2]])),
  set('three-keys-other-order', `${S27} 'No role or label' and section 10.7 ('in the string's order'): the same three keys in the order 3, 1, 2 give the ids in that order; no key has a role`, MARKER + [K[2], K[0], K[1]].join(','), valid([ID[2], ID[0], ID[1]])),
  set('five-keys-rfc8032', `${S27} 'Shape': RFC 8032 section 7.1's five public keys`, MARKER + K.join(','), valid(ID)),
  set('sixteen-keys', `${S27} 'A set that does not read' ('more than 16 keys'): exactly 16 keys still read (the five RFC keys, then 11 made for this vector)`, MARKER + sixteen.map((k) => k.entry).join(','), valid(sixteen.map((k) => k.id))),
  file('file-empty-set-as-committed', `${S27} 'The empty set': the committed file until the ceremony, two-space indent, LF line ends, an LF at the end`, '{\n  "key_set": "' + MARKER + '"\n}\n', valid([])),
  file('file-one-key', `${S27} 'Shape': a whole keys.json holding RFC 8032 TEST 1's key`, '{\n  "key_set": "' + MARKER + K[0] + '"\n}\n', valid([ID[0]])),
  file('file-other-fields-ignored', `${S27} 'Shape' ('Every other field is ignored (a fork may add one)')`, '{\n  "comment": "a fork\'s own field",\n  "key_set": "' + MARKER + K[0] + ',' + K[1] + '",\n  "roles": ["active", "standby"]\n}\n', valid([ID[0], ID[1]])),

  // -- a missing or non-string key_set
  file('file-key-set-missing', `${S27} 'A set that does not read' ('a missing ... key_set'): an object without the field`, '{}\n', INVALID),
  file('file-key-set-other-case', `${S27} 'A set that does not read' ('a missing ... key_set'): the field name is key_set; Key_set is another field`, '{\n  "Key_set": "' + MARKER + K[0] + '"\n}\n', INVALID),
  file('file-key-set-number', `${S27} 'A set that does not read' ('a ... non-string key_set'): a number`, '{\n  "key_set": 1\n}\n', INVALID),
  file('file-key-set-null', `${S27} 'A set that does not read' ('a ... non-string key_set'): null`, '{\n  "key_set": null\n}\n', INVALID),
  file('file-key-set-array', `${S27} 'A set that does not read' ('a ... non-string key_set'): an array of key strings is no key_set string`, '{\n  "key_set": ["' + K[0] + '"]\n}\n', INVALID),
  file('file-key-set-object', `${S27} 'A set that does not read' ('a ... non-string key_set'): an object`, '{\n  "key_set": {"marker": "hilbertraum-key-set-1", "keys": []}\n}\n', INVALID),

  // -- another marker
  set('marker-empty-string', `${S27} 'A set that does not read' ('another marker'): the empty string`, '', INVALID),
  set('marker-number-2', `${S27} 'A set that does not read' ('another marker'; 'Shape': a later shape takes a new marker number): hilbertraum-key-set-2:`, 'hilbertraum-key-set-2:' + K[0], INVALID),
  set('marker-number-10', `${S27} 'A set that does not read' ('another marker'): hilbertraum-key-set-10: only starts like the marker`, 'hilbertraum-key-set-10:' + K[0], INVALID),
  set('marker-other-case', `${S27} 'A set that does not read' ('another marker'): the marker in another case`, 'Hilbertraum-Key-Set-1:' + K[0], INVALID),
  set('marker-without-colon', `${S27} 'Shape' (the marker ends with its colon): the marker's words without the colon`, 'hilbertraum-key-set-1', INVALID),
  set('marker-missing', `${S27} 'A set that does not read' ('another marker'): a key with no marker before it`, K[0], INVALID),
  set('marker-leading-space', `${S27} 'A set that does not read' ('another marker'): a space before the marker`, ' ' + MARKER + K[0], INVALID),
  set('marker-space-before-colon', `${S27} 'A set that does not read' ('another marker'): a space between the marker's words and its colon`, 'hilbertraum-key-set-1 :' + K[0], INVALID),

  // -- an entry that is not canonical standard base64
  set('entry-url-safe-alphabet', `${S27} 'A set that does not read' ('not canonical standard base64 (..., the standard alphabet only)'): a key written with - and _ in place of + and /`, MARKER + urlKey.replace(/\+/g, '-').replace(/\//g, '_'), INVALID),
  set('entry-without-padding', `${S27} 'A set that does not read' ('not canonical standard base64'; section 2.3 'The base64 grammar': padding is required): the 59 characters without the final =`, MARKER + K[0].replace(/=$/, ''), INVALID),
  set('entry-non-zero-pad-bits', `${S27} 'A set that does not read' ('not canonical standard base64'; section 2.3 'The base64 grammar': the unused bits of the last character are zero): the last character before = raised by one`, MARKER + K[0].slice(0, 58) + B64[B64.indexOf(K[0][58]) + 1] + '=', INVALID),
  set('entry-space-after-comma', `${S27} 'Shape' ('joined by , (no space, no other character)'): a space after the comma`, MARKER + K[0] + ', ' + K[1], INVALID),
  set('entry-trailing-newline', `${S27} 'Shape' ('no space, no other character'): a line feed after the last key`, MARKER + K[0] + '\n', INVALID),
  set('entry-trailing-space', `${S27} 'Shape' ('no space, no other character'): a space after the marker of an otherwise empty set`, MARKER + ' ', INVALID),
  set('entry-line-break-inside', `${S27} 'A set that does not read' ('not canonical standard base64'; section 2.3: no whitespace or line break): a line feed inside a key`, MARKER + K[0].slice(0, 30) + '\n' + K[0].slice(30), INVALID),
  set('entry-empty-trailing-comma', `${S27} 'Shape' ('zero or more public keys joined by ,'): a comma after the last key leaves an empty entry`, MARKER + K[0] + ',', INVALID),
  set('entry-empty-leading-comma', `${S27} 'Shape': a comma before the first key leaves an empty entry`, MARKER + ',' + K[0], INVALID),
  set('entry-empty-double-comma', `${S27} 'Shape': two commas between two keys leave an empty entry`, MARKER + K[0] + ',,' + K[1], INVALID),
  set('entry-second-colon', `${S27} 'Shape' ('no other character'): a second colon after the marker`, MARKER + ':' + K[0], INVALID),

  // -- an entry whose bytes are not the 12-byte prefix followed by 32 bytes
  set('entry-raw-32-bytes', `${S27} 'A set that does not read' ('not the 12-byte prefix followed by 32 bytes'): the raw 32 key bytes of RFC 8032 TEST 1 without the SPKI prefix`, MARKER + entryOf(raw1), INVALID),
  set('entry-43-bytes', `${S27} 'A set that does not read' ('44 in all'): the prefix and 31 key bytes`, MARKER + entryOf(spkiOf(raw1.subarray(0, 31))), INVALID),
  set('entry-45-bytes', `${S27} 'A set that does not read' ('44 in all'): the prefix and 33 key bytes`, MARKER + entryOf(spkiOf(Buffer.concat([raw1, Buffer.from([0])]))), INVALID),
  set('entry-x25519-prefix', `${S27} 'A set that does not read' ('not the 12-byte prefix'; 'Release 1 knows no other key type'): 44 bytes with the X25519 object identifier (2b656e) in place of Ed25519's (2b6570)`, MARKER + entryOf(Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw1])), INVALID),
  set('entry-prefix-last-byte-changed', `${S27} 'A set that does not read' ('not the 12-byte prefix'): the prefix's last byte 01 in place of 00, then 32 key bytes`, MARKER + entryOf(Buffer.concat([Buffer.from('302a300506032b6570032101', 'hex'), raw1])), INVALID),
  set('entry-hex-key', `${S27} 'A set that does not read' ('not the 12-byte prefix followed by 32 bytes'): the key as 64 hex characters (they are base64 characters too, and decode to 48 other bytes)`, MARKER + edVectors[0].publicKey, INVALID),

  // -- a repeated entry, and more than 16 keys
  set('repeated-entry', `${S27} 'A set that does not read' ('a repeated entry'): the same key twice`, MARKER + [K[0], K[0]].join(','), INVALID),
  set('repeated-entry-not-adjacent', `${S27} 'A set that does not read' ('a repeated entry'): the same key first and last of three`, MARKER + [K[0], K[1], K[0]].join(','), INVALID),
  set('seventeen-keys', `${S27} 'A set that does not read' ('more than 16 keys'): 17 different keys (the sixteen-keys vector's and one more)`, MARKER + seventeen.map((k) => k.entry).join(','), INVALID),
  set('one-bad-entry-spoils-the-set', `${S27} 'A set that does not read' ('the whole set is invalid'): two good keys and a third entry of 43 bytes`, MARKER + [K[0], K[1], entryOf(spkiOf(raw1.subarray(0, 31)))].join(','), INVALID),

  // -- a weak key: the eight small-order points' y values (0, 1, p - 1, the two order-8 values), either sign bit.
  //    The first vector keeps its id from before the row existed, when it expected a set that reads.
  oneKey('any-32-bytes-all-zero', true, 0n, false, '32 zero bytes after the prefix, y = 0 (a point of order 4)'),
  oneKey('weak-small-order-y-0-sign-set', true, 0n, true, 'y = 0 (the other point of order 4)'),
  oneKey('weak-small-order-y-1', true, 1n, false, 'y = 1 (the neutral point, order 1)'),
  oneKey('weak-small-order-y-1-sign-set', true, 1n, true, "y = 1 ('either sign bit': x is 0 here, and RFC 8032 section 5.1.3 step 4 refuses this encoding)"),
  oneKey('weak-small-order-y-p-minus-1', true, P - 1n, false, 'y = p - 1 (the point of order 2)'),
  oneKey('weak-small-order-y-p-minus-1-sign-set', true, P - 1n, true, "y = p - 1 ('either sign bit': x is 0 here, and RFC 8032 section 5.1.3 step 4 refuses this encoding)"),
  oneKey('weak-small-order-order-8-a', true, ORDER_8_A, false, 'y = the first order-8 value the row prints (26e8...fc05)'),
  oneKey('weak-small-order-order-8-a-sign-set', true, ORDER_8_A, true, 'y = the first order-8 value the row prints (26e8...fc05)'),
  oneKey('weak-small-order-order-8-b', true, ORDER_8_B, false, 'y = the second order-8 value the row prints (c717...037a)'),
  oneKey('weak-small-order-order-8-b-sign-set', true, ORDER_8_B, true, 'y = the second order-8 value the row prints (c717...037a)'),

  // -- a weak key: y not below p (the 19 values p to 2^255 - 1; RFC 8032 section 5.1.3 step 1 refuses them).
  //    The last vector keeps its id from before the row existed, when it expected a set that reads.
  oneKey('weak-non-canonical-y-p', true, P, false, "y = p ('not below p': the smallest non-canonical value)"),
  oneKey('weak-non-canonical-y-p-sign-set', true, P, true, "y = p ('not below p')"),
  oneKey('weak-non-canonical-y-p-plus-1', true, P + 1n, false, "y = p + 1 ('not below p')"),
  oneKey('weak-non-canonical-y-p-plus-1-sign-set', true, P + 1n, true, "y = p + 1 ('not below p')"),
  oneKey('weak-non-canonical-y-2-255-minus-1', true, Y_MAX, false, "y = 2^255 - 1 = p + 18 ('not below p': the largest value 255 bits hold; it is none of the five values reduced modulo p)"),
  oneKey('any-32-bytes-all-ff', true, Y_MAX, true, "32 bytes ff after the prefix, y = 2^255 - 1 ('not below p')"),

  // -- a weak key spoils the whole set
  set('weak-key-among-good-keys', `${WEAK} ('and the whole set invalid'): the order-8 key 26e8...fc05 between two good keys (RFC 8032 TEST 1 and TEST 2)`, MARKER + [K[0], weakOrder8A.entry, K[1]].join(','), INVALID),
  set('weak-key-first-of-three', `${WEAK} ('and the whole set invalid'): the non-canonical key y = p before two good keys`, MARKER + [weakP.entry, K[0], K[1]].join(','), INVALID),
  set('weak-key-last-of-three', `${WEAK} ('and the whole set invalid'): the key y = 1 after two good keys`, MARKER + [K[0], K[1], weakOne.entry].join(','), INVALID),

  // -- not weak: the values next to each boundary, and keys from a key generator
  oneKey('not-weak-y-2', false, 2n, false, 'y = 2, next to 1'),
  oneKey('not-weak-y-3', false, 3n, false, 'y = 3'),
  oneKey('not-weak-y-p-minus-2', false, P - 2n, false, 'y = p - 2, next to p - 1'),
  oneKey('not-weak-y-p-minus-3', false, P - 3n, false, 'y = p - 3'),
  oneKey('not-weak-y-p-minus-3-sign-set', false, P - 3n, true, 'y = p - 3 (the key bytes are above p as a 256-bit number; y is what remains with bit 255 cleared)'),
  oneKey('not-weak-order-8-a-first-byte-plus-1', false, ORDER_8_A + 1n, false, 'y = the first order-8 value plus 1 (its first byte 27 for 26)'),
  oneKey('not-weak-order-8-a-last-byte-plus-1', false, ORDER_8_A + (1n << 248n), false, 'y = the first order-8 value plus 2^248 (its last byte 06 for 05)'),
  oneKey('not-weak-order-8-b-first-byte-minus-1', false, ORDER_8_B - 1n, false, 'y = the second order-8 value minus 1 (its first byte c6 for c7)'),
  oneKey('not-weak-order-8-b-last-byte-minus-1', false, ORDER_8_B - (1n << 248n), true, 'y = the second order-8 value minus 2^248 (its last byte 79 for 7a, here f9 with the sign bit)'),
  ...generated.map((k, i) => set(`not-weak-generated-key-${i + 1}`, `${WEAK} ('a key made by an Ed25519 key generator is never weak'): a key made for this vector by generateKeyPairSync('ed25519'), not weak by the row's rule, reads`, MARKER + k.entry, valid([k.id]))),

  // -- the file readers
  file('file-byte-order-mark', `${S27} 'The file readers': a keys.json that starts with a byte-order mark is refused, never read as an empty set (the text is otherwise the committed empty set)`, '\u{feff}{\n  "key_set": "' + MARKER + '"\n}\n', INVALID),
  file('file-byte-order-mark-with-key', `${S27} 'The file readers': a byte-order mark before a file that holds a good key`, '\u{feff}{\n  "key_set": "' + MARKER + K[0] + '"\n}\n', INVALID),
  file('file-no-json', `${S27} 'The file readers' ('is no JSON'): the committed empty set cut before its closing brace`, '{\n  "key_set": "' + MARKER + '"\n', INVALID),
  file('file-empty', `${S27} 'The file readers' ('is no JSON'): a file of 0 bytes`, '', INVALID),
  file('file-top-level-array', `${S27} 'The file readers' ('whose top level is no object'; section 2.3 'JSON': an array is no object): an array holding the object`, '[\n  {\n    "key_set": "' + MARKER + K[0] + '"\n  }\n]\n', INVALID),
  file('file-top-level-string', `${S27} 'The file readers' ('whose top level is no object'): the key_set string alone as the JSON text`, '"' + MARKER + K[0] + '"\n', INVALID),
  file('file-top-level-null', `${S27} 'The file readers' ('whose top level is no object'; section 2.3 'JSON': null is no object)`, 'null\n', INVALID)
]

for (const vectors of [paeVectors, edVectors, keySetVectors]) checkIds(vectors)
// A byte-order mark in a keysJson text is written as its JSON escape (section 10.7), which asciiJson does.
writeFileSync(join(outDir, 'pae.json'), fileText(paeVectors))
writeFileSync(join(outDir, 'ed25519.json'), fileText(edVectors))
writeFileSync(join(outDir, 'key-set.json'), fileText(keySetVectors))
console.log(`pae.json ${paeVectors.length}, ed25519.json ${edVectors.length}, key-set.json ${keySetVectors.length} vectors`)
