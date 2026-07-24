import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
// `messages` row ONLY, so even those "lose nothing" paths brought the answer back WITHOUT
// the human's work — permanently, with no warning and no undo. (Conversation deletion, by
// contrast, has always counted the attached reviews and warned first.)
//
// These tests drive the real IPC handler for the documents channel (the "Answer without it"
// click sends `askDocuments(convId, '', null, regenerate: true)`) and the shared wrapper
// directly for the paths the IPC harness cannot reach cheaply. A real temp SQLite workspace,
// real crypto and the real review CRUD run underneath; only the Electron IPC transport and
// the model runtime are faked.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import { t } from '../../src/shared/i18n'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import {
  appendMessage,
  createConversation,
  emptyAssistantMessage,
  listMessages
} from '../../src/main/services/chat'
import {
  createEvidenceReview,
  createEvidenceReviewItems,
  getEvidenceReviewForMessage,
  recordEvidenceExport,
  setEvidenceLink,
  updateEvidenceReviewItem
} from '../../src/main/services/evidence-reviews'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { withRegenerateGuard, type ChatStreamRunFn } from '../../src/main/ipc/chat-stream'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import type { Message } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** The localized refusal both channels raise when the reply to be replaced carries a review. */
const REFUSAL = t('en', 'main.chat.reviewBlocksRegenerate')

const QUESTION = 'what are the payment terms'
const PRIOR_ANSWER = 'The payment term is 30 days. [S1]'

/** Seed one indexed document with a single chunk + its mock embedding, so retrieval finds
 *  context for `text` and the grounded path reaches the model. */
async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  text: string
): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const [vector] = await embedder.embed([text])
  const chunkId = randomUUID()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
     VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?)`
  ).run(chunkId, docId, text, title, text.split(/\s+/).length, now)
  db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chunkId, embedder.id, encodeVector(vector), vector.length, now)
  return docId
}

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

/** A runtime whose grounded generation fails with a NON-abort error before any token — the
 *  context-exceeded 400 that a regenerate (a full-history replay near the window) most reaches.
 *  This is the failure that triggers the restore path. */
function throwingRuntime(): ModelRuntime {
  return {
    modelId: 'throwing',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    // eslint-disable-next-line require-yield
    async *chatStream(_messages: ChatMessage[]): AsyncGenerator<string> {
      throw new Error('Chat request failed: HTTP 400 exceed_context_size_error')
    }
  } as unknown as ModelRuntime
}

function freshDb(): { db: Db; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-regenreview-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return { db, workspacePath: join(root, 'workspace') }
}

function makeCtx(db: Db, workspacePath: string, runtime: ModelRuntime): AppContext {
  return {
    paths: { rootPath: workspacePath, workspacePath },
    get db() {
      return db
    },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    ocrEngine: undefined
  } as unknown as AppContext
}

/** A documents conversation ending in a skill-stamped, cited assistant answer — the exact
 *  shape the "Answer without it" undo rides on. */
async function seedDocumentsTurn(
  db: Db,
  embedder: MockEmbedder
): Promise<{ conversationId: string; answer: Message }> {
  const docId = await seedDocument(db, embedder, 'contract.pdf', QUESTION)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [docId] }
  })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: QUESTION })
  const answer = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: PRIOR_ANSWER,
    citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 2 }],
    skillId: 'app:contract-review',
    autoFired: true
  })
  return { conversationId: conv.id, answer }
}

interface SeededReview {
  reviewId: string
  itemId: string
}

/** A REAL review chain on one message: head + a decided/annotated block item + an evidence
 *  link + a recorded export. Every table the message FK cascades into is populated, so a
 *  cascade shows up as a count drop in each of them. */
function seedReviewChain(db: Db, messageId: string): SeededReview {
  const review = createEvidenceReview(db, {
    messageId,
    title: 'Payment terms review',
    answerSnapshot: PRIOR_ANSWER,
    questionSnapshot: QUESTION,
    reviewerLabel: 'P. Reviewer',
    sources: [
      {
        key: 'S1',
        machineLabel: 'S1',
        kind: 'direct_excerpt',
        identity: 'resolved',
        documentTitle: 'contract.pdf'
      }
    ]
  })
  const [item] = createEvidenceReviewItems(db, review.id, [
    {
      kind: 'block',
      blockKey: 'b0',
      blockKind: 'paragraph',
      textSnapshot: PRIOR_ANSWER
    }
  ])
  if (!item) throw new Error('test setup: review item was not created')
  updateEvidenceReviewItem(db, item.id, {
    decision: 'supported',
    reviewerNote: 'Checked against clause 5 of the contract.'
  })
  setEvidenceLink(db, item.id, 'S1', { origin: 'reviewer', relation: 'supports' })
  recordEvidenceExport(db, {
    reviewId: review.id,
    format: 'html',
    schemaVersion: 1,
    fileName: 'payment-terms.html',
    fileSha256: 'ab'.repeat(32)
  })
  return { reviewId: review.id, itemId: item.id }
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

/** Drive a guarded runFn with a real abort signal + inert senders. */
function drive(wrapped: ChatStreamRunFn): Promise<Message> {
  const signal = new AbortController().signal
  const noop = (): void => {}
  return wrapped(signal, noop, noop, noop, noop)
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('regenerate vs. an evidence review — the documents "Answer without it" undo (AUD-01)', () => {
  it('refuses the re-answer and leaves the review chain and the answer fully intact', async () => {
    const { db, workspacePath } = freshDb()
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurn(db, embedder)
    const seeded = seedReviewChain(db, answer.id)
    expect(chainCounts(db, seeded)).toEqual(INTACT)

    // The model would happily answer — nothing but the guard stands between the click and
    // the destructive delete.
    registerRagIpc(makeCtx(db, workspacePath, answeringRuntime('a fresh, skill-free answer')))

    // Exactly what the renderer sends for "Answer without it": the same conversation, an
    // empty question (the last user turn is re-used), the skill cleared, regenerate ON.
    const err = await invokeCatching(IPC.askDocuments, conversationId, '', null, true)

    // The human work product survives — head, decisions/notes, links and export history.
    expect(chainCounts(db, seeded)).toEqual(INTACT)
    const summary = getEvidenceReviewForMessage(db, answer.id)
    expect(summary?.id).toBe(seeded.reviewId)
    expect(summary?.title).toBe('Payment terms review')

    // …and the refusal is the localized, actionable message (not a raw structural error).
    expect(err?.message).toBe(REFUSAL)

    // The reviewed answer itself is untouched: same id, same text, still the last turn.
    const history = listMessages(db, conversationId)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.id).toBe(answer.id)
    expect(history.at(-1)?.content).toBe(PRIOR_ANSWER)
    expect(inFlightStreams.has(conversationId)).toBe(false)
  })

  it('a re-answer whose generation would FAIL is refused before anything is deleted', async () => {
    // The non-abort-failure restore path: it replays the deleted `messages` row only, so
    // pre-guard this leg brought the answer back with its review chain already cascaded away.
    const { db, workspacePath } = freshDb()
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurn(db, embedder)
    const seeded = seedReviewChain(db, answer.id)

    registerRagIpc(makeCtx(db, workspacePath, throwingRuntime()))

    const err = await invokeCatching(IPC.askDocuments, conversationId, '', null, true)

    expect(chainCounts(db, seeded)).toEqual(INTACT)
    expect(getEvidenceReviewForMessage(db, answer.id)?.id).toBe(seeded.reviewId)
    // Refused BEFORE the delete, so the failure the user sees is the review refusal — never
    // the generation error that the delete-then-restore dance would have surfaced.
    expect(err?.message).toBe(REFUSAL)
    const history = listMessages(db, conversationId)
    expect(history.at(-1)?.id).toBe(answer.id)
    expect(history.at(-1)?.content).toBe(PRIOR_ANSWER)
    expect(inFlightStreams.has(conversationId)).toBe(false)
  })

  it('a re-answer on an UN-reviewed turn still regenerates normally (the guard is narrow)', async () => {
    const { db, workspacePath } = freshDb()
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurn(db, embedder)
    // No review on this message — the ordinary undo must keep working exactly as before.

    registerRagIpc(makeCtx(db, workspacePath, answeringRuntime('a fresh, skill-free answer')))

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
  function seedChatTurn(db: Db): { conversationId: string; answer: Message } {
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUESTION })
    const answer = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: PRIOR_ANSWER
    })
    return { conversationId: conv.id, answer }
  }

  it('refuses on the plain-chat channel too (the guard is channel-agnostic, not UI-dependent)', async () => {
    const { db } = freshDb()
    const { conversationId, answer } = seedChatTurn(db)
    const seeded = seedReviewChain(db, answer.id)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      appendMessage(db, { conversationId, role: 'assistant', content: 'a replacement answer' })
    )
    const err = await drive(wrapped).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    )

    expect(chainCounts(db, seeded)).toEqual(INTACT)
    expect(err?.message).toBe(REFUSAL)
    expect(listMessages(db, conversationId).at(-1)?.id).toBe(answer.id)
  })

  it('refuses the Stop-before-first-token leg too — the empty-resolve restore never re-created a review', async () => {
    // A Stop before the first token RESOLVES with an unpersisted empty message, and the
    // wrapper then replays the deleted `messages` row. That replay carries no review data, so
    // pre-guard two clicks (re-answer, Stop) left the answer looking restored and the review
    // silently gone. Refused up front, the leg is unreachable.
    const { db } = freshDb()
    const { conversationId, answer } = seedChatTurn(db)
    const seeded = seedReviewChain(db, answer.id)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      emptyAssistantMessage(conversationId)
    )
    const err = await drive(wrapped).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    )

    expect(chainCounts(db, seeded)).toEqual(INTACT)
    expect(getEvidenceReviewForMessage(db, answer.id)?.id).toBe(seeded.reviewId)
    expect(err?.message).toBe(REFUSAL)
    expect(listMessages(db, conversationId).at(-1)?.id).toBe(answer.id)
  })

  it('a review on an EARLIER turn never blocks a regenerate of the (un-reviewed) last turn', async () => {
    // The guard resolves the row the delete would actually target — the last VISIBLE message —
    // so a review deeper in the transcript, which the delete cannot reach, must not refuse.
    const { db } = freshDb()
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
    const result = await drive(wrapped)

    expect(result.content).toBe('a replacement answer')
    expect(chainCounts(db, seeded)).toEqual(INTACT) // the earlier review is untouched
    const history = listMessages(db, conv.id)
    expect(history.some((m) => m.id === last.id)).toBe(false) // the last reply WAS replaced
    expect(history.some((m) => m.id === reviewed.id)).toBe(true)
  })
})
