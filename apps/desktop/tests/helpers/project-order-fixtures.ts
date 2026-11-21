import type { UiLanguage } from '../../src/shared/i18n'

const C = String.fromCharCode

/**
 * Three project names per language, given in code-point order (the order main's `ORDER BY name`
 * returns), chosen so that the language's own order differs from BOTH the code-point order and the
 * 'en' order. A row built on them cannot pass on SQL order or on a collator without the language
 * (#828; the issue's own pairs Çanta/Cuma and Łódź/Lublin sort the same in SQL and in tr/pl).
 */
export const PROJECT_ORDER_CASES: Array<[UiLanguage, string[]]> = [
  ['tr', ['Cuma', `${C(0x00c7)}anta`, 'Dolap'].sort()],
  ['pl', ['Lublin', `${C(0x0141)}${C(0x00f3)}d${C(0x017a)}`, 'Mazury'].sort()],
  [
    'uk',
    ['Zeugnisse', `${C(0x0413)}${C(0x043e)}${C(0x0440)}${C(0x0430)}`, `${C(0x0490)}${C(0x0430)}${C(0x043d)}${C(0x043e)}${C(0x043a)}`].sort()
  ]
]

/** The names in the interface language's order. */
export const inLanguageOrder = (lang: UiLanguage, names: string[]): string[] =>
  [...names].sort(new Intl.Collator(lang).compare)
