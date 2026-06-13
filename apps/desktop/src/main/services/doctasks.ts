import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { t, type MessageKey } from '../../shared/i18n'
import { tMain } from './i18n'
import type { Db } from './db'
import type {
  DocTaskKind,
  DocTaskStatus,
  DocumentOrigin,
  DocumentSummary,
  StartDocTaskRequest,
  TranslationTargetLang
} from '../../shared/types'
import type { ChatMessage, ModelRuntime } from './runtime'
import { approxTokenCount, tokenize } from './ingestion/chunker'
import {
  createQueuedDocument,
  deleteDocument,
  extractDocumentPreview,
  getDocument,
  processDocument,
  reindexDocument,
  setDocumentOcr,
  setDocumentOrigin,
  setDocumentSummary,
  type IngestionDeps
} from './ingestion'
import { isPdfPath } from './ingestion/parsers'
import type { OcrEngine, OcrPage } from './ocr'
import type { RasterizePdf } from './ocr/rasterizer'
import { ENCRYPTED_DOC_SUFFIX, shredFile } from './workspace-vault'
import { decodeVector, VectorIndex } from './embeddings'
import { isAbortError, stripThinkBlocks } from './chat'
import type { AuditRecorder } from './audit'
import { log } from './logging'

// Document task service (docs/functionality-wave-3-plan.md §6–§8) — the shared engine
// for summary, translation, and compare: an async-with-polling job state machine.
//
// Concurrency (strict one-at-a-time):
// - Tasks serialize among THEMSELVES: one FIFO queue, one running task.
// - A task REFUSES to start while a chat answer is streaming. The check reads the
//   per-conversation in-flight registry, but tasks get their OWN AbortController and
//   are NEVER entries in that map — `stopGeneration(conversationId)` must not be able
//   to kill a document task, and a task must not block a conversation key.
// - The inverse guard lives in the chat/RAG IPC handlers: a chat message sent while a
//   task is active gets DOC_TASK_BUSY_MESSAGE (with a renderer-side cancel option).
//
// Runtime use: tasks call the ACTIVE chat runtime via the same `chatStream` contract
// with EXPLICIT maxTokens/temperature — never the answer-depth modes. No runtime
// running → a friendly "start a model first" failure, never an auto-start surprise
// (same rule as sendChatMessage).
//
// Vault-lease note: a summary task only READS chunk rows and WRITES the
// `documents.summary_json` column of the open DB — it never touches the `.enc`
// document sidecars on disk. It therefore deliberately does NOT take the
// `beginDocumentWork()` lease (which exists to keep sidecar writers and the vault
// password change mutually exclusive). TRANSLATION and COMPARE tasks are the inverse:
// their materialize step writes a `.enc` sidecar through the normal import path, so
// that step — and ONLY that step — holds the lease. The long window-by-window model
// loop runs lease-free so a password change is never blocked for minutes; a change
// landing mid-loop just makes the final materialize fail friendly (VaultBusyError).
//
// Privacy: summaries, translations, and comparison reports are CONTENT. They are
// persisted only in the (possibly encrypted) workspace — `documents.summary_json` /
// the materialized `.enc` document — and the audit events carry ids and kinds only
// (`{ kind, documentId }`, plus `documentIdB` for a compare).

// Friendly copy (spec §11.4) for the guards + failure states. Task errors live ONLY in
// the in-memory polling status (never the DB — verified for the i18n boundary, plan §6
// fact-5 check), so the THROW sites localize via tMain() (i18n record §3.3 rule 2). The
// canonical-English constants stay exported for the exact-string tests (D-L8).
export const TASK_NEEDS_RUNTIME_MESSAGE = t('en', 'main.noModelRunning')
export const TASK_REFUSED_CHAT_STREAMING_MESSAGE = t('en', 'main.task.refusedChatStreaming')
export const TASK_COMPARE_PICK_TWO_MESSAGE = t('en', 'main.task.comparePickTwo')
export const TASK_COMPARE_REINDEX_MESSAGE = t('en', 'main.task.compareReindex')
export const TASK_DOCUMENT_NOT_READY_MESSAGE = t('en', 'main.task.documentNotReady')
export const TASK_GENERIC_FAILURE_MESSAGE = t('en', 'main.task.genericFailure')
export const TASK_EXPIRED_MESSAGE = t('en', 'main.task.expired')
export const TASK_TRANSLATION_TARGET_MESSAGE = t('en', 'main.task.translationTarget')
export const TASK_SOURCE_UNREADABLE_MESSAGE = t('en', 'main.task.sourceUnreadable')
export const TASK_NEEDS_OCR_MESSAGE = t('en', 'main.task.needsOcr')
export const TASK_OCR_NOT_A_SCAN_MESSAGE = t('en', 'main.task.ocrNotAScan')
export const TASK_OCR_NO_TEXT_MESSAGE = t('en', 'main.task.ocrNoText')
export const TASK_OCR_FAILED_MESSAGE = t('en', 'main.task.ocrFailed')

// ---- Summary window math (budget-driven two-level map-reduce) ------------------------
//
// Budgets reuse the chunker's word≈token estimate (`approxTokenCount` = whitespace
// words). That estimate UNDERCOUNTS real model tokens (umlauts, punctuation, subword
// splits), so the input budget is derived in words via an explicit words→tokens safety
// factor: usable context tokens ÷ SUMMARY_TOKENS_PER_WORD. A window that fits the word
// budget then cannot overflow the model's real `contextTokens` window.

/** maxTokens for the single-pass and reduce calls (also the output reserve). */
export const SUMMARY_OUTPUT_TOKENS = 512
/** Reserved for the instruction template + chat chrome, in model tokens. */
export const SUMMARY_PROMPT_RESERVE_TOKENS = 300
/** Real-tokens-per-whitespace-word safety factor (German office text measures ~1.2–1.3). */
export const SUMMARY_TOKENS_PER_WORD = 1.3
/**
 * Hard ceiling on map calls: ~12 windows ≈ a ~50-page document at the default
 * context. Beyond it the summary honestly covers the beginning (`truncated` flag).
 */
export const SUMMARY_MAP_CALL_CEILING = 12
/** Low temperature: summaries should be faithful, not creative. */
export const SUMMARY_TEMPERATURE = 0.3
/** Floor for a map call's output cap — below this, partials stop being useful. */
const SUMMARY_MAP_OUTPUT_FLOOR_TOKENS = 128

/** Usable model tokens for input text after the prompt + output reserves. */
function usableInputTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - SUMMARY_OUTPUT_TOKENS - SUMMARY_PROMPT_RESERVE_TOKENS
}

/** The per-call input budget in WORDS (the chunker's token estimate unit). */
export function summaryBudgetWords(contextTokens: number): number {
  return Math.max(200, Math.floor(usableInputTokens(contextTokens) / SUMMARY_TOKENS_PER_WORD))
}

export interface SummaryPlan {
  /** Window texts, in document order. One window = single pass; more = map-reduce. */
  windows: string[]
  singlePass: boolean
  /** True when the map-call ceiling cut content: the summary covers the beginning. */
  truncated: boolean
  /** Output cap per map call, sized so ALL partials fit the reduce call's input budget. */
  mapMaxTokens: number
  /** Model calls planned: map windows (+ 1 reduce when not single-pass). */
  stepsTotal: number
}

/**
 * Pack texts greedily, in order, into windows of at most `budgetWords` words. A single
 * over-budget text is SPLIT into budget-sized pieces rather than truncated — no text is
 * silently dropped by packing. Shared by the summary (chunks in) and translation
 * (segments in) planners.
 */
function packIntoWindows(texts: string[], budgetWords: number): string[] {
  // Split any over-budget text into budget-sized pieces (document order kept).
  const pieces: Array<{ text: string; words: number }> = []
  for (const text of texts) {
    const words = tokenize(text)
    if (words.length === 0) continue
    if (words.length <= budgetWords) {
      pieces.push({ text, words: words.length })
    } else {
      for (let at = 0; at < words.length; at += budgetWords) {
        const slice = words.slice(at, at + budgetWords)
        pieces.push({ text: slice.join(' '), words: slice.length })
      }
    }
  }

  const windows: string[] = []
  let current: string[] = []
  let currentWords = 0
  const flush = (): void => {
    if (current.length > 0) {
      windows.push(current.join('\n\n'))
      current = []
      currentWords = 0
    }
  }
  for (const piece of pieces) {
    if (currentWords + piece.words > budgetWords) flush()
    current.push(piece.text)
    currentWords += piece.words
  }
  flush()
  return windows
}

/**
 * Plan the summary windows for a document's chunk texts (pure — unit-tested at the
 * boundaries). Chunks are packed greedily, in order, into windows of at most
 * `summaryBudgetWords` words (an over-budget chunk is split, never truncated). More
 * windows than the ceiling → keep the first SUMMARY_MAP_CALL_CEILING and mark the
 * plan truncated.
 */
export function planSummaryWindows(chunkTexts: string[], contextTokens: number): SummaryPlan {
  const budgetWords = summaryBudgetWords(contextTokens)
  const windows = packIntoWindows(chunkTexts, budgetWords)

  let truncated = false
  let kept = windows
  if (windows.length > SUMMARY_MAP_CALL_CEILING) {
    kept = windows.slice(0, SUMMARY_MAP_CALL_CEILING)
    truncated = true
  }

  const singlePass = kept.length <= 1
  // Cap each partial so the reduce input (all partials together) provably fits the
  // input budget: windows × mapMaxTokens ≤ usable input tokens. The floor keeps tiny
  // contexts from degenerating; the reduce step additionally hard-truncates its input.
  const mapMaxTokens = singlePass
    ? SUMMARY_OUTPUT_TOKENS
    : Math.max(
        SUMMARY_MAP_OUTPUT_FLOOR_TOKENS,
        Math.min(SUMMARY_OUTPUT_TOKENS, Math.floor(usableInputTokens(contextTokens) / kept.length))
      )

  return {
    windows: kept,
    singlePass,
    truncated,
    mapMaxTokens,
    stepsTotal: singlePass ? 1 : kept.length + 1
  }
}

// ---- Prompts ------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT =
  'You are a careful assistant summarizing a document for its owner, fully offline. ' +
  'Use only the provided text. Never invent facts, names, or numbers. ' +
  'Write the summary in the same language as the document.'

function singlePassPrompt(title: string, text: string): string {
  return (
    `Summarize the document "${title}". Start with a short overview paragraph, then list ` +
    'the key points as bullets. Keep important names, numbers, and dates exact.\n\n' +
    `Document text:\n${text}`
  )
}

function mapPrompt(title: string, part: number, total: number, text: string): string {
  return (
    `Summarize part ${part} of ${total} of the document "${title}" in one concise paragraph. ` +
    'Keep important names, numbers, and dates exact.\n\n' +
    `Part text:\n${text}`
  )
}

function reducePrompt(title: string, partials: string[]): string {
  return (
    `Below are partial summaries of consecutive parts of the document "${title}". Combine ` +
    'them into one coherent summary: a short overview paragraph, then the key points as ' +
    'bullets. Keep important names, numbers, and dates exact. Do not mention the parts.\n\n' +
    partials.map((p, i) => `Part ${i + 1} summary:\n${p}`).join('\n\n')
  )
}

// ---- Translation window math + templates ----------------------------------------------
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

// ---- Compare window math + templates ---------------------------------------------------
//
// The result is a MATERIALIZED corpus document ("Comparison: A vs B.md") and the
// strategy auto-switches on token math:
//   (a) small-docs full compare — both documents' full texts fit one call ⇒ one
//       structured-comparison call over both, then materialize.
//   (b) section-matched compare — for each window of doc A's chunks, the nearest doc-B
//       chunks are retrieved via the EXISTING VectorIndex scoped to doc B (the
//       `documentIds` scoping; the vectors are already there — no new index), each
//       matched pair is compared (map), and one reduce merges the notes into the report.
//
// Mode-(a) input: like the translation, mode (a) reads the parser's SEGMENTS
// re-extracted from the stored copies — NOT the stored chunks. Two reasons:
// chunk overlap (~80 tokens) would present duplicated text to the model as if both
// documents repeated themselves (phantom "shared" content in a comparison, where a
// summary merely tolerated repetition), and the MODE DECISION itself must be made on
// the true text length — the overlap inflates a chunk-based estimate by ~16%, enough
// to push a fitting pair into the heavier mode (b). Cost: one re-parse per document,
// the same the preview pays. Mode (b)'s map step uses the stored CHUNKS instead — the
// pairing needs their vectors, and per-pair notes tolerate overlap like summary
// partials do.
//
// Mode (b) honesty note: the pairing is A-driven (B excerpts are retrieved by
// similarity to A's sections), so "only in B" findings are structurally weaker than
// "only in A" — the reduce is instructed to report only what the notes support, and
// the per-pair prompt lets the model flag B-excerpt content without an A counterpart.
// Recorded in known-limitations.md.

/** maxTokens for the single-pass and reduce calls (also the output reserve). */
export const COMPARE_OUTPUT_TOKENS = 512
/** Reserved for the instruction template + chat chrome, in model tokens. */
export const COMPARE_PROMPT_RESERVE_TOKENS = 300
/** Comparison is faithful synthesis, not creative writing (same as summary). */
export const COMPARE_TEMPERATURE = 0.3
/** Hard ceiling on map calls (like the summary ceiling: bounded CPU latency). */
export const COMPARE_MAP_CALL_CEILING = 12
/** Floor for a map call's output cap — below this, per-pair notes stop being useful. */
const COMPARE_MAP_OUTPUT_FLOOR_TOKENS = 128
/** Nearest doc-B chunks retrieved per doc-A chunk before the word-budget fill. */
export const COMPARE_NEIGHBORS_PER_CHUNK = 3

/** Usable model tokens for input text after the prompt + output reserves. */
function compareUsableInputTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - COMPARE_OUTPUT_TOKENS - COMPARE_PROMPT_RESERVE_TOKENS
}

/** Total per-call input budget in WORDS (both documents/sides together). */
export function compareBudgetWords(contextTokens: number): number {
  return Math.max(200, Math.floor(compareUsableInputTokens(contextTokens) / SUMMARY_TOKENS_PER_WORD))
}

/** Mode switch: do both documents' full texts fit one comparison call? */
export function compareFitsSinglePass(wordsA: number, wordsB: number, contextTokens: number): boolean {
  return wordsA + wordsB <= compareBudgetWords(contextTokens)
}

/** A doc-A chunk reference the mode-(b) planner windows (id kept for vector lookup). */
export interface CompareChunkRef {
  id: string
  text: string
}

/** One mode-(b) map window: consecutive doc-A chunks + the ids to retrieve B-neighbors for. */
export interface CompareWindow {
  chunkIds: string[]
  text: string
}

export interface ComparePlan {
  windows: CompareWindow[]
  /** True when the map-call ceiling cut doc-A coverage: the report covers its beginning. */
  truncated: boolean
  /** Output cap per map call, sized so ALL notes fit the reduce call's input budget. */
  mapMaxTokens: number
  /** Word budget for the retrieved doc-B excerpts of one map call (the B side's share). */
  pairBudgetWords: number
  /** Model calls (map windows + 1 reduce) + the materialize step. */
  stepsTotal: number
}

/**
 * Plan the mode-(b) map windows over doc A's chunks (pure — unit-tested at the
 * boundaries). The per-call input budget is split half/half between the doc-A window
 * and the retrieved doc-B excerpts; chunks pack greedily in document order into
 * A-windows of at most half the budget (an over-budget chunk is split, its pieces
 * keeping the chunk id — neighbors are per-chunk). More windows than the ceiling →
 * keep the first COMPARE_MAP_CALL_CEILING and mark the plan truncated.
 */
export function planCompareWindows(chunks: CompareChunkRef[], contextTokens: number): ComparePlan {
  const budget = compareBudgetWords(contextTokens)
  const aShare = Math.max(100, Math.floor(budget / 2))
  const pairBudgetWords = Math.max(100, budget - aShare)

  // Split over-budget chunks into aShare-sized pieces (id kept), then pack greedily.
  const pieces: Array<{ id: string; text: string; words: number }> = []
  for (const chunk of chunks) {
    const words = tokenize(chunk.text)
    if (words.length === 0) continue
    if (words.length <= aShare) {
      pieces.push({ id: chunk.id, text: chunk.text, words: words.length })
    } else {
      for (let at = 0; at < words.length; at += aShare) {
        const slice = words.slice(at, at + aShare)
        pieces.push({ id: chunk.id, text: slice.join(' '), words: slice.length })
      }
    }
  }
  const windows: CompareWindow[] = []
  let ids: string[] = []
  let texts: string[] = []
  let words = 0
  const flush = (): void => {
    if (texts.length > 0) {
      windows.push({ chunkIds: ids, text: texts.join('\n\n') })
      ids = []
      texts = []
      words = 0
    }
  }
  for (const piece of pieces) {
    if (words + piece.words > aShare) flush()
    if (!ids.includes(piece.id)) ids.push(piece.id)
    texts.push(piece.text)
    words += piece.words
  }
  flush()

  let truncated = false
  let kept = windows
  if (windows.length > COMPARE_MAP_CALL_CEILING) {
    kept = windows.slice(0, COMPARE_MAP_CALL_CEILING)
    truncated = true
  }

  // Cap each map call's notes so all of them together provably fit the reduce input
  // (windows × mapMaxTokens ≤ usable input tokens).
  const mapMaxTokens = Math.max(
    COMPARE_MAP_OUTPUT_FLOOR_TOKENS,
    Math.min(
      COMPARE_OUTPUT_TOKENS,
      Math.floor(compareUsableInputTokens(contextTokens) / Math.max(1, kept.length))
    )
  )

  return {
    windows: kept,
    truncated,
    mapMaxTokens,
    pairBudgetWords,
    stepsTotal: kept.length + 2
  }
}

const COMPARE_SYSTEM_PROMPT_TEXT =
  'You are a careful assistant comparing two documents for their owner, fully offline. ' +
  'Use only the provided text. Never invent facts, names, or numbers. ' +
  'Write the comparison in the same language as the documents.'

/** Shared system prompt for every compare call (exported for the manual smoke harness). */
export function compareSystemPrompt(): string {
  return COMPARE_SYSTEM_PROMPT_TEXT
}

/**
 * The fixed report skeleton (common / differs / only-in-A / only-in-B). The
 * headings are dictated verbatim so the materialized report has a deterministic
 * structure; the bullet content follows the documents' language.
 */
export function compareReportHeadings(titleA: string, titleB: string): string[] {
  return [
    '## What both documents share',
    '## What differs between them',
    `## Only in "${titleA}"`,
    `## Only in "${titleB}"`
  ]
}

/** Mode (a): one structured-comparison call over both full texts. */
export function compareFullPrompt(
  titleA: string,
  textA: string,
  titleB: string,
  textB: string
): string {
  return (
    `Compare document A ("${titleA}") with document B ("${titleB}"). ` +
    'Write a structured comparison report in Markdown with exactly these four sections:\n' +
    compareReportHeadings(titleA, titleB).join('\n') +
    '\n\nUnder each heading write short bullet points. Keep important names, numbers, and ' +
    'dates exact. List each finding under exactly ONE section: something present in only ' +
    'one document belongs under its "Only in" section, not under the differences. ' +
    'If a section has nothing to report, write "Nothing notable." under it. ' +
    'Reply with ONLY the report — no introduction, no notes.\n\n' +
    `Document A ("${titleA}"):\n${textA}\n\n` +
    `Document B ("${titleB}"):\n${textB}`
  )
}

/**
 * Mode (b) map: one doc-A window against its retrieved doc-B excerpts. A deliberately
 * SMALLER per-pair format than the report: compact prefixed bullets the reduce can
 * merge mechanically.
 */
export function comparePairPrompt(
  titleA: string,
  titleB: string,
  part: number,
  total: number,
  windowText: string,
  excerptsB: string
): string {
  return (
    `You are comparing document A ("${titleA}") with document B ("${titleB}") section by ` +
    `section. This is section ${part} of ${total} of document A, shown together with the ` +
    'most closely related excerpts of document B. List your findings as short bullets, ' +
    'each prefixed exactly like this:\n' +
    '- Same: a fact stated by both\n' +
    '- Different: a fact where the two versions disagree (give both versions)\n' +
    '- Only in A: something in this section of A with no counterpart in the excerpts of B\n' +
    '- Only in B: something in the excerpts of B with no counterpart in this section of A\n' +
    'Check every fact in the section of A: if the excerpts of B do not mention it, list it ' +
    'under "Only in A". Keep names, numbers, and dates exact. Do not mention excerpts or ' +
    'sections. Reply with ONLY the bullets.\n\n' +
    `Section of document A:\n${windowText}\n\n` +
    `Related excerpts of document B:\n${excerptsB}`
  )
}

/** Mode (b) reduce: merge the per-window notes into the four-section report. */
export function compareReducePrompt(titleA: string, titleB: string, partials: string[]): string {
  return (
    `Below are comparison notes from consecutive sections of document A ("${titleA}"), each ` +
    `compared against the most closely related parts of document B ("${titleB}"). Combine ` +
    'them into one comparison report in Markdown with exactly these four sections:\n' +
    compareReportHeadings(titleA, titleB).join('\n') +
    '\n\nMerge duplicate points into one bullet, keep names, numbers, and dates exact, and ' +
    'only report what the notes support — never add facts of your own. List each finding ' +
    'under exactly ONE section: a point the notes mark as "Only in" one document belongs ' +
    'under that document\'s section, not under the differences. If a section has nothing ' +
    'to report, write "Nothing notable." under it. Do not mention the notes or sections. ' +
    'Reply with ONLY the report.\n\n' +
    partials.map((p, i) => `Notes ${i + 1}:\n${p}`).join('\n\n')
  )
}

/** The honesty attribution prepended to every materialized comparison. */
export function compareAttributionLine(modelId: string): string {
  return `Machine-generated comparison by ${modelId} — may contain errors.`
}

/** Honest in-document notice when the map ceiling cut doc-A coverage (mode b). */
export function compareTruncationNotice(titleA: string): string {
  return (
    `> ⚠ These documents are long — this comparison covers the beginning of "${titleA}". ` +
    'Both documents stay fully searchable and answerable in chat.'
  )
}

/** `"report.pdf" + "draft.docx"` → `"Comparison: report vs draft.md"`. */
export function compareDocumentTitle(titleA: string, titleB: string): string {
  const base = (t: string): string => {
    const ext = extname(t)
    return (ext ? t.slice(0, -ext.length) : t).trim() || 'document'
  }
  return `Comparison: ${base(titleA)} vs ${base(titleB)}.md`
}

// ---- The task manager ----------------------------------------------------------------

/** Injected seams so the engine is testable without Electron and the IPC layer. */
export interface DocTaskDeps {
  /** The live workspace DB (the `ctx.db` getter — throws while locked). */
  getDb: () => Db
  /** The active chat runtime, or null when none is running. */
  getRuntime: () => ModelRuntime | null
  /** True while any chat/RAG answer is streaming (the in-flight registry). */
  isChatStreaming: () => boolean
  /** The user's `contextTokens` setting (drives the window budget). */
  getContextTokens: () => number
  /** `workspace/documents/` — where materialized documents (and their transients) live. */
  getStoreDir: () => string
  /** Ingestion deps (embedder + document cipher) for the materialize/import step. */
  getIngestionDeps: () => IngestionDeps
  /**
   * The vault lease (`WorkspaceController.beginDocumentWork`). Held ONLY around the
   * materialize step (it writes `.enc` sidecars); throws the friendly
   * `VaultBusyError` while a password change runs.
   */
  beginDocumentWork: () => () => void
  /**
   * The local OCR engine, or null when the drive carries no language files. The
   * 'ocr' kind refuses to start without it (friendly copy) — every other kind
   * ignores it. Read per task (the assets can appear mid-session).
   */
  getOcrEngine?: () => OcrEngine | null
  /**
   * PDF → page-PNG rasterizer: the hidden-window renderer in the app, a fake in
   * tests. Only the 'ocr' kind uses it.
   */
  rasterizePdf?: RasterizePdf
  audit?: AuditRecorder
}

interface InternalTask {
  status: DocTaskStatus
  controller: AbortController
  /** Validated translation target (kind === 'translation' only). */
  targetLang?: TranslationTargetLang
}

const TERMINAL: ReadonlySet<DocTaskStatus['state']> = new Set(['done', 'failed', 'cancelled'])

export class DocTaskManager {
  private readonly tasks = new Map<string, InternalTask>()
  private queue: string[] = []
  private runningId: string | null = null

  constructor(private readonly deps: DocTaskDeps) {}

  /**
   * Validate + enqueue a task. Throws friendly errors for the guards (chat
   * streaming, no runtime) and for invalid requests; a queued/running task is reported
   * via `getDocTask` polling from then on.
   */
  startDocTask(req: StartDocTaskRequest): { jobId: string } {
    const kind = req?.kind as DocTaskKind
    if (kind !== 'summary' && kind !== 'translation' && kind !== 'compare' && kind !== 'ocr') {
      throw new Error(tMain('main.task.unknownKind'))
    }
    // Translation targets are a closed set: de | en only — a free-text language
    // field invites silent quality failures.
    let targetLang: TranslationTargetLang | undefined
    if (kind === 'translation') {
      const raw = req.params?.targetLang
      if (raw !== 'de' && raw !== 'en') {
        throw new Error(tMain('main.task.translationTarget'))
      }
      targetLang = raw
    }
    if (this.deps.isChatStreaming()) {
      throw new Error(tMain('main.task.refusedChatStreaming'))
    }
    // OCR runs the local recognition engine, not the chat model — it needs the
    // vendored language files instead of a running runtime.
    if (kind === 'ocr') {
      if (!this.deps.getOcrEngine?.()) {
        throw new Error(tMain('main.task.needsOcr'))
      }
    } else if (!this.deps.getRuntime()) {
      throw new Error(tMain('main.noModelRunning'))
    }
    // Compare runs over exactly TWO (distinct) documents; summary/translation/ocr over one.
    const documentIds = (req.documentIds ?? []).filter((x) => typeof x === 'string' && x.length > 0)
    const wanted = kind === 'compare' ? 2 : 1
    if (documentIds.length !== wanted || new Set(documentIds).size !== wanted) {
      throw new Error(
        kind === 'compare'
          ? tMain('main.task.comparePickTwo')
          : kind === 'translation'
            ? tMain('main.task.pickOneTranslate')
            : kind === 'ocr'
              ? tMain('main.task.pickOneOcr')
              : tMain('main.task.pickOneSummarize')
      )
    }
    if (kind === 'ocr') {
      // The target is a scan-DETECTED PDF (step 0 marked it), or an already-OCR'd PDF
      // being re-run (better assets / a bad first pass). Never an ordinary document.
      const doc = getDocument(this.deps.getDb(), documentIds[0])
      if (!doc || !isPdfPath(doc.title) || !(doc.scanDetected || doc.ocr)) {
        throw new Error(tMain('main.task.ocrNotAScan'))
      }
    } else {
      for (const id of documentIds) {
        const doc = getDocument(this.deps.getDb(), id)
        if (!doc || doc.status !== 'indexed' || doc.chunkCount === 0) {
          throw new Error(tMain('main.task.documentNotReady'))
        }
      }
    }

    const jobId = randomUUID()
    const task: InternalTask = {
      status: {
        jobId,
        kind,
        documentIds,
        state: 'queued',
        progress: { stepsDone: 0, stepsTotal: 0 },
        error: null,
        resultRef: null
      },
      controller: new AbortController(),
      targetLang
    }
    this.tasks.set(jobId, task)
    this.queue.push(jobId)
    log.info('Document task queued', { jobId, kind, documentId: documentIds[0] })
    this.pump()
    return { jobId }
  }

  /** Poll one task. Unknown/expired ids report a terminal state so pollers stop. */
  getDocTask(jobId: string): DocTaskStatus {
    const task = this.tasks.get(jobId)
    if (task) {
      // Return a copy — the renderer must not share mutable state with the engine.
      return { ...task.status, progress: { ...task.status.progress } }
    }
    return {
      jobId,
      kind: 'summary',
      documentIds: [],
      state: 'failed',
      progress: { stepsDone: 0, stepsTotal: 0 },
      error: tMain('main.task.expired'),
      resultRef: null
    }
  }

  /**
   * Cancel a task: a running one is aborted mid-stream, a queued one is dequeued.
   * With no jobId, cancels the currently active (running, else next queued) task —
   * the chat screen's "cancel the busy task" affordance.
   */
  cancelDocTask(jobId?: string | null): void {
    const id = jobId ?? this.runningId ?? this.queue[0] ?? null
    if (!id) return
    const task = this.tasks.get(id)
    if (!task || TERMINAL.has(task.status.state)) return
    log.info('Document task cancel requested', { jobId: id })
    if (task.status.state === 'queued') {
      this.queue = this.queue.filter((q) => q !== id)
      task.status.state = 'cancelled'
      return
    }
    task.controller.abort()
  }

  /** True while a task is running or queued — the chat-side busy guard reads this. */
  hasActiveTask(): boolean {
    return this.runningId !== null || this.queue.length > 0
  }

  /** True when an active (running/queued) task targets `documentId` — guards re-index/delete. */
  isDocumentBusy(documentId: string): boolean {
    const ids = [...(this.runningId ? [this.runningId] : []), ...this.queue]
    return ids.some((id) => this.tasks.get(id)?.status.documentIds.includes(documentId) ?? false)
  }

  /** Run the next queued task; tasks serialize among themselves. */
  private pump(): void {
    if (this.runningId) return
    const next = this.queue.shift()
    if (!next) return
    const task = this.tasks.get(next)
    if (!task || task.status.state !== 'queued') {
      this.pump()
      return
    }
    this.runningId = next
    void this.run(task).finally(() => {
      this.runningId = null
      this.pump()
    })
  }

  private async run(task: InternalTask): Promise<void> {
    const { kind } = task.status
    // The SOURCE document id(s) — the audit events carry these; a generated OUTPUT id
    // travels in `resultRef` (and is appended to `documentIds` for the busy guard, so
    // capture the sources BEFORE the task runs). A compare's second source rides as
    // the additive ids-only `documentIdB`.
    const documentId = task.status.documentIds[0]
    const auditMeta: Record<string, unknown> = { kind, documentId }
    if (kind === 'compare' && task.status.documentIds[1]) {
      auditMeta.documentIdB = task.status.documentIds[1]
    }
    task.status.state = 'running'
    try {
      let resultId: string
      if (kind === 'ocr') {
        // OCR uses the recognition engine, not the chat runtime.
        resultId = await this.runOcr(task)
      } else {
        // Re-check at dequeue time: the runtime may have been stopped while queued.
        const runtime = this.deps.getRuntime()
        if (!runtime) throw new Error(tMain('main.noModelRunning'))
        resultId =
          kind === 'compare'
            ? await this.runCompare(task, runtime)
            : kind === 'translation'
              ? await this.runTranslation(task, runtime)
              : await this.runSummary(task, runtime)
      }
      task.status.state = 'done'
      task.status.resultRef = { documentId: resultId }
      this.deps.audit?.('document_task_completed', `Document task completed: ${kind}`, auditMeta)
      log.info('Document task completed', { jobId: task.status.jobId, kind, documentId })
    } catch (err) {
      if (isAbortError(err, task.controller.signal)) {
        task.status.state = 'cancelled'
        log.info('Document task cancelled', { jobId: task.status.jobId, kind, documentId })
        return
      }
      const raw = err instanceof Error ? err.message : String(err)
      // Friendly failures (§11.4): our own guard copy passes through (as does the
      // vault lease's VaultBusyError — its message is written for users); anything
      // else (runtime/HTTP/SQL errors) is replaced by the generic copy. The raw reason
      // goes to the local log only — never to the renderer, never to the audit log.
      const friendly =
        isFriendlyTaskError(raw) || (err instanceof Error && err.name === 'VaultBusyError')
      task.status.state = 'failed'
      task.status.error = friendly ? raw : tMain('main.task.genericFailure')
      this.deps.audit?.('document_task_failed', `Document task failed: ${kind}`, auditMeta)
      log.error('Document task failed', { jobId: task.status.jobId, kind, documentId, error: raw })
    }
  }

  /** The summary task: stored chunks in, `summary_json` out. */
  private async runSummary(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(tMain('main.task.documentNotReady'))

    // Input = the document's stored CHUNKS, in order (no re-parse). Adjacent chunks
    // overlap by ~80 tokens (the chunker's retrieval overlap); the slight repetition
    // is harmless for summarization.
    const rows = db
      .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as unknown as Array<{ text: string }>
    const texts = rows.map((r) => r.text).filter((t) => t.trim().length > 0)
    if (texts.length === 0) throw new Error(tMain('main.task.documentNotReady'))

    const contextTokens = this.deps.getContextTokens()
    const plan = planSummaryWindows(texts, contextTokens)
    task.status.progress.stepsTotal = plan.stepsTotal
    const signal = task.controller.signal

    let summaryText: string
    if (plan.singlePass) {
      summaryText = await this.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        singlePassPrompt(doc.title, plan.windows[0] ?? ''),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      task.status.progress.stepsDone = 1
    } else {
      const partials: string[] = []
      for (let i = 0; i < plan.windows.length; i++) {
        const partial = await this.generate(
          runtime,
          SUMMARY_SYSTEM_PROMPT,
          mapPrompt(doc.title, i + 1, plan.windows.length, plan.windows[i]),
          plan.mapMaxTokens,
          SUMMARY_TEMPERATURE,
          signal
        )
        if (partial.length > 0) partials.push(partial)
        task.status.progress.stepsDone += 1
      }
      if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))
      // Belt for the reduce input: the map output caps already size partials to fit,
      // but a model that ignores maxTokens semantics must still not overflow.
      const budgetWords = summaryBudgetWords(contextTokens)
      let reduceInput = partials
      const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
      if (totalWords > budgetWords) {
        const allWords = tokenize(partials.join('\n\n'))
        reduceInput = [allWords.slice(0, budgetWords).join(' ')]
      }
      summaryText = await this.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        reducePrompt(doc.title, reduceInput),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      task.status.progress.stepsDone += 1
    }

    if (summaryText.length === 0) throw new Error(tMain('main.task.genericFailure'))
    const summary: DocumentSummary = {
      text: summaryText,
      modelId: runtime.modelId,
      createdAt: new Date().toISOString(),
      truncated: plan.truncated
    }
    // Re-read via a fresh getter: the document may have been deleted while we worked
    // (the IPC layer refuses re-index/delete on a busy document, but be safe anyway —
    // the UPDATE on a vanished row is a no-op).
    setDocumentSummary(this.deps.getDb(), documentId, summary)
    return documentId
  }

  /**
   * The OCR task ("Make searchable (OCR)", never automatic): rasterize the stored
   * PDF page by page in the hidden window, recognize each page PNG main-side with
   * the local engine, persist the recognition (`documents.ocr_json`, content → DB
   * only), then re-ingest — the PdfParser's ocrPages hook turns the recognition into
   * one segment per page, so page citations work unchanged.
   * Progress = pages recognized + the final re-ingest step; cancel persists NOTHING.
   */
  private async runOcr(task: InternalTask): Promise<string> {
    const engine = this.deps.getOcrEngine?.()
    const rasterize = this.deps.rasterizePdf
    if (!engine || !rasterize) throw new Error(tMain('main.task.needsOcr'))
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(tMain('main.task.ocrNotAScan'))
    const signal = task.controller.signal

    const pdf = this.readStoredPdfBytes(documentId)
    const pages: OcrPage[] = []
    try {
      await rasterize(pdf, {
        signal,
        onPageCount: (n) => {
          // pages + persist/re-ingest as the final step.
          task.status.progress.stepsTotal = n + 1
        },
        onPage: async (pageNumber, png) => {
          // Backpressure: the next page is not rendered until this recognition ends.
          const result = await engine.recognize(png, { signal })
          pages.push({ pageNumber, text: result.text.trim() })
          task.status.progress.stepsDone += 1
          if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
        }
      })
    } catch (err) {
      if (isAbortError(err, signal)) throw err
      // §11.4: raw render/recognition errors go to the local log only.
      log.warn('OCR task failed while reading the scan', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(tMain('main.task.ocrFailed'))
    }
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    if (!pages.some((p) => p.text.length > 0)) {
      throw new Error(tMain('main.task.ocrNoText'))
    }

    // Persist the recognition, then re-ingest through the normal pipeline (chunks,
    // embeddings, FTS — the document becomes a first-class searchable corpus member).
    // The re-ingest may rewrite a legacy plaintext stored copy to `.enc`, so it holds
    // the vault lease like every sidecar writer (VaultBusyError → friendly fail).
    setDocumentOcr(db, documentId, {
      pages,
      engineId: engine.id,
      languages: [...engine.languages]
    })
    const release = this.deps.beginDocumentWork()
    try {
      const result = await reindexDocument(
        db,
        this.deps.getStoreDir(),
        documentId,
        this.deps.getIngestionDeps()
      )
      if (result.status !== 'indexed') {
        // The recognition stays persisted (it is real work); the document row keeps
        // the re-ingest failure message — Re-index retries with the stored pages.
        log.error('OCR re-ingest did not reach indexed', {
          documentId,
          status: result.status,
          error: result.errorMessage
        })
        throw new Error(tMain('main.task.ocrFailed'))
      }
    } finally {
      release()
    }
    task.status.progress.stepsDone += 1
    return documentId
  }

  /**
   * Read the stored PDF's plaintext bytes for rasterization. Encrypted copies decrypt
   * to a `.parse-ocr.pdf` transient (covered by the startup crash sweep) that is
   * shredded before returning — only the in-memory Buffer leaves this method.
   */
  private readStoredPdfBytes(documentId: string): Buffer {
    const db = this.deps.getDb()
    const row = db
      .prepare('SELECT title, stored_path, original_path FROM documents WHERE id = ?')
      .get(documentId) as unknown as
      | { title: string; stored_path: string | null; original_path: string | null }
      | undefined
    if (!row) throw new Error(tMain('main.task.sourceUnreadable'))
    const cipher = this.deps.getIngestionDeps().cipher ?? null
    try {
      if (row.stored_path && existsSync(row.stored_path)) {
        if (row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
          if (!cipher) throw new Error(tMain('main.task.sourceUnreadable'))
          const transient = join(this.deps.getStoreDir(), `${documentId}.parse-ocr.pdf`)
          try {
            cipher.decryptFile(row.stored_path, transient)
            return readFileSync(transient)
          } finally {
            shredFile(transient)
          }
        }
        return readFileSync(row.stored_path)
      }
      if (row.original_path && existsSync(row.original_path)) {
        return readFileSync(row.original_path)
      }
    } catch (err) {
      log.warn('OCR source read failed', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(tMain('main.task.sourceUnreadable'))
    }
    throw new Error(tMain('main.task.sourceUnreadable'))
  }

  /**
   * The translation task: re-extracted parser SEGMENTS in, window-by-window
   * translation in document order (no reduce), one NEW materialized Markdown
   * document out. Returns the new document's id (the `resultRef`).
   */
  private async runTranslation(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const targetLang = task.targetLang
    if (!targetLang) throw new Error(tMain('main.task.translationTarget'))
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(tMain('main.task.documentNotReady'))

    // The input is the parser's SEGMENTS re-extracted from the stored copy —
    // ordered and non-overlapping (see the window-math note above; stored chunks
    // would duplicate their ~80-token overlap into the translation).
    const segmentTexts = await this.extractSegmentTexts(documentId)

    const plan = planTranslationWindows(segmentTexts, this.deps.getContextTokens())
    task.status.progress.stepsTotal = plan.stepsTotal
    const signal = task.controller.signal

    // Map in document order — no reduce. A window the model refuses/garbles is
    // retried ONCE, then MARKED visibly with the original text kept; it is never
    // silently dropped. Only a fully-failed translation fails the task.
    const parts: string[] = []
    let failedWindows = 0
    for (let i = 0; i < plan.windows.length; i++) {
      const translated = await this.generateWithRetry(
        runtime,
        translationSystemPrompt(targetLang),
        translationWindowPrompt(targetLang, i + 1, plan.windows.length, plan.windows[i]),
        plan.windowMaxTokens,
        TRANSLATION_TEMPERATURE,
        signal
      )
      if (translated !== null) {
        parts.push(translated)
      } else {
        failedWindows += 1
        parts.push(`${failedWindowNotice(i + 1, plan.windows.length)}\n\n${plan.windows[i]}`)
      }
      task.status.progress.stepsDone += 1
    }
    if (failedWindows === plan.windows.length) throw new Error(tMain('main.task.genericFailure'))

    // Materialize ONLY now that every window succeeded (or is honestly marked) — a
    // cancelled task persists nothing, so the last cancellation point is here.
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    const markdown = `> ${translationAttributionLine(runtime.modelId)}\n\n${parts.join('\n\n')}\n`
    const newDocId = await this.materializeDocument(
      task,
      markdown,
      translatedDocumentTitle(doc.title, targetLang),
      { type: 'translation', translatedFrom: documentId, targetLang }
    )
    task.status.progress.stepsDone += 1
    return newDocId
  }

  /**
   * Re-extract a document's ordered, non-overlapping segment texts from its stored
   * copy (never the ~80-token-overlapping chunks). Encrypted copies decrypt to a
   * `.parse*` transient inside and are shredded on the way out.
   */
  private async extractSegmentTexts(documentId: string): Promise<string[]> {
    let texts: string[]
    try {
      const preview = await extractDocumentPreview(
        this.deps.getDb(),
        this.deps.getStoreDir(),
        documentId,
        { cipher: this.deps.getIngestionDeps().cipher ?? null }
      )
      texts = preview.segments.map((s) => s.text).filter((t) => t.trim().length > 0)
    } catch (err) {
      log.warn('Document task source re-extraction failed', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(tMain('main.task.sourceUnreadable'))
    }
    if (texts.length === 0) throw new Error(tMain('main.task.documentNotReady'))
    return texts
  }

  /**
   * The compare task: two documents in, one materialized "Comparison: A vs B.md"
   * report out. The strategy auto-switches on token math — mode (a) when both
   * re-extracted full texts fit one call, else mode (b) section-matched over the
   * stored chunks + vectors. Returns the new document's id.
   */
  private async runCompare(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const [idA, idB] = task.status.documentIds
    const docA = getDocument(db, idA)
    const docB = getDocument(db, idB)
    if (!docA || !docB) throw new Error(tMain('main.task.documentNotReady'))

    // The mode decision AND mode (a)'s input both use the re-extracted parser
    // segments — exact and non-overlapping. Deciding on stored chunks would inflate
    // the length by the ~80-token overlap (and mode (a) would show the model
    // duplicated text as phantom "shared" content).
    const textA = (await this.extractSegmentTexts(idA)).join('\n\n')
    const textB = (await this.extractSegmentTexts(idB)).join('\n\n')
    const contextTokens = this.deps.getContextTokens()
    const signal = task.controller.signal

    let report: string
    let truncated = false
    if (compareFitsSinglePass(approxTokenCount(textA), approxTokenCount(textB), contextTokens)) {
      // Mode (a): one structured-comparison call over both full texts.
      task.status.progress.stepsTotal = 2
      report = await this.generate(
        runtime,
        compareSystemPrompt(),
        compareFullPrompt(docA.title, textA, docB.title, textB),
        COMPARE_OUTPUT_TOKENS,
        COMPARE_TEMPERATURE,
        signal
      )
      if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
      task.status.progress.stepsDone = 1
    } else {
      const sectionMatched = await this.runCompareSectionMatched(task, runtime, docA, docB)
      report = sectionMatched.report
      truncated = sectionMatched.truncated
    }

    // Materialize: attribution + (honest) truncation notice + report.
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    const markdown =
      `> ${compareAttributionLine(runtime.modelId)}\n\n` +
      (truncated ? `${compareTruncationNotice(docA.title)}\n\n` : '') +
      `${report}\n`
    const newDocId = await this.materializeDocument(
      task,
      markdown,
      compareDocumentTitle(docA.title, docB.title),
      { type: 'compare', comparedFrom: [idA, idB] }
    )
    task.status.progress.stepsDone += 1
    return newDocId
  }

  /**
   * Mode (b) — section-matched compare: window doc A's stored chunks, retrieve each
   * window's nearest doc-B chunks via the EXISTING VectorIndex scoped to doc B
   * (the `documentIds` scoping — the vectors are already there, no new index),
   * compare each matched pair (map), then reduce the notes into the report.
   */
  private async runCompareSectionMatched(
    task: InternalTask,
    runtime: ModelRuntime,
    docA: { id: string; title: string },
    docB: { id: string; title: string }
  ): Promise<{ report: string; truncated: boolean }> {
    const db = this.deps.getDb()
    const contextTokens = this.deps.getContextTokens()
    const signal = task.controller.signal

    // Embedder-visibility guard: the pairing reads stored vectors, so BOTH documents
    // must be visible to the ACTIVE embedder — a stale-embeddings document would
    // silently pair against nothing. Fail friendly with the actionable re-index copy
    // instead.
    const embedder = this.deps.getIngestionDeps().embedder
    if (!embedder) throw new Error(tMain('main.task.compareReindex'))
    const embeddedCount = (documentId: string): number => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
           WHERE c.document_id = ? AND e.embedding_model_id = ?`
        )
        .get(documentId, embedder.id) as unknown as { n: number }
      return r.n
    }
    if (embeddedCount(docA.id) === 0 || embeddedCount(docB.id) === 0) {
      throw new Error(tMain('main.task.compareReindex'))
    }

    // Doc A's chunks in document order, with their STORED vectors (no re-embedding —
    // the pairing must be deterministic and cost nothing but cosine scans).
    const aRows = db
      .prepare(
        `SELECT c.id, c.text, e.vector_blob, e.dimensions
         FROM chunks c JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?
         WHERE c.document_id = ? ORDER BY c.chunk_index`
      )
      .all(embedder.id, docA.id) as unknown as Array<{
      id: string
      text: string
      vector_blob: Uint8Array
      dimensions: number
    }>
    if (aRows.length === 0) throw new Error(tMain('main.task.compareReindex'))

    const plan = planCompareWindows(
      aRows.map((r) => ({ id: r.id, text: r.text })),
      contextTokens
    )
    if (plan.windows.length === 0) throw new Error(tMain('main.task.documentNotReady'))
    task.status.progress.stepsTotal = plan.stepsTotal

    const vectorByChunk = new Map(
      aRows.map((r) => [r.id, decodeVector(r.vector_blob, r.dimensions)])
    )
    const index = new VectorIndex(db, embedder, {
      embeddingModelId: embedder.id,
      documentIds: [docB.id]
    })

    const partials: string[] = []
    for (let i = 0; i < plan.windows.length; i++) {
      const window = plan.windows[i]
      // Union of each window chunk's top-N doc-B neighbors, best score kept.
      // Deterministic: scores come from stored vectors; ties break on chunk id.
      const scoreByB = new Map<string, number>()
      for (const chunkId of window.chunkIds) {
        const vec = vectorByChunk.get(chunkId)
        if (!vec) continue
        for (const hit of index.search(vec, COMPARE_NEIGHBORS_PER_CHUNK)) {
          const prev = scoreByB.get(hit.chunkId)
          if (prev === undefined || hit.score > prev) scoreByB.set(hit.chunkId, hit.score)
        }
      }
      const candidates = [...scoreByB.entries()].sort(
        (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)
      )
      // Fill the B side best-first up to its word budget; present the picked excerpts
      // in doc-B document order (readability). The first excerpt always fits — a
      // degenerate tiny context hard-truncates it rather than sending nothing.
      const bTexts = new Map<string, { text: string; chunkIndex: number }>()
      if (candidates.length > 0) {
        const rows = db
          .prepare(
            `SELECT id, text, chunk_index FROM chunks
             WHERE id IN (${candidates.map(() => '?').join(', ')})`
          )
          .all(...candidates.map(([id]) => id)) as unknown as Array<{
          id: string
          text: string
          chunk_index: number
        }>
        for (const r of rows) bTexts.set(r.id, { text: r.text, chunkIndex: r.chunk_index })
      }
      const picked: Array<{ text: string; chunkIndex: number }> = []
      let usedWords = 0
      for (const [chunkId] of candidates) {
        const row = bTexts.get(chunkId)
        if (!row) continue
        const rowWords = approxTokenCount(row.text)
        if (picked.length === 0 && rowWords > plan.pairBudgetWords) {
          picked.push({
            text: tokenize(row.text).slice(0, plan.pairBudgetWords).join(' '),
            chunkIndex: row.chunkIndex
          })
          usedWords = plan.pairBudgetWords
          continue
        }
        if (usedWords + rowWords > plan.pairBudgetWords) continue
        picked.push(row)
        usedWords += rowWords
      }
      picked.sort((x, y) => x.chunkIndex - y.chunkIndex)
      const excerptsB = picked.map((p) => p.text).join('\n\n')

      const partial = await this.generate(
        runtime,
        compareSystemPrompt(),
        comparePairPrompt(
          docA.title,
          docB.title,
          i + 1,
          plan.windows.length,
          window.text,
          excerptsB
        ),
        plan.mapMaxTokens,
        COMPARE_TEMPERATURE,
        signal
      )
      if (partial.length > 0) partials.push(partial)
      task.status.progress.stepsDone += 1
    }
    if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))

    // Belt for the reduce input: the map output caps already size the notes to fit,
    // but a model that ignores maxTokens must still not overflow.
    const budgetWords = compareBudgetWords(contextTokens)
    let reduceInput = partials
    const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
    if (totalWords > budgetWords) {
      reduceInput = [tokenize(partials.join('\n\n')).slice(0, budgetWords).join(' ')]
    }
    const report = await this.generate(
      runtime,
      compareSystemPrompt(),
      compareReducePrompt(docA.title, docB.title, reduceInput),
      COMPARE_OUTPUT_TOKENS,
      COMPARE_TEMPERATURE,
      signal
    )
    if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
    task.status.progress.stepsDone += 1
    return { report, truncated: plan.truncated }
  }

  /**
   * Write the generated Markdown to a transient file and run it through the NORMAL
   * import path (`createQueuedDocument` + `processDocument`) so the new document is
   * chunked, embedded, searchable, citable, and `.enc`-encrypted automatically.
   * Holds the vault lease for exactly this step — it writes `.enc` sidecars
   * (`VaultBusyError` from a concurrent password change propagates as a friendly task
   * failure). The transient uses the `.parse` infix so the startup crash sweep shreds
   * it if we die mid-step; otherwise it is shredded here, success or failure.
   */
  private async materializeDocument(
    task: InternalTask,
    markdown: string,
    title: string,
    origin: DocumentOrigin
  ): Promise<string> {
    const release = this.deps.beginDocumentWork()
    const db = this.deps.getDb()
    const storeDir = this.deps.getStoreDir()
    const tempPath = join(storeDir, `${task.status.jobId}.parse.md`)
    let newDocId: string | null = null
    try {
      writeFileSync(tempPath, markdown, 'utf8')
      const info = createQueuedDocument(db, tempPath, title)
      newDocId = info.id
      // The output document is born inside the task — OUTSIDE registerDocsIpc's
      // `processing` set — so list it on the task: `isDocumentBusy` then covers it
      // and it cannot be deleted/re-indexed mid-materialize.
      task.status.documentIds.push(info.id)
      const result = await processDocument(db, storeDir, info.id, this.deps.getIngestionDeps())
      if (result.status !== 'indexed') {
        // processDocument never throws — but a materialized output must fully succeed
        // or persist nothing, so a failed import removes the half-born row again.
        log.error(`Materialized ${origin.type} output failed to import`, {
          jobId: task.status.jobId,
          status: result.status,
          error: result.errorMessage
        })
        throw new Error(tMain('main.task.genericFailure'))
      }
      setDocumentOrigin(db, info.id, origin)
      // A new corpus document must never appear without an audit trail (filename +
      // id only — the translated text is content, never audit-logged).
      this.deps.audit?.('document_imported', `Document imported: ${result.title}`, {
        documentId: info.id,
        status: result.status,
        chunkCount: result.chunkCount
      })
      return info.id
    } catch (err) {
      if (newDocId) deleteDocument(db, newDocId)
      throw err
    } finally {
      shredFile(tempPath)
      release()
    }
  }

  /**
   * One translation window: a failed or empty generation is retried once; a second
   * failure returns null (the caller marks the window). Aborts always propagate
   * immediately — cancel must never look like a failed window.
   */
  private async generateWithRetry(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await this.generate(runtime, systemPrompt, prompt, maxTokens, temperature, signal)
        if (out.length > 0) return out
        log.warn('Translation window came back empty', { attempt })
      } catch (err) {
        if (isAbortError(err, signal)) throw err
        log.warn('Translation window failed', {
          attempt,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    }
    return null
  }

  /**
   * One model call over the LOCKED `chatStream` contract: explicit
   * maxTokens/temperature, NO depth mode, the task's own abort signal. Cancellation
   * must never persist a half result — an abort throws instead of returning the
   * partial text (chat keeps partials; tasks do not).
   */
  private async generate(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ]
    let out = ''
    const stream = runtime.chatStream(messages, {
      signal,
      maxTokens,
      temperature
    })
    for await (const token of stream) {
      out += token
    }
    // The mock runtime returns cleanly on abort; the real one throws AbortError. Both
    // must land in the `cancelled` state, so normalize the clean return into a throw.
    if (signal.aborted) {
      throw new DOMException('Document task cancelled', 'AbortError')
    }
    return stripThinkBlocks(out).trim()
  }
}

/** Keys of the guard/validation copy that may pass through to the renderer on failure. */
const FRIENDLY_TASK_ERROR_KEYS: readonly MessageKey[] = [
  'main.noModelRunning',
  'main.task.refusedChatStreaming',
  'main.task.documentNotReady',
  'main.task.genericFailure',
  'main.task.translationTarget',
  'main.task.sourceUnreadable',
  'main.task.comparePickTwo',
  'main.task.compareReindex',
  'main.task.needsOcr',
  'main.task.ocrNotAScan',
  'main.task.ocrNoText',
  'main.task.ocrFailed'
]

/**
 * True when a thrown message is our own friendly guard copy (exact match). The guards
 * throw via tMain(), so the message may be in EITHER language — and the cached language
 * can even change between a guard throwing and the failure being recorded — so both
 * catalogs are checked, not just the current one.
 */
export function isFriendlyTaskError(raw: string): boolean {
  return FRIENDLY_TASK_ERROR_KEYS.some((key) => raw === t('en', key) || raw === t('de', key))
}
