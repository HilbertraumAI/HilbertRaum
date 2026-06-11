# RAG design — Private AI Drive Lite

_Last updated: 2026-06-10 (Phase 21 — hybrid keyword retrieval + reranker, §11)_

This document describes the local document → retrieval-augmented-generation pipeline.
It is built up phase by phase:

- **Phase 4:** ingestion — parse, chunk, store metadata, track status. ✅
- **Phase 5:** embeddings & cosine vector search (mock embedder first). ✅
- **Phase 6:** grounded RAG chat with `[S1]…` citations. ✅
- **Phase 17 (§10):** document-scoped asking + embedder-visibility honesty. ✅
- **Phase 21 (§11):** hybrid keyword + vector retrieval, cross-encoder reranker. ✅

Everything runs **locally and offline** (spec §3.6). No file content, embedding, or query
ever leaves the device.

```
import → extract text → chunk → embed → store vectors → on question: embed query →
cosine top-k ⊕ FTS5 keyword top-k (RRF fusion, §11) → optional rerank (§11) →
grounded prompt with [S1]… labels → local LLM → cited answer → snippets
```

---

## 1. Ingestion pipeline (Phase 4) — spec §7.7

`services/ingestion/` owns the document lifecycle. The statuses are persisted on the
`documents.status` column and surfaced in the Documents screen:

```
queued → extracting → chunking → embedding → indexed
                                   (failed on any error; deleted on removal)
```

As of **Phase 5** the `embedding` step writes one vector per chunk into the `embeddings`
table (see §6). It is still a **pass-through when no embedder is supplied** — a document
then reaches `indexed` with chunks but no vectors — which keeps the Phase-4 callers/tests
valid and lets the real embedder swap in unchanged (Phase 10).

### Steps

1. **Select / expand.** `expandPaths()` turns a user selection into a flat file list:
   folders are walked recursively (supported extensions only); explicitly-picked files are
   always included (an unsupported one surfaces later as `failed`).
2. **Queue.** `createQueuedDocument()` inserts a `documents` row (`status = queued`,
   `original_path`, guessed `mime_type`, `size_bytes`).
3. **Extract.** `processDocument()` copies the original into the workspace
   (`workspace/documents/<id><ext>` → `stored_path`), records `sha256` + `size_bytes`,
   selects a `DocumentParser` by extension, and extracts ordered text **segments**.
4. **Chunk.** `chunkSegments()` splits each segment into overlapping token windows.
5. **Persist.** Old chunks + embeddings (if re-indexing) are removed, new chunks inserted
   into `chunks`.
6. **Embed.** Each chunk's text is embedded and the vector written to `embeddings` (§6).
7. **Indexed.** Final status.

Errors never crash the run: `processDocument` catches anything, writes `failed` +
`error_message`, and returns the document so the UI can show it. A corrupt PDF, an
unsupported type, or a missing source file all land in `failed` gracefully.

### File storage decision

Imported files are **copied into the workspace** (`workspace/documents/`), and both paths
are recorded: `stored_path` (the workspace copy) and `original_path` (where the user picked
it from). Rationale: the spec's privacy ethos wants a **self-contained drive** — pull the
USB stick and every imported document is still present, re-indexable, and independent of the
user's original folders. Re-indexing re-parses the stored copy; delete removes the stored
copy, its chunks/embeddings, and the row (the original is never touched).

### Import execution model decision

Import is **async with polling** (not the chat streaming channel). `importDocuments(paths)`
expands the selection, persists a `queued` row per file, returns the document ids
immediately, then processes files sequentially in the background. The `documents` table is
the source of truth for per-file status (it survives restart); the per-job aggregate
(`ImportJobStatus`: total/completed/failed/done) is held **in memory** and read via
`getImportJob(jobId)`. The Documents screen polls `getImportJob` + `listDocuments` while a
job is in flight. Ingestion progress is coarse-grained, so polling is simpler and more
robust than a token-style stream.

---

## 2. Parsers — spec §9.2 `DocumentParser`

All parsers are **pure-JS** (no native deps), consistent with the `node:sqlite` choice, and
heavy libraries are imported lazily inside `parse()`.

| Format | Parser | Library | Segment granularity | Metadata |
|---|---|---|---|---|
| `.txt`/`.text`/`.log` | `TxtParser` | `node:fs` | whole file = 1 segment | — |
| `.md`/`.markdown`/`.mdown` | `MarkdownParser` | hand-rolled | one segment per ATX heading section | `sectionLabel` = heading text |
| `.pdf` | `PdfParser` | `pdfjs-dist` (legacy build) | one segment per page | `pageNumber` (1-based) |
| `.docx` | `DocxParser` | `mammoth` (raw text) | one segment per paragraph | — |
| `.csv`/`.tsv` | `CsvParser` | `papaparse` | whole table = 1 segment | — (rows → `header: value` lines) |

A parser returns `{ segments: ExtractedSegment[], mimeType }`, where each segment carries its
optional `pageNumber` / `sectionLabel`. The chunker copies that structure onto every chunk it
derives, so a chunk can always cite the page/section it came from.

**PDF note (BUILD_STATE R3):** pdfjs-dist's **legacy** build (`pdfjs-dist/legacy/build/pdf.mjs`)
runs in the Electron/Node main process with **no Web Worker and no DOM** — validated in
Phase 4. The `standardFontDataUrl` warning it logs is harmless (it only affects glyph
*rendering*, not text *extraction*). The parser libs are marked **external** in
`electron.vite.config.ts` (`externalizeDepsPlugin`) so pdfjs's large ESM bundle is
`require`/`import`-ed from `node_modules` at runtime rather than bundled.

---

## 3. Chunking — spec §7.7

`services/ingestion/chunker.ts`. Defaults (`CHUNK_DEFAULTS`):

```
chunk_size_tokens:   500
chunk_overlap_tokens: 80
max_chunks_per_file: 1000
```

- **Token counting is approximate** for the mock phase: one whitespace-delimited word ≈ one
  token (`tokenize` / `approxTokenCount`). Deterministic and dependency-free; a real
  tokenizer can replace it later without changing the chunk metadata shape.
- **Windows.** Within each segment, tokens are split into windows of `size`, advancing by
  `step = size − overlap`. Consecutive windows overlap by `overlap` tokens. `overlap` is
  clamped to `size − 1` so the window always advances. A window that reaches the end of the
  segment stops the segment (no redundant tail chunk).
- **No cross-segment chunks.** Chunking happens *within* a segment, so each chunk inherits
  exactly one `pageNumber` / `sectionLabel`.
- **Cap.** The global chunk count is capped at `max_chunks_per_file`; once hit, remaining
  text is dropped and the document still reaches `indexed`.

### Chunk metadata → storage

Spec §7.7 chunk metadata maps onto the `chunks` table (spec §8) like so:

| Spec field | `chunks` column | Notes |
|---|---|---|
| `chunk_id` | `id` | UUID v4 |
| `document_id` | `document_id` | FK → `documents.id` |
| `source_title` | `source_label` | the document title (file name) |
| `source_path` | — | derivable from `documents.original_path`/`stored_path` |
| `page_number` | `page_number` | from the segment (PDF); null otherwise |
| `section` | `section_label` | from the segment (Markdown); null otherwise |
| `text` | `text` | chunk text |
| `token_count` | `token_count` | approximate (see above) |
| `embedding_model_id` | `embeddings.embedding_model_id` | written in Phase 5 (see §6) |
| `created_at` | `created_at` | ISO-8601 UTC |

The `[S1] [S2] …` retrieval labels are **not** stored here — they are assigned per query at
retrieval time in Phase 6.

---

## 4. IPC surface (Phase 4)

`ipc/registerDocsIpc.ts`, exposed through the preload bridge:

| Command | Shape | Purpose |
|---|---|---|
| `pickDocuments(mode?)` | `'files' \| 'folder'` → `string[]` | OS picker in main (renderer has no dialog access) |
| `importDocuments(paths)` | → `ImportJob { jobId, documentIds }` | queue + background ingest |
| `getImportJob(jobId)` | → `ImportJobStatus` | poll job aggregate |
| `listDocuments()` | → `DocumentInfo[]` | non-deleted docs, newest first, with chunk counts |
| `deleteDocument(id)` | → `void` | remove chunks/embeddings/stored copy/row |
| `reindexDocument(id)` | → `DocumentInfo` | re-parse & re-chunk the stored copy |

---

## 5. Tested behaviour (Phase 4)

- Each parser on a fixture (txt/md/csv on inline files; **real** PDF and DOCX synthesised in
  `tests/helpers/fixtures.ts` so the libraries get genuine offline coverage).
- Chunker: window boundaries, overlap content, no-redundant-tail, per-segment metadata, the
  1000-chunk cap, and overlap clamping.
- Pipeline: txt → `indexed` with a workspace copy + sha256 + chunks; PDF page numbers on
  chunks; **corrupt PDF → `failed` with `error_message` (no crash)**; unsupported type →
  `failed`; re-index replaces chunks without duplication; delete removes everything.
- `expandPaths` folder walking + explicit-file inclusion.

---

## 6. Embeddings & vector search (Phase 5) — spec §6, §7.8, §9.2

`services/embeddings/` owns vectorization + retrieval, behind the same kind of swappable
interface as `ModelRuntime`. Everything runs **locally and offline**: the mock embedder uses only
`node:crypto` (feature hashing), the real `E5Embedder` (Phase 10) talks to a loopback-only
`llama-server --embedding` sidecar, and search is an in-process linear scan over SQLite rows —
no remote vector service, no network.

### `Embedder` interface (spec §9.2)

```ts
interface Embedder {
  readonly id: string          // model-id tag → embeddings.embedding_model_id
  readonly dimensions: number  // fixed output width (384, matches E5-small)
  embed(texts: string[]): Promise<Float32Array[]>  // L2-normalized, one per input, in order
}
```

Vectors are **`Float32Array`** (chosen over `number[][]` so encoding to the BLOB is a direct
byte view and the real GGUF embedder can fill typed arrays without conversion).

### `MockEmbedder` (`mock.ts`)

Deterministic, **hash-based** vectors with zero network and zero model files
(spec mock-first decision). For each text: lowercase + split into alphanumeric word tokens;
SHA-256 each token and scatter it across several **signed buckets** (4 bytes → bucket index
`mod dimensions`, 1 byte → sign) of a fixed-width float array; sum across tokens; finally
**L2-normalize** (so cosine == dot product; empty text → all-zero vector → cosine 0, never
`NaN`). Identical text → byte-identical vector; texts sharing tokens get a higher cosine, which
is enough for ranking sanity in the mock phase. Default width **384** matches the E5-small
manifest (`multilingual-e5-small-q8`, `dimensions: 384`) so the Phase-10 real embedder is a
drop-in swap behind this interface.

### Embedding during ingestion

The ingestion `embedding` step (`processDocument`) takes optional deps
`{ embedder?, embeddingModelId? }`. When an embedder is present it embeds every chunk's text
as a **single batch** (the 1000-chunk-per-file cap bounds the work) and inserts one
`embeddings` row per chunk. The re-index path deletes a document's chunks **and** embeddings
first, so re-embedding (e.g. after an embedding-model change) is clean. Rows are tagged with
the active embedding model id (`settings.activeEmbeddingModelId`), falling back to
`embedder.id` when no model is selected — so a model change is always detectable.

### `embeddings` table (spec §8) + BLOB encoding (LOCKED)

| Column | Notes |
|---|---|
| `chunk_id` | PK, FK → `chunks.id` |
| `embedding_model_id` | active embedding model id, else `embedder.id` |
| `vector_blob` | raw little-endian **Float32 bytes** of the vector |
| `dimensions` | vector width (e.g. 384) |
| `created_at` | ISO-8601 UTC |

- **Encode:** `encodeVector(f32)` = `Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)`.
- **Decode:** `decodeVector(blob, dims)` **copies** the bytes into a fresh, 4-byte-aligned
  buffer before viewing them as `Float32Array` — SQLite blobs can land on an unaligned byte
  offset, which would otherwise throw a `RangeError` (this is tested).

### `VectorIndex` — cosine search

```ts
class VectorIndex {
  search(queryVector: Float32Array, topK): { chunkId, score }[]  // cosine, sorted desc
  searchText(query: string, topK): Promise<{ chunkId, score }[]> // embed query, then search
}
```

MVP = **linear scan**: decode every `embeddings` row, compute cosine similarity to the query
vector, sort descending, take `topK`. Rows whose `dimensions` differ from the query (e.g.
mid-migration) are skipped, not compared. The query is embedded with the **same** embedder, so
a query equal to a chunk's text scores ≈ 1.0 and ranks first. **Upgrade path:** an ANN index
(sqlite-vec / HNSW) behind this same `search` signature when corpora grow.

> Phase 6 consumes `VectorIndex.search` to build the `[S1]…` grounded prompt + citations
> (`askDocuments`). Phase 5 ships retrieval primitives only — no prompt/citation layer yet.

---

## 7. Tested behaviour (Phase 5)

- **Determinism:** same text → byte-identical vector.
- **Vector shape:** width 384 (matches E5-small) and L2 norm ≈ 1; empty text → all-zero
  vector with cosine 0 (no `NaN`); distinct texts have cosine < 1.
- **BLOB round-trip:** Float32 → BLOB → Float32 is exact, **including from an unaligned blob
  offset**.
- **Ranking sanity:** a query equal to a chunk's text ranks that chunk first (score ≈ 1),
  results are sorted descending, `topK` is honoured, and mismatched-dimension vectors are
  ignored.
- **Ingestion:** `processDocument` writes one embedding per chunk tagged with the active
  model id (or `embedder.id` fallback) with correct `dimensions`; with no embedder the step is
  a pass-through (no vectors).
- **Offline guarantee (spec Milestone 5):** spying on `http`/`https`/`net.connect`/
  `Socket.prototype.connect`/`fetch` shows **zero** network calls across embed + full
  ingestion + search.

---

## 8. Grounded RAG chat with citations (Phase 6) — spec §7.6, §7.8, Milestone 6

`services/rag/` turns a question into a **grounded, cited answer**. It reuses the Phase-5
retrieval primitives (`Embedder` + `VectorIndex`) and the Phase-3 chat plumbing
(`appendMessage`, the streaming contract) — nothing new touches the network.

```
question → retrieve() → buildGroundedPrompt() → runtime.chatStream() → answer + Citation[]
```

### Retrieval (`retrieve`)

`retrieve(db, embedder, question, settings)`:

1. embeds the question and runs `VectorIndex.searchText(question, topKInitial)` (default
   **top_k_initial = 12**),
2. joins each hit back to its `chunks` row for `text` / `source_label` (= title) /
   `page_number` / `section_label`,
3. drops hits below **min_similarity_threshold** (`ragMinSimilarity`, default 0),
4. **dedups by document/page** — keeps the best-scoring chunk per `(document_id, page)`.
   Page-less chunks (txt/md windows) are keyed by chunk id, so they are never collapsed,
5. trims to **top_k_final = 6** while respecting **max_context_tokens = 2500** (the
   chunker's `approxTokenCount`). The single most relevant chunk is always included so an
   over-budget top chunk never produces an empty context,
6. assigns `[S1] [S2] …` labels **per query** (never stored) and resolves a `Citation[]`.

Returns both the labelled `RetrievedChunk[]` (for the prompt) and the `Citation[]` (for
persistence + UI). Each `Citation` carries a truncated `snippet` (≤ `SNIPPET_MAX_CHARS`,
600) of the chunk text so the renderer's source-snippet panel can show what was cited
without a second lookup.

### Grounded prompt (`buildGroundedPrompt`)

A pure function emitting the spec §7.8 template verbatim — the rules, the `Question:`, then
the numbered `Document excerpts:` in the spec's source-context format:

```text
[S1] File: Contract.pdf | Page: 4
"...chunk text..."

[S2] File: Terms.docx | Section: Liability
"...chunk text..."
```

The meta line is `| Page: N` when the chunk has a page, else `| Section: X`, else nothing.
`buildGroundedChatMessages` then assembles the runtime message list: the base system prompt
(spec §7.6), prior conversation history, and the **last user turn replaced by the grounded
prompt**. The DB keeps the raw question for the transcript/title; only the model sees the
grounded form.

### Answer generation (`generateGroundedAnswer`) + `askDocuments` IPC

`generateGroundedAnswer` retrieves context, streams the answer from the runtime, and
persists the assistant turn **with its `Citation[]`** (→ `messages.citations_json`).
Retrieval is the **source of truth for citations** — the mock runtime's echo contains no
real `[Sn]` markers, so we persist the computed citations directly (a real model that emits
`[Sn]` inline still renders against this same list).

`ipc/registerRagIpc.ts` exposes `askDocuments(conversationId, question)`. It is the
document-grounded sibling of `sendChatMessage` and **reuses the locked Phase-3 streaming
contract** (`chat:token/done/error:<conversationId>`), so the renderer subscribes
identically. It requires a running runtime (same "start a model" error as chat), appends
the user turn, sets the title from the first message, then calls `generateGroundedAnswer`.
Cancellation uses a **shared in-flight registry** (`ipc/inflight.ts`) so the existing
`stopGeneration(conversationId)` cancels a document answer too.

### Grounding rule — empty corpus / weak retrieval (spec §7.8)

When retrieval yields **no usable chunks** (no documents indexed, or every hit below the
threshold), the model is **not called** — `generateGroundedAnswer` persists a fixed answer
(`NO_DOCUMENT_CONTEXT_ANSWER`: *"I couldn't find anything about that in your documents…"*)
with no citations. This makes the no-hallucination guarantee deterministic and testable
rather than relying on the model to refuse. Phase 17 adds an actionable variant
(`REINDEX_NEEDED_ANSWER`) when the whole corpus is invisible to the active embedder — see §10.

### Settings (spec §7.8 defaults)

Retrieval knobs live on `AppSettings` / `DEFAULT_SETTINGS` and are read per request via
`ragSettingsFrom`: `ragTopKInitial` (12), `ragTopKFinal` (6), `ragMaxContextTokens` (2500),
`ragMinSimilarity` (0).

### Renderer

`ChatScreen` gains a **Chat / Ask Documents** mode toggle. The mode is fixed per
conversation (its `mode` field); the toggle picks the mode for the next new conversation and
syncs when a conversation is selected. Document answers call `askDocuments`; each assistant
message renders a **Sources** panel listing its citations (`[Sn] File · Page/Section`) with
an expandable snippet of the cited chunk text. The plain chat path is unchanged.

---

## 9. Tested behaviour (Phase 6)

- **Grounded prompt:** spec §7.8 template shape (rules, `Question:`, numbered excerpts), the
  `[Sn] File: X | Page: 4` / `| Section: Y` source format, the page→section→none meta
  fallback, and the trailing `Answer:`.
- **Retrieval:** returns the matching chunk for a question (`MockEmbedder`) with resolved
  citations + snippet; sequential `[Sn]` labelling in score order; **dedup by
  document/page**; **top_k_final + max_context_tokens** trimming; min-similarity filtering.
- **Answer generation:** streams tokens and **persists citations to `citations_json`**
  (round-trips on reload); the **empty-corpus path** returns the fixed "not found" answer
  **without calling the runtime**.
- **Offline guarantee:** spying `http`/`https`/`net.connect`/`Socket.prototype.connect`/
  `fetch` shows **zero** network calls across ingestion + retrieval + grounded answer.

---

## 10. Document-scoped asking & embedder-visibility honesty (Phase 17)

Plan: [`post-mvp-functionality-plan.md`](post-mvp-functionality-plan.md) §5. Adds three
RAG-trust features on top of the Phase-6 design; the grounded path's no-hallucination
guarantee (model never called without context) is unchanged.

### "Ask selected documents" (spec §10.4)

- **`VectorIndexOptions.documentIds`** — when non-empty, the cosine scan is restricted to
  vectors whose chunk belongs to those documents (`chunk_id IN (SELECT id FROM chunks WHERE
  document_id IN (…))`, placeholders only). Composes with the Phase-10 `embeddingModelId`
  filter; empty/absent = whole corpus (existing callers unchanged).
- **Scope lives on the conversation** — additive nullable `conversations.scope_json` column
  (a JSON array of document ids; guarded `ALTER TABLE` migration in `db.ts`, decision D2).
  `Conversation.scopeDocumentIds` round-trips it; `createConversation` accepts it;
  `updateConversationScope` (IPC `chat:updateScope`) replaces/clears it. Malformed stored
  JSON reads back as null (unscoped), never throws.
- **Threading:** `retrieve(db, embedder, question, settings, scopeDocumentIds?)`;
  `generateGroundedAnswer` takes `opts.scopeDocumentIds`; `askDocuments` reads the
  conversation's persisted scope — callers pass nothing per-request.
- **Renderer:** Documents screen gets per-row checkboxes (indexed docs only) + **Ask these
  documents (N)** → Chat opens in documents mode with the selection as the next
  conversation's scope; removable **scope chips** above the composer show the active scope
  (existing conversations persist chip removal via `updateConversationScope`).

### Filename auto-scope (post-MVP UX fix)

Document retrieval is corpus-wide by default — the question text is only ever a
semantic/keyword query, so "analyze contract.pdf" runs hybrid search over **all** indexed
documents and the top-K can include weakly-related chunks from other files (generic words
like "analyze"/"summary" even inflate other docs' keyword rank). Users reasonably read
naming a file as "use only that file", so other files showing up as sources reads as a bug.

- **`detectFilenameScope(question, docs)`** (`services/rag/scope.ts`, pure + unit-tested):
  a document matches when its filename — the full title or its extension-stripped stem,
  each normalized to lowercase alphanumeric tokens — appears in the normalized question as a
  **whole token run** (space-delimited both sides, so "contractual" ≠ "contract"). Lone
  generic words (`document`, `file`, `pdf`, …) never trigger on their own; a question that
  would match the **entire** corpus narrows nothing and is treated as no match.
- **Applied only when there is no explicit scope** — `askDocuments` runs the detector over
  the indexed documents *just* for a conversation whose `scopeDocumentIds` is null/empty, and
  uses the result as the per-request `scopeDocumentIds`. It can only ever **narrow**, never
  widen; an explicit "ask selected documents" scope always wins and is left untouched.
- **Visible + honest:** when it fires, the main process emits a one-shot, non-persisted
  `STREAM.scope` notice (`api.onScopeNotice`) and Chat shows an *"Answering from contract.pdf
  only"* toast, so a wrong guess is obvious and the user can rephrase or set scope manually.

### Plain-chat document awareness (plan §5.1)

While ≥ 1 indexed document exists, plain Chat shows a dismissible per-conversation notice
("answers don't use your imported documents") with a one-click **Ask Documents instead**
switch — the guard against the wrong-tab hallucination found in the first real-drive test
(BUILD_STATE §9). The mode tabs carry subtitles ("General assistant" / "Answers from your
files, with sources"). Renderer-only; dismissals are per-conversation, in-memory.

### Embedder-visibility honesty (plan §5.2)

- **Vectors are tagged with the id of the embedder that produced them.** `registerDocsIpc`
  no longer passes `settings.activeEmbeddingModelId` into ingestion — with the E5 manifest
  selected but the mock embedder active (no binary), that tag stamped mock vectors with the
  E5 id, hiding them from mock-scoped search now and poisoning E5-scoped search later. Tag
  and search scope both come from `embedder.id`.
- **`REINDEX_NEEDED_ANSWER`** — when retrieval is empty AND `corpusNeedsReindex` (some
  indexed document has chunks but no document has any vector under the active embedder),
  the fixed answer tells the user to re-index instead of to rephrase. Still no model call.
- **Re-index all** — the Documents screen offers a one-click sequential re-index of every
  stale document (the per-document stale badge shipped in the earlier polish round).

### Tested behaviour (Phase 17)

`tests/integration/rag-scope.test.ts` (scoped index/retrieve/answer, the reindex-needed
variant, scope persistence + the pre-Phase-17 column migration), `chat-ipc.test.ts` (scope
over IPC), `tests/renderer/ChatHomeNav.test.tsx` (notice, chips, pending-scope handoff),
`tests/renderer/DocumentsScreen.test.tsx` (selection → `onAskSelected`, Re-index all).

---

## 11. Hybrid retrieval + reranker (Phase 21)

Working paper / decisions D8–D15: [`retrieval-quality-plan.md`](retrieval-quality-plan.md)
(research-gated like the GPU plan: the rerank endpoint shapes were verified against the
pinned llama.cpp b9585 SOURCE, FTS5 availability was probed in BOTH runtimes). The
grounding guard is untouched: empty retrieval still never calls the model.

### The pipeline as rebuilt (`retrieve()`, plan §3)

```
1. embed question → cosine topKInitial      (scoped: embedder id + documentIds)
2. drop vector hits < minSimilarity         (cosine floor, PRE-fusion/PRE-rerank — D12)
3. FTS5 keyword search topKInitial          (scoped: documentIds + visibility join, §5.4)
4. RRF fusion (k = 60)                      (rank-based; scales never mix)
5. join → chunks rows
6. rerank when a reranker is active         (reorder by relevance_score; failure ⇒ fused order)
7. dedup by (document_id, page)             (unchanged)
8. topKFinal + maxContextTokens             (unchanged)
9. [S1]… labels per query                   (unchanged, never stored)
```

**Pass-through guarantee:** no reranker + no keyword hits ⇒ byte-identical to the
pre-Phase-21 result (ordering and scores). `RetrievedChunk.score` is stage-dependent:
cosine for vector candidates, RRF score for keyword-only candidates, the reranker's
relevance logit after a rerank. Citations never persist scores (locked).

### Keyword index (`chunks_fts`, plan §5)

Self-contained FTS5 table `fts5(text, chunk_id UNINDEXED)` — NOT external-content on
`chunks`' implicit rowid (VACUUM may renumber implicit rowids and would silently desync
the index; the duplicated text lives in the same workspace DB, encrypted at rest with
it). Synced by three triggers on `chunks` (insert/delete/update-of-text), so
ingest/re-index/delete can never miss it; created + backfilled by a guarded additive
migration in `openDatabase` (the `scope_json` precedent). Questions are sanitized into
`MATCH` queries in JS (quoted phrase tokens OR-ed, capped at 32 — FTS5 operator syntax
in user text never reaches MATCH raw); ranking is `bm25()`.

**Embedder-visibility rule (the §10 honesty story, reconciled):** keyword hits are
restricted to chunks that have a vector under the ACTIVE embedder. Hybrid search can
never see more documents than vector search could, so an invisible corpus still yields
empty retrieval ⇒ `REINDEX_NEEDED_ANSWER` (tested, incl. a lexically-matching invisible
corpus).

### Reranker (`services/reranker/`, plan §4)

`bge-reranker-v2-m3` (Apache-2.0; F16 GGUF — q8_0 of the XLM-R family crashes b9585,
the recorded E5 lesson) behind the `Reranker` interface. `LlamaReranker` is the third
`LlamaServer` composition: same b9585 binary, `--rerank --device none` (CPU pin; chat
args never reach it), lazy start on first `rerank()`, `/v1/rerank` Jina shape
(`{ query, documents }` → `results: [{ index, relevance_score }]`, mapped back by
`index`). Inputs are word-truncated (query ≤ 160, doc ≤ 320) to bound CPU latency.
The sidecar also passes `--batch-size`/`--ubatch-size` = the context (2048): in
`--rerank`/embedding mode llama-server forces `n_batch = n_ubatch` and defaults them to
**512**, but a query+document rerank input runs ~670 tokens and would otherwise HTTP-500
the whole request on real-length chunks (found by `PAID_RERANK_SMOKE`; retrieval-plan §1.1).
Selection is availability-driven (`createSelectedReranker` → real iff binary + GGUF,
else **null**; no mock — null = today's ordering). Failure modes: a failed START latches
for the session (fail-fast, no 60 s health stall per question); a failed CALL logs and
keeps the fused order. Stopped on `will-quit`; `suspend()`ed on workspace lock (lazy
restart allowed — the same fix gave the E5 embedder a working post-lock restart).

No new `AppSettings` keys, no UI surface (D14 — the embedder precedent); the manifest
(`model-manifests/reranker/bge-reranker-v2-m3.yaml`) carries a `download` block, so the
Phase-18 in-app downloader covers it. `ragMinSimilarity` keeps its meaning (cosine,
pre-rerank); its default is **measured and stays 0** — on the real drive the relevant and
irrelevant best-chunk cosine distributions OVERLAP (E5 runs without query:/passage: prefixes
→ everything lands in a narrow ~0.87–0.94 band), so no positive floor separates them without
dropping real hits (plan §1.3; `tests/manual/minsim-measure.test.ts`). Relevance separation
is the reranker's job, not the floor's.

### Tested behaviour (Phase 21)

`tests/integration/reranker.test.ts` (spawn args incl. no-chat-args, index mapping,
truncation, failed-start latch, stop/suspend, selector), `hybrid-search.test.ts`
(migration + backfill + trigger sync, MATCH sanitization, visibility + scope, RRF,
retrieve() e2e with a fake reranker, both grounding-guard variants),
`e5-embedder.test.ts` (suspend), `drive.test.ts` (`models/reranker`). Manual:
`tests/manual/rerank-smoke.test.ts` behind `PAID_RERANK_SMOKE` — **run 2026-06-10** on the
real F16 GGUF + b9585: loads clean, ranks the relevant doc first (+8.82 vs −11.01), and the
worst-case 12-candidate batch took **≈ 24.7 s** on a CPU-pinned i7-1185G7 (the §7 number;
also the regression that surfaced the n_ubatch=512 fix above).
