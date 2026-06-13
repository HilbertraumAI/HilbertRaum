import { extname } from 'node:path'
import type { TranslationTargetLang } from '../../../shared/types'
import { packIntoWindows, SUMMARY_TOKENS_PER_WORD } from './summary'

// Translation window math + templates (split out of the former monolithic doctasks.ts —
// audit M-A4).
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
// usable/(1.3+2.0) words and the rest of the context is output headroom. There is NO
// window ceiling: a faithful translation may not silently truncate the document (the
// summary ceiling exists because a summary may honestly cover "the beginning"; a
// translation may not). Long documents simply take more windows — progress is visible
// and cancel always works.

/** Reserved for the instruction template + chat chrome, in model tokens. */
export const TRANSLATION_PROMPT_RESERVE_TOKENS = 300
/**
 * Estimated OUTPUT tokens per source word for DE↔EN (measured on the pinned
 * llama.cpp build + Qwen3-4B — German output is subword-heavy; 1.3× headroom
 * truncated a near-budget window, 2.0× leaves ~40% margin over the worst measurement).
 */
export const TRANSLATION_OUTPUT_TOKENS_PER_WORD = 2.0
/** Very low temperature: translation should be literal, not creative. */
export const TRANSLATION_TEMPERATURE = 0.2
/** Floor for a window's output cap (degenerate tiny contexts). */
const TRANSLATION_MIN_OUTPUT_TOKENS = 256
/** Floor for the per-window input budget, in words. */
const TRANSLATION_MIN_BUDGET_WORDS = 120

/** Usable model tokens for a translation call after the prompt reserve. */
function translationUsableTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - TRANSLATION_PROMPT_RESERVE_TOKENS
}

/** The per-window INPUT budget in WORDS (the input's share of the usable context). */
export function translationBudgetWords(contextTokens: number): number {
  return Math.max(
    TRANSLATION_MIN_BUDGET_WORDS,
    Math.floor(
      translationUsableTokens(contextTokens) /
        (SUMMARY_TOKENS_PER_WORD + TRANSLATION_OUTPUT_TOKENS_PER_WORD)
    )
  )
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
 * in document order and concatenated.
 */
export function planTranslationWindows(
  segmentTexts: string[],
  contextTokens: number
): TranslationPlan {
  const usable = translationUsableTokens(contextTokens)
  const budgetWords = translationBudgetWords(contextTokens)
  const windows = packIntoWindows(segmentTexts, budgetWords)
  // Output headroom = the usable tokens the input share cannot consume — ≈2.0× the
  // input words by construction (TRANSLATION_OUTPUT_TOKENS_PER_WORD).
  const windowMaxTokens = Math.max(
    TRANSLATION_MIN_OUTPUT_TOKENS,
    usable - Math.ceil(budgetWords * SUMMARY_TOKENS_PER_WORD)
  )
  return { windows, windowMaxTokens, stepsTotal: windows.length + 1 }
}

const TARGET_LANG_NAME: Record<TranslationTargetLang, string> = {
  de: 'German',
  en: 'English'
}

/** The display label used in the materialized document's title. */
export const TARGET_LANG_TITLE_LABEL: Record<TranslationTargetLang, string> = {
  de: 'Deutsch',
  en: 'English'
}

/**
 * Strict translator instructions: translate, don't summarize; keep
 * the Markdown structure; numbers/names/dates verbatim; output only the translation
 * (the 4B-class models otherwise prepend "Here is the translation:" chatter).
 */
export function translationSystemPrompt(targetLang: TranslationTargetLang): string {
  const lang = TARGET_LANG_NAME[targetLang]
  return (
    `You are a professional translator working fully offline. Translate the user's text into ${lang}. ` +
    'Translate faithfully and completely — never summarize, shorten, or add anything. ' +
    'Preserve the Markdown structure: headings, lists, tables, and emphasis stay as they are. ' +
    'Keep numbers, dates, names, and codes exactly as written. ' +
    'Reply with ONLY the translation — no introduction, no notes, no explanations.'
  )
}

export function translationWindowPrompt(
  targetLang: TranslationTargetLang,
  part: number,
  total: number,
  text: string
): string {
  const lang = TARGET_LANG_NAME[targetLang]
  const partNote =
    total > 1 ? ` This is part ${part} of ${total} of a longer document; translate just this part.` : ''
  return (
    `Translate the following text into ${lang}.${partNote} ` +
    'Translate everything, keep numbers, names, and dates verbatim, and reply with only the translation.\n\n' +
    `Text:\n${text}`
  )
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

/** "report.pdf" + de → "report (Deutsch).md" (the materialized doc is Markdown). */
export function translatedDocumentTitle(
  sourceTitle: string,
  targetLang: TranslationTargetLang
): string {
  const ext = extname(sourceTitle)
  const base = (ext ? sourceTitle.slice(0, -ext.length) : sourceTitle).trim() || 'document'
  return `${base} (${TARGET_LANG_TITLE_LABEL[targetLang]}).md`
}
