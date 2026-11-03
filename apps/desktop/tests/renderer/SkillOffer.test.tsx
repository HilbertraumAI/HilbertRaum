// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { t } from '../../src/shared/i18n'
import type { EvidenceReviewSummary, SkillOffer } from '../../src/shared/types'
import { makeMessage, userMsg } from '../helpers/chat-fixtures'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { renderTranscript, type TranscriptProps } from '../helpers/transcript'

// Issue #80 (wave R80) — the per-answer actionable skill OFFER affordance. Contract under test:
//   - renders ONLY on the LAST assistant turn (SKA-37: accepting re-answers via regenerate, which
//     acts on the conversation's last turn) — an older turn keeps the prose hint only;
//   - a click hands the offered installId to onRunWithSkill (the click IS the consent — S13b/D4);
//   - the classifier-sourced offer carries the "suggested by the local model" provenance marker,
//     the deterministic one does not (owner decision 4 — visually distinct sources);
//   - DISABLED (never hidden) when the reply carries an evidence review (the AUD-01 posture the
//     "answer without it" undo shares — re-answering would cascade the review away).
// The #132 since-disabled/removed gate is proven through the real screen predicate in SkillOfferAccept.test.tsx.

beforeEach(() => {
  stubApi({})
})

afterEach(() => {
  cleanup()
  assertNoUnexpectedApiCalls()
})

const RUN_LABEL = t('en', 'chat.skill.offer.run', { title: 'Bank Statement Analysis' })
const MODEL_MARKER = t('en', 'chat.skill.offer.model')
const BLOCKED_TITLE = t('en', 'chat.skill.answerWithoutBlockedByReview')

const OFFER: SkillOffer = {
  installId: 'app:bank-statement',
  title: 'Bank Statement Analysis',
  source: 'deterministic'
}

/** A documents-conversation transcript with a run handler wired (a no-op unless the row spies on it):
 *  without one the offer never renders, so a row asserting its absence would pass for the wrong reason. */
function renderOffer(over: Partial<TranscriptProps>): void {
  renderTranscript({ onRunWithSkill: () => {}, reviewConversation: { mode: 'documents' }, ...over })
}

describe('per-answer skill offer (#80)', () => {
  it('renders the one-click run action on the last assistant turn and hands over the installId', () => {
    const onRunWithSkill = vi.fn()
    renderOffer({ messages: [makeMessage({ skillOffer: OFFER })], onRunWithSkill })
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeEnabled()
    run.click()
    expect(onRunWithSkill).toHaveBeenCalledExactlyOnceWith('app:bank-statement')
  })

  it('a deterministic offer carries NO provenance marker; a classifier offer carries it', () => {
    renderOffer({ messages: [makeMessage({ skillOffer: OFFER })] })
    expect(screen.queryByText(MODEL_MARKER)).not.toBeInTheDocument()
    cleanup()
    renderOffer({ messages: [makeMessage({ skillOffer: { ...OFFER, source: 'classifier' } })] })
    expect(screen.getByText(MODEL_MARKER)).toBeInTheDocument()
  })

  it('does NOT render on an offer-stamped turn that is no longer last (regenerate acts on the last turn)', () => {
    renderOffer({ messages: [makeMessage({ skillOffer: OFFER }), userMsg('u1', 'next question')] })
    expect(screen.queryByRole('button', { name: RUN_LABEL })).not.toBeInTheDocument()
  })

  it('an answer without an offer renders no affordance at all', () => {
    renderOffer({ messages: [makeMessage()] })
    expect(screen.queryByRole('button', { name: RUN_LABEL })).not.toBeInTheDocument()
  })

  it('is DISABLED with the explanatory title when the reply carries an evidence review (AUD-01)', () => {
    const onRunWithSkill = vi.fn()
    const answer = makeMessage({ skillOffer: OFFER })
    const summary: EvidenceReviewSummary = {
      id: 'r1',
      conversationId: 'c1',
      messageId: answer.id,
      title: 'Review',
      status: 'draft',
      outdated: false,
      gate: { eligible: false, requiredTotal: 1, decidedTotal: 0 },
      updatedAt: '2026-08-09T10:00:00.000Z'
    }
    renderOffer({
      messages: [answer],
      onRunWithSkill,
      reviewSummaries: new Map([[answer.id, summary]])
    })
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeDisabled()
    expect(run).toHaveAttribute('title', BLOCKED_TITLE)
    run.click()
    expect(onRunWithSkill).not.toHaveBeenCalled()
  })

  it('the shared streaming gate disables it like every message action', () => {
    renderOffer({ messages: [makeMessage({ skillOffer: OFFER })], actionsDisabled: true })
    expect(screen.getByRole('button', { name: RUN_LABEL })).toBeDisabled()
  })
})
