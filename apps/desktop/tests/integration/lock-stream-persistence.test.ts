import { describe, it, expect, onTestFinished, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../src/main/services/db'
import {
  createConversation,
  appendMessage,
  generateAssistantMessage,
  listMessages,
  persistAssistantMessage
} from '../../src/main/services/chat'
import { generateGroundedAnswer, ragSettingsFrom } from '../../src/main/services/rag'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { log } from '../../src/main/services/logging'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { openFreshDb } from '../helpers/db-fixtures'
import { until } from '../helpers/hang-budget'

// R1 (full-audit-2026-06-30, Phase C): a workspace LOCK / quit aborts an in-flight chat stream while
// its partial reply is still unwinding to `appendMessage`. Phase C makes the teardown await each
// stream's SETTLE so the partial persists while the DB is open (the deterministic primary fix,
// covered by the shutdown/workspace-ipc ordering tests). Here we pin the two end-state guarantees in
// `generateAssistantMessage` itself: (1) an aborted partial DOES persist on an open DB; (2) the
// defense-in-depth guard swallows a partial-persist against an already-CLOSED DB cleanly (no
// unhandled rejection) instead of crashing the teardown.

/** The line the guard logs when it drops a partial: the conversation id only, never the content. */
const DROPPED = 'chat: dropped partial reply — workspace locked during persist'

/**
 * A runtime whose chatStream yields ONE token, then parks on `gate`. On release it observes the
 * abort and returns (the mock-runtime semantics) — so the test controls exactly when the
 * abort-unwind reaches `appendMessage`, modelling the lock racing the persistence.
 */
function gatedRuntime(gate: Promise<void>): ModelRuntime {
  return {
    modelId: 'mock',
    backend: 'mock',
    gpuName: null,
    async start() {},
    async stop() {},
    contextWindow: () => 2048,
    async health() {
      return { healthy: true, port: null, message: 'ok' }
    },
    async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
      yield 'partial '
      await gate // park until the test releases (the lock/quit window)
      if (options?.signal?.aborted) return // mock returns on abort; keep the streamed partial
      yield 'more'
    }
  } as unknown as ModelRuntime
}

describe('R1 — chat partial persistence vs a locking DB', () => {
  it('persists the aborted partial while the DB is still open', async () => {
    const db = openFreshDb('lockpersist')
    const conv = createConversation(db, { modelId: 'mock' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const p = generateAssistantMessage(db, gatedRuntime(gate), conv.id, {
      signal: ctrl.signal,
      onToken: (t) => (token += t)
    })
    await until(() => token !== '', 'the partial token streaming') // the generator is parked at the gate

    ctrl.abort() // the lock/quit aborts the stream
    release() // …and the abort-unwind proceeds to appendMessage on the still-OPEN db
    const msg = await p

    expect(msg.content).toBe('partial ') // the partial was persisted
    const stored = listMessages(db, conv.id).filter((m) => m.role === 'assistant')
    expect(stored.map((m) => m.content)).toEqual(['partial '])
  })

  it('swallows a locked-DB partial-persist cleanly — no rejection escapes (R1 guard)', async () => {
    const db = openFreshDb('lockpersist')
    const conv = createConversation(db, { modelId: 'mock' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const p = generateAssistantMessage(db, gatedRuntime(gate), conv.id, {
      signal: ctrl.signal,
      onToken: (t) => (token += t)
    })
    await until(() => token !== '', 'the partial token streaming')

    ctrl.abort()
    db.close() // the lock CLOSED the DB before the abort-unwind reached appendMessage
    release()

    // R1 guard: appendMessage against the closed DB during an ABORT partial-persist is swallowed →
    // an empty message, NOT a rejection (which would surface only as a global unhandled-rejection
    // log). Without the guard this REJECTS with "database is not open" and the assertion reds.
    await expect(p).resolves.toMatchObject({ content: '' })
  })

  it('a genuine persistence error on an OPEN DB still propagates (the guard is narrow)', async () => {
    const db = openFreshDb('lockpersist')
    const conv = createConversation(db, { modelId: 'mock' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // Drop the table so appendMessage throws a REAL error while the DB is open + signal aborted —
    // the guard (which keys on `!db.isOpen`) must NOT swallow this; it has to propagate.
    const p = generateAssistantMessage(db, gatedRuntime(gate), conv.id, {
      signal: ctrl.signal,
      onToken: (t) => (token += t)
    })
    await until(() => token !== '', 'the partial token streaming')
    ctrl.abort()
    db.exec('DROP TABLE messages') // DB stays OPEN, but the insert will fail
    release()
    await expect(p).rejects.toThrow(/no such table: messages/) // that error, not some other failure on the way
  })
})

// CODE-18 (full-audit 2026-07-11): the R1 guard used to exist ONLY on the plain-chat persist — the
// grounded persist sites (rag/index.ts ×2, whole-doc-tree.ts) errored on the same Stop+lock race
// instead of the designed quiet drop. All four sites now share `persistAssistantMessage`.
describe('CODE-18 — the shared persistAssistantMessage guard on the grounded paths', () => {
  /** Seed one indexed document with a single chunk so the whole-document grounded read has content
   *  (retrieveWholeDocument reads chunks directly — no embeddings needed). */
  function seedDoc(db: Db): string {
    const now = new Date().toISOString()
    const docId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
       VALUES (?, 'memo.txt', 'indexed', 'text/plain', ?, ?)`
    ).run(docId, now, now)
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, 0, 'the quarterly totals are stable', 'memo.txt', 1, ?)`
    ).run(randomUUID(), docId, now)
    return docId
  }

  it('a grounded (whole-document) Stop+lock race quietly drops the partial — no rejection', async () => {
    const db = openFreshDb('lockpersist')
    const docId = seedDoc(db)
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'what does it say?' })
    const warn = vi.spyOn(log, 'warn')
    onTestFinished(() => warn.mockRestore())

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const p = generateGroundedAnswer(
      db,
      gatedRuntime(gate),
      new MockEmbedder(),
      conv.id,
      'what does it say?',
      ragSettingsFrom(DEFAULT_SETTINGS),
      { signal: ctrl.signal, onToken: (t) => (token += t), wholeDocument: { documentId: docId } }
    )
    await until(() => token !== '', 'the partial token streaming')

    ctrl.abort()
    db.close() // the lock CLOSED the DB before the abort-unwind reached the grounded persist
    release()

    // Pre-fix this REJECTED ("database is not open"); the shared guard drops the partial quietly.
    await expect(p).resolves.toMatchObject({ content: '' })
    // …and it was the guard that answered, at the grounded persist: an empty result alone is also what a path that
    // never reached the persist would return.
    expect(warn).toHaveBeenCalledWith(DROPPED, { conversationId: conv.id })
  })

  it('persistAssistantMessage: guard fires ONLY on aborted+closed; open-DB errors propagate', () => {
    const db = openFreshDb('lockpersist')
    const conv = createConversation(db, {})
    const aborted = new AbortController()
    aborted.abort()

    // Aborted + OPEN DB with a genuine persistence error → it propagates (the guard keys on the closed DB).
    const open = openFreshDb('lockpersist')
    const openConv = createConversation(open, {})
    open.exec('DROP TABLE messages')
    expect(() =>
      persistAssistantMessage(open, { conversationId: openConv.id, role: 'assistant', content: 'partial' }, aborted.signal)
    ).toThrow(/no such table: messages/)
    open.close()

    // Aborted + closed DB → quiet drop (the unpersisted empty message).
    db.close()
    const dropped = persistAssistantMessage(
      db,
      { conversationId: conv.id, role: 'assistant', content: 'partial' },
      aborted.signal
    )
    expect(dropped.content).toBe('')

    // NOT aborted + closed DB → the genuine error still propagates (the guard is narrow).
    expect(() =>
      persistAssistantMessage(db, { conversationId: conv.id, role: 'assistant', content: 'x' })
    ).toThrow(/database is not open/)
  })
})
