import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkBundleKeys,
  findMarker,
  readKeysFile,
  type BundleFile,
  type BundleKeysResult
} from '../../src/main/services/updates/bundle-check'
import { asarFilesUnder, packedArtifact, packedPathExists, PACKED_ENV, writeAsar } from '../helpers/asar-layout'
import { DESKTOP_ROOT, filesUnder, REPO_ROOT } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'

// The release guard (app-update W-3, F-3; T4.3; docs/app-updates.md §2.7, "The release guard's reading"): the key set
// embedded in a build's main bundle equals the keys.json of the tree the build was made from, byte for byte, two empty
// sets included. It only compares: refusing an empty set is the sell gate's and the pre-publish check's (W-33, P5), so a
// dispatch before the key ceremony passes here.
//
// Where each block runs: the synthetic rows, the load row and the scratch-asar rows on every CI leg; the out/main row on
// every CI leg (built before the tests) and locally after `npm run build`; the packed row only where
// HILBERTRAUM_PACKED_ASAR names an app.asar, which release.yml's three build legs set to the one they just packaged
// (packaging.test.ts reads those steps on every PR). So a ci.yml leg shows this file with one skip (the packed row), a
// release.yml build leg with none.
//
// Keys (plan C8, record §2.7): every key below is made here at run time and only its public half is used; nothing is
// committed. Expected ids are computed here with SHA-256 over the SPKI bytes, not read back from the parser.

/** The key-set marker with its colon: fine in a test, never spelled in src/ (record §2.7, "The embedded form"). */
const MARKER = 'hilbertraum-key-set-1:'
const KEYS_JSON = join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'keys.json')
const OUT_MAIN = join(DESKTOP_ROOT, 'out', 'main')

/** A fresh Ed25519 public key: its 44-byte SPKI DER in standard base64 with padding (record §2.7). */
function newKey(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}
const POOL = Array.from({ length: 20 }, newKey)
const [A, B, C, D, E, F] = POOL as [string, string, string, string, string, string]
const idOf = (key: string): string => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')
const setOf = (keys: readonly string[]): string => MARKER + keys.join(',')
const keysJson = (keySet: unknown, extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({ key_set: keySet, ...extra }, null, 2) + '\n', 'utf8')
const file = (path: string, text: string | Buffer): BundleFile => ({ path, bytes: typeof text === 'string' ? Buffer.from(text, 'utf8') : text })
/** A main bundle's text in the form the build writes keys.json's import (out/main/index.mjs: `const key_set = "…";`). */
const bundleText = (keySet: string): string => `const before = 1;\nconst key_set = "${keySet}";\nconst keysJson = {\n  key_set\n};\nexport { keysJson };\n`
const bundle = (keySet: string, path = 'index.mjs'): BundleFile => file(path, bundleText(keySet))
const ok = (keyCount: number, path = 'index.mjs'): BundleKeysResult => ({ ok: true, path, keyCount })
/** A result as one comparable line: `ok`, or the failure (so a red row prints why). */
const verdict = (r: BundleKeysResult): string => (r.ok ? 'ok' : JSON.stringify(r.failure))

describe('checkBundleKeys: the embedded set equals keys.json, byte for byte (record §2.7)', () => {
  it('an empty set on both sides passes (a dispatch build before the key ceremony): ok, 0 keys', () => {
    expect(checkBundleKeys([bundle(MARKER)], keysJson(MARKER))).toEqual(ok(0))
  })

  it.each([3, 16])('%i keys on both sides pass (16: the most a set holds)', (n) => {
    const set = setOf(POOL.slice(0, n))
    expect(checkBundleKeys([bundle(set)], keysJson(set))).toEqual(ok(n))
  })

  const differ = (embedded: readonly string[], committed: readonly string[]): BundleKeysResult => ({
    ok: false,
    failure: { check: 'keys', reason: 'keys-differ', path: 'index.mjs', embeddedIds: embedded.map(idOf), committedIds: committed.map(idOf) }
  })

  it('other keys in the bundle: keys-differ, with both id lists', () => {
    expect(checkBundleKeys([bundle(setOf([D, E, F]))], keysJson(setOf([A, B, C])))).toEqual(differ([D, E, F], [A, B, C]))
  })

  // The embedded form holds no ids, so "wrong key bytes under a right id" is the same place with other bytes.
  it('one bit of one key flipped, still an Ed25519 SPKI: keys-differ', () => {
    const der = Buffer.from(C, 'base64')
    der[43] ^= 1
    const flipped = der.toString('base64')
    expect(checkBundleKeys([bundle(setOf([A, B, flipped]))], keysJson(setOf([A, B, C])))).toEqual(differ([A, B, flipped], [A, B, C]))
  })

  it('the same keys in another order: keys-differ (byte for byte, not as a set)', () => {
    expect(checkBundleKeys([bundle(setOf([C, A, B]))], keysJson(setOf([A, B, C])))).toEqual(differ([C, A, B], [A, B, C]))
  })

  it.each<[string, string[], string[]]>([
    ['the bundle lacks a key', [A, B], [A, B, C]],
    ['the bundle has one key more', [A, B, C], [A, B]],
    ['a filled bundle, an empty keys.json', [A], []],
    ['an empty bundle, a filled keys.json (the first build after the ceremony read from a stale out/)', [], [A, B, C]]
  ])('%s: keys-differ', (_label, embedded, committed) => {
    expect(checkBundleKeys([bundle(setOf(embedded))], keysJson(setOf(committed)))).toEqual(differ(embedded, committed))
  })
})

describe('checkBundleKeys: the marker is found exactly once across out/main, in a code file (record §2.7)', () => {
  const set = setOf([A, B, C])
  const sourceMap = (text: string): string => JSON.stringify({ version: 3, sources: ['../../src/main/services/updates/keys.json'], sourcesContent: [text], mappings: 'AAAA' })
  const repeated = (paths: string[]): BundleKeysResult => ({ ok: false, failure: { check: 'keys', reason: 'marker-repeated', paths } })

  it('twice in one file: marker-repeated, the file named twice', () => {
    const twice = file('index.mjs', `${bundleText(set)}const again = "${set}";\n`)
    expect(checkBundleKeys([twice], keysJson(set))).toEqual(repeated(['index.mjs', 'index.mjs']))
  })

  it('in index.mjs and in a chunk: marker-repeated, both files named', () => {
    expect(checkBundleKeys([bundle(set), bundle(set, 'chunks/keys-a1b2.mjs')], keysJson(set))).toEqual(repeated(['index.mjs', 'chunks/keys-a1b2.mjs']))
  })

  it('in index.mjs and in its .map (a source map with sourcesContent): marker-repeated', () => {
    const map = file('index.mjs.map', sourceMap(`{\n  "key_set": "${set}"\n}\n`))
    expect(checkBundleKeys([bundle(set), map], keysJson(set))).toEqual(repeated(['index.mjs', 'index.mjs.map']))
  })

  it.each<[string, BundleFile[]]>([
    ['no file holds it', [file('index.mjs', 'export {};\n')]],
    ["only the marker's name without its colon (envelope.ts's constant)", [file('index.mjs', `const KEY_SET_MARKER_NAME = "${MARKER.slice(0, -1)}";\n`)]],
    ['no file at all', []]
  ])('%s: marker-not-found', (_label, files) => {
    expect(checkBundleKeys(files, keysJson(set))).toEqual({ ok: false, failure: { check: 'keys', reason: 'marker-not-found' } })
  })

  // Sheet decision 1 (T4.3): a set found only in a file that is not code is a build whose code carries no set. Review
  // R-4: the reason names what is tested (a name that does not end .js, .mjs or .cjs), not only a source map.
  it.each<[string, BundleFile]>([
    ['a .map (the source text, not the code)', file('index.mjs.map', sourceMap(`{\n  "key_set": "${set}"\n}\n`))],
    ['a JSON file', file('keys-1a2b.json', `{"key_set":"${set}"}`)],
    ['a file without an extension', file('chunks/keys', bundleText(set))]
  ])('once, only in %s: marker-not-in-code', (_label, only) => {
    expect(checkBundleKeys([file('index.mjs', 'export {};\n'), only], keysJson(set))).toEqual({
      ok: false,
      failure: { check: 'keys', reason: 'marker-not-in-code', path: only.path }
    })
  })

  // Review R-4: the extension is compared in any letter case, so `.JS` and `.MJS` name code too.
  it.each(['INDEX.MJS', 'chunks/keys-1a2b.JS', 'chunks/keys-3c4d.Cjs'])('once, in %s (the extension in another letter case): ok', (path) => {
    expect(checkBundleKeys([bundle(set, path)], keysJson(set))).toEqual(ok(3, path))
  })
})

describe("checkBundleKeys: a value either side's parser refuses fails as unreadable, never as a difference", () => {
  const committed = keysJson(setOf([A, B, C]))
  it.each<[string, string, string]>([
    ['a key cut short by one character', setOf([A, B, C.slice(0, -1)]), 'not-base64'],
    ['44 bytes that are no Ed25519 SPKI', setOf([Buffer.alloc(44).toString('base64')]), 'not-ed25519-spki'],
    ['a lone comma', `${MARKER},`, 'not-ed25519-spki'],
    ['17 keys (one more than a set holds)', setOf(POOL.slice(0, 17)), 'too-many'],
    ['a repeated key', setOf([A, A]), 'repeated']
  ])('the bundle holds %s: embedded-unreadable', (_label, embedded, fault) => {
    expect(checkBundleKeys([bundle(embedded)], committed)).toEqual({
      ok: false,
      failure: { check: 'keys', reason: 'embedded-unreadable', path: 'index.mjs', fault }
    })
  })

  // The bundle holds the empty set, so a reader that fell back to an empty set on a damaged keys.json would pass. The
  // record's file readers (§2.7): a byte-order mark, no JSON or a top level that is no object is refused loudly.
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  it.each<[string, Buffer, string]>([
    ['a byte-order mark before a good empty set', Buffer.concat([BOM, keysJson(MARKER)]), 'not-json-object'],
    ['bytes that are not UTF-8', Buffer.concat([Buffer.from(`{"key_set": "${MARKER}", "note": "`), Buffer.from([0xff]), Buffer.from('"}\n')]), 'not-json-object'],
    ['no JSON', Buffer.from(`key_set = "${MARKER}"\n`), 'not-json-object'],
    ['an empty file', Buffer.alloc(0), 'not-json-object'],
    ['a top-level array', Buffer.from(`["${MARKER}"]\n`), 'not-json-object'],
    ['a top-level null', Buffer.from('null\n'), 'not-json-object'],
    ['no key_set field', Buffer.from('{}\n'), 'not-a-string'],
    ['key_set a number', keysJson(1), 'not-a-string'],
    ['another marker', keysJson('hilbertraum-key-set-2:'), 'marker'],
    ['a key that is not canonical base64', keysJson(`${MARKER}AAA`), 'not-base64']
  ])('keys.json holds %s: committed-unreadable', (_label, bytes, fault) => {
    expect(checkBundleKeys([bundle(MARKER)], bytes)).toEqual({ ok: false, failure: { check: 'keys', reason: 'committed-unreadable', fault } })
  })
})

describe('checkBundleKeys: where the embedded value ends, and what else the bundle holds', () => {
  const set = setOf([A, B, C])
  // Review R-1: the literal is the committed string and nothing more, so the same quote stands directly before the
  // marker and directly after the run of value characters, in any of the three quote styles.
  it.each<[string, string]>([
    ['a double quote', `const key_set = "${set}";\n`],
    ['a single quote', `const key_set = '${set}';\n`],
    ['a backtick', `const key_set = \`${set}\`;\n`]
  ])('opened and closed by %s: ok, the run of value characters exactly', (_label, text) => {
    expect(checkBundleKeys([file('index.mjs', text)], keysJson(set))).toEqual(ok(3))
  })

  const notQuoted: BundleKeysResult = { ok: false, failure: { check: 'keys', reason: 'marker-not-quoted', path: 'index.mjs' } }
  /** A backslash, spelled so that no escape sequence stands in this file's text. */
  const BS = String.fromCharCode(0x5c)
  // The string goes on past the run the guard reads, so the running app's string is longer than the committed one:
  // after an escape or a line continuation it holds a third key that keys.json lacks (review R-1's probe); after any
  // other character it is a set the app's own parser refuses, so that build would embed no key at all.
  const two = setOf([A, B])
  it.each<[string, string]>([
    ['an escaped comma (x2c) and a third key', `const key_set = "${two}${BS}x2c${C}";\n`],
    ['an escaped comma (u002c) and a third key', `const key_set = "${two}${BS}u002c${C}";\n`],
    ['a line continuation and a third key', `const key_set = "${two}${BS}\n,${C}";\n`],
    ['a hyphen and a third key', `const key_set = "${two}-${C}";\n`],
    ['a letter outside the value characters', `const key_set = "${two}${String.fromCodePoint(0xe9)}${C}";\n`]
  ])('the string runs on past the value with %s: marker-not-quoted', (_label, text) => {
    expect(checkBundleKeys([file('index.mjs', text)], keysJson(two))).toEqual(notQuoted)
  })

  it.each<[string, string]>([
    ['another quote than the opening double quote', `const key_set = "${set}';\n`],
    ['another quote than the opening single quote', `const key_set = '${set}\`;\n`],
    ['another quote than the opening backtick', `const key_set = \`${set}";\n`],
    ['an escaped quote (a JSON.parse string)', `const keysJson = JSON.parse("{\\"key_set\\":\\"${set}\\"}");\n`],
    ['a line end, no closing quote', `const key_set = "${set}\nexport {};\n`],
    ['the end of the file, no closing quote', `const key_set = "${set}`]
  ])('the value is followed by %s: marker-not-quoted', (_label, text) => {
    expect(checkBundleKeys([file('index.mjs', text)], keysJson(set))).toEqual(notQuoted)
  })

  it.each<[string, string]>([
    ['a parenthesis (no quote at all)', `use(${set});\n`],
    ['another character inside the string', `const key_set = "x${set}";\n`],
    ['nothing (the file starts with the marker)', `${set}";\n`]
  ])('the marker is preceded by %s: marker-not-quoted', (_label, text) => {
    expect(checkBundleKeys([file('index.mjs', text)], keysJson(set))).toEqual(notQuoted)
  })

  // Review R-2: a set that stands only in a comment without quotes fails. A quoted copy in a comment or inside another
  // string passes (the guard reads bytes and does not parse JavaScript: the recorded limit of its bounded claim, record
  // §2.7 "The release guard's reading"); these rows hold the unquoted form only.
  it.each<[string, string, string]>([
    ['a line comment', `// ${set}\nexport {};\n`, set],
    ['a line comment at the end of the file', `// ${set}`, set],
    ['a block comment, the empty set on both sides', `/* ${MARKER} */ export {};\n`, MARKER]
  ])('the set stands only in %s: marker-not-quoted', (_label, text, committed) => {
    expect(checkBundleKeys([file('index.mjs', text)], keysJson(committed))).toEqual(notQuoted)
  })

  it('keys.json with a field of its own beside key_set (a fork may add one): ok', () => {
    expect(checkBundleKeys([bundle(set)], keysJson(set, { note: 'a fork' }))).toEqual(ok(3))
  })

  it('another file with multibyte UTF-8, a look-alike colon and bytes that are no UTF-8: no false hit, no throw', () => {
    const odd = file(
      'chunks/text-9f8e.mjs',
      Buffer.concat([
        Buffer.from(`const s = "${String.fromCodePoint(0xfc, 0x1f600)}"; // ${MARKER.slice(0, -1)}${String.fromCodePoint(0xff1a)}${A}\n`, 'utf8'),
        Buffer.from([0xff, 0xfe, 0x80, 0x00, 0xc3])
      ])
    )
    expect(checkBundleKeys([odd, bundle(set)], keysJson(set))).toEqual(ok(3))
  })
})

describe('findMarker and readKeysFile, the parts P5 and T6.4a reuse', () => {
  const digit = (b: number): boolean => b >= 0x30 && b <= 0x39
  // Offsets counted by hand: `xx m:12;m:3` holds `m:` at bytes 3 and 8.
  it('findMarker: every occurrence, in file order, with its offset and the run of value bytes after it', () => {
    expect(findMarker([file('a.mjs', 'xx m:12;m:3'), file('b.mjs', 'none'), file('c.mjs', 'm:')], 'm:', digit)).toEqual([
      { path: 'a.mjs', offset: 3, value: '12' },
      { path: 'a.mjs', offset: 8, value: '3' },
      { path: 'c.mjs', offset: 0, value: '' }
    ])
  })

  it('findMarker: an empty marker finds nothing', () => {
    expect(findMarker([file('a.mjs', 'abc')], '', digit)).toEqual([])
  })

  it('readKeysFile: key_set exactly as written, and its keys in their order with their ids', () => {
    const read = readKeysFile(keysJson(setOf([B, A]), { note: 'ignored' }))
    expect(read.valid ? { value: read.value, ids: read.keys.map((k) => k.id) } : read).toEqual({ value: setOf([B, A]), ids: [idOf(B), idOf(A)] })
  })
})

// P5's release tools load bundle-check.ts through Node's own type stripping (Δ-75 row 4), with P3's sibling-import hook
// (scripts/lib/ts-sibling-imports.mjs): so it imports only envelope.ts and types, no JSON, no `electron`, no `@shared`
// path, and holds only TypeScript that stripping can erase. The typecheck sees none of that; this row loads it so.
describe('bundle-check.ts loads under Node type stripping', () => {
  it('a plain node process with the hook loads it and checks a bundle against a keys.json it writes', () => {
    const url = (...p: string[]): string => JSON.stringify(pathToFileURL(join(...p)).href)
    const script = [
      `const { registerTsSiblingImports } = await import(${url(REPO_ROOT, 'scripts', 'lib', 'ts-sibling-imports.mjs')})`,
      'registerTsSiblingImports()',
      `const m = await import(${url(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'bundle-check.ts')})`,
      "const { generateKeyPairSync } = await import('node:crypto')",
      `const set = ${JSON.stringify(MARKER)} + generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')`,
      'const keys = Buffer.from(JSON.stringify({ key_set: set }))',
      "const files = [{ path: 'index.mjs', bytes: Buffer.from('const key_set = ' + JSON.stringify(set) + ';') }]",
      'console.log(JSON.stringify([m.checkBundleKeys(files, keys), m.readKeysFile(keys).valid]))'
    ].join('\n')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: testBudgetMs(60_000)
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('[{"ok":true,"path":"index.mjs","keyCount":1},true]')
  })
})

// The asar adapter the packed row reads through (tests/helpers/asar-layout.ts): a scratch app.asar written with the
// @electron/asar writer electron-builder packs with, in a test temp folder (never under out/, which the out/main row reads).
describe('asarFilesUnder: the files under out/main of an app.asar', () => {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-bundle-check-'))
  const main = Buffer.from(`const key_set = "${MARKER}";\n`)
  const sub = Buffer.from('export const x = 1;\n')

  it('exactly the files under out/main with their bytes, paths /-separated; another folder is not read', async () => {
    const asar = join(root, 'files.asar')
    await writeAsar(asar, [
      { path: 'package.json', bytes: Buffer.from('{}') },
      { path: 'out/main/index.mjs', bytes: main },
      { path: 'out/main/sub/c.mjs', bytes: sub },
      { path: 'out/renderer/x.js', bytes: Buffer.from(`"${MARKER}"`) }
    ])
    const files = asarFilesUnder(asar, 'out/main')
    expect(files).toEqual([
      { path: 'index.mjs', bytes: main },
      { path: 'sub/c.mjs', bytes: sub }
    ])
    expect(checkBundleKeys(files, keysJson(MARKER))).toEqual(ok(0))
    expect(() => asarFilesUnder(asar, 'out/preload')).toThrow(/no folder out\/preload/)
  })

  // An unpacked file sits outside the archive and its integrity hash (electron-builder.yml's asarUnpack comment, #562).
  it('an unpacked file under out/main fails loudly', async () => {
    const asar = join(root, 'unpacked.asar')
    await writeAsar(asar, [
      { path: 'out/main/index.mjs', bytes: main },
      { path: 'out/main/sub/c.mjs', bytes: sub, unpacked: true }
    ])
    expect(() => asarFilesUnder(asar, 'out/main')).toThrow(/out\/main\/sub\/c\.mjs is unpacked/)
  })

  it('a link under out/main fails loudly', async () => {
    const asar = join(root, 'link.asar')
    await writeAsar(asar, [
      { path: 'out/main/index.mjs', bytes: main },
      { path: 'out/main/again.mjs', link: 'index.mjs' }
    ])
    expect(() => asarFilesUnder(asar, 'out/main')).toThrow(/out\/main\/again\.mjs is a link/)
  })
})

// The build this checkout last made: every file under out/main (chunks and any .map included; never out/, where the
// tools' build holds a copy of keys.json of its own, CF-48) against this checkout's keys.json. CI builds before it tests,
// so there it cannot skip (the CODE-46 / AUD-18 idiom of csp-build-output.test.ts). Locally it reads whatever build is in
// out/, which may be older than the source: run `npm run build` first.
const built = existsSync(join(OUT_MAIN, 'index.mjs'))
describe('the main bundle in out/main', () => {
  it.skipIf(!built)("embeds this checkout's keys.json once, byte for byte", () => {
    const files = filesUnder(OUT_MAIN, /./).map((p) => file(relative(OUT_MAIN, p).split(sep).join('/'), readFileSync(p)))
    expect(files.map((f) => f.path)).toContain('index.mjs')
    expect(verdict(checkBundleKeys(files, readFileSync(KEYS_JSON)))).toBe('ok')
  })

  it('CI built out/main before the tests, so the row above ran', () => {
    if (process.env.CI) expect(built).toBe(true)
  })
})

// release.yml's build-win, build-mac and build-linux each name the app.asar they just packaged (packaging.test.ts reads the
// three steps). A named file that is missing fails here, never skips.
const packed = packedArtifact().asar
describe('the packed app.asar a release build leg names', () => {
  it.skipIf(packed === undefined)(`its out/main embeds this checkout's keys.json once, byte for byte (${PACKED_ENV.asar})`, () => {
    expect(packedPathExists(packed), `${PACKED_ENV.asar} names ${packed}`).toBe(true)
    const files = asarFilesUnder(packed!, 'out/main')
    expect(files.map((f) => f.path)).toContain('index.mjs')
    expect(verdict(checkBundleKeys(files, readFileSync(KEYS_JSON)))).toBe('ok')
  })
})
