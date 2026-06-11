import { describe, it, expect } from 'vitest'
import {
  planSummaryWindows,
  summaryBudgetWords,
  SUMMARY_MAP_CALL_CEILING,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_PROMPT_RESERVE_TOKENS,
  SUMMARY_TOKENS_PER_WORD
} from '../../src/main/services/doctasks'
import { approxTokenCount } from '../../src/main/services/ingestion/chunker'

// Phase 33 window math (decision D25) at the boundaries: single-pass vs map-reduce
// cutover, the hard map-call ceiling + truncated flag, and the no-overflow guarantees
// the plan demands ("verify the window math against real chunk rows so windows can't
// overflow the context").

/** A chunk-row-like text of exactly `words` whitespace words (the chunker's estimate unit). */
function chunkOf(words: number, tag = 'w'): string {
  return Array.from({ length: words }, (_, i) => `${tag}${i}`).join(' ')
}

const CTX = 4096
const BUDGET = summaryBudgetWords(CTX)

describe('summaryBudgetWords', () => {
  it('derives the word budget from contextTokens minus the reserves, with the safety factor', () => {
    const usable = CTX - SUMMARY_OUTPUT_TOKENS - SUMMARY_PROMPT_RESERVE_TOKENS
    expect(BUDGET).toBe(Math.floor(usable / SUMMARY_TOKENS_PER_WORD))
  })

  it('never collapses below the floor on junk/tiny contexts', () => {
    expect(summaryBudgetWords(0)).toBeGreaterThanOrEqual(200)
    expect(summaryBudgetWords(512)).toBeGreaterThanOrEqual(200)
    expect(summaryBudgetWords(Number.NaN)).toBeGreaterThanOrEqual(200)
  })
})

describe('planSummaryWindows — single-pass vs map-reduce cutover', () => {
  it('total ≤ budget → ONE window, single pass, one step', () => {
    // 500-word chunks like real default chunk rows.
    const chunks = [chunkOf(500, 'a'), chunkOf(500, 'b'), chunkOf(500, 'c')]
    const plan = planSummaryWindows(chunks, CTX)
    expect(plan.singlePass).toBe(true)
    expect(plan.windows).toHaveLength(1)
    expect(plan.stepsTotal).toBe(1)
    expect(plan.truncated).toBe(false)
    // The stitched window itself stays within the word budget.
    expect(approxTokenCount(plan.windows[0])).toBeLessThanOrEqual(BUDGET)
  })

  it('exactly at the budget stays single-pass; one word over cuts to map-reduce', () => {
    const atBudget = planSummaryWindows([chunkOf(BUDGET)], CTX)
    expect(atBudget.singlePass).toBe(true)

    const overBudget = planSummaryWindows([chunkOf(BUDGET), chunkOf(1, 'x')], CTX)
    expect(overBudget.singlePass).toBe(false)
    expect(overBudget.windows).toHaveLength(2)
    expect(overBudget.stepsTotal).toBe(3) // 2 map + 1 reduce
  })

  it('no window ever exceeds the word budget (real default-sized chunk rows)', () => {
    // ~25 chunks of 500 words ≈ a mid-sized PDF.
    const chunks = Array.from({ length: 25 }, (_, i) => chunkOf(500, `c${i}`))
    const plan = planSummaryWindows(chunks, CTX)
    expect(plan.singlePass).toBe(false)
    for (const w of plan.windows) {
      expect(approxTokenCount(w)).toBeLessThanOrEqual(BUDGET)
    }
    // Windows preserve document order: the first window starts with the first chunk.
    expect(plan.windows[0].startsWith('c00')).toBe(true)
  })

  it('an over-budget single chunk is SPLIT into budget-sized windows, never truncated', () => {
    const plan = planSummaryWindows([chunkOf(BUDGET * 2)], CTX)
    expect(plan.windows).toHaveLength(2)
    for (const w of plan.windows) {
      expect(approxTokenCount(w)).toBeLessThanOrEqual(BUDGET)
    }
    // Every word survives into some window (no silent text loss before the ceiling).
    expect(plan.windows.join(' ').split(/\s+/)).toHaveLength(BUDGET * 2)
  })

  it('empty/whitespace chunks are ignored; no chunks → no windows', () => {
    expect(planSummaryWindows([], CTX).windows).toHaveLength(0)
    const plan = planSummaryWindows(['   ', chunkOf(10)], CTX)
    expect(plan.windows).toHaveLength(1)
  })
})

describe('planSummaryWindows — the hard ceiling (truncated flag)', () => {
  it('caps map calls at the ceiling and flags the plan truncated', () => {
    // Enough 500-word chunks to want far more windows than the ceiling permits.
    const wanted = SUMMARY_MAP_CALL_CEILING + 5
    const chunksPerWindow = Math.floor(BUDGET / 500)
    const chunks = Array.from({ length: wanted * chunksPerWindow }, (_, i) => chunkOf(500, `c${i}`))
    const plan = planSummaryWindows(chunks, CTX)
    expect(plan.windows).toHaveLength(SUMMARY_MAP_CALL_CEILING)
    expect(plan.truncated).toBe(true)
    expect(plan.stepsTotal).toBe(SUMMARY_MAP_CALL_CEILING + 1)
    // The kept windows are the BEGINNING of the document (honest truncation).
    expect(plan.windows[0].startsWith('c0')).toBe(true)
  })

  it('just under the ceiling is not truncated', () => {
    const chunksPerWindow = Math.floor(BUDGET / 500)
    const chunks = Array.from(
      { length: SUMMARY_MAP_CALL_CEILING * chunksPerWindow },
      (_, i) => chunkOf(500, `c${i}`)
    )
    const plan = planSummaryWindows(chunks, CTX)
    expect(plan.windows.length).toBeLessThanOrEqual(SUMMARY_MAP_CALL_CEILING)
    expect(plan.truncated).toBe(false)
  })
})

describe('planSummaryWindows — reduce-input safety', () => {
  it('sizes the per-map output cap so all partials fit the reduce input budget', () => {
    const chunksPerWindow = Math.floor(BUDGET / 500)
    const chunks = Array.from({ length: 14 * chunksPerWindow }, (_, i) => chunkOf(500, `c${i}`))
    const plan = planSummaryWindows(chunks, CTX)
    expect(plan.singlePass).toBe(false)
    const usable = CTX - SUMMARY_OUTPUT_TOKENS - SUMMARY_PROMPT_RESERVE_TOKENS
    // windows × mapMaxTokens ≤ usable input tokens (the provable-fit property)…
    expect(plan.windows.length * plan.mapMaxTokens).toBeLessThanOrEqual(usable)
    // …while staying useful (the floor) and never above the single-call cap.
    expect(plan.mapMaxTokens).toBeGreaterThanOrEqual(128)
    expect(plan.mapMaxTokens).toBeLessThanOrEqual(SUMMARY_OUTPUT_TOKENS)
  })
})

// ---- Phase 34: translation window math + templates (D36 + R-T2) ----------------------

import {
  failedWindowNotice,
  planTranslationWindows,
  translatedDocumentTitle,
  translationAttributionLine,
  translationBudgetWords,
  translationSystemPrompt,
  translationWindowPrompt,
  TRANSLATION_OUTPUT_TOKENS_PER_WORD,
  TRANSLATION_PROMPT_RESERVE_TOKENS
} from '../../src/main/services/doctasks'

const T_BUDGET = translationBudgetWords(CTX)

describe('translationBudgetWords', () => {
  it('splits the usable context by measured token weight: 1.3/word in, 2.0/word out (R-T2)', () => {
    const usable = CTX - TRANSLATION_PROMPT_RESERVE_TOKENS
    expect(T_BUDGET).toBe(
      Math.floor(usable / (SUMMARY_TOKENS_PER_WORD + TRANSLATION_OUTPUT_TOKENS_PER_WORD))
    )
  })

  it('never collapses below the floor on junk/tiny contexts', () => {
    expect(translationBudgetWords(0)).toBeGreaterThanOrEqual(120)
    expect(translationBudgetWords(Number.NaN)).toBeGreaterThanOrEqual(120)
  })
})

describe('planTranslationWindows', () => {
  it('a small document is one window; stepsTotal includes the materialize step', () => {
    const plan = planTranslationWindows([chunkOf(200)], CTX)
    expect(plan.windows).toHaveLength(1)
    expect(plan.stepsTotal).toBe(2) // 1 window + materialize
  })

  it('packs segments greedily in document order and splits an over-budget segment', () => {
    const seg1 = chunkOf(T_BUDGET - 10, 'a')
    const seg2 = chunkOf(T_BUDGET + 50, 'b') // must be SPLIT, never truncated
    const seg3 = chunkOf(30, 'c')
    const plan = planTranslationWindows([seg1, seg2, seg3], CTX)
    // No text silently dropped: every word survives packing.
    const allWords = plan.windows.join(' ').split(/\s+/)
    expect(allWords).toHaveLength(T_BUDGET - 10 + T_BUDGET + 50 + 30)
    // Document order preserved across windows: a-words before b-words before c-words.
    const joined = plan.windows.join(' ')
    expect(joined.indexOf('a0')).toBeLessThan(joined.indexOf('b0'))
    expect(joined.indexOf('b0')).toBeLessThan(joined.indexOf('c0'))
    // Every window respects the input budget.
    for (const w of plan.windows) {
      expect(approxTokenCount(w)).toBeLessThanOrEqual(T_BUDGET)
    }
  })

  it('has NO window ceiling — a faithful translation may not truncate', () => {
    // 40 windows' worth of text: far past the summary ceiling of 12.
    const segs = Array.from({ length: 40 }, (_, i) => chunkOf(T_BUDGET, `s${i}`))
    const plan = planTranslationWindows(segs, CTX)
    expect(plan.windows.length).toBeGreaterThanOrEqual(40)
    expect(plan.stepsTotal).toBe(plan.windows.length + 1)
  })

  it('input estimate + output cap provably fit the usable context (the fit property)', () => {
    for (const ctx of [1024, 2048, 4096, 8192]) {
      const plan = planTranslationWindows([chunkOf(5000)], ctx)
      const usable = Math.max(1024, ctx) - TRANSLATION_PROMPT_RESERVE_TOKENS
      const budget = translationBudgetWords(ctx)
      expect(Math.ceil(budget * SUMMARY_TOKENS_PER_WORD) + plan.windowMaxTokens).toBeLessThanOrEqual(
        Math.max(usable, Math.ceil(budget * SUMMARY_TOKENS_PER_WORD) + 256) // floor exception
      )
      // Output headroom ≈ 2.0× the input words — the R-T2-measured German token
      // weight (a 1.3× cap truncated a near-budget window on the real model).
      expect(plan.windowMaxTokens).toBeGreaterThanOrEqual(Math.floor(budget * 1.9))
    }
  })
})

describe('translation templates (R-T2-informed)', () => {
  it('system prompt: target language, translate-don\'t-summarize, structure, verbatim numbers', () => {
    const de = translationSystemPrompt('de')
    expect(de).toContain('into German')
    expect(de).toContain('never summarize')
    expect(de).toContain('Markdown structure')
    expect(de).toContain('numbers, dates, names, and codes exactly as written')
    expect(de).toContain('ONLY the translation')
    expect(translationSystemPrompt('en')).toContain('into English')
  })

  it('window prompt carries the verbatim-numbers instruction and the part numbering', () => {
    const p = translationWindowPrompt('de', 2, 5, 'Der Vertrag endet am 31.12.2026.')
    expect(p).toContain('into German')
    expect(p).toContain('part 2 of 5')
    expect(p).toContain('keep numbers, names, and dates verbatim')
    expect(p).toContain('Der Vertrag endet am 31.12.2026.')
    // A single-window document does not pretend to have parts.
    expect(translationWindowPrompt('en', 1, 1, 'x')).not.toContain('part 1 of 1')
  })

  it('failed-window notice is visible, friendly, and keeps the original text below', () => {
    const n = failedWindowNotice(3, 7)
    expect(n).toContain('(3 of 7)')
    expect(n).toContain('could not be translated')
    expect(n).toContain('original text is kept below')
    expect(n.startsWith('> ')).toBe(true) // a Markdown blockquote — visually set apart
  })

  it('attribution line is honest about machine translation', () => {
    expect(translationAttributionLine('qwen3-4b')).toBe(
      'Machine-translated by qwen3-4b — may contain errors.'
    )
  })

  it('translated titles keep the base name and become Markdown', () => {
    expect(translatedDocumentTitle('report.pdf', 'de')).toBe('report (Deutsch).md')
    expect(translatedDocumentTitle('Notizen.docx', 'en')).toBe('Notizen (English).md')
    expect(translatedDocumentTitle('no-extension', 'de')).toBe('no-extension (Deutsch).md')
  })
})
