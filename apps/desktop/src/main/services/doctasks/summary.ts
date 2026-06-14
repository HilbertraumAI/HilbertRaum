import { approxTokenCount, windowByTokens } from '../ingestion/chunker'

// Summary window math + prompts (split out of the former monolithic doctasks.ts — audit
// M-A4). The budget-driven two-level map-reduce; pure and unit-tested at the boundaries.
// `packIntoWindows` is shared with the translation planner (re-imported there).
//
// Budgets use the chunker's `approxTokenCount` (≈1 token/word for prose, per-character
// for space-less scripts, length-charged for glued runs — so it never collapses a huge
// no-space run to one token). The budget keeps an explicit words→tokens safety factor on
// top (usable context tokens ÷ SUMMARY_TOKENS_PER_WORD) to absorb subword splits, so a
// window that fits the budget cannot overflow the model's real `contextTokens` window.

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
export function usableInputTokens(contextTokens: number): number {
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
export function packIntoWindows(texts: string[], budgetWords: number): string[] {
  const budget = Math.max(1, Math.floor(budgetWords))
  // Split any over-budget text into budget-sized pieces (document order kept). Measuring
  // and splitting by `approxTokenCount` (not a raw word count) is what keeps space-less
  // text — CJK, or glued PDF runs — from packing far past the budget and overflowing the
  // model context: `windowByTokens` charges such runs by length and slices them.
  const pieces: Array<{ text: string; tokens: number }> = []
  for (const text of texts) {
    const tokens = approxTokenCount(text)
    if (tokens === 0) continue
    if (tokens <= budget) {
      pieces.push({ text, tokens })
    } else {
      for (const sub of windowByTokens(text, budget, 0)) {
        pieces.push({ text: sub, tokens: approxTokenCount(sub) })
      }
    }
  }

  const windows: string[] = []
  let current: string[] = []
  let currentTokens = 0
  const flush = (): void => {
    if (current.length > 0) {
      windows.push(current.join('\n\n'))
      current = []
      currentTokens = 0
    }
  }
  for (const piece of pieces) {
    if (currentTokens > 0 && currentTokens + piece.tokens > budget) flush()
    current.push(piece.text)
    currentTokens += piece.tokens
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

export const SUMMARY_SYSTEM_PROMPT =
  'You are a careful assistant summarizing a document for its owner, fully offline. ' +
  'Use only the provided text. Never invent facts, names, or numbers. ' +
  'Write the summary in the same language as the document.'

export function singlePassPrompt(title: string, text: string): string {
  return (
    `Summarize the document "${title}". Start with a short overview paragraph, then list ` +
    'the key points as bullets. Keep important names, numbers, and dates exact.\n\n' +
    `Document text:\n${text}`
  )
}

export function mapPrompt(title: string, part: number, total: number, text: string): string {
  return (
    `Summarize part ${part} of ${total} of the document "${title}" in one concise paragraph. ` +
    'Keep important names, numbers, and dates exact.\n\n' +
    `Part text:\n${text}`
  )
}

export function reducePrompt(title: string, partials: string[]): string {
  return (
    `Below are partial summaries of consecutive parts of the document "${title}". Combine ` +
    'them into one coherent summary: a short overview paragraph, then the key points as ' +
    'bullets. Keep important names, numbers, and dates exact. Do not mention the parts.\n\n' +
    partials.map((p, i) => `Part ${i + 1} summary:\n${p}`).join('\n\n')
  )
}
