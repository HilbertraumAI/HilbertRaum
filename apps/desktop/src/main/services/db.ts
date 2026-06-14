import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

// SQLite storage via Node's built-in driver (no native compilation).
// Requires the bundled Node >= 22.5; Electron is pinned ^37 (Node 22.x) so the packaged
// main process has node:sqlite (Electron 33 bundles Node 20 and lacks it).
// Encrypted-at-rest mode wraps this same file/schema.
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

-- Document organization (architecture.md "Document organization — design record" §3). A collection is
-- the unifying primitive: Projects are collections; Library/Temporary are seeded
-- built-ins; Archive is a lifecycle; Generated is a role/view. Membership never
-- duplicates documents/chunks/embeddings.
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- 'library' | 'project' | 'temporary' | 'archive' | 'smart'
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,  -- 1 for the seeded Library/Temporary (undeletable)
  color TEXT,                          -- optional UI accent; null = neutral
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,                    -- project-level archive (null = active)
  retention_policy_json TEXT           -- reserved for later explicit retention (null in v1)
);
CREATE INDEX IF NOT EXISTS idx_collections_type ON collections(type);

-- Many-to-many document↔collection membership. ON DELETE CASCADE on BOTH FKs is
-- load-bearing for version-skew safety (plan C4): foreign_keys is ON and deleteDocument
-- deletes the documents row directly, so without CASCADE a delete would hit an FK
-- violation and dangling rows; CASCADE makes the orphan membership rows disappear.
CREATE TABLE IF NOT EXISTS document_collections (
  document_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'source', -- 'source' | 'reference' | 'attachment' ('generated' RESERVED, unused in v1)
  added_at TEXT NOT NULL,
  PRIMARY KEY (document_id, collection_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doccoll_collection ON document_collections(collection_id);
CREATE INDEX IF NOT EXISTS idx_doccoll_document ON document_collections(document_id);

-- Temporary chat attachments are bound to their conversation HERE (plan C3), never via
-- scope_json. CASCADE removes only the LINK on conversation delete, never the document.
CREATE TABLE IF NOT EXISTS conversation_documents (
  conversation_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, document_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_convdoc_conversation ON conversation_documents(conversation_id);
CREATE INDEX IF NOT EXISTS idx_convdoc_document ON conversation_documents(document_id);
`

// Additive column migrations on top of the spec §8 base schema. `CREATE TABLE IF NOT
// EXISTS` never alters an existing table, so columns added after a workspace was created
// must be ALTERed in — guarded by a pragma check to stay idempotent.
//   conversations.scope_json — the optional "ask selected documents" scope, a JSON
//   array of document ids (NULL = whole corpus).
//   documents.summary_json — the persisted one-click summary
//   `{ text, modelId, createdAt, truncated }` (NULL = none).
//   documents.origin_json — provenance of an app-generated document — a `DocumentOrigin`
//   (translation `{ translatedFrom, targetLang }` or compare `{ type: 'compare',
//   comparedFrom: [a, b] }`; NULL = normal import).
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  // The arguments are interpolated into SQL (SQLite cannot parameterize DDL). Every
  // caller passes compile-time constants, but assert the shape anyway so a future
  // caller cannot turn this into an injection point.
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/
  if (!ident.test(table) || !ident.test(column) || !/^[A-Za-z0-9_ ]+$/.test(ddl)) {
    throw new Error(`ensureColumn: unsafe identifier/DDL (${table}.${column}: ${ddl})`)
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

// The FTS5 keyword index over chunk text, used by hybrid retrieval (rag-design §11).
// SELF-CONTAINED (text + chunk_id UNINDEXED), deliberately NOT an
// external-content table keyed on chunks' implicit rowid — `chunks.id` is a TEXT PK, so
// the table has only an implicit rowid, and VACUUM is documented to renumber those,
// which would silently desync an external-content index. Sync is via triggers so no
// ingest/reindex/delete code path can ever miss it; the one-time backfill makes an
// older workspace searchable on first open after upgrade (guarded additive migration).
// FTS5 availability in BOTH runtimes (Electron's bundled Node + system Node) is
// verified.
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

// The FTS5 index over message text, used by conversation search.
// Mirrors `ensureChunksFts` exactly — self-contained (NOT external-content,
// same VACUUM rationale), trigger-synced so no chat code path can miss it (message
// content is never UPDATEd by current code; the third trigger is cheap
// defense-in-depth), and a one-time guarded backfill makes an older workspace
// searchable on first open after upgrade. Messages are persisted with think blocks
// already stripped, so reasoning text can never be indexed. FTS5 +
// snippet()/highlight() availability in BOTH runtimes is verified.
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

/**
 * Seed the built-in collections and back-fill Library membership (document-organization
 * plan §9). Idempotent: built-ins are seeded once (guarded by `type`), and the backfill
 * only touches documents that have NO membership yet, so re-opening never double-files.
 *
 * Backfill rule (plan §9 step 4): every `status='indexed'` document with NO membership and
 * `origin_json IS NULL` becomes a Library member. The `status='indexed'` gate (M1) skips a
 * doc still importing for a Project/Temporary destination; the `origin_json IS NULL` guard
 * (D3) keeps generated translations/comparisons OUT of the default corpus — they get no
 * membership at all and are reached only via explicit selection.
 */
function seedCollections(db: Db): void {
  const now = new Date().toISOString()
  const ensureBuiltin = (type: 'library' | 'temporary', name: string): string => {
    const existing = db
      .prepare('SELECT id FROM collections WHERE type = ? LIMIT 1')
      .get(type) as unknown as { id: string } | undefined
    if (existing) return existing.id
    const id = randomUUID()
    db.prepare(
      `INSERT INTO collections (id, name, type, description, builtin, color, created_at, updated_at, archived_at, retention_policy_json)
       VALUES (?, ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL)`
    ).run(id, name, type, now, now)
    return id
  }
  // Canonical English names; the UI localizes built-ins by type (plan §9 step 3).
  const libraryId = ensureBuiltin('library', 'Library')
  ensureBuiltin('temporary', 'Temporary')
  db.prepare(
    `INSERT INTO document_collections (document_id, collection_id, role, added_at)
     SELECT d.id, ?, 'source', ?
     FROM documents d
     WHERE d.status = 'indexed'
       AND d.origin_json IS NULL
       AND NOT EXISTS (SELECT 1 FROM document_collections dc WHERE dc.document_id = d.id)`
  ).run(libraryId, now)
}

/** Open (or create) the database at `path` and run migrations. */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  ensureColumn(db, 'conversations', 'scope_json', 'scope_json TEXT')
  ensureColumn(db, 'documents', 'summary_json', 'summary_json TEXT')
  ensureColumn(db, 'documents', 'origin_json', 'origin_json TEXT')
  // Persisted per-page OCR recognition (content — lives only in this DB).
  ensureColumn(db, 'documents', 'ocr_json', 'ocr_json TEXT')
  // Document-organization columns (plan §8.2/§8.3). All nullable — the ensureColumn DDL
  // grammar allows no DEFAULT/NOT NULL, so NULL is the sentinel, coalesced in code
  // (`lifecycle` NULL ⇒ 'permanent', the parseScope precedent).
  ensureColumn(db, 'documents', 'lifecycle', 'lifecycle TEXT')
  ensureColumn(db, 'documents', 'source_relative_path', 'source_relative_path TEXT')
  ensureColumn(db, 'documents', 'source_folder_label', 'source_folder_label TEXT')
  ensureColumn(db, 'documents', 'pending_destination_json', 'pending_destination_json TEXT')
  ensureColumn(db, 'documents', 'expires_at', 'expires_at TEXT')
  ensureColumn(db, 'conversations', 'collection_id', 'collection_id TEXT')
  ensureColumn(db, 'conversations', 'scope_v2_json', 'scope_v2_json TEXT')
  ensureChunksFts(db)
  ensureMessagesFts(db)
  seedCollections(db)
  return db
}

/** List of table names — used by tests/diagnostics to confirm migration ran. */
export function listTables(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}
