import { describe, it, expect } from 'vitest'
import {
  UI_LANGUAGES,
  cldrPlural,
  isUiLanguage,
  isUiLanguageSetting,
  pluralKeyFor,
  resolveUiLanguage,
  resolveUiLanguageIn,
  t,
  tCount,
  type CatalogFor,
  type CatalogKeyFor,
  type CountMessageKey,
  type MessageKey,
  type UiCatalog,
  type UiLanguageInfo,
  type UiLanguageSetting
} from '../../src/shared/i18n'

// The UI-language registry and the cores derived from it (i18n record D-L9, D-L1, D-L2):
// registry invariants, the plural engine, OS-locale resolution, and the catalog types.
//
// The registry holds English and German only until more languages are registered, so the
// rows for other languages run the pure cores (`pluralKeyFor`, `resolveUiLanguageIn`,
// `CatalogFor`) against fixture entries. Production calls the same cores with the real
// registry.

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

describe('tCount — English and German keep the exact n === 1 rule (D-L1)', () => {
  // The oracle is local on purpose: comparing against the module's own rule would stay
  // green if that rule changed.
  const oracle = (n: number): 'one' | 'other' => (n === 1 ? 'one' : 'other')
  const counts = [
    ...Array.from({ length: 10_006 }, (_, i) => i - 5), // −5 … 10,000
    0.5,
    1.0,
    1.5,
    2.25,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ]

  it.each(['en', 'de'] as const)('%s: singular for exactly 1, plural for every other count', (lang) => {
    const wrong = counts.filter(
      (n) =>
        tCount(lang, 'home.docsReady', n) !==
        t(lang, `home.docsReady.${oracle(n)}`, { count: n })
    )
    expect(wrong).toEqual([])
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
// A language's catalog type is derived from its registry entry. No language beyond
// English and German is registered yet, so these rows prove the derivation on the
// fixture entries above: an unused `@ts-expect-error` or a `false` handed to `Assert`
// fails typecheck.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type PackKey = Extract<MessageKey, `packExport.${string}`>

type RuKey = CatalogKeyFor<typeof RU>
type FrKey = CatalogKeyFor<typeof FR>

type CatalogTypeRows = [
  // English and German: exactly the English key set, as before the registry.
  Assert<Equal<UiCatalog<'en'>, Record<MessageKey, string>>>,
  Assert<Equal<UiCatalog<'de'>, Record<MessageKey, string>>>,
  // Russian: one .few and one .many key per plural base on top of the English keys.
  Assert<Equal<Exclude<RuKey, MessageKey>, `${CountMessageKey}.${'few' | 'many'}`>>,
  // French: one .many key per plural base, and no .few.
  Assert<Equal<Exclude<FrKey, MessageKey>, `${CountMessageKey}.many`>>,
  // A language that writes no evidence packs: every English key except packExport.*.
  Assert<Equal<Exclude<MessageKey, RuKey>, PackKey>>,
  Assert<Equal<Exclude<MessageKey, FrKey>, PackKey>>,
  // A language that does write them needs those keys too.
  Assert<Equal<Exclude<MessageKey, CatalogKeyFor<typeof RU_WITH_PACKS>>, never>>
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
  const validForms: CatalogFor<typeof RU> = {
    ...complete,
    'home.docsReady.few': 'x',
    'home.docsReady.many': 'x'
  }
  void [missingKey, missingForm, englishShape, misspelt, formOfPlainKey]
  void [formTheLanguageLacks, unshownPackKey, validForms]
}
