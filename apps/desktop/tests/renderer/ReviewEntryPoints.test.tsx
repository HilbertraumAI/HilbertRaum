// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ConversationList } from '../../src/renderer/chat/ConversationList'
import { t } from '../../src/shared/i18n'
import type { Message } from '../../src/shared/types'
import { makeCitations, makeConversation, makeMessage, userMsg } from '../helpers/chat-fixtures'
import { deferred } from '../helpers/deferred'
import { makeSummary } from '../helpers/evidenceReview'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { renderTranscript } from '../helpers/transcript'

// EP-1 plan §7.2 — the review entry points: the per-message "Review evidence" /
// "Continue review" action + Draft/Ready chip (spec §9.1/§9.4), the quiet
// SourcesDisclosure footer action (spec §9.2), and the D-2 delete-confirm review-count
// warning (spec §25.4). The visibility matrix pins how the transcript wires the shared
// `isReviewEligible` gate (eligible / ineligible / streaming / plain-chat); the user-turn row is
// stopped earlier, by MessageActions mounting for assistant turns only (Transcript.tsx:662). The
// predicate's own matrix lives in tests/unit/evidence-review-gate.test.ts (IP15's move).
//
// Zero-model/zero-network (review FIX-5, structural): every test runs against a FRESH
// stubApi (an empty install for the pure-prop matrix tests; D-2 tests re-install their
// count stub), and a file-wide afterEach runs assertNoUnexpectedApiCalls() — any window.api
// call outside the supplied evidence/count stubs fails the suite.

beforeEach(() => {
  stubApi({})
})

afterEach(() => {
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

function noop(): void {}

const CITED: Partial<Message> = { content: 'Answer text [S1]', citations: makeCitations(1) }

const START = t('en', 'review.action.start')
const CONTINUE = t('en', 'review.action.continue')

describe('review entry point — visibility matrix (spec §9.1)', () => {
  it('ELIGIBLE: an assistant answer with citations offers "Review evidence" and hands off its message id', () => {
    const onOpenReview = vi.fn()
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview,
      reviewConversation: { mode: 'documents' }
    })
    const btn = screen.getByRole('button', { name: START })
    fireEvent.click(btn)
    expect(onOpenReview).toHaveBeenCalledWith('m1')
  })

  it('ELIGIBLE via documents-mode: no citations/coverage but a documents conversation', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1', citations: undefined, coverage: undefined })],
      onOpenReview: noop,
      reviewConversation: { mode: 'documents' }
    })
    expect(screen.getByRole('button', { name: START })).toBeInTheDocument()
  })

  it('INELIGIBLE (plain chat): an assistant answer without citations/coverage shows NO review action', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1' })],
      onOpenReview: noop,
      reviewConversation: { mode: 'chat' }
    })
    expect(screen.queryByRole('button', { name: START })).toBeNull()
    expect(screen.queryByRole('button', { name: CONTINUE })).toBeNull()
  })

  it('INELIGIBLE (user turn): user messages never carry the action', () => {
    renderTranscript({
      messages: [userMsg('m1', 'Question?')],
      onOpenReview: noop,
      reviewConversation: { mode: 'documents' }
    })
    expect(screen.queryByRole('button', { name: START })).toBeNull()
  })

  it('STREAMING: the action renders DISABLED while a reply streams (actionsDisabled row gate)', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview: noop,
      reviewConversation: { mode: 'documents' },
      actionsDisabled: true
    })
    expect(screen.getByRole('button', { name: START })).toBeDisabled()
  })

  it('NO HANDOFF: without onOpenReview the affordance never renders (optional-callback gate)', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      reviewConversation: { mode: 'documents' }
    })
    expect(screen.queryByRole('button', { name: START })).toBeNull()
  })

  it('EXISTING REVIEW (spec §9.4): "Continue review" + Draft chip; Ready flips the chip', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview: noop,
      reviewSummaries: new Map([['m1', makeSummary({ status: 'draft' })]]),
      reviewConversation: { mode: 'documents' }
    })
    expect(screen.getByRole('button', { name: CONTINUE })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: START })).toBeNull()
    expect(screen.getByText(t('en', 'review.status.draft'))).toBeInTheDocument()

    cleanup()
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview: noop,
      reviewSummaries: new Map([['m1', makeSummary({ status: 'ready' })]]),
      reviewConversation: { mode: 'documents' }
    })
    expect(screen.getByText(t('en', 'review.status.ready'))).toBeInTheDocument()
  })

  it('P4 OUTDATED chip (spec §9.4/§18.4): JOINS the status chip — Ready stays visible', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview: noop,
      reviewSummaries: new Map([['m1', makeSummary({ status: 'ready', outdated: true })]]),
      reviewConversation: { mode: 'documents' }
    })
    // BOTH chips: the completion fact is never erased by the overlay.
    expect(screen.getByText(t('en', 'review.status.ready'))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'review.status.outdated'))).toBeInTheDocument()

    cleanup()
    // Not outdated → no Outdated chip.
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview: noop,
      reviewSummaries: new Map([['m1', makeSummary({ status: 'draft', outdated: false })]]),
      reviewConversation: { mode: 'documents' }
    })
    expect(screen.queryByText(t('en', 'review.status.outdated'))).toBeNull()
  })
})

describe('SourcesDisclosure footer entry (spec §9.2)', () => {
  it('the expanded sources region carries the quiet "Review answer and sources" action', () => {
    const onOpenReview = vi.fn()
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview,
      reviewConversation: { mode: 'documents' }
    })
    // Collapsed: the footer action is not in the document.
    expect(screen.queryByRole('button', { name: t('en', 'review.entry.sources') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /sources \(1\)/i }))
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.entry.sources') }))
    expect(onOpenReview).toHaveBeenCalledWith('m1')
  })

  it('an ineligible answer (no onOpenReview handoff) shows no footer action when expanded', () => {
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      reviewConversation: { mode: 'documents' }
    })
    fireEvent.click(screen.getByRole('button', { name: /sources \(1\)/i }))
    expect(screen.queryByRole('button', { name: t('en', 'review.entry.sources') })).toBeNull()
  })

  it('STREAMING: the footer action honors the same gate as the action row (FIX-6)', () => {
    const onOpenReview = vi.fn()
    renderTranscript({
      messages: [makeMessage({ id: 'm1', ...CITED })],
      onOpenReview,
      reviewConversation: { mode: 'documents' },
      actionsDisabled: true
    })
    fireEvent.click(screen.getByRole('button', { name: /sources \(1\)/i }))
    const footer = screen.getByRole('button', { name: t('en', 'review.entry.sources') })
    expect(footer).toBeDisabled()
    fireEvent.click(footer)
    expect(onOpenReview).not.toHaveBeenCalled()
  })
})

// ---- D-2: conversation-delete confirm names the review count (spec §25.4) --------------

function openDeleteConfirm(): void {
  render(
    <ConversationList
      conversations={[makeConversation({ id: 'c1', title: 'Contract chat', modelId: 'm', mode: 'documents' })]}
      activeId={null}
      streaming={false}
      mode="chat"
      onSelect={noop}
      onNew={noop}
      onDelete={noop}
      onCollapse={noop}
    />
  )
  // Right-click opens the same controlled "⋯" menu (the ConvRow onContextMenu path) —
  // deterministic in jsdom where Radix's pointer-driven trigger is flaky.
  fireEvent.contextMenu(screen.getByText('Contract chat'))
  fireEvent.click(screen.getByRole('menuitem', { name: t('en', 'chat.delete.menuItem') }))
}

describe('conversation-delete confirm — review-count warning (D-2)', () => {
  it('names the count when reviews are attached', async () => {
    stubApi({ countEvidenceReviewsForConversation: vi.fn(async () => 2) })
    openDeleteConfirm()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(
        within(dialog).getByText(
          t('en', 'review.deleteWithConversation.other', { count: 2 })
        )
      ).toBeInTheDocument()
    )
  })

  it('stays quiet when the conversation has no reviews', async () => {
    const count = deferred<number>()
    const countEvidenceReviewsForConversation = vi.fn(() => count.promise)
    stubApi({ countEvidenceReviewsForConversation })
    openDeleteConfirm()
    const dialog = await screen.findByRole('dialog')
    expect(countEvidenceReviewsForConversation).toHaveBeenCalledWith('c1')
    // Settle the count INSIDE act, then read synchronously: a waitFor around a negative passes on its first poll,
    // which could run before the 0 had committed.
    await act(async () => {
      count.resolve(0)
    })
    // The base delete body renders; no review line appears.
    expect(within(dialog).getByText(/permanently removed/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/evidence review/i)).toBeNull()
  })

  it('warns GENERICALLY when the count cannot be read — never silent about the cascade', async () => {
    stubApi({
      countEvidenceReviewsForConversation: vi.fn(async () => {
        throw new Error('locked')
      })
    })
    openDeleteConfirm()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(
        within(dialog).getByText(t('en', 'review.deleteWithConversation.unknown'))
      ).toBeInTheDocument()
    )
  })
})
