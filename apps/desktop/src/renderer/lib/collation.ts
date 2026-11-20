import type { UiLanguage } from '@shared/i18n'

/**
 * Display order for names (#828, #818): the interface language's own collation, not the code-point
 * order SQLite's `ORDER BY name` returns. Renderer-only and display-only: main's order stays as it is.
 * One collator per language for the whole renderer, so the compare function keeps its identity
 * (memoized rows such as DocRow do not re-render because of it).
 */
const compareByLang = new Map<UiLanguage, (a: string, b: string) => number>()

export function nameCompare(lang: UiLanguage): (a: string, b: string) => number {
  let compare = compareByLang.get(lang)
  if (!compare) {
    compare = new Intl.Collator(lang).compare
    compareByLang.set(lang, compare)
  }
  return compare
}

/** A sorted copy in the language's name order. Stable: equal names keep their incoming order. */
export function inNameOrder<T extends { name: string }>(items: readonly T[], lang: UiLanguage): T[] {
  const compare = nameCompare(lang)
  return [...items].sort((a, b) => compare(a.name, b.name))
}
