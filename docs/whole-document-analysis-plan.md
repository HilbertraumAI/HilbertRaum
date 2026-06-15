# Whole-document analysis beyond the context window — implementation plan

> **Status: PLAN (working paper). Not yet implemented.** Per `CLAUDE.md` doc-lifecycle,
> this file lives only while the work is open; once shipped it condenses into §-records in
> `docs/rag-design.md` / `docs/architecture.md` and is deleted.
>
> Goal: first-class analysis of documents (and collections) that **vastly exceed** the
> 4k–8k model context — covering the **whole** document, faithfully and honestly — by
> moving cost from query time to ingest time via a persistent hierarchical summary tree
> (RAPTOR-lite) plus structured extract-then-aggregate, routed by task type. All offline,
> one model job at a time, CPU-first.

> **Audit remediation (2026-06-15).** This revision fixes the Critical/High findings of the
> multi-persona audit:
> - **C1 — coverage honesty under the 1000-chunk cap.** Keep the cap, but evaluate the
>   would-be chunk count **at upload** and **reject** an over-cap document with a friendly
>   error instead of silently dropping its tail. Any *indexed* document is therefore fully
>   chunked, so "tree covers 100% of chunks" == "covers 100% of the document" (no silent
>   truncation). (§1.1, §3.5, Phase 1.)
> - **C2 — one global cap parameter.** A single `MAX_CHUNKS_PER_DOCUMENT` is the source of
>   truth for the cap, the upload check, the coverage math, and the test fixtures.
> - **C3 — cache key vs node identity split.** A content cache (`content_hash → summary`)
>   skips model calls; tree-node *identity* is always a fresh row per structural position,
>   so repeated/boilerplate content can no longer collapse the tree. (§3.1, §4.1.)
> - **H1/H2 — re-index churns chunk ids & orphans the tree.** Tree nodes/edges are torn
>   down and `tree_status` reset wherever chunks are replaced; the content cache (keyed by
>   text, not id) makes the rebuild cheap. (§3.2, §3.5, §4.1.)
> - **H3 — a 250-call build must not freeze chat.** The build is a *yielding* background
>   job that commits one node at a time and cedes the single model slot to interactive chat
>   between nodes (worst-case chat wait ≈ one node, not the whole build). (§4.1, §5.1.)
> - **H4/H5 — node vectors.** `VectorIndex` scans only `embeddings`; a separate
>   node-cosine path over `tree_nodes` is new code, scoped by `embedding_model_id` with the
>   same staleness discipline as chunks. (§3.1, §4.3.)
> - **H6 — collection-scope coverage** has a defined, honest v1 behavior. (§4.6.)
> - **H7 — "list every X"** is honest about its closed vocabulary and per-chunk recall
>   (no false "complete"). (§4.2.)
> - **H8 — symmetric compare** scope is stated precisely (single-pass OR both-trees). (§4.3.)

---

## 1. Codebase map (verified against the code)

Everything below was read in the current tree. Where it corrects the brief, it is flagged **[correction]**.

### 1.1 Ingestion pipeline
- Entry points: [`registerDocsIpc.ts`](../apps/desktop/src/main/ipc/registerDocsIpc.ts) `IPC.importDocuments` handler (line 196) → `createQueuedDocument` (per file) → background loop calls `processDocument` (line 264) → `fileFromPendingDestination` (line 274). Re-index path: `IPC.reindexDocument` (line 466) → `reindexDocument` (line 476).
- Pipeline core: [`ingestion/index.ts`](../apps/desktop/src/main/services/ingestion/index.ts) `processDocument` (line 447): `extracting → chunking → embedding → indexed`, writes `documents`/`chunks`/`embeddings`. `embedChunks` (line 655) embeds **all chunks in one batch** and stores raw Float32 blobs.
- Chunking: [`chunker.ts`](../apps/desktop/src/main/services/ingestion/chunker.ts) `chunkSegments` (line 204). **[confirms brief]** `CHUNK_DEFAULTS = { chunkSizeTokens: 500, chunkOverlapTokens: 80, maxChunks: 1000 }` (line 36). The **1000-chunk cap is enforced inside `chunkSegments`** (line 223: `if (index >= maxChunks) return chunks` — **today, remaining text is silently dropped; the doc still reaches `indexed`**). **[change — C1/C2]** This silent drop is the root of the coverage-honesty problem. We **keep the cap** but make it a single named constant `MAX_CHUNKS_PER_DOCUMENT` (replacing `CHUNK_DEFAULTS.maxChunks`, the one source of truth), and we **reject** an over-cap document at upload instead of truncating it (§3.5). After this change, *every indexed document is fully chunked*, so the tree's "100% of chunks" is "100% of the document." Overlap is applied **within a segment only** (chunks never straddle a page/section boundary). `approxTokenCount` (line 82) over-counts space-less scripts to avoid the HTTP-400 overflow bug; `windowByTokens`/`truncateToApproxTokens` do budget-bounded windowing.
- Pre-parse caps: [`limits.ts`](../apps/desktop/src/main/services/ingestion/limits.ts) (byte ceiling / parse timeout / PDF pages / DOCX inflate). Not relevant to the tree except as the bound that keeps a single parse finite.
- Re-extraction (used by translate/compare, **not** chunks): `extractDocumentPreview` (line 688) re-parses the stored copy into ordered, **non-overlapping** segments.

### 1.2 Storage schema
- [`db.ts`](../apps/desktop/src/main/services/db.ts). Tables (line 19+): `settings`, `conversations`, `messages`, `documents`, `chunks`, `embeddings`, `runtime_events`, plus org tables `collections`, `document_collections`, `conversation_documents`.
- `chunks` (line 61): `id` (TEXT PK), `document_id`, `chunk_index`, `text`, `source_label`, `page_number`, `section_label`, `token_count`, `created_at`. **No content hash column.**
- `embeddings` (line 75): `chunk_id` (PK), `embedding_model_id`, `vector_blob` (raw LE Float32), `dimensions`, `created_at`. One row per chunk; **PK is chunk_id**, so a node embedding cannot reuse this table without a synthetic key — a node table needs its own embedding columns.
- FTS5: `chunks_fts` (line 173) — self-contained (`text`, `chunk_id UNINDEXED`), trigger-synced on chunk insert/delete/update, with a one-time backfill. (`messages_fts` mirrors it for chat search.)
- **Migration mechanism [correction to any assumption of versioning]:** there is **no schema version number**. `openDatabase` (line 270) runs `SCHEMA` (`CREATE TABLE IF NOT EXISTS`), then a list of idempotent `ensureColumn` calls (line 150 — guarded by `PRAGMA table_info`; DDL grammar forbids `DEFAULT`/`NOT NULL`, so NULL is the sentinel, coalesced in code), then `ensureChunksFts`/`ensureMessagesFts`, then `seedCollections`. **The pattern a new feature must follow:** add new tables to the `SCHEMA` constant (idempotent), new columns via `ensureColumn`, new virtual/seed work as guarded idempotent functions called from `openDatabase`.
- **Encryption [confirms brief, important]:** the **whole SQLite file is encrypted at rest** (vault envelope, `workspace-vault.ts`); document copies rest as `<id><ext>.enc`. New tables therefore **inherit encryption automatically** — there is nothing per-table to do. Node's built-in `node:sqlite` driver is used (loaded via `createRequire`).

### 1.3 Retrieval (the FALLBACK engine — keep)
- [`rag/index.ts`](../apps/desktop/src/main/services/rag/index.ts) `retrieve` (line 194): embed query → cosine top-k (`VectorIndex.searchText`) with a `minSimilarity` floor → FTS5 keyword top-k (`keywordSearchChunks`) → **RRF fuse** → join to chunk rows → optional rerank → dedup by document/page → trim to `topKFinal`/`maxContextTokens` → assign `[S1]…` labels + `Citation[]`. `generateGroundedAnswer` (line 412) builds the grounded prompt and streams; empty/weak retrieval returns a fixed "not in your documents" answer (never calls the model) and distinguishes `REINDEX_NEEDED` from `NO_DOCUMENT_CONTEXT`.
- Hybrid + fusion: [`rag/hybrid.ts`](../apps/desktop/src/main/services/rag/hybrid.ts) `keywordSearchChunks` (line 48, embedder-visibility-scoped), `rrfFuse` (line 109, `RRF_K=60`).
- Vector search: [`embeddings/index.ts`](../apps/desktop/src/main/services/embeddings/index.ts) `VectorIndex` (line 136) — linear cosine scan, scoped by `embeddingModelId` + `documentIds`/`collectionIds`/`includeArchived`. `encodeVector`/`decodeVector` (lines 55/64).
- Scope filter: [`retrieval-scope.ts`](../apps/desktop/src/main/services/retrieval-scope.ts) `buildScopeFilter` (line 36) — the one shared membership/id/archived SQL builder. `RetrievalScope`/`DocumentScope` resolved per conversation by `resolveScope` in [`collections.ts`](../apps/desktop/src/main/services/collections.ts).
- Filename auto-scope (routing precedent): [`rag/scope.ts`](../apps/desktop/src/main/services/rag/scope.ts) `detectFilenameScope` (line 72) — a pure narrowing heuristic already wired into `registerRagIpc`.

### 1.4 Reranker
- [`reranker/index.ts`](../apps/desktop/src/main/services/reranker/index.ts) `Reranker.rerank(query, documents[])`. **[correction to the brief's cost model]:** it makes **one batched `/v1/rerank` call over all candidates**, not one call per candidate. The "~2s/candidate" is the marginal cost the model pays; truncation caps query≈160 words / doc≈320 words. It is **optional/null-safe** — `composeServices` yields `reranker: Reranker | null`; absent ⇒ retrieval keeps the fused order byte-identical. **Implication:** the tree/extract passes should avoid the reranker on the hot ingest path; it stays a query-time relevance refinement.

### 1.5 Map-reduce summarizer / translation / compare (the COVERAGE engine — reuse, fix the cap)
- Orchestrator: [`doctasks/manager.ts`](../apps/desktop/src/main/services/doctasks/manager.ts) `DocTaskManager` (line 169). FIFO queue, **one running task** (`runningId`); refuses to start while chat is streaming (`isChatStreaming`, line 196); chat refuses while a task is active (guard in chat/RAG IPC). Tasks get their own `AbortController`. `generate` (line 1013) is the single model-call primitive (explicit maxTokens/temperature; maps overflow → friendly `contextExceeded`).
- Summary math/prompts: [`doctasks/summary.ts`](../apps/desktop/src/main/services/doctasks/summary.ts). **[confirms brief]** budget = `usableInputTokens = ctx − SUMMARY_OUTPUT_TOKENS(512) − SUMMARY_PROMPT_RESERVE_TOKENS(300)`; `summaryBudgetWords = usable / SUMMARY_TOKENS_PER_WORD(1.3)`. **`SUMMARY_MAP_CALL_CEILING = 12`** (line 23) — the central cap; `planSummaryWindows` (line 103) keeps the first 12 windows and sets `truncated = true` ("covers the beginning"). `packIntoWindows` (line 58) is the reusable greedy packer (split over-budget pieces, never drop).
- Translation: [`doctasks/translation.ts`](../apps/desktop/src/main/services/doctasks/translation.ts) — linear map over re-extracted segments, **no ceiling, no reduce** (must be complete). **[confirms brief]**
- Compare: [`doctasks/compare.ts`](../apps/desktop/src/main/services/doctasks/compare.ts) — mode (a) single-pass when both full texts fit (`compareFitsSinglePass`); else mode (b) **A-driven section-matched** map-reduce (`planCompareWindows`, `COMPARE_MAP_CALL_CEILING = 12`, `truncated`). **[confirms brief: asymmetric]** Mode (b) retrieves B-neighbours per A-window via the existing `VectorIndex` scoped to B; the honesty note (lines 28–32) already records that "only in B" is structurally weaker.

### 1.6 Single-job model scheduling [correction/refinement]
Concurrency is enforced at three layers, **not** a single global model queue:
1. `RuntimeManager` ([`runtime/index.ts`](../apps/desktop/src/main/services/runtime/index.ts)) serializes **start/stop** of the one `ModelRuntime` (one `llama-server`), and `start` is idempotent.
2. Chat streams are de-duped per conversation via `inFlightStreams` ([`ipc/inflight.ts`](../apps/desktop/src/main/ipc/inflight.ts)).
3. `DocTaskManager` FIFO + the chat↔task mutual-exclusion guards.
**Key facts for this design:** (a) The **embedder is a separate sidecar process** (`--device none`, CPU) from the chat `llama-server` — embedding and chat do not contend for the same process, but both load the CPU. (b) There is **no queue that serializes raw `chatStream` calls** beyond these layers; the new tree/extract passes MUST go through `DocTaskManager` (or an equivalent single-job owner) so they cannot run concurrently with chat or each other.

### 1.7 IPC + renderer surface
- Doc-task IPC: [`registerDocTasksIpc.ts`](../apps/desktop/src/main/ipc/registerDocTasksIpc.ts) — `doctasks:start` → `{jobId}`, `doctasks:get` (poll `DocTaskStatus`), `doctasks:cancel`. Renderer store: [`renderer/lib/doctasks.ts`](../apps/desktop/src/renderer/lib/doctasks.ts) (module-level single active task, 400ms poll, survives unmount).
- RAG IPC: [`registerRagIpc.ts`](../apps/desktop/src/main/ipc/registerRagIpc.ts) — `rag:ask`, resolves scope, runs filename auto-scope within scope, sends an ephemeral `STREAM.scope` notice, streams tokens.
- Types: [`shared/types.ts`](../apps/desktop/src/shared/types.ts) — `DocTaskKind = 'summary'|'translation'|'compare'|'ocr'`, `DocTaskStatus`, `StartDocTaskRequest`, `DocumentSummary { text, modelId, createdAt, truncated }`, `DocumentInfo`, `GeneratedProvenance`, `DocumentScope`, `RetrievalScope`.
- **The "truncated / covers only the beginning" warning is surfaced** in [`DocumentsScreen.tsx`](../apps/desktop/src/renderer/screens/DocumentsScreen.tsx) `PreviewModal` (`summary.truncated && <Banner tone="warning">{t('docs.previewModal.truncated')}</Banner>`); compare's truncation is an in-document Markdown notice (`compareTruncationNotice`). This is exactly where the **coverage meter** attaches.

---

## 2. Gap analysis (against §5 of the brief)

| Component | Exists today | Gap / change needed |
|---|---|---|
| Over-cap docs | silently truncated at 1000 chunks (still `indexed`) | **[C1]** Reject at upload with a friendly "too large" error; centralize the cap as `MAX_CHUNKS_PER_DOCUMENT` **[C2]**. |
| Hierarchical summary tree | **Nothing.** | New `tree_nodes`/`tree_edges` tables, build algorithm, content cache, node embeddings. |
| Tree build scheduling | DocTaskManager FIFO (chat-runtime jobs) | **[H3]** New **yielding** background build (per-node commit, cedes the model slot to chat between nodes). Auto if runtime up, else `pending` (Q1). |
| Greedy window packing | `packIntoWindows` (summary.ts) | Reuse as the group-packer (target `TREE_GROUP_TOKENS`, scaled to context). |
| Map/reduce summarization primitive | `DocTaskManager.generate` + summary prompts | Reuse verbatim to summarize each tree group (one call → one node). |
| Whole-doc summary cap | `SUMMARY_MAP_CALL_CEILING = 12`, `truncated` | When a tree is `ready`, root summary feeds `summary_json` (`truncated=false`). **[M1]** `runSummary` consults the tree first; capped path stays the tree-less fallback. |
| Node embeddings + search | `embeddings` is chunk-PK only; `VectorIndex` scans only `embeddings` | **[H4]** Store node vectors in `tree_nodes`; **new** node-cosine scan (not `VectorIndex`), scoped by `embedding_model_id` **[H5]**. |
| Multi-level retrieval (semi-global QA) | `VectorIndex` over chunk vectors | Optionally surface upper-level nodes as *derived context*, **never as `[Sn]` citations** (M2). |
| Structured extract-then-aggregate | **Nothing.** | New `extraction_records` table, per-chunk extract pass at ingest, SQL aggregation via `buildScopeFilter`, router rule. |
| Symmetric compare | Mode (b) A-driven (asymmetric) | **[H8]** New symmetric path for single-pass **or** both-trees; asymmetric mode (b) stays the labelled fallback. |
| Task router | `detectFilenameScope` (narrowing only); task kind chosen by UI button | New router: task type + "list all/every/how many" → coverage; precedence + low-confidence fallback to relevance. |
| Coverage meter / tiers / provenance UI | `summary.truncated` banner only | Coverage metric (breadth ≠ fidelity), tier selector, node/chunk provenance, "no tree yet / relevance-only" labels. |
| Caching by content hash | none (chunks have no hash) | **[C3]** Content cache `content_hash → summary` (skip model call); node identity is a fresh row per position. |
| Re-index / tree invalidation | `reindexDocument` clears only `summary_json` | **[H1/H2]** Tear down tree nodes/edges + reset `tree_status` wherever chunks are replaced; extraction rows cascade via `chunk_id`. |
| Migration | idempotent `SCHEMA`+`ensureColumn` | Add tables/columns the same way; no version bump. Encryption inherited. |

---

## 3. Proposed data model (SQLite)

All additive. Tables go in the `SCHEMA` constant of [`db.ts`](../apps/desktop/src/main/services/db.ts); columns via `ensureColumn`. No schema-version number (consistent with the repo). Everything inherits whole-file encryption.

### 3.1 Tree nodes
```sql
CREATE TABLE IF NOT EXISTS tree_nodes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,          -- source document (per-doc tree)
  scope_key TEXT,                     -- reserved for collection-level "tree of trees" (NULL in per-doc v1)
  level INTEGER NOT NULL,             -- 1 = first summary level (children are chunks); 2+ summarize nodes; root = max level
  ordinal INTEGER NOT NULL,           -- order within (document_id, level)
  parent_id TEXT,                     -- NULL for the root
  is_root INTEGER NOT NULL DEFAULT 0,
  summary_text TEXT NOT NULL,
  embedding_blob BLOB,                -- raw LE Float32 (same encoding as embeddings.vector_blob)
  dimensions INTEGER,
  embedding_model_id TEXT,            -- [H5] the embedder that produced embedding_blob; node search scopes by this
  content_hash TEXT NOT NULL,         -- [C3] sha256 over ORDERED child texts — the CONTENT-CACHE key (NOT node identity)
  model_id TEXT,                      -- chat model that produced summary_text
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id)  REFERENCES tree_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_doc ON tree_nodes(document_id, level, ordinal);

-- Child edges: a node's children are either chunks (level-1 nodes) or lower nodes (level≥2).
CREATE TABLE IF NOT EXISTS tree_edges (
  parent_id TEXT NOT NULL,
  child_id  TEXT NOT NULL,            -- chunks.id when child_is_chunk=1, else tree_nodes.id
  child_is_chunk INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  FOREIGN KEY (parent_id) REFERENCES tree_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tree_edges_parent ON tree_edges(parent_id);

-- [C3] Content cache: maps the exact summarize-input text to its computed summary (and the
-- node embedding), so a rebuild — or a different document with identical boilerplate — skips
-- the model + embed call. This is SEPARATE from node identity: a tree always gets one fresh
-- tree_nodes row per structural position (so repeated content can never collapse two
-- positions into one node — the C3 bug). Keyed by (content_hash, model_id) so a model change
-- doesn't silently reuse an older model's summary [M5]. Cache survives node/tree deletion;
-- it carries no document_id and is pruned by a size/age policy, never by FK.
CREATE TABLE IF NOT EXISTS summary_cache (
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,             -- chat model that produced summary_text
  summary_text TEXT NOT NULL,
  embedding_blob BLOB,                -- node vector for this summary, under embedding_model_id
  embedding_model_id TEXT,
  dimensions INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (content_hash, model_id)
);
```
- **Provenance** ("which chunks fed this answer") = recursive walk of `tree_edges` to the chunk leaves. **Coverage** = leaf-chunk count reachable from the root **/ `chunks` count for the doc** — which, after the §3.5 upload-cap rejection, is the whole document. When `tree_status != 'ready'` the meter reports the partial fraction, never "100%" (see §4.5).
- `ON DELETE CASCADE` on `document_id` keeps deletes clean under `PRAGMA foreign_keys = ON` (same rationale as `document_collections`, db.ts line 110). **Note [H1]:** `tree_edges.child_id` is intentionally polymorphic (chunk *or* node) so it carries **no** FK to `chunks`; deleting chunks therefore does NOT cascade to edges — re-index must tear the tree down explicitly (§3.5).

### 3.2 Tree build state (resume)
Add columns rather than a table (cheap, matches the org-feature precedent):
```
ensureColumn(db, 'documents', 'tree_status', 'tree_status TEXT')  -- NULL | 'pending' | 'building' | 'ready' | 'stale' | 'failed'
ensureColumn(db, 'documents', 'tree_meta_json', 'tree_meta_json TEXT') -- { rootId, levels, leafChunkCount, builtAt, modelId, embeddingModelId }
```
- Resumability: a build that died leaves `tree_status='building'`; a startup `reconcileStuckTrees` (mirror of `reconcileStuckDocuments`) flips it to `'pending'`. **[M4]** A startup sweep re-enqueues `'pending'` trees *only* when a chat runtime is available and the build policy (Q4, opt-in/size-gated) permits — otherwise they wait for the user's "Build deep index" action.
- **[H5]** `tree_meta_json.embeddingModelId` records which embedder produced the node vectors. If the active embedder differs (mock↔real, model swap), node vectors are invisible to node search — surface a node-level `staleEmbeddings` equivalent and require a re-embed (cheap: re-embed node `summary_text`, no chat calls) or a rebuild before serving node-vector features (compare align, semi-global retrieval).

### 3.3 Structured extraction records
```sql
CREATE TABLE IF NOT EXISTS extraction_records (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,             -- provenance (which chunk this came from)
  record_type TEXT NOT NULL,          -- e.g. 'obligation' | 'party' | 'date' | 'amount' | 'definition' | 'generic'
  value_text TEXT NOT NULL,           -- the surfaced item, verbatim-ish
  normalized_value TEXT NOT NULL,     -- lowercased/trimmed key for dedup/aggregation
  attributes_json TEXT,               -- optional structured fields per type
  model_id TEXT,
  content_hash TEXT NOT NULL,         -- per-chunk extract cache key (sha256 of chunk text + type-set)
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id)   REFERENCES chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_extract_doc_type ON extraction_records(document_id, record_type, normalized_value);
```
- **[H1, free win]** Because `chunk_id` has `ON DELETE CASCADE`, re-index (which deletes+recreates chunks) **automatically** drops a document's extraction rows — extraction self-invalidates on re-index (unlike the tree, which must be torn down explicitly because its leaves are polymorphic edges, §3.5).
- **[M3]** Aggregation must scope through the shared `buildScopeFilter` (membership OR id, archived exclusion), not a raw `document_id IN (…)`, so collection/archived semantics match the rest of the app: `… WHERE record_type=? AND <buildScopeFilter('document_id')> GROUP BY normalized_value`.
- **[H7] Honesty:** a chunk whose extract reply was unparseable after one retry is recorded as an `unparsed` marker row (or counted in `tree_meta`-style extract state), so the listing's coverage meter reads "scanned 213/213 chunks (3 unparsed)" rather than silently dropping items. The result is **exhaustive over indexed chunks with per-item provenance**, *not* "guaranteed complete" — per-chunk model recall and `normalized_value` dedup are explicit caveats surfaced in the UI.
- Extract state: a `documents.extract_status` column (mirrors `tree_status`) tracks the per-chunk pass; fold tree+extract into one `deep_index_status` if they always run together.

### 3.4 Migration & encryption
- Append the `tree_nodes` / `tree_edges` / `summary_cache` / `extraction_records` `CREATE TABLE IF NOT EXISTS` blocks to `SCHEMA`; add the `ensureColumn` lines in `openDatabase`. Add a `reconcileStuckTrees` call (mirror of `reconcileStuckDocuments`) for `'building'` rows.
- **Encrypted workspaces:** no special handling — the file is whole-encrypted; node summaries, the content cache, and extraction records (all **content**) live in that same DB and must **never** be logged or audited (same rule as `summary_json`). Audit events stay ids/kinds/counts only.

### 3.5 Cap enforcement at upload + tree invalidation on re-index (C1/C2, H1/H2)
- **Single cap constant [C2].** Export `MAX_CHUNKS_PER_DOCUMENT` (= 1000 today) from `chunker.ts` as the one source of truth; `CHUNK_DEFAULTS.maxChunks`, the upload check, the coverage math, and the test fixtures all reference it.
- **Reject over-cap at upload [C1].** `chunkSegments` (or a cheap pre-count helper `wouldExceedChunkCap(segments)`) must report **overflow** instead of silently returning the first `MAX_CHUNKS_PER_DOCUMENT` windows. In `processDocument`'s chunking step: if the document would exceed the cap, set `status='failed'` with a new friendly, persist-canonical English message `main.ingest.tooManyChunks` ("This document is too large to fully index (over N sections). Split it and import the parts."), display-mapped at render. Because over-cap docs never reach `indexed`, **every indexed document is fully chunked** → the tree's chunk coverage IS document coverage (kills the silent-truncation dishonesty). *This is a deliberate behavior change* (today such docs index partially); call it out in `known-limitations.md` and BUILD_STATE. Existing partially-indexed docs are unaffected until re-indexed, at which point they fail with the actionable message.
- **Tree teardown on re-index [H1/H2].** `processDocument` deletes+recreates chunks with fresh ids, orphaning the tree. In the **same** block where chunks/embeddings are replaced, add:
  `DELETE FROM tree_nodes WHERE document_id = ?` (edges cascade via `parent_id`), and set `tree_status` → `'stale'` if a tree existed (so the UI offers "rebuild"), else clear it. Extraction rows self-cascade via `chunk_id`. `reindexDocument` already clears `summary_json`; if that summary came from the root it is correctly invalidated. The expensive model outputs survive in `summary_cache` (keyed by text, not chunk id), so the post-re-index rebuild reuses every unchanged group's summary and only re-summarizes changed groups — cheap, and correct despite full chunk-id churn.

---

## 4. Algorithms

### 4.1 Tree build (per document) — `services/analysis/tree-build.ts` (new)
**Inputs:** the document's stored chunks (level 0), in `chunk_index` order. **Reuses** `packIntoWindows` and the `DocTaskManager.generate` + summary prompts.

1. **Group (level 1).** Pack chunk *texts* greedily, **in `chunk_index` order**, into groups whose combined `approxTokenCount` ≤ **`TREE_GROUP_TOKENS`** (Q5 — scale to context: `usableInputTokens(contextTokens)` reusing the summary budget math), respecting section boundaries when present (don't merge across a `section_label` change if it would exceed the target). Record each group's child chunk ids + ordinals.
2. **Summarize each group → one fresh level-1 node** (always a new `tree_nodes` row per position — never reuse a row by hash). The summary text comes from the **content cache** (step 4); embed it with the **active E5 embedder** and store node + ordered edges (`child_is_chunk=1`).
3. **Recurse.** Treat level-1 node summaries as the inputs; pack to `TREE_GROUP_TOKENS`; summarize each group → level-2 nodes (edges with `child_is_chunk=0`); continue until **one root** remains. Mark it `is_root=1`.
4. **Content cache & resume [C3].** Separate *content* from *identity*:
   - `content_hash = sha256(join('\n\n', orderedChildTexts))` — **ordered, not sorted** (position matters; document order is deterministic).
   - Before a `generate` call, look up `summary_cache(content_hash, model_id)`. **Hit ⇒ copy `summary_text` (+ cached node vector) — skip the chat call and possibly the embed.** Miss ⇒ one `generate` call + embed, then **insert** into `summary_cache`.
   - **Node identity is always a fresh row** keyed by structural position, so two groups with identical content (boilerplate/repeated clauses) get **two distinct nodes** that merely *share a cached summary* — the tree shape and leaf-coverage count stay correct (fixes the C3 collapse bug).
   - **Resume:** a crashed/cancelled build re-plans from the (unchanged) chunks; every group whose content is cached costs **0 chat calls**; only never-seen groups call the model. Partially-built trees are discarded and rebuilt from the cache (cheap), avoiding half-wired parent pointers.
5. **Finalize.** Write `tree_meta_json` (rootId, levels, leafChunkCount, modelId, embeddingModelId, builtAt) and `tree_status='ready'` **atomically** (one transaction) so a reader never sees `ready` with a half-written tree.

**Model-call cost (cold):** O(n) at the build, paid once. For 1000 leaf chunks, branching ≈5: ~200 (L1) + ~40 (L2) + ~8 (L3) + ~2 (L4) ≈ **~250 summary calls**. **Embedding calls:** one per node (~250), on the separate embedder sidecar. With a warm `summary_cache` (re-index, or repeated boilerplate), most of these are skipped. **Query-time whole-doc summary cost:** read the root = **0 or 1 model call** (Tier 1; higher tiers cost more — see §4.5).

**[H3] Yielding background build — must not freeze chat.** A ~250-call build cannot run as a monolithic blocking task (DocTaskManager runs one task at a time and chat refuses while a task is active — that would lock chat out for the whole build). Instead the build is a **cooperative, per-node** job:
- It commits **one node at a time** (each node is durable immediately — resumable, cancellable).
- **Between nodes** it checks whether an interactive chat answer is requested/streaming; if so it **yields the single model slot** (pauses, persists `tree_status='building'`, returns) and resumes when chat is idle. Worst-case added chat latency ≈ **one node**, not the whole build.
- This requires a small change to the chat↔task mutual-exclusion: a chat request arriving during a *yielding tree build* must **signal the build to pause** rather than be refused with `DOC_TASK_BUSY_MESSAGE`. Strict single-model-job is preserved (the builder and chat never call `chatStream` concurrently — the builder only starts a node when no chat is in flight).
- It still registers its target `documentId` on the task so `isDocumentBusy` blocks delete/re-index of that doc while building (consistent with existing tasks).

**Skip generated docs [M6].** Tree build (and the extract pass) skip documents with `origin_json` set — generated translations/comparisons are work-products, excluded from the default corpus (same rule as the Library backfill).

**Rebuild after re-index:** §3.5 tears the tree down and sets `tree_status='stale'`; the next build reuses the warm `summary_cache` so unchanged groups cost no chat calls despite full chunk-id churn.

### 4.2 Structured extract-then-aggregate — `services/analysis/extract.ts` (new)
1. **Per-chunk extract pass (ingest-time, O(n) calls).** For each level-0 chunk, one `generate` call over the **fixed v1 type set** (Q3: `generic`, `date`, `amount`, `party`, `obligation`) with a **strict JSON-array prompt**: "reply ONLY a JSON array of `{type, value}`; if none, `[]`." Low temperature. Parse tolerantly; **on unparseable output, retry once** (translation-window precedent), and if it still fails record an `unparsed` marker for that chunk (do **not** silently drop it — H7 honesty). Insert one `extraction_records` row per item with `chunk_id` provenance, `normalized_value` for dedup, `content_hash` for caching. Same yielding/background discipline as the tree build (§4.1, H3).
2. **Aggregate (query-time, 0 model calls).** SQL `GROUP BY normalized_value` scoped via `buildScopeFilter` (M3) → the list with counts and source chunk ids, plus the coverage line "scanned N/N chunks (k unparsed)".
3. **Honest framing [H7].** This is **exhaustive over indexed chunks with per-item provenance** — *not* a guaranteed-complete list. Surfaced caveats: per-chunk model recall (a small model may miss an item), `normalized_value` over/under-merge, and items split across the ~80-token chunk overlap. The UI labels it "every {X} found across the whole document (N chunks scanned)", never just "complete".
4. **Closed vocabulary → open request mapping [H7].** Extraction is precomputed for the fixed type set only. The router maps a user's "{X}" to a type via a small synonym table (e.g. *deadline/due date* → `date`; *cost/fee/price* → `amount`; *who/parties/signatories* → `party`; *must/shall/obligation/clause* → `obligation`), defaulting to `generic`. **The zero-query-call guarantee holds ONLY for a mapped, pre-extracted type.** An unmapped/ad-hoc "{X}" (e.g. "every risk") has no precomputed table, so v1 **does not** claim completeness for free — it offers an explicit **live full-scan extraction** (a bounded coverage pass over the in-scope chunks, costs model calls, shown as a progress task) or falls back to labelled relevance. This keeps the "0 calls" claim true where stated and honest where not.

### 4.3 Symmetric compare — extend `doctasks/compare.ts` + manager
**Applicability [H8] (state precisely):** the genuinely symmetric path applies in two cases — **(a)** both docs fit a single pass (existing mode (a), already symmetric), or **(b)** **both** documents have a `ready` tree under the **same** active embedder. Two large docs *without* both trees fall back to the existing asymmetric mode (b), explicitly **labelled** "asymmetric — may under-report content unique to B" (the existing honesty note). v1 offers to build the missing tree(s) first (opt-in, Q4).
- **Build for both:** use each tree's level-1 nodes as aligned, non-overlapping sections.
- **Align [H4]:** match A-sections to B-sections by **node-vector cosine**. *This is new code* — `VectorIndex` scans only the chunk `embeddings` table, so node vectors (stored in `tree_nodes`) need a small dedicated cosine scan (`nodeVectorSearch(documentId, level, queryVec)` reusing `decodeVector`/`cosineSimilarity`). Greedy mutual-best-match → aligned pairs + unmatched-A + unmatched-B.
- **Embedder guard [H5]:** both docs' node vectors must be under the active `embedding_model_id` (`tree_meta_json.embeddingModelId`); otherwise re-embed nodes (cheap, no chat calls) or fail friendly with the actionable copy (same pattern as the existing `compareReindex` guard).
- **Diff symmetrically:** for each pair, one `generate` call producing `Same / Different / Only-A / Only-B`; unmatched-A → Only-A, unmatched-B → Only-B. Reduce into the existing four-section report skeleton (`compareReportHeadings`).
- **Acceptance:** in cases (a)/(b), swapping A/B yields the mirror image (alignment is symmetric; Only-A/Only-B swap). The asymmetric fallback is **not** mirror-symmetric and is labelled as such.

### 4.4 Task router — `services/analysis/router.ts` (new, pure + unit-tested)
Input: `{ taskType?, question, scope, treeAvailable, extractAvailable }`. Output: an engine choice.
- **Explicit task buttons** (Summarize/Translate/Compare) set `taskType` directly.
- **Free-text question classification** (regex, language-aware EN+DE):
  - `/\b(list|enumerate|every|each|all (of )?the|how many|count)\b/i` (+ DE: `jede|jeden|alle|wie viele|sämtliche|liste`) → **coverage-extract** (route to §4.2; never top-k).
  - `/\b(summari[sz]e|overview|tl;?dr|gist|whole document|entire)\b/` (+DE) → **tree-summary** (root or subtree).
  - `/\b(compare|difference|versus|vs\.?|diff)\b/` (+DE) → **compare**.
  - else → **relevance RAG** (existing `retrieve`).
- **Precedence + low confidence [M7]:** a question can match several patterns ("summarize the differences in the obligations"). Fixed precedence: **explicit task button > compare (needs 2 docs) > coverage-extract > tree-summary > relevance**. A coverage-extract match that maps to no extracted type, or any low-confidence classification, **falls back to relevance RAG** (never returns an empty "no items" because a generic trigger word fired). Compare classified in a non-2-doc context falls back to relevance.
- **Semi-global QA [M2]:** for relevance questions the router *may* add a few upper-level node summaries as **derived context** in the prompt, but node summaries are machine-generated and are **never emitted as `[Sn]` citations** (that would let the answer cite a synthesized summary as a source, breaking grounding). Citations remain source chunks only; node context is labelled "background (generated summary)".
- **Fallbacks:** when no tree is available, coverage-summary requests degrade to the capped map-reduce **with the honest truncation banner** and an explicit "Build deep index for full coverage" offer; relevance requests are unaffected.

### 4.5 Coverage tiers
With the tree precomputed, tiers select **how much precomputed material** to surface:
- **Tier 1 (instant, 0 calls):** return the stored **root** `summary_text` verbatim (Q6). Re-styling to the user's specific ask is an explicit +1 call.
- **Tier 2 (1 call):** read the **top ~2 levels** of nodes and run **one** reduce for a richer multi-section summary.
- **Tier 3 (few calls):** read **all level-1 nodes** (full leaf coverage, precomputed) and reduce in budget-bounded batches — bounded by node count, **not** by document size at query time.
- **Coverage meter honesty [C1/L2]:** the meter reports two distinct things — **breadth** (chunks reachable from the served subtree ÷ document chunk count; after §3.5 this is 100% only when `tree_status='ready'`) and **depth/tier** (a Tier-1 root is a summary-of-summaries — abstractive and lossy). It must **never** print "100%" when `tree_status` is `stale`/`building`/`pending` (report the partial fraction), and the wording separates "covers the whole document" (breadth) from "high-level / detailed" (depth) so "100%" is never read as "nothing lost". Node/chunk provenance is exposed alongside.

### 4.6 Collection-scope coverage in v1 [H6]
Per-doc trees ship in v1; the collection "tree of trees" is deferred (Q2). A collection-scoped coverage **summary** request therefore has a defined, honest v1 behavior:
- Gather the **roots** of every in-scope member (resolved via `buildScopeFilter`: membership/id, archived excluded). Members **without** a `ready` tree are listed as "not deeply indexed" — the collection coverage meter reads **(members with ready tree) / (members in scope)**, never a blanket 100%.
- If the gathered roots **fit** the budget → one reduce → a true whole-collection summary (Tier-1-of-collection).
- If they **exceed** the budget (large collections — the genuinely deferred case) → v1 does **not** silently truncate: it returns per-document root summaries grouped by document and states "whole-collection synthesis needs the collection deep index (coming later); showing per-document summaries." This keeps v1 honest and gives the brief's Library/Project case a real, non-misleading answer until the collection root lands.
- Collection **"list every X"** already generalizes for free — the §4.2 SQL aggregation runs over the scoped `document_id` set; coverage = scanned chunks across all in-scope, deeply-indexed members.

---

## 5. UI / IPC changes

### 5.1 IPC
- **New deep-index task kind.** Extend `DocTaskKind` with `'tree'` (and `'extract'`) via `DocTaskManager` so progress polling, cancellation, and the busy guard come for free — but as the **yielding** class (§4.1, H3): the chat-busy guard is updated so a chat request during a tree/extract build **signals the build to pause** after the current node rather than returning `DOC_TASK_BUSY_MESSAGE`. `DocTaskStatus.progress.stepsTotal` = planned node/extract count; `stepsDone` advances per committed node (resumable display).
- **Node-vector search [H4]** is a new internal helper over `tree_nodes` (not an IPC), used by compare-align and optional semi-global context; it is **not** `VectorIndex`.
- **Summary wiring [M1].** `runSummary` (the existing one-click summary DocTask) consults the tree first: if `tree_status='ready'`, it serves the Tier-selected summary and writes `summary_json` with `truncated=false`; otherwise it runs today's capped map-reduce (`truncated` as today). So the existing `summary_json` / `PreviewModal` surface keeps working with no new field, and "Summarize" automatically benefits once a tree exists.
- **New query channels:** `analysis:summarize(documentId|scope, tier)` → `{ text, coverage, provenance }`; `analysis:listAll(scope, recordType)` → SQL aggregation result. Free-text questions route through `rag:ask` via the router. Mirror in [`preload/index.ts`](../apps/desktop/src/preload/index.ts).
- **Coverage payload** (new shared type `CoverageInfo { mode: 'tree'|'relevance'|'capped'; treeStatus?: 'ready'|'stale'|'building'|'pending'; chunksCovered; chunksTotal; unparsedChunks?; treeLevels?; tier?; nodeIds?; truncated? }`) returned alongside summaries/answers/listings.

### 5.2 Renderer
- **Coverage meter** (Phase 2 — the honesty differentiator): a component rendered with summary/answer results showing e.g. "Covers 100% of 213 chunks via a 3-level tree" vs "Best-effort: 18 of 213 chunks retrieved (relevance, not exhaustive)". Attaches in `PreviewModal` (replacing/augmenting the `summary.truncated` banner) and in the chat answer surface (near `SourcesDisclosure`).
- **Coverage-tier selector:** a small control (reuse `DepthMenu` pattern) on summarize — Tier 1/2/3.
- **"No tree yet / relevance-only" labels + "Build deep index" action** on documents without a tree (`tree_status` exposed on `DocumentInfo`).
- **Provenance display:** expose node/chunk lineage (reuse `SourcesDisclosure`).

---

## 6. Phased delivery (matches §5.6 build order)

Each phase is independently shippable, tests green + docs + BUILD_STATE per the per-phase ritual.

### Phase 1 — Cap honesty + ingestion-time summary tree (fixes the truncation bug)
- **Cap [C1/C2]:** export `MAX_CHUNKS_PER_DOCUMENT`; make `processDocument` **reject** over-cap docs (`main.ingest.tooManyChunks`) instead of silent truncation; note the behavior change in `known-limitations.md`.
- Schema: `tree_nodes`, `tree_edges`, `summary_cache`, `documents.tree_status`/`tree_meta_json`; `reconcileStuckTrees`; **tree teardown + `tree_status` reset in the chunk-replacement block** [H1/H2].
- `tree-build.ts` as the **yielding** background build [H3] (per-node commit; cedes the model slot to chat); `tree` DocTask kind (Q1) auto-enqueued (size-gated, Q4) when a chat runtime is up, else `pending` + manual "Build deep index"; node embeddings under the active embedder [H5]; skip generated docs [M6].
- `runSummary` serves from the tree root when `ready` (`summary_json`, `truncated=false`) [M1]; capped map-reduce stays the tree-less fallback.
- **Acceptance:**
  - An over-cap document **fails at upload** with the actionable message (never indexes a partial doc).
  - For a **near-cap fixture** (chunks just below `MAX_CHUNKS_PER_DOCUMENT`, exceeding context AND the old 12-window cap), once `tree_status='ready'` a **whole-document (root/Tier-1) summary is produced with ≤1 query-time model call and reports 100% chunk coverage**; a fact planted in the **last** chunk appears on the root summary path (no beginning-only truncation).
  - Coverage meter reports the **partial fraction** (never 100%) while `building`/`stale`/`pending`.
  - Interrupting the build and resuming costs **0 chat calls** for already-cached groups (assert `generate` call count); a re-index tears down the tree, sets `stale`, and the rebuild reuses `summary_cache` despite full chunk-id churn.
  - A chat request sent **during** a build is served within ~one node (build yields), not blocked for the whole build [H3].
  - A tree-less doc still summarizes via the capped path with the honest banner.

### Phase 2 — Coverage meter in the UI
- `CoverageInfo` type + plumb through IPC; coverage meter + tier selector + "no tree yet" labels + provenance.
- **Acceptance:** every summary/answer shows an accurate coverage statement; a relevance answer is explicitly labelled "not exhaustive"; a capped result never displays as complete.

### Phase 3 — Structured extract-then-aggregate
- `extraction_records` schema; `extract.ts`; `extract` ingest pass; router rule "list all/every/how many" → coverage; SQL aggregation answer.
- **Acceptance:** "list every {X}" over a large doc returns a **complete, provenance-backed** list with **zero query-time model calls** after the extract pass; the count matches a manual ground-truth on the fixture; routing sends "how many…" to coverage, never top-k.

### Phase 4 — Symmetric, coverage-oriented compare
- Symmetric align+diff for single-pass **or** both-trees [H8]; node-vector align [H4] with the embedder guard [H5]; asymmetric mode (b) stays the **labelled** fallback when a tree is missing.
- **Acceptance:** in the single-pass and both-trees cases, **swapping A and B yields the mirror-image diff** (Only-A ↔ Only-B, Same/Different stable) and both documents are covered (no beginning-only truncation); the asymmetric fallback is reached only without both trees and is explicitly labelled non-symmetric.

---

## 7. Test plan
- **Fixtures (respect `MAX_CHUNKS_PER_DOCUMENT`):**
  - a **near-cap** document — chunk count just **below** `MAX_CHUNKS_PER_DOCUMENT` (exceeds context AND the old 12-window cap) with known structure (N numbered sections, M planted "obligations", a fact present only in the **last** chunk — the "no truncation-to-beginning" probe);
  - an **over-cap** document — would exceed the cap — to assert upload **rejection** (`main.ingest.tooManyChunks`), never partial index [C1/C2];
  - a doc with **repeated/boilerplate** sections (identical text) to prove the tree does **not** collapse distinct positions [C3];
  - a pair of large near-duplicate docs with planted A-only/B-only facts for symmetric compare.
- **Unit (pure):** group packing to `TREE_GROUP_TOKENS`; `content_hash` is **order-sensitive** + cache-hit logic; **node identity ≠ content** (two identical groups → two nodes, one cache entry) [C3]; router classification + precedence + low-confidence→relevance + open-vocab→type mapping [M7/H7]; coverage math (reachable leaves ÷ chunk count; partial when not `ready`) [C1]; extract JSON tolerance + unparsed-marker accounting [H7]; symmetric-align mirror property.
- **Integration (mock runtime + mock embedder, `npm test` from `apps/desktop`):**
  - over-cap upload fails; near-cap builds a tree whose root covers 100% and surfaces the **last-chunk** fact (no beginning-only truncation);
  - **resumable build:** kill mid-build → resume → already-cached groups cost **0** `generate` calls (assert count);
  - **re-index invalidation [H1/H2]:** re-index tears down the tree, sets `stale`, rebuild reuses `summary_cache` despite changed chunk ids; provenance walk has no dangling edges;
  - **yield [H3]:** a chat request during a build is served within ~one node, not blocked for the whole build;
  - fallback when no tree (capped path + banner); collection-scope summary returns honest per-doc fallback when roots exceed budget [H6];
  - extract aggregation via `buildScopeFilter` (archived excluded) + zero query-time calls for a mapped type; live full-scan path for an unmapped type [H7/M3];
  - compare swap-A/B mirror in single-pass and both-trees cases; embedder-mismatch guard fires [H5];
  - encrypted-workspace round-trip (tree nodes, `summary_cache`, extraction records persist and read back inside the vault).
- **Concurrency:** strict single model job (builder + chat never call `chatStream` concurrently); a chat request pauses (not refuses) a yielding build; cancel mid-build leaves a resumable, non-corrupt state.

---

## 8. Risks, open questions, assumptions

### Decisions taken (owner-confirmed 2026-06-15)
- **Q1 — Build trigger = new `tree` DocTask, auto if a chat runtime is running, else `tree_status='pending'` + manual/lazy "Build deep index".** Reuses single-job serialization, progress, cancel, and chat-mutual-exclusion; import loop unchanged. (NOT built inside `processDocument`.)
- **Q4 — Build policy = opt-in / above a size threshold.** Small docs (that fit anyway) skip the tree; large docs surface a "Build deep index for full coverage" action. Avoids surprise multi-minute serialized CPU spend. (NOT auto for every import.)
- **Q2 — v1 scope = per-document trees only; collection-level "tree of trees" deferred.** `scope_key` column is reserved now (no later migration); the collection root is a thin recursion added as a follow-up after Phase 1.
- **Q3 — Phase 3 extractors = all four record types:** `generic` (salient items), `date`/`amount`, `party` (names/orgs), `obligation` (clauses). Router maps "list every {X} / how many" to the matching `record_type`, defaulting to `generic`.

### Remaining open questions — resolved inline (defaults adopted)
- **Q5 — `TREE_GROUP_TOKENS` scales with context** = `usableInputTokens(contextTokens)` (≈3.2k at 4096, ≈7.2k at 8192), reusing the summary budget math so a group + prompt + output always fits the real window (§4.1).
- **Q6 — Tier 1 returns the stored root verbatim (0 calls);** re-styling to a specific question is an explicit +1 call (§4.5).

### Critical/High audit findings — status
**Fixed in this revision:** C1 (upload-cap rejection), C2 (single `MAX_CHUNKS_PER_DOCUMENT`), C3 (content cache vs node identity), H1/H2 (re-index teardown + warm cache rebuild), H3 (yielding background build), H4/H5 (node-vector search + staleness), H6 (collection-scope v1 behavior), H7 ("list every" honesty + closed-vocab mapping), H8 (symmetric-compare applicability). Medium items M1/M2/M3/M4/M5/M6/M7 are also addressed in the relevant sections; the Low items (L1 lease-free build, L2 breadth≠fidelity wording, L4 sizing, L5 reverse index) remain as noted-but-deferred polish.

### Assumptions (flagging, not silently adopting)
- Level 0 = the existing stored **chunks** (overlapping ~80 tokens); the overlap is harmless for summarization. After §3.5, the chunk set is the **whole** document (over-cap docs are rejected, not truncated), so chunk coverage == document coverage.
- Node embeddings reuse the **active E5 embedder** and the same Float32 blob encoding; node vectors live in `tree_nodes` (+ `summary_cache`), **not** the chunk-PK `embeddings` table, are searched by a dedicated node-cosine helper, and are kept out of chunk retrieval/citations (M2) so they don't dilute citation-grade chunk hits.
- Tree build + extract are **DB-only writers** → they run **lease-free** (no `beginDocumentWork`), like the existing summary task (L1).
- Summaries / cache / extraction records are **content** → DB-only, never logged/audited; audit events stay ids/kinds/counts.
- No new long-context single-shot path; every call stays within 4k–8k (anti-goal respected). Reranker stays a query-time relevance tool, off the ingest hot path.
- Backward compatibility: tree-less documents detected via `tree_status IS NULL` → graceful fallback + explicit offer to build.
