import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkBundleBuildDate,
  checkBundleKeys,
  findMarker,
  occurrences,
  readKeysFile,
  type BundleBuildDateResult,
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
//
// T6.4a adds the build date (record §5.10, "The guard's build-date check"; CF-48 (3)): the release commit's committer
// date, git's %cI written as UTC to the second, stands exactly once in the main bundle, in a code file, as one quoted
// literal. The packed row checks both; the out/main row checks the keys only, since a developer's tree with changes
// builds no date (record §5.10, "The build-date step").

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

// ---- the build date (T6.4a; record §5.10, "The guard's build-date check")

/** The date in the form the build writes the build-date file's import (`const commit_date = "…";`). */
const DATE = '2027-03-15T09:30:00Z'
/** git's %cI for that instant, as a committer in UTC+01:00 has it. */
const COMMITTED = '2027-03-15T10:30:00+01:00'
const dateText = (literal: string): string => `const before = 1;\nconst commit_date = ${literal};\nconst buildDate = {\n  commit_date\n};\nexport { buildDate };\n`
const dated = (date = DATE, path = 'index.mjs'): BundleFile => file(path, dateText(`"${date}"`))
const dateOk = (date = DATE, path = 'index.mjs'): BundleBuildDateResult => ({ ok: true, path, date })
/** A result as one comparable line: `ok`, or the failure (so a red row prints why). */
const dateVerdict = (r: BundleBuildDateResult): string => (r.ok ? 'ok' : JSON.stringify(r.failure))

describe("checkBundleBuildDate: the expected text is the release commit's %cI as UTC to the second (record §5.10)", () => {
  it('the date in the bundle and the committer date in UTC+01:00: ok, the UTC text', () => {
    expect(checkBundleBuildDate([dated()], COMMITTED)).toEqual(dateOk())
  })

  // Written by hand: the offset is subtracted, across an hour, a day, a year and a leap day.
  it.each<[string, string, string]>([
    ['an offset of +00:00', '2027-03-15T09:30:00+00:00', DATE],
    ['a Z', '2027-03-15T09:30:00Z', DATE],
    ['an offset of -05:30', '2027-03-15T04:00:00-05:30', DATE],
    ['a positive offset past midnight', '2027-03-16T01:15:00+14:00', '2027-03-15T11:15:00Z'],
    ['a negative offset into the next year', '2027-12-31T23:30:00-01:00', '2028-01-01T00:30:00Z'],
    ['a negative offset onto a leap day', '2028-02-28T23:00:00-02:00', '2028-02-29T01:00:00Z']
  ])('%s: %s is %s', (_label, committed, utc) => {
    expect(checkBundleBuildDate([dated(utc)], committed)).toEqual(dateOk(utc))
  })

  // No release date can be looked for: the check fails first, whatever the bundle holds.
  it.each<[string, string]>([
    ['nothing', ''],
    ['no date', 'not a date'],
    ['no zone', '2027-03-15T10:30:00'],
    ["git's %ci form", '2027-03-15 10:30:00 +0100'],
    ['a trailing line end (the caller trims)', `${COMMITTED}\n`],
    ['a fraction of a second', '2027-03-15T10:30:00.000+01:00'],
    ['30 February', '2027-02-30T10:30:00+01:00'],
    ['hour 24', '2027-03-15T24:00:00+00:00'],
    ['an offset of +01:60', '2027-03-15T10:30:00+01:60'],
    ['a time in 1999', '1999-12-31T23:59:59+00:00'],
    ['a time in 2000 that is 1999 in UTC', '2000-01-01T00:30:00+01:00'],
    // T6.4a review B (uncovered): every bound of the real local time and of the UTC year.
    ['an offset of +24:00', '2027-03-15T10:30:00+24:00'],
    ['minute 60', '2027-03-15T10:60:00+01:00'],
    ['second 60', '2027-03-15T10:30:60+01:00'],
    ['month 00', '2027-00-15T10:30:00+01:00'],
    ['month 13', '2027-13-15T10:30:00+01:00'],
    ['day 00', '2027-03-00T10:30:00+01:00'],
    ['a time in 9999 that is 10000 in UTC', '9999-12-31T23:59:59-00:01']
  ])('%s: expected-unreadable', (_label, committed) => {
    expect(checkBundleBuildDate([dated()], committed)).toEqual({ ok: false, failure: { check: 'build-date', reason: 'expected-unreadable' } })
  })
})

describe('checkBundleBuildDate: the date is found exactly once across out/main, in a code file, quoted (record §5.10)', () => {
  const failure = (reason: string, extra: Record<string, unknown> = {}): BundleBuildDateResult =>
    ({ ok: false, failure: { check: 'build-date', reason, expected: DATE, ...extra } }) as BundleBuildDateResult

  // A build that has no release date (a tree with changes) embeds null: the guard stops on the safe side.
  it.each<[string, BundleFile[]]>([
    ['the build embeds null (no release date)', [file('index.mjs', dateText('null'))]],
    ['the build embeds another date', [dated('2027-03-15T09:30:01Z')]],
    ['the date only without its Z', [file('index.mjs', dateText(`"${DATE.slice(0, -1)}"`))]],
    ['no file at all', []]
  ])('%s: date-not-found', (_label, files) => {
    expect(checkBundleBuildDate(files, COMMITTED)).toEqual(failure('date-not-found'))
  })

  it.each<[string, BundleFile[], string[]]>([
    ['twice in one file', [file('index.mjs', `${dateText(`"${DATE}"`)}const again = "${DATE}";\n`)], ['index.mjs', 'index.mjs']],
    ['in index.mjs and in a chunk', [dated(), dated(DATE, 'chunks/date-a1b2.mjs')], ['index.mjs', 'chunks/date-a1b2.mjs']],
    ['in index.mjs and in its .map', [dated(), file('index.mjs.map', JSON.stringify({ version: 3, sourcesContent: [`{"commit_date":"${DATE}"}\n`] }))], ['index.mjs', 'index.mjs.map']]
  ])('%s: date-repeated, each occurrence named', (_label, files, paths) => {
    expect(checkBundleBuildDate(files, COMMITTED)).toEqual(failure('date-repeated', { paths }))
  })

  it.each<[string, BundleFile]>([
    ['a .map', file('index.mjs.map', JSON.stringify({ version: 3, sourcesContent: [`{"commit_date":"${DATE}"}\n`] }))],
    ['a JSON file', file('build-date-1a2b.json', `{"commit_date":"${DATE}"}\n`)],
    ['a file without an extension', file('chunks/date', dateText(`"${DATE}"`))]
  ])('once, only in %s: date-not-in-code', (_label, only) => {
    expect(checkBundleBuildDate([file('index.mjs', 'export {};\n'), only], COMMITTED)).toEqual(failure('date-not-in-code', { path: only.path }))
  })

  it.each(['INDEX.MJS', 'chunks/date-1a2b.JS', 'chunks/date-3c4d.Cjs'])('once, in %s (the extension in another letter case): ok', (path) => {
    expect(checkBundleBuildDate([dated(DATE, path)], COMMITTED)).toEqual(dateOk(DATE, path))
  })

  it.each<[string, string]>([
    ['a double quote', `"${DATE}"`],
    ['a single quote', `'${DATE}'`],
    ['a backtick', `\`${DATE}\``]
  ])('opened and closed by %s: ok', (_label, literal) => {
    expect(checkBundleBuildDate([file('index.mjs', dateText(literal))], COMMITTED)).toEqual(dateOk())
  })

  // The string the app reads must be the 20 characters and nothing more (the key check's rule, review R-1).
  it.each<[string, string]>([
    ['another quote at its end', `const commit_date = "${DATE}';\n`],
    ['the escaped quotes of a JSON.parse string', `const buildDate = JSON.parse("{\\"commit_date\\":\\"${DATE}\\"}");\n`],
    ['a character after it inside the string', `const commit_date = "${DATE}0";\n`],
    ['a character before it inside the string', `const commit_date = "x${DATE}";\n`],
    ['no quote at all (a comment)', `// built ${DATE}\nexport {};\n`],
    ['the same character on both sides that is no quote', `/* ${DATE} */ export {};\n`],
    ['the start of the file', `${DATE}";\n`],
    ['the end of the file', `const commit_date = "${DATE}`]
  ])('the date with %s: date-not-quoted', (_label, text) => {
    expect(checkBundleBuildDate([file('index.mjs', text)], COMMITTED)).toEqual(failure('date-not-quoted', { path: 'index.mjs' }))
  })

  it('a bundle holding the key set and the date passes both checks, each on its own literal', () => {
    const both = file('index.mjs', `${bundleText(MARKER)}${dateText(`"${DATE}"`)}`)
    expect({ keys: verdict(checkBundleKeys([both], keysJson(MARKER))), date: dateVerdict(checkBundleBuildDate([both], COMMITTED)) }).toEqual({ keys: 'ok', date: 'ok' })
  })
})

describe('findMarker and readKeysFile, the parts P5 and T6.4a reuse', () => {
  const digit = (b: number): boolean => b >= 0x30 && b <= 0x39

  // CF-48 (3): the occurrence reader, exported with the byte before each hit and the byte after its run; -1 at the
  // file's start or end. Offsets counted by hand: `"m:12" m:` holds `m:` at bytes 1 and 7.
  it('occurrences: each hit with the byte before it and the byte after its run, -1 at either end of the file', () => {
    expect(occurrences([file('a.mjs', '"m:12" m:')], 'm:', digit)).toEqual([
      { path: 'a.mjs', offset: 1, value: '12', before: 0x22, after: 0x22 },
      { path: 'a.mjs', offset: 7, value: '', before: 0x20, after: -1 }
    ])
    expect(occurrences([file('b.mjs', 'm:')], 'm:', digit)).toEqual([{ path: 'b.mjs', offset: 0, value: '', before: -1, after: -1 }])
  })

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

/**
 * git's %cI of HEAD in `dir`, as the packed row below reads it for its expected date: the commit's own date, whatever a
 * replace ref or a log.showSignature setting says (git's --no-replace-objects and --no-show-signature, as the build step;
 * record §5.10, "The guard's build-date check"; T6.4a review B m-2, m-3).
 */
function releaseCommitDate(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', ['--no-replace-objects', '-C', dir, 'log', '-1', '--no-show-signature', '--format=%cI'], { encoding: 'utf8', env }).trim()
}

// The packed row's expected date runs only on a release leg, so its git call is held here on throw-away repositories
// (no global or system git configuration; no key of any kind: the signature header is made-up text in SSH armour, for
// which git finds no allowed signers and starts no program).
describe("the packed row's release commit date is the commit's own (record §5.10, \"The guard's build-date check\")", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hilbertraum-bundle-check-git-'))
  writeFileSync(join(scratch, 'gitconfig'), '')
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name]
  const IDENT = 'bundle-check-test <bundle-check-test@example.invalid>'
  const gitIn = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, input?: string): string =>
    execFileSync('git', ['-c', `user.name=bundle-check-test`, '-c', 'user.email=bundle-check-test@example.invalid', ...args], {
      cwd,
      env: { ...env, GIT_COMMITTER_DATE: COMMITTED, GIT_AUTHOR_DATE: COMMITTED, ...extra },
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
  /** A repository with one commit dated COMMITTED. */
  const repo = (label: string): string => {
    const dir = mkdtempSync(join(scratch, `${label}-`))
    writeFileSync(join(dir, 'README.md'), 'one\n')
    gitIn(dir, ['init', '-q'])
    gitIn(dir, ['add', '-A'])
    gitIn(dir, ['commit', '-q', '-m', 'one'])
    return dir
  }

  it("a replace ref on HEAD (another commit, dated 2031): the commit's own %cI", () => {
    const dir = repo('replace')
    const head = gitIn(dir, ['rev-parse', 'HEAD']).trim()
    const other = gitIn(dir, ['commit-tree', `${head}^{tree}`, '-m', 'other'], { GIT_COMMITTER_DATE: '2031-01-01T00:00:00+00:00' }).trim()
    gitIn(dir, ['replace', head, other])
    expect(releaseCommitDate(dir, env)).toBe(COMMITTED)
  })

  it('log.showSignature and a HEAD whose commit carries a signature header: the %cI alone, no other line', () => {
    const dir = repo('signed')
    const tree = gitIn(dir, ['rev-parse', 'HEAD^{tree}']).trim()
    const commit = [
      `tree ${tree}`,
      `author ${IDENT} 1805103000 +0100`,
      `committer ${IDENT} 1805103000 +0100`,
      'gpgsig -----BEGIN SSH SIGNATURE-----',
      ' bWFkZS11cCB0ZXh0LCBubyBrZXk=',
      ' -----END SSH SIGNATURE-----',
      '',
      'signed',
      ''
    ].join('\n')
    gitIn(dir, ['update-ref', 'HEAD', gitIn(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'], {}, commit).trim()])
    gitIn(dir, ['config', 'log.showSignature', 'true'])
    gitIn(dir, ['config', 'gpg.ssh.program', join(scratch, 'no-such-program').split(sep).join('/')])
    expect(releaseCommitDate(dir, env)).toBe(COMMITTED)
  })
})

// release.yml's build-win, build-mac and build-linux each name the app.asar they just packaged (packaging.test.ts reads the
// three steps). A named file that is missing fails here, never skips. T6.4a: the same row checks the build date against
// this checkout's release commit (record §5.10, "The guard's build-date check"): git's %cI of HEAD, read here
// (releaseCommitDate, above), apart from the build step's own reading (%ct). A leg whose tree a step changed before the
// build embeds null and fails here with date-not-found; the leg's git status line before its build shows why.
const packed = packedArtifact().asar
describe('the packed app.asar a release build leg names', () => {
  it.skipIf(packed === undefined)(`its out/main embeds this checkout's keys.json once, byte for byte, and its release commit's date once (${PACKED_ENV.asar})`, () => {
    expect(packedPathExists(packed), `${PACKED_ENV.asar} names ${packed}`).toBe(true)
    const files = asarFilesUnder(packed!, 'out/main')
    expect(files.map((f) => f.path)).toContain('index.mjs')
    const committed = releaseCommitDate(DESKTOP_ROOT)
    expect({ keys: verdict(checkBundleKeys(files, readFileSync(KEYS_JSON))), date: dateVerdict(checkBundleBuildDate(files, committed)) }).toEqual({
      keys: 'ok',
      date: 'ok'
    })
  })
})
