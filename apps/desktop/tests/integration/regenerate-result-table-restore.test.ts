import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// A "regenerate" turn must never silently destroy the result table of an answer it then puts BACK.
//
// The mechanism: the chat "Try again" and the skill-stamped "Answer without it" undo both
// re-answer the last turn with `regenerate: true`, which routes through the ONE shared wrapper
// (`withRegenerateGuard`) and runs `DELETE FROM messages` on the conversation's last assistant
// reply. `result_tables.message_id` is a foreign key with ON DELETE CASCADE and the workspace
// runs with `PRAGMA foreign_keys = ON`, so that single delete also drops the answer's structured
// table — the bank-statement / analysis artifact behind the message-level "Export CSV" action.
//
// On a SUCCESSFUL regenerate that is correct: the answer is genuinely being replaced, and the new
// answer carries its own table (or none). But the wrapper has two legs that put the OLD answer
// back — a NON-ABORT generation failure (a context-exceeded 400, a dead sidecar) and a Stop
// BEFORE the first token (which resolves with an unpersisted empty message) — and the
// deleted-message snapshot those legs replay used to cover the `messages` row ONLY. So on exactly
// the two paths whose contract is "nothing is lost", the answer came back while its table stayed
// permanently gone: `hasResultTable` (a derived EXISTS join over `result_tables`) then read false
// and the Export affordance silently disappeared from a turn the app had just reported as fully
// restored. Not reproducible without re-running the model.
//
// These tests drive the real documents IPC handler for the failure leg and the shared wrapper
// directly for the Stop leg, over a real temp SQLite workspace with real crypto and the real
// result-table store; only the Electron IPC transport and the model runtime are faked.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import {
  appendMessage,
  createConversation,
  deleteLastAssistantMessage,
  emptyAssistantMessage,
  listMessages,
  restoreMessage
} from '../../src/main/services/chat'
import { loadResultTable, saveResultTable } from '../../src/main/services/tables/store'
import type { TableSpec } from '../../src/main/services/tables'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { withRegenerateGuard, type ChatStreamRunFn } from '../../src/main/ipc/chat-stream'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import type { Message } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

const QUESTION = 'list every transaction in the statement'
const PRIOR_ANSWER = 'I found 2 transactions. [S1]'

/** The structured artifact behind the answer's "Export CSV" action — content, never logged. */
const TABLE: TableSpec = {
  columns: [
    { key: 'date', label: 'date' },
    { key: 'description', label: 'description' },
    { key: 'amount', label: 'amount', kind: 'money' }
  ],
  rows: [
    { date: '2026-01-02', description: 'Lebensmittel — Müller', amount: -45.9 },
    { date: '2026-01-03', description: 'Salary', amount: 2500 }
  ]
}

/** A SECOND table on the same message: `result_tables.message_id` carries only an index, not a
 *  UNIQUE constraint, so the schema permits more than one row per message and the snapshot has
 *  to capture (and replay) all of them in a deterministic order. */
const SECOND_TABLE: TableSpec = {
  columns: [
    { key: 'category', label: 'category' },
    { key: 'total', label: 'total', kind: 'money' }
  ],
  rows: [{ category: 'Lebensmittel', total: -45.9 }]
}

interface RawResultTableRow {
  id: string
  message_id: string
  conversation_id: string
  columns_json: string
  rows_json: string
  row_count: number
  source: string | null
  created_at: string
}

/** Every persisted `result_tables` row for a message, ALL columns, in the deterministic order the
 *  snapshot captures them — so "byte-identical after the restore" is a plain deep-equal. */
function rawResultTables(db: Db, messageId: string): RawResultTableRow[] {
  return db
    .prepare(
      `SELECT id, message_id, conversation_id, columns_json, rows_json, row_count, source, created_at
         FROM result_tables WHERE message_id = ? ORDER BY created_at ASC, rowid ASC`
    )
    .all(messageId) as unknown as RawResultTableRow[]
}

/** Total `result_tables` rows in the workspace — catches a replay that leaks a duplicate. */
function totalResultTables(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM result_tables').get() as unknown as { n: number }).n
}

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

/** A runtime whose grounded generation fails with a NON-abort error before any token — the
 *  context-exceeded 400 that a regenerate (a full-history replay near the window) most reaches.
 *  This is the failure that triggers the restore leg. */
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
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-regentable-'))
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

/** A documents conversation ending in a skill-stamped answer that CARRIES a result table — the
 *  exact shape the bank/analysis "Export CSV" affordance hangs off. */
async function seedDocumentsTurnWithTable(
  db: Db,
  embedder: MockEmbedder
): Promise<{ conversationId: string; answer: Message }> {
  const docId = await seedDocument(db, embedder, 'statement.pdf', QUESTION)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [docId] }
  })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: QUESTION })
  const answer = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: PRIOR_ANSWER,
    citations: [{ label: 'S1', sourceTitle: 'statement.pdf', pageNumber: 1 }],
    skillId: 'app:bank-statement',
    autoFired: true
  })
  expect(
    saveResultTable(db, {
      messageId: answer.id,
      conversationId: conv.id,
      table: TABLE,
      source: 'app:bank-statement'
    })
  ).toBe(true)
  return { conversationId: conv.id, answer }
}

/** A plain-CHAT conversation ending in an assistant answer that carries a result table. */
function seedChatTurnWithTable(db: Db): { conversationId: string; answer: Message } {
  const conv = createConversation(db, {})
  appendMessage(db, { conversationId: conv.id, role: 'user', content: QUESTION })
  const answer = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: PRIOR_ANSWER
  })
  expect(
    saveResultTable(db, {
      messageId: answer.id,
      conversationId: conv.id,
      table: TABLE,
      source: 'app:bank-statement'
    })
  ).toBe(true)
  return { conversationId: conv.id, answer }
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

describe('regenerate restore legs — the answer comes back WITH its result table', () => {
  it('a regenerate whose grounded generation FAILS restores the table byte-identically', async () => {
    const { db, workspacePath } = freshDb()
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurnWithTable(db, embedder)
    const before = rawResultTables(db, answer.id)
    expect(before).toHaveLength(1)

    registerRagIpc(makeCtx(db, workspacePath, throwingRuntime()))

    await expect(
      invoke(handlers, IPC.askDocuments, conversationId, QUESTION, null, /* regenerate */ true)
    ).rejects.toThrow(/HTTP 400|too large/i)

    // The answer itself was always restored — the table is what used to stay gone.
    const history = listMessages(db, conversationId)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.id).toBe(answer.id)
    expect(history.at(-1)?.content).toBe(PRIOR_ANSWER)

    // Same row: same id, same JSON payload, same row_count/source/timestamps — no re-derivation.
    expect(rawResultTables(db, answer.id)).toEqual(before)
    expect(totalResultTables(db)).toBe(1) // replayed, not duplicated
    expect(loadResultTable(db, answer.id)).toEqual(TABLE)
    // …so the derived flag the renderer keys the "Export CSV" action off reads true again.
    expect(history.at(-1)?.hasResultTable).toBe(true)
    expect(inFlightStreams.has(conversationId)).toBe(false)
  })

  it('a Stop BEFORE the first token restores the table byte-identically', async () => {
    // The empty-resolve leg: the run resolves (it does not throw) with an unpersisted empty
    // message, and the wrapper replays the snapshot. Two clicks (Try again, Stop) used to leave
    // the answer looking fully restored with its table silently erased.
    const { db } = freshDb()
    const { conversationId, answer } = seedChatTurnWithTable(db)
    const before = rawResultTables(db, answer.id)
    expect(before).toHaveLength(1)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      emptyAssistantMessage(conversationId)
    )
    const result = await drive(wrapped)

    // chat:done carries the restored answer straight back to the UI, so the flag that drives the
    // "Export CSV" affordance has to be lit on the returned object too — not only in the DB.
    expect(result.id).toBe(answer.id)
    expect(result.hasResultTable).toBe(true)
    expect(rawResultTables(db, answer.id)).toEqual(before)
    expect(totalResultTables(db)).toBe(1)
    expect(loadResultTable(db, answer.id)).toEqual(TABLE)
    expect(listMessages(db, conversationId).at(-1)?.hasResultTable).toBe(true)
  })

  it('CONTROL — a SUCCESSFUL regenerate still drops the old table (the answer was replaced)', async () => {
    // The fix must be confined to the restore legs: a completed re-answer legitimately replaces
    // the reply, and the new answer carries its own table (or none). Resurrecting the old table
    // onto a replaced answer would mis-label a fresh answer with stale rows.
    const { db } = freshDb()
    const { conversationId, answer } = seedChatTurnWithTable(db)
    expect(totalResultTables(db)).toBe(1)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      appendMessage(db, { conversationId, role: 'assistant', content: 'a fresh answer' })
    )
    const result = await drive(wrapped)

    expect(result.content).toBe('a fresh answer')
    const history = listMessages(db, conversationId)
    expect(history.some((m) => m.id === answer.id)).toBe(false) // the old reply is gone…
    expect(rawResultTables(db, answer.id)).toEqual([]) // …and its table went with it
    expect(totalResultTables(db)).toBe(0)
    expect(history.at(-1)?.hasResultTable).toBeUndefined()
  })
})

describe('deleted-message snapshot — result-table capture and replay', () => {
  it('replays EVERY table on the message, in a deterministic order (message_id is not unique)', () => {
    const db = freshDb().db
    const { conversationId, answer } = seedChatTurnWithTable(db)
    // A second row on the same message, stamped later so the order is unambiguous.
    expect(
      saveResultTable(db, {
        messageId: answer.id,
        conversationId,
        table: SECOND_TABLE,
        source: 'app:bank-statement',
        now: () => '2099-01-01T00:00:00.000Z'
      })
    ).toBe(true)
    const before = rawResultTables(db, answer.id)
    expect(before).toHaveLength(2)

    const snapshot = deleteLastAssistantMessage(db, conversationId)
    expect(snapshot).not.toBeNull()
    expect(totalResultTables(db)).toBe(0) // the FK cascade took both

    restoreMessage(db, snapshot!)
    expect(rawResultTables(db, answer.id)).toEqual(before)
    // `loadResultTable` reads the newest row, so the ordering the replay preserves is observable.
    expect(loadResultTable(db, answer.id)).toEqual(SECOND_TABLE)
  })

  it('a table-less answer round-trips unchanged (the common case adds nothing)', () => {
    const db = freshDb().db
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })
    const answer = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'pong'
    })

    const snapshot = deleteLastAssistantMessage(db, conv.id)
    expect(snapshot).not.toBeNull()
    restoreMessage(db, snapshot!)

    expect(totalResultTables(db)).toBe(0)
    const restored = listMessages(db, conv.id).at(-1)
    expect(restored?.id).toBe(answer.id)
    expect(restored?.content).toBe('pong')
    expect(restored?.hasResultTable).toBeUndefined()
  })
})
