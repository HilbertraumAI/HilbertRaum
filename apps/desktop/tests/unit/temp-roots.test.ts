import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDeferredRoot,
  cleanupRecordedRoots,
  isTestTempRoot,
  pendingTempRoots,
  readDeferredRoots,
  removeTempRoot,
  sweepDeferredRoots
} from '../helpers/temp-roots'

// Issue #335: the harness-level temp-root hygiene (tests/helpers/temp-roots.ts,
// tests/setup-temp-roots.ts, tests/global-temp-roots.ts). Before it, a full `npm test` left
// ~2,500 `hilbertraum-*` roots behind in the OS temp dir, every run, across ~120 files.

describe('temp roots: what may be removed', () => {
  it('a hilbertraum-* or hr-* directory directly under the temp dir is a test root; anything else is not', () => {
    const tmp = tmpdir()
    expect(isTestTempRoot(join(tmp, 'hilbertraum-picker-seams-abc123'))).toBe(true)
    expect(isTestTempRoot(join(tmp, 'hr-engine-root-abc123'))).toBe(true)
    // Nested inside a root: removed with the root, never on its own.
    expect(isTestTempRoot(join(tmp, 'hilbertraum-x-abc123', 'hilbertraum-nested-def456'))).toBe(false)
    // An unrelated name under the temp dir, and a test-looking name elsewhere.
    expect(isTestTempRoot(join(tmp, 'vitest-deferred-temp-roots-1.txt'))).toBe(false)
    expect(isTestTempRoot(join(tmp, 'something-else-abc123'))).toBe(false)
    expect(isTestTempRoot(join(tmp, 'elsewhere', 'hilbertraum-abc123'))).toBe(false)
    expect(isTestTempRoot('/', tmp)).toBe(false)
  })
})

describe('temp roots: removal never fails a suite', () => {
  it('removes a real root with its contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-test-'))
    mkdirSync(join(root, 'workspace'))
    writeFileSync(join(root, 'workspace', 'file.txt'), 'x')
    expect(await removeTempRoot(root)).toBe(true)
    expect(existsSync(root)).toBe(false)
  })

  it('retries once after a real macrotask when the first attempt fails (a Windows EBUSY)', async () => {
    const calls: string[] = []
    let first = true
    const rm = (path: string): void => {
      calls.push(path)
      if (first) {
        first = false
        const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException
        err.code = 'EBUSY'
        throw err
      }
    }
    expect(await removeTempRoot(join(tmpdir(), 'hilbertraum-fake-'), { rm, delayMs: 1 })).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('reports a root it cannot remove as false — and throws nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-stuck-'))
    const rm = (): void => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }
    expect(await removeTempRoot(root, { rm, delayMs: 1 })).toBe(false)
    expect(existsSync(root)).toBe(true)
    expect(await removeTempRoot(root)).toBe(true)
  })

  it('a missing root is a no-op success', async () => {
    expect(await removeTempRoot(join(tmpdir(), 'hilbertraum-never-existed-'))).toBe(true)
  })
})

describe('temp roots: the deferred list and the post-run sweep', () => {
  it('appends, deduplicates, sweeps only test roots, and deletes the list', async () => {
    const list = join(mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-list-')), 'deferred.txt')
    const stuck = mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-deferred-'))
    const foreign = mkdtempSync(join(tmpdir(), 'not-a-test-root-'))
    appendDeferredRoot(stuck, list)
    appendDeferredRoot(stuck, list)
    appendDeferredRoot(foreign, list)
    expect(readDeferredRoots(list)).toEqual([stuck, foreign])
    const result = await sweepDeferredRoots(list)
    expect(result).toEqual({ removed: 1, remaining: [] })
    expect(existsSync(stuck)).toBe(false)
    // Not a test root: skipped by the sweep, whatever the list says.
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(list)).toBe(false)
    await removeTempRoot(foreign)
  })

  it('without a list (a bare vitest run) appending is a silent no-op', () => {
    expect(() => appendDeferredRoot(join(tmpdir(), 'hilbertraum-x-'), undefined)).not.toThrow()
  })
})

describe('temp roots: the harness records what a test file mints (tests/setup-temp-roots.ts)', () => {
  it('a sync mkdtemp and an async one are recorded; cleanupRecordedRoots removes them and empties the registry', async () => {
    const sync = mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-sync-'))
    const asyncRoot = await mkdtemp(join(tmpdir(), 'hr-temp-roots-async-'))
    // A root NOT directly under the temp dir is never recorded.
    const nested = mkdtempSync(join(sync, 'hilbertraum-nested-'))
    expect(pendingTempRoots()).toContain(sync)
    expect(pendingTempRoots()).toContain(asyncRoot)
    expect(pendingTempRoots()).not.toContain(nested)

    const result = await cleanupRecordedRoots()
    expect(result.removed).toBeGreaterThanOrEqual(2)
    expect(result.remaining).toEqual([])
    expect(existsSync(sync)).toBe(false)
    expect(existsSync(asyncRoot)).toBe(false)
    expect(pendingTempRoots()).toEqual([])
  })

  it('a root that cannot be removed goes onto the deferred list instead of failing', async () => {
    const list = join(mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-list2-')), 'deferred.txt')
    const previous = process.env.HILBERTRAUM_TEST_DEFERRED_ROOTS
    process.env.HILBERTRAUM_TEST_DEFERRED_ROOTS = list
    try {
      const root = mkdtempSync(join(tmpdir(), 'hilbertraum-temp-roots-stuck2-'))
      const rm = (): void => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      }
      const result = await cleanupRecordedRoots({ rm, delayMs: 1 })
      expect(result.remaining).toContain(root)
      expect(readDeferredRoots(list)).toContain(root)
      expect(await sweepDeferredRoots(list)).toMatchObject({ remaining: [] })
      expect(existsSync(root)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.HILBERTRAUM_TEST_DEFERRED_ROOTS
      else process.env.HILBERTRAUM_TEST_DEFERRED_ROOTS = previous
    }
  })
})
