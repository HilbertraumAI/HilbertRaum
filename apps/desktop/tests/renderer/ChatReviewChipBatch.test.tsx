// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type {
  AppSettings,
  AppStatus,
  Conversation,
  EvidenceReviewSummary,
  Message,
  RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

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
// The tripwire is a COUNT, not a timing: the batch channel must be called exactly once and
// the per-message channel not at all.

const HISTORY_ANSWERS = 40

const idleStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

const conversation: Conversation = {
  id: 'c1',
  title: 'Long documents chat',
  createdAt: '2026-07-18T09:00:00.000Z',
  updatedAt: '2026-07-18T10:00:00.000Z',
  modelId: 'm1',
  mode: 'documents',
  scopeDocumentIds: null,
  collectionId: null,
  scope: null
} as Conversation

/** `HISTORY_ANSWERS` cited assistant answers (each with its question turn) — every answer is
 *  review-eligible, so the pre-batch shape would have made one round trip per answer. */
function longHistory(): Message[] {
  const messages: Message[] = []
  for (let i = 1; i <= HISTORY_ANSWERS; i++) {
    messages.push({
      id: `q${i}`,
      conversationId: 'c1',
      role: 'user',
      content: `Question ${i}?`,
      createdAt: '2026-07-18T09:00:00.000Z'
    })
    messages.push({
      id: `a${i}`,
      conversationId: 'c1',
      role: 'assistant',
      content: `Answer ${i}. [S1]`,
      createdAt: '2026-07-18T10:00:00.000Z',
      citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 12, snippet: 'Either…' }]
    })
  }
  return messages
}

function summary(messageId: string, over: Partial<EvidenceReviewSummary> = {}): EvidenceReviewSummary {
  return {
    id: `r-${messageId}`,
    conversationId: 'c1',
    messageId,
    title: 'Evidence review',
    status: 'draft',
    outdated: false,
    gate: { eligible: false, requiredTotal: 2, decidedTotal: 0 },
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...over
  }
}

function baseStubs(messages: Message[]) {
  return {
    listConversations: vi.fn(async () => [conversation]),
    listMessages: vi.fn(async () => messages),
    getRuntimeStatus: vi.fn(async () => idleStatus),
    listDocuments: vi.fn(async () => []),
    listCollections: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    listSkillRuns: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    getAppStatus: vi.fn(async () => ({ dictationAvailable: false }) as AppStatus),
    getActiveStream: vi.fn(async () => null),
    listActiveStreamConversations: vi.fn(async () => []),
    getConversationContextUsage: vi.fn(async () => null),
    getConversationSummary: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({}) as AppSettings),
    onRuntimeNotice: vi.fn(() => () => {})
  }
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('AUD-12 — chat chip state is ONE round trip per conversation open', () => {
  it(`opens a ${HISTORY_ANSWERS}-answer conversation with exactly ONE batch call and ZERO per-message calls`, async () => {
    const messages = longHistory()
    const getEvidenceReviewSummariesForConversation = vi.fn(async () => [
      summary('a3'),
      summary('a7', { status: 'ready' })
    ])
    const getEvidenceReviewForMessage = vi.fn(async () => null)
    const stubs = baseStubs(messages)
    stubApi({
      ...stubs,
      getEvidenceReviewSummariesForConversation,
      getEvidenceReviewForMessage
    })

    render(
      <ChatScreen onNavigate={() => {}} initialConversationId="c1" onOpenReview={() => {}} />
    )

    await waitFor(() => expect(stubs.listMessages).toHaveBeenCalledWith('c1'))
    // Gate on the chip-state read having HAPPENED (on either channel), never on a sleep…
    await waitFor(() =>
      expect(
        getEvidenceReviewSummariesForConversation.mock.calls.length +
          getEvidenceReviewForMessage.mock.calls.length
      ).toBeGreaterThan(0)
    )
    // …then let every follow-up effect pass settle: the map is now fully answered, so the
    // effect's own "unknown candidates" gate must close and stop it re-firing.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // THE ASSERTION: ONE batch round trip for the whole history, and not a single
    // per-message one (the shape whose cost scaled with the history).
    expect({
      batch: getEvidenceReviewSummariesForConversation.mock.calls.length,
      perMessage: getEvidenceReviewForMessage.mock.calls.length
    }).toEqual({ batch: 1, perMessage: 0 })
    expect(getEvidenceReviewSummariesForConversation).toHaveBeenCalledWith('c1')
  })

  it('a failing batch read leaves every chip hidden and does NOT retry per message', async () => {
    const messages = longHistory()
    const getEvidenceReviewSummariesForConversation = vi.fn(async () => {
      throw new Error('Workspace is locked.')
    })
    const getEvidenceReviewForMessage = vi.fn(async () => null)
    const stubs = baseStubs(messages)
    stubApi({
      ...stubs,
      getEvidenceReviewSummariesForConversation,
      getEvidenceReviewForMessage
    })

    render(
      <ChatScreen onNavigate={() => {}} initialConversationId="c1" onOpenReview={() => {}} />
    )

    await waitFor(() =>
      expect(
        getEvidenceReviewSummariesForConversation.mock.calls.length +
          getEvidenceReviewForMessage.mock.calls.length
      ).toBeGreaterThan(0)
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    // One attempt, no per-message fallback fan-out, no retry storm.
    expect({
      batch: getEvidenceReviewSummariesForConversation.mock.calls.length,
      perMessage: getEvidenceReviewForMessage.mock.calls.length
    }).toEqual({ batch: 1, perMessage: 0 })
  })
})
