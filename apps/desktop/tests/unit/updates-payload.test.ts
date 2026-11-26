import { afterEach, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  FILES_MAX_ENTRIES,
  MEMBER_SIZE_MAX,
  SUMMARY_MAX_CODE_POINTS,
  checkPayload,
  parseIssued,
  readPayloadFiles,
  summaryText,
  type PayloadInput,
  type PayloadResult,
  type VerifiedEnvelope
} from '../../src/main/services/updates/payload'
import { verifyEnvelope, type UpdateKey } from '../../src/main/services/updates/envelope'
import { checkVersionRule, parseSemver, type Semver } from '../../src/main/services/updates/version'
import { isReleaseVersion, rootApps, type RootApp } from '../../src/main/services/updates/drive-release'
import { appOlderThanMinimum, type AppVersionRead, type VersionCore } from '../../src/shared/app-version'
import { DESKTOP_ROOT, REPO_ROOT, repoText } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'
import { envelopeBytes, vectorSetFiles } from '../helpers/update-vectors'

// The update file's signed payload (app-update W-2, W-63, W-75; F-2, F-4, F-18's names; T4.2): every row is a row of the
// record's tables (docs/app-updates.md §2.4 "The payload's values", §2.5 "The version rule's values", §2.10 "The
// verdicts", §4.3's `files[]` row, §4.5's order), written out by hand. Release 1 answers these for ever. The payload check
// takes the verified arm of verifyEnvelope's result (the T4.2 sheet's Q8: "verify before parsing" holds in the type), so
// these rows build `{ verified: true, payload }` directly; the golden vectors below run the whole pipeline over signed
// envelopes. Non-ASCII test strings are written as `\u{…}` escapes.

const sha = (label: string): string => createHash('sha256').update(label).digest('hex')

/** A version the row needs as parsed (the running version, a cap). */
function v(text: string): Semver {
  const parsed = parseSemver(text)
  expect(parsed, `${JSON.stringify(text)} should parse`).not.toBeNull()
  return parsed!
}

const APPLY = { name: 'apply.cmd', size: 4096, sha256: sha('apply.cmd'), role: 'script' }
const EXE = { name: 'HilbertRaum-1.1.0-portable.exe', size: 104857600, sha256: sha('exe'), group: 'win32', role: 'app' }
const START = { name: 'Start-HilbertRaum.cmd', size: 2048, sha256: sha('start'), install_as: 'Start HilbertRaum.cmd', role: 'start-file' }

/** The accepted form of the three entries above (§2.10: `group` and `installAs` or null; `role` never read). */
const APPLY_OUT = { name: 'apply.cmd', size: 4096, sha256: sha('apply.cmd'), group: null, installAs: null }
const EXE_OUT = { name: 'HilbertRaum-1.1.0-portable.exe', size: 104857600, sha256: sha('exe'), group: 'win32', installAs: null }
const START_OUT = { name: 'Start-HilbertRaum.cmd', size: 2048, sha256: sha('start'), group: null, installAs: 'Start HilbertRaum.cmd' }

const BASE: Readonly<Record<string, unknown>> = {
  format: 1,
  product: 'hilbertraum',
  kind: 'release',
  channel: 'stable',
  version: '1.1.0',
  issued: '2027-01-10T08:00:00Z',
  files: [APPLY, EXE, START]
}

/** A value written into the payload's text as it stands (`1.0`, `1e3`): JSON.stringify would respell a number. */
const raw = (text: string): Record<string, string> => ({ '@raw': text })
const isRaw = (value: unknown): value is { '@raw': string } => typeof value === 'object' && value !== null && Object.hasOwn(value, '@raw')

/** The payload's text: `BASE` with `fields` over it (a field set to `undefined` is left out). */
function payloadText(fields: Readonly<Record<string, unknown>> = {}, base: Readonly<Record<string, unknown>> = BASE): string {
  const raws: string[] = []
  const text = JSON.stringify({ ...base, ...fields }, (_key, value: unknown) => (isRaw(value) ? `@@raw${raws.push(value['@raw']) - 1}@@` : value))
  return text.replace(/"@@raw(\d+)@@"/g, (_m, i: string) => raws[Number(i)]!)
}

const verified = (payload: string | Buffer): VerifiedEnvelope => ({ verified: true, payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8') })

const NOW = Date.parse('2027-01-15T12:00:00Z')
const RUNNING = '1.0.0'
const COMMON = { runningVersion: v(RUNNING), driveAppVersion: null, rootApps: [], maxVersion: null, now: NOW, uiLanguage: 'en' } as const
/** The host's two arms (the T4.2 sheet's Q3): a Windows or macOS version string, or Linux's glibc (null when absent). */
type SystemHost = Extract<PayloadInput, { os: 'win32' | 'darwin' }>
type LinuxHost = Extract<PayloadInput, { os: 'linux' }>
const WIN: SystemHost = { ...COMMON, os: 'win32', osVersion: '10.0.26300', glibc: null }
const MAC: SystemHost = { ...COMMON, os: 'darwin', osVersion: '15.1.0', glibc: null }
const LINUX: LinuxHost = { ...COMMON, os: 'linux', osVersion: null, glibc: '2.39' }
const HOSTS: ReadonlyArray<readonly [string, PayloadInput]> = [
  ['win32', WIN],
  ['darwin', MAC],
  ['linux', LINUX]
]

/** What most rows compare: `accepted`, or the refusal's code and parameters. */
function answer(r: PayloadResult): unknown {
  return r.accepted ? 'accepted' : { code: r.refusal.code, params: r.refusal.params }
}
const check = (fields: Readonly<Record<string, unknown>> = {}, host: PayloadInput = WIN): PayloadResult => checkPayload(verified(payloadText(fields)), host)
const run = (fields: Readonly<Record<string, unknown>> = {}, host: PayloadInput = WIN): unknown => answer(check(fields, host))

/** The accepted payload, or a failure that names the refusal. */
function accepted(r: PayloadResult) {
  if (!r.accepted) throw new Error(`refused: ${r.refusal.code}`)
  return r.payload
}

const TOO_NEW = (running = RUNNING) => ({ code: 'UPD-TOO-NEW', params: { runningVersion: running } })
const NOT_AN_UPDATE = { code: 'UPD-NOT-AN-UPDATE', params: {} }
const FOR_NEWER = (running = RUNNING) => ({ code: 'UPD-FOR-NEWER-HILBERTRAUM', params: { runningVersion: running } })
const WRONG_CHANNEL = { code: 'UPD-WRONG-CHANNEL', params: {} }
const NEEDS = (minUpgradeFrom: string, running = RUNNING) => ({ code: 'UPD-NEEDS-IN-BETWEEN', params: { runningVersion: running, minUpgradeFrom } })
const SAME_OR_OLDER = (version: string, driveVersion: string | null = null, running = RUNNING) => ({
  code: 'UPD-SAME-OR-OLDER',
  params: { version, runningVersion: running, driveVersion }
})
const ABOVE_MAX = (version: string, maxVersion: string) => ({ code: 'UPD-ABOVE-MAX-VERSION', params: { version, maxVersion } })
const CANT_CHECK = (running = RUNNING) => ({ code: 'UPD-CANT-CHECK-LINUX-FLOOR', params: { runningVersion: running } })
const OS_TOO_OLD = (system: string, floor: string, hostVersion: string, running = RUNNING) => ({
  code: 'UPD-OS-TOO-OLD',
  params: { runningVersion: running, system, floor, hostVersion }
})

const GOOD = payloadText()

/** Sets a value on Object.prototype for one call, so a row can show that only own keys are read. */
function withInherited<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  try {
    return body()
  } finally {
    delete (Object.prototype as Record<string, unknown>)[key]
  }
}

describe('checkPayload: the reading (record §2.4, "Reading")', () => {
  it.each<[string, string | Buffer]>([
    ['no JSON', 'this is no JSON'],
    ['a byte-order mark before a good payload', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GOOD)])],
    ['bytes that are not UTF-8 (C3 28) in an ignored key', Buffer.concat([Buffer.from(GOOD.slice(0, -1) + ',"note":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])],
    ['a top-level array', `[${GOOD}]`],
    ['a top-level null', 'null'],
    ['a top-level string', '"hilbertraum"'],
    ['a top-level number', '1'],
    ['no bytes', ''],
    ['a payload cut short', GOOD.slice(0, -1)],
    ['the good payload under an own __proto__ key (an unknown key: format is missing)', `{"__proto__":${GOOD}}`]
  ])('%s: UPD-TOO-NEW (a known key signed it, so it is a later writer\u{2019}s file, never damage)', (_label, payload) => {
    expect(answer(checkPayload(verified(payload), WIN))).toEqual(TOO_NEW())
  })

  it('an own __proto__ key is an unknown key, and ignored', () => {
    expect(answer(checkPayload(verified(GOOD.slice(0, -1) + ',"__proto__":{"channel":"beta","format":2}}'), WIN))).toBe('accepted')
  })

  it('with a duplicate key the last one counts', () => {
    expect(answer(checkPayload(verified(GOOD.slice(0, -1) + ',"channel":"beta"}'), WIN))).toEqual(WRONG_CHANNEL)
    expect(answer(checkPayload(verified('{"channel":"beta",' + GOOD.slice(1)), WIN))).toBe('accepted')
  })

  it('a value reached through the prototype is no value: only own keys are read', () => {
    expect(withInherited('channel', 'stable', () => run({ channel: undefined }))).toEqual(WRONG_CHANNEL)
    expect(withInherited('min_upgrade_from', '9.0.0', () => run())).toBe('accepted')
    expect(withInherited('win32', '99', () => run({ requires: { linux: '2.31' } }))).toBe('accepted')
    expect(withInherited('group', 'linux', () => accepted(check()).files)).toEqual([APPLY_OUT, EXE_OUT, START_OUT])
    expect(withInherited('en', 'An inherited summary.', () => accepted(check({ summary: {} })).summary)).toBeNull()
  })

  // T4.2 review 1, m-4: `requires` itself is read as an own key only. The floor 99 refuses on this host when it is read.
  it('a requires reached through the prototype, or held under an own __proto__ key, is no requires: no floor', () => {
    expect(run({ requires: { win32: '99' } })).toEqual(OS_TOO_OLD('win32', '99', '10.0.26300'))
    expect(answer(checkPayload(verified(GOOD.slice(0, -1) + ',"__proto__":{"requires":{"win32":"99"}}}'), WIN))).toBe('accepted')
    expect(withInherited('requires', { win32: '99' }, () => run())).toBe('accepted')
  })

  it('unknown fields are ignored, and the parsed value is never walked as a whole (5,000 levels in an ignored key)', () => {
    const deep = '['.repeat(5000) + ']'.repeat(5000)
    const text = GOOD.slice(0, -1) + `,"engine":{"llama":"b12110"},"security":"x","notes":${deep}}`
    expect(answer(checkPayload(verified(text), WIN))).toBe('accepted')
  })
})

describe('checkPayload: format, product, kind and channel (record §2.4, §2.6)', () => {
  it.each<[string, unknown]>([
    ['1', 1],
    ['1.0', raw('1.0')],
    ['1e0', raw('1e0')],
    ['10e-1', raw('10e-1')],
    ['a number text the parse rounds to 1', raw('1.00000000000000001')]
  ])('format %s is 1: accepted', (_label, format) => {
    expect(run({ format })).toBe('accepted')
  })

  it.each<[string, unknown]>([
    ['2', 2],
    ['2.0', raw('2.0')],
    ['0', 0],
    ['1.5', raw('1.5')],
    ['-1', -1],
    ['the string "1"', '1'],
    ['null', null],
    ['true', true],
    ['a list', [1]],
    ['missing', undefined]
  ])('format %s: UPD-TOO-NEW with the in-between hint', (_label, format) => {
    expect(run({ format })).toEqual(TOO_NEW())
  })

  it.each<[string, unknown]>([
    ['another case', 'HilbertRaum'],
    ['a trailing space', 'hilbertraum '],
    ['another product', 'other-product'],
    ['empty', ''],
    ['null', null],
    ['a number', 1],
    ['a list', ['hilbertraum']],
    ['missing', undefined]
  ])('product %s: UPD-NOT-AN-UPDATE (no parameters)', (_label, product) => {
    expect(run({ product })).toEqual(NOT_AN_UPDATE)
  })

  it.each<[string, unknown]>([
    ['a model pack', 'model-pack'],
    ['definitions', 'definitions'],
    ['another case', 'Release'],
    ['a trailing space', 'release '],
    ['empty', ''],
    ['null', null],
    ['a number', 1],
    ['missing', undefined]
  ])('kind %s: UPD-FOR-NEWER-HILBERTRAUM (W-63, G-30)', (_label, kind) => {
    expect(run({ kind })).toEqual(FOR_NEWER())
  })

  it.each<[string, unknown]>([
    ['beta', 'beta'],
    ['Stable (code unit for code unit)', 'Stable'],
    ['STABLE', 'STABLE'],
    ['a trailing space', 'stable '],
    ['empty', ''],
    ['null', null],
    ['true', true],
    ['missing', undefined]
  ])('channel %s: UPD-WRONG-CHANNEL (G-22)', (_label, channel) => {
    expect(run({ channel })).toEqual(WRONG_CHANNEL)
  })
})

describe('checkPayload: version and min_upgrade_from (record §2.4; CF-36)', () => {
  const v64 = '1.1.0-' + 'a'.repeat(58)
  const v65 = '1.1.0-' + 'a'.repeat(59)

  it.each([['1.1.0'], ['1.1.0-rc.1'], ['1.1.0+build.5'], [v64]])('version %s: accepted, carried as written', (version) => {
    expect(v64.length).toBe(64)
    expect(accepted(check({ version })).version).toBe(version)
  })

  it.each<[string, unknown]>([
    ['65 bytes (SemVer, but not a release version: it becomes a folder name and app_version)', v65],
    ['257 characters', '1.1.0-' + 'a'.repeat(251)],
    ['a v', 'v1.1.0'],
    ['two components', '1.1'],
    ['a leading zero', '01.1.0'],
    ['a trailing space', '1.1.0 '],
    ['empty', ''],
    ['a number', raw('1.1')],
    ['null', null],
    ['a list', ['1.1.0']],
    ['missing', undefined]
  ])('version %s: UPD-TOO-NEW', (_label, version) => {
    expect(v65.length).toBe(65)
    expect(run({ version })).toEqual(TOO_NEW())
  })

  it.each<[string, unknown]>([
    ['absent: no constraint', undefined],
    ['equal to the running version: passes', '1.0.0'],
    ['below it', '0.9.0'],
    ['equal precedence (build metadata no part)', '1.0.0+b'],
    ['a pre-release of the running version (below it)', '1.0.0-rc.1']
  ])('min_upgrade_from %s: accepted', (_label, min) => {
    expect(run({ min_upgrade_from: min })).toBe('accepted')
  })

  it.each<[string, string, string]>([
    ['a patch above', '1.0.1', RUNNING],
    ['as written (build metadata kept)', '1.0.1+b', RUNNING],
    ['a pre-release above', '1.1.0-rc.1', RUNNING],
    ['a release above a pre-release running version', '1.0.0', '1.0.0-rc.1']
  ])('min_upgrade_from %s: UPD-NEEDS-IN-BETWEEN', (_label, min, running) => {
    expect(run({ min_upgrade_from: min }, { ...WIN, runningVersion: v(running) })).toEqual(NEEDS(min, running))
  })

  it.each<[string, unknown]>([
    ['null (a writer omits the field)', null],
    ['no version', 'garbled'],
    ['two components', '1.0'],
    ['65 bytes', v65],
    ['a number', 1]
  ])('min_upgrade_from %s: UPD-TOO-NEW', (_label, min) => {
    expect(run({ min_upgrade_from: min })).toEqual(TOO_NEW())
  })
})

// The P7 hand-off re-checks the cap with policy.ts's updateInstallVerdict, so the import and the hand-off must give one
// answer: on F-8's golden max_version table (read as data, never through policy.ts), UPD-ABOVE-MAX-VERSION holds exactly
// where the golden says `above-max`, for every row whose version is a release version (§2.4: anything else is
// UPD-TOO-NEW first). A row without a cap is never above it.
describe('checkPayload: updates.max_version agrees with F-8\u{2019}s golden max_version table (record §2.10, §4.5)', () => {
  interface MaxRow {
    max: string | null
    version: string
    verdict: 'allowed' | 'above-max'
    why?: string
  }
  const rows = (JSON.parse(repoText('apps', 'desktop', 'tests', 'fixtures', 'readers', 'f8-policy', 'vectors.json')) as { maxVersion: MaxRow[] }).maxVersion
  const runnable = rows.filter((r) => isReleaseVersion(r.version))

  it('reads the golden table (27 rows; 23 with a release version: 1.5, v1.4.0, "" and 1.5 again are none)', () => {
    expect(rows.length).toBe(27)
    expect(runnable.length).toBe(23)
  })

  it.each(runnable.map((r) => [String(r.max), r.version, r.verdict, r] as const))('max %s, version %s: %s', (_max, _version, _verdict, r) => {
    const host = { ...WIN, runningVersion: v('0.0.0-0'), maxVersion: r.max === null ? null : v(r.max) }
    expect(run({ version: r.version }, host)).toEqual(r.verdict === 'above-max' ? ABOVE_MAX(r.version, r.max!) : 'accepted')
  })
})

describe('checkPayload: requires, the OS floors (record §2.4; G-24, Δ-39)', () => {
  it.each(HOSTS)('requires absent, or empty, on %s: accepted', (_os, host) => {
    expect(run({}, host)).toBe('accepted')
    expect(run({ requires: {} }, host)).toBe('accepted')
  })

  const notObject: ReadonlyArray<readonly [string, unknown]> = [
    ['a list', []],
    ['null', null],
    ['a string', '10.0'],
    ['a number', 10],
    ['true', true]
  ]
  it.each(HOSTS.flatMap(([os, host]) => notObject.map(([label, value]) => [label, os, host, value] as const)))(
    'requires that is %s, on %s: UPD-TOO-NEW',
    (_label, _os, host, requires) => {
      expect(run({ requires }, host)).toEqual(TOO_NEW())
    }
  )

  const garbled: ReadonlyArray<readonly [string, unknown]> = [
    ['a letter', '2.x'],
    ['empty', ''],
    ['a number', 2.34],
    ['null', null],
    ['an empty component', '2..34'],
    ['a leading space', ' 2.34'],
    ['ten digits', '1234567890'],
    ['a list holding a floor', ['2']]
  ]
  it.each(HOSTS.flatMap(([os, host]) => garbled.map(([label, value]) => [label, os, host, value] as const)))(
    'a linux floor that breaks the grammar (%s), on %s: UPD-CANT-CHECK-LINUX-FLOOR (fail closed on every system)',
    (_label, _os, host, linux) => {
      expect(run({ requires: { linux } }, host)).toEqual(CANT_CHECK())
    }
  )
  it.each(HOSTS.flatMap(([os, host]) => garbled.flatMap(([label, value]) => (['win32', 'darwin'] as const).map((system) => [system, label, os, host, value] as const))))(
    'a %s floor that breaks the grammar (%s), on %s: UPD-TOO-NEW (on every system)',
    (system, _label, _os, host, floor) => {
      expect(run({ requires: { [system]: floor } }, host)).toEqual(TOO_NEW())
    }
  )

  it.each<[string, PayloadInput, Record<string, unknown>, unknown]>([
    ['linux before win32, on win32', WIN, { win32: '10.x', linux: '2.x' }, CANT_CHECK()],
    ['linux before darwin, on darwin', MAC, { darwin: '15.x', linux: '2.x' }, CANT_CHECK()],
    ['linux before win32, on linux', LINUX, { win32: '10.x', linux: '2.x' }, CANT_CHECK()],
    ['the forms before this system\u{2019}s floor: darwin garbled, win32 above the host, on win32', WIN, { win32: '99', darwin: '15.x' }, TOO_NEW()],
    ['the forms before this system\u{2019}s floor: win32 garbled, linux above the host, on linux', LINUX, { linux: '9.0', win32: '10.x' }, TOO_NEW()],
    ['the forms before the host\u{2019}s glibc: win32 garbled, glibc unreadable', { ...LINUX, glibc: null }, { linux: '2.0', win32: '10.x' }, TOO_NEW()]
  ])('the order (%s)', (_label, host, requires, want) => {
    expect(run({ requires }, host)).toEqual(want)
  })

  it.each<[string, PayloadInput, Record<string, unknown>, unknown]>([
    ['win32 at the host version', WIN, { win32: '10.0.26300' }, 'accepted'],
    ['win32 below it (a shorter floor: 10.0 = 10.0.0)', WIN, { win32: '10.0' }, 'accepted'],
    ['win32 one component', WIN, { win32: '10' }, 'accepted'],
    ['win32 a fourth component 0', WIN, { win32: '10.0.26300.0' }, 'accepted'],
    ['win32 an old system', WIN, { win32: '6.1' }, 'accepted'],
    ['win32 a leading zero', WIN, { win32: '010.0' }, 'accepted'],
    ['win32 above the host by one build', WIN, { win32: '10.0.26301' }, OS_TOO_OLD('win32', '10.0.26301', '10.0.26300')],
    ['win32 a major above', WIN, { win32: '11' }, OS_TOO_OLD('win32', '11', '10.0.26300')],
    ['win32 a fourth component above 0', WIN, { win32: '10.0.26300.1' }, OS_TOO_OLD('win32', '10.0.26300.1', '10.0.26300')],
    ['win32 as written (a leading zero kept)', WIN, { win32: '010.1' }, OS_TOO_OLD('win32', '010.1', '10.0.26300')],
    ['darwin at the host version', MAC, { darwin: '15.1.0' }, 'accepted'],
    ['darwin a shorter floor', MAC, { darwin: '15.1' }, 'accepted'],
    ['darwin below', MAC, { darwin: '14.7.1' }, 'accepted'],
    ['darwin above', MAC, { darwin: '15.2' }, OS_TOO_OLD('darwin', '15.2', '15.1.0')],
    ['darwin a major above', MAC, { darwin: '16' }, OS_TOO_OLD('darwin', '16', '15.1.0')],
    ['linux at the host glibc', LINUX, { linux: '2.39' }, 'accepted'],
    ['linux integers, not text (2.4 is below 2.39)', LINUX, { linux: '2.4' }, 'accepted'],
    ['linux one component', LINUX, { linux: '2' }, 'accepted'],
    ['linux above', LINUX, { linux: '2.40' }, OS_TOO_OLD('linux', '2.40', '2.39')],
    ['linux a third component above 0', LINUX, { linux: '2.39.1' }, OS_TOO_OLD('linux', '2.39.1', '2.39')],
    ['linux a major above', LINUX, { linux: '3' }, OS_TOO_OLD('linux', '3', '2.39')]
  ])("this system's floor: %s", (_label, host, requires, want) => {
    expect(run({ requires }, host)).toEqual(want)
  })

  it.each<[string, PayloadInput, Record<string, unknown>]>([
    ['win32: the other systems\u{2019} floors above every host', WIN, { darwin: '99', linux: '99' }],
    ['darwin: the same', MAC, { win32: '99', linux: '99' }],
    ['linux: the same', LINUX, { win32: '99', darwin: '99' }]
  ])('%s are never compared here', (_label, host, requires) => {
    expect(run({ requires }, host)).toBe('accepted')
  })

  it.each(HOSTS)('unknown keys and systems are ignored, whatever their value, on %s', (_os, host) => {
    expect(run({ requires: { freebsd: 'x', Win32: 'x', 'linux ': 'x', win: 'x', android: null } }, host)).toBe('accepted')
  })

  it.each<[string, string | null, Record<string, unknown> | undefined, unknown]>([
    ['glibc absent (null), a linux floor named', null, { linux: '2.0' }, CANT_CHECK()],
    ['glibc empty, a linux floor named', '', { linux: '2.0' }, CANT_CHECK()],
    ['glibc with a suffix, a linux floor named', '2.39-0ubuntu8', { linux: '2.0' }, CANT_CHECK()],
    ['glibc absent, only another system\u{2019}s floor', null, { win32: '10' }, 'accepted'],
    ['glibc absent, no requires', null, undefined, 'accepted'],
    ['glibc with a leading zero (the same grammar)', '02.39', { linux: '2.39' }, 'accepted']
  ])('on linux, %s', (_label, glibc, requires, want) => {
    expect(run({ requires }, { ...LINUX, glibc })).toEqual(want)
  })

  it.each<[string, PayloadInput, Record<string, unknown> | undefined, unknown]>([
    ['win32, a host version outside the grammar, a win32 floor named: meets no floor (fail closed)', { ...WIN, osVersion: '' }, { win32: '10' }, OS_TOO_OLD('win32', '10', '')],
    ['win32, another host text, as given', { ...WIN, osVersion: 'Windows 11' }, { win32: '10' }, OS_TOO_OLD('win32', '10', 'Windows 11')],
    ['darwin, the same', { ...MAC, osVersion: '15.1.0 (24B83)' }, { darwin: '15' }, OS_TOO_OLD('darwin', '15', '15.1.0 (24B83)')],
    ['win32, a host version outside the grammar, no win32 floor', { ...WIN, osVersion: '' }, { darwin: '1', linux: '1' }, 'accepted'],
    ['win32, a host version outside the grammar, no requires', { ...WIN, osVersion: '' }, undefined, 'accepted'],
    ['win32, a host version with a leading zero (the same grammar)', { ...WIN, osVersion: '010.0.26300' }, { win32: '10.0.26300' }, 'accepted']
  ])('%s', (_label, host, requires, want) => {
    expect(run({ requires }, host)).toEqual(want)
  })
})

describe('checkPayload: the other systems\u{2019} floors, a warning with an accepted payload (record §2.4, §2.10)', () => {
  const ALL = { win32: '10', darwin: '13', linux: '2.31' }
  // As rootApps lists them (drive-release.ts's rootArtifactOf), written out.
  const EXE_APP: RootApp = { name: 'HilbertRaum-1.0.0-portable.exe', kind: 'file', system: 'win32', version: '1.0.0' }
  const ZIP_APP: RootApp = { name: 'HilbertRaum-1.0.0-mac-arm64.app.zip', kind: 'file', system: 'darwin', version: '1.0.0' }
  const MAC_FOLDER: RootApp = { name: 'HilbertRaum.app', kind: 'folder', system: 'darwin', version: null }
  const LINUX_APP: RootApp = { name: 'HilbertRaum-1.0.0.AppImage', kind: 'file', system: 'linux', version: '1.0.0' }
  const JUNK_LINUX_APP: RootApp = { name: 'HilbertRaum-junk.AppImage', kind: 'file', system: 'linux', version: null }

  it.each<[string, PayloadInput, readonly RootApp[] | null, Record<string, unknown>, unknown[]]>([
    ['every system has an app', WIN, [EXE_APP, ZIP_APP, LINUX_APP], ALL, [{ system: 'darwin', floor: '13' }, { system: 'linux', floor: '2.31' }]],
    ['only this system has an app', WIN, [EXE_APP], ALL, []],
    ['a root *.app folder is a macOS app', WIN, [EXE_APP, MAC_FOLDER], ALL, [{ system: 'darwin', floor: '13' }]],
    ['an app of no known version is an app', WIN, [EXE_APP, JUNK_LINUX_APP], ALL, [{ system: 'linux', floor: '2.31' }]],
    ['the root could not be listed: every one named', WIN, null, ALL, [{ system: 'darwin', floor: '13' }, { system: 'linux', floor: '2.31' }]],
    ['the order is win32, darwin, linux, not the payload\u{2019}s', LINUX, null, { linux: '2.31', darwin: '13', win32: '10' }, [{ system: 'win32', floor: '10' }, { system: 'darwin', floor: '13' }]],
    ['on darwin', MAC, [EXE_APP, LINUX_APP, MAC_FOLDER], { linux: '2.31', win32: '10' }, [{ system: 'win32', floor: '10' }, { system: 'linux', floor: '2.31' }]],
    ['a floor as written', WIN, null, { darwin: '07.1' }, [{ system: 'darwin', floor: '07.1' }]],
    ['a floor above every host is only shown', LINUX, [EXE_APP], { win32: '99' }, [{ system: 'win32', floor: '99' }]],
    ['no floor named for a system with an app', WIN, [EXE_APP, ZIP_APP, LINUX_APP], { win32: '10' }, []],
    ['no requires', WIN, [EXE_APP, ZIP_APP, LINUX_APP], {}, []]
  ])('%s', (_label, host, apps, requires, floors) => {
    expect(accepted(check({ requires }, { ...host, rootApps: apps })).flags.otherSystemFloors).toEqual(floors)
  })
})

describe('checkPayload: issued, the two clock checks (record §2.4; owner 2026-11-26)', () => {
  it.each([
    '2027-01-10T08:00:00Z',
    '2000-01-01T00:00:00Z',
    '9999-12-31T23:59:59Z',
    '2024-02-29T12:00:00Z',
    '2000-02-29T00:00:00Z',
    '2027-04-30T23:59:59Z',
    '2027-12-31T00:00:00Z'
  ])('parseIssued reads %s', (text) => {
    expect(parseIssued(text)).toBe(Date.parse(text))
  })

  it.each<[string, unknown]>([
    ['a year before 2000', '1999-12-31T23:59:59Z'],
    ['29 February of a common year', '2023-02-29T00:00:00Z'],
    ['29 February of a century that is no leap year', '2100-02-29T00:00:00Z'],
    ['31 April', '2027-04-31T00:00:00Z'],
    ['month 13', '2027-13-01T00:00:00Z'],
    ['month 0', '2027-00-10T00:00:00Z'],
    ['day 0', '2027-01-00T00:00:00Z'],
    ['day 32', '2027-01-32T00:00:00Z'],
    ['hour 24', '2027-01-10T24:00:00Z'],
    ['minute 60', '2027-01-10T23:60:00Z'],
    ['a leap second', '2027-01-10T23:59:60Z'],
    ['a fraction (toISOString)', '2027-01-10T08:00:00.000Z'],
    ['an offset (git %cI)', '2027-01-10T08:00:00+00:00'],
    ['no zone', '2027-01-10T08:00:00'],
    ['a space for T', '2027-01-10 08:00:00Z'],
    ['lower-case t and z', '2027-01-10t08:00:00z'],
    ['no seconds', '2027-01-10T08:00Z'],
    ['a date only', '2027-01-10'],
    ['a two-digit year', '27-01-10T08:00:00Z'],
    ['an expanded year', '+002027-01-10T08:00:00Z'],
    ['a leading space', ' 2027-01-10T08:00:00Z'],
    ['a trailing space', '2027-01-10T08:00:00Z '],
    ['a one-digit month', '2027-1-10T08:00:00Z'],
    ['a full-width digit', '2027-01-1\u{FF10}T08:00:00Z']
  ])('parseIssued refuses %s', (_label, text) => {
    expect(parseIssued(text)).toBeNull()
  })

  const at = (issued: string, nowMs: number) => accepted(check({ issued }, { ...WIN, now: nowMs }))
  const flagsOf = (p: ReturnType<typeof accepted>) => ({ issued: p.issued, issuedInFuture: p.flags.issuedInFuture, oldFile: p.flags.oldFile })

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['garbled, far in the past', '1999-12-31T23:59:59Z'],
    ['garbled, far in the future', '2099-02-30T00:00:00Z'],
    ['a fraction', '2000-01-01T00:00:00.000Z'],
    ['a number', 0]
  ])('issued %s: accepted, no date shown, neither check runs', (_label, issued) => {
    expect(flagsOf(accepted(check({ issued }, { ...WIN, now: Date.parse('2060-01-01T00:00:00Z') })))).toEqual({ issued: null, issuedInFuture: false, oldFile: false })
  })

  const FUTURE = '2027-01-16T12:00:00Z'
  const PAST = '2026-01-15T12:00:00Z'
  it.each<[string, string, number, boolean, boolean]>([
    ['exactly 24 hours ahead: no warning', FUTURE, Date.parse(FUTURE) - 86_400_000, false, false],
    ['1 ms more than 24 hours ahead: the warning', FUTURE, Date.parse(FUTURE) - 86_400_001, true, false],
    ['14 hours ahead (a clock in the wrong time zone): no warning', FUTURE, Date.parse(FUTURE) - 14 * 3_600_000, false, false],
    ['now itself', FUTURE, Date.parse(FUTURE), false, false],
    ['exactly 365 days old: not old', PAST, Date.parse(PAST) + 31_536_000_000, false, false],
    ['1 ms more than 365 days old: the confirmation', PAST, Date.parse(PAST) + 31_536_000_001, false, true],
    ['12 calendar months that are 366 days: old (a day count, not months)', '2027-02-28T00:00:00Z', Date.parse('2028-02-29T00:00:00Z'), false, true]
  ])('%s', (_label, issued, nowMs, future, old) => {
    expect(flagsOf(at(issued, nowMs))).toEqual({ issued, issuedInFuture: future, oldFile: old })
  })
})

describe('checkPayload: summary, shown in the UI language, else en, else not at all (record §2.4; W-75)', () => {
  const astral = (n: number) => '\u{1F600}'.repeat(n)
  const summaryOf = (summary: unknown, uiLanguage = 'en') => accepted(check({ summary }, { ...WIN, uiLanguage })).summary

  it.each<[string, unknown, string, string | null]>([
    ['absent', undefined, 'en', null],
    ['not an object: a string', 'Fixes.', 'en', null],
    ['not an object: a list', ['Fixes.'], 'en', null],
    ['not an object: null', null, 'en', null],
    ['en, in en', { en: 'Fixes.' }, 'en', 'Fixes.'],
    ['de and en, in de', { en: 'Fixes.', de: 'Behebt.' }, 'de', 'Behebt.'],
    ['only en, in de: the fallback', { en: 'Fixes.' }, 'de', 'Fixes.'],
    ['an unknown language only, in de', { xx: 'Fixes.' }, 'de', null],
    ['a key in another case', { EN: 'Fixes.' }, 'en', null],
    ['400 code points with astral characters (800 UTF-16 units): shown', { en: astral(400) }, 'en', astral(400)],
    ['400 code points of one-unit characters', { en: 'a'.repeat(400) }, 'en', 'a'.repeat(400)],
    ['one code point', { en: '\u{1F600}' }, 'en', '\u{1F600}'],
    ['401 code points in de: ignored, en shown', { de: astral(401), en: 'Fixes.' }, 'de', 'Fixes.'],
    ['401 in en: none', { en: 'a'.repeat(401) }, 'en', null],
    ['401 in de and in en: none', { de: 'a'.repeat(401), en: astral(401) }, 'de', null],
    ['a lone surrogate in de: ignored, en shown', { de: 'Beh\u{D800}ebt.', en: 'Fixes.' }, 'de', 'Fixes.'],
    ['a lone surrogate in en: none', { en: 'Fixes\u{DC00}.' }, 'en', null],
    ['empty in de: en shown', { de: '', en: 'Fixes.' }, 'de', 'Fixes.'],
    ['a number in de: en shown', { de: 1, en: 'Fixes.' }, 'de', 'Fixes.'],
    ['an object in en: none', { en: { text: 'Fixes.' } }, 'en', null]
  ])('%s', (_label, summary, uiLanguage, shown) => {
    expect(summaryOf(summary, uiLanguage)).toBe(shown)
  })

  it('summaryText (P5\u{2019}s writer imports it) is the same reading, and the bound is 400 code points', () => {
    expect(SUMMARY_MAX_CODE_POINTS).toBe(400)
    expect(summaryText({ de: astral(400), en: 'x' }, 'de')).toBe(astral(400))
    expect(summaryText({ de: astral(401), en: 'x' }, 'de')).toBe('x')
    expect(summaryText('x', 'en')).toBeNull()
  })
})

describe('checkPayload: files[] (record §2.4, §4.3, §4.4)', () => {
  const entry = (fields: Record<string, unknown>): Record<string, unknown> => ({ name: 'member.bin', size: 1, sha256: sha('member'), ...fields })
  const filesOf = (files: unknown) => accepted(check({ files })).files
  const named = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `m${i}`, size: 0, sha256: sha('x') }))

  it('0 entries, and 4,096: accepted; 4,097: UPD-TOO-NEW', () => {
    expect(FILES_MAX_ENTRIES).toBe(4096)
    expect(filesOf([])).toEqual([])
    expect(filesOf(named(4096)).length).toBe(4096)
    expect(run({ files: named(4097) })).toEqual(TOO_NEW())
  })

  it('carries the entries in payload order, sha256 lower-cased, group and installAs or null', () => {
    expect(filesOf([START, EXE, APPLY])).toEqual([START_OUT, EXE_OUT, APPLY_OUT])
  })

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['an object', { 0: APPLY }],
    ['a string', 'apply.cmd'],
    ['null', null]
  ])('files %s: UPD-TOO-NEW', (_label, files) => {
    expect(run({ files })).toEqual(TOO_NEW())
  })

  it.each<[string, unknown, number]>([
    ['0', 0, 0],
    ['8,589,934,591 (the ustar bound)', MEMBER_SIZE_MAX, 8_589_934_591],
    ['1e3', raw('1e3'), 1000],
    ['1.0', raw('1.0'), 1]
  ])('size %s: accepted', (_label, size, value) => {
    expect(MEMBER_SIZE_MAX).toBe(8_589_934_591)
    expect(filesOf([entry({ size })])[0]!.size).toBe(value)
  })

  it('size -0: the value JSON.parse gives is a safe integer in range, accepted', () => {
    expect(run({ files: [entry({ size: raw('-0') })] })).toBe('accepted')
  })

  // T4.5's review, m-6: a reader in another language gives 0 for the text -0, and so does staged.txt (CF-50); the
  // accepted payload and §5.9's reading carry +0, never -0 (the record's §4.3: "-0 is 0").
  it('size -0 is carried as 0 by the import and by readPayloadFiles alike', () => {
    const text = payloadText({ files: [entry({ size: raw('-0') })] })
    expect(text).toContain('"size":-0,')
    expect(Object.is(JSON.parse('-0'), -0), 'JSON.parse gives -0 for the text -0').toBe(true)
    const env = verified(text)
    const sign = (size: number | undefined): string => (Object.is(size, 0) ? '+0' : Object.is(size, -0) ? '-0' : String(size))
    const carried = { checkPayload: sign(accepted(checkPayload(env, WIN)).files[0]!.size), readPayloadFiles: sign(readPayloadFiles(env)?.[0]?.size) }
    expect(carried).toEqual({ checkPayload: '+0', readPayloadFiles: '+0' })
  })

  it.each<[string, unknown]>([
    ['-1', -1],
    ['8,589,934,592', 8_589_934_592],
    ['1.5', raw('1.5')],
    ['the string "1"', '1'],
    ['null', null],
    ['missing', undefined]
  ])('size %s: UPD-TOO-NEW', (_label, size) => {
    expect(run({ files: [entry({ size })] })).toEqual(TOO_NEW())
  })

  it.each<[string, string, string]>([
    ['lower case', sha('member'), sha('member')],
    ['upper case, lower-cased', sha('member').toUpperCase(), sha('member')],
    ['mixed case, lower-cased', sha('member').slice(0, 32).toUpperCase() + sha('member').slice(32), sha('member')]
  ])('sha256 in %s: accepted', (_label, value, out) => {
    expect(filesOf([entry({ sha256: value })])[0]!.sha256).toBe(out)
  })

  it.each<[string, unknown]>([
    ['63 characters', sha('member').slice(1)],
    ['65 characters', sha('member') + '0'],
    ['a non-hex character', 'g' + sha('member').slice(1)],
    ['a space inside', sha('member').slice(0, 63) + ' '],
    ['a list holding 64 hex characters', [sha('member')]],
    ['a number', 1],
    ['missing', undefined]
  ])('sha256 %s: UPD-TOO-NEW', (_label, sha256) => {
    expect(run({ files: [entry({ sha256 })] })).toEqual(TOO_NEW())
  })

  it.each<[string, unknown, string | null]>([
    ['absent: a required member', undefined, null],
    ['a label', 'win32', 'win32'],
    ['one space (a string of at least one character, never interpreted)', ' ', ' ']
  ])('group %s', (_label, group, out) => {
    expect(filesOf([entry({ group })])[0]!.group).toBe(out)
  })

  it.each<[string, unknown]>([
    ['empty', ''],
    ['null', null],
    ['a number', 1],
    ['an object', {}],
    ['a list', ['win32']],
    ['a boolean', false]
  ])('group %s: UPD-TOO-NEW', (_label, group) => {
    expect(run({ files: [entry({ group })] })).toEqual(TOO_NEW())
  })

  it.each<[string, unknown, string | null]>([
    ['a root name with a space', 'Start HilbertRaum.cmd', 'Start HilbertRaum.cmd'],
    ['empty (a string)', '', ''],
    ['a path (never used as one)', '../x', '../x'],
    ['null', null, null],
    ['a number', 1, null],
    ['an object', { name: 'x' }, null],
    ['absent', undefined, null]
  ])('install_as %s: never a refusal', (_label, installAs, out) => {
    expect(filesOf([entry({ install_as: installAs })])[0]!.installAs).toBe(out)
  })

  it.each<[string, unknown]>([
    ['a string', 'app'],
    ['a number', 7],
    ['null', null],
    ['an object', { kind: 'x' }]
  ])('role %s: never read', (_label, role) => {
    expect(run({ files: [entry({ role })] })).toBe('accepted')
  })

  it.each<[string, unknown]>([
    ['a space', 'Start HilbertRaum.cmd'],
    ['a leading hyphen', '-rf'],
    ['a device name', 'NUL.txt'],
    ['member 0\u{2019}s name', 'hilbertraum-release.dsse.json'],
    ['100 bytes', 'a'.repeat(100)],
    ['a number', 1],
    ['missing', undefined]
  ])('a name that breaks the member-name rule (%s): UPD-TOO-NEW', (_label, name) => {
    expect(run({ files: [entry({ name })] })).toEqual(TOO_NEW())
  })

  it.each<[string, unknown[]]>([
    ['two names equal after folding', [entry({ name: 'Apply.cmd' }), entry({ name: 'apply.CMD' })]],
    ['the same name twice', [entry({ name: 'apply.cmd' }), entry({ name: 'apply.cmd' })]],
    ['an entry that is no object', [entry({}), 'apply.cmd']],
    ['a null entry', [null]],
    ['a list entry', [['apply.cmd', 1, sha('x')]]]
  ])('%s: UPD-TOO-NEW', (_label, files) => {
    expect(run({ files })).toEqual(TOO_NEW())
  })
})

// Two failing checks in one payload: the earlier one in §4.5's order decides (format → product → kind → channel →
// version → min_upgrade_from → the version rule → updates.max_version → requires → issued → files[]).
describe('checkPayload: the check order (record §4.5)', () => {
  const STALE: PayloadInput = { ...WIN, driveAppVersion: '1.4.0', rootApps: [] }
  it.each<[string, Record<string, unknown>, PayloadInput, unknown]>([
    ['format before product', { format: 2, product: 'other' }, WIN, TOO_NEW()],
    ['product before kind', { product: 'other', kind: 'model-pack' }, WIN, NOT_AN_UPDATE],
    ['kind before channel', { kind: 'model-pack', channel: 'beta' }, WIN, FOR_NEWER()],
    ['channel before version', { channel: 'beta', version: 'garbled' }, WIN, WRONG_CHANNEL],
    ['version before min_upgrade_from', { version: 'garbled', min_upgrade_from: '9.0.0' }, WIN, TOO_NEW()],
    ['min_upgrade_from above before the version rule', { version: '1.0.0', min_upgrade_from: '9.0.0' }, WIN, NEEDS('9.0.0')],
    ['min_upgrade_from garbled before the version rule', { version: '1.0.0', min_upgrade_from: null }, WIN, TOO_NEW()],
    ['the version rule before the cap', { version: '1.0.0' }, { ...WIN, maxVersion: v('0.9.0') }, SAME_OR_OLDER('1.0.0')],
    ['the version rule before requires', { version: '1.0.0', requires: { linux: '2.x' } }, WIN, SAME_OR_OLDER('1.0.0')],
    ['the version rule before files[]', { version: '1.0.0', files: undefined }, WIN, SAME_OR_OLDER('1.0.0')],
    ['the cap before requires', { requires: { linux: '2.x' } }, { ...WIN, maxVersion: v('1.0.5') }, ABOVE_MAX('1.1.0', '1.0.5')],
    ['the cap before files[]', { files: undefined }, { ...WIN, maxVersion: v('1.0.5') }, ABOVE_MAX('1.1.0', '1.0.5')],
    ['requires (linux form) before files[]', { requires: { linux: '2.x' }, files: undefined }, WIN, CANT_CHECK()],
    ['this system\u{2019}s floor before files[]', { requires: { win32: '99' }, files: undefined }, WIN, OS_TOO_OLD('win32', '99', '10.0.26300')],
    ['an unreadable host glibc before files[]', { requires: { linux: '2.0' }, files: undefined }, { ...LINUX, glibc: null }, CANT_CHECK()],
    ['issued never refuses: files[] decides', { issued: 'garbled', files: undefined }, WIN, TOO_NEW()]
  ])('%s', (_label, fields, host, want) => {
    expect(run(fields, host)).toEqual(want)
  })

  it.each<[string, Record<string, unknown>, PayloadInput, string, boolean]>([
    ['a refusal before the version rule (format) does not carry it', { format: 2 }, STALE, 'UPD-TOO-NEW', false],
    ['nor one by kind', { kind: 'model-pack' }, STALE, 'UPD-FOR-NEWER-HILBERTRAUM', false],
    ['nor one by min_upgrade_from', { min_upgrade_from: '9.0.0' }, STALE, 'UPD-NEEDS-IN-BETWEEN', false],
    ['the version rule\u{2019}s own refusal carries it', { version: '0.9.0' }, STALE, 'UPD-SAME-OR-OLDER', true],
    ['a refusal by the cap carries it', {}, { ...STALE, maxVersion: v('1.0.5') }, 'UPD-ABOVE-MAX-VERSION', true],
    ['a refusal by requires carries it', { requires: { linux: '2.x' } }, STALE, 'UPD-CANT-CHECK-LINUX-FLOOR', true],
    // The other three refusals of requires, one per return (T4.2 review 1, M-1): no object, a win32 or darwin floor that
    // breaks the grammar, an unreadable host glibc with a linux floor named.
    ['a refusal by a requires that is no object carries it', { requires: [] }, STALE, 'UPD-TOO-NEW', true],
    ['a refusal by a win32 floor that breaks the grammar carries it', { requires: { win32: '10.x' } }, STALE, 'UPD-TOO-NEW', true],
    ['a refusal by an unreadable host glibc, a linux floor named, carries it', { requires: { linux: '2.0' } }, { ...LINUX, driveAppVersion: '1.4.0', rootApps: [], glibc: null }, 'UPD-CANT-CHECK-LINUX-FLOOR', true],
    ['a refusal by files[] carries it', { files: undefined }, STALE, 'UPD-TOO-NEW', true],
    ['a refusal by files[] with a drive version that counts: false', { files: undefined }, { ...STALE, driveAppVersion: '1.0.0', rootApps: null }, 'UPD-TOO-NEW', false]
  ])('staleDriveVersion on a refusal: %s', (_label, fields, host, code, stale) => {
    const r = check(fields, host)
    expect(r.accepted ? 'accepted' : { code: r.refusal.code, staleDriveVersion: r.staleDriveVersion }).toEqual({ code, staleDriveVersion: stale })
  })

  it('staleDriveVersion with an accepted payload: set when the drive version is stale, else not', () => {
    expect(accepted(check({}, STALE)).flags.staleDriveVersion).toBe(true)
    expect(accepted(check({}, { ...STALE, driveAppVersion: null })).flags.staleDriveVersion).toBe(false)
  })
})

// The six codes of the address set each carry the running version as written, so P6 builds <address>/from/<version>
// (record §2.10). UPD-UNKNOWN-SIGNER is the envelope's (updates-envelope.test.ts); the other five are the payload's.
describe('checkPayload: the address set carries the running version as written (record §2.10; Δ-75 row 7)', () => {
  const R = '1.0.0-rc.1+build.5'
  const host = { ...WIN, runningVersion: v(R) }
  it.each<[string, Record<string, unknown>, PayloadInput, unknown]>([
    ['UPD-TOO-NEW', { format: 2 }, host, TOO_NEW(R)],
    ['UPD-NEEDS-IN-BETWEEN', { min_upgrade_from: '1.0.1' }, host, NEEDS('1.0.1', R)],
    ['UPD-FOR-NEWER-HILBERTRAUM', { kind: 'model-pack' }, host, FOR_NEWER(R)],
    ['UPD-OS-TOO-OLD', { requires: { win32: '11' } }, host, OS_TOO_OLD('win32', '11', '10.0.26300', R)],
    ['UPD-CANT-CHECK-LINUX-FLOOR', { requires: { linux: '2.x' } }, host, CANT_CHECK(R)],
    ['UPD-SAME-OR-OLDER (not an address code, its version parameters as written)', { version: '1.0.0-rc.1+other' }, host, SAME_OR_OLDER('1.0.0-rc.1+other', null, R)]
  ])('%s', (_label, fields, h, want) => {
    expect(run(fields, h)).toEqual(want)
  })
})

describe('checkPayload: an accepted payload (record §2.10), with the root apps as rootApps lists them', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('carries version, issued, the summary shown, files[] and the four flags', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-updates-payload-'))
    roots.push(root)
    writeFileSync(join(root, 'HilbertRaum-1.0.0-portable.exe'), '')
    writeFileSync(join(root, 'HilbertRaum-1.0.0.AppImage'), '')
    writeFileSync(join(root, 'READ ME FIRST.txt'), '')
    mkdirSync(join(root, 'HilbertRaum.app'))
    const apps: RootApp[] = rootApps(root)
    const host: PayloadInput = { ...WIN, driveAppVersion: '1.0.0', rootApps: apps, now: Date.parse('2028-03-01T00:00:00Z'), uiLanguage: 'de' }
    const r = check({ requires: { win32: '10.0', darwin: '13.0', linux: '2.31' }, summary: { en: 'Fixes.', de: 'Behebt.' } }, host)
    expect(r).toEqual({
      accepted: true,
      payload: {
        version: '1.1.0',
        issued: '2027-01-10T08:00:00Z',
        summary: 'Behebt.',
        files: [APPLY_OUT, EXE_OUT, START_OUT],
        flags: {
          otherSystemFloors: [
            { system: 'darwin', floor: '13.0' },
            { system: 'linux', floor: '2.31' }
          ],
          issuedInFuture: false,
          oldFile: true,
          staleDriveVersion: false
        }
      }
    })
  })
})

describe('readPayloadFiles: the support details\u{2019} files[] reading (record §5.9, §2.4\u{2019}s install_as row)', () => {
  it('is the import\u{2019}s files[] reading', () => {
    const env = verified(GOOD)
    expect(readPayloadFiles(env)).toEqual(accepted(checkPayload(env, WIN)).files)
  })

  it.each<[string, Record<string, unknown>]>([
    ['the version rule (the applied version equals the running one)', { version: RUNNING }],
    ['format', { format: 2 }],
    ['channel', { channel: 'beta' }],
    ['requires', { requires: { linux: '2.x' } }]
  ])('runs no other check: %s', (_label, fields) => {
    expect(readPayloadFiles(verified(payloadText(fields)))).toEqual([APPLY_OUT, EXE_OUT, START_OUT])
  })

  it.each<[string, string]>([
    ['no JSON', 'this is no JSON'],
    ['no files[]', payloadText({ files: undefined })],
    ['a files[] entry that breaks §4.3', payloadText({ files: [{ ...APPLY, size: -1 }] })]
  ])('null (support shows "not checked") for %s', (_label, text) => {
    expect(readPayloadFiles(verified(text))).toBeNull()
  })
})

// The min_upgrade_from half of the agreement with appOlderThanMinimum (Δ-75 row 1; the version rule's half is in
// updates-version.test.ts): a running app below `min` must get UPD-NEEDS-IN-BETWEEN exactly when the gates call it
// older than `min`. The reads are written out.
describe('min_upgrade_from agrees with appOlderThanMinimum on every version both read (Δ-75 row 1)', () => {
  const APPS: ReadonlyArray<readonly [string, AppVersionRead]> = [
    ['0.0.9', { core: [0, 0, 9], prerelease: false }],
    ['0.1.65', { core: [0, 1, 65], prerelease: false }],
    ['0.1.66', { core: [0, 1, 66], prerelease: false }],
    ['0.1.100', { core: [0, 1, 100], prerelease: false }],
    ['1.0.0', { core: [1, 0, 0], prerelease: false }],
    ['0.1.66-beta.1', { core: [0, 1, 66], prerelease: true }],
    ['0.1.66+abc', { core: [0, 1, 66], prerelease: false }],
    ['0.1.67-beta.1', { core: [0, 1, 67], prerelease: true }],
    ['1.0.0-rc.1', { core: [1, 0, 0], prerelease: true }],
    ['10.20.30', { core: [10, 20, 30], prerelease: false }]
  ]
  const MINS: ReadonlyArray<readonly [string, VersionCore]> = [
    ['0.0.0', [0, 0, 0]],
    ['0.1.9', [0, 1, 9]],
    ['0.1.10', [0, 1, 10]],
    ['0.1.66', [0, 1, 66]],
    ['0.1.67', [0, 1, 67]],
    ['1.0.0', [1, 0, 0]],
    ['10.20.30', [10, 20, 30]]
  ]
  it('UPD-NEEDS-IN-BETWEEN exactly when the app is older than the minimum', () => {
    for (const [app, read] of APPS) {
      for (const [min, core] of MINS) {
        const got = run({ version: '999.0.0', min_upgrade_from: min }, { ...WIN, runningVersion: v(app) })
        expect(got, `running ${app}, min_upgrade_from ${min}`).toEqual(appOlderThanMinimum(read, core) ? NEEDS(min, app) : 'accepted')
      }
    }
  })
})

describe('the running version the payload check is given (the T4.2 sheet\u{2019}s Q2)', () => {
  it("apps/desktop/package.json's version is a release version, so it parses as the running version", () => {
    const { version } = JSON.parse(repoText('apps', 'desktop', 'package.json')) as { version: unknown }
    expect(isReleaseVersion(version)).toBe(true)
  })
})

// ---- The golden vectors of F-1, F-2 and F-4 (record §10.7): public keys, envelopes and the verdict release 1 gives
// each for ever, written without the verifier (each set's PROVENANCE.md). This runner reads every vectors*.json of the
// sets it lists and routes each vector by its form ("File shape and routing"): one with an `envelope` runs the whole
// pipeline (verifyEnvelope, then checkPayload with the version rule inside it), whatever its stage; one with `version`
// and no `envelope` runs the version rule alone. The whole `expect` is compared, `stage` included. A vector that
// disagrees with the code is never edited (the T4.2 sheet's Q5): the record decides which side is wrong.

/**
 * The sets this runner reads. The set reader (tests/helpers/update-vectors.ts) lists every vectors*.json of a set in
 * name order (§10.7: a test reads every one; a bare JSON array each), builds each envelope's bytes, guards each
 * vector's form, and throws, so this file fails, when a listed set does not exist or holds no vector.
 */
const VECTOR_SETS = ['negative', 'positive']

const VECTOR_FILES = VECTOR_SETS.flatMap((set) => vectorSetFiles(set))
const ALL_VECTORS = VECTOR_FILES.flatMap((f) => f.vectors.map((vector) => ({ ...f, vector })))
const ENVELOPE_FORM = ALL_VECTORS.filter((x) => 'envelope' in x.vector)
const VERSION_FORM = ALL_VECTORS.filter((x) => !('envelope' in x.vector) && 'version' in x.vector)

/** The vector's key set: each SPKI loaded, its id computed from it (§2.7), never read from the vector. */
function vectorKeys(keys: readonly string[]): UpdateKey[] {
  return keys.map((spki) => {
    const der = Buffer.from(spki, 'base64')
    return { id: createHash('sha256').update(der).digest('hex'), key: createPublicKey({ key: der, format: 'der', type: 'spki' }) }
  })
}

const UTC_SECONDS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/

/** §10.7's `host` as the payload check's input: the versions parsed, `now` in milliseconds, the rest as given. */
function vectorInput(h: Record<string, unknown>): PayloadInput {
  expect(typeof h.now === 'string' && UTC_SECONDS.test(h.now), `now ${String(h.now)}`).toBe(true)
  return {
    runningVersion: v(h.runningVersion as string),
    driveAppVersion: h.driveAppVersion as string | null,
    rootApps: h.rootApps as RootApp[] | null,
    maxVersion: h.maxVersion === null ? null : v(h.maxVersion as string),
    os: h.os,
    osVersion: h.osVersion,
    glibc: h.glibc,
    now: Date.parse(h.now as string),
    uiLanguage: h.uiLanguage as string
  } as PayloadInput
}

const NO_FLAGS = { staleDriveVersion: false, issuedInFuture: false, oldFile: false, otherSystemFloors: [] }

describe('the golden vectors: every set this runner lists exists, and every vector has one form (record §10.7)', () => {
  it.each(VECTOR_SETS)('set %s holds at least one vectors*.json, each with at least one vector', (set) => {
    const files = VECTOR_FILES.filter((f) => f.set === set)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(f.vectors.length, `${set}/${f.file}`).toBeGreaterThan(0)
  })

  it('each vector is exactly one of the two forms, with its stage and host as the schema says, and its id unique', () => {
    expect(ENVELOPE_FORM.length + VERSION_FORM.length).toBe(ALL_VECTORS.length)
    for (const { set, file, vector } of ALL_VECTORS) {
      const where = `${set}/${file} ${vector.id}`
      const form = 'envelope' in vector
      expect(form ? !('version' in vector) && Array.isArray(vector.keys) : 'version' in vector && !('keys' in vector), where).toBe(true)
      expect(Object.keys(vector.host).sort(), where).toEqual(
        form ? ['driveAppVersion', 'glibc', 'maxVersion', 'now', 'os', 'osVersion', 'rootApps', 'runningVersion', 'uiLanguage'] : ['driveAppVersion', 'rootApps', 'runningVersion']
      )
      expect(form ? ['envelope', 'payload', 'version-rule'] : ['version-rule'], where).toContain(vector.expect.stage)
    }
    for (const set of VECTOR_SETS) {
      const ids = ALL_VECTORS.filter((x) => x.set === set).map((x) => x.vector.id)
      expect(new Set(ids).size, set).toBe(ids.length)
    }
  })
})

describe('the golden vectors with an envelope: verifyEnvelope, then checkPayload (record §10.7)', () => {
  it.each(ENVELOPE_FORM.map((x) => [`${x.set}/${x.file}`, x.vector.id, x.vector] as const))('%s %s', (_file, _id, vector) => {
    const host = vector.host
    const r = verifyEnvelope(envelopeBytes(vector.envelope!), vectorKeys(vector.keys!), host.runningVersion as string)
    let got: Record<string, unknown>
    if (!r.verified) {
      got = { stage: 'envelope', code: r.refusal.code, params: r.refusal.params, flags: NO_FLAGS }
    } else {
      const p = checkPayload(r, vectorInput(host))
      if (!p.accepted) {
        const stage = p.refusal.code === 'UPD-SAME-OR-OLDER' ? 'version-rule' : 'payload'
        got = { stage, code: p.refusal.code, params: p.refusal.params, flags: { ...NO_FLAGS, staleDriveVersion: p.staleDriveVersion } }
      } else {
        const { flags, ...fields } = p.payload
        got = { stage: 'payload', code: 'accepted', params: {}, flags, ...fields }
        // §5.9's reading of the same envelope is the import's files[] (R-P12).
        expect(readPayloadFiles(r), 'readPayloadFiles').toStrictEqual(fields.files)
      }
    }
    expect(got).toStrictEqual(vector.expect)
  })
})

describe('the golden vectors of the version rule alone (record §10.7, §2.5)', () => {
  it.each(VERSION_FORM.map((x) => [`${x.set}/${x.file}`, x.vector.id, x.vector] as const))('%s %s', (_file, _id, vector) => {
    const host = vector.host
    const r = checkVersionRule(v(vector.version!), v(host.runningVersion as string), host.driveAppVersion as string | null, host.rootApps as RootApp[] | null)
    const got = r.accepted
      ? { stage: 'version-rule', code: 'accepted', params: {}, flags: { ...NO_FLAGS, staleDriveVersion: r.staleDriveVersion } }
      : { stage: 'version-rule', code: r.refusal.code, params: r.refusal.params, flags: { ...NO_FLAGS, staleDriveVersion: r.staleDriveVersion } }
    expect(got).toStrictEqual(vector.expect)
  })
})

// The release tools (P5's check-draft, W-53's reader snapshot) load payload.ts through Node's own type stripping with
// P3's sibling-import hook (Δ-75 row 4), and run it on the owner's computer, not a Kit: so it reads no host value
// itself (every one is an argument) and imports only its siblings. The load row runs it so; the source row holds the
// two rules the load cannot see.
describe('payload.ts loads under Node type stripping, and reads no host value itself', () => {
  it('a plain node process with the hook loads it and checks a payload', () => {
    const url = (...p: string[]) => JSON.stringify(pathToFileURL(join(...p)).href)
    const script = [
      `const { registerTsSiblingImports } = await import(${url(REPO_ROOT, 'scripts', 'lib', 'ts-sibling-imports.mjs')})`,
      'registerTsSiblingImports()',
      `const m = await import(${url(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'payload.ts')})`,
      `const { parseSemver } = await import(${url(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'version.ts')})`,
      `const env = { verified: true, payload: Buffer.from(${JSON.stringify(GOOD)}) }`,
      "const host = { runningVersion: parseSemver('1.0.0'), driveAppVersion: null, rootApps: [], maxVersion: null, os: 'linux', osVersion: null, glibc: '2.39', now: 0, uiLanguage: 'en' }",
      "console.log(JSON.stringify([m.checkPayload(env, host).accepted, m.checkPayload(env, { ...host, maxVersion: parseSemver('1.0.5') }).refusal.code, m.readPayloadFiles(env).length]))"
    ].join('\n')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: testBudgetMs(60_000)
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('[true,"UPD-ABOVE-MAX-VERSION",3]')
  })

  it('imports only its siblings (no @shared alias, no JSON, no electron) and names no process. or Date clock', () => {
    const source = readFileSync(join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'payload.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const imports = [...code.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)].map((m) => ({ type: m[1] !== undefined, from: m[2]! }))
    expect(imports.length).toBeGreaterThan(0)
    const values = imports.filter((i) => !i.type).map((i) => i.from)
    expect(values.filter((from) => !['./envelope', './version', './member-name', './drive-release'].includes(from))).toEqual([])
    expect(imports.map((i) => i.from).filter((from) => from.startsWith('@') || from.endsWith('.json') || from === 'electron')).toEqual([])
    expect(code).not.toMatch(/\bprocess\s*\.|\bDate\s*\.\s*now\b|\bnew\s+Date\b/)
  })
})
