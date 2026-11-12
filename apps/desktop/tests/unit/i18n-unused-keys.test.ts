import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import * as ts from 'typescript'
import { en, UI_LANGUAGE_CODES, type MessageKey } from '../../src/shared/i18n'
import { isCatalogPath, registeredCatalogCode } from '../helpers/i18n-catalogs'

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
// case hands a real failed job to the real `ModelsScreen`), so a key exercised only
// through a preview override is still real production code reading it. Including it can only
// ADD "used" evidence — it never manufactures a false negative — so there is no safety cost to
// keeping it in scope. The i18n catalog files themselves are excluded: they declare every
// key as an object-literal string, which would trivially mark every key "used" and defeat the
// guard entirely. A row below holds the excluded files to the registered languages' catalogs,
// so a new catalog (ru.ts) can only be excluded, never scanned.

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

/** The two interface languages code named as a closed set (`'en' | 'de'`) before the language registry. */
const LEGACY_PAIR: ReadonlySet<string> = new Set(['en', 'de'])

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
])

/** The catalog lookups that take the language as their first argument, by their exported names. */
const CATALOG_LOOKUPS: ReadonlySet<string> = new Set(['t', 'tCount'])

/** The registered languages a lookup may not be handed literally: English is the persist language. */
const NON_ENGLISH_CODES: ReadonlySet<string> = new Set(UI_LANGUAGE_CODES.filter((code) => code !== 'en'))

/** Whether `fileName`'s import `specifier` is the shared i18n module (`src/shared/i18n`, its index). */
function isSharedI18nImport(fileName: string, specifier: string): boolean {
  const target = specifier.startsWith('@shared/')
    ? `src/shared/${specifier.slice('@shared/'.length)}`
    : specifier.startsWith('.')
      ? posix.join(posix.dirname(fileName.split('\\').join('/')), specifier)
      : null
  return target !== null && /(^|\/)src\/shared\/i18n(\/index)?$/.test(target)
}

/**
 * The local names under which a file imports the catalog lookups: plain or aliased
 * (`t as tCatalog`) named imports, and namespace imports (`i18n.t`).
 */
function catalogLookupBindings(
  fileName: string,
  source: ts.SourceFile
): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!isSharedI18nImport(fileName, statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || statement.importClause?.isTypeOnly) continue
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && CATALOG_LOOKUPS.has((element.propertyName ?? element.name).text)) {
        names.add(element.name.text)
      }
    }
  }
  return { names, namespaces }
}

/**
 * The places a file hardcodes the English/German pair instead of reading the language registry
 * (`shared/i18n/languages.ts`): a union type or an array literal (`as const` or not) naming both
 * `'en'` and `'de'`, an equality comparison (or `case`) against `'en'` or `'de'`, and a catalog
 * lookup (`t`, `tCount`, under whatever local name the file imports it) handed a registered
 * language other than English as a literal, the `t('en', key) || t('de', key)` shape that knows
 * copy in two languages only. `t('en', …)` stays allowed: persisted text is canonical English.
 * String and type literals only, through the compiler's AST, so a comment or a string that
 * merely spells `=== 'de'` never matches. Parentheses, `as`, `satisfies` and `!` around a code are
 * seen through. Not seen (reviewed limits): a code held in a constant, `.includes` / `Set` /
 * `startsWith` / regex tests, an `{ en, de }` key table, and a lookup re-bound to another name
 * after its import.
 */
function twoLanguageLiterals(fileName: string, sourceText: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  // Parentheses and type assertions leave the value as it is: `('de' as UiLanguage)` is still 'de'.
  const unwrap = (node: ts.Node): ts.Node => {
    let e = node
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = e.expression
    }
    return e
  }
  const literalText = (node: ts.Node): string | null => {
    const e = unwrap(node)
    return ts.isStringLiteralLike(e) ? e.text : null
  }
  const isPairLiteral = (node: ts.Node): boolean => LEGACY_PAIR.has(literalText(node) ?? '')
  const lookups = catalogLookupBindings(fileName, source)
  const isCatalogLookup = (callee: ts.Expression): boolean =>
    ts.isIdentifier(callee)
      ? lookups.names.has(callee.text)
      : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        lookups.namespaces.has(callee.expression.text) &&
        CATALOG_LOOKUPS.has(callee.name.text)
  const sites: Array<{ line: number; text: string }> = []
  const record = (node: ts.Node, text: string): void => {
    sites.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node)) {
      const named = node.types.flatMap((member) =>
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : []
      )
      if (named.includes('en') && named.includes('de')) record(node, node.getText(source))
    } else if (ts.isArrayLiteralExpression(node)) {
      const named = node.elements.flatMap((element) => literalText(element) ?? [])
      if (named.includes('en') && named.includes('de')) record(node, node.getText(source))
    } else if (
      ts.isBinaryExpression(node) &&
      EQUALITY_OPERATORS.has(node.operatorToken.kind) &&
      (isPairLiteral(node.left) || isPairLiteral(node.right))
    ) {
      record(node, node.getText(source))
    } else if (ts.isCaseClause(node) && isPairLiteral(node.expression)) {
      record(node, `case ${node.expression.getText(source)}`)
    } else if (
      ts.isCallExpression(node) &&
      isCatalogLookup(node.expression) &&
      node.arguments.length > 0 &&
      NON_ENGLISH_CODES.has(literalText(node.arguments[0]) ?? '')
    ) {
      record(node, node.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites.map(({ line, text }) => ({ line, text: text.replace(/\s+/g, ' ') }))
}

// ---------------------------------------------------------------------------------------------
// Production source walk (mirrors i18n.test.ts's existing `t('key'` scan's file-listing shape).
// ---------------------------------------------------------------------------------------------

/** Every production source file under src/ (catalogs included). */
function listSourceFiles(): string[] {
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
  return files
}

function listProductionFiles(): string[] {
  // Exclude the catalogs themselves (see the file-header note): every file that could be one,
  // so a new catalog never counts as a use of every key; the catalog-exclusion rows below
  // fail on any of them that is not a registered language's. Everything else under src/,
  // preview/ included, counts as production source for this guard.
  return listSourceFiles().filter((f) => !isCatalogPath(f))
}

// One parse of the tree serves every row below (the result is read, never changed).
let productionScan: ScanResult | undefined

function scanProduction(): ScanResult {
  if (productionScan !== undefined) return productionScan
  const literals = new Set<string>()
  const dynamics: DynamicPattern[] = []
  for (const file of listProductionFiles()) {
    const text = readFileSync(file, 'utf8')
    const found = scanSource(file, text)
    for (const literal of found.literals) literals.add(literal)
    dynamics.push(...found.dynamics)
  }
  productionScan = { literals, dynamics }
  return productionScan
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

// ---------------------------------------------------------------------------------------------
// Two-language literals (UI languages wave): the interface languages come from the
// registry (`UI_LANGUAGES`), so a hardcoded en/de pair in src/ is a language left out the day
// a third one registers, and so is a catalog lookup in a fixed language other than English
// (`t('de', key)`). The exceptions name the en/de pair for a reason other than the
// interface language. Each entry is one site, matched by file and source text: a new site, a
// second copy or a stale entry fails the row.
// ---------------------------------------------------------------------------------------------

/** src/ paths whose files may name languages freely: the registry, the catalogs and `t()` itself. */
const PAIR_LITERAL_SCOPE = 'shared/i18n/'

interface PairLiteralException {
  /** Path under src/, forward slashes. */
  file: string
  /** The flagged source text, whitespace collapsed. */
  text: string
  reason: string
}

const PAIR_LITERAL_EXCEPTIONS: readonly PairLiteralException[] = [
  {
    file: 'main/services/skills/vocabulary.ts',
    text: "'en' | 'de'",
    reason:
      'VocabLang: the languages questions are understood in (content language; the UI languages wave is interface-only, owner call 2026-11-11)'
  },
  {
    file: 'main/services/zim/question-language.ts',
    text: "'de' | 'en' | null",
    reason: 'the detected language of a question (content language, not the interface language)'
  },
  {
    file: 'main/services/zim/expand.ts',
    text: "'de' | 'en' | null",
    reason: "the question's detected language in the expansion result (content language, not the interface language)"
  },
  {
    file: 'main/services/ingestion/index.ts',
    text: "v.targetLang === 'de'",
    reason: 'legacy translation-provenance rows, persisted before the type field, translated only to de/en'
  },
  {
    file: 'main/services/ingestion/index.ts',
    text: "v.targetLang === 'en'",
    reason: 'the same legacy translation-provenance check'
  },
  {
    file: 'renderer/lib/translateSession.ts',
    text: "lang === 'en'",
    reason: 'the English UI translates from German: the one UI language that cannot be its own source (translateSession.ts)'
  },
  {
    file: 'shared/types.ts',
    text:
      "[ 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fil', 'fr', 'gu', 'he', " +
      "'hi', 'hr', 'hu', 'id', 'is', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'nl', 'no', 'pa', 'pl', 'pt', " +
      "'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'zh', 'zu' ]",
    reason: 'TRANSLATION_LANGUAGE_CODES: the 51 languages documents translate between (content language, issue #31)'
  },
  {
    file: 'shared/types.ts',
    text: "'en' | 'de'",
    reason:
      'EvidencePackLanguage: packs are written in en/de only (UI-languages owner call D-5 (b), i18n record D-L11); a type row in evidence-pack-model.test.ts holds it to the registry'
  }
]

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

// =================================================================================================
// Which files the scan skips as catalogs: every catalog, and nothing but registered ones.
// =================================================================================================

describe('i18n unused-key guard — the catalog exclusion', () => {
  it.each([
    ['/repo/apps/desktop/src/shared/i18n/en.ts', true],
    ['C:\\repo\\apps\\desktop\\src\\shared\\i18n\\de.ts', true],
    // A catalog of a language the registry does not list yet is skipped from the start (and
    // refused by the row below until the language is registered).
    ['/repo/apps/desktop/src/shared/i18n/ru.ts', true],
    // Nested: skipped too, and then refused below, because no registered catalog is nested.
    ['/repo/apps/desktop/src/shared/i18n/drafts/ru.ts', true],
    ['/repo/apps/desktop/src/shared/i18n/index.ts', false],
    ['/repo/apps/desktop/src/shared/i18n/languages.ts', false],
    ['/repo/apps/desktop/src/renderer/i18n.tsx', false],
    ['/repo/apps/desktop/src/main/services/i18n.ts', false]
  ])('isCatalogPath(%s) → %s', (path, skipped) => {
    expect(isCatalogPath(path)).toBe(skipped)
  })

  it.each<[string, readonly string[], string | null]>([
    ['/repo/apps/desktop/src/shared/i18n/de.ts', UI_LANGUAGE_CODES, 'de'],
    ['C:\\repo\\apps\\desktop\\src\\shared\\i18n\\en.ts', UI_LANGUAGE_CODES, 'en'],
    // `xx` names no language, so this row still holds once more languages register.
    ['/repo/apps/desktop/src/shared/i18n/xx.ts', UI_LANGUAGE_CODES, null],
    ['/repo/apps/desktop/src/shared/i18n/ru.ts', ['en', 'de', 'ru'], 'ru'],
    ['/repo/apps/desktop/src/shared/i18n/drafts/ru.ts', ['en', 'de', 'ru'], null]
  ])('registeredCatalogCode(%s, %j) → %s', (path, codes, code) => {
    expect(registeredCatalogCode(path, codes)).toBe(code)
  })

  it('skips exactly the registered languages’ catalogs (an unregistered one fails here, never silently disables the guard)', () => {
    const srcRoot = join(process.cwd(), 'src')
    const name = (file: string): string => relative(srcRoot, file).split('\\').join('/')
    const catalogLike = listSourceFiles().filter(isCatalogPath)
    const scanned = new Set(listProductionFiles())
    expect(catalogLike.filter((f) => scanned.has(f)).map(name), 'catalog files the scan still reads').toEqual([])
    expect(
      catalogLike.filter((f) => registeredCatalogCode(f, UI_LANGUAGE_CODES) === null).map(name),
      'files under shared/i18n/ that are no registered language’s catalog: register the language ' +
        '(languages.ts, index.ts), or list a code module in NON_CATALOG_MODULES (tests/helpers/i18n-catalogs.ts)'
    ).toEqual([])
    expect(catalogLike.map((f) => registeredCatalogCode(f, UI_LANGUAGE_CODES)).sort()).toEqual(
      [...UI_LANGUAGE_CODES].sort()
    )
  })
})

// =================================================================================================
// Two-language literals outside the registry.
// =================================================================================================

describe('two-language literals — the interface languages come from the registry', () => {
  it.each([
    ['a comparison with de', 'fixture.ts', "const german = lang === 'de'", ["lang === 'de'"]],
    ['a negated comparison with en', 'fixture.ts', "if ('en' !== lang) render()", ["'en' !== lang"]],
    ['a loose comparison', 'fixture.ts', 'const english = lang == "en"', ['lang == "en"']],
    ['the closed union', 'fixture.ts', "type Lang = 'en' | 'de'", ["'en' | 'de'"]],
    ['a wider union naming both', 'fixture.ts', "type Lang = 'de' | 'en' | null", ["'de' | 'en' | null"]],
    ['a switch case', 'fixture.ts', "switch (lang) { case 'de': break }", ["case 'de'"]],
    ['an array naming both', 'fixture.ts', "const LANGS = ['en', 'de']", ["['en', 'de']"]],
    ['an as-const array naming both', 'fixture.ts', "const LANGS = ['de', 'en'] as const", ["['de', 'en']"]],
    ['a wider array naming both, over lines', 'fixture.ts', "new Set([\n  'en',\n  'de',\n  'fr'\n])", ["[ 'en', 'de', 'fr' ]"]],
    ['an array naming one code', 'fixture.ts', "const LANGS = ['en'] as const", []],
    ['a comparison in JSX', 'fixture.tsx', "export const A = () => <p>{lang === 'de' ? 'Hallo' : 'Hi'}</p>", ["lang === 'de'"]],
    ['a comparison with a cast code', 'fixture.ts', "const german = lang === ('de' as UiLanguage)", ["lang === ('de' as UiLanguage)"]],
    ['a comparison in parentheses', 'fixture.ts', "const german = ('de') === lang", ["('de') === lang"]],
    ['a switch case with a cast code', 'fixture.ts', "switch (lang) { case 'en' satisfies UiLanguage: break }", ["case 'en' satisfies UiLanguage"]],
    ['an array of cast codes', 'fixture.ts', "const LANGS = ['en' as UiLanguage, 'de' as UiLanguage]", ["['en' as UiLanguage, 'de' as UiLanguage]"]],
    ['a comment only', 'fixture.ts', "// lang === 'de' used to pick German\nconst x = 1", []],
    ['a string that spells it', 'fixture.ts', "const hint = \"use lang === 'de' nowhere\"", []],
    ['another language', 'fixture.ts', "type Lang = 'en' | 'fr'\nconst french = lang === 'fr'", []],
    ['object keys (a table per pack language)', 'fixture.ts', "const line = { en: 'a', de: 'b' }", []],
    ['a union naming only one of the pair', 'fixture.ts', "type T = 'de' | 'system'", []],
    // A catalog lookup handed a fixed language other than English. The lookups are found
    // through the file's own import of shared/i18n, under whatever name it binds them.
    [
      'the pre-registry friendly-error check (t in de, t in en allowed)',
      '/repo/apps/desktop/src/main/services/doctasks/fixture.ts',
      "import { t } from '../../../shared/i18n'\nconst ok = raw === t('en', key) || raw === t('de', key)",
      ["t('de', key)"]
    ],
    [
      't in de, imported under another name',
      '/repo/apps/desktop/src/renderer/lib/fixture.ts',
      "import { t as tCatalog, type MessageKey } from '@shared/i18n'\nconst text = tCatalog('de', key)",
      ["tCatalog('de', key)"]
    ],
    [
      't handed a cast code',
      '/repo/apps/desktop/src/renderer/lib/fixture.ts',
      "import { t, type UiLanguage } from '@shared/i18n'\nconst text = t('de' as UiLanguage, key)",
      ["t('de' as UiLanguage, key)"]
    ],
    [
      'tCount in de',
      '/repo/apps/desktop/src/main/services/fixture.ts',
      "import { tCount } from '../../shared/i18n'\nconst text = tCount('de', 'docs.count', n)",
      ["tCount('de', 'docs.count', n)"]
    ],
    [
      't in de through a namespace import',
      '/repo/apps/desktop/src/shared/fixture.ts',
      "import * as i18n from './i18n'\nconst text = i18n.t('de', key)",
      ["i18n.t('de', key)"]
    ],
    [
      't in en (the persist language) and in a variable language',
      '/repo/apps/desktop/src/main/services/fixture.ts',
      "import { t } from '../../shared/i18n'\nconst saved = t('en', key)\nconst shown = t(lang, key)",
      []
    ],
    [
      'de handed to a call that is no catalog lookup',
      '/repo/apps/desktop/src/renderer/fixture.ts',
      "import { t } from '@shared/i18n'\nconst n = value.toLocaleString('de')\nconst list = codes.includes('de')",
      []
    ],
    [
      'a t imported from another module',
      '/repo/apps/desktop/src/renderer/fixture.ts',
      "import { t } from './translate'\nconst text = t('de', key)",
      []
    ]
  ])('%s', (_title, fileName, code, texts) => {
    expect(twoLanguageLiterals(fileName, code).map((site) => site.text)).toEqual(texts)
  })

  it('src/ names the en/de pair only at the reviewed sites; everything else derives from UI_LANGUAGES', () => {
    const srcRoot = join(process.cwd(), 'src')
    const sites = listSourceFiles().flatMap((file) => {
      const path = relative(srcRoot, file).split('\\').join('/')
      if (path.startsWith(PAIR_LITERAL_SCOPE)) return []
      return twoLanguageLiterals(file, readFileSync(file, 'utf8')).map((site) => ({ file: path, ...site }))
    })
    const key = ({ file, text }: { file: string; text: string }): string => `${file}: ${text}`
    expect(
      sites.map(key).sort(),
      'a hardcoded en/de pair or a lookup in a fixed non-English language: derive the languages from ' +
        'UI_LANGUAGES (shared/i18n/languages.ts), or, for a ' +
        'content language rather than the interface one, add a PAIR_LITERAL_EXCEPTIONS entry with its reason. ' +
        `Sites: ${sites.map((s) => `${s.file}:${s.line} ${s.text}`).join('; ')}`
    ).toEqual(PAIR_LITERAL_EXCEPTIONS.map(key).sort())
  })
})
