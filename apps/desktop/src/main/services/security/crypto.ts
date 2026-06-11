import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual
} from 'node:crypto'
import { argon2id } from '@noble/hashes/argon2.js'

// KDF + AEAD primitives for the encrypted workspace (spec §3.5, Phase 9).
//
// Pure + I/O-free so it is trivially unit-testable. Two responsibilities:
//   1. KDF — derive a 32-byte AES key from a password + salt. The algorithm and its
//      parameters are RECORDED (returned in the descriptor) so unlock is deterministic.
//   2. AEAD — AES-256-GCM encrypt/decrypt of a Buffer (random 12-byte IV, 16-byte auth
//      tag stored alongside). A wrong key or tampered ciphertext makes `decrypt` throw.
//
// KDF: NEW vaults default to **Argon2id** (the OWASP-recommended password KDF), provided
// by the pure-JS, audited `@noble/hashes` — so there is NO fragile native `argon2` build
// (the original blocker, R4). `scrypt` from `node:crypto` is still fully supported so any
// vault created under the earlier default unlocks unchanged: the descriptor records the
// `algo` + params, and `deriveKey` dispatches on them. No on-disk format change.

export type KdfAlgo = 'scrypt' | 'argon2id'

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

/** Legacy scrypt parameters (still supported for unlocking older vaults). */
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

/** Size of the random vault DATA key (descriptor v2 envelope, Phase 32). */
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
 * denial-of-service on the vault (audit SEC-B). Tampering cannot disclose data (a wrong
 * key still fails the verifier); these bounds just keep the failure mode sane.
 */
function validateKdfBounds(params: KdfParams): void {
  if (params.keyLen !== 32) {
    throw new Error(`KDF keyLen must be 32 (AES-256), got ${String(params.keyLen)}`)
  }
  if (params.algo === 'scrypt') {
    const { N, r, p } = params
    if (!N || !r || !p || N < 1024 || N > 2 ** 22 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) {
      throw new Error('scrypt parameters out of bounds (descriptor may be corrupt or tampered)')
    }
  }
  if (params.algo === 'argon2id') {
    const { m, t, p } = params
    if (!m || !t || !p || m < 8 || m > 2 ** 21 || t < 1 || t > 64 || p < 1 || p > 16) {
      throw new Error('argon2id parameters out of bounds (descriptor may be corrupt or tampered)')
    }
  }
}

/**
 * Derive a key from a password + salt using the recorded params. Deterministic: the
 * same password + salt + params always yield the same key (so unlock matches encrypt).
 */
export function deriveKey(password: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Buffer {
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
    const out = argon2id(password, salt, { m: params.m, t: params.t, p: params.p, dkLen: params.keyLen })
    return Buffer.from(out)
  }
  throw new Error(`Unsupported KDF algorithm: ${String(params.algo)}`)
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
 * with (GCM authentication failure) — callers treat that as "wrong password".
 */
export function decrypt(key: Buffer, blob: EncryptedBlob): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.iv)
  decipher.setAuthTag(blob.tag)
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()])
}

// ---- Framed serialization (for the encrypted DB file on disk) -------------------

const MAGIC = Buffer.from('PAIDENC1') // 8 bytes: format magic + version

/** Frame layout constants, exported for the STREAMING file crypto in workspace-vault.ts
 *  (which must read/write the exact same `MAGIC | iv | tag | ciphertext` format). */
export const BLOB_MAGIC: Buffer = MAGIC
export const BLOB_IV_BYTES = IV_BYTES
export const BLOB_TAG_BYTES = TAG_BYTES

/**
 * Serialize an encrypted blob to a single self-describing buffer:
 * `MAGIC(8) | iv(12) | tag(16) | ciphertext(...)`. Written to `paid.sqlite.enc`.
 */
export function serializeBlob(blob: EncryptedBlob): Buffer {
  return Buffer.concat([MAGIC, blob.iv, blob.tag, blob.ciphertext])
}

/** Parse a buffer produced by `serializeBlob`. Throws on a bad/short/foreign header. */
export function deserializeBlob(buf: Buffer): EncryptedBlob {
  const headerLen = MAGIC.length + IV_BYTES + TAG_BYTES
  if (buf.length < headerLen) {
    throw new Error('Encrypted blob is too short or corrupt')
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Encrypted blob has an unrecognised header')
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = buf.subarray(MAGIC.length + IV_BYTES, headerLen)
  const ciphertext = buf.subarray(headerLen)
  return { iv, tag, ciphertext }
}

// ---- Password verifier ----------------------------------------------------------

/** A fixed known plaintext encrypted under the derived key to verify a password. */
const VERIFIER_PLAINTEXT = Buffer.from('paid-vault-verifier-v1')

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
