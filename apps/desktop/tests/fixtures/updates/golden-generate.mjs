// The generator of the golden update file (app-update task T6.0b; docs/app-updates.md §2.3, §2.4, §4.3, §4.4).
//
//   node golden-generate.mjs --out <an empty or new folder>
//
// It writes golden.hrupdate (every member), golden-win32-only.hrupdate (the same envelope, without the groups `posix`,
// `darwin` and `linux`: a per-system file) and golden-keys.json (the public key). Plain Node: node:crypto, node:fs and
// node:path only, nothing from the repository, so the file is not the output of the code that reads it.
//
// The key pair is made here, in memory, and its private half is never written, printed or exported: it is used for one
// signature and dropped with the process. So every run makes another key and another signature, and THE COMMITTED FILES
// ARE THE GOLDEN: a new run does not reproduce them (it reproduces every byte but the key id and the signature). The
// generator refuses a folder that holds anything, so no run replaces a committed file.
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ascii = (text) => Buffer.from(text, 'latin1')
const repeated = (line, size) => Buffer.alloc(size, ascii(line))

// ---- the members (every byte is stated here; none is a program) -----------------------------------------------------
const VERSION = '1.2.0'
const members = [
  { name: 'apply.cmd', group: 'win32', role: 'apply', data: ascii('@echo off\r\nrem golden stand-in: it does nothing\r\nexit /b 0\r\n') },
  { name: 'apply.sh', group: 'posix', role: 'apply', data: ascii('#!/bin/sh\n# golden stand-in: it does nothing\nexit 0\n') },
  { name: `HilbertRaum-${VERSION}-portable.exe`, group: 'win32', role: 'app', data: repeated('golden stand-in, not a program\n', 1536) },
  { name: `HilbertRaum-${VERSION}-mac-arm64.app.zip`, group: 'darwin', role: 'app', data: repeated('golden stand-in, not an archive\n', 1000) },
  { name: `HilbertRaum-${VERSION}.AppImage`, group: 'linux', role: 'app', data: repeated('golden stand-in, not an image\n', 513) },
  { name: 'start-hilbertraum.cmd', group: 'win32', role: 'start', install_as: 'Start HilbertRaum.cmd', data: ascii('@echo off\r\nrem golden stand-in for the start file\r\n') },
  { name: 'notes.txt', role: 'doc', data: repeated('A member every file must carry: it has no group.\n', 600) },
  { name: 'zero-bytes.txt', role: 'doc', data: Buffer.alloc(0) }
]
// The order in the file differs from files[] on purpose (§4.3 "Members after member 0": in any order).
const FILE_ORDER = ['notes.txt', `HilbertRaum-${VERSION}.AppImage`, 'apply.sh', 'zero-bytes.txt', `HilbertRaum-${VERSION}-portable.exe`, 'start-hilbertraum.cmd', `HilbertRaum-${VERSION}-mac-arm64.app.zip`, 'apply.cmd']
const WIN32_ONLY_GROUPS = new Set(['win32'])

// ---- the payload (§2.4): its text is written key by key, so its bytes are stated, not a serializer's choice -----------
const entry = (m) =>
  `{"name":${JSON.stringify(m.name)},"size":${m.data.length},"sha256":"${sha256(m.data)}"` +
  (m.group ? `,"group":${JSON.stringify(m.group)}` : '') +
  `,"role":${JSON.stringify(m.role)}` +
  (m.install_as ? `,"install_as":${JSON.stringify(m.install_as)}` : '') +
  '}'
const payloadText =
  '{"format":1,"product":"hilbertraum","kind":"release","channel":"stable"' +
  `,"version":"${VERSION}","issued":"2026-11-27T12:00:00Z"` +
  ',"requires":{"win32":"10.0.19045","darwin":"13.0","linux":"2.31"}' +
  ',"summary":{"en":"A golden test update. It installs nothing.","de":"Ein Test-Update. Es installiert nichts."}' +
  `,"files":[${members.map(entry).join(',')}]}`
const payload = Buffer.from(payloadText, 'utf8')
const PAYLOAD_TYPE = 'application/vnd.hilbertraum.release+json'

// ---- the envelope (§2.3): DSSE, Ed25519 over the PAE ----------------------------------------------------------------
/** DSSEv1 pre-authentication encoding: the counts are byte counts in ASCII decimal. */
const pae = (type, body) => Buffer.concat([ascii(`DSSEv1 ${Buffer.byteLength(type, 'utf8')} `), Buffer.from(type, 'utf8'), ascii(` ${body.length} `), body])

function signedEnvelope() {
  // The one place a private key exists. Nothing in this function writes, logs, exports or returns it.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, pae(PAYLOAD_TYPE, payload), privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return { spki, signature }
}
const { spki, signature } = signedEnvelope()
const keyId = sha256(spki) // a key's id: the lower-case hex sha256 of its SPKI DER
const envelope = Buffer.from(
  `{"payloadType":${JSON.stringify(PAYLOAD_TYPE)},"payload":"${payload.toString('base64')}","signatures":[{"keyid":"${keyId}","sig":"${signature.toString('base64')}"}]}`,
  'utf8'
)

// ---- the container (§4.3, table A.2): the writer's own bytes --------------------------------------------------------
function header(name, size) {
  const h = Buffer.alloc(512)
  const put = (text, at) => void h.write(text, at, 'latin1')
  put(name, 0) // bytes 0–99: the name, then NULs
  put('0000644\0', 100) // mode
  put('0000000\0', 108) // uid
  put('0000000\0', 116) // gid
  put(size.toString(8).padStart(11, '0') + '\0', 124) // size: 11 octal digits, NUL
  put('00000000000\0', 136) // mtime
  put('        ', 148) // the checksum counts its own field as spaces
  put('0', 156) // type
  put('ustar\0', 257) // magic
  put('00', 263) // version
  put('0000000\0', 329) // devmajor
  put('0000000\0', 337) // devminor
  let sum = 0
  for (const byte of h) sum += byte
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148) // 6 octal digits, NUL, space
  return h
}
const member = (name, data) => Buffer.concat([header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)])
const container = (names) =>
  Buffer.concat([member('hilbertraum-release.dsse.json', envelope), ...names.map((name) => member(name, members.find((m) => m.name === name).data)), Buffer.alloc(1024)])

const full = container(FILE_ORDER)
const win32Only = container(FILE_ORDER.filter((name) => { const m = members.find((x) => x.name === name); return !m.group || WIN32_ONLY_GROUPS.has(m.group) }))

// ---- checks on what was made (the public half only) -----------------------------------------------------------------
if (envelope.length > 4194304 || members.length > 4096) throw new Error('over a cap of §4.3')
for (const m of members) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/.test(m.name) || m.name.endsWith('.')) throw new Error(`member name ${m.name}`)
if (new Set(FILE_ORDER).size !== members.length || !FILE_ORDER.every((n) => members.some((m) => m.name === n))) throw new Error('the file order does not list every member once')
if (!verify(null, pae(PAYLOAD_TYPE, payload), createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature)) throw new Error('the signature does not verify')

// ---- write ----------------------------------------------------------------------------------------------------------
const at = process.argv.indexOf('--out')
const out = at > 0 ? process.argv[at + 1] : undefined
if (!out) throw new Error('usage: node golden-generate.mjs --out <an empty or new folder>')
if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty: the committed files are the golden, and no run replaces them`)
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'golden.hrupdate'), full)
writeFileSync(join(out, 'golden-win32-only.hrupdate'), win32Only)
writeFileSync(
  join(out, 'golden-keys.json'),
  JSON.stringify(
    {
      why: 'The public key the golden update files golden.hrupdate and golden-win32-only.hrupdate are signed with (app-update task T6.0b). A test key: its private half was never written anywhere. It must never stand in keys.json, a build or a doc as a real key (docs/app-updates.md §10.7 "No private key"; repo-hygiene.test.ts compares keys.json with it)',
      keys: [spki.toString('base64')],
      keyIds: [keyId]
    },
    null,
    2
  ) + '\n'
)
console.log(`golden.hrupdate ${full.length} bytes sha256 ${sha256(full)}`)
console.log(`golden-win32-only.hrupdate ${win32Only.length} bytes sha256 ${sha256(win32Only)}`)
console.log(`envelope ${envelope.length} bytes, payload ${payload.length} bytes sha256 ${sha256(payload)}, key id ${keyId}`)
