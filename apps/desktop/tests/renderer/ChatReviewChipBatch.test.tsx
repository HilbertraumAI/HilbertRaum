// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, waitFor, cleanup } from '@testing-library/react'
import type { Conversation, Message } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatScreenStubs, renderChatScreen } from '../helpers/chat-screen'
import { assistantMsg, makeConversation, userMsg } from '../helpers/chat-fixtures'
import { makeSummary } from '../helpers/evidenceReview'
import { t } from '../../src/shared/i18n'

// AUD-12 — the chat transcript's evidence-review chip state costs ONE IPC round trip per
// conversation open, no matter how long the history is.
//
// It used to ask per message: for every review-eligible assistant answer the screen awaited
// its own `getEvidenceReviewForMessage` invoke, SERIALLY, and each of those did a full
// item-row load plus a freshness recompute main-side. Opening a documents-mode conversation
// therefore got slower the longer it had been used, and — because the screen committed the
// whole batch only after the LAST round trip resolved — the chips appeared at the speed of
// the slowest one. That commit shape is load-bearing beyond latency: while a reviewed turn's
// chip state is still unknown, the transcript renders the "Answer without it" undo as
// enabled, and a shorter unknown window is a smaller chance of clicking it (main refuses the
// destructive action outright either way).
//
// The tripwire is a COUNT, not a timing: the batch channel must be called exactly once. (The
// per-message channel no longer exists: #840 removed it with its preload member, so the old
// "and zero per-message calls" half is now the type checker's.)

const HISTORY_ANSWERS = 40

const conversation = (): Conversation =>
  makeConversation({ title: 'Long documents chat', modelId: 'm1', mode: 'documents' })

/** `HISTORY_ANSWERS` cited assistant answers (each with its question turn) — every answer is
 *  review-eligible, so the pre-batch shape would have made one round trip per answer. */
function longHistory(): Message[] {
  const messages: Message[] = []
  for (let i = 1; i <= HISTORY_ANSWERS; i++) {
    messages.push(userMsg(`q${i}`, `Question ${i}?`))
    messages.push(
      assistantMsg(`a${i}`, `Answer ${i}. [S1]`, {
        citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 12, snippet: 'Either…' }]
      })
    )
  }
  return messages
}

afterEach(() => {
  // Unmount first, so a call ChatScreen makes while unmounting is checked against the same stub set.
  try {
    cleanup()
    assertNoUnexpectedApiCalls()
  } finally {
    vi.restoreAllMocks()
    window.localStorage.clear()
  }
})

/**
 * T-3 (#147): deterministic settle for the negative assertions below — drain queued task
 * cascades until the observed IPC counter is unchanged for 3 consecutive rounds (bounded).
 * Replaces a real 50 ms sleep, which was only a sampling window: an effect firing later
 * passed undetected, and CI load narrowed the window further.
 */
async function settleUntilQuiescent(count: () => number): Promise<void> {
  let quiet = 0
  let last = count()
  for (let i = 0; i < 50 && quiet < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const now = count()
    if (now === last) quiet += 1
    else {
      quiet = 0
      last = now
    }
  }
}

describe('AUD-12 — chat chip state is ONE round trip per conversation open', () => {
  it(`opens a ${HISTORY_ANSWERS}-answer conversation with exactly ONE batch call, each chip on its own answer`, async () => {
    const messages = longHistory()
    const getEvidenceReviewSummariesForConversation = vi.fn(async () => [
      makeSummary({ id: 'r-a3', messageId: 'a3' }),
      makeSummary({ id: 'r-a7', messageId: 'a7', status: 'ready' })
    ])
    const listMessages = vi.fn(async () => messages)
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [conversation()]),
        listMessages,
        getEvidenceReviewSummariesForConversation
      })
    )

    renderChatScreen({ initialConversationId: 'c1', onOpenReview: () => {} })

    await waitFor(() => expect(listMessages).toHaveBeenCalledWith('c1'))
    // Gate on the chip-state read having HAPPENED, never on a sleep…
    await waitFor(() => expect(getEvidenceReviewSummariesForConversation.mock.calls.length).toBeGreaterThan(0))
    // …then let every follow-up effect pass settle DETERMINISTICALLY (T-3, #147): drain
    // task cascades until the IPC counter is quiescent for 3 consecutive rounds — the old
    // real 50 ms sleep was only a sampling window CI load could narrow past a late effect.
    await settleUntilQuiescent(() => getEvidenceReviewSummariesForConversation.mock.calls.length)

    // THE ASSERTION: ONE batch round trip for the whole history (the per-message shape's
    // cost scaled with the history).
    expect(getEvidenceReviewSummariesForConversation).toHaveBeenCalledTimes(1)
    expect(getEvidenceReviewSummariesForConversation).toHaveBeenCalledWith('c1')
    // The batch is keyed by MESSAGE id renderer-side (#839 U2f): each summary's chip lands on its own answer, and
    // every other answer shows none.
    const chipOf = (block: Element): string | null => block.querySelector('.msg-review-chip')?.textContent ?? null
    await waitFor(() => {
      const chips = [...document.querySelectorAll('.msg-block.assistant')].map(chipOf)
      expect(chips).toHaveLength(HISTORY_ANSWERS)
      expect(chips.flatMap((chip, i) => (chip === null ? [] : [[`a${i + 1}`, chip]]))).toEqual([
        ['a3', expect.stringContaining(t('en', 'review.status.draft'))],
        ['a7', expect.stringContaining(t('en', 'review.status.ready'))]
      ])
    })
  })

  it('a failing batch read is not retried', async () => {
    const messages = longHistory()
    const getEvidenceReviewSummariesForConversation = vi.fn(async () => {
      throw new Error('Workspace is locked.')
    })
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [conversation()]),
        listMessages: vi.fn(async () => messages),
        getEvidenceReviewSummariesForConversation
      })
    )

    renderChatScreen({ initialConversationId: 'c1', onOpenReview: () => {} })

    await waitFor(() => expect(getEvidenceReviewSummariesForConversation.mock.calls.length).toBeGreaterThan(0))
    await settleUntilQuiescent(() => getEvidenceReviewSummariesForConversation.mock.calls.length)
    // One attempt, no retry storm.
    expect(getEvidenceReviewSummariesForConversation).toHaveBeenCalledTimes(1)
  })
})
