import { extname } from 'node:path'
import { TRANSLATION_NATIVE_NAMES, type TranslationTargetLang } from '../../../shared/types'
import { packIntoWindows, SUMMARY_TOKENS_PER_WORD } from './summary'

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
// roughly as long as its input — and in TOKENS it is heavier than the input estimate:
// a smoke run on the pinned runtime measured German output at ~2 real tokens per
// source word (subword-heavy compounds), and an early half-input/half-output split
// TRUNCATED a near-budget window mid-sentence when its German output hit the cap. The
// usable context is therefore split by measured weight: input claims 1.3 tokens/word
// (the summary safety factor), output claims 2.0 — i.e. a window's input budget is
// usable/(1.3+2.0) words and the rest of the context is output headroom. On top of that
// sits the D4 clamp: TranslateGemma's model card specifies a TOTAL INPUT of ~2K tokens
// (the gemma3 architecture supports far more, but the fine-tune is trained/evaluated at
// ≤2K), so the per-window input is HARD-capped at `TRANSLATION_MAX_INPUT_TOKENS`
// regardless of the launched context. There is NO window ceiling: a faithful
// translation may not silently truncate the document (the summary ceiling exists
// because a summary may honestly cover "the beginning"; a translation may not). Long
// documents simply take more windows — progress is visible and cancel always works.

/**
 * Reserved for the sidecar's prompt scaffold (`buildTranslationPrompt`'s instruction +
 * turn markers — well under 150 tokens for every language pair), in model tokens.
 * Kept at the chat-era 300 as conservative headroom until TG-6 re-measures.
 */
export const TRANSLATION_PROMPT_RESERVE_TOKENS = 300
/**
 * Estimated OUTPUT tokens per source word for DE↔EN (measured on the pinned
 * llama.cpp build + Qwen3-4B — German output is subword-heavy; 1.3× headroom
 * truncated a near-budget window, 2.0× leaves ~40% margin over the worst measurement).
 * Deliberately conservative for TranslateGemma too: over-chunking is harmless where
 * overflow is not. TG-6 re-measures both constants on the Gemma tokenizer.
 */
export const TRANSLATION_OUTPUT_TOKENS_PER_WORD = 2.0
/**
 * D4 (translategemma plan §2): the model card's "Total input context of 2K tokens",
 * minus the prompt scaffold — a HARD per-window input ceiling enforced by
 * `translationBudgetWords` even when the launched context would allow more (the
 * `--ctx-size 4096` split above already stays under it; this clamp is what keeps a
 * bigger future context from quietly exceeding the fine-tune's trained input size).
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
 * clamped to the D4 input spec (tokens-per-word constants measured on Qwen3-4B —
 * conservative defaults until the TG-6 Gemma-tokenizer re-measurement).
 */
export function translationBudgetWords(contextTokens: number): number {
  const byContext = Math.floor(
    translationUsableTokens(contextTokens) /
      (SUMMARY_TOKENS_PER_WORD + TRANSLATION_OUTPUT_TOKENS_PER_WORD)
  )
  const byInputSpec = Math.floor(TRANSLATION_MAX_INPUT_TOKENS / SUMMARY_TOKENS_PER_WORD)
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
  // Output headroom = the usable tokens the input share cannot consume — ≥2.0× the
  // input words by construction (TRANSLATION_OUTPUT_TOKENS_PER_WORD; more when the D4
  // clamp shrinks the input share of a larger context).
  const windowMaxTokens = Math.max(
    TRANSLATION_MIN_OUTPUT_TOKENS,
    usable - Math.ceil(budgetWords * SUMMARY_TOKENS_PER_WORD)
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
