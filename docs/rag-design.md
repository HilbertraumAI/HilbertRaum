# RAG design — HilbertRaum

_Last updated: 2026-06-15 (whole-document-analysis closeout: the four-phase plan condensed into the §14 design record; Phases 1–4 shipped — summary tree, coverage meter, extract-then-aggregate, symmetric compare). Prior: 2026-06-12 docs housekeeping — Phase-17 record into §10, Phase-21 design record as §12._

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

- **Token counting is approximate** but must never UNDER-count: `approxTokenCount` counts an
  ordinary whitespace word as ~1 token, a space-less-script character (CJK/Thai/…) as ~1
  token, and an over-long no-space run as `ceil(len / 4)` — so a glued run can't collapse to
  one token. (A plain whitespace count did exactly that, letting space-less documents overflow
  the model context — `HTTP 400 exceed_context_size_error` — across the whole doc-analysis
  path; fixed 2026-06-14.) Deterministic and dependency-free; a real tokenizer can still
  replace it without changing the chunk-metadata shape.
- **Windows.** `windowByTokens` splits a segment into windows of `size` approx tokens,
  overlapping by `overlap` (clamped to `size − 1`); a window that reaches the segment end
  stops it (no redundant tail chunk). A space-less run with no word breaks is hard-cut by
  character so a window is never larger than the budget — content is preserved (pieces are
  raw substrings). The same windower backs the summary/translation/compare planners and the
  `truncateToApproxTokens` budget clamp.
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
| `embedding_model_id` | `embeddings.embedding_model_id` | written by the embedding step (see §6) |
| `created_at` | `created_at` | ISO-8601 UTC |

The `[S1] [S2] …` retrieval labels are **not** stored here — they are assigned per query at
retrieval time.

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

This is the Phase-17 design record (the wave-1 working paper was folded into the topic
docs, 2026-06-12 housekeeping; full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`).
Adds three RAG-trust features on top of the Phase-6 design; the grounded path's
no-hallucination guarantee (model never called without context) is unchanged. Decisions:
**D1** — keep the two chat modes + the plain-chat awareness notice. Originally deferred
"pending Phase-21 quality data"; **re-affirmed 2026-06-12 with that data in hand**: the
measured floor result (§12.1 R3) proves there is no cheap "is this question about the
documents?" signal under prefix-less E5 (relevant and irrelevant cosines overlap), the only
reliable gate is the *optional* reranker at up to ~25 s worst-case on CPU — unacceptable
per plain-chat message — and the original wrong-tab failure is already triple-defended
(awareness notice, mode subtitles, filename auto-scope). **Revisit trigger: Phase 30
Track B** — if a prefix-using embedder lands with a measurable relevance floor,
auto-grounding becomes cheap to gate and D1 gets re-evaluated (rider recorded in
`big-slot-embeddings-plan.md` §4.4).
**D2** — the scope persists as the additive nullable
`conversations.scope_json` column (guarded `ALTER TABLE`).

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

### Plain-chat document awareness

While ≥ 1 indexed document exists, plain Chat shows a dismissible per-conversation notice
("answers don't use your imported documents") with a one-click **Ask Documents instead**
switch — the guard against the wrong-tab hallucination found in the first real-drive test
(BUILD_STATE §9). The mode tabs carry subtitles ("General assistant" / "Answers from your
files, with sources"). Renderer-only; dismissals are per-conversation, in-memory.

### Embedder-visibility honesty (the mock→E5 trap)

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

Decisions D8–D15 + the research record live in **§12** below
(research-gated like the GPU plan: the rerank endpoint shapes were verified against the
pinned llama.cpp b9585 SOURCE, FTS5 availability was probed in BOTH runtimes). The
grounding guard is untouched: empty retrieval still never calls the model.

### The pipeline as rebuilt (`retrieve()`)

```
1. embed question → cosine topKInitial      (scoped: embedder id + documentIds)
2. drop vector hits < minSimilarity         (cosine floor, PRE-fusion/PRE-rerank — D12)
3. FTS5 keyword search topKInitial          (scoped: documentIds + visibility join)
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

### Keyword index (`chunks_fts`)

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

### Reranker (`services/reranker/`)

`bge-reranker-v2-m3` (Apache-2.0; F16 GGUF — q8_0 of the XLM-R family crashes b9585,
the recorded E5 lesson) behind the `Reranker` interface. `LlamaReranker` is the third
`LlamaServer` composition: same b9585 binary, `--rerank --device none` (CPU pin; chat
args never reach it), lazy start on first `rerank()`, `/v1/rerank` Jina shape
(`{ query, documents }` → `results: [{ index, relevance_score }]`, mapped back by
`index`). Inputs are word-truncated (query ≤ 160, doc ≤ 320) to bound CPU latency.
The sidecar also passes `--batch-size`/`--ubatch-size` = the context (2048): in
`--rerank`/embedding mode llama-server forces `n_batch = n_ubatch` and defaults them to
**512**, but a query+document rerank input runs ~670 tokens and would otherwise HTTP-500
the whole request on real-length chunks (found by `HILBERTRAUM_RERANK_SMOKE`; §12.1 R1).
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
dropping real hits (§12.1 R3; `tests/manual/minsim-measure.test.ts`). Relevance separation
is the reranker's job, not the floor's.

### Tested behaviour (Phase 21)

`tests/integration/reranker.test.ts` (spawn args incl. no-chat-args, index mapping,
truncation, failed-start latch, stop/suspend, selector), `hybrid-search.test.ts`
(migration + backfill + trigger sync, MATCH sanitization, visibility + scope, RRF,
retrieve() e2e with a fake reranker, both grounding-guard variants),
`e5-embedder.test.ts` (suspend), `drive.test.ts` (`models/reranker`). Manual:
`tests/manual/rerank-smoke.test.ts` behind `HILBERTRAUM_RERANK_SMOKE` — **run 2026-06-10** on the
real F16 GGUF + b9585: loads clean, ranks the relevant doc first (+8.82 vs −11.01), and the
worst-case 12-candidate batch took **≈ 24.7 s** on a CPU-pinned i7-1185G7 (the §7 number;
also the regression that surfaced the n_ubatch=512 fix above).

---

## 12. Phase-21 design record — research evidence, decisions, budgets

_Formerly `docs/retrieval-quality-plan.md` (folded in here, 2026-06-12 docs housekeeping;
the full working paper is in git history: `git show b8feb46:docs/retrieval-quality-plan.md`).
The design **as built** is §11 above; this section keeps the research facts the design rests
on, the decision table D8–D15, and the load-bearing budgets. Out of scope, unchanged:
unified auto-RAG chat (decision D1 — re-affirmed 2026-06-12, revisit trigger = Phase 30
Track B; see §10), deep-grounded answers, ANN (D15), signed update bundles (Phase 22)._

### 12.1 Research findings (verified 2026-06-10)

**R1 — the b9585 rerank endpoint (verified from the pinned tag's SOURCE):**

- **Routes:** `POST /rerank`, `/reranking`, `/v1/rerank`, `/v1/reranking` → one handler
  (`tools/server/server.cpp` L201–204).
- **Flag:** `--rerank` (alias `--reranking`) sets `params.embedding = true` **and**
  `pooling_type = LLAMA_POOLING_TYPE_RANK` (`common/arg.cpp` L2964–2971) — the one flag
  is the whole switch; the handler refuses otherwise (`server-context.cpp` L4594–4597).
- **Request** (`server-context.cpp` L4600–4641): `{ query: string, documents: string[],
  top_n? }` (alias `texts` = TEI format; we use the Jina format). One internal task per
  document.
- **Prompting** (`server-common.cpp` L1540–1582): a GGUF-embedded `rerank` chat template
  if present, else **`BOS query EOS SEP document EOS`** — the BERT-style default path
  bge-reranker-v2-m3 uses (no template needed).
- **DEVIATION found by `HILBERTRAUM_RERANK_SMOKE` (2026-06-10):** in `--rerank`/embedding mode
  the server **forces `n_batch = n_ubatch`** and they default to **512** ("embeddings
  enabled with n_batch (2048) > n_ubatch (512) … setting n_batch = n_ubatch = 512"). A
  rerank input is query+document in ONE sequence — at the §12.3 word caps ≈ 670 real
  tokens — so the 512 default makes the server **HTTP 500 the whole request**, which would
  silently drop every rerank pass back to the fused order on real-length chunks. **Fix:**
  the reranker sidecar passes `--batch-size`/`--ubatch-size` = the context (2048) so any
  in-context input decodes in one ubatch (`services/reranker/llama.ts`; locked by
  `reranker.test.ts`).
- **Response** (`server-common.cpp` L1213–1258; per-task `server-task.cpp` L1867–1873):
  `{ model, object: "list", usage, results: [{ index, relevance_score }] }` sorted by
  score **desc**, truncated to `top_n`; results map to inputs by `index`, not order.
  **`relevance_score` is an unbounded logit** — never a cosine (→ D12).

**R2 — FTS5 in `node:sqlite` (GO):** probed 2026-06-10 in BOTH runtimes that matter —
**Electron 37.10.3 main process** (Node 22.21.1, probed INSIDE Electron, the Phase-1
precedent) and **system Node 24.13.0** (what vitest runs under). Both: SQLite **3.50.4**
with `ENABLE_FTS5`; virtual table + `MATCH` + `bm25()` all work. No native dependency.

**R3 — similarity floor (MEASURED 2026-06-10 → keep 0):** measured on the real `D:\` drive
(`tests/manual/minsim-measure.test.ts`, `HILBERTRAUM_MINSIM_MEASURE`): a topically-diverse
12-passage corpus, 12 RELEVANT queries (answerable) vs 12 IRRELEVANT ones (absent topics),
embedded through the EXACT production path (real multilingual-E5, no `query:`/`passage:`
prefix, the same `cosineSimilarity` `VectorIndex` uses). Best-chunk cosine per query:

| class | min | median | mean | max |
|---|---|---|---|---|
| relevant (n=12) | 0.8790 | 0.9018 | 0.9033 | 0.9352 |
| irrelevant (n=12) | 0.8658 | 0.8937 | 0.8909 | 0.9065 |

The classes **OVERLAP by 0.0276** (irrelevant.max 0.9065 > relevant.min 0.8790). Because
E5 runs WITHOUT its prefixes, every cosine compresses into a narrow ~0.87–0.94 band, so
**no positive floor separates relevant from irrelevant without dropping real hits** (a 0.89
floor would discard 4/12 relevant queries yet still admit most irrelevant ones — strictly
harmful: a dropped real hit means an empty/"not in your documents" answer, the worst
failure). **Decision: `ragMinSimilarity` stays 0** — empirically confirmed, not merely
deferred. Relevance separation is delegated to the reranker (clean +8.82 vs −11.01, §12.3)
and RRF, not the cosine floor. *Latent improvement (not done — it would require
re-embedding the whole corpus): adding the E5 `query:`/`passage:` prefixes would likely
spread the distribution and make a floor meaningful; revisit only with a prefix migration.*

### 12.2 Decisions (D8–D15, continuing the wave-1 table at D8)

| # | Decision | Resolution |
|---|---|---|
| D8 | Reranker model + license | **bge-reranker-v2-m3** (Apache-2.0 base, HF-API-verified 2026-06-10) — GGUF `gpustack/bge-reranker-v2-m3-GGUF` `bge-reranker-v2-m3-FP16.gguf` (1 159 776 896 B). **FP16, not q8_0** (the recorded b9585 XLM-R q8_0 warmup crash, BUILD_STATE §9). Qwen3-Reranker-0.6B rejected: no official GGUF (HF 401), template-path dependency, slower causal arch. Manifest `role: reranker` with `download` block + approved `license_review` |
| D9 | Sidecar lifecycle | Third **`LlamaServer` composition** (E5 pattern): `--rerank --device none` (CPU pin), lazy start, `stop()` on will-quit / `suspend()` on lock, NO chat args. **Factory default = `null`** (not a mock) ⇒ retrieval byte-identical (graceful-fallback rule). Query-time failure ⇒ log + fused order; start failure ⇒ session latch |
| D10 | Resource budget (8 GB) | ~1.3 GB RSS when active; lazy + opt-in-by-provisioning + CPU-pinned ⇒ 8 GB worst case ≈ 5.3 GB. NOT bundled for TINY. Latency bounded by candidate cap + word truncation (q ≤ 160, doc ≤ 320); real numbers in §12.3 |
| D11 | Rerank placement + topKInitial | Between fusion and dedup — dedup keeps the best-by-rerank chunk per page. **`topKInitial` does NOT rise** when a reranker is active (CPU latency linear in candidates; the fused union already reaches ≤ 2×topKInitial; the settings knob remains for tuning) |
| D12 | `minSimilarity` pre- vs post-rerank | **PRE-rerank, cosine-only** (status quo site + meaning): applied to vector hits before fusion. Rerank `relevance_score` is an unbounded logit — never compared to the floor. Keyword hits carry no cosine and bypass the floor by design. R3 measured ⇒ default stays 0 |
| D13 | FTS index shape + sync + fusion | Self-contained `fts5(text, chunk_id UNINDEXED)` (NOT external-content on the implicit rowid — VACUUM foot-gun); 3 sync triggers; guarded additive migration + backfill (scope_json precedent). Fusion = **RRF, k = 60**, sanitized phrase-OR MATCH. **Visibility rule: keyword hits require a vector under the active embedder** — `REINDEX_NEEDED_ANSWER` semantics intact |
| D14 | Settings surface | **Availability-driven (embedder precedent): no new `AppSettings` keys, no toggle, no UI.** Hybrid always-on (pure SQLite); reranker active iff binary + weights present; the Phase-18 downloader covers the GGUF |
| D15 | ANN index | **NOT built** (evidence rule): sqlite-vec/HNSW are native deps against the project theme; no measured corpus outgrows the linear scan. `VectorIndex.search` stays the upgrade path |

### 12.3 Resource budget (8 GB machines) + measured validation

Reranker ≈ **1.3 GB RSS** when active (F16 1.08 GiB + ctx 2048); worst case alongside
4B chat (~2.6 GB) + E5 (~0.35 GB) + Electron (~1 GB) ≈ 5.3 GB — workable because the
reranker is lazy, CPU-pinned, and opt-in by provisioning (never bundled; manifest
`recommended_min_ram_gb: 6`, profiles LITE/BALANCED/PRO). CPU latency bounded by the
candidate cap (≤ 2×topKInitial) + word truncation.

**Measured 2026-06-10 (`HILBERTRAUM_RERANK_SMOKE`, real F16 GGUF on b9585, Intel i7-1185G7,
`--device none`, 4 threads):** the F16 GGUF LOADS clean (no q8_0 XLM-R warmup crash);
relevance is correct (relevant invoice line **+8.82** vs irrelevant **−11.01**);
**worst-case latency ≈ 24.7 s** for a 12-candidate batch at the full truncation budget
(160-word query + 320-word docs, ~670 tokens/input). That worst case is ~2 s/candidate —
significant on a CPU pin, so reranking visibly lengthens a documents query on a low-end
laptop; the candidate cap keeps it bounded, and it stays opt-in by provisioning.
Tightening `MAX_DOC_WORDS` / the candidate cap is the lever if the latency proves too high.

**End-to-end quality validation 2026-06-10 (`HILBERTRAUM_RAG_QUALITY`, all three real backends on
a 4-doc corpus — `tests/manual/rag-quality.test.ts`):** the evidence the reranker EARNS its
cost. For "What is the cap on liability in our agreement with Acme?" the hybrid (vector+RRF)
order put the true *Limitation of liability* clause only **#3 (cosine 0.848)** — behind two
unrelated chunks (an invoice 0.875; an encryption clause 0.870), the exact prefix-less-E5
compression R3 found. With the reranker ON the liability clause jumped to **#1 (logit
−1.88)** and all four contract clauses took the top 4 with a clean gap; the grounded 4B
answer was correct + cited ("one million United States dollars … [S1]" → the MSA). A
keyword-exact query (`INV-2024-001`) surfaced the exact invoice chunk at #1 via FTS5. ⇒ on
this prefix-less-E5 setup the reranker is not marginal polish — it rescued the correct
answer from #3-behind-distractors to #1; the ~25 s worst-case cost buys real correctness.

Gate at ship: typecheck clean, 601 tests, build green; phase commit `b8feb46`.

## 13. Collection-scoped retrieval & composite scope — design record (document organization, Phases A–F)

_The retrieval/scope half of the document-organization layer. The **data model, IPC, audit, and
filing-suggestion engine** are in [`architecture.md`](architecture.md) "Document organization — design
record" (§1–§8); this section is **how a chat's chosen sources become a retrieval filter**. Condensed
from `docs/document-organization-plan.md` at the Phase-F closeout (2026-06-14); full original:
`git show 477f803:docs/document-organization-plan.md`. **§13.x anchors are stable.**_

### 13.1 The scope model (D1 — a union of selected sources)

A documents-chat's scope is a **UNION** the user composes from any mix of the whole **Library**, one or
more **project** folders, and **specific documents** — not one anchor. It is persisted per conversation
in `conversations.scope_v2_json` as a `DocumentScope` (`{ collectionIds, documentIds, includeArchived? }`);
an **empty** scope (both arrays empty) is the explicit **"All documents"** choice (whole corpus). This
supersedes the original single-`collection_id` anchor (kept only as the creation anchor + a legacy
fallback). Tolerant parse → NULL falls back to the legacy interpretation, never throws.

### 13.2 `resolveScope(db, conversationId) ⇒ RetrievalScope` (`collections.ts`)

Pure (reads only). Resolution order:
1. `scope_v2_json` present ⇒ authoritative composite scope (`collectionIds` ∪ `documentIds`).
2. else legacy fallback: non-empty `scope_json` ⇒ explicit specific-doc scope; else `collection_id` ⇒
   that project; else the **Library** default (documents-mode default).
3. **chat attachments** (`conversation_documents`, C3) are **always** merged into `documentIds` — a file
   dropped into the chat is answerable regardless of the rest of the scope, and the link (not Temporary
   membership) is authoritative, so a later "Keep in Library" doesn't drop it from its chat.

`hasExplicitDocSelection` is set from the user's **hand-picked** docs **before** attachments/expansion
are merged (N2), so filename auto-scope can tell a deliberate pick from an attachment. Result:
`RetrievalScope { documentIds?, collectionIds?, includeArchived?, hasExplicitDocSelection? }`.

### 13.3 Threading scope into retrieval (H3 — arg-5 union, no caller churn)

`retrieve()`'s parameter 5 is widened to `string[] | RetrievalScope | null` and **normalized
internally** (`Array.isArray(scope) || scope == null ? { documentIds: scope ?? null } : scope`), so
**every existing positional `scopeDocumentIds` caller and test stays valid byte-for-byte**;
`generateGroundedAnswer` gains `opts.scope` and forwards it. The membership filter is pushed into SQL
as an **EXISTS/IN disjunction** (index-backed by `idx_doccoll_*`), not a materialized `IN (…thousands…)`:

```sql
AND embeddings.chunk_id IN (
  SELECT c.id FROM chunks c WHERE (
    EXISTS (SELECT 1 FROM document_collections dc                 -- membership branch
            WHERE dc.document_id = c.document_id AND dc.collection_id IN (…collectionIds…))
    OR c.document_id IN (…documentIds…))                          -- explicit-doc branch, UNIONed in
  AND NOT EXISTS (SELECT 1 FROM documents d                       -- C1: doc-level archive only
                  WHERE d.id = c.document_id AND d.lifecycle = 'archived'))
```

`keywordSearchChunks` (FTS5) attaches the analogous predicate to its existing `chunks c` join. A
document is in scope when it is a member of any `collectionIds` entry **OR** its id is in `documentIds`
(a UNION, D1 — not a short-circuit). Empty both ⇒ no filter = "All documents".

### 13.4 What scoping does and does NOT exclude

- **Archive is document-level only (C1).** `includeArchived=false` (default) adds a single
  `lifecycle != 'archived'` predicate to the whole union. Archiving a *project* only removes it as a
  selectable source; a member also reachable via Library/another project stays answerable.
- **Generated docs are excluded structurally (D3/N1).** They carry **no membership**, so a
  `collectionIds` expansion never reaches them — no `role='generated'` predicate exists. They are
  answerable only when their specific id is hand-added to `documentIds`.
- **Temporary is not a pickable bulk source** (N10); **Generated is not a source** (D3) — both are
  reached only via "Specific documents…" or (for temp) their own chat attachment.

### 13.5 Filename auto-scope within the resolved scope (N2/N13)

`detectFilenameScope` now runs over the **documents visible in the resolved scope** (a bounded
`id,title` projection — no vectors loaded), not the whole corpus. It is skipped **only** when
`hasExplicitDocSelection` is true (a deliberate hand-pick). Multiple in-scope matches ⇒ scope to *all*
matches + a disambiguation notice on the existing `STREAM.scope` channel — never a silent guess.
Note (RAG-4): the flag is union-wide — **one** hand-picked doc in a composite scope
(`collectionIds=[project]` *plus* a specific doc) sets `hasExplicitDocSelection` and disables filename
auto-scope across the *entire* union, even though the picked collections are still in play. This is
intended (an explicit pick means "I chose these"), just easy to overlook.

### 13.6 Scope-aware re-index honesty (M2)

`corpusNeedsReindex(db, embeddingModelId, scope?)` applies the same membership/`includeArchived` filter
as retrieval, so the grounding guarantee stays correct under scope: an **empty** scope (a new/empty
project) ⇒ `NO_DOCUMENT_CONTEXT_ANSWER` (re-indexing wouldn't help); a scope with indexed docs **none
visible to the active embedder** ⇒ `REINDEX_NEEDED_ANSWER`. Collection filtering can only shrink the
candidate set, so the empty-context ⇒ no-model-call guarantee strengthens, never weakens.
`generateGroundedAnswer` passes the **same scope retrieval used** to this check —
`corpusNeedsReindex(db, embedder.id, normalizeScope(opts.scope ?? opts.scopeDocumentIds))` — so the
honesty story holds on the **legacy doc-id path too**, not only the composite-`scope` path (RAG-1). A
bare `null`/`undefined` still normalizes to the whole-corpus check (the archived exclusion only),
byte-identical to before; only the legacy `scopeDocumentIds` array path changes — from a wrong
whole-corpus diagnosis to the correct scoped one.

### 13.7 Persistence & smart-view-as-scope (out of v1)

The composite `DocumentScope` (incl. the empty "All documents") persists in `scope_v2_json` and survives
restarts. A smart view (§7.6 — a query-time predicate, not a stored collection) is **not** storable *as*
a scope in v1; a user can apply it to the listing and hand-add its current ids via "Specific documents…".

## 14. Whole-document analysis beyond the context window — design record (Phases 1–4)

_First-class analysis of documents that **vastly exceed** the 4k–8k chat window — covering the
**whole** document, faithfully and honestly — by moving cost from query time to ingest time via a
persistent hierarchical summary tree (RAPTOR-lite) plus structured extract-then-aggregate, routed by
task type. All offline, **one model job at a time**, CPU-first. Condensed from
`docs/whole-document-analysis-plan.md` at the Phase-4 closeout (2026-06-15); full original (incl. the
three audit-remediation passes — C1–C4/H1–H11/M1–M13/L1–L7):
`git show 4071685:docs/whole-document-analysis-plan.md`. **§14.x anchors are stable — code comments
that cite "plan §3.x/§4.x" map here (§4.1→§14.3, §4.2→§14.5, §4.3→§14.6, §4.5→§14.4, §3.1→§14.2).** The
data tables live in [`db.ts`](../apps/desktop/src/main/services/db.ts); everything inherits whole-file
encryption. Summaries, the content cache, extraction records, and node vectors are **content** — never
logged or audited; audit events stay ids/kinds/counts._

### 14.1 Cap honesty + the `fully_chunked` invariant (C1/C2/C4/M13)

The 1000-chunk-per-document cap used to **silently drop** an over-cap document's tail (the doc still
reached `indexed`), so "the tree covers 100% of chunks" did **not** mean "covers the whole document".
Fix: a single source-of-truth constant `MAX_CHUNKS_PER_DOCUMENT`
([`chunker.ts`](../apps/desktop/src/main/services/ingestion/chunker.ts)); `processDocument` chunks with
`maxChunks = cap + 1` and **rejects** an over-cap document with the persist-canonical
`main.ingest.tooManyChunks` **before** the destructive `DELETE FROM chunks` (**M13** — a re-index of an
over-cap doc keeps its existing searchable chunks; the gate fails **closed**). Every successful index
stamps `documents.fully_chunked` at the **one** indexing-success site (all paths funnel through
`processDocument` — C4), so "the stored chunks ARE the whole document" is provable. **Deep index, the
extract pass, and any 100%-coverage claim are gated on `fully_chunked`**; a legacy (`fully_chunked IS
NULL`, maybe-truncated) doc must **re-index first** (which fully chunks it, or fails over-cap). This is
a deliberate behavior change (noted in `known-limitations.md`).

### 14.2 Summary-tree schema + content cache (plan §3.1/§3.5)

Additive tables in `SCHEMA` (no version bump; `ensureColumn` for the document columns):
- **`tree_nodes`** — per-doc hierarchical summary nodes. `level` (1 = first summary layer, children are
  chunks; 2+ summarize nodes; root = max level), `ordinal`, `parent_id`/`is_root`, `summary_text`,
  `content_hash` (the **cache key**, sha256 over ORDERED child texts — *not* node identity), `model_id`
  (chat model), and the node-vector columns `embedding_blob`/`dimensions`/`embedding_model_id`
  (**NULL until Phase 4 fills them lazily** — §14.6, L6). `ON DELETE CASCADE` on `document_id`/`parent_id`.
- **`tree_edges`** — ordered child edges; `child_id` is **polymorphic** (a chunk when `child_is_chunk=1`,
  else a node) and carries **no FK to chunks**, so deleting chunks does NOT cascade — re-index tears the
  tree down explicitly. `idx_tree_edges_child` gives the reverse chunk→node lookup (L5).
- **`summary_cache`** — `(content_hash, model_id)` → `summary_text` (+ the node vector). Separate from
  node identity: a tree always gets **one fresh `tree_nodes` row per structural position**, so identical
  boilerplate yields two distinct nodes that merely share a cached summary (kills the C3 tree-collapse
  bug). A rebuild/resume over a warm cache costs **0 chat calls** for unchanged groups despite full
  chunk-id churn. Keyed by `model_id` so a model change never reuses an older model's summary (M5).
- Columns: `documents.tree_status` (NULL|pending|building|ready|stale|failed), `tree_meta_json`
  (`{rootId, levels, leafChunkCount, builtAt, modelId, embeddingModelId}`), `fully_chunked` (§14.1).
  `reconcileStuckTrees` flips a stuck `building`→`pending` at startup.
- **Re-index teardown [H1/H2]:** in the chunk-replacement block, `DELETE FROM tree_nodes` (edges cascade
  via `parent_id`) + `tree_status`→`stale` if a tree existed; the warm `summary_cache` makes the rebuild
  cheap. Extraction rows self-cascade via `chunk_id` (§14.5).

### 14.3 Yielding tree build + the model-slot arbiter (plan §4.1, H3/H9/H10/H11/M8/M9/M12)

[`tree-build.ts`](../apps/desktop/src/main/services/analysis/tree-build.ts) packs chunks (in
`chunk_index` order) into groups ≤ `TREE_GROUP_TOKENS` (= the summary budget math, Q5), summarizes each
group into **one fresh level-1 node**, and recurses over node summaries to a single root. Cost is **O(n)
chat calls** paid once (~250 for a 1000-chunk doc), **zero embeds at build time** (node vectors deferred
— §14.6).
- **Yielding (H3/H9/H10):** a ~250-call build cannot block chat. The build commits **one node per
  transaction** and, at each node boundary (synchronous, before the next `generate`), checks the
  **`ModelSlotArbiter`** ([`model-slot-arbiter.ts`](../apps/desktop/src/main/services/analysis/model-slot-arbiter.ts)) —
  the single in-process owner of the one chat-runtime slot. If chat asked for the slot the builder
  **parks on `await arbiter.reacquire()`** (it does **not** return — a returning DocTask is marked `done`
  and never resumes) and continues from the next node in-session when chat's stream ends. Chat's
  `assertChatStreamReady` is **async**: for a yielding `tree`/`extract` task it sets `pauseRequested`,
  **awaits** the builder's handoff, then claims the slot; a non-yielding task still refuses chat with
  `DOC_TASK_BUSY_MESSAGE` (the guard branches on the running task's **kind**). One slot, one synchronous
  claim, one awaited handoff ⇒ builder and chat never call `chatStream` concurrently.
- **Per-node transaction with ROLLBACK [H11/M8]:** the repo had **zero** `BEGIN/COMMIT` and `node:sqlite`
  has no `.transaction()` helper; the build introduces an explicit `try { BEGIN; inserts; COMMIT } catch
  { ROLLBACK; rethrow }` scoped to one writer. The `generate`/embed `await`s happen **outside** `BEGIN`
  (the transaction body is synchronous). The `ROLLBACK` is mandatory: one `DatabaseSync` is shared with
  chat **and the concurrent import loop**, so a thrown insert that left `BEGIN` open would poison the
  next writer. Finalize is a single atomic `UPDATE … tree_status='ready'`.
- **Abort on lock/quit [M9]:** `lockWorkspace`/`will-quit` call `docTasks.abortActiveBuild()` (aborts the
  task controller AND **rejects** the parked `reacquire`) **before** the sidecar teardown, so a
  multi-minute build doesn't thrash the CPU while the vault re-encrypts. **Model switch [M12]:** the
  build is pinned to `tree_meta.modelId`; resume restarts (not resumes) on a model change to avoid a
  mixed-model tree (the warm cache keeps the restart cheap).
- **Resume = discard + rebuild** from the warm cache (never half-wired parent pointers). DB-only writer
  ⇒ lease-free (L1). Generated docs are skipped (M6). The **`extract` pass (§14.5) is the second yielding
  build** — same arbiter handshake, cancel, and lock discipline.

### 14.4 Coverage, provenance, tiers (plan §4.5, C1/L2/M1/M2)

[`coverage.ts`](../apps/desktop/src/main/services/analysis/coverage.ts) is a pure DB reader (no model
calls). `reachableLeafChunkIds` walks `tree_edges` root→leaf **chunks**; `documentLeafProvenance` turns
those leaf SOURCE chunks into `[Sn]` `Citation[]` (**M2 — node summaries are derived context, NEVER
citations**). `documentCoverage` reports two **separate** honest statements — **breadth** (reachable
leaves ÷ chunk count; 100% only when `tree_status='ready'`, never while building/stale/pending — C1) and
**depth/tier** (a Tier-1 root is abstractive/lossy — breadth ≠ fidelity, L2). **Tiers** in `runSummary`
(`summarizeFromTree`, selected via the `summary` task `params.tier`; no-arg = Tier 1, unchanged):
**Tier 1** = stored root verbatim (**0** calls, M1 — the one-click summary serves the ready tree root
with `truncated:false`); **Tier 2** = one reduce over the root's children; **Tier 3** = all level-1
nodes reduced in batches bounded by **node count**, not document size. All tiers cover the whole document.
The renderer surface (`CoverageMeter`/`TierMenu`, the PreviewModal meter+selector+provenance, the chat
"most relevant passages" relevance label, the "Build deep index"/"Re-index first" row action) honours the
forbidden-UI-words policy: "deeply indexed"/"sections"/"passages", never chunk/node/tree/vector jargon.

### 14.5 Structured extract-then-aggregate + the task router (plan §4.2/§3.3/§4.4, H7/H1/M3/M7)

`list every X / how many` moves **off** top-k relevance onto a precomputed, provenance-backed SQL
aggregation answered at **zero query-time model calls** — exhaustive **over indexed sections**, never
"complete" (H7).
- **Schema:** `extraction_records` (one item row per surfaced item + one `__scan__` marker row/chunk
  recording `ok`/`unparsed`); `chunk_id` **FK ON DELETE CASCADE** ⇒ re-index self-invalidates (H1, a
  free win the tree's polymorphic edges cannot have). `documents.extract_status` mirrors `tree_status`;
  `reconcileStuckExtracts` mirrors the tree reconcile.
- **Pass** ([`extract.ts`](../apps/desktop/src/main/services/analysis/extract.ts)): the **second**
  yielding build — one `generate`/chunk over the fixed v1 type set (`generic|date|amount|party|
  obligation`), strict JSON-array prompt at temp 0, tolerant `parseExtraction` + retry-once, then an
  `unparsed` marker (the chunk is **surfaced, never dropped** — H7); same arbiter/cancel/lock discipline
  + per-chunk `try{BEGIN…COMMIT}catch{ROLLBACK}` (H11); per-`(chunk_id, content_hash)` resume cache = **0**
  calls on re-run. Gated on `fully_chunked` (C4). Manual-only (not auto-enqueued at import — avoids
  surprise CPU spend).
- **Aggregate:** `aggregateExtractions` GROUPs BY `normalized_value` through the shared
  `buildScopeFilter('document_id')` (M3 — membership/id UNION + archived exclusion), **0** model calls;
  returns items+counts+source-chunk provenance + scanned/total/unparsed + `fullyChunked`.
- **Router** ([`router.ts`](../apps/desktop/src/main/services/analysis/router.ts), pure): EN+DE
  classification (list/every/each/how many/count + jede/alle/wie viele/sämtliche/liste/zähl), fixed
  precedence **explicit-button > compare(2 docs) > coverage-extract > tree-summary > relevance** (M7),
  closed-vocab→type synonym map; **low-confidence / no-extract-data / compare-without-2-docs → labelled
  relevance** (never an empty "no items" or a false "complete"). The `rag:ask` wiring streams the
  deterministic listing ([`listing-answer.ts`](../apps/desktop/src/main/services/analysis/listing-answer.ts))
  for a mapped pre-extracted type; everything else falls through to the existing relevance path
  **byte-unchanged**. An unmapped/ad-hoc "{X}" falls back to labelled relevance in v1 (no live full-scan —
  deferred), so the 0-call completeness claim is only ever made for a mapped type.

### 14.6 Symmetric compare + lazy node vectors (Phase 4, plan §4.3/§3.1, H4/H5/H8/L6)

Node vectors are **NULL** after the Phase-1 build; **Phase 4 — symmetric compare — is their first and
only consumer**, so they are embedded **lazily** here, the first time a compare needs a tree's nodes.
[`compare.ts`](../apps/desktop/src/main/services/doctasks/compare.ts) now distinguishes three modes:
- **(a)** both full texts fit one pass — the existing single call over both, already symmetric.
- **(c) symmetric both-trees** — when BOTH docs have a `ready` tree under the same active embedder AND
  the smaller doc has ≤ `SYMMETRIC_COMPARE_CALL_CEILING` (24) level-1 sections. Align each tree's
  **level-1 nodes** as non-overlapping sections by **node-vector cosine** (`alignNodes`, **greedy
  mutual-best-match** with a **swap-invariant** tie-break — the canonical pair key — above
  `SYMMETRIC_MATCH_MIN_SCORE`), diff each aligned pair with one `generate` call (Same/Different/Only-A/
  Only-B), attribute unmatched-A→Only-A and unmatched-B→Only-B **with no model call** (their node
  summaries are fed as notes — M2, never `[Sn]` citations), then one reduce into the four-section report.
  **Acceptance — the mirror property:** swapping A and B yields the mirror-image diff (Only-A ↔ Only-B
  swap; Same/Different stable). The diff/reduce live in the manager (`runCompareSymmetricTrees`); the
  **pure `alignNodes`** lives in `compare.ts` so the mirror is unit-testable without the model.
  **Lopsided-pair honesty (post-merge review M-1):** the 24-ceiling bounds the number of `generate`
  calls (pairs ≤ the *smaller* section count), but a lopsided pair (e.g. A=3, B=40) still emits many
  free Only-B notes; when those overflow the reduce input budget the belt condenses the tail. That is
  flagged — `runCompareSymmetricTrees` returns `truncated`, and the report materializes
  `compareSymmetricTruncationNotice` ("some sections were condensed … may not list every section-level
  detail") — so the symmetric report never silently implies a complete two-way comparison (H8).
  **Symmetric loss (review follow-up):** the Only-A/Only-B notes are **interleaved** (A, B, A, B …) before
  the belt, so a tail-truncating reduce sheds both documents' unique content roughly evenly and the loss
  stays mirror-symmetric (swapping A/B drops the same sections, off by at most one note at an odd boundary)
  rather than always sacrificing the Only-B tail. The same belt in mode (b) (`runCompareSectionMatched`)
  also sets `truncated` now (it cuts the later doc-A windows, so the existing `compareTruncationNotice`
  "covers its beginning" wording applies) — the two paths are honest about condensing in parallel.
- **(b) asymmetric A-driven** (the existing section-matched map-reduce over `VectorIndex`-scoped doc-B
  neighbours) — the labelled fallback when the two docs are **not** both deeply indexed. The materialized
  report now carries `compareAsymmetricNotice` ("one-directional — may under-report content found only in
  B; deeply index both for a complete two-way comparison"). v1 does **not** auto-build the missing tree —
  it falls back, labelled, and the user has the per-doc "Build deep index" action (the default; flagged).

**Lazy node embeddings + the H5 guard** ([`node-vectors.ts`](../apps/desktop/src/main/services/analysis/node-vectors.ts)):
`ensureNodeEmbeddings(db, documentId, embedder)` embeds each node's `summary_text` on the **CPU embedder
sidecar** (`--device none`, **not** the chat slot) in one batch, reusing the exact `encodeVector` Float32
encoding, stores the raw LE blob in `tree_nodes.embedding_blob`/`dimensions`/`embedding_model_id`, and
writes the vector back to `summary_cache` so a **rebuild refills from the cache** (0 sidecar calls — the
rebuild mints fresh NULL-vector rows with the same `content_hash`). It is **scoped by
`embedding_model_id`**: a node under a *different* embedder (mock↔real / model swap) is **re-embedded**
under the active one — a mixed-embedder alignment **never silently happens** (H5); it stamps
`tree_meta_json.embeddingModelId`. The pass runs **inside** the (non-yielding) compare DocTask, so it is
still one model job at a time (chat is refused during compare) — **decision (c): folded into `runCompare`,
not its own DocTaskKind**. The node-cosine primitives (`nodeVectorSearch`/`loadNodeVectors`) read **only
`tree_nodes`** — never the chunk `embeddings` table — so citation-grade chunk retrieval is untouched
(§3.6); they are **not** `VectorIndex`. The compare in-document notices (`compareAsymmetricNotice`,
`compareTruncationNotice`, `compareSymmetricTruncationNotice`, `compareAttributionLine`) stay **English literals** by the existing
`compare.ts` precedent (the report body itself is in the documents' language — a D-L7 candidate, not a
new i18n key).

### 14.7 Storage/scan sizing + offline/privacy invariants (plan §3.6)

Per fully-built doc: ≈ `chunks/4` node rows (≈250 for 1000 chunks), one node vector each **once Phase 4
embeds them** (384×4 B ≈ 1.5 KB → ~0.4 MB; NULL before that), plus deduped `summary_cache` entries and N
`extraction_records` — all bounded by `MAX_CHUNKS_PER_DOCUMENT`. Node vectors live in `tree_nodes`,
**out of** the chunk `embeddings` linear scan, so ordinary RAG retrieval is unaffected; the node-cosine
helper scans one document's nodes at a time. No new long-context single-shot path; every call stays
within 4k–8k. The embedder is a **separate CPU process** from chat. Strict single-model-job, fully
offline, no telemetry hold throughout.

### 14.8 Deferred (not built in v1)

The collection-level "tree of trees" (`tree_nodes.scope_key` reserved); a live full-scan extract for an
**unmapped** ad-hoc "{X}" type; semi-global QA injecting upper-level node summaries as derived context
(the router hook exists; node summaries would stay labelled "background", never `[Sn]`); node vectors in
ordinary chunk retrieval/citations (deliberately excluded). A symmetric compare of two docs whose smaller
side exceeds the 24-section ceiling falls back to the labelled asymmetric mode (b).
