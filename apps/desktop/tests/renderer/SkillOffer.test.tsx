// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { t } from '../../src/shared/i18n'
import type { EvidenceReviewSummary, Message, SkillOffer } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'

// Issue #80 (wave R80) — the per-answer actionable skill OFFER affordance. Contract under test:
//   - renders ONLY on the LAST assistant turn (SKA-37: accepting re-answers via regenerate, which
//     acts on the conversation's last turn) — an older turn keeps the prose hint only;
//   - a click hands the offered installId to onRunWithSkill (the click IS the consent — S13b/D4);
//   - the classifier-sourced offer carries the "suggested by the local model" provenance marker,
//     the deterministic one does not (owner decision 4 — visually distinct sources);
//   - DISABLED (never hidden) when the reply carries an evidence review (the AUD-01 posture the
//     "answer without it" undo shares — re-answering would cascade the review away).

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

const RUN_LABEL = t('en', 'chat.skill.offer.run', { title: 'Bank Statement Analysis' })
const MODEL_MARKER = t('en', 'chat.skill.offer.model')
const BLOCKED_TITLE = t('en', 'chat.skill.answerWithoutBlockedByReview')

const OFFER: SkillOffer = {
  installId: 'app:bank-statement',
  title: 'Bank Statement Analysis',
  source: 'deterministic'
}

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'Found 2 amounts across 1 section scanned.',
    createdAt: '2026-08-09T10:00:00.000Z',
    ...over
  }
}

function renderTranscript(opts: {
  messages: Message[]
  onRunWithSkill?: (installId: string) => void
  reviewSummaries?: ReadonlyMap<string, EvidenceReviewSummary | null>
  actionsDisabled?: boolean
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
      onRunWithSkill={opts.onRunWithSkill ?? noop}
      onCopy={noop}
      onSave={noop}
      reviewSummaries={opts.reviewSummaries}
      reviewConversation={{ mode: 'documents' }}
      actionsDisabled={opts.actionsDisabled ?? false}
    />
  )
}

describe('per-answer skill offer (#80)', () => {
  it('renders the one-click run action on the last assistant turn and hands over the installId', () => {
    const onRunWithSkill = vi.fn()
    renderTranscript({ messages: [msg({ skillOffer: OFFER })], onRunWithSkill })
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeEnabled()
    run.click()
    expect(onRunWithSkill).toHaveBeenCalledExactlyOnceWith('app:bank-statement')
  })

  it('a deterministic offer carries NO provenance marker; a classifier offer carries it', () => {
    renderTranscript({ messages: [msg({ skillOffer: OFFER })] })
    expect(screen.queryByText(MODEL_MARKER)).not.toBeInTheDocument()
    cleanup()
    renderTranscript({ messages: [msg({ skillOffer: { ...OFFER, source: 'classifier' } })] })
    expect(screen.getByText(MODEL_MARKER)).toBeInTheDocument()
  })

  it('does NOT render on an offer-stamped turn that is no longer last (regenerate acts on the last turn)', () => {
    renderTranscript({
      messages: [
        msg({ id: 'm1', skillOffer: OFFER }),
        { id: 'm2', conversationId: 'c1', role: 'user', content: 'next question', createdAt: '2026-08-09T10:01:00.000Z' }
      ]
    })
    expect(screen.queryByRole('button', { name: RUN_LABEL })).not.toBeInTheDocument()
  })

  it('an answer without an offer renders no affordance at all', () => {
    renderTranscript({ messages: [msg({})] })
    expect(screen.queryByRole('button', { name: RUN_LABEL })).not.toBeInTheDocument()
  })

  it('is DISABLED with the explanatory title when the reply carries an evidence review (AUD-01)', () => {
    const onRunWithSkill = vi.fn()
    const summary: EvidenceReviewSummary = {
      id: 'r1',
      conversationId: 'c1',
      messageId: 'm1',
      title: 'Review',
      status: 'draft',
      outdated: false,
      gate: { eligible: false, requiredTotal: 1, decidedTotal: 0 },
      updatedAt: '2026-08-09T10:00:00.000Z'
    }
    renderTranscript({
      messages: [msg({ skillOffer: OFFER })],
      onRunWithSkill,
      reviewSummaries: new Map([['m1', summary]])
    })
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeDisabled()
    expect(run).toHaveAttribute('title', BLOCKED_TITLE)
    run.click()
    expect(onRunWithSkill).not.toHaveBeenCalled()
  })

  it('the shared streaming gate disables it like every message action', () => {
    renderTranscript({ messages: [msg({ skillOffer: OFFER })], actionsDisabled: true })
    expect(screen.getByRole('button', { name: RUN_LABEL })).toBeDisabled()
  })
})
