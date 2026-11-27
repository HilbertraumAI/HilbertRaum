import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
// The root globs (`rootArtifactOf`) are not this rule: drive-release.test.ts holds them. Non-ASCII test strings are
// written as `\u{…}` escapes.

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
