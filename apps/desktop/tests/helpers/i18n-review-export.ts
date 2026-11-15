// The native-review kit's builder (#813): for one interface language, the reviewer table (every
// catalog key with its English text, its translation and the code comments above it) and the
// plural-edge sheet (every plural base rendered through the real `tCount` at the edge counts), as
// CSV files a spreadsheet opens. `tests/manual/i18n-review-export.test.ts` writes them;
// `tests/unit/i18n-review-export.test.ts` checks them.
//
// Tooling, not product code: nothing in the app reads it, so it does not live in `src/`. It lives
// here because it needs what only the test runner gives: plain Node cannot load the catalogs (their
// imports have no file extension, and no TypeScript loader is a dependency; plan S-W0-15), while
// vitest loads them, the real `tCount` with them, and `catalogOf` (i18n-catalogs.ts). The
// `tests/` tree typechecks (tsconfig.web.json) and is never part of the app build.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import {
  pluralKeyFor,
  tCount,
  uiLanguageInfo,
  type CountMessageKey,
  type PluralCategory,
  type UiLanguage
} from '../../src/shared/i18n'
import { I18N_DIR, catalogOf } from './i18n-catalogs'
import { DESKTOP_ROOT } from './repo-files'

type Catalog = Readonly<Record<string, string>>

// ---- Groups ------------------------------------------------------------------------------------

/** The table's three groups, in table order (#813: the security text first, then the review screen). */
const REVIEW_GROUPS = ['security', 'review', 'other'] as const
export type ReviewGroup = (typeof REVIEW_GROUPS)[number]

/** The privacy, password, lock-screen and workspace keys: a meaning error there is a safety error. */
const SECURITY_PREFIXES: readonly string[] = ['privacy.', 'password.', 'gate.', 'main.workspace.']

function reviewGroupOf(key: string): ReviewGroup {
  if (SECURITY_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'security'
  return key.startsWith('review.') ? 'review' : 'other'
}

// ---- Keys the code reads by their text (i18n record §3.3 Rule 3) --------------------------------

/**
 * A place in `src/` that recognises catalog text by comparing it with the catalog value in every
 * registered language. Rewording such a value, in any language, changes what the code recognises,
 * so the table marks these keys. The keys are read from the site's own source, never copied here:
 * the elements of the array a declaration is initialised with, or one argument of every call to a
 * function (inside one declaration, when `within` names it). A site whose shape changed throws
 * rather than marking nothing: the declaration or the call gone, an element or an argument that is
 * not a string literal (a key passed through a constant would go unmarked), or a literal that is
 * not a catalog key.
 */
export interface ExactMatchSite {
  /** The source file, relative to `apps/desktop`, with forward slashes. */
  file: string
  find: { array: string } | { calls: string; argument: number; within?: string }
  /** What a reviewer needs to know about these keys, in plain words. */
  reason: string
}

export const EXACT_MATCH_SITES: readonly ExactMatchSite[] = [
  {
    file: 'src/main/services/doctasks/manager.ts',
    find: { array: 'FRIENDLY_TASK_ERROR_KEYS' },
    reason:
      'A document task that fails with exactly this text shows it; any other text is replaced by ' +
      'the generic failure message (isFriendlyTaskError, doctasks/manager.ts).'
  },
  {
    file: 'src/renderer/screens/ChatScreen.tsx',
    find: { calls: 'tCatalog', argument: 1, within: 'STALE_MODEL_REFUSALS' },
    reason:
      'The chat screen clears a banner with exactly this text once the model is running ' +
      '(STALE_MODEL_REFUSALS, ChatScreen.tsx).'
  },
  {
    file: 'src/main/services/skills/analysis/bank-statement.ts',
    find: { calls: 'routedQuestions', argument: 0 },
    reason:
      'The bank-statement skill recognises this question by its exact text and answers it with ' +
      'the checked figures (routedQuestions, skills/analysis/bank-statement.ts).'
  },
  {
    file: 'src/main/services/analysis/router.ts',
    find: { calls: 'catalogValues', argument: 0 },
    reason:
      'The document chat recognises this example question by its text: the summarize chip by its ' +
      'whole text, the every-mention chip by the text around its quotes (catalogValues, ' +
      'analysis/router.ts).'
  }
]

/** `node` itself when it is a variable declaration named `name`, else undefined. */
const declarationNamed = (node: ts.Node, name: string): ts.VariableDeclaration | undefined =>
  ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name ? node : undefined

/** `node` without `as …` / `satisfies …` around it. */
function unwrapped(node: ts.Expression): ts.Expression {
  let value = node
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression
  return value
}

/** The catalog keys `site` reads, from its source text, in source order. */
function exactMatchSiteKeys(site: ExactMatchSite, sourceText: string, english: Catalog): string[] {
  const source = ts.createSourceFile(site.file, sourceText, ts.ScriptTarget.Latest, true)
  const find = site.find
  const what =
    'array' in find
      ? `the array of const ${find.array}`
      : `argument ${find.argument} of ${find.calls}()${find.within === undefined ? '' : ` in const ${find.within}`}`
  const fail = (problem: string): never => {
    throw new Error(`${site.file}: ${problem} (${what}); update EXACT_MATCH_SITES`)
  }
  const keys: string[] = []
  const take = (node: ts.Node | undefined): void => {
    if (node === undefined || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      fail(`${node === undefined ? 'nothing' : `'${node.getText(source)}'`} is not a string literal`)
      return
    }
    if (!Object.hasOwn(english, node.text)) fail(`'${node.text}' is not a catalog key`)
    keys.push(node.text)
  }
  const visit = (node: ts.Node, inside: boolean): void => {
    if ('array' in find) {
      const declaration = declarationNamed(node, find.array)
      if (declaration !== undefined) {
        const value = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer)
        if (value === undefined || !ts.isArrayLiteralExpression(value)) fail('not initialised with an array')
        else value.elements.forEach(take)
      }
    } else if (inside && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === find.calls) {
      take(node.arguments[find.argument])
    }
    const into = inside || ('calls' in find && find.within !== undefined && declarationNamed(node, find.within) !== undefined)
    ts.forEachChild(node, (child) => visit(child, into))
  }
  visit(source, !('calls' in find) || find.within === undefined)
  if (keys.length === 0) fail('no catalog key found')
  return [...new Set(keys)]
}

/** Every site with the keys it reads, from the committed source. */
export function exactMatchSitesWithKeys(): { site: ExactMatchSite; keys: string[] }[] {
  const english = catalogOf('en')
  return EXACT_MATCH_SITES.map((site) => ({
    site,
    keys: exactMatchSiteKeys(site, readFileSync(join(DESKTOP_ROOT, site.file), 'utf8'), english)
  }))
}

// ---- Code comments --------------------------------------------------------------------------------

/** The comments of one catalog key: the section heading it sits under, and the comment above it. */
interface KeyComments {
  section: string
  comment: string
}

/** The text of one comment, without its markers, one entry per line. */
function commentLines(text: string, range: ts.CommentRange): string[] {
  const raw = text.slice(range.pos, range.end)
  if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) return [raw.slice(2).trim()]
  return raw
    .slice(2, -2)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?/, '').trim())
}

/** Comment lines read as prose: wrapped lines joined by a space, a blank line starting a paragraph. */
function prose(lines: readonly string[]): string {
  const paragraphs: string[][] = [[]]
  for (const line of lines) {
    if (line === '') paragraphs.push([])
    else paragraphs[paragraphs.length - 1]!.push(line)
  }
  return paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(' '))
    .join('\n')
}

/** A section heading's text: `// ---- Home (HomeScreen.tsx) ----` gives `Home (HomeScreen.tsx)`. */
const headingName = (lines: readonly string[]): string =>
  lines.join(' ').replace(/^-+\s*/, '').replace(/\s*-+$/, '')

/**
 * The comments of every key of the catalog `exportName` in `sourceText`: the comments between the
 * previous key and this one, plus a comment on the key's own last line (`'k': 'v', // CODE-37`).
 * A comment that starts with `----` is a section heading (it runs to the line that ends with
 * `----`), not a key's comment; the key and every key after it sit in that section. A heading
 * ending in "— END" closes the block a "— BEGIN" heading opened: the section goes back to the one
 * before it.
 */
function catalogComments(sourceText: string, exportName: string): Map<string, KeyComments> {
  const source = ts.createSourceFile(`${exportName}.ts`, sourceText, ts.ScriptTarget.Latest, true)
  const literal = catalogLiteral(source, exportName)
  const out = new Map<string, KeyComments>()
  const opened: string[] = []
  let section = ''
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) {
      throw new Error(`${exportName}.ts: a catalog entry that is not 'key': value at ${property.getStart()}`)
    }
    const lines: string[] = []
    let previousEnd = -1
    let heading: string[] | null = null
    for (const range of ts.getLeadingCommentRanges(sourceText, property.getFullStart()) ?? []) {
      const text = commentLines(sourceText, range)
      if (heading === null && text[0]!.startsWith('----')) heading = []
      if (heading !== null) {
        heading.push(...text)
        if (!/-{4}\s*$/.test(text[text.length - 1]!)) continue
        const name = headingName(heading)
        if (/—\s*END$/.test(name)) section = opened.pop() ?? section
        else {
          if (/—\s*BEGIN$/.test(name)) opened.push(section)
          section = name.replace(/\s*—\s*BEGIN$/, '')
        }
        heading = null
        if (lines.length > 0) lines.push('')
        previousEnd = -1
        continue
      }
      if (previousEnd !== -1 && /\n[ \t]*\r?\n/.test(sourceText.slice(previousEnd, range.pos))) lines.push('')
      lines.push(...text)
      previousEnd = range.end
    }
    if (heading !== null) section = headingName(heading)
    let after = property.end
    while (sourceText[after] === ' ' || sourceText[after] === '\t') after++
    if (sourceText[after] === ',') after++
    for (const range of ts.getTrailingCommentRanges(sourceText, after) ?? []) {
      lines.push(...commentLines(sourceText, range))
    }
    out.set(property.name.text, { section, comment: prose(lines) })
  }
  return out
}

/** The object literal of `export const <name> = { … }` (also `{ … } as const`). */
function catalogLiteral(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const value = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer)
      if (value !== undefined && ts.isObjectLiteralExpression(value)) return value
    }
  }
  throw new Error(`${source.fileName}: no 'export const ${name} = { … }'`)
}

const catalogSource = (code: UiLanguage): string => readFileSync(join(I18N_DIR, `${code}.ts`), 'utf8')

// ---- The reviewer table -------------------------------------------------------------------------

export interface ReviewRow {
  group: ReviewGroup
  /** The `en.ts` section heading the key sits under (where in the app the text belongs). */
  section: string
  key: string
  /** English's text; for a plural form English does not have (`.few`, `.many`), English's `.other`. */
  english: string
  translation: string
  /** Why the code reads this key by its text (several reasons on separate lines), or empty. */
  exactMatch: string
  /** The comment above the key in `en.ts`. */
  englishComment: string
  /** The comment above the key in the language's own catalog file. */
  translationComment: string
}

interface ReviewTableInput {
  english: Catalog
  englishComments: ReadonlyMap<string, KeyComments>
  catalog: Catalog
  comments: ReadonlyMap<string, KeyComments>
  /** Key → the reasons the code reads it by its text. */
  exactMatch: ReadonlyMap<string, readonly string[]>
}

const PLURAL_FORM = /^(.*)\.(zero|one|two|few|many|other)$/

/** The English key standing for `key`: itself, or for a plural form English lacks, `<base>.other`. */
function englishKeyFor(english: Catalog, key: string): string {
  if (Object.hasOwn(english, key)) return key
  const form = PLURAL_FORM.exec(key)
  return form !== null ? `${form[1]}.other` : key
}

/** One row per key of `catalog`: the security keys first, then `review.*`, then the rest, each in catalog order. */
function buildReviewTable(input: ReviewTableInput): ReviewRow[] {
  const keys = Object.keys(input.catalog)
  const rows = keys.map((key): ReviewRow => {
    const englishKey = englishKeyFor(input.english, key)
    return {
      group: reviewGroupOf(key),
      section: input.englishComments.get(englishKey)?.section ?? '',
      key,
      english: input.english[englishKey] ?? '',
      translation: input.catalog[key]!,
      exactMatch: (input.exactMatch.get(key) ?? []).join('\n'),
      englishComment: input.englishComments.get(key)?.comment ?? '',
      translationComment: input.comments.get(key)?.comment ?? ''
    }
  })
  return REVIEW_GROUPS.flatMap((group) => rows.filter((row) => row.group === group))
}

/** The reviewer table of a registered language, from the committed catalogs and sources. */
export function reviewTableFor(code: UiLanguage): ReviewRow[] {
  const exactMatch = new Map<string, string[]>()
  for (const { site, keys } of exactMatchSitesWithKeys()) {
    for (const key of keys) exactMatch.set(key, [...(exactMatch.get(key) ?? []), site.reason])
  }
  return buildReviewTable({
    english: catalogOf('en'),
    englishComments: catalogComments(catalogSource('en'), 'en'),
    catalog: catalogOf(code),
    comments: code === 'en' ? new Map() : catalogComments(catalogSource(code), code),
    exactMatch
  })
}

// ---- The plural-edge sheet -------------------------------------------------------------------------

/** The counts every plural base is rendered at (#813): where a language's forms change. */
const PLURAL_EDGE_COUNTS: readonly number[] = [0, 1, 2, 5, 21, 22, 25, 101, 1_000_000]

/**
 * Counts tried, in order, for a form no edge count takes (Polish, Russian and Ukrainian `.other`
 * is a fraction's form): the sheet gets one more row per such form, so that every form is seen.
 */
const EXTRA_COUNTS: readonly number[] = [1.5, 0.5, 2.5]

export interface PluralRow {
  base: string
  count: number
  /** The plural category the language's rule picks for `count`. */
  category: PluralCategory
  /** The key `tCount` renders: `<base>.<category>`, or `<base>.other` when the catalog lacks the form. */
  key: string
  translation: string
  english: string
  /** Empty for an edge count; says why for an extra count. */
  note: string
}

/** The plural bases of `catalog`: `X` with both `X.one` and `X.other`, in catalog order. */
function pluralBasesOf(catalog: Catalog): string[] {
  return Object.keys(catalog)
    .filter((key) => key.endsWith('.one') && Object.hasOwn(catalog, `${key.slice(0, -'.one'.length)}.other`))
    .map((key) => key.slice(0, -'.one'.length))
}

/** Every `{name}` placeholder of `base`'s forms in `catalogs`, except `{count}`. */
function otherPlaceholders(base: string, catalogs: readonly Catalog[]): string[] {
  const names = new Set<string>()
  for (const catalog of catalogs) {
    for (const [key, value] of Object.entries(catalog)) {
      if (PLURAL_FORM.exec(key)?.[1] !== base) continue
      for (const match of value.matchAll(/\{(\w+)\}/g)) names.add(match[1]!)
    }
  }
  names.delete('count')
  return [...names]
}

/**
 * For every plural base of the language, one row per edge count (and per extra count, see
 * `EXTRA_COUNTS`), rendered through the real `tCount`. A placeholder other than `{count}` is passed
 * itself as its value, so it stays visible as `{name}`: left unset, `t` would fall back to English.
 */
export function pluralSheetFor(code: UiLanguage): PluralRow[] {
  const info = uiLanguageInfo(code)
  const catalog = catalogOf(code)
  const english = catalogOf('en')
  const counts = [...PLURAL_EDGE_COUNTS]
  const notes = new Map<number, string>()
  for (const category of info.pluralCategories) {
    if (counts.some((count) => info.plural(count) === category)) continue
    const extra = EXTRA_COUNTS.find((count) => info.plural(count) === category)
    if (extra === undefined) throw new Error(`${code}: no count in EXTRA_COUNTS takes the '${category}' form`)
    counts.push(extra)
    notes.set(extra, `No edge count takes the "${category}" form; a fraction does.`)
  }
  return pluralBasesOf(catalog).flatMap((base) => {
    const params = Object.fromEntries(otherPlaceholders(base, [catalog, english]).map((name) => [name, `{${name}}`]))
    const keyBase = base as CountMessageKey
    return counts.map((count): PluralRow => {
      return {
        base,
        count,
        category: info.plural(count),
        key: pluralKeyFor(info, base, count, (key) => Object.hasOwn(catalog, key)),
        translation: tCount(code, keyBase, count, params),
        english: tCount('en', keyBase, count, params),
        note: notes.get(count) ?? ''
      }
    })
  })
}

// ---- CSV ----------------------------------------------------------------------------------------------

/** UTF-8 byte order mark: it tells a spreadsheet app the file is UTF-8 (written as an escape, never raw). */
const BOM = '\uFEFF'

/** One RFC 4180 field: quoted when it holds a quote, a comma or a line break, its quotes doubled. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** RFC 4180 CSV (CRLF between records, a line break inside a value kept inside its quotes), with a BOM. */
export function toCsv(records: readonly (readonly string[])[]): string {
  return BOM + records.map((record) => record.map(csvField).join(',')).join('\r\n') + '\r\n'
}

const REVIEW_CSV_HEADER: readonly string[] = [
  'group',
  'section',
  'key',
  'english',
  'translation',
  'exact_match',
  'exact_match_reason',
  'english_comment',
  'translation_comment'
]

export function reviewCsv(rows: readonly ReviewRow[]): string {
  return toCsv([
    REVIEW_CSV_HEADER,
    ...rows.map((row) => [
      row.group,
      row.section,
      row.key,
      row.english,
      row.translation,
      row.exactMatch === '' ? '' : 'yes',
      row.exactMatch,
      row.englishComment,
      row.translationComment
    ])
  ])
}

const PLURAL_CSV_HEADER: readonly string[] = ['base', 'count', 'category', 'key', 'translation', 'english', 'note']

export function pluralCsv(rows: readonly PluralRow[]): string {
  return toCsv([
    PLURAL_CSV_HEADER,
    ...rows.map((row) => [row.base, String(row.count), row.category, row.key, row.translation, row.english, row.note])
  ])
}
