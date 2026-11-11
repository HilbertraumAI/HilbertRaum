import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  de,
  en,
  resolveUiLanguage,
  t,
  tCount,
  UI_LANGUAGE_CODES,
  UI_LANGUAGES,
  type MessageKey,
  type UiLanguage,
  type UiLanguageInfo
} from '../../src/shared/i18n'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { catalogOf } from '../helpers/i18n-catalogs'

// Phase 39 — the shared i18n module (i18n record §3.1, D-L1/D-L2/D-L8): synchronous
// lookup, {name} interpolation, .one/.other plurals, English fallback, and the
// 'system' → locale resolution the setting + the pre-unlock gate both use.

describe('t — lookup and interpolation', () => {
  it('looks up plain keys per language', () => {
    // Rail labels are now plain words — no soft hyphens (Task A: the rail never breaks a label
    // mid-word; the grid column is widened to fit instead). See the rail-labels guard below.
    expect(t('en', 'nav.documents')).toBe('Documents')
    expect(t('de', 'nav.documents')).toBe('Dokumente')
    expect(t('en', 'gate.unlock.title')).toBe('Unlock your workspace')
    expect(t('de', 'gate.unlock.title')).toBe('Arbeitsbereich entsperren')
  })

  it('interpolates {name} params in both languages', () => {
    expect(t('en', 'home.docsReady.other', { count: 3 })).toBe(
      '3 documents ready to ask about'
    )
    expect(t('de', 'home.docsReady.other', { count: 3 })).toBe(
      '3 Dokumente bereit für deine Fragen'
    )
  })

  it('falls back to the raw key for an unknown key (runtime guard; typecheck prevents real ones)', () => {
    expect(t('en', 'no.such.key' as MessageKey)).toBe('no.such.key')
    expect(t('de', 'no.such.key' as MessageKey)).toBe('no.such.key')
  })

  it('falls back to the English string when a param is missing in a non-English render', () => {
    // The unresolved placeholder stays literal — visible in dev, never a crash.
    expect(t('de', 'home.docsReady.other')).toBe('{count} documents ready to ask about')
  })

  it('U1/ux-10: the extract coverage badge is softened from "Every match found" (overclaim) to "Read"', () => {
    // "Every match found" asserted the EXTRACTION was exhaustive — a small model / unusual layout can miss
    // a match. The honest claim is that every section was READ, not that every match was captured.
    for (const key of ['coverage.extract.whole', 'coverage.extract.sections'] as MessageKey[]) {
      // Supply the {scanned} param so the REAL German renders — without it, a missing param makes `t('de')`
      // fall back to English, and the negative assertion would inspect English (vacuously passing).
      expect(t('en', key, { scanned: 3 })).not.toMatch(/every match/i)
      expect(t('en', key, { scanned: 3 })).toMatch(/read/i)
      expect(t('de', key, { scanned: 3 })).not.toMatch(/jeder treffer/i)
      expect(t('de', key, { scanned: 3 })).toMatch(/gelesen/i)
    }
  })
})

describe('tCount — .one/.other plural pairs (n === 1 rule)', () => {
  it('selects the singular variant only for exactly 1', () => {
    expect(tCount('en', 'home.docsReady', 1)).toBe('1 document ready to ask about')
    expect(tCount('en', 'home.docsReady', 0)).toBe('0 documents ready to ask about')
    expect(tCount('en', 'home.docsReady', 2)).toBe('2 documents ready to ask about')
    expect(tCount('de', 'home.docsReady', 1)).toBe('1 Dokument bereit für deine Fragen')
    expect(tCount('de', 'home.docsReady', 5)).toBe('5 Dokumente bereit für deine Fragen')
  })

  it('CODE-8: the five previously non-pluralized strings decline correctly at 1 and 2 (EN + DE)', () => {
    // full-audit 2026-07-11 CODE-8 — the DE singular carries the adjective ending
    // („1 fehlgeschlagenES Dokument"), which is why these are catalog pairs, not code.
    expect(tCount('en', 'docs.retryAllConfirm.title', 1)).toBe('Retry 1 failed document?')
    expect(tCount('en', 'docs.retryAllConfirm.title', 2)).toBe('Retry 2 failed documents?')
    expect(tCount('de', 'docs.retryAllConfirm.title', 1)).toBe(
      '1 fehlgeschlagenes Dokument erneut versuchen?'
    )
    expect(tCount('de', 'docs.retryAllConfirm.title', 2)).toBe(
      '2 fehlgeschlagene Dokumente erneut versuchen?'
    )

    expect(tCount('en', 'docs.reindexAllConfirm.title', 1)).toBe('Re-index 1 document?')
    expect(tCount('en', 'docs.reindexAllConfirm.title', 2)).toBe('Re-index 2 documents?')
    expect(tCount('de', 'docs.reindexAllConfirm.title', 1)).toBe('1 Dokument neu indexieren?')
    expect(tCount('de', 'docs.reindexAllConfirm.title', 2)).toBe('2 Dokumente neu indexieren?')

    expect(tCount('en', 'docs.reindexAllDone', 1)).toBe('Re-indexed 1 document.')
    expect(tCount('en', 'docs.reindexAllDone', 2)).toBe('Re-indexed 2 documents.')
    expect(tCount('de', 'docs.reindexAllDone', 1)).toBe('1 Dokument neu indexiert.')
    expect(tCount('de', 'docs.reindexAllDone', 2)).toBe('2 Dokumente neu indexiert.')

    expect(tCount('en', 'chat.sources.wholeDoc', 1)).toBe('Drawn from the document — 1 section')
    expect(tCount('en', 'chat.sources.wholeDoc', 2)).toBe('Drawn from the document — 2 sections')
    expect(tCount('de', 'chat.sources.wholeDoc', 1)).toBe('Aus dem Dokument entnommen — 1 Abschnitt')
    expect(tCount('de', 'chat.sources.wholeDoc', 2)).toBe('Aus dem Dokument entnommen — 2 Abschnitte')

    expect(tCount('en', 'chat.sources.more', 1)).toBe('and 1 more section')
    expect(tCount('en', 'chat.sources.more', 2)).toBe('and 2 more sections')
    // DE: „weiterER Abschnitt" (starke Flexion im Singular) vs „weiterE Abschnitte".
    expect(tCount('de', 'chat.sources.more', 1)).toBe('und 1 weiterer Abschnitt')
    expect(tCount('de', 'chat.sources.more', 2)).toBe('und 2 weitere Abschnitte')
  })
})

describe('missing-interpolation dev-warning (CODE-45)', () => {
  it('warns on a missing param in ENGLISH too (used to be non-EN-only)', () => {
    // full-audit 2026-07-11 CODE-45: on the EN dev/CI default a forgotten param shipped a
    // literal '{name}' with no diagnostic. The render itself is unchanged (placeholder
    // stays visibly literal, never a crash).
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(t('en', 'home.docsReady.other')).toBe('{count} documents ready to ask about')
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("missing param for 'home.docsReady.other' (en)")
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('a fully-parameterized EN render stays silent', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(t('en', 'home.docsReady.other', { count: 3 })).toBe('3 documents ready to ask about')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveUiLanguage (D-L2)', () => {
  it('an explicit choice always wins over the OS locale', () => {
    expect(resolveUiLanguage('en', 'de-DE')).toBe('en')
    expect(resolveUiLanguage('de', 'en-US')).toBe('de')
  })

  it("'system' resolves de-prefixed locales to German, everything else to English", () => {
    expect(resolveUiLanguage('system', 'de')).toBe('de')
    expect(resolveUiLanguage('system', 'de-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'de-AT')).toBe('de')
    expect(resolveUiLanguage('system', 'de_CH')).toBe('de')
    expect(resolveUiLanguage('system', 'DE-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'en-US')).toBe('en')
    expect(resolveUiLanguage('system', 'fr-FR')).toBe('en')
    // Another language whose tag merely shares a first letter with 'de' is not German.
    expect(resolveUiLanguage('system', 'dv')).toBe('en')
  })

  it('tolerates a missing/empty locale (→ English)', () => {
    expect(resolveUiLanguage('system', '')).toBe('en')
    expect(resolveUiLanguage('system', null)).toBe('en')
    expect(resolveUiLanguage('system', undefined)).toBe('en')
  })

  it("the shipped default ('system') resolves to English on this EN dev/CI machine", () => {
    // The whole existing suite asserts English copy (D-L8); this pins the assumption.
    expect(DEFAULT_SETTINGS.uiLanguage).toBe('system')
    expect(resolveUiLanguage(DEFAULT_SETTINGS.uiLanguage, 'en-US')).toBe('en')
  })
})

/** One machine-checkable typography rule of a language (its style guide; design-guidelines §7). */
interface TypographyRule {
  title: string
  /** The catalog entries that break the rule; empty when it holds. */
  offenders: (catalog: Readonly<Record<string, string>>) => string[]
  /** The failure message, naming the fix. */
  message: string
}

const occurrences = (value: string, mark: string): number => value.split(mark).length - 1

/** Every `open` quote is closed by `close`, never by an ASCII quote. Offenders read `key: value`. */
function balancedQuotes(open: string, close: string, title: string, message: string): TypographyRule {
  return {
    title,
    message,
    offenders: (catalog) =>
      Object.entries(catalog)
        .filter(([, value]) => occurrences(value, open) !== occurrences(value, close))
        .map(([key, value]) => `${key}: ${value}`)
  }
}

/** `close` never comes before its `open` (walking each value's pairs). Offenders are keys. */
function opensBeforeCloses(open: string, close: string, title: string, message: string): TypographyRule {
  return {
    title,
    message,
    offenders: (catalog) =>
      Object.entries(catalog)
        .filter(([, value]) => {
          let depth = 0
          for (const ch of value) {
            if (ch === open) depth++
            else if (ch === close && --depth < 0) return true
          }
          return false
        })
        .map(([key]) => key)
  }
}

// The rules run over the CATALOG VALUES only: a catalog file's own comments are not shipped
// copy, and technical field names inside notes ("{field}", "language") legitimately keep
// straight ASCII pairs. Typecheck makes every registered language list its rules here.
const TYPOGRAPHY_RULES: { readonly [C in UiLanguage]: readonly TypographyRule[] } = {
  en: [],
  // German quotes are „…“ — an opening „ closed with an ASCII " is a visible typo in shipped
  // copy (it rendered as `Durchsuchbar machen (OCR)"` on the Images empty state).
  de: [
    balancedQuotes(
      '„',
      '“',
      'closes every opening „ with “, never with an ASCII quote',
      'German values with an unbalanced „…“ pair — close them with “ (U+201C), not "'
    ),
    opensBeforeCloses(
      '„',
      '“',
      'never uses “ as an OPENING quote (the pair is „…“, not “…”)',
      '“ used before its „ — German opens low, closes high'
    )
  ]
}

describe('typography per registered language (design-guidelines §7 "Typography")', () => {
  const rows = UI_LANGUAGES.flatMap(({ code }) =>
    TYPOGRAPHY_RULES[code].map((rule) => [code, rule.title, rule] as const)
  )

  it.each(rows)('%s: %s', (code, _title, { offenders, message }) => {
    expect(offenders(catalogOf(code)), message).toEqual([])
  })
})

describe('German typography — quotation marks (design-guidelines §7 "Typography")', () => {
  it('the strings the sweep corrected read with German closers', () => {
    expect(de['images.avail.ocrPointer']).toContain('„Durchsuchbar machen (OCR)“')
    expect(de['docs.task.extractBusyTitle']).toContain('„Liste alle…“')
    // (docs.deepIndex.buildTitle was removed as a dead key — RD-5, #151.)
    expect(de['skills.analysis.refusePartial']).toContain('„Neu indexieren“')
    expect(de['models.vision.installed']).toContain('„Bilder“')
    expect(de['models.vision.notInstalled']).toContain('„Bilder“')
    expect(de['images.chip.readForm.prompt']).toContain('„unklar“')
    expect(de['translate.file.err.noPath']).toContain('„ein Dokument auswählen“')
  })

  it('does not touch the English catalog (straight quotes stay straight there)', () => {
    expect(en['images.avail.ocrPointer']).not.toMatch(/„|“/)
  })
})

describe('house dashes — knowledge-pack copy (#301 P6, plan §9.23 (c)4)', () => {
  // EN sentence-level breaks use the em dash "—", DE uses the en dash "–"; a bare ASCII
  // hyphen standing in for either (space-hyphen-space) is a typo, not a house-style choice.
  // The same holds in every other registered language (its dash is in its style guide).
  const PREFIXES = ['packs.', 'chat.scope.', 'chat.packs.', 'chat.article.']

  it('no value under packs./chat.scope./chat.packs./chat.article. contains " - " in any registered language', () => {
    const offenders: string[] = []
    for (const { code: lang } of UI_LANGUAGES) {
      for (const [key, value] of Object.entries(catalogOf(lang))) {
        if (!PREFIXES.some((p) => key.startsWith(p))) continue
        if (value.includes(' - ')) offenders.push(`${lang}:${key}: ${value}`)
      }
    }
    expect(offenders, 'bare " - " where a house dash (— EN / – DE) belongs').toEqual([])
  })
})

type Catalog = Readonly<Record<string, string>>
type CatalogShape = Pick<UiLanguageInfo, 'evidencePack' | 'pluralCategories'>

/** The plural bases: `X` with both `X.one` and `X.other` (`packs.addFailed.other` alone is no plural). */
function pluralBases(keys: ReadonlySet<string>): string[] {
  return [...keys]
    .filter((key) => key.endsWith('.one') && keys.has(`${key.slice(0, -'.one'.length)}.other`))
    .map((key) => key.slice(0, -'.one'.length))
}

/**
 * The runtime twin of `CatalogKeyFor` (shared/i18n/languages.ts): the exact key set a catalog of
 * a language must have. Every English key, plus one key per plural base for each form the
 * language has beyond `.one`/`.other` (Russian `.few` and `.many`); without any `packExport.*`
 * key when the language writes no evidence packs (they render only inside a pack, D-L9).
 */
function requiredCatalogKeys(info: CatalogShape, english: Catalog): Set<string> {
  const englishKeys = new Set(Object.keys(english))
  const extraForms = info.pluralCategories.filter((form) => form !== 'one' && form !== 'other')
  const keys = [
    ...englishKeys,
    ...pluralBases(englishKeys).flatMap((base) => extraForms.map((form) => `${base}.${form}`))
  ]
  return new Set(keys.filter((key) => info.evidencePack || !key.startsWith('packExport.')))
}

const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()

/**
 * Everything wrong with `catalog` as the catalog of a language shaped `info`: a missing or an
 * unexpected key, an empty value, or placeholders that differ from English. A form English
 * does not have (`.few`) is compared with its base's `.other`.
 */
function catalogParityProblems(info: CatalogShape, catalog: Catalog, english: Catalog): string[] {
  const required = requiredCatalogKeys(info, english)
  const problems: string[] = []
  for (const key of [...required].sort()) {
    if (!Object.hasOwn(catalog, key)) problems.push(`missing key ${key}`)
  }
  for (const key of Object.keys(catalog).sort()) {
    if (!required.has(key)) {
      problems.push(`unexpected key ${key}`)
      continue
    }
    const value = catalog[key]
    if (value.trim().length === 0) problems.push(`empty value for ${key}`)
    const reference = english[key] ?? english[`${key.slice(0, key.lastIndexOf('.'))}.other`]
    const [have, want] = [placeholders(value), placeholders(reference)]
    if (have.join() !== want.join()) {
      problems.push(`placeholder mismatch in ${key}: [${have.join(', ')}], English [${want.join(', ')}]`)
    }
  }
  return problems
}

describe('catalog hygiene (parity is otherwise enforced by typecheck)', () => {
  // D-L10: every registered catalog is complete. Typecheck holds the key set (`UiCatalog`);
  // this row is its runtime belt and adds what a type cannot say (no empty value, the
  // English placeholders).
  it.each(UI_LANGUAGES.map((info) => [info.code, info] as const))(
    '%s: carries exactly its required keys, no empty value, and the English placeholders',
    (code, info) => {
      expect(catalogParityProblems(info, catalogOf(code), en)).toEqual([])
    }
  )

  // Every guard here reads the catalog FILES (`catalogOf`); `t` reads `CATALOGS` (index.ts).
  // Languages with the same plural forms share a catalog type, so a map entry pointing at
  // another language's catalog (`de: en`, `fr: es`) typechecks; this row is what notices it.
  it.each(UI_LANGUAGE_CODES)('%s: t() renders the text of its own catalog file (the CATALOGS entry)', (code) => {
    const catalog = catalogOf(code)
    const plain = Object.keys(catalog).filter((key) => !/\{\w+\}/.test(catalog[key]))
    const elsewhere = plain.filter((key) => t(code, key as MessageKey) !== catalog[key])
    expect(plain.length).toBeGreaterThan(0)
    expect(
      elsewhere.slice(0, 5),
      `${elsewhere.length} of ${plain.length} param-less keys render text that is not in ${code}.ts`
    ).toEqual([])
  })

  describe('the parity rule on fixture catalogs (only en and de are registered so far)', () => {
    const english = {
      'nav.home': 'Home',
      'docs.opened': 'Opened {name}',
      'docs.count.one': '{count} document',
      'docs.count.other': '{count} documents',
      'packs.addFailed.other': 'The archive could not be added.',
      'packExport.title': 'Evidence pack',
      'packExport.items.one': '{count} item',
      'packExport.items.other': '{count} items'
    }
    const russianShape: CatalogShape = {
      evidencePack: false,
      pluralCategories: ['one', 'few', 'many', 'other']
    }
    const frenchShape: CatalogShape = { evidencePack: false, pluralCategories: ['one', 'many', 'other'] }
    const russian: Catalog = {
      'nav.home': 'Главная',
      'docs.opened': 'Открыт {name}',
      'docs.count.one': '{count} документ',
      'docs.count.few': '{count} документа',
      'docs.count.many': '{count} документов',
      'docs.count.other': '{count} документа',
      'packs.addFailed.other': 'Не удалось добавить архив.'
    }
    // The same catalog with the forms French has (one, many, other).
    const { 'docs.count.few': _few, ...frenchForms } = russian
    void _few
    const without = (catalog: Catalog, key: string): Catalog =>
      Object.fromEntries(Object.entries(catalog).filter(([k]) => k !== key))

    it('a complete catalog passes: its extra forms, no packExport.*, no form of a non-plural', () => {
      // `packs.addFailed` has no `.one`, so it has no `.few`; `packExport.items` is a plural, but a
      // language without evidence packs carries none of its forms.
      expect(catalogParityProblems(russianShape, russian, english)).toEqual([])
      expect(catalogParityProblems(frenchShape, frenchForms, english)).toEqual([])
    })

    it.each<[string, CatalogShape, Catalog, string[]]>([
      ['a plain key removed', russianShape, without(russian, 'nav.home'), ['missing key nav.home']],
      [
        'a plural form the language has removed',
        russianShape,
        without(russian, 'docs.count.few'),
        ['missing key docs.count.few']
      ],
      [
        'a form the language does not have',
        frenchShape,
        { ...frenchForms, 'docs.count.few': '{count} documents' },
        ['unexpected key docs.count.few']
      ],
      [
        'a form of a key that is not a plural',
        russianShape,
        { ...russian, 'nav.home.few': 'x', 'packs.addFailed.few': 'x' },
        ['unexpected key nav.home.few', 'unexpected key packs.addFailed.few']
      ],
      [
        'a packExport key in a language without evidence packs',
        russianShape,
        { ...russian, 'packExport.title': 'Пакет' },
        ['unexpected key packExport.title']
      ],
      [
        'a form of a packExport plural in a language without evidence packs',
        russianShape,
        { ...russian, 'packExport.items.few': '{count} элемента' },
        ['unexpected key packExport.items.few']
      ],
      [
        'no packExport keys in a language that writes evidence packs',
        { ...russianShape, evidencePack: true },
        russian,
        [
          'missing key packExport.items.few',
          'missing key packExport.items.many',
          'missing key packExport.items.one',
          'missing key packExport.items.other',
          'missing key packExport.title'
        ]
      ],
      [
        'an empty value',
        russianShape,
        { ...russian, 'nav.home': ' ' },
        ['empty value for nav.home']
      ],
      [
        'a placeholder dropped from a plain key',
        russianShape,
        { ...russian, 'docs.opened': 'Открыт' },
        ['placeholder mismatch in docs.opened: [], English [{name}]']
      ],
      [
        'a placeholder English does not have',
        russianShape,
        { ...russian, 'nav.home': 'Главная {x}' },
        ['placeholder mismatch in nav.home: [{x}], English []']
      ],
      [
        "a placeholder dropped from a form English lacks (compared with the base's .other)",
        russianShape,
        { ...russian, 'docs.count.many': 'много документов' },
        ['placeholder mismatch in docs.count.many: [], English [{count}]']
      ]
    ])('%s is a problem', (_title, shape, catalog, problems) => {
      expect(catalogParityProblems(shape, catalog, english)).toEqual(problems)
    })
  })

  it('CODE-8 net: every {count}/{done}/{hidden} key consumed via plain t() is on the reviewed non-grammatical list', () => {
    // full-audit 2026-07-11 CODE-8 (task 2): the plural class must not regress. A key whose
    // value interpolates {count} (or the {done} progress twin) and is consumed via plain
    // t() can render broken grammar the moment a call site passes 1 ("Retry 1 failed
    // documents?"). Every such key must either be a .one/.other pair consumed via tCount,
    // or sit on this reviewed list of counts that never inflect (parenthetical counts,
    // "{done} of {total}" progress forms, pre-formatted figures). Adding a NEW plain-t()
    // consumer of a counting key fails here — pluralize it or justify it below.
    const NON_GRAMMATICAL: ReadonlySet<string> = new Set([
      'chat.sources.toggle', // "Sources ({count})" — parenthetical
      'docs.askSelected', // "Ask these documents ({count})" — parenthetical
      'docs.reindexAll', // "Re-index all ({count})" — parenthetical
      'docs.retryAllFailed', // "Retry all ({count})" — parenthetical
      'docs.reindexAllProgress', // "Re-indexing {done} of {total}…" — no noun inflects
      'docs.reindexAllCancelled', // "… {done} of {total} done."
      'docs.reindexAllPartial', // "{done} of {total} — {failed} failed."
      'translate.file.progress', // "Translating… ({done}/{total})"
      'models.tech.contextValue', // "{count} tokens" — pre-formatted figure, window ≥ 512
      'models.context.autoResolved', // the same pre-formatted figure in the Auto label
      // " ({count} cores)" — a single-core machine would read "(1 cores)"; registered as a
      // residual in the remediation plan's discoveries, deliberately not fixed in Phase G.
      'diag.bench.cores',
      // #236: "characters not shown: {hidden}" — a figure after a colon, no noun inflects.
      'main.dialog.openLink.truncated',
      // #576/#538: "on {count} of {total} pages" — the noun follows {total}, which these call sites
      // only render when it is at least 2 (ocrNotes.ts); "all {count}" likewise only for ≥ 2 pages
      // (a single page has its own sentence).
      'docs.previewModal.ocrInfoPartial',
      'docs.ocr.unsure.some',
      'docs.ocr.unsure.all',
      // #575: "Scanned pages without readable text yet: {count} of {total}." — figures after a colon.
      'docs.ocr.scannedPages'
    ])
    // Scan the shipped source for plain `t('key'` consumptions (bound renderer t and the
    // shared t(lang, …) form differ in shape — the latter never matches `t('`). The read is
    // NUL-tolerant by construction (utf8 readFileSync): analysis/extract.ts carries a
    // literal NUL byte until CODE-24 lands in Phase H.
    const srcRoot = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(p)
      }
    }
    walk(srcRoot)
    expect(files.length).toBeGreaterThan(100) // sanity: the walk really saw the tree

    const catalog = en as Record<string, string>
    const offenders = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) {
        const key = m[1]
        const value = catalog[key]
        if (value === undefined) continue // dynamic/derived keys are out of static reach
        if (!/\{count\}|\{done\}|\{hidden\}/.test(value)) continue
        if (!NON_GRAMMATICAL.has(key)) offenders.add(key)
      }
    }
    expect(
      [...offenders].sort(),
      'plain-t()-consumed {count}/{done} keys — switch them to tCount with .one/.other variants (CODE-8) or justify them on the list above'
    ).toEqual([])

    // Teeth for the allowlist itself: every entry still exists and still counts — a renamed
    // or de-counted key must be pruned here, not silently ignored.
    for (const key of NON_GRAMMATICAL) {
      expect(catalog[key], `stale allowlist entry ${key}`).toBeDefined()
      expect(/\{count\}|\{done\}|\{hidden\}/.test(catalog[key]), `allowlisted key no longer counts: ${key}`).toBe(true)
    }
  })

  it('every .one plural key has its .other partner and vice versa (tCount contract)', () => {
    // Key parity is asserted above, so checking the English key set covers every catalog.
    // A trailing ".other" alone is not proof of a plural (a key could just as well be a plain
    // label that happens to end in "...other") — a plural variant is one that interpolates
    // {count}.
    const keys = new Set(Object.keys(en) as MessageKey[])
    for (const key of keys) {
      if (key.endsWith('.one')) {
        expect(keys.has(`${key.slice(0, -4)}.other` as MessageKey), `missing .other for ${key}`).toBe(true)
      } else if (key.endsWith('.other') && en[key].includes('{count}')) {
        expect(keys.has(`${key.slice(0, -6)}.one` as MessageKey), `missing .one for ${key}`).toBe(true)
      }
    }
  })
})
