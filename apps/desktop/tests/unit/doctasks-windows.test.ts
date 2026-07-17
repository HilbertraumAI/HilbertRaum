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

  // The HTTP 400 fix: a space-less chunk (CJK / glued PDF run) used to count as ~1 "word",
  // so it packed into a single pass whose real prompt overflowed the model context. It must
  // now window into in-budget pieces.
  it('windows a space-less (CJK) chunk into in-budget pieces instead of one over-budget pass', () => {
    const cjk = '情報'.repeat(3000) // 6000 tokens, zero whitespace; budget at CTX 4096 ≈ 2526
    const plan = planSummaryWindows([cjk], CTX)
    expect(plan.singlePass).toBe(false)
    expect(plan.windows.length).toBeGreaterThan(1)
    for (const w of plan.windows) {
      expect(approxTokenCount(w)).toBeLessThanOrEqual(BUDGET)
    }
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

// ---- Phase 34: translation window math (D36 + R-T2), TG-3: the D4 input clamp --------
// (The former chat-model prompt templates — translationSystemPrompt/translationWindowPrompt/
// TRANSLATION_TEMPERATURE — were deleted at TG-3 with the chat translation path: the prompt
// is built inside the TranslateGemma sidecar, `services/translation/prompt.ts`, and pinned
// by `tests/unit/translation-prompt.test.ts`.)

import {
  assertNoTextDropped,
  computeMissingPageRanges,
  failedWindowNotice,
  missingPageNotice,
  planTranslationBlocks,
  planTranslationWindows,
  translatedDocumentTitle,
  translationAttributionLine,
  translationBudgetWords,
  TRANSLATION_MAX_INPUT_TOKENS,
  TRANSLATION_INPUT_TOKENS_PER_WORD,
  TRANSLATION_OUTPUT_TOKENS_PER_WORD,
  TRANSLATION_PROMPT_RESERVE_TOKENS,
  type TranslationSegment
} from '../../src/main/services/doctasks'

const T_BUDGET = translationBudgetWords(CTX)

describe('translationBudgetWords', () => {
  it('splits the usable context by the TG-6 Gemma token weight: 2.5/word in, 3.0/word out', () => {
    const usable = CTX - TRANSLATION_PROMPT_RESERVE_TOKENS
    // At the sidecar's launched 4096 the context split (~690 words ≈ 1725 input tokens)
    // sits just under the D4 clamp (720 words), so the formula is the context share.
    expect(T_BUDGET).toBe(
      Math.floor(usable / (TRANSLATION_INPUT_TOKENS_PER_WORD + TRANSLATION_OUTPUT_TOKENS_PER_WORD))
    )
    expect(Math.ceil(T_BUDGET * TRANSLATION_INPUT_TOKENS_PER_WORD)).toBeLessThanOrEqual(
      TRANSLATION_MAX_INPUT_TOKENS
    )
  })

  it('D4: clamps the input to the model card 2K spec on larger contexts', () => {
    // A 16K context would allow far more words by the split formula — the fine-tune is
    // trained at ≤2K input tokens, so the clamp must win regardless of the context.
    const clampWords = Math.floor(TRANSLATION_MAX_INPUT_TOKENS / TRANSLATION_INPUT_TOKENS_PER_WORD)
    expect(translationBudgetWords(16384)).toBe(clampWords)
    expect(translationBudgetWords(8192)).toBe(clampWords)
    // Estimated input tokens for a clamped window never exceed the spec.
    expect(Math.ceil(clampWords * TRANSLATION_INPUT_TOKENS_PER_WORD)).toBeLessThanOrEqual(
      TRANSLATION_MAX_INPUT_TOKENS
    )
  })

  it('never collapses below the floor on junk/tiny contexts', () => {
    expect(translationBudgetWords(0)).toBeGreaterThanOrEqual(120)
    expect(translationBudgetWords(Number.NaN)).toBeGreaterThanOrEqual(120)
  })

  it('L9: a REAL small context (512) is respected, never clamped UP to 1024', () => {
    // The pre-L9 code clamped ctx UP to 1024, so ctx 512 and 1024 produced the SAME budget.
    // A real 512-token context must now yield a SMALLER budget than 1024 — never inflated
    // past the context the model actually has (which would overflow every window).
    const small = translationBudgetWords(512)
    expect(small).toBeLessThan(translationBudgetWords(1024))
    // The window's estimated INPUT plus the prompt reserve fits inside the REAL 512 context.
    expect(
      Math.ceil(small * TRANSLATION_INPUT_TOKENS_PER_WORD) + TRANSLATION_PROMPT_RESERVE_TOKENS
    ).toBeLessThanOrEqual(512)
    // A plan over the small context still packs into in-budget windows (no overflow).
    const plan = planTranslationWindows([chunkOf(2000)], 512)
    expect(plan.windows.length).toBeGreaterThan(1)
    for (const w of plan.windows) {
      expect(approxTokenCount(w)).toBeLessThanOrEqual(small)
    }
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
      expect(
        Math.ceil(budget * TRANSLATION_INPUT_TOKENS_PER_WORD) + plan.windowMaxTokens
      ).toBeLessThanOrEqual(
        Math.max(usable, Math.ceil(budget * TRANSLATION_INPUT_TOKENS_PER_WORD) + 256) // floor exception
      )
      // Output headroom ≥ 1.9× the input words — comfortably over the TG-6-measured real
      // Gemma output weight (~1.96 tok/source-word into token-dense targets on prose).
      expect(plan.windowMaxTokens).toBeGreaterThanOrEqual(Math.floor(budget * 1.9))
    }
  })

  it('D4: windows on a big context stay within the clamped input budget', () => {
    const clampWords = Math.floor(TRANSLATION_MAX_INPUT_TOKENS / TRANSLATION_INPUT_TOKENS_PER_WORD)
    const plan = planTranslationWindows([chunkOf(clampWords * 3)], 16384)
    expect(plan.windows.length).toBeGreaterThanOrEqual(3)
    for (const w of plan.windows) {
      expect(approxTokenCount(w)).toBeLessThanOrEqual(clampWords)
    }
  })
})

describe('translation output framing (R-T2-informed)', () => {
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

  it('translated titles keep the base name and become Markdown (native names, widened set)', () => {
    expect(translatedDocumentTitle('report.pdf', 'de')).toBe('report (Deutsch).md')
    expect(translatedDocumentTitle('Notizen.docx', 'en')).toBe('Notizen (English).md')
    expect(translatedDocumentTitle('no-extension', 'de')).toBe('no-extension (Deutsch).md')
    // TG-3 widening: every curated target labels with its NATIVE name.
    expect(translatedDocumentTitle('report.pdf', 'fr')).toBe('report (Français).md')
    expect(translatedDocumentTitle('report.pdf', 'cs')).toBe('report (Čeština).md')
    expect(translatedDocumentTitle('report.pdf', 'uk')).toBe('report (Українська).md')
  })
})

// ---- Phase 35: compare window math + templates (D28 + D37 + R-T2) ---------------------

import {
  compareAttributionLine,
  compareBudgetWords,
  compareDocumentTitle,
  compareFitsSinglePass,
  compareFullPrompt,
  comparePairPrompt,
  compareReducePrompt,
  compareReportHeadings,
  compareTruncationNotice,
  planCompareWindows,
  COMPARE_MAP_CALL_CEILING,
  COMPARE_OUTPUT_TOKENS,
  COMPARE_PROMPT_RESERVE_TOKENS,
  type CompareChunkRef
} from '../../src/main/services/doctasks'

const C_BUDGET = compareBudgetWords(CTX)
const A_SHARE = Math.floor(C_BUDGET / 2)

function chunkRefs(count: number, wordsEach: number, tag = 'c'): CompareChunkRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tag}${i}`,
    text: chunkOf(wordsEach, `${tag}${i}w`)
  }))
}

describe('compareBudgetWords + the mode switch (D28)', () => {
  it('derives the total input budget from contextTokens minus the reserves', () => {
    const usable = CTX - COMPARE_OUTPUT_TOKENS - COMPARE_PROMPT_RESERVE_TOKENS
    expect(C_BUDGET).toBe(Math.floor(usable / SUMMARY_TOKENS_PER_WORD))
  })

  it('never collapses below the floor on junk/tiny contexts', () => {
    expect(compareBudgetWords(0)).toBeGreaterThanOrEqual(200)
    expect(compareBudgetWords(Number.NaN)).toBeGreaterThanOrEqual(200)
  })

  it('switches modes exactly at the budget boundary', () => {
    expect(compareFitsSinglePass(C_BUDGET - 100, 100, CTX)).toBe(true) // at budget
    expect(compareFitsSinglePass(C_BUDGET - 100, 101, CTX)).toBe(false) // one word over
    expect(compareFitsSinglePass(0, 0, CTX)).toBe(true)
  })
})

describe('planCompareWindows (mode b)', () => {
  it('packs A chunks into half-budget windows in document order, ids kept', () => {
    // 500-word chunks like real default chunk rows.
    const chunks = chunkRefs(6, 500)
    const plan = planCompareWindows(chunks, CTX)
    expect(plan.windows.length).toBeGreaterThanOrEqual(2)
    expect(plan.truncated).toBe(false)
    for (const w of plan.windows) {
      expect(approxTokenCount(w.text)).toBeLessThanOrEqual(A_SHARE)
      expect(w.chunkIds.length).toBeGreaterThan(0)
    }
    // Order preserved: window 1 starts with chunk 0's first word, and every chunk id
    // appears in some window in order.
    expect(plan.windows[0].text.startsWith('c0w0')).toBe(true)
    const allIds = plan.windows.flatMap((w) => w.chunkIds)
    expect(allIds).toEqual([...new Set(allIds)].sort((a, b) => allIds.indexOf(a) - allIds.indexOf(b)))
    expect(new Set(allIds)).toEqual(new Set(chunks.map((c) => c.id)))
  })

  it('splits an over-budget chunk into pieces that KEEP its id (neighbors are per-chunk)', () => {
    const big = { id: 'big', text: chunkOf(A_SHARE * 2 + 10, 'big') }
    const plan = planCompareWindows([big], CTX)
    expect(plan.windows.length).toBeGreaterThanOrEqual(2)
    for (const w of plan.windows) {
      expect(w.chunkIds).toEqual(['big'])
      expect(approxTokenCount(w.text)).toBeLessThanOrEqual(A_SHARE)
    }
    // No text silently dropped by packing.
    const total = plan.windows.reduce((n, w) => n + approxTokenCount(w.text), 0)
    expect(total).toBe(A_SHARE * 2 + 10)
  })

  it('caps windows at the ceiling and flags the plan truncated', () => {
    const chunksPerWindow = Math.max(1, Math.floor(A_SHARE / 500))
    const chunks = chunkRefs((COMPARE_MAP_CALL_CEILING + 5) * chunksPerWindow, 500)
    const plan = planCompareWindows(chunks, CTX)
    expect(plan.windows).toHaveLength(COMPARE_MAP_CALL_CEILING)
    expect(plan.truncated).toBe(true)
    expect(plan.stepsTotal).toBe(COMPARE_MAP_CALL_CEILING + 2) // maps + reduce + materialize
    expect(plan.windows[0].text.startsWith('c0w0')).toBe(true) // the BEGINNING is kept
  })

  it('sizes the per-map output cap so all notes provably fit the reduce input', () => {
    const chunksPerWindow = Math.max(1, Math.floor(A_SHARE / 500))
    const chunks = chunkRefs(14 * chunksPerWindow, 500)
    const plan = planCompareWindows(chunks, CTX)
    const usable = CTX - COMPARE_OUTPUT_TOKENS - COMPARE_PROMPT_RESERVE_TOKENS
    expect(plan.windows.length * plan.mapMaxTokens).toBeLessThanOrEqual(usable)
    expect(plan.mapMaxTokens).toBeGreaterThanOrEqual(128)
    expect(plan.mapMaxTokens).toBeLessThanOrEqual(COMPARE_OUTPUT_TOKENS)
  })

  it('reserves the other half of the budget for the retrieved doc-B excerpts', () => {
    const plan = planCompareWindows(chunkRefs(2, 100), CTX)
    expect(plan.pairBudgetWords).toBe(C_BUDGET - A_SHARE)
    expect(plan.pairBudgetWords).toBeGreaterThanOrEqual(100)
  })

  it('ignores empty chunks; no chunks → no windows', () => {
    expect(planCompareWindows([], CTX).windows).toHaveLength(0)
    const plan = planCompareWindows([{ id: 'e', text: '   ' }, { id: 'x', text: chunkOf(10) }], CTX)
    expect(plan.windows).toHaveLength(1)
    expect(plan.windows[0].chunkIds).toEqual(['x'])
  })
})

describe('compare templates (R-T2-validated on the real b9585 + Qwen3-4B)', () => {
  it('the report skeleton is the four dictated D28 sections', () => {
    const h = compareReportHeadings('a.pdf', 'b.pdf')
    expect(h).toEqual([
      '## What both documents share',
      '## What differs between them',
      '## Only in "a.pdf"',
      '## Only in "b.pdf"'
    ])
  })

  it('full prompt dictates the headings, exclusive placement, and only-the-report', () => {
    const p = compareFullPrompt('a.pdf', 'TEXT-A', 'b.pdf', 'TEXT-B')
    for (const h of compareReportHeadings('a.pdf', 'b.pdf')) expect(p).toContain(h)
    expect(p).toContain('exactly ONE section') // the round-2 smoke fix
    expect(p).toContain('Nothing notable.')
    expect(p).toContain('ONLY the report')
    expect(p).toContain('Document A ("a.pdf"):\nTEXT-A')
    expect(p).toContain('Document B ("b.pdf"):\nTEXT-B')
  })

  it('pair prompt uses the SMALLER prefixed-bullets format with the recall instruction', () => {
    const p = comparePairPrompt('a.pdf', 'b.pdf', 2, 5, 'WINDOW-A', 'EXCERPTS-B')
    expect(p).toContain('section 2 of 5')
    for (const prefix of ['- Same:', '- Different:', '- Only in A:', '- Only in B:']) {
      expect(p).toContain(prefix)
    }
    expect(p).toContain('Check every fact in the section of A') // the round-2 smoke fix
    expect(p).toContain('Section of document A:\nWINDOW-A')
    expect(p).toContain('Related excerpts of document B:\nEXCERPTS-B')
  })

  it('reduce prompt dictates the headings, faithfulness, and dedup', () => {
    const p = compareReducePrompt('a.pdf', 'b.pdf', ['- Same: x.', '- Different: y.'])
    for (const h of compareReportHeadings('a.pdf', 'b.pdf')) expect(p).toContain(h)
    expect(p).toContain('never add facts of your own')
    expect(p).toContain('Merge duplicate points')
    expect(p).toContain('Notes 1:\n- Same: x.')
    expect(p).toContain('Notes 2:\n- Different: y.')
  })

  it('attribution + truncation notice are honest and friendly', () => {
    expect(compareAttributionLine('qwen3-4b')).toBe(
      'Machine-generated comparison by qwen3-4b — may contain errors.'
    )
    const n = compareTruncationNotice('a.pdf')
    expect(n.startsWith('> ')).toBe(true)
    expect(n).toContain('covers the beginning of "a.pdf"')
  })

  it('report titles strip the source extensions and become Markdown', () => {
    expect(compareDocumentTitle('report.pdf', 'draft.docx')).toBe('Comparison: report vs draft.md')
    expect(compareDocumentTitle('no-ext', 'x.txt')).toBe('Comparison: no-ext vs x.md')
  })
})

// ---- Issue #58: completeness accounting (computeMissingPageRanges / planTranslationBlocks) ----

describe('computeMissingPageRanges (#58)', () => {
  const seg = (page: number | null, text = 'some real text'): TranslationSegment => ({
    text,
    pageNumber: page
  })

  it('finds leading, middle, and trailing gaps and collapses consecutive pages into ranges', () => {
    expect(computeMissingPageRanges([seg(2), seg(5)], 7)).toEqual([
      { from: 1, to: 1 },
      { from: 3, to: 4 },
      { from: 6, to: 7 }
    ])
  })

  it('a complete document has no gaps', () => {
    expect(computeMissingPageRanges([seg(1), seg(2), seg(3)], 3)).toEqual([])
  })

  it('several segments on one page count once', () => {
    expect(computeMissingPageRanges([seg(1), seg(1), seg(2)], 2)).toEqual([])
  })

  it('page-less sources (null pageCount, or any null pageNumber) yield NO page accounting', () => {
    expect(computeMissingPageRanges([seg(null)], null)).toEqual([])
    expect(computeMissingPageRanges([seg(null)], 5)).toEqual([])
    expect(computeMissingPageRanges([seg(1), seg(null)], 5)).toEqual([])
    expect(computeMissingPageRanges([seg(1)], 0)).toEqual([])
    expect(computeMissingPageRanges([seg(1)], Number.NaN)).toEqual([])
  })

  it('stays O(segments) with a bounded result on a crafted huge page count (M-2 shape)', () => {
    // One text page in a PDF that DECLARES a million pages: one trailing range, not a
    // million-entry list — and no walk over 1..pageCount.
    expect(computeMissingPageRanges([seg(1)], 1_000_000)).toEqual([{ from: 2, to: 1_000_000 }])
  })
})

describe('planTranslationBlocks (#58)', () => {
  const CTX = 4096

  it('with no gaps it degenerates to EXACTLY planTranslationWindows', () => {
    const texts = [chunkOf(300, 'a'), chunkOf(translationBudgetWords(CTX) + 50, 'b'), chunkOf(30, 'c')]
    const flat = planTranslationWindows(texts, CTX)
    const blocks = planTranslationBlocks(
      texts.map((t, i) => ({ text: t, pageNumber: i + 1 })),
      texts.length,
      CTX
    )
    expect(blocks.gaps).toEqual([])
    expect(blocks.blocks.map((b) => (b.kind === 'window' ? b.text : ''))).toEqual(flat.windows)
    expect(blocks.windowCount).toBe(flat.windows.length)
    expect(blocks.windowMaxTokens).toBe(flat.windowMaxTokens)
    expect(blocks.stepsTotal).toBe(flat.stepsTotal)
  })

  it('places a gap block at its true reading position and packs the runs separately', () => {
    const plan = planTranslationBlocks(
      [
        { text: chunkOf(50, 'p1w'), pageNumber: 1 },
        { text: chunkOf(50, 'p2w'), pageNumber: 2 },
        { text: chunkOf(50, 'p4w'), pageNumber: 4 },
        { text: chunkOf(50, 'p5w'), pageNumber: 5 }
      ],
      5,
      CTX
    )
    expect(plan.gaps).toEqual([{ from: 3, to: 3 }])
    // Tiny runs each pack to one window: [window(p1+p2), gap(3), window(p4+p5)].
    expect(plan.blocks.map((b) => b.kind)).toEqual(['window', 'gap', 'window'])
    const [w1, , w2] = plan.blocks
    expect(w1.kind === 'window' && w1.text).toContain('p2w0')
    expect(w2.kind === 'window' && w2.text).toContain('p4w0')
    // A gap never merges the surrounding text into one window across it.
    expect(w1.kind === 'window' && w1.text).not.toContain('p4w0')
    expect(plan.windowCount).toBe(2)
    expect(plan.stepsTotal).toBe(3)
  })

  it('a TRAILING gap lands after the last window block', () => {
    const plan = planTranslationBlocks(
      [{ text: chunkOf(40, 'p1w'), pageNumber: 1 }],
      3,
      CTX
    )
    expect(plan.gaps).toEqual([{ from: 2, to: 3 }])
    expect(plan.blocks.map((b) => b.kind)).toEqual(['window', 'gap'])
  })

  it('a LEADING gap lands before the first window block', () => {
    const plan = planTranslationBlocks(
      [{ text: chunkOf(40, 'p3w'), pageNumber: 3 }],
      3,
      CTX
    )
    expect(plan.gaps).toEqual([{ from: 1, to: 2 }])
    expect(plan.blocks.map((b) => b.kind)).toEqual(['gap', 'window'])
  })
})

describe('assertNoTextDropped — the per-segment completeness invariant (#58)', () => {
  it('accepts whitespace-only re-joins (packing and windowByTokens splits)', () => {
    expect(() =>
      assertNoTextDropped(['alpha beta', 'gamma\ndelta'], ['alpha beta\n\ngamma delta'])
    ).not.toThrow()
  })

  it('THROWS when packed windows lost content (teeth)', () => {
    expect(() => assertNoTextDropped(['alpha beta', 'gamma'], ['alpha beta'])).toThrow(
      /dropped content/
    )
    // Reordering/altering non-whitespace content is also a violation.
    expect(() => assertNoTextDropped(['ab cd'], ['cd ab'])).toThrow(/dropped content/)
  })
})

describe('missingPageNotice framing (#58)', () => {
  it('uses the single-page phrasing for a one-page gap and the range phrasing otherwise', () => {
    const single = missingPageNotice({ from: 3, to: 3 })
    expect(single).toContain('Page 3')
    expect(single).toMatch(/^> ⚠ /)
    const range = missingPageNotice({ from: 2, to: 4 })
    expect(range).toContain('Pages 2–4')
    expect(range).toMatch(/^> ⚠ /)
  })
})
