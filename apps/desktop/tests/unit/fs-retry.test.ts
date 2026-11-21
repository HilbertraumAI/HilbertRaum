import { describe, it, expect, vi, beforeEach } from 'vitest'

// #986: the engine swap's renames are tried again while Windows reports a held handle (an antivirus
// scan of a fresh file, the indexer): EPERM, EACCES, EBUSY, within a fixed budget of waits. The
// rename and the wait are the module's own imports, so the seams replace those two and nothing else:
// `rename` refuses as scripted, and each wait returns at once and is recorded (no real sleep).
const seams = vi.hoisted(() => ({
  refusals: [] as string[],
  calls: 0,
  waits: [] as number[]
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...orig,
    rename: async () => {
      seams.calls++
      const code = seams.refusals.shift()
      if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('node:timers/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:timers/promises')>()
  const mocked = {
    ...orig,
    setTimeout: async (ms?: number) => {
      seams.waits.push(Number(ms))
    }
  }
  return { ...mocked, default: mocked }
})

import { RENAME_RETRY_BUDGET_MS, renameWithRetry } from '../../src/main/services/fs-retry'

beforeEach(() => {
  seams.refusals = []
  seams.calls = 0
  seams.waits = []
})

describe('renameWithRetry (#986)', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('on Windows, a rename refused with %s a few times goes through', async (code) => {
    seams.refusals = [code, code, code]
    await expect(renameWithRetry('a', 'b', 'win32')).resolves.toBeUndefined()
    expect(seams.calls).toBe(4)
    expect(seams.waits).toEqual([50, 100, 200])
  })

  it('on Windows, a rename that stays refused fails with that error once the waits reach the budget', async () => {
    seams.refusals = Array.from({ length: 100 }, () => 'EPERM')
    await expect(renameWithRetry('a', 'b', 'win32')).rejects.toMatchObject({ code: 'EPERM' })
    const waited = seams.waits.reduce((sum, ms) => sum + ms, 0)
    expect(waited).toBeLessThanOrEqual(RENAME_RETRY_BUDGET_MS)
    // About 12 s in all: the next wait would have passed the budget.
    expect(waited).toBeGreaterThan(RENAME_RETRY_BUDGET_MS - 1_000)
    expect(Math.max(...seams.waits)).toBe(1_000)
    expect(seams.calls).toBe(seams.waits.length + 1)
  })

  it('any other error is final at once, on Windows too', async () => {
    seams.refusals = ['ENOENT']
    await expect(renameWithRetry('a', 'b', 'win32')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(seams.calls).toBe(1)
    expect(seams.waits).toEqual([])
  })

  it.each(['linux', 'darwin'] as const)('on %s the first refusal stands (the codes mean a real permission problem there)', async (platform) => {
    seams.refusals = ['EPERM']
    await expect(renameWithRetry('a', 'b', platform)).rejects.toMatchObject({ code: 'EPERM' })
    expect(seams.calls).toBe(1)
    expect(seams.waits).toEqual([])
  })
})
