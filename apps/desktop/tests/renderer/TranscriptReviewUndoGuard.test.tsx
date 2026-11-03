// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { t } from '../../src/shared/i18n'
import type { EvidenceReviewSummary, Message } from '../../src/shared/types'
import { makeMessage } from '../helpers/chat-fixtures'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { renderTranscript, type TranscriptProps } from '../helpers/transcript'

// AUD-01 — the "Answer without it" undo re-answers the turn with `regenerate: true`, which
// DELETES this assistant reply. `evidence_reviews.message_id` is a foreign key with ON DELETE
// CASCADE, so that delete takes the reply's entire review chain with it — the review head, every
// per-block decision and note, the evidence links and the export history — and the restore
// snapshot that the failure paths replay carries the `messages` row only. The main process now
// refuses such a turn outright; the renderer must not offer the click in the first place.
//
// The affordance is DISABLED, never hidden: the review chip renders in the same action row, so a
// button that simply vanished would read as a bug. The disabled button plus an explanatory title
// says what the state is and why.

beforeEach(() => {
  stubApi({})
})

afterEach(() => {
  cleanup()
  assertNoUnexpectedApiCalls()
})

const UNDO = t('en', 'chat.skill.answerWithout')
const BLOCKED_TITLE = t('en', 'chat.skill.answerWithoutBlockedByReview')
const noop = (): void => {}

/** A skill-stamped, cited answer `m1`: the shape the undo and the review chip share. */
const msg = (over: Partial<Message> = {}): Message =>
  makeMessage({
    id: 'm1',
    content: 'The payment term is 30 days. [S1]',
    citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 2 }],
    skillId: 'app:contract-review',
    skillTitle: 'Contract review',
    autoFired: true,
    ...over
  })

function summary(over: Partial<EvidenceReviewSummary> = {}): EvidenceReviewSummary {
  return {
    id: 'r1',
    conversationId: 'c1',
    messageId: 'm1',
    title: 'Payment terms review',
    status: 'draft',
    outdated: false,
    gate: { eligible: false, requiredTotal: 1, decidedTotal: 0 },
    updatedAt: '2026-07-23T10:00:00.000Z',
    ...over
  }
}

/** A documents-conversation transcript with the undo and the review entry point wired. */
function renderGuard(opts: Partial<TranscriptProps>): void {
  renderTranscript({
    onAnswerWithoutSkill: noop,
    onOpenReview: noop,
    reviewConversation: { mode: 'documents' },
    ...opts
  })
}

describe('"Answer without it" undo vs. an evidence review (AUD-01)', () => {
  // Any review blocks it, draft or ready: either is human work the delete would destroy. The row's
  // shared `actionsDisabled` blocks it too, with no review title. ChatScreen also withholds the
  // handler while it streams, so that leg is the component's own contract, as for the other
  // actions (#743).
  const blocked: Array<[string, Partial<TranscriptProps>, string | null]> = [
    ['the turn carries a draft review, with the review title', { reviewSummaries: new Map([['m1', summary({ status: 'draft' })]]) }, BLOCKED_TITLE],
    ['the turn carries a ready review, with the review title', { reviewSummaries: new Map([['m1', summary({ status: 'ready' })]]) }, BLOCKED_TITLE],
    ['the row’s actions are disabled and there is no review, with no title', { actionsDisabled: true }, null]
  ]
  it.each(blocked)('renders the undo DISABLED when %s, and a click does nothing', (_case, state, title) => {
    const onAnswerWithoutSkill = vi.fn()
    renderGuard({ messages: [msg()], ...state, onAnswerWithoutSkill })
    // Still present (the review chip sits in the same row — a vanished button would confuse)…
    const undo = screen.getByRole('button', { name: UNDO })
    // …but inert, and a review says why instead of leaving the user guessing.
    expect(undo).toBeDisabled()
    expect(undo.getAttribute('title')).toBe(title)
    // The click attempt too, so a move to `aria-disabled` (which `toBeDisabled` would miss) stays pinned.
    undo.click()
    expect(onAnswerWithoutSkill).not.toHaveBeenCalled()
  })

  it('stays ENABLED and title-free on a skill-stamped turn with no review', () => {
    renderGuard({ messages: [msg()] })
    const undo = screen.getByRole('button', { name: UNDO })
    expect(undo).toBeEnabled()
    expect(undo).not.toHaveAttribute('title')
  })

  it('a review on ANOTHER message never disables this turn\'s undo', () => {
    renderGuard({
      messages: [msg({ id: 'm1' })],
      reviewSummaries: new Map([['m-other', summary({ messageId: 'm-other' })]])
    })
    expect(screen.getByRole('button', { name: UNDO })).toBeEnabled()
  })

  it('a null summary entry (looked up, none found) leaves the undo enabled', () => {
    // The summaries map records "checked, no review" as an explicit null — it must read as
    // "no review", not as "some entry exists".
    renderGuard({
      messages: [msg()],
      reviewSummaries: new Map([['m1', null]])
    })
    expect(screen.getByRole('button', { name: UNDO })).toBeEnabled()
  })
})
