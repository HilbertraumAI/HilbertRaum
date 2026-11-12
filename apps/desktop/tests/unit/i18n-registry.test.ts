import { describe, it, expect, vi } from 'vitest'
import {
  UI_LANGUAGES,
  UI_LANGUAGE_CODES,
  cldrPlural,
  en,
  isUiLanguage,
  isUiLanguageSetting,
  pluralKeyFor,
  resolveUiLanguage,
  resolveUiLanguageIn,
  tCount,
  uiLanguageInfo,
  type CatalogFor,
  type CatalogKeyFor,
  type CountMessageKey,
  type MessageKey,
  type UiCatalog,
  type UiLanguageInfo,
  type UiLanguageSetting
} from '../../src/shared/i18n'
import { catalogOf } from '../helpers/i18n-catalogs'

// The UI-language registry and the cores derived from it (i18n record D-L9, D-L1, D-L2):
// registry invariants, the plural engine, OS-locale resolution, and the catalog types.
//
// Most rows run the pure cores (`pluralKeyFor`, `resolveUiLanguageIn`, `CatalogFor`) against
// fixture entries, so a rule is proved on a language shape whether or not a language of that
// shape is registered; the rows over `UI_LANGUAGES` check the real registry and catalogs.
// Production calls the same cores with the real registry.

/** Fixture entries with the plural forms CLDR gives these languages. */
const RU = {
  code: 'ru',
  nativeName: 'Русский',
  nativeReviewed: false,
  evidencePack: false,
  plural: cldrPlural('ru'),
  pluralCategories: ['one', 'few', 'many', 'other']
} as const satisfies UiLanguageInfo

const FR = {
  code: 'fr',
  nativeName: 'Français',
  nativeReviewed: false,
  evidencePack: false,
  plural: cldrPlural('fr'),
  pluralCategories: ['one', 'many', 'other']
} as const satisfies UiLanguageInfo

/** Russian plural forms, but a language that does write evidence packs. */
const RU_WITH_PACKS = { ...RU, evidencePack: true } as const satisfies UiLanguageInfo

/** The languages that keep the exact n === 1 rule (UI-languages owner call D-8 (a)). */
const EXACT_ONE_CODES: readonly string[] = ['en', 'de']

/** Counts at which the rules of English, German, Russian, French, Spanish and Italian part ways. */
const PLURAL_PROBES = [0, 0.5, 1, 1.5, 2, 5, 21, 22, 1_000_000]

/**
 * The exactly-1 rule English and German keep, written out here: comparing with the module's own
 * rule would stay green if that rule changed.
 */
const exactlyOne = (n: number): 'one' | 'other' => (n === 1 ? 'one' : 'other')

/**
 * −5 … 10,000, fractions (1.0000001 reads as "1" to CLDR), NaN and ∞, and an exact million (the
 * count Spanish, Italian and French keep a `.many` form for).
 */
const SWEEP = [
  ...Array.from({ length: 10_006 }, (_, i) => i - 5),
  1_000_000,
  -0.5,
  0.5,
  1.0,
  1.0000001,
  1.5,
  2.25,
  Number.NaN,
  Number.POSITIVE_INFINITY
]

/**
 * Everything wrong with an entry's plural rule. English and German must give `one` to exactly 1
 * and to nothing else over the whole sweep, negative counts and fractions included: a rule that
 * only agrees on positive counts fails (CLDR English also gives `one` to −1). Every other language
 * must select as its own CLDR rule does (`Intl.PluralRules(code)`), so a copied entry that kept
 * another language's rule fails. The branch is decided by `code`, not by the forms: a language
 * with only one/other forms that is not English or German takes its CLDR rule too.
 */
function pluralRuleProblems(info: Pick<UiLanguageInfo, 'code' | 'plural'>): string[] {
  if (EXACT_ONE_CODES.includes(info.code)) {
    return SWEEP.filter((n) => info.plural(n) !== exactlyOne(n)).map(
      (n) => `${info.code}: ${n} → ${info.plural(n)}, exactly-1 rule ${exactlyOne(n)}`
    )
  }
  const cldr = new Intl.PluralRules(info.code)
  return PLURAL_PROBES.filter((n) => info.plural(n) !== cldr.select(n)).map(
    (n) => `${info.code}: ${n} → ${info.plural(n)}, CLDR ${cldr.select(n)}`
  )
}

describe('UI language registry — invariants', () => {
  it('lists English first (the fallback language)', () => {
    expect(UI_LANGUAGES[0].code).toBe('en')
  })

  it('has unique codes that are lower-case primary language subtags', () => {
    const codes = UI_LANGUAGES.map((info) => info.code)
    expect(new Set(codes).size).toBe(codes.length)
    // A region or script suffix ('de-AT') could never match: the resolver compares the
    // OS locale's primary subtag only.
    for (const code of codes) expect(code).toMatch(/^[a-z]{2,3}$/)
  })

  it.each([...UI_LANGUAGES, RU, FR])(
    '$code: the pinned plural forms are the ones the running ICU reports',
    (info) => {
      // The ICU drift detector: a catalog must provide exactly the pinned forms, so a
      // Node/Electron ICU update that adds or drops a form has to show up here.
      const icu = new Intl.PluralRules(info.code).resolvedOptions().pluralCategories
      expect([...info.pluralCategories].sort()).toEqual([...icu].sort())
    }
  )

  it.each([...UI_LANGUAGES, RU, FR])(
    '$code: the plural rule only ever selects a pinned form',
    (info) => {
      const pinned: readonly string[] = info.pluralCategories
      const counts = [...Array.from({ length: 201 }, (_, n) => n), 1_000_000, 0.5, 1.5, -1]
      expect(counts.filter((n) => !pinned.includes(info.plural(n)))).toEqual([])
    }
  )

  it.each([...UI_LANGUAGES, RU, FR])('$code: the plural rule is the language’s own', (info) => {
    expect(pluralRuleProblems(info)).toEqual([])
  })

  it.each<[string, Pick<UiLanguageInfo, 'code' | 'plural'>, string[]]>([
    [
      'an Italian entry that kept the French rule',
      { ...FR, code: 'it' },
      ['it: 0 → one, CLDR other', 'it: 0.5 → one, CLDR other', 'it: 1.5 → one, CLDR other']
    ],
    // CLDR rounds to three fraction digits before it selects, so 1.0000001 reads as "1".
    ['English with the CLDR English rule', { code: 'en', plural: cldrPlural('en') }, [
      'en: -1 → one, exactly-1 rule other',
      'en: 1.0000001 → one, exactly-1 rule other'
    ]],
    ['German with a stray singular at 101', { code: 'de', plural: (n) => (n === 1 || n === 101 ? 'one' : 'other') }, [
      'de: 101 → one, exactly-1 rule other'
    ]]
  ])('%s is a problem', (_title, info, problems) => {
    expect(pluralRuleProblems(info)).toEqual(problems)
  })

  it('isUiLanguage accepts exactly the registered codes', () => {
    for (const { code } of UI_LANGUAGES) expect(isUiLanguage(code)).toBe(true)
    for (const junk of ['system', 'xx', 'EN', 'de-AT', '', null, undefined, 3]) {
      expect(isUiLanguage(junk)).toBe(false)
    }
  })

  it("isUiLanguageSetting accepts the registered codes and 'system'", () => {
    expect(isUiLanguageSetting('system')).toBe(true)
    for (const { code } of UI_LANGUAGES) expect(isUiLanguageSetting(code)).toBe(true)
    for (const junk of ['xx', 'System', 'de-AT', '', null, undefined, 3]) {
      expect(isUiLanguageSetting(junk)).toBe(false)
    }
  })
})

describe('tCount — each registered language renders the form its own rule picks (D-L1)', () => {
  // The oracle is local on purpose (`exactlyOne` above; CLDR for every other language). The
  // expected text comes from the language's own catalog FILE, so a language registered later gets
  // these rows the day it is registered, and `tCount` reading another language's rule or catalog
  // turns them red.
  const fill = (template: string, n: number): string => template.split('{count}').join(String(n))

  it.each(UI_LANGUAGE_CODES)('%s: the form its own rule picks, from its own catalog, for every count', (code) => {
    const catalog = catalogOf(code)
    const cldr = new Intl.PluralRules(code)
    const rule = (n: number): string => (EXACT_ONE_CODES.includes(code) ? exactlyOne(n) : cldr.select(n))
    const wrong = SWEEP.flatMap((n) => {
      const key = `home.docsReady.${rule(n)}`
      const want = catalog[key]
      const got = tCount(code, 'home.docsReady', n)
      return want !== undefined && got === fill(want, n)
        ? []
        : [`${n}: ${JSON.stringify(got)}, expected ${want === undefined ? `${key} (not in the catalog)` : JSON.stringify(fill(want, n))}`]
    })
    expect(wrong.slice(0, 5), `${wrong.length} counts render the wrong form`).toEqual([])
  })

  // A form whose param is missing renders English: the English form for the SAME count, by the
  // English rule, with the missing placeholder left visible. Never another English form (English
  // has no `.few` to borrow) and never the raw key.
  it.each(UI_LANGUAGE_CODES)('%s: a missing param falls back to the English form for the same count', (code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const wrong = PLURAL_PROBES.filter(
        (n) =>
          tCount(code, 'chat.skill.run.running', n) !==
          fill(en[`chat.skill.run.running.${exactlyOne(n)}`], n)
      )
      expect(wrong).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  // The sweep row above is only as good as the counts it tries: they must reach every form a
  // language pins (Russian 2 → few and 5 → many, French 0 → one, 1,000,000 → many), or a form
  // goes unchecked. French writes every `.many` exactly like its `.other` (owner call: no «de»
  // after a figure), so for French a `tCount` that never picks `.many` cannot be told apart.
  it.each(UI_LANGUAGE_CODES)('%s: the sweep reaches every plural form the registry pins', (code) => {
    const cldr = new Intl.PluralRules(code)
    const rule = (n: number): string => (EXACT_ONE_CODES.includes(code) ? exactlyOne(n) : cldr.select(n))
    const reached = new Set(SWEEP.map(rule))
    expect(uiLanguageInfo(code).pluralCategories.filter((form) => !reached.has(form))).toEqual([])
  })

  // The missing-pages warning picks its form by the page count while it shows the pages as a
  // range (TranslateScreen). Russian `.one` also serves 21, 31 … pages, so it may not read as one
  // page: with the same range text it reads exactly as the form for 25 pages does.
  it('ru: the missing-pages warning for 21 pages reads as it does for 25', () => {
    const pages = '3–23'
    expect(tCount('ru', 'translate.file.gapPages', 21, { pages })).toBe(
      tCount('ru', 'translate.file.gapPages', 25, { pages })
    )
  })
})

describe('pluralKeyFor — the form a language renders for a count', () => {
  const hasEvery = (): boolean => true

  it.each([
    [1, 'one'],
    [2, 'few'],
    [5, 'many'],
    [11, 'many'],
    [21, 'one'],
    [22, 'few'],
    [25, 'many'],
    [111, 'many'],
    [1.5, 'other']
  ])('Russian %d → .%s', (count, form) => {
    expect(pluralKeyFor(RU, 'docs.count', count, hasEvery)).toBe(`docs.count.${form}`)
  })

  it.each([
    [0, 'one'],
    [1, 'one'],
    [2, 'other'],
    [1_000_000, 'many']
  ])('French %d → .%s', (count, form) => {
    expect(pluralKeyFor(FR, 'docs.count', count, hasEvery)).toBe(`docs.count.${form}`)
  })

  it('falls back to .other when the catalog lacks the selected form', () => {
    const onlyPair = (key: string): boolean => key.endsWith('.one') || key.endsWith('.other')
    expect(pluralKeyFor(RU, 'docs.count', 2, onlyPair)).toBe('docs.count.other')
    expect(pluralKeyFor(FR, 'docs.count', 1_000_000, onlyPair)).toBe('docs.count.other')
    // A form the catalog has is still used.
    expect(pluralKeyFor(RU, 'docs.count', 21, onlyPair)).toBe('docs.count.one')
  })
})

describe('resolveUiLanguageIn — setting + OS locale against a set of languages (D-L2)', () => {
  const CODES = ['en', 'de', 'ru', 'fr', 'es', 'it'] as const

  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['RU_ru', 'ru'],
    ['fr-CA', 'fr'],
    ['es-419', 'es'],
    ['it-CH', 'it'],
    ['de_CH', 'de'],
    ['pt-BR', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en']
  ])("'system' with OS locale %j → %s", (locale, expected) => {
    expect(resolveUiLanguageIn(CODES, 'system', locale)).toBe(expected)
  })

  // Other languages whose tag merely begins with a registered code. Only the whole
  // primary subtag counts.
  it.each(['deu', 'frr-DE', 'rue', 'ita', 'esu'])(
    "'system' with the prefix-trap locale %s → en",
    (locale) => {
      expect(resolveUiLanguageIn(CODES, 'system', locale)).toBe('en')
    }
  )

  it('a registered setting wins over the OS locale', () => {
    expect(resolveUiLanguageIn(CODES, 'ru', 'de-DE')).toBe('ru')
    expect(resolveUiLanguageIn(CODES, 'en', 'fr-FR')).toBe('en')
  })

  it("a setting the set does not know resolves like 'system'", () => {
    expect(resolveUiLanguageIn(CODES, 'xx', 'it-IT')).toBe('it')
    expect(resolveUiLanguageIn(CODES, 'xx', 'pt-BR')).toBe('en')
    // The same through the real registry: a stored value from a build with more
    // languages (a shared drive) follows the OS instead of sticking.
    expect(resolveUiLanguage('xx' as UiLanguageSetting, 'de-AT')).toBe('de')
    expect(resolveUiLanguage('xx' as UiLanguageSetting, 'pt-BR')).toBe('en')
  })
})

// ---- Catalog types (checked by `npm run typecheck`, which includes tests/) ----------------
//
// A language's catalog type is derived from its registry entry. These rows prove the
// derivation on the fixture entries above (including shapes no registered language has,
// such as a language that writes packs and has extra plural forms); the real catalogs are
// checked by the `CATALOGS` map in `index.ts`. An unused `@ts-expect-error` or a `false`
// handed to `Assert` fails typecheck.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type PackKey = Extract<MessageKey, `packExport.${string}`>
/** A `packExport.*` plural base (`CountMessageKey` holds bases, which are not message keys). */
type PackBase = `packExport.${string}`

type RuKey = CatalogKeyFor<typeof RU>
type FrKey = CatalogKeyFor<typeof FR>

type CatalogTypeRows = [
  // English and German: exactly the English key set, as before the registry.
  Assert<Equal<UiCatalog<'en'>, Record<MessageKey, string>>>,
  Assert<Equal<UiCatalog<'de'>, Record<MessageKey, string>>>,
  // Russian: one .few and one .many key per plural base on top of the English keys, except
  // the packExport.* bases: a language without evidence packs has none of their forms.
  Assert<Equal<Exclude<RuKey, MessageKey>, `${Exclude<CountMessageKey, PackBase>}.${'few' | 'many'}`>>,
  // French: one .many key per plural base (packExport.* bases excluded), and no .few.
  Assert<Equal<Exclude<FrKey, MessageKey>, `${Exclude<CountMessageKey, PackBase>}.many`>>,
  // A language that writes no evidence packs: every English key except packExport.*.
  Assert<Equal<Exclude<MessageKey, RuKey>, PackKey>>,
  Assert<Equal<Exclude<MessageKey, FrKey>, PackKey>>,
  // A language that does write them needs those keys too, every plural form included.
  Assert<Equal<Exclude<MessageKey, CatalogKeyFor<typeof RU_WITH_PACKS>>, never>>,
  Assert<
    Equal<Exclude<CatalogKeyFor<typeof RU_WITH_PACKS>, MessageKey>, `${CountMessageKey}.${'few' | 'many'}`>
  >
]

// Never called: only its types matter.
function catalogLiteralRows(complete: CatalogFor<typeof RU>, french: CatalogFor<typeof FR>): void {
  const { 'nav.home': _plainKey, ...withoutPlainKey } = complete
  const { 'home.docsReady.few': _fewForm, ...withoutFewForm } = complete
  void _plainKey
  void _fewForm

  // @ts-expect-error — a missing key is a compile error
  const missingKey: CatalogFor<typeof RU> = withoutPlainKey
  // @ts-expect-error — so is a missing plural form the language has
  const missingForm: CatalogFor<typeof RU> = withoutFewForm
  // @ts-expect-error — an English-only key set is not a Russian catalog
  const englishShape: CatalogFor<typeof RU> = {} as Record<MessageKey, string>

  const misspelt: CatalogFor<typeof RU> = {
    ...complete,
    // @ts-expect-error — a misspelt key is an excess property
    'nav.hmoe': 'x'
  }
  const formOfPlainKey: CatalogFor<typeof RU> = {
    ...complete,
    // @ts-expect-error — a plural form of a key that is not a plural base
    'nav.home.few': 'x'
  }
  const formTheLanguageLacks: CatalogFor<typeof FR> = {
    ...french,
    // @ts-expect-error — French has no .few form
    'home.docsReady.few': 'x'
  }
  const unshownPackKey: CatalogFor<typeof RU> = {
    ...complete,
    // @ts-expect-error — packExport.* is not part of a catalog without evidence packs
    'packExport.integrity.options': 'x'
  }
  const unshownPackForm: CatalogFor<typeof RU> = {
    ...complete,
    // @ts-expect-error — nor is the extra plural form of a packExport.* plural base
    'packExport.items.unreviewedExcluded.few': 'x'
  }
  const validForms: CatalogFor<typeof RU> = {
    ...complete,
    'home.docsReady.few': 'x',
    'home.docsReady.many': 'x'
  }
  void [missingKey, missingForm, englishShape, misspelt, formOfPlainKey]
  void [formTheLanguageLacks, unshownPackKey, unshownPackForm, validForms]
}
