// Prompt builder + language maps for the TranslateGemma sidecar (TG wave, plan §2 D2 / §7 V1).
//
// TranslateGemma is served WITHOUT `--jinja` (the #20305 embedded-template regression, plan §1.1):
// a chat-parsing rework (llama.cpp PR #19419) regressed the jinja path for this model
// ("Unable to generate parser for this template … std::bad_alloc"; fix PR #20956 still OPEN,
// re-verified 2026-07-05 at TG-2). So the trained single-user-turn prompt is formatted HERE, in
// app code, and sent to the raw `/completion` endpoint (the workaround endorsed in the issue).
// The template's own `code → language name` dictionary is unusable without jinja, so we carry
// our own English-name map below.
//
// The instruction text is TranslateGemma's documented translation prompt
// (google/translategemma-*-it model cards; arXiv:2601.09012), reconstructed 2026-07-05. The
// VERBATIM authority is the GGUF's `tokenizer.chat_template` — plan §7 V1 requires reconciling
// this builder against it before the go/no-go gate. Because that GGUF is only present on a
// provisioned drive, the manual smoke (`translategemma-smoke`) dumps the running server's
// `/props` `chat_template` and reconciles this builder against it; the snapshot test in
// `tests/unit/translation-prompt.test.ts` pins the rendered string so a drift is caught in CI.

import { TRANSLATION_LANGUAGE_CODES, type TranslationLangCode } from '../../../shared/types'

// The curated 10-language set (plan O4 / §2 D5) is CANONICAL in `shared/types.ts`
// (`TRANSLATION_LANGUAGE_CODES` / `TranslationLangCode` — unified at TG-3 so the shared
// `TranslationSourceLang`/`TranslationTargetLang` doc-task contract and this builder can
// never drift; main may import shared, not vice-versa). Re-exported here so the sidecar
// module keeps one import surface for its consumers.
export { TRANSLATION_LANGUAGE_CODES, TRANSLATION_NATIVE_NAMES } from '../../../shared/types'
export type { TranslationLangCode } from '../../../shared/types'

/**
 * English language names — used INSIDE the trained prompt (the model was fine-tuned on English
 * names + BCP-47-ish codes). TranslateGemma REQUIRES an explicit source language: without one the
 * template renders the language as "English (en-GB)" (plan §1.1), so there is no auto-detect.
 */
export const TRANSLATION_ENGLISH_NAMES: Record<TranslationLangCode, string> = {
  de: 'German',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  cs: 'Czech',
  uk: 'Ukrainian'
}

/**
 * The stop token that ends a Gemma-3 model turn. Passed as `stop: ["<end_of_turn>"]` to
 * `/completion` (plan §2 D2) so generation halts at the turn boundary and the token never leaks
 * into the translation (a smoke assertion). Gemma also emits it as an EOS-class token, so this is
 * belt-and-suspenders against a server that streams the literal marker.
 */
export const TRANSLATION_STOP_TOKEN = '<end_of_turn>'

export interface TranslationPromptInput {
  sourceLang: TranslationLangCode
  targetLang: TranslationLangCode
  /** The source text. Placed inside the prompt as DATA — it is translated, never obeyed (D2). */
  text: string
}

/** Guard: TranslateGemma needs a real source/target language, so an unknown code is a bug. */
function langName(code: TranslationLangCode): string {
  const name = TRANSLATION_ENGLISH_NAMES[code]
  if (!name) throw new Error(`Unsupported translation language code: ${String(code)}`)
  return name
}

/**
 * Build the raw `/completion` prompt for one translation window (plan §1.1 / §2 D2).
 *
 * The rendered string is the trained single-user-turn format: a `<start_of_turn>user` turn whose
 * instruction names the source→target pair (English name + code), demands "only the translation,
 * without any additional explanations or commentary", then the source text after a blank-line gap,
 * closed by `<end_of_turn>` and an open `<start_of_turn>model` turn for the model to complete.
 *
 * No `<bos>` is emitted: llama-server prepends BOS when it tokenizes the `/completion` prompt for a
 * model whose metadata sets `add_bos_token` (Gemma does) — the smoke's DE→EN sanity check is the
 * gate that this is handled correctly on the real pin (plan exit criteria; a double/missing BOS
 * would surface as garbled output → STOP and re-plan).
 *
 * The source text is interpolated as DATA. Any imperative sentences inside `{TEXT}` are part of the
 * document to translate, NOT instructions to the model — so there is deliberately no "part n of m"
 * scaffolding (plan §2 D2); the adversarial smoke window asserts embedded instructions are
 * translated, not obeyed.
 */
export function buildTranslationPrompt({ sourceLang, targetLang, text }: TranslationPromptInput): string {
  const src = langName(sourceLang)
  const tgt = langName(targetLang)
  const instruction =
    `You are a professional ${src} (${sourceLang}) to ${tgt} (${targetLang}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${src} text ` +
    `while adhering to ${tgt} grammar, vocabulary, and cultural sensitivities. ` +
    `Produce only the ${tgt} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${src} text into ${tgt}:`
  return `<start_of_turn>user\n${instruction}\n\n\n${text}<end_of_turn>\n<start_of_turn>model\n`
}
