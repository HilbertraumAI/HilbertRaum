import { en } from './en'
import { de } from './de'

// Hand-rolled, typed i18n for the two UI languages (i18n-plan §3.1, D-L1): synchronous
// flat-catalog lookup with `{name}` interpolation and `.one`/`.other` plural pairs.
// Importable from BOTH processes (like `shared/types.ts`); no dependency, no async
// resource loading, nothing fetched at runtime — the catalogs are bundled statically.
//
// Fallback contract (D-L8 keeps the existing English test assertions authoritative):
// an unknown key or a missing interpolation param falls back to the ENGLISH string
// (worst case the raw key), never to an exception or an empty render.

export { en } from './en'
export { de } from './de'

/** Every message key, derived from the English source-of-truth catalog. */
export type MessageKey = keyof typeof en

/** A resolved UI language (what `t` renders in). */
export type UiLanguage = 'en' | 'de'

/** The `AppSettings.uiLanguage` value: an explicit language or "follow the OS". */
export type UiLanguageSetting = UiLanguage | 'system'

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

const CATALOGS: Record<UiLanguage, Record<string, string>> = { en, de }

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
  const localized = CATALOGS[lang][key]
  if (localized === undefined) {
    // Unreachable for real keys (typecheck enforces catalog parity) — runtime guard
    // for casts/persisted junk.
    warnDev(`unknown message key '${key}'`)
  } else if (lang !== 'en') {
    const result = interpolate(localized, params)
    if (!result.missingParam) return result.text
    warnDev(`missing param for '${key}' (${lang}) — falling back to English`)
  }
  const english = (en as Record<string, string>)[key]
  if (english === undefined) return key
  return interpolate(english, params).text
}

/**
 * Plural-aware lookup: selects `<keyBase>.one` when `count === 1`, else
 * `<keyBase>.other`. English and German share the n === 1 plural rule, so two variants
 * suffice — no ICU machinery (D-L1). `{count}` is always available as a param.
 */
export function tCount(
  lang: UiLanguage,
  keyBase: CountMessageKey,
  count: number,
  params?: MessageParams
): string {
  const key = `${keyBase}.${count === 1 ? 'one' : 'other'}` as MessageKey
  return t(lang, key, { count, ...params })
}

/**
 * Resolve the effective UI language from the setting + an OS locale (D-L2):
 * 'system' → a `de`-prefixed locale (`de`, `de-AT`, `de_CH`, …) means German,
 * everything else English. Tolerates null/empty locales (→ English).
 */
export function resolveUiLanguage(
  setting: UiLanguageSetting,
  osLocale: string | null | undefined
): UiLanguage {
  if (setting === 'en' || setting === 'de') return setting
  const locale = (osLocale ?? '').toLowerCase()
  return locale === 'de' || locale.startsWith('de-') || locale.startsWith('de_') ? 'de' : 'en'
}
