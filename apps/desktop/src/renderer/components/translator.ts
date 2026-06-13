import { t, type MessageKey, type MessageParams } from '@shared/i18n'

// Shared components RECEIVE a bound translate function as a prop/argument instead of
// importing the renderer i18n context (i18n record §5 ⑤) — they stay pure and reusable.
// The default (used when no `t` prop is passed, e.g. provider-less component tests)
// is the English catalog, mirroring the useT() provider-less fallback (D-L8).

/** A translate function already bound to the active language. */
export type Translator = (key: MessageKey, params?: MessageParams) => string

/** Default Translator: the English catalog (pure — no hidden language state). */
export const englishTranslator: Translator = (key, params) => t('en', key, params)
