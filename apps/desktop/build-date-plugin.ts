import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

// App-update W-17 (F-12; docs/app-updates.md §5.10, "The build-date step"): the build writes the release commit's
// committer date into src/main/services/updates/build-date.json (git-ignored, beside keys.json), which
// src/main/services/updates/build-date.ts embeds into the main bundle. One mechanism, never a file's modification time
// (a copy to exFAT resets it), pinned by the release guard (bundle-check.ts, checkBundleBuildDate).
//
// It runs in the main target's buildStart, so for `npm run dev`, `npm run build`, `npm run package`, `package:win` and
// any direct `electron-vite build`, before the main bundle reads the file; the typecheck and the tests need no file and
// get no step. The date is `git show -s --format=%ct HEAD` (Unix seconds) written as UTC to the second. A build has no
// release date, and the file says `null`, when git is missing or fails, when apps/desktop is not the folder
// `apps/desktop/` of a checkout of its own (a source archive unpacked inside another repository's checkout would take
// that repository's date), when the seconds are no decimal number, or when the tree has tracked changes (a developer's
// build, a scratch copy whose keys.json the walk changed). Git is run by its arguments, without a shell, with a time
// limit, and without the variables a calling git (a hook) may leave that name another repository, work tree or index.
// The file is written only when its bytes differ (a watch build does not set itself off again); a file that cannot be
// written fails the build, so a stale date is never embedded.

/** The file, below apps/desktop. */
const BUILD_DATE_FILE = ['src', 'main', 'services', 'updates', 'build-date.json'] as const

/** What `git rev-parse --show-prefix` prints in apps/desktop of a checkout of this repository. */
const DESKTOP_PREFIX = 'apps/desktop/'

/** Each git call's limit. A call that takes longer gives no release date (and the release guard then stops). */
const GIT_TIMEOUT_MS = 30_000

/**
 * The variables that make git answer about another repository, work tree, index or object store, or stop its search
 * for the checkout: git's own list of the ones it clears before it runs in another repository (environment.c,
 * `local_repo_env`), the two that steer discovery, and the namespace; the walk's list (scripts/release/walk-build.mjs,
 * T6.11 F2). Dropped in any letter case (Git for Windows reads `git_dir` as GIT_DIR).
 */
const GIT_ENV_DROPPED: ReadonlySet<string> = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE'
])

/** One git call in `desktopDir`: its standard output, or null when git is missing, fails or runs past its limit. */
function git(desktopDir: string, args: readonly string[]): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_ENV_DROPPED.has(name.toUpperCase())))
  try {
    return execFileSync('git', ['-C', desktopDir, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true
    })
  } catch {
    return null
  }
}

/** One line of git's output without its line end. */
const line = (out: string): string => out.replace(/\r?\n$/, '')

/**
 * `%ct`'s seconds as the file's text, `YYYY-MM-DDTHH:MM:SSZ` (UTC, no fraction); null when they are no decimal number or
 * name no time that text can hold (after 9999-12-31T23:59:59Z).
 */
export function utcSecondText(seconds: string): string | null {
  if (!/^[0-9]+$/.test(seconds)) return null
  const date = new Date(Number(seconds) * 1000)
  if (Number.isNaN(date.getTime())) return null
  const iso = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})\.000Z$/.exec(date.toISOString())
  return iso === null ? null : `${iso[1]}Z`
}

/** The release date of the checkout `desktopDir` is apps/desktop of, or null for a build that has none (above). */
export function commitDate(desktopDir: string): string | null {
  const prefix = git(desktopDir, ['rev-parse', '--show-prefix'])
  if (prefix === null || line(prefix) !== DESKTOP_PREFIX) return null
  const changes = git(desktopDir, ['status', '--porcelain', '--untracked-files=no'])
  if (changes !== '') return null
  const seconds = git(desktopDir, ['show', '-s', '--format=%ct', 'HEAD'])
  return seconds === null ? null : utcSecondText(line(seconds))
}

/** The file's bytes (record §5.10): `{"commit_date":"<date>"}` or `{"commit_date":null}`, and one LF; ASCII, no space. */
export function buildDateFileText(date: string | null): string {
  return `${JSON.stringify({ commit_date: date })}\n`
}

/** Writes the file for the app folder `desktopDir` when its bytes differ; throws when it cannot be written. */
function writeBuildDateFile(desktopDir: string): void {
  const file = join(desktopDir, ...BUILD_DATE_FILE)
  const bytes = Buffer.from(buildDateFileText(commitDate(desktopDir)), 'utf8')
  let current: Buffer | null = null
  try {
    current = readFileSync(file)
  } catch {
    current = null // no file yet, or none that can be read: write it
  }
  if (current === null || !current.equals(bytes)) writeFileSync(file, bytes)
}

/** The step, for electron.vite.config.ts's main target: it writes the file for the target's root (apps/desktop). */
export function buildDatePlugin(): Plugin {
  let root: string | null = null
  return {
    name: 'hilbertraum:build-date',
    configResolved(config) {
      root = config.root
    },
    buildStart() {
      if (root === null) throw new Error('hilbertraum:build-date: the build started before its config was resolved')
      writeBuildDateFile(root)
    }
  }
}
