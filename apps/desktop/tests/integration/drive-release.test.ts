import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  driveAppVersion,
  readDriveRelease,
  rootArtifactOf,
  type DriveReleaseRead,
  type RootArtifact,
  type RootEntryKind
} from '../../src/main/services/updates/drive-release'
import { DESKTOP_ROOT, REPO_ROOT } from '../helpers/repo-files'
import { hangBudgetMs, testBudgetMs, within } from '../helpers/hang-budget'
import { makeUnreadable } from '../helpers/unreadable-dir'

// F-13 (app-update plan Appendix B, W-20; docs/app-updates.md §8.5, §5.10 table B.11): what release 1 makes of
// config/drive-release.json can never change in the field, and every Kit carries the record the builders' helper wrote.
// The expected values are the golden's (tests/fixtures/readers/f13-drive-release/), written by hand from the plan, the
// record and the T3.3a sheet, never from the reader's or the helper's output. The reader runs in this process; the
// helper runs as the builders run it, `node scripts/lib/write-drive-release.mjs`, in a real child, so every CI leg also
// proves that plain Node loads the TypeScript reader through type stripping.

type Part = { text: string } | { base64: string } | { repeat: string; times: number }
type At =
  | 'file'
  | 'no-config'
  | 'absent'
  | 'config-is-file'
  | 'folder'
  | 'file-link'
  | 'dangling-link'
  | 'folder-link'
  | 'config-link'
  | 'fifo'
  | 'deny-read'
  | 'held'
interface ReadVector {
  id: string
  name: string
  at?: At
  parts?: Part[]
  expect?: DriveReleaseRead | { kind: 'unreadable' }
  anyOf?: DriveReleaseRead[]
  codes?: string[]
  decision: string | null
}
interface RecordShape {
  app_version: string | null
  systems: string[]
  paths?: string[]
}
interface WriteVector {
  id: string
  name: string
  remove?: string[]
  add?: Record<string, string>
  existing?: Part[]
  at?: At
  links?: Array<{ at: string; to: string; kind: 'folder' | 'file' }>
  dryRun?: boolean
  exit: number
  record: 'golden' | 'untouched' | 'none' | RecordShape
  append?: string
  appendRepeat?: { before: string; repeat: string; times: number; after: string }
  stdout?: string
  stderr?: string
}
interface Golden {
  read: ReadVector[]
  noCache: { first: string; second: string; firstDecision: string; secondDecision: string }
  artifacts: Array<{ name: string; kind: RootEntryKind; artifact: RootArtifact | null }>
  tree: { files: Record<string, string> }
  writes: { vectors: WriteVector[] }
}

const GOLDEN_DIR = join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f13-drive-release')
const GOLDEN = JSON.parse(readFileSync(join(GOLDEN_DIR, 'vectors.json'), 'utf8')) as Golden
const EXPECTED_RECORD = readFileSync(join(GOLDEN_DIR, 'expected-record.json'))
const GOLDEN_PATHS = (JSON.parse(EXPECTED_RECORD.toString('utf8')) as { files: Array<{ path: string }> }).files.map((f) => f.path)
const HELPER = join(REPO_ROOT, 'scripts', 'lib', 'write-drive-release.mjs')
const READER_TS = join(DESKTOP_ROOT, 'src', 'main', 'services', 'updates', 'drive-release.ts')
const SIBLING_IMPORTS = join(REPO_ROOT, 'scripts', 'lib', 'ts-sibling-imports.mjs')
/** The golden's answer for a file holding `{"app_version":"0.2.0"}` (R12a), for the rows that read one outside `read`. */
const R12A = GOLDEN.read.find((v) => v.id === 'R12a')!

const isWindows = process.platform === 'win32'
const isPosixRoot = process.getuid?.() === 0

const bytesOf = (parts: Part[]): Buffer =>
  Buffer.concat(
    parts.map((p) =>
      'text' in p ? Buffer.from(p.text, 'utf8') : 'base64' in p ? Buffer.from(p.base64, 'base64') : Buffer.from(p.repeat.repeat(p.times), 'utf8')
    )
  )

const scratch = (label: string): string => mkdtempSync(join(tmpdir(), `hr-drive-release-${label}-`))
const recordPath = (root: string): string => join(root, 'config', 'drive-release.json')
const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** A symbolic link to a file needs the privilege on Windows (Developer Mode or admin); the rows that need one skip without it. */
const canFileLink = ((): boolean => {
  const dir = scratch('can-link')
  try {
    writeFileSync(join(dir, 't'), '')
    symlinkSync(join(dir, 't'), join(dir, 'l'), 'file')
    return true
  } catch {
    return false
  }
})()
if (!canFileLink) console.warn('drive-release.test: no symbolic links to files here (Windows without the privilege): those rows skip')

/** Why this machine cannot place `at`, or null. Named for the orchestrator's CI skip-count check. */
function cannotPlace(at: At | undefined, links: WriteVector['links'] = []): string | null {
  if ((at === 'file-link' || at === 'dangling-link' || links.some((l) => l.kind === 'file')) && !canFileLink) return 'no file symlinks'
  if (at === 'fifo' && isWindows) return 'no named pipes on Windows'
  if (at === 'held' && !isWindows) return 'POSIX has no sharing modes'
  if (at === 'deny-read' && isPosixRoot) return 'root reads any mode'
  return null
}

/**
 * Windows: another process holds `path` open with the sharing `share`, as an antivirus scan or an indexer does, until the
 * returned release runs. `None` refuses every other open; `Read` lets others read but not delete or replace the file.
 */
async function holdOpen(path: string, share: 'None' | 'Read'): Promise<() => Promise<void>> {
  const script = `$f = [System.IO.File]::Open($env:HR_HOLD_PATH, 'Open', 'Read', '${share}'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, HR_HOLD_PATH: path },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let out = ''
  await within(
    new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
        if (out.includes('held')) resolve()
      })
      child.stderr.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.once('exit', (code) => reject(new Error(`the holder exited (${String(code)}) before it held the file: ${out}`)))
    }),
    'the holder opening the file',
    30_000
  )
  return async () => {
    child.stdin.end('\n')
    await within(exited, 'the holder closing the file', 30_000)
  }
}

/** Puts what `at` says at config/drive-release.json under a root whose config/ (if any) exists; returns the undo. */
async function placeAt(root: string, at: At, parts: Part[] | undefined): Promise<() => Promise<void> | void> {
  const file = recordPath(root)
  const bytes = parts === undefined ? Buffer.alloc(0) : bytesOf(parts)
  switch (at) {
    case 'file':
      writeFileSync(file, bytes)
      return () => undefined
    case 'no-config':
    case 'absent':
      return () => undefined
    case 'config-link':
      if (parts !== undefined) writeFileSync(file, bytes) // through the link, into the folder it points to
      return () => undefined
    case 'config-is-file':
      writeFileSync(join(root, 'config'), 'not a folder')
      return () => undefined
    case 'folder':
      mkdirSync(file)
      return () => undefined
    case 'file-link':
      writeFileSync(join(root, 'config', 'target.json'), bytes)
      symlinkSync(join(root, 'config', 'target.json'), file, 'file')
      return () => undefined
    case 'dangling-link':
      symlinkSync(join(root, 'config', 'gone.json'), file, 'file')
      return () => undefined
    case 'folder-link':
      mkdirSync(join(root, 'target-folder'))
      symlinkSync(join(root, 'target-folder'), file, 'junction') // `junction` is ignored outside Windows: a folder symlink
      return () => undefined
    case 'fifo': {
      const r = spawnSync('mkfifo', [file], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`mkfifo failed: ${r.stderr}`)
      return () => undefined
    }
    case 'deny-read':
      writeFileSync(file, bytes)
      return makeUnreadable(file) // RD on Windows (read data), mode 000 elsewhere; a file opens by path as before
    case 'held':
      writeFileSync(file, bytes)
      return holdOpen(file, 'None')
  }
}

/** A scratch drive root with config/drive.json, or without config/ where `at` needs that; for `config-link` config/ is a
 *  link to the folder that holds it. */
function readRoot(at: At): string {
  const root = scratch('read')
  if (at === 'no-config' || at === 'config-is-file') return root
  const config = join(root, at === 'config-link' ? 'config-target' : 'config')
  mkdirSync(config)
  writeFileSync(join(config, 'drive.json'), '{}')
  if (at === 'config-link') symlinkSync(config, join(root, 'config'), 'junction') // `junction` is ignored outside Windows
  return root
}

/**
 * The reader as plain Node loads it (the helper's way), in a child whose `node:fs` answers as `readInChild` is told:
 * `HR_SEEN`, the record's name `lstat`s as that regular file did (what was there before a swap); `HR_CLOSE_FAILS`, a
 * close closes, then throws. The reader's own open, fstat and read stay real.
 */
const CHILD_READ = [
  "import fs from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  'const env = process.env',
  'const { registerTsSiblingImports } = await import(env.HR_SIBLINGS)',
  'registerTsSiblingImports()',
  'const { readDriveRelease } = await import(env.HR_READER)',
  'const { lstatSync, closeSync } = fs',
  'if (env.HR_SEEN) {',
  '  const seen = lstatSync(env.HR_SEEN)',
  '  fs.lstatSync = (path, ...rest) => (path === env.HR_RECORD ? seen : lstatSync(path, ...rest))',
  '}',
  "if (env.HR_CLOSE_FAILS) fs.closeSync = (fd) => { closeSync(fd); throw Object.assign(new Error('injected'), { code: 'EIO' }) }",
  'syncBuiltinESMExports()',
  'process.stdout.write(JSON.stringify(readDriveRelease(env.HR_ROOT)))'
].join('\n')

/** `readDriveRelease(root)` in a child (see CHILD_READ), bounded: an open that blocks is killed and fails the row. */
function readInChild(root: string, opts: { seen?: string; closeFails?: boolean }): DriveReleaseRead {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '--eval', CHILD_READ], {
    env: {
      ...process.env,
      HR_SIBLINGS: pathToFileURL(SIBLING_IMPORTS).href,
      HR_READER: pathToFileURL(READER_TS).href,
      HR_ROOT: root,
      HR_RECORD: recordPath(root),
      HR_SEEN: opts.seen ?? '',
      HR_CLOSE_FAILS: opts.closeFails ? '1' : ''
    },
    encoding: 'utf8',
    timeout: hangBudgetMs(10_000),
    windowsHide: true
  })
  if (r.error) throw new Error(`the read did not return (${(r.error as NodeJS.ErrnoException).code ?? 'error'}): an open that blocks?`)
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as DriveReleaseRead
}

describe('F-13 golden: readDriveRelease reads config/drive-release.json as release 1 does for ever', () => {
  it.for(GOLDEN.read.map((v) => [`${v.id} ${v.name}`, v] as const))('%s', async ([, v], ctx) => {
    const at = v.at ?? 'file'
    if (cannotPlace(at)) ctx.skip()
    const root = readRoot(at)
    const undo = await placeAt(root, at, v.parts)
    let got: DriveReleaseRead
    try {
      got = readDriveRelease(root)
    } finally {
      await undo()
    }
    if (v.anyOf) expect(v.anyOf).toContainEqual(got)
    else if (v.codes) {
      // An errno token only, never a message (which names the path; F-11's content-free rule).
      expect(Object.keys(got).sort()).toEqual(['code', 'kind'])
      expect(got.kind).toBe('unreadable')
      expect(v.codes).toContain((got as { code: unknown }).code)
    } else expect(got).toStrictEqual(v.expect)
    expect(driveAppVersion(got)).toBe(v.decision)
  })

  // P3 entry decision 7: the update rules read from disk at each call, so a same-size, same-mtime edit is never missed.
  it('R25 reads the disk at every call: a same-size, same-mtime rewrite is seen', () => {
    const { first, second, firstDecision, secondDecision } = GOLDEN.noCache
    expect(first.length).toBe(second.length) // the premise of "same size"
    const root = readRoot('file')
    const file = recordPath(root)
    const pinned = new Date('2026-01-02T03:04:05Z')
    writeFileSync(file, first)
    utimesSync(file, pinned, pinned)
    expect(driveAppVersion(readDriveRelease(root))).toBe(firstDecision)
    writeFileSync(file, second)
    utimesSync(file, pinned, pinned)
    expect(driveAppVersion(readDriveRelease(root))).toBe(secondDecision)
  })

  // Review m2 and T3.2's review m-7: what the open finds can differ from what the lstat saw, when something is swapped
  // in at the name between the two. A race cannot be timed portably, so the child's lstat answers for the name as the
  // regular file there before the swap did, and the name really holds what was swapped in, which the reader's real open
  // and fstat meet: a folder (every system: the open succeeds, the fstat sees a folder); a named pipe (POSIX: opened
  // non-blocking, so it cannot hold the start); a symbolic link to a record (POSIX: O_NOFOLLOW refuses it; Windows has
  // no such flag, so there the open follows the link to the file it names: the recorded residual).
  const SWAPS: ReadonlyArray<readonly [string, At, DriveReleaseRead]> = [
    ['a folder', 'folder', { kind: 'damaged', fault: 'not-a-file' }],
    ['a named pipe', 'fifo', { kind: 'damaged', fault: 'not-a-file' }],
    ['a symbolic link to a record', 'file-link', isWindows ? (R12A.expect as DriveReleaseRead) : { kind: 'unreadable', code: 'ELOOP' }]
  ]
  it.for(SWAPS)('R28 swapped in after the lstat: %s', { timeout: testBudgetMs(60_000) }, async ([, at, want], ctx) => {
    if (cannotPlace(at)) ctx.skip()
    const root = readRoot('file')
    const seen = join(root, 'config', 'before-the-swap.json')
    writeFileSync(seen, bytesOf(R12A.parts!))
    await placeAt(root, at, R12A.parts)
    expect(readInChild(root, { seen })).toStrictEqual(want)
  })

  // Review m3: a close that fails after the read cannot make the reader throw; the read's answer stands.
  it('R29 a close that fails after the read: the read still answers, nothing is thrown', () => {
    const root = readRoot('file')
    writeFileSync(recordPath(root), bytesOf(R12A.parts!))
    expect(readInChild(root, { closeFails: true })).toStrictEqual(R12A.expect)
  }, testBudgetMs(60_000))
})

describe('rootArtifactOf: the drive-root names release 1 counts as apps, and the version each carries (record §4.4)', () => {
  it.each(GOLDEN.artifacts.map((a) => [a.name, a.kind, a.artifact] as const))('%s (%s)', (name, kind, artifact) => {
    expect(rootArtifactOf(name, kind)).toStrictEqual(artifact)
  })
})

// ---- the helper -------------------------------------------------------------------------------------------------

interface Run {
  status: number | null
  stdout: string
  /** The helper's own stderr lines (each starts with "drive-release.json"); Node's warnings are left out. */
  own: string[]
  stderr: string
}

/** The helper as the builders run it (or the copy `helper`), from a working folder of its own unless `cwd` says otherwise. */
function runHelper(args: string[], opts: { cwd?: string; nodeArgs?: string[]; helper?: string } = {}): Run {
  const r = spawnSync(process.execPath, [...(opts.nodeArgs ?? []), opts.helper ?? HELPER, ...args], {
    cwd: opts.cwd ?? scratch('cwd'),
    encoding: 'utf8',
    timeout: testBudgetMs(60_000),
    windowsHide: true
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, own: r.stderr.split(/\r?\n/).filter((l) => l.startsWith('drive-release.json')), stderr: r.stderr }
}

/** A copy of the helper and its ts-sibling-imports under a scratch repo root, with `reader` (its text) at the reader's
 *  path there, or nothing at that path. Returns the copy's path. */
function helperCopy(reader: string | null): string {
  const repo = scratch('helper-copy')
  const lib = join(repo, 'scripts', 'lib')
  mkdirSync(lib, { recursive: true })
  for (const name of ['write-drive-release.mjs', 'ts-sibling-imports.mjs']) copyFileSync(join(REPO_ROOT, 'scripts', 'lib', name), join(lib, name))
  if (reader !== null) {
    const dir = join(repo, 'apps', 'desktop', 'src', 'main', 'services', 'updates')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'drive-release.ts'), reader)
  }
  return join(lib, 'write-drive-release.mjs')
}

/** The golden tree with the vector's changes under a fresh root; config/ goes behind a junction for `config-link`. */
function treeRoot(v: Pick<WriteVector, 'remove' | 'add' | 'at' | 'links'> = {}): string {
  const root = scratch('tree')
  const files = { ...GOLDEN.tree.files }
  for (const p of v.remove ?? []) delete files[p]
  Object.assign(files, v.add ?? {})
  for (const [rel, text] of Object.entries(files)) {
    const segments = rel.split('/')
    if (v.at === 'config-link' && segments[0] === 'config') segments[0] = 'config-target'
    const path = join(root, ...segments)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  if (v.at === 'config-link') symlinkSync(join(root, 'config-target'), join(root, 'config'), 'junction')
  for (const l of v.links ?? []) {
    const link = join(root, ...l.at.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(root, ...l.to.split('/')), link, l.kind === 'folder' ? 'junction' : 'file')
  }
  return root
}

/** The golden record's bytes, with the vector's kept fields between the files list and the closing brace. */
function goldenBytes(v: Pick<WriteVector, 'append' | 'appendRepeat'>): Buffer {
  const extra = v.append ?? (v.appendRepeat ? `${v.appendRepeat.before}${v.appendRepeat.repeat.repeat(v.appendRepeat.times)}${v.appendRepeat.after}` : null)
  const text = EXPECTED_RECORD.toString('utf8')
  return Buffer.from(extra === null ? text : text.replace(/\n}\n$/, `,\n${extra}\n}\n`), 'utf8')
}

function expectRecordShape(root: string, want: RecordShape): void {
  const bytes = readFileSync(recordPath(root))
  expect(bytes.includes(0x0d), 'LF only').toBe(false)
  expect(bytes[0], 'no byte-order mark').toBe(0x7b)
  expect(bytes.toString('utf8').endsWith('}\n')).toBe(true)
  const record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  expect(Object.keys(record)).toEqual(['format', ...(want.app_version === null ? [] : ['app_version']), 'systems', 'files'])
  expect(record.format).toBe(1)
  if (want.app_version !== null) expect(record.app_version).toBe(want.app_version)
  expect(record.systems).toEqual(want.systems)
  const files = record.files as Array<Record<string, unknown>>
  expect(files.map((f) => f.path)).toEqual(want.paths ?? GOLDEN_PATHS)
  for (const f of files) {
    expect(Object.keys(f)).toEqual(['path', 'sha256'])
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  }
}

function expectUntouched(root: string, v: WriteVector): void {
  const file = recordPath(root)
  const at = v.at ?? 'file'
  const info = lstatOrNull(file)
  expect(info, 'the record is still there').not.toBeNull()
  if (at === 'folder') expect(info!.isDirectory()).toBe(true)
  if (at === 'folder-link' || at === 'file-link') expect(info!.isSymbolicLink()).toBe(true)
  if (v.existing) expect(readFileSync(at === 'file-link' ? join(root, 'config', 'target.json') : file)).toEqual(bytesOf(v.existing))
}

describe('F-13 golden: the helper writes the record the HEAD builders put on every drive (W-20)', () => {
  it.for(GOLDEN.writes.vectors.map((v) => [`${v.id} ${v.name}`, v] as const))(
    '%s',
    { timeout: testBudgetMs(60_000) },
    async ([, v], ctx) => {
      if (cannotPlace(v.at, v.links)) ctx.skip()
      const root = treeRoot(v)
      const undo = v.existing !== undefined || (v.at !== undefined && v.at !== 'config-link') ? await placeAt(root, v.at ?? 'file', v.existing) : () => undefined
      let run: Run
      try {
        run = runHelper(['--target', root, ...(v.dryRun ? ['--dry-run'] : [])])
      } finally {
        await undo()
      }
      expect(run.status, run.own.join('\n')).toBe(v.exit)
      if (v.stdout !== undefined) expect(run.stdout).toBe(`${v.stdout}\n`)
      else if (v.exit === 0) expect(run.stdout).toMatch(/^drive-release\.json: app_version=\S+.* systems=\S+ files=\d+\n$/)
      else expect(run.stdout).toBe('')
      expect(run.own).toEqual(v.stderr === undefined ? [] : [expect.stringContaining(v.stderr)])
      expect(lstatOrNull(`${recordPath(root)}.tmp`), 'no temporary file is left').toBeNull()
      if (v.record === 'golden') expect(readFileSync(recordPath(root))).toEqual(goldenBytes(v))
      else if (v.record === 'untouched') expectUntouched(root, v)
      else if (v.record === 'none') expect(lstatOrNull(recordPath(root))).toBeNull()
      else expectRecordShape(root, v.record)
      // What the helper wrote, release 1's own reader reads back: a record, with the app_version written, format 1.
      if (v.exit === 0 && !v.dryRun) {
        const back = readDriveRelease(root)
        const want = v.record === 'golden' ? '0.2.0' : (v.record as RecordShape).app_version
        expect(back.kind).toBe('record')
        expect(driveAppVersion(back)).toBe(want)
        expect(back.kind === 'record' && back.format).toStrictEqual({ state: 'valid', value: 1 })
      }
    }
  )

  it('W02 a second run over its own record writes the same bytes', () => {
    const root = treeRoot()
    expect(runHelper(['--target', root]).status).toBe(0)
    const first = readFileSync(recordPath(root))
    expect(runHelper(['--target', root]).status).toBe(0)
    expect(readFileSync(recordPath(root))).toEqual(first)
    expect(first).toEqual(EXPECTED_RECORD)
  }, testBudgetMs(60_000))

  // The record is a function of the tree alone, so both builder twins (and any working folder or spelling of the
  // target) give the same bytes: no clock, host, locale, working folder or target prefix in it.
  it('W03 the same bytes from another working folder and every spelling of the target', () => {
    const spellings: Array<[string, (root: string) => { target: string; cwd?: string }]> = [
      ['as is', (root) => ({ target: root })],
      ['a trailing slash', (root) => ({ target: `${root}/` })],
      ['a trailing /.', (root) => ({ target: `${root}/.` })],
      ['relative to the working folder', (root) => ({ target: basename(root), cwd: dirname(root) })],
      ...(isWindows ? [['a trailing backslash', (root: string) => ({ target: `${root}\\` })] as [string, (root: string) => { target: string }]] : [])
    ]
    for (const [label, spell] of spellings) {
      const root = treeRoot()
      const { target, cwd } = spell(root)
      const run = runHelper(['--target', target], { cwd })
      expect(run.status, label).toBe(0)
      expect(readFileSync(recordPath(root)), label).toEqual(EXPECTED_RECORD)
    }
  }, testBudgetMs(120_000))

  // A failed write leaves the old record as it was and no temporary file. POSIX: config/ refuses a new file (mode r-x),
  // so the temporary file is never made. Windows: another process holds the record open without delete sharing, so
  // the temporary file is written and its rename over the record fails.
  it('W22 a write that fails leaves the old record and no temporary file', async (ctx) => {
    if (isPosixRoot) ctx.skip() // root writes into any mode
    const root = treeRoot()
    const existing = '{"zeta":1}'
    writeFileSync(recordPath(root), existing)
    let undo: () => Promise<void> | void
    if (isWindows) undo = await holdOpen(recordPath(root), 'Read')
    else {
      chmodSync(join(root, 'config'), 0o555)
      undo = () => chmodSync(join(root, 'config'), 0o755)
    }
    let run: Run
    try {
      run = runHelper(['--target', root])
    } finally {
      await undo()
    }
    expect(run.status).toBe(1)
    expect(run.own).toEqual([expect.stringContaining('writing the record failed')])
    expect(readFileSync(recordPath(root), 'utf8')).toBe(existing)
    expect(lstatOrNull(`${recordPath(root)}.tmp`)).toBeNull()
  }, testBudgetMs(60_000))

  it('W19c a target that does not exist is refused', () => {
    const run = runHelper(['--target', join(scratch('gone'), 'no-such-drive')])
    expect(run.status).toBe(1)
    expect(run.own).toEqual([expect.stringContaining('the target is not a folder')])
  }, testBudgetMs(60_000))

  // T3.3b decides how each builder treats it: on a Node without type stripping the helper cannot load the reader.
  it('a Node without type stripping is refused with one line, before anything is read or written', () => {
    const root = treeRoot()
    const run = runHelper(['--target', root], { nodeArgs: ['--no-experimental-strip-types'] })
    expect(run.status).toBe(1)
    expect(run.own).toEqual([expect.stringContaining('type stripping')])
    expect(lstatOrNull(recordPath(root))).toBeNull()
  }, testBudgetMs(60_000))

  // Review m4: a reader that cannot be loaded (a partial checkout, a later Node without module hooks) ends the helper
  // with its own one line, never Node's stack with the checkout's paths. Run as the builders run it (`--no-warnings`,
  // T3.3b), stderr holds that line and nothing else.
  it('W31 a reader that cannot be loaded is refused with one line, and nothing is written', () => {
    const root = treeRoot()
    const run = runHelper(['--target', root], { helper: helperCopy(null), nodeArgs: ['--no-warnings'] })
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr.split(/\r?\n/).filter((l) => l !== '')).toEqual(['drive-release.json: the reader could not be loaded (ERR_MODULE_NOT_FOUND); nothing written'])
    expect(lstatOrNull(recordPath(root))).toBeNull()
  }, testBudgetMs(60_000))

  // Review m5: the record is replaced before it is read back, so a failed read-back says the record was written. The
  // copy's reader is the real one but for a read-back that finds no record, as a drive that does not give back what
  // was written would.
  it('W32 a record that does not read back as written: exit 1, and the line says it was written', () => {
    const root = treeRoot()
    const reader = `export * from ${JSON.stringify(pathToFileURL(READER_TS).href)}\nexport function readDriveRelease() {\n  return { kind: 'absent' }\n}\n`
    const run = runHelper(['--target', root], { helper: helperCopy(reader) })
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.own).toEqual(['drive-release.json: the record was written but could not be read back as written; check the drive'])
    expect(readFileSync(recordPath(root))).toEqual(EXPECTED_RECORD)
    expect(lstatOrNull(`${recordPath(root)}.tmp`)).toBeNull()
  }, testBudgetMs(60_000))

  it.each<[string, string[]]>([
    ['no arguments', []],
    ['--target without a value', ['--target']],
    ['an unknown flag', ['--target', 'x', '--force']],
    ['--dry-run alone', ['--dry-run']],
    ['two targets', ['--target', 'x', '--target', 'y']]
  ])('exits 2 on a usage error: %s', (_label, args) => {
    const run = runHelper(args)
    expect(run.status).toBe(2)
    expect(run.own).toEqual([expect.stringContaining('usage:')])
    expect(run.stdout).toBe('')
  }, testBudgetMs(60_000))
})
