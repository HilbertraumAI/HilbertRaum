import { en } from './en'
import { de } from './de'
import {
  UI_LANGUAGE_CODES,
  pluralKeyFor,
  resolveUiLanguageIn,
  uiLanguageInfo,
  type UiCatalog,
  type UiLanguage,
  type UiLanguageSetting
} from './languages'

// Hand-rolled, typed i18n for the registered UI languages (i18n record §3.1, D-L1, D-L9):
// synchronous flat-catalog lookup with `{name}` interpolation and plural forms chosen by
// each language's own rule (`languages.ts` holds the registry).
// Importable from BOTH processes (like `shared/types.ts`); no dependency, no async
// resource loading, nothing fetched at runtime — the catalogs are bundled statically.
//
// Fallback contract (D-L8 keeps the existing English test assertions authoritative):
// an unknown key or a missing interpolation param falls back to the ENGLISH string
// (worst case the raw key), never to an exception or an empty render.

export { en } from './en'
export { de } from './de'
export {
  UI_LANGUAGES,
  UI_LANGUAGE_CODES,
  cldrPlural,
  isUiLanguage,
  isUiLanguageSetting,
  pluralKeyFor,
  resolveUiLanguageIn,
  uiLanguageInfo
} from './languages'
export type {
  CatalogFor,
  CatalogKeyFor,
  PluralCategory,
  UiCatalog,
  UiLanguage,
  UiLanguageInfo,
  UiLanguageSetting
} from './languages'

/** Every message key, derived from the English source-of-truth catalog. */
export type MessageKey = keyof typeof en

/** Interpolation params for `{name}` placeholders. */
export type MessageParams = Record<string, string | number>

/**
 * Key bases usable with `tCount`: keys that exist as a complete
 * `<base>.one` / `<base>.other` pair in the catalog.
 */
export type CountMessageKey = {
  [K in MessageKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends MessageKey
      ? Base
      : never
    : never
}[MessageKey]

// One catalog per registered language, each checked against its own required key set
// (`UiCatalog`). Leaving a registered code out of this map is a compile error.
const CATALOGS: { readonly [C in UiLanguage]: UiCatalog<C> } = { en, de }

/** `lang`'s catalog as a plain string map, for a lookup by a computed key. */
function catalogOf(lang: UiLanguage): Record<string, string> {
  return CATALOGS[lang]
}

/** Dev-only diagnostics for fallbacks; never throws, silent in production builds. */
function warnDev(message: string): void {
  try {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return
    console.warn(`[i18n] ${message}`)
  } catch {
    /* diagnostics only */
  }
}

/** Replace `{name}` placeholders; flags placeholders that had no param supplied. */
function interpolate(
  template: string,
  params?: MessageParams
): { text: string; missingParam: boolean } {
  let missingParam = false
  const text = template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    const value = params?.[name]
    if (value === undefined) {
      missingParam = true
      return raw
    }
    return String(value)
  })
  return { text, missingParam }
}

/**
 * Look up `key` in `lang`'s catalog and interpolate `params`. Synchronous by design
 * (D-L8). Falls back to the English string on an unknown key or a missing param
 * (unresolved placeholders there stay literal — visible, never a crash).
 */
export function t(lang: UiLanguage, key: MessageKey, params?: MessageParams): string {
  return render(lang, key, key, params)
}

/**
 * The lookup behind `t` and `tCount`. `englishKey` is the key the English fallback
 * reads: `key` itself for `t`; for `tCount` the English form of the same count, because
 * a plural form English does not have (Russian `.few`) has no English entry.
 */
function render(
  lang: UiLanguage,
  key: string,
  englishKey: string,
  params?: MessageParams
): string {
  const localized = catalogOf(lang)[key]
  if (localized === undefined) {
    // Unreachable for real keys (typecheck enforces catalog parity) — runtime guard
    // for casts/persisted junk.
    warnDev(`unknown message key '${key}'`)
  } else {
    const result = interpolate(localized, params)
    if (!result.missingParam) return result.text
    // Missing-param diagnostic for EVERY language (full-audit 2026-07-11 CODE-45): it used
    // to fire only on the non-EN path, so on the EN dev/CI default a forgotten param
    // shipped a literal '{name}' silently. Rendering is unchanged — EN still falls through
    // to the English interpolation below (same text, placeholder left visibly literal);
    // non-EN still falls back to the English string.
    warnDev(
      `missing param for '${key}' (${lang})${lang === 'en' ? '' : ' — falling back to English'}`
    )
  }
  const english = catalogOf('en')[englishKey]
  if (english === undefined) return key
  return interpolate(english, params).text
}

/**
 * Plural-aware lookup: renders the form of `<keyBase>` that `lang`'s plural rule selects
 * for `count` (D-L1). English and German keep the exact `count === 1` rule (`.one` for
 * exactly 1, else `.other`), so two variants suffice for them; a language with more
 * forms carries them in its catalog as `<keyBase>.few` / `.many`. `{count}` is always
 * available as a param (a caller may pass its own pre-formatted `count`).
 */
export function tCount(
  lang: UiLanguage,
  keyBase: CountMessageKey,
  count: number,
  params?: MessageParams
): string {
  const keyIn = (language: UiLanguage): string => {
    const catalog = catalogOf(language)
    return pluralKeyFor(uiLanguageInfo(language), keyBase, count, (key) =>
      Object.hasOwn(catalog, key)
    )
  }
  return render(lang, keyIn(lang), keyIn('en'), { count, ...params })
}

/**
 * Resolve the effective UI language from the setting + an OS locale (D-L2): an explicit
 * registered language wins. 'system' (or a value this build does not know) follows the
 * OS locale's primary subtag — `de`, `de-AT`, `de_CH`, … mean German — when that
 * language is registered, and is English otherwise. Tolerates null/empty locales
 * (→ English).
 */
export function resolveUiLanguage(
  setting: UiLanguageSetting,
  osLocale: string | null | undefined
): UiLanguage {
  return resolveUiLanguageIn(UI_LANGUAGE_CODES, setting, osLocale)
}
