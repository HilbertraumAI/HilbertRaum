// Shared computation of the npm packages that SHIP in a packaged HilbertRaum artifact
// (LIC-2, full-audit 2026-07-12). Used by BOTH:
//   - scripts/generate-third-party-notices.mjs  (writes THIRD-PARTY-NOTICES.md)
//   - apps/desktop/tests/integration/third-party-notices.test.ts  (freshness gate)
// so the notices file and the gate can never disagree about what "shipped" means.
//
// What ships (see apps/desktop/electron-builder.yml + docs/packaging.md):
//   app.asar = the production dependency closure of apps/desktop (electron-builder's
//   collector walks package-lock.json exactly like npm's node_modules resolution),
//   MINUS the `files:` negation globs in electron-builder.yml (the never-imported
//   mermaid chain + the @napi-rs/canvas native optional dep). The Vite-compiled
//   renderer/main bundles inline a SUBSET of those same production dependencies
//   (react, katex, streamdown, …), so the closure already covers them.
//
// The closure walk mirrors prodClosure() in apps/desktop/tests/integration/
// packaging.test.ts (which keeps the yml negations honest against the lockfile);
// if you change the resolution semantics here, check that test's copy too.
//
// Deliberately OUT of scope (not "bundled npm deps"):
//   - Electron itself: electron-builder ships Electron's own LICENSE.electron.txt +
//     LICENSES.chromium.html beside the executable.
//   - devDependency toolchain (vite, vitest, electron-builder, typescript, …): build
//     tools, nothing of theirs lands in the artifact.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * Renderer-bundled libraries that are devDependencies (would ship via the Vite bundle
 * WITHOUT being in the production closure). Derived 2026-07-12 by scanning every bare
 * import in apps/desktop/src/renderer + src/shared + src/main + src/preload: every
 * runtime import resolves to a production `dependency` of apps/desktop, so this list
 * is EMPTY. If a devDependency ever starts being imported by shipped code, add it here
 * (name only; the installed version is resolved from the lockfile) and regenerate.
 */
export const RENDERER_BUNDLED_DEV_DEPS = []

/** Minimatch-style files glob -> coarse RegExp (same rules as packaging.test.ts). */
function globToRegExp(glob) {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*') +
      '$'
  )
}

/**
 * Walk the production dependency graph of apps/desktop over package-lock entries,
 * exactly like electron-builder's collector (npm node_modules resolution).
 * Returns the set of lockfile paths ("node_modules/foo", "apps/desktop/node_modules/katex", …).
 */
function prodClosure(packages) {
  const resolveDep = (fromPath, name) => {
    let p = fromPath
    for (;;) {
      const cand = (p ? p + '/' : '') + 'node_modules/' + name
      if (packages[cand]) return cand
      const i = p.lastIndexOf('/node_modules/')
      if (i === -1) {
        const root = 'node_modules/' + name
        return p !== '' && packages[root] ? root : null
      }
      p = p.slice(0, i)
    }
  }
  const rootDeps = packages['apps/desktop']?.dependencies ?? {}
  const seen = new Set()
  const queue = []
  for (const d of Object.keys(rootDeps)) {
    const r = resolveDep('apps/desktop', d)
    if (r) queue.push(r)
  }
  while (queue.length > 0) {
    const cur = queue.pop()
    if (seen.has(cur)) continue
    seen.add(cur)
    const entry = packages[cur]
    const deps = { ...entry.dependencies, ...entry.optionalDependencies }
    for (const d of Object.keys(deps)) {
      const r = resolveDep(cur, d)
      if (r && !seen.has(r)) queue.push(r)
    }
  }
  return seen
}

/**
 * Compute the shipped package set for a packaged artifact.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {Array<{ name: string, version: string, lockPath: string }>}
 *   sorted by name (then version), deduplicated by name@version. `lockPath` is the
 *   lockfile/node_modules path of one physical copy (for reading license files).
 */
export function computeShippedPackages(repoRoot) {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const builder = parse(
    readFileSync(join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8')
  )
  const negations = (builder.files ?? [])
    .filter((f) => typeof f === 'string' && f.startsWith('!'))
    .map((f) => globToRegExp(f.slice(1)))

  const closure = prodClosure(lock.packages)
  const shippedPaths = [...closure].filter(
    // A package is excluded when a files negation covers its directory content
    // (probe with a representative file path, as packaging.test.ts does).
    (p) => !negations.some((rx) => rx.test(p + '/x.js'))
  )

  for (const name of RENDERER_BUNDLED_DEV_DEPS) {
    const direct = `node_modules/${name}`
    const nested = `apps/desktop/node_modules/${name}`
    const found = lock.packages[nested] ? nested : lock.packages[direct] ? direct : null
    if (!found) throw new Error(`RENDERER_BUNDLED_DEV_DEPS entry not in lockfile: ${name}`)
    shippedPaths.push(found)
  }

  const byId = new Map()
  for (const p of shippedPaths) {
    const name = p.replace(/^.*node_modules\//, '')
    const version = lock.packages[p].version
    if (!version) throw new Error(`lockfile entry has no version: ${p}`)
    const id = `${name}@${version}`
    if (!byId.has(id)) byId.set(id, { name, version, lockPath: p })
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
}
