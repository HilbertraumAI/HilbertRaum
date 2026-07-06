import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

// L18 (audit-2026-06-13): @napi-rs/canvas is an OPTIONAL transitive dep of pdfjs-dist —
// a platform-specific native `.node` (Skia) the app never imports. With
// `includeSubNodeModules: true`, electron-builder would otherwise follow the hoisted
// dependency tree and bundle the win32 `.node` into app.asar, breaking the pure-JS /
// cross-OS portable posture (a Windows binary shipped on a macOS/Linux drive). The
// exclusion is invisible until release packaging, so guard it here in the green gate.

const BUILDER_YML = join(__dirname, '..', '..', 'electron-builder.yml')
const LOCKFILE = join(__dirname, '..', '..', '..', '..', 'package-lock.json')

interface BuilderConfig {
  files?: string[]
  asarUnpack?: string[]
  includeSubNodeModules?: boolean
}

function loadBuilderConfig(): BuilderConfig {
  return parse(readFileSync(BUILDER_YML, 'utf8')) as BuilderConfig
}

/** Translate a minimatch-style files glob to a coarse RegExp (same rules as the L18 test below). */
function globToRegExp(glob: string): RegExp {
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

interface LockPackage {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dev?: boolean
}

/**
 * Walk the production dependency graph of apps/desktop exactly like electron-builder's
 * collector would (npm's node_modules resolution over package-lock entries), optionally
 * refusing to step INTO `mermaid`. The difference between the two closures is the set of
 * packages that exist ONLY because of mermaid.
 */
function prodClosure(packages: Record<string, LockPackage>, skipMermaid: boolean): Set<string> {
  const resolveDep = (fromPath: string, name: string): string | null => {
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
  const seen = new Set<string>()
  const queue: string[] = []
  for (const d of Object.keys(rootDeps)) {
    const r = resolveDep('apps/desktop', d)
    if (r) queue.push(r)
  }
  while (queue.length > 0) {
    const cur = queue.pop()!
    if (seen.has(cur)) continue
    if (skipMermaid && cur.replace(/^.*node_modules\//, '') === 'mermaid') continue
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

describe('electron-builder packaging excludes the @napi-rs/canvas native binary (L18)', () => {
  it('has a files glob that negates every @napi-rs/canvas variant', () => {
    const cfg = loadBuilderConfig()
    expect(Array.isArray(cfg.files)).toBe(true)
    const files = cfg.files ?? []

    // The exclusion must be a negation glob ("!...") that matches the canvas package
    // and all its per-platform siblings (@napi-rs/canvas-win32-x64-msvc, -darwin-*, …).
    const exclusion = files.find(
      (f) => f.startsWith('!') && /@napi-rs\/canvas/.test(f)
    )
    expect(exclusion, 'expected a "!**/@napi-rs/canvas*/**"-style exclusion in files').toBeTruthy()
    expect(exclusion).toContain('@napi-rs/canvas')
    // A trailing `*` after `canvas` so the platform-suffixed packages are caught too.
    expect(exclusion).toMatch(/@napi-rs\/canvas\*/)
  })

  it('the exclusion glob actually matches the platform-specific native package paths', () => {
    const cfg = loadBuilderConfig()
    const exclusion = (cfg.files ?? []).find(
      (f) => f.startsWith('!') && /@napi-rs\/canvas/.test(f)
    )!
    // Translate the (minimatch-style) glob to a coarse RegExp and prove it covers the
    // real hoisted paths electron-builder would walk.
    const body = exclusion.slice(1) // drop the leading "!"
    const rx = new RegExp(
      '^' +
        body
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          // `**/` matches zero or more leading path segments (minimatch globstar)…
          .replace(/\*\*\//g, '(?:.*/)?')
          // …a bare `**` matches anything…
          .replace(/\*\*/g, '.*')
          // …and a single `*` matches within one segment.
          .replace(/(?<!\.)\*/g, '[^/]*') +
        '$'
    )
    for (const p of [
      'node_modules/@napi-rs/canvas/index.js',
      'node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
      'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
      'apps/desktop/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node'
    ]) {
      expect(rx.test(p), `exclusion should match ${p}`).toBe(true)
    }
  })
})

// streamdown hard-depends on mermaid, but the @streamdown/mermaid plugin is not installed, so
// the whole ~136 MB mermaid/cytoscape/d3/dagre/roughjs chain is never imported. Vite keeps it
// out of the renderer bundle; only electron-builder's app.asar collection would ship it. The
// yml negates the chain — these tests keep the negations HONEST against package-lock.json:
// mermaid must stay excluded, and nothing excluded may be needed by the production graph
// outside mermaid (if a future dep starts using e.g. dayjs, the negation must be removed —
// this goes red instead of the packaged app silently missing a runtime dep).
describe('electron-builder packaging excludes the never-imported mermaid chain', () => {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as {
    packages: Record<string, LockPackage>
  }
  const negations = (loadBuilderConfig().files ?? [])
    .filter((f) => f.startsWith('!') && !f.includes('@napi-rs'))
    .map((f) => globToRegExp(f.slice(1)))

  it('mermaid itself and its parser are negated', () => {
    for (const p of ['node_modules/mermaid/dist/mermaid.js', 'node_modules/@mermaid-js/parser/x.js']) {
      expect(
        negations.some((rx) => rx.test(p)),
        `expected a files negation covering ${p}`
      ).toBe(true)
    }
  })

  it('every mermaid-only package in the lockfile is covered by a negation', () => {
    const withMermaid = prodClosure(lock.packages, false)
    const withoutMermaid = prodClosure(lock.packages, true)
    const mermaidOnly = [...withMermaid].filter((p) => !withoutMermaid.has(p))
    expect(mermaidOnly.length).toBeGreaterThan(50) // sanity: the chain is really in the lock
    const uncovered = mermaidOnly.filter((p) => !negations.some((rx) => rx.test(p + '/x.js')))
    expect(uncovered, 'mermaid-only packages missing a files negation').toEqual([])
  })

  it('no negation covers a package the production graph needs WITHOUT mermaid', () => {
    const withoutMermaid = prodClosure(lock.packages, true)
    const wronglyExcluded = [...withoutMermaid].filter((p) =>
      negations.some((rx) => rx.test(p + '/x.js'))
    )
    expect(
      wronglyExcluded,
      'these packages are needed by the production graph but excluded from app.asar — remove their negation'
    ).toEqual([])
  })
})
