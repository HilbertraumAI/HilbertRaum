import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import config from '../../electron.vite.config'
import { buildDateFileText, buildDatePlugin, commitDate, utcSecondText } from '../../build-date-plugin'
import { parseBuildDate } from '../../src/main/services/updates/build-date'
import { tempRoot } from '../helpers/db-fixtures'
import { REPO_ROOT } from '../helpers/repo-files'

// The build date (app-update W-17, F-12; docs/app-updates.md §5.10, "The build-date file", "The build-date step", "The
// build date's reader"): the release commit's committer date, written by the build into a git-ignored
// build-date.json beside keys.json, embedded into the main bundle through import.meta.glob, and silent (null) for a
// build that has no release date. Here: the step's date and its null cases on throw-away repositories (made below, never
// this checkout), the file's bytes, the plugin's hooks on a scratch folder, its place in the main target, the anchored
// ignore line, and the reader's reading of the file's value. No row reads this checkout's own build-date.json, which is
// absent or a developer's leftover in a test run (record §5.10); that the value reaches the bundle is the release guard's
// packed row (updates-bundle-check.test.ts, checkBundleBuildDate) and the task's build proof.

/** The test's own git: no global or system config (hooks, templates, signing, autocrlf) and no inherited repository. */
function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const base: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(emptyConfigDir(), 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete base[k]
  return execFileSync('git', ['-c', 'user.name=build-date-test', '-c', 'user.email=build-date-test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: { ...base, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

let configDir: string | null = null
function emptyConfigDir(): string {
  if (configDir === null) {
    configDir = tempRoot('build-date-gitconfig')
    writeFileSync(join(configDir, 'gitconfig'), '')
  }
  return configDir
}

/** Where the step writes the file, below apps/desktop (record §5.10: beside keys.json). */
const FILE_PARTS = ['src', 'main', 'services', 'updates', 'build-date.json'] as const

/** The committer date of every throw-away commit here, and the same instant in UTC; the author date differs on purpose. */
const COMMITTED = '2027-03-15T10:30:00+01:00'
const COMMITTED_UTC = '2027-03-15T09:30:00Z'
const AUTHORED = '2001-02-03T04:05:06+00:00'

interface Checkout {
  /** The repository's top folder. */
  readonly repo: string
  /** The app folder inside it, `<repo>/<desktopAt>`. */
  readonly desktop: string
  git(...args: string[]): string
}

/** A throw-away repository with the app folder at `desktopAt` (apps/desktop, as in this repository, by default), one
 *  tracked file in the updates folder and a README, in one commit dated COMMITTED. */
function checkout(label: string, desktopAt = 'apps/desktop'): Checkout {
  const repo = tempRoot(`build-date-${label}`)
  const desktop = desktopAt === '' ? repo : join(repo, ...desktopAt.split('/'))
  const git = (...args: string[]): string => gitIn(repo, args, { GIT_COMMITTER_DATE: COMMITTED, GIT_AUTHOR_DATE: AUTHORED })
  mkdirSync(dirname(join(desktop, ...FILE_PARTS)), { recursive: true })
  writeFileSync(join(desktop, 'src', 'main', 'services', 'updates', 'keys.json'), '{ "key_set": "x" }\n')
  writeFileSync(join(repo, 'README.md'), 'one\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'one')
  return { repo, desktop, git }
}

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('buildDatePlugin: the main target\u{2019}s buildStart writes the file (record §5.10)', () => {
  type Hook = (this: unknown, ...args: unknown[]) => unknown
  /** The plugin's two hooks as Vite calls them: the resolved root, then the build's start. */
  function run(plugin: Plugin, root: string): void {
    ;(plugin.configResolved as unknown as Hook).call(null, { root })
    ;(plugin.buildStart as unknown as Hook).call(null, {})
  }
  const fileOf = (c: Checkout): string => join(c.desktop, ...FILE_PARTS)
  const writable: string[] = []
  afterAll(() => {
    for (const f of writable) chmodSync(f, 0o644) // so the temp-root sweep can remove it
  })

  it('writes the date into src/main/services/updates/build-date.json under the resolved root', () => {
    const c = checkout('plugin')
    run(buildDatePlugin(), c.desktop)
    expect(readFileSync(fileOf(c), 'latin1')).toBe('{"commit_date":"2027-03-15T09:30:00Z"}\n')
  })

  // A watch build must not set itself off again, so the file is written only when its bytes differ. A read-only file
  // with the same bytes shows that no write was tried; the changed answer then has to be written and fails on it.
  it('writes only when the bytes differ: the same bytes are not written again, other bytes are', () => {
    const c = checkout('plugin-change')
    const plugin = buildDatePlugin()
    run(plugin, c.desktop)
    chmodSync(fileOf(c), 0o444)
    writable.push(fileOf(c))
    expect(() => run(plugin, c.desktop)).not.toThrow()
    writeFileSync(join(c.repo, 'README.md'), 'two\n') // the tree now has a tracked change: no release date
    expect(() => run(plugin, c.desktop)).toThrow()
    chmodSync(fileOf(c), 0o644)
    run(plugin, c.desktop)
    expect(readFileSync(fileOf(c), 'latin1')).toBe('{"commit_date":null}\n')
  })

  // A stale date must never be embedded: a file that cannot be written fails the build.
  it('a file that cannot be written (a folder at its path): buildStart throws, so the build fails', () => {
    const c = checkout('plugin-fail')
    mkdirSync(fileOf(c))
    expect(() => run(buildDatePlugin(), c.desktop)).toThrow()
  })

  it('electron.vite.config.ts runs it in the main target, and in no other', () => {
    const named = (target: 'main' | 'preload' | 'renderer'): number =>
      (((config as unknown as Record<string, { plugins?: unknown[] }>)[target]?.plugins ?? []).flat(Infinity) as Plugin[]).filter((p) => p?.name === buildDatePlugin().name).length
    expect({ main: named('main'), preload: named('preload'), renderer: named('renderer') }).toEqual({ main: 1, preload: 0, renderer: 0 })
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
