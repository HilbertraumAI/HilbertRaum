import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareSemver, parseSemver, type Semver } from '../../src/main/services/updates/version'
import { DESKTOP_ROOT, repoText } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'

// The SemVer 2.0.0 grammar and precedence order that `updates.max_version` rests on (F-8, the app-update wave's T3.1; plan
// W-13, P3 entry decision 7). Release 1 orders versions this way for ever, so the expected values are the F-8 golden's
// `semver` part, written from semver.org 2.0.0 by hand (tests/fixtures/readers/f8-policy/PROVENANCE.md). The
// `max_version` table itself runs through the policy reader, in policy.test.ts.

type Part = { text: string } | { base64: string } | { repeat: string; times: number }
type Entry = string | { name: string; parts: Part[] }
interface SemverGolden {
  valid: Entry[]
  invalid: Entry[]
  ascending: string[]
  below: Array<[string, string, string]>
  equal: Array<[string, string]>
}

const SEMVER = (JSON.parse(repoText('apps', 'desktop', 'tests', 'fixtures', 'readers', 'f8-policy', 'vectors.json')) as { semver: SemverGolden }).semver

const textOf = (e: Entry): string =>
  typeof e === 'string'
    ? e
    : e.parts
        .map((p) => ('text' in p ? p.text : 'base64' in p ? Buffer.from(p.base64, 'base64').toString('utf8') : p.repeat.repeat(p.times)))
        .join('')
const label = (e: Entry): string => (typeof e === 'string' ? JSON.stringify(e) : e.name)

/** The parse of a string the golden lists as valid; a row that reaches here with an invalid one fails on its own. */
function parsed(text: string): Semver {
  const v = parseSemver(text)
  expect(v, `${JSON.stringify(text)} should parse`).not.toBeNull()
  return v!
}

describe('parseSemver: strict SemVer 2.0.0, at most 256 characters (F-8 golden)', () => {
  it.each(SEMVER.valid.map((e) => [label(e), textOf(e)]))('accepts %s', (_label, text) => {
    expect(parseSemver(text)?.text).toBe(text)
  })

  it.each(SEMVER.invalid.map((e) => [label(e), textOf(e)]))('refuses %s', (_label, text) => {
    expect(parseSemver(text)).toBeNull()
  })

  // A policy file or a release manifest is JSON, so the parser meets whatever value the file holds.
  it.each<[string, unknown]>([
    ['a number', 1.5],
    ['null', null],
    ['undefined', undefined],
    ['a list', ['1.0.0']],
    ['an object', { version: '1.0.0' }]
  ])('refuses a value that is not a string: %s', (_label, value) => {
    expect(parseSemver(value)).toBeNull()
  })
})

describe('compareSemver: SemVer 2.0.0 precedence (§11), build metadata ignored (§10)', () => {
  it("orders the spec's §11 chain, every pair both ways", () => {
    const chain = SEMVER.ascending.map(parsed)
    for (let i = 0; i < chain.length; i++) {
      expect(compareSemver(chain[i], chain[i]), SEMVER.ascending[i]).toBe(0)
      for (let j = i + 1; j < chain.length; j++) {
        const pair = `${SEMVER.ascending[i]} < ${SEMVER.ascending[j]}`
        expect(compareSemver(chain[i], chain[j]), pair).toBe(-1)
        expect(compareSemver(chain[j], chain[i]), pair).toBe(1)
      }
    }
  })

  it.each(SEMVER.below)('%s is below %s: %s', (low, high) => {
    expect(compareSemver(parsed(low), parsed(high))).toBe(-1)
    expect(compareSemver(parsed(high), parsed(low))).toBe(1)
  })

  it.each(SEMVER.equal)('%s and %s have the same precedence', (a, b) => {
    expect(compareSemver(parsed(a), parsed(b))).toBe(0)
    expect(compareSemver(parsed(b), parsed(a))).toBe(0)
  })
})

// P4's release tools load this file through Node's own type stripping (P3 entry decision 7, T4.2): no import, and only
// TypeScript that stripping can erase (an `enum` or a parameter property stops the load). The typecheck sees neither.
describe('version.ts loads under Node type stripping', () => {
  it('a plain node process imports it and orders a pre-release below its release', () => {
    const url = pathToFileURL(join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'version.ts')).href
    const r = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(url)}); console.log(m.compareSemver(m.parseSemver('1.0.0-rc.1'), m.parseSemver('1.0.0')))`
      ],
      { encoding: 'utf8', timeout: testBudgetMs(60_000) }
    )
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('-1')
  })
})
