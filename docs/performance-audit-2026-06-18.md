# Performance Audit — HilbertRaum (2026-06-18)

> Multi-persona performance audit of the HilbertRaum MVP. Scope: find bottlenecks
> and improvement potential across storage, retrieval, ingestion, the renderer, and
> the model runtime. **No code was changed by this audit** — it is a findings report.
>
> Target reminder (shapes severity): HilbertRaum runs **fully offline from a portable
> USB drive** on **commodity/laptop hardware, often CPU-only**. I/O latency (fsync,
> seeks) and main-thread CPU are the scarce resources, so write-amplification, full
> scans, synchronous main-process work, and prompt-prefill cost dominate.

> **STATUS — Waves P1 + P2 IMPLEMENTED (2026-06-18, branch `performance-tuning`).** Wave P1 (six
> storage/retrieval/runtime items): **DB-1**, **DB-2**, **DB-4/DB-6/DB-7** (run_id indexes
> deliberately omitted — see DB-7), **RAG-2/ING-1**, **DB-3/ING-2**, **RT-1**. Wave P2 (renderer
> responsiveness): **FE-1**, **FE-2**, **FE-7**, **FE-3**, **FE-4** shipped; **FE-5** (list
> windowing) and the heaviest sub-parts of FE-3/FE-4 (Composer/`input` move, `DocRow` extraction)
> are **deferred** under the behavior-preserving mandate (see those findings + §6). All shipped
> items verified (suite green, typecheck + build clean). Lasting decisions are folded into
> `docs/architecture.md` "Performance — design record" (Wave P1 + Wave P2 sections); this report is
> retained as the findings record. Waves P3–P4 remain open (§6). Implemented findings are tagged
> **✅ IMPLEMENTED** inline.

---

## 1. Method

Five independent performance personas each audited one domain by reading the real
code (line numbers cited throughout), with no cross-talk:

1. **Database / SQLite** (`db.ts`, `fts.ts`, `collections.ts`, query sites)
2. **RAG / vector search / embeddings** (`rag/`, `embeddings/`, `reranker/`, `analysis/`)
3. **Ingestion / OCR / parsing / doc-tasks** (`ingestion/`, `ocr/`, `transcriber/`, `doctasks/`, `skills/`)
4. **Renderer / React / IPC** (`renderer/screens/`, `renderer/chat/`, `preload/`, `main/ipc/`)
5. **LLM runtime / sidecar / startup** (`runtime/`, `models.ts`, `preflight.ts`, `main/index.ts`)

Where two personas independently flagged the same code, it is marked
**⊕ corroborated** below — these are the highest-confidence findings.

### Severity legend
- **Critical** — large, certain regression on the common path (USB write amplification, data-volume cliffs hit at MVP-realistic sizes).
- **High** — significant cost on a hot path; scales badly or is felt today.
- **Medium** — real, measurable, but bounded / less frequent / partly mitigated.
- **Low** — micro-optimization or latent cliff; fix opportunistically.
- **Info** — verified-good design, recorded so the audit is complete.

---

## 2. Executive summary

The MVP is, on the whole, **deliberately and defensibly built for correctness first**:
WAL is on, embeddings batch (32), PDF rasterization uses pull-based backpressure, the
chunk count is hard-capped (1000/doc), the OCR worker is warm-pooled, the runtime stays
resident (no per-request cold start), token streaming is batched at 40 ms, and
`cache_prompt: true` is now explicit. Many of the scaling cliffs below are **already
documented as deliberate MVP deferrals** (the linear vector scan is the headline one,
rag-design §12.2 D15).

That said, the audit found **one Critical, several High** issues that are *not* design
trade-offs but oversights or untuned knobs — and they cluster on exactly the two
operations a user does most: **importing documents** and **asking a question**.

**The five highest-value fixes (do these first):**

| Rank | Finding | Severity | Why |
|------|---------|----------|-----|
| 1 | **DB-1** Ingestion inserts not wrapped in a transaction | **Critical** | ~3000 fsync'd commits per document on USB; the single biggest import win. |
| 2 | **DB-2** Missing portable-drive PRAGMAs (`synchronous=NORMAL`, `busy_timeout`, `mmap_size`, …) | **High** | One-line change; multiplies the cost of *every* commit and the vector scan. |
| 3 | **RAG-2 / ING-1** Compare mode-(b) re-scans + re-decodes all of doc-B per A-chunk ⊕ | **High** | Pure redundant work; in-process fix using a pattern already in the file. |
| 4 | **DB-3 / ING-2** `listDocuments` is 1+2N queries (count + stale-check per row) ⊕ | **High** | Felt every time the Documents list opens / polls; trivially batchable. |
| 5 | **RT-1** Chat sidecar never sets `--batch-size`/`--ubatch-size` | **High** | Default 512 throttles prompt prefill — the dominant time-to-first-token cost. |

Plus two renderer Highs (**FE-1** streaming re-parse, **FE-2** DocumentsScreen render-body
work) that cause visible jank on CPU-only hardware.

---

## 3. Cross-cutting themes

1. **Write amplification on USB (import path).** SQLite is opened WAL-only with default
   `synchronous=FULL`, and the highest-volume writer — ingestion — does not batch its
   inserts into transactions. Every other batch writer in the codebase (`tree-build.ts`,
   `extract.ts`, `node-vectors.ts`, bank/invoice) *does* wrap in `BEGIN…COMMIT`; ingestion
   is the lone exception, and it's the hottest. (DB-1, DB-2)

2. **Synchronous full scans on the main process (query path).** `node:sqlite` is
   synchronous and runs on the Electron main process. The vector search decodes every
   embedding BLOB and computes cosine in JS, uninterruptibly, on every question — and the
   `embedding_model_id` filter has no index, so even the filtered path is a full scan.
   This is a documented MVP deferral (ANN, D15) but the *event-loop-blocking* aspect and a
   couple of cheap constant-factor wins are not. (RAG-1, RAG-3/DB-4)

3. **N+1 query patterns where a grouped query exists three lines away.** `listDocuments`
   does per-row COUNT + stale-check despite the memberships join right beside it being
   deliberately de-N+1'd. The compare loop re-queries SQLite per window. (DB-3/ING-2, RAG-2/ING-1)

4. **Un-memoized renderer doing O(list) and Markdown re-parse work per render/flush.**
   `Transcript` re-parses every message's Markdown (and the whole growing live answer)
   every 40 ms flush; `DocumentsScreen` re-runs 5+ array passes + a Map build in the render
   body, polled at 400 ms during import. No `React.memo`/`useMemo` in the chat tree. (FE-1, FE-2)

5. **Untuned llama.cpp batch knobs.** The chat and embedder sidecars leave `--batch-size`
   at the 512 default, while the reranker deliberately raises it — so the prefill cost the
   Skills §17 record measured (3.5–15 s on CPU) is processed in 512-token chunks. (RT-1, RT-2)

---

## 4. Findings by domain

### 4.1 Storage / SQLite

#### DB-1 — Ingestion chunk + embedding inserts are not wrapped in a transaction · **Critical** · ✅ IMPLEMENTED
- **Location:** `apps/desktop/src/main/services/ingestion/index.ts:688-706` (chunk inserts), `:780-788` (embedding inserts), DELETEs at `:654-657`.
- **Evidence:** Hoisted `db.prepare(...)` then a bare `for … insert.run(...)` loop — no `BEGIN`/`COMMIT`. With WAL + default `synchronous=FULL`, each `run()` is its own auto-commit (WAL frame + fsync), and each chunk also fires the `chunks_fts_ai` FTS trigger (`db.ts:423`) inside that same commit.
- **Impact:** Up to `MAX_CHUNKS_PER_DOCUMENT = 1000` chunk inserts + 1000 embedding inserts + 1000 FTS trigger writes ⇒ **~3000 individually fsync'd transactions per document**. On USB (fsync 5–20 ms) that is seconds-to-tens-of-seconds of pure commit overhead per file, dwarfing embed compute. This is the single biggest portable-drive win.
- **Fix:** Wrap the delete-then-insert chunk phase and the embedding-insert phase each in `db.exec('BEGIN')` … `COMMIT` (`ROLLBACK` on throw) — the exact pattern in `tree-build.ts:148-164`. Keep the async `embed` `await` *outside* the transaction (the `node-vectors.ts:156` precedent). Collapses ~3000 commits → ~2.

#### DB-2 — Missing performance PRAGMAs for a high-latency portable drive · **High** · ✅ IMPLEMENTED
- **Location:** `apps/desktop/src/main/services/db.ts:512-516` (`openDatabase`).
- **Evidence:** Only `journal_mode=WAL` and `foreign_keys=ON` are set. No `synchronous`, `busy_timeout`, `cache_size`, `mmap_size`, or `temp_store`.
- **Impact:** Default `synchronous=FULL` fsyncs at every commit (compounds DB-1). No `busy_timeout` ⇒ the concurrent import loop vs chat/tree-build risks `SQLITE_BUSY` throws instead of a short wait. No `mmap_size` ⇒ the vector scan (RAG-1) goes through read syscalls instead of mapped pages.
- **Fix:** After WAL, add: `PRAGMA synchronous = NORMAL;` (WAL-safe durability), `PRAGMA busy_timeout = 5000;`, `PRAGMA mmap_size = 268435456;` (256 MB), `PRAGMA cache_size = -16000;` (~16 MB), `PRAGMA temp_store = MEMORY;`. One-line, low-risk, directly targets the USB latency.

#### DB-3 — `listDocuments` is 1+2N queries (chunk count + stale-check per row) · **High** ⊕ · ✅ IMPLEMENTED
- **Location:** `apps/desktop/src/main/services/ingestion/index.ts:1142-1173`; helpers `chunkCountFor:398-403`, `chunksEmbeddedUnder:381-389`. (Corroborated by ingestion persona as ING-2.)
- **Evidence:** Inside `rows.map(...)`, `chunkCountFor` runs `SELECT COUNT(*) FROM chunks WHERE document_id=?` per row, and `chunksEmbeddedUnder` runs a COUNT+JOIN per *indexed* row — while memberships three lines above (`:1148-1164`) were deliberately batched into one join.
- **Impact:** Listing N docs fires up to **2N+1** queries; the list is polled during import. 200 docs ⇒ ~400 round-trips, the stale check hitting the unindexed `embedding_model_id` (compounds DB-4). Visible lag opening the Documents pane on USB.
- **Fix:** Two grouped queries into `Map`s: `SELECT document_id, COUNT(*) FROM chunks GROUP BY document_id` and the embeddings JOIN `GROUP BY document_id` — mirroring the memberships pattern already present.

#### DB-4 — No index on `embeddings.embedding_model_id` · **Medium** ⊕ · ✅ IMPLEMENTED
- **Location:** schema `db.ts:75-82` (only `chunk_id PRIMARY KEY`); query `embeddings/index.ts:163-184`. (Corroborated by RAG persona as RAG-4.)
- **Evidence:** Every retrieval and stale-check filters `WHERE embedding_model_id = ?` with no supporting index.
- **Impact:** Forces a full table scan / row-by-row filter; worst during/after a mock→E5 migration when stale rows are loaded across the SQL→JS boundary only to be discarded. Also slows the DB-3 stale check and the `hybrid.ts:81` keyword join.
- **Fix:** `CREATE INDEX idx_embeddings_model ON embeddings(embedding_model_id)` (additive migration, precedent throughout `db.ts`).

#### DB-5 — Prepared statements re-compiled on every call on hot read paths · **Medium**
- **Location:** Pervasive `db.prepare(...).get()/.all()/.run()` one-liners. Hot: `chat.ts:372-379` (`listMessages`, per turn), `chat.ts:404-436` (`appendMessage`), `collections.ts:450-484` (`resolveScope`, 2/turn), the DB-3 counters.
- **Evidence:** `node:sqlite` `prepare()` parses+plans each call; none memoized. Batch-insert sites correctly hoist the prepare — the per-call readers don't.
- **Impact:** Extra parse/plan CPU on the main thread per turn / per row; compounds DB-3.
- **Fix:** Cache hot-path statements (module-level `WeakMap<Db, Stmt>` or a small per-Db cache). Prioritize `listMessages`, `appendMessage`, `resolveScope`, the DB-3 counters.

#### DB-6 — `extraction_records` aggregation lacks an index for the unscoped path · **Medium** · ✅ IMPLEMENTED
- **Location:** `apps/desktop/src/main/services/analysis/extract.ts:305-345` (`aggregateExtractions`); only index is `idx_extract_doc_type(document_id, record_type, normalized_value)` (`db.ts:221`).
- **Evidence:** Whole-corpus listings filter on `record_type` (and `record_type, normalized_value`) *without* a leading `document_id`, so the doc-leading index can't serve them ⇒ up to 4 scans of `extraction_records` per listing.
- **Impact:** `extraction_records` (one `__scan__` marker per chunk + N items/chunk) is among the largest tables; an unscoped "list every date/amount" does multiple full scans synchronously on the answer path.
- **Fix:** `CREATE INDEX idx_extract_type_nv ON extraction_records(record_type, normalized_value)` (the doc-leading index still serves scoped queries).

#### DB-7 — FK / filter columns without supporting indexes · **Medium** · ✅ IMPLEMENTED (status + category_id; run_id omitted)
- **Location:** `db.ts` — `documents.status` (filtered in `listDocuments:1144`, `rag/index.ts:144`, `extract.ts:353`), `bank_transactions.category_id` (`:562`), `*.run_id` (bank/invoice). SQLite does not auto-index FK child columns.
- **Impact:** `documents.status` is scanned on every list + re-index honesty check; `category_id`/`run_id` joins scale with transaction volume. Cheap scans today, cheaper to remove.
- **Fix:** `idx_documents_status(status)`, `idx_bank_transactions_category(category_id)`, and `run_id` indexes where downstream tools join.
- **As implemented (2026-06-18):** `idx_documents_status` + `idx_bank_transactions_category` added. The `run_id` indexes were **deliberately omitted** — a code sweep confirmed `run_id` is only ever INSERTed (bank/invoice run tools), never joined or filtered, so an index would be pure write-amplification on USB with no read benefit. Documented inline in `db.ts`; add one alongside the first query that joins on `run_id`.

#### DB-8 — `SELECT *` on wide rows that include large TEXT columns · **Low**
- **Location:** `ingestion/index.ts:392` (`getRow`), `:1143-1145`, `collections.ts:62-72`, `chat.ts:356-363`.
- **Evidence:** `getRow` `SELECT *` is reused by `getDocument`/`getDocumentSummary`/`getDocumentOrigin`/… and pulls `summary_json`, `origin_json`, and the potentially large `ocr_json` even when one small field is wanted.
- **Impact:** Reads/deserializes large TEXT needlessly; multiplied by the DB-3 N+1.
- **Fix:** Project only needed columns on targeted getters (e.g. `getDocumentOrigin` → `SELECT origin_json`); avoid `ocr_json` in `listDocuments`.

---

### 4.2 RAG / vector search / embeddings

#### RAG-1 — Brute-force vector scan decodes every BLOB and computes cosine in JS, synchronously on the main process · **High**
- **Location:** `apps/desktop/src/main/services/embeddings/index.ts:157-197` (`VectorIndex.search`), via `rag/index.ts:219`.
- **Evidence:** `db.prepare(sql).all()` loads all matching rows + blobs; a `for` loop calls `decodeVector` (a `slice` copy, `:64-67`) and `cosineSimilarity` (3-accumulator loop over all 384 dims, `:77-92`) per row; then `sort` + `slice(topK)`. No `await` between the query and the end of the scan ⇒ one uninterruptible main-process CPU block.
- **Impact:** Per query: `O(N_chunks × dims)` cosine + `O(N_chunks)` blob copies + sort. At the 1000-chunk cap, ~100 docs ⇒ ~100k vectors (~150 MB) read + scanned **on every question**, blocking all other IPC (token relays, UI). Documented MVP deferral (rag-design §12.2 D15) — but the blocking + constant factors are addressable now.
- **Fix (cheap, now):** Vectors are stored **L2-normalized** (`e5.ts:213`; mock too), so cosine == raw **dot product** — drop the `na`/`nb` norm computation (`:86-91`) for ~2× fewer FLOPs/row. Add `mmap_size` (DB-2) so blob reads hit page cache. **Fix (with D15):** move the scan off the main thread (worker) and/or adopt sqlite-vec; keep decoded vectors resident in one contiguous `Float32Array` to kill the per-query re-decode (RAG-6).

#### RAG-2 — Compare mode-(b) re-scans + re-decodes all of doc-B once per A-chunk · **High** ⊕ · ✅ IMPLEMENTED
- **Location:** `apps/desktop/src/main/services/doctasks/manager.ts:1145-1163` (loop), body in `embeddings/index.ts:157-197`. (Corroborated by ingestion persona as ING-1.)
- **Evidence:** For each A-chunk, `index.search(vec, …)` re-runs `SELECT … FROM embeddings WHERE chunk_id IN (… doc B …)` and **re-decodes every doc-B vector** to cosine against one A-vector.
- **Impact:** `O(N_A × N_B × dims)` with doc-B's BLOBs re-fetched and re-decoded `N_A` times. Two ~300-chunk docs ⇒ ~90k cosines but ~27M redundant decode ops + repeated SQLite reads, all on the main loop. The mode-(c) `alignNodes` path (`compare.ts:349`) already does this correctly (decode once, reuse).
- **Fix:** Decode doc-B's vectors once into a `Map<chunkId, Float32Array>` (the loop already does this for doc A at `manager.ts:1141-1143`) and cosine in memory — eliminating `N_A−1` full re-scans. Also fold doc-B `(id, text, chunk_index)` into the same one-shot load to fix RAG-2's sibling re-fetch (`manager.ts:1170-1183`, a fresh `IN (…)` statement compiled per window).

#### RAG-3 — Reranker is the dominant per-query latency (~2 s/candidate, serial CPU) · **Medium**
- **Location:** `rag/index.ts:265-282`; `reranker/llama.ts:149-182`, CPU-pinned (`--device none`).
- **Evidence:** Up to ~2×`topKInitial` (≈24) candidates in one CPU rerank request; rag-design §12.3 measured ≈24.7 s worst-case (~2 s/candidate). Correctly bounded (candidate cap + word truncation) and fails safe to fused order.
- **Impact:** When provisioned, by far the largest documents-answer latency. Accepted, documented design — not a bug.
- **Note/Fix:** One real micro-issue — rerank runs on the fused set *before* dedup (`:265` vs `:286`), so near-duplicate same-page chunks can consume ~2 s slots. This is a deliberate quality/latency trade (D11). Revisit only if latency bites; the documented lever is `MAX_DOC_WORDS`/candidate cap.

#### RAG-4 — (see DB-4) No index on `embedding_model_id` · **Medium** ⊕ — folded into DB-4.

#### RAG-5 — No query-vector cache (fresh sidecar round-trip per question) · **Low**
- **Location:** `embeddings/index.ts:200-203` (`searchText`), `e5.ts:162-217`.
- **Impact:** Re-asking / retries / the re-index re-check all re-embed from scratch (one HTTP + forward pass each). Cheap relative to reranker. Ingestion batching is already correct.
- **Fix:** Optional small LRU on normalized query → `Float32Array`, cleared on embedder change.

#### RAG-6 — Per-row BLOB copy + `Float32Array` allocation churn in the scan · **Low**
- **Location:** `embeddings/index.ts:64-67` (`decodeVector`), per row at `:192`.
- **Evidence:** The `slice` copy is *required* for alignment safety, but every full scan allocates `N_chunks` short-lived `Float32Array`s, all GC'd after the cosine.
- **Fix:** Resolved by the resident contiguous buffer recommended in RAG-1's D15 fix; not worth a standalone change first.

#### RAG-7 — Context assembly re-counts tokens by re-scanning strings per turn · **Low**
- **Location:** `chat.ts:634-636` (`messageTokens`), `:650-678` (`fitMessagesToContext`); `rag/index.ts:299-305`, `:485`.
- **Evidence:** `approxTokenCount` (full regex+split, `chunker.ts:91-102`) is called per message and per candidate chunk, repeated across the retrieve trim, skill-fence sizing, and history fit.
- **Fix:** Read the persisted `chunks.token_count` column instead of recomputing for chunks; memoize `messageTokens` by message id. Linear and cheap vs inference — low priority.

#### RAG-8 — `alignNodes` is O(n²) over the section-node cartesian product · **Low**
- **Location:** `doctasks/compare.ts:349-378`.
- **Evidence:** Full `|A|×|B|` cosine + sort, but `n` = level-1 summary sections (tens, not thousands), vectors pre-decoded.
- **Fix:** Acceptable as-is; cap candidate generation (per-A top-K) only if tree branching is ever lowered.

---

### 4.3 Ingestion / OCR / parsing / doc-tasks

#### ING-1 — (see RAG-2) Compare mode-(b) re-scan · **High** ⊕ — folded into RAG-2.
#### ING-2 — (see DB-3) `listDocuments` N+1 · **High** ⊕ — folded into DB-3.

#### ING-3 — Document import is fully serialized; embed (I/O) never overlaps next-file parse (CPU) · **High**
- **Location:** `apps/desktop/src/main/ipc/registerDocsIpc.ts:253-266`; `processDocument` `ingestion/index.ts:500-728`.
- **Evidence:** `for (const id …) await processDocument(...)` — parse → chunk → **embed (sidecar round-trips)** → write, fully awaited before the next file. Embed is I/O wait during which CPU + parser idle.
- **Impact:** A 200-file folder takes the *sum* of every file's parse+embed+write. Parse of file N+1 is independent of embed of file N but left on the table; a 1-deep pipeline could cut wall-clock materially.
- **Fix:** Shallow producer/consumer — parse+chunk N+1 while N embeds (the embed sidecar is the single contended resource; parse is not). At minimum document the trade-off. (Pairs with DB-1: batch the writes too.)

#### ING-4 — Selection is walked & `statSync`'d 2–3× (preflight + import expansion) · **Medium**
- **Location:** `ingestion/index.ts:902-916` (`summarizeImportPaths` → `expandPaths`), `:1271` (import → `expandPathsWithSource` → `expandPaths` again), walker `:1205-1248`.
- **Evidence:** Recursive `readdirSync`/`statSync` walk run by preflight, then again by the import, plus per-audio-file `statSync`.
- **Impact:** A large picked tree is synchronously walked 2–3× on the event loop; on USB each `statSync` is a real seek and the UI freezes during the walk.
- **Fix:** Walk once, cache `ExpandedFile[]` + sizes, reuse for both preflight and import. Use `readdirSync(dir, {withFileTypes:true})` (one syscall/entry instead of two).

#### ING-5 — OCR renders and recognizes strictly one page at a time (no render/recognize overlap) · **Medium**
- **Location:** `doctasks/manager.ts:821-827`, `ocr/rasterizer.ts:171-179`, `ocr/tesseract.ts:117-133`.
- **Evidence:** `onPage` awaits `engine.recognize(png)` before the next page renders (queue capped at 0). Render (pdfjs in hidden window) and recognize (WASM tesseract) are different engines that could overlap.
- **Impact:** Strictly serial render→recognize roughly doubles wall-clock for a multi-hundred-page scan. The backpressure is correct for *memory* but conservative for *throughput*.
- **Fix:** 1-deep look-ahead — render page N+1 into a single slot while page N recognizes. Keeps memory bounded (one extra PNG) and lets the engines pipeline.

#### ING-6 — `materializeDocument` writes generated text to disk then re-parses/re-embeds it · **Medium**
- **Location:** `doctasks/manager.ts:1422-1466`.
- **Evidence:** Translation/compare output already in RAM is `writeFileSync`'d to a temp `.parse.md`, re-read by the Markdown parser, re-chunked, re-embedded.
- **Impact:** Extra MB-scale synchronous disk round-trip for in-memory text + a redundant parse pass. (Embedding is unavoidable.)
- **Fix:** Low priority — this deliberately reuses the canonical import path (encryption/FTS/citations for free). Add an in-memory ingestion entry only if profiling shows it matters; flag so it isn't mistaken for free.

#### ING-7 — Many tiny single-column `SELECT … WHERE id=?` reads on per-doc / per-compare paths · **Low**
- **Location:** `manager.ts:249-251, 368-371, 608-610, 702-704, 1259-1271`; `ingestion/index.ts:664-682` (separate `SELECT tree_status` then `SELECT extract_status`, each + an `UPDATE`).
- **Fix:** Coalesce adjacent single-column reads of the same row into one `SELECT`.

#### ING-8 — Synchronous whole-file reads; OCR PDF read is sync on the event loop · **Low**
- **Location:** parsers use async `fs/promises` (`pdf.ts:55`, `docx.ts:26`, `image.ts:48`) — fine; but OCR `readStoredPdfBytes` uses `readFileSync` (`manager.ts:898-906`) on a potentially huge PDF. `maxBytes` cap is 1 GiB (`limits.ts:30`).
- **Fix:** Switch the OCR reads to async `readFile`; consider a lower default `maxBytes` for non-audio formats.

#### ING-9 — `coalesceSegments` accumulates by string concatenation · **Low**
- **Location:** `ingestion/chunker.ts:190-205` (`prev.text = \`${prev.text}\n\n${segment.text}\``).
- **Impact:** For a DOCX emitting one segment/paragraph, coalescing M paragraphs is O(total chars) reallocation per group (classic accumulate-by-concat); V8 ropes mitigate but the text is re-scanned later anyway.
- **Fix:** Accumulate into a `string[]` per group and `join('\n\n')` once at flush.

#### ING-10 — `approxTokenCount` does 2–3 full allocations per call, invoked per word · **Low**
- **Location:** `chunker.ts:91-102`, called per word in `atomize:121,130`, per window, and heavily across `manager.ts`.
- **Evidence:** Each call does `match` + `replace` + `split` over its input; `atomize` calls it once per word and per char-slice.
- **Fix:** In the per-word path the word has no internal whitespace — count chars directly; reserve full `approxTokenCount` for whole segments.

---

### 4.4 Renderer / React / IPC

#### FE-1 — Streaming re-renders the whole transcript and re-parses all Markdown every ~40 ms flush · **High** · ✅ IMPLEMENTED
- **Location:** `renderer/chat/Transcript.tsx:81-157` (`messages.map`), `:193-201` (live bubble), `:277-300` (`AssistantMarkdown`); driver `ChatScreen.tsx:222-238` (`STREAM_FLUSH_MS=40`).
- **Evidence:** `setStreamText(prev => prev + chunk)` every 40 ms; `streamText` is a prop of the **unmemoized** `Transcript` (zero `memo`/`useMemo`/`useCallback` in `renderer/chat`). So each flush: (1) re-maps + re-`AssistantMarkdown`-parses every *prior* message (none changed); (2) re-parses the **entire growing live buffer** from scratch — O(n²) over reply length; (3) recomputes `[...messages].reverse().find(...)` (`:75`).
- **Impact:** Every 40 ms the app re-parses Markdown for all messages + the whole live answer. On CPU-only hardware this competes with token generation ⇒ visible jank / dropped frames during streaming, worsening with both transcript and answer length.
- **Fix:** (a) memoized `MessageBlock` (`React.memo`, keyed by `m.id`/`m.content`) so persisted messages don't re-parse; (b) `useMemo` `lastAssistantId`; (c) render `streamText` as plain text (or incremental) during streaming, doing the full Markdown parse once on completion when it re-renders from `messages`.

#### FE-2 — DocumentsScreen does all filter/sort/count/Map work in the render body, polled at 400 ms · **High** · ✅ IMPLEMENTED
- **Location:** `DocumentsScreen.tsx:508-554` (derivations), `:740-744` (4 rail-count passes), `:543` (`sourcesById` Map), `:551-554` (sort), import poll `:274-288` (`setInterval(…,400)` → `refresh()` → `setDocs`).
- **Evidence:** Every render runs `docs.some`, multiple `docs.filter`, `collections.filter` ×4, `new Map(docs.map(...))`, `docs.filter(inSection)`, `[...sectioned].sort(...)`, and **four** `docs.filter(matchesSmartView)` for rail counts — none memoized. The 400 ms import poll replaces the whole array and re-runs all of it + re-renders every row.
- **Impact:** During import (when the list is most active) the screen recomputes 5+ array passes + a Map rebuild every 400 ms with a large library; also recomputes on every unrelated state change (menu/hover/modal).
- **Fix:** `useMemo` the derived collections, `sourcesById`, `sectioned`, `visibleDocs`, and the rail counts (one bucketing pass) keyed on `[docs, section]`/`collections`. Widen/replace the import poll (see FE-7).

#### FE-3 — Chat & document children unmemoized; ChatScreen passes fresh closures every render · **Medium** · ✅ IMPLEMENTED (Transcript + ConversationList; Composer/input-move deferred)
- **Location:** `ChatScreen.tsx:1042-1058` (`<Transcript>`), `:962-972` (`<ConversationList>`), `:1098-1152` (`<Composer>` + inline `footer` JSX).
- **Evidence:** No `React.memo`; props like `onTryAgain`, `onAnswerWithoutSkill`, `onCopy`, and the `footer={<>…</>}` are new references each render. ChatScreen re-renders on every keystroke (`input` state) and every flush.
- **Impact:** Typing re-renders `ConversationList` (re-running `groupByProject`/`groupConversations`) and `Transcript`; multiplies FE-1.
- **Fix:** `React.memo` the three; `useCallback` the handlers; `useMemo`/extract the footer; move `input` into the `Composer` so per-keystroke state doesn't re-render the screen.
- **As implemented (Wave P2):** `Transcript` + `ConversationList` are `React.memo`'d; the handlers passed to them are stabilized via a `useEventCallback` (latest-ref) wrapper and `emptyState` is `useMemo`'d, so a keystroke/flush no longer re-renders either (compounding FE-1). **Deferred:** memoizing `Composer` + moving `input` into it — the footer (`ScopePopover`/`DepthMenu`/`SkillPicker`) handlers must be stabilized first (notably the suggest-on-open handler that reads the live draft), a larger refactor; without it, memoizing Composer is moot (the footer prop changes every render). Tracked for a Wave P2b/P3 follow-up.

#### FE-4 — Document & conversation rows unmemoized; one-row interaction re-renders all rows · **Medium** · ✅ IMPLEMENTED (ConvRow; DocRow deferred)
- **Location:** `DocumentsScreen.tsx:907-1191` (inline row closures), `ConversationList.tsx:199-260`.
- **Evidence:** Rows built inline with per-row `rowChips(d)`, `badgeFor`, fresh `onContextMenu`/`onChange` closures; opening one `⋯` menu (`menuOpenId`) re-renders all rows. `renderRow`/grouping recreated each render.
- **Fix:** Extract memoized `DocRow`/`ConvRow` with stable `useCallback(onToggle(id))`; `useMemo` the grouping.
- **As implemented (Wave P2):** `ConvRow` (React.memo) with stable per-row callbacks — opening one conversation's ⋯ menu no longer re-renders every conversation row. **Deferred:** the `DocumentsScreen` `DocRow` extraction — a ~25-prop memoized row (every doc-task handler + `busy`/`activeTask`/`section`/lifecycle state) with a high stale-closure surface; held back under the behavior-preserving mandate, tracked for a follow-up.

#### FE-5 — No list virtualization (document list, transcript, conversation list) · **Medium** (High at scale) · ⏳ PARTIAL (scroll-thrash fixed; windowing deferred)
- **Location:** `DocumentsScreen.tsx:906-1192`, `Transcript.tsx:79-205`, `ConversationList.tsx:336-353`.
- **Evidence:** Straight `.map` into the DOM; the transcript is worst (each item carries a `react-markdown` render + disclosures). The scroll-to-bottom effect (`Transcript.tsx:71-73`) runs on every `streamText` change, forcing layout over the whole tree each flush.
- **Fix:** Window the transcript first, then the document list; gate the scroll effect so it doesn't run on every flush when scrolled up.
- **As implemented (Wave P2):** the **scroll-thrash half is done** under FE-1 — the scroll-to-bottom effect is gated on an `atBottomRef`, so a streaming flush only forces layout + scroll while the user is pinned to the bottom. **Deferred:** the actual list windowing (transcript + document list) — no virtualization library is in deps, and windowing variable-height Markdown items while preserving scroll-to-bottom, find-in-page, and a11y is a behavior-sensitive change; tracked for when transcript/list length actually bites.

#### FE-6 — PreviewModal renders the entire extracted document text synchronously over IPC · **Medium**
- **Location:** `DocumentsScreen.tsx:1770-1781` (`preview.segments.map`), IPC `previewDocument` (`preload/index.ts:272`).
- **Evidence:** `previewDocument(id)` returns the full document text as one serialized payload; all segments mounted in one synchronous render.
- **Impact:** A large PDF/transcript crosses the bridge as one big JSON and mounts at once — multi-hundred-ms hitch + high modal memory.
- **Fix:** Paginate/window the preview; have `previewDocument` return a bounded first page + cursor.

#### FE-7 — IPC chattiness: 400 ms full-list polling during import/attach; 300 ms stream-recover poll · **Medium** · ✅ IMPLEMENTED (import/attach polls; stream-recover poll unchanged)
- **Location:** `DocumentsScreen.tsx:274-288` (`watchJob` → `refresh()` → `listDocuments()` + `refreshCollections()`), `ChatScreen.tsx:790-820` (`watchAttachJob`), `:349-399` + `polling.ts:13` (300 ms).
- **Evidence:** `watchJob` pulls the **entire** `DocumentInfo[]` 2.5×/s for the import duration and re-derives everything (FE-2).
- **Fix:** Poll **job status only** (`getImportJob`) at 400 ms; refresh the full list only on a status transition/completion — the pattern `ModelsScreen.tsx:169-182` already uses. Better: push import progress from main via an event channel (the stream channels already demonstrate it).
- **As implemented (Wave P2):** both import watchers (DocumentsScreen `watchJob`, ChatScreen `watchAttachJob`) now read only `getImportJob` on the 400 ms tick and refresh the full list (+ attachments) only when `completed + failed` changes (a file finished) and once at completion — the ModelsScreen download-poll pattern. The list updates at file-completion granularity instead of re-deriving 2.5×/s. The event-push channel is the better fix but was out of scope (not cheap). The 300 ms stream-recover poll (`ChatScreen.tsx`) is left as-is — it polls a single small snapshot, not the full list.

#### FE-8 — Render-body linear `docs.find` lookups (preview/provenance) · **Low**
- **Location:** `DocumentsScreen.tsx:1363-1368` (four `docs.find` for one preview), `:471` (`titleOf` per provenance line), `:606`.
- **Fix:** Resolve `previewDoc` once via `useMemo`; route `titleOf` through the existing `sourcesById` Map.

#### FE-9 — ChatScreen mount fires 6 un-batched IPC calls; `listDocuments` fetched by two screens · **Low**
- **Location:** `ChatScreen.tsx:258-294`; also `DocumentsScreen.tsx:245`.
- **Fix:** A shared in-renderer cache or one `getChatBootstrap` IPC so navigation doesn't re-pull the list twice.

#### FE-10 — `runnableTools` effect re-fires IPC on every `messages.length` change · **Low**
- **Location:** `ChatScreen.tsx:516-533` (deps `[currentSkillId, activeId, messages.length]`).
- **Fix:** Drop `messages.length` from the deps unless the tool set truly depends on message count; key on scope instead.

---

### 4.5 LLM runtime / sidecar / startup

#### RT-1 — Chat sidecar never sets `--batch-size`/`--ubatch-size`; default 512 throttles prefill · **High** · ✅ IMPLEMENTED
- **Location:** `runtime/sidecar.ts:235-250` (`buildArgs`), `runtime/llama.ts:30` (`CHAT_SERVER_ARGS = --jinja --reasoning-format deepseek`).
- **Evidence:** Chat passes only `--host --port --model --ctx-size --threads` + the two jinja args. No batch flags ⇒ llama-server's 512 default. The reranker (`reranker/llama.ts:96-115`) *deliberately* raises `--batch-size`/`--ubatch-size` to ctx size precisely because 512 throttles its inputs.
- **Impact:** Prompt prefill (skill fence + RAG excerpts + history) — the dominant time-to-first-token cost, measured 3.5–15 s on CPU in Skills §17 — is processed in 512-token chunks; on GPU a larger ubatch materially improves prompt-processing throughput.
- **Fix:** Set `--batch-size`/`--ubatch-size` on the chat sidecar to `min(ctxSize, ~2048)` (1024 is a low-risk start), validated on pinned b9585; mind VRAM on GPU. Add a `llama-runtime.test.ts` arg assertion mirroring the reranker's.

#### RT-2 — Grounded (RAG) answers re-prefill the whole excerpt block every turn · **Medium**
- **Location:** `rag/index.ts:335-364` (`buildGroundedPrompt`), `:493-501`; design note `architecture.md:1786-1793` (§17 "recommended, not implemented (a)").
- **Evidence:** The skill fence *and* excerpts ride in the per-turn **user** message, so `cache_prompt`'s longest-common-prefix reuse stops at the system prompt — the whole excerpt block (up to `ragMaxContextTokens`) re-prefills every documents question, even follow-ups.
- **Impact:** On CPU, a 1–2k-token excerpt block is several seconds of prefill *per* documents turn — the largest recurring documents-mode latency. Acknowledged, not mitigated.
- **Fix:** Keep stable grounding rules + preface in `system` (cacheable), put only excerpts in the user turn (preserving precedence); and/or cap `ragMaxContextTokens` harder on CPU profiles. Surface a measured number in rag-design.

#### RT-3 — First-run weight hashing of multi-GB GGUFs is on the `listModels` IPC (Chat-mount) critical path · **Medium**
- **Location:** `main/ipc/registerModelIpc.ts:130-155` → `models.ts:498-587` (`buildModelList` → `computeInstallState` → `sha256FileCached`); cache note `models.ts:171-180`.
- **Evidence:** `listModels` (fired on Models-screen visit *and* Chat-screen mount) SHA-256-hashes each present weight on a cache miss (L1 mem + L2 settings store, keyed path+size+mtime). First run / cold cache hashes every multi-GB GGUF — "minutes of USB I/O" — awaited by the renderer IPC.
- **Impact:** First Chat/Models mount can block on whole-corpus weight hashing. Mitigated steady-state by the cache + progress streaming; the cost is first-run / cold-cache (e.g. encrypted workspace before the store is warm).
- **Fix:** Hash lazily — only the *active* model on the chat path, the full set only on explicit Models-screen visits; ensure the L2 cache is warm before the first Chat-mount `listModels`.

#### RT-4 — Embeddings sidecar relies on default n_batch 512 while batching 32 inputs · **Medium**
- **Location:** `embeddings/e5.ts:113` (extraArgs), `:38` (`DEFAULT_EMBED_BATCH_SIZE=32`), `:17` (ctx 512).
- **Evidence:** Spawns `--embedding --pooling mean --device none` with no `--batch-size`; embedding mode forces `n_batch=n_ubatch` (default 512) while POSTing 32-input batches.
- **Impact:** Fewer sequences co-decode per physical batch than the context allows ⇒ more round-trips ⇒ slower large-corpus ingestion (already slow on USB).
- **Fix:** Set `--batch-size`/`--ubatch-size` explicitly (matching the reranker's reasoning) and/or raise per-request batching to pack more short inputs; verify on b9585 that embedding mode honors a raised batch for multi-sequence throughput.

#### RT-5 — Health readiness is a fixed 250 ms poll, not event-driven · **Low**
- **Location:** `runtime/sidecar.ts:188` (`DEFAULT_HEALTH_INTERVAL_MS=250`), `:333-358` (`waitForHealthy`).
- **Impact:** Up to ~250 ms dead time on every sidecar start (chat/embedder/reranker), recurring on every model switch.
- **Fix:** Drop the interval to ~50–100 ms (cheap loopback GET) or exponential backoff from small.

#### RT-6 — `n_threads` = half the logical cores · **Low**
- **Location:** `runtime/sidecar.ts:86-95` (`defaultThreadCount` = `floor(logical/2)`).
- **Impact:** Reasonable default; edge cases — under-uses P-cores on hybrid CPUs; three CPU-pinned sidecars (chat + embedder + reranker) at `cores/2` can oversubscribe when ingesting while chatting.
- **Fix:** Consider physical-core count for chat; a smaller thread budget for the CPU-pinned embedder/reranker. Measure first.

#### RT-7 — KV cache is per-process; GPU-crash CPU fallback discards it · **Low**
- **Location:** `runtime/factory.ts:285-309` (`createGpuCrashAutoFallback`), `llama.ts:220`.
- **Impact:** After a mid-session GPU→CPU fallback, the next message pays a full cold prefill of all history on CPU. Bounded (one event).
- **Fix:** Acceptable for v1; `--slot-save-path` + cache restore would let the CPU restart resume KV — weigh vs disk/complexity. Document as known residual.

#### RT-8 — First-run benchmark token-probe can steal the runtime slot · **Low**
- **Location:** `main/index.ts:296-300`; `benchmark.ts:196-217`, `:291-294`.
- **Evidence:** Startup fires the benchmark + auto-start as `void` (good), but the benchmark's 64-token probe runs through `runtime.active()`; usually null at startup (auto-start in flight) so skipped, but if a runtime is warm it competes with the user's first turn for the single slot.
- **Fix:** Gate `measureTokensPerSecond` behind "no chat stream / doc task in flight," or skip at first-run and populate on the next manual benchmark.

#### RT-9 — Per-turn full-history replay (residual on Skills §17 PERF-1) · **Low**
- **Location:** `chat.ts:685-705` (`buildChatMessages`), `:822-826` (`buildTurnFence`); §17 `architecture.md:1770-1793`.
- **Evidence:** `cache_prompt: true` reuses the common token prefix — but a near-budget **user** skill whose fence trim depends on the live final-turn length, or history dropping under context pressure (`fitMessagesToContext`), shifts the prefix and silently defeats reuse ⇒ full re-prefill. Latent for shipped skills (none trim).
- **Fix:** Implement §17 recommended (b) — size the plain-chat fence against a *fixed* user-turn reserve so the system prefix is byte-stable regardless of question length.

#### RT-10 — No idle keep-alive · **Info (verified good)**
- Runtime stays resident until model switch/quit; embedder/reranker CPU-pinned (`--device none`) avoid VRAM thrash with chat (GPU record §7). No per-request cold start. No action.

---

## 5. Verified-good (recorded so the audit is complete)

- WAL enabled; FK enforcement on (`db.ts:513-514`).
- Embeddings batch at 32 (`e5.ts:170`); per-doc embed is a single batched call.
- Chunk count hard-capped at 1000/doc with an over-cap gate before the destructive delete.
- PDF rasterization uses correct pull-based backpressure (no page pile-up).
- OCR tesseract worker is warm-pooled (lazy-init once, reused), not reloaded per doc.
- Re-ingestion deletes+replaces but the `summary_cache` (keyed by text) survives, so unchanged content isn't re-summarized.
- Runtime stays resident; CPU-pinned embedder/reranker avoid VRAM contention (no load/unload thrash).
- Token streaming batched at 40 ms (refs + timer), not per-token state updates.
- `cache_prompt: true` is explicit (§17 PERF-1); per-turn skill load cached by (mtime,size) (§17 PERF-2).
- Sidecar process hygiene solid: stdout ignored (no pipe deadlock), stderr drained, SIGTERM→SIGKILL gated on real exit, start/stop serialized, GPU probe concurrent with rung-1 start.
- Streaming SSE is incremental with partial-line buffering, abort-on-signal, reader cancel, destroyed-renderer guard.
- Conversation search is debounced (150 ms) with cancellation; i18n context value memoized.
- ModelsScreen download/engine polls already refresh the full list only on terminal transitions (the pattern FE-7 wants for imports).
- Batch DB writers `tree-build.ts`, `extract.ts`, `node-vectors.ts`, bank/invoice all correctly use `BEGIN…COMMIT` — only ingestion (DB-1) does not.

---

## 6. Recommended remediation roadmap

**Wave P1 — high ROI, low risk — ✅ DONE (2026-06-18, branch `performance-tuning`):**
1. ✅ **DB-1** — wrap ingestion chunk + embedding inserts in transactions (`ingestion/index.ts`). *Biggest USB import win.*
2. ✅ **DB-2** — add `synchronous=NORMAL`, `busy_timeout`, `mmap_size`, `cache_size`, `temp_store` PRAGMAs (`db.ts`).
3. ✅ **DB-4** — `idx_embeddings_model` (+ DB-6/DB-7 indexes while in `db.ts`; `run_id` indexes omitted — no join site).
4. ✅ **RAG-2 / ING-1** — decode doc-B vectors once in compare mode-(b) (`doctasks/manager.ts`).
5. ✅ **DB-3 / ING-2** — de-N+1 `listDocuments` into grouped queries (`ingestion/index.ts`).
6. ✅ **RT-1** — set chat `--batch-size`/`--ubatch-size` (`runtime/sidecar.ts`) + arg test.

Decisions folded into `docs/architecture.md` "Performance — design record (perf audit 2026-06-18, Wave P1)".

**Wave P2 — renderer responsiveness (CPU-only hardware) — ✅ DONE (2026-06-18; FE-5 + heaviest
FE-3/4 sub-parts deferred):**
7. ✅ **FE-1** — memoized `MessageBlock` + `AssistantMarkdown`; live `streamText` renders as plain text until completion; gated scroll effect.
8. ✅ **FE-2** — `useMemo` the DocumentsScreen derivations + one-pass rail counts.
9. ✅ **FE-7** — poll `getImportJob` only during import/attach; refresh the list on a completion transition.
10. ✅/⏳ **FE-3/FE-4/FE-5** — `React.memo` Transcript/ConversationList + ConvRow with stable handlers (done); **deferred:** Composer/`input` move, `DocRow` extraction, list windowing (FE-5; the scroll-thrash half landed under FE-1).

Decisions folded into `docs/architecture.md` "Performance — design record (perf audit 2026-06-18, Wave P2)".

**Wave P3 — pipeline throughput & latency:**
11. **ING-3** — 1-deep parse/embed import pipeline.
12. **ING-5** — 1-deep OCR render/recognize look-ahead.
13. **RT-2** — move stable grounding rules to the cacheable system prompt; cap RAG context on CPU.
14. **RT-3** — hash only the active model on the chat path; full set only on Models-screen visits.
15. **RT-4** — set embedder batch size; **RT-5** tighten health poll; **RAG-1** dot-product fast path.

**Wave P4 — when the D15 ANN trigger fires (deferred, tracked):**
16. **RAG-1 / RAG-6** — ANN index (sqlite-vec) or worker-thread scan with resident contiguous vectors; this is the real fix for the synchronous main-thread vector scan as the corpus grows.

Plus the **Low** items (DB-5/DB-8, RAG-5/RAG-7/RAG-8, ING-6/7/8/9/10, FE-8/9/10, RT-6/7/8/9) opportunistically when touching those files.

---

## 7. Notes & caveats

- This is a static read of the code on branch `Skills-implementation`; no profiler traces
  were captured. Where the code or design records already carry measured numbers (Skills
  §17 prefill 3.5–15 s CPU; rag-design §12.3 rerank ≈24.7 s), they are cited; the rest are
  reasoned from algorithmic complexity and the USB/CPU target, and should be confirmed with
  a profiler on a representative corpus before large refactors.
- Several headline cliffs (RAG-1 linear scan) are **known, documented MVP deferrals** —
  flagged here for completeness with the cheap constant-factor wins that *don't* require the
  full ANN work separated out (RAG-1 dot-product, DB-4 index, mmap).
- Honor the doc-lifecycle rule: once a wave is implemented, fold its decisions into the
  relevant topic doc (`docs/rag-design.md`, `docs/architecture.md`, `docs/benchmark.md`) and
  retire the corresponding items here rather than letting this report drift.
