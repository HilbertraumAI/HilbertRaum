#!/usr/bin/env node
// Golden vault descriptors from published tags (app-update plan T2.8, W-80 (d); #845's goldens). For each tag it runs
// THAT tag's own descriptor-writing code on an empty scratch root with a throwaway password and keeps the
// `config/workspace.json` it wrote: `createEncryptedVaultOnDisk(vaultPaths, password)` with no KDF argument and no
// options (the production default: `WorkspaceController.create` makes the same call), then the same tag's
// `unlockEncryptedVault` and `lockEncryptedVault`, which must leave the descriptor byte for byte.
//
//   node scripts/release/golden-descriptors.mjs --tag <tag> [--tag …] [--out <dir>] [--work <scratch dir>] [--keep]
//
// The tag's sources come from scripts/release/snapshot-readers.mjs (`git archive`, read-only) and are bundled by its
// one build (`bundleCjs`: apps/desktop's vite in library mode, the #646 check, every module inside the tag's tree),
// with ONE difference: the vault code's key derivation imports `@noble/hashes` (every published tag does), and that one
// package is resolved from THIS checkout's installed copy, by its absolute path under <repo>/node_modules, never from
// anywhere else (the orchestrator's decision in T2.8: the tags pin 2.2.0 up to v0.1.62 and 2.4.0 from v0.1.63). A tag
// whose pin is another major version than the installed one is refused. Any other import that is not `node:*` fails
// the run. Each printed line records the tag's own pin.
//
// Before a descriptor is kept, its verifier and its data key must open under node:crypto's own Argon2id
// (`argon2Sync`, Node 24.7 or later; no @noble/hashes involved), with the parameters the descriptor records: a stand-in
// package that derived another key cannot write a golden (review R-3).
//
// A descriptor holds a random salt and a random data key, so a rerun never reproduces a committed file: an existing
// output file is kept, never overwritten (`v0.1.50-workspace.json` and `v0.1.65-workspace.json` predate this script).
// The files are read by tests/integration/workspace-vault-format-guard.test.ts (one row each) and locked by
// apps/desktop/tests/fixtures/golden-fixtures.sha256; their provenance is tests/fixtures/vault-golden/PROVENANCE.md.
// The gates are tested by apps/desktop/tests/integration/release-scripts.test.ts.
//
// Exit codes: 0 ok · 1 a tag failed (its code, its bundle, its key derivation, or a changed descriptor) · 2 usage error.

import { spawnSync } from 'node:child_process'
import * as nodeCrypto from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, SnapshotError, bundleCjs, checkTagName, exportTag, foreignImportsIn } from './snapshot-readers.mjs'

const GENERATOR = 'scripts/release/golden-descriptors.mjs'
const DEFAULT_OUT = 'apps/desktop/tests/fixtures/vault-golden'
/** Tags that exist without a release: there is no descriptor of theirs to keep. */
const NEVER_PUBLISHED = new Set(['v0.1.51'])
const PACKAGE = '@noble/hashes'
const PACKAGE_DIR = join(REPO_ROOT, 'node_modules', '@noble', 'hashes')

/** The capture, bundled with the tag's own vault code. Written into the scratch copy of the tag, never the repo. */
const DRIVER = `import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createEncryptedVaultOnDisk,
  lockEncryptedVault,
  unlockEncryptedVault,
  vaultPathsFrom
} from './main/services/workspace-vault'

export function capture(root: string, password: string): Buffer {
  const configPath = join(root, 'config')
  const dbPath = join(root, 'workspace', 'hilbertraum.sqlite')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  const vaultPaths = vaultPathsFrom({ configPath, dbPath })
  createEncryptedVaultOnDisk(vaultPaths, password)
  const written = readFileSync(vaultPaths.descriptorPath)
  const unlocked = unlockEncryptedVault(vaultPaths, password)
  lockEncryptedVault(vaultPaths, unlocked.db, unlocked.key)
  if (!readFileSync(vaultPaths.descriptorPath).equals(written)) throw new Error('the descriptor changed across unlock and lock')
  return written
}
`

function git(args) {
  const r = spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw new SnapshotError(`git ${args[0]}: ${r.error.message}`)
  if (r.status !== 0) throw new SnapshotError(`git ${args.join(' ')} exited ${r.status}: ${String(r.stderr).trim()}`)
  return r.stdout
}

/** `@noble/hashes` as a `package-lock.json` text pins it. */
function lockedPin(lockText, where) {
  const entry = JSON.parse(lockText).packages?.[`node_modules/${PACKAGE}`]
  if (!entry?.version || !entry?.integrity) throw new SnapshotError(`${where}'s lockfile pins no ${PACKAGE}`)
  return { version: entry.version, integrity: entry.integrity }
}

/** This checkout's installed copy, which must be the one its own lockfile pins (else node_modules is stale: npm ci). */
function installedPackage() {
  const installed = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version
  const pin = lockedPin(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'), 'this checkout')
  if (installed !== pin.version) throw new SnapshotError(`${PACKAGE} ${installed} is installed, the lockfile pins ${pin.version}`)
  return pin
}

/** `@noble/hashes/<subpath>` by the package's own `exports` map, under PACKAGE_DIR; any file outside it is refused. */
function packageFile(specifier) {
  const subpath = specifier === PACKAGE ? '.' : `./${specifier.slice(PACKAGE.length + 1)}`
  const exported = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).exports?.[subpath]
  const target = typeof exported === 'string' ? exported : (exported?.import ?? exported?.default)
  if (typeof target !== 'string') throw new SnapshotError(`${specifier}: ${PACKAGE} exports no ${subpath}`)
  const file = realpathSync.native(join(PACKAGE_DIR, target))
  const rel = relative(realpathSync.native(PACKAGE_DIR), file)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SnapshotError(`${specifier} resolved outside ${PACKAGE_DIR}: ${file}`)
  return file
}

/** The driver and the tag's vault code in one CommonJS file: the recipe's build, with that one package allowed. */
export async function bundleCapture(tag, tree) {
  writeFileSync(join(tree, 'apps', 'desktop', 'src', 'golden-capture.ts'), DRIVER)
  const resolveBare = (source) => (source === PACKAGE || source.startsWith(`${PACKAGE}/`) ? packageFile(source) : null)
  const { chunk, foreign } = await bundleCjs({ tree, entry: 'apps/desktop/src/golden-capture.ts', fileName: 'golden-capture.cjs', resolveBare, roots: [PACKAGE_DIR] })
  const bad = [...foreign, ...foreignImportsIn(chunk.code, chunk)]
  if (bad.length > 0) throw new SnapshotError(`${tag}'s vault code needs more than node:* and ${PACKAGE}: ${[...new Set(bad)].join('; ')}`)
  const file = join(tree, 'golden-capture.cjs')
  writeFileSync(file, chunk.code)
  return file
}

/** The descriptor's verifier and data key, opened with node:crypto's own Argon2id and AES-256-GCM (review R-3). */
function openWithNodeArgon2(tag, d, password) {
  if (typeof nodeCrypto.argon2Sync !== 'function') {
    throw new SnapshotError(`node:crypto has no argon2Sync on Node ${process.version} (24.7 or later): the key derivation cannot be checked`)
  }
  const kek = nodeCrypto.argon2Sync('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: Buffer.from(d.saltB64, 'base64'),
    parallelism: d.kdf.p,
    tagLength: d.kdf.keyLen,
    memory: d.kdf.m,
    passes: d.kdf.t
  })
  const open = (blob) => {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(blob.ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(blob.tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(blob.ciphertextB64, 'base64')), decipher.final()])
  }
  try {
    open(d.verifier)
    if (open(d.dataKey).length !== 32) throw new Error('the data key is not 32 bytes')
  } catch (err) {
    throw new SnapshotError(`${tag}'s descriptor does not open under node:crypto's Argon2id with its own kdf block (${err.message})`)
  } finally {
    kek.fill(0)
  }
}

/** One descriptor from the tag's own code in `tree`, checked for the published shape and its key derivation. */
export async function captureFromTree({ tag, commit, tree, work, pin }) {
  const head = installedPackage()
  if (pin.version.split('.')[0] !== head.version.split('.')[0]) {
    throw new SnapshotError(`${tag} pins ${PACKAGE} ${pin.version}, another major version than the installed ${head.version}: no stand-in`)
  }
  const bundle = await bundleCapture(tag, tree)
  const password = `golden-throwaway-${tag}`
  const root = join(work, 'root')
  mkdirSync(root)
  const { capture } = createRequire(import.meta.url)(bundle)
  const bytes = capture(root, password)
  const d = JSON.parse(bytes.toString('utf8'))
  const kdf = d.kdf ?? {}
  if (d.version !== 2 || d.mode !== 'encrypted' || !d.dataKey || kdf.algo !== 'argon2id' || kdf.m !== 19456 || kdf.t !== 2) {
    throw new SnapshotError(`${tag} (${commit}) wrote a descriptor of another shape: version ${d.version}, mode ${d.mode}, kdf ${JSON.stringify(kdf)}`)
  }
  if (bytes[0] === 0xef || bytes.includes(0x0d)) throw new SnapshotError(`${tag}'s descriptor starts with a BOM or holds a CR`)
  openWithNodeArgon2(tag, d, password)
  return { password, bytes, kdfPackage: pin.version === head.version ? `${PACKAGE} ${pin.version}, the tag's pin` : `the tag pins ${PACKAGE} ${pin.version}; ${head.version} stood in` }
}

/** One descriptor from `tag`'s own code: its sources, its lockfile's pin, then `captureFromTree`. */
async function captureDescriptor(tag, work) {
  if (NEVER_PUBLISHED.has(tag)) throw new SnapshotError(`${tag} was never published: no descriptor of its own to keep`)
  const { tree, commit } = exportTag(tag, work)
  const pin = lockedPin(git(['show', `${commit}:package-lock.json`]), tag)
  return { commit, ...(await captureFromTree({ tag, commit, tree, work, pin })) }
}

function parseArgs(argv) {
  const args = { tags: [], out: DEFAULT_OUT, work: '', keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new SnapshotError(`${a} needs a value`)
      return v
    }
    if (a === '--tag') args.tags.push(checkTagName(value()))
    else if (a === '--out') args.out = value()
    else if (a === '--work') args.work = value()
    else if (a === '--keep') args.keep = true
    else throw new SnapshotError(`unknown argument ${a}`)
  }
  if (args.tags.length === 0) throw new SnapshotError('at least one --tag is required')
  return args
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    if (!(err instanceof SnapshotError)) throw err
    console.error(`${err.message}\nusage: node ${GENERATOR} --tag <tag> [--tag …] [--out <dir>] [--work <dir>] [--keep]`)
    return 2
  }
  const outDir = resolve(REPO_ROOT, args.out)
  if (args.work) mkdirSync(resolve(args.work), { recursive: true })
  // Removed below unless --keep; in the file system's own spelling before anything derives from it (#646).
  const work = realpathSync.native(mkdtempSync(join(args.work ? resolve(args.work) : tmpdir(), 'hr-golden-')))
  let failed = false
  try {
    mkdirSync(outDir, { recursive: true })
    for (const tag of args.tags) {
      const name = `${tag}-workspace.json`
      if (existsSync(join(outDir, name))) {
        console.log(`${name}: kept (a committed capture is never regenerated: its salt and data key are random)`)
        continue
      }
      try {
        const { commit, password, bytes, kdfPackage } = await captureDescriptor(tag, mkdtempSync(join(work, `${tag}-`)))
        writeFileSync(join(outDir, name), bytes)
        const sha256 = nodeCrypto.createHash('sha256').update(bytes).digest('hex')
        console.log(`| \`${name}\` | \`${tag}\` | \`${commit}\` | \`${password}\` | \`${sha256}\` | ${kdfPackage} |`)
      } catch (err) {
        if (!(err instanceof SnapshotError)) throw err
        console.error(err.message)
        failed = true
      }
    }
    return failed ? 1 : 0
  } catch (err) {
    if (!(err instanceof SnapshotError)) throw err
    console.error(err.message)
    return 1
  } finally {
    if (!args.keep) rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
