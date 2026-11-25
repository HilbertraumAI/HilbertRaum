#!/usr/bin/env node
// W-53's reader-snapshot recipe (app-update plan T2.8). It bundles modules of a published tag's OWN sources into single
// CommonJS files that a test loads beside today's code, so an "old reader" row runs the released code itself, not
// today's code under another name.
//
//   node scripts/release/snapshot-readers.mjs --tag <tag> --out <dir> --entry <path in the tag>=<name>.cjs [--entry …]
//                                             [--force | --check] [--work <scratch dir>] [--keep]
//
//   e.g. --tag v0.1.60 --out apps/desktop/tests/fixtures/readers/v0.1.60
//        --entry apps/desktop/src/main/services/db.ts=open-database.cjs
//
// 1. `git archive` of the tag's `apps/desktop/src`, its tsconfig files and package.json files, unpacked by the OS tar
//    (by absolute path) from stdin inside a scratch folder (no `-C`, #856). Read-only against the repository: no
//    worktree, ref or index. The scratch folder is taken in the file system's own spelling first (#646).
// 2. Each entry is bundled by apps/desktop's own vite (the app's build tool, found by an explicit path) in library
//    mode into one CommonJS file (no minify, no source map), with no node_modules. The only imports a bundle may keep
//    are `node:*` built-ins: a package, a bare built-in name such as `fs`, or `electron` fails the run, named with its
//    importer, and so does a `require`, `import()`, `process.getBuiltinModule` or `createRequire` handle that loads
//    anything but a `node:` literal, or a handle handed on. Every module must be a file of the tag's own tree, and no
//    file may be bundled twice under two spellings (#646). A reader that needs a package is the tag-tree `npm ci`
//    fallback, the orchestrator's call (app-update plan C4).
// 3. The bundle starts with a banner (tag, commit, vite version, entry); `<name>.provenance.json` beside it records the
//    same plus the vite path, the date, the Node version and the command. An existing bundle is never overwritten
//    unless `--force`, and then only when its bytes change (its provenance is rewritten with it, never alone).
//    `--check` rebuilds and compares with the committed bytes, writing nothing: the bundle's bytes depend only on the
//    tag and the vite version, so a rerun reproduces them.
//
// Not read from the tag: its `electron.vite.config.ts`. An alias there fails loudly (an unresolved import); a
// build-time `define` would not (it would stay a free name in the bundle). No tag defines one for src/main (checked at
// v0.1.66); a snapshot of a later reader must check again.
//
// How a test loads a snapshot: `createRequire(__filename)(<absolute path of the .cjs>)` and a type the test declares
// (tsconfig has no allowJs, so a static import of the .cjs would fail the typecheck). The snapshot runs on the test's
// own Node and node:sqlite, not on the tag's Electron.
//
// CI checks out one commit without tags, so the recipe runs on a developer box. CI checks the committed outputs through
// apps/desktop/tests/fixtures/golden-fixtures.sha256 (repo-hygiene.test.ts), and the gates through
// apps/desktop/tests/integration/release-scripts.test.ts.
//
// Exit codes: 0 ok · 1 the archive, a build or a check failed, an existing snapshot was refused, or `--check` found
// other bytes · 2 usage error.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RECIPE = 'scripts/release/snapshot-readers.mjs'
/** What a tag's archive holds: the app's sources and the files their transform reads (tsconfig, package type). */
const ARCHIVE_PATHS = ['package.json', 'apps/desktop/package.json', 'apps/desktop/tsconfig*.json', 'apps/desktop/src']
const TAG_NAME = /^v\d+\.\d+\.\d+$/

export class SnapshotError extends Error {}

/** Refuses a name that is not a release tag's (a path would also name folders outside the scratch folder). */
export function checkTagName(tag) {
  if (!TAG_NAME.test(tag)) throw new SnapshotError(`not a release tag name: ${tag}`)
  return tag
}

function git(args, options = {}) {
  const r = spawnSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 512 * 1024 * 1024, ...options })
  if (r.error) throw new SnapshotError(`git ${args[0]}: ${r.error.message}`)
  if (r.status !== 0) throw new SnapshotError(`git ${args.join(' ')} exited ${r.status}: ${String(r.stderr).trim()}`)
  return r.stdout
}

/** The tag's commit. Refuses a name that is not a tag (a branch or a sha would make the provenance lie). */
export function tagCommit(tag) {
  checkTagName(tag)
  git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { encoding: 'utf8' })
  return git(['rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
}

/** The OS tar by absolute path (C9's precedent): System32's bsdtar on Windows, /usr/bin/tar elsewhere. */
function osTar() {
  if (process.platform === 'win32') {
    if (!process.env.SystemRoot) throw new SnapshotError('SystemRoot is not set: no tar')
    return join(process.env.SystemRoot, 'System32', 'tar.exe')
  }
  if (!existsSync('/usr/bin/tar')) throw new SnapshotError('no /usr/bin/tar')
  return '/usr/bin/tar'
}

/** The tag's sources (ARCHIVE_PATHS) unpacked into `<work>/<tag>`, read only through `git archive`. */
export function exportTag(tag, work) {
  const commit = tagCommit(tag)
  const tree = join(realpathSync.native(work), tag) // the file system's own spelling before anything derives from it
  if (existsSync(tree)) throw new SnapshotError(`scratch tree already exists: ${tree}`)
  mkdirSync(tree, { recursive: true })
  const archive = git(['archive', '--format=tar', commit, '--', ...ARCHIVE_PATHS])
  const r = spawnSync(osTar(), ['-x', '-f', '-'], { cwd: tree, input: archive, maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new SnapshotError(`tar -x failed: ${r.error?.message ?? String(r.stderr).trim()}`)
  return { tree, commit }
}

/** A call's argument as written, when it is not exactly one `node:` string literal: `(?<![\w$])` keeps `nodeRequire`
 *  and `x.require` apart; `module.require(` is a `require(` here too. */
const NOT_A_NODE_LITERAL = String.raw`\s*\(\s*(?!["']node:[^"'\\]+["']\s*\))([^)]{0,80})\)?`

/**
 * Every way the bundle loads code that is not a `node:*` built-in: an import Rollup kept; a `require(`, `import(` or
 * `process.getBuiltinModule(` whose argument is not a `node:` literal; and the handles `createRequire(…)` returns, which
 * must be bound to a name (`const r = createRequire(…)`) and only ever called with a `node:` literal (review R-1: the
 * handle v0.1.60's db.ts calls for node:sqlite is the codebase's own idiom, and the old scan never judged it).
 */
export function foreignImportsIn(code, chunk) {
  const found = new Set([...chunk.imports, ...chunk.dynamicImports].filter((id) => !id.startsWith('node:')))
  for (const callee of ['require', 'import', String.raw`process\.getBuiltinModule`]) {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$])${callee}${NOT_A_NODE_LITERAL}`, 'g'))) {
      found.add(`${callee.replace('\\', '')}(${m[1]})`)
    }
  }
  // `const r = createRequire(…)`, also as Rollup prints it (`node_module.createRequire(…)`, `(0, m.createRequire)(…)`).
  const bound = [...code.matchAll(/(?<![\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*(?:0\s*,\s*)?(?:[A-Za-z_$][\w$]*\.)?createRequire\s*\)?\s*\(/g)]
  const uses = code.match(/(?<![\w$])createRequire(?![\w$])/g)?.length ?? 0
  if (uses !== bound.length) found.add(`a createRequire handle not bound to a name (${uses - bound.length} of ${uses})`)
  for (const name of new Set(bound.map((m) => m[1]))) {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}(?![\w$])`, 'g'))) {
      const after = code.slice(m.index + name.length)
      if (/(?:const|let|var)\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue // its binding
      if (/^\s*\(\s*["']node:[^"'\\]+["']\s*\)/.test(after)) continue // a call with a node: literal
      found.add(`${name}${after.split('\n')[0].slice(0, 40)} (a createRequire handle)`)
    }
  }
  return [...found]
}

/** apps/desktop's own vite, by explicit path: its node_modules first, then the workspace hoist (review R-7). */
export async function appVite() {
  const dir = ['apps/desktop/node_modules/vite', 'node_modules/vite'].find((d) => existsSync(join(REPO_ROOT, ...d.split('/'), 'package.json')))
  if (!dir) throw new SnapshotError("apps/desktop's vite is not installed (npm ci)")
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, ...dir.split('/'), 'package.json'), 'utf8'))
  const vite = await import(pathToFileURL(join(REPO_ROOT, ...dir.split('/'), pkg.exports['.'].import)).href)
  return { build: vite.build, version: vite.version, path: dir }
}

/** A module id's file in the file system's own spelling, or null for an id that is no file (path-casing.ts's rule). */
function fileOf(id) {
  if (id.startsWith('\0')) return null // vite's own virtual modules
  const file = id.includes('?') ? id.slice(0, id.indexOf('?')) : id
  if (!isAbsolute(file)) return null // an external by name, already judged by the resolver
  try {
    return realpathSync.native(file)
  } catch {
    return null
  }
}

const inside = (root, file) => {
  const rel = relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The one build both release scripts use: `entry` (a path inside `tree`, forward slashes) bundled by apps/desktop's vite
 * in library mode into one CommonJS file. `node:*` stays external; any other bare import goes to `resolveBare(source)`,
 * which returns the file to bundle or null (then it is foreign and the build fails, named with its importer). Then the
 * module ids are checked, as the app's build checks its own (path-casing.ts's `oneModulePerFile`, #646): no file
 * bundled twice under two spellings, and every file inside `tree` or `roots` (review R-2).
 */
export async function bundleCjs({ tree, entry, fileName, resolveBare = () => null, roots = [] }) {
  const { build, version, path } = await appVite()
  const base = realpathSync.native(tree)
  const allowed = [base, ...roots.map((r) => realpathSync.native(r))]
  const foreign = []
  let moduleIds = []
  const gate = {
    name: 'hilbertraum:release-gate',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('node:')) return { id: source, external: true }
      if (importer === undefined || source.startsWith('\0')) return null // the entry itself; vite's virtual modules
      if (source.startsWith('.') || isAbsolute(source)) return null // a file: judged by its id after the build
      const file = resolveBare(source)
      if (file) return file.split('\\').join('/') // vite's own id form; the file is judged by its id after the build
      foreign.push(`${source} (imported by ${relative(base, importer).split(sep).join('/')})`)
      return { id: source, external: true } // kept external so the build lists them all; the run fails below
    },
    buildEnd() {
      moduleIds = [...this.getModuleIds()]
    }
  }
  const result = await build({
    configFile: false,
    root: base,
    envDir: base,
    cacheDir: join(base, '.vite-cache'),
    publicDir: false,
    mode: 'production',
    logLevel: 'warn',
    plugins: [gate],
    build: {
      write: false,
      outDir: join(base, '.snapshot-out'),
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      target: 'node22',
      minify: false,
      sourcemap: false,
      lib: { entry: join(base, ...entry.split('/')), formats: ['cjs'], fileName: () => fileName },
      rollupOptions: { output: { exports: 'named', inlineDynamicImports: true } }
    }
  })
  const idsByFile = new Map()
  for (const id of moduleIds) {
    const file = fileOf(id)
    if (file === null) continue
    if (!allowed.some((root) => inside(root, file))) throw new SnapshotError(`${entry}: a module outside the tag's sources: ${file}`)
    idsByFile.set(file, [...(idsByFile.get(file) ?? []), id])
  }
  const split = [...idsByFile].filter(([, ids]) => ids.length > 1)
  if (split.length > 0) {
    throw new SnapshotError(`${entry}: the build bundled one file twice (#646): ${split.map(([file, ids]) => `${file} as ${ids.join(' and ')}`).join('; ')}`)
  }
  const outputs = [result].flat().flatMap((r) => r.output)
  if (outputs.length !== 1 || outputs[0].type !== 'chunk') {
    throw new SnapshotError(`${entry}: expected one chunk, got ${outputs.map((o) => o.fileName).join(', ')}`)
  }
  return { chunk: outputs[0], foreign, viteVersion: version, vitePath: path }
}

/**
 * Bundles `entry` (a path inside the tag's tree, forward slashes) under the reader rule: `node:*` built-ins only.
 * Returns the code with the banner, or throws a SnapshotError naming every import that is not node:*.
 */
export async function bundleEntry({ tag, commit, tree, entry, fileName }) {
  const { chunk, foreign, viteVersion, vitePath } = await bundleCjs({ tree, entry, fileName })
  const banner =
    `// Reader snapshot ${fileName}: ${entry} at ${tag} (${commit}),\n` +
    `// bundled by ${RECIPE} with vite ${viteVersion} in library mode (CommonJS, node:* imports only).\n` +
    `// Generated from the tag: never edit; rerun the recipe. Provenance: ${basename(fileName, '.cjs')}.provenance.json.`
  // The banner goes on after the build: lib mode's final esbuild pass reprints the chunk and drops every comment.
  const code = `${banner}\n${chunk.code}${chunk.code.endsWith('\n') ? '' : '\n'}`
  // The resolver's record names each import with its importer; the scan of the output is the backstop for anything
  // that reached the bundle another way (a `require` or a createRequire handle the tag's code calls itself).
  const bad = [...foreign, ...foreignImportsIn(code, chunk)]
  if (bad.length > 0) {
    throw new SnapshotError(
      `${entry} at ${tag} needs more than node:* built-ins: ${[...new Set(bad)].join('; ')}. ` +
        'A package is the tag-tree npm ci fallback (the orchestrator decides); it is never bundled from elsewhere.'
    )
  }
  if (code.includes('\0')) throw new SnapshotError(`${entry}: the bundle holds a NUL byte`)
  if (code.includes('\r')) throw new SnapshotError(`${entry}: the bundle holds a carriage return`)
  const local = [tree, realpathSync.native(tree), REPO_ROOT, tmpdir()]
    .flatMap((p) => [p, p.split('\\').join('/')])
    .map((p) => p.toLowerCase())
  const lower = code.toLowerCase()
  const leak = local.find((p) => lower.includes(p))
  if (leak) throw new SnapshotError(`${entry}: the bundle names a local path (${leak})`)
  return { code, viteVersion, vitePath }
}

/**
 * Writes one bundle into `outDir` under the overwrite rule (review R-6), and says what it did:
 * - no bundle there: `written` (bundle and provenance), or `missing` under `check`;
 * - a bundle there: `refused` without a flag (nothing is compared or written); under `force`, `unchanged` when the bytes
 *   are the same (nothing written: the provenance keeps its date) or `written` (both files); under `check`, `same` or
 *   `differs`, and nothing is ever written.
 */
export function writeSnapshot({ outDir, fileName, code, provenance, force, check }) {
  const bundlePath = join(outDir, fileName)
  const existing = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : null
  if (check) return existing === null ? 'missing' : existing === code ? 'same' : 'differs'
  if (existing !== null && !force) return 'refused'
  if (existing === code) return 'unchanged'
  writeFileSync(bundlePath, code)
  writeFileSync(join(outDir, `${basename(fileName, '.cjs')}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`)
  return 'written'
}

/** The output folder as the provenance names it: relative to the repository, forward slashes. */
function repoRelative(p) {
  const rel = relative(REPO_ROOT, resolve(p))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SnapshotError(`--out must be inside the repository: ${p}`)
  return rel.split('\\').join('/')
}

function parseArgs(argv) {
  const args = { tag: '', out: '', outRel: '', entries: [], work: '', keep: false, force: false, check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new SnapshotError(`${a} needs a value`)
      return v
    }
    if (a === '--tag') args.tag = checkTagName(value())
    else if (a === '--out') args.out = value()
    else if (a === '--work') args.work = value()
    else if (a === '--keep') args.keep = true
    else if (a === '--force') args.force = true
    else if (a === '--check') args.check = true
    else if (a === '--entry') {
      const [entry, fileName, ...rest] = value().split('=')
      if (!entry || !fileName || rest.length > 0 || !/^[a-z0-9][a-z0-9.-]*\.cjs$/.test(fileName) || entry.includes('\\')) {
        throw new SnapshotError(`--entry wants <path in the tag, forward slashes>=<name>.cjs, got ${argv[i]}`)
      }
      args.entries.push({ entry, fileName })
    } else throw new SnapshotError(`unknown argument ${a}`)
  }
  if (!args.tag || !args.out || args.entries.length === 0) throw new SnapshotError('--tag, --out and --entry are required')
  if (args.force && args.check) throw new SnapshotError('--force and --check exclude each other')
  args.outRel = repoRelative(args.out)
  return args
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    if (!(err instanceof SnapshotError)) throw err
    console.error(
      `${err.message}\nusage: node ${RECIPE} --tag <tag> --out <dir> --entry <path>=<name>.cjs [--entry …] [--force | --check] [--work <dir>] [--keep]`
    )
    return 2
  }
  const { outRel } = args
  if (args.work) mkdirSync(resolve(args.work), { recursive: true })
  const work = args.work ? realpathSync.native(resolve(args.work)) : realpathSync.native(mkdtempSync(join(tmpdir(), 'hr-snapshot-')))
  let created = args.work ? '' : work // only what this run made is removed
  let failed = false
  try {
    if (args.work && existsSync(join(work, args.tag))) throw new SnapshotError(`scratch tree already exists: ${join(work, args.tag)}`)
    if (args.work) created = join(work, args.tag)
    const { tree, commit } = exportTag(args.tag, work)
    const outDir = join(REPO_ROOT, ...outRel.split('/'))
    if (!args.check) mkdirSync(outDir, { recursive: true })
    const command = [`node ${RECIPE} --tag ${args.tag} --out ${outRel}`, ...args.entries.map((e) => `--entry ${e.entry}=${e.fileName}`)]
    for (const { entry, fileName } of args.entries) {
      const { code, viteVersion, vitePath } = await bundleEntry({ tag: args.tag, commit, tree, entry, fileName })
      const provenance = {
        bundle: fileName,
        entry,
        tag: args.tag,
        commit,
        bundler: `vite ${viteVersion} (library mode, CommonJS, node:* imports only)`,
        vite_path: vitePath,
        recipe: RECIPE,
        command: command.join(' '),
        node: process.version,
        created: new Date().toISOString(),
        runs_on: "the loading process's own Node and node:sqlite, not the tag's Electron"
      }
      const outcome = writeSnapshot({ outDir, fileName, code, provenance, force: args.force, check: args.check })
      const said = {
        written: 'written',
        unchanged: 'unchanged (the same bytes: nothing written)',
        same: 'the committed bytes are reproduced',
        refused: 'exists: refused (--check compares it, --force replaces it when its bytes change)',
        differs: 'differs from the committed bytes',
        missing: 'missing'
      }[outcome]
      if (['refused', 'differs', 'missing'].includes(outcome)) failed = true
      console.log(`${outRel}/${fileName}: ${entry} at ${args.tag} (${commit.slice(0, 12)}), vite ${viteVersion} (${vitePath}): ${said}`)
    }
    return failed ? 1 : 0
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
