import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readKeysFile } from '../../src/main/services/updates/bundle-check'
import { parseSemver } from '../../src/main/services/updates/version'
import { tempRoot } from '../helpers/db-fixtures'
import { REPO_ROOT } from '../helpers/repo-files'

// T6.11 (app-update plan G-4 (d), W-35; docs/app-updates.md §2.7 "No test entrance in the product", §10.4): the
// scratch-copy half of scripts/release/walk-build.mjs. A test-signed update is trusted only by a throw-away copy of the
// source whose keys.json holds a per-run test public key, so the product needs no test entrance and no real checkout
// ever trusts a test key. Every row runs against a git repository the test makes in a temp folder: the real
// repository's worktree list is never touched by a test. The copy is a detached worktree (no branch made), its
// node_modules are links to the source's (removed by their own name, so a removal never runs through one into the
// source's packages), and the script never runs `git worktree prune` (other sessions' stale entries survive).

interface ScratchLink {
  readonly path: string
  readonly target: string
}
interface ScratchCopy {
  readonly dir: string
  readonly desktopDir: string
  readonly keysJson: string
  readonly commit: string
  readonly keyIds: readonly string[]
  readonly links: readonly ScratchLink[]
  remove(): void
}
interface MakeOptions {
  repo: string
  rev: unknown
  root: string
  publicKeys: unknown
  name?: string
}
interface WalkBuild {
  makeScratchCopy(o: MakeOptions): Promise<ScratchCopy>
  removeScratchCopy(o: { repo: string; dir: string }): void
  versionOverride(version: unknown): { version: string; arg: string }
}

const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'walk-build.mjs')
/** The script is plain ESM without a declaration file: loaded by URL, typed above. */
const walkBuild = async (): Promise<WalkBuild> => (await import(pathToFileURL(SCRIPT).href)) as WalkBuild

const KEYS_PATH = ['apps', 'desktop', 'src', 'main', 'services', 'updates', 'keys.json']
const KEYS_REL = KEYS_PATH.join('/')
/** This checkout's committed keys.json (the production set): the sources the test makes commit its bytes. */
const COMMITTED_KEYS = readFileSync(join(REPO_ROOT, ...KEYS_PATH))
const COMMITTED_VALUE = (JSON.parse(COMMITTED_KEYS.toString('utf8')) as { key_set: string }).key_set
/** The marker with its colon, taken from the committed value (never spelled here). */
const MARKER = COMMITTED_VALUE.slice(0, COMMITTED_VALUE.indexOf(':') + 1)

/** A fresh Ed25519 public key in the record's form (base64 of the 44 SPKI bytes); the private half is never exported. */
const publicKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
/** A key's id as the record defines it: lower-case hex SHA-256 of its SPKI bytes. */
const keyId = (key: string): string => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')
/** keys.json as the record's form writes it: one field, two-space indent, LF line ends, an LF at the end. */
const keysText = (keys: readonly string[]): string => `{\n  "key_set": "${MARKER}${keys.join(',')}"\n}\n`

/** The developer's global and system git config (hooks, templates, signing) and a hook's GIT_DIR stay out. */
let emptyConfig = ''
function gitIn(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync('git', ['-c', 'user.name=walk-test', '-c', 'user.email=walk-test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: { ...env, ...options.env },
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

/** A folder of its own under the OS temp folder, in the file system's spelling. */
const scratch = (label: string): string => realpathSync.native(tempRoot(`walk-${label}`))

interface Source {
  readonly repo: string
  /** The first commit and HEAD (the second). */
  readonly first: string
  readonly head: string
  git(...args: string[]): string
}

/**
 * A source repository: keys.json (this checkout's committed bytes), a lockfile, a .gitignore for node_modules/ and a
 * README, in two commits; then the packages a checkout has: node_modules/ at the root and under apps/desktop (`both`),
 * only at the root (`root`) or none. Each node_modules folder holds a sentinel file.
 */
function makeSource(label: string, packages: 'both' | 'root' | 'none' = 'both'): Source {
  const repo = scratch(label)
  const git = (...args: string[]): string => gitIn(repo, args)
  const write = (rel: string, data: string | Buffer): void => {
    const file = join(repo, ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  write(KEYS_REL, COMMITTED_KEYS)
  write('package-lock.json', '{ "lockfileVersion": 3 }\n')
  write('.gitignore', 'node_modules/\n')
  write('README.md', 'one\n')
  git('init', '-q', '--initial-branch=main')
  git('add', '--', KEYS_REL, 'package-lock.json', '.gitignore', 'README.md')
  git('commit', '-q', '-m', 'one')
  const first = git('rev-parse', 'HEAD').trim()
  write('README.md', 'two\n')
  git('add', '--', 'README.md')
  git('commit', '-q', '-m', 'two')
  const head = git('rev-parse', 'HEAD').trim()
  if (packages !== 'none') write('node_modules/sentinel.txt', 'root packages\n')
  if (packages === 'both') write('apps/desktop/node_modules/sentinel.txt', 'desktop packages\n')
  return { repo, first, head, git }
}

/** A commit on top of HEAD (on no branch), its tree changed by `change` through an index file of its own. */
function variantCommit(src: Source, change: (index: (args: string[], input?: string) => string) => void): string {
  const env = { GIT_INDEX_FILE: join(scratch('index'), 'index') }
  const index = (args: string[], input?: string): string => gitIn(src.repo, args, { env, input })
  index(['read-tree', src.head])
  change(index)
  const tree = index(['write-tree']).trim()
  return index(['commit-tree', tree, '-p', src.head, '-m', 'variant']).trim()
}

/** A symlink entry (mode 120000) at `path` in the variant's index; the link text names a file outside the copy. */
const linkEntry = (index: (args: string[], input?: string) => string, path: string): void => {
  const blob = index(['hash-object', '-w', '--stdin'], '../../../../../../../outside.json').trim()
  index(['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`])
}

/** A scratch root as found: its entries when a folder, its text when a file. */
const rootState = (root: string): unknown => (statSync(root).isDirectory() ? readdirSync(root).sort() : readFileSync(root, 'utf8'))

/** What a refused call must leave as it was: the source's worktrees, refs, status and keys.json, and the root. */
function snapshot(src: Source, root: string): Record<string, unknown> {
  return {
    worktrees: src.git('worktree', 'list', '--porcelain'),
    refs: src.git('for-each-ref'),
    status: src.git('status', '--porcelain', '--ignored'),
    keys: readFileSync(join(src.repo, ...KEYS_PATH), 'utf8'),
    root: rootState(root)
  }
}

/** The block of `git worktree list --porcelain` for `dir`, or undefined. */
function worktreeBlock(src: Source, dir: string): string | undefined {
  const norm = (p: string): string => p.split('\\').join('/').toLowerCase()
  return src
    .git('worktree', 'list', '--porcelain')
    .split(/\n\n/)
    .find((block) => norm(block.split('\n')[0] ?? '') === `worktree ${norm(dir)}`)
}

/** A link removed by its own name (never a recursive removal): a junction on Windows, a symlink elsewhere. */
const unlinkByName = (link: string): void => (process.platform === 'win32' ? rmdirSync(link) : unlinkSync(link))

/** os.tmpdir() answers `dir` while `run` runs (TMPDIR on POSIX, TEMP and TMP on Windows), restored after. */
async function withTempFolder<T>(dir: string, run: () => T | Promise<T>): Promise<T> {
  const names = ['TMPDIR', 'TMP', 'TEMP'] as const
  const saved = names.map((n) => process.env[n])
  for (const n of names) process.env[n] = dir
  try {
    expect(realpathSync.native(tmpdir())).toBe(dir)
    return await run()
  } finally {
    names.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n]
      else process.env[n] = saved[i]
    })
  }
}

beforeAll(() => {
  emptyConfig = join(scratch('config'), 'empty.gitconfig')
  writeFileSync(emptyConfig, '')
})

describe('makeScratchCopy at HEAD: a detached worktree, linked packages and a per-run key set (T6.11)', () => {
  it('makes the copy at HEAD, detached and on no branch, with node_modules linked to the source and keys.json holding exactly the given keys', async () => {
    const src = makeSource('head')
    const root = scratch('head-root')
    const keys = [publicKey(), publicKey()]
    const branches = src.git('for-each-ref', 'refs/heads')
    const sourceStatus = src.git('status', '--porcelain', '--ignored')
    const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: 'HEAD', root, publicKeys: keys })
    try {
      expect(dirname(copy.dir)).toBe(root)
      expect(copy.desktopDir).toBe(join(copy.dir, 'apps', 'desktop'))
      expect(copy.keysJson).toBe(join(copy.dir, ...KEYS_PATH))
      // At the revision, detached: HEAD is the commit and no symbolic ref; no branch was made.
      expect(copy.commit).toBe(src.head)
      expect(gitIn(copy.dir, ['rev-parse', 'HEAD']).trim()).toBe(src.head)
      expect(spawnSync('git', ['-C', copy.dir, 'symbolic-ref', '-q', 'HEAD']).status).toBe(1)
      expect(worktreeBlock(src, copy.dir)?.split('\n')).toContain('detached')
      expect(src.git('for-each-ref', 'refs/heads')).toBe(branches)
      // The packages: links, resolving to the source's folders (a file inside reads through them).
      for (const rel of ['node_modules', 'apps/desktop/node_modules']) {
        const link = join(copy.dir, ...rel.split('/'))
        expect(lstatSync(link).isSymbolicLink(), rel).toBe(true)
        expect(realpathSync.native(link)).toBe(realpathSync.native(join(src.repo, ...rel.split('/'))))
        expect(readFileSync(join(link, 'sentinel.txt'), 'utf8')).toBe(readFileSync(join(src.repo, ...rel.split('/'), 'sentinel.txt'), 'utf8'))
      }
      expect(copy.links.map((l) => l.path)).toEqual([join(copy.dir, 'node_modules'), join(copy.dir, 'apps', 'desktop', 'node_modules')])
      // keys.json: exactly the given keys in the record's form, and it reads through the file readers' function.
      expect(readFileSync(copy.keysJson, 'utf8')).toBe(keysText(keys))
      const read = readKeysFile(readFileSync(copy.keysJson))
      expect(read.valid && read.keys.map((k) => k.id)).toEqual(keys.map(keyId))
      expect(copy.keyIds).toEqual(keys.map(keyId))
      // The source is as it was: its keys.json and its status (no file of it written).
      expect(readFileSync(join(src.repo, ...KEYS_PATH))).toEqual(COMMITTED_KEYS)
      expect(src.git('status', '--porcelain', '--ignored')).toBe(sourceStatus)
    } finally {
      copy.remove()
    }
  })

  it("remove() unlinks the links by name (their targets intact), removes the worktree, and leaves the worktree list as it was, another stale entry included", async () => {
    const src = makeSource('remove')
    // Another session's stale entry: a worktree whose folder is gone. `git worktree prune` would drop it.
    const stale = join(scratch('stale'), 'w')
    src.git('worktree', 'add', '-q', '--detach', stale, src.first)
    rmSync(stale, { recursive: true, force: true })
    const before = src.git('worktree', 'list', '--porcelain')
    expect(before).toMatch(/\nprunable\b/)
    const refs = src.git('for-each-ref')
    const root = scratch('remove-root')
    const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: 'HEAD', root, publicKeys: [publicKey()] })
    expect(worktreeBlock(src, copy.dir)).toBeDefined()
    copy.remove()
    for (const link of copy.links) expect(existsSync(link.path), link.path).toBe(false)
    expect(readFileSync(join(src.repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('root packages\n')
    expect(readFileSync(join(src.repo, 'apps', 'desktop', 'node_modules', 'sentinel.txt'), 'utf8')).toBe('desktop packages\n')
    expect(readdirSync(join(src.repo, 'node_modules'))).toEqual(['sentinel.txt'])
    expect(existsSync(copy.dir)).toBe(false)
    expect(readdirSync(root)).toEqual([])
    expect(src.git('worktree', 'list', '--porcelain')).toBe(before)
    expect(src.git('for-each-ref')).toBe(refs)
  })

  it('links only the root node_modules when the source has no apps/desktop/node_modules', async () => {
    const src = makeSource('root-only', 'root')
    const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: 'HEAD', root: scratch('root-only-root'), publicKeys: [publicKey()] })
    try {
      expect(copy.links.map((l) => l.path)).toEqual([join(copy.dir, 'node_modules')])
      expect(lstatSync(join(copy.dir, 'node_modules')).isSymbolicLink()).toBe(true)
      expect(existsSync(join(copy.dir, 'apps', 'desktop', 'node_modules'))).toBe(false)
    } finally {
      copy.remove()
    }
  })
})

describe('makeScratchCopy at an older revision (T6.11)', () => {
  it('makes the copy at that commit, links no packages (a tag runs its own npm ci), and writes the key set', async () => {
    const src = makeSource('older')
    const keys = [publicKey()]
    const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: src.first, root: scratch('older-root'), publicKeys: keys })
    try {
      expect(copy.commit).toBe(src.first)
      expect(gitIn(copy.dir, ['rev-parse', 'HEAD']).trim()).toBe(src.first)
      expect(readFileSync(join(copy.dir, 'README.md'), 'utf8').trim()).toBe('one')
      expect(copy.links).toEqual([])
      expect(existsSync(join(copy.dir, 'node_modules'))).toBe(false)
      expect(existsSync(join(copy.dir, 'apps', 'desktop', 'node_modules'))).toBe(false)
      expect(readFileSync(copy.keysJson, 'utf8')).toBe(keysText(keys))
    } finally {
      copy.remove()
    }
  })
})

describe('the removal never runs through a link it did not make (T6.11)', () => {
  it('refuses a copy that holds another link and removes nothing; once that link is gone by its name, it removes the copy', async () => {
    const src = makeSource('foreign')
    const outside = scratch('foreign-outside')
    writeFileSync(join(outside, 'sentinel.txt'), 'outside\n')
    const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: 'HEAD', root: scratch('foreign-root'), publicKeys: [publicKey()] })
    const extra = join(copy.dir, 'apps', 'extra-link')
    symlinkSync(outside, extra, 'junction')
    expect(() => copy.remove()).toThrow('walk-build: the copy holds a link out of it that it did not make; nothing removed')
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside\n')
    for (const link of copy.links) expect(lstatSync(link.path).isSymbolicLink(), link.path).toBe(true)
    expect(existsSync(copy.keysJson)).toBe(true)
    expect(worktreeBlock(src, copy.dir)).toBeDefined()
    unlinkByName(extra)
    copy.remove()
    expect(existsSync(copy.dir)).toBe(false)
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside\n')
  })

  it("removes a copy whose own packages hold a link into the copy (npm's workspace link in a tag's copy), by its name", async () => {
    const src = makeSource('inside-link')
    const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: src.first, root: scratch('inside-link-root'), publicKeys: [publicKey()] })
    // What `npm ci` leaves in a copy of a tag: a real node_modules whose workspace entry links back into the copy.
    const scope = join(copy.dir, 'node_modules', '@scope')
    mkdirSync(scope, { recursive: true })
    symlinkSync(copy.desktopDir, join(scope, 'desktop'), 'junction')
    copy.remove()
    expect(existsSync(copy.dir)).toBe(false)
    expect(worktreeBlock(src, copy.dir)).toBeUndefined()
  })

  it.each([
    ['a worktree on a branch', 'branch'],
    ['a folder that is no worktree', 'plain'],
    ['a detached worktree outside the temp folder', 'outside-temp']
  ] as const)('removeScratchCopy refuses %s and leaves it', async (_label, kind) => {
    const src = makeSource(`refuse-${kind}`)
    const { removeScratchCopy } = await walkBuild()
    let dir: string
    if (kind === 'branch') {
      dir = join(scratch('refuse-branch-wt'), 'w')
      src.git('worktree', 'add', '-q', '-b', 'side', dir, src.head)
    } else if (kind === 'plain') {
      dir = scratch('refuse-plain')
      writeFileSync(join(dir, 'kept.txt'), 'kept\n')
    } else {
      const copy = await (await walkBuild()).makeScratchCopy({ repo: src.repo, rev: 'HEAD', root: scratch('refuse-outside-root'), publicKeys: [publicKey()] })
      try {
        await withTempFolder(scratch('refuse-other-temp'), () => {
          expect(() => removeScratchCopy({ repo: src.repo, dir: copy.dir })).toThrow(
            'walk-build: the folder is not a detached worktree of the repository inside the temp folder'
          )
        })
        expect(worktreeBlock(src, copy.dir)).toBeDefined()
        for (const link of copy.links) expect(lstatSync(link.path).isSymbolicLink(), link.path).toBe(true)
      } finally {
        copy.remove()
      }
      return
    }
    const before = src.git('worktree', 'list', '--porcelain')
    const files = readdirSync(dir).sort()
    expect(() => removeScratchCopy({ repo: src.repo, dir })).toThrow('walk-build: the folder is not a detached worktree of the repository inside the temp folder')
    expect(readdirSync(dir).sort()).toEqual(files)
    expect(src.git('worktree', 'list', '--porcelain')).toBe(before)
  })
})

describe('makeScratchCopy refuses before it writes anything (T6.11)', () => {
  let src: Source
  beforeAll(() => {
    src = makeSource('guards')
  })

  type Case = () => Promise<Partial<MakeOptions> & { tempFolder?: string }> | (Partial<MakeOptions> & { tempFolder?: string })
  const cases: Array<[string, Case, string]> = [
    ['no public key', () => ({ publicKeys: [] }), 'walk-build: publicKeys must be 1 to 16 public keys'],
    ['17 public keys', () => ({ publicKeys: Array.from({ length: 17 }, publicKey) }), 'walk-build: publicKeys must be 1 to 16 public keys'],
    ['a key list that is no array', () => ({ publicKeys: { length: 1, 0: publicKey() } }), 'walk-build: publicKeys must be 1 to 16 public keys'],
    [
      'a key object instead of its text',
      () => ({ publicKeys: [generateKeyPairSync('ed25519').publicKey] }),
      'walk-build: the public keys do not read as a key set (not-a-string)'
    ],
    ['two keys in one entry', () => ({ publicKeys: [`${publicKey()},${publicKey()}`] }), 'walk-build: the public keys do not read as a key set (not-one-key)'],
    [
      'a private key (PKCS#8), never taken',
      () => ({ publicKeys: [generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')] }),
      'walk-build: the public keys do not read as a key set (not-ed25519-spki)'
    ],
    ['a source that is no checkout', () => ({ repo: scratch('not-a-repo') }), 'walk-build: the repository is not the top of a git checkout'],
    [
      'a copy name with a path in it',
      () => {
        // Nested, so that a copy made by a broken name check would still land inside this test's own folder.
        const root = join(scratch('name'), 'root')
        mkdirSync(root)
        return { root, name: '../escape' }
      },
      'walk-build: the copy name is not a plain folder name'
    ],
    [
      'a scratch root that is a file',
      () => {
        const file = join(scratch('root-file'), 'file')
        writeFileSync(file, '')
        return { root: file }
      },
      'walk-build: the scratch root is not an existing folder'
    ],
    [
      'a scratch root outside the temp folder',
      () => ({ root: scratch('elsewhere'), tempFolder: scratch('other-temp') }),
      'walk-build: the scratch root is not inside the temp folder'
    ],
    [
      'a scratch root inside the source checkout',
      () => {
        const root = join(src.repo, 'scratch-inside')
        mkdirSync(root, { recursive: true })
        return { root }
      },
      'walk-build: the scratch root is inside a checkout or worktree'
    ],
    [
      "a scratch root inside the source's .git folder",
      () => {
        const root = join(src.repo, '.git', 'scratch-inside')
        mkdirSync(root, { recursive: true })
        return { root }
      },
      'walk-build: the scratch root is inside a checkout or worktree'
    ],
    [
      'a copy folder that already exists',
      () => {
        const root = scratch('exists')
        mkdirSync(join(root, 'taken'))
        return { root, name: 'taken' }
      },
      'walk-build: the copy folder already exists'
    ],
    ['a revision that names nothing', () => ({ rev: 'no-such-revision' }), 'walk-build: the revision does not name a commit'],
    ['a revision that names a tree', () => ({ rev: `${src.head}^{tree}` }), 'walk-build: the revision does not name a commit'],
    ['a revision that is no string (a list whose text would name HEAD)', () => ({ rev: ['HEAD'] }), 'walk-build: the revision does not name a commit'],
    [
      'a revision whose keys.json is a link',
      () => ({ rev: variantCommit(src, (index) => linkEntry(index, KEYS_REL)) }),
      "walk-build: the revision's keys.json is not a regular file"
    ],
    [
      'a revision whose keys.json sits under a linked folder',
      () => ({
        rev: variantCommit(src, (index) => {
          index(['update-index', '--force-remove', KEYS_REL])
          linkEntry(index, 'apps/desktop/src/main/services/updates')
        })
      }),
      "walk-build: the revision's keys.json is not a regular file"
    ],
    [
      'a revision whose keys.json does not read',
      () => ({
        rev: variantCommit(src, (index) => {
          const blob = index(['hash-object', '-w', '--stdin'], '{}\n').trim()
          index(['update-index', '--cacheinfo', `100644,${blob},${KEYS_REL}`])
        })
      }),
      "walk-build: the revision's keys.json does not read (not-a-string)"
    ],
    [
      "HEAD while the source's lockfile differs from HEAD's",
      () => {
        const changed = makeSource('lockfile')
        writeFileSync(join(changed.repo, 'package-lock.json'), '{ "lockfileVersion": 3, "changed": true }\n')
        return { repo: changed.repo }
      },
      "walk-build: the source's package-lock.json differs from the revision's"
    ],
    ['HEAD of a source without node_modules', () => ({ repo: makeSource('no-packages', 'none').repo }), 'walk-build: the source has no node_modules to link']
  ]

  it.each(cases)('refuses %s', async (_label, make, message) => {
    const given = await make()
    const repo = given.repo ?? src.repo
    const root = given.root ?? scratch('guard-root')
    const options: MakeOptions = { repo, rev: 'rev' in given ? given.rev : 'HEAD', root, publicKeys: given.publicKeys ?? [publicKey()] }
    if (given.name !== undefined) options.name = given.name
    const isRepo = existsSync(join(repo, '.git'))
    const watched = isRepo ? { ...src, repo, git: (...args: string[]) => gitIn(repo, args) } : null
    const before = watched ? snapshot(watched, root) : rootState(root)
    const { makeScratchCopy } = await walkBuild()
    const call = (): Promise<ScratchCopy> => makeScratchCopy(options)
    if (given.tempFolder !== undefined) await withTempFolder(given.tempFolder, () => expect(call()).rejects.toThrow(message))
    else await expect(call()).rejects.toThrow(message)
    expect(watched ? snapshot(watched, root) : rootState(root)).toEqual(before)
  })
})

describe('versionOverride: the build version of a walk build (T6.11, for T7.7a)', () => {
  it('turns MAJOR.MINOR.PATCH into its -e2e pre-release and the electron-builder argument that sets it', async () => {
    const { versionOverride } = await walkBuild()
    expect(versionOverride('0.1.66')).toEqual({ version: '0.1.66-e2e', arg: '-c.extraMetadata.version=0.1.66-e2e' })
    const parsed = parseSemver(versionOverride('10.0.3').version)
    expect(parsed && [parsed.major, parsed.minor, parsed.patch, parsed.prerelease]).toEqual(['10', '0', '3', ['e2e']])
  })

  // The last row is a list whose text is a valid version: only the type check refuses it.
  it.each([['0.1.66-e2e'], ['v0.1.66'], ['0.1'], ['01.2.3'], [' 0.1.66'], ['0.1.66\n'], [['0.1.66']]])('refuses %j', async (version) => {
    const { versionOverride } = await walkBuild()
    expect(() => versionOverride(version)).toThrow('walk-build: the version is not MAJOR.MINOR.PATCH')
  })
})

describe('the command line (plain Node: the key reader loads through type stripping) (T6.11)', () => {
  const run = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('make prints the copy as one JSON line, and remove removes it, the worktree list as before', () => {
    const src = makeSource('cli')
    const root = scratch('cli-root')
    const keys = [publicKey()]
    const before = src.git('worktree', 'list', '--porcelain')
    const made = run('make', '--repo', src.repo, '--rev', 'HEAD', '--root', root, '--key', keys[0]!)
    expect(made.status, String(made.stderr)).toBe(0)
    const copy = JSON.parse(String(made.stdout).trim()) as Omit<ScratchCopy, 'remove'>
    expect(copy.commit).toBe(src.head)
    expect(readFileSync(copy.keysJson, 'utf8')).toBe(keysText(keys))
    expect(copy.keyIds).toEqual(keys.map(keyId))
    expect(copy.links.map((l) => realpathSync.native(l.path))).toEqual([join(src.repo, 'node_modules'), join(src.repo, 'apps', 'desktop', 'node_modules')])
    const removed = run('remove', '--repo', src.repo, '--dir', copy.dir)
    expect(removed.status, String(removed.stderr)).toBe(0)
    expect(existsSync(copy.dir)).toBe(false)
    expect(readFileSync(join(src.repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('root packages\n')
    expect(src.git('worktree', 'list', '--porcelain')).toBe(before)
  })

  it('answers a refusal with exit 1 and its one line, and a usage error with exit 2', () => {
    const src = makeSource('cli-refused')
    const root = scratch('cli-refused-root')
    const refused = run('make', '--repo', src.repo, '--rev', 'no-such-revision', '--root', root, '--key', publicKey())
    // Node may add its own warning lines (a module type); the script's own lines start with its name.
    const own = String(refused.stderr)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('walk-build'))
    expect([refused.status, own]).toEqual([1, ['walk-build: the revision does not name a commit']])
    expect(readdirSync(root)).toEqual([])
    expect(run('make', '--rev', 'HEAD').status).toBe(2)
    expect(run().status).toBe(2)
  })
})
