import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation, deleteConversation, deleteLastAssistantMessage, searchMessages } from '../../src/main/services/chat'

// CODE-4 (full audit 2026-07-11) — the FTS5 delete triggers used `DELETE FROM <fts> WHERE
// chunk_id/message_id = old.id`: FTS5 has no index on UNINDEXED columns, so EVERY per-row
// trigger firing full-scanned the `%_content` shadow table (measured 3536 ms vs 29 ms — 123× —
// for one 250-chunk document delete on a 50k-chunk corpus, synchronous on the main process).
// The fix: a `fts_rowid` handle column on `chunks`/`messages`, maintained by the AI/AU
// triggers via `last_insert_rowid()`, so the AD/AU deletes are O(log N) rowid lookups. Legacy
// rows (fts_rowid NULL) keep the old predicate via a WHEN-split fallback trigger, so
// correctness never regresses — including under a rolled-back binary, because the triggers
// live in the DB file itself (everything below drives plain SQL, exactly what an older binary
// executes against a migrated workspace).

const nodeRequire = createRequire(process.execPath)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-ftsrowid-')), 'test.sqlite'))
}

const WORDS = ['invoice', 'solar', 'panel', 'contract', 'payment', 'delivery', 'warranty', 'amount', 'total', 'clause']

/** ~50k chunks / ~30 MB text across 200 docs — the report's measurement fixture. */
function seedLargeCorpus(db: Db, docs = 200, chunksPerDoc = 250): void {
  const now = new Date().toISOString()
  const insDoc = db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  )
  const insChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at)
     VALUES (?, ?, ?, ?, 'perf.txt', ?)`
  )
  db.exec('BEGIN')
  let n = 0
  for (let d = 0; d < docs; d++) {
    insDoc.run(`doc-${d}`, `doc-${d}.txt`, now, now)
    for (let c = 0; c < chunksPerDoc; c++) {
      const text = Array.from({ length: 80 }, (_, i) => WORDS[(n + i) % 10] + (n % 977)).join(' ')
      insChunk.run(`chunk-${d}-${c}`, `doc-${d}`, c, text, now)
      n++
    }
  }
  db.exec('COMMIT')
}

function chunkFtsRows(db: Db): Array<{ rowid: number; chunk_id: string; text: string }> {
  return db
    .prepare('SELECT rowid, chunk_id, text FROM chunks_fts ORDER BY chunk_id')
    .all() as unknown as Array<{ rowid: number; chunk_id: string; text: string }>
}

function triggerSql(db: Db, name: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(name) as unknown as { sql: string } | undefined
  return row?.sql
}

function eqpDetail(db: Db, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as Array<{ detail: string }>
  return rows.map((r) => r.detail).join(' | ')
}

describe('CODE-4 — FTS delete triggers are rowid-targeted (timing + plan)', () => {
  it('deletes a 250-chunk document from a 50k-chunk corpus in ≤ 500 ms (was ~3.5 s via the chunk_id scan)', () => {
    const db = freshDb()
    seedLargeCorpus(db)
    const t0 = performance.now()
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run('doc-100')
    const elapsed = performance.now() - t0
    // Pre-fix this is ~3500 ms (250 firings × one full shadow-table scan). Post-fix the rowid
    // path measured ~3 ms. The bound was 100 ms ("wide CI headroom") but starved shared runners
    // flaked it twice in five days in two modes (112.57 ms on ubuntu 2026-07-23; whole-test
    // 15 s vitest timeouts during seeding on windows 2026-07-19 + 2026-07-23) — issue #84.
    // 500 ms still fails a real scan regression by 7×, and the EXPLAIN-QUERY-PLAN test below
    // is the noise-free structural guard against the scan path returning either way. The
    // explicit 60 s per-test timeout covers the ~30 MB corpus seeding on a slow runner (the
    // global 15 s budget was the second flake mode).
    expect(elapsed).toBeLessThanOrEqual(500)
    // And the delete was complete — trigger sync holds.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunk_id LIKE 'chunk-100-%'").get() as unknown as { n: number }).n
    ).toBe(0)
  }, 60_000)

  it('the AD/AU trigger bodies target rowid (O(log N) lookup), with the legacy chunk_id predicate only in the NULL-fallback twins', () => {
    const db = freshDb()
    // The hot-path triggers are rowid-targeted…
    expect(triggerSql(db, 'chunks_fts_ad')).toContain('rowid = old.fts_rowid')
    expect(triggerSql(db, 'chunks_fts_au')).toContain('rowid = old.fts_rowid')
    expect(triggerSql(db, 'messages_fts_ad')).toContain('rowid = old.fts_rowid')
    expect(triggerSql(db, 'messages_fts_au')).toContain('rowid = old.fts_rowid')
    // …and the WHEN-split legacy fallbacks keep the old predicate for fts_rowid-NULL rows.
    expect(triggerSql(db, 'chunks_fts_ad_legacy')).toContain('chunk_id = old.id')
    expect(triggerSql(db, 'messages_fts_ad_legacy')).toContain('message_id = old.id')

    // EXPLAIN QUERY PLAN: a rowid-constrained FTS5 delete plans as a rowid lookup
    // (idxStr '=' → "INDEX 0:="), NOT the bare full scan ("INDEX 0:") the old
    // chunk_id predicate produces. This is the plan-level proof the trigger body's
    // hot statement no longer scans.
    expect(eqpDetail(db, 'DELETE FROM chunks_fts WHERE rowid = 42')).toMatch(/VIRTUAL TABLE INDEX 0:=/)
    expect(eqpDetail(db, "DELETE FROM chunks_fts WHERE chunk_id = 'x'")).toMatch(/VIRTUAL TABLE INDEX 0:($| )/)
    expect(eqpDetail(db, 'DELETE FROM messages_fts WHERE rowid = 42')).toMatch(/VIRTUAL TABLE INDEX 0:=/)
  })
})

describe('CODE-4 — fts_rowid sync via plain SQL (what any binary, incl. a rolled-back one, executes)', () => {
  it('insert/update/delete keep chunks.fts_rowid in lock-step with the FTS rowid and the index exact', () => {
    const db = freshDb()
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d1','a.txt','indexed',?,?)`).run(now, now)
    const ins = db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at) VALUES (?, 'd1', ?, ?, 'a.txt', ?)`
    )
    ins.run('c1', 0, 'alpha text', now)
    ins.run('c2', 1, 'beta text', now)
    const handles = db
      .prepare('SELECT id, fts_rowid FROM chunks ORDER BY id')
      .all() as unknown as Array<{ id: string; fts_rowid: number | null }>
    // The AI trigger stamped each chunk with its FTS rowid (last_insert_rowid() inside the
    // trigger body reflects the trigger's own FTS insert — probed on node:sqlite/SQLite 3.50).
    for (const h of handles) {
      expect(h.fts_rowid).not.toBeNull()
      const fts = db.prepare('SELECT chunk_id FROM chunks_fts WHERE rowid = ?').get(h.fts_rowid) as unknown as { chunk_id: string }
      expect(fts.chunk_id).toBe(h.id)
    }

    // UPDATE OF text: old FTS row replaced, handle re-stamped to the NEW rowid.
    db.prepare("UPDATE chunks SET text = 'edited text' WHERE id = 'c1'").run()
    const c1 = db.prepare("SELECT fts_rowid FROM chunks WHERE id = 'c1'").get() as unknown as { fts_rowid: number }
    const ftsC1 = db.prepare('SELECT text FROM chunks_fts WHERE rowid = ?').get(c1.fts_rowid) as unknown as { text: string }
    expect(ftsC1.text).toBe('edited text')
    expect(chunkFtsRows(db)).toHaveLength(2)

    // DELETE: the rowid-targeted trigger removes exactly the right FTS row.
    db.prepare("DELETE FROM chunks WHERE id = 'c1'").run()
    expect(chunkFtsRows(db).map((r) => r.chunk_id)).toEqual(['c2'])
  })

  it('a legacy row (fts_rowid NULL) still deletes its FTS entry via the fallback predicate', () => {
    const db = freshDb()
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d1','a.txt','indexed',?,?)`).run(now, now)
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at) VALUES ('c1','d1',0,'legacy text','a.txt',?)`
    ).run(now)
    // Simulate a pre-migration row: FTS entry present, handle column NULL.
    db.prepare('UPDATE chunks SET fts_rowid = NULL WHERE id = ?').run('c1')
    db.prepare('DELETE FROM chunks WHERE id = ?').run('c1')
    expect(chunkFtsRows(db)).toHaveLength(0)
  })

  it('messages: plain rows carry the handle, compaction rows stay unindexed with a NULL handle, and regenerate/conversation deletes stay exact', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'zork question' })
    // A compaction checkpoint row (mid-transcript, where a real checkpoint sits) must not
    // enter conversation search (R8) and therefore carries no FTS handle (permanently NULL —
    // its AD firing takes the WHEN-guarded legacy twin, which excludes compaction kinds and
    // so never scans for it).
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, kind) VALUES ('cp1', ?, 'assistant', 'secret summary', ?, 'compaction')`
    ).run(conv.id, new Date().toISOString())
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'zork answer' })
    const rows = db
      .prepare('SELECT id, kind, fts_rowid FROM messages ORDER BY rowid')
      .all() as unknown as Array<{ id: string; kind: string | null; fts_rowid: number | null }>
    for (const r of rows) {
      if (r.kind === 'compaction') expect(r.fts_rowid).toBeNull()
      else expect(r.fts_rowid).not.toBeNull()
    }
    expect(searchMessages(db, 'secret summary')).toHaveLength(0)
    expect(searchMessages(db, 'zork').length).toBeGreaterThan(0)

    // Regenerate path: deleting the last assistant reply removes exactly its FTS row.
    deleteLastAssistantMessage(db, conv.id)
    const ftsCount = (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as unknown as { n: number }).n
    expect(ftsCount).toBe(1) // only the user turn remains indexed
    // Conversation delete (messages incl. the compaction row) leaves no FTS residue.
    deleteConversation(db, conv.id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as unknown as { n: number }).n).toBe(0)
  })
})

describe('CODE-4 — migration of a pre-fix workspace (idempotent, backfilled)', () => {
  /**
   * Build an on-disk DB exactly as the PRE-CODE-4 binary left it: current base tables (the
   * ensureColumn migrations tolerate missing columns), the FTS tables, and the OLD
   * chunk_id/message_id-scanning trigger set — with data already indexed.
   */
  function buildPreMigrationDb(): string {
    const path = join(mkdtempSync(join(tmpdir(), 'hilbertraum-ftsrowid-mig-')), 'old.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`
CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, original_path TEXT, stored_path TEXT,
  mime_type TEXT, size_bytes INTEGER, sha256 TEXT, status TEXT NOT NULL, error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL, source_label TEXT NOT NULL, page_number INTEGER, section_label TEXT,
  token_count INTEGER, created_at TEXT NOT NULL);
CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL DEFAULT 'chat');
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL, token_count INTEGER, citations_json TEXT, kind TEXT);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, chunk_id UNINDEXED);
CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(text, chunk_id) VALUES (new.text, new.id);
END;
CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;
CREATE TRIGGER chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
  INSERT INTO chunks_fts(text, chunk_id) VALUES (new.text, new.id);
END;
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind IS NOT 'compaction' BEGIN
  INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(content, message_id)
    SELECT new.content, new.id WHERE new.kind IS NOT 'compaction';
END;
INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d1','a.txt','indexed','2026-01-01','2026-01-01');
INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at)
  VALUES ('c1','d1',0,'legacy invoice text','a.txt','2026-01-01'),
         ('c2','d1',1,'legacy solar text','a.txt','2026-01-01');
INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('v1','t','2026-01-01','2026-01-01');
INSERT INTO messages (id, conversation_id, role, content, created_at)
  VALUES ('m1','v1','user','old zork question','2026-01-01');
`)
    old.close()
    return path
  }

  it('opening twice migrates once: triggers rewritten, handles backfilled, no duplicate FTS rows, search intact', () => {
    const path = buildPreMigrationDb()
    const db = openDatabase(path)

    // Triggers were rewritten to the rowid-targeted set + fallback twins.
    expect(triggerSql(db, 'chunks_fts_ad')).toContain('rowid = old.fts_rowid')
    expect(triggerSql(db, 'chunks_fts_ad_legacy')).toContain('chunk_id = old.id')
    expect(triggerSql(db, 'messages_fts_ad')).toContain('rowid = old.fts_rowid')

    // Backfill joined the existing FTS rows onto the new handle column.
    const handles = db
      .prepare('SELECT id, fts_rowid FROM chunks ORDER BY id')
      .all() as unknown as Array<{ id: string; fts_rowid: number | null }>
    expect(handles).toHaveLength(2)
    for (const h of handles) {
      expect(h.fts_rowid).not.toBeNull()
      const fts = db.prepare('SELECT chunk_id FROM chunks_fts WHERE rowid = ?').get(h.fts_rowid) as unknown as { chunk_id: string }
      expect(fts.chunk_id).toBe(h.id)
    }
    const msg = db.prepare("SELECT fts_rowid FROM messages WHERE id = 'm1'").get() as unknown as { fts_rowid: number | null }
    expect(msg.fts_rowid).not.toBeNull()
    expect(searchMessages(db, 'zork')).toHaveLength(1)

    // Idempotence — the whole game: a second open must not error, not duplicate FTS rows,
    // and not disturb the handles.
    db.close()
    const again = openDatabase(path)
    expect(chunkFtsRows(again)).toHaveLength(2)
    expect(
      (again.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as unknown as { n: number }).n
    ).toBe(1)
    // Migrated rows now delete via the rowid path (and completely).
    again.prepare("DELETE FROM chunks WHERE document_id = 'd1'").run()
    expect(chunkFtsRows(again)).toHaveLength(0)
  })

  it('a pre-FTS workspace (no chunks_fts at all) gets the new triggers AND handles in one open', () => {
    // The pre-Phase-21 shape from hybrid-search.test.ts: chunks exist, no FTS table.
    const path = join(mkdtempSync(join(tmpdir(), 'hilbertraum-ftsrowid-prefts-')), 'old.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, original_path TEXT, stored_path TEXT,
      mime_type TEXT, size_bytes INTEGER, sha256 TEXT, status TEXT NOT NULL,
      error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    old.exec(`CREATE TABLE chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL, source_label TEXT NOT NULL, page_number INTEGER,
      section_label TEXT, token_count INTEGER, created_at TEXT NOT NULL)`)
    old.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at)
       VALUES ('legacy-chunk', 'doc1', 0, 'legacy invoice text', 'old.pdf', '2026-01-01')`
    ).run()
    old.close()

    const db = openDatabase(path)
    const row = db.prepare("SELECT fts_rowid FROM chunks WHERE id = 'legacy-chunk'").get() as unknown as { fts_rowid: number | null }
    expect(row.fts_rowid).not.toBeNull()
    expect(triggerSql(db, 'chunks_fts_ad')).toContain('rowid = old.fts_rowid')
    db.prepare("DELETE FROM chunks WHERE id = 'legacy-chunk'").run()
    expect(chunkFtsRows(db)).toHaveLength(0)
  })

  // ---- CODE-4 review follow-up: the migration is crash-atomic AND self-healing --------
  //
  // Two holes the review found in the first cut: (a) the upgrade's multi-statement DDL exec
  // auto-committed per statement, so a kill mid-upgrade could leave a torn trigger set — and
  // the sentinel's `!row` early-return (copied from the kind-filter idiom, where a missing
  // trigger is unreachable) turned exactly that torn state into a PERMANENT silent failure
  // (deletes stop maintaining the index → ghost search hits); (b) the sentinel-matching
  // CREATEs could commit while the separately-committed backfill was lost, parking the whole
  // corpus on the legacy scan path forever. Fixed by (i) running DROPs + CREATEs + backfill in
  // ONE transaction (a crash rolls back to the intact pre-migration state and the sentinel
  // retries) and (ii) flipping the sentinel so a MISSING AD trigger means "must upgrade" (the
  // DDL is DROP-IF-EXISTS-safe, so re-running against any torn state repairs it).

  it('crash mid-upgrade rolls back atomically: the old triggers stay intact and the next open retries to completion', () => {
    const path = buildPreMigrationDb()
    // A hostile trigger that fires on the backfill's UPDATE — the crash-equivalent injection:
    // the upgrade transaction dies AFTER its DDL ran but BEFORE the backfill finished.
    const raw = new DatabaseSync(path)
    raw.exec(`CREATE TRIGGER boom AFTER UPDATE ON chunks BEGIN SELECT RAISE(ABORT, 'torn-mid-upgrade'); END;`)
    raw.close()

    expect(() => openDatabase(path)).toThrow(/torn-mid-upgrade/)

    // Rollback proof: NOTHING of the half-run upgrade committed — the OLD (pre-fix) AD
    // trigger is intact and no _legacy twin exists, so the sentinel will retry.
    const inspect = new DatabaseSync(path)
    const ad = inspect
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='chunks_fts_ad'")
      .get() as unknown as { sql: string } | undefined
    expect(ad?.sql).toContain('chunk_id = old.id')
    expect(ad?.sql).not.toContain('fts_rowid')
    expect(
      inspect.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='chunks_fts_ad_legacy'").get()
    ).toEqual({ n: 0 })
    inspect.exec('DROP TRIGGER boom')
    inspect.close()

    // With the injected failure gone, the retry completes the whole migration.
    const db = openDatabase(path)
    expect(triggerSql(db, 'chunks_fts_ad')).toContain('rowid = old.fts_rowid')
    const handles = db
      .prepare('SELECT fts_rowid FROM chunks')
      .all() as unknown as Array<{ fts_rowid: number | null }>
    expect(handles.length).toBeGreaterThan(0)
    for (const h of handles) expect(h.fts_rowid).not.toBeNull()
    expect(searchMessages(db, 'zork')).toHaveLength(1)
  })

  it('a torn trigger state (AD dropped, handles lost) self-heals on the next open instead of failing silently forever', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hilbertraum-ftsrowid-torn-')), 'test.sqlite')
    const db = openDatabase(path)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d1','a.txt','indexed',?,?)`).run(now, now)
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at) VALUES ('c1','d1',0,'alpha text','a.txt',?)`
    ).run(now)
    // Simulate the worst torn state a non-atomic upgrade could have left: the sentinel (AD)
    // trigger and its AU sibling gone, and the backfill lost (NULL handles). Pre-flip, the
    // sentinel's `!row` branch bailed here permanently.
    db.exec('DROP TRIGGER chunks_fts_ad; DROP TRIGGER chunks_fts_au; DROP TRIGGER messages_fts_ad;')
    db.prepare('UPDATE chunks SET fts_rowid = NULL').run()
    db.close()

    const healed = openDatabase(path)
    expect(triggerSql(healed, 'chunks_fts_ad')).toContain('rowid = old.fts_rowid')
    expect(triggerSql(healed, 'chunks_fts_au')).toContain('rowid = old.fts_rowid')
    expect(triggerSql(healed, 'messages_fts_ad')).toContain('rowid = old.fts_rowid')
    // The re-run backfill re-stamped the lost handles…
    const c1 = healed.prepare("SELECT fts_rowid FROM chunks WHERE id = 'c1'").get() as unknown as { fts_rowid: number | null }
    expect(c1.fts_rowid).not.toBeNull()
    // …and deletes maintain the index again (the silent-ghost-hits failure is repaired).
    healed.prepare("DELETE FROM chunks WHERE id = 'c1'").run()
    expect(chunkFtsRows(healed)).toHaveLength(0)
  })
})
