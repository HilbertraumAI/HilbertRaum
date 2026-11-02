// Shared computation of the npm packages that SHIP in a packaged HilbertRaum artifact
// (LIC-2, full-audit 2026-07-12). Used by BOTH:
//   - scripts/generate-third-party-notices.mjs  (writes THIRD-PARTY-NOTICES.md)
//   - apps/desktop/tests/integration/third-party-notices.test.ts  (freshness gate)
// so the notices file and the gate can never disagree about what "shipped" means.
//
// What ships (see apps/desktop/electron-builder.yml + docs/packaging.md):
//   app.asar = the production dependency closure of apps/desktop (this walk follows npm's
//   node_modules resolution over package-lock.json; electron-builder's collector reads
//   `npm list` and re-hoists, see #548 below),
//   MINUS the `files:` negation globs in electron-builder.yml (the @napi-rs/canvas
//   native optional dep, pdfjs-dist's standard fonts). The Vite-compiled
//   renderer/main bundles inline a SUBSET of those same production dependencies
//   (react, katex, streamdown, …), so the closure already covers them.
//
// The negations are matched against lockfile paths here, but electron-builder applies them to
// the RE-HOISTED layout it packs, where a nested package can move to the top level (#548).
// third-party-notices.test.ts checks that this set equals the packed one, so a package that
// escapes a negation fails the gate instead of shipping without its notice.
//
// Deliberately OUT of scope (not "bundled npm deps"):
//   - Electron itself: electron-builder ships Electron's own LICENSE.electron.txt +
//     LICENSES.chromium.html beside the executable.
//   - devDependency toolchain (vite, vitest, electron-builder, typescript, …): build
//     tools, nothing of theirs lands in the artifact.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

// Only the production closure ships. The renderer bundle inlines whatever it imports, so a devDependency imported by
// shipped code would reach users with no notice: such a package must become a production dependency of apps/desktop.
// third-party-notices.test.ts "shipped source imports only…" fails until it has.

// Minimatch-style files glob -> coarse RegExp: two stars and a slash match any directory prefix, two stars anything, a
// single star one path segment. Enough for the node_modules shapes in electron-builder.yml, not a full minimatch, and
// packaging.test.ts refuses any other shape. tests/helpers/globs.ts re-exports this one.
export function globToRegExp(glob) {
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
 * The `files:` negations of apps/desktop/electron-builder.yml as RegExps over repo-relative
 * POSIX paths (`node_modules/pdfjs-dist/standard_fonts/x.ttf`). A path that matches one does
 * not ship in app.asar — a whole package, or part of one.
 */
export function builderFileNegations(repoRoot) {
  const builder = parse(
    readFileSync(join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8')
  )
  return (builder.files ?? [])
    .filter((f) => typeof f === 'string' && f.startsWith('!'))
    .map((f) => globToRegExp(f.slice(1)))
}

/**
 * Walk the production dependency graph of apps/desktop over package-lock entries
 * (npm's node_modules resolution).
 * Returns the set of lockfile paths ("node_modules/foo", "node_modules/katex/node_modules/commander", …).
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
    // TQ-3 (full-audit 2026-07-12b): fold NON-OPTIONAL peerDependencies into the walk:
    // npm 7+ auto-installs them. electron-builder's collector does not follow peer edges
    // (it reads `_dependencies`, which `npm list` fills from dependencies +
    // optionalDependencies), so a package reached only as a peer is listed here and not
    // packed, and third-party-notices.test.ts "names exactly the packages…" goes red.
    // Peers flagged optional in peerDependenciesMeta are NOT auto-installed and stay out.
    // Verified 2026-07-12: every required peer of the current shipped set is already in
    // the closure, so this changes nothing today (regeneration stays byte-identical).
    for (const d of Object.keys(entry.peerDependencies ?? {})) {
      if (!entry.peerDependenciesMeta?.[d]?.optional) deps[d] = true
    }
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
 * @returns {Array<{ name: string, version: string, lockPath: string, lockLicense: string | null }>}
 *   sorted by name (then version), deduplicated by name@version. `lockPath` is the
 *   lockfile/node_modules path of one physical copy (for reading license files);
 *   `lockLicense` is the lockfile entry's license identifier, the fallback when the
 *   package is not installed on this host (REL-2, full-audit 2026-07-12b).
 */
export function computeShippedPackages(repoRoot) {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const negations = builderFileNegations(repoRoot)

  const closure = prodClosure(lock.packages)
  const shippedPaths = [...closure].filter(
    // A package is excluded when a files negation covers its directory content
    // (probe with a representative file path, as packaging.test.ts does).
    (p) => !negations.some((rx) => rx.test(p + '/x.js'))
  )

  const byId = new Map()
  for (const p of shippedPaths) {
    const name = p.replace(/^.*node_modules\//, '')
    const version = lock.packages[p].version
    if (!version) throw new Error(`lockfile entry has no version: ${p}`)
    const id = `${name}@${version}`
    if (!byId.has(id)) {
      byId.set(id, { name, version, lockPath: p, lockLicense: lock.packages[p].license ?? null })
    }
  }
  // Code-unit comparison (codepoint order for these ASCII names), NOT localeCompare
  // (REL-1, full-audit 2026-07-12b): this order feeds a byte-exact drift gate
  // (apps/desktop/tests/integration/third-party-notices.test.ts), and no-locale
  // localeCompare uses the HOST ICU collation (dev = de-AT, CI = en/C), whose punctuation
  // handling (`@ / - .`) is not guaranteed stable across ICU versions. Probed 2026-07-12:
  // the current 226-name set orders identically either way, so this changes nothing
  // today — but code-unit order can never drift with the host.
  const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  return [...byId.values()].sort(
    (a, b) => byCodepoint(a.name, b.name) || byCodepoint(a.version, b.version)
  )
}
