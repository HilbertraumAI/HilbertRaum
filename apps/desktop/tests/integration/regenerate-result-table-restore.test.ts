import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import type { Db } from '../../src/main/services/db'
import { MockEmbedder } from '../../src/main/services/embeddings'
import {
  appendMessage,
  deleteLastAssistantMessage,
  emptyAssistantMessage,
  listMessages,
  restoreMessage
} from '../../src/main/services/chat'
import { loadResultTable, saveResultTable } from '../../src/main/services/tables/store'
import type { TableSpec } from '../../src/main/services/tables'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { withRegenerateGuard } from '../../src/main/ipc/chat-stream'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { Message } from '../../src/shared/types'
import { seedEmbeddedDoc } from '../helpers/doc-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { driveGuarded, regenWorkspace, seedAnsweredTurn } from '../helpers/regenerate-fixtures'
import { failingRuntime } from '../helpers/scripted-runtime'
import { makeRagAskContext } from '../helpers/skills-world'

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
 *  to capture (and replay) all of them in `created_at ASC, rowid ASC` order. */
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

const WORKSPACE = 'regentable'
type Turn = { conversationId: string; answer: Message }

/** Attach a result table to a seeded answer (the artifact behind its "Export CSV" action). */
function attachTable(db: Db, turn: Turn, table: TableSpec = TABLE): void {
  expect(
    saveResultTable(db, {
      messageId: turn.answer.id,
      conversationId: turn.conversationId,
      table,
      source: 'app:bank-statement'
    })
  ).toBe(true)
}

/** A documents conversation ending in a skill-stamped answer that CARRIES a result table — the
 *  exact shape the bank/analysis "Export CSV" affordance hangs off. */
async function seedDocumentsTurnWithTable(db: Db, embedder: MockEmbedder): Promise<Turn> {
  const docId = await seedEmbeddedDoc(db, embedder, 'statement.pdf', [QUESTION])
  const turn = seedAnsweredTurn(db, {
    question: QUESTION,
    answer: PRIOR_ANSWER,
    mode: 'documents',
    documentIds: [docId],
    citations: [{ label: 'S1', sourceTitle: 'statement.pdf', pageNumber: 1 }],
    skillId: 'app:bank-statement',
    autoFired: true
  })
  attachTable(db, turn)
  return turn
}

/** A plain-CHAT conversation ending in an assistant answer that carries a result table. */
function seedChatTurnWithTable(db: Db): Turn {
  const turn = seedAnsweredTurn(db, { question: QUESTION, answer: PRIOR_ANSWER })
  attachTable(db, turn)
  return turn
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('regenerate restore legs — the answer comes back WITH its result table', () => {
  it('a regenerate whose grounded generation FAILS restores the table byte-identically', async () => {
    const w = regenWorkspace(WORKSPACE)
    const { db } = w
    const embedder = new MockEmbedder()
    const { conversationId, answer } = await seedDocumentsTurnWithTable(db, embedder)
    const before = rawResultTables(db, answer.id)
    expect(before).toHaveLength(1)

    registerRagIpc(makeRagAskContext(w, failingRuntime()).ctx)

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
    const { db } = regenWorkspace(WORKSPACE)
    const { conversationId, answer } = seedChatTurnWithTable(db)
    const before = rawResultTables(db, answer.id)
    expect(before).toHaveLength(1)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      emptyAssistantMessage(conversationId)
    )
    const result = await driveGuarded(wrapped)

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
    const { db } = regenWorkspace(WORKSPACE)
    const { conversationId, answer } = seedChatTurnWithTable(db)
    expect(totalResultTables(db)).toBe(1)

    const wrapped = withRegenerateGuard(db, conversationId, true, async () =>
      appendMessage(db, { conversationId, role: 'assistant', content: 'a fresh answer' })
    )
    const result = await driveGuarded(wrapped)

    expect(result.content).toBe('a fresh answer')
    const history = listMessages(db, conversationId)
    expect(history.some((m) => m.id === answer.id)).toBe(false) // the old reply is gone…
    expect(rawResultTables(db, answer.id)).toEqual([]) // …and its table went with it
    expect(totalResultTables(db)).toBe(0)
    expect(history.at(-1)?.hasResultTable).toBeUndefined()
  })
})

describe('deleted-message snapshot — result-table capture and replay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replays EVERY table on the message; the newest stays the exported one (message_id is not unique)', () => {
    const { db } = regenWorkspace(WORKSPACE)
    const turn = seedAnsweredTurn(db, { question: QUESTION, answer: PRIOR_ANSWER })
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'))
    attachTable(db, turn)
    vi.setSystemTime(new Date('2026-03-01T10:00:01.000Z'))
    attachTable(db, turn, SECOND_TABLE)
    vi.useRealTimers()
    const before = rawResultTables(db, turn.answer.id)
    expect(before.map((r) => r.created_at)).toEqual(['2026-03-01T10:00:00.000Z', '2026-03-01T10:00:01.000Z'])

    const snapshot = deleteLastAssistantMessage(db, turn.conversationId)
    expect(snapshot).not.toBeNull()
    expect(totalResultTables(db)).toBe(0) // the FK cascade took both
    restoreMessage(db, snapshot!)
    expect(rawResultTables(db, turn.answer.id)).toEqual(before)
    // `loadResultTable` exports the newest row by created_at, which the replay copies verbatim.
    expect(loadResultTable(db, turn.answer.id)).toEqual(SECOND_TABLE)
  })

  // What this row can tell apart: a capture whose tie-break REVERSES equal stamps (`rowid DESC`). It cannot tell a
  // dropped `rowid ASC` from a kept one: the capture reads through idx_result_tables_message, whose entries for one
  // message sit in rowid order, and the ORDER BY sorter keeps that scan order for equal keys, so `ORDER BY created_at
  // ASC` alone already returns equal stamps in rowid order. No input tells them apart (measured on node:sqlite: rowids
  // reassigned out of insertion order, or PRAGMA reverse_unordered_selects, and both queries still agree), so the
  // explicit tie-break is belt and braces.
  it('replays tables stamped in the same millisecond in insertion order; a reversed tie-break fails', () => {
    const { db } = regenWorkspace(WORKSPACE)
    const turn = seedAnsweredTurn(db, { question: QUESTION, answer: PRIOR_ANSWER })
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z')) // one frozen stamp: created_at cannot order these two
    attachTable(db, turn)
    attachTable(db, turn, SECOND_TABLE)
    vi.useRealTimers()
    const before = rawResultTables(db, turn.answer.id)
    expect(before.map((r) => r.created_at)).toEqual(['2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z'])
    expect(before.map((r) => (JSON.parse(r.columns_json) as Array<{ key: string }>)[0]?.key)).toEqual(['date', 'category'])

    restoreMessage(db, deleteLastAssistantMessage(db, turn.conversationId)!)
    // A reversed capture (`rowid DESC`) would re-insert SECOND_TABLE first, and the rowid order below would flip.
    expect(rawResultTables(db, turn.answer.id)).toEqual(before)
  })
})
