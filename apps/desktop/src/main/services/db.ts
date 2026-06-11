import { createRequire } from 'node:module'

// SQLite storage via Node's built-in driver (no native compilation).
// Requires the bundled Node >= 22.5; Electron is pinned ^37 (Node 22.x) so the packaged
// main process has node:sqlite (Electron 33 bundles Node 20 and lacks it). See BUILD_STATE.md §3.
// Encrypted-at-rest mode (Phase 9) wraps this same file/schema.
//
// node:sqlite is experimental and not listed in module.builtinModules, which
// makes bundlers (Vite/esbuild) try to resolve a non-existent "sqlite" package.
// Loading it through createRequire keeps the specifier opaque to bundlers so it
// resolves natively at runtime in both Electron's main process and vitest.
const nodeRequire = createRequire(process.execPath)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

export type Db = InstanceType<typeof DatabaseSync>

// Schema mirrors spec §8. `IF NOT EXISTS` makes migration idempotent.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  model_id TEXT,
  mode TEXT NOT NULL DEFAULT 'chat'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  token_count INTEGER,
  citations_json TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_path TEXT,
  stored_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_label TEXT NOT NULL,
  page_number INTEGER,
  section_label TEXT,
  token_count INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY,
  embedding_model_id TEXT NOT NULL,
  vector_blob BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
`

// Additive column migrations on top of the spec §8 base schema. `CREATE TABLE IF NOT
// EXISTS` never alters an existing table, so columns added after a workspace was created
// must be ALTERed in — guarded by a pragma check to stay idempotent.
//   conversations.scope_json — Phase 17 (plan §5.3, decision D2): the optional
//   "ask selected documents" scope, a JSON array of document ids (NULL = whole corpus).
//   documents.summary_json — Phase 33 (wave-3 plan §6, decision D25): the persisted
//   one-click summary `{ text, modelId, createdAt, truncated }` (NULL = none).
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

// Phase 21 (retrieval-plan §5): the FTS5 keyword index over chunk text, used by hybrid
// retrieval. SELF-CONTAINED (text + chunk_id UNINDEXED), deliberately NOT an
// external-content table keyed on chunks' implicit rowid — `chunks.id` is a TEXT PK, so
// the table has only an implicit rowid, and VACUUM is documented to renumber those,
// which would silently desync an external-content index. Sync is via triggers so no
// ingest/reindex/delete code path can ever miss it; the one-time backfill makes a
// pre-Phase-21 workspace searchable on first open after upgrade (guarded additive
// migration — the scope_json precedent). FTS5 availability in BOTH runtimes (Electron's
// bundled Node + system Node) was verified for this phase (retrieval-plan §1.2).
function ensureChunksFts(db: Db): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_fts'")
    .get() as unknown as { name: string } | undefined
  if (exists) return
  db.exec(`
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

INSERT INTO chunks_fts(text, chunk_id) SELECT text, id FROM chunks;
`)
}

// Phase 31 (wave-3 plan §4): the FTS5 index over message text, used by conversation
// search. Mirrors `ensureChunksFts` exactly — self-contained (NOT external-content,
// same VACUUM rationale), trigger-synced so no chat code path can miss it (message
// content is never UPDATEd by current code; the third trigger is cheap
// defense-in-depth), and a one-time guarded backfill makes a pre-Phase-31 workspace
// searchable on first open after upgrade. Messages are persisted with think blocks
// already stripped (Phase 20 D6), so reasoning text can never be indexed. FTS5 +
// snippet()/highlight() availability in BOTH runtimes was re-verified for this phase
// (research gate R-S1, 2026-06-11).
function ensureMessagesFts(db: Db): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'")
    .get() as unknown as { name: string } | undefined
  if (exists) return
  db.exec(`
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
END;

INSERT INTO messages_fts(content, message_id) SELECT content, id FROM messages;
`)
}

/** Open (or create) the database at `path` and run migrations. */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  ensureColumn(db, 'conversations', 'scope_json', 'scope_json TEXT')
  ensureColumn(db, 'documents', 'summary_json', 'summary_json TEXT')
  ensureChunksFts(db)
  ensureMessagesFts(db)
  return db
}

/** List of table names — used by tests/diagnostics to confirm migration ran. */
export function listTables(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}
