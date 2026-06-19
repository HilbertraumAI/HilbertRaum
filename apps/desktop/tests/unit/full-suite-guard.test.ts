import { resolve } from 'node:path'
import type { File } from 'vitest'
import { describe, expect, it } from 'vitest'
import { FullSuiteGuard, listTestFiles } from '../full-suite-guard'

const file = (name: string): File => ({ name }) as File

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
    expect(() => guard.onFinished(expected.map(file))).not.toThrow()
  })

  it('throws naming the dropped files when vitest under-collects', () => {
    const guard = new FullSuiteGuard(expected)
    const collected = [file('tests/unit/a.test.ts')] // b and c silently dropped
    expect(() => guard.onFinished(collected)).toThrow(/collected 1 of 3 test files/)
    expect(() => guard.onFinished(collected)).toThrow(/tests\/integration\/b\.test\.ts/)
    expect(() => guard.onFinished(collected)).toThrow(/tests\/renderer\/c\.test\.tsx/)
  })

  it('normalises Windows backslash paths from vitest before comparing', () => {
    const guard = new FullSuiteGuard(['tests/unit/a.test.ts'])
    expect(() => guard.onFinished([file('tests\\unit\\a.test.ts')])).not.toThrow()
  })

  it('no-ops on a filtered/subset run (expected = null), never false-failing', () => {
    const guard = new FullSuiteGuard(null)
    expect(() => guard.onFinished([])).not.toThrow()
  })
})
