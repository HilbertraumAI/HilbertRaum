#!/usr/bin/env node
// The update walk's builds (app-update plan W-35, G-4 (d); docs/app-updates.md §2.7 "No test entrance in the product"
// and "keys.json and the embedded key set", §10.4): the scratch-copy half (T6.11; T7.7a adds the builds). A test that
// needs the app to trust a test-signed update builds or runs a throw-away copy of the source whose keys.json holds a
// per-run test PUBLIC key, so the product has no test entrance and no real checkout ever trusts a test key.
//
//   node scripts/release/walk-build.mjs make --rev <revision> --root <scratch root> --key <public key> [--key ...]
//                                           [--name <folder>] [--repo <checkout>]
//   node scripts/release/walk-build.mjs remove --dir <copy> [--repo <checkout>]
//   node scripts/release/walk-build.mjs version-arg <MAJOR.MINOR.PATCH>
//
// `make` prints the copy as one JSON line (id, dir, desktopDir, keysJson, commit, keyIds, links); `--repo` defaults to
// the checkout this script lives in. The module exports the same: `makeScratchCopy`, `removeScratchCopy` and
// `versionOverride` (the build version `<v>-e2e` and its electron-builder argument, `-c.extraMetadata.version=<v>-e2e`).
// The command line runs when node's program is this file, compared as real paths (node reaches a script through a
// link by its real path, and on macOS every path under /tmp and /var is one); a program node names as its entry that
// the comparison does not match exits 1 with one line, never 0 with nothing done.
//
// The copy: `git worktree add --detach <root>/<name> <commit>`, so no branch is made and none tracks anything. It is
// marked at once with its id (32 hex, random): the line `walk-build copy <id>` in `.walk-build-copy` at the copy's top
// and in `walk-build-copy` in its private git folder (`<common git folder>/worktrees/<entry>/`, which git deletes with
// the entry). Neither is a file the repository tracks: a revision whose top folder tracks that name (any letter case) is
// refused, and the private one is in git's own folder. For the source's HEAD commit the copy's node_modules (the root
// one, and apps/desktop's when the source has one) are links (junctions on Windows) to the source's, refused when the
// source's package-lock.json is not HEAD's (a junction would then build with other packages); a copy of any other
// commit gets none (a tag's copy runs its own `npm ci`, §10.4). keys.json is then rewritten to hold exactly the given
// keys in the record's form (`key_set` = the marker, a colon, the keys joined by `,`; two-space indent, LF line ends, an
// LF at the end) and read back through the file readers' function (`readKeysFile`, updates/bundle-check.ts, with the
// one parser behind it), loaded from this checkout through Node's own type stripping. The key-set marker is taken from
// the revision's own keys.json, never spelled here.
//
// It takes public keys only (plan C8, C15): base64 text of an Ed25519 key's SPKI bytes, 1 to 16 of them, each one key
// that the one parser reads; it never makes, reads or writes a private key (one handed in does not read as a public key
// and is refused). It refuses, each with one fixed line and before anything is written: a source that is no checkout's
// top; a copy name that is no plain folder name; a scratch root that is no existing folder, is not inside the OS temp
// folder, or is inside any checkout, worktree or git folder; a copy folder that exists; a revision that names no
// commit; a revision that tracks the copy marker's name, or whose keys.json is no regular file in its tree (a link, or a
// file under a linked folder) or does not read; keys that do not read as a set; at HEAD, a source without node_modules
// or with another lockfile. After the checkout it refuses a keys.json path that holds a link (git makes none from a tree
// whose keys.json is a regular file; a second check, no test reaches it) and removes the copy again on any failure.
//
// The removal (`remove()`, `removeScratchCopy`, `remove`) acts only on a copy the walk made, strictly inside the OS
// temp folder, and never on the given path when it is itself a link. A copy git still keeps (it lists it, or a private
// folder of the source names it) must be listed, detached and carry the private marker (another worktree, the main one
// included, has none: refused before anything is removed). A folder git keeps no more (its entry dropped while the
// folder was away) must carry the marker at its top and a .git that is a regular file, not a link, whose `gitdir:`
// names a folder in this source's `<common git folder>/worktrees/` that no longer exists, compared as real paths
// (letter case folded on Windows); anything else is refused before anything is removed: a plain folder, a checkout (its
// .git is a folder), a copy of another repository (it names another git folder), a folder holding a kept copy's .git
// (the folder it names exists), and a folder whose .git is gone (a git removal stopped part way; delete it by hand once
// nothing uses it). It checks every link in the copy before it removes one (all or nothing): its own package links,
// and any other link whose target is inside the copy or gone (npm's workspace links in a tag's copy); a link to anything
// outside the copy that the walk did not make is refused, and nothing is removed. Then each link goes by its own name
// (`rmdir` of the link itself on Windows, which takes a junction and never its target, `unlink` elsewhere; no shell, so
// no name is ever expanded), and the rest of the folder by a walk that lstats every entry and never follows a link (it
// stops at one), the copy's .git file and its marker last, so a removal stopped part way (a process that still uses a
// folder of the copy) keeps the entry and both markers and a second `remove` finishes it. Only then
// `git worktree remove --force` drops the copy's own entry (git drops an entry whose folder is gone, as for a copy
// deleted by hand); never `git worktree prune`, which would drop other sessions' stale entries. Afterwards the folder
// must be gone and the worktree list must be the list before it without the copy.
//
// Every git call runs without the variables that point git at another repository, index or object store, or change
// how it finds one (`GIT_ENV_DROPPED`: git's own list of the variables local to a repository, which git clears itself
// before it runs in another one, the two that steer discovery, GIT_CEILING_DIRECTORIES and
// GIT_DISCOVERY_ACROSS_FILESYSTEM, and GIT_NAMESPACE; any letter case on Windows), with its messages in English.
//
// What it does not check: what the build or a later step does with the copy; that the revision's tree is the code a
// release was made from (T7.7a checks a tag's lockfile); a scratch root that the OS temp folder's own setting points
// somewhere unusual (the temp folder is what the OS reports); that nothing uses the copy while it is removed (end every
// process of the copy first: a removal it stops is finished by the next one).
//
// Exit codes: 0 done · 1 refused or failed (one line) · 2 usage.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsSiblingImports } from '../lib/ts-sibling-imports.mjs'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPDATES = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'services', 'updates')
/** keys.json's path in a tree, '/'-separated (§2.7, "Path"). */
export const KEYS_JSON = 'apps/desktop/src/main/services/updates/keys.json'
/** The package folders a copy of HEAD links to the source's, '/'-separated. */
export const LINKED_PACKAGES = ['node_modules', 'apps/desktop/node_modules']
/** The marker at the copy's top, and the one in its private git folder (see the header). */
export const COPY_MARKER = '.walk-build-copy'
export const PRIVATE_MARKER = 'walk-build-copy'
/** A marker's one line. */
const markerText = (id) => `walk-build copy ${id}\n`
const MARKER_LINE = /^walk-build copy ([0-9a-f]{32})\n$/
/** What every git call runs without: git's `local_repo_env` (environment.c; git clears these itself before it runs in
 *  another repository), the two variables that steer its discovery, and GIT_NAMESPACE (which refs it sees). */
export const GIT_ENV_DROPPED = [
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
]
const IS_WINDOWS = process.platform === 'win32'
const USAGE = `walk-build: usage: node scripts/release/walk-build.mjs make --rev <revision> --root <scratch root> --key <public key> [--key ...] [--name <folder>] [--repo <checkout>]
       node scripts/release/walk-build.mjs remove --dir <copy> [--repo <checkout>]
       node scripts/release/walk-build.mjs version-arg <MAJOR.MINOR.PATCH>`

/** A refusal or failure: its message is the one line. */
export class WalkBuildError extends Error {}
function refuse(message) {
  throw new WalkBuildError(`walk-build: ${message}`)
}

const KEYS_COUNT = 'publicKeys must be 1 to 16 public keys'
const keysFault = (fault) => `the public keys do not read as a key set (${fault})`
const NOT_CHECKOUT = 'the repository is not the top of a git checkout'
const BAD_NAME = 'the copy name is not a plain folder name'
const ROOT_NOT_FOLDER = 'the scratch root is not an existing folder'
const ROOT_NOT_TEMP = 'the scratch root is not inside the temp folder'
const ROOT_IN_CHECKOUT = 'the scratch root is inside a checkout or worktree'
const ROOT_UNKNOWN = 'git could not tell whether the scratch root is inside a checkout'
const TARGET_EXISTS = 'the copy folder already exists'
const NOT_A_COMMIT = 'the revision does not name a commit'
const MARKER_TRACKED = "the revision tracks a file at the copy marker's path"
const KEYS_NOT_REGULAR = "the revision's keys.json is not a regular file"
const NO_PACKAGES = 'the source has no node_modules to link'
const OTHER_LOCKFILE = "the source's package-lock.json differs from the revision's"
const KEYS_PATH_LINK = "the copy's keys.json path holds a link"
const NOT_READ_BACK = "the copy's keys.json did not read back as written"
const NO_PRIVATE_FOLDER = "git's private folder of the copy was not found"
const NOT_A_COPY = 'the folder is not a detached worktree of the repository inside the temp folder'
const NO_MARKER = 'the worktree carries no walk-build copy marker; nothing removed'
const NOT_OWN_LEFTOVER = 'the folder holds no .git file that names a removed worktree of this repository; nothing removed'
const FOREIGN_LINK = 'the copy holds a link out of it that it did not make; nothing removed'
const NOT_UNLINKED = 'a link could not be removed by its name'
const LINK_IN_WALK = 'a link appeared in the copy while it was removed'
const notCleared = (code) => `the copy could not be removed completely (${code}); end every process that uses it, then run remove again`
const LEFT_BEHIND = 'the copy folder is still there after the removal'
const LIST_CHANGED = 'the worktree list after the removal is not the list before it'
const BAD_VERSION = 'the version is not MAJOR.MINOR.PATCH'

// ---- git, paths

/** git's environment: the caller's without `GIT_ENV_DROPPED` (by name in any letter case on Windows, where the
 *  environment ignores case), and git's messages in English (one refusal reads git's "not a git repository"). */
function gitEnv() {
  const env = { ...process.env, LC_ALL: 'C' }
  for (const name of Object.keys(env)) {
    if (GIT_ENV_DROPPED.includes(IS_WINDOWS ? name.toUpperCase() : name)) delete env[name]
  }
  return env
}

/** One git call in `cwd`: its status, stdout (text, or bytes when `bytes`) and stderr. Throws only when git cannot start. */
function git(cwd, args, bytes = false) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: gitEnv(), encoding: bytes ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (r.error) refuse(`git could not be started (${r.error.code ?? 'error'})`)
  return { status: r.status, stdout: r.stdout, stderr: bytes ? r.stderr.toString('utf8') : r.stderr }
}

/** A path as compared: absolute, the platform's separators, letter case folded on Windows. */
const comparable = (path) => (IS_WINDOWS ? resolve(path).toLowerCase() : resolve(path))

/** Whether `child` is inside `parent` (both real paths); `orSame` also accepts the folder itself. */
function inside(parent, child, orSame = false) {
  const rel = relative(parent, child)
  if (rel === '') return orSame
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

/** The OS temp folder, as the file system spells it. */
const realTemp = () => realpathSync.native(tmpdir())

/** lstat, or null when nothing is there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

/** `path` as compared when it may be gone: its longest existing head as the real path (links followed), the rest as
 *  spelled. */
function realAsFarAsItExists(path) {
  const rest = []
  for (let head = resolve(path); ; head = dirname(head)) {
    try {
      return join(realpathSync.native(head), ...rest)
    } catch {
      if (dirname(head) === head) return resolve(path)
      rest.unshift(basename(head))
    }
  }
}

/** The real path of an existing folder (links followed), or null. */
function realFolder(path) {
  try {
    const real = realpathSync.native(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** `repo` as the real path of a checkout's top folder. */
function checkoutTop(repo) {
  const real = typeof repo === 'string' && isAbsolute(repo) ? realFolder(repo) : null
  if (real === null) refuse(NOT_CHECKOUT)
  const top = git(real, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0 || comparable(top.stdout.trim()) !== comparable(real)) refuse(NOT_CHECKOUT)
  return real
}

/** `git worktree list --porcelain` as its blocks, each `{ path, lines }`. */
function worktrees(repo) {
  const list = git(repo, ['worktree', 'list', '--porcelain'])
  if (list.status !== 0) refuse(`git could not list the worktrees (exit ${list.status})`)
  return list.stdout
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((block) => block.split('\n').filter((line) => line !== ''))
    .filter((lines) => lines.length > 0 && lines[0].startsWith('worktree '))
    .map((lines) => ({ path: lines[0].slice('worktree '.length), lines }))
}

/** The source's common git folder (the main worktree's `.git`), as an absolute path. */
function commonGitDir(source) {
  const common = git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common.status !== 0) refuse(`git could not name the repository's git folder (exit ${common.status})`)
  return common.stdout.trim()
}

/** The folder git keeps for the worktree at `path`: `<common git folder>/worktrees/<entry>`, whose `gitdir` file names
 *  `<path>/.git` (gitrepository-layout; absolute, or relative to that folder). Read from git's layout, so it is found
 *  when the worktree's own folder is gone too; null when there is none (the main worktree has none). */
function privateFolderOf(source, path) {
  const entries = join(commonGitDir(source), 'worktrees')
  let names = []
  try {
    names = readdirSync(entries)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  for (const name of names) {
    const folder = join(entries, name)
    let named
    try {
      named = readFileSync(join(folder, 'gitdir'), 'utf8').trim()
    } catch {
      continue // not an entry git can read either
    }
    if (named !== '' && comparable(dirname(resolve(folder, named))) === comparable(path)) return folder
  }
  return null
}

/** The folder that the `.git` file at the top of `dir` names (`gitdir: <path>`, absolute or relative to `dir`, as git
 *  reads it), or null when that `.git` is no regular file (missing, a folder, a link) or holds no such line. */
function gitdirNamed(dir) {
  const file = join(dir, '.git')
  if (!lstatOrNull(file)?.isFile()) return null
  const line = /^gitdir: ([^\0\r\n]+)[\r\n]*$/.exec(readFileSync(file, 'utf8'))
  return line === null ? null : resolve(dir, line[1])
}

/** The id in the marker file `file` (a regular file, not a link, holding the marker's one line), or null. */
function markerId(file) {
  const found = lstatOrNull(file)
  if (found === null || !found.isFile()) return null
  return MARKER_LINE.exec(readFileSync(file, 'utf8'))?.[1] ?? null
}

// ---- the key reader (this checkout's own, through Node's type stripping)

let readers = null
/** `readKeysFile` (bundle-check.ts) and the key cap (envelope.ts), loaded once. */
function keyReaders() {
  readers ??= (async () => {
    if (!process.features?.typescript) refuse(`this Node (${process.version}) has no type stripping, so it cannot load the key reader`)
    registerTsSiblingImports()
    const [check, envelope] = await Promise.all([
      import(pathToFileURL(join(UPDATES, 'bundle-check.ts')).href),
      import(pathToFileURL(join(UPDATES, 'envelope.ts')).href)
    ])
    return { readKeysFile: check.readKeysFile, maxKeys: envelope.KEY_SET_MAX_KEYS }
  })()
  return readers
}

// ---- the copy

/** The checks of the scratch root (see the header); its real path. */
function scratchRoot(root) {
  const real = typeof root === 'string' && isAbsolute(root) ? realFolder(root) : null
  if (real === null) refuse(ROOT_NOT_FOLDER)
  if (!inside(realTemp(), real, true)) refuse(ROOT_NOT_TEMP)
  const where = git(real, ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'])
  if (where.status === 0) {
    if (where.stdout.split(/\r?\n/).some((line) => line.trim() === 'true')) refuse(ROOT_IN_CHECKOUT)
  } else if (!/not a git repository/i.test(where.stderr)) refuse(ROOT_UNKNOWN)
  return real
}

/** The revision as a commit id. */
function commitOf(source, rev) {
  if (typeof rev !== 'string' || rev === '' || /[\0\r\n]/.test(rev)) refuse(NOT_A_COMMIT)
  const found = git(source, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])
  const commit = found.status === 0 ? found.stdout.trim() : ''
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) refuse(NOT_A_COMMIT)
  return commit
}

/** The bytes of keys.json in the commit's tree: its entry must be a regular file (mode 100644 or 100755). */
function committedKeysJson(source, commit) {
  const listed = git(source, ['ls-tree', '-z', commit, '--', KEYS_JSON])
  const entries = listed.status === 0 ? listed.stdout.split('\0').filter((e) => e !== '') : []
  const entry = entries.length === 1 ? /^(100644|100755) blob ([0-9a-f]+)\t(.*)$/s.exec(entries[0]) : null
  if (entry === null || entry[3] !== KEYS_JSON) refuse(KEYS_NOT_REGULAR)
  const blob = git(source, ['cat-file', 'blob', entry[2]], true)
  if (blob.status !== 0) refuse(KEYS_NOT_REGULAR)
  return blob.stdout
}

/** Whether the commit's top folder tracks an entry named like the copy marker, letter case ignored (a folder that
 *  ignores case would hand the tracked file to the marker's name). */
function tracksMarker(source, commit) {
  const listed = git(source, ['ls-tree', '-z', '--name-only', commit])
  if (listed.status !== 0) refuse(`git could not list the revision's tree (exit ${listed.status})`)
  return listed.stdout.split('\0').some((entry) => entry.toLowerCase() === COPY_MARKER)
}

/** Whether the source's package-lock.json is the commit's (as `git add` would store it), both absent included. */
function sameLockfile(source, commit) {
  const committed = git(source, ['rev-parse', '--verify', '--quiet', `${commit}:package-lock.json`])
  const onDisk = lstatOrNull(join(source, 'package-lock.json')) !== null
  if (committed.status !== 0 || !onDisk) return committed.status !== 0 && !onDisk
  const hashed = git(source, ['hash-object', '--', 'package-lock.json'])
  return hashed.status === 0 && hashed.stdout.trim() === committed.stdout.trim()
}

/** No link on the path from the copy down to its keys.json, and keys.json a file. */
function assertNoLinkOnPath(dir, rel) {
  let path = dir
  for (const part of rel.split('/')) {
    path = join(path, part)
    if (lstatSync(path).isSymbolicLink()) refuse(KEYS_PATH_LINK)
  }
  if (!lstatSync(path).isFile()) refuse(KEYS_PATH_LINK)
}

/**
 * A scratch copy of `repo` at `rev` in `<root>/<name>` (name `walk-<12 hex of the commit>` by default) whose keys.json
 * holds exactly `publicKeys` (see the header). Resolves to its id (the markers' text), its paths, the commit, the keys'
 * ids (lower-case hex SHA-256 of their SPKI bytes), its links ({ path, target }) and `remove()`.
 */
export async function makeScratchCopy({ repo, rev, root, publicKeys, name } = {}) {
  const { readKeysFile, maxKeys } = await keyReaders()
  if (!Array.isArray(publicKeys) || publicKeys.length < 1 || publicKeys.length > maxKeys) refuse(KEYS_COUNT)
  if (publicKeys.some((key) => typeof key !== 'string')) refuse(keysFault('not-a-string'))
  const source = checkoutTop(repo)
  // A plain folder name; not ending in `.`, which Windows drops from a folder name.
  if (name !== undefined && (typeof name !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/.test(name))) refuse(BAD_NAME)
  const realRoot = scratchRoot(root)
  const commit = commitOf(source, rev)
  const dir = join(realRoot, name ?? `walk-${commit.slice(0, 12)}`)
  if (lstatOrNull(dir) !== null) refuse(TARGET_EXISTS)
  if (tracksMarker(source, commit)) refuse(MARKER_TRACKED)

  const committed = readKeysFile(committedKeysJson(source, commit))
  if (!committed.valid) refuse(`the revision's keys.json does not read (${committed.fault})`)
  const value = `${committed.value.slice(0, committed.value.indexOf(':'))}:${publicKeys.join(',')}`
  const text = `${JSON.stringify({ key_set: value }, null, 2)}\n`
  const planned = readKeysFile(Buffer.from(text, 'utf8'))
  if (!planned.valid) refuse(keysFault(planned.fault))
  if (planned.keys.length !== publicKeys.length) refuse(keysFault('not-one-key'))
  const keyIds = planned.keys.map((key) => key.id)

  const head = git(source, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const packages = []
  if (head.status === 0 && head.stdout.trim() === commit) {
    if (realFolder(join(source, 'node_modules')) === null) refuse(NO_PACKAGES)
    if (!sameLockfile(source, commit)) refuse(OTHER_LOCKFILE)
    for (const rel of LINKED_PACKAGES) {
      const target = realFolder(join(source, ...rel.split('/')))
      if (target !== null) packages.push({ path: join(dir, ...rel.split('/')), target })
    }
  }

  // Everything below writes, inside the copy only.
  const added = git(source, ['worktree', 'add', '--detach', dir, commit])
  if (added.status !== 0) refuse(`git could not add the worktree (exit ${added.status})`)
  const id = randomBytes(16).toString('hex')
  try {
    // The marks first: the removal (below on any failure, or a later one) acts only on a copy that carries them.
    const ownFolder = privateFolderOf(source, dir)
    if (ownFolder === null) refuse(NO_PRIVATE_FOLDER)
    writeFileSync(join(ownFolder, PRIVATE_MARKER), markerText(id), { flag: 'wx' })
    writeFileSync(join(dir, COPY_MARKER), markerText(id), { flag: 'wx' })
    const links = []
    for (const link of packages) {
      symlinkSync(link.target, link.path, 'junction')
      links.push(link)
    }
    const keysJson = join(dir, ...KEYS_JSON.split('/'))
    assertNoLinkOnPath(dir, KEYS_JSON)
    writeFileSync(keysJson, text)
    const back = readKeysFile(readFileSync(keysJson))
    if (!back.valid || back.value !== value || back.keys.map((key) => key.id).join() !== keyIds.join()) refuse(NOT_READ_BACK)
    return { id, dir, desktopDir: join(dir, 'apps', 'desktop'), keysJson, commit, keyIds, links, remove: () => removeScratchCopy({ repo: source, dir }) }
  } catch (err) {
    try {
      removeScratchCopy({ repo: source, dir })
    } catch (cleanup) {
      throw new WalkBuildError(`${err?.message ?? err}; and the copy could not be removed: ${cleanup?.message ?? cleanup}`)
    }
    throw err
  }
}

// ---- the removal

/** Every link under `dir`, links never followed; sorted, so a removal always meets them in one order. */
function linksUnder(dir) {
  const found = []
  const folders = [dir]
  while (folders.length > 0) {
    const folder = folders.pop()
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isSymbolicLink()) found.push(path)
      else if (entry.isDirectory()) folders.push(path)
    }
  }
  return found.sort()
}

/** A link removed by its own name, with no shell: `rmdir` of the link itself on Windows (a junction or a folder link;
 *  the target is never entered), `unlink` for a file link and elsewhere. */
function unlinkByName(link) {
  try {
    if (IS_WINDOWS) {
      try {
        rmdirSync(link)
      } catch (err) {
        if (!lstatOrNull(link)?.isSymbolicLink()) throw err
        unlinkSync(link) // a file link
      }
    } else unlinkSync(link)
  } catch (err) {
    refuse(`${NOT_UNLINKED} (${err?.code ?? 'error'})`)
  }
  if (lstatOrNull(link) !== null) refuse(NOT_UNLINKED)
}

/** `path` and all it holds, each entry lstat'ed: a file unlinked, a folder emptied and removed; a link is never
 *  followed (the walk stops at one: every link went by its name before). */
function removeTree(path) {
  const found = lstatSync(path)
  if (found.isSymbolicLink()) refuse(LINK_IN_WALK)
  if (!found.isDirectory()) return unlinkSync(path)
  for (const name of readdirSync(path).sort()) removeTree(join(path, name))
  rmdirSync(path)
}

/** The copy's folder removed by the walk: its .git file and its marker last, then the folder itself. */
function clearCopy(path) {
  const last = ['.git', COPY_MARKER]
  try {
    for (const name of readdirSync(path).sort()) if (!last.includes(name)) removeTree(join(path, name))
    for (const name of last) if (lstatOrNull(join(path, name)) !== null) removeTree(join(path, name))
    rmdirSync(path)
  } catch (err) {
    if (err instanceof WalkBuildError) throw err
    refuse(notCleared(err?.code ?? 'error'))
  }
}

/** Remove a scratch copy (see the header): only one the walk made, strictly inside the OS temp folder. */
export function removeScratchCopy({ repo, dir } = {}) {
  const source = checkoutTop(repo)
  // The copy's path as git and the file system spell it, its folder present or gone; never a link itself.
  const given = typeof dir === 'string' && isAbsolute(dir) ? lstatOrNull(dir) : undefined
  const parent = given === undefined || given?.isSymbolicLink() ? null : realFolder(dirname(dir))
  const path = parent === null ? null : given === null ? join(parent, basename(dir)) : realFolder(dir)
  if (path === null || !inside(realTemp(), path)) refuse(NOT_A_COPY)
  const present = given !== null
  const listed = worktrees(source)
  const mine = listed.find((w) => comparable(realFolder(w.path) ?? w.path) === comparable(path))
  // Its origin, before anything is removed: a copy git still keeps (listed, or a private folder of the source naming
  // it) by the marker in its private git folder; a folder git keeps no more by the marker at its top and a .git file
  // that names a folder of the source's worktrees/ that is gone (a plain folder, a checkout, a copy of another
  // repository and a copy git keeps elsewhere fail that).
  const ownFolder = privateFolderOf(source, path)
  if (mine !== undefined || ownFolder !== null) {
    if (mine === undefined || !mine.lines.includes('detached')) refuse(NOT_A_COPY)
    if (ownFolder === null || markerId(join(ownFolder, PRIVATE_MARKER)) === null) refuse(NO_MARKER)
  } else {
    if (!present || markerId(join(path, COPY_MARKER)) === null) refuse(NOT_A_COPY)
    const named = gitdirNamed(path)
    if (named === null) refuse(NOT_OWN_LEFTOVER)
    const entries = realAsFarAsItExists(join(commonGitDir(source), 'worktrees'))
    if (comparable(realAsFarAsItExists(dirname(named))) !== comparable(entries)) refuse(NOT_OWN_LEFTOVER)
    // Still there: git keeps it for another folder (were it this one's, `ownFolder` would have found it).
    if (lstatOrNull(named) !== null) refuse(NOT_OWN_LEFTOVER)
  }

  if (present) {
    // Every link checked before the first one goes (all or nothing), then each by its name, then the rest by the walk.
    const own = new Set(LINKED_PACKAGES.map((rel) => comparable(join(path, ...rel.split('/')))))
    const links = linksUnder(path)
    for (const link of links) {
      if (own.has(comparable(link))) continue
      let target = null
      try {
        target = realpathSync.native(link)
      } catch {
        target = null // a link to nothing: removing it by name is all there is
      }
      if (target !== null && !inside(path, target)) refuse(FOREIGN_LINK)
    }
    for (const link of links) unlinkByName(link)
    clearCopy(path)
  }

  const before = listed.filter((w) => w !== mine).map((w) => comparable(w.path))
  if (mine !== undefined) {
    // The copy's own entry, its folder gone: git drops just that entry (and its private folder); never a prune.
    const removed = git(source, ['worktree', 'remove', '--force', path])
    if (removed.status !== 0) refuse(`git could not remove the worktree (exit ${removed.status})`)
  }
  if (lstatOrNull(path) !== null) refuse(LEFT_BEHIND)
  const after = worktrees(source).map((w) => comparable(w.path))
  if (after.join('\n') !== before.join('\n')) refuse(LIST_CHANGED)
}

// ---- the build version (T7.7a)

/** A walk build's version and the electron-builder argument that sets it: `<v>-e2e` for a `MAJOR.MINOR.PATCH` `v`. */
export function versionOverride(version) {
  if (typeof version !== 'string' || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version)) refuse(BAD_VERSION)
  const e2e = `${version}-e2e`
  return { version: e2e, arg: `-c.extraMetadata.version=${e2e}` }
}

// ---- the command line

const FLAGS = { make: ['--rev', '--root', '--key', '--name', '--repo'], remove: ['--dir', '--repo'] }

/** `{ command, ... }`, or null for a usage error. */
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command === 'version-arg') return rest.length === 1 ? { command, version: rest[0] } : null
  if (!Object.hasOwn(FLAGS, command)) return null
  const args = { command, keys: [] }
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]]
    if (!FLAGS[command].includes(flag) || typeof value !== 'string' || value === '' || value.startsWith('--')) return null
    const key = flag.slice(2)
    if (key === 'key') args.keys.push(value)
    else if (Object.hasOwn(args, key)) return null
    else args[key] = value
  }
  if (command === 'make' && (args.rev === undefined || args.root === undefined || args.keys.length === 0)) return null
  if (command === 'remove' && args.dir === undefined) return null
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 2
  }
  try {
    const repo = resolve(args.repo ?? REPO_ROOT)
    if (args.command === 'version-arg') console.log(versionOverride(args.version).arg)
    else if (args.command === 'remove') removeScratchCopy({ repo, dir: resolve(args.dir) })
    else {
      const copy = await makeScratchCopy({ repo, rev: args.rev, root: resolve(args.root), publicKeys: args.keys, name: args.name })
      const { remove: _remove, ...paths } = copy
      console.log(JSON.stringify(paths))
    }
    return 0
  } catch (err) {
    console.error(err instanceof WalkBuildError ? err.message : `walk-build: failed (${err?.code ?? err?.name ?? 'error'})`)
    return 1
  }
}

/** Whether node's program is this file: `argv[1]` and this module compared as real paths (node runs a script reached
 *  through a link from its real path, so the spellings differ then). */
function isProgram() {
  if (!process.argv[1]) return false
  try {
    return comparable(realpathSync.native(resolve(process.argv[1]))) === comparable(realpathSync.native(fileURLToPath(import.meta.url)))
  } catch {
    return false
  }
}

if (isProgram()) process.exitCode = await main(process.argv.slice(2))
else if (import.meta.main === true) {
  // Node names this module its entry, yet the paths did not compare: never exit 0 with nothing done.
  console.error('walk-build: could not tell that it runs as the program; nothing done')
  process.exitCode = 1
}
