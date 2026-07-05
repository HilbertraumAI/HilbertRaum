import { extname } from 'node:path'
import { TRANSLATION_NATIVE_NAMES, type TranslationTargetLang } from '../../../shared/types'
import { packIntoWindows } from './summary'

// Translation window math + output framing (split out of the former monolithic doctasks.ts —
// audit M-A4). Since TG-3 the translation doc-task runs on the TranslateGemma SIDECAR
// (translategemma plan §2 D3): the PROMPT lives inside `services/translation/prompt.ts` (built
// per window by the sidecar service, raw `/completion`, greedy temperature 0) — the former
// chat-model system/window prompts and their 0.2 temperature were deleted with that path (git
// history keeps them). What remains here is the pure planning math plus the attribution/title/
// failed-window framing of the materialized output.
//
// Translation input: translate the parser's SEGMENTS, re-extracted from the stored
// copy via `extractDocumentPreview` — NOT the stored chunks. Chunks overlap by
// ~80 tokens (the retrieval overlap); naive in-order chunk concatenation would
// DUPLICATE text at every boundary in the translated output. A summary tolerates that
// repetition; a faithful translation cannot. The segments are ordered,
// non-overlapping, and exact; the cost is one re-parse of the stored copy — the same
// cost the in-app preview already pays, on the same code path (encrypted copies
// decrypt to a `.parse*` transient and are shredded inside). Trimming the overlap out
// of adjacent chunks instead would be fragile: chunk text is whitespace-normalized at
// the token level, so overlap-matching is heuristic where the re-parse is exact.
//
// Window sizing: unlike a summary (long in, short out), a translation's OUTPUT is
// roughly as long as its input — and in TOKENS the Gemma tokenizer is HEAVY, much
// heavier than the Qwen3-4B estimates the chat path used. TG-6 re-measured the REAL
// Gemma tokenizer on the pinned runtime (`llama-tokenize` over realistic office prose
// across the curated 10): INPUT runs en 1.11 · de 1.43 · nl 1.65 · uk 2.13 · pl 2.19 ·
// cs 2.26 tokens/word (a token-dense 20-word invoice line peaks ~2.8); OUTPUT into the
// token-dense targets runs to ~1.96 tokens per SOURCE word (word-sparse German →
// Czech/Ukrainian), the dense short samples ~3.06. Both FAR exceed the old 1.3/2.0 — at
// those the ~1,150-word windows the chat estimate implied would have been ~3,200+ input
// tokens ALONE, blowing past both the 2K trained input AND the launched 4096 context (a
// latent overflow the TG-6 re-measure caught). The usable context is therefore split by
// MEASURED-then-rounded-UP weights: input claims `TRANSLATION_INPUT_TOKENS_PER_WORD`,
// output claims `TRANSLATION_OUTPUT_TOKENS_PER_WORD` — a window's input budget is
// usable/(input+output) words and the rest is output headroom. Both are conservative
// CEILINGS over the measured maxima, so a window can only ever OVER-chunk (harmless),
// never overflow the launched context or the output cap. On top of that sits the D4
// clamp: TranslateGemma's model card specifies a TOTAL INPUT of ~2K tokens (the gemma3
// architecture supports far more, but the fine-tune is trained/evaluated at ≤2K), so the
// per-window input is HARD-capped at `TRANSLATION_MAX_INPUT_TOKENS` regardless of the
// launched context — and at 2.5 tokens/word that clamp binds in REAL tokens (a clamp-word
// window stays under the trained 2K). There is NO window ceiling: a faithful translation
// may not silently truncate the document (the summary ceiling exists because a summary may
// honestly cover "the beginning"; a translation may not). Long documents simply take more
// windows — progress is visible and cancel always works.

/**
 * Reserved for the sidecar's prompt scaffold (`buildTranslationPrompt`'s instruction +
 * turn markers — well under 150 tokens for every language pair), in model tokens.
 * Kept at the chat-era 300 as conservative headroom until TG-6 re-measures.
 */
export const TRANSLATION_PROMPT_RESERVE_TOKENS = 300
/**
 * INPUT tokens per SOURCE word on the real Gemma tokenizer — MEASURED at TG-6
 * (`llama-tokenize` over realistic office prose, the curated 10: en 1.11 · de 1.43 ·
 * nl 1.65 · uk 2.13 · pl 2.19 · cs 2.26; a token-dense 20-word invoice line peaks ~2.8).
 * 2.5 is a conservative CEILING above the heaviest (Czech/Cyrillic) so a window can only
 * OVER-chunk, never overflow. This REPLACES the Qwen3-4B-measured 1.3 the chat path used
 * (~half the real Gemma weight — the latent overflow the TG-6 re-measure caught). It is
 * deliberately NOT the shared `SUMMARY_TOKENS_PER_WORD` (1.3): that stays the CHAT model's
 * summary factor for a DIFFERENT tokenizer and must not move with translation.
 */
export const TRANSLATION_INPUT_TOKENS_PER_WORD = 2.5
/**
 * OUTPUT tokens per SOURCE word — MEASURED at TG-6 (word-sparse German source → token-dense
 * targets, the worst case: en→de 1.39 · de→pl 1.79 · de→uk 1.90 · de→cs 1.96 on prose). 3.0 is a
 * conservative ceiling well above the realistic prose worst case (1.96) — a several-hundred-word
 * window's real output sits far under the resulting cap, so it can never truncate a realistic
 * window's translation. (The ~3.06 seen on a token-dense 20-word invoice line is a SHORT-sample
 * peak, not a sustained rate: a full window amortizes far below it, so it does not truncate
 * either.) Raised from the Qwen3-4B-measured 2.0.
 */
export const TRANSLATION_OUTPUT_TOKENS_PER_WORD = 3.0
/**
 * D4 (translategemma plan §2): the model card's "Total input context of 2K tokens",
 * minus the prompt scaffold — a HARD per-window input ceiling enforced by
 * `translationBudgetWords` even when the launched context would allow more. At the TG-6
 * `TRANSLATION_INPUT_TOKENS_PER_WORD = 2.5` this is ~720 words; on realistic prose (≤2.26 tok/word)
 * a window's real input then stays under the trained 2K, and a rare token-dense window (~2.8
 * tok/word + scaffold) nudges only slightly over 2K — a fine-tune-QUALITY edge, still far under the
 * launched 4096 context, so never a hard overflow. (At `--ctx-size 4096` the output-room split
 * above binds first at ~690 words; this clamp is the backstop that keeps a bigger future context
 * from quietly exceeding the trained input.)
 */
export const TRANSLATION_MAX_INPUT_TOKENS = 1800
/** Floor for a window's output cap (degenerate tiny contexts). */
const TRANSLATION_MIN_OUTPUT_TOKENS = 256
/** Floor for the per-window input budget, in words. */
const TRANSLATION_MIN_BUDGET_WORDS = 120

/** Usable model tokens for a translation call after the prompt reserve. */
function translationUsableTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - TRANSLATION_PROMPT_RESERVE_TOKENS
}

/**
 * The per-window INPUT budget in WORDS: the input's share of the usable context,
 * clamped to the D4 input spec. The tokens-per-word constants are the TG-6
 * Gemma-tokenizer measurements (`TRANSLATION_INPUT_TOKENS_PER_WORD` /
 * `TRANSLATION_OUTPUT_TOKENS_PER_WORD` above) — conservative ceilings, so this can only
 * ever OVER-chunk, never overflow.
 */
export function translationBudgetWords(contextTokens: number): number {
  const byContext = Math.floor(
    translationUsableTokens(contextTokens) /
      (TRANSLATION_INPUT_TOKENS_PER_WORD + TRANSLATION_OUTPUT_TOKENS_PER_WORD)
  )
  const byInputSpec = Math.floor(TRANSLATION_MAX_INPUT_TOKENS / TRANSLATION_INPUT_TOKENS_PER_WORD)
  return Math.max(TRANSLATION_MIN_BUDGET_WORDS, Math.min(byContext, byInputSpec))
}

export interface TranslationPlan {
  /** Window texts, in document order (segments packed; over-budget segments split). */
  windows: string[]
  /** Output cap per window call: everything the input share leaves free. */
  windowMaxTokens: number
  /** Model calls (windows) + the final materialize step. */
  stepsTotal: number
}

/**
 * Plan the translation windows for a document's re-extracted SEGMENT texts (pure —
 * unit-tested at the boundaries). No ceiling and no reduce: every window is translated
 * in document order and concatenated. `contextTokens` is the SIDECAR's launched
 * `--ctx-size` (`Translator.contextWindow()`), not the chat runtime's window.
 */
export function planTranslationWindows(
  segmentTexts: string[],
  contextTokens: number
): TranslationPlan {
  const usable = translationUsableTokens(contextTokens)
  const budgetWords = translationBudgetWords(contextTokens)
  const windows = packIntoWindows(segmentTexts, budgetWords)
  // Output headroom = the usable tokens the input share cannot consume — ≥ the output
  // weight × input words by construction (TRANSLATION_OUTPUT_TOKENS_PER_WORD; more when
  // the D4 clamp shrinks the input share of a larger context).
  const windowMaxTokens = Math.max(
    TRANSLATION_MIN_OUTPUT_TOKENS,
    usable - Math.ceil(budgetWords * TRANSLATION_INPUT_TOKENS_PER_WORD)
  )
  return { windows, windowMaxTokens, stepsTotal: windows.length + 1 }
}

/**
 * Visible marker for a window the model refused/garbled after a retry: the output
 * keeps the ORIGINAL text under the notice — never a silent gap.
 */
export function failedWindowNotice(part: number, total: number): string {
  return (
    `> ⚠ This part (${part} of ${total}) could not be translated — ` +
    'the original text is kept below unchanged.'
  )
}

/** The honesty attribution prepended to every materialized translation. */
export function translationAttributionLine(modelId: string): string {
  return `Machine-translated by ${modelId} — may contain errors.`
}

/**
 * "report.pdf" + de → "report (Deutsch).md" (the materialized doc is Markdown). The
 * label is the target's NATIVE name (shared/types `TRANSLATION_NATIVE_NAMES` — the
 * curated 10, untranslated by design).
 */
export function translatedDocumentTitle(
  sourceTitle: string,
  targetLang: TranslationTargetLang
): string {
  const ext = extname(sourceTitle)
  const base = (ext ? sourceTitle.slice(0, -ext.length) : sourceTitle).trim() || 'document'
  return `${base} (${TRANSLATION_NATIVE_NAMES[targetLang]}).md`
}
