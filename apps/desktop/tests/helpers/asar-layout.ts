import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * The `node_modules` layout that electron-builder 26 writes into `app.asar` (#548).
 *
 * electron-builder does not copy the lockfile layout. Its npm collector reads the production graph
 * from `npm list --omit dev` (one node per `name@version`, edges = `dependencies` +
 * `optionalDependencies`, children in npm's alphabetical order), re-hoists that graph with Yarn's
 * hoister, and copies every package to its hoisted destination. The `files:` negations are matched
 * against that destination, not the source path. So a package nested under a negated parent in the
 * lockfile moves to `node_modules/<name>` when only a dev package held that slot, and ships past the
 * parent's negation: master's `app.asar` carried `@antfu/install-pkg`'s `tinyexec` that way until
 * #536. `packedNodeModules` replays those steps on `package-lock.json` with electron-builder's own
 * hoister, so the gate sees what `npm run package` packs.
 *
 * The child order matters: the hoister breaks ties by it. `marked` was one until streamdown 2.6
 * dropped mermaid (#550): streamdown needed 17.x and mermaid 16.x, one dependent each; in npm's
 * order 17.x took the top slot and mermaid's copy stayed nested under the negated `mermaid/`, in
 * the reverse order 16.x would have shipped.
 *
 * Checked against a real `package:win` `app.asar` (master `12ec7bd0`, 2026-10-02): the model names
 * its 226 package directories exactly. Platform-specific optional packages are all modelled (only
 * the negated `@napi-rs/canvas-*` variants exist today, so every build host packs the same layout).
 */

/** A `package-lock.json` v3 `packages` entry — the fields the packaging gates read. */
export interface LockPackage {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  dev?: boolean
}

export type LockPackages = Record<string, LockPackage>

/** Node's resolution over lockfile paths: the nearest `node_modules/<name>` above `fromPath`. */
export function resolveLockPath(packages: LockPackages, fromPath: string, name: string): string | null {
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

/** `node_modules/a/node_modules/@s/b` → `@s/b@1.2.3`: the identity electron-builder collects by. */
export function lockId(packages: LockPackages, lockPath: string): string {
  return `${lockPath.replace(/^.*node_modules\//, '')}@${packages[lockPath]?.version ?? 'unknown'}`
}

/** One package as electron-builder packs it: its directory inside `app.asar`, and `name@version`. */
export interface PackedPackage {
  dest: string
  id: string
}

// The hoister's input and output, as far as this model uses them
// (`app-builder-lib/out/node-module-collector/hoist.d.ts`).
interface HoisterTree {
  name: string
  identName: string
  reference: string
  dependencies: Set<HoisterTree>
  peerNames: Set<string>
}
interface HoisterResult {
  name: string
  references: Set<string>
  dependencies: Set<HoisterResult>
}

/** Resolve modules the way `npm run package` does: from the electron-builder this app installs. */
function builderRequire(): NodeJS.Require {
  const appRequire = createRequire(join(__dirname, '..', '..', 'package.json'))
  const builder = createRequire(appRequire.resolve('electron-builder/package.json'))
  return createRequire(builder.resolve('app-builder-lib/package.json'))
}

/** `@s/b@1.2.3` → name + version, as electron-builder's `parseNameVersion` splits it. */
function splitId(id: string): { name: string; version: string } {
  const at = id.startsWith('@') ? id.indexOf('@', id.indexOf('/') + 1) : id.indexOf('@')
  return at <= 0 ? { name: id, version: 'unknown' } : { name: id.slice(0, at), version: id.slice(at + 1) }
}

/** The packages electron-builder packs for the app at `appPath`, at their `app.asar` destinations. */
export function packedNodeModules(packages: LockPackages, appPath = 'apps/desktop'): PackedPackage[] {
  const { hoist } = builderRequire()('./out/node-module-collector/hoist') as {
    hoist: (tree: HoisterTree) => HoisterResult
  }
  // npm list orders every node's children with this collator (`@isaacs/string-locale-compare`).
  const npmOrder = new Intl.Collator('en').compare
  const byNpmOrder = (a: string, b: string): number => npmOrder(lockId(packages, a), lockId(packages, b))

  // 1. The production graph, keyed `name@version`; the first copy reached defines a node's edges.
  const graph = new Map<string, string[]>()
  const children = (lockPath: string): string[] => {
    const entry = packages[lockPath] ?? {}
    return Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })
      .map((name) => resolveLockPath(packages, lockPath, name))
      .filter((p): p is string => p !== null)
      .sort(byNpmOrder)
  }
  const visit = (lockPath: string): string => {
    const id = lockId(packages, lockPath)
    if (graph.has(id)) return id
    const edges: string[] = []
    graph.set(id, edges)
    for (const child of children(lockPath)) edges.push(visit(child))
    return id
  }
  const rootId = packages[appPath]?.name ?? appPath
  graph.set(rootId, children(appPath).map(visit))

  // 2. The hoister's tree: no self-edges (a package that lists itself), as electron-builder builds it.
  const nodes = new Map<string, HoisterTree>()
  const toTree = (id: string): HoisterTree => {
    const existing = nodes.get(id)
    if (existing) return existing
    const { name, version } = splitId(id)
    const node: HoisterTree = { name, identName: name, reference: version, dependencies: new Set(), peerNames: new Set() }
    nodes.set(id, node)
    for (const dep of graph.get(id) ?? []) {
      const child = toTree(dep)
      if (child !== node) node.dependencies.add(child)
    }
    return node
  }

  // 3. Destinations: a hoisted child of the root is `node_modules/<name>`, a nested one sits under
  //    its parent's destination; a cycle back to an ancestor is skipped, as in electron-builder.
  const packed: PackedPackage[] = []
  const walk = (deps: Set<HoisterResult>, prefix: string, ancestors: Set<HoisterResult>): void => {
    for (const d of deps) {
      if (ancestors.has(d)) continue
      const dest = `${prefix}node_modules/${d.name}`
      packed.push({ dest, id: `${d.name}@${[...d.references][0]}` })
      ancestors.add(d)
      walk(d.dependencies, `${dest}/`, ancestors)
      ancestors.delete(d)
    }
  }
  walk(hoist(toTree(rootId)).dependencies, '', new Set())
  return packed
}

/** The package directories in a real `app.asar` (`node_modules/a`, `node_modules/a/node_modules/@s/b`). */
export function asarPackageDirs(asarPath: string): string[] {
  const { listPackage } = builderRequire()('@electron/asar') as {
    listPackage: (archive: string, options: { isPack: boolean }) => string[]
  }
  const chain = /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/
  return listPackage(asarPath, { isPack: false })
    .map((p) => p.replace(/\\/g, '/').replace(/^\//, ''))
    .filter((p) => p.endsWith('/package.json'))
    .map((p) => p.slice(0, -'/package.json'.length))
    .filter((dir) => chain.test(dir))
    .sort()
}
