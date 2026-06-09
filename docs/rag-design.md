# RAG design — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 4 — ingestion & chunking)_

This document describes the local document → retrieval-augmented-generation pipeline.
It is built up phase by phase:

- **Phase 4 (this doc):** ingestion — parse, chunk, store metadata, track status. ✅
- **Phase 5:** embeddings & cosine vector search (mock embedder first). ⚪
- **Phase 6:** grounded RAG chat with `[S1]…` citations. ⚪

Everything runs **locally and offline** (spec §3.6). No file content, embedding, or query
ever leaves the device.

```
import → extract text → chunk → [embed → store vectors] → on question: embed query →
cosine top-k → grounded prompt with [S1]… labels → local LLM → cited answer → snippets
         └────────── Phase 4 ──────────┘ └────────── Phase 5 ──────────┘ └─ Phase 6 ─┘
```

---

## 1. Ingestion pipeline (Phase 4) — spec §7.7

`services/ingestion/` owns the document lifecycle. The statuses are persisted on the
`documents.status` column and surfaced in the Documents screen:

```
queued → extracting → chunking → embedding → indexed
                                   (failed on any error; deleted on removal)
```

`embedding` is a **pass-through in Phase 4** — a document reaches `indexed` with chunks but
no vectors. Phase 5 fills in the `embeddings` table during that step.

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
5. **Persist.** Old chunks (if re-indexing) are removed, new chunks inserted into `chunks`.
6. **Embed.** No-op in Phase 4 (Phase 5 writes vectors here).
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
| `embedding_model_id` | (Phase 5, `embeddings` table) | not written yet |
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
