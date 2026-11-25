import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual
} from 'node:crypto'
import { argon2id } from '@noble/hashes/argon2.js'

// KDF + AEAD primitives for the encrypted workspace (spec §3.5).
//
// Pure + I/O-free so it is trivially unit-testable. Two responsibilities:
//   1. KDF — derive a 32-byte AES key from a password + salt. The algorithm and its
//      parameters are RECORDED (returned in the descriptor) so unlock is deterministic.
//   2. AEAD — AES-256-GCM encrypt/decrypt of a Buffer (random 12-byte IV, 16-byte auth
//      tag stored alongside). A wrong key or tampered ciphertext makes `decrypt` throw.
//
// KDF: NEW vaults default to **Argon2id** (the OWASP-recommended password KDF), provided
// by the pure-JS, audited `@noble/hashes` — so there is NO fragile native `argon2` build.
// `scrypt` from `node:crypto` is still fully supported so any vault created under the
// earlier default unlocks unchanged: the descriptor records the `algo` + params, and
// `deriveKey` dispatches on them. No on-disk format change.

/** The KDF algorithms `deriveKey` can derive with: the one list the type, the dispatch and the vault's format check
 *  (a descriptor naming any other `kdf.algo` was written by a newer build, #845) all come from. */
export const KDF_ALGOS = ['scrypt', 'argon2id'] as const
export type KdfAlgo = (typeof KDF_ALGOS)[number]

/** True when `algo` is one of {@link KDF_ALGOS}. */
export function isKnownKdfAlgo(algo: unknown): algo is KdfAlgo {
  return (KDF_ALGOS as readonly unknown[]).includes(algo)
}

/**
 * Recorded KDF parameters — persisted in the vault descriptor so unlock matches encrypt.
 * Fields are per-algorithm (scrypt: N/r/p; argon2id: m/t/p) and validated in `deriveKey`.
 */
export interface KdfParams {
  algo: KdfAlgo
  /** Derived key length in bytes (32 for AES-256). */
  keyLen: number
  /** scrypt CPU/memory cost (memory ≈ 128 * N * r bytes). */
  N?: number
  /** scrypt block size. */
  r?: number
  /** scrypt parallelization / argon2id parallelism (lanes). */
  p?: number
  /** argon2id memory cost in KiB. */
  m?: number
  /** argon2id time cost (iterations). */
  t?: number
}

/**
 * Default KDF for NEW vaults: Argon2id at the OWASP "interactive" minimum
 * (m = 19 MiB, t = 2, p = 1) → ~0.5 s on a laptop, a deliberate one-time unlock cost.
 * Tunable via the descriptor without changing the on-disk format.
 */
export const DEFAULT_KDF: KdfParams = {
  algo: 'argon2id',
  m: 19456,
  t: 2,
  p: 1,
  keyLen: 32
}

/**
 * The former default scrypt parameters. Nothing reads this constant: a vault created under them still unlocks, but
 * from the KDF params its own descriptor records, never from here.
 */
export const SCRYPT_KDF: KdfParams = {
  algo: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32
}

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

/** Size of the random vault DATA key (descriptor v2 envelope). */
export const DATA_KEY_BYTES = 32

/** Generate a fresh random salt for a new vault. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES)
}

/**
 * Generate the random 32-byte DATA key of a v2 (envelope) vault. The DB file and every
 * document sidecar are encrypted under THIS key; the password-derived key only wraps it
 * (AES-256-GCM via `encrypt`), so a password change re-wraps one small blob instead of
 * re-encrypting the corpus.
 */
export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES)
}

/**
 * Bounds for descriptor-supplied KDF params. The descriptor (`config/workspace.json`)
 * is UNENCRYPTED and attacker-writable on a removable drive: unbounded params (e.g.
 * argon2id `m: 2e9` KiB) would make every unlock attempt a multi-GB allocation — a
 * denial-of-service on the vault. Tampering cannot disclose data (a wrong
 * key still fails the verifier); these bounds just keep the failure mode sane.
 */
/** Upper bound for a descriptor's argon2id `m`, in KiB (1 GiB). T2.7 security fix round (L-1, owner 2026-11-25): it was
 *  2 GiB, and with `t` up to 64 a descriptor could make one unlock attempt run for about 15 minutes on the main thread
 *  (measured on the reference box: 3.4 s at m 2^16, t 8); m 2^20 and t 8 keep the worst case near a minute. The shipped
 *  default (m 19456, t 2, p 1) and every descriptor a published release wrote lie far inside both (F-27: a later version
 *  that needs more raises the descriptor version, which this build refuses as newer). */
const ARGON2_MAX_M_KIB = 2 ** 20

/** The upper bound of every KDF parameter a descriptor may raise, per algorithm (`m` in KiB): one table for the derive's
 *  check below and for {@link kdfParamAboveBounds}, so the two cannot drift apart. T2.7 (L-1): argon2id `t` at most 8
 *  (was 64); `p` and the scrypt bounds as before. */
const KDF_UPPER_BOUNDS: Readonly<Record<KdfAlgo, Readonly<Record<string, number>>>> = {
  scrypt: { N: 2 ** 22, r: 32, p: 16 },
  argon2id: { m: ARGON2_MAX_M_KIB, t: 8, p: 16 }
}

/** T2.7 security fix round (L-4): what a KDF error says of a descriptor value: its type only. The descriptor is plain
 *  JSON on the drive, so a value quoted into a message reached app.log (a failure line keeps a non-file error's
 *  message), at any length. */
const typeOfValue = (value: unknown): string => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)

function validateKdfBounds(params: KdfParams): void {
  if (params.keyLen !== 32) {
    throw new Error(`KDF keyLen must be 32 (AES-256), got a value of type ${typeOfValue(params.keyLen)}`)
  }
  if (params.algo === 'scrypt') {
    const { N, r, p } = params
    const max = KDF_UPPER_BOUNDS.scrypt
    if (!N || !r || !p || N < 1024 || N > max.N || (N & (N - 1)) !== 0 || r < 1 || r > max.r || p < 1 || p > max.p) {
      throw new Error('scrypt parameters out of bounds (descriptor may be corrupt or tampered)')
    }
  }
  if (params.algo === 'argon2id') {
    const { m, t, p } = params
    const max = KDF_UPPER_BOUNDS.argon2id
    if (!m || !t || !p || m < 8 || m > max.m || t < 1 || t > max.t || p < 1 || p > max.p) {
      throw new Error('argon2id parameters out of bounds (descriptor may be corrupt or tampered)')
    }
  }
}

/**
 * T2.9 fix round (R1-6): the first KDF parameter of `kdf` (a descriptor's, as read: unchecked) that is a number above
 * this build's upper bound for its algorithm, as `<algo> <param> <value>` (content-free, for the log), or null. Only for
 * an algorithm this build knows. F-9's later-writer duty keeps a later build's parameters inside these bounds under
 * descriptor version 2, so one above them was written by a newer build (a stronger setting): the vault's format verdict
 * reads it as newer (`workspace_newer`) before anything is written, where the derive used to refuse it with a plain
 * error ("Could not open") after the start's steps and the unlock's rekey recovery had run. A value below a lower
 * bound, of another type, or a key length other than 32 is no setting any build writes: the derive still refuses it.
 */
export function kdfParamAboveBounds(kdf: unknown): string | null {
  const params = kdf as Record<string, unknown> | null
  const algo = params?.algo
  if (!isKnownKdfAlgo(algo)) return null
  for (const [name, max] of Object.entries(KDF_UPPER_BOUNDS[algo])) {
    const value = params?.[name]
    if (typeof value === 'number' && value > max) return `${algo} ${name} ${String(value)}`
  }
  return null
}

/**
 * Derive a key from a password + salt using the recorded params. Deterministic: the
 * same password + salt + params always yield the same key (so unlock matches encrypt).
 */
export function deriveKey(password: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Buffer {
  // T2.7 (L-4): the type only, never the value (`readVaultDescriptorChecked` reads only a string `algo` as newer).
  if (!isKnownKdfAlgo(params.algo)) throw new Error(`Unsupported KDF algorithm (a value of type ${typeOfValue(params.algo)})`)
  if (params.algo === 'scrypt') {
    if (params.N == null || params.r == null || params.p == null) {
      throw new Error('scrypt parameters (N, r, p) are required')
    }
    validateKdfBounds(params)
    // 128 * N * r bytes of memory; give scrypt headroom over the 32 MiB default cap.
    const maxmem = 256 * 1024 * 1024
    return scryptSync(password, salt, params.keyLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem
    })
  }
  if (params.algo === 'argon2id') {
    if (params.m == null || params.t == null || params.p == null) {
      throw new Error('argon2id parameters (m, t, p) are required')
    }
    validateKdfBounds(params)
    // Pure-JS, audited @noble/hashes — no native build. m = memory (KiB), t = iterations.
    // `maxmem` (bytes) is set at the bound above, so the derive never depends on the library's
    // own default (@noble/hashes 2.4 lowered it to 1 GiB, then below the 2 GiB bound).
    const out = argon2id(password, salt, {
      m: params.m,
      t: params.t,
      p: params.p,
      dkLen: params.keyLen,
      maxmem: ARGON2_MAX_M_KIB * 1024
    })
    // T2.7 (L-7): the key is copied out, and the library's array, its only other copy, zeroed.
    const key = Buffer.from(out)
    out.fill(0)
    return key
  }
  // Unreachable: the check at the top admits only KDF_ALGOS, and each has its branch above.
  throw new Error(`Unsupported KDF algorithm (a value of type ${typeOfValue(params.algo)})`)
}

/** An AES-256-GCM ciphertext + its IV and auth tag. */
export interface EncryptedBlob {
  iv: Buffer
  tag: Buffer
  ciphertext: Buffer
}

/** AES-256-GCM encrypt. A fresh random 12-byte IV is used for every call. */
export function encrypt(key: Buffer, plaintext: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv, tag, ciphertext }
}

/**
 * AES-256-GCM decrypt. Throws if the key is wrong or the ciphertext/tag was tampered
 * with (GCM authentication failure). Only the password check (`verifyKey`) reads that as a
 * wrong password; past it, the unlock reads a tag failure as damage (#860 V5b).
 */
export function decrypt(key: Buffer, blob: EncryptedBlob): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.iv)
  decipher.setAuthTag(blob.tag)
  // T2.7 (L-7): the pieces are zeroed once joined: the plaintext (the unwrapped data key, among others) stays in the
  // returned buffer only. A tag that fails throws from `final()`, before the join; the piece `update()` returned is
  // zeroed then too.
  const head = decipher.update(blob.ciphertext)
  let tail: Buffer
  try {
    tail = decipher.final()
  } catch (err) {
    head.fill(0)
    throw err
  }
  const out = Buffer.concat([head, tail])
  head.fill(0)
  tail.fill(0)
  return out
}

// ---- Vault format versions (#845) -------------------------------------------------

/** Which vault artifact a newer build wrote: the descriptor's `version`, its KDF, an encrypted frame, or the
 *  password-change journal. */
export type VaultNewerWhat = 'descriptor' | 'kdf' | 'frame' | 'journal'

/**
 * Thrown when a vault artifact was written by a NEWER build than this one (#845): a descriptor `version` above the
 * highest this build knows, a KDF it does not know, an encrypted frame of this family with a higher version byte, or
 * a password-change journal of a higher version. Thrown BEFORE anything is written, so nothing was changed.
 * Content-free (an artifact name and a version, never a path): the IPC layer maps it to the `workspace_newer` reason
 * and copy, and logs `what` and `found`.
 */
export class VaultNewerError extends Error {
  constructor(
    readonly what: VaultNewerWhat,
    readonly found: string | number
  ) {
    super(`The workspace ${what} was written by a newer HilbertRaum (found ${String(found)}); nothing was changed`)
    this.name = 'VaultNewerError'
  }
}

/** instanceof PLUS the name — the production bundle can hold a second copy of this module. */
export function isVaultNewerError(err: unknown): err is VaultNewerError {
  return err instanceof VaultNewerError || (err instanceof Error && err.name === 'VaultNewerError')
}

// ---- Framed serialization (for the encrypted DB file on disk) -------------------

// 8 bytes: the 7-byte format family `HRAUMEN` and a 1-byte frame version, the ASCII digit `1` (later versions:
// `2`–`9`). Every shipped build writes and reads only `HRAUMEN1`; builds before #845 compare all 8 bytes, so they
// read any other version as an unrecognised header.
const MAGIC = Buffer.from('HRAUMEN1')
const MAGIC_FAMILY_BYTES = 7

/** Frame layout constants, exported for the STREAMING file crypto in workspace-vault.ts
 *  (which must read/write the exact same `MAGIC | iv | tag | ciphertext` format). */
export const BLOB_MAGIC: Buffer = MAGIC
export const BLOB_IV_BYTES = IV_BYTES
export const BLOB_TAG_BYTES = TAG_BYTES

/**
 * What the first bytes of an encrypted frame say (#845): `current` (`HRAUMEN1`, the frame this build reads), `newer`
 * (`HRAUMEN` + an ASCII digit 2–9: written by a newer build), or `foreign` (anything else, including fewer than 8
 * bytes, `HRAUMEN` + any other byte, `PAIDENC1` from before the 0.1.10 rebrand, or no format at all).
 */
export function classifyFrameMagic(head: Buffer): 'current' | 'newer' | 'foreign' {
  if (head.length < MAGIC.length) return 'foreign'
  if (head.subarray(0, MAGIC.length).equals(MAGIC)) return 'current'
  if (!head.subarray(0, MAGIC_FAMILY_BYTES).equals(MAGIC.subarray(0, MAGIC_FAMILY_BYTES))) return 'foreign'
  // Only the ASCII digits 2–9 are later frame versions. Any other byte here (`0`, a letter, a control byte) is one
  // flipped bit or so away from `1`: damage, which must not read as "written by a newer version" forever (W2 review 2).
  const v = head[MAGIC_FAMILY_BYTES]
  return v >= 0x32 && v <= 0x39 ? 'newer' : 'foreign'
}

/** The `VaultNewerError` for a frame `classifyFrameMagic` called `newer`: `found` is its version digit (`'2'`). */
export function newerFrameError(head: Buffer): VaultNewerError {
  return new VaultNewerError('frame', String.fromCharCode(head[MAGIC_FAMILY_BYTES]))
}

/**
 * Serialize an encrypted blob to a single self-describing buffer:
 * `MAGIC(8) | iv(12) | tag(16) | ciphertext(...)`. Written to `hilbertraum.sqlite.enc`.
 */
export function serializeBlob(blob: EncryptedBlob): Buffer {
  return Buffer.concat([MAGIC, blob.iv, blob.tag, blob.ciphertext])
}

/** Parse a buffer produced by `serializeBlob`. Throws on a bad/short/foreign header, and `VaultNewerError` on a
 *  frame a newer build wrote (checked first: a newer layout need not be as long as this build's header). */
export function deserializeBlob(buf: Buffer): EncryptedBlob {
  const headerLen = MAGIC.length + IV_BYTES + TAG_BYTES
  const magic = classifyFrameMagic(buf)
  if (magic === 'newer') throw newerFrameError(buf)
  if (buf.length < headerLen) {
    throw new Error('Encrypted blob is too short or corrupt')
  }
  if (magic !== 'current') {
    throw new Error('Encrypted blob has an unrecognised header')
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = buf.subarray(MAGIC.length + IV_BYTES, headerLen)
  const ciphertext = buf.subarray(headerLen)
  return { iv, tag, ciphertext }
}

// ---- Password verifier ----------------------------------------------------------

/** A fixed known plaintext encrypted under the derived key to verify a password. */
const VERIFIER_PLAINTEXT = Buffer.from('hilbertraum-vault-verifier-v1')

/** Encrypt the known verifier plaintext under `key` (stored in the vault descriptor). */
export function makeVerifier(key: Buffer): EncryptedBlob {
  return encrypt(key, VERIFIER_PLAINTEXT)
}

/**
 * Return true iff `key` decrypts `verifier` back to the known plaintext. Used to check a
 * password WITHOUT touching the encrypted database (a wrong key fails the GCM tag).
 */
export function verifyKey(key: Buffer, verifier: EncryptedBlob): boolean {
  try {
    const out = decrypt(key, verifier)
    return out.length === VERIFIER_PLAINTEXT.length && timingSafeEqual(out, VERIFIER_PLAINTEXT)
  } catch {
    return false
  }
}
