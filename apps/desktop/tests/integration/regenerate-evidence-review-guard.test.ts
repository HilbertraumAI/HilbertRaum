import { describe, it, expect, vi, beforeEach } from 'vitest'

// AUD-01 — a "regenerate" turn must never destroy an evidence review.
//
// The mechanism: both the chat "Try again" and the skill-stamped "Answer without it" undo
// re-answer the last turn with `regenerate: true`, which routes through the ONE shared
// wrapper (`withRegenerateGuard`) and DELETES the conversation's last assistant message.
// `evidence_reviews.message_id` is a foreign key with ON DELETE CASCADE and the workspace
// runs with `PRAGMA foreign_keys = ON`, so that single `DELETE FROM messages` takes the
// message's ENTIRE review chain with it: the review head (title, Ready status, reviewer
// label, general note, freshness acknowledgement), every per-block decision + reviewer note,
// every evidence link, and the whole export history. The deleted-message snapshot that the
// non-abort-failure restore and the Stop-before-first-token restore replay covers the
// `messages` row and the answer's `result_tables` rows, never the review chain, so even those
// "lose nothing" paths brought the answer back WITHOUT the human's work — permanently, with
// no warning and no undo. (Conversation deletion, by contrast, has always counted the
// attached reviews and warned first.)
//
// These tests drive the real documents IPC handler (the "Answer without it" click) and the
// shared wrapper directly for a plain-chat conversation and for the narrowness rule. The
// refusal comes before the delete and before any generation, so the failure-restore and
// Stop-before-first-token legs cannot run with a review attached; their rows were retired,
// and every guard mutation that redded them reds the rows below.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import { t } from '../../src/shared/i18n'
import type { Db } from '../../src/main/services/db'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { appendMessage, createConversation, listMessages } from '../../src/main/services/chat'
import { getEvidenceReviewForMessage } from '../../src/main/services/evidence-reviews'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { withRegenerateGuard } from '../../src/main/ipc/chat-stream'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import type { Message } from '../../src/shared/types'
import { seedEmbeddedDoc } from '../helpers/doc-fixtures'
import { seedReviewChain } from '../helpers/evidence-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { driveGuarded, regenWorkspace, seedAnsweredTurn } from '../helpers/regenerate-fixtures'
import { makeRagAskContext } from '../helpers/skills-world'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** The localized refusal both channels raise when the reply to be replaced carries a review. */
const REFUSAL = t('en', 'main.chat.reviewBlocksRegenerate')

const QUESTION = 'what are the payment terms'
const PRIOR_ANSWER = 'The payment term is 30 days. [S1]'

/** A runtime that ANSWERS: the regenerate succeeds, so the destructive delete would stand. */
function answeringRuntime(text: string): ModelRuntime {
  return {
    modelId: 'answering',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    async *chatStream(_messages: ChatMessage[]): AsyncGenerator<string> {
      yield text
    }
  } as unknown as ModelRuntime
}

/** A documents conversation ending in a skill-stamped, cited assistant answer — the exact
 *  shape the "Answer without it" undo rides on. */
async function seedDocumentsTurn(
  db: Db,
  embedder: MockEmbedder
): Promise<{ conversationId: string; answer: Message }> {
  const docId = await seedEmbeddedDoc(db, embedder, 'contract.pdf', [QUESTION])
  return seedAnsweredTurn(db, {
    question: QUESTION,
    answer: PRIOR_ANSWER,
    mode: 'documents',
    documentIds: [docId],
    citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 2 }],
    skillId: 'app:contract-review',
    autoFired: true
  })
}

/** What H's `seedReviewChain` returns: the chain's review and its one item. */
interface SeededReview {
  reviewId: string
  itemId: string
}

interface ChainCounts {
  reviews: number
  items: number
  links: number
  exports: number
}

/** Row counts across the whole cascade path (reviews → items → links, reviews → exports). */
function chainCounts(db: Db, seeded: SeededReview): ChainCounts {
  const count = (sql: string, param: string): number =>
    (db.prepare(sql).get(param) as unknown as { n: number }).n
  return {
    reviews: count('SELECT COUNT(*) AS n FROM evidence_reviews WHERE id = ?', seeded.reviewId),
    items: count('SELECT COUNT(*) AS n FROM evidence_review_items WHERE review_id = ?', seeded.reviewId),
    links: count(
      'SELECT COUNT(*) AS n FROM evidence_review_links WHERE review_item_id = ?',
      seeded.itemId
    ),
    exports: count('SELECT COUNT(*) AS n FROM evidence_exports WHERE review_id = ?', seeded.reviewId)
  }
}

const INTACT: ChainCounts = { reviews: 1, items: 1, links: 1, exports: 1 }

/** Await a handler invocation, returning the thrown Error instead of rejecting (so the
 *  data-survival assertions can run first and report the real damage). */
async function invokeCatching(channel: string, ...args: unknown[]): Promise<Error | null> {
  try {
    await invoke(handlers, channel, ...args)
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('regenerate vs. an evidence review — the documents "Answer without it" undo (AUD-01)', () => {
  it('refuses the re-answer and leaves the review chain and the answer fully intact', async () => {
    const { db, root, workspacePath } = regenWorkspace('regenreview')
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurn(db, embedder)
    const seeded = seedReviewChain(db, answer.id)
    expect(chainCounts(db, seeded)).toEqual(INTACT)
    const before = getEvidenceReviewForMessage(db, answer.id)

    // The model would happily answer — nothing but the guard stands between the click and
    // the destructive delete.
    registerRagIpc(
      makeRagAskContext({ db, root, workspacePath }, answeringRuntime('a fresh, skill-free answer')).ctx
    )

    // Exactly what the renderer sends for "Answer without it": the same conversation, an
    // empty question (the last user turn is re-used), the skill cleared, regenerate ON.
    const err = await invokeCatching(IPC.askDocuments, conversationId, '', null, true)

    // The human work product survives — head, decisions/notes, links and export history.
    expect(chainCounts(db, seeded)).toEqual(INTACT)
    const summary = getEvidenceReviewForMessage(db, answer.id)
    expect(summary?.id).toBe(seeded.reviewId)
    expect(summary).toEqual(before)

    // …and the refusal is the localized, actionable message (not a raw structural error).
    expect(err?.message).toBe(REFUSAL)

    // The reviewed answer itself is untouched: same id, same text, still the last turn.
    const history = listMessages(db, conversationId)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.id).toBe(answer.id)
    expect(history.at(-1)?.content).toBe(PRIOR_ANSWER)
    expect(inFlightStreams.has(conversationId)).toBe(false)
  })

  it('a re-answer on an UN-reviewed turn still regenerates normally (the guard is narrow)', async () => {
    const { db, root, workspacePath } = regenWorkspace('regenreview')
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurn(db, embedder)
    // No review on this message — the ordinary undo must keep working exactly as before.

    registerRagIpc(
      makeRagAskContext({ db, root, workspacePath }, answeringRuntime('a fresh, skill-free answer')).ctx
    )

    const err = await invokeCatching(IPC.askDocuments, conversationId, '', null, true)
    expect(err).toBeNull()
    const history = listMessages(db, conversationId)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.id).not.toBe(answer.id) // the prior reply WAS replaced
    expect(history.at(-1)?.content).toContain('a fresh, skill-free answer')
  })
})

describe('regenerate vs. an evidence review — the shared wrapper both channels use (AUD-01)', () => {
  /** A plain-CHAT conversation ending in a reviewed assistant answer. Chat answers are not
   *  review-eligible in the UI today, but `regenerate` is caller-supplied over IPC — the guard
   *  must not depend on which channel asked. */
  it('refuses on a plain-chat conversation too (the wrapper keys on the target row, never the conversation mode)', async () => {
    const { db } = regenWorkspace('regenreview')
    const { conversationId, answer } = seedAnsweredTurn(db, { question: QUESTION, answer: PRIOR_ANSWER, mode: 'chat' })
    const seeded = seedReviewChain(db, answer.id)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      appendMessage(db, { conversationId, role: 'assistant', content: 'a replacement answer' })
    )
    const err = await driveGuarded(wrapped).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    )

    expect(chainCounts(db, seeded)).toEqual(INTACT)
    expect(err?.message).toBe(REFUSAL)
    expect(listMessages(db, conversationId).at(-1)?.id).toBe(answer.id)
  })

  it('a review on an EARLIER turn never blocks a regenerate of the (un-reviewed) last turn', async () => {
    // The guard resolves the row the delete would actually target — the last VISIBLE message —
    // so a review deeper in the transcript, which the delete cannot reach, must not refuse.
    const { db } = regenWorkspace('regenreview')
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'first question' })
    const reviewed = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: PRIOR_ANSWER
    })
    const seeded = seedReviewChain(db, reviewed.id)
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'second question' })
    const last = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'a later, un-reviewed answer'
    })

    const wrapped = withRegenerateGuard(db, conv.id, true, async () =>
      appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a replacement answer' })
    )
    const result = await driveGuarded(wrapped)

    expect(result.content).toBe('a replacement answer')
    expect(chainCounts(db, seeded)).toEqual(INTACT) // the earlier review is untouched
    const history = listMessages(db, conv.id)
    expect(history.some((m) => m.id === last.id)).toBe(false) // the last reply WAS replaced
    expect(history.some((m) => m.id === reviewed.id)).toBe(true)
  })
})
