import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hangBudgetMs } from '../helpers/hang-budget'
import { REPO_ROOT } from '../helpers/repo-files'

// #769: scripts/generate-zim-notices.mjs writes one licence notice per ZIM archive on a drive, from what
// `kiwix-manage <library.xml> add <zim>` reads out of it (#339 P8-4). The rows run the real script against a stand-in
// kiwix-manage: a copy of this node binary, which a `--require`d stub turns into kiwix-manage when its executable is
// named so. No shell is involved, as in the script's own spawn, so the same stand-in works on every OS. The stub reads
// each scratch archive as the `<book>` attributes kiwix-manage would report, or `FAIL` for an archive it cannot open.

const SCRIPT = join(REPO_ROOT, 'scripts', 'generate-zim-notices.mjs')

interface Book {
  id: string
  title: string | null
  description: string | null
  language: string | null
  date: string | null
  articleCount: string | null
  mediaCount: string | null
  tags: string | null
}

const STUB = `const { basename } = require('node:path')
if (/^kiwix-manage/i.test(basename(process.execPath)) && process.argv[2] === 'add') {
  const fs = require('node:fs')
  const spec = fs.readFileSync(process.argv[3], 'utf8')
  if (spec === 'FAIL') {
    process.stderr.write('stub: cannot open the archive')
    process.exit(3)
  }
  fs.writeFileSync(process.argv[1], '<library version="20110515">\\n  <book ' + spec + ' />\\n</library>\\n')
  process.exit(0)
}
`

let buildNoticeMd: (book: Book, leaf: string) => string
let toolsDir: string
let stubOptions: string

beforeAll(async () => {
  ;({ buildNoticeMd } = (await import(pathToFileURL(SCRIPT).href)) as { buildNoticeMd: typeof buildNoticeMd })
  const scratch = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-notices-'))
  toolsDir = join(scratch, 'tools')
  mkdirSync(toolsDir)
  const manage = join(toolsDir, process.platform === 'win32' ? 'kiwix-manage.exe' : 'kiwix-manage')
  try {
    linkSync(process.execPath, manage)
  } catch {
    // Another volume, or a binary this user may not link (Program Files, a root-owned node): a copy, made executable.
    copyFileSync(process.execPath, manage)
    chmodSync(manage, 0o755)
  }
  writeFileSync(join(scratch, 'stub.cjs'), STUB)
  // Forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape.
  stubOptions = `--require "${join(scratch, 'stub.cjs').split('\\').join('/')}"`
})

/** A scratch drive root whose zim/ holds these files (name → content). */
function driveWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-drive-'))
  mkdirSync(join(root, 'zim'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'zim', name), content)
  return root
}

function runNotices(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: stubOptions },
    timeout: hangBudgetMs(20_000)
  })
}

const noticesOf = (root: string): string[] =>
  existsSync(join(root, 'zim', 'NOTICES')) ? readdirSync(join(root, 'zim', 'NOTICES')).sort() : []

describe('generate-zim-notices: the notice (#769)', () => {
  const FULL: Book = {
    id: 'c334200f',
    title: 'Klimawandel & Klimaschutz',
    description: 'Artikel rund ums Klima',
    language: 'deu',
    date: '2026-07-01',
    articleCount: '8,245',
    mediaCount: '12',
    tags: 'wikipedia;_ftindex:yes'
  }

  it('states every field the library declares', () => {
    expect(buildNoticeMd(FULL, 'klima.zim').split('\n').slice(0, 12)).toEqual([
      '# Klimawandel & Klimaschutz — knowledge pack notice',
      '',
      '- **Archive file:** klima.zim',
      '- **UUID:** c334200f',
      '- **Language:** deu',
      '- **ZIM date:** 2026-07-01',
      '- **Articles:** 8,245 · **Media:** 12',
      '- **Tags:** wikipedia;_ftindex:yes',
      '',
      '## Description',
      '',
      'Artikel rund ums Klima'
    ])
  })

  it.each([
    ['absent', null],
    ['empty', '']
  ])('falls back for every field the library leaves %s: the file name as title, "not recorded" for the rest', (_label, missing) => {
    const book: Book = { id: 'c334200f', title: missing, description: missing, language: missing, date: missing, articleCount: missing, mediaCount: missing, tags: missing }
    const md = buildNoticeMd(book, 'klima.zim')
    expect(md.split('\n').slice(0, 12)).toEqual([
      '# klima.zim — knowledge pack notice',
      '',
      '- **Archive file:** klima.zim',
      '- **UUID:** c334200f',
      '- **Language:** not recorded',
      '- **ZIM date:** not recorded',
      '- **Articles:** not recorded · **Media:** not recorded',
      '- **Tags:** none recorded',
      '',
      '## Description',
      '',
      '(none recorded)'
    ])
    expect(md).toContain('are NOT knowable offline and are not stated here.')
    expect(md.endsWith('\n')).toBe(true)
  })
})

describe('generate-zim-notices: the command (#769)', () => {
  it('writes zim/NOTICES/<uuid>.md for every archive, an upper-case .ZIM included, and reads nothing else', () => {
    const root = driveWith({
      'a.zim': 'id="u-a" title="Alpha &amp; Co" language="deu"',
      'B.ZIM': 'id="u-b" title="Beta"',
      'notes.txt': 'FAIL'
    })
    const r = runNotices(['--target', root, '--tools-dir', toolsDir])
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect(noticesOf(root)).toEqual(['u-a.md', 'u-b.md'])
    const alpha = readFileSync(join(root, 'zim', 'NOTICES', 'u-a.md'), 'utf8')
    expect(alpha.split('\n').slice(0, 4)).toEqual([
      '# Alpha & Co — knowledge pack notice',
      '',
      '- **Archive file:** a.zim',
      '- **UUID:** u-a'
    ])
    expect(r.stdout).toContain('zim notices: 2/2 archive(s) written')
  })

  it('--dry-run reads every archive and writes nothing', () => {
    const root = driveWith({ 'a.zim': 'id="u-a" title="Alpha"' })
    const r = runNotices(['--target', root, '--tools-dir', toolsDir, '--dry-run'])
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect(r.stdout).toContain('dry-run  a.zim  uuid=u-a')
    expect(noticesOf(root)).toEqual([])
  })

  it('an archive kiwix-manage cannot read exits 1, and the others are still written', () => {
    const root = driveWith({ 'a.zim': 'FAIL', 'b.zim': 'id="u-b" title="Beta"' })
    const r = runNotices(['--target', root, '--tools-dir', toolsDir])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('kiwix-manage failed on a.zim: stub: cannot open the archive')
    expect(noticesOf(root)).toEqual(['u-b.md'])
  })

  it('a drive with no archive exits 0 and writes nothing', () => {
    const root = driveWith({})
    const r = runNotices(['--target', root, '--tools-dir', toolsDir])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('nothing to do')
    expect(noticesOf(root)).toEqual([])
  })

  // #768: the header promises 2 for a usage error; `--target` with no value threw, so it exited 1 with a stack.
  it.each([
    ['--target with no value', ['--target'], '--target needs a value'],
    ['--tools-dir with no value', ['--target', '.', '--tools-dir'], '--tools-dir needs a value'],
    ['an unknown argument', ['--bogus'], 'unknown argument: --bogus'],
    ['a --tools-dir with no kiwix-manage', ['--target', '.', '--tools-dir', join(REPO_ROOT, 'licenses')], 'kiwix-manage not found under']
  ])('%s exits 2 with the message and no stack (#768)', (_title, args, message) => {
    const r = runNotices(args)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(message)
    expect(r.stderr).not.toMatch(/^\s+at /m)
  })
})
