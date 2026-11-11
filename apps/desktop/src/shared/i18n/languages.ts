import type { CountMessageKey, MessageKey } from './index'

// The UI-language registry (i18n record D-L9): the one place that says which interface
// languages exist. `UiLanguage`, the catalog types, the plural rule and the OS-locale
// resolution are all derived from it, so adding a language is one entry here plus one
// catalog file — the compiler then points at everything else that must follow.
//
// The import above is type-only (erased at build time), so this module has no runtime
// dependency on `index.ts` or on a catalog; `index.ts` imports the values below.

/** The CLDR plural categories (`Intl.PluralRules#select` returns one of these). */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/**
 * One registered interface language.
 *
 * There is deliberately no completeness tier: every registered language is complete, and
 * `npm run typecheck` enforces that through its catalog type (`CatalogFor`).
 */
export interface UiLanguageInfo {
  /** Lower-case primary language subtag (`'de'`, never `'de-AT'`); the settings value. */
  code: string
  /** The language's own name, shown untranslated in the picker. */
  nativeName: string
  /** Whether a native speaker has reviewed the catalog (machine-drafted otherwise). */
  nativeReviewed: boolean
  /**
   * Whether evidence packs can be written in this language. `false` also removes the
   * `packExport.*` keys from the language's required catalog type: they render only
   * inside a pack.
   */
  evidencePack: boolean
  /** The plural rule: which form a count takes. */
  plural: (n: number) => PluralCategory
  /**
   * The forms a catalog of this language must provide for every plural base. Pinned here
   * (rather than read from ICU at runtime) so an ICU update cannot change which keys are
   * required without a code change; a test compares the pin with the running ICU.
   */
  pluralCategories: readonly PluralCategory[]
}

/**
 * The English and German rule, kept exactly as it shipped: singular for exactly 1,
 * plural for everything else (0, negatives, fractions, NaN).
 */
export function exactOne(n: number): PluralCategory {
  return n === 1 ? 'one' : 'other'
}

/**
 * The CLDR plural rule of `code`, from the built-in `Intl.PluralRules` (no dependency).
 * The rules object is created on first use and then reused.
 */
export function cldrPlural(code: string): (n: number) => PluralCategory {
  let rules: Intl.PluralRules | undefined
  return (n) => {
    rules ??= new Intl.PluralRules(code)
    return rules.select(n) as PluralCategory
  }
}

/** Every registered interface language. English comes first: it is the fallback. */
export const UI_LANGUAGES = [
  {
    code: 'en',
    nativeName: 'English',
    nativeReviewed: true,
    evidencePack: true,
    plural: exactOne,
    pluralCategories: ['one', 'other']
  },
  {
    code: 'de',
    nativeName: 'Deutsch',
    nativeReviewed: true,
    evidencePack: true,
    plural: exactOne,
    pluralCategories: ['one', 'other']
  }
] as const satisfies readonly UiLanguageInfo[]

/** A resolved UI language (what `t` renders in). */
export type UiLanguage = (typeof UI_LANGUAGES)[number]['code']

/** The `AppSettings.uiLanguage` value: an explicit language or "follow the OS". */
export type UiLanguageSetting = UiLanguage | 'system'

/** The registered codes, in registry order. */
export const UI_LANGUAGE_CODES: readonly UiLanguage[] = UI_LANGUAGES.map((info) => info.code)

/** Whether `value` is a registered UI language code. */
export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGE_CODES as readonly string[]).includes(value)
}

/** Whether `value` is a valid `AppSettings.uiLanguage` value. */
export function isUiLanguageSetting(value: unknown): value is UiLanguageSetting {
  return value === 'system' || isUiLanguage(value)
}

/** The registry entry of a registered language. */
export function uiLanguageInfo(code: UiLanguage): UiLanguageInfo {
  // `code` is registered by type; the English fallback only guards a cast or stored junk.
  return UI_LANGUAGES.find((info) => info.code === code) ?? UI_LANGUAGES[0]
}

// ---- Catalog types -----------------------------------------------------------------------

/** The plural forms a language needs beyond the `.one`/`.other` pair English defines. */
type ExtraPluralCategory<I extends UiLanguageInfo> = Exclude<
  I['pluralCategories'][number],
  'one' | 'other'
>

/**
 * The exact key set a catalog of language `I` must have: every English key (without
 * `packExport.*` when the language writes no evidence packs), plus one key per plural
 * base for each extra plural form of the language (Russian: `.few` and `.many`).
 */
export type CatalogKeyFor<I extends UiLanguageInfo> =
  | (I['evidencePack'] extends false ? Exclude<MessageKey, `packExport.${string}`> : MessageKey)
  | `${CountMessageKey}.${ExtraPluralCategory<I>}`

/**
 * The type a catalog of language `I` is declared with. A missing key is a compile error,
 * and so is a misspelt key or a plural form the language does not have (excess property
 * on the catalog's object literal). For English and German this is `Record<MessageKey,
 * string>`.
 */
export type CatalogFor<I extends UiLanguageInfo> = Record<CatalogKeyFor<I>, string>

/** The catalog type of the registered language `C`. */
export type UiCatalog<C extends UiLanguage> = CatalogFor<
  Extract<(typeof UI_LANGUAGES)[number], { code: C }>
>

// ---- Pure cores (the registry is an argument; `index.ts` calls them with the real one) ---

/**
 * The key to render for `count` of plural base `base` in a language: `<base>.<category>`
 * by the language's rule when its catalog has that form, else `<base>.other`. The second
 * case only happens when the running ICU returns a category the registry does not pin.
 */
export function pluralKeyFor(
  info: Pick<UiLanguageInfo, 'plural'>,
  base: string,
  count: number,
  has: (key: string) => boolean
): string {
  const key = `${base}.${info.plural(count)}`
  return has(key) ? key : `${base}.other`
}

/**
 * Resolve a setting plus an OS locale against the language codes `codes` (D-L2). A
 * registered setting wins. Anything else (`'system'`, or a value this build does not
 * know) follows the OS: the locale's primary subtag (`de` of `de-AT` / `DE_ch`) when it
 * is registered, English otherwise. A missing or empty locale gives English.
 */
export function resolveUiLanguageIn<C extends string>(
  codes: readonly C[],
  setting: string,
  osLocale: string | null | undefined
): C | 'en' {
  const chosen = codes.find((code) => code === setting)
  if (chosen !== undefined) return chosen
  const primary = (osLocale ?? '').toLowerCase().split(/[-_]/)[0]
  return codes.find((code) => code === primary) ?? 'en'
}
