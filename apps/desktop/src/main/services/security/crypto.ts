import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual
} from 'node:crypto'

// KDF + AEAD primitives for the encrypted workspace (spec §3.5, Phase 9).
//
// Pure + I/O-free so it is trivially unit-testable. Two responsibilities:
//   1. KDF — derive a 32-byte AES key from a password + salt. The algorithm and its
//      parameters are RECORDED (returned in the descriptor) so unlock is deterministic.
//   2. AEAD — AES-256-GCM encrypt/decrypt of a Buffer (random 12-byte IV, 16-byte auth
//      tag stored alongside). A wrong key or tampered ciphertext makes `decrypt` throw.
//
// KDF choice (LOCKED for the MVP): **scrypt from `node:crypto`**. Argon2id is the
// stronger default but native `argon2` is a fragile build on Node 24 (R4); scrypt is
// built in, memory-hard, and needs no native module — so we ship it as the portable
// primary and keep the descriptor's `algo` field open so an `argon2id` path can be
// added later without changing the on-disk format.

export type KdfAlgo = 'scrypt' | 'argon2id'

/** Recorded KDF parameters — persisted in the vault descriptor so unlock matches encrypt. */
export interface KdfParams {
  algo: KdfAlgo
  /** scrypt cost (CPU/memory). Memory ≈ 128 * N * r bytes. */
  N: number
  /** scrypt block size. */
  r: number
  /** scrypt parallelization. */
  p: number
  /** Derived key length in bytes (32 for AES-256). */
  keyLen: number
}

/**
 * Default scrypt parameters. N=2^15, r=8, p=1 → ~32 MiB of memory, a sensible
 * interactive cost. `maxmem` is raised below so scrypt does not refuse the work.
 */
export const DEFAULT_KDF: KdfParams = {
  algo: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32
}

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

/** Generate a fresh random salt for a new vault. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES)
}

/**
 * Derive a key from a password + salt using the recorded params. Deterministic: the
 * same password + salt + params always yield the same key (so unlock matches encrypt).
 */
export function deriveKey(password: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Buffer {
  if (params.algo === 'scrypt') {
    // 128 * N * r bytes of memory; give scrypt headroom over the 32 MiB default cap.
    const maxmem = 256 * 1024 * 1024
    return scryptSync(password, salt, params.keyLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem
    })
  }
  throw new Error(`Unsupported KDF algorithm: ${params.algo}`)
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
