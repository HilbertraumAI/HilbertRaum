# Document organization plan — Library / Projects / Temporary / Generated / Archive

_Status: **IN PROGRESS — Phase A (Collections core) + Phase B (Projects + composite scope, D1)
implemented 2026-06-14.** Phase A = schema/migration/`CollectionService`/`resolveScope`/collection-aware
retrieval backend. Phase B = the full IPC/preload surface (collections CRUD + membership + lifecycle +
`chat:setScope`/`setCollection`), `resolveScope` wired into the live ask path (scope-aware
`corpusNeedsReindex` M2 + filename auto-scope **within** the resolved scope, N2), `Conversation.scope`/
`collectionId` + `scope_v2_json` persistence, import→Library default membership, delete-project two
modes (C2), audit events (id/type/count only), and the renderer (Documents section rail + chips +
project management; multi-select source picker; composer footer union; conversation-list project
grouping). Phases C–F still open. Condense into a §-numbered design record in `docs/rag-design.md`
(scope) + `docs/architecture.md` (data model / IPC) + `docs/user-guide.md` (UX) once the WHOLE feature
ships, then delete this file (CLAUDE.md doc-lifecycle rule). Per-phase status lives in `BUILD_STATE.md`._

_Created: 2026-06-14. Author: planning pass on branch `Improved-Document-Structure`._

> This is a planning document only. **No feature code is written in this pass.** It is grounded in
> the current schema, retrieval pipeline, IPC surface, and renderer as they exist today (file paths
> and symbol names cited inline are real and were read for this plan). Where a decision is genuinely
> the product owner's, it is listed in §21 (Open questions) rather than silently chosen.

---

## 0. Audit revisions (2026-06-14)

A multi-persona audit of the first draft found retrieval/deletion bugs, a renderer contradiction, a
version-skew foreign-key hazard, and several under-specified decisions. This revision resolves them.
Every code claim below was re-verified against the source on branch `Improved-Document-Structure`
(paths/lines cited inline):

- **C1** — §7.5, §10.1, §19: an archived **project** no longer globally excludes its members from
  retrieval; only document-level `lifecycle='archived'` does. A doc that is in Library *and* an
  archived project stays answerable from Library.
- **C2** — §12.3: "Delete project with its documents" can no longer delete Library knowledge; the
  delete predicate spares any Library member and only removes genuinely project-only docs.
- **C3** — §7.3, §10.1, §11.2, §13: temporary chat attachments are their **own** scope category
  (Temporary membership + a new `conversation_documents` link), not overloaded onto
  `conversations.scope_json`. Verified `ScopePopover.tsx:45` labels the footer only as
  `scopeIds == null ? usingAll : usingSome(N)` and renders non-null ids as removable selection chips
  — it cannot express "temporary files in this chat".
- **C4** — §8.1, §9, §17, §22: `document_collections` (and the new `conversation_documents`) declare
  `ON DELETE CASCADE` on both foreign keys. Verified `db.ts:187` runs
  `PRAGMA foreign_keys = ON` and `deleteDocument` (`ingestion/index.ts:911`) deletes the `documents`
  row directly — a pre-feature app deleting a doc in a post-feature DB would otherwise hit an FK
  violation. CASCADE also removes manual membership-cleanup ordering concerns.
- **H1** — §2.5, §11.2, §20: chat file attach / drag-drop is **net-new** ingestion. Verified no
  `onDrop`/file-input/`DataTransfer` exists in `ChatScreen.tsx` or `Composer.tsx` today; Phase C must
  build the drop handler + file intake + wiring to the import pipeline.
- **H2** — §11.2, §13.5 (new): defined what happens when a file is dropped into a plain-`chat`
  conversation. Verified plain `chat` mode has no document scope and `onSelectMode`
  (`ChatScreen.tsx:533`) deselects the conversation + clears messages on a mode change.
- **H3** — §10.2: `retrieve`'s 5th parameter becomes a normalized union
  `string[] | RetrievalScope | null` (concrete, not a vague "thin overload"); forced caller edits
  listed. Verified the positional signature at `rag/index.ts:167` and the test callers passing a
  doc-id array / `null` as arg 5.
- **H4** — §11.3: a conversation attachment is append-only by construction (mooted by C3's link
  table); it never calls the `updateConversationScope` **replace** path (`chat.ts:215`).
- **M1** — §9, §11.3: the queued-import destination is persisted at queue time and the Library
  backfill is restricted to `status='indexed'`, so a crash mid-import no longer back-fills a
  Project/Temporary doc to Library.
- **M2** — §10.3: scoped `corpusNeedsReindex` is now an explicit work item (it is global today —
  `rag/index.ts:112`, takes only `embeddingModelId`), with empty-project vs all-stale-project tests.
- **M3** — §10.4, §13.1/§13.2, §21: multi-scope ("Library + project") and smart-view-as-scope are
  removed from **persisted** v1 scope (one `conversations.collection_id` cannot hold them; richer
  `DocumentScope` stays deferred — Q6).
- **M4** — §7.4, §15.2: an explicit decision is recorded for whether generated docs appear in
  Library-default retrieval.
- **M5** — §14.1, §17: delete wording corrected — today it is best-effort `rmSync`
  (`ingestion/index.ts:916`), not a shred; document delete adopts the existing `shredFile`
  (`workspace-vault.ts:306`). Membership cleanup is automatic via C4 CASCADE.
- **L1–L4** — §17, §8.2, §11.2, §12: audit event-type enum + name-redaction rule, `last_used_at`
  write-amplification deferred, symlink / `source_relative_path` note, section-rail responsive reflow.

Numbering is otherwise unchanged. New material: this §0, the `conversation_documents` table in §8.1,
the `pending_destination_json` column in §8.2, and **§13.5** (plain-chat drop). All existing
`§x.y` cross-references stay valid. A one-line version-skew note is added to
`docs/known-limitations.md`.

### 0.1 Product-owner decisions (2026-06-14, post-audit review)

Three open questions were resolved by the owner; these override the audit-pass defaults above:

- **D1 — Composite source selection (resolves Q6; supersedes M3).** A chat's scope is a **union** the
  user composes from any of: the whole **Library/knowledgebase**, one or more **project folders**, and
  **specific documents** — selectable together, not one-at-a-time. This **pulls Q6 forward**: v1 adds a
  persisted `conversations.scope_v2_json` (`DocumentScope`) and `resolveScope` returns a **union**, not
  a single anchor. The strict precedence ladder in §10.1 becomes a **union-of-selected-sources** model.
  Changes: §8.3, §10.1, §10.2 (union, not short-circuit), §10.4, §13.1/§13.2, §16, §19, §21 Q6, §22.
- **D2 — Import always creates a new document (resolves Q7).** No `sha256` dedup, no "add to existing?"
  prompt. To share **one** document across folders without duplicate vectors, the user uses the
  **Add-to-collection** action on the existing doc (membership — §8.4), **not** a re-import. Changes:
  §11.4, §19, §21 Q7, §22.
- **D3 — Generated docs are excluded from *default* retrieval (resolves M4 the other way).**
  Translations/comparisons are **not** part of any default answer corpus. They live in the Generated
  view and are **downloadable**; the way to make one durable knowledge is to **download it and
  re-import** it into the right folder. They remain **explicitly selectable** as a specific-doc source
  (via D1). Generated docs are therefore not auto-filed into source collections. Changes: §7.4, §9
  step 5, §15.2, §19, §22.

### 0.2 Second-pass audit (2026-06-14)

A fresh multi-persona audit (after §0/§0.1) re-verified every code citation against the source on
`Improved-Document-Structure` (all confirmed accurate, incl. the C4-load-bearing fact that
`chunks`/`embeddings` carry FKs **without** CASCADE so `deleteDocument` deletes embeddings→chunks→doc
in order) and found the following. Resolutions are applied inline; numbering is otherwise unchanged.

- **N1 (blocker) — the "built-in Generated home" was referenced but never defined or seeded.** §8.1's
  `collections.type` enum had no `'generated'`, §9 seeded only Library + Temporary, yet §9 step 5 /
  §15.2 / §12.1 relied on a *Generated home* membership. Worse, had it been a selectable collection,
  §10.2's `role <> 'generated'` would have excluded its own members. **Resolved (owner-overridable):
  Generated is a pure smart view over `origin_json IS NOT NULL` with NO collection membership at all.**
  No membership ⇒ a generated doc is automatically absent from every collection-derived scope (D3),
  reachable only via explicit `documentIds`. No Generated-home collection is seeded; no `'generated'`
  collection type. The `document_collections.role` value `'generated'` is **retired in v1** (kept only
  as a reserved enum string); the §10.2 `role <> 'generated'` predicate is dropped as unnecessary.
  Changes: §7.4, §8.1, §9 step 5, §10.1 rule 4, §10.2, §12.1, §15.2, §19. (Alternative the owner may
  pick instead: seed a `type='generated'` built-in — rejected here because it adds a type + seed step
  and creates the self-excluding-collection paradox for no gain.)
- **N2 (blocker) — filename auto-scope's skip condition lost its information under D1+C3.** §10.1 rule 5
  skipped auto-scope "only when the user has a deliberate `documentIds` selection," but rule 1 merges
  **attachments** and rule 2 merges **explicit picks** into one flat `RetrievalScope.documentIds`, so
  the skip decision was unmakeable from the resolved scope. **Resolved:** `resolveScope` computes an
  explicit-pick boolean from `conv.scope.documentIds` (the stored hand-picks) **before** merging
  attachments/collection-expansion, and returns it on `RetrievalScope.hasExplicitDocSelection`; rule 5
  keys off that flag, not the merged ids. Changes: §10.1 rule 5, §10.2.
- **N3 (blocker) — `conversation_documents` FK + async import is an unhandled crash path.** The
  attachment link row is written on indexing **success** (async, later); if the conversation is deleted
  meanwhile, the `INSERT` raises an FK violation on `conversation_id`, and `ON CONFLICT DO NOTHING`
  catches **only PK conflicts, not FK violations**. **Resolved:** the success-path (and crash-resume)
  link write is guarded by a conversation-existence check (skip the link, keep the doc in Temporary, if
  the conversation is gone) inside a try/catch; and §13.5's "new documents-mode conversation" must be
  **created and committed before** the import references its id. Changes: §11.3, §13.5.
- **N4 — drop-to-chat in-flight state was undefined.** The link row only exists post-indexing, so a
  freshly dropped file is neither answerable nor shown in "Files in this chat" until processing
  finishes. **Resolved:** define a pending attachment state (a non-removable "processing" chip driven
  by the existing import-job polling; it becomes a live attachment when the doc reaches `indexed` and
  the link row is written). Changes: §11.2, §13.1, §13.5.
- **N5 — stale contradictory comment.** §11.3's `{ kind: 'conversation' }` variant was annotated
  "tie to a chat's scope_json", contradicting C3/H4. **Resolved:** comment corrected. Changes: §11.3.
- **N6 — the §10.2 illustrative union SQL was scope-broken** (aliased `chunks c2` inside the `EXISTS`
  but referenced `c2` outside it; `embeddings` only has `chunk_id`). **Resolved:** rewritten to the
  existing `chunk_id IN (SELECT id FROM chunks WHERE …)` pattern with the chunk→document join in each
  branch. Changes: §10.2.
- **N7 — doc-lifecycle condensation anchors don't exist.** "spec §10.4" is not a label in
  `CLAUDE_HilbertRaum_MVP.md` (it was echoed from a comment in `embeddings/index.ts`), and
  `known-limitations.md` is heading-based with no §11.3/§16. **Resolved:** references corrected to the
  real homes ("Document tasks & summaries" heading; the MVP spec's selected-documents section by name,
  not a fabricated §-number). Changes: top-of-file note, §15.1.
- **N8 — conversation-list grouping vs union scope.** Grouping by single `collection_id` (§13.4) can't
  place a chat that spans Library + multiple projects. **Resolved:** group only by the creation anchor
  `collection_id`; composite/edited-scope chats fall into the "Other / Library" group. Changes: §13.4.
- **N9 — the Archived listing showed still-answerable docs** (an archived-project member that also
  lives in Library is fully retrievable per C1). **Resolved:** clarify the Archived view splits
  *document-archived* (lifecycle, truly excluded) from *project-archived members* (a hint, still
  answerable elsewhere). Changes: §12.1.
- **N10 — Temporary isn't a selectable scope source** (§13.2 lists Library/Projects/Specific/All).
  Stated explicitly as intended. Changes: §13.2.
- **N11 — line-ref drift:** `generateGroundedAnswer` is at `rag/index.ts:369` (retrieve call `:383`),
  not `:378`. Corrected at §10.2.
- **N12 — `ImportOptions.preserveRelativePaths` default** was unspecified. **Resolved:** defaults
  **true for a folder import, false otherwise**; it only gates the display-metadata capture (§11.2).
  Changes: §11.3.
- **N13 — rule 5 re-introduces the materialization §10.2/§18 avoided.** Filename auto-scope "within the
  resolved scope" needs a materialized in-scope (id, title) list — the very thing pushed into SQL to
  keep a large Library cheap. **Resolved:** recorded as an accepted, bounded cost (one indexed
  `id,title` projection over in-scope docs; no vectors loaded) with a note at §10.1 rule 5 / §18.

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
to filter by collection membership, **unioned** with the existing `scopeDocumentIds` path so a chat's
scope is a composable set of sources (Library + projects + specific docs — §0.1 D1). Everything stays
offline, local, and private; the change is additive at the schema, IPC, and UX layers.

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
  `getImportJob` / `ImportJobStatus`. **The only import entry point today is the Documents screen.**
  Verified: there is **no** chat attach / drag-drop path — `ChatScreen.tsx` and `Composer.tsx`
  contain no `onDrop`/`onDragOver`/`DataTransfer`/file-input (the only file-drop handler in the
  renderer is `components/PasswordField.tsx`, unrelated). So "attach a file to a chat" is **net-new
  ingestion UI**, not a re-route of an existing gesture (§11.2, Phase C §20).
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
tied to its originating conversation by a dedicated link — **not** by overloading
`conversations.scope_json`.

**Why not `scope_json` (C3, decided).** The first draft tied temp attachments to the conversation's
`scope_json` doc-id array. That collides with the explicit "selected documents" feature in three
verified ways: (1) `ScopePopover.tsx:45` computes the footer label only as
`scopeIds == null ? t('chat.scope.usingAll') : tCount('chat.scope.usingSome', scoped.length)` — there
is no way to render "Temporary files in this chat"; (2) the same component renders non-null scope ids
as **removable selection chips** (`ScopePopover.tsx:61`), so temp files would masquerade as a manual
selection the user must clear; (3) filename auto-scope is skipped whenever any `scope_json` is set
(`registerRagIpc.ts` runs `detectFilenameScope` only when the conversation has no explicit scope —
§2.4), so attaching a temp file would silently disable filename narrowing.

**Instead:** a temporary attachment is resolved as its **own scope category** — a row in a new
`conversation_documents` link table (§8.1) binding the doc to the conversation that received it, with
the doc also defaulting into the built-in Temporary collection (its lifecycle/home). `resolveScope`
(§10.1 rule 2) turns the **link** into a distinct scope kind (`temporary-attachments`), separate from
explicit `scope_json` selection. The link — not Temporary membership — is authoritative for "this
chat's files", so a later **Keep in Library** doesn't drop the file out of its chat (§10.1 rule 2). The
footer label and chips distinguish the two (§13.1/§13.3). After analysis the user sees explicit
actions: **Keep in Library**, **Move to Project**, **Delete from drive**, **Archive**. **No silent
deletion in v1.**

### 7.4 Generated (a smart view, no collection membership — N1)

Summaries/translations/comparisons. A materialized generated document (translation/compare) is **not
given any `document_collections` membership** (N1). It is recorded only by its structured
`documents.origin_json` (extended shape, §15), and that `origin_json IS NOT NULL` predicate **is** the
Generated smart view (§12.1) — exactly like the other query-time smart views (Failed = `status='failed'`,
etc.). With no membership, a generated doc is automatically absent from every collection-derived scope
(D3), so no separate exclusion mechanism is required. The provenance lets the UI render "Translated
from report.pdf", "Comparison of draft.pdf and final.pdf", "Summary of policy.pdf". Snapshot semantics
are unchanged (a generated output does not auto-update when its source changes; staleness indicator is
a later phase).

**Generated docs are excluded from default retrieval (D3, decided — owner override of the audit-pass
M4 default; mechanism simplified by N1).** A materialized translation/comparison is **not** part of any
default answer corpus. It is visible in the **Generated view**, **downloadable**, and **explicitly
selectable** as a specific-doc source (it can be hand-added to a chat's `documentIds`, §10.1). Because
it has **no collection membership at all**, it can never be reached through a Library/project scope —
the exclusion is structural, not a predicate. The intended path to make a generated output *durable
knowledge* is: **download it, then re-import it into the right folder** (where it becomes an ordinary
imported document with normal membership — D2). Rationale (owner): generated outputs are work products,
not automatically trusted knowledge; the user decides if/where one becomes part of the answer corpus.
(Summaries are *not* materialized documents — they stay `summary_json` metadata, §15.1 — so this
question doesn't arise for them.)

### 7.5 Archive

- **Document-level (the only *global* exclusion):** `documents.lifecycle='archived'` — retained on
  the drive, **globally excluded from default retrieval at every scope level**, hidden from the
  default Documents listing, reversible (back to `permanent`). Searchable only when **explicitly
  included** (`includeArchived` scope flag).
- **Project-level (a scope-target change, NOT a global exclusion — C1):** `collections.archived_at`
  set — the archived project simply **disappears as a selectable scope target** (it is dropped from
  the scope popover and the project list) and is hidden from the default Documents listing. **Its
  member documents are NOT excluded from retrieval** — a doc that also belongs to Library (or another
  active project) stays fully answerable through *those* memberships. Archiving "Tax 2025" must never
  make a policy that also lives in Library vanish from Library answers. Reversible (clear
  `archived_at`).
- A doc is removed from retrieval **only** by its own `lifecycle='archived'`, never by virtue of one
  of its collections being archived.

### 7.6 Smart views (later — Phase E)

Query-time filters over metadata, **not** stored collections: *Recently added*, *Unfiled* (no
non-builtin membership), *Generated by AI* (`origin_json IS NOT NULL` — N1), *Temporary*, *Needs re-index*
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
  role TEXT NOT NULL DEFAULT 'source', -- 'source' | 'reference' | 'attachment' ('generated' RESERVED, unused in v1 — N1: generated docs get NO membership)
  added_at TEXT NOT NULL,
  PRIMARY KEY (document_id, collection_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doccoll_collection ON document_collections(collection_id);
CREATE INDEX IF NOT EXISTS idx_doccoll_document ON document_collections(document_id);

-- C3: temporary chat attachments are bound to their conversation HERE, not via scope_json.
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
```

Notes:
- **`ON DELETE CASCADE` on both FKs of `document_collections` (and `conversation_documents`) is
  load-bearing for version-skew safety (C4).** `openDatabase` runs `PRAGMA foreign_keys = ON`
  (`db.ts:187`) and `deleteDocument` (`ingestion/index.ts:911`) deletes the `documents` row directly.
  Without CASCADE, a **pre-feature app deleting a document in a post-feature DB** would leave dangling
  membership rows and, with FKs enforced, raise an FK constraint violation on the `DELETE FROM
  documents` — the opposite of the "older app simply ignores collections" claim the first draft made.
  CASCADE makes the orphan rows disappear automatically, so *any* build (old or new) can delete a
  document cleanly, and the post-feature delete path needs **no** manual membership-cleanup ordering
  (§17).
- `type='archive'` and `type='smart'` are reserved in the enum but **not used as stored rows in
  v1** (archive is a lifecycle; smart views are query-time). They are listed so the column domain is
  forward-stable.
- The composite PK on `document_collections` makes membership **idempotent** (re-adding is a no-op
  via `INSERT … ON CONFLICT(document_id, collection_id) DO NOTHING`). `conversation_documents` is
  likewise append-only/idempotent (`INSERT … ON CONFLICT DO NOTHING`), which is what moots H4.

### 8.2 Additive columns on `documents` (all nullable — §2.2 constraint)

```sql
ensureColumn(db, 'documents', 'lifecycle',           'lifecycle TEXT')            -- null ⇒ 'permanent'
ensureColumn(db, 'documents', 'source_relative_path','source_relative_path TEXT') -- folder-import display
ensureColumn(db, 'documents', 'source_folder_label', 'source_folder_label TEXT')  -- top-level folder name
ensureColumn(db, 'documents', 'pending_destination_json','pending_destination_json TEXT') -- M1: queued-import intent
ensureColumn(db, 'documents', 'expires_at',          'expires_at TEXT')           -- reserved; null in v1
-- last_used_at: DEFERRED to Phase E (see L2 below) — not added in v1.
```

- `lifecycle ∈ {permanent, temporary, archived}` with **NULL treated as `permanent`** everywhere
  (a `docLifecycle(row)` helper centralizes the coalesce, mirroring `parseScope`).
- **`pending_destination_json` (M1):** set by `createQueuedDocument` (`ingestion/index.ts:330`) to the
  serialized `ImportDestination` (§11.3) the moment a doc is queued, **before** parse/embed. It is the
  durable record of *where this import is meant to land*, so a crash-and-restart mid-import re-files to
  the intended Project/Temporary instead of being swept into Library by the migration backfill (§9
  step 4). Cleared (set NULL) once the success-path membership is written. Tolerant parse → NULL.
- **`last_used_at` is DEFERRED out of v1 (L2).** Touching a `last_used_at` column on *every* answer
  and preview adds a write on the hot streaming path (each grounded answer would `UPDATE documents`
  per cited doc), i.e. write-amplification for a feature only the Phase-E "Recently used" smart view
  consumes. It is added when that view ships, not now. (`DocumentInfo.lastUsedAt` in §16 is likewise
  deferred.)
- `origin_json` is **reused, shape extended** (no new column) — see §15.

### 8.3 Additive columns on `conversations`

```sql
ensureColumn(db, 'conversations', 'collection_id', 'collection_id TEXT')   -- legacy single-project anchor
ensureColumn(db, 'conversations', 'scope_v2_json', 'scope_v2_json TEXT')   -- D1: persisted composite DocumentScope
```

**`scope_v2_json` is the D1 composite scope (Q6 pulled forward).** It stores a serialized
`DocumentScope`:

```ts
// shared/types.ts
export interface DocumentScope {
  collectionIds: string[]   // any mix: library id, project ids (and later smart-view ids)
  documentIds: string[]     // specific documents added to the union
  includeArchived?: boolean // default false
}
```

The resolved retrieval set is the **union** of (members of every `collectionIds` entry) ∪
(`documentIds`) — see §10.1/§10.2. Semantics:
- `scope_v2_json` **present** ⇒ it is authoritative; `resolveScope` uses it directly.
- `scope_v2_json` **NULL** ⇒ fall back to the legacy interpretation for backward compatibility:
  non-empty `scope_json` ⇒ `{ collectionIds: [], documentIds: <scope_json> }`; else `collection_id`
  (a project, or NULL ⇒ Library) ⇒ `{ collectionIds: [thatIdOrLibrary], documentIds: [] }`.
- An empty `DocumentScope` (`collectionIds:[]`, `documentIds:[]`) means the explicit **"All
  documents"** choice (whole corpus, archived still excluded unless `includeArchived`).

`Conversation` gains `collectionId: string | null` **and** `scope: DocumentScope | null`. `scope_json`
is **unchanged** (still a doc-id array) and is only read on the legacy-fallback path. Tolerant parse →
NULL (the `parseScope` precedent), so a corrupt `scope_v2_json` falls back to the legacy/Library
default and never throws. Decision: **Projects are collections, not a separate table** (§16.1), so
`collectionIds` carries projects, Library, and (later) smart-view ids uniformly.

### 8.4 Why membership, not duplication

`embeddings` is keyed by `chunk_id`, `chunks` by `document_id`. Organization never touches either.
Filtering by collection is a JOIN/EXISTS against `document_collections` — the same shape as the
existing `documentIds` filter, so vectors and chunks are shared across every collection a document
belongs to. This is the core architectural principle (§4) and the reason the change is cheap.

---

## 9. Migration proposal

A single idempotent migration run inside (or right after) `openDatabase`, guarded so re-runs and a
partially-migrated DB are safe.

1. **Create tables** — `collections`, `document_collections`, `conversation_documents` via the
   `SCHEMA` constant (idempotent).
2. **Add columns** — the `ensureColumn` calls in §8.2/§8.3.
3. **Seed built-ins (idempotent):** if no `type='library'` row exists, insert **one** Library
   collection (`builtin=1`); if no `type='temporary'` row exists, insert **one** Temporary
   collection (`builtin=1`). Names come from i18n at seed time but are stored as a stable English
   canonical (`'Library'`, `'Temporary'`) — the UI renders a localized label keyed off `builtin` +
   `type`, never the stored name, so a German user still sees "Bibliothek"/"Temporär". (Mirrors the
   persist-canonical-English / display-map rule from the i18n record.)
4. **Backfill Library membership (idempotent, status-gated — M1; generated-skipping — D3):** for every
   `documents` row that is `status='indexed'`, has **no** `document_collections` row at all, **and has
   `origin_json` NULL** (i.e. is not a generated translation/comparison — those are handled by step 5),
   insert `(document_id, library_id, role='source', added_at=now)`. The `origin_json IS NULL` guard is
   the D3 fix: a generated row must never become a Library member here. Guarding on "has no membership" makes
   this a one-time effect that never double-files. **The `status='indexed'` gate is the M1 fix:** a
   doc that was `queued`/`extracting`/`embedding` for a Project or Temporary destination when the app
   was killed must **not** be back-filled to Library on the next open. Its destination is recovered
   from `pending_destination_json` (§8.2) when the import resumes; only genuinely pre-feature,
   already-indexed docs (which never had an intent recorded) fall through to Library. (Backfilling
   only indexed docs is also correct because an unfinished import has no answerable content yet, so it
   is invisible to retrieval until it finishes and files itself per §11.3.)
5. **Generated rows need no backfill (D3, simplified by N1):** existing rows with `origin_json`
   (translations/comparisons) are given **no** `document_collections` membership at all — not Library,
   not a Generated home (N1 retires the Generated-home idea). Step 4 already skips them (its
   `origin_json IS NULL` guard), so they simply remain membership-free, which **structurally excludes
   them from every collection-derived scope** (§10.1 rule 4 / §10.2). They surface only through the
   Generated smart view (`origin_json IS NOT NULL`, §12.1). This is the D3 behaviour applied
   retroactively: a previously generated translation stops silently polluting the default corpus on
   upgrade. (A user who wants it back as knowledge re-imports it — D3.) The `origin_json` shape is
   widened lazily (read tolerates the old shape; §15). There is therefore **no step-5 write** — it is a
   no-op by construction, kept in the list only to document the intent.
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
- **Version skew (corrected — C4):** a *pre-feature* app opening a *post-feature* DB still works for
  reading — the new tables/columns are simply unread and `scope_json`/`mode` are unchanged, so it
  shows the flat corpus. **The one operation that is NOT inert is deleting a document:** the
  pre-feature `deleteDocument` (`ingestion/index.ts:911`) issues `DELETE FROM documents WHERE id = ?`
  directly, and because `openDatabase` enforces `PRAGMA foreign_keys = ON` (`db.ts:187`), any
  `document_collections` / `conversation_documents` row referencing that doc would raise an FK
  violation. **The `ON DELETE CASCADE` declarations in §8.1 are what make this safe:** the orphan
  membership/attachment rows cascade-delete automatically, so even an old build deletes the document
  cleanly (it just doesn't know the rows existed). This is the corrected story — the first draft
  wrongly claimed the old app "ignores collections" on delete. A one-line note is added to
  `known-limitations.md` recording that an old app on a new DB ignores collections for *display* but
  relies on CASCADE for *deletion*. No down-migration is provided (additive only).

---

## 10. Retrieval / scope proposal

### 10.1 Scope resolution — union of selected sources (decided, D1)

Resolved per request by a new pure `resolveScope(db, conv, question)` in `main/services/rag/`
(unit-testable, no I/O beyond reads). It returns a single `RetrievalScope` (§10.2). **D1 replaces the
first draft's strict precedence ladder with a union model:** the user composes a scope from any mix of
the Library/knowledgebase, project folders, and specific documents, and retrieval searches the
**union**. Resolution, in order:

1. **Conversation attachments are always merged in.** A chat's `conversation_documents` rows (C3) are
   added to the scope's `documentIds` regardless of the rest of the scope, so a file dropped into the
   chat is answerable even if the user also has Library + a project selected. The
   `conversation_documents` link is **authoritative** for "files attached to this chat" — it is *not*
   intersected with Temporary-collection membership, so a file the user later **Keeps in Library**
   (§14.1) stays answerable in its chat. (These are labelled as attachments, not removable selection
   chips — §13.1/§13.3.)
2. **The composed scope** — from `conv.scope` (`scope_v2_json`, §8.3), else the legacy fallback:
   - `scope` present ⇒ `collectionIds` ∪ `documentIds` exactly as stored (the union the user picked:
     e.g. `{collectionIds:[library, projectTax], documentIds:[contractA]}`).
   - `scope` NULL, legacy `scope_json` non-empty ⇒ `{collectionIds:[], documentIds: scope_json}`.
   - `scope` NULL, `collection_id` set ⇒ that project; else **Library** (the documents-mode default).
   - Empty composed scope (user explicitly chose **"All documents"**) ⇒ no collection/doc filter
     (whole corpus).
   Then **union with rule-1 attachments**. The result is one `RetrievalScope`
   `{ collectionIds, documentIds, includeArchived }`.
3. **Archive exclusion is document-level only (C1).** `includeArchived=false` (default) adds the
   single predicate `documents.lifecycle != 'archived'` to the *whole* union. It does **NOT** exclude
   "members of archived projects": an archived *project* is just removed as a **selectable source** (it
   no longer appears in the picker — §7.5, §13), but a document also reachable via Library or another
   selected source stays retrievable. A doc leaves retrieval globally only via its own
   `lifecycle='archived'`.
4. **Generated docs are excluded structurally (D3, simplified by N1).** Generated docs carry **no
   collection membership** (§7.4/§15.2), so a `collectionIds` expansion never reaches them — no
   `role='generated'` predicate is needed (N1 dropped it). They are answerable **only** when the user
   puts their specific id in `documentIds` (explicit selection via D1), which bypasses collection
   expansion entirely.
5. **Filename auto-scope narrows within the resolved union.** `detectFilenameScope` runs over the
   **documents visible in the resolved scope** (not the whole corpus). It runs whenever the scope is a
   collection/attachment-derived set; it is **skipped only when the user has an explicit, deliberate
   hand-picked specific-doc selection** — keyed off `RetrievalScope.hasExplicitDocSelection` (N2), the
   flag `resolveScope` sets from `conv.scope.documentIds` **before** attachments and collection
   expansion are merged into `documentIds`. (Merging would otherwise make a hand-pick indistinguishable
   from an attachment or expansion; the flag preserves that distinction — N2.) On **multiple matches**
   inside scope, do not guess — scope to *all* matches and surface a disambiguation notice ("Two files
   match 'contract' — answering from both") via the existing `STREAM.scope` channel (extended payload).
   No-match-in-scope ⇒ answer from the resolved scope; silent widening to Library is an open question
   (§21 Q1). **Cost note (N13):** matching filenames "within the resolved scope" needs a materialized
   in-scope `(id, title)` list — the projection §10.2/§18 otherwise push into SQL. Accepted as a
   bounded cost: it loads only `id`+`title` for in-scope docs (no vectors, indexed), evaluated once per
   question.

### 10.2 Backend shape (decided — concrete signature, H3)

Verified current signature (`rag/index.ts:167`):
`retrieve(db, embedder, question, settings, scopeDocumentIds?: string[] | null, reranker?, signal?)`.
It has many callers — the production `generateGroundedAnswer` (`rag/index.ts:369`, retrieve call at
`:383` — N11) and a dozen test
call sites across `tests/integration/{rag,rag-scope,hybrid-search,ocr-task}.test.ts` and
`tests/manual/rag-quality.test.ts`, several of which pass a doc-id array (e.g. `detected?.ids`) or
`null` **positionally** as argument 5. A plain "options object replaces arg 5" would break every one
of those. So the committed approach is a **normalized union on parameter 5** — keep the position,
widen the type, normalize internally:

```ts
// main/services/rag/index.ts
export interface RetrievalScope {
  documentIds?: string[] | null       // explicit selected docs — existing behaviour (after merge: hand-picks ∪ attachments)
  collectionIds?: string[] | null     // NEW — membership filter
  includeArchived?: boolean           // NEW — default false
  hasExplicitDocSelection?: boolean   // NEW (N2) — true iff the user hand-picked specific docs; set by resolveScope BEFORE merging attachments/expansion; gates filename auto-scope skip (§10.1 rule 5)
}
// arg 5 is now: string[] | RetrievalScope | null
export async function retrieve(
  db, embedder, question, settings,
  scope?: string[] | RetrievalScope | null,   // string[]/null = legacy doc-id scope
  reranker?, signal?
): Promise<RetrievalResult>
// internally: const s: RetrievalScope = Array.isArray(scope) || scope == null
//                ? { documentIds: scope ?? null } : scope
```

A bare `string[]` or `null` normalizes to `{ documentIds }`, so **every existing positional caller and
test stays valid byte-for-byte** — no call-site churn for the legacy doc-id path. New callers pass a
`RetrievalScope` to use `collectionIds`/`includeArchived`.

**Forced edits (the only ones this signature change requires):**
- `generateGroundedAnswer` (`rag/index.ts:369`) — its `opts` gains a `scope?: RetrievalScope` (or it
  forwards a resolved `RetrievalScope`); it passes that through to `retrieve` as arg 5 (the existing
  `opts.scopeDocumentIds` pass-through is at `:383`).
- `registerRagIpc.ts` — call `resolveScope(db, conv, question)` (§10.1) and hand the resulting
  `RetrievalScope` to `generateGroundedAnswer`; the filename-auto-scope wiring moves to operate
  *within* the resolved scope (§10.1 rule 7).
- Tests: the existing positional callers are untouched (union covers them); **new** tests assert the
  `collectionIds`/`includeArchived` paths (§19). No existing assertion needs rewriting.

**`documentIds` and `collectionIds` are UNIONED, not short-circuited (D1).** A document is in scope
if it is a member of any `collectionIds` entry **OR** its id is in `documentIds`. (The first draft had
`documentIds` *replace* `collectionIds`; D1's composite scope requires the union so "Library + this
project + contractA.pdf" works.) To stay index-friendly for a large Library, the filter is pushed into
SQL as an `EXISTS`/`IN` disjunction, **not** a materialized `IN (…thousands…)`:

- `VectorIndex` (`main/services/embeddings/index.ts`) `VectorIndexOptions` gains
  `collectionIds?: string[] | null`, `documentIds?: string[] | null`, `includeArchived?: boolean`.
  `embeddings` has only `chunk_id`, so (mirroring the **existing** `chunk_id IN (SELECT id FROM chunks
  WHERE document_id IN (…))` filter — N6) the chunk→document hop and every predicate live **inside one
  `chunk_id IN (SELECT …)` subquery**, with the chunk→document join in *each* branch:
  ```sql
  AND embeddings.chunk_id IN (
    SELECT c.id FROM chunks c
    WHERE (
      EXISTS (SELECT 1 FROM document_collections dc           -- D1: membership branch
              WHERE dc.document_id = c.document_id AND dc.collection_id IN (…collectionIds…))
      OR c.document_id IN (…documentIds…)                     -- D1: explicit-doc branch, unioned in
    )
    AND NOT EXISTS (SELECT 1 FROM documents d                 -- C1: doc-level archive only
                    WHERE d.id = c.document_id AND d.lifecycle = 'archived')
  )
  ```
  (No `role <> 'generated'` predicate — N1: generated docs have no membership, so the membership branch
  never reaches them; explicit `documentIds` still can. `includeArchived=true` drops the `NOT EXISTS`.
  Final SQL tuned during implementation; the point is union-of-membership-OR-id, indexed by
  `idx_doccoll_*`; empty `collectionIds` AND empty `documentIds` ⇒ no filter = "All documents".)
- `keywordSearchChunks` (`main/services/rag/hybrid.ts`) `KeywordSearchOptions` gains the same and
  adds the analogous membership-OR-id disjunction + doc-level archived predicate (no generated
  predicate — N1). Its existing `AND c.document_id IN (…)` already joins `chunks c`, so the predicates
  attach there directly.

Backward compatibility is provided by the **arg-5 union + internal normalization** above (a bare
`string[]`/`null` becomes `{ documentIds }`), not by a separate overload — so the old positional
`scopeDocumentIds` callers and tests remain valid unchanged.

### 10.3 Composition with the rest of the pipeline

- **RRF fusion, reranker, citation generation** are unaffected — they operate on whatever candidate
  set the scoped vector/keyword searches return.
- **Embedder-visibility honesty stays — but scoping `corpusNeedsReindex` is a real work item (M2),
  not a freebie.** Verified: `corpusNeedsReindex(db, embeddingModelId)` (`rag/index.ts:112`) counts
  the **whole** corpus — it has no scope parameter. To keep the re-index honesty story correct under
  collection scope it must be **threaded with the active scope** (a new
  `corpusNeedsReindex(db, embeddingModelId, scope?: RetrievalScope)` that applies the same
  membership/`includeArchived` filter as retrieval). The two outcomes must be distinguished within the
  active scope:
  - **scope is genuinely empty** (e.g. a brand-new project with no docs, or all its docs archived) ⇒
    `NO_DOCUMENT_CONTEXT_ANSWER` (nothing to answer from — re-indexing wouldn't help);
  - **scope has indexed docs but none are visible to the active embedder** (all stale) ⇒
    `REINDEX_NEEDED_ANSWER`.
  Tests (§19) must cover both: an **empty-project** scope → `NO_DOCUMENT_CONTEXT_ANSWER`, and an
  **all-stale-project** scope → `REINDEX_NEEDED_ANSWER`. This is an explicit Phase-A/B deliverable.
- **Grounded-answer guarantee preserved:** if the scoped+filtered candidate set is empty, the model
  is **not** called — `NO_DOCUMENT_CONTEXT_ANSWER`. Collection filtering can only shrink the set, so
  this guarantee strengthens, never weakens.

### 10.4 Scope persistence (decided — D1, Q6 pulled forward)

**The composite `DocumentScope` is persisted in v1** via `conversations.scope_v2_json` (§8.3). This is
the D1 decision: a chat remembers the exact union of sources the user picked (Library + project(s) +
specific docs), so follow-up questions reuse it across app restarts. `scope_v2_json` is authoritative
when present.

Backward compatibility (no migration of old conversations needed):
- `scope_v2_json` **NULL** ⇒ legacy interpretation (§8.3): non-empty `scope_json` ⇒ explicit-doc
  scope; else `collection_id` ⇒ project; else Library default.
- `scope_json` is **retained unchanged** as a doc-id array and is only read on that fallback path.
  **Temporary attachments never ride `scope_json`** (C3) — they come from `conversation_documents` and
  are unioned in by §10.1 rule 1.
- `collection_id` is **retained** as the simple "this chat lives in project X" anchor for chats
  created from a project context; the first time the user edits scope in such a chat, the full choice
  is written to `scope_v2_json` (which then wins).

The transient **"All documents"** choice persists as an empty `DocumentScope`
(`{collectionIds:[],documentIds:[]}`) — explicit and durable, not session-only. This supersedes the
audit-pass M3 stance (which dropped composite scope and kept "All documents" session-only); D1 makes
composite scope and "All documents" first-class persisted states. Smart-view-**as-scope** stays out of
v1 only because smart views aren't stored collections (§7.6); a smart view can still be *applied* to
the listing and its current ids hand-added to `documentIds`.

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
- **Drag/drop or attach into Chat** → **Temporary**. This is a **net-new ingestion entry point**
  (H1): verified there is no chat drop/attach handler today (§2.5), so Phase C (§20) must build (a) a
  drop target + file-picker on the Chat surface, (b) intake that hands the dropped paths to the
  existing `importDocuments` pipeline with `{ kind: 'conversation', conversationId }`, and (c) the
  membership wiring. On success the doc gets **Temporary-collection membership + a
  `conversation_documents(conversationId, documentId)` row** (C3) — **not** a `scope_json` mutation —
  so the chat answers from it by default via the `temporary-attachments` scope kind (§10.1 rule 2).
  Dropping into a **plain-`chat`** conversation is handled by §13.5 (it does not silently gain doc
  retrieval).
  - **In-flight state (N4):** because the `conversation_documents` link is written only when the doc
    reaches `indexed` (it is async), the file is **not answerable nor a live attachment until then**.
    The chat shows a **pending "processing invoice.pdf…" chip** driven by the existing import-job
    polling (`getImportJob`/`ImportJobStatus`, §2.5); the chip is **not removable** and converts to a
    live "Files in this chat" attachment (§13.1) once the link row exists. A failed import surfaces the
    existing friendly per-file error in place of the chip and writes **no** link.
- **Folder import** → preserve `source_relative_path` + `source_folder_label` as metadata; do **not**
  auto-create collections in v1. Destination still asked (defaults Library). Optional later mode:
  "Create projects from top-level folders."
  - **`source_relative_path` definition + symlink note (L3):** for a folder import,
    `source_relative_path` is the file's path **relative to the user-picked top-level folder root**,
    and `source_folder_label` is that root folder's name — both **display-only metadata**, never used
    for any file I/O (the stored copy is `workspace/documents/<id><ext>`). Verified: `expandPaths`
    (`ingestion/index.ts:931`) walks with `statSync` (which **follows symlinks** — it is not
    `lstatSync`), the documented "expandPaths follows symlinks" limitation. So a symlinked entry can
    resolve to a target outside the picked root and its computed relative path may contain `..` or look
    odd. Because the field is display-only, this is cosmetic, not a traversal risk; the plan **does not
    change** the symlink behaviour here (any tightening belongs to the separate L-5 symlink-guard
    item, not this feature). When a relative path can't be cleanly computed (symlink escape, different
    drive), fall back to storing just the basename in `source_relative_path`.

### 11.3 IPC change for import (additive, backward-compatible)

```ts
// shared/types.ts
export type ImportDestination =
  | { kind: 'library' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'temporary' }
  | { kind: 'conversation'; conversationId: string } // temp attachment, linked via conversation_documents (C3) — NEVER scope_json (N5/H4)

export interface ImportOptions {
  destination?: ImportDestination     // default { kind: 'library' }
  preserveRelativePaths?: boolean      // N12: capture source_relative_path/source_folder_label; default true for a folder import, false otherwise
}
```

`importDocuments(paths: string[], options?: ImportOptions)` — **old callers (no options) keep working**
and default to Library, preserving existing behaviour exactly.

**Destination is persisted at queue time, membership written on success (M1).**
`createQueuedDocument` (`ingestion/index.ts:330`) records the resolved `ImportDestination` into
`documents.pending_destination_json` (§8.2) **immediately**, before parse/embed. The background loop,
after a document reaches `indexed`, writes the membership row(s) + lifecycle + folder metadata
**derived from `pending_destination_json`** and then clears it. This closes the restart race: if the
app is killed mid-import, the status-gated Library backfill (§9 step 4, `status='indexed'` only) skips
the still-`queued` doc, and the resumed import re-files it to its persisted intended destination
rather than defaulting to Library. **Membership is added on success only**; a failed import creates no
membership (the orphan `pending_destination_json` is harmless and ignored). The async-with-polling
model and friendly per-file errors are untouched.

**Conversation attachment is append-only (H4, mooted by C3).** A `{ kind: 'conversation' }` import
adds a `conversation_documents` row via `INSERT … ON CONFLICT DO NOTHING` — it **never** touches
`scope_json`, so the verified `updateConversationScope` **replace** path (`chat.ts:215`, which
overwrites the whole `scope_json` array via a single `UPDATE`) is **not** on this code path at all and
cannot wipe earlier temp files. (Had temp files still lived in `scope_json` per the first draft, the
import would have had to read-append-write to avoid clobbering; C3's link table removes that hazard
entirely. Any future code that *does* edit `scope_json` for multiple files must still read-append-write,
never call the replace path.)

**The link write is FK-guarded (N3).** The `conversation_documents.conversation_id` FK means a naïve
`INSERT` would raise an FK violation if the conversation was deleted between import-queue and
import-**success** (the link is written on success, asynchronously — possibly seconds later) — and
`ON CONFLICT DO NOTHING` catches only the **PK** conflict, **not** an FK violation. So the success-path
(and crash-resume from `pending_destination_json`) link write must (a) run inside a try/catch and (b)
verify the conversation still exists first; if it is gone, **skip the link** and leave the doc in the
Temporary collection (still reviewable in Documents → Temporary). The doc is never lost; only the
chat binding is dropped because its chat no longer exists. This is the one place `{ kind: 'conversation' }`
differs from the other destinations (which have no conversation FK).

### 11.4 Duplicate handling on import — always import as new (decided, D2)

**Import always creates a new `documents` row** (parse + chunk + embed), even when an identical
`sha256` already exists. There is **no** sha-dedup check, no "this file is already in your drive"
prompt, and no add-membership-instead-of-import branch. This is the D2 owner decision: the import
gesture is simple and predictable — what you import is a new document.

**Sharing one document across folders without duplicate vectors is a separate, explicit action.** A
user who wants the *same* stored document in two projects/Library uses **Add to collection**
(`docs:addToCollection`, §16) on the existing doc — that adds a `document_collections` membership row
and re-uses the one chunk/vector set (§8.4). So the no-duplicate-vectors principle is preserved for
deliberate *organization*, while the *import* path stays dumb-and-new. (Consequence to accept: a user
who re-imports the same file twice does get two rows + two vector sets; that is the chosen trade-off —
§22.)

---

## 12. Documents screen proposal

Keep the top-level IA simple — **no new nav item**; expand `DocumentsScreen.tsx`. Add a left
**section rail** (collapsible) of saved filters, and keep the existing table as the main surface.

**Responsive (L4):** the new section rail must honour the existing responsive reflow. Documents
already reflows at the `@media (max-width: 760px)` / `520px` breakpoints added in the onboarding pass
(`renderer/styles.css`; slim nav rail, tighter gutters, stacked grids). The section rail must
collapse (to a top dropdown/segmented control or an off-canvas drawer) **at or above the 760px
breakpoint** so it never forces horizontal scroll on a narrow window — same discipline as the chat
history auto-collapse. New rail CSS lives beside the existing media queries, not in a new stylesheet.

### 12.1 Left section filters

- **Library** (default selected)
- **Projects** → each project (with doc count, failed/needs-reindex badge)
- **Temporary**
- **Generated** (smart view: `origin_json IS NOT NULL` — N1; no membership predicate)
- **Archived** (smart view) — **two visually distinct groups (N9):** *document-archived*
  (`lifecycle='archived'`, genuinely excluded from retrieval) and, separately, *members of an archived
  project* (a navigational hint only — per C1 these stay fully answerable via their other memberships,
  so they must **not** be presented as "excluded"). Conflating the two would imply a Library doc went
  dark just because some project was archived, which is false.
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
- **Project management:** create · rename · archive · delete. **Delete-project** prompts two modes:
  - *Remove the project only* — drop the project's memberships and the `collections` row; **keep all
    documents** (they remain in Library / other projects / Unfiled).
  - *Delete the project and its documents* — delete **only** documents that are *genuinely
    project-only*, with a predicate that **never deletes a Library member (C2)**:

    > delete document `d` ⟺ `d` is a member of this project **AND** `d` has **no other**
    > `document_collections` membership of any kind — **no Library membership** (built-in), **no other
    > project**, **no Temporary** — i.e. `SELECT COUNT(*) FROM document_collections WHERE document_id =
    > d.id AND collection_id <> :thisProject` is `0`.

    Concretely this only catches docs **imported straight into the project and never added to
    Library** (e.g. project-scoped imports, or a kept-from-Temporary doc moved *into* the project with
    its Temporary/Library memberships dropped). A doc that is in Library **and** this project is
    Library knowledge and is **only un-filed from the project, never deleted**. The first draft's
    "sole non-builtin membership" wording was the bug: Library is a *builtin* membership, so a
    Library+project doc has no *non-builtin* membership besides the project and would have been wrongly
    deleted. The corrected predicate counts **all** memberships (builtin included). Explicit, never
    silent; the confirm dialog states the exact count that will be deleted vs un-filed. Built-in
    Library/Temporary collections are not deletable.

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

### 13.1 Footer scope text — composite (D1)

`ScopePopover.tsx` currently derives the footer label only from `scopeIds == null ? usingAll :
usingSome(N)` (`ScopePopover.tsx:45`). D1 makes scope a **composed union**, so the footer summarizes
*what was selected*, not a single kind. Labelling rules (from the resolved `DocumentScope`, §8.3):

- empty scope → "Using all documents"
- one source → name it: "Using Library" · "Using Project: Tax 2025" · "Using 3 selected documents"
- multiple sources → summarize the union: "Using Library + Project: Tax 2025" ·
  "Using Project: Tax 2025 + 2 documents" · "Using Library + 2 projects + 1 document"
- chat **attachments** are shown separately as their own affordance ("+ 1 file in this chat"), **not**
  as removable selection chips (C3) — they're always unioned in (§10.1 rule 1). An attachment still
  **processing** shows as a non-removable pending chip ("processing invoice.pdf…", N4) until it is
  indexed and its `conversation_documents` link exists.

New i18n keys: per-source labels + a composer that joins them (`chat.scope.union`, `chat.scope.library`,
`chat.scope.project`, `chat.scope.docs`, `chat.scope.attachments`, plus existing `usingAll`).

### 13.2 Scope popover — multi-select source picker (D1)

The popover becomes a **multi-select** "Choose your sources" picker, not a single-choice list. The
user can tick any combination of:

- ☑ **Library** (the whole knowledgebase)
- ☑ **each Project** (one or more; archived projects are not listed — §7.5/C1)
- ☑ **Specific documents…** (opens a doc picker; adds ids to `documentIds`)
- a one-tap **"All documents"** that clears the union to empty (whole corpus)

The built-in **Temporary** collection is intentionally **not** offered as a pickable source (N10):
temporary files are reached through their own chat (the `conversation_documents` attachment, §10.1
rule 1) or hand-picked via "Specific documents…", never as a bulk "all my temporary files" corpus.
Likewise **Generated** is not a source (D3); a generated doc is reached only via "Specific documents…".

The composed selection is written to `conversations.scope_v2_json` (§8.3/§10.4) so it persists across
restarts. Chat attachments appear as a read-only "Files in this chat" line (always included), distinct
from the removable specific-doc selections. **Generated docs are not offered as a Library/project
source** (D3) — to use one, the user picks it explicitly via "Specific documents…". (Plain-chat mode
shows no document scope, as today — §13.5.)

Smart-view-**as-scope** is still not a *saved* scope (smart views aren't stored collections, §7.6),
but a user can apply a smart view in the listing and hand-add its docs through "Specific documents…".

### 13.3 Rules (consistent with §10 precedence)

- A chat started from a **Project** defaults to that project as the initial single-source scope
  (`collection_id` set at `createConversation`); editing scope writes the full union to
  `scope_v2_json` (§10.4).
- **Scope is a composed union (D1):** Library and/or projects and/or specific docs, plus the chat's
  attachments. There is no "winner" — selected sources are added together (§10.1).
- A chat with **attachments** always includes them (they live in `conversation_documents` — C3, not
  `scope_json`), shown as a distinct "Files in this chat" affordance, **not** as removable
  explicit-selection chips.
- **Filename auto-scope narrows within the resolved union** and still emits the `STREAM.scope` toast,
  except when the user has a deliberate specific-doc selection (§10.1 rule 5).
- **"All documents" is explicit** (an empty union), never the invisible default inside a project.
- Scope changes are **visible** (footer text + chips) and **persisted** (`scope_v2_json`). Existing
  conversations preserve their behaviour via the NULL-`scope_v2_json` legacy fallback (§10.4).

### 13.4 Conversation ↔ project association

- `createConversation(opts)` gains `collectionId`. `ChatScreen` passes the active project when a chat
  is started from a project context (mirrors the existing `pendingScope` handoff pattern in
  `ChatScreen.tsx`).
- New IPC `setConversationCollection(conversationId, collectionId | null)` (parallel to
  `updateConversationScope`).
- **Conversation list grouping:** group the existing `ConversationList` strictly by the creation
  anchor `collection_id` (a project header with its chats), with an "Other / Library" group for
  unscoped chats. Keep it a view change, not a new screen. **Composite-scope chats group by anchor, not
  union (N8):** a chat whose scope spans Library + several projects (`scope_v2_json`) cannot belong to
  one project header, so it groups under its original `collection_id` if set, else "Other / Library".
  Grouping is an organizational convenience over the *anchor*, deliberately **not** an index of every
  source a chat draws from (that lives in the footer summary, §13.1).
- **Dangling scope safety:** if a conversation's `collection_id` references an **archived or deleted**
  project, the footer shows a quiet "This project was archived — answering from Library" and falls
  back to Library scope (never an error, never an empty silent corpus). Same calm-fallback discipline
  as malformed `scope_json`.

### 13.5 Dropping a file into a plain-`chat` conversation (decided — H2)

The two chat modes are load-bearing and stay distinct (§5): plain `chat` has **no** document access
(the resolved scope is computed only when `mode === 'documents'` — `ChatScreen.tsx:547`), and
switching mode via `onSelectMode` (`ChatScreen.tsx:533`) **deselects the conversation and clears the
message list** when the active conversation's mode differs. So "drop a file onto a plain-chat
conversation" must be defined rather than left to that destructive default. **Decision:**

- If the active conversation is **empty** (no messages yet), **switch it in place to `documents`
  mode** and attach the dropped file as a temporary attachment. Nothing is lost (no messages to
  clear), and `onSelectMode`'s clear is a no-op on an empty transcript.
- If the active conversation **already has messages** (a real plain chat in progress), **do not
  mutate or clear it.** Instead **create a new `documents`-mode conversation** seeded with the
  temporary attachment (mirroring the existing `pendingScope` / `createConversation` handoff pattern
  in `ChatScreen.tsx`), and switch focus to it. The user's plain chat is preserved verbatim; a toast
  ("Started a new document chat for invoice.pdf") explains the jump.
  - **Ordering (N3):** the new conversation row must be **created and committed before** the import is
    queued with `{ kind: 'conversation', conversationId }`, because `conversation_documents` has an FK
    on `conversation_id`. The chat-drop intake therefore: (1) `createConversation` (documents mode),
    (2) `importDocuments(paths, { destination: { kind:'conversation', conversationId } })`, (3) the
    link row is written FK-guarded on indexing success (§11.3 N3). Until then the new chat shows the
    pending chip (N4).
- **Never** silently convert an in-progress plain chat to documents mode (that would wipe its
  messages via the `onSelectMode` clear) and **never** answer a plain-chat turn from documents (the
  mode boundary stays intact).

This closes H2's gap without collapsing the mode distinction. (Open Q added — §21 Q10 — on whether the
"new conversation vs in-place switch" threshold should be message-count or an explicit prompt.)

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
- **Delete** removes the workspace copy + `chunks` + `embeddings` + all memberships; it **never
  touches the original source file** on the user's disk (the stored copy is a copy — existing
  contract). Verified specifics (M5/C4):
  - Today `deleteDocument` (`ingestion/index.ts:911`) unlinks the workspace copy with **best-effort
    `rmSync`** (`:916`, swallowing errors), not a secure shred. A real `shredFile` helper exists
    (`workspace-vault.ts:306`) and is already used by doctasks/logging. **The plan adopts `shredFile`
    for the workspace copy on document delete** so the on-disk copy is overwritten before unlink (it
    is encrypted ciphertext on an encrypted workspace, but shredding keeps the contract consistent
    with the rest of the app). This makes the "Delete shreds the sidecar" claim in §17 true.
  - Membership / attachment cleanup is **automatic via `ON DELETE CASCADE`** (§8.1, C4) — deleting the
    `documents` row removes its `document_collections` and `conversation_documents` rows with no
    explicit `DELETE FROM document_collections` needed (the first draft's manual-cleanup step is
    unnecessary; a belt-and-suspenders explicit delete is optional, not required).

### 14.2 Temporary ↔ conversation

- A temporary file attached to a chat is linked via `conversation_documents` (C3), **not**
  `scope_json`. **Deleting a conversation does NOT delete its temporary files:** the `ON DELETE
  CASCADE` on `conversation_documents` (§8.1) removes only the **link** row, never the `documents`
  row, so the file stays in Documents → Temporary for review — avoids surprise data loss; cleanup is
  explicit. (Open question §21: offer "also delete N temporary files used only here?" at conversation
  delete.)
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
the source row (do not churn it into a separate document — the **"Document tasks & summaries"** section
of `known-limitations.md` describes the current summary contract: *"Summary = `documents.summary_json`
… metadata, not a separate document. Cleared on re-index."* N7 — that file is heading-based, not
§-numbered). Converting it is an open question §21, leaning *keep as metadata*.

### 15.2 Membership of materialized generated docs (decided — D3)

**D3 (simplified by N1): generated docs get NO `document_collections` membership at all.** The first
draft's intersection / active-project / Library assignment rules are **dropped**, and so is the §0.1
"built-in Generated home" idea (N1 — it was never seeded, had no collection type, and would have
self-excluded under the old `role <> 'generated'` predicate). When a translation/compare produces a
new `documents` row:
- It is given **no** membership — not Library, not the source's collections, not a Generated home. With
  no membership, a collection-scope expansion **structurally never reaches it** (§10.1 rule 4 / §10.2),
  so no `role`-based exclusion predicate is needed.
- It is recorded as generated via `origin_json` / `GeneratedProvenance` (§15.1) and surfaced **only**
  through the **Generated smart view** — the query-time predicate `origin_json IS NOT NULL` (§12.1),
  exactly like the other smart views. The `document_collections.role` value `'generated'` is **unused
  in v1** (reserved enum string only).
- It is **answerable only when the user explicitly selects it** as a specific-doc source (its id in a
  chat's `documentIds`, §10.1) — the explicit `documentIds` branch bypasses collection expansion.
- The path to making a generated output **durable knowledge** is **download + re-import** into the
  chosen folder (D3/§7.4), at which point it is an ordinary imported document with normal membership.

This keeps generated outputs out of the default corpus entirely (owner intent) and removes the need for
any assignment heuristic **and** any Generated-home seed/type — so **§21 Q3 is moot** (see §21).

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
| `chat:setScope` (new — D1) | `(conversationId, scope: DocumentScope \| null) => Conversation` (persists `scope_v2_json`) | `registerChatIpc` |
| `chat:createConversation` (extend) | `opts.collectionId?`, `opts.scope?` | `registerChatIpc` |
| `chat:listAttachments` (new — C3) | `(conversationId) => DocumentInfo[]` (the `conversation_documents` attachments, for footer/chips) | `registerChatIpc` |

Type additions in `shared/types.ts`: `Collection`, `CollectionType`, `DocumentCollectionRole`,
`RetrievalScope`, **`DocumentScope`** (now **used**, not deferred — the persisted composite scope, D1,
§8.3), `ImportDestination`, `ImportOptions`, `GeneratedProvenance`;
`DocumentInfo` gains `collections?: { id; name; type; role }[]`, `lifecycle`, `sourceFolderLabel`
(**`lastUsedAt` is deferred — L2/§8.2 — until the Phase-E "Recently used" view**); `Conversation`
gains `collectionId` **and `scope: DocumentScope | null`** (D1). All additive/optional so existing
renderer code compiles. Preload `api` mirrors each method (1:1 `ipcRenderer.invoke`), keeping the bridge typed and
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
  Temporary files are stored exactly like any document (`<id><ext>.enc`); **Delete `shredFile`s the
  sidecar (M5) + drops chunks + embeddings; memberships + conversation links are removed
  automatically by `ON DELETE CASCADE` (C4 — no explicit `DELETE FROM document_collections` needed).**
  (Today's delete uses best-effort `rmSync`; the plan switches it to the existing `shredFile` —
  `workspace-vault.ts:306` — so this claim is accurate.)
- **Renderer sandbox / IPC:** new IPC is typed and narrow; main owns all file I/O and membership
  writes. `docs:import` continues to accept caller paths (the documented existing trust posture —
  unchanged, not worsened).
- **Audit policy (decided, consistent with the §2.6 hard rule).** New `AuditEventType` values are
  added to the union at `shared/types.ts:769` (which today ends `… | 'settings_changed' |
  'policy_warning' | 'offline_guard_violation'`):
  - `collection_created`, `collection_renamed`, `collection_archived` (a `{ archived: boolean }`
    metadata flag covers archive **and** unarchive), `collection_deleted` — record **collection id +
    type + affected document count** in `metadata_json`; the **name is content-ish** (a project name
    like "Lawsuit Müller" can be sensitive), so log **id + type + count only, NOT the name**.
  - `documents_added_to_collection`, `documents_removed_from_collection`, `document_lifecycle_changed`
    (move = compose add+remove, §16.8) — **ids + counts only**, no content, no collection name.
  - **Search / scope query text is never logged** (unchanged).
  - **Enforcement:** this id-only/no-name rule must be asserted by the existing **sentinel-grep test**
    `tests/integration/audit-ipc.test.ts` (extend its forbidden-substring set with a known
    project/collection name and assert it never appears in any logged event for the new operations) —
    the same mechanism that guards content/passwords today (§2.6).
  - **Acknowledged inconsistency (decided, not a bug):** **filenames are still logged** (the existing
    `document_imported`/`deleted` allowance — §2.6), but **collection/project names are not.** This is
    a deliberate asymmetry: a filename is usually descriptive-but-incidental, whereas a user-typed
    project name ("Divorce", "Layoffs Q3") is more likely to encode intent. The conservative choice is
    to redact the name. (Reconsidering the filename allowance itself is out of scope here; the
    asymmetry is intentional and recorded so a future reviewer doesn't "fix" it by logging names.)
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
- `resolveScope` **union (D1):** a composite `DocumentScope` `{collectionIds:[library, projectTax],
  documentIds:[contractA]}` resolves to the **union** of those members + that doc (not a short-circuit);
  empty scope ⇒ "All documents"; attachments are always unioned in (§10.1 rule 1); legacy fallback
  (NULL `scope_v2_json`) maps `scope_json`/`collection_id` correctly. **D3/N1:** a generated doc (one
  with `origin_json` set and **no membership**) is absent from a collection-derived scope but **included**
  when its id is in `documentIds`; `hasExplicitDocSelection` is set only for hand-picked docs (N2).
  **C1 regression:** a doc in Library **and** an archived project is still returned for a **Library**
  scope. **C3:** attachments resolve from `conversation_documents`, not `scope_json`.
  document-level `lifecycle='archived'` excluded by default; `includeArchived` path.
- Filename auto-scope **within** active collection; ambiguous multi-match → all-matches + notice;
  no-match-in-scope behaviour.
- `lifecycle` coalesce (NULL ⇒ permanent); temporary excluded from Library default.
- `origin_json` provenance parse: old `Translation/CompareOrigin` shape still parses; new
  `GeneratedProvenance` round-trips; malformed → safe default.

### 19.2 Integration (`tests/integration`)

- **Migration:** open a pre-feature DB → all **non-generated** indexed docs become Library members
  (generated rows get **no** membership — D3/step 5 is a no-op, N1); built-ins (Library + Temporary
  only) seeded once; re-open is a no-op (no double-filing). Pre-feature `scope_json` conversations
  still answer (legacy fallback, §10.4).
- Import to Library / Project / Temporary / conversation; folder import preserves
  `source_relative_path` + `source_folder_label`; old `importDocuments(paths)` caller unchanged.
- `retrieve` with `collectionIds` + `documentIds` **unioned (D1)** — a query over "Library + projectX
  + docA" returns hits from all three; **legacy positional `string[]`/`null` arg-5 callers still
  compile and behave identically** (H3 union normalization); project scope + filename auto-scope.
  **D3:** generated docs absent from a collection scope, present when explicitly selected. **M2
  split:** an **empty-project** scope ⇒ runtime not called, `NO_DOCUMENT_CONTEXT_ANSWER`; an
  **all-stale-project** scope (indexed docs, none visible to the active embedder) ⇒ scoped
  `corpusNeedsReindex` true ⇒ `REINDEX_NEEDED_ANSWER`.
- Delete document removes chunks + embeddings + stored copy and **cascades** memberships +
  `conversation_documents` links (C4); original source untouched. **Version-skew:** a delete with FKs
  enforced succeeds (no FK violation) because of `ON DELETE CASCADE`.
- **C1:** archiving a *document* (`lifecycle='archived'`) excludes it from default retrieval (visible
  with `includeArchived`); archiving a *project* removes it as a scope target **but its members
  retrievable via their other memberships are unaffected**.
- **M1:** a doc queued for a Project/Temporary then "restarted" (status still `queued`) is **not**
  back-filled to Library by the migration; on resume it files to its `pending_destination_json`.
- **C2:** delete-project "with documents" deletes only genuinely project-only docs and **never** a
  Library member.
- **D3/N1:** generated translation/compare gets **no membership at all**, is excluded from default
  retrieval **structurally** (no membership ⇒ no collection expansion reaches it), but is answerable
  when explicitly selected; provenance persisted; on migration a pre-existing generated row ends up
  membership-free (step 4's `origin_json IS NULL` guard skips it; step 5 is a no-op) and therefore out
  of the default corpus.
- **D2:** importing a file whose `sha256` already exists creates a **new** `documents` row + new
  embeddings (no dedup, no prompt); `docs:addToCollection` on an existing doc shares it across
  collections **without** a new vector set.
- **D1 persistence:** `chat:setScope` round-trips a composite `DocumentScope` through `scope_v2_json`;
  a corrupt `scope_v2_json` falls back to legacy/Library without throwing.
- **Encrypted workspace:** import/move/delete with collections; lock/unlock round-trips collection +
  scope metadata; re-index keeps memberships.

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

### Phase B — Projects + composite scope (D1)
Create/rename/archive/delete projects; add/move docs; project document view (Documents section rail);
`conversations.collection_id` **and `scope_v2_json`**; **multi-select source picker** (Library +
project(s) + specific docs) writing a persisted composite `DocumentScope` (D1); `chat:setScope`;
project-scoped chats default to project; composer footer summarizes the composed union; conversation-
list grouping. **Deliverable:** create "Tax 2025", then ask over "Library + Tax 2025 + contractA.pdf"
in one chat, and have it persist across restart.

### Phase C — Temporary analysis
Import destination chooser; **net-new chat attach / drag-drop ingestion entry point (H1)** — there is
no drop/file-input handler in `ChatScreen.tsx`/`Composer.tsx` today, so this phase **builds** the drop
target + file picker, the intake that hands paths to `importDocuments` with
`{ kind: 'conversation', conversationId }`, and the `conversation_documents` membership wiring (C3) —
it is **not** a re-route of an existing gesture; plain-`chat` drop routing per §13.5 (H2); Temporary
view; Keep / Move / Delete actions; dangling-scope fallback. No retention sweep. **Deliverable:**
analyse invoice.pdf in chat without polluting Library.

### Phase D — Generated provenance (D3)
Extended `origin_json`/`GeneratedProvenance`; generated docs get **no `document_collections` membership
at all** (N1 — no source/project filing, no Generated home), so they are **excluded from default
retrieval** structurally, visible in the Generated smart view (`origin_json IS NOT NULL`),
**downloadable**, and explicitly selectable; provenance UI labels.
**Deliverable:** generated docs explain their origin, stay out of the default corpus, and can be made
durable knowledge by download + re-import.

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
3. **Multi-collection generated assignment.** ~~Open~~ **MOOT (D3).** Generated docs are no longer
   auto-filed into any source collection (§15.2), so there is nothing to assign — the question
   disappears.
4. **Summary as document vs metadata.** Keep `summary_json` metadata [planned/recommended] or
   materialize summaries as generated documents for uniform provenance?
5. **Project/collection name in audit.** ~~Open~~ **DECIDED (L1):** log **id+type+count only, not the
   name** — more conservative than the filename allowance; enforced by the sentinel-grep test. The
   filename-vs-name asymmetry is intentional (§17). Left here only as a recorded decision; the owner
   may still loosen it, but the plan no longer treats it as open.
6. **Persisted richer `DocumentScope`.** ~~Open~~ **DECIDED (D1): pulled forward.** v1 **adds**
   `conversations.scope_v2_json` and persists a composite `DocumentScope` (Library + projects +
   specific docs), with `resolveScope` returning the union (§8.3, §10). Remaining sub-question, still
   open: should a smart view ever be storable *as* a scope (vs only applied to the listing)? Deferred
   until smart views become stored collections (§7.6).
7. **Duplicate import default.** ~~Open~~ **DECIDED (D2): always import as new.** No sha dedup, no
   prompt; share-without-duplication is the separate Add-to-collection action (§11.4).
8. **Folder import → collections.** v1 metadata-only [planned]; when (if ever) do top-level folders
   auto-create projects?
9. **Default for a brand-new documents-mode chat with projects present.** Library [planned] vs "last
   used project" vs prompt?
10. **Plain-chat drop threshold (new — H2/§13.5).** The planned rule is "empty chat ⇒ switch in
    place; chat-with-messages ⇒ start a new documents-mode conversation." Is the message-count
    boundary the right trigger, or should dropping a file onto *any* plain chat always prompt ("Start
    a document chat for invoice.pdf?") rather than acting automatically?

---

## 22. Accepted v1 trade-offs

- **Library == all documents on day one**; the distinction only earns its keep as users add
  Temporary/Archived/Project-only docs. Acceptable (and the intended gradual behaviour).
- **No retention automation** — Temporary files accumulate until explicitly handled. Safer than
  silent deletion; the review dashboard is Phase E.
- **Provenance staleness is data-only in v1** — we store enough to compute "source changed" later but
  show no staleness badge yet (matches today's snapshot semantics).
- **Smart views are query-time, not stored** — a saved-search abstraction (named, persisted predicate)
  is deferred. They are **listing filters**; their current ids can be hand-added to a scope, but a
  smart view is not itself a *saved* scope in v1 (§13.2).
- **Composite chat scope IS in v1 (D1)** — a chat persists a union of Library + project(s) + specific
  docs in `scope_v2_json`. Cost accepted: a richer scope column + a multi-select popover + union SQL,
  vs the simpler single-anchor model the audit pass had proposed. Worth it per the owner (users think
  in "my sources", not one bucket).
- **Import always creates a new document (D2)** — re-importing the same file yields a second row + a
  second vector set (duplication). Accepted: the import gesture stays simple and predictable;
  deliberate de-duplicated sharing is the explicit Add-to-collection action (§11.4).
- **Generated docs are outside the default corpus (D3)** — a translation/comparison is never auto-part
  of answers; the user re-imports it to make it knowledge. Accepted: keeps the answer corpus to
  user-trusted inputs, at the cost of a download+re-import step for anyone who wants a generated output
  answerable by default.
- **Pre-feature app on a post-feature DB ignores collections for *display*** (shows the flat corpus)
  but **relies on `ON DELETE CASCADE` for safe document *deletion*** (C4) — without CASCADE an old
  app's direct `DELETE FROM documents` would hit an FK violation under `PRAGMA foreign_keys = ON`.
  Documented version-skew (plus a one-line note in `known-limitations.md`), consistent with the
  existing app-beside-data stance.
- **`last_used_at` deferred (L2)** — not written on the streaming/preview hot path in v1; the
  "Recently used" view (Phase E) introduces it when it has a consumer.
- **`ensureColumn` forces nullable columns** — `lifecycle` etc. coalesce NULL⇒default in code rather
  than at the DB layer (the established `scope_json` pattern).

---

## 23. Acceptance criteria

- New tables + columns are additive; a pre-feature DB migrates with all **non-generated** indexed docs
  in Library, seeded built-ins, and no double-filing on re-open.
- Selected-document asking is **preserved** and **unioned** with any collection scope (D1) — a
  specific-doc pick is always included, never dropped.
- **Composite scope (D1)** persists: a chat over "Library + project + specific docs" survives restart
  via `scope_v2_json`.
- Filename auto-scope is **preserved** and now narrows within the resolved union; ambiguity is
  surfaced, never silently mis-guessed.
- **Import always creates a new document (D2)**; sharing across folders is the explicit
  Add-to-collection action.
- Import/re-index/delete semantics are preserved; delete shreds the sidecar and **cascades**
  memberships/links; the original source file is never touched.
- Generated translations/comparisons keep working and gain structured provenance; they are **excluded
  from default retrieval (D3)**, downloadable, and explicitly selectable.
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
- `apps/desktop/src/main/services/db.ts` — `SCHEMA` (+3 tables: `collections`, `document_collections`,
  `conversation_documents` — the last two with `ON DELETE CASCADE`, C4), `ensureColumn` calls
  (incl. `pending_destination_json`, M1; **no** `last_used_at` in v1, L2), seed/backfill
  (status-gated, M1).
- `apps/desktop/src/main/services/collections.ts` — **new** `CollectionService` (CRUD + membership +
  `resolveScope` with the `temporary-attachments` kind from `conversation_documents`, C3).
- `apps/desktop/src/main/services/chat.ts` — `Conversation.collectionId` + **`scope: DocumentScope`**
  (D1, parsed from `scope_v2_json`), `rowToConversation`, `createConversation`/update, a `setScope`
  writer; keep `parseScope`. **No change to `updateConversationScope`'s replace semantics** — temp
  attachments don't use it (H4/C3).
- `apps/desktop/src/main/services/rag/index.ts` — `RetrievalScope`, `retrieve` arg-5 union +
  normalization (H3), **scope-threaded `corpusNeedsReindex`** (M2).
- `apps/desktop/src/main/services/rag/scope.ts` — auto-scope within active scope + ambiguity.
- `apps/desktop/src/main/services/rag/hybrid.ts` — `keywordSearchChunks` collection filter.
- `apps/desktop/src/main/services/embeddings/index.ts` — `VectorIndex` collection/archived filter
  (document-level `lifecycle='archived'` only, C1).
- `apps/desktop/src/main/services/ingestion/index.ts` — `createQueuedDocument` persists
  `pending_destination_json` (M1); on success write membership/lifecycle/folder metadata;
  `deleteDocument` switches `rmSync` → `shredFile` (M5) and relies on CASCADE for membership/link
  cleanup (C4 — the manual `DELETE FROM document_collections` is unnecessary); extend/parse
  `origin_json`.
- `apps/desktop/src/main/services/doctasks/manager.ts` — generated-doc gets **no membership** (N1 —
  no source/project filing, no Generated home) + structured provenance (`GeneratedProvenance`).
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
