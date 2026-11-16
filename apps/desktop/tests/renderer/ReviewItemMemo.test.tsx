// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { purgeReviewSession } from '../../src/renderer/lib/reviewSession'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem } from '../helpers/evidenceReview'
import { renderReview } from '../helpers/review-screen'

// DOC-2 (frontend audit 2026-08-09, #142): ReviewItemRow is memoized (the PERF-5/DocRow recipe). Every note keystroke rebuilds
// `detail.items` with identity preserved for the untouched items. ReviewItemRow is not exported, so its memo is counted through its
// decision group (the #743 pattern, TranscriptMemo.test.tsx): `DecisionControl` is no memo and ReviewItemRow hands it a fresh
// `onChange` arrow, so it renders exactly when the row does. Keyed by `value`: each row below holds a different decision.
const decisionRenders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../src/renderer/review/DecisionControl', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/renderer/review/DecisionControl')>()
  const { countMemoRenders } = await import('../helpers/render-counter')
  return { ...m, DecisionControl: countMemoRenders(m.DecisionControl, (p) => p.value, decisionRenders) }
})

beforeEach(() => {
  purgeReviewSession()
  decisionRenders.clear()
})

afterEach(() => {
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

describe('ReviewScreen — memoized item rows (DOC-2, #142)', () => {
  it('a note keystroke re-renders ONLY the edited row, not its untouched siblings', async () => {
    const detail = makeDetail({
      items: [
        makeItem({ id: 'i1', ordinal: 0, textSnapshot: 'Alpha [S1]', decision: 'supported' }),
        makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta', decision: 'follow_up' }),
        makeItem({ id: 'i3', ordinal: 2, blockKey: 'b2-paragraph-ghi', textSnapshot: 'Gamma', decision: 'not_applicable' })
      ]
    })
    const user = userEvent.setup()
    await renderReview({ detail, api: { updateEvidenceReviewItem: vi.fn(async (id: string) => makeItem({ id })) } })
    const notes = await screen.findAllByPlaceholderText(/note/i)
    expect(notes.length).toBe(3)
    // Focus the note first: focusing selects the row (onFocusCapture), which re-renders it once on its own. Counting
    // from here on leaves only the keystrokes as the cause of the edited row's renders.
    await user.click(notes[0])

    const before = new Map(decisionRenders)
    // The counter sees all three rows (no undefined === undefined pass below).
    expect(before.get('follow_up')).toBeGreaterThan(0)
    expect(before.get('not_applicable')).toBeGreaterThan(0)
    await user.type(notes[0], 'looks right')
    // Positive control: the keystrokes re-rendered the edited row (i1, 'supported').
    await waitFor(() => expect(decisionRenders.get('supported')).toBeGreaterThan(before.get('supported') ?? 0))
    // The untouched siblings did not re-render on the keystrokes (pre-memo every row did).
    expect(decisionRenders.get('follow_up')).toBe(before.get('follow_up'))
    expect(decisionRenders.get('not_applicable')).toBe(before.get('not_applicable'))
  })
})
