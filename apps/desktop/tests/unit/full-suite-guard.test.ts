import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { TestModule, TestSpecification, Vitest } from 'vitest/node'
import { BaseSequencer } from 'vitest/node'
import { describe, expect, it } from 'vitest'
import { FullSuiteGuard, listTestFiles, parseShard, shardTestFiles } from '../full-suite-guard'

/** A literal backslash, spelled without one so no codegen pass can mangle it. */
const BACKSLASH = String.fromCharCode(92)

const file = (relativeModuleId: string): TestModule => ({ relativeModuleId }) as TestModule

/** Calls the guard's hook the way vitest does when a run ends. */
const finish = (guard: FullSuiteGuard, modules: TestModule[]): void => void guard.onTestRunEnd(modules, [], 'passed')

describe('listTestFiles', () => {
  it('walks the test tree and returns posix-relative *.test.{ts,tsx} paths including this file', () => {
    const root = resolve(__dirname, '..', '..')
    const files = listTestFiles(root, resolve(root, 'tests'))
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('tests/unit/full-suite-guard.test.ts')
    expect(files.every((f) => /\.test\.tsx?$/.test(f))).toBe(true)
    expect(files.every((f) => !f.includes('\\'))).toBe(true) // posix separators only
  })
})

describe('FullSuiteGuard', () => {
  const expected = ['tests/unit/a.test.ts', 'tests/integration/b.test.ts', 'tests/renderer/c.test.tsx']

  it('passes silently when every expected file was collected', () => {
    const guard = new FullSuiteGuard(expected)
    expect(() => finish(guard, expected.map(file))).not.toThrow()
  })

  it('throws naming the dropped files when vitest under-collects', () => {
    const guard = new FullSuiteGuard(expected)
    const collected = [file('tests/unit/a.test.ts')] // b and c silently dropped
    expect(() => finish(guard, collected)).toThrow(/collected 1 of 3 test files/)
    expect(() => finish(guard, collected)).toThrow(/tests\/integration\/b\.test\.ts/)
    expect(() => finish(guard, collected)).toThrow(/tests\/renderer\/c\.test\.tsx/)
  })

  it('normalises Windows backslash paths from vitest before comparing', () => {
    const guard = new FullSuiteGuard(['tests/unit/a.test.ts'])
    expect(() => finish(guard, [file('tests\\unit\\a.test.ts')])).not.toThrow()
  })

  it('no-ops on a filtered/subset run (expected = null), never false-failing', () => {
    const guard = new FullSuiteGuard(null)
    expect(() => finish(guard, [])).not.toThrow()
  })
})

// ---- Sharding (#458 step 2) ----------------------------------------------------------------

describe('parseShard', () => {
  it('reads the `=` form CI uses, and the space form', () => {
    expect(parseShard(['--shard=1/2'])).toEqual({ index: 1, count: 2 })
    expect(parseShard(['--shard', '2/2'])).toEqual({ index: 2, count: 2 })
    expect(parseShard(['--reporter=dot', '--shard=3/4', '--bail=1'])).toEqual({ index: 3, count: 4 })
  })

  it('treats a bare count as 1/1 (vitest accepts `--shard=1`)', () => {
    expect(parseShard(['--shard=1'])).toEqual({ index: 1, count: 1 })
  })

  it('is null when absent, so the guard enforces the whole suite', () => {
    expect(parseShard([])).toBeNull()
    expect(parseShard(['--reporter=dot'])).toBeNull()
  })

  // Fail SAFE: an unparseable shard must not narrow the expected set to a lucky subset —
  // null means "enforce everything", which over-reports rather than passing a dropped file.
  it('is null for a malformed or out-of-range value (over-strict, never silently off)', () => {
    for (const bad of ['--shard=0/2', '--shard=3/2', '--shard=2/0', '--shard=a/b', '--shard=/2', '--shard=1/2/3', '--shard=-1/2']) {
      expect(parseShard([bad]), bad).toBeNull()
    }
    expect(parseShard(['--shard'])).toBeNull() // flag with no value
  })
})

describe('shardTestFiles — reproduces vitest 4.1.11 BaseSequencer.shard', () => {
  const root = resolve(__dirname, '..', '..')
  const files = listTestFiles(root, resolve(root, 'tests'))

  it('splits the real suite into a complete, disjoint cover', () => {
    for (const count of [2, 3, 4]) {
      const shards = Array.from({ length: count }, (_, i) => shardTestFiles(files, { index: i + 1, count }))
      expect(new Set(shards.flat()).size, `count=${count} union`).toBe(files.length)
      expect(shards.reduce((n, s) => n + s.length, 0), `count=${count} no overlap`).toBe(files.length)
      // vitest 4's `calculateShardRange`: the first `length % count` shards take one extra file.
      const base = Math.floor(files.length / count)
      const sizes = shards.map((s) => s.length)
      expect(sizes, `count=${count} sizes`).toEqual(sizes.map((_, i) => (i < files.length % count ? base + 1 : base)))
    }
  })

  // The pin that would have caught the vitest 3 → 4 change by itself: run vitest's OWN
  // sequencer (the installed version) over the real suite and demand the same split. A future
  // vitest that changes the algorithm fails here, at the desk, rather than on the sharded legs.
  it('assigns every file to the same shard as the installed vitest BaseSequencer', async () => {
    const posixRoot = '/repo'
    const specs = files.map((f) => ({ moduleId: `${posixRoot}/${f}` }) as TestSpecification)
    for (const count of [2, 3, 4, 5]) {
      for (let index = 1; index <= count; index++) {
        const ctx = { config: { root: posixRoot, shard: { index, count } } } as unknown as Vitest
        const theirs = (await new BaseSequencer(ctx).shard(specs)).map((s) => s.moduleId.slice(posixRoot.length + 1))
        expect(shardTestFiles(files, { index, count }), `shard ${index}/${count}`).toEqual(theirs)
      }
    }
  })

  it('a single shard is the whole suite', () => {
    expect(shardTestFiles(files, { index: 1, count: 1 }).sort()).toEqual([...files].sort())
  })

  it('returns input (posix) paths, so the result compares to what the reporter collects', () => {
    const shard = shardTestFiles(files, { index: 1, count: 2 })
    expect(shard.every((f) => !f.includes(BACKSLASH))).toBe(true)
    expect(shard.every((f) => files.includes(f))).toBe(true)
  })

  it('is stable: the same shard twice is the same list', () => {
    expect(shardTestFiles(files, { index: 2, count: 3 })).toEqual(shardTestFiles(files, { index: 2, count: 3 }))
  })

  // THE regression test for this helper. vitest hashes `/` + the POSIX root-relative path
  // (its `resolve` is pathe, which normalises away from `\` on windows), so the split is the
  // same on every platform. A native-separator implementation type-checks, looks equivalent,
  // and silently assigns a different half — it agreed with a real `--shard=1/2` run on only
  // 109 of 225 files, i.e. chance. These fixed vectors pin the exact hashed string, so that
  // mistake cannot come back unnoticed on a machine where `sep === '/'`.
  it('hashes `/` + the posix path — pinned against sha1 vectors, platform-independent', () => {
    const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')
    // Two files whose relative order under the real algorithm is fixed by these digests.
    const sample = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts']
    const byHash = [...sample].sort((x, y) => (sha1(`/${x}`) < sha1(`/${y}`) ? -1 : 1))
    expect(shardTestFiles(sample, { index: 1, count: 2 })).toEqual([byHash[0]])
    expect(shardTestFiles(sample, { index: 2, count: 2 })).toEqual([byHash[1]])
    // And NOT the native-separator variant, on any platform.
    const nat = (f: string): string => BACKSLASH + f.split('/').join(BACKSLASH)
    const byNativeHash = [...sample].sort((x, y) => (sha1(nat(x)) < sha1(nat(y)) ? -1 : 1))
    if (byNativeHash[0] !== byHash[0]) {
      expect(shardTestFiles(sample, { index: 1, count: 2 })).not.toEqual([byNativeHash[0]])
    }
  })
})

describe('FullSuiteGuard under sharding', () => {
  const root = resolve(__dirname, '..', '..')
  const files = listTestFiles(root, resolve(root, 'tests'))

  it('passes when a shard collected exactly its own subset, and fails when that shard drops one', () => {
    const mine = shardTestFiles(files, { index: 1, count: 2 })
    expect(() => finish(new FullSuiteGuard(mine), mine.map(file))).not.toThrow()
    expect(() => finish(new FullSuiteGuard(mine), mine.slice(1).map(file))).toThrow(/were dropped/)
  })

  // The failure this whole section exists to prevent: enforcing the WHOLE suite against a
  // shard. Pinned so nobody "simplifies" the config back to passing `allTestFiles`.
  it('would fail every sharded run if handed the whole suite instead of the shard', () => {
    const mine = shardTestFiles(files, { index: 1, count: 2 })
    expect(() => finish(new FullSuiteGuard(files), mine.map(file))).toThrow(/were dropped/)
  })
})
