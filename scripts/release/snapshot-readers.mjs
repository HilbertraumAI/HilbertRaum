#!/usr/bin/env node
// W-53's reader-snapshot recipe (app-update plan T2.8). It bundles modules of a published tag's OWN sources into single
// CommonJS files that a test loads beside today's code, so an "old reader" row runs the released code itself, not
// today's code under another name.
//
//   node scripts/release/snapshot-readers.mjs --tag <tag> --out <dir> --entry <path in the tag>=<name>.cjs [--entry …]
//                                             [--work <scratch dir>] [--keep]
//
//   e.g. --tag v0.1.60 --out apps/desktop/tests/fixtures/readers/v0.1.60
//        --entry apps/desktop/src/main/services/db.ts=open-database.cjs
//
// 1. `git archive` of the tag's `apps/desktop/src`, its tsconfig files and package.json files, unpacked by the OS tar
//    from stdin inside a scratch folder (no `-C`, #856). Read-only against the repository: no worktree, ref or index.
// 2. Each entry is bundled by THIS checkout's vite in library mode into one CommonJS file (no minify, no source map),
//    with no node_modules. The only imports a bundle may keep are `node:*` built-ins. Any other import (a package, a
//    bare built-in name such as `fs`, `electron`) fails the run, named with its importer: it is never resolved from a
//    parent folder's node_modules. A reader that needs a package is the tag-tree `npm ci` fallback, the orchestrator's
//    call (app-update plan C4).
// 3. The bundle starts with a banner (tag, commit, vite version, entry); `<name>.provenance.json` beside it records the
//    same plus the date, the Node version and the command. The bundle's bytes depend only on the tag and the vite
//    version, so a rerun reproduces them; only the provenance file's date changes.
//
// How a test loads a snapshot: `createRequire(__filename)(<absolute path of the .cjs>)` and a type the test declares
// (tsconfig has no allowJs, so a static import of the .cjs would fail the typecheck). The snapshot runs on the test's
// own Node and node:sqlite, not on the tag's Electron.
//
// CI checks out one commit without tags, so the recipe runs on a developer box. CI checks the committed outputs through
// apps/desktop/tests/fixtures/golden-fixtures.sha256 (repo-hygiene.test.ts).
//
// Exit codes: 0 ok · 1 the archive, a build or a check failed (a bundle needs more than node:*) · 2 usage error.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RECIPE = 'scripts/release/snapshot-readers.mjs'
/** What a tag's archive holds: the app's sources and the files their transform reads (tsconfig, package type). */
const ARCHIVE_PATHS = ['package.json', 'apps/desktop/package.json', 'apps/desktop/tsconfig*.json', 'apps/desktop/src']

export class SnapshotError extends Error {}

function git(args, options = {}) {
  const r = spawnSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 512 * 1024 * 1024, ...options })
  if (r.error) throw new SnapshotError(`git ${args[0]}: ${r.error.message}`)
  if (r.status !== 0) throw new SnapshotError(`git ${args.join(' ')} exited ${r.status}: ${String(r.stderr).trim()}`)
  return r.stdout
}

/** The tag's commit. Refuses a name that is not a tag (a branch or a sha would make the provenance lie). */
export function tagCommit(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new SnapshotError(`not a release tag name: ${tag}`)
  git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { encoding: 'utf8' })
  return git(['rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
}

/** The tag's sources (ARCHIVE_PATHS) unpacked into `<work>/<tag>`, read only through `git archive`. */
export function exportTag(tag, work) {
  const commit = tagCommit(tag)
  const tree = join(work, tag)
  if (existsSync(tree)) throw new SnapshotError(`scratch tree already exists: ${tree}`)
  mkdirSync(tree, { recursive: true })
  const archive = git(['archive', '--format=tar', commit, '--', ...ARCHIVE_PATHS])
  // The OS tar, by absolute path on Windows (System32's bsdtar), reading stdin in the target folder itself.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? '', 'System32', 'tar.exe') : 'tar'
  if (process.platform === 'win32' && !process.env.SystemRoot) throw new SnapshotError('SystemRoot is not set: no tar')
  const r = spawnSync(tar, ['-x', '-f', '-'], { cwd: tree, input: archive, maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new SnapshotError(`tar -x failed: ${r.error?.message ?? String(r.stderr).trim()}`)
  return { tree, commit }
}

/** Every import the bundle may keep is a `node:*` built-in; a `require(` or `import(` of anything else fails it. */
export function foreignImportsIn(code, chunk) {
  const found = new Set([...chunk.imports, ...chunk.dynamicImports].filter((id) => !id.startsWith('node:')))
  for (const m of code.matchAll(/\brequire\s*\(\s*(?!["']node:[^"']+["']\s*\))([^)]{0,80})\)?/g)) found.add(`require(${m[1]})`)
  for (const m of code.matchAll(/\bimport\s*\(\s*(?!["']node:[^"']+["']\s*\))([^)]{0,80})\)?/g)) found.add(`import(${m[1]})`)
  return [...found]
}

/**
 * Bundles `entry` (a path inside the tag's tree, forward slashes) with this checkout's vite in library mode into one
 * CommonJS file. Returns the code with the banner, or throws a SnapshotError naming every import that is not node:*.
 */
export async function bundleEntry({ tag, commit, tree, entry, fileName }) {
  const { build, version } = await import('vite')
  const foreign = []
  const nodeBuiltinsOnly = {
    name: 'hilbertraum:node-builtins-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('node:')) return { id: source, external: true }
      if (importer === undefined || source.startsWith('\0')) return null // the entry itself; vite's virtual modules
      if (source.startsWith('.') || isAbsolute(source)) return null // the tag's own files
      foreign.push(`${source} (imported by ${relative(tree, importer).split('\\').join('/')})`)
      return { id: source, external: true } // kept external so the build lists them all; the run fails below
    }
  }
  const banner =
    `// Reader snapshot ${fileName}: ${entry} at ${tag} (${commit}),\n` +
    `// bundled by ${RECIPE} with vite ${version} in library mode (CommonJS, node:* imports only).\n` +
    `// Generated from the tag: never edit; rerun the recipe. Provenance: ${basename(fileName, '.cjs')}.provenance.json.`
  const result = await build({
    configFile: false,
    root: tree,
    envDir: tree,
    cacheDir: join(tree, '.vite-cache'),
    publicDir: false,
    mode: 'production',
    logLevel: 'warn',
    plugins: [nodeBuiltinsOnly],
    build: {
      write: false,
      outDir: join(tree, '.snapshot-out'),
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      target: 'node22',
      minify: false,
      sourcemap: false,
      lib: { entry: join(tree, ...entry.split('/')), formats: ['cjs'], fileName: () => fileName },
      rollupOptions: { output: { exports: 'named', inlineDynamicImports: true } }
    }
  })
  const outputs = [result].flat().flatMap((r) => r.output)
  if (outputs.length !== 1 || outputs[0].type !== 'chunk') {
    throw new SnapshotError(`${entry}: expected one chunk, got ${outputs.map((o) => o.fileName).join(', ')}`)
  }
  const chunk = outputs[0]
  // The banner goes on after the build: lib mode's final esbuild pass reprints the chunk and drops every comment.
  const code = `${banner}\n${chunk.code}${chunk.code.endsWith('\n') ? '' : '\n'}`
  // The resolver's record names each import with its importer; the scan of the output is the backstop for anything
  // that reached the bundle another way (a `require` the tag's code builds itself).
  const bad = foreign.length > 0 ? foreign : foreignImportsIn(code, chunk)
  if (bad.length > 0) {
    throw new SnapshotError(
      `${entry} at ${tag} needs more than node:* built-ins: ${[...new Set(bad)].join('; ')}. ` +
        'A package is the tag-tree npm ci fallback (the orchestrator decides); it is never bundled from elsewhere.'
    )
  }
  if (code.includes('\0')) throw new SnapshotError(`${entry}: the bundle holds a NUL byte`)
  if (code.includes('\r')) throw new SnapshotError(`${entry}: the bundle holds a carriage return`)
  const local = [tree, REPO_ROOT, tmpdir()].flatMap((p) => [p, p.split('\\').join('/')]).map((p) => p.toLowerCase())
  const lower = code.toLowerCase()
  const leak = local.find((p) => lower.includes(p))
  if (leak) throw new SnapshotError(`${entry}: the bundle names a local path (${leak})`)
  return { code, viteVersion: version }
}

function parseArgs(argv) {
  const args = { tag: '', out: '', entries: [], work: '', keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new SnapshotError(`${a} needs a value`)
      return v
    }
    if (a === '--tag') args.tag = value()
    else if (a === '--out') args.out = value()
    else if (a === '--work') args.work = value()
    else if (a === '--keep') args.keep = true
    else if (a === '--entry') {
      const [entry, fileName, ...rest] = value().split('=')
      if (!entry || !fileName || rest.length > 0 || !/^[a-z0-9][a-z0-9.-]*\.cjs$/.test(fileName) || entry.includes('\\')) {
        throw new SnapshotError(`--entry wants <path in the tag, forward slashes>=<name>.cjs, got ${argv[i]}`)
      }
      args.entries.push({ entry, fileName })
    } else throw new SnapshotError(`unknown argument ${a}`)
  }
  if (!args.tag || !args.out || args.entries.length === 0) throw new SnapshotError('--tag, --out and --entry are required')
  return args
}

/** The output folder as the provenance names it: relative to the repository, forward slashes. */
function repoRelative(p) {
  const rel = relative(REPO_ROOT, resolve(p))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SnapshotError(`--out must be inside the repository: ${p}`)
  return rel.split('\\').join('/')
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`${err.message}\nusage: node ${RECIPE} --tag <tag> --out <dir> --entry <path>=<name>.cjs [--entry …] [--work <dir>] [--keep]`)
    return 2
  }
  const outRel = repoRelative(args.out)
  const work = args.work ? resolve(args.work) : mkdtempSync(join(tmpdir(), 'hr-snapshot-'))
  let created = args.work ? '' : work // only what this run made is removed
  try {
    if (args.work && existsSync(join(work, args.tag))) throw new SnapshotError(`scratch tree already exists: ${join(work, args.tag)}`)
    if (args.work) created = join(work, args.tag)
    const { tree, commit } = exportTag(args.tag, work)
    const outDir = join(REPO_ROOT, ...outRel.split('/'))
    mkdirSync(outDir, { recursive: true })
    const command = [`node ${RECIPE} --tag ${args.tag} --out ${outRel}`, ...args.entries.map((e) => `--entry ${e.entry}=${e.fileName}`)]
    for (const { entry, fileName } of args.entries) {
      const { code, viteVersion } = await bundleEntry({ tag: args.tag, commit, tree, entry, fileName })
      writeFileSync(join(outDir, fileName), code)
      const provenance = {
        bundle: fileName,
        entry,
        tag: args.tag,
        commit,
        bundler: `vite ${viteVersion} (library mode, CommonJS, node:* imports only)`,
        recipe: RECIPE,
        command: command.join(' '),
        node: process.version,
        created: new Date().toISOString(),
        runs_on: "the loading process's own Node and node:sqlite, not the tag's Electron"
      }
      writeFileSync(join(outDir, `${basename(fileName, '.cjs')}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`)
      console.log(`${outRel}/${fileName}: ${entry} at ${args.tag} (${commit.slice(0, 12)}), vite ${viteVersion}`)
    }
    return 0
  } catch (err) {
    if (!(err instanceof SnapshotError)) throw err
    console.error(err.message)
    return 1
  } finally {
    if (!args.keep && created) rmSync(created, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
