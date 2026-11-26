#!/usr/bin/env node
// Writes the negative contract vectors of the app-update trust core (docs/app-updates.md section 10.7; F-1, F-2,
// F-4): vectors-envelope.json, vectors-payload.json, vectors-order.json, vectors-version-rule.json and
// vectors-caps.json. Plain Node, no dependency, no import from the repository.
//
//   node generate.mjs --out <an empty folder>
//
// Written from the DSSE specification, RFC 8032 and the design record only (PROVENANCE.md), at the record's commit
// 930b7d4c, before the verifier was committed and without reading it (T4.1 was writing it in the same tree; this
// writer saw only its file names in one `git status` line and opened none of them): every `expect` below is stated
// by hand from a record row, which `why` names.
//
// THE COMMITTED VECTORS ARE THE GOLDEN. Every key pair is made at run time (`generateKeyPairSync('ed25519')`); its
// private half stays inside `newKey`'s closure, signs, and is gone when the process ends. It is never exported to a
// file, printed or logged, and no seed, PEM, JWK or PKCS#8 text is written anywhere. So a new run gives other keys
// and signatures: this script documents how the golden was made, it does not reproduce its bytes.

import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outAt = process.argv.indexOf('--out')
const outDir = outAt < 0 ? null : (process.argv[outAt + 1] ?? null)
if (!outDir) {
  console.error('usage: node generate.mjs --out <an empty folder>')
  process.exit(2)
}
if (existsSync(outDir) && readdirSync(outDir).some((n) => /^vectors.*\.json$/.test(n))) {
  console.error('the output folder already holds vectors: they are the golden, write somewhere else')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

// ---- helpers ----------------------------------------------------------------------------------------------------
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const utf8 = (text) => Buffer.from(text, 'utf8')
const asciiJson = (value) => JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const toUrl = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_')
/** The same base64 with the last character before the padding raised by one: its unused bits are then not zero. */
function nonZeroPadBits(b64) {
  const at = b64.indexOf('=') - 1
  if (at < 0) throw new Error('no padding to work on')
  return b64.slice(0, at) + B64[B64.indexOf(b64[at]) + 1] + b64.slice(at + 1)
}

/** The seeds of this run's keys, in memory only: the last step scans every written file for them. */
const seeds = []
/** A new Ed25519 key pair: its public half as section 2.7 writes a key, its id, and a signer. Nothing else leaves. */
function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  seeds.push(Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16)))
  return { spki: spki.toString('base64'), id: sha256hex(spki), sign: (bytes) => edSign(null, bytes, privateKey) }
}

/** DSSE protocol.md: "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body, the lengths being byte counts. */
function pae(typeBytes, body) {
  return Buffer.concat([utf8(`DSSEv1 ${typeBytes.length} `), typeBytes, utf8(` ${body.length} `), body])
}

const RELEASE = 'application/vnd.hilbertraum.release+json'
const HOST = { runningVersion: '1.0.0', driveAppVersion: null, rootApps: [], maxVersion: null, os: 'win32', osVersion: '10.0.26300', glibc: null, now: '2027-01-15T12:00:00Z', uiLanguage: 'en' }
const LINUX = { os: 'linux', osVersion: null, glibc: '2.39' }
const MAC = { os: 'darwin', osVersion: '15.1.0', glibc: null }
const RV = { runningVersion: '1.0.0' }

const H = (label) => sha256hex(utf8(label))
/** The base payload's files, and what an accepted payload carries for them (section 2.10). */
const FILES_IN = () => [
  { name: 'apply.cmd', size: 4096, sha256: H('apply.cmd'), role: 'script' },
  { name: 'HilbertRaum-1.1.0-portable.exe', size: 104857600, sha256: H('exe'), group: 'win32', role: 'app' },
  { name: 'Start-HilbertRaum.cmd', size: 2048, sha256: H('start'), install_as: 'Start HilbertRaum.cmd', role: 'start-file' }
]
const FILES_OUT = () => [
  { name: 'apply.cmd', size: 4096, sha256: H('apply.cmd'), group: null, installAs: null },
  { name: 'HilbertRaum-1.1.0-portable.exe', size: 104857600, sha256: H('exe'), group: 'win32', installAs: null },
  { name: 'Start-HilbertRaum.cmd', size: 2048, sha256: H('start'), group: null, installAs: 'Start HilbertRaum.cmd' }
]
const ISSUED = '2027-01-10T08:00:00Z'
const BASE = (over = {}) => ({ format: 1, product: 'hilbertraum', kind: 'release', channel: 'stable', version: '1.1.0', issued: ISSUED, files: FILES_IN(), ...over })

const FLAGS = (over = {}) => ({ staleDriveVersion: false, issuedInFuture: false, oldFile: false, otherSystemFloors: [], ...over })
const refuse = (stage, code, params = {}, flags = {}) => ({ stage, code, params, flags: FLAGS(flags) })
const accepted = (over = {}, flags = {}) => ({ stage: 'payload', code: 'accepted', params: {}, flags: FLAGS(flags), version: '1.1.0', issued: ISSUED, summary: null, files: FILES_OUT(), ...over })
const DAMAGED = () => refuse('envelope', 'UPD-FILE-DAMAGED')
const TOO_NEW_ENV = () => refuse('envelope', 'UPD-TOO-NEW', RV)
const TOO_NEW = () => refuse('payload', 'UPD-TOO-NEW', RV)
const UNKNOWN = () => refuse('envelope', 'UPD-UNKNOWN-SIGNER', RV)
const NOT_GENUINE = () => refuse('envelope', 'UPD-NOT-GENUINE')

const S23 = 'app-updates.md section 2.3'
const S24 = 'app-updates.md section 2.4'
const S25 = 'app-updates.md section 2.5'
const S43 = 'app-updates.md section 4.3'
const S44 = 'app-updates.md section 4.4'
const S45 = 'app-updates.md section 4.5'

const parts = new Map()
const ids = new Set()
function add(part, vector) {
  if (!/^[a-z0-9-]+$/.test(vector.id) || ids.has(vector.id)) throw new Error('bad or repeated id ' + vector.id)
  if (/[\r\n]/.test(vector.why)) throw new Error('why is one line: ' + vector.id)
  ids.add(vector.id)
  if (!parts.has(part)) parts.set(part, [])
  parts.get(part).push(vector)
}
/** Member 0's bytes as section 10.7 holds them: readable text where the bytes are plain UTF-8 text, else base64. */
function envelopeOf(env) {
  if (typeof env === 'object' && !Buffer.isBuffer(env)) return env // already { parts: [...] }
  const bytes = Buffer.isBuffer(env) ? env : utf8(env)
  const text = bytes.toString('utf8')
  const plain = utf8(text).equals(bytes) && !text.includes('\u{feff}') && !text.includes('\u{0}')
  return plain ? { parts: [{ text }] } : bytes.toString('base64')
}
/** One vector with an envelope. */
function vec(part, id, why, keys, env, expect, host = {}) {
  add(part, { id, why, keys, envelope: envelopeOf(env), host: { ...HOST, ...host }, expect })
}

const bodyOf = (payload) => (Buffer.isBuffer(payload) ? payload : utf8(typeof payload === 'string' ? payload : JSON.stringify(payload)))
/** A payload signed as the record says, by a key made for it. `want` asks for a signature whose base64 fits a test. */
function setup(payload = BASE(), type = RELEASE, want = () => true) {
  const body = bodyOf(payload)
  for (;;) {
    const key = newKey()
    const sig = key.sign(pae(utf8(type), body))
    const sigB64 = sig.toString('base64')
    if (want(sigB64)) return { key, type, body, b64: body.toString('base64'), sig, sigB64, entry: { keyid: key.id, sig: sigB64 } }
  }
}
const HAS_PLUS_AND_SLASH = (b64) => b64.includes('+') && b64.includes('/')
/** The envelope's JSON text; `over` replaces or (with undefined) drops a field, or adds one. */
const envJson = (s, over = {}) => JSON.stringify({ payloadType: s.type, payload: s.b64, signatures: [s.entry], ...over })
/** The envelope with raw bytes as the value of an ignored key `zz`. */
function envWithRawBytes(s, bytes) {
  const [a, b] = envJson(s, { zz: '@@' }).split('@@')
  return Buffer.concat([utf8(a), Buffer.from(bytes), utf8(b)])
}
/** A payload vector: the payload signed by its own key under the release type, in a plain envelope. */
function pay(part, id, why, payload, expect, host = {}) {
  const s = setup(payload)
  vec(part, id, why, [s.key.spki], envJson(s), expect, host)
}

// ================================================================================================================
// vectors-envelope.json: section 2.3, the envelope's table, row by row
// ================================================================================================================
{
  const E = 'envelope'
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])

  // ---- the key set
  let s = setup()
  vec(E, 'env-keyset-empty-good-envelope', `${S23} 'The key set': an empty key set answers UPD-NOT-AVAILABLE, here for an envelope that a key would verify`, [], envJson(s), refuse('envelope', 'UPD-NOT-AVAILABLE'))
  vec(E, 'env-keyset-empty-unreadable-bytes', `${S23} 'The key set' ('before a byte of member 0 is read'): an empty key set and three bytes that are no UTF-8 and no JSON`, [], Buffer.from([0xff, 0xfe, 0x00]), refuse('envelope', 'UPD-NOT-AVAILABLE'))
  vec(E, 'env-keyset-empty-zero-bytes', `${S23} 'The key set': an empty key set and a member 0 of 0 bytes`, [], Buffer.alloc(0), refuse('envelope', 'UPD-NOT-AVAILABLE'))

  // ---- text
  s = setup()
  vec(E, 'env-text-byte-order-mark', `${S23} 'Text': the bytes start with a byte-order mark (EF BB BF), then a good envelope`, [s.key.spki], Buffer.concat([BOM, utf8(envJson(s))]), DAMAGED())
  const badUtf8 = [
    ['overlong-2-bytes', [0xc0, 0x80], 'an overlong form (C0 80 for U+0000)'],
    ['overlong-2-bytes-slash', [0xc0, 0xaf], 'an overlong form (C0 AF for a slash)'],
    ['overlong-3-bytes', [0xe0, 0x9f, 0xbf], 'an overlong form (E0 9F BF for U+07FF)'],
    ['overlong-4-bytes', [0xf0, 0x8f, 0xbf, 0xbf], 'an overlong form (F0 8F BF BF for U+FFFF)'],
    ['surrogate-high', [0xed, 0xa0, 0x80], 'an encoded surrogate (ED A0 80 for U+D800)'],
    ['surrogate-low', [0xed, 0xbf, 0xbf], 'an encoded surrogate (ED BF BF for U+DFFF)'],
    ['surrogate-pair-cesu', [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80], 'a pair of encoded surrogates (CESU-8 for U+1F600)'],
    ['above-10ffff', [0xf4, 0x90, 0x80, 0x80], 'a value above U+10FFFF (F4 90 80 80)'],
    ['lead-f5', [0xf5, 0x80, 0x80, 0x80], 'a lead byte above F4 (F5 80 80 80: no lead byte of UTF-8, it would start a value above U+10FFFF)'],
    ['five-byte-form', [0xf8, 0x88, 0x80, 0x80, 0x80], 'a five-byte form (F8 88 80 80 80)'],
    ['cut-sequence', [0xe2, 0x82], 'a three-byte sequence cut after two bytes (E2 82)'],
    ['lone-continuation', [0x80], 'a continuation byte alone (80)'],
    ['byte-ff', [0xff], 'the byte FF'],
    ['latin-1-byte', [0xe9], 'a Latin-1 byte (E9) before an ASCII character']
  ]
  for (const [slug, bytes, what] of badUtf8) {
    s = setup()
    vec(E, `env-text-not-utf8-${slug}`, `${S23} 'Text' (UTF-8 as RFC 3629 defines it): ${what} inside the string of an ignored key of an otherwise good envelope`, [s.key.spki], envWithRawBytes(s, bytes), DAMAGED())
  }
  s = setup()
  vec(E, 'env-text-utf8-range-ends-accepted', `${S23} 'Text': the first and last code point of each UTF-8 length (U+0080, U+07FF, U+0800, U+D7FF, U+E000, U+FFFF, U+10000, U+10FFFF) in an ignored key are UTF-8, so the envelope reads`, [s.key.spki], envWithRawBytes(s, utf8('\u{80}\u{7ff}\u{800}\u{d7ff}\u{e000}\u{ffff}\u{10000}\u{10ffff}')), accepted())
  s = setup()
  vec(E, 'env-text-utf16le-with-mark', `${S23} 'Text': a good envelope written as UTF-16 LE with its mark (FF FE) is no UTF-8`, [s.key.spki], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(envJson(s), 'utf16le')]), DAMAGED())
  s = setup()
  vec(E, 'env-text-utf16le-no-mark', `${S23} 'Text' and 'JSON': a good envelope written as UTF-16 LE without a mark (every second byte is 00) is no JSON text`, [s.key.spki], Buffer.from(envJson(s), 'utf16le'), DAMAGED())
  s = setup()
  vec(E, 'env-text-mark-inside-string-accepted', `${S23} 'Text' ('do not start with a byte-order mark'): U+FEFF inside the string of an ignored key is an ordinary character`, [s.key.spki], envWithRawBytes(s, BOM), accepted())
  s = setup()
  vec(E, 'env-json-mark-after-space', `${S23} 'JSON': a space, then U+FEFF, then a good envelope; U+FEFF is no JSON whitespace (RFC 8259 section 2)`, [s.key.spki], Buffer.concat([utf8(' '), BOM, utf8(envJson(s))]), DAMAGED())
  s = setup()
  vec(E, 'env-json-mark-at-the-end', `${S23} 'JSON': a good envelope followed by U+FEFF`, [s.key.spki], Buffer.concat([utf8(envJson(s)), BOM]), DAMAGED())
  s = setup()
  vec(E, 'env-json-nul-at-the-end', `${S23} 'JSON': a good envelope followed by one NUL byte`, [s.key.spki], Buffer.concat([utf8(envJson(s)), Buffer.from([0])]), DAMAGED())

  // ---- JSON: texts that JSON.parse refuses
  const k = () => [newKey().spki]
  vec(E, 'env-json-zero-bytes', `${S23} 'JSON': a member 0 of 0 bytes is no JSON text`, k(), Buffer.alloc(0), DAMAGED())
  vec(E, 'env-json-whitespace-only', `${S23} 'JSON': whitespace alone is no JSON text`, k(), ' \r\n\t', DAMAGED())
  s = setup()
  const good = envJson(s)
  const noJson = [
    ['cut-short', good.slice(0, good.length - 40), 'a good envelope cut 40 bytes before its end'],
    ['no-closing-brace', good.slice(0, -1), 'a good envelope without its closing brace'],
    ['trailing-text', good + 'x', 'a good envelope followed by the letter x'],
    ['two-texts', good + good, 'a good envelope twice in a row (one JSON text is asked for)'],
    ['two-texts-line-separated', good + '\n' + good, 'a good envelope on each of two lines'],
    ['trailing-comma', good.replace(/}$/, ',}'), 'a comma before the closing brace'],
    ['single-quoted-keys', good.replace(/"payloadType"/, "'payloadType'"), 'a key in single quotes'],
    ['line-comment', '// envelope\n' + good, 'a comment line before the envelope'],
    ['block-comment', good.replace(/^\{/, '{/* c */'), 'a block comment inside the envelope'],
    ['nan-in-ignored-key', good.replace(/}$/, ',"n":NaN}'), 'NaN as the value of an ignored key'],
    ['leading-zero-number', good.replace(/}$/, ',"n":01}'), 'the number 01 as the value of an ignored key'],
    ['raw-line-feed-in-string', good.replace(/}$/, ',"n":"a\nb"}'), 'an unescaped line feed inside the string of an ignored key'],
    ['bad-escape-in-string', good.replace(/}$/, ',"n":"\\x41"}'), 'the escape backslash-x in the string of an ignored key'],
    ['unquoted-key', good.replace(/"payloadType"/, 'payloadType'), 'a key without quotes']
  ]
  for (const [slug, text, what] of noJson) vec(E, `env-json-${slug}`, `${S23} 'JSON' (one JSON text as JSON.parse reads it): ${what}, signed and otherwise good`, [s.key.spki], text, DAMAGED())

  // ---- JSON: the top level is an object
  const notObject = [
    ['array-of-envelope', '[' + good + ']', 'an array that holds a good envelope'],
    ['empty-array', '[]', 'an empty array'],
    ['null', 'null', 'null'],
    ['true', 'true', 'true'],
    ['number', '1', 'a number'],
    ['string', JSON.stringify(good), 'a JSON string that holds a good envelope as text']
  ]
  for (const [slug, text, what] of notObject) vec(E, `env-json-top-level-${slug}`, `${S23} 'JSON' ('whose top level is an object': never an array and never null): ${what}`, [s.key.spki], text, DAMAGED())
  vec(E, 'env-json-empty-object', `${S23} 'signatures' ('an own array, else UPD-FILE-DAMAGED'): the empty object has none of the fields`, [s.key.spki], '{}', DAMAGED())

  // ---- JSON: own keys, duplicates, escapes, unknown keys
  s = setup()
  vec(E, 'env-json-fields-under-proto-key', `${S23} 'JSON' ('Only own keys count (an own __proto__ key is an unknown key)'): the three fields sit inside an object under the key __proto__, so the envelope itself has none`, [s.key.spki], '{"__proto__":' + envJson(s) + '}', DAMAGED())
  s = setup()
  vec(E, 'env-json-proto-key-ignored-accepted', `${S23} 'JSON' (an own __proto__ key is an unknown key): a good envelope with a further key __proto__ that holds other fields`, [s.key.spki], envJson(s).replace(/^\{/, '{"__proto__":{"signatures":[],"payload":"AAAA","payloadType":"x"},'), accepted())
  s = setup()
  const other = setup(BASE({ version: '9.9.9' }))
  vec(E, 'env-json-duplicate-payload-last-counts-accepted', `${S23} 'JSON' ('with a duplicate key the last one counts'): payload twice, first another payload, last the signed one`, [s.key.spki], `{"payload":"${other.b64}","payloadType":"${RELEASE}","payload":"${s.b64}","signatures":[${JSON.stringify(s.entry)}]}`, accepted())
  vec(E, 'env-json-duplicate-payload-last-counts-refused', `${S23} 'JSON' ('the last one counts') and 'No signature verifies': payload twice, first the signed one, last another payload; the signature names the embedded key and does not verify the last`, [s.key.spki], `{"payload":"${s.b64}","payloadType":"${RELEASE}","payload":"${other.b64}","signatures":[${JSON.stringify(s.entry)}]}`, NOT_GENUINE())
  vec(E, 'env-json-duplicate-signatures-last-counts', `${S23} 'JSON' ('the last one counts') and 'No signature verifies' (0 entries): signatures twice, first with the good signature, last an empty array`, [s.key.spki], `{"signatures":[${JSON.stringify(s.entry)}],"payloadType":"${RELEASE}","payload":"${s.b64}","signatures":[]}`, UNKNOWN())
  vec(E, 'env-json-duplicate-signatures-last-counts-accepted', `${S23} 'JSON' ('the last one counts'): signatures twice, first a number, last the array with the good signature`, [s.key.spki], `{"signatures":7,"payloadType":"${RELEASE}","payload":"${s.b64}","signatures":[${JSON.stringify(s.entry)}]}`, accepted())
  vec(E, 'env-json-duplicate-type-last-counts', `${S23} 'JSON' ('the last one counts') and 'No signature verifies': payloadType twice, first the signed type, last another; the signature names the embedded key and does not verify`, [s.key.spki], `{"payloadType":"${RELEASE}","payloadType":"application/vnd.hilbertraum.models+json","payload":"${s.b64}","signatures":[${JSON.stringify(s.entry)}]}`, NOT_GENUINE())
  s = setup()
  vec(E, 'env-json-escaped-keys-accepted', `${S23} 'JSON' ('keys are compared code unit for code unit after JSON's escapes are decoded'): every key of the envelope and of its signature entry spelt with one \\u escape`, [s.key.spki], envJson(s).replace('"payload":', '"\\u0070ayload":').replace('"payloadType"', '"payloadT\\u0079pe"').replace('"signatures"', '"s\\u0069gnatures"').replace('"sig"', '"s\\u0069g"').replace('"keyid"', '"key\\u0069d"'), accepted())
  const wrongKeys = [
    ['payload-upper-case', ['"payload":', '"Payload":'], 'Payload in place of payload'],
    ['payload-type-lower-case', ['"payloadType"', '"payloadtype"'], 'payloadtype in place of payloadType'],
    ['signatures-singular', ['"signatures"', '"signature"'], 'signature in place of signatures'],
    ['payload-trailing-space', ['"payload":', '"payload ":'], 'a key payload with a trailing space']
  ]
  for (const [slug, [from, to], what] of wrongKeys) vec(E, `env-json-key-${slug}`, `${S23} 'JSON' (keys compared code unit for code unit; unknown keys ignored), so the named field is missing: ${what}`, [s.key.spki], envJson(s).replace(from, to), DAMAGED())
  s = setup()
  vec(E, 'env-json-whitespace-and-unknown-keys-accepted', `${S23} 'JSON' (RFC 8259's grammar; 'unknown keys are ignored'; DSSE envelope.md 'Consumers MUST ignore unrecognized fields'): the envelope indented with tabs and CR LF, with unknown keys holding 1e400, a nested array and an object`, [s.key.spki], '{\r\n\t"future" : { "a" : [ 1 , [ 2 , { "b" : null } ] ] , "n" : 1e400 } ,\r\n\t"payloadType" : "' + RELEASE + '" ,\r\n\t"payload" : "' + s.b64 + '" ,\r\n\t"signatures" : [ { "keyid" : "' + s.key.id + '" , "sig" : "' + s.sigB64 + '" , "alg" : "ed25519" } ] ,\r\n\t"x" : true\r\n}\r\n', accepted())
}

{
  const E = 'envelope'
  // ---- signatures
  let s = setup()
  const notArray = [['missing', undefined, 'no signatures field'], ['null', null, 'null'], ['object', {}, 'an empty object'], ['array-like-object', { 0: s.entry, length: 1 }, 'an object with the keys 0 and length (array-like, no array)'], ['string', s.sigB64, 'the signature as a bare string'], ['number', 1, 'a number'], ['one-entry-not-in-array', s.entry, 'one signature entry that is not inside an array']]
  for (const [slug, value, what] of notArray) vec(E, `env-signatures-${slug}`, `${S23} 'signatures' ('an own array, else UPD-FILE-DAMAGED'): ${what}`, [s.key.spki], envJson(s, { signatures: value }), DAMAGED())
  vec(E, 'env-signatures-zero-entries', `${S23} 'signatures' ('0 entries is legal (it verifies nothing)') and 'No signature verifies' ('0 entries included'): an empty signatures array (owner 2026-11-26: no signature at all is UPD-UNKNOWN-SIGNER)`, [s.key.spki], envJson(s, { signatures: [] }), UNKNOWN())
  const junk = (n) => Array.from({ length: n }, (_, i) => ({ keyid: 'other-scheme-' + i, sig: 'AAAA' }))
  s = setup()
  vec(E, 'env-signatures-64-entries-last-verifies-accepted', `${S23} 'signatures' (at most 64 entries) and 'Verification' (each counting entry in envelope order): 63 entries that verify nothing, then the good signature as entry 64`, [s.key.spki], envJson(s, { signatures: [...junk(63), s.entry] }), accepted())
  vec(E, 'env-signatures-65-entries-one-verifies', `${S23} 'signatures' ('more than 64 entries, whatever they hold -> UPD-TOO-NEW, before any signature is verified'): the good signature first, then 64 entries that verify nothing`, [s.key.spki], envJson(s, { signatures: [s.entry, ...junk(64)] }), TOO_NEW_ENV())
  vec(E, 'env-signatures-65-numbers', `${S23} 'signatures' ('more than 64 entries, whatever they hold'): 65 numbers`, [s.key.spki], envJson(s, { signatures: Array.from({ length: 65 }, (_, i) => i) }), TOO_NEW_ENV())
  vec(E, 'env-signatures-64-entries-none-verifies', `${S23} 'signatures' (64 entries are within the cap) and 'No signature verifies': 64 entries that verify nothing and name no embedded key`, [s.key.spki], envJson(s, { signatures: junk(64) }), UNKNOWN())
  vec(E, 'env-signatures-65-entries-naming-the-key', `${S23} 'signatures' (the cap's answer is UPD-TOO-NEW, never 'not genuine'): 65 entries that name the embedded key and verify nothing`, [s.key.spki], envJson(s, { signatures: Array.from({ length: 65 }, () => ({ keyid: s.key.id, sig: 'AAAA' })) }), TOO_NEW_ENV())

  // ---- payloadType: an own string without a lone surrogate
  s = setup()
  for (const [slug, value, what] of [['missing', undefined, 'no payloadType field'], ['null', null, 'null'], ['number', 1, 'a number'], ['array', [RELEASE], 'an array holding the type'], ['object', { type: RELEASE }, 'an object']]) {
    vec(E, `env-type-${slug}`, `${S23} 'payloadType' ('an own string ..., else UPD-FILE-DAMAGED'): ${what}`, [s.key.spki], envJson(s, { payloadType: value }), DAMAGED())
  }
  for (const [slug, escape, what] of [['lone-high-surrogate', '\\ud83d', 'the escape for U+D83D alone'], ['lone-low-surrogate', '\\ude00', 'the escape for U+DE00 alone'], ['surrogates-reversed', '\\ude00\\ud83d', 'a low surrogate before a high one']]) {
    vec(E, `env-type-${slug}`, `${S23} 'payloadType' ('without a lone surrogate (so its UTF-8 bytes exist)'): the release type followed by ${what}`, [s.key.spki], envJson(s).replace(`"${RELEASE}"`, `"${RELEASE}${escape}"`), DAMAGED())
  }

  // ---- payload: an own string in the base64 grammar
  for (const [slug, value, what] of [['missing', undefined, 'no payload field'], ['null', null, 'null'], ['number', 1, 'a number'], ['array', [s.b64], 'an array holding the base64 string'], ['object-not-encoded', BASE(), 'the payload as a JSON object instead of a base64 string']]) {
    vec(E, `env-payload-${slug}`, `${S23} 'payload' ('an own string in the base64 grammar ..., else UPD-FILE-DAMAGED'): ${what}`, [s.key.spki], envJson(s, { payload: value }), DAMAGED())
  }
  /** A base payload with an ignored key that makes its length mod 3 `rest`, its base64 holding + and /. */
  function shaped(rest) {
    for (let n = 0; n < 64; n++) {
      const p = BASE({ zz: '>>>???~~~' + 'x'.repeat(n) })
      const body = bodyOf(p)
      if (body.length % 3 === rest && HAS_PLUS_AND_SLASH(body.toString('base64'))) return p
    }
    throw new Error('no payload of that shape')
  }
  const G = `${S23} 'The base64 grammar'`
  let s0 = setup(shaped(0))
  let s1 = setup(shaped(1)) // its base64 ends ==
  let s2 = setup(shaped(2)) // its base64 ends =
  vec(E, 'env-b64-payload-standard-accepted', `${G} (the standard alphabet): a payload whose base64 holds + and /`, [s0.key.spki], envJson(s0), accepted())
  vec(E, 'env-b64-payload-url-safe-accepted', `${G} (the URL-safe alphabet, with padding; DSSE protocol.md 'verifiers MUST accept either'): the same kind of payload with - and _, ending ==`, [s1.key.spki], envJson(s1, { payload: toUrl(s1.b64) }), accepted())
  vec(E, 'env-b64-payload-url-safe-one-pad-accepted', `${G} (the URL-safe alphabet, with padding): a payload with - and _, ending in one =`, [s2.key.spki], envJson(s2, { payload: toUrl(s2.b64) }), accepted())
  const firstSlash = (b) => b.replace('/', '_')
  const badPayload = [
    ['mixed-alphabets', s0, firstSlash(s0.b64), "'a string holding one of + / and one of - _ is in neither and fails': one / written as _ beside a +"],
    ['mixed-plus-and-minus', s0, s0.b64.replace('+', '-'), "'one of + / and one of - _': one + written as - beside a /"],
    ['no-padding-two', s1, s1.b64.replace(/==$/, ''), "'Padding is required': the two = left out"],
    ['no-padding-one', s2, s2.b64.replace(/=$/, ''), "'Padding is required': the one = left out"],
    ['one-of-two-pads', s1, s1.b64.replace(/==$/, '='), "'the length is a multiple of 4': one of the two = left out"],
    ['url-safe-no-padding', s1, toUrl(s1.b64).replace(/==$/, ''), "'Padding is required' (section 2.3 'Writers: the form': never Node's base64url, which omits the padding)"],
    ['extra-padding-block', s0, s0.b64 + '====', "'= stands only as the last one or two characters': four = after a complete string"],
    ['three-pads', s1, s1.b64.slice(0, -3) + '===', "'= stands only as the last one or two characters': the last three characters are ="],
    ['pad-in-the-middle', s1, s1.b64 + s1.b64, "'= stands only as the last one or two characters': two padded strings joined, so == stands in the middle"],
    ['line-breaks-every-76', s0, s0.b64.replace(/(.{76})/g, '$1\n'), "'No whitespace, line break or other character': a line feed after every 76 characters (the MIME form)"],
    ['trailing-line-feed', s0, s0.b64 + '\n', "'No whitespace, line break or other character': a line feed at the end"],
    ['leading-space', s0, ' ' + s0.b64, "'No whitespace': a space at the start"],
    ['space-inside', s0, s0.b64.slice(0, 8) + ' ' + s0.b64.slice(8), "'No whitespace': a space after the eighth character"],
    ['other-character', s0, s0.b64.slice(0, 8) + '*' + s0.b64.slice(9), "'No ... other character': an asterisk in place of the ninth character"],
    ['non-ascii-character', s0, s0.b64.slice(0, 8) + '\u{e4}' + s0.b64.slice(9), "'No ... other character': U+00E4 in place of the ninth character"],
    ['one-character-more', s0, s0.b64 + 'A', "'the length is a multiple of 4': one character more"],
    ['non-zero-pad-bits-two-pads', s1, nonZeroPadBits(s1.b64), "'The unused bits of the last character before the padding are zero': four unused bits, one of them set"],
    ['non-zero-pad-bits-one-pad', s2, nonZeroPadBits(s2.b64), "'The unused bits of the last character before the padding are zero': two unused bits, one of them set"]
  ]
  /** These four strings give the signed bytes under no decoding, however lenient: their signature is the original payload's. */
  const NO_DECODING = ['three-pads', 'pad-in-the-middle', 'other-character', 'non-ascii-character']
  for (const [slug, sx, value, what] of badPayload) vec(E, `env-b64-payload-${slug}`, `${G}, for payload: ${what}; the signature is good for ${NO_DECODING.includes(slug) ? "the original payload's bytes (no decoding of this string gives them)" : "the payload's bytes"}`, [sx.key.spki], envJson(sx, { payload: value }), DAMAGED())
  s = setup(Buffer.alloc(0))
  vec(E, 'env-b64-payload-empty-known-key', `${G} ('The empty string is legal (0 bytes)') and section 2.4 'Reading' (a payload that is no JSON, from a known key -> UPD-TOO-NEW): payload is the empty string, signed over 0 bytes (PAE 'DSSEv1 40 <type> 0 ')`, [s.key.spki], envJson(s), TOO_NEW())
  vec(E, 'env-b64-payload-empty-unknown-key', `${G} ('The empty string is legal') and 'No signature verifies': the same envelope for a verifier that embeds another key`, [newKey().spki], envJson(s), UNKNOWN())

  // ---- a signature entry: the shapes that are skipped
  const A = `${S23} 'A signature entry'`
  const N = `'No signature verifies'`
  /** Each skipped shape twice: alone (the deciding rule answers), and before a good entry (never a refusal on its own). */
  function skipped(slug, what, entryOf, names) {
    const sx = setup(BASE(), RELEASE, HAS_PLUS_AND_SLASH)
    const entry = entryOf(sx)
    vec(E, `env-entry-${slug}-alone`, `${A} (skipped: ${what}) and ${N}: the only entry is skipped${names ? ' and names the embedded key, so UPD-NOT-GENUINE' : ' and names no key, so UPD-UNKNOWN-SIGNER'}`, [sx.key.spki], envJson(sx, { signatures: [entry] }), names ? NOT_GENUINE() : UNKNOWN())
    vec(E, `env-entry-${slug}-then-good-accepted`, `${A} ('is skipped: it verifies under no key and is never a refusal on its own'): ${what}, followed by the good signature`, [sx.key.spki], envJson(sx, { signatures: [entry, sx.entry] }), accepted())
  }
  skipped('null', 'no object: null', () => null, false)
  skipped('number', 'no object: a number', () => 7, false)
  skipped('true', 'no object: true', () => true, false)
  skipped('string-key-id', "no object: a string that equals the embedded key's id", (x) => x.key.id, false)
  skipped('string-signature', 'no object: the good signature as a bare string', (x) => x.sigB64, false)
  skipped('array-holding-good-entry', 'no object (an array is none): an array that holds the good entry', (x) => [x.entry], false)
  skipped('empty-object', 'an object with no sig and no keyid', () => ({}), false)
  skipped('no-sig', 'no string sig: the field is missing', (x) => ({ keyid: x.key.id }), true)
  skipped('sig-null', 'no string sig: null', (x) => ({ keyid: x.key.id, sig: null }), true)
  skipped('sig-number', 'no string sig: a number', (x) => ({ keyid: x.key.id, sig: 64 }), true)
  skipped('sig-array', 'no string sig: an array holding the good signature', (x) => ({ keyid: x.key.id, sig: [x.sigB64] }), true)
  skipped('sig-object', 'no string sig: an object', (x) => ({ keyid: x.key.id, sig: { base64: x.sigB64 } }), true)
  skipped('sig-key-upper-case', 'no string sig: the key is spelt Sig', (x) => ({ keyid: x.key.id, Sig: x.sigB64 }), true)
  skipped('sig-no-padding', 'a sig outside the base64 grammar: the good signature without its ==', (x) => ({ keyid: x.key.id, sig: x.sigB64.replace(/==$/, '') }), true)
  skipped('sig-url-safe-no-padding', "a sig outside the base64 grammar: the good signature as Node's base64url (URL-safe, no padding)", (x) => ({ keyid: x.key.id, sig: toUrl(x.sigB64).replace(/==$/, '') }), true)
  skipped('sig-mixed-alphabets', 'a sig outside the base64 grammar: the good signature with its + written as - and its / kept', (x) => ({ keyid: x.key.id, sig: x.sigB64.replace(/\+/g, '-') }), true)
  skipped('sig-trailing-line-feed', 'a sig outside the base64 grammar: the good signature followed by a line feed', (x) => ({ keyid: x.key.id, sig: x.sigB64 + '\n' }), true)
  skipped('sig-leading-space', 'a sig outside the base64 grammar: a space before the good signature', (x) => ({ keyid: x.key.id, sig: ' ' + x.sigB64 }), true)
  skipped('sig-line-break-inside', 'a sig outside the base64 grammar: a line feed after 76 characters of the good signature', (x) => ({ keyid: x.key.id, sig: x.sigB64.slice(0, 76) + '\n' + x.sigB64.slice(76) }), true)
  skipped('sig-four-spaces-inside', 'a sig outside the base64 grammar: the good signature with four spaces after its 44th character (92 characters, still a multiple of 4; without the spaces it is the good signature)', (x) => ({ keyid: x.key.id, sig: x.sigB64.slice(0, 44) + '    ' + x.sigB64.slice(44) }), true)
  skipped('sig-non-zero-pad-bits', 'a sig outside the base64 grammar: the good signature with one unused bit of its last character set', (x) => ({ keyid: x.key.id, sig: nonZeroPadBits(x.sigB64) }), true)
  skipped('sig-three-pads', 'a sig outside the base64 grammar: the good signature with its last three characters as =', (x) => ({ keyid: x.key.id, sig: x.sigB64.slice(0, -3) + '===' }), true)
  skipped('sig-hex', 'another length: the good signature as 128 hex characters (base64 characters that decode to 96 bytes)', (x) => ({ keyid: x.key.id, sig: x.sig.toString('hex') }), true)
  skipped('sig-63-bytes', 'another length: the first 63 bytes of the good signature', (x) => ({ keyid: x.key.id, sig: x.sig.subarray(0, 63).toString('base64') }), true)
  skipped('sig-65-bytes', 'another length: the good signature and one byte 00', (x) => ({ keyid: x.key.id, sig: Buffer.concat([x.sig, Buffer.from([0])]).toString('base64') }), true)
  skipped('sig-empty', 'another length: the empty string (0 bytes)', (x) => ({ keyid: x.key.id, sig: '' }), true)
  skipped('sig-32-bytes', 'another length: the first 32 bytes of the good signature', (x) => ({ keyid: x.key.id, sig: x.sig.subarray(0, 32).toString('base64') }), true)
  skipped('sig-128-bytes', 'another length: the good signature twice (128 bytes)', (x) => ({ keyid: x.key.id, sig: Buffer.concat([x.sig, x.sig]).toString('base64') }), true)
  skipped('sig-other-scheme-4000-bytes', "another length: 4,000 bytes, as a later scheme's signature beside an Ed25519 one", (x) => ({ keyid: 'slh-dsa-key-1', sig: Buffer.alloc(4000, 0x5a).toString('base64') }), false)

  // ---- a signature entry: the shapes that count
  s = setup(BASE(), RELEASE, HAS_PLUS_AND_SLASH)
  vec(E, 'env-entry-sig-url-safe-accepted', `${A} ('a string sig in the base64 grammar that decodes to exactly 64 bytes') and 'The base64 grammar' (URL-safe with padding): the good signature with - and _`, [s.key.spki], envJson(s, { signatures: [{ keyid: s.key.id, sig: toUrl(s.sigB64) }] }), accepted())
  vec(E, 'env-entry-unknown-fields-accepted', `${A} and 'JSON' (unknown keys are ignored): the good entry with further keys`, [s.key.spki], envJson(s, { signatures: [{ alg: 'ed25519', keyid: s.key.id, sig: s.sigB64, cert: null, extra: [1, 2] }] }), accepted())
  vec(E, 'env-entry-fields-under-proto-key', `${A} and 'JSON' (only own keys count) with ${N}: the entry's sig and keyid sit under a key __proto__, so the entry has neither`, [s.key.spki], envJson(s).replace('"signatures":[{', '"signatures":[{"__proto__":{').replace(/\}\]\}$/, '}}]}'), UNKNOWN())
  vec(E, 'env-entry-duplicate-sig-last-counts', `${A} and 'JSON' (the last of a duplicate key counts) with ${N}: sig twice, first the good one, last 64 zero bytes; the entry names the embedded key`, [s.key.spki], envJson(s).replace(/\}\]\}$/, `,"sig":"${Buffer.alloc(64).toString('base64')}"}]}`), NOT_GENUINE())
}

{
  const E = 'envelope'
  const KID = `${S23} 'keyid'`
  const NSV = `${S23} 'No signature verifies'`
  const V = `${S23} 'Verification'`

  // ---- the deciding rule: a signature by a key the verifier does not embed
  let s = setup() // the signer, unknown to the verifier
  let k = newKey() // the verifier's one key
  const unknownSigner = [
    ['own-key-id', { keyid: s.key.id, sig: s.sigB64 }, "its keyid is the signer's own id, which is no embedded key's", false],
    ['keyid-missing', { sig: s.sigB64 }, 'no keyid', false],
    ['keyid-empty', { keyid: '', sig: s.sigB64 }, 'an empty keyid names none', false],
    ['keyid-null', { keyid: null, sig: s.sigB64 }, 'a keyid of null names none', false],
    ['keyid-number', { keyid: 1, sig: s.sigB64 }, 'a keyid that is a number names none', false],
    ['keyid-array-of-embedded-id', { keyid: [k.id], sig: s.sigB64 }, "a keyid that is an array holding the embedded key's id is no string and names none", false],
    ['keyid-object', { keyid: { id: k.id }, sig: s.sigB64 }, 'a keyid that is an object names none', false],
    ['keyid-embedded-upper-case', { keyid: k.id.toUpperCase(), sig: s.sigB64 }, "the embedded key's id in upper case ('never case-folded')", false],
    ['keyid-embedded-trailing-space', { keyid: k.id + ' ', sig: s.sigB64 }, "the embedded key's id with a trailing space ('code unit for code unit')", false],
    ['keyid-embedded-prefix', { keyid: k.id.slice(0, 16), sig: s.sigB64 }, "the first 16 characters of the embedded key's id", false],
    ['keyid-embedded-spki', { keyid: k.spki, sig: s.sigB64 }, "the embedded key's SPKI in base64 in place of its id", false],
    ['keyid-embedded', { keyid: k.id, sig: s.sigB64 }, "its keyid is the embedded key's id", true]
  ]
  for (const [slug, entry, what, names] of unknownSigner) {
    vec(E, `env-unknown-signer-${slug}`, `${NSV} and ${KID.slice(S23.length + 1)}: a good signature by a key the verifier does not embed; ${what} -> ${names ? 'UPD-NOT-GENUINE' : 'UPD-UNKNOWN-SIGNER'}`, [k.spki], envJson(s, { signatures: [entry] }), names ? NOT_GENUINE() : UNKNOWN())
  }
  vec(E, 'env-unknown-signer-skipped-entry-names-the-key', `${NSV} ('some entry, counting or skipped, names an embedded key's id'): a skipped entry (no sig) names the embedded key, a second entry is a good signature by an unknown key`, [k.spki], envJson(s, { signatures: [{ keyid: k.id }, { keyid: s.key.id, sig: s.sigB64 }] }), NOT_GENUINE())
  vec(E, 'env-unknown-signer-second-entry-names-the-key', `${NSV} ('some entry'): two signatures by unknown keys, only the second names the embedded key`, [k.spki], envJson(s, { signatures: [{ keyid: s.key.id, sig: s.sigB64 }, { keyid: k.id, sig: s.sigB64 }] }), NOT_GENUINE())
  const k2 = newKey()
  vec(E, 'env-unknown-signer-three-keys-none-named', `${NSV}: the verifier embeds three keys, the one signature is by a fourth and carries that key's id`, [k.spki, k2.spki, newKey().spki], envJson(s), UNKNOWN())
  vec(E, 'env-unknown-signer-names-second-embedded-key', `${NSV}: the verifier embeds two keys, the signature is by a third and names the second embedded key`, [k.spki, k2.spki], envJson(s, { signatures: [{ keyid: k2.id, sig: s.sigB64 }] }), NOT_GENUINE())

  // ---- keyid is only a hint: an embedded key's good signature is accepted whatever its keyid says
  s = setup()
  const hint = [['missing', { sig: s.sigB64 }, 'no keyid'], ['empty', { keyid: '', sig: s.sigB64 }, 'an empty keyid'], ['number', { keyid: 7, sig: s.sigB64 }, 'a keyid that is a number'], ['made-up', { keyid: 'ffffffff', sig: s.sigB64 }, 'a made-up keyid'], ['upper-case', { keyid: s.key.id.toUpperCase(), sig: s.sigB64 }, 'its own id in upper case']]
  for (const [slug, entry, what] of hint) vec(E, `env-keyid-hint-${slug}-accepted`, `${V} ('keyid never selects or skips a key'; 'a signature's keyid is only a hint, the embedded key bytes decide'): the embedded key's good signature with ${what}`, [s.key.spki], envJson(s, { signatures: [entry] }), accepted())
  const kOther = newKey()
  vec(E, 'env-keyid-hint-names-other-embedded-key-accepted', `${V} ('each counting entry ... against each embedded key'; 'keyid never selects or skips a key'): two embedded keys, the second signed, the entry's keyid is the first key's id`, [kOther.spki, s.key.spki], envJson(s, { signatures: [{ keyid: kOther.id, sig: s.sigB64 }] }), accepted())

  // ---- verification: which key, which entry
  vec(E, 'env-verify-third-of-three-keys-accepted', `${V} (K1: any one key signs alone): three embedded keys, the third signed`, [newKey().spki, newKey().spki, s.key.spki], envJson(s), accepted())
  vec(E, 'env-verify-first-of-three-keys-accepted', `${V} (K1: any one key signs alone): three embedded keys, the first signed`, [s.key.spki, newKey().spki, newKey().spki], envJson(s), accepted())
  vec(E, 'env-verify-sixteenth-of-sixteen-keys-accepted', `${V} ('number of embedded keys, at most 16') and section 10.7 'keys' (at most 16): sixteen embedded keys, the last signed`, [...Array.from({ length: 15 }, () => newKey().spki), s.key.spki], envJson(s), accepted())
  const u = setup() // same payload bytes, another signer
  vec(E, 'env-verify-unknown-then-known-accepted', `${V} ('The first entry that one key verifies accepts the envelope'): a good signature by an unknown key first, the embedded key's second`, [s.key.spki], envJson(s, { signatures: [u.entry, s.entry] }), accepted())
  vec(E, 'env-verify-known-then-junk-accepted', `${V} ('nothing after it is tried'): the embedded key's signature first, then a number, a 63-byte sig and an entry that names the key without verifying`, [s.key.spki], envJson(s, { signatures: [s.entry, 5, { sig: s.sig.subarray(0, 63).toString('base64') }, { keyid: s.key.id, sig: Buffer.alloc(64).toString('base64') }] }), accepted())
  vec(E, 'env-verify-bad-then-good-same-key-accepted', `${V} (each counting entry in envelope order): an entry that names the embedded key with 64 zero bytes, then that key's good signature`, [s.key.spki], envJson(s, { signatures: [{ keyid: s.key.id, sig: Buffer.alloc(64).toString('base64') }, s.entry] }), accepted())
  vec(E, 'env-verify-two-embedded-keys-both-signed-accepted', `${V} and DSSE envelope.md ('An envelope MAY have more than one signature'): two embedded keys, each with a good signature`, [s.key.spki, u.key.spki], envJson(s, { signatures: [s.entry, u.entry] }), accepted())

  // ---- verification: what is signed
  const de = BASE({ summary: { en: 'Fixes and improvements.', de: 'Gr\u{f6}\u{df}ere Dateien, schnellere Suche \u{2013} und Korrekturen.' } })
  s = setup(de)
  vec(E, 'env-verify-non-ascii-payload-accepted', `${V} ('The counts are byte counts'): a payload with characters of 2 and 3 UTF-8 bytes, signed over PAE with its byte count`, [s.key.spki], envJson(s), accepted({ summary: 'Gr\u{f6}\u{df}ere Dateien, schnellere Suche \u{2013} und Korrekturen.' }), { uiLanguage: 'de' })
  /** An envelope whose one signature the embedded key made over `signedBytes` instead of the right PAE. */
  function wrongSigned(slug, what, payload, signedBytesOf, type = RELEASE) {
    const key = newKey()
    const body = bodyOf(payload)
    const sig = key.sign(signedBytesOf(body)).toString('base64')
    const env = JSON.stringify({ payloadType: type, payload: body.toString('base64'), signatures: [{ keyid: key.id, sig }] })
    vec(E, `env-verify-${slug}`, `${V} (Ed25519 over PAE(UTF8(payloadType), payload), nothing else) and 'No signature verifies': the embedded key signed ${what}; the entry names it -> UPD-NOT-GENUINE`, [key.spki], env, NOT_GENUINE())
  }
  const T = utf8(RELEASE)
  wrongSigned('signed-payload-without-pae', 'the payload bytes alone, without the PAE', BASE(), (b) => b)
  wrongSigned('signed-pae-over-base64-text', "the PAE of the payload's base64 text instead of its bytes", BASE(), (b) => pae(T, utf8(b.toString('base64'))))
  wrongSigned('signed-pae-of-another-type', 'the PAE with the type application/vnd.hilbertraum.models+json, while the envelope names the release type', BASE(), (b) => pae(utf8('application/vnd.hilbertraum.models+json'), b))
  wrongSigned('signed-pae-with-character-counts', "the PAE with the payload's count in UTF-16 units instead of bytes (the payload holds non-ASCII characters)", de, (b) => Buffer.concat([utf8(`DSSEv1 ${T.length} `), T, utf8(` ${b.toString('utf8').length} `), b]))
  wrongSigned('signed-pae-with-leading-zero-count', "the PAE with the type's count written 040", BASE(), (b) => Buffer.concat([utf8('DSSEv1 040 '), T, utf8(` ${b.length} `), b]))
  wrongSigned('signed-pae-version-2', 'the same encoding under the label DSSEv2', BASE(), (b) => Buffer.concat([utf8(`DSSEv2 ${T.length} `), T, utf8(` ${b.length} `), b]))
  wrongSigned('signed-pae-without-last-space', 'the PAE without the space between the payload count and the payload', BASE(), (b) => Buffer.concat([utf8(`DSSEv1 ${T.length} `), T, utf8(` ${b.length}`), b]))
  wrongSigned('signed-sha512-of-pae', 'the SHA-512 hash of the PAE (a prehash, which pure Ed25519 is not)', BASE(), (b) => createHash('sha512').update(pae(T, b)).digest())
  wrongSigned('signed-other-payload-bytes', "the PAE of the same payload serialised with two-space indent (other bytes: 'never re-encoded, re-serialised')", BASE(), () => pae(T, utf8(JSON.stringify(BASE(), null, 2))))

  s = setup()
  const flipped = Buffer.from(s.sig)
  flipped[10] ^= 0x01
  vec(E, 'env-verify-signature-bit-flipped-named', `${V} and ${NSV.slice(S23.length + 1)}: the embedded key's signature with one bit of its R half changed; the entry names the key`, [s.key.spki], envJson(s, { signatures: [{ keyid: s.key.id, sig: flipped.toString('base64') }] }), NOT_GENUINE())
  vec(E, 'env-verify-signature-bit-flipped-not-named', `${NSV} (the accepted residual of section 2.3: a file that does not verify and names no embedded key reads UPD-UNKNOWN-SIGNER): the same changed signature without a keyid`, [s.key.spki], envJson(s, { signatures: [{ sig: flipped.toString('base64') }] }), UNKNOWN())
  const tampered = bodyOf(JSON.stringify(BASE()).replace('"version":"1.1.0"', '"version":"1.1.9"'))
  vec(E, 'env-verify-payload-changed-after-signing', `${V} and ${NSV.slice(S23.length + 1)}: the payload's version changed from 1.1.0 to 1.1.9 after the embedded key signed; the entry names the key`, [s.key.spki], envJson(s, { payload: tampered.toString('base64') }), NOT_GENUINE())
  // RFC 8032 section 5.1.7 step 1: S is an integer in the range 0 <= s < L. S + L is the same residue and must fail.
  const L = (1n << 252n) + 27742317777372353535851937790883648493n
  let sInt = 0n
  for (let i = 63; i >= 32; i--) sInt = (sInt << 8n) | BigInt(s.sig[i])
  let big = sInt + L
  const notCanonical = Buffer.from(s.sig)
  for (let i = 32; i < 64; i++) {
    notCanonical[i] = Number(big & 0xffn)
    big >>= 8n
  }
  if (big !== 0n) throw new Error('S + L does not fit 32 bytes')
  vec(E, 'env-verify-signature-s-not-below-l', `${V} (Ed25519 as RFC 8032 section 5.1.7, step 1: S is decoded 'as an integer in the range 0 <= s < L', else the signature is invalid) and ${NSV.slice(S23.length + 1)}: the embedded key's signature with the group order L added to its S half; the entry names the key`, [s.key.spki], envJson(s, { signatures: [{ keyid: s.key.id, sig: notCanonical.toString('base64') }] }), NOT_GENUINE())

  // ---- a verified envelope's type
  const TY = `${S23} 'A verified envelope's type'`
  const types = [
    ['other-hilbertraum-type', 'application/vnd.hilbertraum.models+json', 'UPD-FOR-NEWER-HILBERTRAUM', 'another type that starts with application/vnd.hilbertraum.'],
    ['release-type-other-case-in-tail', 'application/vnd.hilbertraum.Release+json', 'UPD-FOR-NEWER-HILBERTRAUM', "Release with a capital R: not exactly the release type ('code unit for code unit'), and it starts with the prefix"],
    ['release-type-trailing-space', RELEASE + ' ', 'UPD-FOR-NEWER-HILBERTRAUM', 'the release type with a trailing space'],
    ['release-type-with-parameter', RELEASE + ';v=2', 'UPD-FOR-NEWER-HILBERTRAUM', 'the release type with a parameter appended'],
    ['prefix-only', 'application/vnd.hilbertraum.', 'UPD-FOR-NEWER-HILBERTRAUM', 'the prefix alone'],
    ['hilbertraum-type-non-ascii', 'application/vnd.hilbertraum.gr\u{f6}\u{df}e+json', 'UPD-FOR-NEWER-HILBERTRAUM', 'a type with two characters of 2 UTF-8 bytes each (the PAE counts 40 bytes for its 38 characters)'],
    ['prefix-without-last-dot', 'application/vnd.hilbertraum', 'UPD-NOT-AN-UPDATE', 'the prefix without its last dot'],
    ['prefix-other-case', 'Application/vnd.hilbertraum.release+json', 'UPD-NOT-AN-UPDATE', "the release type with a capital A ('code unit for code unit'; DSSE: case-sensitive): it does not start with the prefix"],
    ['hilbertraum-as-word-start', 'application/vnd.hilbertraumx.release+json', 'UPD-NOT-AN-UPDATE', 'a type whose vendor word only starts with hilbertraum'],
    ['leading-space', ' ' + RELEASE, 'UPD-NOT-AN-UPDATE', 'the release type with a leading space'],
    ['generic-json', 'application/json', 'UPD-NOT-AN-UPDATE', 'application/json'],
    ['in-toto', 'application/vnd.in-toto+json', 'UPD-NOT-AN-UPDATE', "DSSE's own example type"],
    ['uri', 'http://example.com/HelloWorld', 'UPD-NOT-AN-UPDATE', "the URI of DSSE's test vector"],
    ['empty', '', 'UPD-NOT-AN-UPDATE', "the empty string ('the empty string is legal' for the PAE; it is no HilbertRaum type)"],
    ['emoji', '\u{1f600}', 'UPD-NOT-AN-UPDATE', 'one character of 4 UTF-8 bytes (U+1F600; the PAE counts 4)']
  ]
  for (const [slug, type, code, what] of types) {
    const st = setup(BASE(), type)
    const expect = code === 'UPD-NOT-AN-UPDATE' ? refuse('envelope', code) : refuse('envelope', code, RV)
    vec(E, `env-type-known-key-${slug}`, `${TY} (decided only after a signature verified): ${what}, signed by the embedded key -> ${code}`, [st.key.spki], envJson(st), expect)
  }
  let st = setup(BASE(), '\u{1f600}')
  vec(E, 'env-type-emoji-written-as-escapes', `${S23} 'payloadType' (a surrogate pair is no lone surrogate) and 'Verification' (UTF8(payloadType)): the type U+1F600 written as the two escapes \\ud83d\\ude00, signed over its 4 UTF-8 bytes by the embedded key -> UPD-NOT-AN-UPDATE`, [st.key.spki], envJson(st).replace('"\u{1f600}"', '"\\ud83d\\ude00"'), refuse('envelope', 'UPD-NOT-AN-UPDATE'))
  st = setup(BASE(), 'application/vnd.hilbertraum.models+json')
  vec(E, 'env-type-other-hilbertraum-unknown-key', `${TY} ('a file of another HilbertRaum type that no embedded key verifies is UPD-UNKNOWN-SIGNER'; owner 2026-11-26): the models type, well signed by a key the verifier does not embed`, [newKey().spki], envJson(st), UNKNOWN())
  k = newKey()
  vec(E, 'env-type-other-hilbertraum-unknown-key-named', `${TY} ('or UPD-NOT-GENUINE by the row above'): the models type, signed by an unknown key, the entry naming the embedded key`, [k.spki], envJson(st, { signatures: [{ keyid: k.id, sig: st.sigB64 }] }), NOT_GENUINE())
  vec(E, 'env-type-other-hilbertraum-no-signature', `${TY} and 'No signature verifies' ('the payloadType plays no part'; 0 entries): the models type with an empty signatures array`, [k.spki], envJson(st, { signatures: [] }), UNKNOWN())
  st = setup(BASE(), 'application/json')
  vec(E, 'env-type-foreign-unknown-key', `'No signature verifies' of ${S23} ('the payloadType plays no part'): application/json, well signed by a key the verifier does not embed`, [newKey().spki], envJson(st), UNKNOWN())
  st = setup('this payload is no JSON', 'application/vnd.hilbertraum.models+json')
  vec(E, 'env-type-other-hilbertraum-payload-not-json', `${TY}: another HilbertRaum type from the embedded key is answered by its type; its payload (no JSON here) is never read as a release payload`, [st.key.spki], envJson(st), refuse('envelope', 'UPD-FOR-NEWER-HILBERTRAUM', RV))
  st = setup(Buffer.from([0x00, 0xff, 0xfe, 0x80]), 'application/octet-stream')
  vec(E, 'env-type-foreign-binary-payload', `${TY}: a foreign type from the embedded key with a payload of four bytes that are no UTF-8`, [st.key.spki], envJson(st), refuse('envelope', 'UPD-NOT-AN-UPDATE'))
}

// ================================================================================================================
// vectors-payload.json: section 2.4, the payload's table (and sections 4.3, 4.4 for files[])
// ================================================================================================================
{
  const P = 'payload'
  const text = (over = {}) => JSON.stringify(BASE(over))
  const FOR_NEWER = () => refuse('payload', 'UPD-FOR-NEWER-HILBERTRAUM', RV)
  const NOT_UPDATE = () => refuse('payload', 'UPD-NOT-AN-UPDATE')
  const CHANNEL = () => refuse('payload', 'UPD-WRONG-CHANNEL')

  // ---- reading
  const R = `${S24} 'Reading'`
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  const unreadable = [
    ['not-json', 'this is no JSON', 'plain text'],
    ['byte-order-mark', Buffer.concat([BOM, utf8(text())]), 'a good payload after a byte-order mark'],
    ['not-utf8-in-ignored-key', Buffer.concat([utf8(text().slice(0, -1) + ',"note":"'), Buffer.from([0xc3, 0x28]), utf8('"}')]), 'a good payload with the bytes C3 28 (no UTF-8) in the string of an ignored key'],
    ['utf16le', Buffer.from(text(), 'utf16le'), 'a good payload written as UTF-16 LE'],
    ['top-level-array', '[' + text() + ']', 'an array that holds a good payload'],
    ['top-level-null', 'null', 'null'],
    ['top-level-string', JSON.stringify(text()), 'a JSON string that holds a good payload as text'],
    ['top-level-number', '1', 'the number 1'],
    ['trailing-text', text() + ' x', 'a good payload followed by text'],
    ['cut-short', text().slice(0, -20), 'a good payload cut 20 bytes before its end'],
    ['two-texts', text() + text(), 'a good payload twice in a row'],
    ['trailing-comma', text().replace(/}$/, ',}'), 'a comma before the closing brace'],
    ['fields-under-proto-key', '{"__proto__":' + text() + '}', 'every field inside an object under the key __proto__ (only own keys count, so format is missing)']
  ]
  for (const [slug, payload, what] of unreadable) pay(P, `pay-read-${slug}`, `${R} (the envelope's reader over the verified bytes; a payload that fails it -> UPD-TOO-NEW, never damage): ${what}, signed by the embedded key`, payload, TOO_NEW())
  pay(P, 'pay-read-duplicate-format-last-counts-accepted', `${R} ('the last of a duplicate key'): format 2 first, format 1 last`, text().replace('{"format":1,', '{"format":2,').replace(/}$/, ',"format":1}'), accepted())
  pay(P, 'pay-read-duplicate-format-last-counts-refused', `${R} ('the last of a duplicate key') and 'format': format 1 first, format 2 last`, text().replace(/}$/, ',"format":2}'), TOO_NEW())
  pay(P, 'pay-read-escaped-keys-accepted', `${R} (keys compared after JSON's escapes are decoded): format, product and version each spelt with one \\u escape`, text().replace('"format"', '"f\\u006frmat"').replace('"product"', '"\\u0070roduct"').replace('"version"', '"versio\\u006e"'), accepted())
  pay(P, 'pay-read-unknown-fields-accepted', `${R} ('every other field not in this table [is] ignored'; the engine fields of sections 6.5, 6.6): unknown fields of every JSON type, a field security, engine fields and an own __proto__ key`, text().replace(/}$/, ',"engine":{"version":"b12110","min":"b11146"},"engine_min":"b11146","security":true,"notes":[1,"two",null,{"three":3.5}],"__proto__":{"format":2,"channel":"beta"},"highest_version_seen":"9.9.9","Format":2,"Channel":"beta"}'), accepted())
  pay(P, 'pay-read-whitespace-and-key-order-accepted', `${R} ('key order, whitespace and number spelling carry no meaning'): the base payload indented with four spaces and CR LF, its keys in reverse order`, JSON.stringify(Object.fromEntries(Object.entries(BASE()).reverse()), null, 4).replace(/\n/g, '\r\n') + '\r\n', accepted())

  // ---- format
  const F = `${S24} 'format'`
  for (const [slug, raw] of [['1-point-0', '1.0'], ['1e0', '1e0'], ['10e-1', '10e-1'], ['1-point-000', '1.000'], ['rounds-to-1', '1.00000000000000000001'], ['0-point-9-rounds-to-1', '0.99999999999999999999']]) {
    pay(P, `pay-format-${slug}-accepted`, `${F} ('the value JSON.parse gives is === 1 (so 1.0, 1e0 and any number text that the parse rounds to 1 pass)'): format written ${raw}`, text().replace('"format":1,', `"format":${raw},`), accepted())
  }
  const badFormat = [['missing', null, 'no format'], ['2', '2', '2'], ['0', '0', '0'], ['minus-1', '-1', '-1'], ['1-point-5', '1.5', '1.5'], ['next-double-above-1', '1.0000000000000002', '1.0000000000000002, the next double above 1'], ['11', '11', '11'], ['1e400', '1e400', '1e400'], ['string-1', '"1"', 'the string "1"'], ['null', 'null', 'null'], ['true', 'true', 'true'], ['array', '[1]', 'the array [1]'], ['object', '{"major":1,"minor":0}', 'an object']]
  for (const [slug, raw, what] of badFormat) {
    pay(P, `pay-format-${slug}`, `${F} ('anything else, missing included ... -> UPD-TOO-NEW'): ${what}`, raw === null ? text({ format: undefined }) : text().replace('"format":1,', `"format":${raw},`), TOO_NEW())
  }

  // ---- product, kind, channel
  const fields = [
    ['product', NOT_UPDATE, 'UPD-NOT-AN-UPDATE', [['missing', undefined], ['other-case', 'HilbertRaum'], ['upper-case', 'HILBERTRAUM'], ['trailing-space', 'hilbertraum '], ['other-product', 'otherproduct'], ['empty', ''], ['null', null], ['number', 1], ['array', ['hilbertraum']]]],
    ['kind', FOR_NEWER, 'UPD-FOR-NEWER-HILBERTRAUM', [['missing', undefined], ['other-case', 'Release'], ['models', 'models'], ['definitions', 'definitions'], ['trailing-space', 'release '], ['empty', ''], ['null', null], ['number', 1], ['array', ['release']]]],
    ['channel', CHANNEL, 'UPD-WRONG-CHANNEL', [['missing', undefined], ['other-case', 'Stable'], ['beta', 'beta'], ['trailing-space', 'stable '], ['empty', ''], ['null', null], ['true', true], ['array', ['stable']]]]
  ]
  for (const [field, expect, code, cases] of fields) {
    for (const [slug, value] of cases) {
      pay(P, `pay-${field}-${slug}`, `${S24} '${field}' ('anything else, missing included -> ${code}'): ${value === undefined ? 'no ' + field : field + ' is ' + JSON.stringify(value)}`, text({ [field]: value }), expect())
    }
  }

  // ---- version
  const VR = `${S24} 'version'`
  const v64 = '1.1.0-' + 'a'.repeat(58)
  const v65 = '1.1.0-' + 'a'.repeat(59)
  pay(P, 'pay-version-64-bytes-accepted', `${VR} ('SemVer 2.0.0 ... of at most 64 bytes'): a version of exactly 64 bytes`, text({ version: v64 }), accepted({ version: v64 }))
  pay(P, 'pay-version-65-bytes', `${VR} ('at most 64 bytes'; CF-36): a SemVer version of 65 bytes`, text({ version: v65 }), TOO_NEW())
  pay(P, 'pay-version-build-metadata-accepted', `${VR} (SemVer 2.0.0 as parseSemver reads it; build metadata is a writer's duty to leave out, not a refusal): 1.1.0+build.5`, text({ version: '1.1.0+build.5' }), accepted({ version: '1.1.0+build.5' }))
  pay(P, 'pay-version-pre-release-accepted', `${VR} and section 2.5 'Order': 1.1.0-rc.1 is SemVer and above the running 1.0.0`, text({ version: '1.1.0-rc.1' }), accepted({ version: '1.1.0-rc.1' }))
  const badVersion = [['missing', undefined, 'no version'], ['null', null, 'null'], ['number', 1.1, 'the number 1.1'], ['empty', '', 'the empty string'], ['two-parts', '1.1', '1.1'], ['four-parts', '1.1.0.0', '1.1.0.0'], ['leading-v', 'v1.1.0', 'v1.1.0'], ['leading-zero', '1.01.0', '1.01.0'], ['trailing-space', '1.1.0 ', '1.1.0 with a trailing space'], ['leading-space', ' 1.1.0', '1.1.0 with a leading space'], ['empty-pre-release', '1.1.0-', '1.1.0-'], ['pre-release-leading-zero', '1.1.0-01', '1.1.0-01'], ['underscore', '1.1.0-rc_1', '1.1.0-rc_1'], ['fullwidth-digit', '\u{ff11}.1.0', 'a full-width digit one, then .1.0'], ['array', ['1.1.0'], 'an array holding 1.1.0'], ['object', { major: 1, minor: 1, patch: 0 }, 'an object']]
  for (const [slug, value, what] of badVersion) pay(P, `pay-version-${slug}`, `${VR} ('anything else, missing included -> UPD-TOO-NEW'): ${what}`, text({ version: value }), TOO_NEW())

  // ---- min_upgrade_from
  const M = `${S24} 'min_upgrade_from'`
  const needs = (min, rv = '1.0.0') => refuse('payload', 'UPD-NEEDS-IN-BETWEEN', { runningVersion: rv, minUpgradeFrom: min })
  pay(P, 'pay-min-equal-running-accepted', `${M} ('equal passes'): min_upgrade_from 1.0.0, running 1.0.0`, text({ min_upgrade_from: '1.0.0' }), accepted())
  pay(P, 'pay-min-below-running-accepted', `${M}: min_upgrade_from 0.9.0, running 1.0.0`, text({ min_upgrade_from: '0.9.0' }), accepted())
  pay(P, 'pay-min-above-running', `${M} ('above the running version ... -> UPD-NEEDS-IN-BETWEEN'): min_upgrade_from 1.0.1, running 1.0.0`, text({ min_upgrade_from: '1.0.1' }), needs('1.0.1'))
  pay(P, 'pay-min-pre-release-and-build-above-running', `${M} ('above the running version ... -> UPD-NEEDS-IN-BETWEEN') and section 2.10 'The parameters' ('the text exactly as the payload ... wrote it, never normalised'): min_upgrade_from 1.0.1-rc.1+b.7, running 1.0.0; minUpgradeFrom keeps the pre-release and the build metadata`, text({ min_upgrade_from: '1.0.1-rc.1+b.7' }), needs('1.0.1-rc.1+b.7'))
  pay(P, 'pay-min-release-above-running-pre-release', `${M} ('a pre-release below its release'): min_upgrade_from 1.0.0, running 1.0.0-rc.1`, text({ min_upgrade_from: '1.0.0' }), needs('1.0.0', '1.0.0-rc.1'), { runningVersion: '1.0.0-rc.1' })
  pay(P, 'pay-min-pre-release-below-running-accepted', `${M} ('a pre-release below its release'): min_upgrade_from 1.0.0-rc.1, running 1.0.0`, text({ min_upgrade_from: '1.0.0-rc.1' }), accepted())
  pay(P, 'pay-min-build-metadata-equal-accepted', `${M} ('build metadata no part'; 'equal passes'): min_upgrade_from 1.0.0+build.9, running 1.0.0`, text({ min_upgrade_from: '1.0.0+build.9' }), accepted())
  pay(P, 'pay-min-numeric-order', `${M} (SemVer order, numbers as numbers): min_upgrade_from 1.0.10, running 1.0.9`, text({ min_upgrade_from: '1.0.10' }), needs('1.0.10', '1.0.9'), { runningVersion: '1.0.9' })
  pay(P, 'pay-min-numeric-order-accepted', `${M} (SemVer order, numbers as numbers): min_upgrade_from 1.0.9, running 1.0.10 (the update is 1.1.0)`, text({ min_upgrade_from: '1.0.9' }), accepted(), { runningVersion: '1.0.10' })
  pay(P, 'pay-min-64-bytes-accepted', `${M} ('a version as version is': at most 64 bytes): a pre-release of 1.0.0 of exactly 64 bytes, below the running 1.0.0`, text({ min_upgrade_from: '1.0.0-' + 'a'.repeat(58) }), accepted())
  const badMin = [['null', null, "null ('null included: a writer omits the field')"], ['65-bytes', '1.0.0-' + 'a'.repeat(59), 'a SemVer version of 65 bytes'], ['number', 1, 'the number 1'], ['empty', '', 'the empty string'], ['two-parts', '1.0', '1.0'], ['leading-v', 'v1.0.0', 'v1.0.0'], ['range', '>=1.0.0', 'a range, >=1.0.0'], ['false', false, 'false'], ['array', ['1.0.0'], 'an array']]
  for (const [slug, value, what] of badMin) pay(P, `pay-min-${slug}`, `${M} ('Else a version as version is, or UPD-TOO-NEW'): ${what}`, text({ min_upgrade_from: value }), TOO_NEW())

  // ---- the policy's cap (section 2.10)
  const CAP = `app-updates.md section 2.10 ('A version above it -> UPD-ABOVE-MAX-VERSION'; the stage is payload, section 10.7 'expect')`
  const above = (version, maxVersion) => refuse('payload', 'UPD-ABOVE-MAX-VERSION', { version, maxVersion })
  pay(P, 'pay-cap-above', `${CAP}: version 1.1.0, cap 1.0.5`, text(), above('1.1.0', '1.0.5'), { maxVersion: '1.0.5' })
  pay(P, 'pay-cap-equal-accepted', `${CAP}: version 1.1.0 equals the cap 1.1.0 and is not above it`, text(), accepted(), { maxVersion: '1.1.0' })
  pay(P, 'pay-cap-higher-accepted', `${CAP}: version 1.1.0, cap 2.0.0`, text(), accepted(), { maxVersion: '2.0.0' })
  pay(P, 'pay-cap-pre-release-of-the-version', `${CAP} and section 2.5 'Order' (a pre-release is below its release): version 1.1.0 is above the cap 1.1.0-rc.1; maxVersion is the cap's text`, text(), above('1.1.0', '1.1.0-rc.1'), { maxVersion: '1.1.0-rc.1' })
  pay(P, 'pay-cap-build-metadata-equal-accepted', `${CAP} and section 2.5 'Order' (build metadata no part): version 1.1.0 is not above the cap 1.1.0+kit`, text(), accepted(), { maxVersion: '1.1.0+kit' })
}

{
  const P = 'payload'
  const text = (over = {}) => JSON.stringify(BASE(over))
  const CANT = () => refuse('payload', 'UPD-CANT-CHECK-LINUX-FLOOR', RV)
  const tooOld = (system, floor, hostVersion) => refuse('payload', 'UPD-OS-TOO-OLD', { runningVersion: '1.0.0', system, floor, hostVersion })
  const HOSTS = { win32: {}, darwin: MAC, linux: LINUX }

  // ---- requires: its type and its keys
  const RQ = `${S24} 'requires'`
  for (const [slug, raw, what] of [['array', '["10.0"]', 'an array'], ['empty-array', '[]', 'an empty array'], ['null', 'null', 'null'], ['string', '"10.0"', 'a string'], ['number', '10', 'a number'], ['true', 'true', 'true']]) {
    pay(P, `pay-requires-${slug}`, `${RQ} ('Anything but an object (an array and null included) -> UPD-TOO-NEW'): requires is ${what}`, text().replace(/}$/, `,"requires":${raw}}`), TOO_NEW())
  }
  pay(P, 'pay-requires-empty-object-accepted', `${RQ}: an empty object names no floor`, text({ requires: {} }), accepted())
  pay(P, 'pay-requires-unknown-keys-accepted', `${RQ} ('every other key and its value are ignored'; keys 'code unit for code unit'): Win32, Linux, DARWIN, freebsd, linux-arm64 and android with values that break the floor grammar`, text({ requires: { Win32: 'not a floor', Linux: null, DARWIN: 99, freebsd: '14.x', 'linux-arm64': { glibc: '2.99' }, android: ['35'] } }), accepted())
  pay(P, 'pay-requires-floors-under-proto-key-accepted', `${RQ} ('only the own keys win32, darwin and linux are read') and section 2.3 'JSON' (an own __proto__ key is an unknown key): floors that this computer does not meet sit under a key __proto__`, text().replace(/}$/, ',"requires":{"__proto__":{"win32":"99.0","linux":"garbled"}}}'), accepted())

  // ---- a floor that breaks the grammar: every form on a Windows host, for each of the three keys
  const GR = `${S24} 'A floor's grammar' and 'A floor that breaks it'`
  const longOk = '00.' + Array(31).fill('0').join('.') // 2 + 1 + 31 + 30 = 64 bytes, every component 0
  const long65 = '000.' + Array(31).fill('0').join('.') // 65 bytes
  if (longOk.length !== 64 || long65.length !== 65) throw new Error('floor lengths')
  const garbled = [
    ['number', 10, 'a number, not a string'], ['null', null, 'null'], ['true', true, 'true'], ['array', ['10', '0'], 'an array of components'], ['object', { min: '10.0' }, 'an object'],
    ['empty', '', 'the empty string (one or more components)'], ['trailing-dot', '10.', 'an empty last component'], ['leading-dot', '.10', 'an empty first component'], ['double-dot', '10..0', 'an empty middle component'],
    ['letter-suffix', '10.0-beta', 'a letter and a hyphen'], ['leading-v', 'v10.0', 'a leading v'], ['leading-space', ' 10.0', 'a leading space'], ['trailing-space', '10.0 ', 'a trailing space'], ['plus-sign', '+10.0', 'a sign'], ['minus-sign', '-1', 'a negative number'],
    ['ten-digits', '10.0.1234567890', 'a component of ten digits (1 to 9 are allowed)'], ['comma', '10,0', 'a comma in place of the dot'], ['fullwidth-digits', '\u{ff11}\u{ff10}.0', 'full-width digits (ASCII digits are asked for)'], ['hex', '0x0a.0', 'a hexadecimal component'], ['exponent', '1e1.0', 'an exponent'],
    ['65-bytes', long65, 'a well-formed string of 65 bytes (at most 64)']
  ]
  for (const key of ['linux', 'win32', 'darwin']) {
    for (const [slug, value, what] of garbled) {
      const linux = key === 'linux'
      pay(P, `pay-floor-garbled-${key}-${slug}`, `${GR} (${linux ? 'linux: UPD-CANT-CHECK-LINUX-FLOOR on every system' : key + ': UPD-TOO-NEW on every system'}): requires.${key} is ${what}; the host is Windows and no other floor is named`, text({ requires: { [key]: value } }), linux ? CANT() : TOO_NEW())
    }
  }
  // ---- each garbled floor on each host system
  for (const host of ['win32', 'darwin', 'linux']) {
    for (const key of ['linux', 'win32', 'darwin']) {
      const linux = key === 'linux'
      pay(P, `pay-floor-garbled-${key}-on-${host}-host`, `${GR} ('on every system'): requires.${key} is 10.x, the other two floors are well-formed and met; the host is ${host} -> ${linux ? 'UPD-CANT-CHECK-LINUX-FLOOR' : 'UPD-TOO-NEW'}`, text({ requires: { win32: '10.0', darwin: '13.0', linux: '2.34', [key]: '10.x' } }), linux ? CANT() : TOO_NEW(), HOSTS[host])
    }
  }
  // ---- the grammar's bounds, accepted
  pay(P, 'pay-floor-64-bytes-accepted', `${S24} 'A floor's grammar' ('at most 64 bytes'; 'a leading zero means nothing') and 'Comparing': a win32 floor of exactly 64 bytes, 32 components that are all zero, which every host meets`, text({ requires: { win32: longOk } }), accepted())
  pay(P, 'pay-floor-nine-digits-accepted', `${S24} 'A floor's grammar' ('each 1 to 9 ASCII digits'): a win32 floor 000000010.000000000.000026300, three components of nine digits, equal to the host's 10.0.26300`, text({ requires: { win32: '000000010.000000000.000026300' } }), accepted())
  pay(P, 'pay-floor-nine-digits-too-old', `${S24} 'A floor's grammar' (nine digits keep every integer exact) and 'This system's floor': the floor 10.0.999999999 is above the host's 10.0.26300`, text({ requires: { win32: '10.0.999999999' } }), tooOld('win32', '10.0.999999999', '10.0.26300'))
  pay(P, 'pay-floor-one-component-accepted', `${S24} 'A floor's grammar' ('one or more components') and 'Comparing' (a missing component counts 0): the floor 10 on the host 10.0.26300`, text({ requires: { win32: '10' } }), accepted())

  // ---- comparing, and this system's floor
  const CMP = `${S24} 'Comparing' and 'This system's floor'`
  const compare = [
    ['win32-equal', 'win32', '10.0.26300', {}, null, 'the host equals the floor'],
    ['win32-one-below', 'win32', '10.0.26301', {}, '10.0.26300', 'the host is one build below the floor'],
    ['win32-leading-zeros-equal', 'win32', '010.00.026300', {}, null, 'the floor 010.00.026300 is 10.0.26300 (a leading zero means nothing)'],
    ['win32-leading-zeros-below', 'win32', '010.00.026301', {}, '10.0.26300', 'the floor 010.00.026301 is 10.0.26301; the parameter keeps the text as written'],
    ['win32-first-difference-decides', 'win32', '10.1', {}, '10.0.26300', 'the second component decides: 10.1 is above 10.0.26300'],
    ['win32-integers-not-text', 'win32', '9.9.99999', {}, null, '9 is below 10 as an integer (as text it would be above)'],
    ['win32-shorter-floor', 'win32', '10.0', {}, null, 'the floor 10.0 counts as 10.0.0'],
    ['win32-longer-floor-zero', 'win32', '10.0.26300.0', {}, null, 'a fourth component 0 equals the missing one'],
    ['win32-longer-floor-above-zero', 'win32', '10.0.26300.1', {}, '10.0.26300', 'a fourth component above 0 is not met by a host of three components'],
    ['win32-host-four-components', 'win32', '10.0.26300.1', { osVersion: '10.0.26300.7462' }, null, 'the host 10.0.26300.7462 meets 10.0.26300.1'],
    ['win32-windows-11-floor-on-windows-10', 'win32', '10.0.22000', { osVersion: '10.0.19045' }, '10.0.19045', 'a Windows 10 host (10.0.19045) below a Windows 11 floor (10.0.22000)'],
    ['darwin-equal-shorter-floor', 'darwin', '15.1', MAC, null, 'the floor 15.1 on the host 15.1.0'],
    ['darwin-below', 'darwin', '15.2', MAC, '15.1.0', 'the host 15.1.0 is below 15.2'],
    ['darwin-major-above', 'darwin', '14', MAC, null, 'the floor 14 on the host 15.1.0'],
    ['darwin-two-digit-order', 'darwin', '9.99', MAC, null, '9.99 is below 15.1.0 as integers'],
    ['linux-above-floor', 'linux', '2.34', LINUX, null, 'glibc 2.39 meets 2.34'],
    ['linux-equal', 'linux', '2.39', LINUX, null, 'glibc 2.39 equals the floor'],
    ['linux-below', 'linux', '2.40', LINUX, '2.39', 'glibc 2.39 is below 2.40'],
    ['linux-components-are-integers', 'linux', '2.4', LINUX, null, 'the floor 2.4 is below glibc 2.39 (4 is below 39; as a decimal fraction 2.4 would be above)'],
    ['linux-three-digit-minor', 'linux', '2.100', LINUX, '2.39', 'the floor 2.100 is above glibc 2.39 (100 is above 39; as text it would be below)'],
    ['linux-major-decides', 'linux', '3.0', LINUX, '2.39', 'glibc 2.39 is below 3.0'],
    ['linux-third-component', 'linux', '2.39.1', LINUX, '2.39', 'a third component above 0 is not met by glibc 2.39']
  ]
  for (const [slug, system, floor, host, hostVersion, what] of compare) {
    pay(P, `pay-floor-${slug}${hostVersion === null ? '-accepted' : ''}`, `${CMP} (component by component as integers; the host meets a floor it equals or exceeds): ${what}`, text({ requires: { [system]: floor } }), hostVersion === null ? accepted() : tooOld(system, floor, hostVersion), host)
  }
  pay(P, 'pay-floor-only-other-systems-accepted', `${S24} 'This system's floor' ('absent: passes'): a Windows host, floors for darwin and linux only that it would not meet as its own, and no app of those systems at the root`, text({ requires: { darwin: '99.0', linux: '9.99' } }), accepted())

  // ---- a host value that cannot be read
  const HV = `${S24} 'This system's floor'`
  pay(P, 'pay-host-glibc-absent-with-linux-floor', `${HV} ('On Linux, when the payload names a linux floor, a host glibc that is absent ... -> UPD-CANT-CHECK-LINUX-FLOOR'): glibc is null`, text({ requires: { linux: '2.34' } }), CANT(), { ...LINUX, glibc: null })
  pay(P, 'pay-host-glibc-absent-no-linux-floor-accepted', `${HV} ('without a linux floor there is nothing to check'; owner 2026-11-26, Q9): glibc is null and the payload has no requires`, text(), accepted(), { ...LINUX, glibc: null })
  pay(P, 'pay-host-glibc-absent-only-other-floors-accepted', `${HV} ('without a linux floor there is nothing to check'): glibc is null, the payload names win32 and darwin floors only, no app of those systems at the root`, text({ requires: { win32: '10.0', darwin: '13.0' } }), accepted(), { ...LINUX, glibc: null })
  for (const [slug, glibc, what] of [['letters', '2.39-ubuntu', '2.39-ubuntu'], ['empty', '', 'the empty string'], ['words', 'glibc 2.39', 'glibc 2.39'], ['trailing-dot', '2.39.', '2.39 with a trailing dot']]) {
    pay(P, `pay-host-glibc-garbled-${slug}-with-linux-floor`, `${HV} ('a host glibc that ... breaks the grammar -> UPD-CANT-CHECK-LINUX-FLOOR'): the host gives ${what}`, text({ requires: { linux: '2.34' } }), CANT(), { ...LINUX, glibc })
  }
  pay(P, 'pay-floor-linux-host-leading-zero-below', `${S24} 'A floor's grammar' ('The host's value is read with the same grammar': a leading zero means nothing, 039 is 39), 'This system's floor' ('Below the floor -> UPD-OS-TOO-OLD') and section 2.10 'The parameters' (hostVersion as the host gave it, never normalised): the host gives glibc 2.039, the floor is 2.40`, text({ requires: { linux: '2.40' } }), tooOld('linux', '2.40', '2.039'), { ...LINUX, glibc: '2.039' })
  pay(P, 'pay-host-glibc-garbled-no-linux-floor-accepted', `${HV} ('without a linux floor there is nothing to check'): the host gives 2.39-ubuntu and the payload names no linux floor`, text({ requires: {} }), accepted(), { ...LINUX, glibc: '2.39-ubuntu' })
  for (const [slug, os, osVersion, floor] of [['win32-words', 'win32', 'Windows 11', '10.0'], ['win32-empty', 'win32', '', '10.0'], ['win32-suffix', 'win32', '10.0.26300-compat', '10.0'], ['darwin-letters', 'darwin', '15.1.0a', '13.0'], ['darwin-empty', 'darwin', '', '13.0']]) {
    pay(P, `pay-host-version-garbled-${slug}-with-floor`, `${HV} ('On Windows and macOS a host value that breaks the grammar meets no floor, so a named floor gives UPD-OS-TOO-OLD'; owner 2026-11-26, Q7; hostVersion 'as the host gave it'): the host gives ${JSON.stringify(osVersion)}, the floor ${floor} is one every real host meets`, text({ requires: { [os]: floor } }), tooOld(os, floor, osVersion), { os, osVersion, glibc: null })
  }
  pay(P, 'pay-host-version-garbled-win32-no-floor-accepted', `${HV} ('absent: passes'): the Windows host gives a version that breaks the grammar and the payload has no requires`, text(), accepted(), { osVersion: 'Windows 11' })
  pay(P, 'pay-host-version-garbled-win32-only-other-floors-accepted', `${HV} ('absent: passes'): the Windows host gives a version that breaks the grammar; the payload names darwin and linux floors only, no app of those systems at the root`, text({ requires: { darwin: '13.0', linux: '2.34' } }), accepted(), { osVersion: 'Windows 11' })

  // ---- the other systems' floors (a warning with an accepted payload)
  const OS = `${S24} 'The other systems' floors' and section 2.10 (floors in the order win32, darwin, linux; the text as written)`
  const exe = { name: 'HilbertRaum-1.0.0-portable.exe', kind: 'file', system: 'win32', version: '1.0.0' }
  const zip = { name: 'HilbertRaum-1.0.0-mac-arm64.app.zip', kind: 'file', system: 'darwin', version: '1.0.0' }
  const appFolder = { name: 'HilbertRaum.app', kind: 'folder', system: 'darwin', version: null }
  const appImage = { name: 'HilbertRaum-1.0.0.AppImage', kind: 'file', system: 'linux', version: '1.0.0' }
  const all = { linux: '2.34', darwin: '013.0', win32: '10.0' } // written in another order than the answer's
  const f = (system, floor) => ({ system, floor })
  pay(P, 'pay-other-floors-all-three-systems-at-root-accepted', `${OS}: a Windows host, apps of all three systems at the root, three floors; the two other systems' floors are shown, darwin's as written (013.0)`, text({ requires: all }), accepted({}, { otherSystemFloors: [f('darwin', '013.0'), f('linux', '2.34')] }), { rootApps: [exe, zip, appImage] })
  pay(P, 'pay-other-floors-only-own-app-at-root-accepted', `${OS} ('that have an app at the root'): a Windows host, only the Windows app at the root, three floors -> none shown`, text({ requires: all }), accepted(), { rootApps: [exe] })
  pay(P, 'pay-other-floors-root-not-listed-accepted', `${OS} ('every one the payload names when the root could not be listed'): a Windows host, rootApps null, three floors -> the two other systems' floors`, text({ requires: all }), accepted({}, { otherSystemFloors: [f('darwin', '013.0'), f('linux', '2.34')] }), { rootApps: null })
  pay(P, 'pay-other-floors-app-folder-counts-accepted', `${OS} (the root apps' system: a root .app folder is a darwin app): a Windows host, the Windows app and a .app folder at the root -> the darwin floor only`, text({ requires: all }), accepted({}, { otherSystemFloors: [f('darwin', '013.0')] }), { rootApps: [exe, appFolder] })
  pay(P, 'pay-other-floors-linux-host-accepted', `${OS}: a Linux host, apps of all three systems at the root -> win32 then darwin`, text({ requires: all }), accepted({}, { otherSystemFloors: [f('win32', '10.0'), f('darwin', '013.0')] }), { ...LINUX, rootApps: [appImage, zip, exe] })
  pay(P, 'pay-other-floors-darwin-host-accepted', `${OS}: a macOS host, apps of all three systems at the root -> win32 then linux`, text({ requires: all }), accepted({}, { otherSystemFloors: [f('win32', '10.0'), f('linux', '2.34')] }), { ...MAC, rootApps: [appImage, zip, exe] })
  pay(P, 'pay-other-floors-system-at-root-without-floor-accepted', `${OS}: a Windows host, apps of all three systems at the root, the payload names a linux floor only -> that one`, text({ requires: { linux: '2.34' } }), accepted({}, { otherSystemFloors: [f('linux', '2.34')] }), { rootApps: [exe, zip, appImage] })
  pay(P, 'pay-other-floors-not-with-a-refusal', `${OS} ('with an accepted payload only') and 'This system's floor': a Windows host below its own floor, apps of all three systems at the root -> UPD-OS-TOO-OLD with no floors listed`, text({ requires: { ...all, win32: '11.0' } }), tooOld('win32', '11.0', '10.0.26300'), { rootApps: [exe, zip, appImage] })
  pay(P, 'pay-other-floors-not-with-a-files-refusal', `${OS} ('with an accepted payload only'; section 2.10 'The flags': the three user-visible ones 'are set with an accepted payload only') and 'files' (section 4.4: a member name with a space): a Windows host, the macOS app at the root, a darwin floor 13.0 that would be shown, and one files[] entry named 'my file' -> UPD-TOO-NEW with no floors listed`, text({ requires: { darwin: '13.0' }, files: [{ name: 'my file', size: 1, sha256: H('x') }] }), TOO_NEW(), { rootApps: [zip] })
}

{
  const P = 'payload'
  const text = (over = {}) => JSON.stringify(BASE(over))
  /** The milliseconds of a `YYYY-MM-DDTHH:MM:SSZ` literal, to hold each hand-written pair against its stated distance. */
  const ms = (t) => Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16), +t.slice(17, 19))
  function issuedCase(id, why, issued, now, distance, flags) {
    if (ms(issued) - ms(now) !== distance) throw new Error(`${id}: issued - now is ${ms(issued) - ms(now)}, not ${distance}`)
    pay(P, id, why, text({ issued }), accepted({ issued }, flags), { now })
  }
  const DAY = 86_400_000
  const FUT = `${S24} 'issued in the future' (issued - now > 86,400,000 ms)`
  const OLD = `${S24} 'issued old' (now - issued > 31,536,000,000 ms; 'exactly 365 days is not old')`
  const NOTE = "section 10.7's now has whole seconds, so the nearest value past the boundary is 1,000 ms past it"
  issuedCase('pay-issued-24h-ahead-accepted', `${FUT}: issued is exactly 24 hours ahead of now (86,400,000 ms), no warning`, '2027-01-16T12:00:00Z', '2027-01-15T12:00:00Z', DAY, {})
  issuedCase('pay-issued-24h-and-1s-ahead-accepted', `${FUT}: issued is 86,401,000 ms ahead of now -> the warning (${NOTE})`, '2027-01-16T12:00:01Z', '2027-01-15T12:00:00Z', DAY + 1000, { issuedInFuture: true })
  issuedCase('pay-issued-14h-ahead-accepted', `${FUT} ('The day absorbs a clock kept in the wrong time zone (at most 14 hours off)'): issued is 14 hours ahead, no warning`, '2027-01-16T02:00:00Z', '2027-01-15T12:00:00Z', 14 * 3_600_000, {})
  issuedCase('pay-issued-one-second-ahead-accepted', `${FUT}: issued is one second ahead of now, no warning`, '2027-01-15T12:00:01Z', '2027-01-15T12:00:00Z', 1000, {})
  issuedCase('pay-issued-same-instant-accepted', `${FUT} and ${OLD.slice(S24.length + 1)}: issued equals now, neither notice`, '2027-01-15T12:00:00Z', '2027-01-15T12:00:00Z', 0, {})
  issuedCase('pay-issued-next-calendar-day-under-24h-accepted', `${FUT} (milliseconds, no calendar day): issued is on the next calendar day but only 2 seconds ahead, no warning`, '2027-01-16T00:00:01Z', '2027-01-15T23:59:59Z', 2000, {})
  issuedCase('pay-issued-ten-years-ahead-accepted', `${FUT}: issued is 3,652 days ahead -> the warning, and the payload is still accepted (an advisory field never refuses)`, '2037-01-14T12:00:00Z', '2027-01-15T12:00:00Z', 3652 * DAY, { issuedInFuture: true })
  issuedCase('pay-issued-365-days-old-accepted', `${OLD}: issued is exactly 365 days before now (31,536,000,000 ms), no confirmation`, '2026-01-15T12:00:00Z', '2027-01-15T12:00:00Z', -365 * DAY, {})
  issuedCase('pay-issued-365-days-and-1s-old-accepted', `${OLD}: issued is 31,536,001,000 ms before now -> the confirmation (${NOTE})`, '2026-01-15T11:59:59Z', '2027-01-15T12:00:00Z', -365 * DAY - 1000, { oldFile: true })
  issuedCase('pay-issued-364-days-old-accepted', `${OLD}: issued is 364 days before now, no confirmation`, '2026-01-16T12:00:00Z', '2027-01-15T12:00:00Z', -364 * DAY, {})
  issuedCase('pay-issued-leap-year-365-days-accepted', `${OLD} ('A day count, not calendar months'): now is 2028-03-01 and issued 2027-03-02, exactly 365 days across 29 February 2028, no confirmation`, '2027-03-02T00:00:00Z', '2028-03-01T00:00:00Z', -365 * DAY, {})
  issuedCase('pay-issued-leap-year-same-calendar-date-accepted', `${OLD} ('A day count, not calendar months'): now is 2028-03-01 and issued 2027-03-01, the same calendar date a year before but 366 days -> the confirmation`, '2027-03-01T00:00:00Z', '2028-03-01T00:00:00Z', -366 * DAY, { oldFile: true })
  issuedCase('pay-issued-year-2000-accepted', `${S24} 'issued' ('year 2000 to 9999') and 'issued old': the first instant of the year 2000 is a date, shown, and old`, '2000-01-01T00:00:00Z', '2027-01-15T12:00:00Z', ms('2000-01-01T00:00:00Z') - ms('2027-01-15T12:00:00Z'), { oldFile: true })
  issuedCase('pay-issued-year-9999-accepted', `${S24} 'issued' ('year 2000 to 9999') and 'issued in the future': the last second of the year 9999 is a date, shown, and in the future`, '9999-12-31T23:59:59Z', '2027-01-15T12:00:00Z', ms('9999-12-31T23:59:59Z') - ms('2027-01-15T12:00:00Z'), { issuedInFuture: true })
  issuedCase('pay-issued-29-february-2028-accepted', `${S24} 'issued' ('a day that exists in that month of the Gregorian calendar'): 29 February 2028 exists (now is one hour later)`, '2028-02-29T12:00:00Z', '2028-02-29T13:00:00Z', -3_600_000, {})
  issuedCase('pay-issued-29-february-2400-accepted', `${S24} 'issued' (the Gregorian calendar: 2400 is a leap year) and 'issued in the future': 29 February 2400 exists and is ahead`, '2400-02-29T00:00:00Z', '2027-01-15T12:00:00Z', ms('2400-02-29T00:00:00Z') - ms('2027-01-15T12:00:00Z'), { issuedInFuture: true })

  // ---- no readable date: no date shown, neither clock check (now is 2030, so a lenient reading would call most of them old)
  const NOW = '2030-06-01T00:00:00Z'
  const IS = `${S24} 'issued' ('Absent, or anything else: no date is shown and neither clock check runs (an advisory field never refuses)')`
  const noDate = [
    ['missing', undefined, 'no issued field'], ['null', null, 'null'], ['number-epoch-seconds', 1799568000, 'a number (epoch seconds)'], ['number-epoch-ms', 1799568000000, 'a number (epoch milliseconds)'], ['empty', '', 'the empty string'], ['array', ['2027-01-10T08:00:00Z'], 'an array holding a date'],
    ['lower-case-t', '2027-01-10t08:00:00Z', 'a lower-case t'], ['lower-case-z', '2027-01-10T08:00:00z', 'a lower-case z'], ['space-for-t', '2027-01-10 08:00:00Z', 'a space in place of T'],
    ['fraction', '2027-01-10T08:00:00.000Z', "a fraction (toISOString()'s form)"], ['offset-zero', '2027-01-10T08:00:00+00:00', "the offset +00:00 (git's %cI form)"], ['offset-plus-two', '2027-01-10T10:00:00+02:00', 'the offset +02:00'], ['no-z', '2027-01-10T08:00:00', 'no Z'],
    ['date-only', '2027-01-10', 'a date without a time'], ['no-seconds', '2027-01-10T08:00Z', 'no seconds'], ['trailing-space', '2027-01-10T08:00:00Z ', 'a trailing space (21 bytes)'], ['leading-space', ' 2027-01-10T08:00:00Z', 'a leading space'],
    ['basic-format', '20270110T080000Z', "ISO 8601's basic form without separators"], ['slashes', '2027/01/10T08:00:00Z', 'slashes in the date'], ['fullwidth-digit', '202\u{ff17}-01-10T08:00:00Z', 'a full-width digit in the year'],
    ['year-1999', '1999-12-31T23:59:59Z', 'the last second of 1999 (year 2000 to 9999)'], ['five-digit-year', '12027-01-10T08:00:00Z', 'a year of five digits'], ['signed-year', '+002027-01-10T08:00:00Z', 'an expanded year with a sign'],
    ['month-00', '2027-00-10T08:00:00Z', 'month 00'], ['month-13', '2027-13-10T08:00:00Z', 'month 13'], ['day-00', '2027-01-00T08:00:00Z', 'day 00'], ['day-32', '2027-01-32T08:00:00Z', 'day 32'], ['31-april', '2027-04-31T08:00:00Z', '31 April'], ['30-february', '2028-02-30T08:00:00Z', '30 February'],
    ['29-february-2027', '2027-02-29T08:00:00Z', '29 February of 2027, no leap year'], ['29-february-2100', '2100-02-29T08:00:00Z', '29 February of 2100, no leap year in the Gregorian calendar (it would be ahead of now)'],
    ['hour-24', '2027-01-10T24:00:00Z', 'hour 24'], ['minute-60', '2027-01-10T08:60:00Z', 'minute 60'], ['second-60', '2026-12-31T23:59:60Z', 'second 60 (a leap second is not in the grammar)']
  ]
  for (const [slug, issued, what] of noDate) pay(P, `pay-issued-unreadable-${slug}-accepted`, `${IS}: ${what}; the payload is accepted with issued null and no notice`, text({ issued }), accepted({ issued: null }), { now: NOW })
  pay(P, 'pay-issued-notices-not-with-a-refusal-future', `app-updates.md section 2.10 'The flags' ('set with an accepted payload only'): issued is ten years ahead and files is missing -> UPD-TOO-NEW with issuedInFuture false`, text({ issued: '2037-01-14T12:00:00Z', files: undefined }), TOO_NEW())
  pay(P, 'pay-issued-notices-not-with-a-refusal-old', `app-updates.md section 2.10 'The flags' ('set with an accepted payload only'): issued is in the year 2000 and files is missing -> UPD-TOO-NEW with oldFile false`, text({ issued: '2000-01-01T00:00:00Z', files: undefined }), TOO_NEW())

  // ---- summary
  const SU = `${S24} 'summary'`
  const sum = (id, why, summary, uiLanguage, shown) => pay(P, id, why, text({ summary }), accepted({ summary: shown }), { uiLanguage })
  const EN = 'Fixes and improvements.'
  const DE = 'Korrekturen und Verbesserungen.'
  sum('pay-summary-ui-language-accepted', `${SU} ('Shown: the UI language's value when it counts'): de and en present, the UI language is de`, { en: EN, de: DE }, 'de', DE)
  sum('pay-summary-fallback-en-accepted', `${SU} ('else en's when it counts'): only en and fr present, the UI language is de`, { en: EN, fr: 'Corrections et am\u{e9}liorations.' }, 'de', EN)
  sum('pay-summary-no-en-no-ui-language-accepted', `${SU} ('else none'): only fr present, the UI language is de`, { fr: 'Corrections et am\u{e9}liorations.' }, 'de', null)
  const ten = { en: EN, de: DE, es: 'Correcciones y mejoras.', fr: 'Corrections et am\u{e9}liorations.', it: 'Correzioni e miglioramenti.', nl: 'Oplossingen en verbeteringen.', pl: 'Poprawki i ulepszenia.', tr: 'D\u{fc}zeltmeler ve iyile\u{15f}tirmeler.', ru: '\u{418}\u{441}\u{43f}\u{440}\u{430}\u{432}\u{43b}\u{435}\u{43d}\u{438}\u{44f} \u{438} \u{443}\u{43b}\u{443}\u{447}\u{448}\u{435}\u{43d}\u{438}\u{44f}.', uk: '\u{412}\u{438}\u{43f}\u{440}\u{430}\u{432}\u{43b}\u{435}\u{43d}\u{43d}\u{44f} \u{442}\u{430} \u{43f}\u{43e}\u{43a}\u{440}\u{430}\u{449}\u{435}\u{43d}\u{43d}\u{44f}.' }
  for (const code of Object.keys(ten)) sum(`pay-summary-all-ten-languages-${code}-accepted`, `${SU} (release 1's ten codes: en, de, es, fr, it, nl, pl, tr, ru, uk): all ten present, the UI language is ${code}`, ten, code, ten[code])
  for (const [slug, summary, what] of [['missing', undefined, 'no summary'], ['null', null, 'null'], ['string', EN, 'a string'], ['array', [EN], 'an array'], ['number', 1, 'a number'], ['empty-object', {}, 'an empty object']]) {
    sum(`pay-summary-${slug}-accepted`, `${SU} ('absent or not an object: no summary'; 'A wrong type ... is ignored, never an error'): summary is ${what}`, summary, 'en', null)
  }
  const A400 = 'a'.repeat(400)
  const EMOJI = '\u{1f600}'
  const CYR = '\u{436}'
  sum('pay-summary-400-code-points-accepted', `${SU} ('a string of 1 to 400 Unicode code points'): 400 ASCII letters are shown`, { en: A400 }, 'en', A400)
  sum('pay-summary-401-code-points-accepted', `${SU} ('1 to 400 Unicode code points'; 'any other value is ignored as if absent'): 401 ASCII letters are ignored, so nothing is shown`, { en: A400 + 'a' }, 'en', null)
  sum('pay-summary-400-emoji-accepted', `${SU} ('Code points count the same ... unlike UTF-16 units (an emoji counts two) or bytes'): 400 times U+1F600 (800 UTF-16 units, 1,600 bytes) are shown`, { en: EMOJI.repeat(400) }, 'en', EMOJI.repeat(400))
  sum('pay-summary-401-emoji-accepted', `${SU} (code points): 401 times U+1F600 are ignored`, { en: EMOJI.repeat(401) }, 'en', null)
  sum('pay-summary-400-cyrillic-accepted', `${SU} (code points, not bytes: 'Cyrillic two'): 400 Cyrillic letters (800 bytes) are shown in ru`, { ru: CYR.repeat(400), en: EN }, 'ru', CYR.repeat(400))
  sum('pay-summary-401-cyrillic-falls-back-accepted', `${SU} ('else en's when it counts'): ru has 401 Cyrillic letters and is ignored, en is shown`, { ru: CYR.repeat(401), en: EN }, 'ru', EN)
  sum('pay-summary-one-code-point-accepted', `${SU} ('1 to 400'): one emoji (one code point, two UTF-16 units) is shown`, { en: EMOJI }, 'en', EMOJI)
  sum('pay-summary-empty-ui-language-falls-back-accepted', `${SU} ('1 to 400'; owner 2026-11-26, Q8: an empty text in the UI language falls back to English): de is the empty string`, { de: '', en: EN }, 'de', EN)
  sum('pay-summary-empty-en-accepted', `${SU} ('1 to 400'): en is the empty string and no other language is present`, { en: '' }, 'en', null)
  sum('pay-summary-both-too-long-accepted', `${SU} ('else none'): de and en both have 401 code points`, { de: A400 + 'b', en: A400 + 'a' }, 'de', null)
  for (const [slug, value, what] of [['number', 1, 'a number'], ['null', null, 'null'], ['array', [DE], 'an array holding the text'], ['object', { text: DE }, 'an object'], ['true', true, 'true']]) {
    sum(`pay-summary-value-${slug}-falls-back-accepted`, `${SU} ('A value counts when it is a string ...; any other value is ignored as if absent'): de is ${what}, en is shown`, { de: value, en: EN }, 'de', EN)
  }
  for (const [slug, key] of [['upper-case', 'DE'], ['region', 'de-AT'], ['underscore-region', 'de_DE'], ['three-letter', 'deu'], ['trailing-space', 'de ']]) {
    sum(`pay-summary-key-${slug}-accepted`, `${SU} (codes 'as release 1 spells them ..., code unit for code unit; any other key is ignored'): the only key is ${JSON.stringify(key)}, the UI language is de`, { [key]: DE }, 'de', null)
  }
  sum('pay-summary-unknown-languages-ignored-accepted', `${SU} ('An unknown language ... is ignored, never an error'): ja, zh and pt beside en, the UI language is en`, { ja: '\u{4fee}\u{6b63}\u{3068}\u{6539}\u{5584}\u{3002}', zh: '\u{4fee}\u{590d}\u{548c}\u{6539}\u{8fdb}\u{3002}', pt: 'Corre\u{e7}\u{f5}es e melhorias.', en: EN }, 'en', EN)
  sum('pay-summary-line-break-still-counts-accepted', `${SU} (the reader's rule is the type and the count; 'without line breaks or control characters' is the writers' duty, section 2.4 'Later writers: issued and summary'): an en value with a line feed counts and is shown as it is`, { en: 'First line.\nSecond line.' }, 'en', 'First line.\nSecond line.')
  // a lone surrogate can only be written as a JSON escape
  const lone = (lang) => text({ summary: { [lang]: '@@', en: lang === 'en' ? '@@' : EN } }).split('"@@"').join('"broken \\ud83d text"')
  pay(P, 'pay-summary-lone-surrogate-falls-back-accepted', `${SU} ('without a lone surrogate'): de holds the escape for U+D83D alone and is ignored, en is shown`, lone('de'), accepted({ summary: EN }), { uiLanguage: 'de' })
  pay(P, 'pay-summary-lone-surrogate-en-accepted', `${SU} ('without a lone surrogate'; 'else none'): en holds a lone surrogate and nothing is shown`, lone('en'), accepted({ summary: null }), { uiLanguage: 'en' })
  pay(P, 'pay-summary-text-under-proto-key-accepted', `${SU} ('Its own keys') and section 2.3 'JSON' (an own __proto__ key is an unknown key): the en text sits under a key __proto__`, text().replace(/}$/, `,"summary":{"__proto__":{"en":"${EN}"}}}`), accepted({ summary: null }))
}

{
  const P = 'payload'
  const text = (over = {}) => JSON.stringify(BASE(over))
  const FI = `${S24} 'files' and section 4.3 'files[] entries'`
  const HASH = H('member')
  const APPLY = { name: 'apply.cmd', size: 4096, sha256: H('apply.cmd') }
  const APPLY_OUT = { name: 'apply.cmd', size: 4096, sha256: H('apply.cmd'), group: null, installAs: null }
  const out = (name, size = 1, more = {}) => ({ name, size, sha256: HASH, group: null, installAs: null, ...more })

  // ---- files itself
  for (const [slug, raw, what] of [['missing', null, 'no files field'], ['null', 'null', 'null'], ['object', '{"apply.cmd":{"size":1}}', 'an object keyed by name'], ['string', '"apply.cmd"', 'a string'], ['number', '0', 'a number']]) {
    pay(P, `pay-files-${slug}`, `${FI} ('an own array ...; else UPD-TOO-NEW'): ${what}`, raw === null ? text({ files: undefined }) : text({ files: '@@' }).replace('"@@"', raw), TOO_NEW())
  }
  pay(P, 'pay-files-zero-entries-accepted', `${FI} ('an own array of 0 to 4,096 entries'): an empty array passes the payload's check (the apply script's presence is a later check of the import, section 4.4)`, text({ files: [] }), accepted({ files: [] }))
  for (const [slug, raw, what] of [['null', 'null', 'null'], ['string', '"apply.cmd"', 'a member name as a bare string'], ['number', '1', 'a number'], ['array', '["apply.cmd",4096,"' + HASH + '"]', 'an array of name, size and hash'], ['true', 'true', 'true']]) {
    pay(P, `pay-files-entry-${slug}`, `${FI} ('each an object'): a good entry, then ${what} as the second entry`, text({ files: [APPLY, '@@'] }).replace('"@@"', raw), TOO_NEW())
  }

  // ---- an entry's fields
  const entry = (id, why, raw, expect) => pay(P, id, why, text({ files: [APPLY, '@@'] }).replace('"@@"', raw), expect)
  const E1 = (fields) => '{' + Object.entries({ name: '"member.bin"', size: '1', sha256: `"${HASH}"`, ...fields }).filter(([, v]) => v !== null).map(([k, v]) => `"${k}":${v}`).join(',') + '}'
  const ok = (more = {}, size = 1) => accepted({ files: [APPLY_OUT, out('member.bin', size, more)] })
  const SZ = `${S43} 'files[] entries' ('an integer size from 0 to 8,589,934,591 (the value JSON.parse gives is a safe integer in that range ...)')`
  for (const [slug, raw, size] of [['0', '0', 0], ['largest', '8589934591', 8589934591], ['1-point-0', '1.0', 1], ['1e3', '1e3', 1000], ['8589934591-point-0', '8589934591.0', 8589934591]]) {
    entry(`pay-files-size-${slug}-accepted`, `${SZ}: size written ${raw}`, E1({ size: raw }), ok({}, size))
  }
  for (const [slug, raw, what] of [['missing', null, 'no size'], ['8-gib', '8589934592', '8,589,934,592 (8 GiB)'], ['minus-1', '-1', '-1'], ['1-point-5', '1.5', '1.5'], ['string', '"1"', 'the string "1"'], ['null', 'null', 'null'], ['1e400', '1e400', '1e400'], ['above-2-pow-53', '9007199254740993', '9007199254740993'], ['true', 'true', 'true'], ['array', '[1]', 'an array']]) {
    entry(`pay-files-size-${slug}`, `${SZ}; anything else from a known key -> UPD-TOO-NEW: size is ${what}`, E1({ size: raw }), TOO_NEW())
  }
  const SH = `${S43} 'files[] entries' ('a sha256 of 64 hex characters (either case; compared lower-cased)')`
  entry('pay-files-sha256-upper-case-accepted', `${SH} and section 2.10 ('sha256 lower-cased'): 64 upper-case hex characters`, E1({ sha256: `"${HASH.toUpperCase()}"` }), ok())
  entry('pay-files-sha256-mixed-case-accepted', `${SH} and section 2.10 ('sha256 lower-cased'): the first half in upper case`, E1({ sha256: `"${HASH.slice(0, 32).toUpperCase() + HASH.slice(32)}"` }), ok())
  for (const [slug, raw, what] of [['missing', null, 'no sha256'], ['63-characters', `"${HASH.slice(1)}"`, '63 hex characters'], ['65-characters', `"${HASH}0"`, '65 hex characters'], ['letter-g', `"g${HASH.slice(1)}"`, 'a g among 64 characters'], ['prefixed', `"sha256:${HASH}"`, 'the hash with a sha256: prefix'], ['base64', `"${Buffer.from(HASH, 'hex').toString('base64')}"`, 'the 32 bytes in base64 (44 characters)'], ['trailing-space', `"${HASH.slice(1)} "`, '63 hex characters and a space'], ['null', 'null', 'null'], ['number', '0', 'a number'], ['empty', '""', 'the empty string']]) {
    entry(`pay-files-sha256-${slug}`, `${SH}; anything else -> UPD-TOO-NEW: ${what}`, E1({ sha256: raw }), TOO_NEW())
  }
  const GP = `${S24} 'group'`
  for (const [slug, label] of [['label', 'win32'], ['one-space', ' '], ['non-ascii', 'gr\u{fc}n'], ['long', 'g'.repeat(300)]]) {
    entry(`pay-files-group-${slug}-accepted`, `${GP} ('A string of at least one character: the member's group, ... never interpreted'): group is ${slug === 'long' ? 'a string of 300 letters' : JSON.stringify(label)}`, E1({ group: JSON.stringify(label) }), ok({ group: label }))
  }
  for (const [slug, raw] of [['null', 'null'], ['empty', '""'], ['number', '1'], ['object', '{"name":"win32"}'], ['array', '["win32"]'], ['true', 'true'], ['false', 'false']]) {
    entry(`pay-files-group-${slug}`, `${GP} ('Anything else (null, "", a number, an object, an array, a boolean) -> UPD-TOO-NEW'): group is ${raw}`, E1({ group: raw }), TOO_NEW())
  }
  const IA = `${S24} 'install_as' ('never read at the import: any value, or none, never a refusal') and section 2.10 (installAs or null: the root name is install_as 'when that is a string')`
  entry('pay-files-install-as-string-accepted', `${IA}: a name with a space`, E1({ install_as: '"Start HilbertRaum.command"' }), ok({ installAs: 'Start HilbertRaum.command' }))
  entry('pay-files-install-as-empty-accepted', `${IA}: install_as is the empty string, which is a string, so installAs is ""`, E1({ install_as: '""' }), ok({ installAs: '' }))
  for (const [slug, raw] of [['number', '7'], ['null', 'null'], ['array', '["Start HilbertRaum.cmd"]'], ['object', '{"win32":"x"}'], ['true', 'true']]) {
    entry(`pay-files-install-as-${slug}-accepted`, `${IA}: install_as is ${raw}, so installAs is null`, E1({ install_as: raw }), ok())
  }
  for (const [slug, raw] of [['string', '"app"'], ['unknown-string', '"future-role"'], ['number', '3'], ['null', 'null'], ['object', '{"a":1}']]) {
    entry(`pay-files-role-${slug}-accepted`, `${S24} 'role' ('never read by release 1: any value, or none'): role is ${raw}`, E1({ role: raw }), ok())
  }
  entry('pay-files-entry-unknown-keys-accepted', `${S24} 'Reading' (unknown fields are ignored) for an entry: further keys, an own __proto__ key among them`, E1({ mode: '"0755"', mtime: '1799568000', ['__proto__']: '{"group":""}', Size: '"x"' }), ok())
  entry('pay-files-entry-duplicate-name-key-last-counts-accepted', `${S24} 'Reading' (the last of a duplicate key counts) for an entry: name twice, first a name that breaks the rule, last member.bin`, `{"name":"bad name","size":1,"sha256":"${HASH}","name":"member.bin"}`, ok())
  entry('pay-files-entry-fields-under-proto-key', `${S24} 'Reading' (only own keys count) for an entry: name, size and sha256 sit under a key __proto__`, `{"__proto__":${E1({})}}`, TOO_NEW())

  // ---- the member-name rule (section 4.4)
  const nameCase = (slug, name, clause, good) => entry(`pay-name-${slug}${good ? '-accepted' : ''}`, `${S44} ${clause}${good ? '' : " and 'A name that breaks the rule' ('in the signed payload -> UPD-TOO-NEW')"}: the name ${name.length > 40 ? `of ${name.length} bytes` : JSON.stringify(name)}`, `{"name":${JSON.stringify(name)},"size":1,"sha256":"${HASH}"}`, good ? accepted({ files: [APPLY_OUT, out(name)] }) : TOO_NEW())
  const CH = "'Characters' (ASCII [A-Za-z0-9._-] only)"
  const LE = "'Length' (1 to 99 bytes)"
  const FL = "'First and last character' (the first is [A-Za-z0-9]; the last is not a dot)"
  const RS = "'Reserved names' (compared case-folded: the Windows device names alone or before a dot; the envelope's name anywhere but member 0)"
  for (const [slug, name] of [['space', 'my file.txt'], ['plus', 'a+b.txt'], ['slash', 'dir/file.txt'], ['backslash', 'dir\\file.txt'], ['at', 'a@b.txt'], ['colon', 'a:b.txt'], ['tilde', 'a~1.txt'], ['asterisk', 'file*.txt'], ['comma', 'a,b.txt'], ['parentheses', 'file(1).txt'], ['e-acute', 'caf\u{e9}.txt'], ['fullwidth-letter', '\u{ff21}.txt'], ['line-feed', 'file.txt\n'], ['tab', 'a\tb'], ['nul', 'a\u{0}b'], ['percent', 'a%20b']]) nameCase(`character-${slug}`, name, CH, false)
  nameCase('empty', '', LE, false)
  nameCase('99-bytes', 'a'.repeat(95) + '.bin', LE, true)
  nameCase('100-bytes', 'a'.repeat(96) + '.bin', LE, false)
  for (const [slug, name] of [['first-dot', '.hidden'], ['first-hyphen', '-option'], ['first-underscore', '_internal'], ['last-dot', 'file.'], ['only-dot', '.'], ['two-dots', '..'], ['only-hyphen', '-']]) nameCase(slug, name, FL, false)
  for (const name of ['con', 'CON', 'Con.txt', 'prn', 'PRN.log', 'aux', 'Aux.tar.gz', 'nul', 'nul.txt', 'NUL.TXT', 'com0', 'com1', 'COM9.dat', 'lpt0', 'LPT1', 'lpt9.txt', 'hilbertraum-release.dsse.json', 'HilbertRaum-Release.DSSE.JSON']) nameCase('reserved-' + name.toLowerCase().replace(/\./g, '-') + (name === name.toLowerCase() ? '' : '-other-case'), name, RS, false)
  for (const [slug, name] of [['one-byte', 'a'], ['digit-first', '0start'], ['all-classes', 'A_b-c.d'], ['dots-inside', 'x..y'], ['last-hyphen', 'a-'], ['last-underscore', 'a_'], ['console', 'console'], ['con-hyphen', 'con-1.txt'], ['con-underscore', 'con_.txt'], ['com-without-digit', 'com'], ['com10', 'com10'], ['com1x', 'com1x.txt'], ['lpt-without-digit', 'lpt.txt'], ['lpt10', 'lpt10.txt'], ['nul-underscore', 'nul_'], ['auxiliary', 'auxiliary.txt'], ['prn1', 'prn1'], ['staged-json', 'staged.json'], ['staged-txt', 'staged.txt'], ['envelope-name-with-suffix', 'hilbertraum-release.dsse.json.sig'], ['envelope-name-with-prefix', 'x-hilbertraum-release.dsse.json']]) nameCase('legal-' + slug, name, slug.startsWith('staged') ? "'Reserved names' ('a member named staged.json is legal')" : slug.match(/^(con|com|lpt|nul|aux|prn|envelope)/) ? RS + ', which this name is not' : CH + ', ' + LE + ', ' + FL, true)
  for (const [slug, raw, what] of [['missing', null, 'no name'], ['null', 'null', 'null'], ['number', '7', 'a number'], ['array', '["member.bin"]', 'an array holding a name']]) {
    entry(`pay-name-${slug}`, `${S43} 'files[] entries' ('a string name'): ${what}`, E1({ name: raw }), TOO_NEW())
  }
  const UQ = `${S44} 'Uniqueness' ('no two names equal after folding A-Z to a-z')`
  const two = (a, b) => text({ files: [{ name: a, size: 1, sha256: HASH }, { name: b, size: 1, sha256: HASH }] })
  pay(P, 'pay-name-unique-same-name-twice', `${UQ}: Readme.txt twice`, two('Readme.txt', 'Readme.txt'), TOO_NEW())
  pay(P, 'pay-name-unique-case-differs', `${UQ}: Readme.txt and README.TXT`, two('Readme.txt', 'README.TXT'), TOO_NEW())
  pay(P, 'pay-name-unique-one-letter-case', `${UQ}: apply.cmd and Apply.cmd`, two('apply.cmd', 'Apply.cmd'), TOO_NEW())
  pay(P, 'pay-name-unique-near-names-accepted', `${UQ}: a.txt, a.txt2 and a-txt differ after folding; the same sha256 and size for all three is no clash`, text({ files: ['a.txt', 'a.txt2', 'a-txt'].map((name) => ({ name, size: 1, sha256: HASH })) }), accepted({ files: [out('a.txt'), out('a.txt2'), out('a-txt')] }))
  pay(P, 'pay-files-order-kept-accepted', `app-updates.md section 2.10 ('its files[] entries in payload order'): four entries that are not in name order`, text({ files: ['zeta', 'Alpha', 'mid', '0first'].map((name, i) => ({ name, size: i, sha256: HASH })) }), accepted({ files: [out('zeta', 0), out('Alpha', 1), out('mid', 2), out('0first', 3)] }))
}

// ================================================================================================================
// vectors-order.json: section 4.5's order of an import, two failing checks with different codes, the earlier deciding;
// and the address set's runningVersion (section 2.10)
// ================================================================================================================
{
  const O = 'order'
  const text = (over = {}) => JSON.stringify(BASE(over))
  const ORD = `${S45} 'Order of an import' and section 10.7 'Two failing checks'`
  const junk65 = Array.from({ length: 65 }, () => ({ sig: 'AAAA' }))
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])

  // ---- inside the envelope (section 2.3's table order)
  let s = setup()
  vec(O, 'order-empty-key-set-before-size', `${ORD} (section 2.3: 'The key set' before 'Size'): an empty key set and 4,194,305 bytes -> UPD-NOT-AVAILABLE, not UPD-TOO-NEW`, [], { parts: [{ repeat: 'x', times: 4194305 }] }, refuse('envelope', 'UPD-NOT-AVAILABLE'))
  vec(O, 'order-empty-key-set-before-text', `${ORD} (section 2.3: 'The key set' before 'Text'): an empty key set and a byte-order mark -> UPD-NOT-AVAILABLE, not UPD-FILE-DAMAGED`, [], Buffer.concat([BOM, utf8(envJson(s))]), refuse('envelope', 'UPD-NOT-AVAILABLE'))
  vec(O, 'order-empty-key-set-before-signer', `${ORD} (section 2.3: 'The key set' before 'No signature verifies'): an empty key set and an envelope without signatures -> UPD-NOT-AVAILABLE, not UPD-UNKNOWN-SIGNER`, [], envJson(s, { signatures: [] }), refuse('envelope', 'UPD-NOT-AVAILABLE'))
  vec(O, 'order-size-before-text', `${ORD} (section 2.3: 'Size' before 'Text'): a byte-order mark, then spaces up to 4,194,305 bytes -> UPD-TOO-NEW, not UPD-FILE-DAMAGED`, [s.key.spki], { parts: [{ base64: BOM.toString('base64') }, { repeat: ' ', times: 4194302 }] }, TOO_NEW_ENV())
  vec(O, 'order-size-before-json', `${ORD} (section 2.3: 'Size' before 'JSON', 'before the parse'): 4,194,305 letters x -> UPD-TOO-NEW, not UPD-FILE-DAMAGED`, [s.key.spki], { parts: [{ repeat: 'x', times: 4194305 }] }, TOO_NEW_ENV())
  vec(O, 'order-signature-cap-before-type', `${ORD} (section 2.3: 'signatures' before 'payloadType'): 65 signature entries and no payloadType -> UPD-TOO-NEW, not UPD-FILE-DAMAGED`, [s.key.spki], envJson(s, { signatures: junk65, payloadType: undefined }), TOO_NEW_ENV())
  vec(O, 'order-signature-cap-before-payload', `${ORD} (section 2.3: 'signatures' before 'payload'): 65 signature entries and a payload that is no base64 -> UPD-TOO-NEW, not UPD-FILE-DAMAGED`, [s.key.spki], envJson(s, { signatures: junk65, payload: 'not base64!' }), TOO_NEW_ENV())
  vec(O, 'order-signature-cap-before-signer', `${ORD} (section 2.3: 'signatures' before 'No signature verifies'): 65 entries that verify nothing and name no key -> UPD-TOO-NEW, not UPD-UNKNOWN-SIGNER`, [s.key.spki], envJson(s, { signatures: junk65 }), TOO_NEW_ENV())
  vec(O, 'order-type-form-before-signer', `${ORD} (section 2.3: 'payloadType' before 'No signature verifies'): a payloadType that is a number and no signature -> UPD-FILE-DAMAGED, not UPD-UNKNOWN-SIGNER`, [s.key.spki], envJson(s, { payloadType: 7, signatures: [] }), DAMAGED())
  vec(O, 'order-payload-form-before-signer', `${ORD} (section 2.3: 'payload' before 'No signature verifies'): a payload whose length is no multiple of 4 and a signature by an unknown key -> UPD-FILE-DAMAGED, not UPD-UNKNOWN-SIGNER`, [newKey().spki], envJson(s, { payload: s.b64.replace(/=+$/, '') + (s.b64.endsWith('=') ? '' : 'A') }), DAMAGED())
  vec(O, 'order-payload-form-before-not-genuine', `${ORD} (section 2.3: 'payload' before 'No signature verifies'): a payload with a space inside and an entry that names the embedded key -> UPD-FILE-DAMAGED, not UPD-NOT-GENUINE`, [s.key.spki], envJson(s, { payload: s.b64.slice(0, 4) + ' ' + s.b64.slice(4) }), DAMAGED())
  let st = setup(BASE(), 'application/json')
  vec(O, 'order-signer-before-type-foreign', `${ORD} (section 2.3: 'No signature verifies' before 'A verified envelope's type'): application/json signed by an unknown key -> UPD-UNKNOWN-SIGNER, not UPD-NOT-AN-UPDATE`, [newKey().spki], envJson(st), UNKNOWN())
  let k = newKey()
  vec(O, 'order-not-genuine-before-type-foreign', `${ORD} (section 2.3: 'No signature verifies' before 'A verified envelope's type'): application/json, an entry naming the embedded key that does not verify -> UPD-NOT-GENUINE, not UPD-NOT-AN-UPDATE`, [k.spki], envJson(st, { signatures: [{ keyid: k.id, sig: st.sigB64 }] }), NOT_GENUINE())
  st = setup(BASE(), 'application/vnd.hilbertraum.models+json')
  vec(O, 'order-not-genuine-before-type-hilbertraum', `${ORD} (section 2.3: 'No signature verifies' before 'A verified envelope's type'): the models type, an entry naming the embedded key that does not verify -> UPD-NOT-GENUINE, not UPD-FOR-NEWER-HILBERTRAUM`, [k.spki], envJson(st, { signatures: [{ keyid: k.id, sig: st.sigB64 }] }), NOT_GENUINE())
  // ---- the envelope before the payload
  s = setup(BASE({ format: 2 }))
  vec(O, 'order-not-genuine-before-format', `${ORD} (member 0's verification before the payload): a payload of format 2 whose signature names the embedded key and is by another -> UPD-NOT-GENUINE, not UPD-TOO-NEW`, [k.spki], envJson(s, { signatures: [{ keyid: k.id, sig: s.sigB64 }] }), NOT_GENUINE())
  st = setup(BASE({ format: 2 }), 'application/json')
  vec(O, 'order-type-foreign-before-format', `${ORD} (the payloadType last in member 0's verification, before the payload): application/json from the embedded key with a payload of format 2 -> UPD-NOT-AN-UPDATE, not UPD-TOO-NEW`, [st.key.spki], envJson(st), refuse('envelope', 'UPD-NOT-AN-UPDATE'))
  st = setup(BASE({ product: 'otherproduct' }), 'application/vnd.hilbertraum.models+json')
  vec(O, 'order-type-hilbertraum-before-product', `${ORD} (the payloadType before the payload): the models type from the embedded key with another product in its payload -> UPD-FOR-NEWER-HILBERTRAUM, not UPD-NOT-AN-UPDATE`, [st.key.spki], envJson(st), refuse('envelope', 'UPD-FOR-NEWER-HILBERTRAUM', RV))

  // ---- inside the payload
  const exeOld = { name: 'HilbertRaum-1.0.0-portable.exe', kind: 'file', system: 'win32', version: '1.0.0' }
  const STALE = { driveAppVersion: '1.2.0', rootApps: [exeOld] } // 1.2.0 is carried by no root app: stale
  const same = (version = '1.0.0', driveVersion = null, flags = {}) => refuse('version-rule', 'UPD-SAME-OR-OLDER', { version, runningVersion: '1.0.0', driveVersion }, flags)
  const needs = refuse('payload', 'UPD-NEEDS-IN-BETWEEN', { runningVersion: '1.0.0', minUpgradeFrom: '1.0.5' })
  const above = (version, maxVersion, flags = {}) => refuse('payload', 'UPD-ABOVE-MAX-VERSION', { version, maxVersion }, flags)
  const cant = (flags = {}) => refuse('payload', 'UPD-CANT-CHECK-LINUX-FLOOR', RV, flags)
  const tooOld = (flags = {}) => refuse('payload', 'UPD-OS-TOO-OLD', { runningVersion: '1.0.0', system: 'win32', floor: '11.0', hostVersion: '10.0.26300' }, flags)
  const pairs = [
    ['format-before-product', 'format 2 and another product', { format: 2, product: 'otherproduct' }, TOO_NEW(), {}, 'UPD-TOO-NEW, not UPD-NOT-AN-UPDATE'],
    ['format-before-kind', 'format 2 and kind models', { format: 2, kind: 'models' }, TOO_NEW(), {}, 'UPD-TOO-NEW, not UPD-FOR-NEWER-HILBERTRAUM'],
    ['format-before-channel', 'no format and channel beta', { format: undefined, channel: 'beta' }, TOO_NEW(), {}, 'UPD-TOO-NEW, not UPD-WRONG-CHANNEL'],
    ['product-before-kind', "another product and kind models (T4.0's one change to the order: product before kind)", { product: 'otherproduct', kind: 'models' }, refuse('payload', 'UPD-NOT-AN-UPDATE'), {}, 'UPD-NOT-AN-UPDATE, not UPD-FOR-NEWER-HILBERTRAUM'],
    ['product-before-channel', 'no product and channel beta', { product: undefined, channel: 'beta' }, refuse('payload', 'UPD-NOT-AN-UPDATE'), {}, 'UPD-NOT-AN-UPDATE, not UPD-WRONG-CHANNEL'],
    ['product-before-version', 'another product and no version', { product: 'otherproduct', version: undefined }, refuse('payload', 'UPD-NOT-AN-UPDATE'), {}, 'UPD-NOT-AN-UPDATE, not UPD-TOO-NEW'],
    ['kind-before-channel', 'kind models and channel beta', { kind: 'models', channel: 'beta' }, refuse('payload', 'UPD-FOR-NEWER-HILBERTRAUM', RV), {}, 'UPD-FOR-NEWER-HILBERTRAUM, not UPD-WRONG-CHANNEL'],
    ['kind-before-version-and-files', 'kind models with no version and no files, as a file of another kind may be', { kind: 'models', version: undefined, files: undefined }, refuse('payload', 'UPD-FOR-NEWER-HILBERTRAUM', RV), {}, 'UPD-FOR-NEWER-HILBERTRAUM, not UPD-TOO-NEW'],
    ['kind-before-version-rule', 'kind models and the running version', { kind: 'models', version: '1.0.0' }, refuse('payload', 'UPD-FOR-NEWER-HILBERTRAUM', RV), {}, 'UPD-FOR-NEWER-HILBERTRAUM, not UPD-SAME-OR-OLDER'],
    ['channel-before-version', 'channel beta and a version that is no SemVer', { channel: 'beta', version: '1.1' }, refuse('payload', 'UPD-WRONG-CHANNEL'), {}, 'UPD-WRONG-CHANNEL, not UPD-TOO-NEW'],
    ['channel-before-min', 'channel beta and min_upgrade_from above the running version', { channel: 'beta', min_upgrade_from: '1.0.5' }, refuse('payload', 'UPD-WRONG-CHANNEL'), {}, 'UPD-WRONG-CHANNEL, not UPD-NEEDS-IN-BETWEEN'],
    ['channel-before-version-rule', 'channel beta and the running version', { channel: 'beta', version: '1.0.0' }, refuse('payload', 'UPD-WRONG-CHANNEL'), {}, 'UPD-WRONG-CHANNEL, not UPD-SAME-OR-OLDER'],
    ['version-form-before-min', 'a version that is no SemVer and min_upgrade_from above the running version', { version: '1.1', min_upgrade_from: '1.0.5' }, TOO_NEW(), {}, 'UPD-TOO-NEW, not UPD-NEEDS-IN-BETWEEN'],
    ['min-before-version-rule', 'min_upgrade_from above the running version, and the running version itself as version', { version: '1.0.0', min_upgrade_from: '1.0.5' }, needs, {}, 'UPD-NEEDS-IN-BETWEEN, not UPD-SAME-OR-OLDER'],
    ['min-form-before-version-rule', 'min_upgrade_from null and the running version as version', { version: '1.0.0', min_upgrade_from: null }, TOO_NEW(), {}, 'UPD-TOO-NEW, not UPD-SAME-OR-OLDER'],
    ['min-before-cap', 'min_upgrade_from above the running version and a version above the cap 1.0.5', { min_upgrade_from: '1.0.5' }, needs, { maxVersion: '1.0.5' }, 'UPD-NEEDS-IN-BETWEEN, not UPD-ABOVE-MAX-VERSION'],
    ['version-rule-before-cap', 'version 0.9.0 is below the running 1.0.0 and above the cap 0.8.0', { version: '0.9.0' }, same('0.9.0'), { maxVersion: '0.8.0' }, 'UPD-SAME-OR-OLDER, not UPD-ABOVE-MAX-VERSION'],
    ['version-rule-before-requires', 'the running version as version and a requires that is an array', { version: '1.0.0', requires: ['10.0'] }, same(), {}, 'UPD-SAME-OR-OLDER, not UPD-TOO-NEW'],
    ['version-rule-before-linux-floor', 'the running version as version and a linux floor that breaks the grammar', { version: '1.0.0', requires: { linux: '2.x' } }, same(), {}, 'UPD-SAME-OR-OLDER, not UPD-CANT-CHECK-LINUX-FLOOR'],
    ['version-rule-before-own-floor', 'the running version as version and a win32 floor above the host', { version: '1.0.0', requires: { win32: '11.0' } }, same(), {}, 'UPD-SAME-OR-OLDER, not UPD-OS-TOO-OLD'],
    ['version-rule-before-files', 'a version below the drive (carried 1.2.0) and no files', { version: '1.1.0', files: undefined }, refuse('version-rule', 'UPD-SAME-OR-OLDER', { version: '1.1.0', runningVersion: '1.0.0', driveVersion: '1.2.0' }), { driveAppVersion: '1.2.0', rootApps: [{ name: 'HilbertRaum-1.2.0-portable.exe', kind: 'file', system: 'win32', version: '1.2.0' }] }, 'UPD-SAME-OR-OLDER, not UPD-TOO-NEW'],
    ['cap-before-requires', 'a version above the cap and a requires that is null', { requires: null }, above('1.1.0', '1.0.5'), { maxVersion: '1.0.5' }, 'UPD-ABOVE-MAX-VERSION, not UPD-TOO-NEW'],
    ['cap-before-linux-floor', 'a version above the cap and a linux floor that breaks the grammar', { requires: { linux: '2.x' } }, above('1.1.0', '1.0.5'), { maxVersion: '1.0.5' }, 'UPD-ABOVE-MAX-VERSION, not UPD-CANT-CHECK-LINUX-FLOOR'],
    ['cap-before-own-floor', 'a version above the cap and a win32 floor above the host', { requires: { win32: '11.0' } }, above('1.1.0', '1.0.5'), { maxVersion: '1.0.5' }, 'UPD-ABOVE-MAX-VERSION, not UPD-OS-TOO-OLD'],
    ['linux-form-before-win32-form', 'a linux floor and a win32 floor that both break the grammar (the linux value first)', { requires: { win32: '10.x', linux: '2.x' } }, cant(), {}, 'UPD-CANT-CHECK-LINUX-FLOOR, not UPD-TOO-NEW'],
    ['linux-form-before-darwin-form', 'a linux floor and a darwin floor that both break the grammar', { requires: { darwin: '13.x', linux: '2.x' } }, cant(), {}, 'UPD-CANT-CHECK-LINUX-FLOOR, not UPD-TOO-NEW'],
    ['linux-form-before-own-floor', 'a linux floor that breaks the grammar and a win32 floor above the Windows host', { requires: { win32: '11.0', linux: '2.x' } }, cant(), {}, 'UPD-CANT-CHECK-LINUX-FLOOR, not UPD-OS-TOO-OLD'],
    ['darwin-form-before-own-floor', "a darwin floor that breaks the grammar and a win32 floor above the Windows host (the forms 'before this system's floor')", { requires: { win32: '11.0', darwin: '13.x' } }, TOO_NEW(), {}, 'UPD-TOO-NEW, not UPD-OS-TOO-OLD'],
    ['linux-form-before-files', 'a linux floor that breaks the grammar and no files', { requires: { linux: '2.x' }, files: undefined }, cant(), {}, 'UPD-CANT-CHECK-LINUX-FLOOR, not UPD-TOO-NEW'],
    ['own-floor-before-files', 'a win32 floor above the host and no files', { requires: { win32: '11.0' }, files: undefined }, tooOld(), {}, 'UPD-OS-TOO-OLD, not UPD-TOO-NEW'],
    ['own-floor-before-file-name', 'a win32 floor above the host and a member name with a space', { requires: { win32: '11.0' }, files: [{ name: 'my file', size: 1, sha256: H('x') }] }, tooOld(), {}, 'UPD-OS-TOO-OLD, not UPD-TOO-NEW']
  ]
  for (const [slug, what, over, expect, host, codes] of pairs) pay(O, `order-${slug}`, `${ORD} (format -> product -> kind -> channel -> version -> min_upgrade_from -> the version rule -> the cap -> requires (linux form, win32 and darwin forms, this system's floor) -> issued -> files[]): ${what} -> ${codes}`, text(over), expect, host)
  pay(O, 'order-win32-form-before-host-glibc', `${ORD} (section 2.4 'A floor that breaks it': 'Checked in this order, before this system's floor: linux, win32, darwin'): a Linux host without a readable glibc, a linux floor 2.34 in the grammar and a win32 floor 11.x that breaks it -> UPD-TOO-NEW, not UPD-CANT-CHECK-LINUX-FLOOR`, text({ requires: { linux: '2.34', win32: '11.x' } }), TOO_NEW(), { ...LINUX, glibc: null })
  pay(O, 'order-host-glibc-before-files', `${ORD} (requires before files[]): a Linux host without a readable glibc, a linux floor, and no files -> UPD-CANT-CHECK-LINUX-FLOOR, not UPD-TOO-NEW`, text({ requires: { linux: '2.34' }, files: undefined }), cant(), { ...LINUX, glibc: null })

  // ---- staleDriveVersion: set with every verdict from the version rule on, never before it (section 2.10 'The flags')
  const FLG = `app-updates.md section 2.10 'The flags' ('staleDriveVersion is set with every verdict from the version rule on, accepted or refused') and section 2.5 'Which app_version counts'`
  const stale = { staleDriveVersion: true }
  pay(O, 'order-stale-flag-accepted', `${FLG}: the drive's 1.2.0 is carried by no root app (the root holds the 1.0.0 app), so 1.1.0 is accepted with the flag`, text(), accepted({}, stale), STALE)
  pay(O, 'order-stale-flag-with-same-or-older', `${FLG} and section 2.10 (driveVersion 'null when none counted, a stale one included'): a stale 1.2.0 and the running version as version`, text({ version: '1.0.0' }), same('1.0.0', null, stale), STALE)
  pay(O, 'order-stale-flag-with-cap', `${FLG}: a stale 1.2.0 and a version above the cap -> UPD-ABOVE-MAX-VERSION with the flag`, text(), above('1.1.0', '1.0.5', stale), { ...STALE, maxVersion: '1.0.5' })
  pay(O, 'order-stale-flag-with-linux-floor', `${FLG}: a stale 1.2.0 and a linux floor that breaks the grammar -> UPD-CANT-CHECK-LINUX-FLOOR with the flag`, text({ requires: { linux: '2.x' } }), cant(stale), STALE)
  pay(O, 'order-stale-flag-with-own-floor', `${FLG}: a stale 1.2.0 and a win32 floor above the host -> UPD-OS-TOO-OLD with the flag`, text({ requires: { win32: '11.0' } }), tooOld(stale), STALE)
  pay(O, 'order-stale-flag-with-files', `${FLG}: a stale 1.2.0 and no files -> UPD-TOO-NEW with the flag`, text({ files: undefined }), refuse('payload', 'UPD-TOO-NEW', RV, stale), STALE)
  pay(O, 'order-stale-flag-not-before-version-rule-channel', `${FLG}: a stale 1.2.0 and channel beta: the refusal comes before the version rule, so the flag is false`, text({ channel: 'beta' }), refuse('payload', 'UPD-WRONG-CHANNEL'), STALE)
  pay(O, 'order-stale-flag-not-before-version-rule-min', `${FLG}: a stale 1.2.0 and min_upgrade_from above the running version: the refusal comes before the version rule, so the flag is false`, text({ min_upgrade_from: '1.0.5' }), needs, STALE)

  // ---- the address set: each of the six codes carries the running version, as the app wrote it (section 2.10)
  const AD = `app-updates.md section 2.10 'The address set' (each of the six codes carries the running version, the text exactly as written) with running version 1.4.2-rc.1`
  const run = '1.4.2-rc.1'
  const rv = { runningVersion: run }
  const host = { runningVersion: run }
  const p2 = (over = {}) => text({ version: '1.5.0', ...over })
  pay(O, 'address-too-new-payload', `${AD}: UPD-TOO-NEW from the payload (format 2)`, p2({ format: 2 }), refuse('payload', 'UPD-TOO-NEW', rv), host)
  s = setup(p2())
  vec(O, 'address-too-new-envelope', `${AD}: UPD-TOO-NEW from the envelope (65 signatures)`, [s.key.spki], envJson(s, { signatures: junk65 }), refuse('envelope', 'UPD-TOO-NEW', rv), host)
  vec(O, 'address-unknown-signer', `${AD}: UPD-UNKNOWN-SIGNER`, [newKey().spki], envJson(s), refuse('envelope', 'UPD-UNKNOWN-SIGNER', rv), host)
  st = setup(p2(), 'application/vnd.hilbertraum.models+json')
  vec(O, 'address-for-newer-hilbertraum-type', `${AD}: UPD-FOR-NEWER-HILBERTRAUM from the payloadType`, [st.key.spki], envJson(st), refuse('envelope', 'UPD-FOR-NEWER-HILBERTRAUM', rv), host)
  pay(O, 'address-for-newer-hilbertraum-kind', `${AD}: UPD-FOR-NEWER-HILBERTRAUM from the payload's kind`, p2({ kind: 'models' }), refuse('payload', 'UPD-FOR-NEWER-HILBERTRAUM', rv), host)
  pay(O, 'address-needs-in-between', `${AD}: UPD-NEEDS-IN-BETWEEN (min_upgrade_from 1.4.2, the release of the running pre-release), with minUpgradeFrom as written`, p2({ min_upgrade_from: '1.4.2' }), refuse('payload', 'UPD-NEEDS-IN-BETWEEN', { runningVersion: run, minUpgradeFrom: '1.4.2' }), host)
  pay(O, 'address-os-too-old', `${AD}: UPD-OS-TOO-OLD on macOS, with system, floor and hostVersion as written`, p2({ requires: { darwin: '16.0' } }), refuse('payload', 'UPD-OS-TOO-OLD', { runningVersion: run, system: 'darwin', floor: '16.0', hostVersion: '15.1.0' }), { ...host, ...MAC })
  pay(O, 'address-cant-check-linux-floor', `${AD}: UPD-CANT-CHECK-LINUX-FLOOR on Linux without a readable glibc`, p2({ requires: { linux: '2.34' } }), refuse('payload', 'UPD-CANT-CHECK-LINUX-FLOOR', rv), { ...host, ...LINUX, glibc: null })
}

// ================================================================================================================
// vectors-version-rule.json: section 2.5, the version rule alone (section 10.7's second vector form)
// ================================================================================================================
{
  const V = 'version-rule'
  const exe = (v) => ({ name: `HilbertRaum-${v}-portable.exe`, kind: 'file', system: 'win32', version: v })
  const zip = (v) => ({ name: `HilbertRaum-${v}-mac-arm64.app.zip`, kind: 'file', system: 'darwin', version: v })
  const appImage = (v) => ({ name: `HilbertRaum-${v}.AppImage`, kind: 'file', system: 'linux', version: v })
  const appFolder = { name: 'HilbertRaum.app', kind: 'folder', system: 'darwin', version: null }
  const junkExe = { name: 'HilbertRaum-junk-portable.exe', kind: 'file', system: 'win32', version: null }
  /** `drive`: the app_version that counted, or null; `stale`: the flag. `ok` false is UPD-SAME-OR-OLDER. */
  function rule(id, why, version, runningVersion, driveAppVersion, rootApps, ok, drive = null, stale = false) {
    const flags = FLAGS({ staleDriveVersion: stale })
    const expect = ok ? { stage: 'version-rule', code: 'accepted', params: {}, flags } : { stage: 'version-rule', code: 'UPD-SAME-OR-OLDER', params: { version, runningVersion, driveVersion: drive }, flags }
    add(V, { id, why, version, host: { runningVersion, driveAppVersion, rootApps }, expect })
  }
  const AN = `${S25} 'The answer' ('accepted when version is above the running version ...; else UPD-SAME-OR-OLDER')`
  const OR = `${S25} 'Order' (SemVer 2.0.0 precedence)`
  const WC = `${S25} 'Which app_version counts'`

  // ---- against the running version alone (no drive version)
  const plain = [
    ['above-patch', '1.0.1', '1.0.0', true, AN, 'a patch above'], ['above-minor', '1.1.0', '1.0.0', true, AN, 'a minor above'], ['above-major', '2.0.0', '1.9.9', true, AN, 'a major above'],
    ['equal', '1.0.0', '1.0.0', false, AN, 'the same version is not above'], ['below-patch', '1.0.0', '1.0.1', false, AN, 'a patch below'], ['below-major', '1.9.9', '2.0.0', false, AN, 'a major below'],
    ['numbers-not-text-minor', '1.10.0', '1.9.0', true, OR, '1.10.0 is above 1.9.0 (as text it would be below)'], ['numbers-not-text-minor-reverse', '1.9.0', '1.10.0', false, OR, '1.9.0 is below 1.10.0'],
    ['numbers-beyond-2-pow-53', '1.0.9007199254740993', '1.0.9007199254740992', true, OR, 'patch 9007199254740993 is above 9007199254740992 (digit strings, never doubles)'], ['numbers-beyond-2-pow-53-equal', '1.0.9007199254740992', '1.0.9007199254740992', false, OR, 'the same patch beyond 2^53 is equal'],
    ['release-above-its-pre-release', '0.2.0', '0.2.0-rc.1', true, OR, "'0.2.0-rc.1 is below 0.2.0'"], ['pre-release-below-its-release', '0.2.0-rc.1', '0.2.0', false, OR, 'a pre-release of the running release is below it'],
    ['pre-release-of-next-above', '1.1.0-rc.1', '1.0.0', true, OR, '1.1.0-rc.1 is above 1.0.0'],
    ['pre-release-numeric-identifiers', '1.0.0-rc.10', '1.0.0-rc.9', true, OR, 'rc.10 is above rc.9 (numeric identifiers as numbers, semver.org 11.4.1)'], ['pre-release-numeric-identifiers-reverse', '1.0.0-rc.9', '1.0.0-rc.10', false, OR, 'rc.9 is below rc.10'],
    ['pre-release-alphabetic', '1.0.0-beta', '1.0.0-alpha', true, OR, 'beta is above alpha (ASCII order, semver.org 11.4.2)'],
    ['pre-release-numeric-below-alphanumeric', '1.0.0-alpha', '1.0.0-1', true, OR, 'a numeric identifier is below an alphanumeric one (semver.org 11.4.3)'], ['pre-release-numeric-below-alphanumeric-reverse', '1.0.0-999', '1.0.0-a', false, OR, '999 is below a'],
    ['pre-release-longer-set-above', '1.0.0-alpha.1', '1.0.0-alpha', true, OR, 'the longer set is above when the shared identifiers are equal (semver.org 11.4.4)'], ['pre-release-shorter-set-below', '1.0.0-alpha', '1.0.0-alpha.1', false, OR, 'the shorter set is below'],
    ['pre-release-case-ascii-order', '1.0.0-rc1', '1.0.0-RC1', true, OR, "rc1 is above RC1 in ASCII order (section 2.4 'Later writers: version': SemVer orders RC1 below rc1)"], ['pre-release-case-ascii-order-reverse', '1.0.0-RC1', '1.0.0-rc1', false, OR, 'RC1 is below rc1'],
    ['pre-release-equal', '1.0.0-rc.1', '1.0.0-rc.1', false, OR, 'the same pre-release is not above'],
    ['build-metadata-equal', '1.1.0+b', '1.1.0+a', false, OR, "'build metadata no part (1.1.0+a equals 1.1.0+b)'"], ['build-metadata-only-on-candidate', '1.1.0+build.5', '1.1.0', false, OR, '1.1.0+build.5 equals the running 1.1.0'],
    ['build-metadata-above', '1.1.1+build.1', '1.1.0+build.9', true, OR, 'the patch decides, the build metadata takes no part'],
    ['running-build-metadata-equal', '1.0.0', '1.0.0+local', false, `${OR} and section 2.10 'The parameters' (the text as written, never normalised)`, '1.0.0 equals the running 1.0.0+local (build metadata no part) and is not above it; runningVersion keeps +local'],
    ['running-build-metadata-above', '1.0.1', '1.0.0+local', true, OR, '1.0.1 is above the running 1.0.0+local'],
    ['key-proof-version', '0.0.0-keyproof.1', '0.1.66', false, `${AN} and section 2.8 (the key proof's throw-away files must read 'same or older')`, '0.0.0-keyproof.1 is below every build']
  ]
  for (const [slug, version, running, ok, row, what] of plain) rule(`ver-${slug}${ok ? '-accepted' : ''}`, `${row}: ${what}; no drive version`, version, running, null, [], ok)
  rule('ver-no-drive-version-root-not-listed-accepted', `${S25} 'Which app_version counts' ('null: none'): no drive version and a root that could not be listed`, '1.1.0', '1.0.0', null, null, true)
  rule('ver-no-drive-version-higher-apps-at-root-accepted', `${S25} 'Which app_version counts' ('null: none'): no drive version; apps of 2.0.0 at the root are no floor by themselves`, '1.1.0', '1.0.0', null, [exe('2.0.0'), appImage('2.0.0')], true)

  // ---- a drive version that counts
  const NB = `${S25} 'The answer' ('where an app_version counts, not below it (equal passes)')`
  rule('ver-drive-carried-below-drive', `${NB} and ${WC.slice(S25.length + 1)} ('a root app's carried version equals it byte for byte'): 1.1.0 is above the running 1.0.0 and below the drive's carried 1.2.0`, '1.1.0', '1.0.0', '1.2.0', [exe('1.2.0')], false, '1.2.0')
  rule('ver-drive-carried-equal-drive-accepted', `${NB}: the drive's own version installs on a lagging system (running 1.0.0, drive 1.2.0, candidate 1.2.0)`, '1.2.0', '1.0.0', '1.2.0', [exe('1.2.0')], true)
  rule('ver-drive-carried-above-drive-accepted', `${NB}: 1.3.0 is above the running 1.0.0 and the drive's 1.2.0`, '1.3.0', '1.0.0', '1.2.0', [exe('1.2.0')], true)
  rule('ver-drive-carried-pre-release-of-drive', `${NB} and 'Order': 1.2.0-rc.1 is below the drive's 1.2.0`, '1.2.0-rc.1', '1.0.0', '1.2.0', [exe('1.2.0')], false, '1.2.0')
  rule('ver-drive-carried-build-metadata-equal-accepted', `${NB} and 'Order' (build metadata no part): 1.2.0+fix equals the drive's 1.2.0 in order and is not below it`, '1.2.0+fix', '1.0.0', '1.2.0', [exe('1.2.0')], true)
  rule('ver-drive-below-running-candidate-between', `${S25} 'The answer' ('both halves alike') and section 2.10 (driveVersion: 'the app_version that counted'): running 1.5.0, drive 1.2.0 (carried), candidate 1.3.0 is not above the running version`, '1.3.0', '1.5.0', '1.2.0', [exe('1.2.0')], false, '1.2.0')
  rule('ver-drive-below-running-candidate-above-accepted', `${S25} 'The answer': running 1.5.0, drive 1.2.0 (carried), candidate 1.6.0`, '1.6.0', '1.5.0', '1.2.0', [exe('1.2.0')], true)
  rule('ver-drive-equal-running-and-candidate', `${S25} 'The answer': the candidate equals the running version and the drive's carried version; not above the running version`, '1.2.0', '1.2.0', '1.2.0', [exe('1.2.0')], false, '1.2.0')
  rule('ver-drive-carried-by-mac-zip', `${WC} (section 4.4: HilbertRaum-V-mac-arm64.app.zip carries V): the macOS archive carries the drive's 1.2.0`, '1.1.0', '1.0.0', '1.2.0', [zip('1.2.0')], false, '1.2.0')
  rule('ver-drive-carried-by-appimage', `${WC} (section 4.4: HilbertRaum-V.AppImage carries V): the AppImage carries the drive's 1.2.0`, '1.1.0', '1.0.0', '1.2.0', [appImage('1.2.0')], false, '1.2.0')
  rule('ver-drive-carried-by-one-of-three', `${WC} ('a root app's carried version equals it'): three apps, only the AppImage carries the drive's 1.2.0 (the others lag at 1.0.0)`, '1.1.0', '1.0.0', '1.2.0', [exe('1.0.0'), zip('1.0.0'), appImage('1.2.0')], false, '1.2.0')
  rule('ver-drive-app-folder-counts', `${WC} ('when a root *.app folder exists (a root app of kind folder)'): only a .app folder at the root, whose version is unknown, keeps the drive's 1.2.0`, '1.1.0', '1.0.0', '1.2.0', [appFolder], false, '1.2.0')
  rule('ver-drive-app-folder-beside-other-version', `${WC} ('a root *.app folder exists'): a .app folder beside an exe of 1.0.0 keeps the drive's 1.2.0`, '1.1.0', '1.0.0', '1.2.0', [exe('1.0.0'), appFolder], false, '1.2.0')
  rule('ver-drive-app-folder-equal-accepted', `${WC} and 'The answer' (equal passes): a .app folder keeps the drive's 1.2.0 and the candidate is 1.2.0`, '1.2.0', '1.0.0', '1.2.0', [appFolder], true)
  rule('ver-drive-root-not-listed', `${WC} ('when the root could not be listed (without the evidence the floor stays ...)'): rootApps is null, the drive's 1.2.0 counts`, '1.1.0', '1.0.0', '1.2.0', null, false, '1.2.0')
  rule('ver-drive-root-not-listed-equal-accepted', `${WC} (the root could not be listed) and 'The answer' (equal passes): rootApps is null, candidate 1.2.0`, '1.2.0', '1.0.0', '1.2.0', null, true)

  // ---- a stale drive version
  const ST = `${WC} ('Otherwise it is stale: treated as absent, with the flag staleDriveVersion')`
  rule('ver-stale-other-version-at-root-accepted', `${ST}: the drive says 1.2.0, the root holds only the 1.0.0 app; 1.1.0 is accepted with the flag`, '1.1.0', '1.0.0', '1.2.0', [exe('1.0.0')], true, null, true)
  rule('ver-stale-empty-root-accepted', `${ST}: the drive says 1.2.0 and the root holds no app`, '1.1.0', '1.0.0', '1.2.0', [], true, null, true)
  rule('ver-stale-null-version-file-accepted', `${ST} ('A root file of no known version (HilbertRaum-junk-portable.exe) keeps no constraint'): only that file at the root`, '1.1.0', '1.0.0', '1.2.0', [junkExe], true, null, true)
  rule('ver-stale-still-not-above-running', `${ST} and section 2.10 (driveVersion 'null when none counted, a stale one included'; the flag 'with every verdict from the version rule on, accepted or refused'): a stale 1.2.0 and the running version as candidate`, '1.0.0', '1.0.0', '1.2.0', [exe('1.0.0')], false, null, true)
  rule('ver-stale-carrier-differs-in-build-metadata-accepted', `${ST} and 'Which app_version counts' ('equals it byte for byte'): the drive says 1.2.0, the root app carries 1.2.0+b (equal in SemVer order, other bytes)`, '1.1.0', '1.0.0', '1.2.0', [exe('1.2.0+b')], true, null, true)
  rule('ver-stale-carrier-differs-in-case-accepted', `${ST} ('byte for byte'): the drive says 1.2.0-RC1, the root app carries 1.2.0-rc1`, '1.1.0', '1.0.0', '1.2.0-RC1', [exe('1.2.0-rc1')], true, null, true)
  rule('ver-stale-carrier-is-pre-release-of-drive-accepted', `${ST} (section 4.4: 'never by prefix or substring'): the drive says 1.4.0, the root app is HilbertRaum-1.4.0-rc.1-portable.exe, which carries 1.4.0-rc.1`, '1.3.0', '1.0.0', '1.4.0', [exe('1.4.0-rc.1')], true, null, true)
  rule('ver-stale-higher-apps-at-root-accepted', `${ST}: the drive says 1.2.0, the root apps carry 1.3.0; the record is stale and the apps themselves are no floor`, '1.1.0', '1.0.0', '1.2.0', [exe('1.3.0'), zip('1.3.0')], true, null, true)
  rule('ver-stale-below-old-floor-accepted', `${ST} ('the stale rule only ever loosens it'): a candidate far below the stale 9.0.0 is accepted once it is above the running version`, '1.0.1', '1.0.0', '9.0.0', [exe('1.0.0'), junkExe], true, null, true)
  rule('ver-not-stale-flag-false-when-counted-accepted', `${WC}: a drive version that counts sets no flag (accepted above it)`, '1.3.0', '1.0.0', '1.2.0', [exe('1.2.0'), junkExe], true, null, false)

  // ---- the same rule behind an envelope (section 10.7: such a vector has the stage version-rule)
  const EV = `${S25} 'The answer' and section 10.7 'expect' ('a vector with an envelope whose answer is UPD-SAME-OR-OLDER has version-rule')`
  const text = (over = {}) => JSON.stringify(BASE(over))
  const same = (version, runningVersion, driveVersion, stale = false) => refuse('version-rule', 'UPD-SAME-OR-OLDER', { version, runningVersion, driveVersion }, { staleDriveVersion: stale })
  pay('payload', 'ver-envelope-equal-running', `${EV}: a well-signed payload of the running version`, text({ version: '1.0.0' }), same('1.0.0', '1.0.0', null))
  pay('payload', 'ver-envelope-below-running', `${EV}: a well-signed payload of 1.1.0 on a running 2.0.0`, text(), same('1.1.0', '2.0.0', null), { runningVersion: '2.0.0' })
  pay('payload', 'ver-envelope-below-drive', `${EV}: a well-signed payload of 1.1.0, running 1.0.0, the drive's carried 1.2.0`, text(), same('1.1.0', '1.0.0', '1.2.0'), { driveAppVersion: '1.2.0', rootApps: [exe('1.2.0')] })
  pay('payload', 'ver-envelope-key-proof', `${EV} and section 2.8 (the key proof: a throw-away file of 0.0.0-keyproof.1 from an embedded key reads 'same or older', which it reaches only after the signature verified)`, text({ version: '0.0.0-keyproof.1' }), same('0.0.0-keyproof.1', '0.1.66', null), { runningVersion: '0.1.66' })
  pay('payload', 'ver-envelope-build-metadata-equal-running', `${EV} and 'Order' (build metadata no part): 1.0.0+rebuild equals the running 1.0.0; the parameter keeps the text as written`, text({ version: '1.0.0+rebuild' }), same('1.0.0+rebuild', '1.0.0', null))
  pay('payload', 'ver-envelope-equal-drive-accepted', `${S25} 'The answer' (equal passes) and section 10.7 'expect' (accepted has the stage payload in a vector with an envelope): 1.2.0 on a running 1.0.0 and a carried drive version 1.2.0`, text({ version: '1.2.0' }), accepted({ version: '1.2.0' }), { driveAppVersion: '1.2.0', rootApps: [exe('1.2.0')] })
}

// ================================================================================================================
// vectors-caps.json: the two large boundary pairs (the 4 MiB envelope, the 4,096 files[] entries)
// ================================================================================================================
{
  const C = 'caps'
  const CAP = 4_194_304
  const SZ = `${S23} 'Size' ('more than 4,194,304 bytes -> UPD-TOO-NEW, before the parse')`
  /** A good envelope padded to exactly `bytes` bytes with `unit` repeated inside the string of an ignored last key. */
  function padded(s, bytes, unit) {
    const head = envJson(s).slice(0, -1) + ',"pad":"'
    const tail = '"}'
    const room = bytes - Buffer.byteLength(head) - tail.length
    const each = Buffer.byteLength(unit)
    const times = Math.floor(room / each)
    const fill = 'a'.repeat(room - times * each) // ASCII letters make up what the unit leaves
    return { parts: [{ text: head + fill }, { repeat: unit, times }, { text: tail }] }
  }
  let s = setup()
  vec(C, 'cap-envelope-4194304-bytes-accepted', `${SZ}: a good envelope of exactly 4,194,304 bytes (an ignored key pads it) is within the cap`, [s.key.spki], padded(s, CAP, 'a'), accepted())
  vec(C, 'cap-envelope-4194305-bytes', `${SZ}: the same envelope with one byte more`, [s.key.spki], padded(s, CAP + 1, 'a'), TOO_NEW_ENV())
  vec(C, 'cap-envelope-bytes-not-characters-at-cap-accepted', `${SZ} (bytes): a good envelope of exactly 4,194,304 bytes padded with U+00E4 (2 bytes each), so it has about half as many characters`, [s.key.spki], padded(s, CAP, '\u{e4}'), accepted())
  vec(C, 'cap-envelope-bytes-not-characters-over-cap', `${SZ} (bytes, not characters or UTF-16 units): a good envelope of 4,194,306 bytes padded with U+00E4, so it has about 2.1 million characters`, [s.key.spki], padded(s, CAP + 2, '\u{e4}'), TOO_NEW_ENV())
  vec(C, 'cap-envelope-4194304-bytes-no-json', `${S23} 'Size' and 'JSON': 4,194,304 letters x are within the cap and no JSON -> UPD-FILE-DAMAGED`, [s.key.spki], { parts: [{ repeat: 'x', times: CAP }] }, DAMAGED())
  vec(C, 'cap-envelope-8-mib', `${SZ}: 8,388,608 spaces`, [s.key.spki], { parts: [{ repeat: ' ', times: 2 * CAP }] }, TOO_NEW_ENV())

  const FC = `${S24} 'files' ('an own array of 0 to 4,096 entries ...; else UPD-TOO-NEW') and section 4.3 'Member count'`
  const HASH = H('member')
  const name = (i) => 'm' + String(i).padStart(4, '0')
  const entries = (n) => Array.from({ length: n }, (_, i) => ({ name: name(i), size: i, sha256: HASH }))
  pay(C, 'cap-files-4096-entries-accepted', `${FC}: exactly 4,096 entries (m0000 to m4095, each of its index as size)`, JSON.stringify(BASE({ files: entries(4096) })), accepted({ files: entries(4096).map((e) => ({ ...e, group: null, installAs: null })) }))
  pay(C, 'cap-files-4097-entries', `${FC}: 4,097 well-formed entries`, JSON.stringify(BASE({ files: entries(4097) })), TOO_NEW())

  // ---- the largest payload: the envelope's cap is the payload's only bound
  {
    // The payload is the base payload with an ignored last key `pad`: a prefix filled to a multiple of 3 bytes, then
    // `aaa` k times, then the two closing bytes. So its base64 is base64(prefix), `YWFh` k times, and `In0=`.
    const [open, close] = JSON.stringify(BASE({ pad: '@@' })).split('@@')
    if (close !== '"}') throw new Error('the pad key is not the last one')
    const prefix = open + 'a'.repeat((3 - (Buffer.byteLength(open) % 3)) % 3)
    const key = newKey()
    const head = `{"payloadType":"${RELEASE}","payload":"` + utf8(prefix).toString('base64')
    const sigAt = '@'.repeat(88) // an Ed25519 signature is 88 base64 characters, whatever it signs
    const tailOf = (sig, align) => utf8(close).toString('base64') + `","signatures":[{"keyid":"${key.id}","sig":"${sig}"}],"align":"${'x'.repeat(align)}"}`
    // The base64 of the payload is a multiple of 4 characters; 0 to 3 letters in an ignored envelope key make the rest fit.
    const room = (align) => CAP - Buffer.byteLength(head) - tailOf(sigAt, align).length
    const align = [0, 1, 2, 3].find((n) => room(n) % 4 === 0)
    const times = room(align) / 4
    const body = Buffer.concat([utf8(prefix), Buffer.alloc(3 * times, 'a'), utf8(close)])
    if (body.length >= 3_145_728) throw new Error('the payload is not below 3,145,728 bytes')
    const sig = key.sign(pae(utf8(RELEASE), body)).toString('base64')
    if (sig.length !== 88) throw new Error('a signature of another length')
    const envelope = { parts: [{ text: head }, { repeat: 'YWFh', times }, { text: tailOf(sig, align) }] }
    if (Buffer.byteLength(head) + 4 * times + tailOf(sig, align).length !== CAP) throw new Error('the envelope is not at the cap')
    if (head.slice(head.lastIndexOf('"') + 1) + 'YWFh'.repeat(2) + utf8(close).toString('base64') !== Buffer.concat([utf8(prefix), utf8('aaaaaa'), utf8(close)]).toString('base64')) throw new Error('the parts do not join to the base64 of the payload')
    vec(C, 'cap-payload-largest-accepted', `${S24} 'Reading' ('No size cap of its own (the envelope's 4 MiB bounds it)') and ${S23} 'Size' and 'Writers: the caps and the signer' (a payload 'stays below 3,145,728 bytes'): a good envelope of exactly 4,194,304 bytes whose payload has ${body.length.toLocaleString('en-US')} bytes, padded inside an ignored key of the payload and signed as a whole (an ignored envelope key of ${align} ${align === 1 ? 'letter' : 'letters'} fits the base64's blocks of 4 to the cap)`, [key.spki], envelope, accepted())
  }
}

// ================================================================================================================
// write, then scan what was written
// ================================================================================================================
const written = []
for (const [part, vectors] of parts) {
  const file = join(outDir, `vectors-${part}.json`)
  writeFileSync(file, '[\n' + vectors.map(asciiJson).join(',\n') + '\n]\n')
  written.push(file)
}
// No file may hold a private key in any form. The needles are built from pieces so that this file passes its own scan.
const exact = ['PRIVATE' + ' KEY', 'MC4C' + 'AQAwBQYDK2Vw', '"d"' + ':', '"k' + 'ty"']
const anyCase = ['302e0201' + '00300506']
let bad = 0
for (const file of [...written, new URL(import.meta.url)]) {
  const textOf = readFileSync(file).toString('latin1')
  const lower = textOf.toLowerCase()
  for (const needle of exact) if (textOf.includes(needle)) (bad++, console.error(`${file}: holds ${needle.slice(0, 4)}...`))
  for (const needle of anyCase) if (lower.includes(needle)) (bad++, console.error(`${file}: holds ${needle.slice(0, 4)}...`))
  for (const seed of seeds) {
    const forms = [seed.toString('base64'), seed.toString('base64url'), seed.toString('base64').replace(/=+$/, '')]
    if (lower.includes(seed.toString('hex')) || forms.some((form) => textOf.includes(form))) (bad++, console.error(`${file}: holds a seed of this run`))
  }
  if (/[^\x0a\x20-\x7e]/.test(textOf)) (bad++, console.error(`${file}: holds a byte outside printable ASCII or LF`))
}
let count = 0
for (const [part, vectors] of parts) {
  count += vectors.length
  console.log(`vectors-${part}.json ${vectors.length}`)
}
console.log(`${count} vectors, ${seeds.length} key pairs made (none written)`)
if (bad) process.exit(1)

