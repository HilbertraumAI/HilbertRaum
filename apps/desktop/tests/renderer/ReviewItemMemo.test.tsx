// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewScreen, __reviewItemRowRenderCounts } from '../../src/renderer/screens/ReviewScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem, stubReviewApi } from '../helpers/evidenceReview'

// DOC-2 (frontend audit 2026-08-09, #142): ReviewItemRow is memoized (the PERF-5/DocRow
// recipe). Every note keystroke rebuilds `detail.items` with identity preserved for the
// untouched items — pre-fix the unmemoized rows all re-rendered (and re-localized their
// immutable snapshots) per keystroke; the probe map pins that only the edited row re-renders.

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

beforeEach(() => {
  resetReviewSessionForTests()
  __reviewItemRowRenderCounts.clear()
})

afterEach(() => {
  cleanup()
  assertNoUnexpectedApiCalls()
})

describe('ReviewScreen — memoized item rows (DOC-2, #142)', () => {
  it('a note keystroke re-renders ONLY the edited row, not its untouched siblings', async () => {
    const detail = makeDetail({
      items: [
        makeItem({ id: 'i1', ordinal: 0, textSnapshot: 'Alpha [S1]' }),
        makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' }),
        makeItem({ id: 'i3', ordinal: 2, blockKey: 'b2-paragraph-ghi', textSnapshot: 'Gamma' })
      ]
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async (id: string) => makeItem({ id }))
    })
    const user = userEvent.setup()
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={() => {}} />)
    const notes = await screen.findAllByPlaceholderText(/note/i)
    expect(notes.length).toBe(3)

    const before = new Map(__reviewItemRowRenderCounts)
    await user.type(notes[0], 'looks right')
    await waitFor(() =>
      expect(__reviewItemRowRenderCounts.get('i1')).toBeGreaterThan(before.get('i1') ?? 0)
    )
    // The untouched siblings did not re-render on the keystrokes (pre-memo every row did).
    expect(__reviewItemRowRenderCounts.get('i2')).toBe(before.get('i2'))
    expect(__reviewItemRowRenderCounts.get('i3')).toBe(before.get('i3'))
  })
})
