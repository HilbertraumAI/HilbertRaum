import {
  t,
  tCount,
  uiLanguageInfo,
  type CountMessageKey,
  type MessageKey,
  type MessageParams,
  type UiLanguage
} from '@shared/i18n'

// Shared components RECEIVE a bound translate function as a prop/argument instead of
// importing the renderer i18n context (i18n record §5 ⑤) — they stay pure and reusable.
// The default (used when no `t` prop is passed, e.g. provider-less component tests)
// is the English catalog, mirroring the useT() provider-less fallback (D-L8).

/** A translate function already bound to the active language. */
export type Translator = (key: MessageKey, params?: MessageParams) => string

/** Default Translator: the English catalog (pure — no hidden language state). */
export const englishTranslator: Translator = (key, params) => t('en', key, params)

/** The plural-aware lookup (`tCount`) already bound to the active language. */
export type CountTranslator = (keyBase: CountMessageKey, count: number, params?: MessageParams) => string

/** The English CountTranslator, the plural companion of `englishTranslator`. */
export const englishCountTranslator: CountTranslator = (keyBase, count, params) =>
  tCount('en', keyBase, count, params)

/**
 * One language's whole binding: its `t`, its `tCount` and the language itself (numbers and
 * dates). A text built from one binding is in one language throughout; `useT()`'s value is one.
 */
export interface LanguageBinding {
  t: Translator
  tCount: CountTranslator
  lang: UiLanguage
}

/** The English binding. */
export const englishBinding: LanguageBinding = {
  t: englishTranslator,
  tCount: englishCountTranslator,
  lang: 'en'
}

/** The interface languages a support report is read in as it is: the maintainers read these (#812). */
const READ_BY_SUPPORT: ReadonlySet<UiLanguage> = new Set<UiLanguage>(['en', 'de'])

/**
 * A support report that a maintainer can read (#812, owner call G-7: one paste, both reports).
 * In English or German it is `build(binding)` alone. In any other interface language it is that
 * report, then one divider line naming English by its own name from the registry, then the same
 * report built in English. The divider is plain ASCII, so the paste stays plain text.
 */
export function withEnglishCopy(binding: LanguageBinding, build: (tr: LanguageBinding) => string): string {
  const report = build(binding)
  if (READ_BY_SUPPORT.has(binding.lang)) return report
  return [report, `--- ${uiLanguageInfo('en').nativeName} ---`, build(englishBinding)].join('\n')
}
