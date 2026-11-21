// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, waitFor, cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { Conversation, Message } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatScreenStubs, conversationRow, deferred, renderChatScreen } from '../helpers/chat-screen'
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

// #976 (follow-ups wave 6, G-7): the entry shows on an answer with sources or coverage, and on any answer that already has a
// review. The batch read is still ONE call per conversation, and it now also runs for a documents conversation whose answers
// carry no sources, so a review made under a no-context reply is found; every summary the batch returns is kept.
describe('#976 — a review on an answer with no sources keeps its chip', () => {
  const NO_SOURCES = (id: string): Message => assistantMsg(id, 'I could not find this in your documents.')
  const chipOf = (block: Element): string | null => block.querySelector('.msg-review-chip')?.textContent ?? null
  const chipsByAnswer = (): Array<[number, string]> =>
    [...document.querySelectorAll('.msg-block.assistant')].flatMap((block, i) => {
      const chip = chipOf(block)
      return chip === null ? [] : [[i, chip] as [number, string]]
    })

  async function open(opts: { mode: 'chat' | 'documents'; messages: Message[]; summaries: ReturnType<typeof makeSummary>[] }) {
    const getEvidenceReviewSummariesForConversation = vi.fn(async () => opts.summaries)
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Chat', modelId: 'm1', mode: opts.mode })]),
        listMessages: vi.fn(async () => opts.messages),
        getEvidenceReviewSummariesForConversation
      })
    )
    renderChatScreen({ initialConversationId: 'c1', onOpenReview: () => {} })
    return getEvidenceReviewSummariesForConversation
  }

  it('documents chat, only answers with no sources, one has a review: ONE read, the chip on that answer', async () => {
    const read = await open({
      mode: 'documents',
      messages: [userMsg('q1', 'Thanks!'), NO_SOURCES('a1'), userMsg('q2', 'What?'), NO_SOURCES('a2')],
      summaries: [makeSummary({ id: 'r-a2', messageId: 'a2' })]
    })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(chipsByAnswer()).toEqual([[1, expect.stringContaining(t('en', 'review.status.draft'))]]))
    await settleUntilQuiescent(() => read.mock.calls.length)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('c1')
    // The answer without a review offers nothing; the one with a review offers to continue it.
    const rows = [...document.querySelectorAll('.msg-block.assistant')]
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: t('en', 'review.action.start') })).toBeNull()
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: t('en', 'review.action.continue') })).toBeInTheDocument()
  })

  it('a documents chat with no review at all reads once and shows no action under a no-sources answer', async () => {
    const read = await open({ mode: 'documents', messages: [userMsg('q1', 'Thanks!'), NO_SOURCES('a1')], summaries: [] })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await settleUntilQuiescent(() => read.mock.calls.length)
    expect(read).toHaveBeenCalledTimes(1)
    expect(chipsByAnswer()).toEqual([])
    expect(screen.queryByRole('button', { name: t('en', 'review.action.start') })).toBeNull()
  })

  it('every summary the batch returns is kept, also one for an answer without sources next to cited ones', async () => {
    const cited = (id: string): Message =>
      assistantMsg(id, 'Answer. [S1]', { citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 1, snippet: 'x' }] })
    const read = await open({
      mode: 'documents',
      messages: [userMsg('q1', 'Q1?'), cited('a1'), userMsg('q2', 'Q2?'), NO_SOURCES('a2')],
      summaries: [makeSummary({ id: 'r-a1', messageId: 'a1', status: 'ready' }), makeSummary({ id: 'r-a2', messageId: 'a2' })]
    })
    await waitFor(() =>
      expect(chipsByAnswer()).toEqual([
        [0, expect.stringContaining(t('en', 'review.status.ready'))],
        [1, expect.stringContaining(t('en', 'review.status.draft'))]
      ])
    )
    await settleUntilQuiescent(() => read.mock.calls.length)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a plain chat with answers that carry no sources reads nothing (no review can exist there)', async () => {
    const read = await open({ mode: 'chat', messages: [userMsg('q1', 'Hi'), assistantMsg('a1', 'Hello!')], summaries: [] })
    await waitFor(() => expect(document.querySelectorAll('.msg-block.assistant')).toHaveLength(1))
    await settleUntilQuiescent(() => read.mock.calls.length)
    expect(read).not.toHaveBeenCalled()
  })
})

// Review round 1 (O5): the once-per-conversation rule of #976. The read is remembered per conversation (`reviewReadForRef`),
// forgotten on a switch, and a new answer without sources does not ask again.
describe('#976 — the first read is once per conversation open', () => {
  const NO_SOURCES = (id: string, conversationId: string): Message =>
    assistantMsg(id, 'I could not find this in your documents.', { conversationId })
  const docsConv = (id: string, title: string): Conversation => makeConversation({ id, title, modelId: 'm1', mode: 'documents' })

  it('switching away while the other conversation is still reading, and back, reads the first one again and keeps its review', async () => {
    const pendingB = deferred<ReturnType<typeof makeSummary>[]>()
    const read = vi.fn(async (id: string) => (id === 'c2' ? pendingB.promise : [makeSummary({ id: 'r-a1', messageId: 'a1' })]))
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docsConv('c1', 'Alpha chat'), docsConv('c2', 'Beta chat')]),
        listMessages: vi.fn(async (id: string) => [userMsg(`q-${id}`, 'Thanks!'), NO_SOURCES(id === 'c1' ? 'a1' : 'b1', id)]),
        getEvidenceReviewSummariesForConversation: read
      })
    )
    const user = userEvent.setup()
    renderChatScreen({ onOpenReview: () => {} })
    await screen.findByText('Alpha chat')
    await user.click(conversationRow('Alpha chat'))
    expect(await screen.findByRole('button', { name: t('en', 'review.action.continue') })).toBeInTheDocument()
    expect(read.mock.calls.filter((c) => c[0] === 'c1')).toHaveLength(1)

    // Beta's read never lands before the user goes back.
    await user.click(conversationRow('Beta chat'))
    await waitFor(() => expect(read).toHaveBeenCalledWith('c2'))
    await user.click(conversationRow('Alpha chat'))
    await waitFor(() => expect(read.mock.calls.filter((c) => c[0] === 'c1').length).toBeGreaterThan(1))
    expect(await screen.findByRole('button', { name: t('en', 'review.action.continue') })).toBeInTheDocument()
    pendingB.resolve([])
  })

  it('a re-render and a new answer without sources do not read again', async () => {
    const read = vi.fn(async (_id: string) => [] as ReturnType<typeof makeSummary>[])
    const history = [userMsg('q1', 'Thanks!'), NO_SOURCES('a1', 'c1')]
    const askDocuments = vi.fn(async () => {
      history.push(userMsg('q2', 'And the deposit?'), NO_SOURCES('a2', 'c1'))
      return NO_SOURCES('a2', 'c1')
    })
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docsConv('c1', 'Alpha chat')]),
        listMessages: vi.fn(async () => [...history]),
        getEvidenceReviewSummariesForConversation: read,
        askDocuments
      })
    )
    const user = userEvent.setup()
    const view = renderChatScreen({ initialConversationId: 'c1', onOpenReview: () => {} })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await settleUntilQuiescent(() => read.mock.calls.length)
    view.rerender(<ChatScreen onOpenReview={() => {}} initialConversationId="c1" onNavigate={() => {}} />)

    await user.type(await screen.findByRole('textbox'), 'And the deposit?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(askDocuments).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelectorAll('.msg-block.assistant')).toHaveLength(2))
    await settleUntilQuiescent(() => read.mock.calls.length)
    expect(read).toHaveBeenCalledTimes(1)
  })

  // Reviews round 2 and 3: a failed read is no first read and marks no answer as "no review". The next run of the effect (the
  // conversation list arriving, a refresh) reads again and the review shows; the failure itself does not loop.
  it('a read that failed leaves its answers unknown: the next run reads again, shows the review, and stops', async () => {
    const history = [userMsg('q1', 'Thanks!'), NO_SOURCES('a1', 'c1')]
    let calls = 0
    const read = vi.fn(async (_id: string) => {
      calls += 1
      if (calls === 1) throw new Error('Workspace is locked.')
      return [makeSummary({ id: 'r-a1', messageId: 'a1' })]
    })
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docsConv('c1', 'Alpha chat')]),
        listMessages: vi.fn(async () => [...history]),
        getEvidenceReviewSummariesForConversation: read
      })
    )
    renderChatScreen({ initialConversationId: 'c1', onOpenReview: () => {} })
    expect(await screen.findByRole('button', { name: t('en', 'review.action.continue') })).toBeInTheDocument()
    await settleUntilQuiescent(() => read.mock.calls.length)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
