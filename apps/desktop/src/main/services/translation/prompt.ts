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

// The language set (plan O4 / §2 D5; widened to the 51-code WMT24++ production tier at issue #31)
// is CANONICAL in `shared/types.ts` (`TRANSLATION_LANGUAGE_CODES` / `TranslationLangCode` —
// unified at TG-3 so the shared `TranslationSourceLang`/`TranslationTargetLang` doc-task contract
// and this builder can never drift; main may import shared, not vice-versa). Re-exported here so
// the sidecar module keeps one import surface for its consumers.
export { TRANSLATION_LANGUAGE_CODES, TRANSLATION_NATIVE_NAMES } from '../../../shared/types'
export type { TranslationLangCode } from '../../../shared/types'

/**
 * English language names — used INSIDE the trained prompt (the model was fine-tuned on English
 * names + BCP-47-ish codes). TranslateGemma REQUIRES an explicit source language: without one the
 * template renders the language as "English (en-GB)" (plan §1.1), so there is no auto-detect.
 *
 * The names mirror the template's own `code → name` dictionary as far as it is known (the GGUF's
 * `tokenizer.chat_template` is the VERBATIM authority — plan §7 V1; the manual smoke reconciles).
 * Notable spellings: `fa` is "Persian" and `zh` is "Chinese (Simplified)" (the template
 * distinguishes zh/zh-Hant; bare `zh` targets Simplified). Minor name drift is tolerated by the
 * model — the code in parentheses is the stronger signal — but reconcile at the next smoke.
 */
export const TRANSLATION_ENGLISH_NAMES: Record<TranslationLangCode, string> = {
  ar: 'Arabic',
  bg: 'Bulgarian',
  bn: 'Bengali',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  et: 'Estonian',
  fa: 'Persian',
  fi: 'Finnish',
  fil: 'Filipino',
  fr: 'French',
  gu: 'Gujarati',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  is: 'Icelandic',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  lt: 'Lithuanian',
  lv: 'Latvian',
  ml: 'Malayalam',
  mr: 'Marathi',
  nl: 'Dutch',
  no: 'Norwegian',
  pa: 'Punjabi',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sr: 'Serbian',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese (Simplified)',
  zu: 'Zulu'
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

/**
 * The Gemma-3 special-token family. llama-server tokenizes the raw `/completion` prompt WITH
 * special-token parsing, so a literal control marker inside the source DOCUMENT tokenizes to the
 * real control token. For the turn markers (`<start_of_turn>`/`<end_of_turn>`) that forges a turn
 * boundary — letting embedded text escape the "translated, never obeyed" boundary the D2 guarantee
 * only extended to plain-text imperatives (TA-4 M4). For the rest of the family (`<bos>`, `<eos>`,
 * `<unk>`, `<pad>`, and the Gemma-3 image markers `<start_of_image>`/`<end_of_image>`) it is not a
 * turn-forgery escape, but a stray mid-prompt BOS/EOS still injects a real control token that can
 * degrade that window's output for no reason (FA-2 F-5). The list is kept to the EXACT known
 * markers so ordinary `<…>` HTML/code stays untouched.
 *
 * TODO(smoke): reconfirm this family against the pinned GGUF's `tokenizer.chat_template` /
 * `added_tokens` at the next manual `translategemma-smoke` — the list is shipped defensively from
 * the Gemma-3 model card meanwhile (the same posture TA-4 M4 took for the two turn markers).
 */
const GEMMA_SPECIAL_TOKEN_RE =
  /<(start_of_turn|end_of_turn|bos|eos|unk|pad|start_of_image|end_of_image)>/g

/**
 * Neutralize the Gemma special tokens in source text so an embedded literal marker cannot forge a
 * turn boundary (M4) or inject a stray control token (FA-2 F-5).
 *
 * We rewrite each marker to a visually-identical spelling using mathematical angle brackets
 * (U+27E8 ⟨ / U+27E9 ⟩) — chosen because it (a) tokenizes as ordinary text, never a special token,
 * (b) is reversible-safe and human-legible so translation fidelity is preserved (the translated
 * form of a control marker is best-effort regardless — it is not natural-language content), and
 * (c) touches ONLY the exact Gemma markers, leaving ordinary `<…>` content (HTML, code) untouched.
 * The prompt's own scaffold markers are added AFTER this rewrite, so they survive.
 */
export function sanitizeSourceText(text: string): string {
  return text.replace(GEMMA_SPECIAL_TOKEN_RE, '⟨$1⟩')
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
 * translated, not obeyed. The text is first run through `sanitizeSourceText` so an embedded literal
 * Gemma turn marker cannot forge a turn boundary (TA-4 M4) — plain-text imperatives were already
 * safe, this closes the control-token escape.
 */
export function buildTranslationPrompt({ sourceLang, targetLang, text }: TranslationPromptInput): string {
  const src = langName(sourceLang)
  const tgt = langName(targetLang)
  const safeText = sanitizeSourceText(text)
  const instruction =
    `You are a professional ${src} (${sourceLang}) to ${tgt} (${targetLang}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${src} text ` +
    `while adhering to ${tgt} grammar, vocabulary, and cultural sensitivities. ` +
    `Produce only the ${tgt} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${src} text into ${tgt}:`
  return `<start_of_turn>user\n${instruction}\n\n\n${safeText}<end_of_turn>\n<start_of_turn>model\n`
}
