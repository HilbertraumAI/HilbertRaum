import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { parse } from 'yaml'
import { globToRegExp } from '../helpers/globs'
import { TESSERACT_WORKER_ENTRY } from '../../src/main/services/ocr/tesseract'

// REL-6 (audit 2026-09-02 Phase 1, PR 1-b) — the `asarUnpack` CLOSURE, derived instead of
// guessed. `worker_threads` loads the tesseract.js worker script and everything it `require`s
// through real filesystem reads, which cannot see inside `app.asar`; electron-builder copies
// the unpacked globs to `app.asar.unpacked` and the engine rewrites the workerPath there. A
// module the worker requires that is NOT covered by an unpack glob stays inside the archive and
// cannot be resolved from the unpacked directory — measured 2026-07-19 on a real packaged
// Windows build: only `tesseract.js/**` and `tesseract.js-core/**` were listed, the worker's
// hoisted deps (`regenerator-runtime`, `is-url`, …) were not, and the load failure killed the
// app (PR 1-a made that failure a per-document error; this test + the globs make OCR WORK).
//
// Method: resolve the worker entry (the engine's own `TESSERACT_WORKER_ENTRY`) from the app
// package exactly as Node would, walk its STATIC `require('<literal>')` graph with
// `createRequire(file).resolve`, and assert every resolved module is covered at EVERY
// destination electron-builder may give it inside the asar:
//   - the source-tree path from the first `node_modules/` segment
//     (`node_modules/node-fetch/node_modules/whatwg-url/lib/URL.js`), and
//   - the FLATTENED path (`node_modules/whatwg-url/lib/URL.js`): electron-builder derives the
//     in-asar location from the dependency tree, and in this npm workspace its collector
//     flattens a source-nested package to top level (reviewer measurement on the 2026-09-02
//     `win-unpacked` artifact: `node-fetch` had no nested `node_modules` inside `app.asar`,
//     `whatwg-url`/`tr46`/`webidl-conversions` sat at top level, packed).
// Requiring both keeps the pin true whichever layout a builder version produces.
// Specifiers that do not resolve in this tree (an optional dep such as node-fetch's `encoding`,
// required inside a try/catch) are tolerated only from the exact `file -> spec` allow-list: a
// package that is not installed cannot be packed either, so it cannot be missing from the
// unpacked copy — but a NEW unresolvable specifier fails the walk.
//
// watch-item: a static walk misses computed `require(expr)`, `import()`, `require.resolve` and
// ESM `import` legs (an `.mjs`/`.node`/`.wasm` file that resolves is coverage-checked but not
// walked); tesseract.js 7.0.0 has none of these on the worker path (grep-verified by the PR 1-b
// review), and `tesseract.js-core` reads its `.wasm` beside its `.js` via `fs` — covered because
// the glob is package-wide. The manual packaged smoke (BUILD_STATE §5 item 18(c)) remains the
// executable exit criterion for the closure.

const APP_DIR = join(__dirname, '..', '..')
const BUILDER_YML = join(APP_DIR, 'electron-builder.yml')

interface BuilderConfig {
  asarUnpack?: string[]
}

const isBuiltin = (spec: string): boolean =>
  spec.startsWith('node:') || builtinModules.includes(spec)

/** `…/node_modules/a/node_modules/b/x.js` → `node_modules/a/node_modules/b/x.js` (source layout). */
export function asarRelative(file: string): string {
  const posix = file.split(sep).join('/')
  const i = posix.indexOf('node_modules/')
  return i >= 0 ? posix.slice(i) : posix
}

/**
 * Every in-asar destination a resolved file may have: the source-nested path and, when the
 * package is nested, the flattened top-level form electron-builder's collector produces.
 */
export function asarCandidates(file: string): string[] {
  const nested = asarRelative(file)
  const segments = nested.split('node_modules/')
  const flattened = `node_modules/${segments[segments.length - 1]}`
  return flattened === nested ? [nested] : [nested, flattened]
}

/** Every file reachable from `entry` through literal CJS requires, plus the specs that did not resolve. */
export function resolveRequireGraph(entry: string): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.(c?js|json)$/.test(file)) return // resolved but not walked (ESM/native/wasm legs)
    const src = readFileSync(file, 'utf8')
    const req = createRequire(file)
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1]
      if (isBuiltin(spec)) continue
      try {
        walk(req.resolve(spec))
      } catch {
        unresolved.push(`${asarRelative(file)} -> ${spec}`)
      }
    }
  }
  walk(entry)
  return { files: [...seen].sort(), unresolved }
}

/** `node_modules/@scope/name/x.js` / `node_modules/name/x.js` → the package name. */
function packageOf(asarPath: string): string {
  const m = asarPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)
  return m ? m[1] : asarPath
}

describe('asarUnpack closure — the tesseract.js worker require graph (REL-6, PR 1-b)', () => {
  const config = parse(readFileSync(BUILDER_YML, 'utf8')) as BuilderConfig
  const globs = config.asarUnpack ?? []
  const matchers = globs.map(globToRegExp)
  const covered = (asarPath: string): boolean => matchers.some((re) => re.test(asarPath))
  const appRequire = createRequire(join(APP_DIR, 'package.json'))
  const entry = appRequire.resolve(TESSERACT_WORKER_ENTRY)
  const { files, unresolved } = resolveRequireGraph(entry)

  it('resolves the engine’s worker entry and a non-trivial graph (the walk itself works)', () => {
    expect(asarRelative(entry)).toBe(`node_modules/${TESSERACT_WORKER_ENTRY}`)
    // The WASM core and the hoisted runtime deps are on the path — if this shrinks to just
    // tesseract.js, the regex walk is broken, not the closure.
    const packages = new Set(files.map((f) => packageOf(asarRelative(f))))
    expect(packages).toContain('tesseract.js')
    expect(packages).toContain('tesseract.js-core')
    expect(packages).toContain('regenerator-runtime')
    expect(packages).toContain('is-url')
    // The flattening rule is exercised by node-fetch's nested deps (a nested source path yields
    // two candidates; a hoisted one yields one).
    const nestedFile = files.find((f) => (asarRelative(f).match(/node_modules\//g) ?? []).length > 1)
    expect(nestedFile, 'expected at least one nested package on the graph').toBeDefined()
    expect(asarCandidates(nestedFile as string)).toHaveLength(2)
    expect(asarCandidates(entry)).toHaveLength(1)
  })

  it('every module the worker can require is covered by an asarUnpack glob at every destination (fails on the DEP-1 P4 gap)', () => {
    expect(globs.length).toBeGreaterThan(0)
    const uncovered = files.flatMap((f) => asarCandidates(f).filter((p) => !covered(p)))
    // Print the offenders by package so the fix is a glob per line, not a guess.
    const offendingPackages = [...new Set(uncovered.map(packageOf))].sort()
    expect(offendingPackages, `uncovered by asarUnpack: ${uncovered.join(', ')}`).toEqual([])
  })

  it('unresolved specifiers are only the known optional try/catch deps (a new one fails the walk)', () => {
    // node-fetch 2.x: `require('encoding')` inside a try/catch (an optional peer that is not
    // installed here). Keyed on the exact `file -> spec`, so the same name from another file, or
    // any other unresolvable specifier, is a real gap.
    const allowed = new Set(['node_modules/node-fetch/lib/index.js -> encoding'])
    const unexpected = unresolved.filter((u) => !allowed.has(u))
    expect(unexpected).toEqual([])
  })
})
