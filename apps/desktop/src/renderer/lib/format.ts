import type { UiLanguage } from '@shared/i18n'

/** Locale-aware one-decimal number (file sizes / RAM / GB) — grouping off so EN output
 *  stays byte-identical to the previous toFixed(1). One definition, shared by the
 *  Diagnostics card and the Chat starting panel so the same kind of value can never
 *  drift in locale/precision between screens. */
export function fmt1(n: number, lang: UiLanguage): string {
  return n.toLocaleString(lang, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false
  })
}
