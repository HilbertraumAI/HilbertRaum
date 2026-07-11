import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { ocrMetaFromJson } from './ingestion/ocr-meta'

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

/** A compiled, reusable statement — `node:sqlite`'s `StatementSync`. */
export type Stmt = ReturnType<Db['prepare']>

// DB-5 — hot-path prepared-statement cache (perf audit 2026-06-18, Wave P5).
//
// node:sqlite re-parses AND re-plans the SQL text on every `db.prepare()`. The hottest read/
// write paths run that parse+plan per chat turn (chat.ts listMessages/appendMessage/
// getConversation/listConversations, collections.ts resolveScope ~2×/turn, the listDocuments
// grouped counters), re-compiling the SAME static SQL each call. This caches one compiled
// `StatementSync` per (Db, sql-text), keyed by the literal SQL string, so the compile happens
// once per connection. A `StatementSync` is freely re-runnable with new bind params and `.all()`
// fully materializes, so reuse is safe across calls. The WeakMap on `Db` lets the statements GC
// with their connection (no leak across open/close of encrypted workspaces).
//
// HARD CONSTRAINT — call this ONLY with a CONSTANT SQL string. A statement whose text varies per
// call (a dynamic `IN (?, ?, …)` arity, or any interpolated fragment) MUST stay on `db.prepare()`:
// caching those would leak an unbounded number of cache entries AND bind the wrong arity. The
// cache is keyed by exact text, so a one-off dynamic string would never even be reused.
const statementCaches = new WeakMap<Db, Map<string, Stmt>>()

export function prepareCached(db: Db, sql: string): Stmt {
  let perDb = statementCaches.get(db)
  if (!perDb) {
    perDb = new Map<string, Stmt>()
    statementCaches.set(db, perDb)
  }
  let stmt = perDb.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    perDb.set(sql, stmt)
  }
  return stmt
}

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

-- Whole-document analysis (docs/rag-design.md §14.2 — analysis design record). A persistent
-- hierarchical summary tree (RAPTOR-lite) per document: level-1 nodes summarize groups of
-- chunks, level-2+ summarize lower nodes, up to one root. Built at ingest time so a
-- whole-document summary is a cheap read. Node summaries are CONTENT — never logged/audited.
CREATE TABLE IF NOT EXISTS tree_nodes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,          -- source document (per-doc tree)
  scope_key TEXT,                     -- reserved for a collection-level tree (NULL in per-doc v1)
  level INTEGER NOT NULL,             -- 1 = first summary level (children are chunks); 2+ summarize nodes
  ordinal INTEGER NOT NULL,           -- order within (document_id, level)
  parent_id TEXT,                     -- NULL for the root
  is_root INTEGER NOT NULL DEFAULT 0,
  summary_text TEXT NOT NULL,
  embedding_blob BLOB,                -- raw LE Float32; NULL at build time, filled lazily on first symmetric compare (L6, rag-design §14.6)
  dimensions INTEGER,
  embedding_model_id TEXT,            -- the embedder that produced embedding_blob (node search scopes by this)
  content_hash TEXT NOT NULL,         -- sha256 over ORDERED child texts — the summary_cache key (NOT node identity)
  model_id TEXT,                      -- chat model that produced summary_text
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id)  REFERENCES tree_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_doc ON tree_nodes(document_id, level, ordinal);

-- A node's ordered children: chunks (level-1 nodes) or lower nodes (level >= 2). child_id is
-- polymorphic (chunks.id when child_is_chunk=1, else tree_nodes.id), so it carries NO FK to
-- chunks — deleting chunks does NOT cascade here; re-index tears the tree down explicitly
-- (ingestion processDocument). Edges DO cascade when their parent node is deleted.
CREATE TABLE IF NOT EXISTS tree_edges (
  parent_id TEXT NOT NULL,
  child_id  TEXT NOT NULL,
  child_is_chunk INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  FOREIGN KEY (parent_id) REFERENCES tree_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tree_edges_parent ON tree_edges(parent_id);
-- Reverse lookup "which node(s) contain chunk/node X" (chunk->node provenance).
CREATE INDEX IF NOT EXISTS idx_tree_edges_child ON tree_edges(child_id, child_is_chunk);

-- Content cache (plan C3): maps the exact summarize-input text to its computed summary so a
-- rebuild — or a different document with identical boilerplate — skips the model call. This
-- is SEPARATE from node identity: a tree always gets one fresh tree_nodes row per structural
-- position, so repeated content can never collapse two positions into one node. Keyed by
-- (content_hash, model_id) so a chat-model change doesn't reuse an older model's summary. The
-- node vector (embedding_blob) is NULL at build time, embedded lazily on first use (L6,
-- rag-design §14.6). Carries no document_id; survives node/tree deletion; never pruned by FK.
-- Growth is bounded by a row-count cap (backend-audit-2026-06-27 DATA-3/MAINT-3): each tree
-- build opportunistically evicts the oldest rows past SUMMARY_CACHE_MAX_ROWS via
-- evictSummaryCache (analysis/summary-cache.ts). It is a cache, so eviction only costs a
-- future re-summarize, never data loss.
CREATE TABLE IF NOT EXISTS summary_cache (
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,             -- chat model that produced summary_text
  summary_text TEXT NOT NULL,
  embedding_blob BLOB,                -- node vector for this summary (NULL until first symmetric compare — L6)
  embedding_model_id TEXT,
  dimensions INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (content_hash, model_id)
);

-- Structured extraction records (whole-document-analysis plan §3.3, Phase 3). One row per
-- item surfaced by the per-chunk extract pass over the fixed v1 type set, plus exactly one
-- bookkeeping "__scan__" marker row per scanned chunk (normalized_value 'ok' | 'unparsed')
-- that records the scan outcome and is the per-chunk resume/cache key. Query-time aggregation
-- GROUPs by normalized_value (scoped via buildScopeFilter) so "list every X" is 0 model calls.
-- value_text/normalized_value are CONTENT — never logged/audited.
-- [H1 free win] chunk_id has ON DELETE CASCADE, so re-index (which deletes+recreates chunks)
-- drops a document's extraction rows automatically — extraction self-invalidates on re-index
-- (under PRAGMA foreign_keys = ON, set in openDatabase).
CREATE TABLE IF NOT EXISTS extraction_records (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,             -- provenance (which chunk this came from)
  record_type TEXT NOT NULL,          -- 'generic'|'date'|'amount'|'party'|'obligation' | '__scan__' marker
  value_text TEXT NOT NULL,           -- the surfaced item, verbatim-ish ('' for a marker)
  normalized_value TEXT NOT NULL,     -- lowercased/trimmed dedup key ('ok'|'unparsed' for a marker)
  attributes_json TEXT,               -- optional structured fields per type (NULL in v1)
  model_id TEXT,                      -- chat model that produced the extraction
  content_hash TEXT NOT NULL,         -- sha256(chunk text + type-set version) — per-chunk cache key
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id)   REFERENCES chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_extract_doc_type ON extraction_records(document_id, record_type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_extract_chunk ON extraction_records(chunk_id);

-- Result tables (result-tables plan §4, Phase 2): ONE generic tabular artifact attached to an
-- assistant message — the structured table behind an answer (e.g. the bank format path's
-- rows+categories), re-serializable on demand by the message-level "Export CSV" affordance.
-- Kept OUT of the messages row so a large table never rides every listMessages load (messages
-- carry only a derived hasResultTable flag). columns_json/rows_json are CONTENT — never
-- logged/audited; source is a content-free discriminator ('bank-statement'). The message FK
-- CASCADEs, so the regenerate delete and the conversation delete (which removes messages first,
-- in one transaction) both drop the table automatically under PRAGMA foreign_keys = ON.
CREATE TABLE IF NOT EXISTS result_tables (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  columns_json TEXT NOT NULL,         -- JSON TableColumn[] (key/label/kind)
  rows_json TEXT NOT NULL,            -- JSON row objects (content)
  row_count INTEGER NOT NULL,
  source TEXT,                        -- content-free origin discriminator
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_result_tables_message ON result_tables(message_id);

-- Skills registry (architecture.md "Skills — design record" §3/§10, revised §0 — plaintext plain-folder model). A
-- pure DERIVED INDEX + state cache over the on-disk skill folders (app-skills/ + user-skills/):
-- disk is the source of truth (DS1), so a DB rebuild simply re-reads the folders and re-derives
-- every row (no orphan, no recovery path). NOTE: there is deliberately NO foreign key FROM the
-- core tables (conversations/messages) INTO skills (audit C3 / §9.4) — a real FK would block
-- deletion and an older app must ignore the columns; references are cleared by an app-level sweep
-- (S4), never a cascade.
--
-- install_id is the DETERMINISTIC natural key "<source>:<id>" (S3 decision), NOT a random uuid:
-- user-skill folders are named by id so two same-id user skills can't coexist on disk, and a
-- disk-derived key is STABLE across a DB rebuild — so conversations.active_skill_id /
-- messages.skill_id keep resolving after a rebuild (a re-minted uuid would orphan them). Same-id
-- app vs user skills get distinct keys ("app:x" vs "user:x"), so DS12's collision handling holds.
CREATE TABLE IF NOT EXISTS skills (
  install_id     TEXT PRIMARY KEY,          -- deterministic "<source>:<id>" (disk-derivable; stable across rebuilds)
  id             TEXT NOT NULL,             -- declared kebab skill id (indexed, NON-unique across sources)
  title          TEXT NOT NULL,
  version        TEXT NOT NULL,
  kind           TEXT NOT NULL,             -- 'instruction' | 'tool'
  source         TEXT NOT NULL,             -- 'app' | 'user' (which folder it was discovered in)
  path           TEXT NOT NULL,             -- on-disk folder BASENAME, relative to the source dir (portable, machine-independent)
  enabled        INTEGER NOT NULL,          -- 0/1; app installs enabled, user drop-ins DISABLED (DS19)
  warning_ack    INTEGER NOT NULL,          -- 0/1; untrusted-skill warning acknowledged (DS7; app=1, user drop-in=0)
  trusted_level  TEXT NOT NULL,             -- 'app' | 'user' (APP-ASSIGNED, never self-declared)
  manifest_json  TEXT NOT NULL,             -- cached parsed manifest (re-derivable cache; carries triggers + compatibility, §22-C2)
  unavailable_at TEXT,                      -- NULL = folder present; ISO timestamp = folder vanished (mark-unavailable; never blind-deleted)
  installed_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_id ON skills(id);   -- duplicate-id lookups across sources (the DS12 warning)

-- Skill tool-run history (architecture.md "Skills — design record" §10, S11a). One row PER
-- app-orchestrated tool run (DS4), bracketed started → done|failed|cancelled. IDS/REFS ONLY —
-- never document/chat content: document_ids_json is ids, result_ref is a bank_statements.id or an
-- invoices.id, and
-- error is a friendly/technical reason. Excluded from every export (skills-plan §9.5). No FK INTO
-- skills (same audit-C3 reasoning as conversations/messages — references cleared by app sweep, not
-- a cascade), so a deleted skill never blocks or rewrites its run history.
CREATE TABLE IF NOT EXISTS skill_runs (
  id                TEXT PRIMARY KEY,
  skill_install_id  TEXT NOT NULL,          -- skills.install_id ("<source>:<id>")
  conversation_id   TEXT,                   -- nullable: a doc-action run may not be a chat
  document_ids_json TEXT,                   -- ids only, never content
  status            TEXT NOT NULL,          -- 'started' | 'done' | 'failed' | 'cancelled'
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  result_ref        TEXT,                   -- e.g. a bank_statements.id / invoices.id; NEVER inline content
  error             TEXT                    -- friendly/technical reason; NEVER document/chat text
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_install_id);

-- Bank-statement data tables (architecture.md "Skills — design record" §10, S11a). CONTENT-CLASS: the extracted
-- figures are user content, so they live ONLY here in the encrypted workspace DB (a workspace
-- backup carries them — correct), are NEVER logged/audited (audit stays ids/counts), and are NEVER
-- in the skill .skill.zip or conversation export. Distinct from the non-secret skill packages
-- (DS20). S11a creates only what extract_transactions needs; categories/rules/corrections arrive
-- additively with S11c (the tree_nodes-per-feature precedent — no overbuild, skills-plan §13).
-- ON DELETE CASCADE on the document FK is load-bearing on FRESH drives (audit DATA-1): foreign_keys
-- is ON and deleteDocument deletes the documents row directly, so without CASCADE a delete of a
-- document that has an extraction would hit an FK violation. The whole bank chain cascades
-- (statement → transactions → corrections), so a bare DELETE FROM documents cleans up cleanly. On
-- drives created BEFORE this fix the FK has NO cascade (CREATE TABLE IF NOT EXISTS can't alter it),
-- so deleteDocument also does an explicit ordered delete (purgeDocumentDerivatives) — that ordered
-- delete is what keeps EXISTING drives safe; the cascade is defense-in-depth for fresh ones.
CREATE TABLE IF NOT EXISTS bank_statements (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,              -- the source document (id only)
  run_id        TEXT,                       -- the skill_runs.id that produced this extraction
  period_start  TEXT,                       -- as printed, nullable
  period_end    TEXT,
  currency      TEXT,                       -- statement currency, nullable
  created_at    TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bank_statements_document ON bank_statements(document_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id             TEXT PRIMARY KEY,
  statement_id   TEXT NOT NULL,             -- references bank_statements.id
  run_id         TEXT,
  row_index      INTEGER NOT NULL,          -- stable order within the statement
  date           TEXT NOT NULL,             -- content: booking date as printed (ISO)
  value_date     TEXT,                      -- content
  description    TEXT NOT NULL,             -- content
  amount         REAL NOT NULL,             -- content: signed
  currency       TEXT NOT NULL,
  balance_after  REAL,                      -- content, nullable
  source_page    INTEGER,                   -- provenance (1-based) for quoting
  created_at     TEXT NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES bank_statements(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_statement ON bank_transactions(statement_id);

-- Categorization + reconciliation + user-correction tables (architecture.md "Skills — design record" §10 full
-- future DDL, created additively at S11c — the tree_nodes-per-feature precedent). All CONTENT-CLASS
-- (a category name / a corrected figure is user content): encrypted workspace DB only, NEVER
-- logged/audited, NEVER exported (skills-plan §9.5). bank_corrections is created now but only
-- written by a future correction UI (out of S11c scope, §8) — the schema is ratified, so it lands
-- additively rather than as a later migration.
CREATE TABLE IF NOT EXISTS bank_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,             -- content: the category label (e.g. "Income", "Fees")
  builtin     INTEGER NOT NULL DEFAULT 0,-- 1 = a built-in deterministic-rule category
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_category_rules (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,             -- references bank_categories.id
  match_kind  TEXT NOT NULL,            -- 'description-substring' | 'amount-sign'
  pattern     TEXT NOT NULL,            -- the substring, or 'positive'|'negative' for amount-sign
  created_at  TEXT NOT NULL,
  FOREIGN KEY (category_id) REFERENCES bank_categories(id)
);
CREATE INDEX IF NOT EXISTS idx_bank_category_rules_category ON bank_category_rules(category_id);
CREATE TABLE IF NOT EXISTS bank_corrections (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,          -- references bank_transactions.id
  field          TEXT NOT NULL,          -- which column the user corrected
  old_value      TEXT,                   -- content
  new_value      TEXT,                   -- content
  created_at     TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bank_corrections_transaction ON bank_corrections(transaction_id);

-- Invoice data tables (architecture.md "Skills — design record" §8/§10). The SECOND Tier-2
-- content-class domain, mirroring the bank_* tables exactly: the extracted figures are user content,
-- so they live ONLY here in the encrypted workspace DB (a workspace backup carries them — correct),
-- are NEVER logged/audited (audit stays ids/counts), and are NEVER in the skill .skill.zip or
-- conversation export. skill_runs.result_ref points at an invoices.id; it never inlines content.
CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL,          -- the source document (id only)
  run_id            TEXT,                   -- the skill_runs.id that produced this extraction
  vendor            TEXT,                   -- content: seller name as printed, nullable
  invoice_number    TEXT,                   -- content, nullable
  invoice_date      TEXT,                   -- content: ISO, nullable
  due_date          TEXT,                   -- content: ISO, nullable
  currency          TEXT,                   -- invoice currency, nullable
  net_total         REAL,                   -- content, nullable
  tax_total         REAL,                   -- content, nullable
  tax_rate          REAL,                   -- content: tax rate percent, nullable
  gross_total       REAL,                   -- content, nullable
  totals_reconciled INTEGER,                -- 1 reconciled / 0 not / NULL unchecked (validate_invoice_totals)
  created_at        TEXT NOT NULL,
  -- ON DELETE CASCADE (document → invoices → line items) mirrors the bank chain: load-bearing on
  -- fresh drives, with the explicit ordered delete in purgeDocumentDerivatives covering existing
  -- ones (audit DATA-1).
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoices_document ON invoices(document_id);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id           TEXT PRIMARY KEY,
  invoice_id   TEXT NOT NULL,               -- references invoices.id
  run_id       TEXT,
  row_index    INTEGER NOT NULL,            -- stable order within the invoice
  description  TEXT NOT NULL,               -- content
  quantity     REAL,                        -- content, nullable
  unit_price   REAL,                        -- content, nullable
  line_total   REAL NOT NULL,               -- content
  currency     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);

-- Image-understanding history (docs/architecture.md image-understanding record). Each
-- analyzed image becomes a session: the image bytes are stored under workspace/images/
-- (encrypted-at-rest when the vault is encrypted — same DocumentCipher as documents) and
-- the Q&A turns are appended here. Deleting a session shreds the stored image (in the
-- service) and CASCADE-removes its turns. stored_name is a RELATIVE filename (resolved
-- against imagesDir at call time) so the drive stays portable across OSes.
CREATE TABLE IF NOT EXISTS image_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,                  -- original file name
  stored_name TEXT NOT NULL,                  -- relative filename under images/ (never absolute)
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  encrypted   INTEGER NOT NULL DEFAULT 0,     -- 1 when stored as a .enc sidecar
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES image_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_image_turns_session ON image_turns(session_id);
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

/**
 * PERF-3 (full-audit-2026-06-29 follow-up, Phase 4) — one-time backfill of the `ocr_meta_json`
 * sidecar for rows imported before that column existed. Reads each row's `ocr_json` blob ONCE,
 * extracts ONLY the surface metadata (`ocrMetaFromJson` — never page text), and writes the sidecar
 * so the hot `listDocuments` path can read the OCR badge without parsing the blob again. After the
 * first open every OCR'd row has meta, so subsequent opens select zero rows (a cheap indexed-status
 * scan). Touches ONLY the new column — `updated_at` is left alone (a transparent migration, not a
 * content edit), and no FK/lifecycle column is read or written, so an old on-disk workspace opens
 * cleanly. Batched in one transaction to amortize fsyncs on the high-latency USB drive (DB-2).
 */
function backfillOcrMeta(db: Db): void {
  const rows = db
    .prepare(
      "SELECT id, ocr_json FROM documents WHERE ocr_json IS NOT NULL AND ocr_meta_json IS NULL"
    )
    .all() as Array<{ id: string; ocr_json: string | null }>
  if (rows.length === 0) return
  const update = db.prepare('UPDATE documents SET ocr_meta_json = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const meta = ocrMetaFromJson(r.ocr_json)
      // A blob that yields no valid page leaves meta NULL (the badge was already absent); it is
      // re-examined on the next open (negligible — effectively never happens for real OCR output).
      if (meta) update.run(JSON.stringify(meta), r.id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// CODE-4 (full audit 2026-07-11) — the canonical, rowid-targeted FTS sync trigger sets.
//
// The original AD/AU triggers deleted `WHERE chunk_id/message_id = old.id`. FTS5 has NO index
// on UNINDEXED columns, so every per-row trigger firing full-scanned the `%_content` shadow
// table — O(K·N) for a K-row delete over an N-row corpus. Measured on the production schema
// (50k chunks / ~30 MB text, in-memory): 3536 ms to delete one 250-chunk document via the
// triggers vs 29 ms set-based (123×) — synchronous on the Electron main process, fired by
// re-index/delete (ingestion), every regenerate, and conversation delete (chat.ts).
//
// The fix: a nullable `fts_rowid` handle column on `chunks`/`messages` (FTS5's `%_content`
// table has an EXPLICIT integer PK, so FTS rowids are VACUUM-stable — unlike the base tables'
// implicit rowids that ruled out external-content). The AI trigger stamps it via
// `last_insert_rowid()` (which, INSIDE a trigger body, reflects the trigger's own FTS insert —
// probed on node:sqlite/SQLite 3.50); the AD/AU triggers delete `WHERE rowid = old.fts_rowid`,
// an O(log N) lookup (EXPLAIN QUERY PLAN "VIRTUAL TABLE INDEX 0:=", not the bare-scan "0:").
//
// The NULL fallback is a SEPARATE `_legacy` trigger gated by `WHEN old.fts_rowid IS NULL`
// rather than an OR inside one DELETE: a constant conjunct on a virtual-table scan is evaluated
// per row, not short-circuited at plan time, so a single combined predicate would still scan.
// The WHEN split keeps the hot path provably rowid-only while legacy rows (pre-migration, or a
// row written mid-upgrade) keep the exact old predicate — correctness never regresses, even
// under a ROLLED-BACK binary: triggers live in the DB file, so an older app keeps stamping and
// consuming the handle without knowing about it.
//
// Recursion safety: the AI-trigger `UPDATE chunks SET fts_rowid=…` cannot re-fire the AU
// triggers (they are `UPDATE OF text`/`OF content` only), and recursive triggers are off by
// default in SQLite.
const CHUNKS_FTS_TRIGGERS = `
CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(text, chunk_id) VALUES (new.text, new.id);
  UPDATE chunks SET fts_rowid = last_insert_rowid() WHERE id = new.id;
END;

CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks WHEN old.fts_rowid IS NOT NULL BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.fts_rowid;
END;

CREATE TRIGGER chunks_fts_ad_legacy AFTER DELETE ON chunks WHEN old.fts_rowid IS NULL BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER chunks_fts_au AFTER UPDATE OF text ON chunks WHEN old.fts_rowid IS NOT NULL BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.fts_rowid;
  INSERT INTO chunks_fts(text, chunk_id) VALUES (new.text, new.id);
  UPDATE chunks SET fts_rowid = last_insert_rowid() WHERE id = new.id;
END;

CREATE TRIGGER chunks_fts_au_legacy AFTER UPDATE OF text ON chunks WHEN old.fts_rowid IS NULL BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
  INSERT INTO chunks_fts(text, chunk_id) VALUES (new.text, new.id);
  UPDATE chunks SET fts_rowid = last_insert_rowid() WHERE id = new.id;
END;
`

// The messages twins carry the compaction `kind` guards (R8/DATA-1) IN the canonical set, so
// the older ensureMessagesFts*KindFilter migrations see `new.kind` present and stay no-ops on
// every later open. Nuances beyond the chunks set:
//   - messages_fts_ad_legacy ALSO excludes `old.kind IS 'compaction'`: a compaction row is
//     guaranteed absent from the index (the AI guard for new rows; ensureMessagesFtsKindFilter
//     pruned any legacy-indexed ones on the same upgrade open), so its handle is permanently
//     NULL and without the exclusion every checkpoint-row delete would pay one legacy scan for
//     a row that has no FTS entry at all.
//   - the AU stamps `CASE WHEN new.kind IS NOT 'compaction' THEN last_insert_rowid() ELSE NULL
//     END`: when the kind guard suppresses the re-insert, last_insert_rowid() is a stale value
//     from some earlier statement and must not be stored (a plain→compaction transition parks
//     the handle at NULL, matching the row's now-unindexed state).
const MESSAGES_FTS_TRIGGERS = `
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind IS NOT 'compaction' BEGIN
  INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
  UPDATE messages SET fts_rowid = last_insert_rowid() WHERE id = new.id;
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages WHEN old.fts_rowid IS NOT NULL BEGIN
  DELETE FROM messages_fts WHERE rowid = old.fts_rowid;
END;

CREATE TRIGGER messages_fts_ad_legacy AFTER DELETE ON messages
WHEN old.fts_rowid IS NULL AND old.kind IS NOT 'compaction' BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages WHEN old.fts_rowid IS NOT NULL BEGIN
  DELETE FROM messages_fts WHERE rowid = old.fts_rowid;
  INSERT INTO messages_fts(content, message_id)
    SELECT new.content, new.id WHERE new.kind IS NOT 'compaction';
  UPDATE messages SET fts_rowid = CASE WHEN new.kind IS NOT 'compaction' THEN last_insert_rowid() ELSE NULL END
    WHERE id = new.id;
END;

CREATE TRIGGER messages_fts_au_legacy AFTER UPDATE OF content ON messages WHEN old.fts_rowid IS NULL BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(content, message_id)
    SELECT new.content, new.id WHERE new.kind IS NOT 'compaction';
  UPDATE messages SET fts_rowid = CASE WHEN new.kind IS NOT 'compaction' THEN last_insert_rowid() ELSE NULL END
    WHERE id = new.id;
END;
`

/**
 * CODE-4 — populate `fts_rowid` for rows that predate the handle (the one-time backfill half
 * of the migration; also used by the fresh-create paths, whose bulk `INSERT … SELECT` into the
 * FTS table bypasses the AI trigger). ONE scan of the FTS table builds the id→rowid map (the
 * per-row correlated-subquery alternative would be the very O(N²) scan this migration removes),
 * then PK-targeted updates run inside a single transaction (the `backfillOcrMeta` pattern) —
 * unless `ownTransaction` is false, in which case the CALLER's already-open transaction covers
 * the updates (`ensureFtsRowidSync` bundles DDL + backfill into one atomic commit; a nested
 * BEGIN would throw). Rows with no FTS entry (compaction messages; a genuinely orphaned row)
 * keep NULL and stay on the legacy-trigger path — correct, just slow, and never re-scanned per
 * open (the caller's trigger-DDL sentinel is the run-once guard). `target` is a compile-time
 * union, so the interpolation cannot become an injection point.
 */
function backfillFtsRowids(db: Db, target: 'chunks' | 'messages', ownTransaction = true): void {
  const fts = target === 'chunks' ? 'chunks_fts' : 'messages_fts'
  const key = target === 'chunks' ? 'chunk_id' : 'message_id'
  const rows = db
    .prepare(`SELECT rowid AS r, ${key} AS id FROM ${fts}`)
    .all() as unknown as Array<{ r: number; id: string }>
  if (rows.length === 0) return
  // `AND fts_rowid IS NULL` keeps this idempotent-safe: a handle the triggers already stamped
  // (rows written after the trigger rewrite, before this backfill ran) is never clobbered.
  const update = db.prepare(`UPDATE ${target} SET fts_rowid = ? WHERE id = ? AND fts_rowid IS NULL`)
  if (!ownTransaction) {
    for (const row of rows) update.run(row.r, row.id)
    return
  }
  db.exec('BEGIN')
  try {
    for (const row of rows) update.run(row.r, row.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * CODE-4 (full audit 2026-07-11) — upgrade a pre-fix workspace to the rowid-targeted trigger
 * sets (see the CHUNKS_FTS_TRIGGERS comment for the why + measurements). Idempotent via the
 * `ensureMessagesFtsKindFilter` sentinel idiom: skips only when the live AD trigger already
 * carries `fts_rowid`, and backfills the handles exactly once (in the same open). Runs AFTER
 * the FTS ensures + kind-filter migrations, so (a) the tables/columns exist, (b) the kind
 * filters' legacy-shaped rewrites on the same upgrade open are superseded here rather than
 * racing us, and (c) their compaction-row prune has already run, so the backfill can never map
 * a checkpoint row (its FTS entry is gone by now).
 *
 * Crash-atomicity (CODE-4 review follow-up): the DROPs + CREATEs + backfill run inside ONE
 * transaction (trigger DDL is transactional in SQLite), so a process kill mid-upgrade rolls
 * back to the intact pre-migration state and the sentinel simply retries on the next open —
 * a bare multi-statement `db.exec` auto-commits per statement, which could tear the trigger
 * set (e.g. AD dropped but never recreated: deletes silently stop maintaining the index) and
 * could commit the sentinel-matching CREATEs with the backfill lost (the whole corpus parked
 * on the legacy scan path forever). And the sentinel deliberately treats a MISSING AD trigger
 * as "must upgrade" (`row?.sql`, NOT the kind-filter idiom's `!row` early-return — there a
 * missing trigger is unreachable by construction; here it is exactly the torn state): the DDL
 * uses DROP TRIGGER IF EXISTS throughout, so re-running against ANY torn trigger state —
 * including one left by the non-atomic fresh-create execs in ensureChunksFts/ensureMessagesFts
 * — is safe, making the migration self-healing rather than a permanent silent failure.
 */
function ensureFtsRowidSync(db: Db): void {
  const upgrade = (adTrigger: string, triggerNames: string[], ddl: string, target: 'chunks' | 'messages'): void => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
      .get(adTrigger) as unknown as { sql: string } | undefined
    if (row?.sql.includes('fts_rowid')) return
    db.exec('BEGIN')
    try {
      db.exec(triggerNames.map((n) => `DROP TRIGGER IF EXISTS ${n};`).join('\n') + ddl)
      backfillFtsRowids(db, target, /* ownTransaction */ false)
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original failure as the thrown error */
      }
      throw err
    }
  }
  upgrade(
    'chunks_fts_ad',
    ['chunks_fts_ai', 'chunks_fts_ad', 'chunks_fts_au', 'chunks_fts_ad_legacy', 'chunks_fts_au_legacy'],
    CHUNKS_FTS_TRIGGERS,
    'chunks'
  )
  upgrade(
    'messages_fts_ad',
    ['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au', 'messages_fts_ad_legacy', 'messages_fts_au_legacy'],
    MESSAGES_FTS_TRIGGERS,
    'messages'
  )
}

// The FTS5 keyword index over chunk text, used by hybrid retrieval (rag-design §11).
// SELF-CONTAINED (text + chunk_id UNINDEXED), deliberately NOT an
// external-content table keyed on chunks' implicit rowid — `chunks.id` is a TEXT PK, so
// the table has only an implicit rowid, and VACUUM is documented to renumber those,
// which would silently desync an external-content index. Sync is via triggers so no
// ingest/reindex/delete code path can ever miss it (rowid-targeted since CODE-4 — see
// CHUNKS_FTS_TRIGGERS above); the one-time backfill makes an older workspace searchable
// on first open after upgrade (guarded additive migration). FTS5 availability in BOTH
// runtimes (Electron's bundled Node + system Node) is verified.
function ensureChunksFts(db: Db): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_fts'")
    .get() as unknown as { name: string } | undefined
  if (exists) return
  db.exec(`
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, chunk_id UNINDEXED);
${CHUNKS_FTS_TRIGGERS}
INSERT INTO chunks_fts(text, chunk_id) SELECT text, id FROM chunks;
`)
  // The bulk INSERT above writes the FTS table directly (no chunks trigger fires), so a
  // pre-FTS workspace's existing chunks still carry a NULL handle — stamp them now (CODE-4).
  backfillFtsRowids(db, 'chunks')
}

// The FTS5 index over message text, used by conversation search.
// Mirrors `ensureChunksFts` exactly — self-contained (NOT external-content,
// same VACUUM rationale), trigger-synced so no chat code path can miss it (message
// content is never UPDATEd by current code; the update trigger is cheap
// defense-in-depth), and a one-time guarded backfill makes an older workspace
// searchable on first open after upgrade. Messages are persisted with think blocks
// already stripped, so reasoning text can never be indexed. FTS5 +
// snippet()/highlight() availability in BOTH runtimes is verified.
//
// The compaction `kind` guard (R8) lives on BOTH the insert AND the update trigger so a
// checkpoint summary can never enter conversation search through either path (DATA-1, full
// audit 2026-06-28). The update trigger guards its INSERT (not the whole trigger via WHEN) so
// its DELETE still runs unconditionally — a plain row that is converted to a compaction row in
// the same content UPDATE still has its old FTS entry purged.
function ensureMessagesFts(db: Db): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'")
    .get() as unknown as { name: string } | undefined
  if (exists) return
  db.exec(`
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED);
${MESSAGES_FTS_TRIGGERS}
INSERT INTO messages_fts(content, message_id) SELECT content, id FROM messages WHERE kind IS NOT 'compaction';
`)
  // As in ensureChunksFts: the bulk INSERT bypasses the AI trigger — stamp the handles (CODE-4).
  backfillFtsRowids(db, 'messages')
}

/**
 * R8 (context-compaction-plan §8) — keep compaction checkpoint rows (`kind='compaction'`) out of
 * conversation search and snippets. `ensureMessagesFts` builds the AFTER INSERT trigger with the kind
 * guard for fresh DBs; this upgrades a DB created BEFORE context compaction, whose `messages_fts_ai`
 * indexed every insert. Idempotent: rewrites only when the live trigger lacks the guard, and prunes
 * any checkpoint row that had already been indexed (none exist pre-feature, but the prune is correct
 * and future-proof). Runs after `ensureMessagesFts` so the table + the `kind` column already exist.
 */
function ensureMessagesFtsKindFilter(db: Db): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_ai'")
    .get() as unknown as { sql: string } | undefined
  if (!row || row.sql.includes('new.kind')) return
  db.exec(`
DROP TRIGGER messages_fts_ai;
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind IS NOT 'compaction' BEGIN
  INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
END;
DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE kind = 'compaction');
`)
}

/**
 * DATA-1 (full audit 2026-06-28) — the UPDATE-trigger twin of `ensureMessagesFtsKindFilter`.
 * `ensureMessagesFts` builds `messages_fts_au` with the `kind` guard on its INSERT for fresh DBs;
 * this upgrades a DB whose `messages_fts_au` re-indexed updated content UNCONDITIONALLY, so a
 * future in-place edit of a `kind='compaction'` row can never leak its summary text into
 * user-facing conversation search. Idempotent: rewrites only when the live trigger lacks the
 * guard (`new.kind` absent), mirroring the insert-trigger backfill precedent. The DELETE stays
 * unconditional (a kind-transition still purges the stale entry). Any already-indexed compaction
 * row is pruned by `ensureMessagesFtsKindFilter`, which runs on the same open. Runs after
 * `ensureMessagesFts` so the table + `kind` column already exist.
 */
function ensureMessagesFtsUpdateKindFilter(db: Db): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_au'")
    .get() as unknown as { sql: string } | undefined
  if (!row || row.sql.includes('new.kind')) return
  db.exec(`
DROP TRIGGER messages_fts_au;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(content, message_id)
    SELECT new.content, new.id WHERE new.kind IS NOT 'compaction';
END;
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
  // DB-2 — portable-drive performance PRAGMAs (perf audit 2026-06-18). HilbertRaum runs from a
  // high-latency USB drive where every fsync is 5–20 ms, so the durability/throughput trade-offs
  // that suit a fixed SSD are wrong here.
  //   synchronous=NORMAL — WAL-safe: still durable across app crashes, only risks the last txn on
  //                        an OS/power loss, in exchange for far fewer fsyncs (compounds DB-1).
  //   busy_timeout=5000  — the concurrent import loop vs chat/tree-build waits briefly instead of
  //                        throwing SQLITE_BUSY.
  //   mmap_size=256 MB   — the linear vector scan (RAG-1) reads BLOBs via mapped pages, not syscalls.
  //   cache_size=-16 MB  — negative = KiB of page cache (~16 MB), not page count.
  //   temp_store=MEMORY  — keep transient sorts/temp B-trees off the slow drive.
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA mmap_size = 268435456;')
  db.exec('PRAGMA cache_size = -16000;')
  db.exec('PRAGMA temp_store = MEMORY;')
  db.exec(SCHEMA)
  ensureColumn(db, 'conversations', 'scope_json', 'scope_json TEXT')
  ensureColumn(db, 'documents', 'summary_json', 'summary_json TEXT')
  ensureColumn(db, 'documents', 'origin_json', 'origin_json TEXT')
  // Persisted per-page OCR recognition (content — lives only in this DB).
  ensureColumn(db, 'documents', 'ocr_json', 'ocr_json TEXT')
  // PERF-3 (full-audit-2026-06-29 follow-up, Phase 4): cheap metadata-only OCR sidecar
  // (`{ pageCount, languages, engineId, createdAt }` — a serialized DocumentOcrInfo, counts/ids
  // only, NEVER page text). `listDocuments` reads the OCR badge from this column instead of
  // JSON.parse-ing the multi-MB `ocr_json` blob per row. Additive + nullable (NULL = not yet
  // backfilled OR no OCR); populated at OCR-write time and by the one-time backfill below.
  ensureColumn(db, 'documents', 'ocr_meta_json', 'ocr_meta_json TEXT')
  backfillOcrMeta(db)
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
  // Whole-document analysis (plan §3.2). All nullable (the ensureColumn DDL grammar forbids
  // DEFAULT/NOT NULL, so NULL is the sentinel, coalesced in code).
  //   tree_status   — NULL | 'pending' | 'building' | 'ready' | 'stale' | 'failed'
  //   tree_meta_json — { rootId, levels, leafChunkCount, builtAt, modelId, embeddingModelId }
  //   fully_chunked — set by processDocument on every successful index (C4); NULL = legacy
  //                   (maybe truncated) ⇒ must re-index before deep-index / 100% coverage.
  ensureColumn(db, 'documents', 'tree_status', 'tree_status TEXT')
  ensureColumn(db, 'documents', 'tree_meta_json', 'tree_meta_json TEXT')
  ensureColumn(db, 'documents', 'fully_chunked', 'fully_chunked TEXT')
  //   extract_status — NULL | 'pending' | 'extracting' | 'ready' | 'stale' | 'failed' (Phase 3,
  //   the per-chunk structured-extract pass; mirrors tree_status, NULL-sentinel).
  ensureColumn(db, 'documents', 'extract_status', 'extract_status TEXT')
  // Skills (skills plan §8.2). Both nullable — NULL = no skill (the scope_v2_json NULL-sentinel
  // convention). No FK into `skills` (audit C3): refs are cleared by an app-level sweep on delete
  // (S4), so an older app can ignore these columns and skill deletion is never FK-blocked.
  //   conversations.active_skill_id — the STICKY DEFAULT skill for new turns (DS18).
  //   messages.skill_id             — the skill that shaped THIS turn; powers the per-message glyph (DS16/DS18).
  ensureColumn(db, 'conversations', 'active_skill_id', 'active_skill_id TEXT')
  ensureColumn(db, 'messages', 'skill_id', 'skill_id TEXT')
  // S13c — auto-fire provenance (skills-s13-plan.md §5/D3). Additive + nullable (NULL/0 = the skill
  // was an explicit pick or there was none; 1 = the app AUTO-FIRED it). Stamped on the assistant row
  // only when the auto-fire path placed the skill, so the per-turn "answer without it" undo shows ONLY
  // on an auto-fired turn. Privacy-safe: a boolean, never content. An older app simply ignores it.
  ensureColumn(db, 'messages', 'auto_fired', 'auto_fired INTEGER')
  // Full-doc-skills plan Phase 1 — per-message coverage breadth (D48). Additive + nullable: NULL =
  // legacy/pre-migration row OR a turn that recorded no coverage; the renderer coalesces NULL to the
  // relevance label, so an older app simply ignores the column and the badge is byte-identical. Holds
  // a JSON-serialized `CoverageInfo` (mode + sections covered/total); CONTENT-free (only counts/mode).
  ensureColumn(db, 'messages', 'coverage_json', 'coverage_json TEXT')
  // Context compaction (context-compaction-plan §4.4, R13). Additive + nullable: `kind` NULL = a
  // plain 'message' (the NULL-sentinel convention, coalesced in code), 'compaction' marks a summary
  // checkpoint row; `covers_through_rowid` is the max messages.rowid that checkpoint subsumes (NULL on
  // plain rows). An older app ignores both columns and reads every row as a message — no behaviour change.
  ensureColumn(db, 'messages', 'kind', 'kind TEXT')
  ensureColumn(db, 'messages', 'covers_through_rowid', 'covers_through_rowid INTEGER')
  // Honest-signal flag (D:\ testing report 2026-07-01): 1 when an assistant reply was CUT OFF at the
  // token/context ceiling (llama-server `finish_reason: 'length'`), NULL otherwise (complete reply,
  // user turn, or user Stop). Additive + nullable — an older app ignores it and reads every reply as
  // complete, byte-identical to before. CONTENT-free (a single boolean).
  ensureColumn(db, 'messages', 'truncated', 'truncated INTEGER')
  // Bank-transaction derived annotations (architecture.md "Skills — design record" §10, S11c). All nullable —
  // a row has no category/reconciled/confidence until a downstream tool computes one. CONTENT-CLASS
  // (a category id / reconcile verdict is derived from user figures): never logged/audited/exported.
  //   bank_transactions.category_id — the assigned bank_categories.id (categorize_transactions).
  //   bank_transactions.reconciled  — 0/1 balance-reconcile verdict (validate_statement_balances).
  //   bank_transactions.confidence  — extraction/categorization confidence, 0..1 (future use).
  ensureColumn(db, 'bank_transactions', 'category_id', 'category_id TEXT')
  ensureColumn(db, 'bank_transactions', 'reconciled', 'reconciled INTEGER')
  ensureColumn(db, 'bank_transactions', 'confidence', 'confidence REAL')
  // Statement-level opening/closing balances (PDF geometry-extraction plan §3.5, D56). Additive +
  // nullable: the completeness gate's only true proof is opening + Σamounts == closing, so these are
  // captured + stored to gate any presented total. CONTENT-CLASS (printed figures): never
  // logged/audited/exported. NULL = a statement that printed no opening/closing balance (gate downgrades).
  ensureColumn(db, 'bank_statements', 'opening_balance', 'opening_balance REAL')
  ensureColumn(db, 'bank_statements', 'closing_balance', 'closing_balance REAL')
  // Whether the categorizer doctask consulted the LLM for this statement (Phase 33). Additive +
  // nullable: NULL/0 = deterministic rule pass (or not categorized), 1 = the model was involved, so the
  // breakdown is labelled "model-assisted". The authoritative signal — replaces the lossy "any category
  // outside the rule set" heuristic, which false-negatives when the model only emits in-rule-set labels
  // (Income/Transfer/Fees/Cash). CONTENT-CLASS adjacent (a derived flag): never logged/audited/exported.
  ensureColumn(db, 'bank_statements', 'categorized_by_model', 'categorized_by_model INTEGER')
  // The deterministic extractor version that produced this statement (A9, Phase 31–33 follow-up).
  // Additive + nullable: NULL = extracted before versioning (or by an older parser) → STALE, so the
  // analysis read-back + categorize doctask RE-EXTRACT (replacing the stale rows) instead of serving
  // figures a since-fixed parser bug mis-signed / lost a payee on. Stamped with `BANK_EXTRACTOR_VERSION`
  // on every extraction; bumped whenever the line parser OR the geometry reconstruction changes output.
  // CONTENT-CLASS adjacent (a provenance int): never logged/audited/exported.
  ensureColumn(db, 'bank_statements', 'extractor_version', 'extractor_version INTEGER')
  // Whether the statement's date ORDER rests on evidence or defaulted to day-first on ambiguous dates (R5,
  // audit §5.7). Additive + nullable: NULL/'evidence' = the order is trustworthy or moot (no caveat);
  // 'default' = day-first was applied to genuinely order-ambiguous dates with nothing in the document to
  // justify it, so the deterministic answer appends ONE honest date caveat. A provenance flag (never a
  // figure); CONTENT-CLASS adjacent — never logged/audited/exported.
  ensureColumn(db, 'bank_statements', 'date_order_inferred', 'date_order_inferred TEXT')
  // How many money-bearing lines the extractor REJECTED (could not turn into a transaction row) — U1,
  // audit §2.3. Additive + nullable: NULL = extracted before this column (pre-U1) → the answer omits the
  // "N lines could not be parsed" gate (the honesty signal is simply absent, not falsely zero); 0 = every
  // money-shaped line parsed (the "whole statement" claim stands); > 0 = the deterministic answer replaces
  // the "across the whole statement" phrasing with an honest "M lines with figures could not be parsed".
  // Stamped on every extraction; a provenance COUNT (never a figure) — CONTENT-CLASS adjacent, never
  // logged/audited/exported.
  ensureColumn(db, 'bank_statements', 'dropped_row_count', 'dropped_row_count INTEGER')
  // The deterministic INVOICE extractor version (F5 — the same reuse/replace/staleness machinery as the
  // bank `extractor_version` above, mirrored for the second Tier-2 content class). Additive + nullable:
  // NULL = extracted before versioning → STALE, so the invoice analysis read-back RE-EXTRACTS (replacing
  // the rows) instead of serving figures a since-fixed parser bug mis-read. Stamped with
  // `INVOICE_EXTRACTOR_VERSION` on every extraction; bumped whenever the invoice parser changes output.
  // CONTENT-CLASS adjacent (a provenance int): never logged/audited/exported.
  ensureColumn(db, 'invoices', 'extractor_version', 'extractor_version INTEGER')
  // The invoice date-order provenance flag (R5, audit §5.7 — mirror of `bank_statements.date_order_inferred`
  // above). Additive + nullable; drives the same one-line honest date caveat on the invoice answer.
  ensureColumn(db, 'invoices', 'date_order_inferred', 'date_order_inferred TEXT')
  // How many money-bearing lines the invoice extractor REJECTED (U1, audit §2.3 — mirror of
  // `bank_statements.dropped_row_count`). Additive + nullable: NULL = pre-U1 (gate omitted); 0 = every
  // money-shaped line parsed ("whole invoice" stands); > 0 = the answer swaps "the whole invoice" for an
  // honest "M lines with figures could not be parsed". A provenance COUNT — never logged/audited/exported.
  ensureColumn(db, 'invoices', 'dropped_row_count', 'dropped_row_count INTEGER')
  // The bill-to party (invoice-hardening-2026-07-04 P3) — read from a labeled line only. Additive +
  // nullable: NULL = not stated / extracted before this column (the version bump re-extracts).
  // CONTENT (a name): lives only in the content-class invoices table, never logged/audited/exported.
  ensureColumn(db, 'invoices', 'recipient', 'recipient TEXT')
  // The glyph-soup text-quality verdict (invoice-hardening-2026-07-04 P3): NULL = the text layer looked
  // normal; 'suspect' = the extractor read glyph-mangled text (the answer layer retries once via the
  // geometry reader); 'suspect-confirmed' = the retry ALSO read soup (final — the handler stops
  // retrying and refuses confident figures). A provenance flag — never logged/audited/exported.
  ensureColumn(db, 'invoices', 'text_quality', 'text_quality TEXT')
  // Additive performance indexes (perf audit 2026-06-18, Wave P1 — DB-4/DB-6/DB-7). CREATE INDEX
  // IF NOT EXISTS is the same additive-migration idiom as the inline SCHEMA indexes; these live
  // here (after ensureColumn) because idx_bank_transactions_category indexes a migrated column.
  db.exec(
    // DB-4/RAG-4: every retrieval + stale-check filters embeddings WHERE embedding_model_id = ?.
    'CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(embedding_model_id);'
  )
  db.exec(
    // DB-6: unscoped "list every date/amount" filters on record_type (and record_type,
    // normalized_value) with no leading document_id — the doc-leading idx_extract_doc_type can't
    // serve it. The doc-leading index still serves the scoped (per-document) queries.
    'CREATE INDEX IF NOT EXISTS idx_extract_type_nv ON extraction_records(record_type, normalized_value);'
  )
  db.exec(
    // DB-7: documents.status is filtered on every list + the re-index honesty check.
    'CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);'
  )
  db.exec(
    // DB-7: bank_transactions.category_id (a migrated column) — joined as transaction volume grows.
    'CREATE INDEX IF NOT EXISTS idx_bank_transactions_category ON bank_transactions(category_id);'
  )
  db.exec(
    // PERF-3 (full audit 2026-06-28): getLatestCheckpoint runs on EVERY chat + grounded turn,
    // filtering `conversation_id AND kind='compaction' ORDER BY rowid DESC LIMIT 1`. The only prior
    // key was idx_messages_conversation (conversation_id alone), forcing an O(messages-in-conv)
    // partial scan per turn on a high-latency USB drive. This composite turns it into an index
    // SEARCH with no SCAN and no temp B-tree: SQLite appends the rowid to every index, so trailing
    // `(conversation_id, kind)` already satisfies the `ORDER BY rowid DESC LIMIT 1` — naming rowid
    // explicitly is REJECTED by SQLite ("no such column: rowid") since messages has a TEXT PK and
    // only an implicit rowid. This index targets getLatestCheckpoint specifically;
    // listConversationTurns and getConversationSummaryMarker keep using idx_messages_conversation
    // (their `rowid > ?` range + `ORDER BY rowid` can't be served here — the non-equality
    // `kind IS NOT 'compaction'` predicate sits before the trailing rowid and blocks the seek), so
    // idx_messages_conversation must NOT be treated as redundant.
    'CREATE INDEX IF NOT EXISTS idx_messages_conv_kind ON messages(conversation_id, kind);'
  )
  db.exec(
    // PERF-4 (full audit 2026-06-28): summary_cache eviction deletes the oldest rows
    // `ORDER BY created_at ASC`, but the table's only key was the PK (content_hash, model_id), so
    // each over-cap tree build did a full scan + temp B-tree sort of up to 50k rows. This makes
    // eviction an ordered index scan (LIMIT-bounded — the residual partial sort is only the
    // content_hash tiebreak within an identical created_at).
    'CREATE INDEX IF NOT EXISTS idx_summary_cache_created ON summary_cache(created_at);'
  )
  db.exec(
    // PF-3 (full audit 2026-07-10): the audit-log retention prune orders runtime_events by
    // created_at (audit.ts pruneAuditEvents); the table's only prior key was the TEXT PK, so
    // every prune full-scanned + temp-B-tree-sorted the table. Same additive ensure-on-open
    // idiom as idx_summary_cache_created above, so it applies to existing workspaces too.
    'CREATE INDEX IF NOT EXISTS idx_runtime_events_created ON runtime_events(created_at);'
  )
  // run_id indexes (DB-7) deliberately OMITTED: run_id is only ever INSERTed, never joined or
  // filtered anywhere in the codebase, so an index would be pure write-amplification on USB with
  // no read benefit. Add one alongside the first query that joins on run_id.
  // CODE-4 (full audit 2026-07-11): the FTS rowid handle columns — added BEFORE the FTS
  // ensures below, whose triggers read and stamp them. Additive + nullable (NULL = legacy
  // row, served by the `_legacy` fallback triggers; see CHUNKS_FTS_TRIGGERS).
  ensureColumn(db, 'chunks', 'fts_rowid', 'fts_rowid INTEGER')
  ensureColumn(db, 'messages', 'fts_rowid', 'fts_rowid INTEGER')
  ensureChunksFts(db)
  ensureMessagesFts(db)
  ensureMessagesFtsKindFilter(db)
  ensureMessagesFtsUpdateKindFilter(db)
  ensureFtsRowidSync(db)
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
