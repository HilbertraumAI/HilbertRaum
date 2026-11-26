#!/usr/bin/env node
// HilbertRaum app-update wave, task T4.4: the POSITIVE contract vectors of F-1, F-2 and F-4 (docs/app-updates.md
// section 10.7). Each vector is a well-formed update file's envelope (member 0) that release 1 must accept, now and in
// ten years: the kinds of file the record lets a later writer make (unknown fields at every level, later signature
// schemes beside the Ed25519 one, more keys, both base64 alphabets, the largest legal values, a release's realistic
// payload). Every expected value is stated here from a row of the record, which the vector's `why` names; none comes from
// the code under test.
//
// Independence (section 10.7, C14): this file imports nothing from src/ and nothing of the verifier. Its PAE, its
// base64 writer and its JSON text are its own, over node:crypto (Ed25519 signing, SHA-256) and node:fs only. So a
// positive envelope is not the verifier's own output.
//
// Keys (plan C8, record section 2.7 "Test keys", section 10.7 "No private key"): every key pair is made in memory at
// run time with generateKeyPairSync('ed25519'); its private half signs inside this process and is never exported to a
// file, printed or logged; only the public half (its SPKI, standard base64) is written. The raw seeds of the run are
// held in memory for one purpose only: the last step scans every written file, and the bytes inside every envelope,
// payload and signature, for them, and for the private-key forms the repo-hygiene row refuses. A new run makes other
// keys and signatures, so the committed vectors are the golden; this file documents how they were made.
//
// Usage: node generate.mjs --out <a folder that does not exist yet>
// It refuses to write into an existing folder. Plain Node 24, no dependency.

import { createHash, generateKeyPairSync, randomBytes, sign, verify, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- the command line

const argv = process.argv.slice(2)
if (argv.length !== 2 || argv[0] !== '--out') {
  console.error('usage: node generate.mjs --out <a folder that does not exist yet>')
  process.exit(2)
}
const OUT = resolve(argv[1])
if (existsSync(OUT)) {
  console.error(`refused: ${OUT} exists; this generator writes only into a new folder`)
  process.exit(2)
}

// ---- base64, written here (RFC 4648 section 4 and 5, with padding; record section 2.3 "The base64 grammar")

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** `bytes` in base64 with padding, standard (`std`) or URL-safe (`url`) alphabet. */
function base64(bytes, alphabet = 'std') {
  const a = alphabet === 'url' ? URL_SAFE : STANDARD
  const out = []
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const n = (bytes[i] << 16) | ((has1 ? bytes[i + 1] : 0) << 8) | (has2 ? bytes[i + 2] : 0)
    out.push(a[(n >> 18) & 63] + a[(n >> 12) & 63] + (has1 ? a[(n >> 6) & 63] : '=') + (has2 ? a[n & 63] : '='))
  }
  return out.join('')
}

// ---- DSSE's PAE, written here (DSSE protocol.md; record section 2.3 "Verification": byte counts, ASCII decimal)

const RELEASE_TYPE = 'application/vnd.hilbertraum.release+json'

function pae(type, payload) {
  const t = Buffer.from(type, 'utf8')
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `, 'latin1'), t, Buffer.from(` ${payload.length} `, 'latin1'), payload])
}

/** Another construction a later version might sign (record section 2.3, "Writers: keyid"): never DSSEv1 PAE. */
function laterConstruction(type, payload) {
  const t = Buffer.from(type, 'utf8')
  return Buffer.concat([Buffer.from(`DSSEv2 ${t.length} `, 'latin1'), t, Buffer.from(` ${payload.length} `, 'latin1'), payload])
}

// ---- keys, made at run time

const SEEDS = [] // this run's raw seeds, in memory only, for the scan at the end
const KEYS = []
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX)) throw new Error('an SPKI of an unexpected shape')
  SEEDS.push(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'))
  let secret = privateKey
  const key = {
    spki: base64(der),
    id: createHash('sha256').update(der).digest('hex'),
    sign: (message) => sign(null, message, secret),
    discard: () => {
      secret = null
    }
  }
  KEYS.push(key)
  return key
}

// ---- JSON text with the key order and spelling written here

class Raw {
  constructor(text) {
    this.text = text
  }
}
const raw = (text) => new Raw(text)
const json = (value) => (value instanceof Raw ? value.text : JSON.stringify(value))
/** An object's JSON text from [key, value] pairs, in their order (so an own `__proto__` key can be written too). */
const obj = (pairs) => `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${json(v)}`).join(',')}}`

const H = (label) => createHash('sha256').update(`positive-vector ${label}`).digest('hex')

// ---- the values the vectors share

const RUNNING = '1.4.2'
const CANDIDATE = '1.5.0'
const NOW = '2028-06-01T09:30:00Z'
const ISSUED = '2028-05-28T14:05:11Z'
const HOST_KEYS = ['runningVersion', 'driveAppVersion', 'rootApps', 'maxVersion', 'os', 'osVersion', 'glibc', 'now', 'uiLanguage']
const BASE_HOST = { runningVersion: RUNNING, driveAppVersion: null, rootApps: [], maxVersion: null, os: 'win32', osVersion: '10.0.26100', glibc: null, now: NOW, uiLanguage: 'en' }
const MAC = { os: 'darwin', osVersion: '14.6.1', glibc: null }
const LINUX = { os: 'linux', osVersion: null, glibc: '2.39' }
/** A host (record section 10.7 "host", its nine fields in the schema's order). */
const host = (over = {}) => {
  const h = { ...BASE_HOST, ...over }
  return Object.fromEntries(HOST_KEYS.map((k) => [k, h[k]]))
}
const rootApp = (name, kind, system, version) => ({ name, kind, system, version })
const ROOT_RUNNING = [
  rootApp(`HilbertRaum-${RUNNING}-portable.exe`, 'file', 'win32', RUNNING),
  rootApp(`HilbertRaum-${RUNNING}-mac-arm64.app.zip`, 'file', 'darwin', RUNNING),
  rootApp(`HilbertRaum-${RUNNING}.AppImage`, 'file', 'linux', RUNNING)
]

/** A small release's files[] (record section 2.4, section 4.3 "files[] entries"). */
const SMALL_FILES = [
  { name: 'apply.cmd', size: 38912, sha256: H('apply.cmd'), role: 'apply-script' },
  { name: 'apply.sh', size: 41233, sha256: H('apply.sh'), role: 'apply-script' },
  { name: `HilbertRaum-${CANDIDATE}-portable.exe`, size: 178257920, sha256: H('exe'), group: 'win32', role: 'app' },
  { name: 'Start-HilbertRaum.cmd', size: 6144, sha256: H('start cmd'), group: 'win32', install_as: 'Start HilbertRaum.cmd', role: 'start-file' }
]

/** The floors a release names (record section 2.4: win32/darwin at most three components, linux at most two). */
const FLOORS = { win32: '10.0.17763', darwin: '12.0', linux: '2.28' }

// The summary texts: release 1's ten UI codes (record section 2.4 "summary") and languages release 1 does not know.
const SUMMARY = {
  en: 'Fixes the update screen and makes document search faster.',
  de: 'Behebt Fehler im Update-Bildschirm und macht die Dokumentsuche schneller f\u{fc}r gro\u{df}e Ordner.',
  es: 'Corrige la pantalla de actualizaci\u{f3}n y acelera la b\u{fa}squeda de documentos.',
  fr: 'Corrige l\u{2019}\u{e9}cran de mise \u{e0} jour et acc\u{e9}l\u{e8}re la recherche de documents.',
  it: 'Corregge la schermata di aggiornamento e velocizza la ricerca nei documenti gi\u{e0} indicizzati.',
  nl: 'Herstelt het updatescherm en maakt het zoeken in documenten sneller.',
  pl: 'Naprawia ekran aktualizacji i przyspiesza wyszukiwanie dokument\u{f3}w.',
  tr: 'G\u{fc}ncelleme ekran\u{131}n\u{131} d\u{fc}zeltir ve belge aramas\u{131}n\u{131} h\u{131}zland\u{131}r\u{131}r.',
  ru: '\u{418}\u{441}\u{43f}\u{440}\u{430}\u{432}\u{43b}\u{44f}\u{435}\u{442} \u{44d}\u{43a}\u{440}\u{430}\u{43d} \u{43e}\u{431}\u{43d}\u{43e}\u{432}\u{43b}\u{435}\u{43d}\u{438}\u{44f} \u{438} \u{443}\u{441}\u{43a}\u{43e}\u{440}\u{44f}\u{435}\u{442} \u{43f}\u{43e}\u{438}\u{441}\u{43a} \u{43f}\u{43e} \u{434}\u{43e}\u{43a}\u{443}\u{43c}\u{435}\u{43d}\u{442}\u{430}\u{43c}.',
  uk: '\u{412}\u{438}\u{43f}\u{440}\u{430}\u{432}\u{43b}\u{44f}\u{454} \u{435}\u{43a}\u{440}\u{430}\u{43d} \u{43e}\u{43d}\u{43e}\u{432}\u{43b}\u{435}\u{43d}\u{43d}\u{44f} \u{442}\u{430} \u{43f}\u{440}\u{438}\u{448}\u{432}\u{438}\u{434}\u{448}\u{443}\u{454} \u{43f}\u{43e}\u{448}\u{443}\u{43a} \u{443} \u{434}\u{43e}\u{43a}\u{443}\u{43c}\u{435}\u{43d}\u{442}\u{430}\u{445}.'
}
const TEN = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'tr', 'ru', 'uk']
const LATER_LANGUAGES = {
  ja: '\u{66f4}\u{65b0}\u{753b}\u{9762}\u{3092}\u{4fee}\u{6b63}\u{3057}\u{3001}\u{6587}\u{66f8}\u{691c}\u{7d22}\u{3092}\u{9ad8}\u{901f}\u{5316}\u{3057}\u{307e}\u{3059}\u{3002}',
  'zh-Hans': '\u{4fee}\u{590d}\u{66f4}\u{65b0}\u{754c}\u{9762}\u{5e76}\u{52a0}\u{5feb}\u{6587}\u{6863}\u{641c}\u{7d22}\u{3002}',
  ar: '\u{64a}\u{635}\u{644}\u{62d} \u{634}\u{627}\u{634}\u{629} \u{627}\u{644}\u{62a}\u{62d}\u{62f}\u{64a}\u{62b} \u{648}\u{64a}\u{633}\u{631}\u{651}\u{639} \u{627}\u{644}\u{628}\u{62d}\u{62b} \u{641}\u{64a} \u{627}\u{644}\u{645}\u{633}\u{62a}\u{646}\u{62f}\u{627}\u{62a}.',
  'pt-BR': 'Corrige a tela de atualiza\u{e7}\u{e3}o e acelera a busca de documentos.',
  'en-GB': 'Fixes the update screen and makes document search faster, colour themes included.'
}
const EMOJI_TEXT = 'Faster search \u{1f50e} and a calmer update screen \u{2705}.'

/** `text` repeated (space-joined) to exactly `n` Unicode code points, never ending in a space. */
function fit(text, n) {
  const cps = []
  while (cps.length < n) cps.push(...text, ' ')
  const out = cps.slice(0, n)
  if (out[n - 1] === ' ') out[n - 1] = '.'
  if ([...out.join('')].length !== n) throw new Error('fit')
  return out.join('')
}

/** A payload object (record section 2.4: the fixed values, then the release's own), in a writer's key order. */
const payload = (over = {}) => ({ format: 1, product: 'hilbertraum', kind: 'release', channel: 'stable', version: CANDIDATE, issued: ISSUED, files: SMALL_FILES, ...over })

/** A files[] entry as an accepted payload carries it (record section 2.10, "An accepted payload"). */
const shown = (e) => ({
  name: e.name,
  size: e.size,
  sha256: e.sha256.toLowerCase(),
  group: typeof e.group === 'string' ? e.group : null,
  installAs: typeof e.install_as === 'string' ? e.install_as : null
})

/** `expect` of an accepted payload (record section 10.7 "expect"; section 2.10). */
function accepted({ version = CANDIDATE, issued = ISSUED, summary = null, files = SMALL_FILES, flags = {} } = {}) {
  return {
    stage: 'payload',
    code: 'accepted',
    params: {},
    flags: { staleDriveVersion: false, issuedInFuture: false, oldFile: false, otherSystemFloors: [], ...flags },
    version,
    issued,
    summary,
    files: files.map(shown)
  }
}

// ---- envelopes and signature entries

/** An Ed25519 signature entry by `key` over `message`; `keyid` the key's id unless given (null: none). */
function edEntry(key, message, { keyid = key.id, alphabet = 'std', extra = [] } = {}) {
  const sig = key.sign(message)
  if (sig.length !== 64) throw new Error('an Ed25519 signature of another length')
  return obj([...(keyid === null ? [] : [['keyid', keyid]]), ['sig', base64(sig, alphabet)], ...extra])
}

/** An entry of a later signature scheme: `n` bytes that verify under no Ed25519 key, with its own keyid or none. */
function laterEntry(n, keyid, scheme) {
  return obj([...(keyid === null ? [] : [['keyid', keyid]]), ['sig', base64(randomBytes(n))], ...(scheme ? [['scheme', scheme]] : [])])
}

/** The envelope's text: unknown fields `before` and `after` the three known ones (record section 2.3). */
function envelopeText({ type = RELEASE_TYPE, payloadBytes, alphabet = 'std', entries, before = [], after = [] }) {
  return obj([...before, ['payloadType', type], ['payload', base64(payloadBytes, alphabet)], ['signatures', raw(`[${entries.join(',')}]`)], ...after])
}

const textPart = (text) => ({ text })

/**
 * An envelope whose signatures are `times` copies of the entry text `entry`, then `last`, held as three parts (the
 * copies as one `repeat` part, section 10.7 "envelope"), so a large envelope stays a small vector. Refuses one over the
 * envelope cap (record section 2.3 "Size": 4,194,304 bytes).
 */
function repeatedEntries(payloadBytes, entry, times, last) {
  const PLACEHOLDER = '@ENTRIES@'
  const full = envelopeText({ payloadBytes, entries: [PLACEHOLDER, last] })
  const at = full.indexOf(PLACEHOLDER)
  const head = full.slice(0, at)
  const tail = full.slice(at + PLACEHOLDER.length + 1) // the comma after the placeholder
  const parts = [textPart(head), { repeat: `${entry},`, times }, textPart(tail)]
  const length = Buffer.byteLength(head) + times * Buffer.byteLength(`${entry},`) + Buffer.byteLength(tail)
  if (length > 4194304) throw new Error(`an envelope over the cap: ${length} bytes`)
  return { parts, length }
}

function vector({ id, why, keys, parts, host: h = host(), expect = accepted() }) {
  return { id, why, keys: keys.map((k) => k.spki), envelope: { parts }, host: h, expect }
}

/** One key, one Ed25519 entry over the payload's PAE, one text part. */
function simple({ id, why, payloadText, payloadObject, host: h, expect, alphabet = 'std', before = [], after = [], entryOptions = {} }) {
  const key = newKey()
  const bytes = Buffer.from(payloadText ?? JSON.stringify(payloadObject ?? payload()), 'utf8')
  const entry = edEntry(key, pae(RELEASE_TYPE, bytes), entryOptions)
  return vector({ id, why, keys: [key], parts: [textPart(envelopeText({ payloadBytes: bytes, alphabet, entries: [entry], before, after }))], host: h, expect })
}

const R = 'app-updates.md section'

// ================================================================================================
// vectors-envelope.json: the envelope a later writer may make (record section 2.3, section 2.1, section 2.7)
// ================================================================================================

const envelopeVectors = []
{
  envelopeVectors.push(
    simple({
      id: 'pos-env-unknown-fields-every-json-type',
      why: `${R} 2.3 'JSON' (unknown keys are ignored; DSSE envelope.md: consumers MUST ignore unrecognized fields) and 'A signature entry' (an entry counts by its own sig): unknown fields of every JSON type before and after the three known ones, and unknown fields in the signature entry`,
      before: [
        ['x-hilbertraum-container', { version: 2, members: 9, compression: null }],
        ['created', ISSUED],
        ['counts', raw('[1,2.5e3,-0.0,1E-7,null,true,false,"",{},[[]]]')]
      ],
      after: [
        ['payloadDigest', { sha256: H('payload digest'), sha512: null }],
        ['transparency', { log: 'later', entries: [{ index: 12, proof: ['aa', 'bb'] }] }],
        ['note', null],
        ['flag', false]
      ],
      entryOptions: { extra: [['alg', 'ed25519'], ['scheme', { name: 'dsse-v1-ed25519', since: 1 }], ['cert', null], ['timestamp', { rfc3161: '' }], ['x5c', []]] }
    })
  )
  envelopeVectors.push(
    simple({
      id: 'pos-env-unknown-fields-non-ascii',
      why: `${R} 2.3 'Text' (strict UTF-8 as RFC 3629 defines it) and 'JSON' (unknown keys are ignored): unknown keys and values with two-, three- and four-byte UTF-8 characters`,
      before: [['Gr\u{f6}\u{df}e', 'Notiz f\u{fc}r sp\u{e4}ter: \u{dc}n\u{ef}c\u{f6}d\u{e9}-Feld'], ['ja', LATER_LANGUAGES.ja]],
      after: [['emoji', EMOJI_TEXT], ['ar', LATER_LANGUAGES.ar]]
    })
  )
  envelopeVectors.push(
    simple({
      id: 'pos-env-own-proto-key-ignored',
      why: `${R} 2.3 'JSON' (only own keys count; an own __proto__ key is an unknown key, ignored): an own __proto__ key holding envelope fields of its own before the real ones`,
      before: [['__proto__', { payloadType: 'application/json', payload: '', signatures: [] }]]
    })
  )
  {
    // 10,000 levels of nesting inside an ignored key (section 10.7 "Depth"), as parts so the vector stays small.
    const key = newKey()
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    const rest = envelopeText({ payloadBytes: bytes, entries: [edEntry(key, pae(RELEASE_TYPE, bytes))] })
    envelopeVectors.push(
      vector({
        id: 'pos-env-depth-10000-in-ignored-key',
        why: `${R} 10.7 'Depth' (one positive vector holds 10,000 levels of nesting inside an ignored key of the envelope) and 2.3 'JSON' (the reader never walks the parsed value as a whole)`,
        keys: [key],
        parts: [textPart('{"x-later-tree":'), { repeat: '[', times: 10000 }, { repeat: ']', times: 10000 }, textPart(`,${rest.slice(1)}`)]
      })
    )
  }
  {
    // Another key order and JSON whitespace (RFC 8259: space, tab, LF, CR) between every token.
    const key = newKey()
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    const entry = edEntry(key, pae(RELEASE_TYPE, bytes))
    const text = `{\r\n\t"signatures" : [\r\n\t\t${entry}\r\n\t] ,\r\n\t"payload" :\t${JSON.stringify(base64(bytes))},\r\n  "payloadType" : ${JSON.stringify(RELEASE_TYPE)}\r\n}\r\n`
    envelopeVectors.push(
      vector({
        id: 'pos-env-key-order-and-whitespace',
        why: `${R} 2.3 'JSON' (one JSON text as JSON.parse reads it, RFC 8259's grammar; the named own keys are read, so their order and the whitespace between tokens carry no meaning) and 'Writers: the form' (no rule on order or whitespace): signatures first, payloadType last, CR LF, tabs and spaces`,
        keys: [key],
        parts: [textPart(text)]
      })
    )
  }
  {
    // The payload in the URL-safe alphabet: a payload whose standard base64 holds both + and / (an ignored filler).
    let bytes = null
    for (let i = 0; i < 200 && bytes === null; i++) {
      const b = Buffer.from(JSON.stringify(payload({ 'x-filler': '>?'.repeat(i) })), 'utf8')
      const s = base64(b)
      if (s.includes('+') && s.includes('/')) bytes = b
    }
    if (bytes === null) throw new Error('no payload with + and / in its base64')
    for (const [id, payloadAlphabet, sigAlphabet] of [
      ['pos-env-b64-payload-url-safe', 'url', 'std'],
      ['pos-env-b64-sig-url-safe', 'std', 'url'],
      ['pos-env-b64-payload-and-sig-url-safe', 'url', 'url']
    ]) {
      // A signature whose standard base64 holds both + and /, so its URL-safe form differs in both characters.
      let key
      let entry
      for (let tries = 0; ; tries++) {
        if (tries > 200) throw new Error('no signature with + and /')
        key = newKey()
        const sig = key.sign(pae(RELEASE_TYPE, bytes))
        const s = base64(sig)
        if (sigAlphabet === 'std' || (s.includes('+') && s.includes('/'))) {
          entry = obj([['keyid', key.id], ['sig', base64(sig, sigAlphabet)]])
          break
        }
      }
      envelopeVectors.push(
        vector({
          id,
          why: `${R} 2.3 'The base64 grammar' (standard or URL-safe, one alphabet per string, padding required; DSSE protocol.md: verifiers MUST accept either): payload in the ${payloadAlphabet === 'url' ? 'URL-safe' : 'standard'} alphabet, sig in the ${sigAlphabet === 'url' ? 'URL-safe' : 'standard'} one, each holding both of its alphabet's two last characters where URL-safe`,
          keys: [key],
          parts: [textPart(envelopeText({ payloadBytes: bytes, alphabet: payloadAlphabet, entries: [entry] }))]
        })
      )
    }
  }
  for (const [pad, rem] of [
    [0, 0],
    [1, 2],
    [2, 1]
  ]) {
    let bytes = null
    for (let i = 0; i < 3 && bytes === null; i++) {
      const b = Buffer.from(JSON.stringify(payload({ 'x-pad': 'n'.repeat(i) })), 'utf8')
      if (b.length % 3 === rem) bytes = b
    }
    envelopeVectors.push(
      simple({
        id: `pos-env-b64-payload-padding-${pad}`,
        why: `${R} 2.3 'The base64 grammar' (padding required: = only as the last one or two characters): a payload of ${bytes.length} bytes, so its base64 ends in ${pad} padding character${pad === 1 ? '' : 's'}`,
        payloadText: bytes.toString('utf8')
      })
    )
  }

  // Several signatures: one valid Ed25519 entry among later schemes' entries, first, in the middle and last.
  for (const [id, position] of [
    ['pos-env-signatures-valid-first-among-later-schemes', 0],
    ['pos-env-signatures-valid-middle-among-later-schemes', 3],
    ['pos-env-signatures-valid-last-among-later-schemes', 6]
  ]) {
    const key = newKey()
    const newer = newKey() // a later key release 1 does not embed
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    const others = [
      laterEntry(3309, 'ml-dsa-65:' + H('ml-dsa key').slice(0, 32), 'ml-dsa-65'),
      laterEntry(7856, 'slh-dsa-sha2-128s:' + H('slh key').slice(0, 32), 'slh-dsa-sha2-128s'),
      edEntry(key, laterConstruction(RELEASE_TYPE, bytes), { keyid: null, extra: [['construction', 'dssev2']] }),
      laterEntry(114, 'ed448:' + H('ed448 key').slice(0, 32), 'ed448'),
      laterEntry(64, 'x-later-scheme-1', null),
      edEntry(newer, pae(RELEASE_TYPE, bytes))
    ]
    const entries = [...others]
    entries.splice(position, 0, edEntry(key, pae(RELEASE_TYPE, bytes)))
    envelopeVectors.push(
      vector({
        id,
        why: `${R} 2.3 'A signature entry' (an entry of another length or scheme is skipped, never a refusal; a later envelope may carry another scheme's signature beside an Ed25519 one) and 'Verification' (each counting entry in envelope order, the first that a key verifies accepts) and 'Writers: keyid' (another construction carries another keyid or none): seven entries (ML-DSA-65 and SLH-DSA-128s sized, an Ed25519 signature of the same key over another construction, an Ed448-sized one, 64 other bytes, a newer key's), the valid one at position ${position + 1}`,
        keys: [key],
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries }))]
      })
    )
  }
  {
    // 64 entries (the cap), 63 of them 64-byte entries that verify under no embedded key, the valid one last.
    const key = newKey()
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    const entries = []
    for (let i = 0; i < 63; i++) {
      if (i % 3 === 0) entries.push(edEntry(newKey(), pae(RELEASE_TYPE, bytes)))
      else if (i % 3 === 1) entries.push(edEntry(key, laterConstruction(RELEASE_TYPE, bytes), { keyid: null }))
      else entries.push(laterEntry(64, `x-later-scheme-${i}`, null))
    }
    entries.push(edEntry(key, pae(RELEASE_TYPE, bytes)))
    envelopeVectors.push(
      vector({
        id: 'pos-env-signatures-64-counting-entries-valid-last',
        why: `${R} 2.3 'signatures' (more than 64 entries is too new; 64 is legal) and 'Verification' (each counting entry, in envelope order, against each embedded key; at most 64 x keys verifications): 63 entries of exactly 64 bytes that verify under no embedded key (newer keys' signatures, the same key over another construction, other bytes), then the valid one`,
        keys: [key],
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries }))]
      })
    )
  }
  {
    // 63 entries the size of a hash-based signature (SLH-DSA-SHA2-192f, 35,664 bytes, ~47 KB as base64) and the
    // valid one last: section 4.3's room for 64 signatures of ~45 KB each. One entry text, repeated as a part.
    const key = newKey()
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    const big = obj([['keyid', 'slh-dsa-sha2-192f:' + H('slh 192f key').slice(0, 32)], ['sig', base64(Buffer.alloc(35664, 'SLH'))], ['scheme', 'slh-dsa-sha2-192f']])
    const { parts, length } = repeatedEntries(bytes, big, 63, edEntry(key, pae(RELEASE_TYPE, bytes)))
    envelopeVectors.push(
      vector({
        id: 'pos-env-signatures-63-hash-based-sized-then-valid',
        why: `${R} 4.3 'Member 0' (the 4 MiB cap leaves room for 64 signatures of up to ~45 KB each, for a later hash-based scheme) and 2.3 'A signature entry' (another length is skipped) and 'signatures' (64 entries legal): 63 entries of 35,664 bytes (SLH-DSA-SHA2-192f's size) then the valid Ed25519 one; ${length} bytes in all`,
        keys: [key],
        parts
      })
    )
  }

  // Two and three embedded keys, a signature by each in turn (record section 2.1, K1: any one key signs alone).
  for (const n of [2, 3]) {
    for (let by = 0; by < n; by++) {
      const keys = Array.from({ length: n }, newKey)
      const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
      envelopeVectors.push(
        vector({
          id: `pos-keys-${n === 2 ? 'two' : 'three'}-signed-by-${['first', 'second', 'third'][by]}`,
          why: `${R} 2.1 (any one of the embedded keys signs alone, K1) and 2.3 'Verification' (each counting entry against each embedded key): ${n} embedded keys, the file signed by key ${by + 1} only`,
          keys,
          parts: [textPart(envelopeText({ payloadBytes: bytes, entries: [edEntry(keys[by], pae(RELEASE_TYPE, bytes))] }))]
        })
      )
    }
  }
  {
    const keys = Array.from({ length: 16 }, newKey)
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    envelopeVectors.push(
      vector({
        id: 'pos-keys-sixteen-signed-by-last',
        why: `${R} 2.7 'A set that does not read' (more than 16 keys invalidates, so 16 is the largest set) and 2.3 'Verification' (every embedded key is tried): 16 embedded keys, the file signed by the 16th`,
        keys,
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries: [edEntry(keys[15], pae(RELEASE_TYPE, bytes))] }))]
      })
    )
  }
  {
    const [a, b] = [newKey(), newKey()]
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    envelopeVectors.push(
      vector({
        id: 'pos-keyid-names-the-other-embedded-key',
        why: `${R} 2.3 'Verification' (keyid never selects or skips a key; trying the named key first changes no answer) and 'keyid' (a hint): two embedded keys, the file signed by the second, its keyid the first key's id`,
        keys: [a, b],
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries: [edEntry(b, pae(RELEASE_TYPE, bytes), { keyid: a.id })] }))]
      })
    )
  }
  {
    const [active, standby, succession] = [newKey(), newKey(), newKey()]
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    envelopeVectors.push(
      vector({
        id: 'pos-keys-two-embedded-keys-both-signed',
        why: `${R} 9.3 step 2 (the signing tool can add a signature to an existing envelope in a second offline session) and 2.3 'Verification' (the first entry one key verifies accepts): three embedded keys, signatures by the second and the first`,
        keys: [active, standby, succession],
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries: [edEntry(standby, pae(RELEASE_TYPE, bytes)), edEntry(active, pae(RELEASE_TYPE, bytes))] }))]
      })
    )
  }
  {
    const [embedded, newer] = [newKey(), newKey()]
    const bytes = Buffer.from(JSON.stringify(payload()), 'utf8')
    envelopeVectors.push(
      vector({
        id: 'pos-keys-newer-key-first-then-embedded-key',
        why: `${R} 2.2 (rotation: a later release is also signed by a key the old Kits embed) and 2.3 'Verification' (each counting entry in envelope order against each embedded key): a newer key's valid signature under its own id first, then the embedded key's`,
        keys: [embedded],
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries: [edEntry(newer, pae(RELEASE_TYPE, bytes)), edEntry(embedded, pae(RELEASE_TYPE, bytes))] }))]
      })
    )
  }
}

// ================================================================================================
// vectors-payload.json: the payload a later writer may make (record section 2.4, section 4.3, section 4.4)
// ================================================================================================

const payloadVectors = []
{
  const TOP_UNKNOWN = [
    ['engine', { 'llama.cpp': 'b12840', whisper: 'v1.8.2', archives: [{ system: 'win32', variant: 'cuda-12.4' }] }],
    ['engine_min', 'b12110'],
    ['security', { advisory: 'HRSA-2028-01', severity: 'high' }],
    ['notes', [1, 'two', null, { three: 3.5 }, [true, false]]],
    ['sbom', { format: 'cyclonedx', sha256: H('sbom') }],
    ['released_by', 'release tooling 3'],
    ['min_engine_for_models', null],
    ['__proto__', { format: 2, channel: 'beta', kind: 'model-pack' }]
  ]
  const fixed = (version = CANDIDATE) => [
    ['format', 1],
    ['product', 'hilbertraum'],
    ['kind', 'release'],
    ['channel', 'stable'],
    ['version', version],
    ['issued', ISSUED]
  ]
  const ENTRY_UNKNOWN = { sha512: H('sha512 a') + H('sha512 b'), mode: '0755', arch: 'x64', compression: { algorithm: 'zstd', level: 19 }, executable: true, signatures: [], 'x-size-on-disk': 178262016 }
  const filesWithUnknown = SMALL_FILES.map((e, i) => ({ ...e, ...ENTRY_UNKNOWN, role: ['apply-script', 'apply-script', 'app', { kind: 'start-file', since: 2 }][i] }))
  const REQUIRES_UNKNOWN = {
    win32: FLOORS.win32,
    freebsd: '14.1',
    android: { api: 35 },
    win32_arm64: '10.0.22621',
    'linux-musl': '1.2.5',
    darwin_x64: false,
    cpu: { x86_64: ['avx2', 'fma'] },
    ram_mib: 8192,
    gpu: null,
    openbsd: ['7.5']
  }
  const SUMMARY_UNKNOWN = { en: SUMMARY.en, de: SUMMARY.de, ...LATER_LANGUAGES, html: { en: '<p>Fixes.</p>' }, 'x-rich': [{ lang: 'en', text: 'Fixes.' }] }

  payloadVectors.push(
    simple({
      id: 'pos-pay-unknown-fields-top-level',
      why: `${R} 2.4 'Reading' (unknown keys ignored; the engine fields and every field not in the table are ignored; an own __proto__ key is an unknown key): engine fields, an advisory, an SBOM digest and other unknown fields of every JSON type`,
      payloadText: obj([...fixed(), ['files', SMALL_FILES], ...TOP_UNKNOWN])
    })
  )
  payloadVectors.push(
    simple({
      id: 'pos-pay-unknown-fields-in-files-entries',
      why: `${R} 4.3 'files[] entries' and 2.4 'role' (never read) and 'Reading' (unknown fields ignored): every files[] entry with unknown fields of every type, a role of a later shape`,
      payloadObject: payload({ files: filesWithUnknown }),
      expect: accepted({ files: filesWithUnknown })
    })
  )
  payloadVectors.push(
    simple({
      id: 'pos-pay-unknown-platforms-in-requires',
      why: `${R} 2.4 'requires' (only the own keys win32, darwin and linux are read; every other key and its value are ignored) and 'Later writers: types for ever' (a richer meaning takes a new key in requires): unknown platforms and new keys with values of every type beside a win32 floor this host meets`,
      payloadObject: payload({ requires: REQUIRES_UNKNOWN }),
      expect: accepted()
    })
  )
  payloadVectors.push(
    simple({
      id: 'pos-pay-unknown-languages-in-summary',
      why: `${R} 2.4 'summary' (any key but release 1's ten codes is ignored; a value that does not count is ignored): languages release 1 does not know (ja, zh-Hans, ar, pt-BR, en-GB) and richer unknown keys beside de and en; shown in de`,
      payloadObject: payload({ summary: SUMMARY_UNKNOWN }),
      host: host({ uiLanguage: 'de' }),
      expect: accepted({ summary: SUMMARY.de })
    })
  )
  payloadVectors.push(
    simple({
      id: 'pos-pay-unknown-fields-at-every-level',
      why: `${R} 2.3 'JSON' and 2.4 'Reading', 'requires', 'summary', 4.3 'files[] entries' (unknown keys ignored at every level): unknown fields in the envelope, the payload, every files[] entry, requires and summary at once`,
      payloadText: obj([...fixed(), ['requires', REQUIRES_UNKNOWN], ['summary', SUMMARY_UNKNOWN], ['files', filesWithUnknown], ...TOP_UNKNOWN]),
      before: [['x-hilbertraum-container', { version: 2 }]],
      after: [['transparency', { log: 'later' }]],
      entryOptions: { extra: [['alg', 'ed25519']] },
      expect: accepted({ summary: SUMMARY.en, files: filesWithUnknown })
    })
  )

  // The summary in all ten of release 1's languages and in languages it does not know; shown in each UI language.
  const allLanguages = { ...SUMMARY, ...LATER_LANGUAGES }
  for (const code of TEN) {
    payloadVectors.push(
      simple({
        id: `pos-pay-summary-ten-languages-shown-in-${code}`,
        why: `${R} 2.4 'summary' (its own keys are release 1's ten UI codes; shown: the UI language's value when it counts) and 'Later writers: issued and summary' (a value for each language release 1 should show, en always): all ten codes and five unknown languages; the UI language ${code}`,
        payloadObject: payload({ summary: allLanguages }),
        host: host({ uiLanguage: code }),
        expect: accepted({ summary: SUMMARY[code] })
      })
    )
  }
  payloadVectors.push(
    simple({
      id: 'pos-pay-summary-ui-language-missing-en-shown',
      why: `${R} 2.4 'summary' (the UI language's value when it counts, else en's): a summary in en and in languages release 1 does not know, read in pl`,
      payloadObject: payload({ summary: { en: SUMMARY.en, ...LATER_LANGUAGES } }),
      host: host({ uiLanguage: 'pl' }),
      expect: accepted({ summary: SUMMARY.en })
    })
  )
  {
    const long = Object.fromEntries(TEN.map((code) => [code, fit(code === 'en' ? EMOJI_TEXT : SUMMARY[code], 400)]))
    for (const code of ['uk', 'en']) {
      payloadVectors.push(
        simple({
          id: `pos-pay-summary-400-code-points-shown-in-${code}`,
          why: `${R} 2.4 'summary' (a value counts at 1 to 400 Unicode code points) and 'Later writers: issued and summary' (1 to 400 code points, [...text].length): every one of the ten values exactly 400 code points (en's with emoji: 400 code points, more UTF-16 units); the UI language ${code}`,
          payloadObject: payload({ summary: long }),
          host: host({ uiLanguage: code }),
          expect: accepted({ summary: long[code] })
        })
      )
    }
  }

  // Versions.
  {
    const files = SMALL_FILES.map((e) => (e.name.endsWith('-portable.exe') ? { ...e, name: 'HilbertRaum-1.5.0-rc.2-portable.exe' } : e))
    payloadVectors.push(
      simple({
        id: 'pos-pay-version-pre-release',
        why: `${R} 2.4 'version' (SemVer 2.0.0 of at most 64 bytes) and 2.5 'Order' (a pre-release of a later version is above the running version): 1.5.0-rc.2 over 1.4.2`,
        payloadObject: payload({ version: '1.5.0-rc.2', files }),
        expect: accepted({ version: '1.5.0-rc.2', files })
      })
    )
  }
  payloadVectors.push(
    simple({
      id: 'pos-pay-running-pre-release-gets-its-release',
      why: `${R} 2.5 'Order' (SemVer 2.0.0: 0.2.0-rc.1 is below 0.2.0) and 'The answer' (accepted above the running version): the running app is 1.5.0-beta.3, the file 1.5.0`,
      host: host({ runningVersion: '1.5.0-beta.3' })
    })
  )
  {
    const v64 = `1.5.0-preview.${'x'.repeat(50)}`
    if (v64.length !== 64) throw new Error('v64')
    payloadVectors.push(
      simple({
        id: 'pos-pay-version-64-bytes',
        why: `${R} 2.4 'version' (SemVer 2.0.0 of at most 64 bytes, isReleaseVersion) and 'Later writers: version' (at most 64 bytes, no build metadata): a 64-byte pre-release version`,
        payloadObject: payload({ version: v64 }),
        expect: accepted({ version: v64 })
      })
    )
  }
  for (const [id, min, note] of [
    ['pos-pay-min-upgrade-from-equal-running', RUNNING, 'equal to the running version (equal passes)'],
    ['pos-pay-min-upgrade-from-below-running', '1.0.0', 'below the running version']
  ]) {
    payloadVectors.push(
      simple({
        id,
        why: `${R} 2.4 'min_upgrade_from' (above the running version is UPD-NEEDS-IN-BETWEEN; equal passes): ${note}`,
        payloadObject: payload({ min_upgrade_from: min })
      })
    )
  }
  for (const [id, max] of [
    ['pos-pay-max-version-equal-candidate', CANDIDATE],
    ['pos-pay-max-version-above-candidate', '1.9.0']
  ]) {
    payloadVectors.push(
      simple({
        id,
        why: `${R} 2.10 'The policy' bullet and 4.5 'Order of an import' (a version above updates.max_version is UPD-ABOVE-MAX-VERSION; at or below passes): the cap ${max}, the file ${CANDIDATE}`,
        host: host({ maxVersion: max })
      })
    )
  }

  // issued: the notices come with an accepted payload (record section 2.4, section 2.10 "The flags").
  payloadVectors.push(
    simple({
      id: 'pos-pay-issued-in-future-notice',
      why: `${R} 2.4 'issued in the future' (issued - now > 86,400,000 ms gives the warning UPD-ISSUED-IN-FUTURE) and 2.10 'The flags' (with an accepted payload): issued three days after now`,
      payloadObject: payload({ issued: '2028-06-04T09:30:00Z' }),
      expect: accepted({ issued: '2028-06-04T09:30:00Z', flags: { issuedInFuture: true } })
    })
  )
  payloadVectors.push(
    simple({
      id: 'pos-pay-issued-old-notice',
      why: `${R} 2.4 'issued old' (now - issued > 31,536,000,000 ms gives the confirmation UPD-OLD-FILE) and 2.10 'The flags' (with an accepted payload): issued 427 days before now`,
      payloadObject: payload({ issued: '2027-04-01T09:30:00Z' }),
      expect: accepted({ issued: '2027-04-01T09:30:00Z', flags: { oldFile: true } })
    })
  )

  // The floors a release names, met on each system; the other systems' floors shown (record section 2.4).
  for (const [system, h, others] of [
    ['win32', {}, [{ system: 'darwin', floor: FLOORS.darwin }, { system: 'linux', floor: FLOORS.linux }]],
    ['darwin', MAC, [{ system: 'win32', floor: FLOORS.win32 }, { system: 'linux', floor: FLOORS.linux }]],
    ['linux', LINUX, [{ system: 'win32', floor: FLOORS.win32 }, { system: 'darwin', floor: FLOORS.darwin }]]
  ]) {
    payloadVectors.push(
      simple({
        id: `pos-pay-floors-met-on-${system}`,
        why: `${R} 2.4 'Comparing' and 'This system's floor' (the host meets a floor it equals or exceeds) and 'The other systems' floors' (a warning with an accepted payload, in the order win32, darwin, linux): floors for all three systems, each met, every system with an app at the root; on ${system}`,
        payloadObject: payload({ requires: FLOORS }),
        host: host({ ...h, rootApps: ROOT_RUNNING, driveAppVersion: RUNNING }),
        expect: accepted({ flags: { otherSystemFloors: others } })
      })
    )
  }

  // Spellings a later writer's JSON library may choose (record section 2.4 "Reading": number spelling carries no meaning).
  {
    const text = obj([
      ['format', raw('1.0')],
      ['product', 'hilbertraum'],
      ['kind', 'release'],
      ['channel', 'stable'],
      ['version', CANDIDATE],
      ['issued', ISSUED],
      [
        'files',
        raw(
          `[${obj([['name', 'apply.cmd'], ['size', raw('3.8912e4')], ['sha256', H('apply.cmd')]])},${obj([['name', 'apply.sh'], ['size', raw('41233.0')], ['sha256', H('apply.sh')]])},${obj([['name', 'empty.txt'], ['size', raw('0E0')], ['sha256', H('empty')]])},${obj([['name', 'big.bin'], ['size', raw('8.589934591E9')], ['sha256', H('big')]])}]`
        )
      ]
    ])
    payloadVectors.push(
      simple({
        id: 'pos-pay-number-spellings',
        why: `${R} 2.4 'Reading' (number spelling carries no meaning) and 'format' (the value JSON.parse gives is === 1) and 4.3 'files[] entries' (the value JSON.parse gives is a safe integer in range: 1.0 and 1e3 pass): format 1.0, sizes 3.8912e4, 41233.0, 0E0 and 8.589934591E9`,
        payloadText: text,
        expect: accepted({
          files: [
            { name: 'apply.cmd', size: 38912, sha256: H('apply.cmd') },
            { name: 'apply.sh', size: 41233, sha256: H('apply.sh') },
            { name: 'empty.txt', size: 0, sha256: H('empty') },
            { name: 'big.bin', size: 8589934591, sha256: H('big') }
          ]
        })
      })
    )
  }
  {
    const p = payload()
    const reordered = { files: p.files, issued: p.issued, version: p.version, channel: p.channel, kind: p.kind, product: p.product, format: p.format }
    payloadVectors.push(
      simple({
        id: 'pos-pay-pretty-printed-other-key-order',
        why: `${R} 2.4 'Reading' (key order, whitespace and number spelling carry no meaning; byte identity is the release tools' own rule): the payload pretty-printed with two-space indent and CR LF, its keys in reverse order`,
        payloadText: JSON.stringify(reordered, null, 2).split('\n').join('\r\n') + '\r\n'
      })
    )
  }
  {
    const files = SMALL_FILES.map((e) => ({ ...e, sha256: e.sha256.toUpperCase() }))
    payloadVectors.push(
      simple({
        id: 'pos-pay-sha256-upper-case',
        why: `${R} 4.3 'files[] entries' (a sha256 of 64 hex characters, either case; compared lower-cased) and 2.10 'An accepted payload' (sha256 lower-cased): every sha256 in upper case`,
        payloadObject: payload({ files }),
        expect: accepted({ files })
      })
    )
  }
  {
    const name99 = `HilbertRaum-content-${'a'.repeat(75)}.bin`
    if (name99.length !== 99) throw new Error('name99')
    const files = [...SMALL_FILES, { name: name99, size: 1, sha256: H('name 99') }]
    payloadVectors.push(
      simple({
        id: 'pos-pay-member-name-99-bytes',
        why: `${R} 4.4 'Length' (1 to 99 bytes, the ustar name field with its NUL) and 'Characters': a member name of 99 bytes`,
        payloadObject: payload({ files }),
        expect: accepted({ files })
      })
    )
  }
  {
    const files = [...SMALL_FILES, { name: 'model-weights.gguf', size: 8589934591, sha256: H('8 GiB - 1'), group: 'models' }]
    payloadVectors.push(
      simple({
        id: 'pos-pay-member-size-8-gib-minus-1',
        why: `${R} 4.3 'Size' and 'files[] entries' (an integer size from 0 to 8,589,934,591; ustar's 11 octal digits): a member of 8,589,934,591 bytes`,
        payloadObject: payload({ files }),
        expect: accepted({ files })
      })
    )
  }
  {
    // Nine members at the member bound: 77,309,411,319 bytes in all, more than any one member may hold.
    const files = [...SMALL_FILES, ...Array.from({ length: 9 }, (_, i) => ({ name: `model-part-${i + 1}-of-9.gguf`, size: 8589934591, sha256: H(`model part ${i + 1}`), group: 'models' }))]
    payloadVectors.push(
      simple({
        id: 'pos-pay-total-size-beyond-one-member',
        why: `${R} 4.3 'Total size' (no cap of its own beyond the member bound, under 8 GiB each, and the free-space check) and 'Member count': nine members of 8,589,934,591 bytes each beside the small release, about 72 GiB in all`,
        payloadObject: payload({ files }),
        expect: accepted({ files })
      })
    )
  }
  {
    const files = [
      ...SMALL_FILES,
      { name: 'llama-b12840-bin-win-cuda-12.4-x64.zip', size: 412088320, sha256: H('engine win cuda'), group: 'engine-win32-cuda', role: 'engine-archive' },
      { name: 'llama-b12840-bin-win-cpu-x64.zip', size: 30441472, sha256: H('engine win cpu'), group: 'win32', role: 'engine-archive' },
      { name: 'llama-b12840-bin-macos-arm64.zip', size: 25165824, sha256: H('engine mac'), group: 'darwin', role: 'engine-archive' },
      { name: 'llama-b12840-bin-ubuntu-x64.zip', size: 28311552, sha256: H('engine linux'), group: 'linux', role: 'engine-archive' }
    ]
    payloadVectors.push(
      simple({
        id: 'pos-pay-escape-hatch-engine-archives',
        why: `${R} 6.5 'The escape hatch' (one release may carry its engine archives in the update file; release 1 stages whatever the payload lists, no frozen change) and 2.4 'group' (a label, never interpreted): four engine archives in per-system groups`,
        payloadObject: payload({ files }),
        expect: accepted({ files })
      })
    )
  }
  {
    const files = SMALL_FILES.map((e, i) => (i === 0 ? { ...e, group: 'win32-x64' } : i === 1 ? { ...e, group: 'posix scripts' } : e)).concat([
      { name: 'models-de.tar', size: 2048, sha256: H('models de'), group: 'Modelle f\u{fc}r Deutsch' },
      { name: 'content-2028.tar', size: 4096, sha256: H('content 2028'), group: 'content-2028' }
    ])
    payloadVectors.push(
      simple({
        id: 'pos-pay-group-labels-of-later-shapes',
        why: `${R} 2.4 'group' (a string of at least one character, compared code unit for code unit and never interpreted) and the group bullet (one payload serves the full and the per-system files): group labels that are no system names, with a space and non-ASCII characters`,
        payloadObject: payload({ files }),
        expect: accepted({ files })
      })
    )
  }
}

// ================================================================================================
// vectors-drive.json: the drive's app_version cases that accept (record section 2.5)
// ================================================================================================

const driveVectors = []
{
  const cases = [
    ['pos-drive-stale-version-above-no-app-carries-it', '1.6.0', [ROOT_RUNNING[0], ROOT_RUNNING[1]], true, `the drive says 1.6.0, above the file, and no root app carries it: stale, treated as absent`],
    ['pos-drive-stale-version-only-a-junk-named-app', '1.6.0', [rootApp('HilbertRaum-junk-portable.exe', 'file', 'win32', null)], true, `a root file of no known version keeps no constraint: stale`],
    ['pos-drive-stale-version-empty-root', '9.0.0', [], true, `no app at the root: stale`],
    ['pos-drive-stale-version-carrier-is-its-pre-release', '1.6.0', [rootApp('HilbertRaum-1.6.0-rc.1-portable.exe', 'file', 'win32', '1.6.0-rc.1')], true, `a root app carries 1.6.0-rc.1, not 1.6.0 byte for byte: stale`],
    ['pos-drive-version-counts-equal-file-lagging-system', CANDIDATE, [rootApp(`HilbertRaum-${RUNNING}-portable.exe`, 'file', 'win32', RUNNING), rootApp(`HilbertRaum-${CANDIDATE}-mac-arm64.app.zip`, 'file', 'darwin', CANDIDATE)], false, `the macOS app already carries 1.5.0, the Windows app lags at 1.4.2: the drive's version counts and the file equals it (not below)`],
    ['pos-drive-version-counts-app-folder-equal-file', CANDIDATE, [ROOT_RUNNING[0], rootApp('HilbertRaum.app', 'folder', 'darwin', null)], false, `a root *.app folder keeps the drive's version: it counts and the file equals it`],
    ['pos-drive-version-counts-root-not-listed', RUNNING, null, false, `the root could not be listed: the floor 1.4.2 stays, the file is above it`],
    ['pos-drive-version-counts-below-file', RUNNING, ROOT_RUNNING, false, `every root app carries 1.4.2: it counts, and the file is above it`]
  ]
  for (const [id, drive, apps, stale, note] of cases) {
    driveVectors.push(
      simple({
        id,
        why: `${R} 2.5 'Which app_version counts' and 'The answer' (accepted above the running version and, where an app_version counts, not below it; a stale one is treated as absent, with the flag staleDriveVersion) and 2.10 'The flags': ${note}`,
        host: host({ driveAppVersion: drive, rootApps: apps }),
        expect: accepted({ flags: { staleDriveVersion: stale } })
      })
    )
  }
}

// ================================================================================================
// vectors-release.json: a release's payload of the shape record section 9.3 says the release tools write
// ================================================================================================

const releaseVectors = []
{
  /** Every member of a full update file but the envelope (record section 2.4 files[] bullet, section 9.3 step 1). */
  const releaseFiles = (v) => [
    { name: `HilbertRaum-${v}-portable.exe`, size: 178257920, sha256: H(`exe ${v}`), group: 'win32', role: 'app' },
    { name: `HilbertRaum-${v}-mac-arm64.app.zip`, size: 193847301, sha256: H(`zip ${v}`), group: 'darwin', role: 'app' },
    { name: `HilbertRaum-${v}.AppImage`, size: 162529280, sha256: H(`appimage ${v}`), group: 'linux', role: 'app' },
    { name: 'apply.cmd', size: 38912, sha256: H(`apply.cmd ${v}`), role: 'apply-script' },
    { name: 'apply.sh', size: 41233, sha256: H(`apply.sh ${v}`), role: 'apply-script' },
    { name: 'Start-HilbertRaum.cmd', size: 6144, sha256: H(`start cmd ${v}`), group: 'win32', install_as: 'Start HilbertRaum.cmd', role: 'start-file' },
    { name: 'Start-HilbertRaum.command', size: 5377, sha256: H(`start command ${v}`), group: 'darwin', install_as: 'Start HilbertRaum.command', role: 'start-file' },
    { name: 'start-hilbertraum.sh', size: 5940, sha256: H(`start sh ${v}`), group: 'linux', role: 'start-file' },
    { name: 'READ-ME-FIRST.txt', size: 3210, sha256: H(`read me ${v}`), install_as: 'READ ME FIRST.txt', role: 'notice' }
  ]
  const releasePayload = (v, min) => ({
    format: 1,
    product: 'hilbertraum',
    kind: 'release',
    channel: 'stable',
    version: v,
    min_upgrade_from: min,
    issued: ISSUED,
    requires: FLOORS,
    summary: { ...SUMMARY },
    engine: { 'llama.cpp': 'b12840', whisper: 'v1.8.2' },
    engine_min: 'b12110',
    files: releaseFiles(v)
  })
  const ROOT_MAC_FOLDER = [ROOT_RUNNING[0], rootApp('HilbertRaum.app', 'folder', 'darwin', null), ROOT_RUNNING[2]]
  for (const [system, h, lang, apps, others] of [
    ['win32', {}, 'de', ROOT_RUNNING, [{ system: 'darwin', floor: FLOORS.darwin }, { system: 'linux', floor: FLOORS.linux }]],
    ['darwin', MAC, 'fr', ROOT_MAC_FOLDER, [{ system: 'win32', floor: FLOORS.win32 }, { system: 'linux', floor: FLOORS.linux }]],
    ['linux', LINUX, 'uk', ROOT_RUNNING, [{ system: 'win32', floor: FLOORS.win32 }, { system: 'darwin', floor: FLOORS.darwin }]]
  ]) {
    const p = releasePayload(CANDIDATE, '1.0.0')
    releaseVectors.push(
      simple({
        id: `pos-release-full-update-file-on-${system}`,
        why: `${R} 9.3 step 1 (the payload's files[] lists every member: the three apps, the apply scripts and the start files) and 2.4 (group, install_as, requires, summary, issued, min_upgrade_from; the engine fields ignored) and 4.4 (member names) and 5.2 (apply.cmd and apply.sh by name): a full release 1.5.0 over a Kit on 1.4.2, on ${system}, read in ${lang}`,
        payloadObject: p,
        host: host({ ...h, uiLanguage: lang, rootApps: apps, driveAppVersion: RUNNING }),
        expect: accepted({ summary: SUMMARY[lang], files: p.files, flags: { otherSystemFloors: others } })
      })
    )
  }
  {
    const p = releasePayload('1.4.3', '1.4.0')
    releaseVectors.push(
      simple({
        id: 'pos-release-fix-line-patch',
        why: `${R} 9.6 (the fix line: security fixes on an older line) and 2.5 'The answer' and 2.4 'min_upgrade_from' (met): a patch 1.4.3 over the running 1.4.2, min_upgrade_from 1.4.0`,
        payloadObject: p,
        host: host({ uiLanguage: 'it', rootApps: ROOT_RUNNING, driveAppVersion: RUNNING }),
        expect: accepted({ version: '1.4.3', summary: SUMMARY.it, files: p.files, flags: { otherSystemFloors: [{ system: 'darwin', floor: FLOORS.darwin }, { system: 'linux', floor: FLOORS.linux }] } })
      })
    )
  }
  {
    // The routine release signed by the active key, and in a second offline session by the standby key.
    const [active, standby, succession] = [newKey(), newKey(), newKey()]
    const p = releasePayload(CANDIDATE, '1.0.0')
    const bytes = Buffer.from(JSON.stringify(p), 'utf8')
    releaseVectors.push(
      vector({
        id: 'pos-release-signed-by-active-and-standby',
        why: `${R} 2.1 (three embedded keys, any one signs alone) and 9.3 step 2 (a second offline session adds a signature) and 2.3 'Verification': the full release with the active key's and the standby key's signatures, three keys embedded`,
        keys: [active, standby, succession],
        parts: [textPart(envelopeText({ payloadBytes: bytes, entries: [edEntry(active, pae(RELEASE_TYPE, bytes)), edEntry(standby, pae(RELEASE_TYPE, bytes))] }))],
        host: host({ uiLanguage: 'nl', rootApps: ROOT_RUNNING, driveAppVersion: RUNNING }),
        expect: accepted({ summary: SUMMARY.nl, files: p.files, flags: { otherSystemFloors: [{ system: 'darwin', floor: FLOORS.darwin }, { system: 'linux', floor: FLOORS.linux }] } })
      })
    )
  }
}

// ================================================================================================
// vectors-largest.json: every bound at its largest legal value in one file (record section 2.3, 2.4, 2.7, 4.3, 4.4)
// ================================================================================================

const largestVectors = []
{
  const version = `1.5.0-preview.${'z'.repeat(50)}`
  const files = []
  files.push({ name: `HilbertRaum-content-${'q'.repeat(75)}.bin`, size: 1, sha256: H('largest 0'), group: 'content' })
  files.push({ name: 'model-weights-q8.gguf', size: 8589934591, sha256: H('largest 1'), group: 'models' })
  const groups = ['win32', 'darwin', 'linux', 'content', null]
  for (let i = 2; i < 4096; i++) {
    const e = { name: `pack-${String(i).padStart(4, '0')}.zst`, size: (i * 7919) % 99991, sha256: H(`largest ${i}`) }
    const g = groups[i % 5]
    if (g !== null) e.group = g
    if (i % 512 === 0) e.install_as = `Pack ${i}.zst`
    files.push(e)
  }
  if (files.length !== 4096 || files[0].name.length !== 99 || version.length !== 64) throw new Error('largest')
  const summary = Object.fromEntries([...TEN.map((code) => [code, fit(SUMMARY[code], 400)]), ...Object.entries(LATER_LANGUAGES).map(([code, text]) => [code, fit(text, 400)])])
  const p = {
    format: 1,
    product: 'hilbertraum',
    kind: 'release',
    channel: 'stable',
    version,
    min_upgrade_from: RUNNING,
    issued: ISSUED,
    requires: { ...FLOORS, freebsd: '14.1', win32_arm64: '10.0.22621' },
    summary,
    files
  }
  const keys = Array.from({ length: 16 }, newKey)
  const bytes = Buffer.from(JSON.stringify(p), 'utf8')
  const big = obj([['keyid', 'slh-dsa-sha2-192f:' + H('largest slh key').slice(0, 32)], ['sig', base64(Buffer.alloc(35664, 'SLH'))], ['scheme', 'slh-dsa-sha2-192f']])
  const { parts, length } = repeatedEntries(bytes, big, 63, edEntry(keys[15], pae(RELEASE_TYPE, bytes)))
  largestVectors.push(
    vector({
      id: 'pos-largest-every-bound-at-once',
      why: `${R} 4.3 'Member count' (4,096 entries), 'Size' (8,589,934,591), 4.4 'Length' (99 bytes), 2.4 'version' (64 bytes), 'summary' (ten codes at 400 code points, unknown languages beside), 2.7 (16 keys, the last signs), 2.3 'signatures' (64 entries, 63 of a hash-based scheme's size) and 4.3 'Member 0' (the cap holds a 4,096-entry payload and 64 large signatures), 2.4 'min_upgrade_from' and the policy cap each equal: ${length} bytes in all, on linux, read in tr`,
      keys,
      parts,
      host: host({ ...LINUX, uiLanguage: 'tr', rootApps: ROOT_RUNNING, driveAppVersion: RUNNING, maxVersion: version }),
      expect: accepted({ version, summary: summary.tr, files, flags: { otherSystemFloors: [{ system: 'win32', floor: FLOORS.win32 }, { system: 'darwin', floor: FLOORS.darwin }] } })
    })
  )
}

// ================================================================================================
// self-checks, then write; then the C8 scan of everything written
// ================================================================================================

const FILES = {
  'vectors-envelope.json': envelopeVectors,
  'vectors-payload.json': payloadVectors,
  'vectors-drive.json': driveVectors,
  'vectors-release.json': releaseVectors,
  'vectors-largest.json': largestVectors
}

/** Member 0's bytes from a vector's parts. */
const bytesOf = (v) => Buffer.concat(v.envelope.parts.map((p) => ('text' in p ? Buffer.from(p.text, 'utf8') : Buffer.from(p.repeat.repeat(p.times), 'utf8'))))

/** Decodes either alphabet (for the self-checks only: the vectors' own strings, written above). */
const decode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const ids = new Set()
for (const [file, vectors] of Object.entries(FILES)) {
  for (const v of vectors) {
    if (!/^[a-z0-9-]+$/.test(v.id) || ids.has(v.id)) throw new Error(`${file}: id ${v.id} is not unique or not [a-z0-9-]`)
    ids.add(v.id)
    if (v.expect.code !== 'accepted') throw new Error(`${v.id}: the positive set holds accepted vectors only`)
    if (JSON.stringify(Object.keys(v.host)) !== JSON.stringify(HOST_KEYS)) throw new Error(`${v.id}: host fields`)
    const bytes = bytesOf(v)
    if (bytes.length > 4194304) throw new Error(`${v.id}: over the envelope cap`)
    const env = JSON.parse(bytes.toString('utf8'))
    if (env.payloadType !== RELEASE_TYPE || !Array.isArray(env.signatures) || env.signatures.length > 64) throw new Error(`${v.id}: envelope shape`)
    // The base64 writer agrees with Buffer's for the standard alphabet, on this envelope's payload.
    const payloadBytes = decode(env.payload)
    if (base64(payloadBytes) !== payloadBytes.toString('base64')) throw new Error(`${v.id}: base64 writer`)
    if (base64(payloadBytes, 'url') !== payloadBytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')) throw new Error(`${v.id}: url-safe writer`)
    // Some entry is a real Ed25519 signature by one of the vector's keys over this file's DSSEv1 PAE.
    const message = pae(env.payloadType, payloadBytes)
    const publics = v.keys.map((spki) => createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }))
    const signed = env.signatures.some((e) => typeof e.sig === 'string' && decode(e.sig).length === 64 && publics.some((k) => verify(null, message, k, decode(e.sig))))
    if (!signed) throw new Error(`${v.id}: no entry verifies under its keys`)
  }
}

for (const key of KEYS) key.discard()

/** JSON text with every character above U+007E as a JSON escape, so each file is plain ASCII. */
const BACKSLASH = String.fromCharCode(92)
function asciiJson(value) {
  const s = JSON.stringify(value)
  const out = []
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 0x7e) {
      out.push(s.slice(from, i), `${BACKSLASH}u${c.toString(16).padStart(4, '0')}`)
      from = i + 1
    }
  }
  out.push(s.slice(from))
  return out.join('')
}

mkdirSync(OUT, { recursive: true })
const written = []
for (const [file, vectors] of Object.entries(FILES)) {
  const text = `[\n${vectors.map(asciiJson).join(',\n')}\n]\n`
  const path = join(OUT, file)
  writeFileSync(path, text)
  written.push(path)
}

// ---- the C8 scan (record section 10.7 "No private key")

const PKCS8_HEX = '302e0201' + '00300506032b657004220420'
const PKCS8_BASE64 = 'MC4CAQAw' + 'BQYDK2VwBCIEI'
const PEM_LINE = new RegExp('-----BEGIN(?: [A-Z0-9]+)* PRIVATE' + ' KEY-----')
const JWK_KTY = new RegExp('"k' + 'ty"\\s*:\\s*"OKP"')
const JWK_D = new RegExp('"' + 'd"\\s*:')
const seedForms = SEEDS.flatMap((s) => [s.toString('hex'), s.toString('hex').toUpperCase(), s.toString('base64'), s.toString('base64').slice(0, 43), s.toString('base64url')])
const problems = []
const generatorPath = fileURLToPath(import.meta.url)
for (const path of [...written, generatorPath]) {
  const text = readFileSync(path, 'latin1')
  if (text.toLowerCase().includes(PKCS8_HEX)) problems.push(`${path}: PKCS#8 hex`)
  if (text.includes(PKCS8_BASE64)) problems.push(`${path}: PKCS#8 base64`)
  if (PEM_LINE.test(text)) problems.push(`${path}: a PRIVATE KEY line`)
  if (JWK_KTY.test(text) && JWK_D.test(text)) problems.push(`${path}: a JWK private key`)
  for (const form of seedForms) if (text.includes(form)) problems.push(`${path}: a seed of this run`)
  if (path !== generatorPath) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7e || text[i] === '\r') problems.push(`${path}: not ASCII and LF at ${i}`)
  }
}
// The layers inside the files: every envelope's bytes, its decoded payload and every decoded sig.
for (const vectors of Object.values(FILES)) {
  for (const v of vectors) {
    const bytes = bytesOf(v)
    const env = JSON.parse(bytes.toString('utf8'))
    const layers = [bytes, decode(env.payload), ...env.signatures.filter((e) => typeof e.sig === 'string').map((e) => decode(e.sig))]
    for (const layer of layers) for (const seed of SEEDS) if (layer.indexOf(seed) >= 0) problems.push(`${v.id}: a seed inside its bytes`)
    for (const layer of layers) if (layer.includes(Buffer.from(PKCS8_HEX, 'hex'))) problems.push(`${v.id}: a PKCS#8 start inside its bytes`)
  }
}
SEEDS.length = 0
if (problems.length > 0) {
  console.error(problems.slice(0, 20).join('\n'))
  throw new Error(`the C8 scan found ${problems.length} problems`)
}

const counts = Object.entries(FILES).map(([file, vectors]) => `${file}: ${vectors.length}`)
console.log(`wrote ${written.length} files, ${ids.size} vectors (${counts.join(', ')}); ${KEYS.length} key pairs made, private halves never written; the C8 scan found nothing`)
