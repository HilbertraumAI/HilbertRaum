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
//
// No cell holds a line break: a spreadsheet's import can split a record at one even inside quotes.
// Comments and headings are joined into one line, and a line break in a catalog value (none has
// one today) is shown as the two characters `\n`.
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

/** Computes `make()` on the first call and returns that value from then on. */
function once<T>(make: () => T): () => T {
  let value: { readonly made: T } | undefined
  return () => (value ??= { made: make() }).made
}

/** `value` on one line: a line break shown as the two characters `\n`. */
const oneLine = (value: string): string => value.replace(/\r\n|\r|\n/g, '\\n')

// ---- Groups ------------------------------------------------------------------------------------

/** The table's three groups, in table order (#813: the security text first, then the review screen). */
const REVIEW_GROUPS = ['security', 'review', 'other'] as const
export type ReviewGroup = (typeof REVIEW_GROUPS)[number]

/**
 * The privacy, security, encryption, password, lock and network/offline text, read first: a
 * meaning error there is a safety error. An entry is a key or a key namespace and covers the key
 * and every key under it (`settings.network` covers `settings.network.hint`, a plural base its
 * forms). #813 named the first four; the others are the keys elsewhere whose English makes such a
 * claim. Left out on purpose: labels and status lines that claim nothing ("Local API", "Port
 * number", "Workspace"), the "Workspace is locked. Unlock it to …" refusals, which only report the
 * state, and copy that only names an offline feature ("an offline Wikipedia").
 */
export const SECURITY_TEXT: readonly string[] = [
  // #813's four: privacy settings, passwords, the lock screen, the workspace's own messages.
  'privacy',
  'password',
  'gate',
  'main.workspace',
  // Locking and encryption.
  'app.lockNow',
  'app.lockNowTitle',
  'home.workspace.encrypted',
  'home.workspace.plaintext',
  'home.workspace.badgeProtected',
  'settings.workspace.modeEncrypted',
  'settings.workspace.modePlaintext',
  'settings.workspace.encryptedHint',
  'settings.workspace.plaintextHint',
  'settings.changePassword',
  'settings.developer.toggle',
  'settings.developer.hint',
  // #932: when a model with no checksum on record may run (developer mode and the drive policy).
  'models.noChecksum.hint',
  'docs.exportOriginal.warning',
  'review.export.encryptionWarning',
  'packExport.privacy',
  'packExport.integrity.hashNote',
  'packExport.sources.pathNote',
  'diag.audit.workspace_lock_failed',
  'diag.audit.workspace_working_copy_lost',
  // Network and offline.
  'settings.tab.privacy',
  'settings.network',
  'indicator',
  'models.confirm.hint',
  'models.engineConfirm.hint',
  'diag.audit.offline_guard_violation',
  'skills.intro',
  'skills.perm',
  'ocr.install.confirm.explain',
  'packs.tools.confirm.hint',
  'packs.tools.confirm.explain',
  // The local API: which programs can reach the model, and with what.
  'settings.localApi.lead',
  'settings.localApi.toggle',
  'settings.localApi.hint',
  'settings.localApi.confirm',
  'settings.localApi.token',
  'settings.localApi.connect.copiedKey',
  'settings.localApi.connect.noKey',
  'settings.localApi.error.portInUse',
  // Where the user's data goes ("stays on this device", "nothing leaves this drive").
  'home.lead',
  'chat.noModel.hintAfter',
  'chat.empty.lineChat',
  'chat.actions.saveTitle',
  'chat.actions.exportCsvTitle',
  'chat.code.saveTitle',
  'docs.lead',
  'docs.empty.line',
  'docs.compareBtnTitle',
  'docs.previewTitle',
  'docs.makeSearchableTitle',
  'docs.translateModal.hint',
  'images.empty.body',
  'translate.lead',
  'translate.avail.hint',
  'models.lead',
  'models.hint.translation',
  'perf.lead',
  'diag.localOnly',
  'diag.activity.hint',
  'diag.logs.hintBefore',
  'diag.logs.hintAfter',
  'diag.bench.hint',
  'skills.redactionRouting.answer',
  'skills.redactionRouting.answerMulti',
  'skills.editRouting.answer',
  'skills.editRouting.answerMulti',
  // Redaction: what was hidden, and how sure that is.
  'chat.skill.run.done.redacted',
  'chat.skill.run.done.redactedClean',
  'chat.skill.run.done.redactedFloor',
  'chat.skill.run.done.redactedCleanFloor',
  'chat.skill.run.done.redactedCapped',
  'chat.skill.confirm.redactionScope',
  'skills.redactionRouting.scan',
  'skills.info.document-redaction.what',
  'skills.info.share-safe-review.limits',
  // App-update copy deck part 1 (T2.6): the legal-sensitive texts release 1 keeps for ever, what it says about a
  // workspace, model, skill, pack or stored text a newer version made. Exact keys, so no sibling comes along
  // (`skills.reconcile.needsNewerApp` is a plural base: its forms only; `skills.tool.note` also covers
  // `skills.tool.note.active`, the tool-run promise beside it). `main.workspace` above already holds C01 and X01.
  'common.newerVersionText',
  'packs.state.newerFormatTitle',
  'packs.addFailed.newerFormat',
  'skills.reconcile.needsNewerApp',
  'analysis.newerExtractorNote',
  'models.newerApp.hint',
  'skills.incompatible.title',
  'main.skills.incompatible',
  'skills.tool.note',
  'skills.import.note.allowedToolsIgnored',
  'chat.packs.outcome.newer-format'
]

const isSecurityText = (key: string): boolean =>
  SECURITY_TEXT.some((entry) => key === entry || key.startsWith(`${entry}.`))

/** Throws when a `SECURITY_TEXT` entry covers no English key (renamed or removed). */
const checkSecurityText = once((): true => {
  const keys = Object.keys(catalogOf('en'))
  const stale = SECURITY_TEXT.filter((entry) => !keys.some((key) => key === entry || key.startsWith(`${entry}.`)))
  if (stale.length > 0) throw new Error(`SECURITY_TEXT covers no key any more: ${stale.join(', ')}`)
  return true
})

function reviewGroupOf(key: string): ReviewGroup {
  if (isSecurityText(key)) return 'security'
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
  /** What a reviewer needs to know about these keys, in plain words: one sentence. */
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
    file: 'src/main/services/analysis/example-chips.ts',
    find: { calls: 'catalogValues', argument: 0 },
    reason:
      'The document chat recognises this example question by its text: the summarize chip by its ' +
      'whole text, the every-mention chip by the text around its quotes, for the router and for ' +
      'the single-fact check of a whole-document skill (catalogValues, analysis/example-chips.ts).'
  }
]

/** The reason a key with the same English text as `readKey`, a key the code reads, is marked too. */
export const twinReason = (readKey: string): string =>
  `Same English text as ${readKey}, which the code reads by its text: keep the two translations identical.`

/** `node` itself when it is a variable declaration named `name`, else undefined. */
const declarationNamed = (node: ts.Node, name: string): ts.VariableDeclaration | undefined =>
  ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name ? node : undefined

/** `node` without `as …` / `satisfies …` around it. */
function unwrapped(node: ts.Expression): ts.Expression {
  let value = node
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression
  return value
}

/** The nodes `site` names a key with: the array's elements, or the argument of each matching call. */
function siteKeyNodes(site: ExactMatchSite, source: ts.SourceFile, fail: (problem: string) => never): (ts.Node | undefined)[] {
  const nodes: (ts.Node | undefined)[] = []
  const find = site.find
  if ('array' in find) {
    const visit = (node: ts.Node): void => {
      const declaration = declarationNamed(node, find.array)
      if (declaration === undefined) return ts.forEachChild(node, visit)
      const value = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer)
      if (value === undefined || !ts.isArrayLiteralExpression(value)) fail('not initialised with an array')
      nodes.push(...value.elements)
    }
    visit(source)
    return nodes
  }
  const visit = (node: ts.Node, inside: boolean): void => {
    if (inside && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === find.calls) {
      nodes.push(node.arguments[find.argument])
    }
    const into = inside || (find.within !== undefined && declarationNamed(node, find.within) !== undefined)
    ts.forEachChild(node, (child) => visit(child, into))
  }
  visit(source, find.within === undefined)
  return nodes
}

/** The catalog keys `site` reads, from its source text, in source order. */
function exactMatchSiteKeys(site: ExactMatchSite, sourceText: string, english: Catalog): string[] {
  const find = site.find
  const what =
    'array' in find
      ? `the array of const ${find.array}`
      : `argument ${find.argument} of ${find.calls}()${find.within === undefined ? '' : ` in const ${find.within}`}`
  function fail(problem: string): never {
    throw new Error(`${site.file}: ${problem} (${what}); update EXACT_MATCH_SITES`)
  }
  const source = ts.createSourceFile(site.file, sourceText, ts.ScriptTarget.Latest, true)
  const keys = siteKeyNodes(site, source, fail).map((node) => {
    if (node === undefined || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      fail(`${node === undefined ? 'nothing' : `'${node.getText(source)}'`} is not a string literal`)
    }
    if (!Object.hasOwn(english, node.text)) fail(`'${node.text}' is not a catalog key`)
    return node.text
  })
  if (keys.length === 0) fail('no catalog key found')
  return [...new Set(keys)]
}

/** Every site with the keys it reads, from the committed source (read once). */
export const exactMatchSitesWithKeys = once((): readonly { site: ExactMatchSite; keys: readonly string[] }[] => {
  const english = catalogOf('en')
  return EXACT_MATCH_SITES.map((site) => ({
    site,
    keys: exactMatchSiteKeys(site, readFileSync(join(DESKTOP_ROOT, site.file), 'utf8'), english)
  }))
})

/**
 * The twins: key → the keys a site reads whose English text is the same as its own. The code compares
 * text, so it cannot tell the two apart (`translate.err.startFailed` passes the doc-task filter as
 * `main.translation.startFailed`), and the two translations have to stay identical.
 */
export const exactMatchTwins = once((): ReadonlyMap<string, readonly string[]> => {
  const english = catalogOf('en')
  const read = [...new Set(exactMatchSitesWithKeys().flatMap(({ keys }) => keys))]
  const twins = new Map<string, string[]>()
  for (const key of Object.keys(english)) {
    const of = read.filter((readKey) => readKey !== key && english[readKey] === english[key])
    if (of.length > 0) twins.set(key, of)
  }
  return twins
})

/** Key → why it is marked: the reason of every site that reads it, then a `twinReason` per key it is a twin of. */
const exactMatchReasons = once((): ReadonlyMap<string, readonly string[]> => {
  const reasons = new Map<string, string[]>()
  const add = (key: string, reason: string): void => {
    reasons.set(key, [...(reasons.get(key) ?? []), reason])
  }
  for (const { site, keys } of exactMatchSitesWithKeys()) for (const key of keys) add(key, site.reason)
  for (const [key, readKeys] of exactMatchTwins()) for (const readKey of readKeys) add(key, twinReason(readKey))
  return reasons
})

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

/** Comment lines as one line of prose. */
const prose = (lines: readonly string[]): string => lines.filter((line) => line !== '').join(' ')

/** A section heading's text: `// ---- Home (HomeScreen.tsx) ----` gives `Home (HomeScreen.tsx)`. */
const headingName = (lines: readonly string[]): string =>
  prose(lines).replace(/^-+\s*/, '').replace(/\s*-+$/, '')

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
    let heading: string[] | null = null
    for (const range of ts.getLeadingCommentRanges(sourceText, property.getFullStart()) ?? []) {
      const text = commentLines(sourceText, range)
      if (heading === null && text[0]!.startsWith('----')) heading = []
      if (heading === null) {
        lines.push(...text)
        continue
      }
      heading.push(...text)
      if (!/-{4}\s*$/.test(text[text.length - 1]!)) continue
      const name = headingName(heading)
      if (/—\s*END$/.test(name)) section = opened.pop() ?? section
      else {
        if (/—\s*BEGIN$/.test(name)) opened.push(section)
        section = name.replace(/\s*—\s*BEGIN$/, '')
      }
      heading = null
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

/** The comments of `en.ts` (read once). */
const englishComments = once(() => catalogComments(catalogSource('en'), 'en'))

// ---- The reviewer table -------------------------------------------------------------------------

export interface ReviewRow {
  group: ReviewGroup
  /** The `en.ts` section heading the key sits under (where in the app the text belongs). */
  section: string
  key: string
  /** English's text; for a plural form English does not have (`.few`, `.many`), English's `.other`. */
  english: string
  translation: string
  /** Why the code reads this key by its text, one sentence each; empty when it does not. */
  exactMatch: readonly string[]
  /** The comment above the key in `en.ts`; for every form of a plural base, the base's note (above `.one` and `.other`). */
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

/** The plural base `key` is a form of in `english` (both `<base>.one` and `<base>.other` exist), or null. */
function pluralBaseOf(english: Catalog, key: string): string | null {
  const base = PLURAL_FORM.exec(key)?.[1]
  return base !== undefined && Object.hasOwn(english, `${base}.one`) && Object.hasOwn(english, `${base}.other`)
    ? base
    : null
}

/** One row per key of `catalog`: the security text first, then `review.*`, then the rest, each in catalog order. */
function buildReviewTable(input: ReviewTableInput): ReviewRow[] {
  const commentOf = (key: string): string => input.englishComments.get(key)?.comment ?? ''
  const rows = Object.keys(input.catalog).map((key): ReviewRow => {
    const base = pluralBaseOf(input.english, key)
    const englishKey = base !== null && !Object.hasOwn(input.english, key) ? `${base}.other` : key
    return {
      group: reviewGroupOf(key),
      section: input.englishComments.get(englishKey)?.section ?? '',
      key,
      english: oneLine(input.english[englishKey] ?? ''),
      translation: oneLine(input.catalog[key]!),
      exactMatch: input.exactMatch.get(key) ?? [],
      englishComment: base === null ? commentOf(key) : prose([commentOf(`${base}.one`), commentOf(`${base}.other`)]),
      translationComment: input.comments.get(key)?.comment ?? ''
    }
  })
  return REVIEW_GROUPS.flatMap((group) => rows.filter((row) => row.group === group))
}

/** The reviewer table of a registered language, from the committed catalogs and sources. */
export function reviewTableFor(code: UiLanguage): ReviewRow[] {
  checkSecurityText()
  return buildReviewTable({
    english: catalogOf('en'),
    englishComments: englishComments(),
    catalog: catalogOf(code),
    comments: code === 'en' ? new Map() : catalogComments(catalogSource(code), code),
    exactMatch: exactMatchReasons()
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

/** Plural base → the `{name}` placeholders of its forms in `catalogs`, `{count}` left out; one pass per catalog. */
function placeholdersByBase(catalogs: readonly Catalog[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const catalog of catalogs) {
    for (const [key, value] of Object.entries(catalog)) {
      const base = PLURAL_FORM.exec(key)?.[1]
      if (base === undefined) continue
      const names = out.get(base) ?? new Set<string>()
      for (const match of value.matchAll(/\{(\w+)\}/g)) if (match[1] !== 'count') names.add(match[1]!)
      out.set(base, names)
    }
  }
  return out
}

/**
 * For every plural base of the language, one row per edge count (and per extra count, see
 * `EXTRA_COUNTS`), rendered through the real `tCount`. A placeholder other than `{count}` is passed
 * itself as its value, so it stays visible as `{name}`: left unset, `t` would fall back to English.
 */
export function pluralSheetFor(code: UiLanguage): PluralRow[] {
  const info = uiLanguageInfo(code)
  const catalog = catalogOf(code)
  const counts = [...PLURAL_EDGE_COUNTS]
  const notes = new Map<number, string>()
  for (const category of info.pluralCategories) {
    if (counts.some((count) => info.plural(count) === category)) continue
    const extra = EXTRA_COUNTS.find((count) => info.plural(count) === category)
    if (extra === undefined) throw new Error(`${code}: no count in EXTRA_COUNTS takes the '${category}' form`)
    counts.push(extra)
    notes.set(extra, `No edge count takes the "${category}" form; a fraction does.`)
  }
  const placeholders = placeholdersByBase([catalog, catalogOf('en')])
  return pluralBasesOf(catalog).flatMap((base) => {
    const params = Object.fromEntries([...(placeholders.get(base) ?? [])].map((name) => [name, `{${name}}`]))
    const keyBase = base as CountMessageKey
    return counts.map(
      (count): PluralRow => ({
        base,
        count,
        category: info.plural(count),
        key: pluralKeyFor(info, base, count, (key) => Object.hasOwn(catalog, key)),
        translation: oneLine(tCount(code, keyBase, count, params)),
        english: oneLine(tCount('en', keyBase, count, params)),
        note: notes.get(count) ?? ''
      })
    )
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

/** The review table as CSV; several exact-match reasons are sentences, joined by a space. */
export function reviewCsv(rows: readonly ReviewRow[]): string {
  return toCsv([
    REVIEW_CSV_HEADER,
    ...rows.map((row) => [
      row.group,
      row.section,
      row.key,
      row.english,
      row.translation,
      row.exactMatch.length === 0 ? '' : 'yes',
      row.exactMatch.join(' '),
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
