import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'
import { parse } from 'yaml'
import { uiLanguageInfo, UI_LANGUAGE_CODES, UI_LANGUAGES, type UiLanguage } from '../../src/shared/i18n'
import { isFriendlyTaskError } from '../../src/main/services/doctasks/manager'
import { I18N_DIR, catalogOf } from '../helpers/i18n-catalogs'
import {
  EXACT_MATCH_SITES,
  exactMatchSitesWithKeys,
  pluralCsv,
  pluralSheetFor,
  reviewCsv,
  reviewTableFor,
  toCsv,
  type PluralRow,
  type ReviewRow
} from '../helpers/i18n-review-export'
import { DESKTOP_ROOT, filesUnder, repoText } from '../helpers/repo-files'

// The native-review kit's builder (#813, tests/helpers/i18n-review-export.ts): what a reviewer is
// handed must be the whole catalog in the order #813 asks for, every plural form at the edge
// counts, CSV a spreadsheet reads back whole, and an exact-match mark on every key the code reads by
// its text. The export itself is tests/manual/i18n-review-export.test.ts.

const tables = new Map<UiLanguage, ReviewRow[]>()
const tableOf = (code: UiLanguage): ReviewRow[] => {
  if (!tables.has(code)) tables.set(code, reviewTableFor(code))
  return tables.get(code)!
}
const english = catalogOf('en')

/** A strict RFC 4180 reader (CRLF records, quoted fields, doubled quotes); throws on anything else. */
function readCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let i = 0
  while (i < text.length) {
    if (field === '' && text[i] === '"') {
      i++
      for (;;) {
        if (i >= text.length) throw new Error('unclosed quote')
        if (text[i] === '"' && text[i + 1] === '"') (field += '"'), (i += 2)
        else if (text[i] === '"') break
        else field += text[i++]
      }
      i++
      if (i < text.length && text[i] !== ',' && text[i] !== '\r') throw new Error(`text after a closing quote at ${i}`)
      continue
    }
    if (text[i] === ',') {
      record.push(field)
      field = ''
      i++
    } else if (text.startsWith('\r\n', i)) {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      i += 2
    } else if ('"\r\n'.includes(text[i]!)) {
      throw new Error(`unquoted ${JSON.stringify(text[i])} at ${i}`)
    } else field += text[i++]
  }
  if (field !== '' || record.length > 0) throw new Error('the last record does not end with CRLF')
  return records
}

describe('the reviewer table (#813)', () => {
  // #813's order: the privacy, password, lock-screen and workspace text, then the review screen.
  const security = (key: string): boolean =>
    ['privacy.', 'password.', 'gate.', 'main.workspace.'].some((prefix) => key.startsWith(prefix))
  const review = (key: string): boolean => !security(key) && key.startsWith('review.')

  it.each(UI_LANGUAGE_CODES)('%s: every catalog key once, the security keys first, then review.*, each group in catalog order', (code) => {
    const catalog = catalogOf(code)
    const keys = Object.keys(catalog)
    const expected = [
      ...keys.filter(security),
      ...keys.filter(review),
      ...keys.filter((key) => !security(key) && !review(key))
    ]
    const rows = tableOf(code)
    expect(rows.map((row) => row.key)).toEqual(expected)
    expect(rows.map((row) => row.group)).toEqual(
      expected.map((key) => (security(key) ? 'security' : review(key) ? 'review' : 'other'))
    )
    expect(rows.some((row) => row.group === 'security') && rows.some((row) => row.group === 'review')).toBe(true)
    for (const row of rows) {
      expect(row.translation).toBe(catalog[row.key])
      // A form English lacks (Russian `.few`) shows English's plural.
      expect(row.english).toBe(english[row.key] ?? english[row.key.replace(/\.[a-z]+$/, '.other')])
    }
  })

  /**
   * Every `//` line inside the catalog literal of `<code>.ts`, keyed by the first key line after it
   * (a comment on a key's own line belongs to that key). Section headings (`// ---- … ----`) are
   * left out: they are the section column, not a key's comment.
   */
  function commentLinesByKey(code: UiLanguage): Map<string, string[]> {
    const lines = readFileSync(join(I18N_DIR, `${code}.ts`), 'utf8').split(/\r?\n/)
    const out = new Map<string, string[]>()
    let pending: string[] = []
    let heading = false
    for (const line of lines.slice(lines.findIndex((l) => l.startsWith(`export const ${code}`)) + 1)) {
      const comment = /^\s*\/\/(.*)$/.exec(line)?.[1]?.trim()
      if (comment !== undefined) {
        if (comment.startsWith('----')) heading = true
        if (heading) heading = !/-{4}\s*$/.test(comment)
        else if (comment !== '') pending.push(comment)
        continue
      }
      const key = /^\s*'([^']+)':/.exec(line)?.[1]
      if (key === undefined) continue
      const trailing = /',\s*\/\/(.*)$/.exec(line)?.[1]?.trim()
      out.set(key, trailing === undefined ? pending : [...pending, trailing])
      pending = []
    }
    return out
  }

  it.each(UI_LANGUAGE_CODES)('%s: every comment line of the catalog file is on the row of the key below it, and only there', (code) => {
    const fromFile = commentLinesByKey(code)
    const rows = tableOf(code)
    const commentOf = (row: ReviewRow): string => (code === 'en' ? row.englishComment : row.translationComment)
    for (const row of rows) {
      const lines = fromFile.get(row.key) ?? []
      for (const line of lines) expect(commentOf(row), row.key).toContain(line)
      if (lines.length === 0) expect(commentOf(row), row.key).toBe('')
    }
    if (code !== 'en') {
      const englishLines = commentLinesByKey('en')
      for (const row of rows) for (const line of englishLines.get(row.key) ?? []) expect(row.englishComment).toContain(line)
    }
    expect(rows.every((row) => row.section !== '')).toBe(true)
  })

  it('en: the section is the en.ts heading above the key; after an "— END" heading, the one its "— BEGIN" left', () => {
    const sections = new Map(tableOf('en').map((row) => [row.key, row.section]))
    expect(sections.get('gate.unlock.title')).toBe('Workspace gate (WorkspaceGate.tsx)')
    const lines = readFileSync(join(I18N_DIR, 'en.ts'), 'utf8').split(/\r?\n/)
    const keys = (from: number, to: number): string[] =>
      lines.slice(from, to).flatMap((line) => /^\s*'([^']+)':/.exec(line)?.[1] ?? [])
    const begin = lines.findIndex((line) => /^\s*\/\/ ----.*— BEGIN/.test(line))
    const end = lines.findIndex((line, index) => index > begin && /^\s*\/\/ ----.*— END/.test(line))
    expect(begin > -1 && end > begin).toBe(true)
    const before = sections.get(keys(0, begin).at(-1)!)
    expect(sections.get(keys(begin, end)[0]!)).not.toBe(before)
    expect(sections.get(keys(end, lines.length)[0]!)).toBe(before)
  })
})

describe('the plural-edge sheet (#813)', () => {
  const EDGES = [0, 1, 2, 5, 21, 22, 25, 101, 1_000_000]

  it.each(UI_LANGUAGE_CODES)('%s: every plural base at the nine edge counts, every form of the language shown, rendered by tCount', (code) => {
    const info = uiLanguageInfo(code)
    const catalog = catalogOf(code)
    const bases = Object.keys(catalog)
      .filter((key) => key.endsWith('.one') && `${key.slice(0, -4)}.other` in catalog)
      .map((key) => key.slice(0, -4))
    const byBase = new Map<string, PluralRow[]>()
    for (const row of pluralSheetFor(code)) byBase.set(row.base, [...(byBase.get(row.base) ?? []), row])
    expect([...byBase.keys()]).toEqual(bases)
    for (const [base, rows] of byBase) {
      expect(rows.slice(0, EDGES.length).map((row) => row.count)).toEqual(EDGES)
      expect(new Set(rows.map((row) => row.category))).toEqual(new Set(info.pluralCategories))
      rows.forEach((row, index) => {
        expect(row.category).toBe(info.plural(row.count))
        expect(row.key).toBe(`${base}.${row.category}`)
        // The language's own form, its other placeholders left visible (no English fallback).
        expect(row.translation).toBe(catalog[row.key]!.replaceAll('{count}', String(row.count)))
        const englishForm = `${base}.${row.count === 1 ? 'one' : 'other'}`
        expect(row.english).toBe(english[englishForm]!.replaceAll('{count}', String(row.count)))
        expect(row.note === '').toBe(index < EDGES.length)
      })
    }
  })
})

describe('the CSV files (#813)', () => {
  it('are RFC 4180 with a BOM: a value with a comma, a quote and a line break reads back whole', () => {
    const records = [
      ['plain', 'a, b', 'say "hi"', 'line 1\nline 2', '"quoted", then\r\nmore', ''],
      ['', 'ü «Джерела»', 'x']
    ]
    const csv = toCsv(records)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(readCsv(csv.slice(1))).toEqual(records)
  })

  // The columns a reviewer reads, in file order: the header, and what each record holds under it.
  const REVIEW_COLUMNS: readonly (readonly [string, (row: ReviewRow) => string])[] = [
    ['group', (row) => row.group],
    ['section', (row) => row.section],
    ['key', (row) => row.key],
    ['english', (row) => row.english],
    ['translation', (row) => row.translation],
    ['exact_match', (row) => (row.exactMatch === '' ? '' : 'yes')],
    ['exact_match_reason', (row) => row.exactMatch],
    ['english_comment', (row) => row.englishComment],
    ['translation_comment', (row) => row.translationComment]
  ]
  const PLURAL_COLUMNS: readonly (readonly [string, (row: PluralRow) => string])[] = [
    ['base', (row) => row.base],
    ['count', (row) => String(row.count)],
    ['category', (row) => row.category],
    ['key', (row) => row.key],
    ['translation', (row) => row.translation],
    ['english', (row) => row.english],
    ['note', (row) => row.note]
  ]

  it.each(UI_LANGUAGE_CODES.filter((code) => code !== 'en'))('%s: both files read back, record for record, to the rows they were written from', (code) => {
    const rows = tableOf(code)
    expect(readCsv(reviewCsv(rows).slice(1))).toEqual([
      REVIEW_COLUMNS.map(([name]) => name),
      ...rows.map((row) => REVIEW_COLUMNS.map(([, cell]) => cell(row)))
    ])
    const plurals = pluralSheetFor(code)
    expect(readCsv(pluralCsv(plurals).slice(1))).toEqual([
      PLURAL_COLUMNS.map(([name]) => name),
      ...plurals.map((row) => PLURAL_COLUMNS.map(([, cell]) => cell(row)))
    ])
  })
})

describe('the exact-match column (#813, i18n record §3.3 Rule 3)', () => {
  const sites = exactMatchSitesWithKeys()
  const marked = (reason: string): string[] =>
    tableOf('en')
      .filter((row) => row.exactMatch.split('\n').includes(reason))
      .map((row) => row.key)

  it('marks exactly the keys whose text the doc-task filter passes through', () => {
    const friendly = EXACT_MATCH_SITES.find((site) => site.file.endsWith('doctasks/manager.ts'))!
    const passed = Object.keys(english).filter((key) => isFriendlyTaskError(english[key]!))
    const keys = marked(friendly.reason)
    // The filter sees text, not keys: a key whose English text is a marked key's (the Images and
    // Translate copies of "cannot run") passes too, without the code reading that key.
    expect(keys.filter((key) => !passed.includes(key))).toEqual([])
    expect(passed.filter((key) => !keys.some((own) => english[own] === english[key]))).toEqual([])
  })

  it('marks each site\'s keys with its reason in every language, and no other key', () => {
    for (const code of UI_LANGUAGE_CODES) {
      for (const row of tableOf(code)) {
        const reasons = sites.filter(({ keys }) => keys.includes(row.key)).map(({ site }) => site.reason)
        expect(row.exactMatch.split('\n').filter((reason) => reason !== '')).toEqual(reasons)
      }
    }
    expect(sites.every(({ keys }) => keys.length > 0)).toBe(true)
  })

  // Code that compares text with every catalog iterates the registry (Rule 3), so every read of
  // the registry outside shared/i18n is an exact-match site the kit knows (one read per site) or a
  // read that compares no text. A new read, also in a file listed here, is a site to look at.
  const READS_COMPARING_NO_TEXT: Readonly<Record<string, number>> = {
    'src/renderer/screens/SettingsScreen.tsx': 1 // the language picker lists the registry
  }

  /** The reads of `UI_LANGUAGES` / `UI_LANGUAGE_CODES` in `path`, under whatever name it imports them, outside imports and comments. */
  function registryReads(path: string, text: string): number {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const names = new Set(['UI_LANGUAGES', 'UI_LANGUAGE_CODES'])
    const visitImports = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) && names.has((node.propertyName ?? node.name).text)) names.add(node.name.text)
      ts.forEachChild(node, visitImports)
    }
    visitImports(source)
    let reads = 0
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return
      if (ts.isIdentifier(node) && names.has(node.text)) reads++
      ts.forEachChild(node, visit)
    }
    visit(source)
    return reads
  }

  it('knows every read of the registry in src outside shared/i18n', () => {
    const reads: Record<string, number> = {}
    for (const path of filesUnder(join(DESKTOP_ROOT, 'src'), /\.tsx?$/)) {
      const file = relative(DESKTOP_ROOT, path).split('\\').join('/')
      const text = readFileSync(path, 'utf8')
      if (file.startsWith('src/shared/i18n/') || !text.includes('UI_LANGUAGE')) continue
      const count = registryReads(file, text)
      if (count > 0) reads[file] = count
    }
    const expected: Record<string, number> = { ...READS_COMPARING_NO_TEXT }
    for (const { file } of EXACT_MATCH_SITES) expected[file] = (expected[file] ?? 0) + 1
    expect(reads).toEqual(expected)
  })
})

describe('the translation-finding issue form (#813)', () => {
  it('offers every registered language by its own name', () => {
    const form = parse(repoText('.github', 'ISSUE_TEMPLATE', 'translation-finding.yml')) as {
      body: { id?: string; attributes: { options?: string[] } }[]
    }
    const language = form.body.find((field) => field.id === 'language')
    expect(language?.attributes.options).toEqual(UI_LANGUAGES.map((info) => `${info.nativeName} (${info.code})`))
  })
})
