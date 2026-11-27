import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareSemver, parseSemver, type Semver } from '../../src/main/services/updates/version'
import { DESKTOP_ROOT, repoText } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'
import {
  FLOOR_MAX_BYTES,
  checkVersionRule,
  meetsFloor,
  parseFloor,
  type VersionRuleApp,
  type VersionRuleResult
} from '../../src/main/services/updates/version'
import { rootArtifactOf, type RootApp, type RootEntryKind } from '../../src/main/services/updates/drive-release'
import { appOlderThanMinimum, type AppVersionRead, type VersionCore } from '../../src/shared/app-version'
import { skillNeedsNewerApp } from '../../src/shared/skill-manifest'

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

// ---- The update version rule and the OS floors (app-update F-4, G-19 (b), G-24; T4.2). Each row is a row of the
// record's tables (docs/app-updates.md §2.5 "The version rule's values", §2.4 "A floor's grammar" and "Comparing"),
// written out by hand. The pipeline's vectors (tests/fixtures/updates/vectors/, the version-rule form included) run in
// updates-payload.test.ts, which reads every vectors*.json of a set and routes each vector by its form (§10.7).

/** The root apps `rootApps` would list for these entries (drive-release.ts's globs), so a row names real root names. */
function root(...entries: Array<[string, RootEntryKind]>): RootApp[] {
  return entries.map(([name, kind]) => {
    const artifact = rootArtifactOf(name, kind)
    expect(artifact, `${name} should be a root app`).not.toBeNull()
    return { name, kind, ...artifact! }
  })
}

/** What a row compares: `accepted`, or the refusal's code and parameters; and the flag. */
function ruleOutcome(r: VersionRuleResult): unknown {
  return { answer: r.accepted ? 'accepted' : { code: r.refusal.code, params: r.refusal.params }, staleDriveVersion: r.staleDriveVersion }
}

const rule = (version: string, running: string, drive: string | null = null, apps: readonly VersionRuleApp[] | null = []): unknown =>
  ruleOutcome(checkVersionRule(parsed(version), parsed(running), drive, apps))

const ACCEPTED = (stale = false) => ({ answer: 'accepted', staleDriveVersion: stale })
const SAME_OR_OLDER = (version: string, running: string, driveVersion: string | null, stale = false) => ({
  answer: { code: 'UPD-SAME-OR-OLDER', params: { version, runningVersion: running, driveVersion } },
  staleDriveVersion: stale
})

describe('checkVersionRule: newer than the running version (record §2.5, "Order", "The answer")', () => {
  it.each<[string, string, string, 'accepted' | 'refused']>([
    ['a patch above', '1.0.1', '1.0.0', 'accepted'],
    ['a minor above', '1.1.0', '1.0.9', 'accepted'],
    ['a major above', '2.0.0', '1.99.99', 'accepted'],
    ['numbers, not text: 0.1.10 above 0.1.9', '0.1.10', '0.1.9', 'accepted'],
    ['numbers, not text: 0.1.9 below 0.1.10', '0.1.9', '0.1.10', 'refused'],
    ['the same version (refused)', '1.0.0', '1.0.0', 'refused'],
    ['only the build metadata differs (no precedence, SemVer §10)', '1.0.0+b', '1.0.0+a', 'refused'],
    ['a release above its own pre-release', '0.2.0', '0.2.0-rc.1', 'accepted'],
    ['a pre-release below its release (0.2.0-rc.1 < 0.2.0)', '0.2.0-rc.1', '0.2.0', 'refused'],
    ['a later pre-release', '0.2.0-rc.2', '0.2.0-rc.1', 'accepted'],
    ['numeric identifiers as numbers (rc.10 above rc.9)', '0.2.0-rc.10', '0.2.0-rc.9', 'accepted'],
    ['a downgrade', '0.9.0', '1.0.0', 'refused'],
    ['exact digits beyond 2^53', '9007199254740993.0.0', '9007199254740992.0.0', 'accepted']
  ])('%s: %s over %s is %s (no drive version)', (_label, version, running, answer) => {
    expect(rule(version, running)).toEqual(answer === 'accepted' ? ACCEPTED() : SAME_OR_OLDER(version, running, null))
  })
})

describe('checkVersionRule: not below the drive\u{2019}s app_version where it counts (record §2.5)', () => {
  const carrying = (v: string) => root([`HilbertRaum-${v}-portable.exe`, 'file'])

  it.each<[string, string, string, string, unknown]>([
    ['below a counting drive version: a downgrade below the drive', '1.1.0', '1.0.0', '1.2.0', SAME_OR_OLDER('1.1.0', '1.0.0', '1.2.0')],
    ["equal to it: a lagging system installs the drive's version (equal passes)", '1.2.0', '1.0.0', '1.2.0', ACCEPTED()],
    ['above it', '1.3.0', '1.0.0', '1.2.0', ACCEPTED()],
    ["a pre-release of the drive's version is below it", '1.2.0-rc.1', '1.0.0', '1.2.0', SAME_OR_OLDER('1.2.0-rc.1', '1.0.0', '1.2.0')],
    ['a drive version below the running one: the running version decides', '1.0.1', '1.0.0', '0.9.0', ACCEPTED()],
    ['between the drive and the running version: still not newer than this one', '0.9.5', '1.0.0', '0.9.0', SAME_OR_OLDER('0.9.5', '1.0.0', '0.9.0')],
    ['equal to both', '1.0.0', '1.0.0', '1.0.0', SAME_OR_OLDER('1.0.0', '1.0.0', '1.0.0')],
    [
      'after "Go back" from 2.0.0 (app_version rewritten to the target): a 1.0.x maintenance version is accepted; highest_version_seen is no input',
      '1.0.1',
      '1.0.0',
      '1.0.0',
      ACCEPTED()
    ],
    [
      'after "Go back" from 2.0.0, or an automatic fallback from it (app_version never advanced): 2.0.0 is accepted again',
      '2.0.0',
      '1.0.0',
      '1.0.0',
      ACCEPTED()
    ]
  ])('%s: %s, running %s, drive %s', (_label, version, running, drive, want) => {
    expect(rule(version, running, drive, carrying(drive))).toEqual(want)
  })
})

describe('checkVersionRule: which app_version counts, and staleDriveVersion (record §2.5, §4.4; Δ-75 rows 3, 6)', () => {
  it.each<[string, string | null, readonly VersionRuleApp[] | null, string, string | null]>([
    ['carried byte for byte by a root file (1.4.0-rc.1 is carried, never 1.4.0)', '1.4.0-rc.1', root(['HilbertRaum-1.4.0-rc.1-portable.exe', 'file']), '1.3.0', '1.4.0-rc.1'],
    ["carried by another system's app", '1.4.0', root(['HilbertRaum-1.4.0.AppImage', 'file']), '1.3.0', '1.4.0'],
    ['carried by the macOS zip', '1.4.0', root(['HilbertRaum-1.4.0-mac-arm64.app.zip', 'file']), '1.3.0', '1.4.0'],
    ['a root *.app folder (no known version) keeps the floor', '1.4.0', root(['HilbertRaum.app', 'folder']), '1.3.0', '1.4.0'],
    ['a root *.app folder keeps it beside a file of another version', '1.4.0', root(['HilbertRaum-1.3.0-portable.exe', 'file'], ['HilbertRaum.app', 'folder']), '1.3.0', '1.4.0'],
    ['a root that could not be listed (null) keeps the floor', '1.4.0', null, '1.3.0', '1.4.0']
  ])('%s: counts', (_label, drive, apps, version, driveVersion) => {
    expect(rule(version, '1.0.0', drive, apps)).toEqual(SAME_OR_OLDER(version, '1.0.0', driveVersion))
  })

  it.each<[string, string, readonly VersionRuleApp[]]>([
    ['no root app carries it: only a pre-release of it', '1.4.0', root(['HilbertRaum-1.4.0-rc.1-portable.exe', 'file'])],
    ['a root file of no known version keeps nothing', '1.4.0', root(['HilbertRaum-junk-portable.exe', 'file'])],
    ['equal precedence is not the same bytes (1.4.0+b does not carry 1.4.0+a)', '1.4.0+a', root(['HilbertRaum-1.4.0+b-portable.exe', 'file'])],
    ['an empty root', '1.4.0', []]
  ])('%s: stale, treated as absent', (_label, drive, apps) => {
    expect(rule('1.3.0', '1.0.0', drive, apps)).toEqual(ACCEPTED(true))
    // A refusal by the running version carries the flag too, and no driveVersion (none counted).
    expect(rule('0.9.0', '1.0.0', drive, apps)).toEqual(SAME_OR_OLDER('0.9.0', '1.0.0', null, true))
  })

  it.each<[string, string | null]>([
    ['no drive version (null)', null],
    ["a drive version that does not parse counts as null (F-13: invalid is absent; the T4.2 sheet's Q4)", 'junk']
  ])('%s: no constraint, nothing stale', (_label, drive) => {
    const apps = root(['HilbertRaum-1.4.0-portable.exe', 'file'], ['HilbertRaum.app', 'folder'])
    expect(rule('1.1.0', '1.0.0', drive, apps)).toEqual(ACCEPTED())
    expect(rule('1.1.0', '1.0.0', drive, null)).toEqual(ACCEPTED())
    expect(rule('0.9.0', '1.0.0', drive, apps)).toEqual(SAME_OR_OLDER('0.9.0', '1.0.0', null))
  })
})

// The plan's agreement row (P4 entry Δ-75 row 1; the precedent: skill-manifest.test.ts's "agrees with the model gate"):
// `appOlderThanMinimum` is the skills and models gates' comparison, core-only on the minimum side. On every version both
// read (a strict SemVer app version; a release-core minimum), "the candidate `min` is newer than the running app" must
// be exactly "the app is older than `min`". The reads are written out, not computed by the test. Outside the shared
// domain, and never asserted equal: a pre-release minimum (the gates cannot hold one), leading zeros (parseSemver refuses
// them, the skills gate reads them), numbers of 2^53 or more, lenient forms (`v0.1.66`, `0.1.66.4`, padding).
const AGREEMENT_APPS: ReadonlyArray<readonly [string, AppVersionRead]> = [
  ['0.0.9', { core: [0, 0, 9], prerelease: false }],
  ['0.1.65', { core: [0, 1, 65], prerelease: false }],
  ['0.1.66', { core: [0, 1, 66], prerelease: false }],
  ['0.1.67', { core: [0, 1, 67], prerelease: false }],
  ['0.1.100', { core: [0, 1, 100], prerelease: false }],
  ['1.0.0', { core: [1, 0, 0], prerelease: false }],
  ['0.1.66-beta.1', { core: [0, 1, 66], prerelease: true }],
  ['0.1.66-0', { core: [0, 1, 66], prerelease: true }],
  ['0.1.66+abc', { core: [0, 1, 66], prerelease: false }],
  ['0.1.66-beta.1+abc', { core: [0, 1, 66], prerelease: true }],
  ['0.1.67-beta.1', { core: [0, 1, 67], prerelease: true }],
  ['1.0.0-rc.1', { core: [1, 0, 0], prerelease: true }],
  ['0.0.0-test', { core: [0, 0, 0], prerelease: true }],
  ['10.20.30', { core: [10, 20, 30], prerelease: false }]
]
const AGREEMENT_MINIMUMS: ReadonlyArray<readonly [string, VersionCore]> = [
  ['0.0.0', [0, 0, 0]],
  ['0.1.9', [0, 1, 9]],
  ['0.1.10', [0, 1, 10]],
  ['0.1.65', [0, 1, 65]],
  ['0.1.66', [0, 1, 66]],
  ['0.1.67', [0, 1, 67]],
  ['1.0.0', [1, 0, 0]],
  ['10.20.30', [10, 20, 30]]
]

describe('checkVersionRule agrees with appOlderThanMinimum on every version both read (Δ-75 row 1)', () => {
  it('a candidate is newer than the running app exactly when the gates call the app older than it', () => {
    for (const [app, read] of AGREEMENT_APPS) {
      for (const [min, core] of AGREEMENT_MINIMUMS) {
        const older = appOlderThanMinimum(read, core)
        expect(skillNeedsNewerApp(min, app), `${app} / ${min}: the written-out read is the gate's own`).toBe(older)
        expect(checkVersionRule(parsed(min), parsed(app), null, []).accepted, `candidate ${min}, running ${app}`).toBe(older)
      }
    }
  })
})

describe('parseFloor: the floor grammar, for the payload\u{2019}s floors and the host\u{2019}s values (record §2.4)', () => {
  const longest = '1' + '.1'.repeat(31) + '1' // 64 bytes

  it('the bound is 64 bytes', () => {
    expect(FLOOR_MAX_BYTES).toBe(64)
    expect(longest.length).toBe(FLOOR_MAX_BYTES)
  })

  it.each<[string, string, number[]]>([
    ['one component', '2', [2]],
    ['two', '2.34', [2, 34]],
    ['three (a Windows host)', '10.0.26300', [10, 0, 26300]],
    ['a leading zero means nothing', '07.1', [7, 1]],
    ['zero', '0', [0]],
    ['nine digits', '999999999', [999999999]],
    ['nine digits with leading zeros', '000000007', [7]],
    ['more components than a host has', '1.2.3.4.5', [1, 2, 3, 4, 5]],
    ['64 bytes', longest, [1, ...Array<number>(30).fill(1), 11]]
  ])('reads %s: %j', (_label, text, parts) => {
    expect(parseFloor(text)).toEqual(parts)
  })

  it.each<[string, unknown]>([
    ['ten digits', '1234567890'],
    ['65 bytes', '11' + '.1'.repeat(31) + '1'],
    ['empty', ''],
    ['a lone dot', '.'],
    ['an empty last component', '2.'],
    ['an empty first component', '.2'],
    ['an empty middle component', '2..34'],
    ['a leading space', ' 2.34'],
    ['a trailing space', '2.34 '],
    ['a trailing line break', '2.34\n'],
    ['a plus sign', '+2'],
    ['a minus sign', '-2'],
    ['a letter', '2.x'],
    ['a v', 'v2'],
    ['a comma', '2,34'],
    ['a distro suffix', '2.39-0ubuntu8'],
    ['a full-width digit', '\u{FF12}.34'],
    ['an Arabic-Indic digit', '\u{662}.34'],
    ['a number', 2.34],
    ['null', null],
    ['undefined', undefined],
    ['a list holding a floor (its text would pass)', ['2']]
  ])('refuses %s', (_label, text) => {
    expect(parseFloor(text)).toBeNull()
  })
})

describe('meetsFloor: component by component as integers, a missing component 0 (record §2.4, "Comparing")', () => {
  it.each<[string, number[], number[], boolean]>([
    ['equal', [2, 34], [2, 34], true],
    ['above', [2, 39], [2, 34], true],
    ['below', [2, 33], [2, 34], false],
    ['integers, not text: 9 is below 10', [9], [10], false],
    ['integers, not text: 10 is above 9', [10], [9], true],
    ['integers, not text: 2.39 is above 2.4', [2, 39], [2, 4], true],
    ['a missing component is 0: 10.0 meets 10.0.0', [10, 0], [10, 0, 0], true],
    ['a missing component is 0: 10.0.0 meets 10.0', [10, 0, 0], [10, 0], true],
    ['a missing component is 0: 2 is below 2.1', [2], [2, 1], false],
    ['a missing component is 0: 2.1 is above 2', [2, 1], [2], true],
    ['the first difference decides', [15, 1, 0], [14, 9, 9], true],
    ['a later component below', [10, 0, 26300], [10, 0, 26301], false],
    ['a later component at the floor', [10, 0, 26300], [10, 0, 26300], true],
    ['a further component above 0 is never met by a shorter host', [2, 39], [2, 39, 1], false]
  ])('%s: host %j, floor %j', (_label, host, floor, meets) => {
    expect(meetsFloor(host, floor)).toBe(meets)
  })
})

// P4's release tools load version.ts through Node's own type stripping (Δ-75 row 4), with or without P3's sibling hook,
// so its T4.2 additions keep the file free of value imports. This second no-hook row runs the additions themselves.
describe('version.ts\u{2019}s version rule and floor grammar load under Node type stripping', () => {
  it('a plain node process without the hook runs checkVersionRule and parseFloor', () => {
    const url = pathToFileURL(join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'version.ts')).href
    const script = [
      `const m = await import(${JSON.stringify(url)})`,
      "const rule = m.checkVersionRule(m.parseSemver('1.3.0'), m.parseSemver('1.0.0'), '1.4.0', [{ kind: 'folder', version: null }])",
      "console.log(JSON.stringify([rule.accepted, rule.refusal.params.driveVersion, m.parseFloor('2.34'), m.meetsFloor([10, 0], [10, 0, 0])]))"
    ].join('\n')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: testBudgetMs(60_000)
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('[false,"1.4.0",[2,34],true]')
  })
})
