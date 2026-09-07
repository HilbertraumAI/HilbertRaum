import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { en, type MessageKey } from '../../src/shared/i18n'

// PR #302 fix wave, P5 (CG8): an unused-i18n-key guard. The full-card model picker's removal
// left five orphaned keys (F7) with no compile-time signal — TypeScript only checks that EN/DE
// stay in sync with each other (i18n.test.ts), never that a key is actually read anywhere. This
// guard closes that gap for future removals without re-litigating F7's already-deleted keys.
//
// Approach: parse every production source file with the TypeScript compiler API (comments are
// therefore invisible to the scan — a stale comment mentioning a key proves nothing) and collect
// every string literal / no-substitution template / template-expression quasi. A literal that
// exactly equals a catalog key is a use. A literal that equals a `tCount`/`tCountMain` PLURAL
// BASE (a key `X` whose `X.one` AND `X.other` both exist) marks both variants used — the literal
// itself ('models.library.results') is never a catalog key on its own, only its plural
// variants are, so without this step every plural in the app would misreport as unused. A
// template literal or string-concatenation with exactly one dynamic segment and a SPECIFIC
// (>= 2 dot-separated, non-empty) leading and/or trailing literal part is treated as reaching
// every catalog key matching `prefix + <single segment, no dots> + suffix` — this is what
// `` `review.source.kind.${source.kind}` `` and `` `review.relation.${r}` `` need
// (EvidencePane.tsx). A generic/empty prefix is never accepted — that would just rediscover the
// `t`/`tCount` implementation itself and exempt everything. Anything else needs a reviewed,
// non-stale EXACT_KEY_EXCEPTIONS entry.
//
// `preview/` is INCLUDED in the scan (not excluded): it lives under `src/renderer` and drives
// the real screens/components through the same translators (e.g. the `models-download-failed`
// case seeds a real failed job and renders the real `ModelsScreen`), so a key exercised only
// through a preview override is still real production code reading it. Including it can only
// ADD "used" evidence — it never manufactures a false negative — so there is no safety cost to
// keeping it in scope. The two i18n catalog files themselves are excluded: they declare every
// key as an object-literal string, which would trivially mark every key "used" and defeat the
// guard entirely.

// ---------------------------------------------------------------------------------------------
// Scanning primitives — plain functions so the classifier can be unit-tested on small fixtures
// independently of the real catalog/source tree (CG8 acceptance c/d below).
// ---------------------------------------------------------------------------------------------

/** A finite dynamic-key candidate: `prefix + <one segment, no dots> + suffix`. */
interface DynamicPattern {
  prefix: string
  suffix: string
}

/** CG8: never allow an empty/generic prefix — require >= 2 non-empty dot-separated segments. */
function isSpecificPrefix(prefix: string): boolean {
  return prefix.length > 0 && prefix.split('.').filter((seg) => seg.length > 0).length >= 2
}

interface ScanResult {
  literals: Set<string>
  dynamics: DynamicPattern[]
}

/** Flatten a `+`-chain into literal/non-literal parts, recursing through nested `+` nodes. */
function flattenPlusChain(node: ts.Expression, parts: Array<{ lit: boolean; text?: string }>): void {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    flattenPlusChain(node.left, parts)
    flattenPlusChain(node.right, parts)
    return
  }
  if (ts.isStringLiteralLike(node)) {
    parts.push({ lit: true, text: node.text })
    return
  }
  parts.push({ lit: false })
}

/** Parse one file's text with the TS compiler API and collect literals + dynamic-key candidates. */
function scanSource(fileName: string, sourceText: string): ScanResult {
  const literals = new Set<string>()
  const dynamics: DynamicPattern[] = []
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      // Covers ts.StringLiteral and NoSubstitutionTemplateLiteral. Comments are never visited —
      // the parser discards them before this walk sees a single node.
      literals.add(node.text)
    } else if (ts.isTemplateExpression(node)) {
      // A single-substitution template (`` `models.library.${x}` ``) decomposes cleanly into a
      // head (prefix) and one tail (suffix). Two or more substitutions are not decomposed into a
      // single prefix/suffix pair (`` `${a}.${b}` `` has no fixed anchor) — such a call needs an
      // exact-key exception if it ever legitimately reaches a catalog key.
      if (node.templateSpans.length === 1) {
        dynamics.push({ prefix: node.head.text, suffix: node.templateSpans[0].literal.text })
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      // Only handle the OUTERMOST `+` of a chain — an inner `+` is already covered by its parent's
      // flatten, and visiting it again would double-count (harmlessly, but noisily) the same chain.
      !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const parts: Array<{ lit: boolean; text?: string }> = []
      flattenPlusChain(node, parts)
      const dynamicCount = parts.filter((p) => !p.lit).length
      if (dynamicCount === 1 && parts.some((p) => p.lit)) {
        let i = 0
        let prefix = ''
        while (i < parts.length && parts[i].lit) {
          prefix += parts[i].text
          i++
        }
        let j = parts.length - 1
        let suffix = ''
        while (j >= 0 && parts[j].lit) {
          suffix = parts[j].text + suffix
          j--
        }
        dynamics.push({ prefix, suffix })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { literals, dynamics }
}

/** Every catalog key base `X` with a complete `X.one` / `X.other` pair (tCount/tCountMain). */
function pluralBases(catalogKeys: ReadonlySet<string>): Set<string> {
  const bases = new Set<string>()
  for (const key of catalogKeys) {
    if (key.endsWith('.one') && catalogKeys.has(`${key.slice(0, -'.one'.length)}.other`)) {
      bases.add(key.slice(0, -'.one'.length))
    }
  }
  return bases
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every catalog key reachable from a bounded dynamic pattern's `prefix<one segment>suffix` shape. */
function boundedDynamicMatches(
  dynamics: readonly DynamicPattern[],
  catalogKeys: ReadonlySet<string>
): Set<string> {
  const matches = new Set<string>()
  for (const { prefix, suffix } of dynamics) {
    if (!isSpecificPrefix(prefix)) continue
    const pattern = new RegExp(`^${escapeRegExp(prefix)}([^.]+)${escapeRegExp(suffix)}$`)
    for (const key of catalogKeys) {
      if (pattern.test(key)) matches.add(key)
    }
  }
  return matches
}

interface ExactKeyException {
  key: string
  reason: string
  callSite: string
}

/**
 * The full classifier: literal uses, plural-base expansion, bounded dynamic matches, and
 * reviewed exact-key exceptions, unioned into one used-key set.
 */
function classifyUsedKeys(
  literals: ReadonlySet<string>,
  dynamics: readonly DynamicPattern[],
  catalogKeys: ReadonlySet<string>,
  exceptions: readonly ExactKeyException[]
): Set<string> {
  const used = new Set<string>()
  const bases = pluralBases(catalogKeys)
  for (const literal of literals) {
    if (catalogKeys.has(literal)) used.add(literal)
    if (bases.has(literal)) {
      used.add(`${literal}.one`)
      used.add(`${literal}.other`)
    }
  }
  for (const key of boundedDynamicMatches(dynamics, catalogKeys)) used.add(key)
  for (const { key } of exceptions) used.add(key)
  return used
}

/**
 * An exception is stale when its key no longer exists in the catalog, or when the PLAIN literal
 * scan alone (no plural/dynamic help) already finds it — at that point the exception is dead
 * weight and should be deleted along with whatever code path it used to cover.
 */
function findStaleExceptions(
  exceptions: readonly ExactKeyException[],
  catalogKeys: ReadonlySet<string>,
  literals: ReadonlySet<string>
): string[] {
  const stale: string[] = []
  for (const { key } of exceptions) {
    if (!catalogKeys.has(key) || literals.has(key)) stale.push(key)
  }
  return stale
}

// ---------------------------------------------------------------------------------------------
// Production source walk (mirrors i18n.test.ts's existing `t('key'` scan's file-listing shape).
// ---------------------------------------------------------------------------------------------

function listProductionFiles(): string[] {
  const srcRoot = join(process.cwd(), 'src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
      files.push(full)
    }
  }
  walk(srcRoot)
  return files.filter((f) => {
    const normalized = f.split('\\').join('/')
    // Exclude the catalogs themselves (see the file-header note) — everything else under src/,
    // preview/ included, counts as production source for this guard.
    return !normalized.endsWith('/shared/i18n/en.ts') && !normalized.endsWith('/shared/i18n/de.ts')
  })
}

function scanProduction(): ScanResult {
  const literals = new Set<string>()
  const dynamics: DynamicPattern[] = []
  for (const file of listProductionFiles()) {
    const text = readFileSync(file, 'utf8')
    const found = scanSource(file, text)
    for (const literal of found.literals) literals.add(literal)
    dynamics.push(...found.dynamics)
  }
  return { literals, dynamics }
}

/**
 * First production file (by `listProductionFiles()` order) whose scan finds `key` reachable as a
 * plain literal or via its plural base — used only to name the call site in a baseline-staleness
 * failure message (#315 item 2). Returns null when the key is reachable only via a bounded-dynamic
 * match (no single call site to name; the caller falls back to naming the rule instead).
 */
function findLiteralCallSite(key: string, catalogKeys: ReadonlySet<string>): string | null {
  const bases = pluralBases(catalogKeys)
  const base = key.endsWith('.one') ? key.slice(0, -'.one'.length) : key.endsWith('.other') ? key.slice(0, -'.other'.length) : null
  for (const file of listProductionFiles()) {
    const { literals } = scanSource(file, readFileSync(file, 'utf8'))
    if (literals.has(key)) return file
    if (base && bases.has(base) && literals.has(base)) return file
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Exact-key exceptions (reviewed dynamic uses the bounded-prefix rule cannot decompose). Empty
// today: EvidencePane.tsx's two dynamic keys (`review.source.kind.${…}`, `review.relation.${…}`)
// both have a specific two-segment-plus prefix and an empty suffix, so the bounded-dynamic rule
// above covers them without an exception. Keep this list for the next genuinely irreducible case
// (e.g. a multi-substitution template or a key built from a lookup table) rather than widening
// the prefix rule to paper over one.
// ---------------------------------------------------------------------------------------------
const EXACT_KEY_EXCEPTIONS: readonly ExactKeyException[] = []

// ---------------------------------------------------------------------------------------------
// LEGACY_UNREFERENCED baseline (CG8 report mode): the place to freeze a FUTURE reviewed batch of
// dead keys the scan finds beyond what it was written to catch (mirrors EXACT_KEY_EXCEPTIONS'
// shape — a key alone is enough here since there is nothing to except, just to acknowledge as
// dead pending deletion). The 17 keys this baseline originally held (#302 CG8) were reviewed and
// deleted outright in #315 rather than kept baselined — none had a real call site. Empty today.
// ---------------------------------------------------------------------------------------------
const LEGACY_UNREFERENCED: readonly MessageKey[] = []

// =================================================================================================
// Classifier unit tests (CG8 acceptance b/c/d): small fixtures, independent of the real catalog.
// =================================================================================================

describe('i18n unused-key guard — classifier (fixtures)', () => {
  it('flags a synthetic key injected into a copied catalog map when nothing references it', () => {
    const catalog = new Set(['app.title', 'app.subtitle', 'app.orphan'])
    const literals = new Set(['app.title', 'app.subtitle']) // 'app.orphan' deliberately absent
    const used = classifyUsedKeys(literals, [], catalog, [])
    const unused = [...catalog].filter((k) => !used.has(k))
    expect(unused).toEqual(['app.orphan'])
  })

  it('accepts a live plural pair via its tCount base literal, without a manual exception', () => {
    const catalog = new Set(['docs.count.one', 'docs.count.other', 'docs.unrelated'])
    // tCount('docs.count', n) — the base is what actually appears as a string literal.
    const literals = new Set(['docs.count'])
    const used = classifyUsedKeys(literals, [], catalog, [])
    expect(used.has('docs.count.one')).toBe(true)
    expect(used.has('docs.count.other')).toBe(true)
    expect(used.has('docs.unrelated')).toBe(false) // unrelated key stays correctly unused
  })

  it('accepts a bounded dynamic key (specific prefix) without exempting an unrelated key', () => {
    const catalog = new Set(['ns.item.alpha', 'ns.item.beta', 'ns.other.gamma'])
    // e.g. `` `ns.item.${role}` `` — a two-segment, non-empty prefix and an empty suffix.
    const dynamics: DynamicPattern[] = [{ prefix: 'ns.item.', suffix: '' }]
    const used = classifyUsedKeys(new Set(), dynamics, catalog, [])
    expect(used.has('ns.item.alpha')).toBe(true)
    expect(used.has('ns.item.beta')).toBe(true)
    // A DIFFERENT namespace under the same top-level segment must not be swept in — proves the
    // rule matches on the full prefix, not just its first segment.
    expect(used.has('ns.other.gamma')).toBe(false)
  })

  it('rejects a generic/empty prefix — it must never reach every key like the t() implementation would', () => {
    const catalog = new Set(['a.b.c', 'x.y.z'])
    expect(isSpecificPrefix('')).toBe(false)
    expect(isSpecificPrefix('a.')).toBe(false) // one segment only — not specific enough
    expect(isSpecificPrefix('a.b.')).toBe(true)
    // A generic single-segment or empty prefix contributes no matches at all.
    const usedEmpty = classifyUsedKeys(new Set(), [{ prefix: '', suffix: '' }], catalog, [])
    expect(usedEmpty.size).toBe(0)
  })

  it('flags a stale exception whose key is now found by the plain literal scan', () => {
    const catalog = new Set(['feature.flag'])
    const literals = new Set(['feature.flag']) // now reachable without help
    const stale = findStaleExceptions(
      [{ key: 'feature.flag', reason: 'was dynamic once', callSite: 'nowhere' }],
      catalog,
      literals
    )
    expect(stale).toEqual(['feature.flag'])
  })

  it('flags a stale exception whose key no longer exists in the catalog', () => {
    const catalog = new Set(['still.here'])
    const stale = findStaleExceptions(
      [{ key: 'long.gone', reason: 'removed', callSite: 'nowhere' }],
      catalog,
      new Set()
    )
    expect(stale).toEqual(['long.gone'])
  })

  it('accepts a live (non-stale) exception: real key, not found by the plain scan alone', () => {
    const catalog = new Set(['multi.a', 'multi.b'])
    // Simulates a multi-substitution template — the plain literal scan finds neither key.
    const stale = findStaleExceptions(
      [{ key: 'multi.a', reason: 'multi-substitution template', callSite: 'X.tsx' }],
      catalog,
      new Set()
    )
    expect(stale).toEqual([])
  })

  it('would flag the five removed PR #302 F7 keys as unused if they came back without call sites', () => {
    // Fixture catalog: the five keys the F7 cleanup deleted, plus one live key for contrast.
    const catalog = new Set([
      'models.section.otherModels',
      'models.section.choose',
      'models.section.other',
      'models.group.onDrive',
      'models.group.toDownload',
      'models.section.yourModel' // still genuinely used elsewhere — must NOT be flagged
    ])
    const literals = new Set(['models.section.yourModel'])
    const used = classifyUsedKeys(literals, [], catalog, [])
    const unused = [...catalog].filter((k) => !used.has(k)).sort()
    expect(unused).toEqual(
      [
        'models.group.onDrive',
        'models.group.toDownload',
        'models.section.choose',
        'models.section.other',
        'models.section.otherModels'
      ].sort()
    )
  })
})

// =================================================================================================
// Real catalog + production source scan (CG8 acceptance a).
// =================================================================================================

describe('i18n unused-key guard — production scan', () => {
  it('sanity: the walk actually sees the source tree', () => {
    expect(listProductionFiles().length).toBeGreaterThan(100)
  })

  it('every catalog key is used, a plural expansion, a bounded dynamic match, an exact exception, or a recorded legacy-unreferenced baseline entry', () => {
    const catalogKeys = new Set(Object.keys(en))
    const { literals, dynamics } = scanProduction()
    const used = classifyUsedKeys(literals, dynamics, catalogKeys, EXACT_KEY_EXCEPTIONS)
    const baseline = new Set<string>(LEGACY_UNREFERENCED)

    const unexplained = [...catalogKeys].filter((k) => !used.has(k) && !baseline.has(k)).sort()
    expect(unexplained, 'new orphan key(s) — delete them or add a reviewed baseline/exception entry').toEqual([])

    // The five F7 keys must never resurface in the baseline — if they do, someone re-added dead
    // copy under the same names instead of a real caller.
    const f7Keys = [
      'models.section.otherModels',
      'models.section.choose',
      'models.section.other',
      'models.group.onDrive',
      'models.group.toDownload'
    ]
    for (const key of f7Keys) {
      expect(catalogKeys.has(key), `${key} should stay deleted (PR #302 F7)`).toBe(false)
    }
  })

  it('the baseline itself only names keys that still exist (no stale baseline entries)', () => {
    const catalogKeys = new Set(Object.keys(en))
    for (const key of LEGACY_UNREFERENCED) {
      expect(catalogKeys.has(key), `LEGACY_UNREFERENCED names a key that no longer exists: ${key}`).toBe(true)
    }
  })

  it('no baselined key has gained a real use site', () => {
    const catalogKeys = new Set(Object.keys(en))
    const { literals, dynamics } = scanProduction()
    const used = classifyUsedKeys(literals, dynamics, catalogKeys, EXACT_KEY_EXCEPTIONS)
    for (const key of LEGACY_UNREFERENCED) {
      expect(catalogKeys.has(key), `LEGACY_UNREFERENCED names a key that no longer exists: ${key}`).toBe(true)
      if (used.has(key)) {
        const site = findLiteralCallSite(key, catalogKeys) ?? '(a bounded-dynamic match — see boundedDynamicMatches)'
        throw new Error(
          `LEGACY_UNREFERENCED key "${key}" now has a real use site (${site}) — remove it from the baseline instead of leaving it "legacy unreferenced"`
        )
      }
    }
  })

  it('the exact-key exception list has no stale entries', () => {
    const catalogKeys = new Set(Object.keys(en))
    const { literals } = scanProduction()
    expect(findStaleExceptions(EXACT_KEY_EXCEPTIONS, catalogKeys, literals)).toEqual([])
  })

  it('the two known bounded-dynamic call sites (EvidencePane.tsx) still resolve without an exception', () => {
    const catalogKeys = new Set(Object.keys(en))
    const { dynamics } = scanProduction()
    const matches = boundedDynamicMatches(dynamics, catalogKeys)
    expect(matches.has('review.source.kind.direct_excerpt')).toBe(true)
    expect(matches.has('review.relation.contradicts')).toBe(true)
  })
})
