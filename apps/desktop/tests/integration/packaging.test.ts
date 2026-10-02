import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
// The glob → RegExp translation is shared with asar-unpack-closure.test.ts (#232).
import { globToRegExp } from '../helpers/globs'
import {
  asarPackageDirs,
  lockId,
  packedNodeModules,
  resolveLockPath,
  type LockPackages,
  type PackedPackage
} from '../helpers/asar-layout'

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
  productName?: string
  executableName?: string
  win?: { executableName?: string }
  mac?: { executableName?: string }
  linux?: { executableName?: string }
  portable?: { executableName?: string; artifactName?: string }
  // Deliberately loose: a YAML scalar like `43.0` parses as a NUMBER, and the DEP-4 parity
  // test below must be able to CATCH that mistake rather than be typed out of it.
  electronVersion?: string | number
}

function loadBuilderConfig(): BuilderConfig {
  return parse(readFileSync(BUILDER_YML, 'utf8')) as BuilderConfig
}

/**
 * Walk the production dependency graph of apps/desktop over package-lock entries (npm's
 * node_modules resolution), optionally refusing to step INTO `mermaid`. The difference between
 * the two closures is the set of packages that exist ONLY because of mermaid. It answers WHICH
 * packages ship; WHERE electron-builder puts them is `packedNodeModules` (#548).
 */
function prodClosure(packages: LockPackages, skipMermaid: boolean): Set<string> {
  const rootDeps = packages['apps/desktop']?.dependencies ?? {}
  const seen = new Set<string>()
  const queue: string[] = []
  for (const d of Object.keys(rootDeps)) {
    const r = resolveLockPath(packages, 'apps/desktop', d)
    if (r) queue.push(r)
  }
  while (queue.length > 0) {
    const cur = queue.pop()!
    if (seen.has(cur)) continue
    if (skipMermaid && cur.replace(/^.*node_modules\//, '') === 'mermaid') continue
    seen.add(cur)
    const entry = packages[cur]
    const deps = { ...entry.dependencies, ...entry.optionalDependencies }
    // Keep the mirror with scripts/lib/shipped-packages.mjs exact: that walk folds
    // NON-OPTIONAL peerDependencies (TQ-3, full-audit 2026-07-12b), so this copy must too,
    // or the two closures silently disagree about what ships.
    for (const d of Object.keys(entry.peerDependencies ?? {})) {
      if (!entry.peerDependenciesMeta?.[d]?.optional) deps[d] = d
    }
    for (const d of Object.keys(deps)) {
      const r = resolveLockPath(packages, cur, d)
      if (r && !seen.has(r)) queue.push(r)
    }
  }
  return seen
}

/** Lockfile paths → their `name@version` identities (several copies may share one). */
function idsOf(packages: LockPackages, lockPaths: Set<string>): Set<string> {
  return new Set([...lockPaths].map((p) => lockId(packages, p)))
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

// Wave DEP-6: pdfjs-dist's standard_fonts/ does not ship. pdf.js reads those files only
// through `standardFontDataUrl`, which the app never sets, and the LiberationSans files in
// it are Liberation 1.07.4 under GPL v2 with a physical-product clause (pdfjs-dist 6.3
// corrected their notice from OFL). Starting to load standard fonts means revisiting both.
describe('electron-builder packaging excludes pdfjs-dist standard fonts', () => {
  const exclusion = (loadBuilderConfig().files ?? []).find(
    (f) => f.startsWith('!') && f.includes('pdfjs-dist/standard_fonts')
  )

  it('negates standard_fonts/ and nothing else of pdfjs-dist', () => {
    expect(exclusion, 'expected a "!**/node_modules/pdfjs-dist/standard_fonts/**" exclusion').toBeTruthy()
    const rx = globToRegExp(exclusion!.slice(1))
    for (const p of [
      'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
      'node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
      'node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION'
    ]) {
      expect(rx.test(p), `should exclude ${p}`).toBe(true)
    }
    for (const p of [
      'node_modules/pdfjs-dist/package.json',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/wasm/openjpeg.wasm',
      'node_modules/pdfjs-dist/cmaps/Identity-H.bcmap'
    ]) {
      expect(rx.test(p), `should keep ${p}`).toBe(false)
    }
  })

  it('the app never points pdf.js at standard fonts (the exclusion is only safe while so)', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs|js|html)$/.test(e.name) && /standardFontDataUrl|standard_fonts/.test(readFileSync(p, 'utf8'))) {
          offenders.push(p)
        }
      }
    }
    walk(join(__dirname, '..', '..', 'src'))
    expect(offenders).toEqual([])
  })
})

// streamdown hard-depends on mermaid, but the @streamdown/mermaid plugin is not installed, so
// the whole ~136 MB mermaid/cytoscape/d3/dagre/roughjs chain is never imported. Vite keeps it
// out of the renderer bundle; only electron-builder's app.asar collection would ship it. The
// yml negates the chain — these tests keep the negations HONEST against package-lock.json:
// mermaid must stay excluded, and nothing excluded may be needed by the production graph
// outside mermaid (if a future dep starts using e.g. dayjs, the negation must be removed —
// this goes red instead of the packaged app silently missing a runtime dep).
//
// #548: both checks run where electron-builder PACKS each package, not at its lockfile path. The
// collector re-hoists the production graph and applies the negations there, so a package nested
// under a negated parent can land at `node_modules/<name>` and ship past the parent's negation
// (`tinyexec`, until #536). `packedNodeModules` (tests/helpers/asar-layout.ts) replays it.
describe('electron-builder packaging excludes the never-imported mermaid chain', () => {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as { packages: LockPackages }
  const negations = (loadBuilderConfig().files ?? [])
    .filter((f) => f.startsWith('!') && !f.includes('@napi-rs'))
    .map((f) => globToRegExp(f.slice(1)))
  const negated = (dir: string): boolean => negations.some((rx) => rx.test(dir + '/x.js'))
  const needed = idsOf(lock.packages, prodClosure(lock.packages, true))
  const mermaidOnly = new Set(
    [...idsOf(lock.packages, prodClosure(lock.packages, false))].filter((id) => !needed.has(id))
  )
  const packed = packedNodeModules(lock.packages)
  const label = (p: PackedPackage): string => `${p.dest} (${p.id})`

  it('mermaid itself and its parser are negated', () => {
    for (const p of ['node_modules/mermaid/dist/mermaid.js', 'node_modules/@mermaid-js/parser/x.js']) {
      expect(
        negations.some((rx) => rx.test(p)),
        `expected a files negation covering ${p}`
      ).toBe(true)
    }
  })

  it('every mermaid-only package is negated where app.asar would hold it (#548)', () => {
    expect(mermaidOnly.size).toBeGreaterThan(50) // sanity: the chain is really in the lock
    const shipped = packed.filter((p) => mermaidOnly.has(p.id) && !negated(p.dest))
    expect(
      shipped.map(label),
      'mermaid-only packages that app.asar would ship — negate each one by its own name'
    ).toEqual([])
  })

  it('no negation removes a package the production graph needs WITHOUT mermaid', () => {
    const wronglyExcluded = packed.filter((p) => needed.has(p.id) && negated(p.dest))
    expect(
      wronglyExcluded.map(label),
      'these packages are needed by the production graph but excluded from app.asar — remove their negation'
    ).toEqual([])
  })
})

// #548: the layout model itself. The two fixtures are the shapes that decide where a nested
// package lands; the last check compares the model with a real build when one is pointed at.
describe('the app.asar layout model (#548)', () => {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as { packages: LockPackages }

  it('hoists a nested package to the top when only a dev package held that slot (the tinyexec escape)', () => {
    // The pre-#536 shape: vitest 3's tinyexec 0.3 held the top-level slot, so @antfu/install-pkg's
    // 1.2.4 sat nested under the negated `@antfu/` in the lockfile.
    const packages: LockPackages = {
      'apps/desktop': { name: 'app', dependencies: { streamdown: '^1.0.0' } },
      'node_modules/streamdown': { version: '1.0.0', dependencies: { mermaid: '^1.0.0' } },
      'node_modules/mermaid': { version: '1.0.0', dependencies: { '@antfu/install-pkg': '^1.0.0' } },
      'node_modules/@antfu/install-pkg': { version: '1.0.0', dependencies: { tinyexec: '^1.0.0' } },
      'node_modules/@antfu/install-pkg/node_modules/tinyexec': { version: '1.2.4' },
      'node_modules/tinyexec': { version: '0.3.2', dev: true }
    }
    const antfu = globToRegExp('**/node_modules/@antfu/**')
    // What the lockfile-path check saw…
    expect(antfu.test('node_modules/@antfu/install-pkg/node_modules/tinyexec/x.js')).toBe(true)
    // …and where electron-builder put it.
    const tinyexec = packedNodeModules(packages).find((p) => p.id === 'tinyexec@1.2.4')
    expect(tinyexec?.dest).toBe('node_modules/tinyexec')
    expect(antfu.test(`${tinyexec?.dest}/x.js`)).toBe(false)
  })

  it('keeps a conflicting copy nested under its parent', () => {
    const packages: LockPackages = {
      'apps/desktop': { name: 'app', dependencies: { streamdown: '^1.0.0', 'react-markdown': '^1.0.0' } },
      'node_modules/streamdown': { version: '1.0.0', dependencies: { marked: '^17.0.0', mermaid: '^1.0.0' } },
      'node_modules/react-markdown': { version: '1.0.0', dependencies: { marked: '^17.0.0' } },
      'node_modules/marked': { version: '17.0.6' },
      'node_modules/mermaid': { version: '1.0.0', dependencies: { marked: '^16.0.0' } },
      'node_modules/mermaid/node_modules/marked': { version: '16.4.2' }
    }
    const dests = Object.fromEntries(packedNodeModules(packages).map((p) => [p.id, p.dest]))
    expect(dests['marked@17.0.6']).toBe('node_modules/marked')
    expect(dests['marked@16.4.2']).toBe('node_modules/mermaid/node_modules/marked')
  })

  it('places only packages of the production graph', () => {
    const all = idsOf(lock.packages, prodClosure(lock.packages, false))
    const packed = packedNodeModules(lock.packages)
    expect(packed.length).toBeGreaterThan(200)
    expect(packed.filter((p) => !all.has(p.id)).map((p) => p.id)).toEqual([])
  })

  // Run it after a package build:
  // HILBERTRAUM_PACKED_ASAR=release/win-unpacked/resources/app.asar npm test -- tests/integration/packaging.test.ts
  const packedAsar = process.env.HILBERTRAUM_PACKED_ASAR
  it.skipIf(!packedAsar)('names exactly the package directories of a real app.asar', () => {
    const negations = (loadBuilderConfig().files ?? [])
      .filter((f) => f.startsWith('!'))
      .map((f) => globToRegExp(f.slice(1)))
    const predicted = packedNodeModules(lock.packages)
      .map((p) => p.dest)
      .filter((dest) => !negations.some((rx) => rx.test(dest + '/x.js')))
    expect(asarPackageDirs(resolve(__dirname, '..', '..', packedAsar!))).toEqual(
      [...new Set(predicted)].sort()
    )
  })
})

// CODE-1 (full-audit 2026-07-12b): `npm run preview:build` / `screenshot` emit the dev-only
// screenshot-verify preview harness (incl. staged demo chats) to out/preview/, and
// `electron-vite build` clears only out/main|preload|renderer — without a negation a local
// `npm run package` after a screenshot run folds the whole harness into app.asar (dead weight
// plus a discoverable staged demo chat inside a released artifact). Pin the negation the same
// way the mermaid block is pinned: it must exist AND actually match the harness output paths
// while leaving the real out/main|preload|renderer bundles packaged.
describe('electron-builder packaging excludes the dev-only preview harness (CODE-1)', () => {
  it('negates out/preview and only out/preview', () => {
    const files = loadBuilderConfig().files ?? []
    const exclusion = files.find((f) => f.startsWith('!') && f.includes('out/preview'))
    expect(exclusion, 'expected a "!out/preview/**" exclusion in files').toBeTruthy()
    const rx = globToRegExp(exclusion!.slice(1))
    for (const p of ['out/preview/preview.html', 'out/preview/assets/preview-x.js']) {
      expect(rx.test(p), `exclusion should match ${p}`).toBe(true)
    }
    for (const p of ['out/main/index.mjs', 'out/preload/index.mjs', 'out/renderer/index.html']) {
      expect(rx.test(p), `exclusion must NOT match the shipped bundle path ${p}`).toBe(false)
    }
  })
})

// TQ-4 (full-audit 2026-07-12b, §48 LIC-1 follow-up): the desktop package.json `license` field
// is what electron-builder stamps into the artifact metadata; it must never drift from the
// repo-root GPL-3.0-or-later declaration (LICENSE file + root package.json).
describe('desktop package license matches the repo license (TQ-4)', () => {
  it('apps/desktop and root package.json both declare GPL-3.0-or-later', () => {
    const read = (p: string): { license?: string } =>
      JSON.parse(readFileSync(p, 'utf8')) as { license?: string }
    expect(read(join(__dirname, '..', '..', 'package.json')).license).toBe('GPL-3.0-or-later')
    expect(read(join(LOCKFILE, '..', 'package.json')).license).toBe('GPL-3.0-or-later')
  })
})

// PR #30 (portable-build-cleanup): electron-builder derives the per-platform executable /
// AppImage name from the npm package name, which in this workspace is the scoped
// "@hilbertraum/desktop" → "@hilbertraumdesktop"; the '@' is an unsafe path char and the build
// fails (first on the linux AppImage target, then mac/win once the package was renamed). A
// top-level `executableName` pins a path-safe name for every platform. Guard it in the green
// gate — the failure only surfaces when someone runs `npm run package`, never in typecheck/test.
describe('electron-builder pins a path-safe executableName (PR #30)', () => {
  it('sets a top-level executableName equal to productName', () => {
    const cfg = loadBuilderConfig()
    expect(cfg.productName, 'productName present').toBe('HilbertRaum')
    expect(cfg.executableName, 'executableName present and matches productName').toBe(
      cfg.productName
    )
  })

  it('the executableName contains no path-unsafe characters (the "@" that broke the build)', () => {
    const name = loadBuilderConfig().executableName ?? ''
    // No '@' / '/' / '\\' / whitespace / other filename-hostile chars — a plain safe basename.
    expect(name.length).toBeGreaterThan(0)
    expect(name).not.toContain('@')
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('no per-platform section overrides executableName with a conflicting value', () => {
    const cfg = loadBuilderConfig()
    for (const section of ['win', 'mac', 'linux', 'portable'] as const) {
      const override = cfg[section]?.executableName
      // A platform may repeat the same name, but must never disagree with the top-level pin.
      if (override !== undefined) {
        expect(override, `${section}.executableName must match the top-level pin`).toBe(
          cfg.executableName
        )
      }
    }
  })
})

// DEP-1 §5 follow-up #1, discharged by wave DEP-4 (plan P1). `electron-builder.yml`'s
// `electronVersion:` — NOT the npm `electron` devDependency — selects the runtime that is
// actually packaged: electron-builder 26 runs from apps/desktop and cannot resolve the hoisted
// `^`-range devDep, so the field is a hand-maintained pin. DEP-1 §4(b) records what that costs:
// the first `package:win` of that wave silently shipped Electron 37 after the devDep had been
// bumped to 39, and it was caught only because a human happened to notice. The failure is
// invisible to typecheck, test and CI — it surfaces only in the bytes of a release artifact,
// which is the worst possible place to find a stale, still-vulnerable runtime.
//
// The lockfile is the source of truth here, not `node_modules`: it is committed, deterministic,
// and it is what `npm ci` installs on every CI leg and release runner. A node_modules-only check
// would false-pass against a stale local install. The installed copy is checked too, but only
// when present — CI legs set ELECTRON_SKIP_BINARY_DOWNLOAD and a slimmed context may have no
// electron at all.
describe('electron-builder.yml electronVersion tracks the electron devDependency (DEP-1 §5 #1)', () => {
  /** The version the lockfile pins for the hoisted root `node_modules/electron`. */
  function lockedElectronVersion(): string {
    const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    const entry = lock.packages['node_modules/electron']
    expect(entry?.version, 'package-lock.json pins node_modules/electron').toBeTruthy()
    return entry!.version!
  }

  /** The `^x.y.z` range declared in apps/desktop/package.json devDependencies. */
  function declaredElectronRange(): string {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')
    ) as { devDependencies?: Record<string, string> }
    const range = pkg.devDependencies?.electron
    expect(range, 'apps/desktop declares an electron devDependency').toBeTruthy()
    return range!
  }

  const parse3 = (v: string): [number, number, number] => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    expect(m, `"${v}" is a plain three-part version`).not.toBeNull()
    return [Number(m![1]), Number(m![2]), Number(m![3])]
  }

  it('electronVersion is a plain three-part version STRING, not a YAML number', () => {
    const raw = loadBuilderConfig().electronVersion
    // `electronVersion: 43.0` is valid YAML and parses to the number 43 — electron-builder
    // would then look for a nonexistent "43" release. Two dots keep it a string; assert that.
    expect(typeof raw, 'electronVersion must be quoted/dotted enough to stay a string').toBe(
      'string'
    )
    expect(String(raw)).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('electronVersion EQUALS the electron version pinned in package-lock.json', () => {
    const pinned = String(loadBuilderConfig().electronVersion)
    expect(
      pinned,
      'electron-builder.yml packages this exact runtime — if it disagrees with the lockfile, ' +
        'the release artifact ships a different Electron than the one CI tested (DEP-1 §4(b))'
    ).toBe(lockedElectronVersion())
  })

  it('electronVersion satisfies the caret range declared in apps/desktop/package.json', () => {
    const range = declaredElectronRange()
    const caret = /^\^(\d+\.\d+\.\d+)$/.exec(range)
    // If the range form ever changes, fail loudly rather than silently stop checking.
    expect(caret, `electron devDependency "${range}" is a plain caret range`).not.toBeNull()
    const [fMaj, fMin, fPat] = parse3(caret![1])
    const [pMaj, pMin, pPat] = parse3(String(loadBuilderConfig().electronVersion))
    expect(pMaj, 'same major as the declared floor').toBe(fMaj)
    const atOrAbove =
      pMin > fMin || (pMin === fMin && pPat >= fPat)
    expect(atOrAbove, `${pMaj}.${pMin}.${pPat} is at or above the ${caret![1]} floor`).toBe(true)
  })

  it('the INSTALLED electron agrees too, when node_modules is present', () => {
    let installed: string | null = null
    try {
      installed = (
        JSON.parse(
          readFileSync(
            join(LOCKFILE, '..', 'node_modules', 'electron', 'package.json'),
            'utf8'
          )
        ) as { version: string }
      ).version
    } catch {
      // No electron installed (slimmed/lint-only context) — the lockfile assertions above
      // are the load-bearing ones; nothing to compare against here.
      return
    }
    expect(installed, 'a stale node_modules would package a runtime nobody tested').toBe(
      String(loadBuilderConfig().electronVersion)
    )
  })
})
