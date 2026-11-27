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
// `make` prints the copy as one JSON line (dir, desktopDir, keysJson, commit, keyIds, links); `--repo` defaults to the
// checkout this script lives in. The module exports the same: `makeScratchCopy`, `removeScratchCopy` and
// `versionOverride` (the build version `<v>-e2e` and its electron-builder argument, `-c.extraMetadata.version=<v>-e2e`).
//
// The copy: `git worktree add --detach <root>/<name> <commit>`, so no branch is made and none tracks anything. For the
// source's HEAD commit the copy's node_modules (the root one, and apps/desktop's when the source has one) are links
// (junctions on Windows) to the source's, refused when the source's package-lock.json is not HEAD's (a junction would
// then build with other packages); a copy of any other commit gets none (a tag's copy runs its own `npm ci`, §10.4).
// keys.json is then rewritten to hold exactly the given keys in the record's form (`key_set` = the marker, a colon, the
// keys joined by `,`; two-space indent, LF line ends, an LF at the end) and read back through the file readers'
// function (`readKeysFile`, updates/bundle-check.ts, with the one parser behind it), loaded from this checkout through
// Node's own type stripping. The marker is taken from the revision's own keys.json, never spelled here.
//
// It takes public keys only (plan C8, C15): base64 text of an Ed25519 key's SPKI bytes, 1 to 16 of them, each one key
// that the one parser reads; it never makes, reads or writes a private key (one handed in does not read as a public key
// and is refused). It refuses, each with one fixed line and before anything is written: a source that is no checkout's
// top; a copy name that is no plain folder name; a scratch root that is no existing folder, is not inside the OS temp
// folder, or is inside any checkout, worktree or git folder; a copy folder that exists; a revision that names no
// commit; a revision whose keys.json is no regular file in its tree (a link, or a file under a linked folder) or does
// not read; keys that do not read as a set; at HEAD, a source without node_modules or with another lockfile. After the
// checkout it refuses a keys.json path that holds a link (git makes none from a tree whose keys.json is a regular file;
// a second check, no test reaches it) and removes the copy again on any failure.
//
// The removal (`remove()`, `removeScratchCopy`, `remove`): only a detached worktree of the repository, strictly inside
// the OS temp folder. Every link in the copy is removed by its own name first (`cmd /c rmdir <link>` on Windows,
// `unlink` elsewhere; the target is never touched): its own package links, and any other link whose target is inside
// the copy or gone (npm's workspace links in a tag's copy). A link to anything outside the copy that the walk did not
// make is refused, and nothing is removed. Then `git worktree remove --force`, never `git worktree prune` (that would
// drop other sessions' stale entries); afterwards the folder must be gone and the worktree list must be the list before
// it without the copy. Git for Windows neither follows a junction when it removes a worktree nor removes it: it leaves
// the junction and its folder behind and reports success, so the links go first.
//
// What it does not check: what the build or a later step does with the copy; that the revision's tree is the code a
// release was made from (T7.7a checks a tag's lockfile); a scratch root that the OS temp folder's own setting points
// somewhere unusual (the temp folder is what the OS reports).
//
// Exit codes: 0 done · 1 refused or failed (one line) · 2 usage.

import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsSiblingImports } from '../lib/ts-sibling-imports.mjs'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPDATES = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'services', 'updates')
/** keys.json's path in a tree, '/'-separated (§2.7, "Path"). */
export const KEYS_JSON = 'apps/desktop/src/main/services/updates/keys.json'
/** The package folders a copy of HEAD links to the source's, '/'-separated. */
export const LINKED_PACKAGES = ['node_modules', 'apps/desktop/node_modules']
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
const KEYS_NOT_REGULAR = "the revision's keys.json is not a regular file"
const NO_PACKAGES = 'the source has no node_modules to link'
const OTHER_LOCKFILE = "the source's package-lock.json differs from the revision's"
const KEYS_PATH_LINK = "the copy's keys.json path holds a link"
const NOT_READ_BACK = "the copy's keys.json did not read back as written"
const NOT_A_COPY = 'the folder is not a detached worktree of the repository inside the temp folder'
const FOREIGN_LINK = 'the copy holds a link out of it that it did not make; nothing removed'
const NOT_UNLINKED = 'a link could not be removed by its name'
const LEFT_BEHIND = 'the copy folder is still there after the removal'
const LIST_CHANGED = 'the worktree list after the removal is not the list before it'
const BAD_VERSION = 'the version is not MAJOR.MINOR.PATCH'

// ---- git, paths

/** git's environment: the caller's, without what points git at another repository or index, and git's messages in
 *  English (one refusal reads git's "not a git repository"). */
function gitEnv() {
  const env = { ...process.env, LC_ALL: 'C' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    delete env[k]
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
 * holds exactly `publicKeys` (see the header). Resolves to its paths, the commit, the keys' ids (lower-case hex
 * SHA-256 of their SPKI bytes), its links ({ path, target }) and `remove()`.
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
  try {
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
    return { dir, desktopDir: join(dir, 'apps', 'desktop'), keysJson, commit, keyIds, links, remove: () => removeScratchCopy({ repo: source, dir }) }
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

/** Every link under `dir`, links never followed. */
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
  return found
}

/** A link removed by its own name: `rmdir` without /s (a junction or a folder link; a real folder that holds anything
 *  is refused by it), else unlink (a file link). The target is never touched. */
function unlinkByName(link) {
  if (IS_WINDOWS) {
    if (/["%]/.test(link)) refuse(NOT_UNLINKED) // no quoting that cmd keeps literal
    const removed = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"rmdir "${link}""`], {
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    if (removed.status !== 0 && lstatOrNull(link)?.isSymbolicLink()) unlinkSync(link)
  } else unlinkSync(link)
  if (lstatOrNull(link) !== null) refuse(NOT_UNLINKED)
}

/** Remove a scratch copy (see the header): only a detached worktree of `repo` strictly inside the OS temp folder. */
export function removeScratchCopy({ repo, dir } = {}) {
  const source = checkoutTop(repo)
  const real = typeof dir === 'string' && isAbsolute(dir) ? realFolder(dir) : null
  const listed = worktrees(source)
  const mine = real === null ? undefined : listed.find((w) => realFolder(w.path) !== null && comparable(realFolder(w.path)) === comparable(real))
  if (mine === undefined || !mine.lines.includes('detached') || !inside(realTemp(), real)) refuse(NOT_A_COPY)

  const own = new Set(LINKED_PACKAGES.map((rel) => comparable(join(real, ...rel.split('/')))))
  const links = linksUnder(real)
  for (const link of links) {
    if (own.has(comparable(link))) continue
    let target = null
    try {
      target = realpathSync.native(link)
    } catch {
      target = null // a link to nothing: removing it by name is all there is
    }
    if (target !== null && !inside(real, target)) refuse(FOREIGN_LINK)
  }
  for (const link of links) unlinkByName(link)

  const before = listed.filter((w) => w !== mine).map((w) => comparable(w.path))
  const removed = git(source, ['worktree', 'remove', '--force', real])
  if (removed.status !== 0) refuse(`git could not remove the worktree (exit ${removed.status})`)
  if (lstatOrNull(real) !== null) refuse(LEFT_BEHIND)
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
