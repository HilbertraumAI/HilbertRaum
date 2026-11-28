// The release guard (app-update W-3, F-3; docs/app-updates.md §2.7, "The release guard's reading"): the key set embedded
// in a build's main bundle equals the `key_set` of the keys.json that build was made from, byte for byte, two empty sets
// included. It only compares. Refusing an empty set is the sell gate's and the pre-publish check's (W-33, P5); a build
// before the key ceremony passes here.
//
// What it reads: the files of one main bundle (every file under out/main, chunks and any .map included), each as its
// path and bytes, and keys.json's bytes. It searches bytes, never decoded text: the marker is ASCII, and in UTF-8 no byte
// of a multibyte character is below 0x80, so a byte search is exact and nothing is decoded that might not decode. The
// one occurrence must stand as one quoted literal (review R-1): the same quote directly before the marker and directly
// after the run of value characters, so the string the app reads at run time is exactly the run that is compared (no
// escape, line continuation or other character can carry it on). A set in a comment without quotes fails; a quoted
// copy in a comment or inside another string passes, the recorded limit of the guard's bounded claim (§2.7 "The
// release guard's reading"). What it does not check: that the files are the whole bundle (the caller lists them),
// that the build is the one that ships (the caller reads the packed app.asar), that the quoted literal is code rather
// than text inside a comment or another string (it searches bytes, it does not parse JavaScript), or what other code
// in the bundle does with keys. A weak key
// (§2.7 "A weak key") is refused by `parseKeySet` on either side, so it fails here as an unreadable set. The JSON.parse("...") form a bundler can write for a JSON import has
// escaped quotes around the value, so it fails here (loudly); this build writes the plain literal.
//
// The marker is taken from keys.json's own value, the part up to its first colon, once the one parser (`parseKeySet`,
// envelope.ts) has accepted that value; no line here spells it. Main never imports this file (it is in no app.asar). The
// release tools load it through Node's own type stripping (with scripts/lib/ts-sibling-imports.mjs), so it imports only
// envelope.ts and types, reads no file and no environment, and holds only TypeScript that stripping can erase.
//
// T6.4a adds the build date (W-17; §5.10, "The guard's build-date check"; CF-48 (3)): `checkBundleBuildDate`, the same
// byte search through the same occurrence reader (now exported, with the byte before and after each hit), for the
// release commit's committer date written as UTC to the second. The caller hands git's `%cI` of the checkout; the UTC
// text is computed here, apart from the build step's own reading (`%ct`). Its bounded claim is the key check's: the
// literal is in the bundle, not what the code makes of it. No marker: the value keeps the file's approved shape.

import { parseKeySet, readJsonObject } from './envelope'
import type { KeySetFault, UpdateKey } from './envelope'

/** One file of a built main bundle: its path below out/main, '/'-separated (`index.mjs`, `chunks/a.mjs`), and its bytes. */
export interface BundleFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** Why keys.json does not read: not one JSON object (a byte-order mark, no strict UTF-8, no JSON, no object), or its set's fault. */
export type KeysFileFault = 'not-json-object' | KeySetFault

export type KeysFileRead =
  | { readonly valid: true; readonly value: string; readonly keys: readonly UpdateKey[] }
  | { readonly valid: false; readonly fault: KeysFileFault }

/**
 * keys.json read as the file readers read it (§2.7, "The file readers"): its bytes through `readJsonObject`, which refuses
 * a leading byte-order mark before it decodes, then the own field `key_set` through `parseKeySet` (a missing field is
 * `not-a-string`). Never read as an empty set when it does not read. `value` is `key_set` exactly as the file holds it.
 * Never throws.
 */
export function readKeysFile(bytes: Uint8Array): KeysFileRead {
  const json = readJsonObject(bytes)
  if (json === null) return { valid: false, fault: 'not-json-object' }
  const keySet: unknown = Object.hasOwn(json, 'key_set') ? json.key_set : undefined
  const read = parseKeySet(keySet)
  return read.valid ? { valid: true, value: String(keySet), keys: read.keys } : { valid: false, fault: read.fault }
}

/** One occurrence of a marker: the file, the byte offset of the marker's first byte, and the run of value bytes after it. */
export interface MarkerHit {
  readonly path: string
  readonly offset: number
  /** The longest run of bytes after the marker that `isValueByte` accepts, one character per byte (latin1). */
  readonly value: string
}

/** A hit with the byte directly before the marker and the byte directly after its run; -1 at the file's start or end. */
export interface Occurrence extends MarkerHit {
  readonly before: number
  readonly after: number
}

/**
 * The occurrence reader (CF-48 (3)): every occurrence of `marker` (its UTF-8 bytes) in every file, in file order and then
 * offset order, each with the longest run of value bytes that follows it, the byte directly before the marker and the
 * byte directly after the run (-1 at the file's start or end). Occurrences may overlap. An empty marker finds nothing.
 * Never throws.
 */
export function occurrences(files: readonly BundleFile[], marker: string, isValueByte: (byte: number) => boolean): Occurrence[] {
  const needle = Buffer.from(marker, 'utf8')
  if (needle.length === 0) return []
  const hits: Occurrence[] = []
  for (const file of files) {
    const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength)
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) {
      let end = at + needle.length
      while (end < bytes.length && isValueByte(bytes[end])) end++
      hits.push({
        path: file.path,
        offset: at,
        value: bytes.toString('latin1', at + needle.length, end),
        before: at > 0 ? bytes[at - 1] : -1,
        after: end < bytes.length ? bytes[end] : -1
      })
    }
  }
  return hits
}

/**
 * Every occurrence of `marker` (its UTF-8 bytes) in every file, in file order and then offset order, each with the longest
 * run of value bytes that follows it. Occurrences may overlap. An empty marker finds nothing. Never throws.
 */
export function findMarker(files: readonly BundleFile[], marker: string, isValueByte: (byte: number) => boolean): readonly MarkerHit[] {
  return occurrences(files, marker, isValueByte).map(({ path, offset, value }) => ({ path, offset, value }))
}

/** The characters of an embedded key set after its marker (§2.7): standard base64 with padding, and the `,` between keys. */
function isKeySetByte(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2f || b === 0x3d || b === 0x2c
}

/**
 * A file the bundle's code runs from, its extension in any letter case; the set's one occurrence must be in one (a
 * `.map` holds the source text, not code).
 */
const CODE_FILE = /\.(?:js|mjs|cjs)$/i

/** The three quotes a JavaScript string literal opens and closes with: `"`, `'` and the backtick. */
const QUOTES: readonly number[] = [0x22, 0x27, 0x60]

/** Why the guard fails. Key ids are public; no key bytes are carried. `check` leaves room for T6.4a's build-date check. */
export type BundleKeysFailure =
  | { readonly check: 'keys'; readonly reason: 'committed-unreadable'; readonly fault: KeysFileFault }
  | { readonly check: 'keys'; readonly reason: 'marker-not-found' }
  | { readonly check: 'keys'; readonly reason: 'marker-repeated'; readonly paths: readonly string[] }
  | { readonly check: 'keys'; readonly reason: 'marker-not-in-code'; readonly path: string }
  | { readonly check: 'keys'; readonly reason: 'marker-not-quoted'; readonly path: string }
  | { readonly check: 'keys'; readonly reason: 'embedded-unreadable'; readonly path: string; readonly fault: KeySetFault }
  | {
      readonly check: 'keys'
      readonly reason: 'keys-differ'
      readonly path: string
      readonly embeddedIds: readonly string[]
      readonly committedIds: readonly string[]
    }

export type BundleKeysResult =
  | { readonly ok: true; readonly path: string; readonly keyCount: number }
  | { readonly ok: false; readonly failure: BundleKeysFailure }

/**
 * The release guard (§2.7, "The release guard's reading"), in this order, the first failure deciding:
 * 1. keys.json must read (`readKeysFile`), else `committed-unreadable`, whatever the bundle holds;
 * 2. the marker (keys.json's value up to and including its first colon) is found across all files together: never is
 *    `marker-not-found`; more than once (two in one file included) is `marker-repeated`, with one path per occurrence;
 * 3. the one occurrence must be in a file whose name ends `.js`, `.mjs` or `.cjs` in any letter case, else
 *    `marker-not-in-code` (sheet decision 1, review R-4: a set found only in a source map, a JSON file or any other file
 *    that is not code is a build whose code carries none; a `.map` is the one other kind of file a main build writes);
 * 4. the byte directly before the marker must be a quote (`"`, `'` or a backtick) and the byte directly after the run of
 *    value characters the same quote, else `marker-not-quoted` (review R-1: anything else there, an escape, a line
 *    continuation, another character, another quote, the start or end of the file, means the string the app reads is
 *    not the run compared below, or that no string holds the set at all, as in a comment);
 * 5. the marker and the run after it must read through `parseKeySet`, else `embedded-unreadable`;
 * 6. that run must equal keys.json's value after the marker, byte for byte (so also in order), else `keys-differ`, with
 *    both id lists.
 * Never throws.
 */
export function checkBundleKeys(files: readonly BundleFile[], committedKeysJson: Uint8Array): BundleKeysResult {
  const fail = (failure: BundleKeysFailure): BundleKeysResult => ({ ok: false, failure })
  const committed = readKeysFile(committedKeysJson)
  if (!committed.valid) return fail({ check: 'keys', reason: 'committed-unreadable', fault: committed.fault })
  const markerEnd = committed.value.indexOf(':') + 1
  const marker = committed.value.slice(0, markerEnd)
  const hits = occurrences(files, marker, isKeySetByte)
  if (hits.length === 0) return fail({ check: 'keys', reason: 'marker-not-found' })
  if (hits.length > 1) return fail({ check: 'keys', reason: 'marker-repeated', paths: hits.map((h) => h.path) })
  const hit = hits[0]
  if (!CODE_FILE.test(hit.path)) return fail({ check: 'keys', reason: 'marker-not-in-code', path: hit.path })
  if (!QUOTES.includes(hit.before) || hit.after !== hit.before) return fail({ check: 'keys', reason: 'marker-not-quoted', path: hit.path })
  const embedded = parseKeySet(marker + hit.value)
  if (!embedded.valid) return fail({ check: 'keys', reason: 'embedded-unreadable', path: hit.path, fault: embedded.fault })
  if (hit.value !== committed.value.slice(markerEnd)) {
    return fail({
      check: 'keys',
      reason: 'keys-differ',
      path: hit.path,
      embeddedIds: embedded.keys.map((k) => k.id),
      committedIds: committed.keys.map((k) => k.id)
    })
  }
  return { ok: true, path: hit.path, keyCount: committed.keys.length }
}

// ---- the build date (T6.4a; §5.10, "The guard's build-date check")

/** git's `%cI`: strict ISO 8601, `YYYY-MM-DDTHH:MM:SS` and then `Z` or an offset `+HH:MM` / `-HH:MM`. */
const COMMITTER_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/

/**
 * git's `%cI` of the release commit written as UTC to the second, `YYYY-MM-DDTHH:MM:SSZ`: a real local time (a day its
 * month has, hour 00-23, minute and second 00-59, an offset of at most 23:59) with its offset taken off, and that UTC
 * time in §2.4's `issued` grammar (a year from 2000 to 9999); else null. Nothing else is accepted: no fraction, no line
 * end (the caller trims git's), no other form.
 */
function expectedBuildDate(committerDate: string): string | null {
  const m = COMMITTER_DATE.exec(committerDate)
  if (m === null) return null
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  const offsetHours = m[8] === undefined ? 0 : Number(m[8])
  const offsetMinutes = m[9] === undefined ? 0 : Number(m[9])
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = month === 2 ? (leap ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return null
  const sign = m[7] === '-' ? -1 : 1
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - sign * (offsetHours * 60 + offsetMinutes) * 60_000)
  const y = utc.getUTCFullYear()
  if (y < 2000 || y > 9999) return null
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${y}-${two(utc.getUTCMonth() + 1)}-${two(utc.getUTCDate())}T${two(utc.getUTCHours())}:${two(utc.getUTCMinutes())}:${two(utc.getUTCSeconds())}Z`
}

/** Why the build-date check fails; `expected` is the UTC text looked for (a date is public). */
export type BundleBuildDateFailure =
  | { readonly check: 'build-date'; readonly reason: 'expected-unreadable' }
  | { readonly check: 'build-date'; readonly reason: 'date-not-found'; readonly expected: string }
  | { readonly check: 'build-date'; readonly reason: 'date-repeated'; readonly expected: string; readonly paths: readonly string[] }
  | { readonly check: 'build-date'; readonly reason: 'date-not-in-code'; readonly expected: string; readonly path: string }
  | { readonly check: 'build-date'; readonly reason: 'date-not-quoted'; readonly expected: string; readonly path: string }

export type BundleBuildDateResult =
  | { readonly ok: true; readonly path: string; readonly date: string }
  | { readonly ok: false; readonly failure: BundleBuildDateFailure }

/**
 * The release guard's build-date check (§5.10, "The guard's build-date check"), over the same files as `checkBundleKeys`
 * (every file under out/main), in this order, the first failure deciding:
 * 1. `committerDate` (git's `%cI` of the checkout's release commit) must give a UTC text (`expectedBuildDate`), else
 *    `expected-unreadable`, whatever the bundle holds;
 * 2. that text is found across all files together: never is `date-not-found` (a build with no release date embeds null,
 *    so it fails here, on the safe side); more than once (two in one file included) is `date-repeated`, one path per
 *    occurrence;
 * 3. the one occurrence must be in a file whose name ends `.js`, `.mjs` or `.cjs` in any letter case, else
 *    `date-not-in-code`;
 * 4. the byte directly before it and the byte directly after its 20 characters must be the same quote (`"`, `'` or a
 *    backtick), else `date-not-quoted` (the string the app reads is then the date and nothing more).
 * Never throws.
 */
export function checkBundleBuildDate(files: readonly BundleFile[], committerDate: string): BundleBuildDateResult {
  const fail = (failure: BundleBuildDateFailure): BundleBuildDateResult => ({ ok: false, failure })
  const expected = expectedBuildDate(committerDate)
  if (expected === null) return fail({ check: 'build-date', reason: 'expected-unreadable' })
  const hits = occurrences(files, expected, () => false)
  if (hits.length === 0) return fail({ check: 'build-date', reason: 'date-not-found', expected })
  if (hits.length > 1) return fail({ check: 'build-date', reason: 'date-repeated', expected, paths: hits.map((h) => h.path) })
  const hit = hits[0]
  if (!CODE_FILE.test(hit.path)) return fail({ check: 'build-date', reason: 'date-not-in-code', expected, path: hit.path })
  if (!QUOTES.includes(hit.before) || hit.after !== hit.before) return fail({ check: 'build-date', reason: 'date-not-quoted', expected, path: hit.path })
  return { ok: true, path: hit.path, date: expected }
}
