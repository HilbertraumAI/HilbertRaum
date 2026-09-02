import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { parse } from 'yaml'

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
// Method: resolve the worker entry (`tesseract.js/src/worker-script/node/index.js`) from the
// app package exactly as Node would, walk its STATIC `require('<literal>')` graph with
// `createRequire(file).resolve`, and assert every resolved module path (relative to the first
// `node_modules/` segment — the layout electron-builder reproduces inside the asar) matches at
// least one `asarUnpack` glob. Specifiers that do not resolve in this tree (an optional dep
// such as node-fetch's `encoding`, required inside a try/catch) are tolerated: a package that
// is not installed cannot be packed either, so it cannot be missing from the unpacked copy.
//
// watch-item: a static walk misses computed `require(expr)` calls; tesseract.js 7.0.0 has none
// on the worker path (its `getCore.js` variants are all literal), and the manual packaged smoke
// (BUILD_STATE §5 item 18(c)) remains the executable exit criterion for the closure.

const APP_DIR = join(__dirname, '..', '..')
const BUILDER_YML = join(APP_DIR, 'electron-builder.yml')
const WORKER_ENTRY = 'tesseract.js/src/worker-script/node/index.js'

interface BuilderConfig {
  asarUnpack?: string[]
}

/** Translate a minimatch-style glob to a coarse RegExp (same rules as `packaging.test.ts`). */
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

const isBuiltin = (spec: string): boolean =>
  spec.startsWith('node:') || builtinModules.includes(spec)

/** Every file reachable from `entry` through literal CJS requires, plus the specs that did not resolve. */
export function resolveRequireGraph(entry: string): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.(c?js|json)$/.test(file)) return
    const src = readFileSync(file, 'utf8')
    const req = createRequire(file)
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1]
      if (isBuiltin(spec)) continue
      try {
        walk(req.resolve(spec))
      } catch {
        unresolved.push(`${relative(APP_DIR, file).split(sep).join('/')} -> ${spec}`)
      }
    }
  }
  walk(entry)
  return { files: [...seen].sort(), unresolved }
}

/** `…/node_modules/a/node_modules/b/x.js` → `node_modules/a/node_modules/b/x.js` (asar-relative). */
function asarRelative(file: string): string {
  const posix = file.split(sep).join('/')
  const i = posix.indexOf('node_modules/')
  return i >= 0 ? posix.slice(i) : posix
}

describe('asarUnpack closure — the tesseract.js worker require graph (REL-6, PR 1-b)', () => {
  const config = parse(readFileSync(BUILDER_YML, 'utf8')) as BuilderConfig
  const globs = config.asarUnpack ?? []
  const matchers = globs.map(globToRegExp)
  const appRequire = createRequire(join(APP_DIR, 'package.json'))
  const entry = appRequire.resolve(WORKER_ENTRY)
  const { files, unresolved } = resolveRequireGraph(entry)

  it('resolves the worker entry and a non-trivial graph (the walk itself works)', () => {
    expect(asarRelative(entry)).toBe(`node_modules/${WORKER_ENTRY}`)
    // The WASM core and the hoisted runtime deps are on the path — if this shrinks to just
    // tesseract.js, the regex walk is broken, not the closure.
    const packages = new Set(
      files.map((f) => {
        const m = asarRelative(f).match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)
        return m ? m[m.length - 1].replace('node_modules/', '') : f
      })
    )
    expect(packages).toContain('tesseract.js')
    expect(packages).toContain('tesseract.js-core')
    expect(packages).toContain('regenerator-runtime')
    expect(packages).toContain('is-url')
  })

  it('every module the worker can require is covered by an asarUnpack glob (fails on the DEP-1 P4 gap)', () => {
    expect(globs.length).toBeGreaterThan(0)
    const uncovered = files
      .map(asarRelative)
      .filter((rel) => !matchers.some((re) => re.test(rel)))
    // Print the offenders by package so the fix is a glob per line, not a guess.
    const offendingPackages = [
      ...new Set(
        uncovered.map((rel) => {
          const m = rel.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)
          return m ? m[1] : rel
        })
      )
    ].sort()
    expect(offendingPackages, `uncovered by asarUnpack: ${uncovered.join(', ')}`).toEqual([])
  })

  it('unresolved specifiers are only optional deps guarded by try/catch (nothing packed is missing)', () => {
    // node-fetch 2.x: `require('encoding')` inside a try/catch (an optional peer that is not
    // installed here). Anything else unresolved means the graph walk hit a real gap.
    const allowed = new Set(['encoding'])
    const unexpected = unresolved.filter((u) => !allowed.has(u.split(' -> ')[1]))
    expect(unexpected).toEqual([])
  })
})
