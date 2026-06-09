import { describe, it, expect } from 'vitest'
import {
  DEFAULT_KDF,
  SCRYPT_KDF,
  generateSalt,
  deriveKey,
  encrypt,
  decrypt,
  serializeBlob,
  deserializeBlob,
  makeVerifier,
  verifyKey,
  type KdfParams
} from '../../src/main/services/security/crypto'

// Phase 9 — KDF + AEAD primitives (pure, no I/O).

// Fast params for the bulk of tests (they only need *a* key, not a costly one). The real
// DEFAULT_KDF (argon2id, ~0.5 s) is exercised in a couple of targeted tests below.
const FAST_SCRYPT: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const FAST_ARGON: KdfParams = { algo: 'argon2id', m: 256, t: 1, p: 1, keyLen: 32 }

describe('deriveKey', () => {
  it('defaults new vaults to argon2id', () => {
    expect(DEFAULT_KDF.algo).toBe('argon2id')
    expect(SCRYPT_KDF.algo).toBe('scrypt')
  })

  for (const params of [FAST_SCRYPT, FAST_ARGON]) {
    describe(params.algo, () => {
      it('is deterministic: same password + salt + params → same 32-byte key', () => {
        const salt = generateSalt()
        const a = deriveKey('correct horse battery staple', salt, params)
        const b = deriveKey('correct horse battery staple', salt, params)
        expect(a.length).toBe(32)
        expect(a.equals(b)).toBe(true)
      })

      it('produces different keys for different passwords (same salt)', () => {
        const salt = generateSalt()
        expect(deriveKey('password-one', salt, params).equals(deriveKey('password-two', salt, params))).toBe(
          false
        )
      })

      it('produces different keys for different salts (same password)', () => {
        const a = deriveKey('same-password', generateSalt(), params)
        const b = deriveKey('same-password', generateSalt(), params)
        expect(a.equals(b)).toBe(false)
      })
    })
  }

  it('argon2id and scrypt yield different keys for the same password+salt', () => {
    const salt = generateSalt()
    expect(deriveKey('pw', salt, FAST_ARGON).equals(deriveKey('pw', salt, FAST_SCRYPT))).toBe(false)
  })

  it('rejects an unsupported algorithm', () => {
    const salt = generateSalt()
    expect(() => deriveKey('pw', salt, { ...FAST_SCRYPT, algo: 'pbkdf2' as 'scrypt' })).toThrow(
      /Unsupported KDF/
    )
  })

  it('rejects incomplete params for the chosen algorithm', () => {
    const salt = generateSalt()
    expect(() => deriveKey('pw', salt, { algo: 'argon2id', keyLen: 32 })).toThrow(/argon2id parameters/)
    expect(() => deriveKey('pw', salt, { algo: 'scrypt', keyLen: 32 })).toThrow(/scrypt parameters/)
  })

  // SEC-B (audit round 4): the descriptor is unencrypted + attacker-writable. Unbounded
  // params would make every unlock attempt a multi-GB allocation (vault DoS); a foreign
  // keyLen silently changes the AES key size. Both must fail loudly instead.
  it('rejects out-of-bounds params from a tampered descriptor', () => {
    const salt = generateSalt()
    expect(() =>
      deriveKey('pw', salt, { algo: 'argon2id', m: 2_000_000_000, t: 2, p: 1, keyLen: 32 })
    ).toThrow(/out of bounds/)
    expect(() =>
      deriveKey('pw', salt, { algo: 'scrypt', N: 1000, r: 8, p: 1, keyLen: 32 }) // not a power of two
    ).toThrow(/out of bounds/)
    expect(() => deriveKey('pw', salt, { ...FAST_SCRYPT, keyLen: 64 })).toThrow(/keyLen/)
  })
})

describe('AES-256-GCM encrypt/decrypt', () => {
  const key = deriveKey('a-strong-password', generateSalt(), FAST_SCRYPT)

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
    const wrongKey = deriveKey('wrong-password', generateSalt(), FAST_SCRYPT)
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
  const key = deriveKey('serialize-pw', generateSalt(), FAST_SCRYPT)

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
    const key = deriveKey('vault-password', salt, FAST_ARGON)
    const verifier = makeVerifier(key)
    expect(verifyKey(key, verifier)).toBe(true)

    const wrongKey = deriveKey('not-the-password', salt, FAST_ARGON)
    expect(verifyKey(wrongKey, verifier)).toBe(false)
  })

  it('round-trips a key derived with the real default KDF (argon2id)', () => {
    const salt = generateSalt()
    const key = deriveKey('real-default-kdf', salt, DEFAULT_KDF)
    expect(verifyKey(key, makeVerifier(key))).toBe(true)
  })
})
