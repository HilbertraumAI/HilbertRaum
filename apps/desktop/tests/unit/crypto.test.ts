import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
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
import { FAST_ARGON, FAST_KDF as FAST_SCRYPT, thrownBy } from '../helpers/vault-fixtures'

// Phase 9 — KDF + AEAD primitives (pure, no I/O).

// Fast params for the bulk of tests (they only need *a* key, not a costly one). The real
// DEFAULT_KDF (argon2id, ~0.5 s) is exercised by the known-answer vector below. That new vaults
// get it is pinned at the vault boundary (workspace-vault.test.ts, the encrypted lifecycle row
// reads the created descriptor's `kdf`).

describe('deriveKey', () => {
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
  // params would make every unlock attempt a multi-GB allocation or an endless derive (vault
  // DoS); a foreign keyLen silently changes the AES key size. Both must fail loudly instead.
  // One row per bound, every other param cheap and in range, so each row reaches one clause of
  // the bounds check: with that clause deleted the value reaches the library, which either
  // derives (a hang-sized `t`, a 17-lane `p`) or fails with its own, different message.
  // The `< 1` floors take -1, not 0: the truthiness check (`!t`) refuses a 0 as well, so a 0 row
  // stays green with its floor deleted. No row isolates the truthiness checks: the one value they
  // refuse and the floors let through is NaN (a missing param fails earlier), and JSON cannot carry it.
  it.each<[string, KdfParams, RegExp]>([
    // T2.7 (L-1): the argon2id ceilings are m 1 GiB and t 8 (they were 2 GiB and 64), the first values past them here.
    ['argon2id m above the 1 GiB ceiling', { ...FAST_ARGON, m: 2 ** 20 + 1 }, /out of bounds/],
    ['argon2id t above 8', { ...FAST_ARGON, t: 9 }, /out of bounds/],
    ['argon2id m above the 2 GiB ceiling', { ...FAST_ARGON, m: 2_000_000_000 }, /out of bounds/],
    ['argon2id m below the floor of 8', { ...FAST_ARGON, m: 7 }, /out of bounds/],
    ['argon2id t below the floor of 1', { ...FAST_ARGON, t: -1 }, /out of bounds/],
    ['argon2id t above 64', { ...FAST_ARGON, t: 65 }, /out of bounds/],
    ['argon2id p below the floor of 1', { ...FAST_ARGON, p: -1 }, /out of bounds/],
    ['argon2id p above 16', { ...FAST_ARGON, p: 17 }, /out of bounds/],
    ['scrypt N below the 1024 floor', { ...FAST_SCRYPT, N: 512 }, /out of bounds/],
    ['scrypt N that is not a power of two', { ...FAST_SCRYPT, N: 1536 }, /out of bounds/],
    ['scrypt N above 2^22', { ...FAST_SCRYPT, N: 2 ** 23 }, /out of bounds/],
    ['scrypt r below the floor of 1', { ...FAST_SCRYPT, r: -1 }, /out of bounds/],
    ['scrypt r above 32', { ...FAST_SCRYPT, r: 33 }, /out of bounds/],
    ['scrypt p below the floor of 1', { ...FAST_SCRYPT, p: -1 }, /out of bounds/],
    ['scrypt p above 16', { ...FAST_SCRYPT, p: 17 }, /out of bounds/],
    ['keyLen other than 32', { ...FAST_SCRYPT, keyLen: 64 }, /keyLen must be 32/]
  ])('rejects an out-of-bounds %s from a tampered descriptor', (_bound, params, error) => {
    expect(() => deriveKey('pw', generateSalt(), params)).toThrow(error)
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

  it('rejects a length-reduced (truncated) ciphertext (T9 — unit-tier GCM truncation)', () => {
    // Distinct from the bit-flip cases above: shortening the ciphertext changes its LENGTH, but the
    // GCM tag was computed over the full ciphertext, so decrypt must still fail authentication. The
    // streaming layer already covers a truncated on-disk frame; this pins the core `decrypt` itself.
    const blob = encrypt(key, Buffer.from('truncate me — the last byte is about to vanish'))
    blob.ciphertext = blob.ciphertext.subarray(0, blob.ciphertext.length - 1)
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

  it('rejects a buffer shorter than the 36-byte header', () => {
    expect(() => deserializeBlob(Buffer.from('not-a-paid-blob'))).toThrow(/too short/)
    expect(() => deserializeBlob(Buffer.alloc(4))).toThrow(/too short/)
  })

  // A frame with a magic this build does not write must be refused by name, never parsed as `iv | tag | ct`. One of
  // this family with a higher version byte (`HRAUMEN2`) was written by a NEWER build (#845), also when it is shorter
  // than this build's header (a newer layout need not match it); any other magic stays "unrecognised".
  it.each([
    ['HRAUMEN2', '2'],
    ['HRAUMEN9', '9']
  ])('reads a frame a newer build wrote (%s) as newer, by name (#845)', (magic, version) => {
    for (const rest of [randomBytes(12 + 16), randomBytes(4)]) {
      expect(thrownBy(() => deserializeBlob(Buffer.concat([Buffer.from(magic), rest])))).toEqual({
        name: 'VaultNewerError',
        what: 'frame',
        found: version
      })
    }
  })

  // Only a digit 2–9 after the family is a newer version (W2 review 2): `HRAUMEN0` or a letter there is one flipped bit
  // away from `HRAUMEN1`, damage that must not read as "update the app".
  it.each([
    ['PAIDENC1, the pre-0.1.10 format', Buffer.from('PAIDENC1')],
    ['bytes of no format', Buffer.from('0011223344556677', 'hex')],
    ['HRAUMEN0, the family with the digit 0', Buffer.from('HRAUMEN0')],
    ['HRAUMENq, the family with a letter', Buffer.from('HRAUMENq')]
  ])('rejects a header-sized frame with a foreign magic as unrecognised, not newer: %s', (_case, magic) => {
    const foreign = Buffer.concat([magic, randomBytes(12 + 16)])
    expect(() => deserializeBlob(foreign)).toThrow(/unrecognised header/)
    expect(thrownBy(() => deserializeBlob(foreign)).name).toBe('Error')
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

  // Existing vaults must keep unlocking across library updates: the default KDF has to
  // derive exactly the key it derived before. Vector computed with @noble/hashes 2.2.0
  // and 2.4.0 (identical); a KDF library change that alters it fails here, not at unlock.
  it('derives the known key for a fixed password + salt with the default KDF', () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
    expect(deriveKey('correct horse battery staple', salt, DEFAULT_KDF).toString('hex')).toBe(
      '818259b6310026a8e0dbac5d2e6927abcfdb07b32258fac4f61b18b80f929085'
    )
  })

  // #860 V7: the same for a vault created under the former scrypt default. No published release wrote one, but the
  // descriptor-driven dispatch keeps such a vault unlockable, so its derivation must not drift either. Vector computed
  // with `node:crypto` scryptSync directly (N 32768, r 8, p 1, maxmem 256 MiB), Node 24.13.
  it('derives the known key for a fixed password + salt with the former scrypt default', () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
    expect(deriveKey('correct horse battery staple', salt, SCRYPT_KDF).toString('hex')).toBe(
      '7a8e34241db898d59175c696538c417467a975ffe569068425f16188d3159c58'
    )
  })
})
