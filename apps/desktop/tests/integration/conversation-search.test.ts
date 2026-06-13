import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Phase 31 (wave-3 plan §4): conversation search — the messages_fts guarded migration +
// backfill, trigger sync (incl. conversation delete), the shared MATCH sanitizer,
// bm25 ranking with the newest-first tie-break (D23), snippet highlight markers, and
// the privacy sentinel (a search writes NO audit row — queries/snippets are content).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { openDatabase, type Db } from '../../src/main/services/db'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  searchMessages
} from '../../src/main/services/chat'
import { buildFtsMatchQuery } from '../../src/main/services/fts'
import { buildFtsMatchQuery as buildFtsMatchQueryFromHybrid } from '../../src/main/services/rag/hybrid'
import { createAuditRecorder } from '../../src/main/services/audit'
import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { IPC } from '../../src/shared/ipc'
import { SEARCH_MARK_END, SEARCH_MARK_START } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-search-')), 'test.sqlite'))
}

function ftsRows(db: Db): Array<{ content: string; message_id: string }> {
  return db
    .prepare('SELECT content, message_id FROM messages_fts ORDER BY message_id')
    .all() as unknown as Array<{ content: string; message_id: string }>
}

/** Insert a message with a CONTROLLED created_at (appendMessage always uses now). */
function insertMessageAt(
  db: Db,
  conversationId: string,
  id: string,
  content: string,
  createdAt: string,
  role: 'user' | 'assistant' = 'user'
): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, createdAt)
}

// ---- Migration + backfill (db.ts ensureMessagesFts) --------------------------------

describe('messages_fts migration', () => {
  it('creates the FTS table and triggers on a fresh database', () => {
    const db = freshDb()
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'messages_fts%'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(names).toContain('messages_fts')
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(triggers).toEqual(
      expect.arrayContaining(['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au'])
    )
  })

  it('backfills a pre-Phase-31 database (existing messages become searchable on open)', () => {
    // A DB with the pre-Phase-31 schema and message rows but no messages_fts — exactly
    // what an upgraded workspace looks like on disk (the chunks_fts backfill precedent).
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-search-mig-'))
    const path = join(dir, 'old.sqlite')
    const nodeRequire = createRequire(process.execPath)
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL DEFAULT 'chat')`)
    old.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL, token_count INTEGER,
      citations_json TEXT)`)
    old.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Old chat', '2026-01-01', '2026-01-01')`
    ).run()
    old.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES ('m1', 'c1', 'assistant', 'the liability cap is two million', '2026-01-01')`
    ).run()
    old.close()

    const db = openDatabase(path)
    expect(ftsRows(db)).toEqual([{ content: 'the liability cap is two million', message_id: 'm1' }])
    // Backfill happens ONCE: re-opening must not duplicate rows.
    const again = openDatabase(path)
    expect(ftsRows(again)).toHaveLength(1)
    // And the backfilled message is found end-to-end.
    const results = searchMessages(again, 'liability cap')
    expect(results).toHaveLength(1)
    expect(results[0].conversationTitle).toBe('Old chat')
  })
})

describe('messages_fts trigger sync', () => {
  it('keeps the index exact across insert and conversation delete', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'alpha question' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'alpha answer' })
    const keep = createConversation(db, {})
    appendMessage(db, { conversationId: keep.id, role: 'user', content: 'beta question' })
    expect(ftsRows(db)).toHaveLength(3)

    // deleteConversation removes messages via SQL DELETE → the FTS delete trigger MUST
    // fire (no CASCADE involved) and only the deleted conversation's rows go.
    deleteConversation(db, conv.id)
    expect(ftsRows(db).map((r) => r.content)).toEqual(['beta question'])
    expect(searchMessages(db, 'alpha')).toEqual([])
    expect(searchMessages(db, 'beta')).toHaveLength(1)
  })

  it('covers UPDATE OF content (defense-in-depth — no current code path updates it)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const msg = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'original text' })
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('edited text', msg.id)
    expect(ftsRows(db).map((r) => r.content)).toEqual(['edited text'])
  })
})

// ---- Sanitizer reuse ----------------------------------------------------------------

describe('search query sanitization', () => {
  it('reuses the ONE shared sanitizer (hybrid re-exports services/fts)', () => {
    expect(buildFtsMatchQueryFromHybrid).toBe(buildFtsMatchQuery)
  })

  it('FTS5 operator syntax in the query never reaches MATCH raw', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'a note about near misses' })
    // Operator-laden queries must not throw and match as plain tokens.
    expect(() => searchMessages(db, 'NEAR(misses) AND "x*" -')).not.toThrow()
    expect(searchMessages(db, 'NEAR(misses)')).toHaveLength(1)
  })

  it('returns [] for token-less queries and limit <= 0', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'alpha' })
    expect(searchMessages(db, '?! …')).toEqual([])
    expect(searchMessages(db, '')).toEqual([])
    expect(searchMessages(db, 'alpha', 0)).toEqual([])
  })
})

// ---- Ranking, grouping, snippets (D23) -----------------------------------------------

describe('searchMessages ranking + grouping', () => {
  it('ranks by bm25 (a term-dense short message beats a long one)', () => {
    const db = freshDb()
    const a = createConversation(db, { title: 'dense' })
    const b = createConversation(db, { title: 'dilute' })
    insertMessageAt(db, a.id, 'short', 'liability', '2026-01-01T00:00:00.000Z')
    insertMessageAt(
      db,
      b.id,
      'long',
      'somewhere in this much longer reply the word liability appears once among many other words',
      '2026-01-02T00:00:00.000Z'
    )
    const results = searchMessages(db, 'liability')
    expect(results.map((r) => r.conversationTitle)).toEqual(['dense', 'dilute'])
  })

  it('breaks bm25 ties newest-first, deterministically (D23)', () => {
    const db = freshDb()
    const a = createConversation(db, { title: 'older' })
    const b = createConversation(db, { title: 'newer' })
    // Identical content → identical bm25. The NEWER message is inserted FIRST so a
    // rowid-based order would invert it — created_at must decide.
    insertMessageAt(db, b.id, 'm-new', 'identical liability words', '2026-02-02T00:00:00.000Z')
    insertMessageAt(db, a.id, 'm-old', 'identical liability words', '2026-01-01T00:00:00.000Z')
    const results = searchMessages(db, 'liability')
    expect(results.map((r) => r.conversationTitle)).toEqual(['newer', 'older'])
    // Determinism: identical call, identical order.
    expect(searchMessages(db, 'liability')).toEqual(results)
  })

  it('groups hits per conversation, ordered by each conversation’s best hit', () => {
    const db = freshDb()
    const a = createConversation(db, { title: 'A' })
    const b = createConversation(db, { title: 'B' })
    insertMessageAt(db, a.id, 'a1', 'zork', '2026-01-01T00:00:00.000Z') // best overall (short)
    insertMessageAt(db, b.id, 'b1', 'a middling zork mention here', '2026-01-02T00:00:00.000Z')
    insertMessageAt(
      db,
      a.id,
      'a2',
      'a much longer trailing message where zork appears among many many other words indeed',
      '2026-01-03T00:00:00.000Z'
    )
    const results = searchMessages(db, 'zork')
    // A leads (its best hit is rank 1) and carries BOTH of its hits, best first.
    expect(results.map((r) => r.conversationTitle)).toEqual(['A', 'B'])
    expect(results[0].hits.map((h) => h.messageId)).toEqual(['a1', 'a2'])
    expect(results[1].hits.map((h) => h.messageId)).toEqual(['b1'])
  })

  it('wraps matched terms in the SEARCH_MARK markers and respects the limit', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'the liability cap is two million euros per occurrence'
    })
    const [result] = searchMessages(db, 'liability')
    expect(result.hits[0].snippet).toContain(`${SEARCH_MARK_START}liability${SEARCH_MARK_END}`)
    expect(result.hits[0].role).toBe('assistant')

    for (let i = 0; i < 5; i++) {
      appendMessage(db, { conversationId: conv.id, role: 'user', content: `liability note ${i}` })
    }
    const capped = searchMessages(db, 'liability', 3)
    expect(capped.reduce((n, r) => n + r.hits.length, 0)).toBe(3)
  })
})

// ---- IPC + privacy sentinel ----------------------------------------------------------

describe('chat:search IPC', () => {
  it('answers over IPC and writes NO audit row (queries/snippets are content)', async () => {
    ipcState.handlers.clear()
    const db = freshDb()
    const conv = createConversation(db, { title: 'Contract talk' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'what is the liability cap?' })
    const audit = createAuditRecorder(() => db)
    const ctx = {
      db,
      runtime: { active: () => null, activeModelId: () => null },
      audit
    } as unknown as AppContext
    registerChatIpc(ctx)

    const { result } = await invoke(handlers, IPC.searchConversations, 'liability')
    const results = result as Array<{ conversationTitle: string }>
    expect(results).toHaveLength(1)
    expect(results[0].conversationTitle).toBe('Contract talk')

    // The sentinel: a search must leave runtime_events EMPTY — reads are not audited,
    // and neither the query nor a snippet may ever land there (Phase-19 privacy rule).
    const events = db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as unknown as {
      n: number
    }
    expect(events.n).toBe(0)

    // Junk input degrades to an empty result, never a throw.
    const junk = await invoke(handlers, IPC.searchConversations, undefined)
    expect(junk.result).toEqual([])
  })
})
