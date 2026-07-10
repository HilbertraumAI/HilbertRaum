import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Data-layer hardening (full audit 2026-06-28, Phase 5). Atomicity + the per-conversation
// checkpoint index + the polymorphic tree_edges invariant:
//   REL-4  — deleteConversation is ONE transaction (no half-deleted empty thread on a mid-delete crash).
//   PERF-3 — getLatestCheckpoint (every chat turn) is served by idx_messages_conv_kind, not a partial scan.
//   DATA-2 — tree_edges.child_id is a polymorphic FK (chunks.id OR tree_nodes.id) with no FK to chunks;
//            the no-dangling-edge invariant is upheld only because every chunk-delete path also tears
//            down the document's tree_nodes (cascading the edges). This pins that invariant + its teeth.
// (REL-5 lives in image-history.test.ts, DATA-1 in conversation-search.test.ts, DATA-3 in
//  whole-doc-extract.test.ts, PERF-4 in summary-cache-eviction.test.ts — each next to its own infra.)

import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation, deleteConversation } from '../../src/main/services/chat'
import { deleteDocument } from '../../src/main/services/ingestion'

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-datalayer-')), 'test.sqlite'))
}

/** EXPLAIN QUERY PLAN for `sql`, flattened to one string for substring assertions. */
function plan(db: Db, sql: string, ...params: unknown[]): string {
  return (
    db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(params as never[])) as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join(' | ')
}

// ---- REL-4 — deleteConversation atomicity ------------------------------------------------

describe('deleteConversation atomicity (REL-4)', () => {
  function seedConversation(db: Db): { id: string; messageCount: number } {
    const conv = createConversation(db, { title: 'thread' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'question one' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'answer one' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'question two' })
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv.id) as {
        n: number
      }
    ).n
    return { id: conv.id, messageCount: n }
  }

  const msgCount = (db: Db, convId: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId) as {
      n: number
    }).n
  const convCount = (db: Db, convId: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(convId) as {
      n: number
    }).n

  it('deletes the conversation and all its messages in the happy path', () => {
    const db = freshDb()
    const { id } = seedConversation(db)
    expect(deleteConversation(db, id)).toBe(true)
    expect(convCount(db, id)).toBe(0)
    expect(msgCount(db, id)).toBe(0)
  })

  it('rolls back BOTH deletes when the conversations delete fails mid-transaction (no half-delete)', () => {
    const db = freshDb()
    const { id, messageCount } = seedConversation(db)

    // Inject a failure on the SECOND delete (conversations), after the messages delete has run
    // inside the transaction. The wrap must ROLLBACK so neither delete persists. We only override
    // the conversations-delete `.run`; everything else (BEGIN/COMMIT/ROLLBACK via exec, the
    // messages delete) hits the real connection so the transaction is genuine.
    const wrapped = {
      exec: (sql: string) => db.exec(sql),
      prepare(sql: string) {
        if (sql.includes('DELETE FROM conversations')) {
          return {
            run: () => {
              throw new Error('injected: conversations delete failed mid-transaction')
            }
          }
        }
        return db.prepare(sql)
      }
    } as unknown as Db

    expect(() => deleteConversation(wrapped, id)).toThrow(/injected/)

    // Rolled back: the conversation row AND every message are still present — not an empty thread.
    expect(convCount(db, id)).toBe(1)
    expect(msgCount(db, id)).toBe(messageCount)

    // The connection is not poisoned — a fresh transaction opens cleanly (no dangling BEGIN).
    expect(() => {
      db.exec('BEGIN')
      db.exec('COMMIT')
    }).not.toThrow()
  })

  it('illustrates the half-delete the transaction prevents (the regression guard is the injection test above)', () => {
    // Documentation, not the teeth: this shows the un-transacted REL-4 bug SHAPE directly — an
    // autocommitted messages-delete, then a crash before the conversations-delete leaves messages
    // gone but the conversation row surviving (the orphaned empty thread). The actual regression
    // guard is the injected-failure test above, which drives the real deleteConversation and asserts
    // ROLLBACK; that one fails if the BEGIN…COMMIT wrap is removed (teeth-verified).
    const db = freshDb()
    const { id } = seedConversation(db)
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id) // commits immediately…
    // …and a crash here, before the conversations delete, would leave:
    expect(msgCount(db, id)).toBe(0) // messages gone…
    expect(convCount(db, id)).toBe(1) // …but the conversation row survives — the half-deleted thread
  })
})

// ---- PERF-3 — per-conversation checkpoint index ------------------------------------------

describe('getLatestCheckpoint index (PERF-3)', () => {
  // Mirrors chat.ts getLatestCheckpoint — runs on EVERY chat + grounded turn.
  const GET_LATEST_CHECKPOINT = `SELECT m.rowid AS rowid, m.content AS content, m.covers_through_rowid AS covers
       FROM messages m
       WHERE m.conversation_id = ? AND m.kind = 'compaction'
       ORDER BY m.rowid DESC LIMIT 1`

  // TS-5 (full-audit 2026-07-10): assert index NAMES only, never planner phrasing.
  // EXPLAIN QUERY PLAN detail strings ("SCAN", "USE TEMP B-TREE", "COVERING") are
  // unstable planner output that shifts with the SQLite bundled by the pinned Node
  // (node:sqlite) — a Node upgrade changed them before with no behavior change. Which
  // INDEX the planner picks is the actual PERF-3 contract. If these tests fail right
  // after a Node/Electron bump, triage as expected planner drift first, not a regression.
  it('is served by idx_messages_conv_kind', () => {
    const db = freshDb()
    const p = plan(db, GET_LATEST_CHECKPOINT, 'c1')
    expect(p).toContain('idx_messages_conv_kind')
  })

  it('TEETH: without idx_messages_conv_kind the planner falls back to the conversation-only index', () => {
    const db = freshDb()
    db.exec('DROP INDEX idx_messages_conv_kind')
    const p = plan(db, GET_LATEST_CHECKPOINT, 'c1')
    expect(p).not.toContain('idx_messages_conv_kind')
    // It degrades to idx_messages_conversation, which cannot filter kind in the index — the partial
    // scan PERF-3 removes.
    expect(p).toContain('idx_messages_conversation')
  })

  it('explicitly naming rowid in the index is rejected by SQLite (why the index is (conversation_id, kind))', () => {
    const db = freshDb()
    expect(() =>
      db.exec('CREATE INDEX idx_bad ON messages(conversation_id, kind, rowid)')
    ).toThrow(/no such column: rowid/)
  })
})

// ---- DATA-2 — tree_edges polymorphic FK invariant ----------------------------------------

describe('tree_edges no-dangling-chunk-edge invariant (DATA-2)', () => {
  /** Seed a document with two chunks and a 2-level summary tree whose level-1 edges point at the
   *  chunks (child_is_chunk=1) and whose root edge points at the level-1 node (child_is_chunk=0). */
  function seedDocWithTree(db: Db): { docId: string } {
    const now = new Date().toISOString()
    const docId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
       VALUES (?, 'Doc', 'indexed', 'text/plain', ?, ?)`
    ).run(docId, now, now)
    const chunkIds = [randomUUID(), randomUUID()]
    chunkIds.forEach((cid, i) => {
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
         VALUES (?, ?, ?, ?, 'p', 1, ?)`
      ).run(cid, docId, i, `chunk ${i}`, now)
    })
    const leafNode = randomUUID()
    const rootNode = randomUUID()
    // The root is inserted first: the leaf's parent_id FK references tree_nodes(id).
    db.prepare(
      `INSERT INTO tree_nodes (id, document_id, level, ordinal, parent_id, is_root, summary_text, content_hash, created_at)
       VALUES (?, ?, 2, 0, NULL, 1, 'root summary', 'h2', ?)`
    ).run(rootNode, docId, now)
    db.prepare(
      `INSERT INTO tree_nodes (id, document_id, level, ordinal, parent_id, is_root, summary_text, content_hash, created_at)
       VALUES (?, ?, 1, 0, ?, 0, 'leaf summary', 'h1', ?)`
    ).run(leafNode, docId, rootNode, now)
    const edge = db.prepare(
      `INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, ?, ?)`
    )
    edge.run(leafNode, chunkIds[0], 1, 0) // level-1 edge -> chunk
    edge.run(leafNode, chunkIds[1], 1, 1) // level-1 edge -> chunk
    edge.run(rootNode, leafNode, 0, 0) // root edge -> node
    return { docId }
  }

  /** Edges that claim a chunk child but reference a chunk row that no longer exists. */
  const danglingChunkEdges = (db: Db): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM tree_edges
           WHERE child_is_chunk = 1 AND child_id NOT IN (SELECT id FROM chunks)`
        )
        .get() as { n: number }
    ).n
  const edgeCount = (db: Db): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM tree_edges').get() as { n: number }).n

  it('deleteDocument tears the tree down with the chunks — no edge is left dangling', () => {
    const db = freshDb()
    const { docId } = seedDocWithTree(db)
    expect(edgeCount(db)).toBe(3)
    expect(danglingChunkEdges(db)).toBe(0) // edges reference live chunks

    // The authoritative chunk-delete path also deletes tree_nodes (purgeDocumentDerivatives), so the
    // edges cascade via their parent_id FK — the invariant the polymorphic child_id relies on.
    deleteDocument(db, docId)
    expect(edgeCount(db)).toBe(0) // whole tree gone
    expect(danglingChunkEdges(db)).toBe(0) // invariant holds
  })

  it('TEETH: deleting chunks WITHOUT the tree teardown dangles the chunk edges (the forbidden path)', () => {
    const db = freshDb()
    const { docId } = seedDocWithTree(db)
    // A future chunk-mutating path that skips the tree teardown — exactly what DATA-2 warns against.
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId)
    expect(danglingChunkEdges(db)).toBe(2) // both level-1 edges now point at gone chunks
  })
})
