import { describe, it, expect } from 'vitest'
import {
  DEFAULT_KDF,
  generateSalt,
  deriveKey,
  encrypt,
  decrypt,
  serializeBlob,
  deserializeBlob,
  makeVerifier,
  verifyKey
} from '../../src/main/services/security/crypto'

// Phase 9 — KDF + AEAD primitives (pure, no I/O).

describe('deriveKey (scrypt KDF)', () => {
  it('is deterministic: same password + salt + params → same 32-byte key', () => {
    const salt = generateSalt()
    const a = deriveKey('correct horse battery staple', salt, DEFAULT_KDF)
    const b = deriveKey('correct horse battery staple', salt, DEFAULT_KDF)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
  })

  it('produces different keys for different passwords (same salt)', () => {
    const salt = generateSalt()
    const a = deriveKey('password-one', salt, DEFAULT_KDF)
    const b = deriveKey('password-two', salt, DEFAULT_KDF)
    expect(a.equals(b)).toBe(false)
  })

  it('produces different keys for different salts (same password)', () => {
    const a = deriveKey('same-password', generateSalt(), DEFAULT_KDF)
    const b = deriveKey('same-password', generateSalt(), DEFAULT_KDF)
    expect(a.equals(b)).toBe(false)
  })

  it('rejects an unsupported algorithm', () => {
    const salt = generateSalt()
    expect(() => deriveKey('pw', salt, { ...DEFAULT_KDF, algo: 'argon2id' })).toThrow()
  })
})

describe('AES-256-GCM encrypt/decrypt', () => {
  const key = deriveKey('a-strong-password', generateSalt(), DEFAULT_KDF)

  it('round-trips arbitrary bytes', () => {
    const plaintext = Buffer.from('the quick brown fox 🦊 — bytes ☃ end')
    const blob = encrypt(key, plaintext)
    expect(blob.iv.length).toBe(12)
    expect(blob.tag.length).toBe(16)
    expect(decrypt(key, blob).equals(plaintext)).toBe(true)
  })

  it('uses a fresh IV per encryption (ciphertexts differ for the same input)', () => {
    const pt = Buffer.from('repeat me')
    const a = encrypt(key, pt)
    const b = encrypt(key, pt)
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  it('fails to decrypt with the wrong key', () => {
    const blob = encrypt(key, Buffer.from('secret'))
    const wrongKey = deriveKey('wrong-password', generateSalt(), DEFAULT_KDF)
    expect(() => decrypt(wrongKey, blob)).toThrow()
  })

  it('detects tampering with the ciphertext (auth-tag failure)', () => {
    const blob = encrypt(key, Buffer.from('integrity matters'))
    blob.ciphertext[0] ^= 0xff
    expect(() => decrypt(key, blob)).toThrow()
  })

  it('detects tampering with the auth tag', () => {
    const blob = encrypt(key, Buffer.from('integrity matters'))
    blob.tag[0] ^= 0xff
    expect(() => decrypt(key, blob)).toThrow()
  })
})

describe('serializeBlob / deserializeBlob', () => {
  const key = deriveKey('serialize-pw', generateSalt(), DEFAULT_KDF)

  it('round-trips through the framed on-disk format', () => {
    const pt = Buffer.from('on-disk database bytes')
    const buf = serializeBlob(encrypt(key, pt))
    const parsed = deserializeBlob(buf)
    expect(decrypt(key, parsed).equals(pt)).toBe(true)
  })

  it('rejects a buffer with a foreign/short header', () => {
    expect(() => deserializeBlob(Buffer.from('not-a-paid-blob'))).toThrow()
    expect(() => deserializeBlob(Buffer.alloc(4))).toThrow()
  })
})

describe('password verifier', () => {
  it('verifies the right key and rejects the wrong key without touching the DB', () => {
    const salt = generateSalt()
    const key = deriveKey('vault-password', salt, DEFAULT_KDF)
    const verifier = makeVerifier(key)
    expect(verifyKey(key, verifier)).toBe(true)

    const wrongKey = deriveKey('not-the-password', salt, DEFAULT_KDF)
    expect(verifyKey(wrongKey, verifier)).toBe(false)
  })
})
