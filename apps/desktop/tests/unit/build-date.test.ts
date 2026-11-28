import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'
import config from '../../electron.vite.config'
import { APP_IN_HEAD, buildDateFileText, buildDatePlugin, commitDate, utcSecondText } from '../../build-date-plugin'
import { parseBuildDate } from '../../src/main/services/updates/build-date'
import { tempRoot } from '../helpers/db-fixtures'
import { REPO_ROOT } from '../helpers/repo-files'

// The build date (app-update W-17, F-12; docs/app-updates.md §5.10, "The build-date file", "The build-date step", "The
// build date's reader"): the release commit's committer date, written by the build into a git-ignored
// build-date.json beside keys.json, embedded into the main bundle through import.meta.glob, and silent (null) for a
// build that has no release date. Here: the step's date and its null cases on throw-away repositories (made below, never
// this checkout), the file's bytes, the plugin's hooks on a scratch folder, its log line for a build with no date, its
// place in the main target, the anchored ignore line, and the reader's reading of the file's value. No row reads this
// checkout's own build-date.json, which is absent or a developer's leftover in a test run (record §5.10); the reader
// built through Vite is tests/integration/build-date-reader.test.ts's, and that the value reaches the bundle is the
// release guard's packed row (updates-bundle-check.test.ts, checkBundleBuildDate) and the task's build proof.
//
// execFileSync is the real one, watched: rows read the environment and options each git call of the step is handed
// (what the child process gets), and some rows hand the step a git answer no real git gives here (CR LF line ends, a
// time limit, a failing `show`).

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFileSync: vi.fn(real.execFileSync) }
})
const { execFileSync: realExecFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')

/** The walk's list of the variables git runs without (scripts/release/walk-build.mjs; record §5.10 names it). */
const { GIT_ENV_DROPPED: WALK_GIT_ENV_DROPPED } = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'release', 'walk-build.mjs')).href)) as {
  GIT_ENV_DROPPED: readonly string[]
}

/** The test's own git: no global or system config (hooks, templates, signing, autocrlf) and no inherited repository. */
function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  const base: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig(), GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete base[k]
  return execFileSync('git', ['-c', 'user.name=build-date-test', '-c', 'user.email=build-date-test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: { ...base, ...env },
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  })
}

let configDir: string | null = null
function emptyConfig(): string {
  if (configDir === null) {
    configDir = tempRoot('build-date-gitconfig')
    writeFileSync(join(configDir, 'gitconfig'), '')
  }
  return join(configDir, 'gitconfig')
}

/** The step's own git calls, too, read no global or system configuration: a row's repository configuration decides. */
function isolateGitConfig(): void {
  vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig())
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
}

/** A path as git's configuration and a shell script take it on every system. */
const slashed = (path: string): string => path.split(sep).join('/')

/** Where the step writes the file, below apps/desktop (record §5.10: beside keys.json). */
const FILE_PARTS = ['src', 'main', 'services', 'updates', 'build-date.json'] as const

/** The committer date of every throw-away commit here, and the same instant in UTC; the author date differs on purpose. */
const COMMITTED = '2027-03-15T10:30:00+01:00'
const COMMITTED_UTC = '2027-03-15T09:30:00Z'
const AUTHORED = '2001-02-03T04:05:06+00:00'
/** COMMITTED as a commit object writes it. */
const COMMITTED_RAW = '1805103000 +0100'
const IDENT = 'build-date-test <build-date-test@example.invalid>'

interface Checkout {
  /** The repository's top folder. */
  readonly repo: string
  /** The app folder inside it, `<repo>/<desktopAt>`. */
  readonly desktop: string
  git(...args: string[]): string
}

/** A throw-away repository with the app folder at `desktopAt` (apps/desktop, as in this repository, by default), the
 *  app's build-date-plugin.ts (record §5.10: HEAD's tree must hold apps/desktop/build-date-plugin.ts), one tracked file in
 *  the updates folder and a README, in one commit dated COMMITTED. */
function checkout(label: string, desktopAt = 'apps/desktop'): Checkout {
  const repo = tempRoot(`build-date-${label}`)
  const desktop = desktopAt === '' ? repo : join(repo, ...desktopAt.split('/'))
  const git = (...args: string[]): string => gitIn(repo, args, { GIT_COMMITTER_DATE: COMMITTED, GIT_AUTHOR_DATE: AUTHORED })
  mkdirSync(dirname(join(desktop, ...FILE_PARTS)), { recursive: true })
  writeFileSync(join(desktop, 'build-date-plugin.ts'), '// the app\u{2019}s build-date step (a stand-in)\n')
  writeFileSync(join(desktop, 'src', 'main', 'services', 'updates', 'keys.json'), '{ "key_set": "x" }\n')
  writeFileSync(join(repo, 'README.md'), 'one\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'one')
  return { repo, desktop, git }
}

/** Another project's repository (one commit, no apps/desktop in it) with this app unpacked, untracked, at its
 *  apps/desktop: a source archive unpacked at the top of someone else's checkout (T6.4a review B M-2). */
function foreignCheckout(label: string): Checkout {
  const repo = tempRoot(`build-date-${label}`)
  const git = (...args: string[]): string => gitIn(repo, args, { GIT_COMMITTER_DATE: COMMITTED, GIT_AUTHOR_DATE: AUTHORED })
  writeFileSync(join(repo, 'README.md'), 'another project\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'theirs')
  const desktop = join(repo, 'apps', 'desktop')
  mkdirSync(dirname(join(desktop, ...FILE_PARTS)), { recursive: true })
  writeFileSync(join(desktop, 'build-date-plugin.ts'), '// unpacked from a source archive\n')
  writeFileSync(join(desktop, 'src', 'main', 'services', 'updates', 'keys.json'), '{ "key_set": "x" }\n')
  return { repo, desktop, git }
}

/** A repository with no commit yet and the app folder at apps/desktop. */
function unbornCheckout(label: string): string {
  const repo = tempRoot(`build-date-${label}`)
  const desktop = join(repo, 'apps', 'desktop')
  mkdirSync(dirname(join(desktop, ...FILE_PARTS)), { recursive: true })
  gitIn(repo, ['init', '-q'])
  return desktop
}

/** HEAD moved to a commit object written here, with the checkout's tree and the given header lines (no key is made). */
function writeHead(c: Checkout, lines: readonly string[]): void {
  const tree = c.git('rev-parse', 'HEAD^{tree}').trim()
  const sha = gitIn(c.repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {}, [`tree ${tree}`, ...lines].join('\n')).trim()
  c.git('update-ref', 'HEAD', sha)
}

/** A shell script that appends a line to `mark` each time it starts (and passes its input through, for a filter).
 *  Git is told to run it as `sh "<script>"`, so it needs no execute permission (nor a temp folder that grants one). */
function marker(label: string): { script: string; mark: string } {
  const dir = tempRoot(`build-date-${label}`)
  const mark = join(dir, 'started.txt')
  const script = join(dir, 'probe.sh')
  writeFileSync(script, `#!/bin/sh\necho started >> "${slashed(mark)}"\ncat\n`)
  return { script, mark }
}

/** The options the step handed each git call since the last clear, one per call (this file's own git has no -C). */
function stepGitCalls(): { env?: NodeJS.ProcessEnv; timeout?: number; stdio?: unknown }[] {
  const calls = vi.mocked(execFileSync).mock.calls as unknown as [string, readonly string[], { env?: NodeJS.ProcessEnv; timeout?: number; stdio?: unknown }][]
  return calls.filter(([file, args]) => file === 'git' && args.includes('-C')).map(([, , options]) => options)
}

/** The environments the step handed git since the last clear: one per git call. */
function stepGitEnvs(): NodeJS.ProcessEnv[] {
  return stepGitCalls().map((options) => options.env ?? {})
}

/** Git 2.45 and later honour GIT_NO_LAZY_FETCH; an older git ignores it (record §5.10 states the limit). */
const gitHonoursNoLazyFetch = ((): boolean => {
  try {
    const version = /^git version ([0-9]+)\.([0-9]+)/.exec(String(realExecFileSync('git', ['--version'], { encoding: 'utf8' })))
    return version !== null && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 45))
  } catch {
    return false
  }
})()

/** How many packs a repository's object store holds: one more means git fetched. */
const packsIn = (repo: string): number => readdirSync(join(repo, '.git', 'objects', 'pack')).filter((name) => name.endsWith('.pack')).length

/** For the next git calls, the answer `change` makes of each real one (or throws instead). */
function gitAnswers(change: (args: readonly string[], real: () => string) => string): void {
  vi.mocked(execFileSync).mockImplementation(((file: string, args: readonly string[], options: object) => {
    const real = (): string => realExecFileSync(file, args, options) as unknown as string
    return file === 'git' ? change(args, real) : real()
  }) as unknown as typeof execFileSync)
}

/** A git call past its time limit, as node's execFileSync reports one (code ETIMEDOUT). */
const timeLimit = (): Error => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' })

/** A clean checkout's app folder. The next git calls are real, except the one with `subcommand`, which throws
 *  `error()` instead. */
function failingAt(label: string, subcommand: string, error: () => Error): string {
  const c = checkout(label)
  gitAnswers((args, real) => {
    if (args.includes(subcommand)) throw error()
    return real()
  })
  return c.desktop
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(execFileSync).mockImplementation(realExecFileSync)
})

describe('the build-date step: the committer date of HEAD, in UTC to the second (record §5.10)', () => {
  it('a clean checkout with the app at apps/desktop: the committer time, not the author time, as UTC', () => {
    expect(commitDate(checkout('clean').desktop)).toBe(COMMITTED_UTC)
  })

  it('an untracked file only (status reads tracked files: --untracked-files=no): still the date', () => {
    const c = checkout('untracked')
    writeFileSync(join(c.repo, 'notes.txt'), 'not added\n')
    expect(commitDate(c.desktop)).toBe(COMMITTED_UTC)
  })

  // A developer's build, or a scratch copy whose keys.json the walk changed (record §10.4): no release date.
  it.each<[string, (c: Checkout) => void]>([
    ['a tracked file changed', (c) => writeFileSync(join(c.repo, 'README.md'), 'two\n')],
    ['a tracked file deleted', (c) => unlinkSync(join(c.repo, 'README.md'))],
    ['a new file staged', (c) => (writeFileSync(join(c.repo, 'new.txt'), 'new\n'), c.git('add', '--', 'new.txt'))]
  ])('%s: null', (_label, change) => {
    const c = checkout('dirty')
    change(c)
    expect(commitDate(c.desktop)).toBeNull()
  })

  it('a folder that is no checkout: null', () => {
    const dir = tempRoot('build-date-no-checkout')
    expect(commitDate(dir)).toBeNull()
  })

  // A source archive unpacked inside another repository's checkout would otherwise take that repository's date.
  it.each([
    ['the app folder deeper in another checkout (vendor/hr/apps/desktop)', 'vendor/hr/apps/desktop'],
    ["the app folder is the checkout's top", '']
  ])('%s: null (rev-parse --show-prefix is not apps/desktop/)', (_label, desktopAt) => {
    expect(commitDate(checkout('prefix', desktopAt).desktop)).toBeNull()
  })

  // The same archive unpacked at that repository's own apps/desktop passes the prefix check (T6.4a review B M-2).
  it("this app unpacked, untracked, at apps/desktop of another repository (HEAD\u{2019}s tree holds no apps/desktop/build-date-plugin.ts): null", () => {
    expect(commitDate(foreignCheckout('foreign').desktop)).toBeNull()
  })

  // The HEAD check names this file by a constant: a rename or move of the file that leaves the constant as it is would
  // give every build of this repository no release date, which only a release run would show (T6.4a re-check minor 5).
  // Read without git, so a source archive passes too: the module at the path the constant names, below the repository's
  // root, is the step this file imports.
  it('the path the HEAD check names, below the repository root, is this tree\u{2019}s own build-date step', async () => {
    const [rev, path] = APP_IN_HEAD.split(':')
    const named = join(REPO_ROOT, ...(path ?? '').split('/'))
    // Only a file is imported: a folder would load its package's main entry.
    const isFile = existsSync(named) && statSync(named).isFile()
    const step = isFile && ((await import(pathToFileURL(named).href)) as { buildDatePlugin?: unknown }).buildDatePlugin === buildDatePlugin
    expect({ rev, isFile, step }).toEqual({ rev: 'HEAD', isFile: true, step: true })
  })

  // Record §5.10: a time limit of 30 s per call, and no git text in the build's output (stderr dropped). On a clean
  // checkout every check runs.
  it('every git call of the step has the 30 s time limit and drops git\u{2019}s stderr', () => {
    const c = checkout('call-options')
    vi.mocked(execFileSync).mockClear()
    expect(commitDate(c.desktop)).toBe(COMMITTED_UTC)
    const calls = stepGitCalls().map(({ timeout, stdio }) => ({ timeout, stderr: Array.isArray(stdio) ? (stdio as unknown[])[2] : stdio }))
    expect({ calls: calls.length > 0, others: calls.filter((o) => o.timeout !== 30_000 || o.stderr !== 'ignore') }).toEqual({ calls: true, others: [] })
  })

  it('no git on PATH: null', () => {
    const c = checkout('no-git')
    vi.stubEnv('PATH', tempRoot('build-date-empty-path'))
    expect(commitDate(c.desktop)).toBeNull()
  })

  // The step asks about the checkout the app folder sits in, whatever repository, work tree or index a calling git
  // (a hook) left in the environment (the walk's rule, T6.11 F2).
  it('GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE naming another repository: still the checkout\u{2019}s own date', () => {
    const c = checkout('env')
    const decoy = tempRoot('build-date-decoy')
    gitIn(decoy, ['init', '-q'])
    writeFileSync(join(decoy, 'x.txt'), 'x\n')
    gitIn(decoy, ['add', '-A'])
    gitIn(decoy, ['commit', '-q', '-m', 'decoy'], { GIT_COMMITTER_DATE: '2030-01-01T00:00:00+00:00' })
    vi.stubEnv('GIT_DIR', join(decoy, '.git'))
    vi.stubEnv('GIT_WORK_TREE', decoy)
    vi.stubEnv('GIT_INDEX_FILE', join(decoy, '.git', 'index'))
    expect(commitDate(c.desktop)).toBe(COMMITTED_UTC)
  })

  // Record §5.10: git's --no-replace-objects on every call (T6.4a review B m-2).
  it("a replace ref on HEAD (another commit, dated 2031): the commit\u{2019}s own date, not the replacement\u{2019}s", () => {
    const c = checkout('replace')
    const head = c.git('rev-parse', 'HEAD').trim()
    const other = gitIn(c.repo, ['commit-tree', `${head}^{tree}`, '-m', 'other'], { GIT_COMMITTER_DATE: '2031-01-01T00:00:00+00:00', GIT_AUTHOR_DATE: AUTHORED }).trim()
    c.git('replace', head, other)
    expect(commitDate(c.desktop)).toBe(COMMITTED_UTC)
  })

  // Record §5.10: `show` runs with --no-show-signature (T6.4a review B m-3). The signature header is made-up text in SSH
  // armour: no key of any kind exists, git finds no allowed signers and starts no program (and none could start: both
  // verifier settings name a program that does not exist).
  it('log.showSignature in the repository configuration and a HEAD whose commit carries a signature header: still the date', () => {
    const c = checkout('signed')
    writeHead(c, [
      `author ${IDENT} ${COMMITTED_RAW}`,
      `committer ${IDENT} ${COMMITTED_RAW}`,
      'gpgsig -----BEGIN SSH SIGNATURE-----',
      ' bWFkZS11cCB0ZXh0LCBubyBrZXk=',
      ' -----END SSH SIGNATURE-----',
      '',
      'signed',
      ''
    ])
    c.git('config', 'log.showSignature', 'true')
    c.git('config', 'gpg.program', slashed(join(c.repo, 'no-such-program')))
    c.git('config', 'gpg.ssh.program', slashed(join(c.repo, 'no-such-program')))
    isolateGitConfig()
    expect(commitDate(c.desktop)).toBe(COMMITTED_UTC)
  })

  // Record §5.10: `status` runs with core.fsmonitor off and without optional locks (T6.4a review B m-6). The plain status
  // after the step is the control: it shows the program would start, and the index would be written. Git runs the
  // fsmonitor value through a shell, so `sh "<script>"` starts it as the filter rows do (T6.4a re-check minor 7).
  it('a core.fsmonitor program in the repository configuration: the step never starts it, and still gets the date', () => {
    const c = checkout('fsmonitor')
    const { script, mark } = marker('fsmonitor-probe')
    c.git('config', 'core.fsmonitor', `sh "${slashed(script)}"`)
    isolateGitConfig()
    const date = commitDate(c.desktop)
    const startedByTheStep = existsSync(mark)
    gitIn(c.repo, ['status', '--porcelain'])
    expect({ date, startedByTheStep, startedByAPlainStatus: existsSync(mark) }).toEqual({ date: COMMITTED_UTC, startedByTheStep: false, startedByAPlainStatus: true })
  })

  it('a tracked file whose time moved: the step leaves .git/index as it was (no optional lock), and still gets the date', () => {
    const c = checkout('locks')
    const index = join(c.repo, '.git', 'index')
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(c.repo, 'README.md'), later, later)
    const before = readFileSync(index)
    isolateGitConfig()
    const date = commitDate(c.desktop)
    const unchangedByTheStep = readFileSync(index).equals(before)
    gitIn(c.repo, ['status', '--porcelain'])
    expect({ date, unchangedByTheStep, changedByAPlainStatus: !readFileSync(index).equals(before) }).toEqual({
      date: COMMITTED_UTC,
      unchangedByTheStep: true,
      changedByAPlainStatus: true
    })
  })

  // Record §5.10: the prefix and HEAD checks come before `status`, so a folder of another repository is refused before
  // git starts any program its configuration names for `status` (here a clean filter on a file git must re-read).
  it.each<[string, () => Checkout]>([
    ['a folder whose prefix is not apps/desktop/', () => checkout('order-prefix', 'vendor/hr/apps/desktop')],
    ["this app at apps/desktop of another repository whose HEAD does not hold it", () => foreignCheckout('order-foreign')]
  ])('%s: null, and that repository\u{2019}s clean filter never starts', (_label, make) => {
    const c = make()
    const { script, mark } = marker('order-probe')
    writeFileSync(join(c.repo, '.gitattributes'), '* filter=probe\n')
    c.git('add', '--', '.gitattributes') // only it: the unpacked app stays untracked in the other repository
    c.git('commit', '-q', '-m', 'attributes')
    c.git('config', 'filter.probe.clean', `sh "${slashed(script)}"`)
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(c.repo, 'README.md'), later, later)
    isolateGitConfig()
    const date = commitDate(c.desktop)
    const startedByTheStep = existsSync(mark)
    gitIn(c.repo, ['status', '--porcelain'])
    expect({ date, startedByTheStep, startedByAPlainStatus: existsSync(mark) }).toEqual({ date: null, startedByTheStep: false, startedByAPlainStatus: true })
  })

  // The step takes one line end off each answer: LF, or CR LF as a git on Windows may write it.
  it('a git whose lines end in CR LF: still the date', () => {
    const c = checkout('crlf-answers')
    gitAnswers((_args, real) => real().replace(/\n/g, '\r\n'))
    expect(commitDate(c.desktop)).toBe(COMMITTED_UTC)
  })
})

// Record §5.10: git runs without the GIT_* variables that name another repository or another configuration, the walk's
// list (scripts/release/walk-build.mjs, T6.11), in any letter case on Windows (where `Git_Dir` is GIT_DIR). Each name
// alone, set to a value that points git elsewhere where git honours it: the checkout's own date, and no git call of the
// step is handed the name.
describe('the build-date step hands git none of the walk\u{2019}s variables (record §5.10; T6.4a review B, uncovered)', () => {
  let c: Checkout
  let decoy: string
  beforeAll(() => {
    c = checkout('env-names')
    decoy = tempRoot('build-date-env-decoy')
    gitIn(decoy, ['init', '-q'])
    writeFileSync(join(decoy, 'x.txt'), 'x\n')
    gitIn(decoy, ['add', '-A'])
    gitIn(decoy, ['commit', '-q', '-m', 'decoy'], { GIT_COMMITTER_DATE: '2030-01-01T00:00:00+00:00' })
  })
  /** The name as a Windows environment may spell it: `Git_Dir` for GIT_DIR (the same variable there). */
  const spelled = (name: string): string =>
    process.platform === 'win32' ? name.toLowerCase().replace(/(^|_)([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase()) : name
  /** Where each name points git; any other name (GIT_GRAFT_FILE, GIT_SHALLOW_FILE, one the walk adds) names a decoy file. */
  const VALUES: Readonly<Record<string, () => string>> = {
    GIT_DIR: () => join(decoy, '.git'),
    GIT_COMMON_DIR: () => join(decoy, '.git'),
    GIT_WORK_TREE: () => decoy,
    GIT_INDEX_FILE: () => join(decoy, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: () => join(decoy, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: () => join(decoy, '.git', 'objects'),
    GIT_CONFIG: () => join(decoy, '.git', 'config'),
    GIT_CONFIG_PARAMETERS: () => "'core.bare'='true'",
    GIT_CONFIG_COUNT: () => '1', // with GIT_CONFIG_KEY_0 and GIT_CONFIG_VALUE_0 below, which are inert without it
    GIT_CEILING_DIRECTORIES: () => slashed(c.repo),
    GIT_IMPLICIT_WORK_TREE: () => '0',
    GIT_NO_REPLACE_OBJECTS: () => '1',
    GIT_REPLACE_REF_BASE: () => 'refs/decoy/',
    GIT_PREFIX: () => 'vendor/',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: () => '1',
    GIT_NAMESPACE: () => 'decoy'
  }

  it('the walk\u{2019}s list holds the 18 names the record counts', () => {
    expect(WALK_GIT_ENV_DROPPED).toHaveLength(18)
  })

  it.each(WALK_GIT_ENV_DROPPED.map((name) => [name, spelled(name)] as const))('%s, set as %s: the checkout\u{2019}s own date, and no git call sees it', (name, asSet) => {
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')
    vi.stubEnv(asSet, (VALUES[name] ?? (() => join(decoy, 'x.txt')))())
    vi.mocked(execFileSync).mockClear()
    const date = commitDate(c.desktop)
    const envs = stepGitEnvs()
    expect({ date, gitCalls: envs.length > 0, seen: envs.flatMap((env) => Object.keys(env).filter((k) => k.toUpperCase() === name)) }).toEqual({
      date: COMMITTED_UTC,
      gitCalls: true,
      seen: []
    })
  })
})

describe('utcSecondText: git\u{2019}s %ct seconds as the file\u{2019}s text (record §5.10)', () => {
  it.each<[string, string]>([
    ['1805103000', '2027-03-15T09:30:00Z'],
    ['0', '1970-01-01T00:00:00Z'],
    ['253402300799', '9999-12-31T23:59:59Z']
  ])('%s: %s', (seconds, text) => {
    expect(utcSecondText(seconds)).toBe(text)
  })

  // Not a decimal number, or no time the file's shape can hold: no date.
  it.each(['', ' 1805103000', '1805103000 ', '-1', '1.5', '1e9', '0x10', '12a', '253402300800', '9'.repeat(30)])('%j: null', (seconds) => {
    expect(utcSecondText(seconds)).toBeNull()
  })
})

describe('the build-date file\u{2019}s bytes (record §5.10)', () => {
  it('a date: {"commit_date":"<date>"} and one LF; no date: {"commit_date":null} and one LF', () => {
    expect(buildDateFileText(COMMITTED_UTC)).toBe('{"commit_date":"2027-03-15T09:30:00Z"}\n')
    expect(buildDateFileText(null)).toBe('{"commit_date":null}\n')
  })
})

type Hook = (this: unknown, ...args: unknown[]) => unknown
/** The plugin's two hooks as Vite calls them: the resolved root and logger, then the build's start. Returns what the
 *  plugin logged, one entry per line. */
function run(plugin: Plugin, root: string): string[] {
  const lines: string[] = []
  const keep = (message: string): void => {
    lines.push(message)
  }
  ;(plugin.configResolved as unknown as Hook).call(null, { root, logger: { info: keep, warn: keep, warnOnce: keep, error: keep } })
  ;(plugin.buildStart as unknown as Hook).call(null, {})
  return lines
}
const fileIn = (desktop: string): string => join(desktop, ...FILE_PARTS)

describe('buildDatePlugin: the main target\u{2019}s buildStart writes the file (record §5.10)', () => {
  const writable: string[] = []
  afterAll(() => {
    for (const f of writable) chmodSync(f, 0o644) // so the temp-root sweep can remove it
  })

  it('writes the date into src/main/services/updates/build-date.json under the resolved root', () => {
    const c = checkout('plugin')
    run(buildDatePlugin(), c.desktop)
    expect(readFileSync(fileIn(c.desktop), 'latin1')).toBe('{"commit_date":"2027-03-15T09:30:00Z"}\n')
  })

  // A watch build must not set itself off again, so the file is written only when its bytes differ. A read-only file
  // with the same bytes shows that no write was tried; the changed answer then has to be written and fails on it.
  it('writes only when the bytes differ: the same bytes are not written again, other bytes are', () => {
    const c = checkout('plugin-change')
    const plugin = buildDatePlugin()
    run(plugin, c.desktop)
    chmodSync(fileIn(c.desktop), 0o444)
    writable.push(fileIn(c.desktop))
    expect(() => run(plugin, c.desktop)).not.toThrow()
    writeFileSync(join(c.repo, 'README.md'), 'two\n') // the tree now has a tracked change: no release date
    expect(() => run(plugin, c.desktop)).toThrow()
    chmodSync(fileIn(c.desktop), 0o644)
    run(plugin, c.desktop)
    expect(readFileSync(fileIn(c.desktop), 'latin1')).toBe('{"commit_date":null}\n')
  })

  // A stale date must never be embedded: a file that cannot be written fails the build.
  it('a file that cannot be written (a folder at its path): buildStart throws, so the build fails', () => {
    const c = checkout('plugin-fail')
    mkdirSync(fileIn(c.desktop))
    expect(() => run(buildDatePlugin(), c.desktop)).toThrow()
  })

  it('electron.vite.config.ts runs it in the main target, and in no other', () => {
    const named = (target: 'main' | 'preload' | 'renderer'): number =>
      (((config as unknown as Record<string, { plugins?: unknown[] }>)[target]?.plugins ?? []).flat(Infinity) as Plugin[]).filter((p) => p?.name === buildDatePlugin().name).length
    expect({ main: named('main'), preload: named('preload'), renderer: named('renderer') }).toEqual({ main: 1, preload: 0, renderer: 0 })
  })
})

// Record §5.10: a null date is named in one build log line with its condition, without a path or git's text (T6.4a
// review B m-4), so a release leg that fails later with date-not-found shows why. One fixed phrase per condition.
describe('buildDatePlugin: a build with no release date names its condition in one log line, no path, no git text (record §5.10)', () => {
  const NULL_FILE = '{"commit_date":null}\n'
  const lineFor = (condition: string): string => `hilbertraum:build-date: no release date (${condition}); this build shows no age reminder and no support notice`
  const built = (desktop: string): { file: string; lines: string[] } => {
    const lines = run(buildDatePlugin(), desktop)
    return { file: readFileSync(fileIn(desktop), 'latin1'), lines }
  }

  it('a clean checkout: the date, and no line', () => {
    expect(built(checkout('log-clean').desktop)).toEqual({ file: '{"commit_date":"2027-03-15T09:30:00Z"}\n', lines: [] })
  })

  it.each<[string, string, () => string]>([
    ['no git on PATH', 'no git', () => {
      const c = checkout('log-no-git')
      vi.stubEnv('PATH', tempRoot('build-date-empty-path'))
      return c.desktop
    }],
    ['a folder that is no checkout', 'no checkout', () => {
      const dir = tempRoot('build-date-log-no-checkout')
      mkdirSync(dirname(fileIn(dir)), { recursive: true })
      return dir
    }],
    ['the app folder deeper in another checkout', 'wrong prefix', () => checkout('log-prefix', 'vendor/hr/apps/desktop').desktop],
    ['this app at apps/desktop of another repository', 'app not in HEAD', () => foreignCheckout('log-foreign').desktop],
    // HEAD holds apps/desktop, keys.json and a file of its own there, so only the exact path tells (T6.4a re-check
    // minor 4).
    ["a repository whose HEAD holds apps/desktop\u{2019}s keys.json and a file of its own there, but not build-date-plugin.ts (present, untracked)", 'app not in HEAD', () => {
      const c = checkout('log-not-the-step')
      c.git('rm', '-q', '--cached', '--', 'apps/desktop/build-date-plugin.ts')
      writeFileSync(join(c.desktop, 'theirs.txt'), 'their own file\n')
      c.git('add', '--', 'apps/desktop/theirs.txt')
      c.git('commit', '-q', '-m', 'theirs')
      return c.desktop
    }],
    ['a repository with no commit yet', 'app not in HEAD', () => unbornCheckout('log-unborn')],
    ['a tracked change', 'tracked changes', () => {
      const c = checkout('log-dirty')
      writeFileSync(join(c.repo, 'README.md'), 'two\n')
      return c.desktop
    }],
    ['a damaged index (status fails after the checks passed)', 'git failed', () => {
      const c = checkout('log-index')
      writeFileSync(join(c.repo, '.git', 'index'), 'no index\n')
      return c.desktop
    }],
    ['a committer time after 9999-12-31T23:59:59Z', 'unreadable time', () => {
      const c = checkout('log-far')
      writeHead(c, [`author ${IDENT} 253402300800 +0000`, `committer ${IDENT} 253402300800 +0000`, '', 'far', ''])
      return c.desktop
    }],
    // The limit is 30 s per call, too long for a row: node's own error for a call past its `timeout` (code ETIMEDOUT,
    // as a real one reads: impl/p6/T6.4a/fix-1 notes) stands in for status's, and below for rev-parse's and the HEAD
    // check's (each names the time limit, not the check's own condition; T6.4a re-check minor 6).
    ['a git call past its time limit', 'git time limit', () => {
      const c = checkout('log-time')
      gitAnswers((args, real) => {
        if (args.includes('status')) throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' })
        return real()
      })
      return c.desktop
    }],
    ['rev-parse past its time limit', 'git time limit', () => failingAt('log-time-prefix', 'rev-parse', timeLimit)],
    ['the HEAD check (cat-file) past its time limit', 'git time limit', () => failingAt('log-time-head', 'cat-file', timeLimit)],
    // A failed `show` after a clean status, as git exiting non-zero reads (no code, status 128).
    ['show failing after a clean status', 'git failed', () => failingAt('log-show', 'show', () => Object.assign(new Error('Command failed: git show'), { status: 128, signal: null }))]
  ])('%s: null, and the one line names "%s"', (_label, condition, make) => {
    const desktop = make()
    expect(built(desktop)).toEqual({ file: NULL_FILE, lines: [lineFor(condition)] })
  })

  // Record §5.10: with GIT_NO_LAZY_FETCH=1 a partial clone never makes git fetch during the step. A blobless clone
  // (from a local folder: no network) with no checkout, the app's files then unpacked, untracked: HEAD names the step's
  // file, but its object is not in the clone, so the HEAD check fails instead of fetching it (T6.4a re-check minor 1).
  it.skipIf(!gitHonoursNoLazyFetch)('a blobless clone with no checkout and the app unpacked, untracked: null, the one line names "app not in HEAD", and git fetched nothing', () => {
    const source = checkout('lazy-source')
    source.git('config', 'uploadpack.allowFilter', 'true')
    source.git('config', 'uploadpack.allowAnySHA1InWant', 'true')
    const clone = tempRoot('build-date-lazy-clone')
    gitIn(clone, ['clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(source.repo).href, clone])
    const desktop = join(clone, 'apps', 'desktop')
    mkdirSync(dirname(fileIn(desktop)), { recursive: true })
    writeFileSync(join(desktop, 'build-date-plugin.ts'), '// unpacked from a source archive\n')
    writeFileSync(join(desktop, 'src', 'main', 'services', 'updates', 'keys.json'), '{ "key_set": "x" }\n')
    const packs = packsIn(clone)
    isolateGitConfig()
    expect({ ...built(desktop), packs: packsIn(clone) }).toEqual({ file: NULL_FILE, lines: [lineFor('app not in HEAD')], packs })
  })
})

// Record §5.10: generated, never committed. A committed copy would ship a stale date, and the step's own write would
// leave a tracked change behind, so the next build would have no release date. The rule is anchored: the name stays
// free elsewhere (a fixture may carry one). Git judges made-up paths by the rules alone (`--no-index`), as the W-81 row
// of repo-hygiene.test.ts does; outside a checkout there is nothing to judge.
describe('build-date.json is git-ignored, by an anchored rule (record §5.10)', () => {
  let inCheckout = false
  try {
    inCheckout = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === 'true'
  } catch {
    inCheckout = false
  }
  const ignoredAmong = (probes: string[]): string[] => {
    try {
      const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REPO_ROOT, encoding: 'utf8', input: `${probes.join('\n')}\n` })
      return out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    } catch (err) {
      if ((err as { status?: number }).status === 1) return []
      throw err
    }
  }
  it.skipIf(!inCheckout)('the file beside keys.json is ignored; keys.json and the same name anywhere else are not', () => {
    const file = 'apps/desktop/src/main/services/updates/build-date.json'
    expect(
      ignoredAmong([
        file,
        'apps/desktop/src/main/services/updates/keys.json',
        'apps/desktop/src/main/services/build-date.json',
        'apps/desktop/tests/fixtures/updates/build-date.json',
        'build-date.json'
      ])
    ).toEqual([file])
  })
})

describe('parseBuildDate: the file\u{2019}s value as the reader takes it (record §5.10, "The build date\u{2019}s reader")', () => {
  it('an own commit_date in the issued grammar: that text', () => {
    expect(parseBuildDate({ commit_date: COMMITTED_UTC })).toBe(COMMITTED_UTC)
  })

  // Missing (the glob found no file), null (a build with no release date) or malformed: silent.
  it.each<[string, unknown]>([
    ['no file (no value)', undefined],
    ['a null value', null],
    ['commit_date null (a build that has no release date)', { commit_date: null }],
    ['no commit_date', {}],
    ['commit_date a number', { commit_date: 1805103000 }],
    ['commit_date with a fraction of a second', { commit_date: '2027-03-15T09:30:00.000Z' }],
    ['commit_date with an offset', { commit_date: '2027-03-15T10:30:00+01:00' }],
    ['commit_date in 1999', { commit_date: '1999-12-31T23:59:59Z' }],
    ['commit_date on 30 February', { commit_date: '2027-02-30T09:30:00Z' }],
    ['commit_date reached through the prototype only', Object.create({ commit_date: COMMITTED_UTC }) as unknown]
  ])('%s: null', (_label, value) => {
    expect(parseBuildDate(value)).toBeNull()
  })
})
