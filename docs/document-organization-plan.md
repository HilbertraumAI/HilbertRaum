# Document organization plan — Library / Projects / Temporary / Generated / Archive

_Status: **WORKING PAPER — not implemented.** Open plan; condense into a §-numbered design
record in `docs/rag-design.md` (scope) + `docs/architecture.md` (data model / IPC) +
`docs/user-guide.md` (UX) once the feature ships, then delete this file (CLAUDE.md doc-lifecycle
rule)._

_Created: 2026-06-14. Author: planning pass on branch `Improved-Document-Structure`._

> This is a planning document only. **No feature code is written in this pass.** It is grounded in
> the current schema, retrieval pipeline, IPC surface, and renderer as they exist today (file paths
> and symbol names cited inline are real and were read for this plan). Where a decision is genuinely
> the product owner's, it is listed in §21 (Open questions) rather than silently chosen.

---

## 1. Summary

HilbertRaum can import, parse, chunk, embed, and answer over documents, but the corpus is a single
flat pile. Every imported file lands in one undifferentiated set; a one-off invoice dragged into a
chat pollutes the same space as a permanent company policy. There is no notion of *why* a document
is on the drive.

This plan adds a **document-organization layer** above the existing ingestion/retrieval pipeline,
built on **collection membership** — never duplicated files or duplicated embeddings. A document
stays one stored workspace file with one set of `chunks` and `embeddings`; organization is metadata
(`collections` + `document_collections`) plus a small `lifecycle` attribute on `documents`. Five
user-facing containers — **Library**, **Projects**, **Temporary**, **Generated** (a role, not a
place), and **Archive** — plus later **Smart views** (saved metadata filters). Retrieval is extended
to filter by collection membership in addition to the existing `scopeDocumentIds` path, which keeps
its precedence. Everything stays offline, local, and private; the change is additive at the schema,
IPC, and UX layers.

---

## 2. Current system facts (from docs + code)

Grounding for every decision below. All paths are under `apps/desktop/src/`.

### 2.1 Schema (`main/services/db.ts`)

- **`documents`**: `id, title, original_path, stored_path, mime_type, size_bytes, sha256, status,
  error_message, created_at, updated_at` + additive nullable columns `summary_json`, `origin_json`,
  `ocr_json`. `status ∈ {queued, extracting, chunking, embedding, indexed, failed, deleted}`.
- **`chunks`**: `id, document_id, chunk_index, text, source_label, page_number, section_label,
  token_count, created_at`. Index `idx_chunks_document`.
- **`embeddings`**: `chunk_id (PK), embedding_model_id, vector_blob, dimensions, created_at`. One
  vector row per chunk, tagged with the embedder that produced it.
- **`conversations`**: `id, title, created_at, updated_at, model_id, mode DEFAULT 'chat'` + additive
  nullable `scope_json`. `mode ∈ {chat, documents}`.
- **`messages`**: `id, conversation_id, role, content, created_at, token_count, citations_json`.
- **`runtime_events`** (audit): `id, event_type, message, metadata_json, created_at`.
- **`settings`**: `key, value_json, updated_at` (single-row JSON blobs, incl. `AppSettings`).
- **FTS5**: `chunks_fts(text, chunk_id UNINDEXED)` + 3 sync triggers; `messages_fts(content,
  message_id UNINDEXED)`.

### 2.2 Migration mechanism (`main/services/db.ts` → `openDatabase()`)

- **No version pragma, no migrations array.** Base schema is one idempotent `SCHEMA` constant of
  `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. Additive columns are applied by
  `ensureColumn(db, table, column, ddl)` — a `PRAGMA table_info` check then a guarded
  `ALTER TABLE … ADD COLUMN`.
- **Constraint that shapes our schema:** `ensureColumn` validates the DDL with
  `/^[A-Za-z0-9_ ]+$/`. **It cannot express `DEFAULT 'literal'` or `NOT NULL`** (no quotes, no
  punctuation). So every additive column must be **nullable with NULL as the sentinel default**,
  exactly like `scope_json` / `origin_json` today. New *tables* have no such limit (full SQL in the
  `SCHEMA` constant). FTS uses bespoke `ensureChunksFts` / `ensureMessagesFts` helpers.
- **Adding a migration** = add `CREATE TABLE IF NOT EXISTS` to `SCHEMA`, and/or call `ensureColumn`
  after the base schema, plus a one-time idempotent **seed/backfill** step (see §9).

### 2.3 Generated outputs today

- **Summary** = `documents.summary_json` (a `DocumentSummary` on the *source* row — metadata, not a
  separate document). Cleared on re-index.
- **Translation / Comparison** = a **new `documents` row** (materialized Markdown) with
  `origin_json` set to `TranslationOrigin { type:'translation', translatedFrom, targetLang }` or
  `CompareOrigin { type:'compare', comparedFrom:[a,b] }`. `original_path = NULL`. Provenance
  survives re-index (it states *where the text came from*).
- **OCR** = `documents.ocr_json` (per-page text on the source row).
- Tasks run through `main/services/doctasks/manager.ts`, IPC in `registerDocTasksIpc.ts`
  (`startDocTask`/`getDocTask`/`cancelDocTask`), kinds `summary | translation | compare | ocr`.

### 2.4 Retrieval + scope

- Entry point `retrieve(db, embedder, question, settings, scopeDocumentIds?, reranker?, signal?)`
  in `main/services/rag/index.ts`. Pipeline: `VectorIndex` (cosine) + `keywordSearchChunks` (FTS5
  bm25) → `rrfFuse` (RRF, k=60) → optional `reranker.rerank` → dedup by `(document, page)` → token
  budget trim → `S1…Sn` labels + `Citation[]`.
- **Scope is already document-ID-based and threads cleanly:** `VectorIndex` takes
  `{ embeddingModelId, documentIds }` and adds `chunk_id IN (SELECT id FROM chunks WHERE
  document_id IN (…))`; `keywordSearchChunks` adds `AND c.document_id IN (…)`. So *collection
  filtering is a strict generalization of an existing, tested mechanism.*
- **Conversation scope** = `conversations.scope_json` (JSON array of doc ids, NULL = whole corpus),
  parsed by `parseScope` in `main/services/chat.ts` — **malformed JSON silently returns null**
  (never throws). Surfaced as `Conversation.scopeDocumentIds`.
- **Filename auto-scope** = `detectFilenameScope(question, docs)` in `main/services/rag/scope.ts`.
  Applied in `registerRagIpc.ts` **only when the conversation has no explicit scope**; it can only
  narrow, emits a `STREAM.scope` notice (`api.onScopeNotice`) → a "Answering from contract.pdf only"
  toast. Excludes generic filenames; returns null if it matches the whole corpus.
- **Grounding guarantee:** if `chunks.length === 0`, the model is **never called** —
  `NO_DOCUMENT_CONTEXT_ANSWER`, or `REINDEX_NEEDED_ANSWER` when `corpusNeedsReindex(db, embedder.id)`
  (corpus invisible to the active embedder).

### 2.5 Import + IPC + preload + renderer

- Import: `IPC.importDocuments` (`docs:import`) handler in `registerDocsIpc.ts`, signature
  `importDocuments(paths: string[]): ImportJob`. `expandPaths` walks folders; `createQueuedDocument`
  rows then a background loop runs `processDocument` (copies the file into
  `workspace/documents/<id><ext>[.enc]`, parses, chunks, embeds). Async-with-polling via
  `getImportJob` / `ImportJobStatus`.
- IPC constants in `shared/ipc.ts` (`IPC` object + `STREAM` channel factory). Handlers:
  `registerDocsIpc.ts`, `registerRagIpc.ts`, `registerChatIpc.ts`, `registerDocTasksIpc.ts`.
- Preload `preload/index.ts` exposes the `api` object (e.g. `api.importDocuments`,
  `api.listDocuments`, `api.askDocuments`, `api.createConversation`, `api.updateConversationScope`).
- Renderer: `renderer/screens/DocumentsScreen.tsx` (list, per-row + bulk actions, import polling),
  `renderer/screens/ChatScreen.tsx` (`Mode = 'chat' | 'documents'`, scope state, pending-scope
  handoff), `renderer/chat/Composer.tsx` + `renderer/chat/ScopePopover.tsx` (footer scope chip +
  popover), `renderer/chat/ConversationList.tsx`.
- Types in `shared/types.ts`: `DocumentInfo`, `Conversation`, `ImportJob`, `ImportJobStatus`,
  `DocumentSummary`, `DocumentOrigin`, `StartDocTaskRequest`, `DocTaskStatus`, `AppSettings`.

### 2.6 Privacy / audit

- `main/services/audit.ts` → `runtime_events`. **Hard rule:** events carry *ids, model ids,
  filenames, counts only* — never chat/document content or passwords. Enforced by a sentinel-grep
  test (`tests/integration/audit-ipc.test.ts`). Filenames **are** already permitted (imports/deletes
  log them); **search/scope query text is not logged anywhere**.
- Whole-DB-file encryption at rest; `workspace/documents/<id><ext>.enc` sidecars; logs encrypted
  (`app.log.enc`). Offline guard is a detection-only tripwire. Renderer sandboxed; main owns file I/O.

### 2.7 Doc lifecycle obligation

Per CLAUDE.md, this working paper is condensed into a §-record and deleted once implemented. The
target homes are noted at the top.

---

## 3. Product problem

Users import two fundamentally different kinds of content with the same gesture:

1. **Long-term knowledge** — manuals, policies, research, contracts, recurring client material,
   personal records. Should persist and be the default answer corpus.
2. **Temporary analysis** — an invoice to read a due date, a screenshot for OCR, a one-off CSV, a
   PDF dropped into chat for a single question. Should be answerable *now* but must not silently
   become permanent knowledge.

Today both pollute one corpus. The app knows *what* documents exist but not *why*. Consequences:
the default "ask my documents" corpus drifts and dilutes; generated translations/comparisons clutter
the same flat list as their sources; there is no project workspace; and there is no safe place for
disposable files. The fix is an organization layer that records intent (Library / Project /
Temporary) and lets retrieval honour it.

---

## 4. Goals

- A **collection-membership** model over the existing pipeline: one stored file, one set of chunks,
  one set of vectors; organization is metadata.
- Five containers: **Library** (durable default), **Projects** (focused workspaces with scoped
  chats), **Temporary** (first-class, non-polluting one-offs), **Generated** (provenance role +
  view), **Archive** (retained, hidden from default retrieval). **Smart views** later.
- **Scoped retrieval** with an explicit, testable precedence model that *extends* — never replaces —
  selected-document asking and filename auto-scope.
- An **import-destination** flow ("Where should these go?") with sensible defaults per entry point.
- Generated outputs land in the right context and carry **structured provenance**.
- **Additive, safe migration**: existing docs → Library; existing conversations keep working;
  malformed metadata never crashes.
- **Zero erosion** of the offline / local / privacy / grounded-answer guarantees.

---

## 5. Non-goals (v1)

- No physical folders as the product truth (folder paths kept only as display metadata).
- No silent deletion of temporary files; no automatic retention sweeps (retention settings are a
  later, explicit opt-in — §14).
- No AI auto-classification / silent filing. Filing *suggestions* are a later phase (§20 Phase F),
  rule-based first.
- No per-project duplicated vectors or files. No re-embedding for organization.
- No new top-level navigation item unless analysis demands it — extend the Documents screen first.
- No change to the ingestion parser/chunker/embedder. No change to the streaming contract.
- Smart views are not materialized collections in v1 (they are query-time filters; §7.6).

---

## 6. Constraints carried from the codebase

Non-negotiable boundaries this design must respect (each grounded in §2):

- **Additive nullable columns only** (`ensureColumn` DDL allows no `DEFAULT`/`NOT NULL`/quotes —
  §2.2). NULL-as-sentinel coalesced in code (`parseScope` precedent).
- **One stored file, one chunk set, one vector set per document** — organization never duplicates
  `documents`/`chunks`/`embeddings` (§2.1, §8.4).
- **Existing `scopeDocumentIds` retrieval path is preserved and takes precedence** (§2.4, §10).
- **Grounded-answer guarantee is inviolable** — empty context ⇒ no model call (§2.4, §10.3).
- **Malformed persisted JSON must never throw** — tolerant parse → safe default everywhere (§2.4).
- **Privacy/offline hard rules + audit data-class** (ids/counts/filenames only) hold (§2.6, §17).
- **Two chat modes (`chat`/`documents`) stay distinct**; no parser/chunker/embedder change (§5).

---

## 7. Proposed user model

A **collection** is the unifying primitive. `Projects` are collections; `Library`/`Temporary` are
built-in collections; `Archive` is expressed as a lifecycle (doc-level) and `archived_at` (project-
level); `Generated` is a membership **role** plus a smart view; `Smart views` are saved filters.

### 7.1 Library (built-in, `type='library'`)

Long-term knowledge base. Created once by migration; **all existing documents become Library
members**. Library is the default corpus for "Ask my documents" when no narrower project/temporary
scope is active. Library documents are durable; they leave only via explicit Archive or Delete.
Chat attachments and one-off temporary imports do **not** enter Library unless the user keeps them.

### 7.2 Projects (`type='project'`, user-created)

Focused workspaces ("Client Müller", "Tax 2025", "Lawsuit X"). A project groups document
*memberships* and is the default scope for chats started inside it (`conversations.collection_id`).
A document can belong to a project **and** Library (and other projects) without duplicating the
stored file or its vectors — many-to-many membership. Projects can later contain generated
summaries/translations/comparisons (role `generated`).

### 7.3 Temporary (built-in, `type='temporary'` + `documents.lifecycle='temporary'`)

One-off analysis. First-class and **visible** in Documents → Temporary, never hidden. Drag/drop or
attach-to-chat defaults here. A temporary document is **excluded from Library by default** and is
tied to its originating conversation via that conversation's `scope_json` (reusing the existing
selected-document retrieval path — no new retrieval code for "ask this chat's files"). After
analysis the user sees explicit actions: **Keep in Library**, **Move to Project**, **Delete from
drive**, **Archive**. **No silent deletion in v1.**

### 7.4 Generated (role `generated`, plus a smart view)

Summaries/translations/comparisons. A materialized generated document (translation/compare) gets a
`document_collections` row with `role='generated'` in the **same collection(s) as its source(s)**
(assignment rule in §15). Provenance is structured in `documents.origin_json` (extended shape) so the
UI can render "Translated from report.pdf", "Comparison of draft.pdf and final.pdf", "Summary of
policy.pdf". Generated docs stay searchable/answerable. Snapshot semantics are unchanged (a
generated output does not auto-update when its source changes; staleness indicator is a later phase).

### 7.5 Archive

- **Document-level:** `documents.lifecycle='archived'` — retained on the drive, **excluded from
  default retrieval**, hidden from default Documents listing, reversible (back to `permanent`).
- **Project-level:** `collections.archived_at` set — the whole project is hidden from default scope;
  its documents keep their other memberships. Reversible (clear `archived_at`).
- Archived content is searchable only when **explicitly included** (`includeArchived` scope flag).

### 7.6 Smart views (later — Phase E)

Query-time filters over metadata, **not** stored collections: *Recently added*, *Unfiled* (no
non-builtin membership), *Generated by AI* (`role='generated'`), *Temporary*, *Needs re-index*
(`staleEmbeddings`), *Large files*, *Audio transcripts*, *OCR/scanned*, *Failed imports*
(`status='failed'`). A smart view is a named predicate evaluated against `documents` +
`document_collections`; selecting one as a chat scope resolves to its current document-id set.

---

## 8. Data model proposal

Additive only. New tables fully specified in SQL; new columns nullable (the `ensureColumn`
constraint in §2.2).

### 8.1 New tables (added to the `SCHEMA` constant)

```sql
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

CREATE TABLE IF NOT EXISTS document_collections (
  document_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'source', -- 'source' | 'reference' | 'generated' | 'attachment'
  added_at TEXT NOT NULL,
  PRIMARY KEY (document_id, collection_id),
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (collection_id) REFERENCES collections(id)
);
CREATE INDEX IF NOT EXISTS idx_doccoll_collection ON document_collections(collection_id);
CREATE INDEX IF NOT EXISTS idx_doccoll_document ON document_collections(document_id);
```

Notes:
- `type='archive'` and `type='smart'` are reserved in the enum but **not used as stored rows in
  v1** (archive is a lifecycle; smart views are query-time). They are listed so the column domain is
  forward-stable.
- The composite PK on `document_collections` makes membership **idempotent** (re-adding is a no-op
  via `INSERT … ON CONFLICT(document_id, collection_id) DO NOTHING`).

### 8.2 Additive columns on `documents` (all nullable — §2.2 constraint)

```sql
ensureColumn(db, 'documents', 'lifecycle',           'lifecycle TEXT')            -- null ⇒ 'permanent'
ensureColumn(db, 'documents', 'source_relative_path','source_relative_path TEXT') -- folder-import display
ensureColumn(db, 'documents', 'source_folder_label', 'source_folder_label TEXT')  -- top-level folder name
ensureColumn(db, 'documents', 'last_used_at',        'last_used_at TEXT')         -- touched on answer/preview
ensureColumn(db, 'documents', 'expires_at',          'expires_at TEXT')           -- reserved; null in v1
```

- `lifecycle ∈ {permanent, temporary, archived}` with **NULL treated as `permanent`** everywhere
  (a `docLifecycle(row)` helper centralizes the coalesce, mirroring `parseScope`).
- `origin_json` is **reused, shape extended** (no new column) — see §15.

### 8.3 Additive column on `conversations`

```sql
ensureColumn(db, 'conversations', 'collection_id', 'collection_id TEXT') -- project/collection scope; null = library/all
```

`Conversation` gains `collectionId: string | null`. `scope_json` is **unchanged** (still a doc-id
array) and continues to take precedence (explicit selected docs). Decision: **Projects are
collections, not a separate table** (§16.1), so a single `collection_id` covers both "this chat is in
project X" and any future "this chat is pinned to Library/a smart view".

### 8.4 Why membership, not duplication

`embeddings` is keyed by `chunk_id`, `chunks` by `document_id`. Organization never touches either.
Filtering by collection is a JOIN/EXISTS against `document_collections` — the same shape as the
existing `documentIds` filter, so vectors and chunks are shared across every collection a document
belongs to. This is the core architectural principle (§4) and the reason the change is cheap.

---

## 9. Migration proposal

A single idempotent migration run inside (or right after) `openDatabase`, guarded so re-runs and a
partially-migrated DB are safe.

1. **Create tables** — `collections`, `document_collections` via the `SCHEMA` constant (idempotent).
2. **Add columns** — the `ensureColumn` calls in §8.2/§8.3.
3. **Seed built-ins (idempotent):** if no `type='library'` row exists, insert **one** Library
   collection (`builtin=1`); if no `type='temporary'` row exists, insert **one** Temporary
   collection (`builtin=1`). Names come from i18n at seed time but are stored as a stable English
   canonical (`'Library'`, `'Temporary'`) — the UI renders a localized label keyed off `builtin` +
   `type`, never the stored name, so a German user still sees "Bibliothek"/"Temporär". (Mirrors the
   persist-canonical-English / display-map rule from the i18n record.)
4. **Backfill Library membership (idempotent):** for every `documents` row that has **no**
   `document_collections` row at all, insert `(document_id, library_id, role='source', added_at=now)`.
   Guarding on "has no membership" makes this a one-time effect that never double-files.
5. **Backfill generated provenance (best-effort):** existing rows with `origin_json` (translations/
   comparisons) keep Library membership but additionally get `role='generated'` membership where
   their source's collection is unambiguous (initially: Library). The `origin_json` shape is widened
   lazily (read tolerates the old shape; §15).
6. **Lifecycle:** all existing docs get `lifecycle` NULL ⇒ `permanent` (no write needed).
7. **Indexes** from §8.1.

Conversation interpretation:
- Existing conversations keep `scope_json` working unchanged. `collection_id` is NULL ⇒ interpreted
  as **Library** scope in documents mode (§10). Because migration puts every existing doc in Library,
  **Library initially equals "all documents"**, so behaviour is identical on day one and diverges
  only as the user adds Temporary/Archived/Project-only docs — exactly the intended drift away from a
  polluted default.

Safety / compatibility:
- All JSON parses tolerate malformed input → safe default (the `parseScope` precedent), so a corrupt
  `origin_json`/`retention_policy_json` never crashes.
- **Version skew:** a *pre-feature* app opening a *post-feature* DB still works — the new tables/
  columns are simply unread, and `scope_json`/`mode` are unchanged. It will not honour collections
  (it shows the flat corpus), which is consistent with the existing "drives ship the app beside the
  data" stance (cf. the v2-vault skew note in `known-limitations.md`). Documented there, not a
  blocker. No down-migration is provided (additive only).

---

## 10. Retrieval / scope proposal

### 10.1 Precedence model (decided)

Resolved per request by a new pure `resolveScope(db, conv, question)` in `main/services/rag/`
(unit-testable, no I/O beyond reads). Highest wins:

1. **Explicit selected documents** — `conv.scopeDocumentIds` non-empty ⇒ retrieve from exactly those
   ids (today's behaviour, untouched). Filename auto-scope is **not** run.
2. **Conversation temporary attachments** — for a chat that has temporary attachments, those ids are
   already in `scope_json` (§7.3), so they flow through rule 1. (A temporary chat *is* a selected-docs
   chat under the hood.)
3. **Project scope** — `conv.collectionId` points at a `type='project'` collection ⇒ retrieve from
   that collection's members (`scopeCollectionIds=[collectionId]`).
4. **Library (default)** — `conv.collectionId` NULL in documents mode ⇒ `scopeCollectionIds=[libraryId]`.
5. **All documents** — only when the user explicitly picks "All documents" in the scope popover ⇒
   no collection/doc filter (whole corpus, archived still excluded unless toggled).
6. **Archive excluded by default** at every level — `includeArchived=false` adds
   `lifecycle != 'archived'` and excludes members of archived projects, unless the scope explicitly
   includes archived.
7. **Filename auto-scope narrows within the active scope.** `detectFilenameScope` runs over the
   **documents visible in the resolved scope** (not the whole corpus): a project chat asking
   "summarize contract.pdf" matches the project's `contract.pdf` first. If no match inside the active
   scope, v1 does **not** silently widen to Library/all (it just answers from the active scope);
   widening with an explicit notice is an open question (§21). On **multiple matches** inside scope,
   do not guess — scope to *all* matches and surface a disambiguation notice ("Two files match
   'contract' — answering from both") via the existing `STREAM.scope` channel (extended payload).

### 10.2 Backend shape (decided)

Extend the existing, tested doc-id filter rather than replacing it. `retrieve(...)` gains an options
object so the signature stays backward compatible:

```ts
// main/services/rag/index.ts
export interface RetrievalScope {
  documentIds?: string[] | null       // explicit selected docs — existing behaviour
  collectionIds?: string[] | null     // NEW — membership filter
  includeArchived?: boolean           // NEW — default false
}
// retrieve(db, embedder, question, settings, scope?, reranker?, signal?)
```

`documentIds` (when present) **wins** and short-circuits `collectionIds` (explicit selection is
absolute). Otherwise `collectionIds` is applied. To stay index-friendly for a large Library, the
filter is pushed into SQL as an `EXISTS` against `document_collections`, **not** a materialized
`IN (…thousands…)`:

- `VectorIndex` (`main/services/embeddings/index.ts`) `VectorIndexOptions` gains
  `collectionIds?: string[] | null` + `includeArchived?: boolean`; `search()` adds:
  ```sql
  AND EXISTS (SELECT 1 FROM document_collections dc JOIN chunks c2 ON c2.id = embeddings.chunk_id
              WHERE dc.document_id = c2.document_id AND dc.collection_id IN (…))
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c2.document_id AND d.lifecycle = 'archived')
  ```
  (final SQL tuned during implementation; the point is EXISTS-over-membership, with the
  `idx_doccoll_*` indexes).
- `keywordSearchChunks` (`main/services/rag/hybrid.ts`) `KeywordSearchOptions` gains the same and
  adds the analogous `JOIN document_collections` / archived-exclusion.

Backward-compat shim: a thin overload keeps the old positional `scopeDocumentIds` callers (and tests)
valid by mapping to `{ documentIds }`.

### 10.3 Composition with the rest of the pipeline

- **RRF fusion, reranker, citation generation** are unaffected — they operate on whatever candidate
  set the scoped vector/keyword searches return.
- **Embedder-visibility honesty stays:** keyword hits still require a vector under the active
  embedder; `corpusNeedsReindex` is now evaluated **within the active scope** so a project whose
  docs are all stale yields `REINDEX_NEEDED_ANSWER`, not a misleading "nothing found".
- **Grounded-answer guarantee preserved:** if the scoped+filtered candidate set is empty, the model
  is **not** called — `NO_DOCUMENT_CONTEXT_ANSWER`. Collection filtering can only shrink the set, so
  this guarantee strengthens, never weakens.

### 10.4 `scope_json` evolution (decided)

Keep `scope_json` as a **doc-id array** for backward compatibility and for the "explicit selected
docs" + "temporary attachments" cases. Project/Library/All/Archive scope is carried by the new
`conversations.collection_id` + a small **session-only** scope kind for the transient "All
documents" / "Library + project" choices (mirrors how answer-depth is per-session). A richer
persisted `DocumentScope` JSON column is **deferred** (open question §21) — `collection_id` +
`scope_json` cover every v1 case without a third storage shape.

---

## 11. Import UX proposal

### 11.1 The destination question

A calm "Where should these files go?" step on import, with three options (copy avoids jargon):

- **Library** — "Keep as part of my long-term knowledge."
- **Project** — pick an existing project or create one.
- **Temporary analysis** — "Use for this task. Keep out of my Library unless I save it later."

### 11.2 Defaults per entry point (decided)

- Import from the **Documents screen** → **Library** (preselected; the destination chooser still
  shows so the user can redirect).
- Import from **inside a Project** view → that **Project**.
- **Drag/drop or attach into Chat** → **Temporary**, membership in the global Temporary collection +
  added to the active conversation's `scope_json` (so the chat answers from it by default).
- **Folder import** → preserve `source_relative_path` + `source_folder_label` as metadata; do **not**
  auto-create collections in v1. Destination still asked (defaults Library). Optional later mode:
  "Create projects from top-level folders."

### 11.3 IPC change for import (additive, backward-compatible)

```ts
// shared/types.ts
export type ImportDestination =
  | { kind: 'library' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'temporary' }
  | { kind: 'conversation'; conversationId: string } // temp + tie to a chat's scope_json

export interface ImportOptions {
  destination?: ImportDestination     // default { kind: 'library' }
  preserveRelativePaths?: boolean      // folder import
}
```

`importDocuments(paths: string[], options?: ImportOptions)` — **old callers (no options) keep working**
and default to Library, preserving existing behaviour exactly. The background loop, after a document
reaches `indexed`, writes the membership row(s) + lifecycle + folder metadata. **Membership is added
on success only**; a failed import creates no membership (consistent cleanup — §17). The
async-with-polling model and friendly per-file errors are untouched.

### 11.4 Duplicate handling on import (recommended, open-question-flagged)

On import, if a file's `sha256` matches an **already-indexed** document, offer "This file is already
in your drive — add it to <destination>?" → add a **membership** to the existing row instead of
re-storing/re-embedding. If the user declines (or sha differs), store a new row. v1 default:
**add-membership on exact sha match** (no duplicate vectors); intentional duplicates remain possible
by choosing "import as new". (See §16.7/§16.8 and §21.)

---

## 12. Documents screen proposal

Keep the top-level IA simple — **no new nav item**; expand `DocumentsScreen.tsx`. Add a left
**section rail** (collapsible) of saved filters, and keep the existing table as the main surface.

### 12.1 Left section filters

- **Library** (default selected)
- **Projects** → each project (with doc count, failed/needs-reindex badge)
- **Temporary**
- **Generated** (smart view: `role='generated'`)
- **Archived** (smart view: `lifecycle='archived'` ∪ archived-project members)
- **All documents**
- *(Phase E: Recently added, Unfiled, Needs re-index, Large files, Failed imports, Audio, OCR)*

### 12.2 Main table columns

file name · status · collection/project chips · lifecycle · source path / folder label · generated
provenance · last used · size · row actions. (Honour the existing 40px row height + spacing-exception
checkbox a11y note from `known-limitations.md`.)

### 12.3 Actions

- **Per-row:** Ask · Preview · Summarize · Translate · Re-index · Add/Move to collection · Mark
  temporary/permanent · Archive/Unarchive · Delete from drive · Export. (Existing Summarize/
  Translate/Compare/OCR/Re-index/Preview/Export/Delete are preserved verbatim; the new ones are
  additive.)
- **Bulk (existing selection model):** Ask selected · Compare selected · Summarize · Move to project ·
  Add to Library · Mark temporary · Archive · Delete from drive.
- **Project management:** create · rename · archive · delete. **Delete-project** prompts: *Remove the
  project only* (drop memberships, keep documents — they remain in Library/other projects/Unfiled) vs
  *Delete the project and its documents* (only documents whose **sole** non-builtin membership was
  this project are deleted; explicit, never silent). Built-in Library/Temporary are not deletable.

### 12.4 Copy (calm, non-technical — design-guidelines §7)

User-facing terms: **Library**, **Project**, **Temporary analysis**, **Generated**, **Archived**.
Forbidden in UI text: "bucket", "vector", "scope_json", "FTS", "collection_id", "membership",
"embedding". New i18n keys land in `shared/i18n/{en,de}.ts` (flat namespaced keys, e.g.
`docs.section.library`, `docs.section.temporary`, `docs.action.moveToProject`,
`docs.temp.keepInLibrary`, `docs.provenance.translatedFrom`); German copy follows the D-L7 review
discipline (note in BUILD_STATE for the next German pass).

---

## 13. Chat UX proposal

Extend the existing `Composer` footer + `ScopePopover`; **do not** collapse the two chat modes
(`chat` vs `documents`) — that distinction is load-bearing and out of scope.

### 13.1 Footer scope text (examples)

- "Using Library"
- "Using Project: Tax 2025"
- "Using Temporary files in this chat"
- "Using 3 selected documents"
- "Using all documents"
- "Using Library + Project: Tax 2025" (only when explicitly chosen)

### 13.2 Scope popover options

Current project · Library · Library + current project · Temporary files only · Selected documents… ·
All documents. (Plain-chat mode shows no document scope, as today.)

### 13.3 Rules (consistent with §10 precedence)

- A chat started from a **Project** defaults to that project (`collection_id` set at
  `createConversation`).
- A chat with **temporary uploads** defaults to those files (they live in `scope_json`).
- **Explicit selected documents always win** (existing chips above the composer stay).
- **Filename auto-scope narrows within the active scope** and still emits the `STREAM.scope` toast.
- **"All documents" is explicit**, never the invisible default inside a project.
- Scope changes are **visible** (footer text + chips). Existing conversations preserve their scope
  behaviour (null `collection_id` ⇒ Library, which == all on day one).

### 13.4 Conversation ↔ project association

- `createConversation(opts)` gains `collectionId`. `ChatScreen` passes the active project when a chat
  is started from a project context (mirrors the existing `pendingScope` handoff pattern in
  `ChatScreen.tsx`).
- New IPC `setConversationCollection(conversationId, collectionId | null)` (parallel to
  `updateConversationScope`).
- **Conversation list grouping:** group the existing `ConversationList` by project (a project header
  with its chats), with an "Other / Library" group for unscoped chats. Keep it a view change, not a
  new screen.
- **Dangling scope safety:** if a conversation's `collection_id` references an **archived or deleted**
  project, the footer shows a quiet "This project was archived — answering from Library" and falls
  back to Library scope (never an error, never an empty silent corpus). Same calm-fallback discipline
  as malformed `scope_json`.

---

## 14. Temporary lifecycle proposal

### 14.1 v1 behaviour (decided)

- Temporary imports are visible in **Documents → Temporary** (`lifecycle='temporary'` ∪ Temporary
  collection membership).
- **Excluded from Library by default**; included in the originating chat/project only.
- Per-file actions: **Keep in Library** (add Library membership, set `lifecycle='permanent'`, drop
  Temporary membership), **Move to Project** (add project membership, set permanent, drop Temporary),
  **Delete from drive**, **Archive**.
- **No silent deletion.** No retention sweep ships in v1.
- **Delete** removes the workspace copy + `chunks` + `embeddings` + all memberships (existing delete
  path, extended to clear `document_collections`); it **never touches the original source file** on
  the user's disk (the stored copy is a copy — existing contract).

### 14.2 Temporary ↔ conversation

- A temporary file attached to a chat is in that conversation's `scope_json`. **Deleting a
  conversation does NOT delete its temporary files** (they remain in Documents → Temporary for
  review) — avoids surprise data loss; cleanup is explicit. (Open question §21: offer "also delete N
  temporary files used only here?" at conversation delete.)
- **Deleting a temporary document** that an old conversation cited: the existing deleted-document
  handling applies (citations already tolerate missing docs). Old transcripts keep their persisted
  citation snippets; the source panel shows "source no longer available" where a live doc is needed.
  No new breakage introduced.

### 14.3 Later (Phase E) — explicit retention

- Setting "Delete temporary files after: Never / 7 days / 30 days" (default **Never**), driving
  `documents.expires_at`. Must have a **review UI** (a list of what *would* be deleted, with a keep
  action) before anything is removed; must never touch Library docs, generated outputs, or
  project-filed docs; must work under an encrypted workspace (shred sidecars correctly). Strictly
  opt-in and understandable. `retention_policy_json` on `collections` reserves the per-collection
  variant.

---

## 15. Generated provenance proposal

### 15.1 Structured provenance (extend `origin_json`, no new column)

```ts
// shared/types.ts — additive, backward-compatible (old shape still parses)
export interface GeneratedProvenance {
  kind: 'summary' | 'translation' | 'compare' | 'transcript' | 'other'
  sourceDocumentIds: string[]
  sourceCollectionIds?: string[]   // collections of the source(s) at creation time
  modelId?: string                 // if cheaply known
  createdAt: string
}
```

`DocumentOrigin` becomes a discriminated union that **still accepts** the existing
`TranslationOrigin` / `CompareOrigin` shapes (read path tolerant — the `parseOrigin` precedent), with
the richer `GeneratedProvenance` written going forward. **Summary stays `summary_json` metadata** on
the source row (do not churn it into a separate document — §16/§11.3 of `known-limitations.md`
describe the current summary contract; converting it is an open question §21, leaning *keep as
metadata*).

### 15.2 Membership assignment for materialized generated docs (decided)

When a translation/compare produces a new `documents` row:
- Single source, single collection ⇒ `role='generated'` membership in that collection.
- **Active project context present** (task started from a project) ⇒ the active project (records all
  `sourceCollectionIds` in provenance).
- Sources span multiple collections, no active project ⇒ membership in the **intersection** if
  non-empty, else **Library**, recording all source collection ids in provenance. (Do not silently
  scatter into every source collection; do not prompt in v1 — keep it deterministic. Prompting is
  §21.)
- Generated docs are **excluded from Library default** only if they land outside Library; otherwise
  they are normal Library members and answerable.

### 15.3 UI provenance + staleness

- Render "Translated from report.pdf", "Comparison of draft.pdf and final.pdf", "Summary of
  policy.pdf" from structured provenance (not parsed display strings).
- Snapshot semantics preserved (no auto-update; re-run the task after source changes — the existing
  documented behaviour).
- **Staleness indicator is a later phase:** flag when a source was re-indexed after the generated
  output's `createdAt`, or a source was deleted/archived/moved. v1 only keeps the data needed to
  compute it later (`createdAt` + `sourceDocumentIds`).

---

## 16. IPC / API changes (minimum surface)

New `shared/ipc.ts` channels (under a `collections:` / extended `docs:` namespace) + preload methods
+ handlers in a new `registerCollectionsIpc.ts` (and small edits to `registerDocsIpc.ts` /
`registerChatIpc.ts`):

| Channel (const) | Signature | Handler |
|---|---|---|
| `collections:list` | `() => Collection[]` | new `registerCollectionsIpc.ts` |
| `collections:create` | `(name, type, opts?) => Collection` | new |
| `collections:rename` | `(id, name) => Collection` | new |
| `collections:setArchived` | `(id, archived: boolean) => Collection` | new |
| `collections:delete` | `(id, mode: 'membershipOnly' \| 'withDocuments') => void` | new |
| `docs:addToCollection` | `(documentIds[], collectionId, role?) => void` | `registerDocsIpc` |
| `docs:removeFromCollection` | `(documentIds[], collectionId) => void` | `registerDocsIpc` |
| `docs:setLifecycle` | `(documentIds[], 'permanent'\|'temporary'\|'archived') => DocumentInfo[]` | `registerDocsIpc` |
| `docs:import` (extend) | `(paths[], options?: ImportOptions) => ImportJob` | `registerDocsIpc` |
| `docs:list` (extend) | `(filter?: { collectionId?, lifecycle?, smart? }) => DocumentInfo[]` | `registerDocsIpc` |
| `chat:setCollection` | `(conversationId, collectionId\|null) => Conversation` | `registerChatIpc` |
| `chat:createConversation` (extend) | `opts.collectionId?` | `registerChatIpc` |

Type additions in `shared/types.ts`: `Collection`, `CollectionType`, `DocumentCollectionRole`,
`DocumentScope`/`RetrievalScope`, `ImportDestination`, `ImportOptions`, `GeneratedProvenance`;
`DocumentInfo` gains `collections?: { id; name; type; role }[]`, `lifecycle`, `sourceFolderLabel`,
`lastUsedAt`; `Conversation` gains `collectionId`. All additive/optional so existing renderer code
compiles. Preload `api` mirrors each method (1:1 `ipcRenderer.invoke`), keeping the bridge typed and
narrow (security-model rule). **Move** = compose addToCollection + removeFromCollection (no separate
channel) so semantics are explicit and testable (§16.8).

---

## 17. Security / privacy / offline impact

No erosion of any hard rule. Specifics:

- **Offline / no cloud / no telemetry:** collection operations are pure local SQLite writes — no
  network, no model calls (filing suggestions in Phase F stay local + non-silent). Works fully with
  zero models/binaries (organization needs neither).
- **Encryption at rest:** `collections` + `document_collections` live **inside the same workspace
  DB**, so they are encrypted with the DB on an encrypted workspace. No new plaintext artifacts.
  Temporary files are stored exactly like any document (`<id><ext>.enc`); **Delete shreds the sidecar
  + chunks + embeddings + memberships** (extend the existing delete path to also `DELETE FROM
  document_collections WHERE document_id = ?`).
- **Renderer sandbox / IPC:** new IPC is typed and narrow; main owns all file I/O and membership
  writes. `docs:import` continues to accept caller paths (the documented existing trust posture —
  unchanged, not worsened).
- **Audit policy (decided, consistent with the §2.6 hard rule):**
  - `collection_created` / `collection_renamed` / `collection_archived` / `collection_deleted` —
    record **collection id + type + affected document count**; the **name is content-ish** (a project
    name like "Lawsuit Müller" can be sensitive), so log id+type+count only, **not the name** (more
    conservative than the existing filename allowance — recommended; final call is §21).
  - `documents_moved` / `added`/`removed` from collections — **ids + counts only**, no content.
  - **Search / scope query text is never logged** (unchanged).
  - Filenames keep their existing audit treatment (already permitted), but project/collection names
    do not, per above.
- **No user data in logs;** the encrypted `app.log.enc` discipline is unchanged.

---

## 18. Performance impact

- **Membership filter is index-backed:** `idx_doccoll_collection` / `idx_doccoll_document` + the
  EXISTS push-down keep scoped vector/keyword search at the same order as today's `documentIds`
  filter. Pushing membership into SQL (not materializing thousands of ids into `IN (…)`) is the
  explicit choice for a large Library.
- **Vector search is still a linear cosine scan** over the *scoped* embedding rows — scoping to a
  project **reduces** the scan vs whole-corpus, so project chats get faster, not slower. (The ANN
  upgrade path is untouched.)
- **Listing** the Documents screen with chips needs one extra join (`document_collections` →
  `collections`); negligible at the 1000-chunk/file corpus scale, indexed.
- Migration backfill is a single guarded pass over existing `documents` (one-time, idempotent).
- No re-embedding, no re-chunking, no re-parse for any organization action — the whole point of the
  membership model.

---

## 19. Testing plan

### 19.1 Unit (`tests/unit` + service tests, run via `npm test` — never bare `npx vitest`)

- Collection CRUD service: create/rename/archive/unarchive/delete; built-in seed idempotency;
  built-ins undeletable.
- Membership add/remove; duplicate-add idempotency (`ON CONFLICT DO NOTHING`); remove-last-membership
  behaviour.
- `resolveScope` precedence: selected docs > temporary > project > Library > all; archived excluded by
  default; `includeArchived` path.
- Filename auto-scope **within** active collection; ambiguous multi-match → all-matches + notice;
  no-match-in-scope behaviour.
- `lifecycle` coalesce (NULL ⇒ permanent); temporary excluded from Library default.
- `origin_json` provenance parse: old `Translation/CompareOrigin` shape still parses; new
  `GeneratedProvenance` round-trips; malformed → safe default.

### 19.2 Integration (`tests/integration`)

- **Migration:** open a pre-feature DB → all docs become Library members; built-ins seeded once;
  re-open is a no-op (no double-filing). Pre-feature `scope_json` conversations still answer.
- Import to Library / Project / Temporary / conversation; folder import preserves
  `source_relative_path` + `source_folder_label`; old `importDocuments(paths)` caller unchanged.
- `retrieve` with `collectionIds` filter; selected `documentIds` still wins over collections; project
  scope + filename auto-scope; **empty filtered context ⇒ runtime not called**
  (`NO_DOCUMENT_CONTEXT_ANSWER`); scoped `corpusNeedsReindex` ⇒ `REINDEX_NEEDED_ANSWER`.
- Delete document removes memberships + chunks + embeddings + stored copy; original source untouched.
- Archive document / archived project excluded from default retrieval; visible with `includeArchived`.
- Generated translation/compare assigned to expected collection per §15.2; provenance persisted.
- **Encrypted workspace:** import/move/delete with collections; lock/unlock round-trips collection
  metadata; re-index keeps memberships; duplicate-import sha behaviour.

### 19.3 Renderer (`tests/renderer`, jsdom)

- Documents screen shows Library/Projects/Temporary/Generated/Archived sections.
- Create/rename/archive/delete project (membership-only vs with-documents prompt).
- Import destination chooser + defaults per entry point.
- Temporary "Keep in Library / Move to Project / Delete" actions.
- Project-scoped document table; chips render; provenance labels visible.
- Composer footer shows active scope text; scope popover changes scope; **selected-doc chips still
  work**; dangling-project fallback copy.
- Empty states + friendly copy; German smoke (extend `GermanSmoke.test.tsx`) for the new keys.

### 19.4 Privacy / offline

- No network calls in any collection operation (extend the no-network assertions).
- Audit: collection events record id/type/count only, **no name, no content**, **no scope/search
  query** — extend the sentinel-grep test (`audit-ipc.test.ts`).
- Encrypted DB holds collection tables inside the encrypted file (scan the `.enc`, assert no
  plaintext collection rows on disk).
- Temporary deletion shreds the sidecar; does not touch the original source path.

### 19.5 Regression

Existing `importDocuments(paths)` callers; selected-document asking; filename auto-scope;
summaries/translations/compares; chat-mode behaviour; export; preview; failed-import friendly errors;
`rag-scope.test.ts`, `chat-ipc.test.ts`, `ChatHomeNav.test.tsx` stay green (extended, not broken).

---

## 20. Phased implementation plan

Each phase ends with the mandatory ritual (tests green via `npm test`, app builds, docs +
BUILD_STATE updated, commit referencing the phase).

### Phase A — Collections core (backend foundation)
Schema (`collections`, `document_collections`), `ensureColumn` additions, built-in seed + Library
backfill migration, a `CollectionService` (CRUD + membership), `resolveScope`, and the
collection-filtered retrieval backend (`RetrievalScope`, `VectorIndex` + `keywordSearchChunks`
extensions, archived exclusion). Minimal/no UI beyond what tests need. **Deliverable:** app behaves
identically (Library == all), but the backend can filter by collection. _First phase to implement._

### Phase B — Projects
Create/rename/archive/delete projects; add/move docs; project document view (Documents section rail);
`conversations.collection_id`; project-scoped chats default to project; composer footer shows project
scope; conversation-list grouping. **Deliverable:** create "Tax 2025", add docs, ask only those by
default.

### Phase C — Temporary analysis
Import destination chooser; chat attach/drag-drop → Temporary (+ conversation scope); Temporary view;
Keep / Move / Delete actions; dangling-scope fallback. No retention sweep. **Deliverable:** analyse
invoice.pdf in chat without polluting Library.

### Phase D — Generated provenance
Extended `origin_json`/`GeneratedProvenance`; `role='generated'` membership + assignment rule;
provenance UI labels; generated outputs inherit active project/source collection. **Deliverable:**
generated docs belong to the right context and explain their origin.

### Phase E — Smart views + cleanup
Generated / Recently added / Unfiled / Needs re-index / Large files / Failed imports / Audio / OCR
smart views; optional Temporary review dashboard; optional explicit retention setting (with review
UI). **Deliverable:** corpus hygiene tools.

### Phase F — Filing suggestions (later, non-silent)
Rule-based first (folder name, filename patterns like invoice/rechnung/receipt, same source folder as
an existing project, sha/path patterns); local-AI suggestions only later, never silent — always
"Suggested project: Tax 2025 — Apply?". **Deliverable:** suggestions without automatic filing.

---

## 21. Open questions (explicit — not silently decided)

1. **Filename auto-scope widening.** When no in-scope filename match exists, should we (a) answer
   from the active scope only [planned default], or (b) offer "No match in this project — search
   Library?" with an explicit notice?
2. **Conversation delete → temporary cleanup.** Offer "also delete N temporary files used only in
   this chat?" or always keep them in Temporary [planned default: keep]?
3. **Multi-collection generated assignment.** Deterministic intersection/Library rule [planned] vs
   prompt the user when sources span collections?
4. **Summary as document vs metadata.** Keep `summary_json` metadata [planned/recommended] or
   materialize summaries as generated documents for uniform provenance?
5. **Project/collection name in audit.** Log id+type+count only [planned, conservative] or allow the
   name like filenames are allowed today? (Privacy call for the owner.)
6. **Persisted richer `DocumentScope`.** Stay with `collection_id` + `scope_json` [planned] or add a
   third `scope_v2_json` column for "Library + project", saved smart-view scopes, etc.?
7. **Duplicate import default.** Add-membership on exact sha match [planned] vs always import-as-new
   vs always ask?
8. **Folder import → collections.** v1 metadata-only [planned]; when (if ever) do top-level folders
   auto-create projects?
9. **Default for a brand-new documents-mode chat with projects present.** Library [planned] vs "last
   used project" vs prompt?

---

## 22. Accepted v1 trade-offs

- **Library == all documents on day one**; the distinction only earns its keep as users add
  Temporary/Archived/Project-only docs. Acceptable (and the intended gradual behaviour).
- **No retention automation** — Temporary files accumulate until explicitly handled. Safer than
  silent deletion; the review dashboard is Phase E.
- **Provenance staleness is data-only in v1** — we store enough to compute "source changed" later but
  show no staleness badge yet (matches today's snapshot semantics).
- **Smart views are query-time, not stored** — a saved-search abstraction (named, persisted predicate)
  is deferred.
- **Pre-feature app on a post-feature DB ignores collections** (shows the flat corpus) — documented
  version-skew, consistent with the existing app-beside-data stance.
- **`ensureColumn` forces nullable columns** — `lifecycle` etc. coalesce NULL⇒default in code rather
  than at the DB layer (the established `scope_json` pattern).

---

## 23. Acceptance criteria

- New tables + columns are additive; a pre-feature DB migrates with all documents in Library, seeded
  built-ins, and no double-filing on re-open.
- Selected-document asking is **unchanged** and still wins over collection scope.
- Filename auto-scope is **preserved** and now narrows within the active scope; ambiguity is surfaced,
  never silently mis-guessed.
- Import/re-index/delete semantics are preserved; delete also clears memberships and shreds the
  sidecar; the original source file is never touched.
- Generated summaries/translations/comparisons keep working and gain structured provenance + correct
  collection membership.
- The grounded-answer guarantee holds: empty scoped context ⇒ the model is not called.
- No new network calls; no content/scope/search in logs; encrypted workspaces store collection
  metadata inside the encrypted DB.
- `npm test` green (unit + integration + renderer + privacy + regression matrices of §19); app builds
  and launches; Windows-first verified.
- Docs (`rag-design.md`, `architecture.md`, `user-guide.md`, `known-limitations.md`) + BUILD_STATE
  updated; this working paper condensed into a §-record and deleted.

---

## 24. Files likely to change

**Schema / migration / services (main):**
- `apps/desktop/src/main/services/db.ts` — `SCHEMA` (+2 tables), `ensureColumn` calls, seed/backfill.
- `apps/desktop/src/main/services/collections.ts` — **new** `CollectionService` (CRUD + membership +
  `resolveScope`).
- `apps/desktop/src/main/services/chat.ts` — `Conversation.collectionId`, `rowToConversation`,
  `createConversation`/update; keep `parseScope`.
- `apps/desktop/src/main/services/rag/index.ts` — `RetrievalScope`, `retrieve` options, scoped
  `corpusNeedsReindex`.
- `apps/desktop/src/main/services/rag/scope.ts` — auto-scope within active scope + ambiguity.
- `apps/desktop/src/main/services/rag/hybrid.ts` — `keywordSearchChunks` collection filter.
- `apps/desktop/src/main/services/embeddings/index.ts` — `VectorIndex` collection/archived filter.
- `apps/desktop/src/main/services/ingestion/index.ts` — write membership/lifecycle/folder metadata on
  success; extend delete to clear memberships; extend/parse `origin_json`.
- `apps/desktop/src/main/services/doctasks/manager.ts` — generated-doc membership assignment +
  provenance.
- `apps/desktop/src/main/services/audit.ts` — collection events (id/type/count only).

**IPC / preload / shared:**
- `apps/desktop/src/main/ipc/registerCollectionsIpc.ts` — **new**.
- `apps/desktop/src/main/ipc/registerDocsIpc.ts` — `importDocuments` options, add/remove/setLifecycle,
  `listDocuments` filter.
- `apps/desktop/src/main/ipc/registerChatIpc.ts` — `setConversationCollection`, `createConversation`
  opts.
- `apps/desktop/src/main/ipc/registerRagIpc.ts` — pass resolved scope (collections) into retrieval.
- `apps/desktop/src/shared/ipc.ts` — new channel constants; extended `STREAM.scope` payload.
- `apps/desktop/src/shared/types.ts` — `Collection`, `RetrievalScope`, `ImportDestination`,
  `GeneratedProvenance`, extended `DocumentInfo`/`Conversation`.
- `apps/desktop/src/preload/index.ts` — mirror new `api` methods.

**Renderer:**
- `apps/desktop/src/renderer/screens/DocumentsScreen.tsx` — section rail, chips, new actions, project
  management, destination chooser.
- `apps/desktop/src/renderer/screens/ChatScreen.tsx` — collection scope state, project default,
  pending-collection handoff.
- `apps/desktop/src/renderer/chat/Composer.tsx`, `renderer/chat/ScopePopover.tsx` — scope text +
  options; `renderer/chat/ConversationList.tsx` — project grouping.
- `apps/desktop/src/shared/i18n/{en,de}.ts` — new keys (German review flagged).
- `apps/desktop/src/renderer/styles.css` — section rail + chips (responsive, per design-guidelines).

**Tests:** new `collections.test.ts`, `resolveScope.test.ts`; extend `rag-scope.test.ts`,
`chat-ipc.test.ts`, `audit-ipc.test.ts`, `ChatHomeNav.test.tsx`, `DocumentsScreen` + `GermanSmoke`
tests; new migration + encrypted-collections integration tests.

---

## 25. Recommended first implementation phase

**Phase A — Collections core.** It is the foundation every later phase needs, it is almost entirely
backend (low UX risk), and it can ship while leaving observable behaviour **identical** (Library ==
all documents). Concretely, the first PR should:

1. Add the two tables + `ensureColumn` columns + indexes to `db.ts`.
2. Implement the idempotent seed (Library + Temporary built-ins) and the Library backfill.
3. Add `CollectionService` (CRUD + membership) and `resolveScope`.
4. Extend `RetrievalScope` through `retrieve` → `VectorIndex` / `keywordSearchChunks` with the
   archived-exclusion, behind a backward-compatible overload so every existing caller/test is
   untouched.
5. Land the unit + migration + retrieval integration tests (§19.1/§19.2) and the no-network/audit
   assertions (§19.4).

Verifying that the full suite stays green with **zero behaviour change** is the proof that the
foundation is safe to build Projects, Temporary, and Generated on top of.
