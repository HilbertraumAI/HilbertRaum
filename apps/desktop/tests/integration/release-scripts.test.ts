import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as nodeCrypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tempRoot } from '../helpers/db-fixtures'
import { REPO_ROOT } from '../helpers/repo-files'

// T2.8 (W-53, W-80 (d); its review's R-1, R-2, R-3, R-6, R-8): the gates of the two release scripts,
// scripts/release/snapshot-readers.mjs (the reader-snapshot recipe) and scripts/release/golden-descriptors.mjs (the
// golden-descriptor generator). CI has no tags, so neither script runs there on a release; these rows feed their real
// builds and checks small synthetic sources instead. A gate that stops gating then fails here, not years later when
// release 1's readers are snapshotted and the header still says "node:* imports only".

interface Pin {
  version: string
  integrity: string
}
interface Recipe {
  bundleEntry(o: { tag: string; commit: string; tree: string; entry: string; fileName: string }): Promise<{ code: string }>
  bundleCjs(o: { tree: string; entry: string; fileName: string; resolveBare?: (source: string) => string | null }): Promise<{ code: string }>
  writeSnapshot(o: { outDir: string; fileName: string; code: string; provenance: object; force: boolean; check: boolean }): string
}
interface Generator {
  bundleCapture(tag: string, tree: string): Promise<string>
  captureFromTree(o: { tag: string; commit: string; tree: string; work: string; pin: Pin }): Promise<{ bytes: Buffer }>
}

const script = (name: string): string => join(REPO_ROOT, 'scripts', 'release', name)
/** The scripts are plain ESM without a declaration file: loaded by URL, typed above. */
async function load<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(script(name)).href)) as T
}
const recipe = (): Promise<Recipe> => load<Recipe>('snapshot-readers.mjs')
const generator = (): Promise<Generator> => load<Generator>('golden-descriptors.mjs')

/** Where the generator's driver imports the tag's vault code from; the reader rows bundle the same file as an entry. */
const VAULT = 'apps/desktop/src/main/services/workspace-vault.ts'
/** The four names the driver imports. `createEncryptedVaultOnDisk` calls the case's `probe`, so the case's lines are
 *  reachable from the driver too (unreachable code would be tree-shaken out of the generator's bundle). */
const DRIVER_NAMES = `
export function createEncryptedVaultOnDisk(): void { void probe() }
export function unlockEncryptedVault(): { db: null; key: null } { return { db: null, key: null } }
export function lockEncryptedVault(): void {}
export function vaultPathsFrom(p: { configPath: string }): { descriptorPath: string } { return { descriptorPath: p.configPath } }
`

/** A scratch tree in a tag's layout with `files` (paths relative to it), in the file system's own spelling. */
function sourceTree(label: string, files: Record<string, string>): string {
  const tree = realpathSync.native(tempRoot(`release-${label}`))
  for (const [rel, text] of Object.entries(files)) {
    const file = join(tree, ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return tree
}

/** A file outside every tree, imported by an absolute path. */
function outsideFile(): string {
  const file = join(realpathSync.native(tempRoot('release-outside')), 'outside.ts')
  writeFileSync(file, 'export const outside = 1\n')
  return file.split('\\').join('/')
}

// The idiom v0.1.60's db.ts uses for node:sqlite (a createRequire handle called with a node: literal) is clean.
const CLEAN = `import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const nodeRequire = createRequire(process.execPath)
function probe(): unknown { return [nodeRequire('node:sqlite'), randomUUID()] }
${DRIVER_NAMES}`
const PACKAGE = `import { parse } from 'yaml'
function probe(): unknown { return parse('a: 1') }
${DRIVER_NAMES}`
// The review's R-1: a package loaded inside a function through a createRequire handle passed both old gates.
const THROUGH_CREATE_REQUIRE = `import { createRequire } from 'node:module'
function probe(): unknown {
  const load = createRequire(process.execPath)
  return load('yaml')
}
${DRIVER_NAMES}`
const HANDLE_HANDED_ON = `import { createRequire } from 'node:module'
function hand(use: (r: NodeRequire) => unknown): unknown { return use(createRequire(process.execPath)) }
function probe(): unknown { return hand((r) => r) }
${DRIVER_NAMES}`
const outsideCase = (): string => `import { outside } from '${outsideFile()}'
function probe(): unknown { return outside }
${DRIVER_NAMES}`

describe("the reader recipe's gate: node:* built-ins only, the tag's own files only (snapshot-readers.mjs)", () => {
  const bundle = async (label: string, vault: string): Promise<{ code: string }> =>
    (await recipe()).bundleEntry({ tag: 'v0.0.0', commit: '0'.repeat(40), tree: sourceTree(label, { [VAULT]: vault }), entry: VAULT, fileName: 'x.cjs' })

  it('bundles a module that loads node:sqlite through a createRequire handle, as v0.1.60 does', async () => {
    const { code } = await bundle('clean', CLEAN)
    expect(code).toContain('nodeRequire("node:sqlite")')
  })

  it.each([
    ['a package import', PACKAGE, /needs more than node:\* built-ins: yaml \(imported by apps\/desktop\/src\/main\/services\/workspace-vault\.ts\)/],
    ['a package loaded through a createRequire handle (R-1)', THROUGH_CREATE_REQUIRE, /needs more than node:\* built-ins: .*load\("yaml"\)/],
    ['a createRequire handle handed to other code (R-1)', HANDLE_HANDED_ON, /needs more than node:\* built-ins: .*createRequire/]
  ])('refuses %s', async (_label, vault, message) => {
    await expect(bundle('refused', vault)).rejects.toThrow(message)
  })

  it('refuses a module from outside the tag tree (R-2)', async () => {
    await expect(bundle('outside', outsideCase())).rejects.toThrow(/outside the tag's sources: .*outside\.ts/)
  })

  it('refuses a build that bundles one file under two spellings (R-2, #646)', async () => {
    const tree = sourceTree('split', {
      'src/state.ts': 'export const state = new Map()\n',
      'src/entry.ts': "import { state } from './state'\nimport { state as again } from 'second-spelling'\nexport default state === again\n"
    })
    // A directory link to src/: a second spelling of the same file, as #646's `c:\…` and `C:\…` were.
    symlinkSync(join(tree, 'src'), join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const second = join(tree, 'link', 'state.ts')
    const build = (await recipe()).bundleCjs({ tree, entry: 'src/entry.ts', fileName: 'x.cjs', resolveBare: (s) => (s === 'second-spelling' ? second : null) })
    await expect(build).rejects.toThrow(/bundled one file twice \(#646\): .*state\.ts/)
  })
})

describe("the generator's gate: node:* built-ins and @noble/hashes only (golden-descriptors.mjs)", () => {
  const bundle = async (label: string, vault: string): Promise<string> =>
    (await generator()).bundleCapture('v0.0.0', sourceTree(label, { [VAULT]: vault }))

  it('bundles the driver with vault code that imports @noble/hashes and loads node:sqlite through a handle', async () => {
    const file = await bundle('gen-clean', `import { argon2id } from '@noble/hashes/argon2.js'\n${CLEAN.replace('randomUUID()]', 'randomUUID(), argon2id]')}`)
    expect(readFileSync(file, 'utf8')).toContain('nodeRequire("node:sqlite")')
  })

  it.each([
    ['a package import', PACKAGE, /needs more than node:\* and @noble\/hashes: yaml \(imported by apps\/desktop\/src\/main\/services\/workspace-vault\.ts\)/],
    ['a package loaded through a createRequire handle (R-1)', THROUGH_CREATE_REQUIRE, /needs more than node:\* and @noble\/hashes: .*load\("yaml"\)/],
    ['a module from outside the tag tree and the package (R-2)', '', /outside the tag's sources: .*outside\.ts/]
  ])('refuses %s', async (_label, vault, message) => {
    await expect(bundle('gen-refused', vault || outsideCase())).rejects.toThrow(message)
  })
})

// R-3: the generator opens every descriptor it keeps with node:crypto's own Argon2id (no @noble/hashes), so a stand-in
// KDF package that derives something else cannot write a golden. node:crypto has argon2Sync from Node 24.7; the
// generator refuses to run without it, and these rows wait for it the same way.
const hasArgon2 = 'argon2Sync' in nodeCrypto
/** A vault module that writes a descriptor in the published shape (version 2, Argon2id m 19456 t 2), deriving its
 *  key with `t` passes: 2 is what the descriptor says, anything else is a descriptor no release could open. */
function kdfVault(t: number): string {
  return `import { createCipheriv, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argon2id } from '@noble/hashes/argon2.js'
type Blob = { ivB64: string; tagB64: string; ciphertextB64: string }
function seal(key: Buffer, plain: Buffer): Blob {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([c.update(plain), c.final()])
  return { ivB64: iv.toString('base64'), tagB64: c.getAuthTag().toString('base64'), ciphertextB64: ciphertext.toString('base64') }
}
export function vaultPathsFrom(p: { configPath: string; dbPath: string }): { descriptorPath: string } {
  return { descriptorPath: join(p.configPath, 'workspace.json') }
}
export function createEncryptedVaultOnDisk(vp: { descriptorPath: string }, password: string): void {
  const salt = randomBytes(16)
  const kek = Buffer.from(argon2id(password, salt, { m: 19456, t: ${t}, p: 1, dkLen: 32 }))
  const kdf = { algo: 'argon2id', m: 19456, t: 2, p: 1, keyLen: 32 }
  const d = { version: 2, mode: 'encrypted', kdf, saltB64: salt.toString('base64'), verifier: seal(kek, Buffer.from('verifier')), dataKey: seal(kek, randomBytes(32)) }
  writeFileSync(vp.descriptorPath, JSON.stringify(d, null, 2))
}
export function unlockEncryptedVault(): { db: null; key: null } { return { db: null, key: null } }
export function lockEncryptedVault(): void {}
`
}

describe("the generator checks each descriptor's key derivation before it keeps one (R-3)", () => {
  const capture = async (label: string, t: number, pin: Pin): Promise<{ bytes: Buffer }> => {
    const tree = sourceTree(label, { [VAULT]: kdfVault(t) })
    return (await generator()).captureFromTree({ tag: 'v0.0.0', commit: '0'.repeat(40), tree, work: tree, pin })
  }
  const PIN_2 = { version: '2.2.0', integrity: 'sha512-test' }

  it.runIf(hasArgon2)('keeps a descriptor whose verifier and data key open under node:crypto Argon2id', async () => {
    const { bytes } = await capture('kdf-ok', 2, PIN_2)
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ version: 2, kdf: { algo: 'argon2id', t: 2 } })
  })

  it.runIf(hasArgon2)('refuses a descriptor whose key is not the Argon2id its kdf block names', async () => {
    await expect(capture('kdf-off', 1, PIN_2)).rejects.toThrow(/does not open under node:crypto's Argon2id/)
  })

  it('refuses a tag whose @noble/hashes pin is another major version than the installed one', async () => {
    await expect(capture('kdf-major', 2, { version: '1.8.0', integrity: 'sha512-test' })).rejects.toThrow(/major/)
  })
})

describe('the recipe never overwrites a locked snapshot by accident (R-6)', () => {
  const OLD = '// old bundle\n'
  const NEW = '// new bundle\n'
  /** An output folder holding `bundle` (and its provenance) or nothing, then one write; what is on disk after. */
  async function afterWrite(bundle: string | null, code: string, flags: { force: boolean; check: boolean }) {
    const outDir = realpathSync.native(tempRoot('release-write'))
    const provenancePath = join(outDir, 'x.provenance.json')
    if (bundle !== null) {
      writeFileSync(join(outDir, 'x.cjs'), bundle)
      writeFileSync(provenancePath, '{"created":"before"}\n')
    }
    const outcome = (await recipe()).writeSnapshot({ outDir, fileName: 'x.cjs', code, provenance: { created: 'after' }, ...flags })
    const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null)
    return { outcome, bundle: read(join(outDir, 'x.cjs')), provenance: read(provenancePath) }
  }
  const NONE = { force: false, check: false }
  const FORCE = { force: true, check: false }
  const CHECK = { force: false, check: true }
  const after = '{\n  "created": "after"\n}\n'

  it.each([
    ['a new snapshot is written with its provenance', null, NEW, NONE, 'written', NEW, after],
    ['an existing snapshot is refused without --force, even when the bytes are the same', OLD, OLD, NONE, 'refused', OLD, '{"created":"before"}\n'],
    ['--force with the same bytes writes nothing (the provenance keeps its date)', OLD, OLD, FORCE, 'unchanged', OLD, '{"created":"before"}\n'],
    ['--force with other bytes replaces the bundle and its provenance', OLD, NEW, FORCE, 'written', NEW, after],
    ['--check with the same bytes passes and writes nothing', OLD, OLD, CHECK, 'same', OLD, '{"created":"before"}\n'],
    ['--check with other bytes fails and writes nothing', OLD, NEW, CHECK, 'differs', OLD, '{"created":"before"}\n'],
    ['--check with no snapshot fails and writes nothing', null, NEW, CHECK, 'missing', null, null]
  ])('%s', async (_label, existing, code, flags, outcome, bundle, provenance) => {
    expect(await afterWrite(existing, code, flags)).toEqual({ outcome, bundle, provenance })
  })
})

describe('the scripts refuse bad arguments before touching anything (R-8)', () => {
  const run = (name: string, args: string[]) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    return spawnSync(process.execPath, [script(name), ...args], { cwd: REPO_ROOT, encoding: 'utf8', env })
  }
  const outsideRepo = (): string => realpathSync.native(tempRoot('release-args'))

  it.each([
    ['the generator, a tag that is a path', 'golden-descriptors.mjs', () => ['--tag', '../escape'], /not a release tag name: \.\.\/escape/],
    ['the recipe, a tag that is a path', 'snapshot-readers.mjs', () => ['--tag', '../escape', '--out', 'x', '--entry', 'a/b.ts=b.cjs'], /not a release tag name/],
    ['the recipe, --out outside the repository', 'snapshot-readers.mjs', () => ['--tag', 'v0.1.60', '--out', outsideRepo(), '--entry', 'a/b.ts=b.cjs'], /--out must be inside the repository/]
  ])('%s: exit 2 with a usage message', (_label, name, args, message) => {
    const r = run(name, args())
    expect({ status: r.status, stack: /\n\s+at /.test(r.stderr) }).toEqual({ status: 2, stack: false })
    expect(r.stderr).toMatch(message)
  })
})
