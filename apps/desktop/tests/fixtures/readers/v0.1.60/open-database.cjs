// Reader snapshot open-database.cjs: apps/desktop/src/main/services/db.ts at v0.1.60 (5a4894ae17fef711d71c4c8d74229de018139b2f),
// bundled by scripts/release/snapshot-readers.mjs with vite 6.4.6 in library mode (CommonJS, node:* imports only).
// Generated from the tag: never edit; rerun the recipe. Provenance: open-database.provenance.json.
"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const node_module = require("node:module");
const node_crypto = require("node:crypto");
function ocrMetaFromJson(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (!v || !Array.isArray(v.pages)) return null;
    let pageCount = 0;
    for (const p of v.pages) {
      const pageNumber = p?.pageNumber;
      const text = p?.text;
      if (typeof pageNumber === "number" && Number.isInteger(pageNumber) && typeof text === "string") {
        pageCount++;
      }
    }
    if (pageCount === 0) return null;
    return {
      pageCount,
      languages: Array.isArray(v.languages) ? v.languages.filter((l) => typeof l === "string") : [],
      engineId: typeof v.engineId === "string" ? v.engineId : "unknown",
      createdAt: typeof v.createdAt === "string" ? v.createdAt : ""
    };
  } catch {
    return null;
  }
}
const nodeRequire = node_module.createRequire(process.execPath);
const { DatabaseSync } = nodeRequire("node:sqlite");
const statementCaches = /* @__PURE__ */ new WeakMap();
function prepareCached(db, sql) {
  let perDb = statementCaches.get(db);
  if (!perDb) {
    perDb = /* @__PURE__ */ new Map();
    statementCaches.set(db, perDb);
  }
  let stmt = perDb.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    perDb.set(sql, stmt);
  }
  return stmt;
}
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

-- Local-API access key (local-api wave P2). Single row BY CONSTRAINT. Deliberately NOT a
-- settings row: getSettings spreads every stored row to the renderer on three IPC
-- surfaces, so the secret lives in its own main-process-only table
-- (services/local-api/token.ts is the sole reader/writer). Inside the workspace DB, so
-- it is encrypted at rest on an encrypted workspace and unreadable before unlock (D7).
CREATE TABLE IF NOT EXISTS local_api_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
-- Rider: the regenerate delete still cascades, but the two legs that put the OLD answer back (a
-- non-abort generation failure, and a Stop before the first token) now capture these rows before
-- the delete and replay them with the message -- so only a SUCCESSFUL regenerate actually drops
-- the table, which is correct: that answer was genuinely replaced. See DeletedMessage in
-- services/chat.ts. Note message_id carries only an INDEX, not a UNIQUE constraint, so the
-- "ONE tabular artifact per message" wording above is an intended invariant, not an enforced one;
-- the capture/replay handles N rows in (created_at, rowid) order accordingly.
-- (No backticks in this comment: it lives inside the SCHEMA template literal.)
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

-- Evidence Pack / Review Mode (EP-1 plan §5, spec §18.1). One review per assistant message
-- (v1, service-enforced — deliberately NOT a UNIQUE constraint so relaxing later is additive).
-- ALL review text/snapshot columns are CONTENT — never logged/audited (audit stays ids/counts).
-- The tables live in the one workspace DB, so they inherit encrypted-at-rest for free (spec
-- §18.5 satisfied structurally — nothing extra built). status stores ONLY 'draft'|'ready';
-- outdated is DERIVED at read time (spec §18.4 — it must never erase ready). JSON snapshot
-- columns are nullable (plan §5 item 3) and parsed tolerantly (the parseCitations idiom).
-- The message FK CASCADEs (the result_tables template): deleteConversation deletes messages
-- with explicit SQL under PRAGMA foreign_keys = ON, which drops the whole review chain
-- (reviews → items → links, reviews → exports) automatically.
CREATE TABLE IF NOT EXISTS evidence_reviews (
  id                        TEXT PRIMARY KEY,
  conversation_id           TEXT NOT NULL,      -- denormalized for the delete-confirm count (D-2)
  message_id                TEXT NOT NULL,      -- the reviewed assistant message
  question_message_id       TEXT,               -- the question turn, when identifiable
  title                     TEXT NOT NULL,      -- content (D-6: conversation title default, renameable)
  status                    TEXT NOT NULL,      -- 'draft' | 'ready'
  reviewer_label            TEXT,               -- content (D-3: free-text label only)
  general_note              TEXT,               -- content
  answer_snapshot           TEXT NOT NULL,      -- content: the frozen answer markdown
  question_snapshot         TEXT NOT NULL,      -- content: the frozen question text ('' when none)
  source_snapshot_json      TEXT,               -- JSON EvidenceSourceSnapshot[] (content)
  coverage_snapshot_json    TEXT,               -- JSON CoverageInfo (counts/mode only)
  generation_snapshot_json  TEXT,               -- JSON EvidenceGenerationSnapshot (ids/flags only)
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  completed_at              TEXT,               -- last marked ready; NULL while draft
  freshness_ack_json        TEXT,               -- EP-1 P4: JSON { acknowledgedAt, fingerprint } — the
                                                -- acknowledged drift state (spec §15.5/§28.6); NULL = never
                                                -- acknowledged. Never touches status/completed_at (§18.4).
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_evidence_reviews_message ON evidence_reviews(message_id);
-- AUD-14: conversation_id is denormalized onto the head row purely so two conversation-scoped
-- reads never have to join through messages -- the delete-confirm COUNT (D-2) and the chat
-- transcript's chip-state batch. Both filtered on an UNINDEXED column, so each one scanned
-- every review row in the workspace; this additive index turns them into index SEARCHes.
-- (No backticks in this comment: it lives inside the SCHEMA template literal.)
CREATE INDEX IF NOT EXISTS idx_evidence_reviews_conversation ON evidence_reviews(conversation_id);

CREATE TABLE IF NOT EXISTS evidence_review_items (
  id             TEXT PRIMARY KEY,
  review_id      TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,              -- creation/render order within the review
  kind           TEXT NOT NULL,                 -- 'block' | 'selection'
  block_key      TEXT NOT NULL,                 -- stable segment key against the snapshot (plan §6.1)
  block_kind     TEXT,                          -- 'paragraph'|'list_item'|'heading'|'fence'|'table'|'blockquote';
                                                -- NULL = unknown → REQUIRED by the D-7 gate (safe direction)
  start_offset   INTEGER,                       -- selections: UTF-16 offsets into the parent block's text_snapshot
  end_offset     INTEGER,
  text_snapshot  TEXT NOT NULL,                 -- content: the unit's frozen text
  decision       TEXT NOT NULL,                 -- ReviewDecision ('not_reviewed' default)
  reviewer_note  TEXT,                          -- content
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (review_id) REFERENCES evidence_reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_evidence_review_items_review ON evidence_review_items(review_id);

CREATE TABLE IF NOT EXISTS evidence_review_links (
  id                TEXT PRIMARY KEY,
  review_item_id    TEXT NOT NULL,
  evidence_key      TEXT NOT NULL,              -- EvidenceSourceSnapshot.key (one link per item+key)
  link_origin       TEXT NOT NULL,              -- 'answer_marker' | 'reviewer' (honesty split, spec §13.3)
  reviewer_relation TEXT,                       -- 'supports'|'qualifies'|'contradicts'|'context'
  created_at        TEXT NOT NULL,
  FOREIGN KEY (review_item_id) REFERENCES evidence_review_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_evidence_review_links_item ON evidence_review_links(review_item_id);

-- Export history (D-8): metadata + content hash ONLY — no file copy, and the destination
-- path is deliberately NOT persisted (spec §18.1; file_name is the bare chosen name).
CREATE TABLE IF NOT EXISTS evidence_exports (
  id              TEXT PRIMARY KEY,
  review_id       TEXT NOT NULL,
  format          TEXT NOT NULL,                -- 'html' | 'pdf' (plain TEXT — later formats additive)
  schema_version  INTEGER NOT NULL,
  file_name       TEXT NOT NULL,                -- content-adjacent (user-chosen name; never audited)
  file_sha256     TEXT NOT NULL,
  options_json    TEXT,                         -- JSON option flags (D-4); nullable
  created_at      TEXT NOT NULL,
  FOREIGN KEY (review_id) REFERENCES evidence_reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_evidence_exports_review ON evidence_exports(review_id);

-- Knowledge packs (ZIM wave): registered external ZIM archives the chat can retrieve from
-- via the kiwix-serve sidecar. Like skills, a derived index over on-disk files — the id
-- is the archive's own UUID (read by kiwix-manage at registration), so a re-registration
-- of the same archive is an upsert and the id survives a DB rebuild. The FILE is never
-- copied (multi-GB, public, read-only — the deliberate exception to the stored-copy rule,
-- rag-design ZIM record): leaf + recorded_path follow the stored-copy resolution shape
-- (drive-relative zim/<leaf> first, recorded path second; ingestion/stored-copy.ts
-- precedent), and a missing file marks unavailable_at — never a blind delete. Metadata
-- columns are pack-level facts from the archive header (title/description/language/counts):
-- they name what the user reads, so they are CONTENT for audit/export purposes (ids/counts
-- only in runtime_events) but plain rows here inside the encrypted workspace DB.
-- No FK from conversations into this table: a chat's scope stores pack ids in
-- scope_v2_json and a removed pack degrades to "not retrieved from" (the skills C3 rule).
CREATE TABLE IF NOT EXISTS knowledge_packs (
  id             TEXT PRIMARY KEY,          -- ZIM archive UUID (natural key; stable across re-adds/rebuilds)
  title          TEXT NOT NULL,
  description    TEXT,
  language       TEXT,                      -- archive-declared ISO code ("deu", "eng")
  zim_date       TEXT,                      -- archive build date YYYY-MM-DD
  article_count  INTEGER,
  media_count    INTEGER,
  size_bytes     INTEGER,
  leaf           TEXT NOT NULL,             -- file BASENAME (portable resolution: <drive>/zim/<leaf> first)
  recorded_path  TEXT NOT NULL,             -- path as registered (fallback resolution; may be absolute)
  enabled        INTEGER NOT NULL,          -- 0/1 (a disabled pack stays registered but is never queried)
  unavailable_at TEXT,                      -- NULL = file present at last look; ISO stamp = vanished (never blind-deleted)
  removed_at     TEXT,                      -- tombstone: user removed the registration. The ROW stays so
                                            -- drive auto-discovery (keyed by leaf) cannot resurrect a
                                            -- deliberately removed pack; an explicit re-add clears it.
  searchable     TEXT,                      -- CONFIRMED full-text capability: 'yes' | 'no'; NULL = unknown (never probed,
                                            -- or the cache key below moved). Only a validated /suggest probe writes it.
  searchable_key TEXT,                      -- the fingerprint the verdict was taken under: <size>:<mtimeMs> of the archive
                                            -- plus the kiwix-serve binary's <size>:<mtimeMs>. A different key resets the verdict.
  ftindex_hint   TEXT,                      -- the archive's own _ftindex tag ('yes' | 'no'; NULL = no tag) — a HINT only:
                                            -- it never sets searchable and never affects an ask's eligibility.
  added_at       TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;
function ensureColumn(db, table, column, ddl) {
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!ident.test(table) || !ident.test(column) || !/^[A-Za-z0-9_ ]+$/.test(ddl)) {
    throw new Error(`ensureColumn: unsafe identifier/DDL (${table}.${column}: ${ddl})`);
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
function backfillOcrMeta(db) {
  const rows = db.prepare(
    "SELECT id, ocr_json FROM documents WHERE ocr_json IS NOT NULL AND ocr_meta_json IS NULL"
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare("UPDATE documents SET ocr_meta_json = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const meta = ocrMetaFromJson(r.ocr_json);
      if (meta) update.run(JSON.stringify(meta), r.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
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
`;
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
`;
function backfillFtsRowids(db, target, ownTransaction = true) {
  const fts = target === "chunks" ? "chunks_fts" : "messages_fts";
  const key = target === "chunks" ? "chunk_id" : "message_id";
  const rows = db.prepare(`SELECT rowid AS r, ${key} AS id FROM ${fts}`).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE ${target} SET fts_rowid = ? WHERE id = ? AND fts_rowid IS NULL`);
  if (!ownTransaction) {
    for (const row of rows) update.run(row.r, row.id);
    return;
  }
  db.exec("BEGIN");
  try {
    for (const row of rows) update.run(row.r, row.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
function ensureFtsRowidSync(db) {
  const upgrade = (adTrigger, triggerNames, ddl, target) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?").get(adTrigger);
    if (row?.sql.includes("fts_rowid")) return;
    db.exec("BEGIN");
    try {
      db.exec(triggerNames.map((n) => `DROP TRIGGER IF EXISTS ${n};`).join("\n") + ddl);
      backfillFtsRowids(
        db,
        target,
        /* ownTransaction */
        false
      );
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  };
  upgrade(
    "chunks_fts_ad",
    ["chunks_fts_ai", "chunks_fts_ad", "chunks_fts_au", "chunks_fts_ad_legacy", "chunks_fts_au_legacy"],
    CHUNKS_FTS_TRIGGERS,
    "chunks"
  );
  upgrade(
    "messages_fts_ad",
    ["messages_fts_ai", "messages_fts_ad", "messages_fts_au", "messages_fts_ad_legacy", "messages_fts_au_legacy"],
    MESSAGES_FTS_TRIGGERS,
    "messages"
  );
}
function ensureChunksFts(db) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_fts'").get();
  if (exists) return;
  db.exec(`
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, chunk_id UNINDEXED);
${CHUNKS_FTS_TRIGGERS}
INSERT INTO chunks_fts(text, chunk_id) SELECT text, id FROM chunks;
`);
  backfillFtsRowids(db, "chunks");
}
function ensureMessagesFts(db) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'").get();
  if (exists) return;
  db.exec(`
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED);
${MESSAGES_FTS_TRIGGERS}
INSERT INTO messages_fts(content, message_id) SELECT content, id FROM messages WHERE kind IS NOT 'compaction';
`);
  backfillFtsRowids(db, "messages");
}
function ensureMessagesFtsKindFilter(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_ai'").get();
  if (!row || row.sql.includes("new.kind")) return;
  db.exec(`
DROP TRIGGER messages_fts_ai;
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind IS NOT 'compaction' BEGIN
  INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
END;
DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE kind = 'compaction');
`);
}
function ensureMessagesFtsUpdateKindFilter(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_au'").get();
  if (!row || row.sql.includes("new.kind")) return;
  db.exec(`
DROP TRIGGER messages_fts_au;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(content, message_id)
    SELECT new.content, new.id WHERE new.kind IS NOT 'compaction';
END;
`);
}
function seedCollections(db) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const ensureBuiltin = (type, name) => {
    const existing = db.prepare("SELECT id FROM collections WHERE type = ? LIMIT 1").get(type);
    if (existing) return existing.id;
    const id = node_crypto.randomUUID();
    db.prepare(
      `INSERT INTO collections (id, name, type, description, builtin, color, created_at, updated_at, archived_at, retention_policy_json)
       VALUES (?, ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL)`
    ).run(id, name, type, now, now);
    return id;
  };
  const libraryId = ensureBuiltin("library", "Library");
  ensureBuiltin("temporary", "Temporary");
  db.prepare(
    `INSERT INTO document_collections (document_id, collection_id, role, added_at)
     SELECT d.id, ?, 'source', ?
     FROM documents d
     WHERE d.status = 'indexed'
       AND d.origin_json IS NULL
       AND NOT EXISTS (SELECT 1 FROM document_collections dc WHERE dc.document_id = d.id)`
  ).run(libraryId, now);
}
const SCHEMA_VERSION = 1;
class WorkspaceNewerError extends Error {
  constructor(found, supported = SCHEMA_VERSION) {
    super(
      `The workspace database was written by a newer build (schema ${found}; this build reads up to ${supported})`
    );
    this.found = found;
    this.supported = supported;
    this.name = "WorkspaceNewerError";
  }
}
function isWorkspaceNewerError(err) {
  return err instanceof WorkspaceNewerError || err instanceof Error && err.name === "WorkspaceNewerError";
}
function openDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    applyPragmasAndMigrations(db);
  } catch (err) {
    try {
      db.close();
    } catch {
    }
    throw err;
  }
  return db;
}
function applyPragmasAndMigrations(db) {
  const found = db.prepare("PRAGMA user_version").get().user_version;
  if (found > SCHEMA_VERSION) throw new WorkspaceNewerError(found);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA mmap_size = 268435456;");
  db.exec("PRAGMA cache_size = -16000;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec(SCHEMA);
  ensureColumn(db, "conversations", "scope_json", "scope_json TEXT");
  ensureColumn(db, "documents", "summary_json", "summary_json TEXT");
  ensureColumn(db, "documents", "origin_json", "origin_json TEXT");
  ensureColumn(db, "documents", "ocr_json", "ocr_json TEXT");
  ensureColumn(db, "documents", "ocr_meta_json", "ocr_meta_json TEXT");
  backfillOcrMeta(db);
  ensureColumn(db, "documents", "lifecycle", "lifecycle TEXT");
  ensureColumn(db, "documents", "stored_name", "stored_name TEXT");
  ensureColumn(db, "documents", "source_relative_path", "source_relative_path TEXT");
  ensureColumn(db, "documents", "source_folder_label", "source_folder_label TEXT");
  ensureColumn(db, "documents", "pending_destination_json", "pending_destination_json TEXT");
  ensureColumn(db, "documents", "expires_at", "expires_at TEXT");
  ensureColumn(db, "conversations", "collection_id", "collection_id TEXT");
  ensureColumn(db, "conversations", "scope_v2_json", "scope_v2_json TEXT");
  ensureColumn(db, "documents", "tree_status", "tree_status TEXT");
  ensureColumn(db, "documents", "tree_meta_json", "tree_meta_json TEXT");
  ensureColumn(db, "documents", "fully_chunked", "fully_chunked TEXT");
  ensureColumn(db, "documents", "extract_status", "extract_status TEXT");
  ensureColumn(db, "conversations", "active_skill_id", "active_skill_id TEXT");
  ensureColumn(db, "messages", "skill_id", "skill_id TEXT");
  ensureColumn(db, "messages", "auto_fired", "auto_fired INTEGER");
  ensureColumn(db, "messages", "coverage_json", "coverage_json TEXT");
  ensureColumn(db, "messages", "kind", "kind TEXT");
  ensureColumn(db, "messages", "covers_through_rowid", "covers_through_rowid INTEGER");
  ensureColumn(db, "messages", "truncated", "truncated INTEGER");
  ensureColumn(db, "messages", "skill_offer_json", "skill_offer_json TEXT");
  ensureColumn(db, "messages", "pack_outcomes_json", "pack_outcomes_json TEXT");
  ensureColumn(db, "evidence_reviews", "freshness_ack_json", "freshness_ack_json TEXT");
  ensureColumn(db, "bank_transactions", "category_id", "category_id TEXT");
  ensureColumn(db, "bank_transactions", "reconciled", "reconciled INTEGER");
  ensureColumn(db, "bank_transactions", "confidence", "confidence REAL");
  ensureColumn(db, "bank_statements", "opening_balance", "opening_balance REAL");
  ensureColumn(db, "bank_statements", "closing_balance", "closing_balance REAL");
  ensureColumn(db, "bank_statements", "categorized_by_model", "categorized_by_model INTEGER");
  ensureColumn(db, "bank_statements", "extractor_version", "extractor_version INTEGER");
  ensureColumn(db, "bank_statements", "date_order_inferred", "date_order_inferred TEXT");
  ensureColumn(db, "bank_statements", "dropped_row_count", "dropped_row_count INTEGER");
  ensureColumn(db, "invoices", "extractor_version", "extractor_version INTEGER");
  ensureColumn(db, "invoices", "date_order_inferred", "date_order_inferred TEXT");
  ensureColumn(db, "invoices", "dropped_row_count", "dropped_row_count INTEGER");
  ensureColumn(db, "invoices", "recipient", "recipient TEXT");
  ensureColumn(db, "invoices", "text_quality", "text_quality TEXT");
  ensureColumn(db, "knowledge_packs", "unavailable_reason", "unavailable_reason TEXT");
  ensureColumn(db, "knowledge_packs", "searchable", "searchable TEXT");
  ensureColumn(db, "knowledge_packs", "searchable_key", "searchable_key TEXT");
  ensureColumn(db, "knowledge_packs", "ftindex_hint", "ftindex_hint TEXT");
  db.exec(
    // DB-4/RAG-4: every retrieval + stale-check filters embeddings WHERE embedding_model_id = ?.
    "CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(embedding_model_id);"
  );
  db.exec(
    // DB-6: unscoped "list every date/amount" filters on record_type (and record_type,
    // normalized_value) with no leading document_id — the doc-leading idx_extract_doc_type can't
    // serve it. The doc-leading index still serves the scoped (per-document) queries.
    "CREATE INDEX IF NOT EXISTS idx_extract_type_nv ON extraction_records(record_type, normalized_value);"
  );
  db.exec(
    // DB-7: documents.status is filtered on every list + the re-index honesty check.
    "CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);"
  );
  db.exec(
    // DB-7: bank_transactions.category_id (a migrated column) — joined as transaction volume grows.
    "CREATE INDEX IF NOT EXISTS idx_bank_transactions_category ON bank_transactions(category_id);"
  );
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
    "CREATE INDEX IF NOT EXISTS idx_messages_conv_kind ON messages(conversation_id, kind);"
  );
  db.exec(
    // PERF-4 (full audit 2026-06-28): summary_cache eviction deletes the oldest rows
    // `ORDER BY created_at ASC`, but the table's only key was the PK (content_hash, model_id), so
    // each over-cap tree build did a full scan + temp B-tree sort of up to 50k rows. This makes
    // eviction an ordered index scan (LIMIT-bounded — the residual partial sort is only the
    // content_hash tiebreak within an identical created_at).
    "CREATE INDEX IF NOT EXISTS idx_summary_cache_created ON summary_cache(created_at);"
  );
  db.exec(
    // PF-3 (full audit 2026-07-10): the audit-log retention prune orders runtime_events by
    // created_at (audit.ts pruneAuditEvents); the table's only prior key was the TEXT PK, so
    // every prune full-scanned + temp-B-tree-sorted the table. Same additive ensure-on-open
    // idiom as idx_summary_cache_created above, so it applies to existing workspaces too.
    "CREATE INDEX IF NOT EXISTS idx_runtime_events_created ON runtime_events(created_at);"
  );
  ensureColumn(db, "chunks", "fts_rowid", "fts_rowid INTEGER");
  ensureColumn(db, "messages", "fts_rowid", "fts_rowid INTEGER");
  ensureChunksFts(db);
  ensureMessagesFts(db);
  ensureMessagesFtsKindFilter(db);
  ensureMessagesFtsUpdateKindFilter(db);
  ensureFtsRowidSync(db);
  seedCollections(db);
  if (found < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}
function listTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return rows.map((r) => r.name);
}
exports.SCHEMA_VERSION = SCHEMA_VERSION;
exports.WorkspaceNewerError = WorkspaceNewerError;
exports.isWorkspaceNewerError = isWorkspaceNewerError;
exports.listTables = listTables;
exports.openDatabase = openDatabase;
exports.prepareCached = prepareCached;
