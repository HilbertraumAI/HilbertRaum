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
