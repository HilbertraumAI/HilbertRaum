import { describe, it, expect } from 'vitest'

// Phase 2 — adaptive reduce output reserve (wholedoc-truncation-fix-plan §4). `computeReduceBudget`
// sizes the whole-doc map-reduce REDUCE step's output cap + notes budget from the REAL launched context
// so `notes + output` provably fit `n_ctx` at every size — the regression guard against the HTTP 400
// "exceeds context size". POLICY (owner-approved 2026-07-04): NOTES-FIRST — the deliverable reserve aims
// for ANALYSIS_RESPONSE_RESERVE_TOKENS but YIELDS toward CHAT_RESPONSE_RESERVE_TOKENS so whole-document
// coverage survives a small window; the notes are only hard-truncated (⇒ truncated) when even the floor
// output leaves no room. All math is in MODEL tokens.

import {
  computeReduceBudget,
  REDUCE_CHROME_TOKENS,
  REDUCE_MIN_NOTES_TOKENS
} from '../../src/main/services/rag/whole-doc-tree'
import {
  ANALYSIS_RESPONSE_RESERVE_TOKENS,
  CHAT_RESPONSE_RESERVE_TOKENS
} from '../../src/main/services/chat'

const CONTEXTS = [2048, 4096, 8192, 32768]

/** The reduce prompt's worst-case model-token footprint = chrome + fence + question + the notes filling
 *  their whole budget. `footprint + reduceOutputCap ≤ contextTokens` is the no-`n_ctx`-overflow invariant. */
function promptFootprint(fenceTokens: number, questionTokens: number, reduceNotesBudget: number): number {
  return REDUCE_CHROME_TOKENS + fenceTokens + questionTokens + reduceNotesBudget
}

describe('computeReduceBudget — adaptive, non-overflowing reduce output/notes budget (Phase 2 §4)', () => {
  // A realistic small fence + question — keeps every guarantee valid down to the smallest supported 2 048
  // window (below ~1.9 k the CHAT output floor alone exceeds the window, an inherent small-n_ctx limit).
  const FENCE = 200
  const QUESTION = 40

  for (const ctx of CONTEXTS) {
    for (const [label, notesTokens] of [
      ['notes fit (small)', 100],
      ['notes overflow (huge single window)', 100_000]
    ] as const) {
      it(`ctx ${ctx} / ${label}: prompt + cap ≤ ctx, notes ≥ MIN_NOTES, cap ∈ [CHAT, ANALYSIS]`, () => {
        const { reduceOutputCap, reduceNotesBudget, notesTruncated } = computeReduceBudget({
          contextTokens: ctx,
          fenceTokens: FENCE,
          questionTokens: QUESTION,
          notesTokens
        })
        // The load-bearing invariant: the reduce prompt + its output cap never exceed the launched window.
        expect(promptFootprint(FENCE, QUESTION, reduceNotesBudget) + reduceOutputCap).toBeLessThanOrEqual(ctx)
        // Notes are never starved below the floor; the output stays within [today's floor, the desired reserve].
        expect(reduceNotesBudget).toBeGreaterThanOrEqual(REDUCE_MIN_NOTES_TOKENS)
        expect(reduceOutputCap).toBeGreaterThanOrEqual(CHAT_RESPONSE_RESERVE_TOKENS)
        expect(reduceOutputCap).toBeLessThanOrEqual(ANALYSIS_RESPONSE_RESERVE_TOKENS)
        // Honest truncation flag: set iff the notes exceed their budget.
        expect(notesTruncated).toBe(notesTokens > reduceNotesBudget)
      })
    }
  }

  it('large window (≥ 8 k) awards the FULL desired reserve to a normal-size deliverable', () => {
    // A long brief with modest notes on an 8 k window gets the whole ANALYSIS reserve — the mid-sentence
    // cut is gone (§4 done criteria: "typical briefs complete on ≥ 8 k windows").
    const b = computeReduceBudget({ contextTokens: 8192, fenceTokens: 200, questionTokens: 40, notesTokens: 400 })
    expect(b.reduceOutputCap).toBe(ANALYSIS_RESPONSE_RESERVE_TOKENS) // 3072
    expect(b.notesTruncated).toBe(false)
  })

  it("reproduces the plan's worked examples (fence+question ≈ 980, notes fit)", () => {
    // §4: "4096 → cap ≈ 2476, notes ≈ 512, fits exactly". With a realistic ~900-token fence + ~80-token
    // question, the MIN_NOTES reservation squeezes the cap to exactly 2476 and the notes budget to 512 —
    // notes-first matches §4's numbers when the notes fit (the policies only diverge for over-budget notes).
    const FENCE_BIG = 900
    const Q_BIG = 80 // fence + question + CHROME(128) = 1108 overhead
    const at4096 = computeReduceBudget({ contextTokens: 4096, fenceTokens: FENCE_BIG, questionTokens: Q_BIG, notesTokens: 300 })
    expect(at4096.reduceOutputCap).toBe(2476)
    expect(at4096.reduceNotesBudget).toBe(512)
    expect(at4096.notesTruncated).toBe(false)
    expect(promptFootprint(FENCE_BIG, Q_BIG, at4096.reduceNotesBudget) + at4096.reduceOutputCap).toBe(4096) // fits exactly

    // §4: "8192 → cap 3072". The full desired reserve even with the big fence.
    const at8192 = computeReduceBudget({ contextTokens: 8192, fenceTokens: FENCE_BIG, questionTokens: Q_BIG, notesTokens: 300 })
    expect(at8192.reduceOutputCap).toBe(3072)
  })

  it('notes-first: a large single-window document on a 4 k window keeps its notes; the OUTPUT yields', () => {
    // The deviation from §4's fixed output-first clamp (owner-approved): rather than truncate a ~2 000-word
    // document back to the beginning to protect a 3 072-token output, the output shrinks toward the floor so
    // the WHOLE document survives (Phase 1's gap-band closure is preserved at the default 4 k context).
    const notesTokens = 2574 // ≈ a 1 980-word single window (approxPromptTokens)
    const b = computeReduceBudget({ contextTokens: 4096, fenceTokens: 0, questionTokens: 12, notesTokens })
    expect(b.notesTruncated).toBe(false) // whole document retained
    expect(b.reduceNotesBudget).toBeGreaterThanOrEqual(notesTokens)
    expect(b.reduceOutputCap).toBeGreaterThanOrEqual(CHAT_RESPONSE_RESERVE_TOKENS) // output yielded, never below the floor
    expect(b.reduceOutputCap).toBeLessThan(ANALYSIS_RESPONSE_RESERVE_TOKENS) // …and below the desired reserve
    expect(promptFootprint(0, 12, b.reduceNotesBudget) + b.reduceOutputCap).toBeLessThanOrEqual(4096)
  })

  it('only when even the floor output cannot fit the full notes are the notes truncated (honest badge at 4 k)', () => {
    // A document whose notes exceed (context − overhead − floor-output) is genuinely over-cap: the output
    // sits at the floor and the notes are hard-truncated ⇒ truncated:true (coverage honesty).
    const b = computeReduceBudget({ contextTokens: 4096, fenceTokens: 0, questionTokens: 12, notesTokens: 4000 })
    expect(b.reduceOutputCap).toBe(CHAT_RESPONSE_RESERVE_TOKENS) // floored — nothing left to yield
    expect(b.notesTruncated).toBe(true)
    expect(promptFootprint(0, 12, b.reduceNotesBudget) + b.reduceOutputCap).toBeLessThanOrEqual(4096)
  })
})
