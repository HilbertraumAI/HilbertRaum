import { describe, it, expect, vi } from 'vitest'

// @noble/hashes 2.4 lowered argon2id's default `maxmem` to 1 GiB, below the 2 GiB that
// `validateKdfBounds` accepts for a descriptor's `m`. deriveKey therefore passes `maxmem`
// itself; this pins that it reaches the library (the real KDF still runs underneath).
const { seen } = vi.hoisted(() => ({ seen: [] as Array<Record<string, unknown>> }))
vi.mock('@noble/hashes/argon2.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@noble/hashes/argon2.js')>()
  return {
    ...real,
    argon2id: (...args: Parameters<typeof real.argon2id>) => {
      seen.push({ ...args[2] })
      return real.argon2id(...args)
    }
  }
})

import { deriveKey, generateSalt } from '../../src/main/services/security/crypto'

describe('deriveKey — argon2id memory cap', () => {
  it('passes maxmem at the descriptor bound (2 GiB), not the library default (1 GiB)', () => {
    const key = deriveKey('pw', generateSalt(), { algo: 'argon2id', m: 256, t: 1, p: 1, keyLen: 32 })
    expect(key).toHaveLength(32)
    expect(seen.at(-1)?.maxmem).toBe(2 ** 21 * 1024)
  })
})
