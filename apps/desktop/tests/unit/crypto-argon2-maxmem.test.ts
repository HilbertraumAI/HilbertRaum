import { describe, it, expect, vi } from 'vitest'

// @noble/hashes 2.4 lowered argon2id's default `maxmem` to 1 GiB. deriveKey passes `maxmem` itself, at the bound
// `validateKdfBounds` accepts for a descriptor's `m` (1 GiB since T2.7's L-1, 2 GiB before), so the derive never
// depends on the library's default; this pins that it reaches the library (the real KDF still runs underneath).
// T2.7 (L-7): the same wrapper keeps what the library returned, the derived key's only other copy.
const { seen, returned } = vi.hoisted(() => ({
  seen: [] as Array<Record<string, unknown>>,
  returned: [] as Uint8Array[]
}))
vi.mock('@noble/hashes/argon2.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@noble/hashes/argon2.js')>()
  return {
    ...real,
    argon2id: (...args: Parameters<typeof real.argon2id>) => {
      seen.push({ ...args[2] })
      const out = real.argon2id(...args)
      returned.push(out)
      return out
    }
  }
})

import { deriveKey, generateSalt } from '../../src/main/services/security/crypto'

describe('deriveKey — argon2id memory cap', () => {
  it('passes maxmem at the descriptor bound (1 GiB) itself, whatever the library default', () => {
    const key = deriveKey('pw', generateSalt(), { algo: 'argon2id', m: 256, t: 1, p: 1, keyLen: 32 })
    expect(key).toHaveLength(32)
    expect(seen.at(-1)?.maxmem).toBe(2 ** 20 * 1024)
  })

  // T2.7 security fix round (L-7): the key is copied out of the library's array, and that array is zeroed, so the key
  // (the password's key: the data key's wrapping key on a v2 workspace, the file key on a v1) is left in one place only.
  it('zeroes the array the library returned once the key is copied out of it (L-7)', () => {
    const key = deriveKey('pw', generateSalt(), { algo: 'argon2id', m: 256, t: 1, p: 1, keyLen: 32 })
    const out = returned.at(-1)!
    expect(out).toHaveLength(32)
    expect(out.every((b) => b === 0)).toBe(true)
    expect(key.some((b) => b !== 0)).toBe(true)
  })
})
