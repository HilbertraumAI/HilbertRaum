// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { t } from '../../src/shared/i18n'
import type { EvidenceReviewSummary, Message } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'

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

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

const UNDO = t('en', 'chat.skill.answerWithout')
const BLOCKED_TITLE = t('en', 'chat.skill.answerWithoutBlockedByReview')

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'The payment term is 30 days. [S1]',
    createdAt: '2026-07-23T10:00:00.000Z',
    citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 2 }],
    skillId: 'app:contract-review',
    skillTitle: 'Contract review',
    autoFired: true,
    ...over
  }
}

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

function renderTranscript(opts: {
  messages: Message[]
  reviewSummaries?: ReadonlyMap<string, EvidenceReviewSummary | null>
  onAnswerWithoutSkill?: () => void
}): void {
  const noop = (): void => {}
  render(
    <Transcript
      messages={opts.messages}
      streamingHere={false}
      streamText=""
      streamThinking=""
      thinkingOpen={false}
      onThinkingOpenChange={noop}
      emptyState={null}
      onAnswerWithoutSkill={opts.onAnswerWithoutSkill ?? noop}
      onCopy={noop}
      onSave={noop}
      onOpenReview={noop}
      reviewSummaries={opts.reviewSummaries}
      reviewConversation={{ mode: 'documents' }}
      actionsDisabled={false}
    />
  )
}

describe('"Answer without it" undo vs. an evidence review (AUD-01)', () => {
  it('renders the undo DISABLED with an explanatory title when the turn carries a review', () => {
    renderTranscript({
      messages: [msg({})],
      reviewSummaries: new Map([['m1', summary()]])
    })
    const undo = screen.getByRole('button', { name: UNDO })
    // Still present (the review chip sits in the same row — a vanished button would confuse)…
    expect(undo).toBeInTheDocument()
    // …but inert, and it explains the state instead of leaving the user guessing.
    expect(undo).toBeDisabled()
    expect(undo).toHaveAttribute('title', BLOCKED_TITLE)
  })

  it('a READY review blocks it just the same (any review is human work the delete would destroy)', () => {
    renderTranscript({
      messages: [msg({})],
      reviewSummaries: new Map([['m1', summary({ status: 'ready' })]])
    })
    expect(screen.getByRole('button', { name: UNDO })).toBeDisabled()
  })

  it('stays ENABLED and title-free on a skill-stamped turn with no review', () => {
    renderTranscript({ messages: [msg({})] })
    const undo = screen.getByRole('button', { name: UNDO })
    expect(undo).toBeEnabled()
    expect(undo).not.toHaveAttribute('title')
  })

  it('a review on ANOTHER message never disables this turn\'s undo', () => {
    renderTranscript({
      messages: [msg({ id: 'm1' })],
      reviewSummaries: new Map([['m-other', summary({ messageId: 'm-other' })]])
    })
    expect(screen.getByRole('button', { name: UNDO })).toBeEnabled()
  })

  it('a null summary entry (looked up, none found) leaves the undo enabled', () => {
    // The summaries map records "checked, no review" as an explicit null — it must read as
    // "no review", not as "some entry exists".
    renderTranscript({
      messages: [msg({})],
      reviewSummaries: new Map([['m1', null]])
    })
    expect(screen.getByRole('button', { name: UNDO })).toBeEnabled()
  })

  it('the blocked undo cannot be fired (no handler call on a click attempt)', async () => {
    const onAnswerWithoutSkill = vi.fn()
    renderTranscript({
      messages: [msg({})],
      reviewSummaries: new Map([['m1', summary()]]),
      onAnswerWithoutSkill
    })
    const undo = screen.getByRole('button', { name: UNDO })
    undo.click()
    expect(onAnswerWithoutSkill).not.toHaveBeenCalled()
  })
})
