import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NODE_STAGING_FS, planSweep } from '../../src/main/services/updates/staging'
import { rootArtifactOf, type RootArtifact, type RootEntryKind } from '../../src/main/services/updates/drive-release'
import {
  ENVELOPE_MEMBER_NAME,
  MEMBER_NAME_MAX_BYTES,
  foldMemberName,
  hasFoldedDuplicate,
  isMemberName
} from '../../src/main/services/updates/member-name'
import { DESKTOP_ROOT, REPO_ROOT } from '../helpers/repo-files'
import { testBudgetMs } from '../helpers/hang-budget'

// The update file's member names (app-update F-18's name half, frozen with F-2 in P4; Δ-75 row 14; CF-45): table A.3
// of docs/app-updates.md §4.4, row by row. Release 1 applies the rule to every name in a signed payload's `files[]`
// (a name that breaks it is UPD-TOO-NEW, §4.4 "A name that breaks the rule"; the payload's rows are in
// updates-payload.test.ts) and, from P6 on, to every header name and to `staged.json` (P6 adds its staging rows here).
// The root globs (`rootArtifactOf`) are not this rule: drive-release.test.ts holds their names, and the case rule and the
// star per system are F-18's root-glob half (their rows below, T6.2 part 1b, T6.9). Non-ASCII test strings are written as
// `\u{…}` escapes.

describe('isMemberName: the characters (table A.3, "Characters")', () => {
  it.each([
    'apply.cmd',
    'apply.sh',
    'HilbertRaum-1.1.0-portable.exe',
    'HilbertRaum-1.1.0-mac-arm64.app.zip',
    'HilbertRaum-1.1.0.AppImage',
    'Start-HilbertRaum.cmd',
    'a',
    'Z',
    '0',
    'x.y-z_9',
    'A0._-z'
  ])('accepts %j', (name) => {
    expect(isMemberName(name)).toBe(true)
  })

  it.each([
    ['a space', 'Start HilbertRaum.cmd'],
    ['a plus', 'HilbertRaum-1.1.0+b-portable.exe'],
    ['a slash', 'runtime/llama.dll'],
    ['a backslash', 'runtime\\llama.dll'],
    ['a colon', 'C:apply.cmd'],
    ['a tab', 'apply\tcmd'],
    ['a NUL', 'apply\u{0}.cmd'],
    ['a line break', 'apply.cmd\n'],
    ['the Kelvin sign U+212A (not the letter k)', 'a\u{212A}it.zip'],
    ['an e with an acute accent', 'caf\u{E9}.txt'],
    ['a full-width digit', 'v\u{FF11}.bin'],
    ['an asterisk', 'apply*.cmd'],
    ['a quote', 'a"b'],
    ['a percent sign', 'a%TEMP%.cmd'],
    ['a dollar sign', 'x$y.sh']
  ])('refuses a name with %s (after a legal first character)', (_label, name) => {
    expect(/^[A-Za-z0-9]/.test(name)).toBe(true)
    expect(isMemberName(name)).toBe(false)
  })

  it.each<[string, unknown]>([
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['a list holding a legal name', ['apply.cmd']]
  ])('refuses a value that is not a string: %s', (_label, value) => {
    expect(isMemberName(value)).toBe(false)
  })
})

describe('isMemberName: 1 to 99 bytes (table A.3, "Length")', () => {
  it('the bound is the ustar name field with its NUL', () => {
    expect(MEMBER_NAME_MAX_BYTES).toBe(99)
  })

  it.each([
    ['1 byte', 'a', true],
    ['99 bytes', 'a'.repeat(99), true],
    ['99 bytes with an extension', 'a'.repeat(95) + '.exe', true],
    ['100 bytes', 'a'.repeat(100), false],
    ['100 bytes with an extension', 'a'.repeat(96) + '.exe', false],
    ['0 bytes', '', false]
  ])('%s: %s', (_label, name, legal) => {
    expect(isMemberName(name)).toBe(legal)
  })
})

describe('isMemberName: the first and the last character (table A.3)', () => {
  it.each([
    ['a leading hyphen (an option to the scripts)', '-rf', false],
    ['a leading dot (a hidden file; the staging folder\u{2019}s own dot names)', '.incoming-1.1.0', false],
    ['a leading underscore', '_apply.cmd', false],
    ['a trailing dot', 'apply.', false],
    ['two trailing dots', 'apply..', false],
    ['a lone dot', '.', false],
    ['a trailing hyphen', 'apply-', true],
    ['a trailing underscore', 'apply_', true],
    ['a digit first', '7z.exe', true],
    ['a dot inside', 'a.b.c', true],
    ['two dots inside', 'a..b', true]
  ])('%s: %j is %s', (_label, name, legal) => {
    expect(isMemberName(name)).toBe(legal)
  })
})

describe('isMemberName: the reserved names, compared case-folded (table A.3, "Reserved names")', () => {
  it.each([
    'con',
    'prn',
    'aux',
    'nul',
    'CON',
    'Nul',
    'com0',
    'com1',
    'com9',
    'COM5',
    'lpt0',
    'lpt9',
    'LPT1',
    'nul.txt',
    'NUL.txt',
    'nul.tar.gz',
    'Con.Cmd',
    'prn..txt',
    'com1.log',
    'lpt9.x'
  ])('refuses the Windows device name %j', (name) => {
    expect(isMemberName(name)).toBe(false)
  })

  it.each(['com10', 'lpt10', 'con-x', 'console', 'nul_', 'xcon', 'auxiliary.txt', 'comx', 'lpt', 'com', 'prn1', 'con_.txt'])(
    'accepts %j: a device name only alone or before a dot',
    (name) => {
      expect(isMemberName(name)).toBe(true)
    }
  )

  it.each(['hilbertraum-release.dsse.json', 'HilbertRaum-Release.DSSE.json', 'HILBERTRAUM-RELEASE.DSSE.JSON'])(
    'refuses member 0\u{2019}s name %j anywhere else',
    (name) => {
      expect(ENVELOPE_MEMBER_NAME).toBe('hilbertraum-release.dsse.json')
      expect(isMemberName(name)).toBe(false)
    }
  )

  it.each(['hilbertraum-release.dsse.json.bak', 'x-hilbertraum-release.dsse.json', 'hilbertraum-release.dsse', 'staged.json', 'staged.txt', 'files'])(
    'accepts %j: only the exact names are reserved (a member lives one level down, in files/)',
    (name) => {
      expect(isMemberName(name)).toBe(true)
    }
  )
})

describe('foldMemberName and hasFoldedDuplicate: A to Z only (table A.3, "Uniqueness")', () => {
  it.each([
    ['ABCXYZ-09._abcxyz', 'abcxyz-09._abcxyz'],
    ['HilbertRaum-1.1.0-portable.exe', 'hilbertraum-1.1.0-portable.exe'],
    ['\u{212A}', '\u{212A}'],
    ['\u{130}', '\u{130}'],
    ['\u{C9}', '\u{C9}'],
    ['@[`{', '@[`{']
  ])('folds %j to %j (ASCII only, never a locale)', (name, folded) => {
    expect(foldMemberName(name)).toBe(folded)
  })

  it.each<[string, string[], boolean]>([
    ['two names that differ in case only', ['Apply.cmd', 'apply.CMD'], true],
    ['the same name twice', ['apply.cmd', 'apply.cmd'], true],
    ['a duplicate after other names', ['a', 'b', 'c', 'B'], true],
    ['different names', ['apply.cmd', 'apply.sh'], false],
    ['the Kelvin sign and k (not folded together)', ['\u{212A}', 'k'], false],
    ['a dotless i and i', ['\u{131}', 'i'], false]
  ])('%s: %s', (_label, names, duplicate) => {
    expect(hasFoldedDuplicate(names)).toBe(duplicate)
  })
})

// P6's staging rows (T6.2, CF-45): staging imports the rule, never copies it. A `staged.json` is valid only when every
// `files` name keeps table A.3 and no two are equal after the fold (record §4.6 "Valid"); one that breaks either is not
// valid, and the start-up sweep removes its folder (`invalid-marker`). Read through the sweep's own reads on a scratch
// drive, so the row holds what a start does with the marker, not a helper's answer.
describe('staging applies the rule to staged.json (record §4.6 "Valid"; CF-45)', () => {
  const NOTES = Buffer.alloc(512, 0x6e)
  const NOTES_SHA = createHash('sha256').update(NOTES).digest('hex')

  /** The sweep's reading of `updates/staging/1.1.0/` whose staged.json lists `names` (each present in files/ when `present`). */
  async function sweepOf(names: readonly string[], present: boolean): Promise<{ staged: string | null; invalid: number }> {
    const root = mkdtempSync(join(tmpdir(), 'hr-updates-artifact-names-'))
    const dir = join(root, 'updates', 'staging', '1.1.0')
    mkdirSync(join(dir, 'files'), { recursive: true })
    if (present) for (const name of names) writeFileSync(join(dir, 'files', name), NOTES)
    writeFileSync(join(dir, 'staged.json'), JSON.stringify({ format: 1, version: '1.1.0', files: names.map((name) => ({ name, size: 512, sha256: NOTES_SHA })) }))
    const plan = await planSweep({ root, platform: process.platform, fs: NODE_STAGING_FS }, join(root, 'updates'))
    return { staged: plan.staged?.version ?? null, invalid: plan.counts['invalid-marker'] }
  }

  it.each([
    ['a device name', ['nul.txt']],
    ['a device name alone, in upper case', ['CON']],
    ['member 0\u{2019}s name, in another case', ['Hilbertraum-Release.dsse.json']],
    ['a leading dot', ['.incoming-1.1.0']],
    ['a separator', ['files/notes.txt']],
    ['a step up', ['../notes.txt']],
    ['a space', ['Start HilbertRaum.cmd']],
    ['a trailing dot', ['notes.']],
    ['100 bytes', ['a'.repeat(100)]],
    ['two names equal after the fold', ['notes.txt', 'NOTES.txt']]
  ])('a staged.json listing %s is not valid (invalid-marker)', async (_label, names) => {
    expect(await sweepOf(names, false)).toEqual({ staged: null, invalid: 1 })
  })

  it.each([
    ['staged.json, a legal member name one level down in files/', ['staged.json']],
    ['files', ['files']],
    ['a start file\u{2019}s member name', ['Start-HilbertRaum.cmd']],
    ['99 bytes', ['a'.repeat(99)]],
    ['two names that differ after the fold', ['notes.txt', 'notes.txt.bak']]
  ])('a staged.json listing %s is valid: the update stays staged', async (_label, names) => {
    expect(await sweepOf(names, true)).toEqual({ staged: '1.1.0', invalid: 0 })
  })
})

// F-18's root-glob half (T6.2 part 1b, CF-33; record §4.4 "The root globs release 1 reads", §5.7 "Which systems have a
// root artifact"): each system's own start file decides the case, so the app counts what that start file would start.
// Windows' `for` glob ignores case on a Kit's file systems: a win32 name is compared after an ASCII fold of the glob's
// fixed parts, and its version segment is taken as written. The macOS and Linux start files are bash globs: their names,
// and a folder's `.app`, byte for byte. The same three shapes per system, so a fold that reaches the wrong system shows.
// (tests/fixtures/readers/f13-drive-release/vectors.json's `artifacts`, run by drive-release.test.ts, hold the helper's
// own names; these rows hold the rule per system.)
describe('the root globs\u{2019} case rule, per system (record §4.4; F-18, CF-33)', () => {
  it.each<[string, string, RootEntryKind, RootArtifact | null]>([
    ['win32, as the glob spells it', 'HilbertRaum-1.4.0-portable.exe', 'file', { system: 'win32', version: '1.4.0' }],
    ['win32, every fixed part in another case', 'hILBERTrAUM-1.4.0-pORTABLE.eXE', 'file', { system: 'win32', version: '1.4.0' }],
    ['win32, the version segment as written', 'hilbertraum-1.4.0-Beta.2+Build.7-portable.exe', 'file', { system: 'win32', version: '1.4.0-Beta.2+Build.7' }],
    ['win32, a segment that is no version as written', 'hilbertraum-V1.4.0-portable.exe', 'file', { system: 'win32', version: null }],
    ['win32, ASCII only: a dotless i (which upper-cases to I) is no i', 'H\u{131}lbertRaum-1.4.0-portable.exe', 'file', null],    ['darwin, as the glob spells it', 'HilbertRaum-1.4.0-mac-arm64.app.zip', 'file', { system: 'darwin', version: '1.4.0' }],
    ['darwin, the prefix in another case', 'hilbertraum-1.4.0-mac-arm64.app.zip', 'file', null],
    ['darwin, the suffix in another case', 'HilbertRaum-1.4.0-MAC-ARM64.APP.ZIP', 'file', null],
    ['darwin, a folder .app', 'Any.app', 'folder', { system: 'darwin', version: null }],
    ['darwin, a folder .APP', 'Any.APP', 'folder', null],
    ['darwin, a folder .App', 'HilbertRaum.App', 'folder', null],
    ['linux, as the glob spells it', 'HilbertRaum-1.4.0.AppImage', 'file', { system: 'linux', version: '1.4.0' }],
    ['linux, the prefix in another case', 'HILBERTRAUM-1.4.0.AppImage', 'file', null],
    ['linux, the suffix in another case', 'HilbertRaum-1.4.0.APPIMAGE', 'file', null]
  ])('%s: %s', (_label, name, kind, artifact) => {
    expect(rootArtifactOf(name, kind)).toStrictEqual(artifact)
  })
})

// The star of each glob (T6.9 lens 1 m-2; record §4.4 "The root globs release 1 reads": "The star matches any characters,
// line ends included (U+000A, U+000D, U+2028, U+2029), as cmd's and bash's `*` do"): the Windows start file's `for` finds
// a name with a line end in the star (measured on NTFS), and bash's `*` matches any character. Each of the four line ends
// in the star of each system's glob, so a star that skips one on one system shows. The segment that holds it is no
// version, so the app counts with no known version.
const LINE_ENDS = [
  ['U+000A', '\u{A}'],
  ['U+000D', '\u{D}'],
  ['U+2028', '\u{2028}'],
  ['U+2029', '\u{2029}']
] as const
describe('the root globs\u{2019} star matches any characters, line ends included, per system (record §4.4; F-18, T6.9 lens 1 m-2)', () => {
  it.each<[string, string, string, RootEntryKind, RootArtifact]>(
    LINE_ENDS.flatMap(([label, end]): Array<[string, string, string, RootEntryKind, RootArtifact]> => [
      ['win32 HilbertRaum-*-portable.exe', label, `HilbertRaum-7.0.0${end}-portable.exe`, 'file', { system: 'win32', version: null }],
      ['darwin HilbertRaum-*-mac-arm64.app.zip', label, `HilbertRaum-7.0.0${end}-mac-arm64.app.zip`, 'file', { system: 'darwin', version: null }],
      ['darwin *.app (a folder)', label, `Any${end}.app`, 'folder', { system: 'darwin', version: null }],
      ['linux HilbertRaum-*.AppImage', label, `HilbertRaum-7.0.0${end}.AppImage`, 'file', { system: 'linux', version: null }]
    ])
  )('%s with %s in the star', (_glob, _label, name, kind, artifact) => {
    expect(rootArtifactOf(name, kind)).toStrictEqual(artifact)
  })
})

// P5's writer and P6's staging load member-name.ts through Node's own type stripping (Δ-75 rows 4, 14): it imports
// nothing at all, so it loads with the sibling-import hook (as the release tools register it) and without it.
describe('member-name.ts loads under Node type stripping', () => {
  it('a plain node process loads it with the sibling-import hook and without it', () => {
    const url = (...p: string[]) => JSON.stringify(pathToFileURL(join(...p)).href)
    const probe = `const m = await import(${url(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'member-name.ts')}); console.log(JSON.stringify([m.isMemberName('apply.cmd'), m.isMemberName('NUL.txt'), m.foldMemberName('ApPly')]))`
    const hook = [`const { registerTsSiblingImports } = await import(${url(REPO_ROOT, 'scripts', 'lib', 'ts-sibling-imports.mjs')})`, 'registerTsSiblingImports()']
    for (const script of [[...hook, probe].join('\n'), probe]) {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: testBudgetMs(60_000)
      })
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.stdout.trim()).toBe('[true,false,"apply"]')
    }
  })
})
