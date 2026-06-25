# Architecture — HilbertRaum

_Last updated: 2026-06-20. Absorbs the GPU §1–§8, downloader, audit-log and depth-mode design records. Feature changes since: Phase 38 (scanned-PDF/photo OCR), the whole-document-analysis wave (Phases 1–4 — deep index, coverage meter, structured extract, symmetric compare; record in [`rag-design.md`](rag-design.md) §14), and **image understanding** (the Images screen — Phases V1–V5; design record "Image understanding — design record" below)._

## Overview

HilbertRaum is an **Electron** desktop app. It maps the spec's Tauri/Rust design onto
TypeScript while preserving the same module boundaries (spec §7) and command surface (spec §9.1), so
a future move to Tauri/Rust is a localized swap.

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed)                                    │
│  Screens: Onboarding · Home · Chat · Documents · Images ·      │
│           AI Model · Settings (General/Privacy & data/Diag.)   │
│  No Node / no network access — only window.api (typed bridge)  │
└───────────────▲───────────────────────────────┬──────────────┘
                │ contextBridge (preload)        │ IPC events (streams)
┌───────────────┴───────────────────────────────▼──────────────┐
│ Main process (the "backend")                                   │
│  ipc/        → handlers mirroring spec §9.1                     │
│  services/   (~30 top-level modules + subsystem dirs —          │
│              see Module ↔ spec map below)                        │
│    workspace · db (node:sqlite) · models · runtime/ ·          │
│    chat · ingestion/ · embeddings/ · rag · reranker/ ·         │
│    doctasks/ · analysis/ · collections ·                       │
│    transcriber/ · ocr/ · benchmark · policy · audit ·          │
│    downloads · logging · security/                             │
└──────────┬──────────────────┬────────────────────┬───────────┘
           │ spawn (Phase 10)  │ spawn (Phase 36)    │ files
   ┌───────▼────────┐  ┌───────▼────────┐  ┌─────────▼─────────┐
   │ llama.cpp       │  │ whisper.cpp     │  │ Drive / workspace │
   │ llama-server    │  │ whisper-cli     │  │ models/ workspace/│
   │ 127.0.0.1 only  │  │ per-file spawn  │  │ logs/ config/     │
   └────────────────┘  └────────────────┘  └───────────────────┘
```

## Process model & security
- **Renderer**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Talks only to
  the preload bridge.
- **Preload**: exposes a single typed `window.api` object (see `src/preload/index.ts`).
- **Main**: owns all file I/O, the database, the model runtime, and the llama.cpp sidecars.
- **CSP**: same-origin only; no remote origins. Applied as both an `index.html` meta tag and a
  response header (`session.webRequest.onHeadersReceived`) — strict in production, HMR-compatible in
  dev. See [`security-model.md`](security-model.md).

## Swappable interfaces (spec §9.2)
- `ModelRuntime` — `MockRuntime` **or** `LlamaRuntime`, chosen per `start()` by availability (Phase 10).
- `Embedder` — `MockEmbedder` **or** `E5Embedder`, chosen by availability (Phase 10).
- `Reranker` — `LlamaReranker` **or null**, chosen by availability (Phase 21). Deliberately no mock:
  a mock reranker would invent an ordering; null keeps retrieval byte-identical to the
  vector-only pipeline.
- `DocumentParser` — txt/md/pdf/docx/csv adapters (Phase 4); plus `AudioParser` (wav/mp3/flac/ogg
  → whisper.cpp transcript, Phase 36) and `ImageParser` (png/jpg/jpeg → OCR, Phase 38).
- `VectorIndex` — cosine over SQLite-stored vectors (Phase 5) → `sqlite-vec`/HNSW later;
  hybridized with an FTS5 keyword pass + RRF in `rag.retrieve` (Phase 21).
- `VisionAnalyzer` — the lazy vision sidecar (`services/vision/`) **or** absent: with no vision
  model the Images screen shows a calm unavailable state. A dedicated multimodal `llama-server`
  (own `LlamaServer`, NOT the chat `RuntimeManager`) — see "Image understanding — design record".

## Storage
`node:sqlite` — built into the Node bundled by **Electron ^37** (Node 22.x). It is loaded via
`createRequire` in `services/db.ts` because the experimental module is absent from
`module.builtinModules`, which otherwise makes bundlers try to resolve a non-existent `sqlite`
package. One SQLite DB per workspace (`workspace/hilbertraum.sqlite`) holds the original spec §8 tables
(settings, conversations, messages, documents, chunks, embeddings, runtime_events) **plus** additive
tables for document organization (`collections`, `document_collections`, `conversation_documents`),
whole-document analysis (`tree_nodes`, `tree_edges`, `summary_cache`, `extraction_records`), Skills
(`skills`, plus the nullable `conversations.active_skill_id` + `messages.skill_id` refs), and the
FTS5 virtual tables (`chunks_fts`, `messages_fts`). The authoritative schema is `services/db.ts`. In
encrypted mode (Phase 9) the whole DB file is encrypted at rest.

**Skills** (`skills` table + the nullable `conversations.active_skill_id` / `messages.skill_id` refs)
are a derived index over **plain folders outside the encrypted workspace** (`app-skills/` read-only +
`user-skills/` read-write); the registry, import/lifecycle, prompt integration, the Tier-2 tool gate,
the bank-statement tools, and the run UI are consolidated in the **"Skills — design record (Phases
S2–S12)"** below (security model in [`security-model.md`](security-model.md), layout in
[`drive-layout.md`](drive-layout.md)).

## Performance — design record (perf audit 2026-06-18, Wave P1)
Condensed from `docs/performance-audit-2026-06-18.md` after Wave P1 shipped (doc-lifecycle rule;
the full findings report stays as the audit record). Target that shapes every choice: HilbertRaum
runs **fully offline from a high-latency portable USB drive** on **commodity/CPU-only laptops**, so
fsync/seek I/O and main-thread CPU are the scarce resources. The wins below are constant-factor /
batching — no behavior change.

**Storage write path (`services/db.ts`, `services/ingestion/index.ts`).**
- **DB-1 — ingestion writes are transactional.** `processDocument` was the lone batch writer not
  wrapping its inserts (every other — `tree-build`, `extract`, `node-vectors`, bank/invoice — does).
  With WAL each bare `insert.run()` is its own fsync'd auto-commit, and each chunk insert also fires
  the `chunks_fts_ai` FTS trigger inside that commit: up to ~3000 fsync'd commits per document. The
  delete-then-insert chunk phase and the embedding-insert phase are each now one `BEGIN…COMMIT`
  (`ROLLBACK` on throw, the `tree-build.ts` pattern). The async `embedder.embed()` await stays
  **outside** the transaction (only synchronous inserts go inside — the `node-vectors.ts` precedent).
- **DB-2 — portable-drive PRAGMAs.** After `journal_mode=WAL` + `foreign_keys=ON`, `openDatabase` now
  also sets `synchronous=NORMAL` (WAL-safe durability, far fewer fsyncs), `busy_timeout=5000` (the
  concurrent import-vs-chat path waits instead of throwing `SQLITE_BUSY`), `mmap_size=268435456`
  (256 MB — the vector scan reads BLOBs via mapped pages), `cache_size=-16000` (~16 MB page cache),
  `temp_store=MEMORY`. **These are a data-contract / durability change** (NORMAL is the WAL-recommended
  setting; only the last txn is at risk on OS/power loss, never corruption).
- **DB-4/6/7 — additive indexes** (created `CREATE INDEX IF NOT EXISTS` after `ensureColumn`, so the
  migrated `category_id` column exists): `idx_embeddings_model` on `embeddings(embedding_model_id)`
  (every retrieval + stale-check filters it); `idx_extract_type_nv` on
  `extraction_records(record_type, normalized_value)` (the unscoped "list every date/amount" path the
  doc-leading `idx_extract_doc_type` can't serve); `idx_documents_status` on `documents(status)`;
  `idx_bank_transactions_category` on `bank_transactions(category_id)`. **`run_id` indexes deliberately
  omitted** — `run_id` is only ever INSERTed, never joined/filtered, so an index would be pure
  write-amplification on USB; add one alongside the first query that joins on it.
- **DB-3/ING-2 — `listDocuments` de-N+1'd.** The per-row chunk COUNT + per-indexed-row stale-embeddings
  COUNT+JOIN (up to 1+2N queries, polled at 400 ms during import) are now two grouped queries loaded
  into Maps (`GROUP BY document_id`), mirroring the memberships join beside them. Benefits from
  `idx_embeddings_model`.

**Compare retrieval (`services/doctasks/manager.ts`).**
- **RAG-2/ING-1 — decode doc-B once.** Section-matched compare (mode b) ran `VectorIndex.search` per
  doc-A chunk, re-issuing the doc-B embeddings query and re-decoding every doc-B vector each time
  (O(N_A × N_B) redundant decodes + N_A re-scans), then re-fetched doc-B's text per window. Doc-B's
  `(id, text, chunk_index, vector)` is now loaded **once** into a resident array; cosine runs in memory
  via a local `nearestB()` reproducing the search ranking. Mirrors the `alignNodes` precedent
  (`doctasks/compare.ts`).

**Chat runtime (`services/runtime/`).**
- **RT-1 — chat prefill batch.** The chat sidecar left `--batch-size`/`--ubatch-size` at llama-server's
  512 default, chunking prompt prefill (skill fence + RAG excerpts + history) — the dominant
  time-to-first-token cost (3.5–15 s on CPU, Skills §17). `LlamaServerOptions.physicalBatchSize` (opt-in,
  emitted by `buildArgs`) is set by the chat runtime to `min(contextTokens, CHAT_MAX_PHYSICAL_BATCH=2048)`;
  the embedder/reranker don't set it (they tune their own batch via `extraArgs`, the reranker precedent
  at `reranker/llama.ts`). Capping at the context never over-allocates — the whole prompt can't exceed
  `n_ctx`.

Deferred to later waves (tracked in the audit §6): the import & OCR pipelines (ING-3/5, Wave P3),
`cache_prompt` grounding split (RT-2), and the main-thread linear vector scan / ANN index
(RAG-1/RAG-6, Wave P4 — the documented D15 deferral).

## Performance — design record (perf audit 2026-06-18, Wave P2)
Renderer responsiveness on the CPU-only target. The chat transcript and the Documents screen were
re-doing O(list) work and re-parsing Markdown on a 40 ms / 400 ms cadence, competing with token
generation and causing visible jank. All changes are memoization / polling and are
**behavior-preserving** (no visible UI change except less jank) save the one streaming decision
noted below.

**Chat transcript (`renderer/chat/Transcript.tsx`, `renderer/screens/ChatScreen.tsx`).**
- **FE-1 — streaming no longer re-parses the whole transcript.** Each persisted turn is a memoized
  `MessageBlock` (React.memo, keyed by message id) and `AssistantMarkdown` is itself `React.memo`'d
  (keyed by its text), so a ~40 ms `streamText` flush never re-parses a prior, unchanged message's
  Markdown. **DECISION — the live answer streams as PLAIN TEXT** (`.msg-content`, `white-space:
  pre-wrap`), not Markdown: re-parsing the growing buffer every flush was O(n²) over the reply
  length. The full Markdown parse runs **once on completion**, when the turn re-renders from
  `messages` as a `MessageBlock`. The only visible effect is that raw `**markers**` show literally
  during the stream and snap to formatted on completion — accepted (audit-sanctioned). The visible
  text stays non-live (audit L7); `StreamAnnouncer` still announces sentence-by-sentence.
  `lastAssistantId` is `useMemo`'d (was a per-flush `[...messages].reverse().find`), and the
  scroll-to-bottom effect is gated on an `atBottomRef` so a flush only forces layout + scroll while
  the user is pinned to the bottom (also addresses the FE-5 scroll-thrash note).
- **FE-3 — chat children memoized; stable handler identities.** `Transcript` and `ConversationList`
  are `React.memo`'d. ChatScreen re-renders on every keystroke (input state) + every flush; a
  `useEventCallback` (latest-ref) wrapper gives the handlers passed to those children
  (`onCopy`/`onSave`/`onTryAgain`/`onAnswerWithoutSkill`, `onSelect`/`onNew`/`onDelete`/`onCollapse`)
  **constant identities without stale captures**, and the teaching `emptyState` is `useMemo`'d
  (keyed on mode/docs, never on `input`). So a keystroke no longer re-renders the transcript
  (compounding FE-1) or re-runs `groupByProject`/`groupConversations`.
- **FE-4 — conversation rows memoized.** `ConvRow` (React.memo) with stable per-row callbacks, so
  opening one row's ⋯ menu (which flips the parent `menuOpenId`) no longer re-renders every row.

**Documents screen (`renderer/screens/DocumentsScreen.tsx`).**
- **FE-2 — derivations memoized.** The render body — re-run on every 400 ms import poll and every
  unrelated state change (menu/hover/modal) — did 5+ array passes + a Map build each time. The
  derived collections, `sourcesById`, `visibleDocs` (section filter + recent ordering; `inSection`
  is now a pure module helper), `anyActive`/`staleDocs`, and the four rail counts (now one bucketing
  pass) are `useMemo`'d on `[docs]`/`[collections]`/`[docs, section]`.
- **FE-7 — poll the import job, not the whole list.** **CONTRACT/behavioral note:** both import
  watchers (DocumentsScreen `watchJob`, ChatScreen `watchAttachJob`) now read only the small
  `getImportJob` status on the 400 ms tick; the full `listDocuments` (+ attachment) refresh runs
  only when the job's `completed + failed` count changes (a file finished) and once at completion —
  the ModelsScreen download-poll pattern. The list therefore updates at **file-completion
  granularity** instead of re-deriving the whole screen 2.5×/s. For attachments this is exactly when
  the FK-guarded `conversation_documents` link row appears, so the "Files in this chat" reveal is
  unchanged.

**Deferred within Wave P2** (lower-confidence under the behavior-preserving mandate; tracked in the
audit §6 / §4.4): the remainder of FE-3 (memoizing `Composer` + moving `input` state into it —
needs the footer's `ScopePopover`/`DepthMenu`/`SkillPicker` handlers stabilized first, a larger
refactor); the FE-4 `DocRow` extraction (a ~25-prop memoized row — high stale-closure surface); and
**FE-5** list windowing of the transcript + document list (needs a measured approach to preserve
scroll-to-bottom + a11y; the cheap scroll-thrash half of FE-5 is already done under FE-1).

## Performance — design record (perf audit 2026-06-18, Wave P3)
Pipeline throughput & latency on the two hottest operations — **import a document** and **ask a
question** — plus runtime-startup knobs. Unlike P2 (pure memoization), several P3 items are
**structural** (concurrency, prompt layout, runtime flags), so each preserves a stated correctness
contract. Condensed from `docs/performance-audit-2026-06-18.md` §4.2/§4.3/§4.5 after Wave P3 shipped.

**Import pipeline (`services/ingestion/index.ts`, `ipc/registerDocsIpc.ts`).**
- **ING-3 — 1-deep parse/embed pipeline.** Import was fully serialized: per file, parse → chunk →
  embed (sidecar round-trips) → write, each fully awaited, so file N+1's parse (CPU) never overlapped
  file N's embed (I/O wait). `processDocument` is now split at the **already-DB-mediated chunk↔embed
  boundary** into `prepareDocument` (setup → parse → chunk → persist chunks, leaving the doc in
  `embedding`) and `finalizeDocument` (embed the persisted chunks → mark `indexed`); `processDocument`
  is their back-to-back composition, so the reindex / OCR re-ingest / materialize callers are
  behavior-identical. The import loop runs `prepareDocument(N+1)` **while** `finalizeDocument(N)`
  embeds. **The embed sidecar is the single contended resource, so embeds are NEVER parallelized** —
  only the next file's parse overlaps the prior embed. Per-file `ImportJobStatus` counts, ordering,
  per-file error isolation (each phase self-captures failure on the row), the DB-1 per-phase
  transactions, and lock-mid-job are all preserved (the look-ahead is drained + de-registered from
  `processing` on a lock break so the post-job reconcile still fires). Transients (decrypted working
  copies) shred at the **end of prepare** — the embed phase reads chunk text from the DB, not the
  files — strictly shortening plaintext lifetime. **New data contract:** `prepareDocument` /
  `finalizeDocument` / `PreparedDocument` are exported alongside `processDocument`.

**OCR (`services/ocr/pipeline.ts`, `services/ocr/rasterizer.ts`).**
- **ING-5 — 1-deep render/recognize look-ahead.** OCR rendered page N (pdfjs, hidden window) then
  awaited recognize(N) (WASM tesseract) before rendering N+1 — two different engines run strictly
  serially. A new pure `pipelinePages(pageCount, renderPage, onPage, opts)` helper renders page N+1
  **while** page N recognizes, keeping recognitions serial and in order. Memory stays bounded (at most
  one extra rendered PNG resident); page ordering, progress %, and cancellation are unchanged. The
  helper is Electron-free so it is unit-testable with fake render/recognize functions.

**Grounded-answer prompt (`services/rag/index.ts`).**
- **RT-2 — cacheable grounding prompt (updates §17 (a) to implemented).** The stable grounding rules +
  preface rode in the per-turn USER message, so `cache_prompt`'s longest-common-prefix reuse stopped
  at `BASE_SYSTEM_PROMPT` and re-prefilled the whole rules block on every documents turn (the prior
  user turn is replayed as the RAW question, so the grounded prefix never matched). They now live in a
  new **`GROUNDED_SYSTEM_PROMPT`** (`BASE_SYSTEM_PROMPT` + the rules); the user turn carries only the
  per-turn question + excerpts (+ the skill fence, which stays in the user turn as **untrusted
  reference text** — never `system`, skills plan §11.2). ~58 approx tokens of rules now sit in the
  always-reused system prefix instead of re-prefilling per follow-up. **Correctness preserved:**
  precedence is unchanged/strengthened (rules in `system` ≥ the user turn, still outrank the fence);
  the `[Sn]` citation contract and the no-context refusal path are untouched; the skill-fence
  budget is sized against `GROUNDED_SYSTEM_PROMPT` so the total fixed-token reserve is unchanged.
  A test asserts the system prefix is **byte-stable across two turns** (the precondition for reuse).

**Model verification on the chat path (`services/models.ts`, `ipc/registerModelIpc.ts`).**
- **RT-3 — lazy model hashing.** `listModels` fired on both the Models-screen visit and the workspace
  gate into Chat, SHA-256-hashing every present multi-GB GGUF on a cold cache (minutes of USB I/O) on
  the awaited IPC. `buildModelList` gains an additive **`onlyVerifyModelId`**: when present, only that
  model is hashed on a cold cache; other present weights are reported `installed` **without** hashing
  (display-only) — a live cached hash is still served for free, so a known `checksum_failed` still
  surfaces. Threaded via a new optional `lazyVerify` arg on the `listModels` IPC: the `WorkspaceGate`
  (chat path) passes `true` with the active model id; the Models screen omits it and hashes the full
  set. **The §7.4 gate is intact** — `startModelRuntime` re-verifies the model it actually launches,
  and `verify-models --strict` / `assertCommercialDrive` still hash fully.

**Sidecars (`services/runtime/sidecar.ts`, `services/embeddings/e5.ts`).**
- **RT-4 — embedder physical batch.** In `--embedding` mode llama-server forces `n_batch = n_ubatch`
  and defaults both to 512, so a 32-input embed request co-decodes ~1 full-length sequence per physical
  batch. The embedder now sets `--batch-size`/`--ubatch-size` to `max(ctx, 2048)`, packing multiple
  in-context inputs per ubatch (each input ≤ ctx still fits one ubatch — required because mean pooling
  cannot split a sequence). Mirrors the chat 2048 (RT-1) and the reranker's raise (different reason —
  one big query+doc sequence). **Verified on the pinned b9585 binary** (PAID smoke drive): with both
  flags at 2048 the "`n_batch (2048) > n_ubatch (512) … setting n_batch = n_ubatch = 512`" downgrade
  warning does not fire and a multi-input `/v1/embeddings` request returns correctly.
- **RT-5 — readiness-poll backoff.** `waitForHealthy` polled `/health` at a fixed 250 ms, so a
  fast-ready sidecar paid up to a full interval of dead time on every start / model switch. It now
  starts at 50 ms and doubles each miss up to the configured cap (`healthIntervalMs`, default 250 ms);
  the overall timeout budget is unchanged, and a tiny test interval caps the initial too.

**Vector search (`services/embeddings/index.ts`).**
- **RAG-1 — dot-product fast path (cheap slice only).** Stored vectors and the query vector are both
  L2-normalized (`e5.ts` `l2normalize`; the mock embedder too), so cosine == raw dot product. A new
  `dotProduct` helper replaces `cosineSimilarity` in `VectorIndex.search`, dropping the two per-row
  norm accumulators (~2× fewer FLOPs/row); ranking is identical to floating-point tolerance (asserted
  by a test). **The off-main-thread / ANN scan stays Wave P4** (the documented D15 deferral) — this is
  only the constant-factor slice.

Implemented in Wave P4 (below): the per-query BLOB re-read + re-decode (RAG-1/RAG-6 beyond the dot
product). Still deferred from P2: Composer/`input` move, `DocRow` extraction, FE-5 windowing.

## Performance — design record (perf audit 2026-06-18, Wave P4)
The real fix for the synchronous main-thread vector scan (RAG-1/RAG-6) — the documented MVP deferral
D15. Condensed from `docs/performance-audit-2026-06-18.md` §4.2 after Wave P4 shipped. Stays behind the
**unchanged `VectorIndex.search(queryVector, topK)` signature**, so `rag/index.ts retrieve()` and every
scope filter are untouched. The sibling scans in `analysis/node-vectors.ts` (the summary-tree
`node_vectors` table) and `doctasks/manager.ts` (compare's one-shot doc-B load) are NOT `VectorIndex`
and are out of scope.

**RAG-1 / RAG-6 — process-resident decoded-vector cache (`services/embeddings/resident-cache.ts`).**
The scan SELECTed all matching `embeddings` rows **including `vector_blob`** (~150 MB at the heavy
100-doc × 1000-chunk bound) and `decodeVector` + `dotProduct`'d every row in one uninterruptible
main-process loop — **re-reading and re-decoding the same BLOBs on every question**. Now every stored
vector is decoded **once** into a process-resident `Map<chunkId, Float32Array>` (one cache per open
`Db`, `WeakMap`-keyed). A query keeps the **exact same scope-filtered WHERE** but projects only
`chunk_id` (no blob read), then looks each vector up in the resident map — zero per-row allocation,
zero re-decode. **Ranking is byte-identical** (same `dotProduct`, same sort); the dimension-mismatch
skip and the truncated-blob skip are preserved (a short blob is excluded at build time, so the chunk is
simply absent from the map). The vector ↔ BLOB codec moved to `embeddings/codec.ts` so the cache can
decode without an `index ↔ resident-cache` import cycle (re-exported from the barrel).

**Invalidation contract (the highest-risk surface — a stale buffer silently corrupts ranking).**
Belt-and-suspenders:
- **Staleness (primary):** a cheap whole-table signature `(COUNT(*), MAX(rowid))` is recomputed at the
  top of every `search`; any change rebuilds the map. `MAX(rowid)` is O(1) (rightmost btree leaf) and
  `COUNT(*)` is a fast index count — negligible vs the scan they gate. Catches inserts (import),
  deletes (doc delete), and reindex (delete+insert raises `maxRowid`) — i.e. **every `embeddings`
  mutation, including direct SQL writes that bypass the hooks** (so test seeding stays correct).
- **Explicit (belt):** `invalidateResidentVectors(db)` is also called at the three `embeddings` write
  sites — `ingestion/index.ts` finalize-insert + reindex chunk-phase delete + `deleteDocument`. This
  closes the one signature blind spot (delete the single max-rowid row, then insert exactly one row
  reusing that rowid → `(count, maxRowid)` unchanged).
- **Security (lock):** `purgeResidentVectors(db)` drops the map outright on workspace LOCK
  (`registerWorkspaceIpc`, beside the embedder's `suspend()`). The vectors are derived from chunk text
  and must not linger in main-process RAM after the vault re-encrypts — a requirement the staleness
  signature does NOT cover (the table is unchanged on lock). No embedder-switch purge is needed: the
  cache is per-`Db` and per-chunk (model-agnostic), the SQL model-id filter scopes results, and unlock
  reopens the `Db` → a fresh (empty) cache.

**Measurement — confirmed on the PAID drive (D:, b9585; the "real E5-runtime numbers PENDING" item is
now closed).** Two legs, because the scan is **data-independent** (N dot-products of 384-dim Float32 +
sort — identical timing for random unit vectors and real E5 outputs); only the cold-build I/O and the
query-embed round-trip are real-hardware variables.
- **Scan scaling, DB on the real drive (synthetic vectors).** Warm cached scan vs the old
  decode-every-query path: 13.6 ms vs 22.4 ms @ 5k chunks (1.7×), 52.5 ms vs 63.3 ms @ 10k (1.2×),
  164.6 ms vs 225 ms @ 30k (1.4×), 605 ms vs 753 ms @ 100k (1.2×). Cold rebuild (once per mutation,
  not per query) 33 ms @ 5k … 1.48 s @ 100k. These track the earlier mock/SSD projection (~14/50/167/
  580 ms) within noise — mmap (DB-2) keeps the cold build off USB cheap, so the drive does not move the
  numbers.
- **Real E5 vectors, end-to-end on the drive** (genuine `multilingual-e5-small-q8` outputs from the
  b9585 sidecar, stored through the production codec, queried via `searchText`): @2k chunks (a realistic
  ≤~10-doc corpus) warm scan **5.8 ms**, cold build 17.7 ms, full query (E5 embed round-trip + cached
  scan) **17.8 ms** — the **query-embed dominates the scan 3.1×**; @10k chunks warm scan 73 ms, cold
  build 317 ms, full query 102 ms (embed still dominates 1.4×). Real-E5 warm-scan timing matches the
  synthetic table at the same N, confirming data-independence.

The win is the removed per-query BLOB re-read + re-decode (RAG-6 — also a real GC/memory-pressure win
the wall-clock under-reports); the **residual is now SQLite→JS row marshalling + the dot-product scan +
sort, not decode**. The measurements live in `tests/manual/resident-cache-bench.test.ts` (scan scaling,
`RESIDENT_BENCH_DIR` points the DB at the drive) and `tests/manual/resident-cache-real.test.ts` (real-E5
end-to-end, `HILBERTRAUM_RESIDENT_REAL` points at the drive root).

**Why the worker (P4b) and ANN (P4c) stay DEFERRED — evidence-based (now real-drive confirmed).** At
realistic MVP corpora (≤~10k chunks ≈ ≤~10–50 documents) the cached scan is single-digit-to-~70 ms on
the real drive — fine on the main thread. The measured query path is the proof: at 2k chunks the scan is
5.8 ms and the **query-embed round-trip dwarfs it 3.1×**; at 10k the scan (73 ms) and embed (~29 ms) are
comparable, and **both are dwarfed by the reranker (seconds)** when engaged. So nothing in the realistic
range makes the synchronous scan the bottleneck. Only the heavy ~100k-chunk upper bound (~605 ms on the
drive) still blocks — the narrowed remaining D15 cliff.
- **P4b (off-main-thread worker).** Genuine fix for the event-loop block at scale, but heavy
  (`SharedArrayBuffer` for the vectors, a second read-only DB handle or id-set hand-off, abort/cancel,
  writer-race avoidance) — all of which must stay offline. **Trigger:** a representative corpus measures
  the cached main-thread scan over ~100 ms routinely. The resident cache is the substrate a worker
  would scan via `SharedArrayBuffer`, so P4a is also P4b's groundwork.
- **P4c (ANN — sqlite-vec / pure-JS HNSW).** sqlite-vec is a **native loadable SQLite extension**, which
  is against the no-native-build / portable cross-OS packaging posture that put the embedder in a
  llama.cpp sidecar rather than `onnxruntime-node` (D15's reasoning). Not adopted; a pure-JS HNSW would
  be reconsidered only if a linear scan over the resident buffer (even off-thread) still bites.

## Performance — design record (perf audit 2026-06-18, Wave P5)
Three remaining Medium findings on hot/felt paths, all bounded and **behavior-preserving**.
Condensed from `docs/performance-audit-2026-06-18.md` §4 after Wave P5 shipped (doc-lifecycle rule).

**Hot-path prepared statements (`services/db.ts`, `chat.ts`, `collections.ts`, `ingestion/index.ts`).**
- **DB-5 — cache compiled statements per connection.** `node:sqlite` re-parses AND re-plans the SQL
  text on every `db.prepare()`, and the hottest per-chat-turn read/write paths re-compiled the same
  STATIC SQL each call. A new **`prepareCached(db, sql)`** (a module-level `WeakMap<Db, Map<sql, Stmt>>`)
  compiles each distinct SQL string once per connection and reuses the `StatementSync`; the `WeakMap`
  lets the statements GC with their `Db` (no leak across encrypted-workspace open/close). Routed
  through it: `chat.ts` `listMessages` / `appendMessage` (insert + the `updated_at` bump) /
  `getConversation` / `listConversations`; `collections.ts` `resolveScope` (the scope-row select +
  the attachments select, ~2×/turn); the four `listDocuments` DB-3 grouped-counter prepares. **HARD
  CONSTRAINT:** only CONSTANT-SQL callers use it — any prepare built with a dynamic `IN (?, …)` arity
  (or otherwise per-call-varying text) stays on `db.prepare()`, since caching those would leak
  unbounded entries and/or bind the wrong arity. Results and ordering are unchanged; a unit test
  asserts statement-object reuse for identical SQL, distinctness for different SQL, per-`Db` isolation,
  and unchanged results across reuse.

**Import selection walk (`services/ingestion/index.ts`).**
- **ING-4 — halve the walk's syscalls.** `expandPaths` walked the picked tree with `readdirSync(dir)`
  **plus a `statSync` per entry**, and the tree is walked twice (the preflight IPC
  `summarizeImportPaths`, then again on import via `expandPathsWithSource`). On USB each `statSync` is a
  real seek on the synchronous event loop. `walk()` now uses `readdirSync(dir, { withFileTypes: true })`,
  so directory-vs-file is known from the readdir syscall itself — one syscall/entry instead of two.
  **Symlink subtlety (behavior-preserving):** a `Dirent` does NOT follow symlinks (it reports
  `isSymbolicLink()`, never `isDirectory()/isFile()`), whereas the old `statSync` DID — a symlink to a
  dir was walked, a symlink to a supported file added (intentional, audit L3/L5). So only plain
  dirs/files take the cheap `Dirent` path; a symlink (or any special entry) falls back to
  `statSync(full)`, reproducing the exact link-following expansion set. Tests prove a dir-symlink is
  still walked and a file-symlink still added (skipped where the OS denies symlink creation, e.g.
  Windows without the privilege). **SKIPPED — the optional cross-call cache** (reuse the preflight's
  expansion on import to avoid the second walk): preflight and import are separate IPC calls and the
  filesystem can change between them, so a cross-call cache carries a real staleness risk for a modest
  gain; the per-walk syscall win is the safe, unconditional part.

**Document preview pagination (`shared/types.ts` + `ipc.ts`, `ingestion/index.ts`, `ipc/registerDocsIpc.ts`, `preload`, `DocumentsScreen.tsx`).**
- **FE-6 — paginate the preview.** The preview returned the whole extracted document as one IPC payload
  and mounted every segment synchronously (a large PDF/transcript crossed the bridge as one giant JSON
  blob and hitched the modal). `DocumentPreview` gains **OPTIONAL** `totalSegments` + `nextOffset`;
  absent ⇒ the payload is the whole document (so internal consumers and old mocks are unaffected). A new
  service wrapper **`extractDocumentPreviewPage(offset, limit)`** (`DEFAULT_PREVIEW_PAGE_SIZE = 50`)
  slices the UNCHANGED `extractDocumentPreview` and sets the cursor; `previewDocument` now returns the
  first page and a new `previewDocumentPage` IPC serves the rest. The modal accumulates pages behind a
  "Show more" control + a "Showing X of N" hint. **HARD CONSTRAINT preserved:** the internal full-text
  consumers — `registerSkillsIpc`, `doctasks/manager` (compare/translate), `registerRagIpc` — keep
  calling `extractDocumentPreview` and get ALL segments (their tests pass unchanged). **TRADE-OFF:**
  there is no partial parse, so each page re-extracts + slices; the common single-glance case is strictly
  better (same one parse, tiny payload), and only reading a huge doc page-by-page re-parses per "Show
  more" — bounded to one parse per interaction (what the old code paid up front). `requireNotProcessing`
  + deterministic parse keep `totalSegments`/slices stable across page calls.

Deferred with explicit, unmet triggers (recorded, not built): P4b worker/`SharedArrayBuffer` scan
(trigger: cached main-thread scan >100 ms routinely; measured ≤70 ms @10k chunks), P4c ANN/sqlite-vec
(rejected — native loadable extension vs the no-native-build posture, D15), and the behavior-sensitive
renderer items FE-5 list windowing / FE-3 Composer-`input` move / FE-4 `DocRow` extraction.

## Performance — design record (perf audit 2026-06-18, Wave P6 — Low backlog)
The opportunistic **Low** findings, resolved as a closing wave (branch `performance-low-backlog`). All
are **behavior-preserving** internal optimizations — no change to ranking, query results, parse output,
or visible UX. This section folds in the audit's §4 Low items and **retires the audit report**
(`docs/performance-audit-2026-06-18.md` deleted; the High/Medium records already live in the Wave P1–P5
sections above, the full original stays in git history). The deferred-with-trigger items (P4b/P4c/FE-3/
FE-4/FE-5) are unchanged — see Wave P4/P5 above.

**Shipped (✅):**
- **DB-8 — project columns on the targeted document getters** (`ingestion/index.ts`). `getDocumentOrigin`,
  `getDocumentSummary`, `getDocumentOcrPages` now `SELECT` only the one TEXT column each needs instead of
  the shared `getRow` `SELECT *`, so a provenance/summary read no longer also deserializes the potentially
  large `ocr_json`. Output identical (same `parseOrigin`/`parseSummary`/`parseOcr`).
- **RAG-5 — per-embedder query-vector LRU** (`embeddings/index.ts`). `searchText` serves the query
  embedding from a small LRU (`QUERY_VECTOR_CACHE_MAX = 32`) in a `WeakMap` keyed by embedder INSTANCE, so
  re-asking / "try again" / the re-index honesty re-check skip the embed round-trip that DOMINATES the scan
  at realistic corpora (Wave P4 measurement). Keyed by the EXACT query string (no lossy normalization ⇒ a
  hit returns precisely the embedder's vector — byte-identical results); a model swap is a new embedder
  instance ⇒ a fresh empty cache ("cleared on embedder change"). Tested: one embed per repeated query,
  cache shared across `VectorIndex` instances over one embedder, fresh per new embedder.
- **RAG-7 — read persisted token counts; memoize message tokens** (`rag/index.ts`, `chat.ts`). The
  retrieval budget loop reads `chunks.token_count` (which IS `approxTokenCount(text)` by construction in
  the chunker, with a recompute fallback for a legacy NULL) instead of re-scanning each candidate's text;
  carried in a side `Map<chunkId>` so it never rides the returned `RetrievedChunk` shape. `messageTokens`
  is memoized by message-object identity (`WeakMap`) — a pure function of `m.content`, summed repeatedly
  per turn (`fitMessagesToContext` then `getConversationContextUsage`). Both byte-identical.
- **ING-6 — flagged, not rewritten** (`doctasks/manager.ts`). The `materializeDocument` write-temp →
  re-parse → re-embed round-trip is DELIBERATE (it reuses the canonical import path for encryption, FTS,
  citations, and the crash-safe queue-time provenance stamp); documented in a comment so it is not mistaken
  for an oversight.
- **ING-7 — coalesce the re-index status read/write** (`ingestion/index.ts`). The chunk-replace
  transaction read `tree_status` then `extract_status` (two `SELECT`s) and reset each in its own `UPDATE`;
  now one `SELECT` of both + one combined `UPDATE` (four statements → two). The other audit-cited
  per-doc reads in `doctasks/manager.ts` were already single multi-column `SELECT`s — left as-is.
- **ING-8 — async OCR PDF read** (`doctasks/manager.ts`). `readStoredPdfBytes` now uses `await readFile`
  (node:fs/promises) instead of a blocking `readFileSync` on a PDF up to ~1 GiB, so the bytes stream off
  the main event loop; the method became `async` and its single `runOcr` caller awaits it.
- **ING-9 — `coalesceSegments` joins once** (`ingestion/chunker.ts`). Each merged page/section group
  accumulates its parts in a `string[]` and `join('\n\n')`s once at group end, replacing the
  `prev.text = prev.text + '\n\n' + …` accumulate-by-concat (O(total chars) realloc per group).
- **ING-10 — per-word token fast path** (`ingestion/chunker.ts`). `atomize` uses a new `wordTokenCount`:
  a whitespace-free word with no space-less-script char is exactly one token group
  (`len <= ONE_TOKEN_WORD_CHARS ? 1 : ceil(len / CHARS_PER_TOKEN)`), skipping `approxTokenCount`'s
  `replace()` + `split()` passes; mixed-script words fall back to the full counter. Byte-identical.
- **FE-8 — resolve the previewed doc once; titles via the Map** (`DocumentsScreen.tsx`). A `useMemo`'d
  `previewDoc` (from the existing `sourcesById` Map) replaces six linear `docs.find` scans across the
  PreviewModal props, and `titleOf` routes through `sourcesById` instead of a per-provenance-line `find`.
- **FE-10 — narrow the runnable-tools effect deps** (`ChatScreen.tsx`). `listRunnableTools` derives its
  result from the skill + the conversation's in-scope documents, NOT the message count, so the effect now
  keys on `[currentSkillId, activeId]` only; the old `messages.length` dep just re-fired the IPC after
  every turn for an identical answer (the new-conversation transition is already covered by `activeId`).
- **RAG-8 — noted, not changed** (`doctasks/compare.ts`). `alignNodes`' O(|A|×|B|) cosine product is over
  level-1 summary sections (tens) with pre-decoded vectors; a comment records the per-A top-K cap to add
  only if the tree's branching factor is ever lowered enough for section counts to grow.

**Accepted residuals (deferred with reason, not built):**
- **DB-8 (listDocuments `ocr_json`).** The document list's OCR badge needs `pageCount`/`languages`/
  `engineId`, which live ONLY inside `ocr_json`, and the list's summary preview needs `summary_json` —
  both large TEXT. Dropping the read requires either a schema migration with backfill (a behavior-risk for
  existing-data badges, beyond a Low fix) or duplicating `parseOcr`'s malformed-page validation in SQL
  JSON functions (not byte-identical). The disk page is read either way; only the targeted-getter
  projections are safely shippable now.
- **FE-9 (single chat-bootstrap IPC / shared list cache).** Post-DB-3 `listDocuments` is cheap, so the
  per-screen mount fetch is a minor cost; a cross-screen shared cache risks showing a stale list (each
  screen deliberately re-fetches on its own events) and a batched `getChatBootstrap` IPC is a non-trivial
  new IPC surface (channel + preload + handler + types + tests) for a marginal saving. Revisit if mount
  latency is ever felt.
- **RT-6 (`n_threads = cores/2`).** Reasonable default; tuning (physical cores for chat, a smaller budget
  for the CPU-pinned embedder/reranker) needs measurement on representative hybrid hardware first, and an
  over-eager bump risks oversubscription when ingesting while chatting (three CPU-pinned sidecars).
- **RT-7 (KV cache lost on GPU→CPU fallback).** A full cold prefill after a mid-session GPU crash is
  bounded to one event; `--slot-save-path` + restore is real complexity/disk weighed against a rare path.
  Accepted residual for v1.
- **RT-8 (first-run benchmark token-probe steal).** Already mitigated by startup ordering: the benchmark
  fires before `maybeAutoStartActiveModel`, so `runtime.active()` is null and the 64-token probe is skipped
  at true first-run; the steal only occurs in the rare warm-runtime + immediate-chat race, is bounded to
  one first-run event, and a precise in-flight gate needs a streaming signal not cheaply available here.
- **RT-9 (§17(b) fixed user-turn fence reserve).** The `cache_prompt` prefix-reuse win is LATENT — no
  shipped skill trims its fence, so the current live-final-turn term never actually shifts the fence text —
  while switching to a fixed reserve changes the fence-SIZING formula, a prompt-assembly change that could
  alter the fence (and thus the output) for a near-budget skill. Disallowed under the behavior-preserving
  mandate; revisit when a trimming skill ships (§17).
- **FE-3 / FE-4 / FE-5 (renderer tail).** Unchanged from Wave P2/P5: Composer-`input` move (needs footer
  handler stabilization first), `DocRow` extraction (a ~25-prop memoized row with a high stale-closure
  surface), and list windowing (no virtualization lib in deps; windowing variable-height Markdown while
  preserving scroll-to-bottom, find-in-page, and a11y is behavior-sensitive). Left deferred — not
  confidently safe under the behavior-preserving mandate.

## Models & runtime (Phase 2)
- **Manifests** are local YAML under `model-manifests/` (committed; weights are not). The schema +
  validator live in `src/shared/manifest.ts` so renderer and main share one definition. YAML is
  parsed with the pure-JS `yaml` package in the main process only.
- **`services/models.ts`** discovers manifests (recursively), validates them, and computes each
  model's state (`unsupported → missing → checksum_failed → installed`, with `running` overlaid for
  the active runtime). `local_path` is resolved **relative to the drive root**, so weights live at
  `<root>/models/...`. SHA-256 is streamed (large GGUFs never fully buffer). Placeholder hashes are
  treated as installed only in developer mode; otherwise they fail the §7.4 verification gate.
- **Checksum cache (two tiers).** Hashing a multi-GB GGUF takes minutes of USB I/O, so verified
  hashes are cached by `(path, size, mtime)`: an in-memory map (L1) plus the persisted
  `AppSettings.checksumCache` (L2, injected as a `HashStore`), so an unchanged weight file is hashed
  **once ever**, not once per session. A size/mtime change re-hashes; the AI Model screen's
  **Verify checksum** button calls the `verifyModel` IPC, which drops the cache entry and re-hashes
  for real. The ship-time gates (`verify-models --strict`, `assertCommercialDrive`) always hash fully.
- **Model verification progress (first-run bar).** The first cold pass over a fresh drive hashes the
  multi-GB weights — minutes of I/O behind what used to be an opaque spinner. `buildModelList` now
  takes an optional `onProgress(p: ModelVerifyProgress)` sink: a cheap pre-pass (`statSync` + cache
  lookup, **no hashing**) sums the bytes of only the files that will actually hash (cached / missing /
  placeholder-hash weights excluded) into `overallBytesTotal`, then `sha256File` streams a running
  byte count (throttled to one callback per 64 MB, plus a final exact-total flush) that the loop
  re-weights into the overall total and a 1-based `modelIndex / modelCount` step label. A terminal
  `done` event settles the bar to 100%. `overallBytesTotal === 0` (everything cached — the common
  2nd-run case) ⇒ **no events**, no bar. The `listModels` handler forwards the sink to the calling
  renderer over `EVENTS.modelVerifyProgress` via `event.sender` (guarded by `isDestroyed()`); the
  renderer subscribes through `api.onModelVerifyProgress`. **Surfaces:** the first-run `WorkspaceGate`
  *finishing* step and the first cold AI Model screen visit render the shared `Progress` bar
  (byte-weighted %, "Checking model N of M") in place of the spinner; both keep their existing
  fallbacks (the gate's Skip + never-trap `catch`, the screen's calm "Checking…" hint). Each pass
  carries a `runId` (`randomUUID`): `listModels` can run as **overlapping passes** (a screen remount,
  the download poll), each with a different `modelCount` as the cache warms, and the events broadcast
  to the renderer — so the renderer **locks onto the first `runId`** it sees and ignores the others
  until that pass's `done` (without this the bar flips between e.g. "1 of 1" and "2 of 2"). Additive
  behind the locked `listModels` contract; omitting the sink is zero-overhead, so tests/legacy callers
  are unchanged.
- **Recommendation is RAM-best-fit (post-MVP).** `recommendModelIdByRam(manifests, ramGb)` picks the
  LARGEST model whose comfortable RAM (`recommended_ram_gb`) fits this machine; if nothing fits
  comfortably, the lightest model meeting its minimum; else none. Used by `listModels` (live
  `machineRamGb()` = `totalmem` rounded to whole GB) and by the benchmark (same rounding, so the two
  surfaces always agree). The legacy `recommended_profiles` lookup remains the fallback when RAM is
  unknown.
- **RAM gate (post-MVP).** `buildModelList` flags `insufficientRam` on models whose
  `recommended_min_ram_gb` exceeds the machine RAM; the AI Model screen disables Select/Start and
  shows a "Needs ≥N GB RAM" badge, and `startModelRuntime` refuses to load installed weights that
  don't fit (friendly §11.4 copy — the zero-weights mock fallback is not gated). Rounding is
  `Math.round`, so a "16 GB" machine reporting 15.9 GiB still counts as 16.
- **`services/runtime/`** defines the `ModelRuntime` interface and a `RuntimeManager` that owns the
  single active runtime and restarts it on model switch. `MockRuntime` streams a deterministic echo
  with zero model files; the real `LlamaRuntime` (localhost-only sidecar) is selected when binary +
  weights exist. The factory passed to `RuntimeManager` is the only thing that changes.
- **Start is idempotent for the in-flight/running model; `startingModelId` is server truth.**
  `RuntimeManager.start()` serializes via a queue (orphan-safe on a switch), and now short-circuits
  when the requested model is **already running or already starting** — a double-click or a revisit
  to the AI Model screen before a large GGUF finished loading used to **stop-and-restart** the
  runtime (two "Start runtime" log lines, two backend selections). It tracks the in-flight
  `startingModelId` (set synchronously, cleared when the start settles) and exposes it on
  `RuntimeStatus.startingModelId`. The AI Model screen reads runtime status (and polls while a start
  is in flight) to show a disabled **"Starting…"** button that survives leaving + re-entering the
  screen — the per-component `busy` flag is lost on remount, this is not. The Chat screen's no-model
  state likewise says "your model is starting" while `startingModelId` is set. A model *switch*
  (start B while A runs) still stops A first; only same-model re-starts are suppressed.
- **IPC** (`ipc/registerModelIpc.ts`): `listModels`, `selectModel`, `verifyModel`, `startRuntime`,
  `stopRuntime`. The active runtime is stopped on `will-quit`.
- **Auto-start (post-MVP).** `maybeAutoStartActiveModel` starts the persisted `activeModelId` in the
  background once the workspace is usable (app launch for plaintext dev; unlock/create for
  encrypted), so a restarted app matches what Home shows. Same §7.4 install gate as the manual
  `startRuntime`; fire-and-forget like `maybeRunFirstBenchmark` (failures are logged, manual start
  still works). Opt-out via `AppSettings.autoStartActiveModel` (Settings toggle, default ON).

## Chat & streaming (Phase 3)
- **`services/chat.ts`** (spec §7.6) owns conversation/message persistence and prompt
  assembly: `createConversation`, `listConversations`, `listMessages`, `appendMessage`,
  `deleteLastAssistantMessage`, `buildSystemPrompt`, `buildChatMessages`, and the streaming
  orchestrator `generateAssistantMessage`. IDs are UUID v4, timestamps ISO-8601 UTC.
  Messages order by `created_at ASC, rowid ASC` so equal-millisecond timestamps keep turn
  order. The **system prompt is built per request and not persisted** — the `messages` table
  holds only user/assistant turns, so the prompt can evolve (the grounded path swaps its own
  prompt into the last user turn). `messages.citations_json` is written only by grounded answers.
- **Role alternation (fix 2026-06-14).** A failed answer persists the user turn but no
  assistant reply; left unguarded, the next turn sent **consecutive user messages**, which
  several chat templates (Mistral, Qwen tool-style) reject with `HTTP 500` ("roles must
  alternate"). `buildChatMessages` and `buildGroundedChatMessages` run `collapseToAlternating`,
  which forces strict user/assistant alternation after the system prompt by keeping the LATEST
  of any same-role run (stale orphan turns dropped) — so a conversation with earlier failures
  stays answerable.
- **History fits the context window (fix 2026-06-16).** The chat and grounded-answer message
  lists replay the WHOLE persisted history, so an accumulating conversation (or a single
  grounded turn carrying a large retrieved-chunk block) used to assemble a prompt larger than
  the model's window — an `HTTP 400 exceed_context_size_error` that never reached generation.
  `fitMessagesToContext` (in `services/chat.ts`, the single owner) now trims the history to fit
  `contextTokens`: it always keeps the leading system message(s) and the FINAL turn (the
  current question / grounded prompt — never dropped, so an unavoidable overflow is left to the
  runtime to map), and drops older turns oldest-first, keeping a **contiguous recent tail** so
  strict role alternation is preserved. A `CHAT_RESPONSE_RESERVE_TOKENS` (1024) headroom leaves
  room to generate. `buildChatMessages`/`buildGroundedChatMessages` take an optional
  `contextTokens` (the production callers pass `getSettings(db).contextTokens`; omitted = the
  pure, untrimmed builder used by unit tests). This complements the doc-task window budgets
  (`doctasks/summary.ts`), which already sized their inputs to `contextTokens` — the gap was
  only the conversational path.
- **Conversation compaction (L2, above the L1 floor).** When history approaches the **launched** context
  window (`RuntimeStatus.contextWindow?` / `effectiveContextWindow`, not `settings.contextTokens`),
  `ensureCompacted` (`services/chat/compaction.ts`) summarizes the OLDER turns **once** into a cached
  `kind='compaction'` checkpoint row and assembly thereafter replays a synthetic `user→assistant` summary
  pair + only the post-checkpoint turns — instead of silently dropping the oldest. `fitMessagesToContext`
  still runs after and still guarantees fit; below threshold (or with the `chatCompactionEnabled` setting
  off) behaviour is byte-identical to drop-oldest. Every new path fails safe (any summarizer failure ⇒ no
  checkpoint, turn proceeds). UX: a composer context-usage meter, a one-shot "summarizing…" notice
  (`STREAM.compaction`), and an expandable transcript summary marker. Full design record (L0/L1/L2 +
  trigger + summarizer + UX, with the deferred Phase-3 `/tokenize`): [`rag-design.md`](rag-design.md) §15.
- **Surfaced runtime errors (fix 2026-06-14, hardened 2026-06-16).** `LlamaRuntime.chatStream`
  throws a typed `ChatRequestError` carrying the server's `{error:{message,type}}` body
  (previously the body was discarded and only "HTTP <status>" survived). `isExceedContextError`
  recognizes the `exceed_context_size_error` (an HTTP 400 — the prompt is larger than
  `contextTokens`); the doctask manager and the chat/RAG stream wrapper map it to the friendly,
  localized `main.model.contextExceeded` ("too large for this model — try a larger-context model
  or a smaller document") instead of a raw code. The raw reason still goes to the local log only.
  **The renderer surfaces the invoke REJECTION, not the `chat:error` event** — so `withChatStream`
  now *throws the mapped friendly message* (not a raw rethrow) on overflow, and `friendlyIpcError`
  strips any `WordError:` class-name prefix (not just `Error:`). Before this, the carefully-built
  friendly copy was dead for the chat/RAG path and users saw the raw `ChatRequestError: … HTTP 400`.
- **Streaming contract (LOCKED).** Main → renderer over per-conversation IPC event channels
  keyed by the conversation id: `chat:token:<id>` (one token per event), `chat:done:<id>`
  (the final assistant `Message`), `chat:error:<id>` (an error string) — helpers in
  `src/shared/ipc.ts` `STREAM`. The renderer subscribes via the preload `onToken/onDone/onError`
  before sending. `sendChatMessage(conversationId, content, options)` *also* resolves with the
  final assistant `Message`, so a caller can simply `await` it; the event channels drive the
  incremental UI. The streaming id is the **conversation id** (one active stream per conversation).
  **Phase 20 added one ADDITIVE channel:** `chat:reasoning:<id>` (preload `onReasoning`) carries
  Deep-mode thinking deltas; token events still carry only answer text, and reasoning is a
  live-display affordance that is never persisted. A further additive channel
  `chat:scope:<id>` (`STREAM.scope`) carries a one-shot `ScopeNotice` — the filenames retrieval
  was auto-restricted to — before the first token of a document answer when filename auto-scope
  fires; informational only, never persisted.
- **Answer-depth modes (Phase 20, spec §10.3).** `ChatOptions.mode` (`fast|balanced|deep`,
  per message, sticky per conversation in the renderer) threads through
  `generateAssistantMessage` → `RuntimeChatOptions.mode`. The mapping to request parameters
  lives in ONE place, `runtime/llama.ts` `requestParamsForMode` (D4): fast = thinking off +
  temp 0.7 + 1024-token cap; balanced (and omitted) = thinking off, server defaults; deep =
  thinking on + temp 0.6. Thinking is toggled per request via
  `chat_template_kwargs.enable_thinking` (D5, verified against the pinned llama.cpp b9585);
  every chat sidecar is spawned with `--jinja --reasoning-format deepseek`
  (`CHAT_SERVER_ARGS`) so the kwarg acts and reasoning streams as separate
  `delta.reasoning_content` frames. `stripThinkBlocks` (services/chat.ts) scrubs any inline
  `<think>` block from persisted replies AND from assistant turns replayed as history (D6 —
  the collapsed "Thinking…" block is a live-stream affordance only; an all-think aborted
  reply persists nothing). Document answers (`rag/`) never pass a mode — grounded answers
  always run balanced. **Research note that shaped D4/D5:** at b9585 `--reasoning auto`
  (the server default) turns thinking ON for every capable template — the bundled Qwen3
  models were ALREADY thinking on every reply while the app silently dropped those deltas
  (pure latency cost), so `enable_thinking` is ALWAYS sent explicitly; balanced/omitted =
  `false`. The Qwen3 `/think`·`/no_think` soft switches were rejected (they leak into
  transcripts). D4's fast/deep values come from Qwen3's model-card sampling guidance
  (re-tune when the release hardware matrix lands); explicit `RuntimeChatOptions.maxTokens`/
  `temperature` always win over mode-derived values. Deep is offered only when the RUNNING
  model's manifest sets `supports_thinking_mode` (via `RuntimeStatus` — the Chat screen
  already polls it; see `model-policy.md`).
- **Cancellation.** Each in-flight send holds an `AbortController` in a per-conversation map in
  `ipc/registerChatIpc.ts`; `stopGeneration(conversationId)` aborts it. The runtime's
  `chatStream` honours `options.signal` and stops emitting; whatever streamed so far is persisted
  as the (partial) assistant message and a normal `done` is emitted.
- **Stream recovery across navigation.** The Chat screen is unmounted when the user switches
  screens, which destroyed its `streaming` state + token listeners while the main-process
  generation kept running — on return the fresh screen looked idle yet a new message was rejected
  ("a response is already being generated"). `withChatStream` now mirrors the accumulated answer +
  reasoning into a shared `streamBuffers` snapshot (in `ipc/inflight.ts`, cleared in lockstep with
  the `AbortController`); both `sendToken` and the new `sendReasoning` it hands `runFn` write to it,
  so the chat + RAG paths buffer identically. The read-only `getActiveStream(conversationId)` IPC
  returns the live snapshot (or null). On mount/conversation-change the Chat screen, when it does
  not itself own a stream, **polls `getActiveStream`** (`STREAM_RECOVER_POLL_MS`, only while one is
  in flight) and drives the same streaming UI (live bubble via `streamText`/`streamThinking`,
  locked composer + Stop) through a derived `busyStreaming = streaming || recovering`. The token
  events missed while unmounted are not replayed — the snapshot carries the full accumulated text,
  so the bubble resumes complete. Completion (snapshot → null) refreshes the transcript from the DB.
- **`MockRuntime.chatStream`** emits a deterministic reply token-by-token with a small delay so
  the renderer's streaming + stop path is exercised with zero model files. The real
  `LlamaRuntime` (Phase 10) swaps in behind the same `ModelRuntime` interface.
- **Markdown rendering (post-MVP).** Assistant replies (persisted and streaming) render as
  GitHub-flavored Markdown via `react-markdown` + `remark-gfm` — local models emit Markdown, and
  raw `**asterisks**` read as broken output. react-markdown builds React elements (no
  `innerHTML`); raw HTML in model output renders as literal text, so the strict CSP /
  no-injection posture is unchanged. Links get `target="_blank"` so the main process's
  window-open handler routes http(s) to the OS browser and denies everything else. **User turns
  stay plain text** — they are not Markdown and must not be reinterpreted.
- **Runtime requirement (decision).** `sendChatMessage` does **not** auto-start a runtime: a chat
  needs a started model (`RuntimeManager.start()`). With no active runtime the handler throws and
  the Chat screen shows a "start a model" empty state that links to Models (and polls
  `getRuntimeStatus` so it flips to the composer by itself once the background auto-start — see the
  Models section — finishes loading). Rationale: starting the real llama.cpp sidecar mid-request is
  heavy and surprising; the startup auto-start is a deliberate, bounded exception that reuses the
  same gated start path.
- **IPC** (`ipc/registerChatIpc.ts`): `createConversation`, `listConversations`, `listMessages`,
  `sendChatMessage` (streaming), `stopGeneration`, `deleteConversation`, plus `getActiveStream`
  (stream recovery after navigation), `searchConversations` (Phase 31 full-text), `exportConversation`
  (save to Markdown), and the scope/anchor setters used by the composite source picker. Regenerate reuses
  `sendChatMessage` with `options.regenerate` — it deletes the last assistant message, then
  re-streams from history. `deleteConversation` removes a conversation (chat or document Q&A) and
  its messages; it refuses while a stream is in flight for that conversation (the persisted
  assistant turn would otherwise resurrect/violate the FK after the delete).
- **Conversation search (Phase 31, wave-3 plan §4).** `messages_fts` (FTS5,
  `content` + `message_id UNINDEXED`) mirrors the `chunks_fts` design exactly: self-contained
  (not external-content — VACUUM renumbers implicit rowids), three sync triggers on `messages`
  (insert / delete / update-of-content), guarded migration + one-time backfill in
  `openDatabase` (`ensureMessagesFts`). Messages are persisted with think blocks already
  stripped (Phase 20 D6), so reasoning is never indexed. `searchMessages(db, query, limit)`
  (`services/chat.ts`) sanitizes via the SHARED `buildFtsMatchQuery` (lifted from
  `rag/hybrid.ts` into `services/fts.ts`), ranks **bm25 with a newest-first tie-break**
  (D23) and groups hits per conversation (conversations ordered by their best hit). Snippets
  use FTS5's `snippet()` (verified in Electron 37 main AND system Node — research gate
  R-S1), matched terms wrapped in the `SEARCH_MARK_*` control characters so the renderer
  highlights without parsing HTML. IPC `chat:search` (preload `searchConversations`) is plain
  request/response; the search UI lives atop `renderer/chat/ConversationList.tsx`. The index
  lives inside the (possibly encrypted) DB file — encrypted at rest for free; while the vault
  is locked the `db` getter throws, so search is simply unavailable pre-unlock. **Searches are
  never logged or audited** — queries and snippets are content (Phase-19 privacy rule), and a
  sentinel test asserts `runtime_events` stays untouched.

## Document ingestion (Phase 4)
- **`services/ingestion/`** (spec §7.7). `parsers/` implements the `DocumentParser` interface
  (spec §9.2) with pure-JS adapters — `TxtParser`, `MarkdownParser`, `PdfParser` (pdfjs-dist
  legacy build, no worker), `DocxParser` (mammoth), `CsvParser` (papaparse) — each returning
  ordered text **segments** with optional `pageNumber`/`sectionLabel`. `chunker.ts` splits
  segments into overlapping ~500-token windows (overlap 80, cap 1000) without crossing
  segment boundaries, so each chunk inherits one page/section. `index.ts` orchestrates the
  status lifecycle (`queued → extracting → chunking → embedding → indexed`, `failed` on error)
  and persists to the `documents` + `chunks` tables. The `embedding` step embeds all chunks in
  one batch when an embedder is injected; without one it is a pass-through.
- **File storage decision.** Imported files are **copied into the workspace**
  (`workspace/documents/<id><ext>` → `stored_path`); `original_path` is also recorded. The
  drive stays self-contained and re-indexable; delete removes the workspace copy + chunks +
  row (never the original).
- **Import model (decision).** Async with polling: `importDocuments` queues rows and processes
  in the background; the `documents` table is the per-file source of truth; the job aggregate
  is in-memory via `getImportJob`. The renderer (Documents screen) polls while a job runs.
- **Parser libs are external** (`externalizeDepsPlugin` in `electron.vite.config.ts`) so the
  large pdfjs ESM bundle is `require`/`import`-ed from `node_modules`, not bundled (R3).
- **Read-only preview (post-MVP).** `extractDocumentPreview` re-parses the stored copy on demand and
  returns the parser's text segments (page/section labels intact) for an in-app modal. It re-parses
  rather than reading `chunks` because chunks OVERLAP (~80 tokens) — concatenation would duplicate
  text at every boundary. (Exception: AUDIO documents read from stored chunks instead — exact by
  construction and avoids a minutes-long re-transcription; see "Audio transcription" below.) In an encrypted workspace the `.enc` copy is decrypted to a transient
  `.parse-preview` working file and shredded on the way out (covered by the startup `.parse*` crash
  sweep); the original bytes are never handed to an external viewer, which is why this is an in-app
  TEXT preview and not a `shell.openPath`.
- **IPC** (`ipc/registerDocsIpc.ts`): `pickDocuments`, `importDocuments`, `getImportJob`,
  `listDocuments`, `deleteDocument`, `reindexDocument`, `importPreflight` (Phase 36 — the
  size-aware audio confirm); plus the document-organization channels `previewDocument`,
  `exportDocument`, `addToCollection`/`removeFromCollection`, and `setLifecycle` (see the
  "Document organization" §5 IPC table). Full pipeline detail lives
  in [`rag-design.md`](rag-design.md).

## Audio transcription (Phase 36, wave-3 plan §9)

A recording (`.wav`/`.mp3`/`.flac`/`.ogg` — exactly what the pinned binary decodes, R-W2)
becomes a **normal corpus document**: transcribed locally, chunked, embedded, searchable,
citable with time ranges ("ask your meetings"). m4a/aac is descoped (no bundled ffmpeg);
it fails with friendly convert-to-WAV/MP3 copy.

- **`services/transcriber/` — the second sidecar family.** A `Transcriber` interface
  (`transcribe(filePath) → TranscriptSegment[{ startMs, endMs, text }]`) behind
  availability selection: `createSelectedTranscriber` returns the real backend iff the
  `runtime/whisper.cpp/<os>/whisper-cli` binary AND the `models/transcriber/` GGML
  weights exist, else **null** — the reranker D9 pattern, deliberately **no mock** (an
  invented transcript would silently corrupt the corpus). Missing transcriber ⇒ the audio
  FILE fails friendly ("Audio import needs the transcription model — download it on the
  AI Model screen") through the documents-table error path; text ingestion is untouched.
- **D34 (resolved by R-W1): per-file CLI, not a server.** whisper.cpp v1.8.6 ships
  prebuilt binaries for Windows only (so a server gives no per-OS lifecycle win), the CLI
  emits `-pp` progress + progressive segments while it works, there is no
  multi-hundred-MB upload over loopback, and cancel/lock-suspend is just killing the
  child. `WhisperCliTranscriber` spawns the pinned CLI per file (`-oj` JSON to a
  transient `.parse-transcript.json` in the documents dir — content, shredded after,
  crash-sweep-covered), parses `transcription[].offsets` (ms). **The exit code is NOT
  the success signal** (R-W2: a decode failure exits 0 with stderr-only complaints) —
  success = the JSON exists and parses; the error tail keeps **stderr only** (stdout
  carries the transcript, which must never ride an error message into logs).
  `suspend()` (workspace lock) and `stop()` (will-quit) kill in-flight children; the
  failing parse marks that document `failed` and the decrypted transient is shredded.
- **`AudioParser` implements `DocumentParser`.** `parse(filePath, ctx)` uses the
  transcriber injected per call via the ADDITIVE `ParseContext` (carried from
  `IngestionDeps.transcriber` — the embedder-injection precedent; text parsers ignore
  it). Whisper segments are **packed** into paragraph-sized `ExtractedSegment`s
  (~180-word target, hard cap 400 < the 500-token chunk window) labeled
  `sectionLabel: "mm:ss–mm:ss"` (`h:mm:ss` above an hour) — D29: the time range rides
  the EXISTING `Citation.section`, zero citation-path changes. Packing matters twice:
  distinct labels never coalesce in the chunker (raw whisper segments would mean
  thousands of tiny chunks), and the ≤400-word cap makes **every audio chunk exactly one
  packed segment, verbatim, no overlap** — which is why `extractDocumentPreview` (and
  through it translate/compare re-extraction) reads audio text from the STORED CHUNKS
  instead of re-transcribing for minutes.
- **D35: the audio original is KEPT** (the locked Phase-4 copy-into-workspace contract +
  `reindexDocument` re-parsing the stored file force it), encrypted (`.enc`) on
  encrypted workspaces; **a re-index of an audio document is a full re-transcription**
  (no transcript cache — `known-limitations.md`). Large audio (>50 MB picked) gets an
  explicit import confirmation (`importPreflight` IPC → `summarizeImportPaths`).
- **Progress.** The CLI's `-pp` lines (~every 5%) flow
  `transcriber → ParseContext.onProgress → IngestionDeps.onTranscribeProgress` into an
  in-memory map in `registerDocsIpc`, merged into `listDocuments` responses as
  `DocumentInfo.transcriptionProgress` — the polling UI shows "Transcribing… N%" on
  import AND re-index with no new channel (R-W4: a 52-min mp3 ≈ 35 min wall on the dev
  CPU, peak RSS ≈ 1.2 GB with the small model — honest progress is mandatory).
- **Audit:** the existing `document_imported` (filename, document id, status, chunk
  count — never content) covers audio; the
  transcript is CONTENT and never reaches `runtime_events` (sentinel-tested end-to-end).

## Voice dictation (Phase 37, wave-3 plan §10, decision D30)

Push-to-talk into the chat composer — a thin client of the Phase-36 transcriber. The
whole pipeline (locked in D30): renderer `getUserMedia` audio → `MediaRecorder`
(webm/opus) → decode + resample to **16 kHz mono** via an `OfflineAudioContext` render →
**pure-JS WAV encode** (`renderer/lib/wav.ts`, no new deps) → BYTES over the
request/response IPC **`dictation:transcribe`** (preload `transcribeDictation`; no new
event channels) → main writes a transient `<uuid>.parse-dictation.wav` into the
documents dir (the `.parse` infix = crash-sweep coverage), runs
`Transcriber.transcribe(tempPath, { workDir })`, **shreds the WAV in `finally`**, returns
the text. The composer (`renderer/chat/DictationButton.tsx` + `Composer.tsx`) inserts it
**at the cursor for review — never auto-sent**; the insert prefers
`execCommand('insertText')` so it joins the input's normal undo history. Streaming ASR is
explicitly out of scope.

- **Availability-driven (D14 precedent, no settings key):** `AppStatus.dictationAvailable`
  = "a transcriber is selected"; the mic button simply doesn't render without it. The IPC
  refuses friendly as a backstop.
- **Permissions:** the Phase-31 deny-by-default `setPermissionRequestHandler` gained its
  single exception — `media` requests that are **audio-only and from the app's own
  WebContents** (`services/permissions.ts`; scope matrix unit-tested). See
  `security-model.md`.
- **Privacy:** the recording exists only as the shredded transient; **no audit event**
  (content-adjacent, like search); errors to the renderer are fixed friendly copy with
  the technical reason in the local log only. The OS mic indicator is the recording
  signal. Locked workspace needs no handling — the composer doesn't exist pre-unlock.
- **Live in-input waveform (2026-06-13):** an in-app "recording started" cue. A read-only
  Web Audio `AnalyserNode` tap on the SAME `getUserMedia` stream (never wired to a
  destination, never touching the recorded bytes) is exposed as `DictationCapture.analyser`;
  `renderer/chat/Waveform.tsx` paints its time-domain data to a `<canvas>` overlaid on the
  textarea while recording (`Composer` adds `.composer-recording` to dim the draft + accent
  the border). Decorative (`aria-hidden`) — the mic `aria-pressed`/label stays
  authoritative — and `prefers-reduced-motion`-aware (static baseline). Degrades to no
  wave (button pulse + dim only) when Web Audio is absent (`analyser: null`). Local, no new
  deps. Full record: wave-3 plan §10.

## Scanned-PDF / photo OCR (Phase 38, wave-3 plan §11, decisions D31–D33)

Image-only PDFs and photos of pages (`.png`/`.jpg`/`.jpeg`) become searchable corpus
documents via **local** OCR: tesseract.js (pure WASM, pinned 7.0.0) over language files
vendored on the drive (`ocr/deu.traineddata.gz` + `eng.traineddata.gz` — German +
English, the tessdata_best-INTEGERIZED variant per R-O3). Zero network at runtime
(R-O2: tesseract.js's CDN `langPath` default and CWD cache are explicitly disabled;
sentinel-tested), zero native deps.

- **Step 0 — scan detection (the Phase-17 trust spirit).** A PDF where NO page reaches
  `PDF_TEXT_PAGE_MIN_CHARS` (25) of extractable text used to silently index NOTHING.
  The `PdfParser` now fails it friendly ("This PDF looks like a scan — it has no
  readable text yet."); `DocumentInfo.scanDetected` is DERIVED (failed + that exact
  notice) and drives the row's "Make searchable (OCR)" offer. Hybrid text+scan PDFs
  are NOT detected — their text pages index normally, exactly as before.
- **D31 (resolved by R-O1): the split execution design.** Rendering a PDF page to
  pixels needs a canvas; the main process has none and Electron 37's `utilityProcess`
  has NO OffscreenCanvas (probed — option (b) was impossible). So a **hidden
  BrowserWindow** (`ocr.html`, its own tiny sandboxed preload exposing exactly the five
  `OCR_RASTER` channels, never the app API) does ONLY pdf→PNG rasterization with the
  SAME pinned pdfjs **legacy** build the PdfParser uses (the modern v6 build calls
  `Uint8Array.prototype.toHex`, which the pinned Chromium lacks) at 300 DPI (capped at
  4096 px/side). **Recognition always runs MAIN-side** in tesseract.js **Node mode**
  (`services/ocr/tesseract.ts`): image Buffers decode inside the WASM core (no canvas),
  the worker script + core load from the app's own `node_modules` (packaged:
  `asarUnpack` + the `app.asar → app.asar.unpacked` workerPath rewrite — worker_threads
  cannot read inside asar). Photos never touch the renderer at all. The rasterizer
  protocol is **pull-based** (`services/ocr/rasterizer.ts`): main requests one page at
  a time and recognition backpressures rendering, so a long scan never queues unbounded
  page images.
- **D33: OCR is NEVER automatic for PDFs.** Detection marks the row; "Make searchable
  (OCR)" runs as a **Phase-33 document task** (kind `'ocr'` — queue, progress
  "pages + 1", cancel; the D26 guards hold, but it needs the OCR engine instead of the
  chat runtime). The task rasterizes + recognizes page by page, persists the
  recognition in the additive **`documents.ocr_json`** column (CONTENT — DB only,
  never logs/audit; metadata surfaces as `DocumentInfo.ocr`), then re-ingests: the
  `PdfParser`'s `ParseContext.ocrPages` hook turns the stored recognition into one
  `ExtractedSegment{ pageNumber }` per page ⇒ **page citations work unchanged**.
  `ocr_json` survives re-index (like `origin_json`): re-index and preview reuse the
  stored pages instead of silently re-OCRing; re-running the task is the explicit redo.
  Cancel persists nothing. **Photos are the D33 asymmetry:** the `ImageParser` OCRs on
  import directly (one small image, seconds) via the engine injected through
  `ParseContext` — the transcriber-injection precedent.
- **Availability-driven (D14/D9):** `createSelectedOcrEngine` returns the engine iff
  `<root>/ocr/*.traineddata.gz` exist, else **null** (no mock — invented text would
  corrupt the corpus). `AppStatus.ocrAvailable` gates the UI; absent assets ⇒ the scan
  notice appends a "needs the OCR files" hint and photo imports fail friendly per-file.
  No settings key (`ocrLanguages` was considered and dropped — availability-driven).
- **Distribution (D32):** the `ocr:` block on `runtime-sources.yaml` is a NEW asset
  class (plain verified files `{ lang, url, sha256, dest }`, no extraction, no marker —
  the hash IS the install state), fetched by `fetch-runtime --family ocr`,
  asserted by `assertCommercialDrive` (`ocrAssetsVerified`) + both script gates.

## Document tasks (Phases 33–35; OCR Phase 38; tree/extract = whole-document analysis, rag-design §14)
- **`services/doctasks/` (barrel: `doctasks.ts`) — the shared task engine.** Split into a
  `doctasks/` directory (audit M-A4): `manager.ts` (the `DocTaskManager` orchestration),
  `summary.ts`, `translation.ts`, `compare.ts`. A job state machine on the Phase-4/18
  async-with-polling precedent: `startDocTask({ kind, documentIds, params }) → { jobId }`,
  `getDocTask(jobId) → { state, progress { stepsDone, stepsTotal }, error?, resultRef? }`,
  `cancelDocTask(jobId?)`. States: `queued → running → done | failed | cancelled`; unknown
  job ids report a terminal status so pollers always stop. **Six `DocTaskKind`s** run on the
  one machine: `summary` (Phase 33), `translation` (Phase 34), `compare` (Phase 35 — exactly
  TWO distinct source documents; the others take one), `ocr` (Phase 38), and the two
  whole-document-analysis builds `tree` (deep index) and `extract` (structured extract). Deps
  are injected (`getDb`, `getRuntime`, `isChatStreaming`, `getContextTokens`, `getStoreDir`,
  `getIngestionDeps`, `beginDocumentWork`, `audit`), so the engine tests without Electron;
  `main/index.ts` wires it and exposes it as `AppContext.docTasks`.
- **Concurrency (D26, RESOLVED): strict one-at-a-time, with one exception.** Tasks serialize
  among themselves (one FIFO queue, one runner). A **non-yielding** task (`summary`,
  `translation`, `compare`, `ocr`) **refuses to start while a chat answer streams** (it reads
  the shared in-flight registry) but owns its own `AbortController` and is NEVER an entry in
  the per-conversation map — `stopGeneration` cannot kill a task and a task cannot block a
  conversation key (fact §2.8). The inverse guard lives in the chat/RAG handlers: a message
  sent while a non-yielding task is active throws the shared `DOC_TASK_BUSY_MESSAGE`, which the
  chat screen renders with a "Cancel document task" button (`cancelDocTask()` with no jobId
  cancels the active task). **Exception — the yielding builds:** `tree` and `extract` are
  long, resumable background builds that **cede the model slot to an incoming chat** via the
  `ModelSlotArbiter` (`services/analysis/model-slot-arbiter.ts`): the builder parks after the
  current node, chat acquires the slot (`acquireChatSlot`), streams, and the build resumes
  in-session — so chat is not refused during a deep-index/extract build (rag-design §14.3). The **R-T1 probe**
  (`tests/manual/server-concurrency-probe.test.ts`, `HILBERTRAUM_CONCURRENCY_PROBE`) showed the
  pinned b9585 would serve two requests on PARALLEL slots at our default args — the
  app-side guard is the only serialization, which is exactly why it exists.
- **Tasks call the active chat runtime** over the locked `chatStream` contract with
  EXPLICIT `maxTokens`/`temperature` — never the answer-depth modes. No runtime running →
  a friendly "start a model first" refusal, never an auto-start (the `sendChatMessage`
  decision). Failures surface friendly §11.4 copy; the raw reason goes to the local log
  only. Cancellation never persists a partial result (chat keeps partials; tasks do not).
- **Summary algorithm (D25): budget-driven two-level map-reduce over stored CHUNKS** (no
  re-parse; the ~80-token chunk overlap slightly duplicates stitched text — accepted).
  The per-call input budget is derived in WORDS (the chunker's token-estimate unit) with
  an explicit words→tokens safety factor: `(contextTokens − 512 output reserve − 300
  prompt reserve) / 1.3` — the estimate undercounts real tokens, so a budget-sized window
  provably fits the model's real context. Total ≤ budget → one call; else chunks pack
  greedily into budget-sized windows (an over-budget chunk is SPLIT, not truncated) →
  per-window partial summaries → one reduce pass, with each map call's `maxTokens` sized
  to `usableTokens / windowCount` so all partials provably fit the reduce input. Hard
  ceiling: **12 map calls** (≈ a ~50-page document at the default context); beyond it the
  summary covers the beginning and is flagged `truncated` (the UI says so honestly).
- **Persistence (D25):** additive nullable `documents.summary_json`
  (`{ text, modelId, createdAt, truncated }`, `ensureColumn` migration). Cleared FIRST by
  `reindexDocument` (content may have changed — even a failed re-parse clears it); gone
  with document delete. Surfaced as `DocumentInfo.summary`. Summaries are CONTENT: they
  live only in the (possibly encrypted) DB; the additive audit events
  `document_task_completed`/`document_task_failed` carry `{ kind, documentId }` only
  (plus the additive ids-only `documentIdB` for a compare) — sentinel-tested in
  `audit-ipc.test.ts`.
- **Translation (Phase 34, D27/D36): map in document order, materialize a NEW document.**
  `params.targetLang: 'de' | 'en'` (a closed v1 set — free-text language fields invite
  silent quality failures). **D36 — the input is the parser's SEGMENTS, re-extracted from
  the stored copy via `extractDocumentPreview`, NOT the stored chunks:** chunks overlap by
  ~80 tokens for retrieval, and naive in-order chunk concatenation would duplicate text at
  every boundary in the translated output (a summary tolerated that; a faithful
  translation cannot). The segments are ordered, non-overlapping, and exact; the cost is
  one re-parse — the same cost the in-app preview pays, on the same code path (encrypted
  copies decrypt to a `.parse*` transient and are shredded). Overlap-trimming adjacent
  chunks was rejected as heuristic where the re-parse is exact. Windows pack segments by
  the D25 word-budget math, but split the usable context by **measured token weight**
  (R-T2 on the real b9585 + Qwen3-4B): input claims 1.3 tokens/word, output claims 2.0
  (German output is subword-heavy — a half/half split truncated a near-budget window).
  **No window ceiling and no reduce** — a faithful translation may not silently truncate;
  windows are translated in order at temperature 0.2 with a strict template (translate,
  don't summarize; preserve Markdown; numbers/names/dates verbatim) and concatenated. A
  window the model refuses/garbles is retried ONCE, then **marked visibly** in the output
  with the original text kept below — never silently dropped; only an all-windows failure
  fails the task.
- **Compare (Phase 35, D28/D37): two documents in, one materialized report out.** The
  strategy auto-switches on token math (the D25 budget shape: `(max(1024, ctx) − 512 −
  300) / 1.3` input words per call). Both full texts fit ⇒ **mode (a)**: one
  structured-comparison call over both. Else **mode (b), section-matched**: doc A's
  chunks pack into half-budget windows (over-budget chunks split, pieces keep their
  chunk id), each window's nearest doc-B chunks are retrieved via the EXISTING
  `VectorIndex` scoped to doc B under the active embedder's id — STORED vectors only,
  so the pairing is deterministic and costs nothing but cosine scans (top-3 neighbors
  per A-chunk, best-first fill of the other half-budget, presented in doc-B order);
  per-pair map calls use a deliberately smaller prefixed-bullets format
  (R-T2-confirmed), then one reduce merges the notes into the four dictated report
  sections (share / differ / only-in-A / only-in-B; headings dictated verbatim, body in
  the documents' language; temp 0.3, output cap 512 — both R-T2-validated over two
  smoke rounds on the real b9585 + Qwen3-4B). Map ceiling 12 → an honest truncation
  notice INSIDE the report ("covers the beginning of A"); map output caps are sized so
  all notes provably fit the reduce input (the D25 fit property). **D37:** mode (a)'s
  input AND the mode decision use the re-extracted parser segments (chunk overlap would
  read as phantom "shared" content and inflates a length estimate by ~16% — enough to
  mis-route the switch); mode (b)'s map deliberately uses the stored chunks (vectors
  needed; notes tolerate overlap, the D25 precedent). **Embedder-visibility guard:**
  before any model call, mode (b) verifies BOTH documents have vectors under the ACTIVE
  embedder id — a stale/vectorless document fails friendly with the Phase-17-style
  "re-index first" answer, never a silently empty pairing (mode (a) needs no vectors
  and skips the guard).
- **Materialize (D27):** only after every window succeeded (cancel persists nothing), the
  Markdown — `"> Machine-translated by <model> — may contain errors."` (translations) or
  `"> Machine-generated comparison by <model> — may contain errors."` (+ the truncation
  notice when capped) — is written
  to a `<jobId>.parse.md` transient (the startup crash sweep covers it) and run through
  the NORMAL import path (`createQueuedDocument` with the display title
  `"<original> (Deutsch|English).md"` / `"Comparison: <A> vs <B>.md"` + `processDocument`
  with the real ingestion deps) ⇒
  chunked, embedded, searchable, citable, `.enc`-encrypted automatically; the transient is
  shredded. Provenance lands in the additive `documents.origin_json` column — a
  `DocumentOrigin` discriminated union (`{ type: 'translation', translatedFrom,
  targetLang }` | `{ type: 'compare', comparedFrom: [a, b] }`; Phase-34 rows persisted
  without `type` parse as `'translation'` — an additive migration), surfaced as
  `DocumentInfo.origin`; malformed JSON
  reads as null; survives re-index — provenance, not sync. A failed import deletes the
  half-born row: a generated document fully succeeds or persists nothing.
- **Vault lease split:** a summary takes NO `beginDocumentWork()` lease, deliberately — it
  only reads chunk rows and writes one DB column. A translation's/comparison's MATERIALIZE
  step writes
  `.enc` sidecars, so that step — and only that step — holds the lease (the long window
  loop must not block a password change for minutes); a concurrent password change makes
  the materialize fail friendly (`VaultBusyError` passes through). `registerDocsIpc`
  refuses re-index/delete of any document an active task targets (`isDocumentBusy` — both
  compare sources), and
  the freshly created OUTPUT document is appended to the task's `documentIds` at creation
  so the guard covers it before the import finishes.
- **IPC + UI:** `doctasks:start/get/cancel` (+ preload mirrors); the read-only analysis
  channels `analysis:coverage` (a document's `DocumentCoverage` — breadth + depth of the current
  summary, no model call) and `analysis:listAll` (structured extract aggregation, zero model
  calls) are handled by the same `registerDocTasksIpc.ts` (design: rag-design §14.4/§14.5);
  `docs:export` saves a
  text document's stored content via the main-process save dialog (the
  `exportConversation` pattern — built for materialized translations, which are always
  Markdown; audit ids-only). The renderer watcher (`renderer/lib/doctasks.ts`) lives at
  module level so a running task's busy/progress state survives screen navigation — ONE
  store for all kinds (`startTask(kind, documentIds, params)` — one id, or two for a
  compare; D26 guarantees at most one task anyway). The Documents screen polls it
  (`useSyncExternalStore`), shows the per-row
  "Summarizing…/Translating…/Comparing… (n/m)" busy state + Cancel on EVERY source row;
  "Translate" opens a small target-choice modal (German/English); "Compare (2)" appears
  on the Phase-17 multi-select at exactly two selections. A done summary opens the
  preview (collapsible section, "Generated by <model> · <date>", Regenerate); a done
  translation reveals the new document in the refreshed list with a quiet "Translated
  from <original>" provenance line (row + preview); a done comparison opens the new
  report's preview with its "Comparison of <A> and <B>" line. Both materialized kinds
  offer Export.

## Privacy & offline (Phase 8)
- **`services/policy.ts`** (spec §3.5/§3.6/§6) loads optional `config/policy.json` + `config/drive.json`,
  merges them over a **deny-by-default** `DEFAULT_POLICY` (network + telemetry off), and resolves the
  **effective** network permission as `policyCeiling ∧ userSetting`. A signed policy can only
  restrict, never expand, the user toggle. `buildPolicyStatus()` produces the `getPolicy()` IPC shape
  (`PolicyStatus`) the UI uses to distinguish "off by choice" from "disabled by policy".
- **`AppStatus.offlineMode`** is now policy-aware (`= !networkAllowed`), with an added
  `networkAllowed` flag. `getPolicy` is exposed on the preload bridge.
- **`services/offlineGuard.ts`** — `assertOfflinePosture()` runs at startup: logs the posture and
  installs (in **all** builds, when offline — audit §8 M3) a defensive tripwire over
  `net.Socket.prototype.connect` that **logs** any remote connection while offline. **Loopback
  (`127.0.0.1`/`localhost`/`::1`) is exempt** (dev renderer + Phase-10 sidecar). The guard never
  blocks or throws. Boundary note: it covers Node sockets (http/https/fetch via undici); renderer
  traffic is blocked by the CSP; `electron.net` is not used in the core path.
- **UI**: the Settings "Privacy & data" tab (`screens/settings/PrivacyTab.tsx`, spec §7.10/§18.1 —
  a standalone Privacy screen until the Phase-26 IA regroup) renders the offline statement, where
  data lives, the live network state, the plaintext-dev-mode caveat, and the logs-are-local
  guarantee. The sidebar badge reflects the live `getPolicy()` state and opens that tab.
- Full detail in [`security-model.md`](security-model.md).

## Real local inference (Phase 10)
Real on-device inference drops in **behind the unchanged `ModelRuntime`/`Embedder` interfaces** — no
caller changes. Both backends are **opt-in by availability** (graceful-fallback rule): the real one
is used only when BOTH the platform `llama-server` binary AND the model's GGUF weights are present;
otherwise the mock is used, so the app launches and the whole test suite passes with **zero model
files**.

- **`services/runtime/sidecar.ts`** — sidecar discovery + lifecycle.
  - `resolveLlamaServerPath(rootPath, platform, env)` finds `runtime/llama.cpp/<os>/llama-server[.exe]`
    (spec §6 drive layout; `win`/`mac`/`linux` sub-dirs). A `HILBERTRAUM_LLAMA_BIN` env var overrides it for
    dev. Pure `existsSync` check — no surprises in the "binary present?" decision.
  - `findFreePort()` asks the OS for a free **loopback** port (listen on `127.0.0.1:0`, read it, close).
  - **`LlamaServer`** owns one child process: spawns `llama-server` **bound to `127.0.0.1` only**
    (`--host 127.0.0.1 --port <random> --model <gguf> --ctx-size <n> --threads <n>` + optional extra
    args), polls `/health` with a **timeout** before reporting ready (never hangs on a wedged server),
    exposes a loopback `fetch`, and `stop()` kills the child **and waits for exit** so no orphan
    survives. A child that crashes or never gets healthy makes `start()` throw a clear error.
- **`services/runtime/llama.ts`** — `LlamaRuntime implements ModelRuntime`, composing a `LlamaServer`.
  `chatStream` POSTs to the server's **OpenAI-compatible** `/v1/chat/completions` with `stream: true`,
  sending `messages` as plain role/content (the server applies the model's chat template — we never
  hand-roll Qwen's prompt format) and mapping `maxTokens`/`temperature`. `readChatSSE` parses the SSE
  `data:` frames (buffering partial lines, ignoring keep-alives, stopping on `[DONE]`) and `yield`s
  each delta, honouring `options.signal`. This feeds the **locked Phase-3 streaming contract**
  unchanged, so `measureTokensPerSecond` (Phase 7) now reports **real tokens/sec** the moment a real
  runtime streams.
- **`services/runtime/factory.ts`** — `createSelectingRuntimeFactory({ rootPath, … })` returns a
  `RuntimeFactory` that picks `LlamaRuntime` vs `MockRuntime` per `start()` (when the concrete model
  path is known), behind the unchanged `RuntimeManager`. `main/index.ts` uses it in place of the bare
  `createMockRuntime`. **Phase 15:** when binary + weights are present the factory returns the **GPU
  start ladder** (see below) instead of a bare `LlamaRuntime`.

### GPU acceleration: probe + start ladder (Phase 15; design record below)

The Phase-14 drive ships the **Vulkan full build** as the default `llama-server` (it contains every
CPU backend and degrades to CPU on GPU-less machines), so GPU offload happens with **default spawn
args** (b9585: `-ngl auto` + `--fit on` — we **never pass `-ngl`**, locked decision). What Phase 15
adds is the safety machinery:

- **`services/runtime/gpu.ts`** — `probeGpuDevices(binPath)` spawns the drive's own
  `llama-server --list-devices` (offline, no model, sub-second, kill-timeout-bounded (10 s);
  resolves on the child's `close` event so late-buffered stdout is never truncated; never
  throws — any failure → `[]`) and `parseListDevices` parses it (pure, fixture-tested).
  `looksIntegrated(name)` is the conservative iGPU heuristic for the Phase-16 profile bump
  (covers Windows + RADV APU names and Meteor-Lake Arc). `createCachedGpuProbe()` memoizes per
  binary per session and exposes `invalidate()` (wired to "Try GPU again"). The ladder kicks
  the probe off concurrently with the rung-1 server start. The probe labels the backend for the
  UI; it can't prove stable inference — the ladder is the actual guarantee.
- **The start ladder** (`factory.ts`, §5.2): rung 1 = default binary, default args (GPU
  auto-offload; on a GPU-less machine this *is* CPU mode) → rung 2 = same binary, **`--device
  none`** (the only way we force CPU) → rung 3 = the pure-CPU safety-net build
  (`runtime/llama.cpp/<os>/cpu/`, when shipped) → rung 4 = `MockRuntime` (the existing
  graceful-fallback rule; the app can never be stuck). `gpuMode: 'off'` (Settings) or a persisted
  `gpuAutoDisabled` skip rung 1. A rung-1 failure persists `gpuAutoDisabled` + `gpuLastError`
  (no repeated GPU health timeouts on later starts); the Diagnostics tab's "Try GPU again" clears it.
  `RuntimeStatus` now carries `backend: 'gpu' | 'cpu' | 'mock'` + `gpuName`.
- **Mid-generation crash auto-fallback** (§5.3): `LlamaServer` gained an `onUnexpectedExit` hook
  (fires only for a *healthy* server dying outside `stop()`). When the active backend was GPU,
  `createGpuCrashAutoFallback` persists the flags, **restarts the same model once at CPU**, and
  broadcasts the friendly §11.4 notice (`runtime:notice` event → preload `onRuntimeNotice`):
  *"Switched to compatibility mode for stability…"* — never "GPU failed".
- **The E5 embedder is pinned to CPU** (`--device none` in its `extraArgs`, §7 — decided): the
  384-dim model gains little from a GPU, and the pin keeps ingestion immune to driver flakiness
  and VRAM contention with the chat model.
- GPU settings (`gpuMode`, `gpuAutoDisabled`, `gpuLastError`, `gpuProbe`) live in `AppSettings`
  (the possibly-encrypted DB) — fine, because sidecars only ever start post-unlock; every read in
  `main/index.ts` is still guarded (locked → safe defaults).
- CI never touches a GPU/binary: the probe + ladder are covered through the existing
  `SpawnFn`/fetch seams; a real-GPU smoke lives in `tests/manual/gpu-smoke.test.ts`, **skipped
  unless `HILBERTRAUM_GPU_SMOKE` points at a provisioned drive**.
- **The Phase-16 surface** on top of the ladder: Settings' "Use GPU acceleration" toggle binds
  `gpuMode 'auto' | 'off'` (default ON). The Settings "Diagnostics (advanced)" tab shows the **Acceleration** line (live
  `RuntimeStatus.backend`/`gpuName` while running, else the persisted `settings.gpuProbe`), the
  **runtime build** line (`getRuntimeInstall` IPC `runtime:install` → the `.hilbertraum-runtime.json`
  marker), and the compatibility-mode notice with **"Try GPU again"** — a dedicated IPC
  (`gpu:try-again`) that clears `gpuAutoDisabled`/`gpuLastError`, invalidates the session probe
  cache, and re-probes + persists (hidden while the toggle is OFF, where it would do nothing).
  The benchmark path injects the probe as `RunBenchmarkDeps.gpu: { name, useful }`
  (`gpuUsefulForProfile`: ≥ 6144 MiB AND not integrated → the conservative `classifyProfile`
  bump); `benchmark.ts` itself keeps **zero `child_process`**. `maybeRunFirstBenchmark`
  additionally refreshes `settings.gpuProbe` once per session even when a benchmark already
  exists, so a drive moved between machines re-labels itself.
- **`services/embeddings/e5.ts`** — `E5Embedder implements Embedder`, the real backend behind the same
  interface with the **manifest id + 384 dims**. It composes a `LlamaServer` started with `--embedding
  --pooling mean` (the **same** prebuilt binary — **zero new npm deps**, no fragile native build), is
  **lazy-started on first `embed()`** and reused, POSTs to `/v1/embeddings`, re-orders the response by
  `index`, and **L2-normalizes** each vector (interface contract). An additive `stop()` kills the
  sidecar (wired into `will-quit`). `services/embeddings/factory.ts`
  `createSelectedEmbedder({ rootPath, model, … })` picks `E5Embedder` vs `MockEmbedder` by availability
  (the embeddings model is read from the **manifest**, since settings live in the possibly-encrypted DB
  and are unreadable before unlock).
- **Embedding-model-mismatch guard.** Mock vectors (`mock-embedder`) and real E5 vectors are **both
  384-dim**, so `VectorIndex`'s dimension guard cannot separate them — mixing them silently corrupts
  ranking. `VectorIndex` takes an optional `{ embeddingModelId }` that scopes the cosine scan to one
  model's vectors (`WHERE embedding_model_id = ?`); `rag.retrieve` passes the **active embedder's id**,
  so a corpus indexed under the mock can't pollute search under real E5 (and vice-versa) until a
  reindex re-embeds everything. The default (no id) still scans all rows, so existing callers/tests are
  unchanged.
- **`services/reranker/` (Phase 21, [`rag-design.md`](rag-design.md) §11)** — `LlamaReranker
  implements Reranker`, the THIRD `LlamaServer` composition: the same b9585 binary spawned with
  `--rerank --device none` (CPU-pinned like the embedder; `CHAT_SERVER_ARGS` never reach it),
  lazy-started on the first documents question, POSTs `/v1/rerank` and maps
  `results[].{index, relevance_score}` back by index. `createSelectedReranker` returns it only
  when binary + reranker GGUF exist, else **null** (no mock — pass-through is the contract). A
  failed start latches for the session (no health-timeout stall per question); a query-time
  failure logs and keeps the fused order. Stopped on `will-quit`; **suspended** (stop + lazy
  restart allowed) on workspace lock — `suspend()` also fixed the embedder's post-lock latch.
  The E5 embedder carries the same failed-start latch, with one deliberate difference: its
  latch **clears on `suspend()`** — the embedder has no graceful degradation (a latched
  failure blocks all imports), so replacing a bad GGUF + lock/unlock must make imports
  retryable without an app restart.
- **Hybrid keyword retrieval (Phase 21)** — `chunks_fts` (FTS5, `text` + `chunk_id UNINDEXED`,
  trigger-synced from `chunks`, guarded migration + backfill in `db.ts`) gives `rag.retrieve` a
  BM25 keyword pass fused with the cosine pass by reciprocal rank (k = 60, `rag/hybrid.ts`).
  Keyword hits are restricted to chunks with a vector under the active embedder, so hybrid
  search never widens what vector search could see (the Phase-17 re-index honesty story).
- **Localhost-only is non-negotiable.** Every bind/spawn/fetch targets `127.0.0.1`. The Phase-8 offline
  guard exempts loopback precisely for this sidecar; a routable bind would expose local inference to the
  LAN and violate the spec. The no-network test assertions assume loopback-only.
- **R5 — live inference is manual.** Platform sidecar binaries + a GGUF model are **not** in the repo,
  so a real-model answer is a manual acceptance step. Everything else (discovery, fallback, localhost
  binding, process cleanup, health-timeout, SSE parsing, the embedder mechanics, the mismatch filter)
  is covered by tests with a mocked child process / mocked loopback `fetch`.

## GPU acceleration — design record (Phases 14–16, §1–§8)

_Formerly `docs/gpu-support-plan.md` (folded in here, 2026-06-12 docs housekeeping; the full
original implementation plan — research tables, change inventory, phased plan, deviation
log — is in git history: `git show 4549934:docs/gpu-support-plan.md`). IMPLEMENTED
2026-06-10 (Phases 14–16) + a same-day audit round, all findings remediated (BUILD_STATE §3
"GPU audit round"). The runtime design as implemented is the "GPU acceleration: probe +
start ladder" subsection above; **§ numbers below are stable — code comments cite them as
"GPU record §N"**._

### §1 Decisions

| Decision | Choice | Why (short) |
|---|---|---|
| GPU backend (Win + Linux) | **Vulkan** | One ~37 MB build covers NVIDIA + AMD + Intel with standard drivers; CUDA is NVIDIA-only and ~620 MB (see §4) |
| Build shipped per OS | The **Vulkan full build is the default** at `runtime/llama.cpp/<os>/` — it contains the complete CPU backend set (`GGML_BACKEND_DL`), so on a GPU-less machine it *is* the CPU build | Verified by unpacking the b9585 assets |
| CPU-only safety net | Also ship the pure-CPU build at `runtime/llama.cpp/<os>/cpu/` (+16/+15 MB) — rung 3 of the ladder | Last-resort escape if `ggml-vulkan`'s mere presence destabilizes a machine (AV/loader edge cases) |
| User control | **GPU is always the default**; only a detected problem (the ladder) moves a machine to CPU. Settings has a "Use GPU acceleration" toggle (default on); Diagnostics has "Try GPU again" | Zero-technical-knowledge rule |
| `-ngl` strategy | **Pass nothing** — b9585 defaults to `-ngl auto` + `--fit on` (VRAM-aware auto-offload). CPU is forced with `--device none`, never `-ngl 0` | Upstream owns VRAM fitting (§3) |
| GPU detection | **Both**: a `--list-devices` probe (labels the backend for UI/profile) **and** the try-then-fallback start ladder (the actual guarantee) | The probe can't prove inference works; the ladder can't name the GPU |
| First-start CPU-vs-GPU auto-benchmark | **Not built** | v1 trusts llama.cpp auto-offload even on weak iGPUs; §8's honest copy covers the modest-gain case |
| macOS | **No change** — arm64 already runs Metal with auto-offload; mac/x64 + win/arm64 are out of scope (Intel Macs documented in `known-limitations.md`) | Upstream ships mac/x64 with Metal off; macOS has no Vulkan |
| Embedder (E5) | **Forced CPU** (`--device none`) | See §7 |
| New npm deps | **None** — probe + ladder use `node:child_process` on our own shipped binary | No native/fragile deps (project theme) |

**Size delta per drive:** win +53 MB download / +166 MB disk; linux +51 MB / ~172 MB; mac 0.
Negligible next to multi-GB weights.

### §2 Hard rules (these bound every choice)

- **100% offline at runtime.** GPU builds are fetched at drive-build time (`fetch-runtime`);
  the capability check is a local subprocess of a drive-local binary. No network, ever.
- **Plug-and-play.** No driver installs, no required settings. GPU is automatic when it works,
  invisible when it doesn't; a failed GPU attempt can never leave the user stuck — worst case
  is the CPU experience.
- **`ModelRuntime`/`Embedder` interfaces + the graceful-fallback rule stay intact.** The app
  launches and the full suite passes with zero models, zero binaries, zero GPUs (CI default).
- **Localhost-only sidecar binding** (`--host 127.0.0.1`) untouched.
- **Friendly copy (spec §11.4):** "compatibility mode", never "GPU failed" / "your hardware is
  bad". CPU mode is presented as normal, not degraded.

### §3 llama.cpp b9585 facts this design relies on

(Verified 2026-06-10 against the pinned tag; re-verify on the next pin bump.)

- `-ngl` **defaults to `auto`** and `--fit` **defaults to `on`** (upstream PR #15434, Aug 2025):
  the server does VRAM-aware maximum offload with a ~1 GiB margin and a min-context guard —
  *no GPU args needed; VRAM exhaustion at load is upstream's problem.*
- `--device none` forces pure-CPU inference **in the same binary** — our only CPU switch.
- `--list-devices` prints the device list and exits: an offline, no-model probe.
  Format: `  Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)`.
- The win/linux **Vulkan release archives are standalone full builds** carrying every
  `ggml-cpu-*` variant (dynamic backend loading): no usable Vulkan → same binary runs on its
  bundled CPU backends.
- Driver baseline: **Vulkan 1.2** — NVIDIA Kepler/Maxwell+, AMD GCN+ (Adrenalin/RADV), Intel
  Gen9+. Ships with normal GPU drivers (no SDK/runtime install); older machines fail the probe
  cleanly and stay on CPU.
- Pinned asset hashes live in `model-manifests/runtime-sources.yaml`; the license-review record
  naming the two Vulkan assets is in `docs/model-policy.md`.

### §4 Alternatives considered (and why not)

| Alternative | Verdict |
|---|---|
| **CUDA** | Rejected as default (schema leaves the door open): ~620 MB incl. cudart, NVIDIA-only, proprietary-redistributable license review; Vulkan reaches ~85–95 % of CUDA token-gen speed |
| **HIP/ROCm** | Rejected: AMD-only, 125–306 MB, narrow supported-GPU list; Vulkan covers AMD with standard drivers |
| **CPU default + opt-in GPU build dir** | Rejected: forces a binary choice before knowing if GPU works; the Vulkan build's bundled CPU backends make the split unnecessary |
| **Probe decides everything (no ladder)** | Rejected: `--list-devices` proves enumeration, not stable inference — a driver can enumerate fine and crash on first compute |
| **In-house GPU detection** (registry/wmic/native module) | Rejected: native deps or platform scraping; `--list-devices` is ggml's own truth, zero deps |

### §5 Detection & fallback design

Implementation detail (probe §5.1, ladder §5.2, mid-generation crashes §5.3) is the "GPU
acceleration: probe + start ladder" subsection above. The ladder, as a picture:

```
start(model), settings.gpuMode = 'auto' (default)
├─ Rung 1 — default binary, NO -ngl/--device args (auto-offload; GPU-less machine ⇒ already CPU)
│           the cached probe runs CONCURRENTLY with the server start and labels backend gpu|cpu
├─ Rung 2 — same binary + `--device none`   (after rung-1 spawn error / exit / health timeout)
├─ Rung 3 — pure-CPU safety-net build <os>/cpu/llama-server (if present)
└─ Rung 4 — MockRuntime (existing graceful-fallback rule — never stuck)
```

**§5.4 Where GPU state lives:**

| Datum | Home |
|---|---|
| `gpuMode: 'auto' \| 'off'` (user intent; Settings toggle) | `AppSettings` (encrypted DB) |
| `gpuAutoDisabled`, `gpuLastError` (detected problem) | `AppSettings` — written by the ladder; cleared by "Try GPU again" |
| `gpuProbe` (devices + `probedAt`) | `AppSettings` — persisted by the benchmark path **and refreshed once per session** post-unlock, so a drive moved between machines re-labels itself |
| Active backend + GPU name this session | `RuntimeStatus` (in-memory, `getRuntimeStatus` IPC) |

"Try GPU again" is the dedicated `gpu:try-again` IPC: clears the flags **and** invalidates the
session probe cache **and** re-probes + persists (a plain settings write would keep a
once-timed-out probe cached as "no GPU"). Diagnostics hides the button while the Settings
toggle is off. All GPU decisions happen post-unlock (settings live in the possibly-encrypted
DB) — fine, since sidecars only ever start post-unlock.

### §6 Per-OS build matrix (what ships on the drive)

| OS/arch | `runtime/llama.cpp/...` | Backends inside |
|---|---|---|
| win/x64 | `win/` ← win-vulkan zip (default) · `win/cpu/` ← win-cpu zip (safety net) | Vulkan + all CPU variants · CPU only |
| linux/x64 | `linux/` ← ubuntu-vulkan tar.gz (default) · `linux/cpu/` ← ubuntu tar.gz | same |
| mac/arm64 | `mac/` ← macos-arm64 tar.gz (unchanged) | Metal + CPU |
| mac/x64, win/arm64 | **not shipped** (out of scope; Intel-Mac note in `known-limitations.md`) | — |

Each install dir carries a `.hilbertraum-runtime.json` marker (`{version, backend, os, arch}`);
`fetch-runtime` skips are marker-based and re-fetches **pre-clean the dir** (everything except
the archive + `cpu/`) so an upgrade can never keep a stale binary under a fresh marker.

### §7 The embedder (E5) stays on CPU

`E5Embedder` composes the same `LlamaServer`, so the Vulkan build would auto-offload it too. It
is pinned with `--device none`: the 384-dim ~242 MB model embeds hundreds of chunks/second on
CPU (ingestion is parsing-bound), while GPU would add a second VRAM context competing with the
chat model and a second process exposed to driver flakiness during ingestion, where a crash
fails a whole document. Revisit only if a larger embedding model lands. This is also the
codebase's permanent, tested forced-CPU spawn example.

### §8 Expectations, profile bump, UI copy

| Hardware | CPU baseline | With GPU |
|---|---|---|
| Discrete NVIDIA (RTX 2060+) | 5–15 tok/s | 40–100+ tok/s (4B Q4); ~10× prompt processing |
| Discrete AMD (RX 6600+) | 5–15 tok/s | 35–90 tok/s |
| Intel iGPU (Iris Xe / Arc iGPU) | 5–15 tok/s | ~1–2× tokens (sometimes ≈ CPU), 2–4× prompt — shared DDR bounds it; say so honestly |
| No Vulkan-1.2 driver | 5–15 tok/s | unchanged (automatic CPU) |
| Apple Silicon | already GPU (Metal) | unchanged |

(Order-of-magnitude community numbers; the release-acceptance matrix replaces them with
measured values before release notes claim anything.)

**Profile bump rule:** `classifyProfile` takes a precomputed `gpuUseful: boolean` =
`gpuUsefulForProfile(devices)`: some device has **≥ 6144 MiB** AND `!looksIntegrated(name)`.
Conservative by design — an iGPU reporting 16 GB of *shared* RAM must never bump a laptop's
profile; a false negative only costs a too-small model recommendation. The regex lives in
`runtime/gpu.ts` (fixture-tested, covers Windows + RADV APU names and Meteor-Lake Arc).

**UI:** Settings toggle ("Uses your graphics card to speed up responses when available…"),
Diagnostics Acceleration + runtime-build lines, compatibility-mode notice + "Try GPU again",
benchmark-card GPU row. Never "GPU failed" / "your hardware is bad".

### GPU failure modes (all handled, none block)

| Failure | What happens |
|---|---|
| No Vulkan loader / 1.2 driver / RDP session | backend lib doesn't load or 0 devices → the default binary runs on its CPU backends; probe shows CPU |
| Driver enumerates but crashes at model load | rung-1 exit → rung 2 (`--device none`), `gpuAutoDisabled` persisted |
| Driver hangs (never healthy) | 60 s health timeout → rung 2; cost = one slow first start, then never again (flag persisted) |
| Driver crash mid-generation / VRAM stolen mid-run | §5.3 auto-restart at CPU + friendly notice; next message works |
| VRAM too small at load | upstream `--fit` partial offload — no special casing |
| Vulkan present but slower than CPU (weak iGPU) | no crash; honest §8 copy; Settings toggle exists; no auto-benchmark in v1 |
| Rungs 1–2 both fail (binary-level breakage) | rung 3 pure-CPU build |
| Stale flag after a driver upgrade | "Try GPU again" (re-probes, clears flags) |

**Release acceptance:** the manual 9-machine hardware matrix lives in **BUILD_STATE §5**
(item 1b — canonical); the fake-spawn unit tests cover the *logic*, the matrix covers the
*drivers*. Machine ① (dev box, RTX 3080 Ti) passed end-to-end 2026-06-10 via
`tests/manual/gpu-smoke.test.ts` (`HILBERTRAUM_GPU_SMOKE`; CI never runs it).

**History:** Phases 14–16 = commits `f1dcf34`, `9067b89`, `2d4adb7` (2026-06-10); the GPU
audit round = commit `4549934` (same day; full finding list in BUILD_STATE §3 "GPU audit
round"); the full original plan: `git show 4549934:docs/gpu-support-plan.md`.


## Internationalization — design record (Phases 39–42)

_Formerly `docs/i18n-plan.md` (condensed here at the Phase-42 closeout, 2026-06-13, per the
CLAUDE.md doc lifecycle rule; the full original working paper — phased plan, per-phase
as-built notes, original research — is in git history:
`git show 5059ed8:docs/i18n-plan.md`). The entire user-visible surface is available in
**English and German**, selectable in Settings → General (default: follow the OS); the
pre-unlock gate already renders in the right language. No new runtime dependency, no
network, no behavior change outside copy. **§ numbers below are preserved from the plan —
code comments cite them as "i18n record §N"** (the German style rules of §3.5 live in
`design-guidelines.md` "German microcopy")._

### Decisions (all LOCKED as built)

| ID | Decision |
|---|---|
| D-L1 | Hand-rolled typed i18n module in `shared/i18n/` (flat keys, `{name}` interpolation, `.one`/`.other` plurals); **no new dependency**. `de.ts` is typed `Record<keyof typeof en, string>`, so typecheck enforces catalog parity — removing a key is a compile error. i18next/react-intl were rejected: async resource loading + ICU machinery en/de don't need, and a provider-suspense would have churned hundreds of green synchronous tests. |
| D-L2 | `AppSettings.uiLanguage: 'system' \| 'en' \| 'de'`, default `'system'` (theme precedent); a `de`-prefixed OS locale ⇒ German, else English — **including the bare tag `'de'`** (the R-L1 finding below). |
| D-L3 | Pre-unlock language: renderer = the `hilbertraum.uiLanguage` **localStorage mirror** → `navigator.language` fallback; main = a cached language from `app.getLocale()` until settings become readable (post-unlock / plaintext startup), refreshed on `uiLanguage` patches. |
| D-L4 | **Persist canonical English, translate at display**: an exact-match display map over the finite static persisted set (`renderer/lib/displayMap.ts`). Keeps the `scanDetected` contract and pre-i18n rows valid; persisted copy is retroactively language-switchable. |
| D-L5 | **Ephemeral main→user strings localize at emission** via `tMain()` + the cached language; the IPC error transport (`friendlyIpcError`) is unchanged. |
| D-L6 | LLM prompts stay English and unchanged (Phase-29 benchmark comparability; models follow the question's language). Task-output language = a future feature; documented in `known-limitations.md` ("Internationalization"). |
| D-L7 | German address form = informal **„du"** (lowercase mid-sentence), a deliberate brand choice (user decision 2026-06-13); glossary pinned in `de.ts`. Human review of the German copy gates the wave (the user is the reviewer). |
| D-L8 | Default-English + synchronous `t()` keeps the ~323 pre-existing English copy assertions green; migrated assertions reference the `en` catalog instead of re-typed literals. English values for shipped strings stay **byte-identical** to the pre-i18n literals. |

### §3.1 The i18n module

`apps/desktop/src/shared/i18n/` (importable from both processes): `en.ts` is the
source-of-truth catalog (~600 keys; `MessageKey = keyof typeof en`), `de.ts` the typed
German catalog with the §3.5 glossary pinned on top, `index.ts` exports `t(lang, key,
params?)` (synchronous lookup + `{name}` interpolation; unknown key/missing param falls
back to English — never a crash), `tCount(lang, keyBase, n)` (`.one` for exactly 1, else
`.other` — English and German share the n===1 rule), and `resolveUiLanguage(setting,
osLocale)`.

### §3.2 The setting and its resolution

- Renderer: `renderer/i18n.tsx` — `I18nProvider`/`useT()` re-resolve on settings
  load/patch, set `document.documentElement.lang`, and mirror the **resolved** language to
  `localStorage('hilbertraum.uiLanguage')` (written only when a real setting resolves, never from
  the pre-unlock guess). The gate reads the mirror, falling back to `navigator.language` —
  a first run on a German OS shows a German gate with zero stored state; a user who chose
  the non-OS language gets it back at the next gate render. The mirror is a UI preference,
  not user data (the ChatScreen localStorage precedent).
- Main: `services/i18n.ts` holds the cached resolved language — initialized from
  `app.getLocale()` after `whenReady`, updated when settings become readable and inside
  `updateSettings()`. Every main-side emission calls `tMain(key, params)`. No new IPC.
- **R-L1 locale finding (measured on de-AT Windows 11, Electron 37):**
  `app.getLocale()` returns the **bare language tag `'de'`** (Chromium UI language — not
  always a full `de-DE` tag; `app.getSystemLocale()` gives `'de-AT'`), and the renderer's
  `navigator.language` matches. ⇒ `resolveUiLanguage` accepts bare `'de'` as well as
  `de-*`/`de_*` prefixes. The vitest environments are locale-independent (jsdom pins
  `navigator.language` to en-US; unit tests pass explicit locales) — never write a test
  that reads the real OS locale.

### §3.3 The two-rule boundary for main-process strings

- **Rule 1 — persist canonical, translate at display (D-L4).** Anything written to the DB
  or settings keeps being written as the exact English catalog value via an explicit
  `t('en', …)` at the persist site: the seven parser-failure constants (incl.
  `PDF_SCAN_DETECTED_MESSAGE`, whose **exact-match derives `scanDetected`** — the OCR
  offer), source-missing/interrupted ingestion messages, `NO_DOCUMENT_CONTEXT_ANSWER` +
  `REINDEX_NEEDED_ANSWER` (persisted into `messages.content`), `DOC_TASK_BUSY_MESSAGE`
  (recognized renderer-side via `includes`), the four `buildWarnings` strings (persisted in
  `settings.lastBenchmark`), and the default conversation title `'New chat'` (exact-matched
  by `maybeSetTitleFromFirstMessage`). The renderer translates at display via the
  exact-match reverse lookup `localizeServerCopy()` over `DISPLAY_MAP_KEYS` — the en.ts
  **persist-canonical section is a data contract**: editing a value breaks the match for
  already-persisted rows. Unknown/interpolated strings (e.g. `Unsupported file type: …`,
  raw parser-library errors) render as-is by design. A hygiene test pins
  `DISPLAY_MAP_KEYS` ↔ the persist-canonical section key-for-key.
- **Rule 2 — emit localized (D-L5).** Anything ephemeral (IPC guard throws, task-status
  errors, download/policy refusals, preflight problems, `runtime:notice`, dialog titles +
  picker filter names) localizes **in the main process at emission** via `tMain()`.
  Transient messages interpolate values and cannot be exact-matched — that is why
  display-mapping was rejected for this class.
- The product name "HilbertRaum" is never translated; language names in the
  picker stay untranslated (`System`/`English`/`Deutsch`); technical values (model ids,
  paths, hardware-profile codes) stay as-is. Audit-log `message` strings stay English in
  the DB and export (the Phase-19 privacy rule; only the Activity panel's type labels
  translate).

### §3.4 LLM prompts stay English (D-L6)

`BASE_SYSTEM_PROMPT`, the grounded template, and the task prompts are pinned — see the
D-L6 row and `known-limitations.md`.

### §3.5 German style

See `design-guidelines.md` → "German microcopy (D-L7)": the glossary, the informal-du
rules, and §11.4 tone adaptation. The glossary is also pinned as the comment block on top
of `de.ts`.

### §5 Renderer conventions (the Phase-40 sweep rules, kept for future strings)

- Label maps keep their structure; `label` values are `MessageKey`s resolved at render
  (`t(STATUS_BADGE[s].labelKey)`).
- Every `aria-label`, `title`, `placeholder`, and confirm-dialog string is catalog copy —
  accessibility copy is user-visible copy.
- Hand-rolled plurals use `tCount`; the date sites + number formatting take the resolved
  locale from `useT().lang` (`useGrouping: false` keeps English output byte-identical to
  the old `toFixed`).
- Inline JSX islands (`<code>`, `<strong>`) use before/after key pairs
  (`app.fatal.hintBefore/After`).
- Shared components RECEIVE a bound `t` prop/argument (`components/translator.ts`,
  `englishTranslator` default) — they stay pure and provider-less tests keep working (⑤).
- `MIC_BLOCKED_MESSAGE` stays canonical English in `lib/dictation.ts` and is exact-matched
  at display in `DictationButton` — the renderer-internal analogue of the display map.
- Tests assert via `t('en', key)` / the `en` catalog, never re-typed literals; German
  render smokes live in `tests/renderer/GermanSmoke.test.tsx`.

### Phase-42 QA (as built)

Full `de.ts` review pass against the glossary/du-form/tone rules (9 value fixes, commit
`a4d91de`); German eyeball walk over every screen incl. the encrypted first-run gate at
both window extremes (880×600 and maximized) with a programmatic overflow scan — found
and fixed three text-expansion layout issues (chat-header wrap, empty-state chip wrap,
`.kv dd` overflow-wrap) and one untranslated persisted string (`'New chat'`, now D-L4
treated); English regression leg via the Settings picker proved the display map
language-switches both ways. All seven acceptance criteria verified (BUILD_STATE §3,
Phase-42 entry). Tests: `tests/unit/i18n.test.ts` (module + catalog hygiene incl.
placeholder parity and plural pairs), `tests/unit/display-map.test.ts`,
`tests/unit/main-i18n.test.ts`, `tests/integration/i18n-boundary.test.ts`,
`tests/renderer/I18n.test.tsx` + `GermanSmoke.test.tsx`.

## Encrypted workspace (Phase 9 + audit rounds)
- **`services/security/crypto.ts`** — KDF (Argon2id default, scrypt legacy; descriptor-supplied
  params are bounds-checked) + AES-256-GCM primitives and the framed blob format.
- **`services/workspace-vault.ts`** — the vault lifecycle (`WorkspaceController`): create/unlock/
  lock, STREAMING whole-file encrypt/decrypt (constant memory; >2 GiB safe), chunked `shredFile`,
  crash-recovery sweep (`shredStalePlaintext` incl. `.tmp`/`.parse*` transients), the encrypted
  **document cache** (`DocumentCipher` for `workspace/documents/*.enc`), and the create-over-existing
  vault guard. Full design in [`security-model.md`](security-model.md).

## Drive tooling & distribution (Phases 11–13)
Canonical, unit-tested TS modules that the self-contained `scripts/*.{ps1,sh}` mirror natively:
- **`services/drive.ts`** — drive layout (`DRIVE_LAYOUT_DIRS`), `drive.json`/`policy.json`
  generators, `verifyDriveModels`, `buildChecksumsJson`, the prepare-drive plan.
- **`services/assets.ts`** — the DIY asset loader logic: `planModelDownloads`, runtime-build
  selection, `verifyDownloadedFile`, injected-fetch download seam.
- **`services/launcher.ts`** — `resolveDriveRootFromLauncher` (the per-OS launchers mirror it).
- **`services/preflight.ts`** — the friendly, non-blocking first-run drive check (`runPreflight` IPC).
- **`services/commercial-drive.ts`** — `planCommercialDrive` + `assertCommercialDrive`, the "is this
  drive sellable?" gate (commercial policy, weights VERIFIED, license reviews APPROVED, no user data).
- Drive detection without the launcher: `workspace.ts findPreparedDriveRoot` walks up from the app's
  own location (`PORTABLE_EXECUTABLE_DIR` / exe path) to the `config/drive.json` marker (audit M16).

## In-app model downloader (Phase 18)

The app's first sanctioned network feature — explicit, verified, impossible to trigger
silently; its absence changes nothing (the app stays 100 % usable offline). **Triple gate,
all enforced in MAIN and re-checked per call:**

1. `policy.network.allowModelDownloads` — the authoritative ceiling (**wave-1 decision D3**:
   `DEFAULT_POLICY` allows it so the spec §3.6 user toggle is the sole gate when no policy
   file restricts — "policy only restricts" preserved; `prepare-drive` writes deny in BOTH
   postures, so prepared drives stay download-disabled unless the builder edits
   `config/policy.json`).
2. `settings.allowNetwork` — the spec §3.6 checkbox, default off; a locked workspace reads
   as off.
3. A per-download confirmation: model name, size, license + `license_url`, upstream URL, and
   an explicit license acknowledgement when `license_review.status != approved` (the in-app
   `--accept-license`). The renderer dialog is UX; enforcement is main-side. When gate 1
   or 2 fails the AI Model screen says *why* (policy vs Settings toggle), reusing the
   `PolicyStatus` distinction.

**Mechanics:** `services/downloads.ts` `DownloadManager` — a job state machine over the
REUSED `assets.ts` seams (`planModelDownloads` + optional `hashStore`; `downloadToFile`,
extended additively with `signal`/`headers`/`append`/`onResponse`; `verifyDownloadedFile`).
Bytes land in `<weightPath>.part`, renamed into place ONLY after the hash verifies; a
mismatch deletes the partial and fails the job; a placeholder expected hash completes
`unverified` (checksum honesty). Cancel keeps the `.part`; the next start resumes via a
`Range` header (append iff the server answered 206). One download at a time; jobs are
in-memory, polled over `downloads:start/get/cancel` (the Phase-4 import precedent — no new
event channels). On success the checksum-cache entry is invalidated. Audit events
(`model_download_started/verified/failed`) flow through the injected
`DownloadManagerDeps.audit` hook; a placeholder-hash completion records NO "verified".
No update checks, no catalog (only manifests already on the drive), no background anything;
a sanctioned download session is by definition not `offlineMode`. Gate semantics +
licensing: `model-policy.md` §"The in-app downloader"; user-facing posture: `PRIVACY.md`.

**`settings.allowNetwork` now defaults ON (2026-06-13).** The spec §3.6 checkbox was flipped
`false → true` in `DEFAULT_SETTINGS` so a fresh install can download models out of the box
(onboarding feedback). Gate 1 (the policy ceiling) is unchanged and still authoritative: a
commercial `policy.json` with `allow_model_downloads: false` — or the packaged-build
`STRICT_POLICY` fallback — keeps the app offline regardless of the toggle, and telemetry stays
hardcoded off. A locked workspace still reads the setting as off.

### In-app engine installer (2026-06-13)

The model downloader fetches model WEIGHTS only; the `llama-server` **engine binary** is a
separate asset (`runtime-sources.yaml`, normally provisioned at drive-build time by
`fetch-runtime`). With weights present but no engine, a started model lands on the **demo
runtime** (`runtime/factory.ts` — "no llama-server binary on the drive"), which is what a user
hits when downloading a model into a dev/incomplete drive. `services/runtime-download.ts`
`EngineDownloadManager` closes that gap: it resolves the host build (`selectHostBuild`), then
**download → verify → clean → extract → flatten → write the `.hilbertraum-runtime.json`
marker** — mirroring the canonical `fetch-runtime` scripts, but in-app. The network
(`fetchImpl`) and the archive extraction (`extractImpl`, default `tar -xf`, which covers the
.zip/.tar.gz host assets via bsdtar/GNU tar) are **injected seams**, so the unit suite stays
zero-network and never shells out. **Same gates as the model downloader** (policy ∧
`allowNetwork`), re-checked in main; placeholder hashes complete `unverified` (checksum
honesty); the install is **idempotent via the marker** (`runtimeInstallCurrent`). Surfaced as
`engine:status/download/getJob/cancel` IPC + a Models-screen "Install the AI engine" banner
(shown only when the engine is missing but a host build exists; progress/cancel like a model
download). **CI exercises only the injected seams — the real fetch + `tar` extraction of the
pinned build is a manual smoke (like the GPU/PAID harnesses).**

## Diagnostics & transcript export (audit round)
- `getRuntimeStatus` (read-only runtime health), `getLogTail` (tail of the local `app.log`), and
  `exportConversation` (spec §7.6 transcript export via the OS save dialog) round out spec §7.11/§7.6.
- **Copy / save (support hand-off).** Each Diagnostics card — **App & runtime**, **Hardware
  benchmark**, **Logs** — has a **Copy** button that writes a plain-text rendering of exactly the
  rows shown to the clipboard (confirmed by a transient toast), so a user can paste the lot into a
  support message. The copy goes through **`window.api.copyToClipboard`**, which writes from the
  **main process** (`clipboard:write` IPC → Electron's `clipboard.writeText`) — **not**
  `navigator.clipboard` (unreliable in the `file://` renderer: needs a secure context + focus) and
  **not** a preload-side `clipboard` call (the renderer is `sandbox: true`, so the sandboxed preload
  has no `clipboard` module — only `ipcRenderer`/`contextBridge`/`webFrame`/`nativeImage`/`webUtils`).
  The same bridge backs the chat message-copy action. The on-screen rows and the copied text are
  built from the same helpers (`runtimeStatusLine` / `buildAppRuntimeReport` / `buildBenchmarkReport`
  in `DiagnosticsTab.tsx`) so they can't drift. The Logs card additionally has **Save to file…** →
  `exportLog` IPC → `saveTextExport`, which writes the **whole** current log (`readLogFull()`, not
  just the `getLogTail` tail) as **plaintext** to a user-chosen location. This is a deliberate user
  action: the on-disk `app.log` stays **encrypted** at rest (see "Encrypt the diagnostics log at
  rest"); the export is the user choosing to take a copy *outside* the vault to share — never
  uploaded, no telemetry.
- A never-benchmarked workspace is benchmarked **automatically in the background** after it becomes
  usable (spec §2.1 first-run benchmark; `maybeRunFirstBenchmark`).

## Audit log (Phase 19)

`services/audit.ts` finally writes the spec §8 `runtime_events` table (created in Phase 1,
unwritten until now): `recordEvent(db, type, message, metadata?)` (NEVER throws), a typed
`AuditEventType` union (`shared/types.ts`), `listAuditEvents` (newest-first, `beforeId`
cursor), and prune-on-insert retention to `AUDIT_MAX_ROWS = 5000` (**wave-1 decision D7** —
fixed for wave 1; configurability is Office-edition admin surface). **For the user, not
telemetry**: it lives in the workspace DB (encrypted at rest on encrypted workspaces) and
is never uploaded. The app-wide recorder
(`createAuditRecorder` → `AppContext.audit`, optional so partial test contexts stay valid) is
built over the workspace DB *getter* — while the vault is locked it buffers events in memory
(bounded) and flushes them after the next unlock.

**Wiring is deliberately shallow** — call sites live in the IPC layer, not inside services
(keeps services pure/testable): `registerCoreIpc` (`settings_changed`, privacy-relevant keys
only), `registerModelIpc` (`model_selected/verified`, `runtime_started/stopped`),
`registerChatIpc` (`conversation_deleted/exported`), `registerDocsIpc`
(`document_imported/reindexed/deleted`), `registerWorkspaceIpc`
(`workspace_created/unlocked/locked/unlock_failed`), `registerDownloadIpc` → an injected
`DownloadManagerDeps.audit` hook (`model_download_started/verified/failed` — the Phase-18
follow-up), plus `main/index.ts` for `runtime_crashed`/`runtime_fallback` (the GPU
crash-fallback/ladder callbacks), `policy_warning` (startup `loadPolicy`), and
`offline_guard_violation` (a new `assertOfflinePosture.onViolation` hook).

Surface: the **Activity** panel on the Settings Diagnostics tab (`getAuditEvents(limit, beforeId?)` IPC
`audit:list`, client-side type filter, "Show earlier activity" paging) and an
export-to-file action (`exportAuditLog` IPC `audit:export`, the `exportConversation`
save-dialog precedent, JSON output). Data class + privacy rule:
[`security-model.md`](security-model.md) §"Audit log data class".

## Document organization — design record (Phases A–F, §1–§8)

_Formerly `docs/document-organization-plan.md` (condensed here at the Phase-F v1 closeout,
2026-06-14, per the CLAUDE.md doc-lifecycle rule; the full original working paper — three audit
rounds, the §0/§0.1/§0.2 decision ladder, per-phase as-built notes, the open-questions register —
is in git history: `git show 477f803:docs/document-organization-plan.md`). A collection-membership
layer over the existing ingestion/retrieval pipeline: one stored file, one chunk set, one vector set
per document — organization is metadata. Five user-facing containers — **Library**, **Projects**,
**Temporary**, **Generated** (a role/view, not a place), **Archive** — plus query-time **Smart
views**. (A rule-based **filing-suggestion** engine shipped in Phase F and was **removed
2026-06-15** — see §4.) Everything stays local + offline. **The retrieval /
scope half of this design lives in [`rag-design.md`](rag-design.md) §13** (resolveScope, the
RetrievalScope union, collection-filtered search); this record is the **data model, IPC, and
audit** layer. **§ numbers below are stable**; future code comments _should_ cite them
as "doc-org record §N" (existing comments still say "plan §x"; those resolve via git history above)._

### §1 Decisions (the locked ladder — D1/D2/D3 + the audit fixes)

| Decision | Choice | Why (short) |
|---|---|---|
| Organization primitive | **Collection membership** (`document_collections`), never duplicated files/vectors | One doc = one chunk/vector set shared across every collection it belongs to (the cheap-change principle) |
| Projects vs a new table | **Projects ARE collections** (`type='project'`); Library/Temporary are seeded built-ins (`builtin=1`) | One membership model carries Library, projects, and (later) smart-view ids uniformly |
| **D1** — chat scope | A **composed UNION** the user picks from Library + project(s) + specific docs, persisted in `conversations.scope_v2_json` | Users think in "my sources", not one bucket; survives restart |
| **D2** — duplicate import | **Always a new document** (no sha-dedup, no prompt). Share one doc across folders via **Add to collection** | Import stays dumb + predictable; de-duplicated sharing is the explicit membership action |
| **D3 + N1** — generated docs | Get **NO `document_collections` membership at all** ⇒ structurally absent from every collection scope; reachable only by explicit doc-id or download + re-import | Generated outputs are work products, not auto-trusted knowledge; no exclusion predicate needed |
| **C1** — archive | A doc leaves retrieval **only** via its own `lifecycle='archived'`; archiving a *project* just removes it as a selectable source | Archiving "Tax 2025" must never make a Library doc vanish from Library answers |
| **C2** — delete-project "with documents" | Deletes ONLY docs with **no other membership of any kind** (built-ins counted) | A Library+project doc is Library knowledge — un-filed from the project, never deleted |
| **C3** — temporary chat files | Their own scope category — a `conversation_documents` link, **never** `scope_json` | `scope_json` chips would masquerade temp files as a removable manual selection + disable filename auto-scope |
| **M1** — queued-import intent | `documents.pending_destination_json` written at queue time, applied on **every** indexing success (`fileFromPendingDestination` runs in the import loop AND inside `reindexDocument`) | A crash mid-import is reconciled to `failed`; the user's Re-index then re-files to the intended Project/Temporary, not Library (the re-index path files too — DM-1) |
| **Phase F** — filing suggestions | **Rule-based only** (no model, no network), **never silent / never auto-file**; dismissals in `AppSettings` (no new column) | Local-AI classification is a later owner-gated step; a suggestion is inert until Apply |
| Migration shape | Additive only — new tables + **nullable** columns (the `ensureColumn` DDL allows no `DEFAULT`/`NOT NULL`); NULL-as-sentinel coalesced in code | Matches the established `scope_json`/`parseScope` precedent |

### §2 Hard rules (these bound every choice)

- **Additive, nullable columns only** — `ensureColumn` validates DDL with `/^[A-Za-z0-9_ ]+$/`
  (no quotes/punctuation), so every new column is nullable with NULL coalesced in code (e.g.
  `docLifecycle(row)`: NULL ⇒ `'permanent'`). New *tables* carry full SQL in the `SCHEMA` constant.
- **Malformed persisted JSON never throws** — every parse (`parseDocumentScope`,
  `parsePendingDestination`, `parseOrigin`) is tolerant → safe default.
- **Privacy/audit data class holds** — collection events record **id + type + count only, NEVER the
  collection/project NAME** (a project name like "Divorce" is content-ish; the filename allowance does
  not extend to it). Search/scope query text is still never logged. Enforced by the sentinel-grep
  test `tests/integration/audit-ipc.test.ts`.
- **Offline/local** — every organization op is a pure local SQLite write; filing suggestions are a
  pure local rule engine. No network, no model, no telemetry; the feature works with zero models.
- **Encryption at rest** — the new tables live in the same workspace DB, so they are encrypted with it.

### §3 Data model (additive — `db.ts` `SCHEMA` + `ensureColumn`)

Three new tables; **`ON DELETE CASCADE` on both FKs of `document_collections` and
`conversation_documents` is load-bearing (C4)**: `openDatabase` runs `PRAGMA foreign_keys = ON` and
`deleteDocument` deletes the `documents` row directly, so without CASCADE a *pre-feature* app deleting
a doc in a *post-feature* DB would hit an FK violation. CASCADE makes any build delete a doc cleanly
and removes manual membership-cleanup ordering.

```
collections(id, name, type, description, builtin, color, created_at, updated_at,
            archived_at, retention_policy_json)        -- type ∈ library|project|temporary|archive|smart
document_collections(document_id, collection_id, role, added_at)  -- PK(doc,coll) ⇒ idempotent add
conversation_documents(conversation_id, document_id, added_at)    -- C3 temp-attachment link
```

- `type='archive'`/`'smart'` are reserved enum strings, **not stored as rows** in v1 (archive is a
  lifecycle; smart views are query-time). `role='generated'` is reserved-unused (N1 — generated docs
  get no membership). The composite PKs make add idempotent (`ON CONFLICT DO NOTHING`).
- Additive `documents` columns (all nullable): `lifecycle` (NULL ⇒ permanent),
  `source_relative_path` / `source_folder_label` (folder-import display metadata),
  `pending_destination_json` (M1), `expires_at` (reserved for Phase-E.2 retention, NULL in v1).
  **`last_used_at` is deferred** (L2 — it would add a hot-path write per cited doc).
- Additive `conversations` columns: `collection_id` (the legacy single-project creation anchor) +
  `scope_v2_json` (the D1 composite `DocumentScope`).
- **Migration** (idempotent, inside `openDatabase`): create tables → `ensureColumn`s → seed **one**
  Library + **one** Temporary built-in (canonical English name stored; UI localizes by `type`) →
  **backfill Library membership** for every `status='indexed'` doc that has no membership **and
  `origin_json IS NULL`** (the M1 status gate + the D3 generated-skip). Re-open is a no-op
  (membership-guarded). Generated rows get no membership (step is a no-op by construction).

### §4 Services (`collections.ts`)

- **`collections.ts`** (plain functions, no class) — CRUD (`createCollection`/`rename`/`setCollectionArchived`/
  `deleteCollection`), membership (`addToCollection`/`removeFromCollection`, idempotent),
  `setDocumentsLifecycle`, the **C2 predicate** `projectOnlyDocumentIds` (counts ALL memberships so a
  Library member is spared), and the indexing-success filing entry points
  `fileFromPendingDestination` → `fileDocumentByDestination` (Library default when no intent recorded,
  so options-less imports stay byte-for-byte). `fileFromPendingDestination` is the **single
  indexing-success entry point (M1/DM-1)**: it runs both in the in-session import loop AND inside
  `reindexDocument`, so whoever drives a doc to `indexed` files it by its intent — a crash-interrupted
  import that the user re-indexes lands in its Project/Temporary, not Library. It is idempotent (Library
  is unfiled-guarded, pending cleared on first success) and **skips generated docs** (`origin_json` set
  ⇒ no membership, D3/N1), so re-indexing a translation never sweeps it into Library.
  `linkConversationDocument` is **FK-guarded (N3)**:
  verifies the conversation still exists + try/catch the race; if gone, keep the doc in Temporary, drop
  only the link. `resolveScope` is documented in rag-design §13.
- **Filing-suggestion engine (`filing-suggestions.ts`, Phase F) — REMOVED 2026-06-15.** The
  auto "suggested project" feature (the rule engine, the read-only `docs:filingSuggestions`
  IPC, the per-row suggestion chip, and the `dismissedFilingSuggestions` setting) was removed
  as an intentional product decision: it added a near-equal row affordance for a low-value
  guess. Filing is now fully manual via the row **⋯** / selection toolbar (`addToCollection` /
  `createCollection`). The full original lives in git history (`git show HEAD~1:apps/desktop/
  src/main/services/filing-suggestions.ts`); `source_folder_label` import metadata is retained.

### §5 IPC / preload surface (additive, backward-compatible)

| Channel | Signature | Handler |
|---|---|---|
| `collections:list/create/rename/setArchived/delete` | CRUD; delete takes `'membershipOnly' \| 'withDocuments'` (C2) | `registerCollectionsIpc.ts` |
| `docs:addToCollection` / `removeFromCollection` | `(documentIds[], collectionId)` — **Move = add + remove** (no channel) | `registerDocsIpc.ts` |
| `docs:setLifecycle` | `(documentIds[], 'permanent'\|'temporary'\|'archived') ⇒ DocumentInfo[]` | `registerDocsIpc.ts` |
| `docs:import` (extend) | `(paths[], options?: ImportOptions)` — `destination` persisted at queue time (M1) | `registerDocsIpc.ts` |
| `docs:list` (extend) | `filter?: { collectionId?, lifecycle?, smart?: SmartListView }` — `smart` shares the pure `matchesSmartView` with the renderer rail | `registerDocsIpc.ts` |
| `chat:setScope` / `setCollection` / `listAttachments` | composite scope persist · creation anchor · the `conversation_documents` attachments | `registerChatIpc.ts` |
| `skills:list/get` | `() ⇒ SkillInfo[]` · `(installId) ⇒ SkillInfo \| null` (first read reconciles disk→DB) | `registerSkillsIpc.ts` |
| `skills:pick/preview/import` | OS picker ⇒ path · `(source) ⇒ SkillPreview` (no write) · `(source) ⇒ SkillInfo` (validate→place→DS7) | `registerSkillsIpc.ts` |
| `skills:export/delete` | save dialog ⇒ `.skill.zip` (package tree only) · ref-clear sweep + rm folder (app skills refuse) | `registerSkillsIpc.ts` |
| `skills:enable/disable/acknowledgeWarning` | `(installId) ⇒ SkillInfo`; enable enforces one-active-per-id (DS12) | `registerSkillsIpc.ts` |

Renderer-untrusted inputs are sanitized at the boundary (`sanitizeDestination` ⇒ Library fallback;
`safeIdArray`). Every channel mirrors 1:1 in `preload/index.ts`. **Smart views** (§7.6) are query-time
predicates via the shared `matchesSmartView` (`shared/types.ts`) — Generated/Unfiled/Recently added/
Needs re-index/Large/Failed/Audio/OCR — kept in lockstep between the rail and `docs:list`; they are
**not stored collections and not pickable retrieval scopes** in v1.

### §6 Generated provenance (Phase D, structured)

A materialized translation/comparison writes a structured `GeneratedProvenance`
(`{kind, sourceDocumentIds, sourceCollectionIds?, modelId?, createdAt}`) into the **reused**
`origin_json` (no new column); `parseOrigin` reads it first, then falls back to the legacy
`Translation/CompareOrigin` shapes unchanged. `provenanceView(origin)` normalizes both to
`{kind, sourceDocumentIds}` so the UI has one path. The generated row gets **zero membership** (N1/D3)
and is surfaced only by the Generated smart view (`origin != null`). **`origin_json` is stamped at
`createQueuedDocument` time — BEFORE the row can be `indexed` (DM-2)** — so the Library backfill's
`origin_json IS NULL` guard holds even if the process is killed mid-materialize; the post-success
`setDocumentOrigin` then only re-asserts it and clears `original_path`. A half-born work-product is
therefore never swept into Library. Snapshot semantics are unchanged;
the Phase-E `generatedStaleness(doc, sources)` is a pure, tolerant derivation (no new column, no
hot-path write) flagging a row when a source's `updatedAt` post-dates the output's `createdAt`
(`source-changed`) or a source is missing/archived (`source-removed`).

### §7 Audit events (id/type/count only)

New `AuditEventType`s: `collection_created`/`renamed`/`archived`/`deleted` and
`documents_added_to_collection`/`removed_from_collection`/`document_lifecycle_changed` — metadata is
**collection id + type + affected count ONLY, never the name**. The deliberate asymmetry (filenames are
logged, project names are not) is recorded so a future reviewer doesn't "fix" it by logging names.
**Filing suggestions add NO audit event**: Apply reuses `documents_added_to_collection`, so the
suggestion reason (folder / filename pattern / project name) is never logged. The sentinel-grep test
seeds a project-name + a folder-label (suggestion-reason) sentinel and proves neither appears.

### §8 Accepted v1 trade-offs & deferred work

- **Library == all documents on day one** — the distinction earns its keep only as the user adds
  Temporary/Archived/Project-only docs (intended gradual behaviour).
- **Re-importing the same file yields a second row + vector set** (D2) — deliberate de-dup-free import.
- **Pre-feature app on a post-feature DB** ignores collections for *display* but relies on CASCADE for
  safe *deletion* (C4) — one-line note in `known-limitations.md`.
- **Deferred (owner-gated):** Phase E.2 explicit retention + Temporary review dashboard (the reserved
  `expires_at` column, a review-before-delete UI, default Never, never touching Library/generated/
  project-filed docs, shredding sidecars under encryption); `last_used_at`/"Recently used" (L2);
  **local-AI filing suggestions** (Phase F "later"); auto-creating projects from top-level import
  folders (§11.2 / open question Q8).

**History:** Phases A–F = commits `5c70021`, `7bcd4a1`, `39531e8`, `e0bff6b`, `499c3ab`, `477f803`
(2026-06-14); the full original plan: `git show 477f803:docs/document-organization-plan.md`.


## Skills — design record (Phases S2–S13, §1–§19)

A **Skill** is a self-contained, local task package (instructions + optional examples/schemas) the
user selects to shape one turn. Two tiers shipped: **Tier 1 — instruction-only** (the body is injected
as fenced reference text) and **Tier 2 — app-tools** (the bundled bank-statement skill runs typed,
app-orchestrated tools through a validate→run→validate gate). Tier 3 (sandboxed scripts) is
explicitly out of v1. This record consolidates the two working-paper plans (`docs/skills-plan.md`
§1–§19 + `docs/skills-s11-plan.md`, both deleted at S12 — full text in git history); the **security**
model lives in [`security-model.md`](security-model.md) ("Skill-import defences", "App-skill
provisioning…", "Skill tool ceiling (Tier-2)"), the **drive layout** in
[`drive-layout.md`](drive-layout.md), and the accepted **residuals** in
[`known-limitations.md`](known-limitations.md).

### §1 Decisions (the ones that bind as built)

- **DS1/DS2** — files on disk are the source of truth; the `skills` table is a derived index/state
  cache. `SKILL.md` (YAML frontmatter + Markdown body) is canonical; `manifest.json` is an optional,
  non-authoritative cache (SKILL.md wins). The shared parser is `shared/skill-manifest.ts`.
- **DS3/DS19/DS20** — skills are **non-secret task knowledge**, stored **unencrypted as plain folders
  outside `workspace/`**: `app-skills/` (read-only) + `user-skills/` (read-write). A folder dropped
  into `user-skills/` installs **disabled** (DS19); secret material belongs in an encrypted document,
  never a skill (DS20). _(The original encrypted-blob model — DS11 — was revoked.)_
- **DS4** — selection is deterministic/manual (picker + Settings + a one-tap suggestion); tools are
  **app-orchestrated** — the model never parses `tool_calls`; it only *explains* a validated result.
- **DS5** — the skill body is injected as a fenced **data** block with fixed precedence below the base
  preamble + grounding rules + a guard line; **one skill per turn**.
- **DS6/DS8** — permissions are app-computed (restrict-only, clamp-down); in v1 `permissions.*` is a
  display string (nothing executes), real enforcement is the Tier-2 ceiling. A skill can never register
  or self-grant a tool.
- **DS7/DS12/DS15** — a deliberate view-import installs **enabled-with-warning**; duplicate ids coexist
  with **one active per id** by trust-then-version-then-recency precedence; a downgrade is refused
  outside developer mode (a footgun guard — `version` is unsigned).
- **DS16/DS18** — a skill applies to **one turn** (`messages.skill_id`) with a sticky
  per-conversation default (`conversations.active_skill_id`); the per-message glyph marks the answer it
  shaped. Auto-fire is deferred to **S13**, gated on an evaluation harness.
- **DS17** — app skills are committed to the repo (`app-skills/`, text only) and copied by
  `prepare-drive` — never network-fetched. **Nine** bundled app skills now ship. Three are **Tier-2**
  tool references — **`bank-statement`** (the first, `kind: tool`, app-orchestrated tools through the
  §7 gate), **`invoice`** (the second Tier-2, proving the gate generalizes to a second content class),
  and **`document-redaction`** (read-transform-export). The rest are **Tier-1 instruction** skills
  (`kind: instruction`, `allowedTools` empty / `reservesTools` false — they only inject fenced
  guidance): **`meeting-protocol`** (titled *Meeting Minutes*, the Tier-1 reference) plus the
  **Professional Documents** wave — **`contract-brief`**, **`deadline-obligation-finder`**,
  **`what-changed`**, and **`share-safe-review`** (advisory; it points at the redaction *tool* but
  declares none and creates nothing). The Professional Documents skills are honest by construction:
  no legal/compliance certainty, no "fully anonymized" claim, and "ask exactly two documents" /
  "this is not a complete compliance calendar" guards where coverage is partial. meeting-protocol and
  invoice are both **bilingual-trigger** references: their
  `triggers.keywords` carry German and English terms, with umlaut/ending singular-plural pairs listed
  separately (`beschluss`/`beschlüsse`, `rechnung`/`rechnungen`) because §6 matching is case-insensitive
  *substring* (`question.includes`), so an ending/umlaut breaks the substring and each form must appear
  in its own right (and short ambiguous tokens — `vat`/`ust`/`net`/`gross` — are deliberately avoided).

### §2 Hard rules (these bound every choice)

Additive-only schema (new tables full SQL, new columns nullable; DS10). **No** change to CSP, the
deny-by-default permission handler, the offline guard, the encryption posture, or packaging (§14 —
the loader is pure main-side file I/O + DB; no new renderer capability, no new network path). No new
native dependency, fully offline (CLAUDE.md §0). Audit + logs carry **ids/counts only**; content
(skill bodies, the draft question, extracted figures) is never logged/audited (the content-class rule,
proven by the consolidated sentinel guard, §12).

### §3 Storage & registry (S3)

Skill packages live as **plain folders OUTSIDE the encrypted workspace** (`<root>/app-skills/`
read-only + `<root>/user-skills/` read-write). **Disk is the source of truth**; the `skills` table is a
pure derived index + state cache (`services/skills/registry.ts`), reconciled from those folders the
same way `services/models.ts` discovers manifests and doc-org `collections.ts` reconciles a DB index.
Reconcile **inserts** new folders (app → enabled; a user drop-in → DISABLED, DS19), **updates** changed
ones while preserving user state (enabled / `warning_ack`), and **marks unavailable** (never deletes) a
row whose folder vanished — so a transiently-unmounted drive keeps the user's choices and the
conversation/message references. A DB rebuild re-derives every row from disk (no orphan). The PK
`install_id` is the deterministic natural key `"<source>:<id>"` (stable across rebuilds, so the FK-less
`conversations`/`messages` refs keep resolving); there is deliberately **no FK into `skills`** (refs are
cleared by an app-level sweep on delete, §4). `services/skills/loader.ts` has one mode — read the
folder — for both sources (no decrypt/transient/shred).

### §4 Import / export / delete lifecycle (S4)

`services/skills/installer.ts` owns the lifecycle behind IPC. Import **validates** a `.skill.zip` or
folder with a net-new dependency-free **member-by-member safe extractor** (built-in `node:zlib` + a
central-directory parser; full defence matrix in [`security-model.md`](security-model.md)), stages the
whole tree, then **places it as plain files at `user-skills/<id>/`** (folder name == manifest id) and
reconciles the row to **enabled-with-warning** (DS7) — unless an enabled app skill of the same id is
already effective, in which case the import **coexists disabled** (trust-first precedence, DS12). A
lower version is refused unless developer mode (DS15). **Delete** is an app-level **ref-clear sweep**:
in one transaction it nulls `conversations.active_skill_id` + `messages.skill_id` pointing at the
install id and deletes the row (no FK to cascade), then removes the folder; app skills refuse. **Enable**
enforces **one-active-per-id**. The registry handle reconciles disk→DB **once per session on the first
read after unlock** (a `reconciledThisSession` guard, not an unlock hook); the importer/deleter call
`reconcile()` explicitly after mutating disk. Audit events
(`skill_imported`/`deleted`/`enabled`/`disabled`) carry **ids/counts only**.

### §5 Selection & prompt integration (S6+S7)

A single shared **`resolveTurnSkill`** (`services/skills/turn.ts`) feeds **both** chat channels —
`registerChatIpc` (`sendChatMessage`) **and** `registerRagIpc` (`askDocuments` gained a skill arg,
§22-A1) — so a documents conversation gets the skill too; it reads the per-turn override or the sticky
default and **skips a disabled/deleted/unavailable skill gracefully** (resolves to none, never an
error). `services/skills/prompt.ts` builds the **fenced skill block** — a delimited DATA block
(BEGIN/END framing + the guard line `SKILL_GUARD_LINE` as the last app-authored line), never a system
rule (§22-H2). Placement: in **plain chat** the fence is bracketed inside the system message after
`BASE_SYSTEM_PROMPT` (`buildSystemPrompt(skillFence?)`); in **grounded answers** it rides the **user
turn with the excerpts** (`buildGroundedPrompt(question, chunks, skillFence?)`), where the
grounding/citation rules keep precedence. The fence is **pre-sized in `prompt.ts`** against the base
preamble + final turn (+ grounded excerpts) so it can never starve them — `fitMessagesToContext` only
drops older history (§22-A6); over budget it reduces by **whole paragraphs**, and if even the minimum
won't fit it is **omitted entirely** rather than truncated mid-instruction. The assistant row is
stamped with the install id **only when the fence was actually placed** (§22-A5); a no-context answer
stamps NULL, and `listMessages` LEFT JOINs `skills` so a **deleted** skill resolves `messages.skill_id`
back to NULL. The renderer surfaces a quiet composer **"Skill: …" picker** + a per-message **skill
glyph** on the answer it shaped (icon + word, never colour-only).

### §6 Suggestion heuristic (S8)

`services/skills/selector.ts` scores each **enabled** skill's cached `triggers` against the turn —
keyword hits in the draft question (the strong signal) + the in-scope documents' MIME types / filename
globs (supporting) — fully **deterministic, no model, no network**, with a fixed threshold (a lone
document signal never fires). `services/skills/suggest.ts` resolves the conversation's scope
**main-side from the conversationId** (§22-C4), gathers the signals, and returns at most **one** offer
over `suggestSkills(conversationId, question?)`. The question is content: scored but **never logged**.
The offer is surfaced **only inside the composer picker** (no canvas chip, no settings key) and is
**inert until tapped**. **Auto-fire (S13)** is the opt-in extension of this same scorer that *does*
apply a skill without a tap, behind a separate higher threshold + an opt-in + a per-turn undo — see
**§18**.

### §7 Tier-2 tool gate (S10)

`services/skills/tool-registry.ts` is the **static, app-owned** map of `SkillTool`s. A skill never
registers a tool: it only *declares* names via `allowedTools`, and the effective set is the three-way
intersection `declared ∩ registry ∩ userGrant` (`resolveEffectiveTools`). Runs are **app-orchestrated**
(DS4): the app calls `runSkillTool(tool, {skillId, input, ctx, confirmed})` directly. The gate's fixed
order: (1) refuse if the `AbortSignal` is already aborted; (2) **validate input** against `inputSchema`
(a hand-rolled JSON-Schema subset — no validator dep) and refuse **without calling the tool** on a bad
shape; (3) refuse a write/export tool lacking `confirmed:true`; (4) run inside a narrow
`SkillToolContext` whose `documentIds` the gate hands over **frozen** (un-widenable scope), with no
`Db`/SQL/FS/net handle; (5) **validate output** against `outputSchema` — a wrong shape **fails the run**;
(6) bracket with ids/counts-only audit (`skill_run_started`/`done`/`failed` = `{skillId, toolName,
documentCount}`). S10 shipped the gate with one harmless reference tool (`count_selected_documents`).
The full ceiling rationale is in [`security-model.md`](security-model.md) "Skill tool ceiling (Tier-2)".

### §8 Bank-statement tools + the run seam (S11)

S11 wires the first Tier-2 *feature*. The bank specifics live in
`services/skills/tools/bank-statement.ts` (deterministic, offline parsers — kept out of the generic
registry, §13); five tools are registered: `extract_transactions` (read-only; reads a statement's
**page-addressable chunks** through the **only content reach a tool has**,
`SkillToolContext.readDocumentChunks` — scope-bounded, still no raw handle),
`validate_statement_balances` (printed vs computed running balance → a per-row `reconciled` flag, honest
ok/mismatch/unknown), `categorize_transactions` (deterministic rules → `category_id`, seeding the
built-in categories/rules), `summarize_cashflow` (read-only inflow/outflow/net totals — figures are
content, not surfaced in v1), and `export_transactions_csv` (confirm-gated `export-file`). The
**app-orchestrated run seam** `services/skills/run.ts` is what a user action triggers (DS4): it records a
`skill_runs` lifecycle row (ids/refs only), builds the narrow context, runs the tool through the gate,
and persists atomically (ROLLBACK ⇒ no partial rows). The four downstream tools operate on the
**already-extracted** rows — the seam loads the **latest statement** for the in-scope document and passes
them as **structured input**, so the tools stay pure and the §7 ceiling is unchanged (no new accessor).
**The CSV export is the first FS-write from a skill tool:** the pure tool only *produces* the CSV string;
the seam writes it main-side to a **user-chosen path** via a save dialog, gated on the `export-file`
confirm — the path + content never touch any log/audit (only "saved N rows" is surfaced), and free-text
fields are neutralized against spreadsheet formula-injection (S12 fix). The bank `SKILL.md` is
`kind:'tool'`, which makes its declared `allowedTools` effective (the SL-1 parser path keeps the list only
for `kind:'tool'`) and uses the reconcile/validate body. **Geometry-aware PDF reading for columnar
statements (Phase 31, D50–D58) + the opening/closing-balance completeness gate are recorded in §21**
(the `pdf-layout.ts` layout mode + `extractStatementBalances`/`isStatementComplete` extend these same
bank tools; in-code comments here citing `architecture.md "Skills — design record" §8` for the bank
domain still resolve, the geometry specifics live in §21).

**The invoice skill is the SECOND Tier-2 reference** (`app-skills/invoice/`, `id:'invoice'`), proving the
gate generalizes to a second content-class domain with strong EN+DE coverage. It mirrors bank-statement
layer-for-layer: three tools in `services/skills/tools/invoice.ts` — `extract_invoice` (read-only; the
same `readDocumentChunks` reach over the frozen scope), `validate_invoice_totals` (read-only; deterministic
checks within a half-cent epsilon — line items → net, net + tax → gross, tax vs. rate — each
`ok`/`mismatch`/`unknown`, an honest `reconciled` verdict + a `resultKind` discriminator like
`validate_statement_balances`), and `export_invoice_csv` (confirm-gated `export-file`, the line-items CSV).
Parsing is DETERMINISTIC + OFFLINE and CONSERVATIVE (invoice layouts vary — a known limitation that improves
later): header fields and totals are read from **labeled lines only**, line items split a description from a
trailing quantity + trailing unit-price/line-total money tokens, and anything that cannot be confidently
parsed is **dropped** (header fields are individually optional, never guessed). The deterministic money/date
primitives (`parseAmount`/`parseDate`/`detectCurrency`) and the CSV formula-injection neutralization
(`csvField`) are now **shared** by both domains in `services/skills/tools/money.ts` — one parser per locale
rule, one audited export boundary. The run seam is the sibling `services/skills/invoice-run.ts` (it reuses
`run.ts`'s `buildReadDocumentChunks`/`finishRun`): same `skill_runs` lifecycle, same no-partial-persist
(BEGIN…COMMIT/ROLLBACK), same B2/B4 guards, latest-invoice-for-document downstream target, structured input
(no new `SkillToolContext` accessor — the §14 ceiling is unchanged). The dispatch (`tool-runs.ts`) wires the
three names; the controller / IPC / renderer stay domain-free (the renderer adds only the three tool labels
+ the invoice `resultKind` copy). Content-class isolation holds: the new `invoices` / `invoice_line_items`
tables + `skill_runs` never appear in any log/audit/export (audit stays `{skillId, toolName, documentCount}`).

**The document-redaction skill is the THIRD Tier-2 reference** (`app-skills/document-redaction/`,
`id:'document-redaction'`), and the **read-transform-export** shape the bank/invoice domains don't exercise:
a single `redact_document` tool that reads the **whole** selected document (the same `readDocumentChunks`
reach over the frozen scope), masks the personal data it can detect, and produces the redacted text +
per-category counts — which the seam writes to a **user-chosen file** (the same confirm-gated `export-file`
boundary as the CSVs). It has **no content-class data table and no `BEGIN…COMMIT`**: the deliverable is a
file, not rows, so `services/skills/run.ts`'s `runDocumentRedaction` records only the `skill_runs` lifecycle
row (started → terminal; `result_ref` stays **NULL**) and surfaces only `totalRedactions` (a count) + a
content-free `resultKind` (`'redacted'` when something was masked, else `'clean'`, handled in the renderer
like `validate`'s discriminator). Detection (`services/skills/tools/redaction.ts`) is **deterministic,
offline, regex-only** — e-mail, URL, IBAN, date (validated via the shared `parseDate`), phone — applied in a
**fixed order so masks never overlap** (`email → url → iban → date → phone`; e.g. dates are masked before
phones so a dotted date can't be eaten by a 0-leading phone shape), each match replaced by a fixed category
token so redaction is **idempotent**. It is the privacy-aligned skill and the **strongest** content boundary
of the three: the detected values never reach any log/audit/`skill_runs` row, and the redacted text lands
**only** in the user-chosen file. Honesty posture (recorded in [`known-limitations.md`](known-limitations.md)):
regex redaction is **best-effort, not a guarantee** — there is no ML and no name detection, so it
deliberately misses anything without a recognisable pattern and prefers a false negative over corrupting
text; the SKILL.md body + the "done" copy tell the user to review the copy before sharing, and the app never
implies "fully anonymized" or compliance. The dispatch (`tool-runs.ts`) wires the one name (null without the
MAIN-side `saveTextFile`); the controller / IPC / renderer stay domain-free (the renderer adds only the tool
label + the redaction `resultKind` copy).

### §9 The run trigger + UI (S11b/S11c)

A run is started from a **user action**, never the model. A generic controller
`services/skills/run-controller.ts` owns the single active run's lifecycle (state/progress/cancel,
one-at-a-time) and knows nothing about banks; the bank seam is handed in as an opaque runner by the
dispatch `services/skills/tool-runs.ts` (the one place allowed to map a tool name to `run.ts` — §13).
Four generic `skills:*` IPC channels (`listRunnableTools` / `startSkillRun` / `getSkillRun` /
`cancelSkillRun`) wrap it: all `requireUnlocked`, the document scope resolved **main-side** (§22-C4),
the run returning **ids/counts only** (`SkillRunState` = state/progress/counts, never the rows). The
renderer's calm `SkillRunBar` (a `lib/skillruns.ts` polling store — no new event channel) shows the
offer, the busy row ("Running: `<tool>` on `<N>` documents… Cancel"), and the result; write/export tools
are gated by a `ConfirmDialog` before the run starts. The renderer maps each tool to its done copy and
renders `validate_statement_balances` from a content-free `resultKind` discriminator ('reconciled' |
'unreconciled' | 'unchecked') — the controller/IPC stay bank-free (the discriminator is an opaque
string; the bank meaning lives only in the renderer's copy map).

### §10 Data model (additive `db.ts`)

`skills` (the registry index, keyed by `install_id`) + nullable `conversations.active_skill_id` /
`messages.skill_id` refs (S3). `skill_runs` (the run-history lifecycle — **ids/refs only**:
`document_ids_json` is ids, `result_ref` is a `bank_statements.id`, `error` is a friendly/technical
reason; S11a). The **content-class** bank tables `bank_statements` + `bank_transactions` (S11a) and
`bank_categories` / `bank_category_rules` / `bank_corrections` + `bank_transactions.category_id/
reconciled/confidence` (S11c) hold real figures: encrypted DB only, **never logged/audited, never
exported** (§9.5) — distinct from the non-secret skill packages. The **invoice** domain adds the
parallel content-class tables `invoices` (header + totals + a `totals_reconciled` flag) +
`invoice_line_items` (the line-item rows), with the same isolation; `skill_runs.result_ref` points at a
`bank_statements.id` **or** an `invoices.id`, never inline content.

### §11 IPC / audit surface

`skills:list/get/pick/preview/import/export/delete/enable/disable/acknowledgeWarning` +
`suggestSkills` + the four `skills:*` tool-run channels (§9), all `requireUnlocked` for DB-backed work
(the two in-memory controller channels `getSkillRun`/`cancelSkillRun` carry no content). Audit events
(the exact `AuditEventType` members): `skill_imported`/`skill_deleted`/`skill_enabled`/`skill_disabled`
+ `skill_run_started`/`skill_run_done`/`skill_run_failed`, all **ids/counts only**. (Selecting a skill
is a sticky-default DB write and is deliberately **not** audited — there is no `skill_selected` event;
the abandoned DS13 design that named one was never built.)

### §12 Trade-offs, residuals & the closing S12 audit

S12 ran the repo's multi-persona audit over the whole surface against the untrusted-skill-as-input
threat principle (§14). **No CRITICAL/HIGH.** One LOW was fixed (CSV spreadsheet formula-injection at the
export boundary), and the scattered S10/S11 sentinel tests were consolidated into a single
`skills-privacy-guard.test.ts` that drives one secret through every sink (import error, loader, all five
tool runs, the CSV export, the IPC `SkillRunState`) **plus a console spy**. Accepted LOW residuals
(documented in [`known-limitations.md`](known-limitations.md)): prompt text-injection is contained by the
**structural ceiling**, not by escaping the fence delimiter; a user skill's `triggers.filenamePatterns`
compile to a bounded RegExp run only on a user action (and, post-S12, the entry length/count are capped
at parse time + the selector refuses a wildcard-heavy glob — see §13 S2). **Deferred:** S13 auto-fire
(gated on an evaluation harness); native model tool-calling (stays a future option behind the same gate);
the app-skill integrity residual (by location, not signature — same as the engine binary, §22-M2).
**History:** the wave shipped S2–S12 (2026-06-17); the original plans: `git show <S12^>:docs/skills-plan.md`
and `git show <S12^>:docs/skills-s11-plan.md`.

### §13 Post-S12 audit follow-ups (2026-06-17)

A second multi-persona audit after the wave closed found **no CRITICAL/HIGH**; the fixes below landed
behind the unchanged §14 ceiling (no new capability, still offline, audit still ids/counts-only):

- **B1/B2 — cancel vs. outcome (run controller).** The seam is now the single authority on a run's
  terminal status: a non-ok outcome carries an explicit `cancelled` flag (a dismissed CSV save dialog
  is a **cancel**, not a failure), and a successful outcome is reported `done` even if Cancel landed
  late (the work persisted — never reported "cancelled, nothing changed"). `runCsvExport` re-checks the
  abort **before** the FS-write, so nothing is written under a cancel. `SkillRunController.finish`
  reads `outcome.cancelled` (falling back to `signal.aborted` only when a runner threw).
- **I1/I2 — localized failure copy.** The run seams return a content-free reason **code**
  (`errorCode`: `unavailable` | `needsExtraction` | `persistFailed` | `exportWriteFailed`) and the
  import preview returns parallel `errorCodes`; the renderer maps both to EN/DE copy, so a German user
  never sees an English failure/import string. The seam/controller stay i18n-free (codes are
  content-free tokens, like `resultKind`). EN/DE parity is **compile-enforced** (`de: Record<keyof
  typeof en, string>`).
- **S1 — content-free preview notes.** The clamp/`manifest.json`-conflict **notes** no longer echo the
  raw (attacker-supplied) frontmatter value — only the fixed field name — closing the one §22-M1 gap
  where attacker text could ride the `SkillPreview` IPC payload into the UI (notes share the path with
  the already-clean structural errors).
- **S2 — ReDoS guard on `filenamePatterns`.** Two layers: the parser caps each trigger entry's length
  (≤200) and count (≤64), and `selector.globToRegExp` refuses a glob with >10 `*` wildcards (treated as
  a non-match) so a `*a*a…`-style pattern can never hang the synchronous main-side scoring.
- **B3 — `summarize_cashflow` self-consistency.** `net` is derived from the rounded `totalIn`/`totalOut`
  so the three reported figures always satisfy `net === totalIn − totalOut`.
- **B4 — no stranded `started` run.** `runBankExtraction` and `prepareStatementRun` now wrap everything
  after the `skill_runs` 'started' insert in a guard, so an unexpected throw (e.g. a transiently locked
  DB while building the chunk reader) still drives a terminal `failed` status instead of leaving the run
  row at `started` forever. The downstream `runCashflowSummary` is the one seam with no surrounding
  transaction (it persists no figures), so its terminal `finishRun('done')` is itself wrapped in a
  guard that falls back to `persistFailure` — closing the last path that could strand the row at
  `started`.
- **CSV leading-whitespace formula injection.** `CSV_FORMULA_LEAD` now also neutralizes a formula
  trigger that hides behind leading whitespace (`"  =cmd"`) — some importers trim before evaluating —
  in addition to the leading-control-char and bare-`= + - @` cases.
- **Reconcile one-active-per-id (DS12 safety net).** `reconcileSkills` collapses the rare case where two
  AVAILABLE rows of one declared id end up both enabled (a DB rebuild, or an app skill shipped after a
  same-id user skill was enabled): it keeps the highest-precedence one (trust app > user → version →
  recency) and disables the rest. The enable IPC + import already enforced this on their paths; reconcile
  was the gap.

### §14 Content-reach + compatibility audit fixes (2026-06-17b)

A follow-up audit (bugs + docs-vs-code) found one HIGH and the MEDIUMs below; all fixed behind the
unchanged §7 ceiling (no new capability, still offline, audit still ids/counts-only).

- **H1 — the content-reading tools read VERBATIM segments, not retrieval chunks (the fix that makes
  Tier-2 actually work).** `extract_transactions` / `extract_invoice` / `redact_document` reach document
  text through `SkillToolContext.readDocumentChunks`. That had been backed by the stored `chunks` table —
  but those are **retrieval windows**: the chunker collapses every newline to a space (`atomize`→space-join)
  and overlaps consecutive windows by ~80 tokens. So the **line-oriented** bank/invoice extractors saw one
  giant "line" (≈0 rows) and the redaction copy came out de-formatted with duplicated overlap regions — on
  ACTUALLY-ingested documents. (The unit/integration tests masked it by seeding a single chunk whose text
  carried real `\n`.) The fix: the IPC injects a `readDocumentSegments` capability (the same
  `extractDocumentPreview` the doc-tasks use — ordered, non-overlapping, newline-preserving parser
  segments, re-extracted from the stored copy), and the run seams build the tool's reader from it
  (`run.ts` `resolveDocumentReader`). The §7 ceiling is unchanged: the **seam**, not the tool, holds the
  FS/cipher capability (a closure), the reach stays frozen to the single in-scope id, and a failed
  re-extraction surfaces through the tool's own content-free "could not be read" path. The legacy
  chunk-table reader remains as the fallback for callers that don't inject the capability (the seam-level
  tests that seed `chunks` directly); the IPC always injects the verbatim one, and the tool-run IPC tests
  now seed a REAL stored `.txt` so they exercise the production path end-to-end.
- **M1 — the §6.5 `minAppVersion` gate is now ENFORCED (was parsed-but-ignored).** A pure shared
  `skillNeedsNewerApp(minAppVersion, appVersion)` (`shared/skill-manifest.ts`) drives it. An app skill that
  needs a newer app reconciles in DISABLED (not auto-enabled); an import installs it disabled; the enable
  IPC refuses it (`main.skills.incompatible`); `SkillInfo` gains `incompatible` + `minAppVersion`, and the
  Skills tab shows a "Needs newer app" badge with the toggle disabled. The app version is threaded from
  `app.getVersion()` through the registry + installer deps + IPC. (Originally a residual remained: a skill
  edited on disk to need a newer app *while already enabled* stayed effective, because reconcile preserves
  the `enabled` flag and the use-sites gated only on `enabled`. **§15 closed it** — the gate is now airtight:
  the use-sites gate on *compatibility*, not just `enabled`.)
- **M2 — the Tier-2 "active tools" note is domain-free.** `skills.tool.note.active` no longer enumerates
  bank tools (it had shown bank copy for the invoice + redaction skills too); it now reads "run approved
  local tools on a document you choose…", true for every `kind:'tool'` skill.
- **M3 — the terminal-run acknowledge handshake is wired.** A new `skills:clearToolRun` IPC + preload
  method lets the renderer's `acknowledgeSkillRun()` release the controller's terminal run main-side
  (`SkillRunController.clear` was previously dead code; the comment promising the handshake is now true).

### §15 LOW / residual follow-ups (2026-06-17c)

The four remaining LOW/residual items after the §14 audit, all fixed behind the unchanged §7 ceiling
(no new capability, still offline, audit still ids/counts-only; EN/DE parity still compile-enforced):

- **Docs — user-facing Skills coverage.** [`user-guide.md`](user-guide.md) gained a **§8 "Skills"**
  section (the composer picker, the per-message glyph, the one-tap suggestion, tool skills + the run
  bar + confirm/cancel, and Settings → Skills: import/enable/delete, drop-ins install disabled, the
  "Needs newer app" badge), and [`troubleshooting.md`](troubleshooting.md) gained four entries
  (drop-in installs disabled DS19; the structural import-rejection reasons; the "Needs newer app"
  badge §14/M1; and "the skill tool found nothing in my document" — read-step-first / OCR / conservative
  parsing). Docs-only.
- **`reconcileBalances` over-reporting (honesty).** The lone **baseline** row (the first row, or any
  row whose predecessor printed no balance) is now `unknown`, not `ok` — it has nothing to compare
  against, so it is not a genuine check. `reconciled` is true only when no row mismatched **and at
  least one row was actually compared against a predecessor** (`okCount > 0`). A single-transaction
  statement therefore reports `reconciled: false` / `resultKind: 'unchecked'` (it verified nothing)
  instead of a false "reconciled". `validate_statement_balances`' downstream `resultKind` was already
  keyed off `unknown`, so it flowed through unchanged; the baseline row now persists `reconciled =
  NULL` (unchecked) rather than `1`. The invoice path (`validateInvoiceTotals`) has **no** baseline
  concept — each of its three checks is a genuine figure-to-figure comparison — so it needed no change.
- **Cancel-during-run audit consistency.** When the abort signal has fired, the gate
  (`tool-registry.ts`) now **suppresses** the `skill_run_failed` audit event (a cancelled run audits
  as started-then-no-terminal-event), so the audit agrees with the `skill_runs` row the seam records
  as `cancelled` — the audit surface has no `skill_run_cancelled` event (it stays ids/counts-only,
  §11). A genuine non-cancel `!ok` still audits `skill_run_failed` unchanged.
- **minAppVersion gate made airtight (the §14/M1 residual).** The use-sites now gate on
  **compatibility**, not just `enabled`, reusing the shared `skillNeedsNewerApp` helper
  (`shared/skill-manifest.ts`). The app version (already threaded via `app.getVersion()` in §14) is
  carried into `resolveTurnSkill` (`turn.ts`, via `TurnSkillDeps.appVersion` + the registry handle's
  new `appVersion` field), `suggestSkillsForTurn` (`suggest.ts`), and `runnableToolNames` /
  `runnableToolsForSkill` (`tool-runs.ts`, threaded from the IPC's `appVersion` at both the
  `listRunnableTools` and `startSkillRun` sites). So a skill edited on disk to need a newer app while
  already enabled is **skipped at turn-resolution, never suggested, and refused at run start** — even
  with a stale `enabled` flag. The threading is tolerant by default (absent / '' ⇒ compatible), so the
  seam-level/test callers are unaffected.

### §16 Per-locale skill display localization (2026-06-17d)

Skill **content** (title/description/body) was English-only — the UI chrome is fully i18n'd, but the
manifest carried a single `title`/`description`, so a German UI showed English skill names in the
composer picker, the per-message glyph, and the Settings → Skills cards/detail. Fixed for the **display
metadata** (the chosen scope; the guidance **body** stays single-language — the model is multilingual
and still answers in German, D-L6):

- **Additive manifest block.** `SKILL.md` may carry a `localized:` map (locale → `{title?, description?}`),
  parsed in `shared/skill-manifest.ts` (lenient like `triggers`/`language`: a malformed/blank/over-long/
  multi-line entry is **noted and skipped**, never an error; locale keys are lower-cased and bounded; at
  most `MAX_LOCALIZED_LOCALES` = 16). It rides the existing additive-schema posture (§2) and the
  `manifest_json` cache round-trips it. `SkillManifest.localized` + `SkillInfo.localized` are both optional.
- **Projection.** `installer.ts` `recordToInfo` copies `manifest.localized` into `SkillInfo` so the
  renderer (which alone knows the resolved UI language via `useT().lang`) picks the entry; the main side
  stays locale-agnostic.
- **Renderer pick (display only).** A tiny pure helper `renderer/lib/skillI18n.ts`
  (`localizedSkillTitle`/`localizedSkillDescription` + a `skillTitleResolver` for the glyph) is used by
  the composer **`SkillPicker`** (trigger label, suggestion offer, each row), the **Settings → Skills**
  cards + detail modal, and the per-message **glyph** in `Transcript` (an installId→localized-title
  resolver threaded from `ChatScreen`, built from the full skills list so a now-disabled stamped skill
  still localizes, with a stamped-title fallback). Every pick falls back to the canonical text.
- **Bundled skills.** All four app skills (`bank-statement`, `invoice`, `document-redaction`,
  `meeting-protocol`) gained a `localized.de` title + description. (The triggers were already bilingual,
  which is why German questions already fired the suggestion — only the visible text was English.)

Display-only by design: nothing here threads locale into `resolveTurnSkill`/the prompt, so the gate +
ceiling are unchanged and the injected body is byte-identical regardless of UI language.

### §17 Active-skill turn-latency: measured root cause + the prefix-cache fix (2026-06-17e)

A regression report — "chat with a skill active feels noticeably slower than with no skill" — was
**measured before being theorized** (a temporary, content-free perf harness over the real bundled
SKILL.md files + synthetic bodies up to the 64 KB cap; deleted after measuring, §22-M1: ids/counts/
durations only). The numbers localized the cost and refuted the "main-side prompt assembly is slow"
guess:

- **Main side is negligible for the shipped skills.** The full per-turn `resolveTurnSkill` path —
  disk read + YAML parse + validate (`loadSkillPackage`) plus fence assembly + the paragraph-growth
  sizing loop (`buildSkillFence`) — measured **< 1 ms/turn** for a ~1.5 KB bundled skill (`load`
  ≈ 0.65 ms, `fence` ≈ 0.06 ms) on an OS-cached SSD. **Not** perceptible.
- **The injected body is the driver, and it's a *prefill* cost.** The bundled skills inject a
  **measured 288–381-token** body (≈ 447 tokens including the BEGIN/END framing + guard line); the
  system prompt grows from ~94 to ~541 tokens. That delta is paid in **prefill**, whose wall-clock is
  hardware-bound: derived from the measured token count, ~290–450 tokens is sub-100 ms on GPU
  (~3 k tok/s) but **~3.5–15 s on a laptop CPU** (~30–80 tok/s) — which fully explains a "noticeably
  slower" feel and why the effect differs CPU vs GPU.
- **Whether that prefill is one-time or per-turn is governed by KV-cache prefix reuse — and the app
  was leaving it to the server default.** Plain chat brackets the fence in the **stable system
  prefix** (§5), so it *should* be prefilled once and then reused; grounded rides the fence in the
  **per-turn user turn** with the varying excerpts (§5/§22-H2), so its +447 tokens are genuinely
  re-prefilled every turn by design. The chat request sent **no `cache_prompt`**, relying on
  llama-server's default (which has flipped across releases) — so plain chat's "prefill once" was not
  guaranteed, and any prefix shift (toggling the skill, a large user skill whose fence trims to a
  question-dependent budget, or history dropping under context pressure) forces a **full re-prefill**.

**Decisions / fixes as built** (both behind the unchanged §7 ceiling — no new capability, fully
offline, audit still ids/counts-only; no i18n surface touched):

- **PERF-1 — `cache_prompt: true` is now explicit** (`runtime/llama.ts` `chatStream`). The KV slot
  reuses the longest common token prefix instead of re-prefilling the whole prompt, set explicitly
  rather than inherited from a release-dependent default. With the stable plain-chat system prefix
  this makes the fence a **one-time** prefill (toggle-on cost), not per-turn. Loopback-only compute
  hint, no telemetry. Asserted in `llama-runtime.test.ts`.
- **PERF-2 — the per-turn load is cached** (`skills/loader.ts` `loadSkillPackage`). `resolveTurnSkill`
  hit disk + re-ran the YAML parse/validate **every turn**; the result only changes when SKILL.md
  changes, so it is now cached keyed by the file's **(mtime, size)** (+ the `maxBodyChars` limit).
  Measured **~33 µs** cache hit vs **~650 µs** uncached (~20×) on SSD — and the win is far larger on
  the **portable drive** HilbertRaum targets, where a per-turn read dominates, and for a large user
  skill that re-parses + re-sizes (the sizing loop is O(paragraphs²): measured **~19 ms** at the
  64 KB cap). DS1/DS2 honoured — an on-disk edit (mtime/size change) re-parses on the next turn — and
  the **reconcile/installer paths call `parseSkillManifestFromDir` directly**, bypassing the cache, so
  disk→DB reconciliation always reads fresh. Content-class clean (in-memory parsed result only).
  Covered by `skills-loader-cache.test.ts`.

**(a) — IMPLEMENTED in Wave P3 (RT-2, 2026-06-18).** The grounded answer's **stable grounding rules +
preface** now ride in a cacheable system prompt (`GROUNDED_SYSTEM_PROMPT` = `BASE_SYSTEM_PROMPT` + the
rules) instead of the per-turn user message, so `cache_prompt`'s prefix reuse no longer stops at
`BASE_SYSTEM_PROMPT` and re-prefills them every documents turn (the prior user turn is replayed as the
RAW question, so the grounded prefix never matched). The per-turn user message keeps only the question
+ excerpts. **The skill fence still rides in the user turn deliberately** — it is untrusted reference
text and must never read as a top-level rule (§22-H2), so this is the grounding-RULES move, not a fence
move; the excerpts themselves are inherently per-turn and still re-prefill. ~58 approx tokens of rules
now sit in the always-reused prefix; precedence is unchanged/strengthened (rules in `system` ≥ user,
still outrank the fence) and the `[Sn]` + no-context contracts are untouched. See "Performance — design
record … Wave P3" (RT-2).

**Recommended, not implemented** (deliberately out of scope, recorded so the trade-off is visible):
(b) for a **large user skill near the budget**, the plain-chat fence trim depends on the current
question's length (`buildTurnFence` subtracts the live final-turn tokens), so the system prefix can
shift turn-to-turn and defeat PERF-1 — sizing the fence against a *fixed* user-turn reserve would keep
it byte-stable, but it is a no-op for every shipped skill (none trim) and was left for a follow-up to
avoid changing the §22-A6 budget contract (RT-9, still open).

### §18 Auto-fire triggers (S13 — gated on an evaluation harness, 2026-06-17)

S13 closes the one remaining skills *feature*: **auto-fire** — the app applying the right skill to a
turn the user left *without* one, saving the tap. It is the opt-in extension of the §6 suggestion
scorer, and it shipped in three gated sub-phases. The full original working paper (`docs/skills-s13-plan.md`,
deleted at S13 close — text in git history) holds the baseline tables; this is the design as built.

**The gate (S13a — harness + corpus + baseline).** Auto-fire ships only after an **offline,
deterministic** harness proves a precision bar on a labelled corpus — a false fire (shaping an answer
the user didn't ask for) is the costly event; a miss just falls back to the tap-offer. A synthetic,
no-user-data corpus of 33 labelled turns (`tests/fixtures/skill-triggers/corpus.json`) is scored
through the **real** `scoreSkillTriggers`/`selectSuggestion` (`tests/eval/skill-triggers.ts` +
`.test.ts`) reporting precision/recall + a confusion matrix — no model, no network, no DB (DS4). The
question is content: scored, never logged (a privacy guard extends the S12 sentinel posture).

**The ratified contract (owner, 2026-06-17 — D1–D6).** D1 **≥ 95% precision**. D2 **`threshold-3`** —
fire only when a keyword hit is corroborated by ≥ 1 doc signal (a separate `AUTOFIRE_SCORE_THRESHOLD = 3`,
distinct from `SUGGEST_SCORE_THRESHOLD = 2`; a lone keyword = 2, a lone doc signal ≤ 2, so the gate
structurally means "the user asked **and** a relevant doc is present"). D3 **silent apply + the
existing glyph + a one-click undo** (never a confirm-before-firing dialog). D4 **opt-in, app-skills
only in v1**. D5 **fire only when the turn has no skill set** (never override a sticky default or a
per-turn pick/clear). D6 additive **`triggers.autoFire?: boolean`** (only `true` opts a skill in). On
the §3.3.1 baseline threshold-3 clears 100% / 88.2% recall; the harness asserts the owner-set form
**`fired-wrong == 0` AND `precision ≥ 0.95`** so it survives corpus growth.

**The mechanics (S13b).** `triggers.autoFire?: boolean` is additive + lenient in
`shared/skill-manifest.ts` (only boolean `true` opts in; absent/false leaves `manifest_json`
byte-unchanged). `services/skills/autofire.ts` `resolveAutoFireSkill(db, deps, conversationId,
question)`: candidates = **enabled + available + app-only (D4) + `triggers.autoFire === true` (D6) +
compatible (§6.5/M1)**, scored via the existing scorer over the **factored-out** `scope-signals.ts`
`inScopeDocSignals` (shared with `suggest.ts`, no duplication), gated at `AUTOFIRE_SCORE_THRESHOLD`.
It reads the **`skillsAutoFireEnabled`** opt-in first and is a true no-op when off; it **logs nothing**
(the question is content). It is plugged into the single resolution path `resolveTurnSkill`
(`services/skills/turn.ts`) **only** in the would-return-null branch AND only when no per-turn pick was
made (`requestedInstallId === undefined`) — both chat channels (`registerChatIpc` / `registerRagIpc`)
pass the turn text, so a documents conversation auto-fires too.

**The surprise-mitigation UX (S13c).** Two surfaces, both EN/DE:

- **The opt-in toggle (D4).** A Switch in **Settings → Skills** (`SkillsTab.tsx`) reads/writes
  `skillsAutoFireEnabled` through the shared `updateSettings` patch path, **off by default**, hidden
  until the setting loads (never implies an unconfirmed state). This is the **only** control that
  makes S13b reachable — until it ships, auto-fire cannot be enabled by a user.
- **The per-turn undo (D3).** An auto-fired turn stamps an **additive, nullable `messages.auto_fired`
  column** — set only when the auto-fire path placed the skill AND the fence was actually placed (the
  §22-A5 stamp-only-when-fenced precedent), so it lines up 1:1 with the glyph and a **deleted** skill
  drops glyph + undo together. Carried via an additive `TurnSkill.autoFired` + `Message.autoFired` (a
  boolean — never content; the simpler "undo on every skill turn" alternative was rejected as it would
  surface the undo on explicit picks too, contradicting D3). The `Transcript` glyph on an auto-fired
  turn reads **"Answered with `<skill>`"** + a one-click **"answer without it"** on the *last*
  assistant turn; tapping it re-runs the **same** user question with the skill **explicitly cleared
  (`skillInstallId: null`)** — the explicit per-turn clear both stamps no skill and suppresses a
  re-auto-fire. It reuses the regenerate path in **both** modes; `askDocuments` gained a symmetric
  `regenerate` argument (drop the last assistant turn, re-use the existing last user turn — never a
  duplicate user row).

**Safe-merge property.** With `skillsAutoFireEnabled` **default-false**, a fresh install behaves
**identically** to pre-S13 regardless of which skills opt in — auto-fire only activates once a user
turns it on (S13c). The §14 ceilings + the S12 sentinel guard are unchanged: a wrong fire is at worst
a worse answer + a one-click undo, never an unauthorized action; the undo is a re-run, not a new
capability; no auto-fire path adds an audit event or logs the question.

**First opted-in product skill (D6).** `document-redaction` declares `triggers.autoFire: true` (the
only bundled skill to do so). Once a user enables auto-fire, an "anonymize/redact"-style turn over a
selected pdf/plain/markdown document auto-applies it: keyword (2) + the in-scope-doc MIME signal (1) =
3, clearing `AUTOFIRE_SCORE_THRESHOLD`. It is proven at 100% precision on the S13a corpus (the
`threshold-3` gate). A "selected" document is one in the conversation's persisted scope, so
`inScopeDocSignals` surfaces its MIME main-side (§22-C4) — the same phrase with no document in scope
scores 2 and does **not** fire (regression-tested in `skills-autofire.test.ts`).

### §19 Full-document analysis for tool skills (2026-06-19, D44–D49)

**The bug this closes.** A `kind:tool` skill ships deterministic whole-document tools (the §7/§8
gate), but when a user just *asked* about a document in chat the turn took the ordinary top-k RAG path
(`generateGroundedAnswer`) with the SKILL.md body as a fenced reference — answering from ~5 retrieved
passages, not the whole document. For accounting (the bank-statement test case) a partial read means
wrong totals; the coverage badge correctly said "based on the most relevant passages," but the
*analysis* was still partial. (Folded from `docs/full-doc-skills-plan.md`, deleted at this phase; full
text in git history. Coverage half cross-linked from [`rag-design.md`](rag-design.md) §14.7.)

**Decisions (locked with the user 2026-06-19, continuing the global series after D38–D43):**

- **D44** — the fix is a **general `kind:tool` mechanism**, not a bank-only patch: the bug is a class
  (any tool skill's correctness guarantees are bypassed on the chat path). Bank-statement is the first
  adopter + the test case; invoice the second.
- **D45** — when a doc can't be analysed exhaustively (any in-scope doc not fully chunked), **refuse the
  partial answer** with a fixed, localized message pointing at the existing Documents → Re-index
  affordance — no model call, no partial answer (honesty posture §22-D1). A silent partial accounting
  answer is worse than a clear "not yet."
- **D46** — a plain chat question **auto-runs the skill's READ-ONLY tools** (export stays
  confirm-gated). Read-only, deterministic, no side effects — a question should give exhaustive results
  without an extra click. This narrows the "tools run only when the user starts them" contract to
  **read-only** tools.
- **D47** — the answer is **synthesised from the structured tool output** (the compact extracted table),
  never by prompt-stuffing every chunk: the structured result fits context trivially; top-k RAG exists
  *because* raw documents overflow it.
- **D48** — coverage stops being **hardcoded** `relevance`: a real `CoverageInfo` is persisted per
  message and the renderer shows the truth. Requirement "if we analysed the full document, show that"
  is inexpressible until the meter is data-driven.
- **D49** — adoption is **per-skill**: `bank-statement` + `invoice` both register an analysis handler;
  `document-redaction` does **not** register an *exhaustive* handler (it is an action skill — it
  redacts a document — not an analysis-question skill, so a plain question is never force-routed
  through a whole-document tool run).
  - **D49a (amended 2026-06-22).** `document-redaction` now registers a **`routing` handler** instead
    of nothing. The original "keep the relevance path" choice produced two real defects on an
    "anonymize this" turn: the model wrote a **lecture/refusal** (reciting the SKILL.md caveats —
    "you never run it yourself", everything it won't catch — and inventing a manual procedure)
    instead of pointing at the one-click run affordance, and it even **speculated about the
    document's content** from top-k passages; and the coverage badge read **"based on the most
    relevant passages, NOT the whole document"** — misleading, since the tool reads the *whole*
    document. The handler gains a `mode: 'exhaustive' | 'routing'` discriminator (default
    `exhaustive`). A `routing` handler reads **no content**, runs **no tool**, emits **no audit
    event**: on a redaction-shaped request (`applies()` matches the action verbs + ≥1 in-scope doc)
    it returns a short, deterministic, localized answer naming the **same run button the SkillRunBar
    shows** (`chat.skill.tool.redactDocument`), with **no citations and no coverage** (the meter
    renders only for answers *with* citations — `Transcript.tsx` — so the misleading badge is gone).
    The chat path skips the D45 fully-chunked refusal for a `routing` handler (nothing is read). The
    SKILL.md body was rewritten so its **first paragraph** (the one the prompt builder guarantees to
    keep) is the action-routing instruction, with the honesty caveats demoted — fixing the fallback
    path when the model does answer (an off-topic turn). `SkillAnalysisResult.coverage` is now
    optional. The write tool stays **user-initiated + confirm-gated** — routing points at it, never
    runs it.

**The seam (`main/services/skills/analysis/`).** A small registry keyed by skill `install_id` →
`SkillAnalysisHandler` (`applies({question,scope,db}): boolean` + `run(ctx): Promise<SkillAnalysisResult>`),
following `tool-registry.ts`: **no import-time side effects**, app-owned, populated by an explicit
`registerBuiltinSkillAnalysisHandlers()` called once at app init (`main/index.ts`, before any
`register*Ipc`). `SkillAnalysisResult = { answer; citations; coverage }`. A handler's only content
reach is the **same run seam** the doc-action path uses (`run.ts` / `invoice-run.ts` over the faithful
`extractDocumentPreview` segment reader) — the §7/§14 ceiling is unchanged: it adds no new DB/FS/net
handle, and the export tier is excluded **by construction** (the CSV-export run fns are never
imported).

**Per-message coverage contract (D48).** `messages.coverage_json TEXT` (nullable, additive
`ensureColumn`; old rows = NULL); `Message.coverage?: CoverageInfo`; `appendMessage` serializes it
tolerantly (a stringify fault degrades to NULL, never blocks the append) and `rowToMessage` parses it
(NULL/malformed → undefined). The relevance path persists **no** coverage (stays NULL); the renderer
falls back to `{ mode:'relevance' }` so every pre-migration message and every non-re-routed turn
renders byte-identically (R5). The skill-analysis path stamps a real `{ mode:'extract', chunksCovered,
chunksTotal, fullyChunked }`, where `fullyChunked` gates the "whole document" meter wording.

**Chat routing + the refuse gate (in `registerRagIpc.askDocuments`).** After the turn skill resolves +
scope/filename auto-scope, and BEFORE the `routeQuestion`/`generateGroundedAnswer` decision, the turn
looks up `getSkillAnalysisHandler(skill.installId)` (the registry **is** the opt-in — a registered
handler implies `kind:tool`; no separate kind check). When `handler.applies(...)`:
`allInScopeDocsFullyChunked(db, scope)` reads `documents.fully_chunked` at **turn time** (R4, not a
cached flag) — not fully chunked ⇒ **refuse** (`skills.analysis.refusePartial`, NULL coverage, no
model call, skill stamped); fully chunked ⇒ `handler.run(ctx)` with a production context (the skills
audit adapter, the `extractDocumentPreview` reader, `tMain`, the chat slot's abort signal). Both
outcomes acquire the chat slot via `withChatStream` exactly as the coverage-extract branch (R3, the
single-locked-slot contract). When no handler is registered or `applies()` is false the whole block is
skipped and the relevance + coverage-extract paths run **byte-unchanged** (R5).

**Per-skill adoption.** Each handler's `applies()` is conservative: a single in-scope document (R2 —
multi-doc keeps relevance) **and** an analysis-shaped keyword set (EN+DE, substring-ambiguous tokens
avoided per §1's DS17 caution). `run()` auto-runs the read-only tools through the run seam for their
`skill_runs` lifecycle + ids/counts audit, then computes the answer's **figures from the persisted
rows** via the **pure** tool functions (the seams surface only counts). The answer is deterministic,
localized Markdown honouring the SKILL.md honesty posture (quote printed figures; surface flagged rows
**before** the headline; never invent), with real `[Sn]` source-chunk citations (M2-safe, never the
synthesised total).

- **`bank-statement`** (`analysis/bank-statement.ts`): `extract_transactions` →
  `summarize_cashflow` + `validate_statement_balances` (+ `categorize_transactions` only when the
  question is category-shaped). Leads with the count, surfaces unreconciled rows before the totals,
  reports mixed currency as "no single total." Citations narrow to the transactions' `source_page`.
- **`invoice`** (`analysis/invoice.ts`): `extract_invoice` → `validate_invoice_totals`. Surfaces any
  failed reconciliation check (line-items→net, net+tax→gross, tax-vs-rate) **before** the headline
  gross; prints only the figures the invoice states (a field that couldn't be parsed is left out).
  The invoice schema records no per-figure source page, so citations are the document's leading
  source chunks (still real chunks, M2-safe). i18n: `skills.invoiceAnalysis.*` (EN+DE parity), reusing
  the shared `coverage.extract.*` meter + `skills.analysis.refusePartial` refuse copy.

**Tests.** `skills-analysis-bank.test.ts` + `skills-analysis-invoice.test.ts` (handler-level:
`applies()` pre-flight, exhaustive math from rows, flagged check surfaced before the headline, figures
quoted not invented, export never auto-run, coverage `fullyChunked` true/false, real source citations);
`rag-skill-analysis.test.ts` + `rag-skill-analysis-invoice.test.ts` (IPC-level over the real
`askDocuments`: exhaustive path with `coverage.mode==='extract'` + no model call, refuse path, relevance
path byte-unchanged, single-locked-slot contract).

### §20 Skill-aware whole-document analysis for instruction skills (2026-06-22, Wave 2)

**The gap this closes.** §19 gave `kind:tool` skills a whole-document path, but the Tier-1
**instruction** skills (meeting minutes, contract brief, share-safe review, deadlines) still answered
from top-k relevance — because the SKILL.md fence is applied on **exactly one** engine, the relevance
`generateGroundedAnswer` path. Every whole-document engine (the §19 handlers, `coverage-extract`,
`tree-summary`) ignores the fence. So an instruction skill could be **whole-document OR
formatted-to-its-spec, never both** — worst case meeting minutes built from ~5 retrieved passages miss
decisions/action items, and "summarize meeting" could hijack to a generic tree-summary that ignores
the 8-section format. (Folded from `docs/skill-whole-doc-engine-plan.md`, deleted at this phase; full
text in git history. Continues the §19 audit recorded in BUILD_STATE 2026-06-22.)

**The engine (`grounded-whole-doc`).** A third `SkillAnalysisHandler` `mode` (after §19's `exhaustive`
and Wave 1's `routing`). Unlike `exhaustive` (deterministic, model-free, hardcoded TS) these stream a
**model** answer, so they do NOT use `run()` (it is now optional and omitted). Instead
`registerRagIpc` detects the mode and calls `generateGroundedAnswer({ wholeDocument: { documentId } })`:
the grounded context is the single in-scope document read **in order** (`retrieveWholeDocument`, not
top-k), capped to a whole-document token budget (`wholeDocumentBudgetTokens` = the real launched window
− answer reserve − system prompt − question − the skill-fence allowance), with the SKILL.md fence
riding in the grounded USER turn exactly as the relevance path. The persisted coverage is the honest
**`capped`** mode — `truncated:false` ⇒ "covers the whole document"; `truncated:true` ⇒ "covers the
beginning" (the meter wording already existed for the summary task). The §19 **fully-chunked refusal**
(D45) still gates the turn (a not-fully-chunked doc is refused, no model call). The relevance path is
byte-unchanged: coverage stays `undefined` ⇒ persisted NULL ⇒ the relevance badge.

**Per-skill adoption (single-document; `analysis/whole-doc-skills.ts`).** `meeting-protocol`,
`contract-brief`, `share-safe-review`, `deadline-obligation-finder` each register a handler whose
`applies()` matches an analysis-shaped keyword set (EN+DE) over a **single** in-scope document. Because
these skills are **explicitly selected**, the keyword sets include the bare domain nouns (e.g.
`contract`/`vertrag`) — `includes` can't span "summarize **this** contract", so the noun is the robust
trigger; an off-topic question or a multi-doc scope still keeps the relevance path. **`what-changed`** is
the 2-document sibling — see the compare record below (Follow-up B).

**Large documents — deep-index map-reduce (Follow-up A, Wave 3, 2026-06-22).** An over-budget document
no longer truncates to its beginning when a **ready deep-index tree** exists: `generateGroundedAnswer`
detects `retrieveWholeDocument`'s `truncated` flag and hands off to **`answerWholeDocFromTree`**
(`rag/whole-doc-tree.ts`), which runs the SAME map-reduce the tree summary uses
(`manager.summarizeFromTree`) over the precomputed node summaries — the **deepest layer** (`level 1` =
full leaf coverage) read via `nodeSummariesAtLevel` — with the **SKILL.md fence applied at every step**
(a skill-fenced MAP per `packIntoWindows` window when the summaries span >1 window, then a skill-fenced
streamed REDUCE; when they fit one window the single fenced reduce IS the step). It stamps the honest
**`tree`** coverage (`treeStatus:'ready'`, `chunksCovered = reachableLeafChunkIds`, `treeLevels`,
`truncated:false`) and cites the **leaf chunks** (`documentLeafProvenance`, M2-safe — node summaries are
never `[Sn]`). It returns **null** when there is no usable tree (no `ready` status / no node summaries),
so the turn falls back to the byte-unchanged Wave 2 capped/"covers the beginning" path; once a model
call has run it always returns a Message (the answer, or an empty one on Stop), so a cancel never
triggers a second capped pass. A document that **fits** the budget never enters this branch
(`truncated:false`) — the small-doc path is byte-identical to Wave 2. The §14 ceiling is unchanged: pure
DB tree/coverage reads + the chat runtime, no new DB/FS/net handle; the fence (with its guard line) keeps
bracketing the untrusted body in every step's USER turn, the app-authored system prompt outside it.
**Still open** for the tree path: a tree-backed compare (applying this map-reduce per oversized document
inside the 2-doc compare below) — today the compare reads both docs capped, not tree-reduced.

**2-document whole-doc compare (Follow-up B, Wave 3, 2026-06-22).** `what-changed` registers a
**`grounded-whole-doc-compare`** handler (`analysis/whole-doc-skills.ts`) whose `applies()` matches a
compare-shaped keyword set (EN+DE) over **exactly two** in-scope documents. `registerRagIpc` detects the
mode (after the same D45 fully-chunked refusal, which now gates **both** docs) and calls
`generateGroundedAnswer({ wholeDocumentCompare:{ documentIds } })`: **`retrieveCompareWholeDocuments`**
reads BOTH documents **in order** (not top-k), splitting the whole-document budget across them
**size-aware** (**`splitCompareBudget`**: each gets up to half; a smaller doc donates its unused half to
the larger, so two versions that jointly fit are both read whole — the common case — while two large
versions each get ~half). The two documents ride the grounded turn as **labelled blocks**
(**`buildCompareWholeDocPrompt`** — "Document 1 — …" / "Document 2 — …", so a same-titled version pair
stays distinguishable) with the SKILL.md fence; `[Sn]` labels run **continuously across both** so a
citation unambiguously names its version (M2). Coverage is honest **`capped`** — `truncated:true` when
**either** doc overflowed its share. The relevance path stays byte-unchanged for a 1- or 3-doc scope
(`applies()` false). The §14 ceiling + the fence/guard bracketing are unchanged.

**Tests.** `rag-whole-doc-tree.test.ts` (the tree map-reduce: single-level → one fenced reduce + `tree`
coverage + leaf citations + skill stamp; multi-level + small context → map-per-section then reduce with
the fence at EVERY step; no-ready-tree → null + no model call). `rag-whole-doc-compare.test.ts` (IPC: the
compare path streams a model answer with BOTH whole docs in one labelled turn + `capped` coverage +
cross-document citations; the refuse path when a doc isn't fully chunked; a single-doc scope keeps the
relevance path). `skills-analysis-whole-doc.test.ts` also pins the `what-changed` handler shape +
`applies()` (compare-shaped over exactly two docs) + `splitCompareBudget` + `retrieveCompareWholeDocuments`.
`skills-analysis-whole-doc.test.ts` (handler-level: `mode==='grounded-whole-doc'` + no
`run()`, `applies()` matrix EN+DE / off-topic / multi-doc / no-doc, registry wiring, and
`retrieveWholeDocument` order + truncation + always-keep-first-chunk); `rag-whole-doc-skill.test.ts`
(IPC-level over the real `askDocuments`: the model IS called with `coverage.mode==='capped'` +
the fence + the whole transcript in the user turn, the refuse path with no model call, and an off-topic
question keeping the relevance path with no `capped` coverage).

### §21 Geometry-aware PDF bank-statement extraction (Phase 31, 2026-06-23, D50–D58)

_Folded from `docs/pdf-geometry-extraction-plan.md` (deleted at the Stage-1 closeout per the
CLAUDE.md doc-lifecycle rule; the full working paper — every option, the Stage-2 design, the
corroborating research — is in git history via `git log --follow` on that path). In-code comments
cite the plan's anchors (`§3.1` row/column reconstruction, `§3.2` the non-breaking `parseDate`
guarantee, `§3.5` the completeness gate, `D50`–`D58`); read them against this record (the legend below
maps them). Branch `pdf-geometry-extraction`._

**The gap this closes.** A real user analysed a German HypoVereinsbank statement with
`app:bank-statement` and got **zero transactions**. Root cause was the PDF parser, not the regex
tools: `parsers/pdf.ts` calls `page.getTextContent()` — whose items carry `transform` (x/y) +
`width` — but keeps only `str`/`hasEOL` and concatenates in pdf.js *reading order*. A columnar
statement (date · description · amount, year in the page header) therefore arrives as scrambled
interleaved lines, so almost no row survives `parseLine` (which needs a full date token and the amount
on one line), and bare `DD.MM.` per-row dates with the year only in the header are rejected by
`parseDate`. The geometry needed to rebuild the columns was already fetched and thrown away.

**Decisions (the ones that bind as built).**
- **D50 — Hybrid, Node-native, no Python sidecar.** Deterministic geometry-first extraction; a
  constrained local-LLM only as a *future* verified fallback. We already ship `pdfjs-dist` and the
  coordinates are in the object we iterate — the gap is discarded data, not a missing ecosystem, so a
  second runtime (pdfplumber/camelot) would buy column clustering we write in ~100 lines of TS at the
  cost of bundle size / code-signing / a second binary to verify. **No new runtime dependency.**
- **D51 — A layout MODE of the existing parser, reached through the existing re-parse seam** — not a
  new standalone reader. A standalone reader taking "the original PDF path" cannot work in an encrypted
  workspace (no plaintext path; the bytes exist only as a transient `extractDocumentPreview` decrypts
  and shreds). Threading a `layout` flag through `ParseContext` → `PdfParser.parse()` reuses the
  decrypt/OCR/shred/page-cap machinery and keeps the R5 relevance path unchanged.
- **D52 — Stage 1 first; ship + measure; the LLM is gated.** Stage 2 (the constrained-LLM fallback)
  lands ONLY if Stage-1 deterministic recall on the local-only gold set proves below ~90%. Measure
  before building the expensive path. **Not yet closed** — see "Conditional future" below.
- **D53/D55 — (Stage 2, not built).** Any future LLM row must carry a verbatim `grounding_quote`
  verified against the source then balance-reconciled (drop-on-failure, never guess); it needs
  grammar-constrained decoding plumbed through the `llama-server` HTTP sidecar (a `json_schema`/GBNF
  request field the runtime seam does not expose today). Recorded for when D52 triggers it.
- **D54/D56 — Honesty + the completeness gate (the cardinal safety property).** Never present an
  invented total, nor a partial/mis-read total *dressed up as the statement total*. A confident WRONG
  total (17 of 20 rows presented AS the whole) is *worse* than today's empty result. The only true proof
  a total is whole is the printed **opening + Σamounts == closing**; capturing those statement-level
  balances was explicit Stage-1 scope (we did not store them before).
  - **D56-R (refinement, 2026-06-25) — three outcomes, not a boolean.** The original boolean gate
    refused a total whenever *either* balance was absent, which conflated two very different cases and
    wrongly refused a perfectly honest sum on a balance-less "Umsätze" listing (the reported bug).
    `assessCompleteness` now returns **`complete`** (printed opening+closing tie out → present the
    VERIFIED total), **`contradicted`** (a printed balance the rows refute — a per-row mismatch, or
    opening+Σ ≠ closing → keep the honest refusal: a suspect read must never surface a number), or
    **`unverified`** (NO opening/closing to tie against AND nothing contradicting → present the figures
    under an explicit caveat: *"a sum of the N rows I read, not a verified statement total"*). The
    cardinal property is preserved exactly — it forbids a number the user could mistake for THE
    statement total from coming out of an incomplete read; a clearly-labelled "sum of the rows shown"
    is not such a number. A bounded transaction listing now trails every non-empty answer so the user
    can SEE the rows that were read.
- **D57 — The gold set is LOCAL-ONLY / gitignored.** Real bank statements are user financial data
  (CLAUDE.md "never commit user data"); only aggregate metrics are committed, and every *test* fixture
  is synthetic (`makeColumnarPdf`), never a real statement or excerpt.
- **D58 — Layout mode is bank-statement ONLY.** The invoice skill is label/line-scan based, so
  column-reconstructed text could shift its line composition — adopt layout there (if ever) only behind
  its own measurement. Redaction/preview/translate/compare/ingest never set `layout`.

**Design as built (deterministic, offline, ZERO model calls).**
- **`ingestion/parsers/pdf-layout.ts`** — pure geometry reconstruction. `clusterRows` groups
  positioned words into visual rows by baseline y (tolerance band for jitter/superscripts), top-to-
  bottom, each row left-to-right. `resolvePageYear` resolves the page year (first fully-printed
  `DD.MM.YYYY`, else a header-band 4-digit token, else null → bare rows dropped unless the caller
  supplies a document-level fallback year). `reconstructLine` emits one clean `<DD.MM.YYYY> <desc>
  <amount> [<balance>]` per transaction row — the year resolved *during reconstruction* (§3.2: the
  token reaching the SHARED `parseDate` is already a full date, so `parseDate` — used by invoice +
  redaction — is **untouched by construction**). A row with no resolvable date / no amount / no
  description is dropped, never invented.
- **The booking-date COLUMN MODEL (`detectDatumColumn`/`inDatumColumn`, §3.1.3) — the precision fix
  (2026-06-23).** The gold-set measurement found Stage 1 OVER-extracting the Raiffeisen "Mein ELBA"
  statement (26 real rows → 43): its Valuta/value-date column prints on a SECOND baseline that aligns
  with a row's second description line, and that continuation hides a foreign-currency reference amount
  (`39,00 USD`); `reconstructLine` saw a date (the Valuta) + a money token (the FX) and emitted a
  spurious transaction. `detectDatumColumn` clusters every date-token x into bands and picks the
  **densest, leftmost** band (the booking column prints one date per row, so it is densest; density-
  first guards against a stray header/period date further left defining a phantom column). A row
  qualifies as a transaction ONLY when its lead date sits in that band; an out-of-column date (Valuta,
  or a mid-line label date) is dropped — and the non-transaction RAW fallback (`rowText`) also drops
  out-of-column dates so a Valuta line can't be re-extracted by the date-leading `parseLine`.
- **The BALANCE-LABEL GUARD (`isBalanceLabelLine`, `bank-statement.ts`) — the other half of the fix.**
  Raiffeisen prints opening/closing as `Kontostand per <date>` with the date IN the Datum column, so
  geometry alone can't reject it. `'kontostand per'` is added to BOTH `OPENING_LABELS` and
  `CLOSING_LABELS` (the existing "first opening / last closing" rule then reads opening `35.037,04`
  from the period-start line and closing `30.647,07` from the period-end line; "Aktueller Kontostand"
  deliberately excluded — it restates the closing at the top and would corrupt the opening), and
  `extractTransactionRows` SKIPS any balance-label line so a summary is never counted as a transaction
  (it is still read by `extractStatementBalances`). This stops the double-count that broke the tie.
- **The completeness gate (D56 + the D56-R refinement).** New `extractStatementBalances` (printed
  opening/closing, EN+DE labels incl. `balance brought/carried forward`, `opening/closing balance`,
  `Anfangs-/Endsaldo`, `Kontostand per`) feeds `assessCompleteness`, the three-outcome classifier
  (`complete` / `contradicted` / `unverified`); `isStatementComplete` is retained as its boolean
  `=== 'complete'` projection (the unit tests pin the gate by that name). Balances persist additively on
  `bank_statements` (`opening_balance`/`closing_balance`, REAL, nullable, content-class — never
  logged/audited/exported). `buildBankAnswer` renders each outcome: `complete` → VERIFIED total + the
  proven-whole `caveat`; `unverified` → the SAME single-currency totals + categories under
  `unverifiedCaveat` (a labelled sum of the rows read — the no-balance "Umsätze" case, the reported
  bug); `contradicted` → `skills.bankAnalysis.incompleteNoTotal` (the honest refusal). Mixed-currency
  reports no-single-total (safe) regardless of outcome. A bounded transaction listing
  (`transactionsHeading`/`transactionItem`/`transactionsMore`, first 10 + "ask to export CSV") trails
  every non-empty answer. All strings are EN+DE.
- **Wiring (D51/D58).** `readDocumentSegments(id, {layout})` → `extractDocumentPreview` (now accepting
  `layout` + the `maxPages` cap, a DoS guard since per-page clustering is uncapped otherwise) →
  `ParseContext.layout` → `PdfParser` layout mode (scan-detection re-keyed on RAW text so an empty
  reconstruction is never mistaken for an image-only scan). The bank analysis handler sets
  `layout:true`; every other caller is byte-unchanged. `getDocument` is called with `verbosity:0`
  (VerbosityLevel.ERRORS) so pdf.js's font-program WARNINGS — e.g. the `Warning: TT: undefined function:
  21` flood from a malformed embedded TrueType hint program — no longer spam the log; real errors still
  surface (a verbosity flag, offline-safe).

- **HVB "Umsätze" multi-baseline recovery (2026-06-25, the D56-R follow-up — `pdf-layout.ts`).** A real
  HVB online "Umsätze" export exposed three Stage-1 parsing failures the gold set's German statements did
  not: the payee/purpose prints on CONTINUATION baselines below the booking row, the per-row currency
  code `EUR` polluted the description, and a debit's sign sat in a separate cell so a Lastschrift read
  POSITIVE. Three deterministic, offline fixes (zero model calls):
  - **(A1) Multi-baseline row association.** `reconstructPage` is now stateful: a booking row OPENS a
    transaction; a following dateless, money-LESS text row is a CONTINUATION whose payee/purpose text is
    appended to that transaction's description (bounded by `MAX_CONTINUATION_ROWS`=4); the transaction
    flushes on the next booking row, an intervening non-continuation row, or page end. This is the
    deferred "multi-baseline association" the over-extraction boundary called for — payees survive instead
    of being orphaned onto dropped dateless rows.
  - **(A2) Currency-token class.** A standalone ISO code / symbol is its own token class (kept out of the
    description); `reconstructLine` re-emits ONE currency code AFTER the amount, where the line parser
    still detects it. This **also resolves the boundary-1 over-extraction**: a phantom `<date> EUR
    <balance>` running-balance row now has an EMPTY description → dropped, while a genuine row whose payee
    wrapped is rescued by A1. The §21 objection to a bare "drop a currency-only description" guard (it
    silently dropped 8 genuine wrapped rows) no longer applies — A1 is what makes A2 safe: the genuine
    row's payee continuation makes its description non-empty; the phantom's does not.
  - **(A3) Sign-column fold.** A standalone `+`/`-` or Soll/Haben `S`/`H` marker in the money column zone
    (`SIGN_ZONE_SLACK`) is folded into the amount's sign (`S`/`-` → debit/negative, `H`/`+` →
    credit/positive). Conservative by design: a dash FAR from the amount (a description dash) is dropped
    from the text but NEVER read as a sign, so it can't flip a total. **Caveat (D57):** the EXACT HVB sign
    encoding (separate cell vs a glued trailing minus pdf.js splits) must be confirmed on the real
    statement via the local gold-set harness; A3 handles the sign-column case without guessing at a
    mid-line dash. Until confirmed, an unusual sign layout still degrades to the honest gate
    (`contradicted` when balances are printed; an `unverified` labelled sum when they are not).

**Gold-set result (local-only corpus, D57; 2026-06-24, measured under the original boolean gate).** Three
text-layer statements — a sanitized HVB transactions-only excerpt, a full Raiffeisen "Mein ELBA"
statement, and an HVB "Umsätze" page — plus one image-only scan (below): micro recall **116.5% (99/85)** —
>100% because the HVB "Umsätze" page is OVER-extracted (next paragraph); macro recall **100%**;
figure-exact-match **100% (1/1 with printed balances)**; hallucinated / partial-total / model-calls all
**0**. Under the original gate, gate pass was **33% (1/3)** because the two balance-less statements
refused a total. **Under the D56-R refinement (2026-06-25) those two now present an `unverified` labelled
sum** instead of refusing — so the harness reports the same one VERIFIED total (Raiffeisen) plus two
`unverified` labelled sums, and the cardinal invariant is re-stated accordingly: no number is ever
presented *as the verified statement total* from an incomplete or mis-counted set. The corpus must be
re-measured locally (`HILBERTRAUM_PDF_GOLDSET=1`) to refresh these figures under the refined harness.

**Known Stage-1 boundaries (2026-06-24, boundary 1 substantially RESOLVED 2026-06-25) — all SAFE (no
wrong total is ever shown), residual fixes scoped:**
- **Per-row running-balance OVER-extraction — RESOLVED for the `<date> <CUR> <balance>` shape (A1+A2),
  2026-06-25.** Some statements (the HVB "Umsätze" export) print a separate running-balance row BETWEEN
  transactions shaped `<date> <CUR> <balance>` with the date in the booking-date column. Geometry rebuilt
  it, and because its only non-date/non-money token was the bare currency code, `parseLine` read that as
  the description and emitted a phantom transaction (14 real rows → 28). The **currency-token class (A2)**
  now keeps the bare `EUR` out of the description, so the phantom row's description is EMPTY → dropped,
  while a genuine row whose payee wrapped onto a continuation baseline is RESCUED by **multi-baseline
  association (A1)** (its description is non-empty). The earlier objection — that a naive "drop a
  currency-only description" guard silently dropped 8 genuine wrapped rows — is exactly what A1 fixes, so
  A2 is now safe. Pinned end-to-end through real pdf.js (`pdf-bank-layout.test.ts` case (i): phantom rows
  dropped, the genuine rows tie out → the gate now PRESENTS the verified total; case (j): payees recovered
  from continuation baselines). The 2026-06-24 geometry probe still holds — the balance and amount are
  right-aligned in ONE numeric column, so an x-band "money-column model" could NOT have separated them;
  the token-class + association fix did. **Residual (safe, gate-guarded):** a genuine NO-payee row whose
  booking line is a bare `<date> <CUR> <amount>` with no continuation below is indistinguishable from a
  phantom and is also dropped — a recall loss, never a wrong total (the gate downgrades). A statement that
  carries the running balance INLINE on the booking row (`<date> <desc> <amount> <balance>`) was never
  this boundary and is unaffected.
- **Image-only / "blacked-out" statements.** A user who blacks out or scans a statement can flatten it to
  a full-page IMAGE with no text layer. Stage 1 reads the text layer, so `PdfParser` raises the
  scan-detected error and nothing is extracted → the **safe** empty/downgrade (0 rows, no total, 0 model
  calls — a blacked statement never yields a confident wrong total). Recovering it is the **OCR path's**
  job (§ "Scanned-PDF / photo OCR"), out of Stage-1 scope (plan §7). The gold-set harness detects the
  scan throw, excludes such statements from the recall/gate aggregates, and **safety-asserts** the empty
  outcome instead.
- **Split-amount items (identified by the pre-merge audit, 2026-06-24; pinned by tests).** When a PDF
  producer renders one amount as TWO adjacent text items (e.g. `2.000` + `,00`, a kerning/positioning gap
  pdf.js surfaces as separate `TextItem`s), neither fragment classifies as money (`2.000` is text, `,00`
  is text; note `1.234` even back-classifies as a *date*), so the row carries no amount and is **dropped**
  — the real transaction silently vanishes (a recall loss). It is **safe in the original sense** when the
  statement prints opening/closing (the missing row breaks the `opening + Σ == closing` tie → `contradicted`
  → refusal, the pinned test path); on a balance-LESS statement, D56-R presents an `unverified` labelled
  sum that is silently UNDER-counted by the dropped row — honest per its caveat ("a sum of the rows I read"),
  but no longer a refusal (same D56-R tradeoff as boundary 1). The scoped fix is an **x-adjacency money re-merge** (merge
  neighbouring tokens whose concatenation parses as money and whose x-gap is sub-column), **deferred** with
  the money-column model. Pinned by `pdf-layout.test.ts` (the split drops the row; the same amount as one
  token reconstructs) + an end-to-end `pdf-bank-layout.test.ts` case (real pdf.js → safe downgrade). Two
  related tuning-constant boundaries are pinned alongside it: `clusterRows` anchors a row on its FIRST
  baseline (so >`DEFAULT_ROW_TOLERANCE`=3 pt of cumulative jitter splits a row and loses its amount), and a
  Datum/Valuta pair closer than `DEFAULT_COLUMN_GAP`=12 pt MERGES into one band (a Valuta date can then
  qualify a spurious row — same gate-safe over-extraction class as boundary 1).

**Conditional future — Stage 2 is NOT built, but is EXPECTED to be needed eventually.** It is not a
*planned next step* (it lands only on evidence, per D52), but the expectation is that it **probably will
be warranted** once the corpus broadens: today's gold set is still narrow (**three** text statements +
one image-only scan, D57), and real statement layouts vary wildly (no-printed-balance statements that the completeness gate can only
downgrade, ruled/borderless tables, multi-column or rotated layouts, OCR'd scans). Deterministic
geometry will almost certainly miss *some* of them, and those are exactly the residual hard subset
Stage 2 exists to cover. So treat Stage 2 as a **probable future need, gated — not abandoned**: it
lands only if D52's breadth evidence (more banks/layouts — Sparkasse/ING/DKB + invoices) shows Stage-1
deterministic recall below ~90% on a layout the completeness gate can't honestly downgrade. The
discipline is still measure-then-build (don't pay for the LLM path until a real layout proves Stage 1
insufficient) and its D55 prerequisite (grammar-constrained decoding plumbed through `llama-server`)
remains real work. Until then Stage 1 is the shipped extractor for the verified layouts; Stage 2
remains deferred + unapproved, but the recommendation is to expect it and re-run the gold-set harness on
a broader corpus to trigger it.

**Tests.** `tests/unit/pdf-layout.test.ts` (clustering, `toFullDate` year resolution proving
`parseDate` is untouched, `detectDatumColumn` density/leftmost/tie, out-of-column-date rejection,
value-date drop, balance-line preservation, fallback-year). `tests/integration/pdf-bank-layout.test.ts`
(SYNTHETIC columnar PDFs via `makeColumnarPdf`: text-mode loses every row while layout-mode recovers
them + the correct total + honest coverage + citations + 0 model calls; a non-tying balance MUST
downgrade; the Raiffeisen Valuta/second-baseline + `Kontostand per` regression pins the column model;
and the Phase-31 breadth set — English `Balance brought/carried forward` gate-pass, an English value-
date second baseline rejected, an English running-balance-only downgrade, a multi-line wrapped
description). **Adversarial geometry through real pdf.js (audit M3 CI-realism, 2026-06-24):** because
every fixture above encodes *ideal* geometry (one TextItem per cell, identical per-row baselines, wide
column gaps) a regression that only bites on a real, messy TextItem distribution could pass `npm test`;
a dedicated `pdf-bank-layout.test.ts` describe block now drives the messiness through the REAL pdf.js
path — sub-tolerance baseline jitter (still one row), over-tolerance jitter (amount splits off → row
dropped → gate downgrades), a tight (<12 pt) Datum/Valuta gap (columns merge → over-extraction → safe
downgrade), the shared-column running-balance shape of former boundary 1 (case (i): the phantom rows are
now DROPPED by A2 and the genuine rows tie out → the gate presents the verified total), and the HVB
"Umsätze" multi-baseline recovery (case (j): payees merged from continuation baselines, `EUR` stripped, a
Lastschrift signed negative → the honest `unverified` labelled sum). `pdf-layout.test.ts` adds the
`HVB multi-baseline recovery` block (currency strip, sign-column fold, the conservative far-dash
no-fold, association + phantom-drop). The local-only gold set remains the real-*distribution* gate; these
pin the documented boundaries + the recovery in CI. `tests/real-data/pdf-goldset.realdata.test.ts`
is the LOCAL-ONLY, gitignored, gated (`HILBERTRAUM_PDF_GOLDSET=1`) gold-set harness — aggregate metrics
only, 0 model calls, skipped in `npm test`.

### §-anchor legend (historical plan citations)

The wave's plan files were folded into this record (S2–S12 into §1–§12; **S13 into §18**) and
`security-model.md`, but in-code comments and the kept docs still cite the **original plans'** section
numbers (`skills plan §N`, `skills-s13-plan.md §N` / `§2.1` / `D1`–`D6`, `§22-*`). Those numbers were
never renumbered; this legend keeps them **resolvable** (the doc-lifecycle "stable anchors" intent)
without churning ~150 comments. Read a historical `§N` as:

| Historical anchor | Meaning | Now lives in |
|---|---|---|
| §9.2 | Import safe-extractor defences | §4 + security-model "Skill-import defences" |
| §9.3 | Collision / version / downgrade policy | §4 |
| §9.4 | Delete = app-level ref-clear sweep | §4 |
| §9.5 | Content-class data excluded from every export | §10 + security-model (Tier-2 ceiling) |
| §10 / §10.1–§10.4 | Selection, prompt placement, suggestion heuristic | §5 + §6 |
| §11 / §11.2 | Fenced-skill prompt integration | §5 |
| §12 / §12.1 / §12.2 | Tier-2 tool gate (schema, validate→run→validate, confirm) | §7 + security-model "Skill tool ceiling (Tier-2)" |
| §13 (plan) | Bank specifics kept out of the generic infra | §8 (note: §13 in THIS record is the post-S12 follow-ups above) |
| §14 | The untrusted-skill-as-input threat model + structural ceilings | §2 + §7 + §12; security-model "Skill tool ceiling" |
| §15 / §16 | Renderer surfaces / IPC surface | §9 + §11 |
| §18.x | Phase/sub-phase breakdown (historical) | this record's phase tags (S2–S12) |
| `skills-s13-plan.md` §2.1 / D1–D6 | Ratified auto-fire contract (precision bar, threshold-3, opt-in, app-only, no-override, schema) | §18 |
| `skills-s13-plan.md` §3 / §4 / §5 | Eval harness + corpus (S13a) / auto-fire mechanics (S13b) / surprise-mitigation UX (S13c) | §18 |
| §22-A1/A5/A6 | One skill-resolution path; stamp only when placed; fence pre-sized | §5 |
| §22-C2 | Selector reads triggers from the cache, never unpacks a blob | §6 |
| §22-C3/C4 | No FK into `skills` (app-level sweep); scope resolved main-side | §4 + §9 |
| §22-D1/D3 | Honesty posture (drop, don't invent); suggestion is an inert offer | §6 + §8 |
| §22-M1 | Content-class rule — ids/counts only; no content in log/audit/IPC | §2 (the consolidated sentinel guard) |
| §22-M2 | App-skill integrity by location, not signature (accepted residual) | §12 + security-model |
| §22-M4 | v1 permissions are a display summary; nothing executes | §1 (DS6) |
| `pdf-geometry-extraction-plan.md` §3.1 / §3.1.3 | Row/column reconstruction; the booking-date column model | §21 (`pdf-layout.ts`) |
| `pdf-geometry-extraction-plan.md` §3.2 | The non-breaking `parseDate` guarantee (year resolved in reconstruction) | §21 |
| `pdf-geometry-extraction-plan.md` §3.5 / D56 | The opening/closing-balance completeness gate (no partial totals) | §21 |
| `pdf-geometry-extraction-plan.md` D50–D58 | Stage-1 architecture decisions (geometry-first; Stage 2 conditional) | §21 |


### §22 Bank-statement LLM categorizer (Phase 33, 2026-06-25, D55/D26)

The deterministic Stage-1 extractor finally recovers real payees/descriptions (§21 multi-baseline
recovery), so there is usable text to **categorize**. Categorization is the FIRST place a local LLM
assigns meaning to bank data in this app — defensible under the honesty posture for one structural
reason: **a category is not a figure.** A mislabel only shifts the per-category breakdown; it never
moves the **verified statement total** or the **D56 completeness gate** (which read the signed amounts,
never the labels). So — unlike a future Stage-2 figure extraction (D53/D55 `grounding_quote`) — no
figure verification is needed. The constraints that DO hold:

- **Offline only.** A local llama.cpp sidecar, never a hosted API (CLAUDE.md §0).
- **Fixed set, grammar-constrained.** The reply is constrained to a `json_schema` whose category field
  is an **enum** of a fixed EN taxonomy (`CATEGORIZER_CATEGORIES`: Groceries/Dining/Transport/Utilities/
  Rent/Insurance/Subscriptions/Health/Shopping/Income/Transfer/Fees/Cash/Tax/Uncategorized) — the model
  cannot emit an off-list label (the D55 plumbing: `RuntimeChatOptions.responseSchema` →
  llama-server `response_format:{type:'json_schema',strict:true}`). DE glosses ride in the prompt only.
- **Drop-to-`Uncategorized`.** Any invalid / out-of-range / unparseable output drops to `Uncategorized`
  (a whole batch drops on a parse failure). Never an invented category. The mock runtime (which ignores
  `responseSchema`) exercises exactly this path in CI.
- **Model-OPTIONAL.** With no model loaded the module degrades to the deterministic rule pass
  (`categorizeRow`). Confident description-rule matches (Fees/Income/Transfer/Cash) are a PRE-FILTER that
  skips the model; the rest go to the model in batches of `CATEGORIZER_BATCH_SIZE` (=20).
- **Model-assisted label.** A breakdown is labelled model-assisted whenever a persisted category lies
  OUTSIDE the deterministic rule set (the honest, schema-free signal — a deterministic fallback writes
  only rule-set names, so it is never mislabelled). `categorizer.ts` + `analysis/bank-statement.ts`.

**Decisions as built:**
- **D26 — the categorizer is a `DocTaskManager` kind (`'categorize'`), NOT a model call on the skill-run
  seam.** The `ModelSlotArbiter` only mediates chat ↔ a *yielding* build; the chat↔task one-job-at-a-time
  exclusion (D26) lives in the `DocTaskManager` (chat checks `hasActiveTask()`, tasks check
  `isChatStreaming()`); the skill-run `SkillRunController` is a SEPARATE lane neither observes. A model
  call on `runCategorization` could let two `chatStream` calls hit the one llama-server at once. The
  doctask lane gives D26 exclusion + progress + cancel + `getRuntime()` for free. `'categorize'` is the
  one **model-OPTIONAL** kind (it skips `startDocTask`'s runtime gate; a null runtime ⇒ deterministic).
- **Button wiring — wrap the doctask in the skill-run shell.** The existing "Kategorisieren" button keeps
  its `SkillRunController` UX: the `categorize_transactions` runner ENQUEUES a `'categorize'` doctask and
  MIRRORS its progress/cancel into the run bar (`tool-runs.ts` `runCategorizeViaDocTask`). The real job —
  and the model call — runs in the doctask lane, so D26 holds; the shell is a thin status mirror.
- **Auto-extract (the (D) ordering fix).** `runCategorize` AUTO-EXTRACTS the statement first when none
  exists (the "categorize before extract" `needsExtraction` failure is gone). Persistence of
  `category_id` is atomic (BEGIN/COMMIT, no partial annotations survive); the categories are seeded by
  the SHARED `ensureBuiltinCategories` (now the union of the rule set + the LLM taxonomy).
- **Auto-offer after extraction (Q2).** A successful `extract_transactions` BUTTON run best-effort
  enqueues a `'categorize'` doctask in the background (D26-safe, model-optional) — categories are ready
  by the time the user asks. The chat analysis path is unaffected (it never goes through that runner).
- **Read-back stays 0-model-calls (Q3 routed feedback).** `analysis/bank-statement.ts` now REUSES the
  latest statement (re-extraction is deterministic, so it would only duplicate AND discard the doctask's
  persisted categories) and `categoryTotals` reads the PERSISTED category (LEFT JOIN `bank_categories`),
  else `categorizeRow`. The model call happens ONLY in the doctask. After a categorize run completes the
  renderer ROUTES the standard breakdown question into the transcript, so the model-assisted breakdown
  appears as a normal chat answer (`ChatScreen` → the analysis handler, still 0 model calls).

**Tests:** `skills-categorizer.test.ts` (taxonomy/enum, prefilter, model path, off-list/out-of-range
drop, unparseable-batch drop, batching, no-runtime fallback); `doctasks-categorize.test.ts` (model path
persists, deterministic fallback persists, auto-extract-then-categorize); `skills-analysis-bank.test.ts`
(persisted model categories surface + the model-assisted label; no duplicate statement on re-ask).


## Image understanding — design record (Phases V1–V5, §1–§10)

_Formerly `docs/image-understanding-plan.md` (folded in here at the Phase-V5 closeout,
2026-06-20, per the CLAUDE.md doc-lifecycle rule; the full original working paper — every option,
the four-branch V1 gate, the per-phase task lists — is in git history via `git log --follow` on
that path). IMPLEMENTED 2026-06-20 across five phases on branch `image-understanding`: V1 research
gate → V2 backend skeleton → V3 Images screen → V4 real runtime + idle teardown → V5 eval/docs.
**§ numbers below are this record's; the in-code comments still cite the original PLAN's `§N` and
its `RUNTIME-*`/`SEC-*`/`PROD-*`/`IPC-*`/`DIST-*` traceability tags — the §9 legend keeps those
resolvable.** The feature: a 6th primary screen, **Images**, that answers a question about ONE
local PNG/JPEG using a local vision-language model. It is **visual understanding**, distinct from
OCR (tesseract.js, Documents) and from any image generation (never built)._

### §1 Decisions

| Decision | Choice | Why (short) |
|---|---|---|
| Runtime topology | **Dedicated lazy vision sidecar** (`services/vision/`, own `LlamaServer`) — Option A | Mirrors the embedder/reranker, keeps Chat undisturbed; composes `LlamaServer` directly so it does NOT inherit `CHAT_SERVER_ARGS` (RUNTIME-2). Option B (swap chat to multimodal) + Option C (mtmd CLI) rejected — §4 |
| Image transport | **base64 `image_url` data-URL inlined into the loopback request — NO disk write, NO pin bump** | V1 gate #1 best case: `llama-server --mmproj` on b9585 answers `/v1/chat/completions` with a base64 image; the temp-file fallback (§12 of the plan) was NOT built |
| Vision arg set (V1-resolved) | `--mmproj <projector>` + `--device none`; `--jinja` left default-ON; **`--reasoning-format` NOT passed** | Qwen2.5-VL is non-reasoning (emits no reasoning frames); CPU-pin avoids VRAM contention. `cache_prompt:true` caches the image prefill across follow-ups |
| SSE reader | **Reuse `readChatSSE` unchanged** | V1: the streamed frames are byte-identical to text chat — streaming-by-default stands (no vision-specific reader, no poll fallback) |
| Serialization | **Vision's OWN one-job latch + busy-REJECT** (not the chat slot arbiter) | A separate sidecar is not covered by `model-slot-arbiter`; chat + embedder + vision = 3 co-resident (RUNTIME-3). A 2nd analyze returns `busy`, never queued (IPC-3) |
| Idle teardown | **Net-new SOFT idle teardown, default 120 000 ms** (2 min, §19.13 band; tuned V5) | The idle ~4.6 GB must not sit co-resident forever; cache_prompt makes the warm-window value small, so reclaim RAM promptly (RUNTIME-4 / model-benchmarks §8.3) |
| Preview encoding | **`data:` URL only — NOT `blob:`** | Prod CSP `img-src 'self' data:` lists no `blob:` (`main/index.ts`); `data:` needs NO CSP change (SEC-1). ~33% base64 inflation, mitigated by downscaling first |
| Image decode/downscale | **Browser APIs in the sandbox, no native dep** (`createImageBitmap` → 1536 px → re-encode) | No `sharp`/`jimp`; downscale is a real LATENCY lever (fewer image tokens ⇒ less CPU prefill) AND normalizes EXIF orientation |
| Download topology | **Two atomic single-file planner tasks sharing one `modelId`**, fetched under one UI job | Install = both GGUF + mmproj present + verified. The planner (`planModelDownloads`) and the scripts always emitted both; the in-app `DownloadManager` later grew to run all of a model's tasks sequentially under one job with COMBINED progress (DIST-1) |
| Persistence | **Ephemeral renderer state only** — no DB writes, no auto-OCR, no corpus indexing | The image/question/answer live only in screen state (§3 non-goals); never persisted |
| Model | **Qwen2.5-VL-3B-Instruct Q4_K_M + f16 mmproj** (Apache-2.0) | V1 winner: loads on b9585, reads a real German invoice; ~3.27 GB on disk, ~4.6 GB peak RSS (model-benchmarks §8.2) |

### §2 Hard rules (these bound every choice)

- **No cloud/telemetry; fully offline.** No hosted-AI API; the sidecar binds **`127.0.0.1` only**
  (the offline guard exempts loopback). The green gate holds with **zero vision models** ⇒
  `available:false`, the app launches, the full suite passes.
- **No new native npm dependency.** Image decode/preview/downscale use only browser APIs in the
  sandboxed renderer (`contextIsolation`/`sandbox` untouched; CSP unchanged — `data:`-only preview).
- **No image/prompt/answer/OCR content in logs or audit.** The vision path writes **zero** audit
  rows; errors to the renderer are friendly `VisionErrorCode`s, technical reasons to the local log
  only (asserted by the §17-plan security sentinel, `tests/integration/vision-security.test.ts`).
- **Never crash on missing assets.** No runtime / no model / incompatible ⇒ a calm unavailable
  state. Status is **workspace-agnostic** (PROD-2 — no `'locked'` reason; weights aren't encrypted).

### §3 b9585 facts this design relies on (V1, verified live on the PAID smoke drive)

(Verified 2026-06-20 against the pinned tag; re-verify on the next pin bump.)

- `llama-server --mmproj <file>` **loads multimodal cleanly** and answers `/v1/chat/completions`
  with a **base64 `image_url` data-URL — no disk write** (gate #1, the best of the four branches).
- `--jinja` is **default-ENABLED** on b9585, so the multimodal chat-template path is taken without
  inheriting `CHAT_SERVER_ARGS`; `--reasoning-format` must be **left at default** for a non-reasoning
  VLM; `--device none` CPU-pins (the embedder precedent).
- The streamed frames are **byte-identical to text chat** → `readChatSSE` parses them unchanged
  (verbatim sample pinned at `tests/fixtures/vision/vision-sse-sample.txt`; CI regression in
  `tests/unit/vision-sse.test.ts`).
- `cache_prompt:true` ⇒ the image prefill is **cached across follow-ups** (`cache_n:2812,
  prompt_n:1` measured on the 2nd question) — the per-image thread pays the (slow CPU) prefill once.
- Multimodal CLIs (`llama-mtmd-cli` etc.) are **also bundled** — Option C remains an unused fallback.

### §4 Alternatives considered (and why not)

| Alternative | Verdict |
|---|---|
| **Option B — swap the chat `RuntimeManager` to a multimodal chat model** | Rejected: disrupts Chat (stop/restart), forces the *chat* model to be multimodal, couples two features. Revisit only if one bundled model serves both well |
| **Option C — one-shot `llama-mtmd-cli` per spawn** (transcriber-style) | Fallback only if server `--mmproj` lacked multimodal; needs a temp image file (CLI takes a path) + the `.parse-vision` shred posture. V1 made it unnecessary (Option A works) |
| **Runtime-pin bump** | Avoided — gate #1 succeeded on the existing pin; a bump would be a major reviewed change (`model-policy.md` "To bump the release") |
| **`blob:` preview** (`URL.createObjectURL`) | Rejected: CSP-blocked (no `blob:` in `img-src`); would need a reviewed dev+prod CSP edit (a §0 red line). `data:` chosen (SEC-1) |
| **Queue a 2nd analyze** | Rejected: busy-REJECT keeps `ImageJobState` + the §5.6 copy simple for marginal benefit (IPC-3) |
| **One download job, two files** | Originally deferred (cross-file progress aggregation + per-file verify + partial-failure recovery `downloads.ts` then lacked); the planner stayed two-task. Later BUILT in the UI downloader when the vision manifest shipped — one job runs each task in turn with combined progress (DIST-1) |
| **A native image lib** (`sharp`/`jimp`/`canvas`) | Rejected: browser APIs cover decode/downscale/EXIF in the sandbox with zero deps |

### §5 Design as built (the module map + the flow)

- **`shared/manifest.ts`** — `vision` role; an optional **`mmproj` projector sub-block** (`MmprojSpec`,
  required iff `role: vision`); the top-level `download` + `mmproj.download` validation share one
  `validateDownloadSubBlock` (https-only, a real download hash equals the real file hash); optional
  informational `input_modalities`. Unknown keys ignored ⇒ older builds treat a vision manifest as
  `unsupported` (forward-compatible).
- **`services/models.ts`** — vision install state = **both files present + verified**: `mmprojPath` +
  `manifestFiles` thread through `computeInstallState` (precedence `unsupported → missing → checksum_failed
  → installed`), the lazy `skipHash` path, and the `(path,size,mtime)` two-tier checksum cache.
- **`services/vision/`** — `status.ts` (`getVisionStatus`: no-runtime → no-model → incompatible →
  available; cheap, lazy, lock-safe), `limits.ts` (byte cap ~20 MiB env-overridable + extension/MIME
  guards + `validateAnalyzeRequest` — the SEC-3 main-side re-validation `importDocuments` lacks),
  `runtime.ts` (`VisionRuntime` on `LlamaServer` directly with the §1 args; lazy single-flight
  `ensureStarted`; `analyze` builds the base64 `image_url` request + `readChatSSE`; the §6
  idle-teardown interlock), `index.ts` (`VisionService`: ephemeral job map, own one-job
  serialization, busy-reject, cancel via AbortController, lock/quit `stop()`).
- **`ipc/registerImagesIpc.ts`** — `images:getStatus|chooseImage|readBytes|analyze|cancel|getJob` +
  `STREAM.imgToken/imgDone/imgError(jobId)`. `getStatus` needs no unlock; file/runtime handlers
  `requireUnlocked`. `chooseImage` returns `{path,name,sizeBytes}` (IPC-2); `readBytes`/`analyze`
  re-validate extension + byte cap in MAIN (SEC-3). `imageReadBytes` is the PICKER path only —
  drag-drop reads the `File` bytes directly (IPC-1).
- **Renderer** — `renderer/screens/ImagesScreen.tsx` (the §5.6-plan state machine, busy-reject,
  focus re-check) reads the active analysis from `renderer/lib/visionSession.ts` — a **module-level
  store** (the `doctasks.ts`/`skillruns.ts` "survives screen unmount" precedent) that holds the
  loaded image + the Q&A thread and **owns the `onImage*` stream listeners**. Because the store, not
  the component, owns the in-flight job, a running analysis **survives navigating away and back**
  (still streaming, partial answer intact) instead of being cancelled on unmount; the screen only
  drops it on workspace **LOCK** (`clearVisionSession()`, parity with main purging the job map).
  The screen has two views toggled by a screen-local `viewingDetail` (default **list**, so every
  return to Images lands on the "new analysis" view — a finished analysis never strands the user on
  the result view): the **list** (upload drop zone + previous-results history) and the
  single-analysis **detail** (preview + composer + thread, with a "‹ Back to analyses" link that
  leaves WITHOUT cancelling). While an analysis runs the upload is **disabled** (vision is
  one-at-a-time) and the in-flight job shows as a distinct "Analysis running…" top row of the
  results list (`ImageHistory`'s `running` prop) that re-opens the live detail view on click.
  Building blocks in `renderer/images/`: `ImageDropZone`, `ImagePreview` = `data:` URL,
  `QuestionComposer`, `AnswerThread`, `VisionUnavailable`,
  `decode.ts` = `createImageBitmap({imageOrientation:'from-image'})`
  → downscale longest side to 1536 → re-encode to the input MIME on `OffscreenCanvas`/`<canvas>` →
  `data:` URL, EXIF stripped by the draw, best-effort fallback to original bytes. Images is the
  **6th primary nav destination** — `design-guidelines.md §2` updated to "6 primary + 1 utility".
- **Lifecycle wiring** — `ctx.vision` built once in `main/index.ts`; torn down on `will-quit` and on
  workspace **LOCK** (in `registerWorkspaceIpc`, beside `ctx.embedder.suspend()` — its KV cache holds
  the decoded image, so it must die before the vault re-encrypts).

**Flow:** drop/choose a PNG/JPEG → renderer decodes/downscales (EXIF-normalized) → `imageAnalyze`
ships the bytes to main once → `VisionService` validates + serializes → `VisionRuntime` lazily starts
the sidecar (cold) → base64-inlines the image into one loopback request → streams the answer back via
`STREAM.img*` → idle teardown reclaims the RAM after 2 min.

### §6 The idle-teardown interlock (RUNTIME-4 — the net-new V4 work)

`e5.ts` is the precedent for lazy-start/`startFailed`/no-orphan, but it has **no idle timer**, so the
interlock is genuinely new (and races: a teardown firing concurrently with `ensureStarted`/`analyze`).
As built in `runtime.ts`:

- An `inFlight` counter + an `idleTimer` + an `idleTeardownPromise`. The timer is **cancelled on every
  `ensureStarted()`/`analyze()` entry** and **rearmed only when the LAST in-flight analyze settles**
  (`inFlight===0`).
- The idle teardown is **SOFT** — it kills the child + nulls `this.server` but does **NOT** latch
  `stopped`, so the next analyze cold-starts cleanly. It is **guarded** against `stopped`/`starting`/
  `inFlight>0` (never tears down under a running job); an analyze arriving mid-teardown sees
  `server===null` and cold-starts a fresh, independent child (the old one finishes stopping on its own).
- `stop()` (permanent — lock/quit/cancel) cancels the timer + **awaits an in-flight soft teardown** so
  no child orphans on quit; the timer is `unref()`-ed so it never blocks a clean exit.
- Default **120 000 ms** (tuned V5 — model-benchmarks §8.3), env `HILBERTRAUM_VISION_IDLE_MS`.

### §7 Security & privacy posture (additive within the boundaries)

Renderer stays sandboxed (no Node/network); main owns all file I/O + the sidecar call. **CSP
unchanged** (`data:`-only preview, SEC-1). Sidecar **loopback-only**; no remote origin in
`connect-src`/`img-src`. **No image/prompt/answer content in logs/audit** — the vision path records
**zero** audit rows (the `audit-ipc.test.ts`-style sentinel proves it on success + failure paths).
The only vision log lines are **content-free job lifecycle** (`Vision analyze started`/`done`/`failed`,
`{jobId}` + the friendly error CODE only — so a started analysis is visible in the log without ever
emitting image/prompt/answer text; the security sentinel asserts the failure-line shape).
The image is attacker-controllable, so the byte/extension/dimension caps mirror `ingestion/limits.ts`;
the path-trust stance matches `importDocuments` (accepted residual) but the extension+cap re-check is
net-new code (SEC-3). The ANALYZE call itself still keeps no temp file (bytes are base64-inlined);
the only on-disk bytes are the **history** copy, which is **encrypted at rest** (§10). Engine-binary
trust is unchanged (no new binary on the recommended path).

### §8 Limits & RAM (PROD-1 / known-limitations)

- **CPU prefill of a full-res image is SLOW** (~52 s for ~2800 image tokens off USB, ~12 tok/s
  decode) — the §1 downscale-to-1536 is a real latency lever, GPU is the §19.11 lever; `cache_prompt`
  blunts follow-ups but the FIRST question per image pays it.
- **RAM peak is co-resident** — chat + E5 + vision = three sidecars; the idle teardown bounds the
  *window*, not the active-use peak. A 12B chat (~7 GB) + vision (~4.6 GB) + embedder ⇒ **>16 GB**;
  the `recommended_min_ram_gb` / RAM-best-fit gate keeps vision off small tiers (model-benchmarks §8.4).
- **MVP scope:** single image only (no compare/video/camera), PNG/JPEG only (WEBP deferred), ctx
  capped at 4096 (vs train 128000). Full list in `known-limitations.md`. (The original "ephemeral,
  no persistence" scope was **lifted 2026-06-20** — analyses are now saved to an encrypted, deletable
  history, §10.)

**Commercial-drive gate (closed — verifies BOTH files; DIST-2).** `assertCommercialDrive` →
`verifyDriveModels` now iterates the same `manifestFiles` set (GGUF + `mmproj`) that
`computeInstallState` requires, folding to one per-model row that reports the FIRST non-`verified`
file — so a half-installed vision drive (good GGUF, missing/corrupt projector) fails `weightsVerified`
and cannot pass the sell gate. `buildChecksumsJson` likewise captures one entry per file. The download
side matches: `planModelDownloads` + `fetch-models.{ps1,sh}` fetch both files (DIST-1), and the in-app
`DownloadManager` (UI) now does too — `start()` plans every task for the model and `run()` fetches each
one sequentially under a single job (skipping files already present + verified, so a half-installed
vision model downloads JUST the missing projector), reporting the COMBINED received/total. The job is
`done` only once every file is verified; one placeholder hash taints the whole model UNVERIFIED. (This
closed the original "GGUF-only" residual once a `role: vision` manifest was committed — see
`tests/integration/downloads.test.ts` "DownloadManager vision (two files)".)

### §9 §-anchor legend (historical plan citations)

The plan was folded into §1–§8 above, but in-code comments + the kept docs still cite the **original
plan's** `§N` and its bracketed traceability tags. Those were never renumbered; this legend keeps them
resolvable (the doc-lifecycle "stable anchors" intent) without churning the comments. Read a historical
anchor as:

| Historical anchor | Meaning | Now lives in |
|---|---|---|
| plan §7 / §10 | Option A sidecar + the `services/vision/` module design | §1 + §5 |
| plan §9 / §9.1–§9.4 | IPC/preload surface + the job pattern (busy-reject) | §5 (+ IPC-1/2/3) |
| plan §5.1–§5.6 | The renderer component anchors cited in `screens/images/*.tsx` (VisionUnavailable §5.1, ImageDropZone §5.2, ImagePreview/QuestionComposer §5.3, AnswerThread §5.4, the §5.6 state matrix) | §5 / the §4 state matrix |
| plan §11 | Renderer components + decode/downscale/EXIF algorithm | §5 |
| plan §12 / §13 | Privacy posture (ephemeral, no content in log/audit) + security model | §2 + §7 |
| plan §14 | Caps + RAM co-residency | §8 |
| plan §15 / §17 | Eval/benchmark + the test plan | model-benchmarks §8 + the vision test suite |
| plan §19.10 | Streaming-by-default (the SSE channels) | §1 + §3 |
| plan §19.11 | GPU vs CPU lever | §1 + §8 |
| plan §19.13 | Idle-teardown timeout (2–5 min → tuned 120 s) | §1 + §6 |
| `RUNTIME-2` | Composes `LlamaServer` directly; V1-resolved arg set | §1 + §3 |
| `RUNTIME-3` | Vision's own one-job serialization (3 co-resident sidecars) | §1 + §5 |
| `RUNTIME-4` | The net-new idle-teardown interlock + its races | §6 |
| `SEC-1` | `data:`-only preview; CSP unchanged | §1 + §7 |
| `SEC-3` | Main-side extension+cap re-validation (net-new) | §5 + §7 |
| `PROD-1` | RAM co-residency peak (idle bounds the window, not the peak) | §8 |
| `PROD-2` | Workspace-agnostic status (no `'locked'` reason) | §2 |
| `IPC-1/2/3` | Drag-drop skips `readBytes`; `{path,name,sizeBytes}`; busy-reject | §5 |
| `DIST-1` | Two download jobs share one modelId | §1 + §5 |

### §10 Analysis history (encrypted-at-rest, deletable — added 2026-06-20)

The V1–V5 "ephemeral, nothing persists" posture was **intentionally lifted**: analyzed images are now
saved to a local **history** (the user asked for parity with the documents/chat history), encrypted at
rest exactly like the document cache. Markdown rendering of the answer was fixed in the same change
(the `AnswerThread` answer now uses the shared `AssistantMarkdown` — `react-markdown` + `remark-gfm` —
instead of plain `pre-wrap` text).

- **Data model** (`db.ts`): `image_sessions` (one per analyzed image — `title`, `stored_name`,
  `mime_type`, `size_bytes`, `width`/`height`, `encrypted`, timestamps) + `image_turns`
  (`session_id` FK **ON DELETE CASCADE**, `question`, `answer`, `created_at`). `stored_name` is a
  **relative** filename (drive-portability), resolved against `imagesDir(workspacePath)` at call time.
- **Storage + crypto** (`services/vision/history.ts`): mirrors the document cache. When the vault is
  encrypted (`ctx.workspace.documentCipher()` ≠ null) the image is written to a short-lived plaintext
  temp, `cipher.encryptFile`-d to `workspace/images/<id><ext>.enc`, and the temp `shredFile`-d; in
  plaintext mode a raw `<id><ext>` copy is written (same as documents). `getImageSession` decrypts to a
  temp, reads, shreds; `deleteImageSession` shreds the stored image then deletes the row (turns
  cascade). Turn order uses SQLite `rowid` (monotonic insertion order), not the ms-resolution timestamp.
- **Save trigger:** AUTOMATIC, like chat — the session is created **lazily on the first completed
  answer** (the `done` wrapper in `registerImagesIpc`), so a busy/failed/cancelled/empty job persists
  **nothing** (no turnless sessions). `ImageAnalyzeRequest` carries `name`/`width`/`height`/`sessionId`;
  the new session id rides back on the initial job + the `STREAM.imgDone` event so a follow-up question
  reuses the SAME session/stored image. New IPC: `images:listSessions|getSession|deleteSession`
  (all `requireUnlocked()`-gated).
- **UI:** a text-row history list (`renderer/images/ImageHistory.tsx`, no thumbnails — the image is
  only decrypted when an entry is opened) under the drop zone; opening replays the stored turns and
  reloads the image; delete confirms via `ConfirmDialog`.
- **Security:** the `vision-security.test.ts` "writes nothing to disk" guarantee was **replaced** by
  "the stored copy rests **encrypted** under `images/` (no plaintext image bytes on disk)"; the
  loopback-only + **no content in logs/audit** guarantees are unchanged and still asserted.

**History:** Phases V1–V5 on branch `image-understanding` (2026-06-20); commits `1917f55` (V1 gate),
`6d66e16` (V2), `688d49b` (V3), `27ff275` (V4), + the V5 closeout. Markdown-fix + encrypted analysis
history added 2026-06-20 (§10). Full original plan: `git log --follow docs/image-understanding-plan.md`.


## Data flow (RAG)
import → extract text → chunk → embed (local) → store vectors → on question: embed query →
cosine top-k ⊕ FTS5 keyword top-k (RRF fusion) → optional rerank → build grounded prompt with
`[S1]…` source labels → local LLM → answer with citations → render snippets. Full pipeline:
[`rag-design.md`](rag-design.md).

## Module ↔ spec map
| Module | Spec §7 |
|---|---|
| `services/workspace.ts` | 7.2 drive detector, 7.9 workspace |
| `services/db.ts` | §8 data model |
| `services/models.ts` | 7.4 model manager |
| `services/runtime/` | 7.5 runtime manager |
| `services/chat.ts` | 7.6 chat service |
| `services/ingestion/` | 7.7 ingestion |
| `services/embeddings/` | §6 embeddings |
| `services/rag/index.ts` | 7.8 RAG |
| `services/reranker/` | 7.8 retrieval rerank (rag-design §11) |
| `services/doctasks/` | async document tasks: summary/translation/compare/ocr/tree/extract |
| `services/analysis/` | whole-document analysis: deep index, coverage, extract, symmetric compare (rag-design §14) |
| `services/collections.ts` | document organization (rag-design §13, architecture "Document organization") |
| `services/transcriber/` | whisper.cpp sidecar — audio transcription / dictation (Phase 36) |
| `services/ocr/` | tesseract OCR engine — scanned-PDF / photo text (Phase 38) |
| `services/vision/` | dedicated multimodal llama.cpp sidecar — Images screen (image understanding, V1–V5) |
| `services/downloads.ts` + `services/runtime-download.ts` | in-app model + engine downloader (Phase 18) |
| `services/benchmark.ts` | 7.3 benchmarker |
| `services/policy.ts` | 7.10 privacy/offline |
| `services/logging.ts` | 7.11 diagnostics/logs |
| `services/audit.ts` | §8 `runtime_events`, 7.11 local-only activity record |
| `services/security/` + `services/workspace-vault.ts` | 3.5 encryption, 7.9 workspace modes |
| `services/drive.ts` + `services/assets.ts` | §6 drive layout, §12 packaging |
| `services/launcher.ts` + `services/preflight.ts` | §6 launchers, §11.4 first-run check |
| `services/commercial-drive.ts` | §12.2 sellable-drive gate, §13 license reviews |
| `services/context.ts` | §9 DI service context (`ctx`) wiring all services together |
| `services/compose-services.ts` | composes/constructs the service graph at startup |
| `services/resolve-model.ts` | 7.4 resolves which installed model/file backs a role (availability) |
| `services/select-sidecar-backed.ts` | 7.5 selects the sidecar-backed runtime for an available model |
| `services/retrieval-scope.ts` | 7.8 builds the SQL scope filter for retrieval (collection/document scoping) |
| `services/settings.ts` | §8 persisted user settings access |
