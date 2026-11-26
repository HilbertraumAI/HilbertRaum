// The release guard (app-update W-3, F-3; docs/app-updates.md §2.7, "The release guard's reading"): the key set embedded
// in a build's main bundle equals the `key_set` of the keys.json that build was made from, byte for byte, two empty sets
// included. It only compares. Refusing an empty set is the sell gate's and the pre-publish check's (W-33, P5); a build
// before the key ceremony passes here.
//
// What it reads: the files of one main bundle (every file under out/main, chunks and any .map included), each as its
// path and bytes, and keys.json's bytes. It searches bytes, never decoded text: the marker is ASCII, and in UTF-8 no byte
// of a multibyte character is below 0x80, so a byte search is exact and nothing is decoded that might not decode. What it
// does not check: that the files are the whole bundle (the caller lists them), that the build is the one that ships (the
// caller reads the packed app.asar), or that a key is a sound curve point (§2.7, the key proof).
//
// The marker is taken from keys.json's own value, the part up to its first colon, once the one parser (`parseKeySet`,
// envelope.ts) has accepted that value; no line here spells it. Main never imports this file (it is in no app.asar). The
// release tools load it through Node's own type stripping (with scripts/lib/ts-sibling-imports.mjs), so it imports only
// envelope.ts and types, reads no file and no environment, and holds only TypeScript that stripping can erase.

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

/**
 * Every occurrence of `marker` (its UTF-8 bytes) in every file, in file order and then offset order, each with the longest
 * run of value bytes that follows it. Occurrences may overlap. An empty marker finds nothing. Never throws.
 */
export function findMarker(files: readonly BundleFile[], marker: string, isValueByte: (byte: number) => boolean): readonly MarkerHit[] {
  const needle = Buffer.from(marker, 'utf8')
  if (needle.length === 0) return []
  const hits: MarkerHit[] = []
  for (const file of files) {
    const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength)
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) {
      let end = at + needle.length
      while (end < bytes.length && isValueByte(bytes[end])) end++
      hits.push({ path: file.path, offset: at, value: bytes.toString('latin1', at + needle.length, end) })
    }
  }
  return hits
}

/** The characters of an embedded key set after its marker (§2.7): standard base64 with padding, and the `,` between keys. */
function isKeySetByte(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2f || b === 0x3d || b === 0x2c
}

/** A file the bundle's code runs from; the set's one occurrence must be in one (a `.map` holds the source text, not code). */
const CODE_FILE = /\.(?:js|mjs|cjs)$/

/** Why the guard fails. Key ids are public; no key bytes are carried. `check` leaves room for T6.4a's build-date check. */
export type BundleKeysFailure =
  | { readonly check: 'keys'; readonly reason: 'committed-unreadable'; readonly fault: KeysFileFault }
  | { readonly check: 'keys'; readonly reason: 'marker-not-found' }
  | { readonly check: 'keys'; readonly reason: 'marker-repeated'; readonly paths: readonly string[] }
  | { readonly check: 'keys'; readonly reason: 'marker-only-in-map'; readonly path: string }
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
 * 3. the one occurrence must be in a `.js`, `.mjs` or `.cjs` file, else `marker-only-in-map` (sheet decision 1: a set
 *    found only in a source map is a build whose code carries none; a `.map` is the one other kind of file a main build
 *    writes);
 * 4. the marker and the run after it must read through `parseKeySet`, else `embedded-unreadable`;
 * 5. that run must equal keys.json's value after the marker, byte for byte (so also in order), else `keys-differ`, with
 *    both id lists.
 * Never throws.
 */
export function checkBundleKeys(files: readonly BundleFile[], committedKeysJson: Uint8Array): BundleKeysResult {
  const fail = (failure: BundleKeysFailure): BundleKeysResult => ({ ok: false, failure })
  const committed = readKeysFile(committedKeysJson)
  if (!committed.valid) return fail({ check: 'keys', reason: 'committed-unreadable', fault: committed.fault })
  const markerEnd = committed.value.indexOf(':') + 1
  const marker = committed.value.slice(0, markerEnd)
  const hits = findMarker(files, marker, isKeySetByte)
  if (hits.length === 0) return fail({ check: 'keys', reason: 'marker-not-found' })
  if (hits.length > 1) return fail({ check: 'keys', reason: 'marker-repeated', paths: hits.map((h) => h.path) })
  const hit = hits[0]
  if (!CODE_FILE.test(hit.path)) return fail({ check: 'keys', reason: 'marker-only-in-map', path: hit.path })
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
