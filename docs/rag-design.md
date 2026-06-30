# RAG design — HilbertRaum

_Last updated: 2026-06-29 (the body now reflects the 2026-06-27/28/29 audit waves — backend, full, and post-merge: the RAG-N markdown-fence/CSV-delimiter/doc-cap fixes, RAG-1 listing-honesty, REL-5/9, and the §12.3/§12.4 sidecar records). Prior: 2026-06-15 (whole-document-analysis closeout: the four-phase plan condensed into the §14 design record; Phases 1–4 shipped — summary tree, coverage meter, extract-then-aggregate, symmetric compare). Earlier: 2026-06-12 docs housekeeping — Phase-17 record into §10, Phase-21 design record as §12._

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
   always included (an unsupported one surfaces later as `failed`). The walk **follows
   symlinked directories** (intended — ING-4), but guards against a **symlink cycle**
   (`a/loop -> ..`): it tracks the `realpathSync` of every directory on the *current recursion
   path* in a Set and skips a directory whose real path is already an ancestor (backend audit
   2026-06-27, REL-9). This terminates a self-referential tree (which would otherwise recurse
   until ENAMETOOLONG/ELOOP or a stack overflow, re-adding files via every looped path) while
   leaving every acyclic walk's expansion set byte-identical — a symlink to a *distinct*
   directory is not an ancestor, so it is still followed.
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
| `.md`/`.markdown`/`.mdown` | `MarkdownParser` | hand-rolled | one segment per ATX heading section (fenced-code-aware, RAG-N4) | `sectionLabel` = heading text |
| `.pdf` | `PdfParser` | `pdfjs-dist` (legacy build) | one segment per page | `pageNumber` (1-based) |
| `.docx` | `DocxParser` | `mammoth` (raw text) | one segment per paragraph | — |
| `.csv`/`.tsv` | `CsvParser` | `papaparse` | whole table = 1 segment | — (rows → `header: value` lines; delimiter pinned by extension, RAG-N5) |
| `audio/*` (`.wav`/`.mp3`/`.flac`/`.ogg`) | `AudioParser` | injected transcriber engine | transcript packed into segments ≤ the chunk window (token-based, space-less-script-safe) | `sectionLabel` = time range `mm:ss–mm:ss` → `Citation.section` |
| `image/*` (`.png`/`.jpg`/`.jpeg`) | `ImageParser` | injected OCR engine | whole photo = 1 segment | — |

A parser returns `{ segments: ExtractedSegment[], mimeType }`, where each segment carries its
optional `pageNumber` / `sectionLabel`. The chunker copies that structure onto every chunk it
derives, so a chunk can always cite the page/section it came from. Parsers also receive an
optional `ParseContext` carrying the injected `transcriber` / `ocrEngine` (the text parsers
ignore it), an optional `signal` (REL-1 cancellation, forwarded only by the AudioParser), plus
`maxPages` and `maxInflatedBytes` (PDF page-count + DOCX zip-bomb caps, security audit M-2/M-3).

**Audio packing — token-based, space-less-script-safe (RAG-N1).** `packTranscriptSegments`
coalesces whisper's tiny per-phrase segments into paragraph-sized ones, capped at
`AUDIO_SEGMENT_MAX_TOKENS` (= `CHUNK_DEFAULTS.chunkSizeTokens − 100`, a ~20 % margin below the
chunk window). The cap is measured in **approx-tokens** (`approxTokenCount`, the same CJK/Thai-aware
counter the chunker budgets with), not whitespace words — a space-less phrase (Japanese/Chinese/Thai)
is a few "words" but hundreds of tokens, so a word cap let an audio segment blow past the window.
A single over-budget whisper segment is split via `windowByTokens(text, max, 0)`, which cuts
**space-less scripts on character boundaries** (overlap 0 ⇒ a lossless partition). Because every
packed segment is guaranteed `≤ AUDIO_SEGMENT_MAX_TOKENS < chunkSizeTokens`, the chunker emits
**one chunk per packed segment, verbatim, with no overlap** — which is what lets
`audioSegmentsFromChunks` rebuild the transcript from stored chunks with **no duplicated or dropped
spans** (preview / translate / compare without re-transcribing). The reconstruction is byte-exact
in the common case; the one exception is the *oversize-single-segment* path: its split pieces share
one time-range label, so the chunker's `coalesceSegments` re-merges and re-windows them, and a small
trailing remainder that merges into the prior window normalizes its `\n\n` boundary to a single
space in a space-less script — never duplicating or losing text (a pre-existing benign property of
the chunker's coalesce, now reached by long CJK/Thai utterances too). Existing CJK/Thai audio keeps
its old chunks until re-indexed (re-index self-heals); no migration.

**Markdown fence-awareness (RAG-N4, full audit 2026-06-28).** `MarkdownParser` splits sections at ATX
headings (`/^(#{1,6})\s+/`) but tracks an in-fence flag toggled on every code-fence line (a
triple-backtick or `~~~` run, optionally indented). A `#`-prefixed line INSIDE a fenced block — a
shell comment, a C `#define`, a diff/patch hunk — is therefore treated as code, not a heading; without
this the fenced block fragmented into bogus sections stamped with garbage `sectionLabel`s (→ wrong
citations). Non-fenced Markdown is byte-identical. It is a simple toggle: it does not model nested
fences of differing backtick lengths, which Markdown disallows anyway.

**CSV/TSV delimiter pinned by extension (RAG-N5, full audit 2026-06-28).** `CsvParser` passes
`delimiter: '\t'` for `.tsv` and `','` for `.csv` to papaparse instead of relying on auto-detection. A
`.tsv` whose cells contain commas (e.g. "Lovelace, Ada") could otherwise tie tab with comma on
field-count consistency and — papaparse checking comma first — auto-detect as comma, silently
mis-pairing `header: value` while the document still reached `indexed`.

### Cap stack — one enforcement point (`parseWithLimits`, MAINT-4 / REL-5)

Every parse entry point — ingest (`prepareDocument`), the renderer preview
(`extractDocumentPreview`), and the paged preview (`extractDocumentPreviewPage`, via the
former) — routes through the **single `parseWithLimits(parser, source, ctx, limits)`
decorator** so the resource cap stack can never silently diverge per path again. The decorator
(1) injects the per-parser caps (`maxPages` / `maxInflatedBytes`) from the resolved
`IngestionLimits` onto the context (a caller-set value — e.g. the bank-statement layout seam's
own page cap — wins), and (2) races the parse against the wall-clock `parseTimeoutMs`, **except
audio** (a long transcription legitimately runs for minutes; its `signal` + the transcriber's
inactivity watchdog bound a wedged child instead). The pre-parse **byte ceiling** (M-1) stays a
stat the ingest path runs before parser selection; the preview reads the already-import-capped
stored copy, so the byte ceiling is in force on both paths without a re-stat.

This closes **REL-5** (backend audit 2026-06-27): the preview re-parse formerly threaded *none*
of the caps (only `maxPages`, and only in layout mode) and re-extracted the whole document per
"Show more", so an already-indexed but pathological file (e.g. a 4000-page PDF) could wedge the
main process on a user-triggered preview where import would have killed it. The preview path now
enforces the same `maxPages` + `maxInflatedBytes` + timeout backstop on every page request. The
timeout *message* differs by caller: the ingest path passes persist-canonical English (written
to `documents.error_message`); the preview passes a localized `tMain(...)` emission (a transient
IPC throw, never persisted).

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
  raw substrings). **Overlap for space-less scripts (RAG-N2):** the character slices are sized
  `gcd(size, overlap)` (e.g. `gcd(500, 80) = 20`) so the windower's whole-atom step-back can
  re-include ~`overlap` tokens — a single window-sized slice can never be stepped back into, so
  CJK/Thai chunks formerly got **zero** overlap (a boundary-straddling fact could be missed). The
  re-joined slices carry a `glued` flag so they stitch back with no inserted space. With `overlap
  = 0` the slices are `size` chars again — a lossless partition (what the audio split and
  `truncateToApproxTokens` rely on). **Ordinary space-separated prose is byte-identical** to before
  (words ≤ `size` are never sliced); an **over-long no-space run** longer than `size` tokens —
  base64, a giant URL, a glued PDF-extraction run — is now treated as the space-less run it is and
  likewise gets glued/overlapped, which also FIXES a latent bug: the old char-slice path
  space-joined those pieces, injecting spaces into the run (corrupting a base64/URL and breaking
  lossless reconstruction). The same windower backs the summary/translation/compare planners and
  the `truncateToApproxTokens` clamp.
- **No cross-segment chunks.** Chunking happens *within* a segment, so each chunk inherits
  exactly one `pageNumber` / `sectionLabel`.
- **Cap.** The global chunk count is capped at `max_chunks_per_file` (`MAX_CHUNKS_PER_DOCUMENT`,
  1000). A document that would exceed it is **REJECTED at index time** — `processDocument` chunks
  with `maxChunks = MAX_CHUNKS_PER_DOCUMENT + 1` and, when the result is over the real cap, throws
  the friendly `main.ingest.tooManyChunks` ("too large to fully index — split it") *before* the
  destructive chunk replacement, so a previously-searchable copy is never half-deleted (M13) and
  any stale `fully_chunked` marker is cleared (C4). This **replaces** the legacy silent
  truncation (where the cap dropped the document's tail and still reached `indexed`); the win is
  that every *indexed* document is now the WHOLE document, which is what lets a deep index
  honestly claim full coverage. `chunkSegments` itself still STOPS at its `maxChunks` argument as
  a memory guard (it is no longer the honesty boundary), and callers that pass no `maxChunks` keep
  the legacy truncate-at-1000 behaviour (tests only). (Distinct from the **pre-parse** resource
  caps — byte ceiling / parse timeout / PDF page count / DOCX inflate — which bound the *parser*
  before it ever produces segments; those are now applied uniformly on every parse entry point,
  including the preview path, via the `parseWithLimits` decorator — see §2.)

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
| `deleteDocument(id)` | → `void` | atomic teardown: `purgeDocumentDerivatives` (chunks/embeddings/tree + bank/invoice rows) → row, in one txn; stored copy shredded after commit (audit DATA-1) |
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

MVP = **linear scan**: score every stored chunk vector by dot product against the query vector
(stored + query vectors are L2-normalized, so dot == cosine — RAG-1), sort descending, take `topK`.
Rows whose `dimensions` differ from the query (e.g. mid-migration) are skipped, not compared. The
query is embedded with the **same** embedder, so a query equal to a chunk's text scores ≈ 1.0 and
ranks first. The decoded vectors are held **process-resident** (`embeddings/resident-cache.ts`, perf
audit Wave P4; maintained **incrementally** since PERF-1 / full-audit-2026-06-29 Phase 5) so a query
reads no `vector_blob` and re-decodes nothing. The write-site hooks mark the cache dirty and the next
query RECONCILES the delta on the unique `chunk_id` — decoding only the new chunks (a pure-add of K into
N decodes K, not N), and correct even when a re-index reuses a freed rowid; a cheap whole-table
`(count, maxRowid)` signature is the self-healing backstop that full-rebuilds on an out-of-band write,
and the cache is purged on workspace lock (vectors derive from chunk text). **P2 (full-audit-2026-06-30):**
on the unscoped path (no document/collection scope, archived exclusion vacuous) `search` now **iterates
the resident map directly** — filtered in memory by `modelByChunk` (the cache's chunkId → model-id view)
— and skips the per-query `SELECT chunk_id` row marshal entirely; any real scope filter (or a live
archived exclusion) keeps the unchanged scoped SQL scan. Byte-identical results, ~5×/query at 10k–50k
(see architecture.md Wave-P4 "Phase B" note). **Upgrade path** (still behind this same `search`
signature, D15): an off-main-thread worker scan and/or an ANN index (sqlite-vec / HNSW) when a corpus
outgrows the linear scan.

`searchText` embeds the query through `embedQueryCached` (RAG-5): a small per-embedder LRU
(`QUERY_VECTOR_CACHE_MAX = 32`, keyed by exact query string, held in a `WeakMap` by embedder
instance) memoizes query text → embedding vector, so a repeat ask / "try again" / the re-index
honesty re-check skips the dominant embed round-trip. Swapping the embedder starts from an empty
cache automatically.

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

### Grounded prompt (`buildGroundedPrompt` + `GROUNDED_SYSTEM_PROMPT`)

The grounded prompt is split across two messages. The **stable** grounding rules + preface live in
`GROUNDED_SYSTEM_PROMPT` (= `BASE_SYSTEM_PROMPT` + the rules block); `buildGroundedPrompt` is a pure
function emitting only the **per-turn** content — the `Question:`, then the numbered
`Document excerpts:` in the spec §7.8 source-context format:

```text
[S1] File: Contract.pdf | Page: 4
"...chunk text..."

[S2] File: Terms.docx | Section: Liability
"...chunk text..."
```

The meta line is `| Page: N` when the chunk has a page, else `| Section: X`, else nothing.

**RT-2 — the rules ride in the cacheable system prompt (perf audit 2026-06-18, Wave P3).** The rules
+ preface USED to ride in this per-turn user message, so `cache_prompt`'s longest-common-prefix reuse
stopped at `BASE_SYSTEM_PROMPT` and **re-prefilled the whole rules block every documents turn** — even
follow-ups, because the prior user turn is replayed as the *raw* question (the DB never stores the
grounded form), so the grounded prefix never matched across turns. Moving the rules into the byte-stable
`GROUNDED_SYSTEM_PROMPT` puts them in the always-reused prefix: **~58 approx tokens** of rules that no
longer re-prefill per follow-up (on CPU, prefill is ~30–80 tok/s — see architecture.md §17). Precedence
is unchanged/strengthened (rules in `system` ≥ the user turn); the `[Sn]` citation contract and the
no-context refusal path are untouched. A test asserts the system prefix is byte-stable across two turns.

**Skill fence (Skills plan §11.2 / S7).** `buildGroundedPrompt` takes an optional `skillFence`: when
a skill is active for the turn, its fenced instruction block is placed in **this user/data turn**
(after the `Question:`, before the excerpts) — **never in `system`** (§22-H2): a skill is
user-selected reference text, the same untrusted class as the excerpts, and the grounding + citation
rules keep precedence. (RT-2 moves only the stable grounding RULES to `system`, NOT the fence.) The
fence is pre-sized by `services/skills/prompt.ts` against the fence-less grounded turn — now measured
as `GROUNDED_SYSTEM_PROMPT` + the rules-less user turn, an unchanged total — so the excerpts/question
are never starved (§22-A6), and the assistant row is stamped with the skill only when the fence was
actually placed **and** chunks were found — a no-context answer (model not called) stamps NULL. See
architecture.md "Chat & streaming" / the skills design.

`buildGroundedChatMessages` then assembles the runtime message list: the **`GROUNDED_SYSTEM_PROMPT`**
(base preamble + grounding rules), prior conversation history, and the **last user turn replaced by
the grounded prompt**. The DB keeps the raw question for the transcript/title; only the model sees the
grounded form. The history is then **trimmed to the model context** via `fitMessagesToContext`
(chat.ts; passed `getSettings(db).contextTokens`) — the grounded turn is the final message and
is always kept, while older turns are dropped oldest-first. `maxContextTokens` bounds only the
**retrieved-chunk block**; the context-window budget bounds the **whole prompt** (chunks +
history + system), which is what prevents the multi-turn `HTTP 400 exceed_context_size_error`
(fix 2026-06-16 — see architecture.md "Chat & streaming").

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
  stale document (the per-document stale badge shipped in the earlier polish round). The Failed
  imports tab carries the same affordance as **Retry all**, targeting `status === 'failed'`
  documents instead of stale-embedding ones; both are confirm-gated (M-U6), with copy keyed off
  which set opened it. The sequential loop is **owned by MAIN** (`IPC.startReindexAll` /
  `getReindexAllJob`, a `ReindexJobStatus` aggregate), mirroring the import job: only one runs at a
  time (a start while running is idempotent), and the renderer drives the determinate progress bar
  by polling. Because the job lives in main, the bar **survives navigating away from the Documents
  screen and back** — the renderer recovers it with the parameterless `getReindexAllJob()` on mount.
  Transient state only: nothing is persisted to disk (a saved counter would lie after a restart; the
  live main job is the single source of truth, recovered by polling — same posture as imports).

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
4. RRF fusion (k = 60)                      (rank-based; scales never mix; ties → best rank, then chunkId)
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

`rrfFuse` is deterministic: equal RRF scores break on the chunk's best individual rank
`min(vectorRank, keywordRank)`, then on `chunkId` (M-C4). The `min` (rather than vector rank
alone) keeps a #1 keyword-only exact-match hit — invoice numbers / codes, the case hybrid search
exists to catch — from always losing an RRF tie to a #1 vector hit.

**Per-list tie-break (full-audit-2026-06-29 RAG-1).** `rrfFuse` breaks the *final* tie on
`chunkId`, but the *per-list rank* each chunk feeds in (1/(k+rank)) is only deterministic if each
input list is. Under prefix-less E5 the cosines compress into a narrow band (§12.1 R3), so
equal-score ties are realistic — and without a secondary key the vector list inherited V8 sort
stability while the keyword list inherited SQLite's unspecified `bm25()` tie order, so which chunk
won a page-dedup slot could flip across SQLite versions/query plans (a reproducibility/test-flake
risk, not a hallucination). Both input lists now carry a `chunkId` tiebreak — the vector sort in
`embeddings/index.ts` (`score desc, chunkId asc`) and the FTS `ORDER BY bm25(chunks_fts),
chunks_fts.chunk_id` — so the ranks into RRF and the page-dedup winner are pinned. (`chunkId` is
unique, so the order is total.)

### Keyword index (`chunks_fts`)

Self-contained FTS5 table `fts5(text, chunk_id UNINDEXED)` — NOT external-content on
`chunks`' implicit rowid (VACUUM may renumber implicit rowids and would silently desync
the index; the duplicated text lives in the same workspace DB, encrypted at rest with
it). Synced by three triggers on `chunks` (insert/delete/update-of-text), so
ingest/re-index/delete can never miss it; created + backfilled by a guarded additive
migration in `openDatabase` (the `scope_json` precedent). Questions are sanitized into
`MATCH` queries by `fts.ts` `buildFtsMatchQuery` (shared with conversation search, re-exported
from `rag/hybrid.ts`): quoted phrase tokens OR-ed, capped at 32 — FTS5 operator syntax in user
text never reaches MATCH raw; ranking is `bm25()`.

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
`index`). Inputs are truncated by **approx-token cost** (query ≤ 160, doc ≤ **500 = the WHOLE chunk
window**, `CHUNK_DEFAULTS.chunkSizeTokens`) to fit the context — via the CJK/Thai-aware
`truncateToApproxTokens` shared with the E5 embedder (`runtime/context-budget.ts`), NOT a whitespace
word split. **The doc cap was 320 before RAG-N3 (full audit 2026-06-28); it is now the whole chunk
window so the reranker scores every chunk in full** (a key sentence in a chunk's second half was
previously invisible — see "Known retrieval-quality ceilings" below and §12.3). The old word split
treated a space-less passage (CJK/Thai) as one "word" and never truncated it, so it overflowed
`n_ctx`, the sidecar HTTP-500'd, and the rerank silently fell back to the fused order — a no-op
reranker on those scripts (EMB-1, backend audit 2026-06-27; see §12.3). The per-field caps are
derived from the context budget in the constructor, so they can never exceed `n_ctx`; per-candidate
CPU latency is bounded by the small candidate cap (≤ 2×topKInitial), not by clipping each chunk.
The sidecar also passes `--batch-size`/`--ubatch-size` = the context (2048): in
`--rerank`/embedding mode llama-server forces `n_batch = n_ubatch` and defaults them to
**512**, but a query+document rerank input runs ~1452 worst-case real tokens (160 + 500 approx ×
2.2; RAG-N3 raised the doc cap to the whole chunk window) and would otherwise HTTP-500 the whole
request on real-length chunks (found by `HILBERTRAUM_RERANK_SMOKE`; §12.1 R1).
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

### Known retrieval-quality ceilings (DOC-N6, full audit 2026-06-28)

Two properties of the current stack bound retrieval quality and explain WHY the reranker is the
load-bearing relevance separator — recorded here so future work invests in the right lever:

1. **E5 runs PREFIX-LESS → compressed cosines.** The embedder sends raw chunk/query text with no
   `query:` / `passage:` prefixes, so every best-chunk cosine compresses into a narrow ~0.87–0.94
   band and relevant/irrelevant distributions OVERLAP (R3, §12.1, measured on the real drive). That
   is why `ragMinSimilarity` is empirically pinned at **0** (a positive floor drops real hits) and
   why **relevance separation is delegated to the reranker, not the cosine floor**. The §12.3
   reranker win ("rescued #3-behind-distractors → #1") was measured on exactly this prefix-less
   setup — the reranker is doing the heavy lifting *because* the cosines barely separate.
   - **TODO (tracked — NOT done; the real lever, separate larger work):** add the E5
     `query:`/`passage:` prefixes. *Expected impact:* spreads the cosine distribution, makes a
     meaningful `ragMinSimilarity` floor possible again, and reduces how much the reranker must
     carry. It requires **RE-EMBEDDING the whole corpus** (every stored vector changes), so it is
     its own migration phase — do NOT bundle it with a reranker tweak. See §12.1 R3 + §10 (the
     Phase-30 Track B revisit trigger).

2. **The reranker scores the leading N approx-tokens of each chunk.** N is the doc truncation cap.
   Before RAG-N3 (full audit 2026-06-28) N = 320 while chunks are 500 approx tokens, so the last
   ~36 % of every chunk — a key sentence in a chunk's second half — was invisible to the reranker,
   and that truncated score drove BOTH final ordering AND the dedup-by-page winner (`rag/index.ts`).
   **RAG-N3 (owner decision (a)) raised N to the whole chunk window
   (500 = `CHUNK_DEFAULTS.chunkSizeTokens`)**, so this ceiling is now lifted on the doc side; the
   cost is more per-candidate CPU at rerank time (§12.3, reasoned ~+38 % worst case, not
   re-measured — no provisioned drive in CI/dev). The query cap stays 160 (questions are short). If
   a future chunk size were to exceed the rerank context budget, the constructor clamp
   (`usable − queryCap`) would silently re-introduce this ceiling — keep N ≥ `chunkSizeTokens` or
   re-document. CI pins this: `reranker.test.ts` [RAG-N3] (the whole chunk, incl. its tail, is sent)
   and `rag.test.ts` [RAG-N3] (the dedup-by-page winner now rests on the whole-chunk score).

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

> **PRECONDITION for re-enabling a floor (F13, post-merge audit 2026-06-29):** today
> `rag/index.ts` applies the `minSimilarity` filter **AFTER** the `topKInitial` cosine cut
> (`searchText(question, topKInitial)` then `.filter(score >= minSimilarity)`) — inert at the
> pinned default 0, but the moment the prefix migration re-enables a **positive** floor that
> ordering becomes a **silent recall bug**: above-threshold hits ranked just outside `topKInitial`
> are never considered while below-threshold hits inside it are dropped, so the scan yields fewer
> real candidates than the index could supply. The prefix-migration phase MUST therefore also move
> the floor **before** the cut (over-fetch a larger K → floor → trim, or push the floor into the
> scan). Couple this to that phase; do not ship a positive floor without it.

### 12.2 Decisions (D8–D15, continuing the wave-1 table at D8)

| # | Decision | Resolution |
|---|---|---|
| D8 | Reranker model + license | **bge-reranker-v2-m3** (Apache-2.0 base, HF-API-verified 2026-06-10) — GGUF `gpustack/bge-reranker-v2-m3-GGUF` `bge-reranker-v2-m3-FP16.gguf` (1 159 776 896 B). **FP16, not q8_0** (the recorded b9585 XLM-R q8_0 warmup crash, BUILD_STATE §9). Qwen3-Reranker-0.6B rejected: no official GGUF (HF 401), template-path dependency, slower causal arch. Manifest `role: reranker` with `download` block + approved `license_review` |
| D9 | Sidecar lifecycle | Third **`LlamaServer` composition** (E5 pattern): `--rerank --device none` (CPU pin), lazy start, `stop()` on will-quit / `suspend()` on lock, NO chat args. **Factory default = `null`** (not a mock) ⇒ retrieval byte-identical (graceful-fallback rule). Query-time failure ⇒ log + fused order; start failure ⇒ session latch |
| D10 | Resource budget (8 GB) | ~1.3 GB RSS when active; lazy + opt-in-by-provisioning + CPU-pinned ⇒ 8 GB worst case ≈ 5.3 GB. NOT bundled for TINY. Latency bounded by the candidate cap + per-field truncation (q ≤ 160, doc ≤ **500 = whole chunk window**, raised from 320 by RAG-N3 / full audit 2026-06-28); real numbers in §12.3 |
| D11 | Rerank placement + topKInitial | Between fusion and dedup — dedup keeps the best-by-rerank chunk per page. **`topKInitial` does NOT rise** when a reranker is active (CPU latency linear in candidates; the fused union already reaches ≤ 2×topKInitial; the settings knob remains for tuning) |
| D12 | `minSimilarity` pre- vs post-rerank | **PRE-rerank, cosine-only** (status quo site + meaning): applied to vector hits before fusion. Rerank `relevance_score` is an unbounded logit — never compared to the floor. Keyword hits carry no cosine and bypass the floor by design. R3 measured ⇒ default stays 0 |
| D13 | FTS index shape + sync + fusion | Self-contained `fts5(text, chunk_id UNINDEXED)` (NOT external-content on the implicit rowid — VACUUM foot-gun); 3 sync triggers; guarded additive migration + backfill (scope_json precedent). Fusion = **RRF, k = 60**, sanitized phrase-OR MATCH (`fts.ts` `buildFtsMatchQuery`, shared with conversation search). **Visibility rule: keyword hits require a vector under the active embedder** — `REINDEX_NEEDED_ANSWER` semantics intact |
| D14 | Settings surface | **Availability-driven (embedder precedent): no new `AppSettings` keys, no toggle, no UI.** Hybrid always-on (pure SQLite); reranker active iff binary + weights present; the Phase-18 downloader covers the GGUF |
| D15 | ANN index | **PARTIALLY RESOLVED (perf audit Wave P4, 2026-06-18; extended by full-audit-2026-06-30 P2).** The *re-decode-every-query* half is now fixed: `VectorIndex.search` reads from a **process-resident decoded-vector cache** (`embeddings/resident-cache.ts`) — vectors decoded once, no per-query `vector_blob` re-read, behind the unchanged `search` signature; ranking byte-identical (see architecture.md "Performance — design record … Wave P4"). **P2 (2026-06-30)** then removed the *per-query row marshal* too: on the unscoped path `search` iterates the resident map directly (model-filtered via `modelByChunk`) and skips the `SELECT chunk_id`, ~5×/query at 10k–50k; the scoped scan is unchanged. The scan is **still synchronous + linear** (~580 ms @ the 100k upper bound). An **ANN index stays NOT built** (evidence rule): sqlite-vec/HNSW are native deps against the project theme; no realistic corpus yet outgrows the cached linear scan. The off-main-thread worker scan + ANN remain the upgrade path (P4b/P4c), triggered when a representative corpus measures the cached main-thread scan over ~100 ms routinely |

### 12.3 Resource budget (8 GB machines) + measured validation

Reranker ≈ **1.3 GB RSS** when active (F16 1.16 GB + ctx 2048); worst case alongside
4B chat (~2.6 GB) + E5 (~0.35 GB) + Electron (~1 GB) ≈ 5.3 GB — workable because the
reranker is lazy, CPU-pinned, and opt-in by provisioning — it IS in the DIY `prepare-drive
--with-assets` default fetch set, but is flagged `bundled_on_preconfigured_drive: false`
(advisory/unused in code) so a sold/commercial preconfigured drive does not ship it; manifest
`recommended_min_ram_gb: 6`, profiles LITE/BALANCED/PRO). CPU latency bounded by the
candidate cap (≤ 2×topKInitial) + the per-field approx-token truncation (§12.4).

**Measured 2026-06-10 (`HILBERTRAUM_RERANK_SMOKE`, real F16 GGUF on b9585, Intel i7-1185G7,
`--device none`, 4 threads):** the F16 GGUF LOADS clean (no q8_0 XLM-R warmup crash);
relevance is correct (relevant invoice line **+8.82** vs irrelevant **−11.01**);
**worst-case latency ≈ 24.7 s** for a 12-candidate batch at the *then-current* truncation budget
(160 + 320 approx-token query+doc, ~670 tokens/input for English). That worst case is
~2 s/candidate — significant on a CPU pin, so reranking visibly lengthens a documents query on a
low-end laptop; the candidate cap keeps it bounded, and it stays opt-in by provisioning.
Tightening `MAX_DOC_APPROX_TOKENS` / the candidate cap is the lever if the latency proves too high.

**RAG-N3 update (full audit 2026-06-28, owner decision (a)).** The 24.7 s above AND the
"rescued #3→#1" validation below were both measured under the OLD **320**-token doc truncation. The
doc cap is now the **whole chunk window (500 approx tokens, `CHUNK_DEFAULTS.chunkSizeTokens`)** so the
reranker scores every chunk in full (RAG-N3 — a discriminating sentence in a chunk's tail was
previously dropped before scoring, under-ranking the chunk and skewing the dedup-by-page winner).
Per-candidate input grows ~480→660 approx tokens (~1.38×); CPU prefill is ≈linear, so the absolute
worst case (12 full-500-token candidates) is **reasoned at ~34 s — NOT re-measured** (no provisioned
drive in CI/dev; the §12.3 quality fixture is env-gated). Latency stays bounded by the candidate cap
and opt-in by provisioning; `MAX_DOC_APPROX_TOKENS` / the candidate cap remain the levers. **n_ctx is
safe:** (160 + 500) × `REAL_TOKENS_PER_APPROX_TOKEN` (2.2) ≈ **1452 real tokens < the 2048 context and
the 2048 physical batch**, and the constructor clamp (`usable − queryCap` ≈ 754 ≥ 500) guarantees it.

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

### 12.4 Token-aware sidecar input truncation + vector-codec hardening (backend audit 2026-06-27)

**The contract (EMB-1 / MAINT-2).** The two free-text llama-server sidecars — the E5 embedder and
the reranker — truncate every input to fit the context **before** sending, measured by
`approxTokenCount`, which charges space-less CJK/Thai ~1 token/char and an over-long glued run by
length. The reranker formerly used a naive whitespace word split (`text.split(/\s+/).slice(...)`),
so a space-less passage was a **single "word"** and was never truncated: it overflowed `n_ctx`,
llama-server returned HTTP 500, and `rag/index.ts` caught it and silently kept the fused order — a
**no-op reranker on those scripts**. Both subsystems now share one helper, `runtime/context-budget.ts`
(`REAL_TOKENS_PER_APPROX_TOKEN = 2.2` worst-case multilingual factor, `maxInputApproxTokens(ctx)`,
`truncateToContext(text, ctx)`), so they cannot diverge again. The reranker's per-field caps
(query ≤ 160, doc ≤ **500** approx tokens — the whole chunk window, raised from 320 by RAG-N3 / full
audit 2026-06-28; combined ≈ **1452** worst-case real tokens < 2048) are **derived from the context
budget in the constructor**, so they can never exceed `n_ctx` even if a smaller context is configured.
The fused-order fallback stays as a backstop but now rarely fires.

**Vector codec (EMB-4 / MAINT-5 + DATA-2).** `embeddings/codec.ts` asserts the host is
**little-endian at module load** (the BLOB encoding is locked LE Float32, spec §6 — a big-endian
host would silently corrupt every vector, so it fails loudly at startup instead). `decodeVector`
now returns **`Float32Array | null`**: a physically truncated `vector_blob` (`length < dimensions*4`,
e.g. a partial write) or a non-positive `dimensions` yields `null` so **every** caller skips the row
uniformly — including the two compare-path decodes (`doctasks/handlers/compare.ts`; moved there by DX-1, architecture.md §38) that previously threw a
`RangeError` and failed the whole compare task. The guard is one cheap length comparison, negligible
on the hot resident-cache vector scan (§12 / D15). Tests: `reranker.test.ts` (CJK > ctx still
reranks, no 500 fall-through), `embeddings.test.ts` (`decodeVector` truncated → null; resident-cache
scan skips the bad row), `doctasks-compare.test.ts` (a truncated stored vector → the compare
completes, not a thrown task) — all teeth-verified.

## 13. Collection-scoped retrieval & composite scope — design record (document organization, Phases A–F)

_The retrieval/scope half of the document-organization layer. The **data model, IPC, and audit**
layer is in [`architecture.md`](architecture.md) "Document organization — design
record" (§1–§8; the Phase-F filing-suggestion engine documented there was removed 2026-06-15);
this section is **how a chat's chosen sources become a retrieval filter**. Condensed
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

**`includeArchived` parity now regression-tested (RAG-N6, full audit 2026-06-28).** Because both
`corpusNeedsReindex` and retrieval route through the shared `buildScopeFilter` (which adds the
document-level archived `NOT EXISTS` whenever `includeArchived` is falsy), an **all-archived scope** is
already diagnosed correctly. `rag-scope.test.ts` pins it with teeth: a single archived doc embedded
under a *different* model, scoped with `includeArchived:false`, answers `NO_DOCUMENT_CONTEXT` (the
archived doc is out of scope, so the corpus is empty — re-index wouldn't help), and flips to
`REINDEX_NEEDED` only with `includeArchived:true` (then it is in scope and invisible to the embedder).
Neutering the archived exclusion in `buildScopeFilter` flips the false case to a stale "needs reindex"
misdiagnosis — the test fails, confirming the parity is load-bearing.

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
that cite the old plan's "§3.x/§4.x/§5.x" map here: §3.1/§3.2/§3.5→§14.2, §3.3→§14.5, §4.1→§14.3,
§4.2→§14.5, §4.3→§14.6, §4.4→§14.5, §4.5→§14.4, §5.1 (IPC)→§14.4 (coverage) & §14.5 (listAll),
§5.2 (renderer)→§14.4.** The
data tables live in [`db.ts`](../apps/desktop/src/main/services/db.ts); everything inherits whole-file
encryption. Summaries, the content cache, extraction records, and node vectors are **content** — never
logged or audited; audit events stay ids/kinds/counts._

> **Skills remediation wave (2026-07-02) touched this machinery** — the coverage-honesty, budget, and
> gate changes are recorded in [`architecture.md`](architecture.md) §39: **W1** (audit §2.2) added the
> in-prompt partial-document notice, the 1.5 German-subword whole-doc/compare budget divisor, char-based
> (KMP) chunk de-overlap, and the tree-ceiling `coverage.truncated` flip; **A3** (audit §8.2) inverted the
> whole-doc gate so an `analysis:`-mode skill over a fully-chunked scope defaults to this engine
> (`isNeedleShaped` downgrades to top-k only when the whole-doc read would truncate); **R4** (audit §5.1)
> made the symmetric-compare pair deterministic (A/B by import date). See §39's §-anchor legend for the
> `audit §N.M` mapping.

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
  tree down explicitly. `idx_tree_edges_child` (compound, on `(child_id, child_is_chunk)`) gives the
  reverse chunk→node / node→node lookup (L5).
- **`summary_cache`** — `(content_hash, model_id)` PK → `summary_text` plus the node-vector columns
  `embedding_blob`/`embedding_model_id`/`dimensions` (NULL until the first symmetric compare embeds
  them — §14.6) and `created_at`. Separate from
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
`chunk_index` order) into groups bounded by `summaryBudgetWords(contextTokens)` (the same per-call word
budget the summary windower uses — dynamic, not a named constant; Q5), summarizes each group into **one
fresh level-1 node**, and recurses over node summaries to a single root. Cost is **O(n) chat calls**
paid once — the node count is `estimateNodeCount` over the level-1 groups and the branching factor, so it
scales with context-window size (roughly 50–300 nodes for a 1000-chunk doc at typical 4k–8k context) —
**zero embeds at build time** (node vectors deferred — §14.6).
- **Provable termination [vuln-scan-2026-06-21 HIGH_BUG]:** the level-by-level `for(;;)` reduces until one
  root group remains, so it must shrink each level. `summaryBudgetWords` is floored at 200 words, but a
  node summary is capped at `SUMMARY_OUTPUT_TOKENS`(512) — so at a tiny `contextTokens` a single summary
  can **exceed** a budget window, and the old "a child is far below the budget" assumption was false: the
  upper levels never reduced (each over-budget summary sat alone), looping forever and issuing unbounded
  `generate()` calls that **permanently blocked the single-slot doc-task queue**. Fix: `groupByBudget`
  takes a `minPerGroup`; the **node-reduction levels (≥2) pass `minPerGroup=2`** so every group bar a final
  remainder holds ≥2 children and the node count **strictly shrinks regardless of summary size** — the
  build halts in ≤`leaves.length` levels. Level 1 (chunks→summaries, which may legitimately be 1:1) keeps
  `minPerGroup=1` and runs exactly once. A backstop guard (`TREE_BUILD_NO_PROGRESS`) + a `maxLevels` cap
  turn any future regression into a clean task failure instead of a hang. Independently, **`updateSettings`
  clamps `contextTokens` UP to a 2048 floor** (`MIN_CONTEXT_TOKENS`, settings.ts) so a renderer-supplied
  value can't drop the budget below a single summary's size — 2048 always fits ≥2 node summaries + reserve
  in one reduce window.
- **Yielding (H3/H9/H10):** an O(n)-call build cannot block chat. The build commits **one node per
  transaction** and, at each node boundary (synchronous, before the next `generate`), checks the
  **`ModelSlotArbiter`** ([`model-slot-arbiter.ts`](../apps/desktop/src/main/services/analysis/model-slot-arbiter.ts)) —
  the single in-process owner of the one chat-runtime slot. If chat asked for the slot the builder
  **parks on `await arbiter.reacquire()`** (it does **not** return — a returning DocTask is marked `done`
  and never resumes) and continues from the next node in-session when chat's stream ends. Chat's
  `assertChatStreamReady` throws `DOC_TASK_BUSY_MESSAGE` only for a non-yielding active task; for a
  yielding `tree`/`extract` build it returns, and `withChatStream` then calls `acquireChatSlot()` (its
  optional `acquireSlot` arg) which sets `pauseRequested` and **awaits** the builder's handoff before
  claiming the slot (the guard branches on the running task's **kind**). One slot, one synchronous
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
(the private `summarizeFromTree`, called by `runSummary` when a ready tree exists; the tier is parsed
from the `summary` task `params.tier` in `startDocTask`, no-arg = Tier 1, unchanged):
**Tier 1** = stored root verbatim (**0** calls, M1 — the one-click summary serves the ready tree root
with `truncated:false`); **Tier 2** = one reduce over the root's children; **Tier 3** = all level-1
nodes reduced in batches bounded by **node count**, not document size. All tiers cover the whole document.
The renderer surface (`CoverageMeter`/`TierMenu`, the PreviewModal meter+selector+provenance, the chat
"most relevant passages" relevance label, the "Build deep index"/"Re-index first" row action) honours the
forbidden-UI-words policy: "deeply indexed"/"sections"/"passages", never chunk/node/tree/vector jargon.

**Tree-answer citations are whole-document LEAF PROVENANCE, not inline-grounded `[Sn]` excerpts (F11,
post-merge audit 2026-06-29).** A `mode:'tree'` answer ([`whole-doc-tree.ts`](../apps/desktop/src/main/services/rag/whole-doc-tree.ts)
`answerWholeDocFromTree`) map-reduces over **node summaries** — its prompt carries **no** `[Sn]` excerpt
markers and the model emits no inline `[Sn]` — yet it persists a citation for **every reachable leaf
chunk** (`documentLeafProvenance`, up to ~1000). So a tree answer's Sources are "the answer was derived
from the whole document, here is all of it", a **deliberate coverage choice** (M2: node summaries are
derived context, never citations) that is **distinct from the `generateGroundedAnswer` contract**, where
each `[Sn]` is a labelled excerpt the model was actually shown and cited 1:1.

**Renderer differentiation — AS BUILT (full-audit-2026-06-29 follow-up, Phase 5 — FE-B / F11 renderer
half).** The two are no longer presented identically. [`SourcesDisclosure`](../apps/desktop/src/renderer/chat/SourcesDisclosure.tsx)
now takes the answer's `coverage.mode` (threaded from `Transcript`/`MessageBlock` via `m.coverage?.mode`,
and from the PreviewModal via `cov.coverage.mode`). Any **whole-document mode** (`tree`/`capped`/`extract`
— i.e. `mode != null && mode !== 'relevance'`) renders as **provenance**, not inline citations:
- the toggle relabels from `chat.sources.toggle` ("Sources (N)") to `chat.sources.wholeDoc` ("Drawn from
  the document — N sections"). The wording is **breadth-neutral on purpose** — the `CoverageMeter` beside
  it already owns the breadth claim ("whole document" / "beginning" / "partial"), so the disclosure must
  not restate it (and "whole document" would be wrong for a truncated `capped` answer). **Divergence from
  the audit's literal "Drawn from the whole document" example, deliberate:** dropping "whole" keeps the
  label honest across every non-relevance mode and non-duplicative with the meter.
- each card drops the `[Sn]` `cite-label` (which reads as a 1:1 inline citation) and the list carries a
  quiet "Sections covered" caption (`chat.sources.wholeDocCaption`).
- the rendered cards are **capped at 24** (`PROVENANCE_CARD_CAP`); the held-back tail is reached via an
  "and N more sections" reveal (`chat.sources.more`) so a ~1000-leaf answer neither misleads ("the model
  cited 1000 passages") nor janks.
A `relevance` answer — and a pre-migration **NULL-coverage** turn (`mode` undefined) — is **byte-identical
to before**: "Sources (N)", every card 1:1, with `[Sn]` labels. The **persisted leaf list is left uncapped**
(`documentLeafProvenance` server-side unchanged) — the render cap alone meets the honesty + jank goals, and
keeping the full provenance persisted avoids a persisted-data semantics change (the full set stays available
to the PreviewModal and future features). FE-D in the same pass wired `aria-controls`/`role="region"` onto
this disclosure (and the live Thinking + SummaryMarker disclosures); see design-guidelines §11.3.

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
  `buildScopeFilter(scope, 'document_id')` (M3 — membership/id UNION + archived exclusion), **0** model calls;
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
- **"Whole document" wording gate (RAG-1, backend audit 2026-06-27):** `buildListingAnswer` says
  *"across the whole document"* only when **`fullyChunked && scannedChunks >= totalChunks`** — i.e. the
  chunking invariant holds AND every in-scope chunk actually carries a `__scan__` marker. `fullyChunked`
  alone proves "stored chunks are complete," NOT "we scanned every in-scope document": in a multi-document
  scope where extraction ran on only some docs, `fullyChunked` is true but `scannedChunks < totalChunks`,
  so the wording honestly falls back to *"across N sections scanned"* (the over-claim H7 forbids). A
  single fully-extracted document still satisfies both conditions, so its wording is unchanged.

### 14.6 Symmetric compare + lazy node vectors (Phase 4, plan §4.3/§3.1, H4/H5/H8/L6)

Node vectors are **NULL** after the Phase-1 build; **Phase 4 — symmetric compare — is their first and
only consumer**, so they are embedded **lazily** here, the first time a compare needs a tree's nodes.
[`compare.ts`](../apps/desktop/src/main/services/doctasks/compare.ts) now distinguishes four modes:
- **(d) diff-driven** (compare-diff record, architecture.md §20; the PRIMARY path for a version pair) —
  a deterministic Myers **word-level diff** (`services/diff`, `wordDiff`) over both full texts. Runs only
  when the pair is SIMILAR (`isPreciseDiffUseful`: some shared content, changed fraction ≤ 0.5); a
  rewrite / too-large / too-different pair returns null and falls through to (a)/(b)/(c). Identical docs
  short-circuit to a model-free "textually identical" report; a real change set materializes a
  deterministic **redline** (`renderRedline`) above a model interpretation of just the changes
  (`compareDiffPrompt`) — the model never eyeballs two walls, so a one-word change can't be missed. The
  chat compare (`grounded-whole-doc-compare`) has the mirror read `retrieveCompareDiff` in
  [`rag/index.ts`](../apps/desktop/src/main/services/rag/index.ts): it reads both docs whole (no cap →
  honest whole-document coverage, no page-2 truncation), feeds the changes+redline via
  `buildCompareDiffPrompt`, and cites the chunks where the changes are.
- **(a)** both full texts fit one pass — the existing single call over both, already symmetric.
- **(c) symmetric both-trees** — when BOTH docs have a `ready` tree under the same active embedder AND
  the smaller doc has ≤ `SYMMETRIC_COMPARE_CALL_CEILING` (24) level-1 sections. Align each tree's
  **level-1 nodes** as non-overlapping sections by **node-vector cosine** (`alignNodes`, **greedy
  mutual-best-match** with a **swap-invariant** tie-break — the canonical pair key — above
  `SYMMETRIC_MATCH_MIN_SCORE`), diff each aligned pair with one `generate` call (Same/Different/Only-A/
  Only-B), attribute unmatched-A→Only-A and unmatched-B→Only-B **with no model call** (their node
  summaries are fed as notes — M2, never `[Sn]` citations), then one reduce into the four-section report.
  **Acceptance — the mirror property:** swapping A and B yields the mirror-image diff (Only-A ↔ Only-B
  swap; Same/Different stable). The diff/reduce live in the compare handler
  (`doctasks/handlers/compare.ts`, `runCompareSymmetricTrees`; moved there by DX-1, architecture.md §38);
  the **pure `alignNodes`** lives in `compare.ts` so the mirror is unit-testable without the model.
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

### 14.9 Per-message coverage is now data-driven (D48; 2026-06-19)

The coverage meter (§14.4) was computed for the analysis modes but **not persisted on chat messages** —
the renderer hardcoded `mode:'relevance'` for every citation-bearing answer. As of the full-doc-skills
work it is real: `messages.coverage_json` (nullable, additive) carries a `CoverageInfo` per message,
`appendMessage` serializes it tolerantly (NULL on fault) and the renderer falls back to `relevance` when
NULL — so every legacy/relevance turn renders byte-identically, while an exhaustive turn records and shows
its true breadth. This is what makes "if we analysed the full document, show that" expressible.

The first consumer is the **`kind:tool` skill analysis path**: a tool skill answers a plain chat question
**exhaustively** from its whole-document tools (the §8 run seam) over a single, **fully-chunked** doc, and
stamps a real `{ mode:'extract', chunksCovered=chunksTotal, chunksTotal, fullyChunked }` (the same
`fully_chunked` invariant as §14.1); when the doc isn't fully chunked it **refuses** rather than answering
partially (no breadth claim → NULL coverage → the relevance fallback). The seam, the routing/refuse gate,
and the bank + invoice adopters are recorded in [`architecture.md`](architecture.md) "Skills — design
record" §19 (D44–D49); this subsection is the coverage-half cross-link.

### 14.10 Whole-doc analysis truncation fix — chunk map-reduce, adaptive reduce budget, progress notice, continue-generation (2026-07-04/05)

_Condensed from `docs/wholedoc-truncation-fix-plan.md` at its close (2026-07-05, Phase 4); full original —
incl. the diagnosis tables, the notes-first owner deviation rationale, and the worked budget examples — in
git history. This is a distinct **4-phase wave** (its own "Phase 1–4"), not §14's original phases. **§14.10 is
the stable anchor: code/test comments citing `wholedoc-truncation-fix-plan §2/§3/§4/§5/§6` all resolve here
(legend at the end).**_

**The two truncations it fixes.** A `contract-brief`-style `analysis: whole-doc` turn over a multi-page PDF hit
two independent cuts: (1) **input** — an over-budget document with **no deep-index tree** was read from the
**beginning only** (the §20 tree rescue auto-builds only at ~50 pages, so every doc between ~1.5 and ~50 pages
truncated to the beginning and never got a tree — the **"gap band"**); (2) **output** — the reduce reserved a
fixed 1024 output tokens and stamped `truncated` when a 9-section brief overran `n_ctx`. Map-reduce (bounded
input windows) is the answer to both, but pre-fix it was gated behind a tree that never built for mid-size docs.

**Phase 1 — chunk map-reduce closes the gap band (§3).** The fence→pack→map→reduce→stream→persist body was
**extracted from `answerWholeDocFromTree` into the shared core `streamWholeDocMapReduce(input)`**
([`rag/whole-doc-tree.ts`](../apps/desktop/src/main/services/rag/whole-doc-tree.ts)); the tree path is now a
thin pre-model gate calling it with `coverageMode:'tree'` (**byte-identical**, pinned by
`rag-whole-doc-tree.test.ts`). New **`answerWholeDocFromChunks(deps)`** ([`rag/index.ts`](../apps/desktop/src/main/services/rag/index.ts))
runs an on-the-fly map-reduce over the document's **de-overlapped RAW chunks** (`coverageMode:'capped'`),
wired as `viaTree ?? viaChunks ?? (capped floor)` in the `opts.wholeDocument` branch. The de-overlap read is
the single private `readWholeDocumentChunkTexts` (`retrieveWholeDocument` consumes it too). Citations = a
bounded representative sample of REAL leaf chunks (≤ `SUMMARY_MAP_CALL_CEILING`, M2). Share-safe parity: the
chunk path passes `buildShareSafeScanBlock(scan, false)` as `extraReduceBlock` (reduce USER turn, never
system). **Coverage stamp (data contract):** `mode:'capped', truncated:false, chunksCovered===chunksTotal` =
whole-doc via map-reduce (the meter's existing "covers the whole document"); `truncated:true` only on a
> ceiling window count or a notes hard-cut. A doc between the single-read budget and one summary window packs
into ONE window ⇒ the reduce runs directly over the whole document, no map step (no extra latency for the
common small case).

**Phase 2 — adaptive, notes-first reduce budget (§4).** `ANALYSIS_RESPONSE_RESERVE_TOKENS = 3072` (the *desired*
reduce output; `CHAT_RESPONSE_RESERVE_TOKENS = 1024` stays the floor) + a pure, unit-tested
**`computeReduceBudget({contextTokens, fenceTokens, questionTokens, notesTokens})`** size the reduce
`maxTokens` (`reduceOutputCap`) and the notes hard-cut (`reduceNotesBudget`) from the REAL launched context,
inside the shared core (so BOTH paths get it). **Owner-approved policy is NOTES-FIRST** (a deliberate deviation
from the plan's original output-first clamp): the output reserve **yields** to the actual notes — it aims for
3072 but shrinks toward 1024 (never below) so a small (4 k) window keeps **whole-document coverage** and only
the *deliverable* shrinks; the notes are hard-truncated (⇒ `truncated:true`) only when even the floor output
leaves no room. **Data contract (model tokens):** `overhead = fence + question + 128`; `available = ctx −
overhead`; `reduceOutputCap = clamp(aim 3072, floor 1024, available − max(notesTokens, 512))`;
`reduceNotesBudget = max(512, available − reduceOutputCap)`; **guarantee** `overhead + reduceNotesBudget +
reduceOutputCap ≤ ctx` at every real window (the HTTP-400 regression guard). `wholeDocumentFitBudgetTokens`
(the single-turn input-budget + needle-downgrade boundary) is UNCHANGED.

**Phase 3 — analysis progress notice (§5).** A multi-window source runs SILENT map calls before the first
streamed reduce token; the shared core fires the existing ephemeral `'analysis'` notice
(`onCompactionStart?.('analysis')` — "Reading the whole document…") **only when `windows.length > 1`** (a real
map loop), placed after the `answerPrefix` token and before the map loop, cleared on the first reduce token.
Threaded through the deps + both whole-doc calls; the grounded-whole-doc IPC path already passed
`sendCompaction`, so no IPC change and no new `CompactionNotice` kind. Single-window / fits-budget / needle /
relevance paths fire nothing. Ephemeral (R14); a callback ⇒ no new handle (SEC-1).

**Phase 4 — continue-generation for over-cap deliverables (§6).** The reduce stream now captures its finish
reason (`onFinish`, mirroring the single-turn grounded path). When a reduce pass ends `finishReason ===
'length'` (a ceiling cut — NOT a user Stop, which fires no finish reason), a **continuation loop** re-prompts
to FINISH: each pass re-sends the SAME reduce USER turn (fence + notes + question + `extraReduceBlock` — "fence
at every step") via `continuationUserPrompt(reduceUser, anchor)` that adds a resume instruction + an `anchor` =
the last `CONTINUATION_ANCHOR_CHARS` (200) chars produced; it streams live via `onToken`, holding back only the
opening until the seam overlap against the anchor is resolved (`seamOverlap` — the longest anchor-tail↔head
match, ≤ the anchor) then emits the DE-DUPLICATED remainder. **Bounds:** `MAX_REDUCE_CONTINUATIONS = 2`
(runaway guard) AND a per-pass no-overflow room guard — the continuation prompt is larger than the reduce
prompt, so its `maxTokens = min(reduceOutputCap, contextTokens − continuePromptTokens)` is sized against the
ACTUAL assembled prompt, stopping (`CONTINUATION_MIN_OUTPUT_TOKENS = 256` floor) rather than assemble a prompt
the runtime rejects. All INSIDE the existing try/catch: a Stop mid-continuation is caught and the accumulated
partial persisted (the aborted pass's partial folded in via a `finally` seam-flush) — never a fresh pass past
the abort. **Stamp decision (data contract):** `Message.truncated = true` is set ONLY when continuation is
EXHAUSTED and the last pass is still 'length' — an honest **OUTPUT**-truncation badge ("Answer truncated…"),
**parity with the single-turn grounded path's `messages.truncated`**, kept STRICTLY separate from
`coverage.truncated` (**INPUT** coverage). The whole document can be covered (`coverage.truncated:false`) while
the deliverable is output-cut (`Message.truncated:true`); a user Stop leaves it false. **Scope:** the shared
reduce core, and — since **follow-up #1** (2026-07-05) — the **single-turn grounded path** too: the continuation
loop was extracted into the shared engine **`continueUntilComplete`** (`whole-doc-tree.ts`), which takes the
whole prior message array (system + history + the grounded/reduce USER turn) and appends the resume
instruction + anchor to its last user turn, so `generateGroundedAnswer`'s stream (relevance top-k, the
small-doc fits-budget read, and the whole-doc capped read) finishes a 'length'-cut answer the same way,
stamping `Message.truncated` only when the cap is exhausted. `withContinuation` (append the resume hint to the
last user turn) + `seamOverlap` (the dedup) are the shared primitives; the room guard sizes each pass against
the ACTUAL assembled prompt so history + the grounded block never overflow `n_ctx`.

**Invariants preserved across all four phases (plan §2).** SEC-1 capability ceiling (pure DB reads + the chat
runtime, no new handle); the SKILL.md fence rides every map/reduce/continuation USER turn, never the system
prompt; coverage honesty (`truncated:false` only when the whole doc was processed — a ceiling cut or notes
hard-cut ⇒ `truncated:true`, INPUT); `[Sn]` citations are real leaf chunks (M2); needle-downgrade + relevance
paths byte-unchanged; the abort/Stop contract (a Stop before the first reduce token ⇒ `emptyAssistantMessage`;
a Stop mid-stream/mid-continuation ⇒ the partial persisted, never a second capped pass); and `prompt + outputCap
≤ n_ctx` at every context size (no HTTP 400).

**Follow-up #2 — hierarchical fold for the large-document tail (2026-07-05).** The map-call ceiling used to
drop the tail of any document past `SUMMARY_MAP_CALL_CEILING` (~12 windows ≈ ~50 pages). #2 raises the reach:
up to **`SUMMARY_MAP_CALL_HARD_CEILING`** (= `SUMMARY_MAP_CALL_CEILING × 2`, ~100 pages) windows are mapped,
and when the window count exceeds the single-level ceiling the per-window notes are **condensed** down through
bounded fenced intermediate reduces (`foldUserPrompt`, the fence riding each — §2) until the joined notes fit
alongside at least the floor output (so the reduce's notes-cut does not bind ⇒ `truncated:false`, whole
document covered). The fold loop is bounded by **`MAX_FOLD_DEPTH`** (each level shrinks the notes ~fan-out-fold,
so a hard-ceiling document converges in 1–2 levels); a residual overflow after the depth cap falls to the
existing notes hard-cut (honest `truncated`). The ≤ ceiling path is **byte-identical** to pre-#2 (single-level
join → reduce). Beyond the hard ceiling the tail stays honestly beginning-only — deep-index **tree** territory
(the tree auto-builds at ~this size and is the designed rescue; the fold is a deliberately-bounded query-time
lever, not unbounded — the dominant cost is one map call per window on CPU, covered by the Phase 3 progress
notice).

**Residuals** (see `known-limitations.md`): a document beyond the **hard** ceiling (~100 pages) is still
beginning-only (INPUT, tree territory); a deliverable long enough to still be cut after the 2-cap keeps the
honest OUTPUT-truncated badge; 2–24 map calls (+ fold) of latency on a large analysis (with the Phase 3
affordance). Tests: `rag-whole-doc-mapreduce.test.ts` (Phase 1 reach + Phase 2 `maxTokens` + Phase 3 notice +
Phase 4 continuation/dedup/cap/abort + #2 fold-coverage/hard-ceiling), `rag-whole-doc-tree.test.ts` (the hard
ceiling on the tree path), `rag.test.ts` (#1 grounded-path continuation), and
`tests/unit/wholedoc-reduce-budget.test.ts` (pure budget math).

**§-anchor legend (retired plan → here).** `wholedoc-truncation-fix-plan §2` (invariants), `§3` (Phase 1 —
chunk map-reduce), `§4` (Phase 2 — adaptive reduce budget), `§5` (Phase 3 — progress notice), `§6` (Phase 4 —
continue-generation) **all map to §14.10**. Architecture-level summary: `architecture.md` §20 ("Skill-aware
whole-document analysis", "Large documents").

## 15. Context budgeting + conversation compaction — design record (Phases 0–2)

_When a conversation approaches the model's context window, summarize the **older** turns once into a
cached, auditable checkpoint and replay only the recent turns verbatim — instead of silently
**dropping** the oldest turns (the prior `fitMessagesToContext` behaviour). All offline, on the
**already-running** local chat model, **summarize-once-and-cache**, every new path **fail-safe to the
old behaviour**. Condensed from `docs/context-compaction-plan.md` at closeout (2026-06-19); full
original incl. the risk table R1–R14 and open-decision rationale:
`git show 4dca3e3:docs/context-compaction-plan.md`. Cross-ref: [`architecture.md`](architecture.md)
"Chat & streaming" (the chat-pipeline owner). **§15.x anchors are stable — code/test comments that cite
the old plan map here:** §L0/§4.1→§15.1; §4.2/§4.3/R9→§15.2; §4.4/§4.7/R8/R13→§15.3;
§4.5/§4.6/§4.8/R3/R4/R6/R11/R-RAG→§15.4; §5.1→§15.5; §5.2/R14→§15.5; §5.3/D-b→§15.5; §5.4/D-a→§15.5;
the deferred Phase-3 `/tokenize` (D-c) + R7/R10 guardrails→§15.6. **The summary text and the checkpoint
row are content** — model context, never logged or audited; a German chat is summarized in German (R12).
Nothing leaves the device: summarization is a local chat-model call, no new network surface (R12)._

### 15.1 L0 — the context window source of truth (§L0/§4.1, fix G1)

Prompt assembly used to trim against `settings.contextTokens` (default 4096), but the sidecar is
launched with `manifest.recommendedContextTokens || settings.contextTokens` as `--ctx-size` — the two
can diverge, so we trimmed to the wrong window (too-tight wastes capacity; too-loose risks the 400).
Fix: a new **OPTIONAL** `ModelRuntime.contextWindow(): number` accessor
([`runtime/index.ts`](../apps/desktop/src/main/services/runtime/index.ts)) reports the launched window —
implemented on the three production runtimes (`LlamaRuntime` stores `opts.contextTokens`; `MockRuntime`
and the delegating `LadderRuntime` return theirs; fixed for a runtime's lifetime). **Optional on purpose**
(like `contextWindow?()`'s sibling accessors): the ~15 `ModelRuntime` test-literal stubs stay valid, and a
runtime that can't report one degrades gracefully. `RuntimeManager.status()` surfaces it as
`RuntimeStatus.contextWindow?` (absent when not running). The exported helper
`effectiveContextWindow(runtime, settings)` ([`chat.ts`](../apps/desktop/src/main/services/chat.ts)) =
`runtime.contextWindow?.() ?? settings.contextTokens` (falls back when unreported/≤0); both
`generateAssistantMessage` and `generateGroundedAnswer` budget through it. `assemblyBudget = window −
CHAT_RESPONSE_RESERVE_TOKENS` (reserve = 1024, unchanged). For the shipped Qwen models
`recommendedContextTokens` IS the launched window, so the budget is unchanged today — this just stops
trimming against the wrong number and gives L2 the authoritative window.

**Relevance-path excerpt budget clamped to the window (2026-07-01, fix G1-follow-up).** The history
assembly above trimmed against the real window, but the RELEVANCE (top-k) path sized its retrieved-excerpt
block only by the fixed `ragMaxContextTokens` setting (2500) — decoupled from `n_ctx`. On a small-window
model (e.g. `recommendedContextTokens: 4096`) the grounded turn (system + excerpts + per-excerpt framing +
question) could exceed the window, and since `fitMessagesToContext` keeps the FINAL turn mandatory it was
sent unshrunk → llama-server HTTP 400 "exceeds the available context size". `generateGroundedAnswer` now
clamps the excerpt budget to `min(ragMaxContextTokens, retrievalExcerptBudgetTokens(window, …))` before
`retrieve` — mirroring the whole-document path's `wholeDocumentBudgetTokens` (which already clamped). The
helper subtracts the reserve + system prompt + question scaffold + per-excerpt framing and divides by a
`RETRIEVAL_FIT_SAFETY` (1.5) headroom, because the 1.3 tokens/word estimate under-counts subword-dense
(e.g. German) text. The clamp is caller-scoped (retrieve()'s loop is unchanged, so a caller that passes an
explicit budget is unaffected); `min()` keeps large-window models at the full 2500 and only constrains
small ones. Teeth: `rag-pipeline-floor.test.ts` asserts a small launched window packs strictly fewer
excerpts than a large one.

### 15.2 Token accounting + the compaction trigger (§4.2/§4.3, R9)

Budgeting uses the cheap word estimate `messageTokens` (`approxTokenCount × CHAT_TOKENS_PER_WORD(1.3) ×
CHAT_TOKENS_PER_WORD_SAFETY(1.5) + 8/msg`, exported from `chat.ts`) — **deliberately biased to over-count**,
the safe direction for a budget. The 1.5 subword-density safety (added 2026-07-01, §15.7) lifts the
effective rate to ≈1.95 real tokens/word so subword-dense German (~1.5–2 tokens/word) can't slip under the
1.3 base and overflow; one estimate feeds the trim, the compaction trigger, AND the usage meter.
`ensureCompacted` ([`chat/compaction.ts`](../apps/desktop/src/main/services/chat/compaction.ts)) triggers
when the **assembled-history** estimate ≥ `COMPACT_THRESHOLD (0.85) × window` **and** at least
`MIN_COMPACTABLE_TURNS (6)` turns sit older than the protected `KEEP_RECENT_TURNS (6)` tail. Below
threshold ⇒ **no model call** (the common path stays free). **R9 — estimate error at the boundary is
benign:** over-counting only triggers *earlier* (one wasted local summarization, harmless) and the L1
`fitMessagesToContext` floor still guarantees fit if we trigger late. The constants are the §4 starting
points (D-d: golden-trace tuning deferred). Phase 3's `/tokenize`-exact count near the boundary was
**deferred** — see §15.6.

### 15.3 L2 — the compaction pre-pass + checkpoint persistence (§4.4/§4.7, R13/R8)

`ensureCompacted(db, runtime, conversationId, window, {signal, onStart})` is awaited inside BOTH
chokepoints (`generateAssistantMessage`, `generateGroundedAnswer`) right after the window is resolved and
**before** assembly. Algorithm: load the turns newer than the last checkpoint; estimate the **assembled**
view (existing summary-pair tokens + post-checkpoint turns); if under threshold or too few → return;
else summarize the region older than the protected tail (folding the prior checkpoint summary in for
**chained re-compaction**, §4.7) and persist **one** checkpoint.
- **Summarize-once guarantee:** estimating the *assembled* view means a fresh checkpoint drops the next
  turn below threshold, so the summarizer is not called again until enough NEW turns re-cross it (a single
  rolling checkpoint, never an unbounded stack).
- **Persistence (R13, additive/idempotent migration in
  [`db.ts`](../apps/desktop/src/main/services/db.ts)):** `ensureColumn(messages,'kind')` (NULL|`'message'`
  |`'compaction'`; NULL-sentinel = a plain message, so old DBs read correctly) + `covers_through_rowid
  INTEGER NULL` (the max `rowid` the summary subsumes). A checkpoint is one `kind='compaction'` row
  (role `system`, `skill_id` NULL) holding the summary in `content`. The message-table SQL stays in
  `chat.ts` (the existing `listMessages`/`appendMessage` owner — least-disruptive deviation from the plan's
  letter, which suggested `db.ts`): `getLatestCheckpoint`/`writeCheckpoint`, the rowid-aware kind-filtered
  `listConversationTurns(db, convId, afterRowid)`, and a `kind IS NOT 'compaction'` filter on
  `listMessages` so the renderer/export/fence-sizing auto-skip checkpoints. `writeCheckpoint` deliberately
  does NOT bump `conversations.updated_at` (internal context, not a user action).
- **R8 — keep checkpoints out of search/export:** the `messages_fts_ai` AFTER INSERT trigger carries
  `WHEN new.kind IS NOT 'compaction'` (fresh DBs); `ensureMessagesFtsKindFilter` idempotently rewrites the
  trigger on a pre-feature DB and prunes any already-indexed checkpoint row; the FTS backfill SELECT is
  also kind-filtered.

### 15.4 Summary representation + the summarizer call (§4.5/§4.6/§4.8, R3/R4/R6/R11/R-RAG)

**Template-safe representation (§4.5, R3):** the summary is injected at assembly time as a synthetic
`user → assistant` pair (`COMPACTION_SUMMARY_INTRO` "Here is a summary of our earlier conversation so
far: …" → `COMPACTION_SUMMARY_ACK` "Understood — I'll continue with that context in mind.") at the start
of the retained window, NOT as a second mid-history `system` block (several local templates accept only
one leading system block, and `collapseToAlternating` assumes leading-system-then-strict-alternation).
The pair is **constructed at assembly only, never persisted and never skill-stamped** (R3); the leading
**system prompt stays byte-stable** so its `cache_prompt: true` KV prefix is reused (it shifts for exactly
one turn after a new checkpoint — accepted, that turn already paid for summarization). `buildChatMessages`/
`buildGroundedChatMessages` inject the pair + replay only `rowid > coversThroughRowid` turns when a
checkpoint exists; byte-identical to before when none does.
- **The summarizer call (§4.6):** reuses the active runtime as a plain sequential `chatStream` call on the
  already-claimed slot, run **before** `withChatStream` opens the answer stream — so it is *part of* the
  chat turn, not a competing DocTask, and cannot deadlock the model-slot arbiter (R4). Config:
  `mode:'balanced'` (⇒ `enable_thinking:false`; a non-thinking model just ignores the kwarg — R11),
  explicit `temperature:0.2` + `maxTokens:700`. When the input overflows the summarizer's own window it
  map-reduces over `packIntoWindows`/`summaryBudgetWords` (reused from `doctasks/summary.ts`, §4.7) so a
  chained re-compaction can never itself overflow.
- **R-RAG — the RAG path** builds the checkpoint from the **stored raw turns**, never the transient
  grounded prompt; the live final grounded turn (the question + `[Sn]` citations) is untouched and stays
  mandatory in `fitMessagesToContext`.
- **The prompt (§4.8, R6):** `selfSummaryPrompt` is an exported English constant (internal context — the
  summary *content* comes out in the conversation's language). Structured sections act as a preservation
  checklist; explicit "copy identifiers/numbers/`[Sn]` exactly" + "write 'unclear' rather than guess" rules
  + low temperature + the §15.5 marker (the user can read/verify the summary) guard against a hallucinated
  fact poisoning every later turn (R6). The dev-time golden-trace LLM-as-judge eval gate is deferred with
  the constant tuning (D-d).
- **Fail-safe (R4/R6):** any summarizer failure or abort ⇒ NO checkpoint, no user-visible error, the turn
  proceeds via the unchanged L1 floor. A cancel mid-summary abandons it and releases the slot via the
  existing `finally`.

### 15.5 UX — meter, "summarizing…" notice, transcript marker, settings toggle (§5.1–§5.4, R14, D-a/D-b)

All user-visible strings go through `shared/i18n` (en + de, parity test enforced); internal prompts stay
English (R12).
- **Context meter (§5.1).** `ContextUsage {usedTokens, window}` (`shared/types.ts`) +
  `getConversationContextUsage(db, runtime|null, convId)` — a pure read that assembles via
  `buildChatMessages` over `effectiveContextWindow` (falls back to `settings.contextTokens` with no
  runtime) and sums `messageTokens`. Surfaced through the resting IPC `getConversationContextUsage`; the
  renderer refreshes on conversation switch + after each completed turn. `renderer/chat/ContextMeter.tsx`
  is a thin composer-footer bar: calm <75% / amber 75–90% / near-full ≥90%, tooltip "Context: 6.4k / 8k
  tokens (approximate)" + a will-summarize line in the amber band. **Labelled approximate** (it reflects
  the over-counting estimate — honesty over false precision). **Deviation (documented):** §5.1 offered the
  usage on `STREAM.done` OR a resting IPC; chose the resting IPC for BOTH surfaces (the renderer awaits the
  invoke + re-reads history and never consumes `onDone`; `done` is the locked `Message` contract — left
  untouched). **Enhanced 2026-07-01 (§15.7):** the bar now carries an **always-visible %** (aria-hidden;
  the progressbar's `aria-valuetext` still reads the tokens) and updates **live** while an answer streams —
  `ChatScreen` derives `liveUsage` = the resting read + the in-flight user turn estimate + a running
  `estimateLiveTokens(streamText)`, then reconciles to the authoritative resting read in the stream
  `finally` (the try-side refresh moved there so a partial/stopped reply also settles, with no double-count).
- **"Summarizing…" notice (§5.2, R14).** `STREAM.compaction(requestId)` → `CompactionNotice {phase:'start'}`
  (`shared/ipc.ts`) mirrors `STREAM.scope`. `withChatStream` gained a 4th `runFn` arg `sendCompaction` (a
  `SendCompaction` notifier beside `sendToken`/`sendReasoning`): isDestroyed-guarded but **never written to
  `streamBuffers`** (R14 — ephemeral; a remount may miss it, accepted). Both IPC handlers pass it as
  `onCompactionStart` (`registerRagIpc` only on the grounded path — the refuse/listing runFns make no model
  call). Preload `onCompaction` mirrors `onScopeNotice`; `ChatScreen` shows a quiet status line above the
  streaming bubble and clears it on the first answer token (+ in `finally`).
- **Transcript marker (§5.3, D-b — expandable, for auditability).** `ConversationSummaryMarker {summary,
  beforeMessageId}` + `getConversationSummaryMarker(db, convId)` (main computes `beforeMessageId` = the
  first rendered turn with `rowid > coversThroughRowid`, since `Message` carries no rowid; null with no
  checkpoint or when compaction is off). Resting IPC `getConversationSummary`; `Transcript` renders an
  expandable `SummaryMarker` (the SourcesDisclosure pattern) before that message, reading the checkpoint
  text so the user can confirm context was condensed, not lost.
- **Settings toggle (§5.4, D-a — default ON).** `AppSettings.chatCompactionEnabled` default **true** (the
  defaults-merge IS the migration — no schema change; silent drop-oldest is strictly worse than a visible
  summary). `compactionEnabled(db)` gates BOTH the `ensureCompacted` pre-pass AND the checkpoint READ in
  assembly + the marker reader — **chosen behaviour: when off, any existing checkpoint is ignored and the
  FULL history replays (pure L1) = byte-identical to the pre-feature app.** An explicit user
  `contextTokens` cap is always respected (`effectiveContextWindow` only ever falls BACK to it).

### 15.6 Deferred — Phase 3 `/tokenize` (D-c) + the R7/R10 guardrails

**Phase 3 (`/tokenize`-backed exact counts near the threshold, cached on the unused `messages.token_count`
column) was deliberately NOT built** (decision 2026-06-19, confirming D-c). Rationale: the word estimate
is safe-biased (R9) — over-counting only summarizes early (harmless) and the L1 floor guarantees fit if it
triggers late — so Phase 3 only earns its keep if the threshold proves *jumpy in real use*, which has not
been observed (the feature is not yet in real use). It also is not truly free: llama-server's `/tokenize`
does **not** apply the chat template, so even the "exact" path would tokenize per-message content + a
per-message overhead constant, trading a known safe over-count for a new approximation plus an HTTP
round-trip and a new optional interface method. Revisit only if the boundary proves jumpy in practice.
`messages.token_count` remains written NULL.

**Guardrails noted (not yet code, no triggering feature exists):**
- **R7 — stale checkpoint on edit/delete.** If a future message-edit/delete feature mutates a turn at/below
  a checkpoint's `covers_through_rowid`, the summary may describe content that no longer exists. The fix
  when that feature lands: invalidate (delete) checkpoints whose covered range intersects the change; the
  next over-threshold turn re-summarizes. (The app has no edit/delete-history feature today.)
- **R10 — a single oversized turn.** Summarizing *older* turns can't shrink one giant pasted turn;
  unchanged from before — `fitMessagesToContext` keeps the final turn and the runtime's 400 path surfaces
  the friendly "too large for this model" message. Head+tail truncation of a giant single turn is out of
  scope.

### 15.7 Honest truncation signal + German safety + live meter % (2026-07-01, from D:\ testing)

Triggered by a D:\ test session (a German chat where later "tell me everything" replies stopped **mid-word**
while an earlier, longer reply completed). Root cause, cross-verified: the balanced/deep path sends **no
`max_tokens`** and the sidecar launches with **no `--n-predict`**, so a reply is bounded only by EOS or by
physically filling `n_ctx` (`finish_reason: 'length'`). As history accumulates the answer's runway
(`n_ctx − prompt`) shrinks, so late-conversation "answer everything" replies overflow — and the app was
**blind to it** (`readChatSSE` only read `delta.content`), persisting the partial as if complete. Three
independent fixes:

- **Honest signal (L0).** `parseSseLine`/`readChatSSE` now surface the final chunk's `finish_reason` via a
  new `RuntimeChatOptions.onFinish(reason)` callback (optional; the vision path and the mock are unaffected
  — the mock reports `'stop'` on a clean finish for contract fidelity). `generateAssistantMessage` captures
  it and flags `finishReason === 'length'` → persists `messages.truncated` (additive nullable column via
  `ensureColumn`; threaded through `Message.truncated`, `MessageRow`, `rowToMessage`, `AppendMessageInput`,
  the `appendMessage` INSERT, and the regenerate delete/restore snapshot for byte-faithful restore). A user
  **Stop** aborts before any final chunk, so `finishReason` stays null → the intentional partial is **not**
  flagged. Renderer: a quiet amber `.msg-truncated` note ("Reply cut off — reached the model's context
  limit", `chat.truncated.label`/`.hint`, `role="note"`) with an actionable tooltip. **Scope:** plain chat
  (`generateAssistantMessage`); the grounded doc-answer path is out of scope for this signal.
- **German subword safety (§15.2).** `messageTokens` scales the 1.3 base word rate by
  `CHAT_TOKENS_PER_WORD_SAFETY (1.5)` → ≈1.95 real tokens/word, mirroring the RAG grounded-answer ÷1.5
  German safety (§15.1). The 1.3 base under-counted German (~1.5–2 tokens/word), so the trim kept too much
  history and the real prompt ran larger than estimated — compounding the overflow. One estimate feeds the
  trim budget, the compaction trigger, AND the meter, so German trims/compacts sooner and the meter reads
  truthfully high (English reads slightly high — accepted; the meter is labelled approximate and warns
  before the cliff). All token-math tests are structural/comparative, so the change is regression-safe.
- **Live meter % (§15.5).** `ContextMeter` gains an always-visible percentage (aria-hidden — the
  progressbar `aria-valuetext` still reads the tokens); `ChatScreen`'s `liveUsage` adds the in-flight user
  turn + a running `estimateLiveTokens(streamText)` on top of the resting read so the bar + number climb as
  the answer streams, then reconciles to the authoritative resting read in the stream `finally` (moved there
  from the try so a stopped/failed turn also settles; `liveUserTokens` cleared first, and seeded 0 on a
  regenerate to avoid double-counting an existing user turn).

**Not done here (offered, deferred):** raising the default `contextTokens` above 4096, and a "continue this
reply" affordance on a truncated turn. **The exact `finish_reason`/`usage` capture** (curl the loopback
`/v1/chat/completions`) remains the one measurement that would confirm `length`-vs-`stop` on the original
D:\ transcript; the fix makes the app self-report it going forward. Tests: `llama-runtime.test.ts`
(onFinish length/stop + null-intermediate) and `chat.test.ts` (truncated persist round-trip; clean-`stop`
and user-Stop both unflagged).

### 15.8 Context truth end-to-end: real-usage meter, grounded truncation parity, one window, user context size (2026-07-04 user report)

Triggered by a user report: *"the context display sits at 7% but the context is full — a 5-page PDF hit
the limit almost immediately; is the context different per area? I'd offer a UI option to change the
context size."* All four observations were real seams:

- **The meter under-read document turns by the whole document.** The resting meter (§15.5) sums only the
  PERSISTED history, and the live climb added only the visible user turn + streaming answer — but a
  grounded turn injects the retrieved-excerpt / whole-document block (sized to ~the whole window by
  design), which never persists. So a documents chat could run its window ~full every turn while the
  meter honestly-but-misleadingly showed single digits. Fix: `generateAssistantMessage` /
  `generateGroundedAnswer` / `generateGroundedDataAnswer` gain `onPromptUsage(usage)` — fired once after
  assembly with the REAL assembled prompt's `messageTokens` sum over the launched window (the same
  estimate currency the trim uses). `withChatStream` forwards it on the new ephemeral `STREAM.usage`
  channel (`sendUsage`, R14 posture: isDestroyed-guarded, never buffered), preload exposes
  `onContextUsage`, and `ChatScreen` keeps it as `streamUsage`: while THIS conversation streams, the
  meter's base is the reported real usage (+ the streaming-answer estimate; `liveUserTokens` is ignored —
  the report already contains the user turn), then the stream `finally` clears it so the meter reconciles
  to the resting read. The post-turn drop-back is CORRECT: the excerpt block is per-turn, so at rest the
  window really is mostly free again. Tests: `chat.test.ts` (usage over the launched window),
  `rag.test.ts` (grounded usage strictly exceeds the resting read).
- **Grounded answers now wear the truncation badge too.** §15.7 scoped the honest `'length'` signal to
  plain chat, but a budget-filling document turn is exactly where the ceiling hits. Both grounded
  generators now pass `onFinish` and stamp `messages.truncated` (rag.test.ts: cut-off flagged, clean run
  unflagged).
- **A `max_tokens` cap no longer masquerades as "context limit".** llama-server reports `'length'` for
  BOTH ceilings; a Fast-mode reply that hit `FAST_MAX_TOKENS` (1024) showed "reached the model's context
  limit" at single-digit meter usage — a false "context is full" signal. `generateAssistantMessage` flags
  truncated only when NO cap was in effect (`runtimeOptions.maxTokens ?? requestParamsForMode(mode).maxTokens`
  is null); prompt fitting reserves ≥ the Fast cap of answer room, so with a cap set the cap is what fired.
- **One window for every area.** Doc tasks budgeted against bare `settings.contextTokens` while chat/RAG
  budgeted against the launched window — the literal "different context sizes in different areas". The
  `DocTaskManager.getContextTokens` dep (main/index.ts) now returns `effectiveContextWindow(active, s)`
  when a runtime is up (fallback: the override-aware next-start value).
- **User-settable context size.** `settings.contextTokensOverride` (nullable; DEFAULT null = automatic),
  clamped by `updateSettings` into `[MIN_CONTEXT_TOKENS 2048, MAX_CONTEXT_TOKENS_OVERRIDE 32768]` with
  junk rejected (the null default defeats the generic type check). The chat launch
  (`registerModelIpc.startModel`) becomes `override ?? (manifest.recommendedContextTokens ||
  settings.contextTokens)` — before this, the manifest ALWAYS won, so the `chat.truncated.hint` copy
  ("raise the context size on the AI Model screen") pointed at a control that neither existed nor would
  have had any effect. The AI Model screen gains the "Context size" card (`CONTEXT_SIZE_PRESETS`
  4k/8k/16k/32k + Automatic; applies at the next model start, restart note while one runs);
  `effectiveContextWindow`'s no-runtime fallback and the Settings→Workspace display are override-aware
  (the latter shows "Automatic (model default)" instead of a number nothing uses). Larger windows cost
  KV-cache RAM + prefill time — hence the bounded presets and the ceiling. Tests:
  `settings-context-override.test.ts` (round-trip/clamp/junk), `chat.test.ts` (fallback precedence).

**Also answered for the report:** context is **per conversation** (assembly replays only
`conversationId`'s history — nothing accumulates across chats), and the 5-page-PDF limit is real on a
4096-token model: the whole-doc budget is `(window − reserve − framing) ÷ 1.5` ≈ 2–3 pages (§15.1) — the
new context-size picker is the remedy the report asked for.
