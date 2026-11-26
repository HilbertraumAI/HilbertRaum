// The update file's signed envelope (app-update W-1, F-1, F-3; docs/app-updates.md §2.3, §2.7, §2.10): DSSE's
// pre-authentication encoding (PAE) and Ed25519 through `node:crypto`, the two caps, the base64 grammar, `keyid` as a
// hint and the UnknownSigner rule, the `payloadType` decided after a signature verified, and the one parser of the
// embedded key set. Release 1 applies this to every update file for ever, so it reads the bytes before it parses them,
// checks the signature before the payload is read, hands the payload on as the bytes that were signed (never
// re-encoded or re-serialised), and lets only the embedded key bytes decide: a `keyid` never selects a key. Each check
// below is a row of §2.3's table, in the table's order; the first one that fails decides.
//
// What it does not check: that a key is a sound curve point (the key proof and the review of the keys' pull request
// do, §2.7); the payload's own fields (§2.4); the update file's container (§4.3).
//
// The release tools load this file through Node's own type stripping (with scripts/lib/ts-sibling-imports.mjs), so it
// imports only `node:crypto` and types, and holds only TypeScript that stripping can erase (no `enum`, no namespace, no
// parameter property). It is handed the key set: keys.ts is the one module that reads keys.json. No line here spells
// the key-set marker with its colon (§2.7, "The embedded form": the build carries keys.json's copy only).

import { createHash, createPublicKey, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { EnvelopeRefusal } from '../../../shared/updates/types'

/** The envelope's cap (4 MiB): more bytes are UPD-TOO-NEW before a byte of them is decoded or parsed. */
export const ENVELOPE_MAX_BYTES = 4_194_304

/** At most this many `signatures` entries, counted after the parse and before any signature is verified. */
export const ENVELOPE_MAX_SIGNATURES = 64

/** At most this many keys in a key set (release 1 embeds three). */
export const KEY_SET_MAX_KEYS = 16

/** A release's `payloadType`. */
export const RELEASE_PAYLOAD_TYPE = 'application/vnd.hilbertraum.release+json'

/** Every later HilbertRaum `payloadType` starts so (§2.3, "Writers: the caps and the signer"). */
const VENDOR_TYPE_PREFIX = 'application/vnd.hilbertraum.'

/** The key-set marker's name: the set is this name, a colon, then the keys. */
const KEY_SET_MARKER_NAME = 'hilbertraum-key-set-1'

/** An Ed25519 key's DER SubjectPublicKeyInfo (RFC 8410): these 12 bytes, then the 32 key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_SPKI_BYTES = 44
const ED25519_SIGNATURE_BYTES = 64

// ---- the base64 grammar (§2.3, "The base64 grammar")

const SEXTETS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const BASE64_BODY = /^[A-Za-z0-9+/_-]*$/

/** A character's 6-bit value in either alphabet (only called on one that passed BASE64_BODY). */
function sextet(c: string): number {
  const i = SEXTETS.indexOf(c)
  return i >= 0 ? i : c === '+' || c === '-' ? 62 : 63
}

/**
 * The bytes `text` stands for in RFC 4648 base64, or null when it breaks the grammar: one alphabet per string, standard
 * (`+` `/`) or URL-safe (`-` `_`; refused when `standardOnly`), the length a multiple of 4, `=` only as the last one or
 * two characters, no other character (no whitespace, no line break), the unused bits of the last character zero. The
 * empty string is 0 bytes. Checked by hand, because `Buffer.from(…, 'base64')` accepts all of these and more.
 */
function decodeBase64(text: string, standardOnly: boolean): Buffer | null {
  if (text.length % 4 !== 0) return null
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const body = text.slice(0, text.length - padding)
  if (!BASE64_BODY.test(body)) return null
  const urlSafe = /[-_]/.test(body)
  if (urlSafe && (standardOnly || /[+/]/.test(body))) return null
  if (padding > 0 && (sextet(body[body.length - 1]) & (padding === 1 ? 0b11 : 0b1111)) !== 0) return null
  return Buffer.from(urlSafe ? body.replace(/-/g, '+').replace(/_/g, '/') : body, 'base64')
}

// ---- JSON as release 1 reads it (§2.3, rows "Text" and "JSON"; §2.4's payload is read the same way)

/** A JSON object: never an array, never null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own key's value; a key reached through the prototype is no key (an own `__proto__` key is an unknown one). */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

/** Strict UTF-8 (RFC 3629: no overlong form, no encoded surrogate, nothing above U+10FFFF); a bad byte throws. */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The JSON object `bytes` hold, or null: bytes that start with a byte-order mark (refused here, before the decoder,
 * which would drop one silently), that are not strict UTF-8, that are no JSON text (every exception of the decode or
 * the parse, a refusal for the text's depth included), or whose top level is no object. With a duplicate key the last
 * one counts (`JSON.parse`). The caller reads named own keys only and never walks the value whole. The envelope maps
 * null to UPD-FILE-DAMAGED; the payload check (§2.4) maps it to UPD-TOO-NEW.
 */
export function readJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null
  let value: unknown
  try {
    value = JSON.parse(UTF8.decode(bytes))
  } catch {
    return null
  }
  return isObject(value) ? value : null
}

// ---- the key set (§2.7)

/** One embedded public key: its id (lower-case hex SHA-256 of its 44 SPKI bytes, §2.7) and the loaded key. */
export interface UpdateKey {
  readonly id: string
  readonly key: KeyObject
}

/**
 * Why a key set does not read (§2.7, "A set that does not read"): no string; another marker, or none; more than 16
 * keys; an entry that is not canonical standard base64; an entry that is not the 12-byte Ed25519 SPKI prefix and 32
 * bytes; an entry `createPublicKey` throws on (no input is known to make it); a repeated entry.
 */
export type KeySetFault = 'not-a-string' | 'marker' | 'too-many' | 'not-base64' | 'not-ed25519-spki' | 'unloadable' | 'repeated'

export type KeySetRead = { readonly valid: true; readonly keys: readonly UpdateKey[] } | { readonly valid: false; readonly fault: KeySetFault }

/**
 * The one parser of keys.json's `key_set` (§2.7): the marker's name, a colon, then zero or more Ed25519 SPKI keys in
 * standard base64 with padding, joined by `,`. Any fault makes the whole set invalid, never a part of it. The part before
 * the first colon is compared with the marker's name, so no source spells the marker with its colon. Never throws.
 */
export function parseKeySet(keySet: unknown): KeySetRead {
  if (typeof keySet !== 'string') return { valid: false, fault: 'not-a-string' }
  const colon = keySet.indexOf(':')
  if (colon < 0 || keySet.slice(0, colon) !== KEY_SET_MARKER_NAME) return { valid: false, fault: 'marker' }
  const rest = keySet.slice(colon + 1)
  const entries = rest === '' ? [] : rest.split(',')
  if (entries.length > KEY_SET_MAX_KEYS) return { valid: false, fault: 'too-many' }
  const keys: UpdateKey[] = []
  for (const entry of entries) {
    const der = decodeBase64(entry, true)
    if (der === null) return { valid: false, fault: 'not-base64' }
    if (der.length !== ED25519_SPKI_BYTES || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      return { valid: false, fault: 'not-ed25519-spki' }
    }
    let key: KeyObject
    try {
      key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    } catch {
      return { valid: false, fault: 'unloadable' }
    }
    const id = createHash('sha256').update(der).digest('hex')
    if (keys.some((k) => k.id === id)) return { valid: false, fault: 'repeated' }
    keys.push({ id, key })
  }
  return { valid: true, keys }
}

// ---- the envelope (§2.3)

/**
 * DSSE's PAE (§2.3, "Verification"): `DSSEv1`, the type's UTF-8 byte count, the type, the payload's byte count, the
 * payload, one space between each, a count in ASCII decimal without leading zeros. What the keys sign (§2.2): the
 * release tools sign this too. `payloadType` must hold no lone surrogate (the envelope refuses one first).
 */
export function pae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, 'utf8')
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, 'ascii'), type, Buffer.from(` ${payload.length} `, 'ascii'), payload])
}

/** A verified envelope hands on its payload's bytes as they were signed (no verdict of its own, §2.10); else a refusal. */
export type EnvelopeResult =
  | { readonly verified: true; readonly payload: Buffer }
  | { readonly verified: false; readonly refusal: EnvelopeRefusal }

/** Pure Ed25519 (RFC 8032 §5.1.7: no context, no prehash). A throw (not expected for a 64-byte signature) verifies nothing. */
function verifies(message: Buffer, key: KeyObject, signature: Buffer): boolean {
  try {
    return verify(null, message, key, signature)
  } catch {
    return false
  }
}

/**
 * Verify member 0's bytes against the embedded keys (§2.3's table, in its order). `runningVersion` is only a parameter
 * of the answers that carry it (§2.10). An empty key set refuses before a byte is read, and so does a `keys` that is no
 * array (an untyped caller's mistake, such as parseKeySet's whole read: it holds no key). Every `signatures` entry that
 * counts (an object whose own `sig` is base64 of exactly 64 bytes) is tried, in envelope order, against every key; the
 * first that one key verifies accepts, and only then is the `payloadType` read for its meaning. When none verifies, an
 * entry whose own string `keyid` equals an embedded key's id makes it UPD-NOT-GENUINE, else UPD-UNKNOWN-SIGNER (no
 * signature at all included). Never throws for any bytes, with parseKeySet's keys or with a `keys` that is no array
 * (`undefined` included); an array of other values is no key set and outside this contract.
 */
export function verifyEnvelope(bytes: Uint8Array, keys: readonly UpdateKey[], runningVersion: string): EnvelopeResult {
  const refuse = (refusal: EnvelopeRefusal): EnvelopeResult => ({ verified: false, refusal })
  // `as unknown`: Array.isArray would narrow `keys` to any[] for the rest of the function.
  if (!Array.isArray(keys as unknown) || keys.length === 0) return refuse({ code: 'UPD-NOT-AVAILABLE', params: {} })
  if (bytes.length > ENVELOPE_MAX_BYTES) return refuse({ code: 'UPD-TOO-NEW', params: { runningVersion } })
  const envelope = readJsonObject(bytes)
  if (envelope === null) return refuse({ code: 'UPD-FILE-DAMAGED', params: {} })
  const signatures: unknown = own(envelope, 'signatures')
  if (!Array.isArray(signatures)) return refuse({ code: 'UPD-FILE-DAMAGED', params: {} })
  if (signatures.length > ENVELOPE_MAX_SIGNATURES) return refuse({ code: 'UPD-TOO-NEW', params: { runningVersion } })
  const payloadType = own(envelope, 'payloadType')
  if (typeof payloadType !== 'string' || !payloadType.isWellFormed()) return refuse({ code: 'UPD-FILE-DAMAGED', params: {} })
  const encoded = own(envelope, 'payload')
  const payload = typeof encoded === 'string' ? decodeBase64(encoded, false) : null
  if (payload === null) return refuse({ code: 'UPD-FILE-DAMAGED', params: {} })

  const message = pae(payloadType, payload)
  const ids = new Set(keys.map((k) => k.id))
  let namesEmbeddedKey = false
  for (const entry of signatures as unknown[]) {
    if (!isObject(entry)) continue
    const keyid = own(entry, 'keyid')
    if (typeof keyid === 'string' && ids.has(keyid)) namesEmbeddedKey = true
    const sig = own(entry, 'sig')
    const signature = typeof sig === 'string' ? decodeBase64(sig, false) : null
    if (signature === null || signature.length !== ED25519_SIGNATURE_BYTES) continue
    if (!keys.some((k) => verifies(message, k.key, signature))) continue
    if (payloadType === RELEASE_PAYLOAD_TYPE) return { verified: true, payload }
    return refuse(
      payloadType.startsWith(VENDOR_TYPE_PREFIX)
        ? { code: 'UPD-FOR-NEWER-HILBERTRAUM', params: { runningVersion } }
        : { code: 'UPD-NOT-AN-UPDATE', params: {} }
    )
  }
  return refuse(namesEmbeddedKey ? { code: 'UPD-NOT-GENUINE', params: {} } : { code: 'UPD-UNKNOWN-SIGNER', params: { runningVersion } })
}
