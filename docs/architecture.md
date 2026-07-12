# Architecture — HilbertRaum

_This doc is both the architecture overview and the home of the
**§-numbered design records** (with their §-anchor legends): code comments and the other docs cite
`§N` / finding-id anchors that resolve here. The records absorb the earlier audit ledgers and
remediation waves; the full original working papers live in git history._

**Layout of this file** (wayfinding only — nothing below is reordered or renumbered):

1. **Overview & system shape** — process model & security, swappable interfaces, storage.
2. **Design records** — the bulk of the file: one §-numbered record per subsystem or wave
   (performance waves, models/chat/ingestion, GPU, i18n, document organization, skills,
   translation, result tables, test-enforcement seams, image understanding, …).
   **§ numbers restart inside every record** (standing decision — `§N` collisions across
   records are deliberate; resolve a citation via the record named alongside it), and
   several records end with their own "§-anchor legend" for retired-plan citations.
3. **Audit remediation ledgers §24–§49** — one continuous series interleaved among the
   records (find one with `### §N <audit name>`); each holds a round's finding dispositions.
4. **Data flow (RAG)** and the **Module ↔ spec map** — near the end of the file.
5. **"Original MVP spec — retirement record & §-anchor legend"** — at the very END: the
   resolution table for every `spec §N` citation in code, tests, manifests, and docs.

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
- **Preload**: exposes a single typed `window.api` object (see `src/preload/index.ts`). Stays
  **CommonJS** even though main ships ESM — Electron only allows ESM preload with `sandbox: false`,
  which we never do. See packaging.md "Module format & renderer bundle — design record".
- **Main**: owns all file I/O, the database, the model runtime, and the llama.cpp sidecars. Bundled
  as **ESM** (`out/main/index.mjs`).
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
- `Translator` — the lazy TranslateGemma sidecar (`services/translation/`) **or null**, chosen by
  availability (TG wave). Deliberately no mock (a mock would invent a translation). See "Translation
  sidecar — design record" below.

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
  `idx_bank_transactions_category` on `bank_transactions(category_id)`; `idx_messages_conv_kind` on
  `messages(conversation_id, kind)` (full-audit-2026-06-28 PERF-3 — the per-turn `getLatestCheckpoint`
  compaction lookup, `WHERE conversation_id=? AND kind='compaction' ORDER BY rowid DESC LIMIT 1`,
  served with no SCAN/temp-B-tree because SQLite auto-appends the rowid; **not** `(…, kind, rowid)` —
  naming rowid in an index is rejected, "no such column: rowid"); `idx_summary_cache_created` on
  `summary_cache(created_at)` (PERF-4 — turns the age-ordered eviction delete into an ordered index
  scan, replacing a full-table temp-B-tree sort). `idx_messages_conversation` (conversation_id alone) is
  **retained** — it still serves `listConversationTurns` / the summary-marker lookup, whose `rowid>?`
  range + `ORDER BY rowid` the composite can't satisfy (the non-equality `kind!='compaction'` blocks the
  trailing rowid seek). **`run_id` indexes deliberately
  omitted** — `run_id` is only ever INSERTed, never joined/filtered, so an index would be pure
  write-amplification on USB; add one alongside the first query that joins on it.
- **DB-3/ING-2 — `listDocuments` de-N+1'd.** The per-row chunk COUNT + per-indexed-row stale-embeddings
  COUNT+JOIN (up to 1+2N queries, polled at 400 ms during import) are now two grouped queries loaded
  into Maps (`GROUP BY document_id`), mirroring the memberships join beside them. Benefits from
  `idx_embeddings_model` and the covering `idx_chunks_document`. **Chat & Documents audit 2026-07-07
  DB-5** adds an embedded-count early-out: on a mid-import poll where no row is `indexed` the whole
  embeddings⋈chunks scan is skipped (no indexed row can be stale) — see the Session-6 record in the
  doc-organization reliability/perf notes (the `document_id` count-map cache was declined there).
- **Data-layer hardening (full audit 2026-06-28, Phase 5).** Atomicity + a trigger guard + two pinned
  invariants, all additive (no schema-shape change; indexes `IF NOT EXISTS`, the FTS trigger drop/recreate
  the only non-index DDL).
  - **REL-4/REL-5 — transactional parity with `deleteDocument`.** `deleteConversation` (chat.ts) now wraps
    its two deletes (messages, then conversations — no `ON DELETE CASCADE`) in one `BEGIN…COMMIT` with
    `ROLLBACK` on throw, so a crash / `SQLITE_BUSY` past the busy_timeout between them can't leave an
    orphaned empty thread (compaction checkpoint rows live in `messages` too). `deleteImageSession`
    (vision/history.ts) now deletes the ROW first (in a txn) and shreds the stored image only AFTER —
    the DATA-1 "never destroy the on-disk copy while the row delete can still fail" ordering, closing the
    undeletable-ghost-session window. Both run from IPC handlers with no outer transaction (no nested
    BEGIN), exactly like `deleteDocument`.
  - **DATA-1 — `messages_fts_au` kind guard + backfill.** The UPDATE trigger now guards its INSERT with
    `WHERE new.kind IS NOT 'compaction'` (the DELETE stays unconditional, so a plain→compaction content
    edit still purges the stale FTS row), matching the INSERT trigger. `ensureMessagesFtsUpdateKindFilter`
    drop/recreates the trigger on existing DBs whose `au` trigger re-indexed updates unconditionally
    (mirrors `ensureMessagesFtsKindFilter`) — so a future in-place edit of a checkpoint row can never leak
    its summary text into conversation search, on old or new drives.
  - **DATA-2 (invariant, no code change).** `tree_edges.child_id` is a polymorphic FK (chunks.id OR
    tree_nodes.id) with no FK to chunks; the no-dangling-edge invariant holds only because every
    chunk-delete path also tears down the document's `tree_nodes` (cascading the edges via `parent_id`).
    Pinned by an integrity test (after a `deleteDocument`, zero `child_is_chunk=1` edges reference a gone
    chunk; the forbidden chunks-only delete dangles them).
  - **DATA-3 (idempotency confirmed, no code change).** `extract.ts` re-extract is idempotent per chunk:
    the main loop skips a chunk whose `__scan__` marker matches the current content hash, and `commitChunk`
    deletes the chunk's prior rows before inserting, so a forced re-commit replaces rather than doubles the
    marker. Pinned by a no-double-count test.

**Compare retrieval (`services/doctasks/handlers/compare.ts`; the run path moved there by DX-1, §38 — the pure window math stays in `doctasks/compare.ts`).**
- **RAG-2/ING-1 — decode doc-B once.** Section-matched compare (mode b) ran `VectorIndex.search` per
  doc-A chunk, re-issuing the doc-B embeddings query and re-decoding every doc-B vector each time
  (O(N_A × N_B) redundant decodes + N_A re-scans), then re-fetched doc-B's text per window. Doc-B's
  `(id, text, chunk_index, vector)` is now loaded **once** into a resident array; the ranking runs in
  memory. Mirrors the `alignNodes` precedent (`doctasks/compare.ts`).
- **P1 (full-audit-2026-06-30) — `dotProduct` + running top-K.** The in-memory neighbor scan is now the
  pure, exported **`compareNearestNeighbors`** (`doctasks/compare.ts`) using `dotProduct` (stored vectors
  are L2-normalized → cosine == dot, the same RAG-1 fast path `VectorIndex.search` uses; ~2× fewer FLOPs)
  + a running top-K instead of a full `sort().slice()` per A-chunk. Byte-identical selection to the old
  cosine-sort-slice (equivalence-tested in `tests/unit/compare-nearest-neighbors.test.ts`); ~2.2× faster
  on a 1000×1000 compare. See the Phase B note in the Wave-P4 performance record.

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
  Markdown. **DECISION (revised) — the live answer streams as Markdown via Streamdown.** The original
  O(n²)-per-flush worry that kept the live bubble as PLAIN TEXT is gone: Streamdown splits the buffer
  into blocks and memoizes each, so a flush re-parses only the final block, and `parseIncompleteMarkdown`
  closes dangling `**bold**`/`` `code` ``/fences/links mid-stream so partial syntax formats cleanly
  instead of flashing raw markers. The live bubble is now `.msg-content.md` (same prose CSS as a
  persisted turn) with the stream caret a sibling of the block. The visible text stays non-live
  (audit L7); `StreamAnnouncer` still announces sentence-by-sentence. `lastAssistantId` is `useMemo`'d
  (was a per-flush `[...messages].reverse().find`), and the scroll-to-bottom effect is gated on an
  `atBottomRef` so a flush only forces layout + scroll while the user is pinned to the bottom (also
  addresses the FE-5 scroll-thrash note).
  - **Measured (`scripts/bench-markdown-flush.mjs`, jsdom client render, total stream time as the
    reply grows 10→80 rich KaTeX blocks):** naive full re-parse each flush (memo defeated) is
    **O(n²)** — 263ms→14,358ms, 6.8× per-block growth, confirming the original worry was real.
    Block memoization alone (no `parseIncompleteMarkdown`) is **flat O(n)** — 10.5ms→67ms, 0.8×
    per-block — so closed blocks are genuinely not re-parsed, and the module-level `components`/plugin
    references in `Transcript.tsx` are what keeps that memoization intact (an inline `components`
    object would put the live bubble back on the O(n²) curve). The **shipped config**
    (memoization **+** `parseIncompleteMarkdown`) lands in between — 14.4ms→346ms, 3.0× per-block,
    super-linear: `parseIncompleteMarkdown` re-scans the whole growing buffer each flush. Net: ~40×
    faster than naive at 80 blocks and ~4 ms/flush, comfortably interactive for realistic replies
    (flushes are rAF/40 ms-throttled and replies are rarely that long). **Ceiling + upgrade path:**
    the residual is the whole-buffer `parseIncompleteMarkdown` scan; if very long single replies ever
    feel sluggish, gate `streaming` off past N blocks (a long buffer has few dangling tokens to close,
    so the anti-flicker benefit is only at the trailing edge) — not done now (YAGNI at current sizes).
- **FE-3 — chat children memoized; stable handler identities.** `Transcript` and `ConversationList`
  are `React.memo`'d. ChatScreen re-renders on every keystroke (input state) + every flush; a
  `useEventCallback` (latest-ref) wrapper gives the handlers passed to those children
  (`onCopy`/`onSave`/`onTryAgain`/`onAnswerWithoutSkill`, `onSelect`/`onNew`/`onDelete`/`onCollapse`)
  **constant identities without stale captures**, and the teaching `emptyState` is `useMemo`'d
  (keyed on mode/docs, never on `input`). So a keystroke no longer re-renders the transcript
  (compounding FE-1) or re-runs `groupByProject`/`groupConversations`.
- **FE-4 — conversation rows memoized.** `ConvRow` (React.memo) with stable per-row callbacks, so
  opening one row's ⋯ menu (which flips the parent `menuOpenId`) no longer re-renders every row.
- **Full-audit 2026-07-10 PF-1/PF-2/PF-3 — streaming + audit-log hot-path closures.**
  `StreamAnnouncer`'s sentence-boundary scan starts at the previous announce point instead of
  re-scanning the whole buffer per flush (byte-identical output, oracle-pinned); the live
  context-meter word count advances incrementally per flushed chunk (exact-equivalence-pinned);
  the audit-log prune is slack-gated + transactional over `idx_runtime_events_created` (see the
  Audit log record).
- **Full-audit 2026-07-10 PF-4/PF-7 — startup discovery + renderer churn sweep.** PF-4:
  `composeServices` discovers manifests ONCE per composition pass and threads the result into its
  role resolvers (`resolveModelByRole` takes an optional pre-discovered list) — the per-action IPC
  callers and the issue-#40 `onModelInstalled` refresh still re-discover; deliberately NO stateful
  module cache, which could serve stale results. PF-7a: the Home runtime poll keeps the previous
  state object on a value-unchanged tick (React bails out of the re-render) and stops entirely once
  the model runs, with a window-focus re-check instead (the ChatScreen poll-while-not-running
  pattern). PF-7b: the doc-task store's 400 ms poll ports the skillruns `sameRun` no-change gate
  (SKA-39 precedent) — an identical tick sets nothing and the snapshot identity stays stable.
  PF-7c (**closes the carried-forward PERF-5**, see the 2026-06-30 ledger): `visionSession` batches
  token deltas through a 40 ms flush buffer (the ChatScreen `STREAM_FLUSH_MS` precedent; settle
  paths flush first so no token is lost, discard paths drop the buffer), and ImagesScreen got the
  FE-3 `useEventCallback` sweep over `onCopy`/`onTryAgain`/`onStop` — a settled `TurnRow` no longer
  re-renders while a sibling turn streams (render-count-pinned via the `__docRowRenderCounts`
  pattern). `translateSession` deliberately stays per-token (~4 tok/s — documented there). PF-7d:
  `ScopePopover` memoizes its `indexed`/`addableDocs`/collection derivations on
  `[docs, docIds, collections]`, so the (usually closed) composer-footer popover no longer
  re-filters the full docs list on every keystroke/stream flush.

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

## Renderer robustness — design record (full audit 2026-06-28, Phase 3)
The renderer was the least-audited surface (prior rounds were backend-only). Phase 3 closes a
top-level robustness gap plus a cluster of unhandled-rejection / effect-lifecycle / key / i18n / a11y
items. All changes are renderer-only (plus the shared i18n catalogs); no IPC surface, no main-process
behavior. The labels below are the audit's **FE-1…FE-9** (full-audit-2026-06-28 — distinct from the
Wave-P2 perf FE-* record above).

**Error boundary (FE-1 — the one High).** Before Phase 3 there was **no** error boundary anywhere, so
any screen render throw (e.g. `Streamdown` on malformed model output, a Radix portal edge)
unmounted the whole tree → a blank window with no recovery, in an offline app the user must
force-quit. The contract now:
- **Component:** `renderer/components/ErrorBoundary.tsx` — a class component with
  `getDerivedStateFromError` + `componentDidCatch`. It takes a `fallback(reset)` render-prop and an
  optional `onError` sink. **Logging is LOCAL-ONLY** (CLAUDE.md hard rule: no cloud/telemetry/remote
  crash reporting): there is no renderer→main log IPC (the preload exposes only the READ-only
  `getLogTail`/`exportLog`), so it logs via `console.error` — never a network call.
- **Per-screen boundary (`App.tsx`).** AppShell wraps the active screen in an `<ErrorBoundary>` **keyed
  by `screen`**, so navigating to any other destination re-mounts the subtree and clears a captured
  error. The boundary is INSIDE `<main>`, so the nav rail (rendered outside it) stays alive — the user
  is never trapped. The localized fallback (`ScreenErrorFallback`, `role="alert"`) offers an in-place
  **Try again** (`reset`) and a **Go to Home** escape — the latter calls `reset()` *and*
  `navigate('home')`, since when Home is itself the throwing screen `navigate('home')` is a same-value
  no-op (the key never changes), so `reset()` is what actually clears the boundary.
- **Outer last-resort boundary (`main.tsx`).** Wraps `<App/>` so a throw ABOVE the per-screen boundary
  (the gate, the i18n provider, AppShell itself) still shows a localized reload prompt
  (`RootErrorFallback`) instead of a blank window. It sits OUTSIDE `I18nProvider`, so it resolves the
  pre-unlock language itself (`resolvePreUnlockLanguage` + the standalone `t`).
- **New i18n keys** (en + de, parity typecheck-enforced): `errorBoundary.title/body/retry/home` and
  `errorBoundary.app.title/body/reload`.

**The FE-2…FE-9 cluster.**
- **FE-2 (unhandled IPC rejections).** `ModelsScreen` cancel now `.catch`es → `friendlyIpcError` into
  the error banner; `SkillsTab.pick()` moved `pickSkillPackage` INSIDE its `try` → a rejecting picker
  shows the `skills.import.failed` toast, not an unhandled rejection.
- **FE-3 (skill toggle double-submit).** A per-skill in-flight `Set` (`toggling`) disables the row
  Switch while an enable/disable is pending and ignores a second submit for the same skill;
  `refresh()` reconciles to the server state in `finally`. Disable-while-pending over optimistic UI
  (simpler, robust).
- **FE-4 (setState-after-unmount).** The HomeScreen `let active` guard (or a component `mountedRef`
  where the async setState lives in a shared callback/interval) is applied uniformly: the
  DocumentsScreen import poll (guard checked after each `await` before any setState), `PrivacyTab`,
  `DiagnosticsTab` refreshers, `SkillsTab` settings load, and the General tab. (React 18 makes a
  post-unmount setState a silent no-op, so this is defensive correctness; the DocumentsScreen test has
  teeth by asserting `listDocuments` is not re-fetched after unmount.)
  **Extended (full audit 2026-06-29, FE-1):** `ChatScreen` was the remaining FE-4-class gap — its
  attach-import poll (`watchAttachJob`) and streamed-token flush (`flushStream`) both resolve after the
  user can navigate away mid-import / mid-generation. It now carries the same `mountedRef` (gating the
  poll/flush setStates) and clears the pending flush timer on unmount. **Hard constraint:** the
  main-side stream is *not* torn down — it is intentionally recovered on remount via `getActiveStream`
  (see "Stream recovery across navigation" below); the fix is guard-only. Teeth: `ChatUnmount.test.tsx`
  unmounts with a poll tick AND a flush timer in flight, then asserts `listDocuments` is not re-fetched
  and the flush timer was `clearTimeout`'d.
  **Reconciled (full audit 2026-06-29 postmerge, F22 — the "applied uniformly" claim was overstated):**
  two hold-outs remained when this record was written. `ModelsScreen`'s download/engine poll callbacks
  (`setJob` + a transitional `void refresh()`) had **no** guard, and the `DiagnosticsTab`
  `loadActivity`/`loadMoreActivity` refreshers — though this bullet listed "DiagnosticsTab refreshers" as
  covered — guarded only `refreshStatus`/`refreshLogs`/the mount effect, not the activity-page setStates.
  Phase 6 gives `ModelsScreen` its own `mountedRef` (guarding `refresh()` after its `await` + both poll
  `.then`s) and routes the two `DiagnosticsTab` activity setStates through the existing component
  `mountedRef`, so the discipline is **now actually uniform across every screen**. Teeth:
  `ModelsScreenUnmount.test.tsx` (see §32). Sibling renderer lifecycle/a11y fixes landed the same phase:
  **F21** (DictationButton mic-stream released when `getUserMedia` resolves after unmount — same
  `mountedRef` idiom) and **F20** (WorkspaceGate per-`phase` focus management — `useEffect([phase])`).
- **FE-5 (effect re-run on language change).** `I18nProvider.applyLanguageSetting` is now
  `useCallback([])` (identity-stable; it only needs `setLang`), so App's policy/settings effect, which
  lists it in deps, no longer re-fires `getPolicy()`+`getSettings()` purely because the UI language
  changed.
- **FE-6 (unstable keys).** ScopePopover pending-attachment chips key by `name+index` (name-aware so a
  new import re-mounts a changed slot, index-disambiguated so two cross-folder files with the same base
  name don't collide on a duplicate key); the ChatScreen optimistic user-message id uses a monotonic
  counter (not `Date.now()`, which collides within a millisecond).
- **FE-7 (untracked toast timer).** `ToastProvider` tracks its auto-dismiss `setTimeout` ids in a ref
  and clears them in a cleanup effect.
- **FE-8 (raw English in localized copy).** `DiagnosticsTab` benchmark failures route through
  `friendlyIpcError` (no transport/Error-class prefix in `diag.bench.failed`); the literal `'UNKNOWN'`
  is replaced with `t('diag.app.unknown')`.
- **FE-9 (SegmentedControl Home/End).** Home/End now select the FIRST/LAST **enabled** segment directly
  (`moveToEdge`), instead of relying on the arrow-key modulo wrap to land there incidentally.

**Drag-drop intake (full-audit-2026-06-29 follow-up, Phase 2 — FE-A / FE-C).** Chat drag-and-drop
attach was **silently dead in the shipped app**: `ChatScreen.pathsFromDrop` read `(file).path`, the
non-standard `File.path` Electron **removed in v32** (the app pins `^37.0.0`; installed 37.10.3). At
runtime `.path` is `undefined`, so the loop produced `[]`, `attachFiles` was never called, and a drop
did nothing — no import, no pending chip, no error. It went unnoticed because the only intake test
(`ChatAttach.test.tsx`) **fabricated** `dataTransfer.files = [{ name, path }]`, injecting a property
real Electron 37 doesn't provide → green test, broken product (the round's headline test lesson:
never fabricate a platform property the renderer could read directly).
- **FE-A — resolve the path in the PRELOAD.** The replacement, `webUtils.getPathForFile(file)`, is
  only callable from the (sandboxed) preload, never the renderer. A new preload bridge method
  `window.api.getDroppedFilePath(file)` (`preload/index.ts`, next to `pickDocuments`) wraps it;
  `pathsFromDrop` now calls the bridge per dropped `File`. **NOT a new IPC channel** — `webUtils` is
  synchronous and in-process in the preload, so the resolver is a plain bridge function (no
  `ipcRenderer.invoke`, nothing added to `shared/ipc.ts`); the renderer call site is typed via
  `PreloadApi = typeof api`. `File` objects cross `contextBridge` to the function; `contextIsolation`/
  `sandbox` stay intact. Main still re-validates every path (existence + supported extension) on
  import, so a spoofed value simply fails to import (unchanged trust model). The paperclip picker
  (`pickDocuments` → main dialog → real paths) was always unaffected. The **Images** drop zone reads
  `File` bytes (`FileReader`/`arrayBuffer`), never `File.path`, so it needed no change (confirmed).
- **FE-C — no silent zero-path drop.** `onDrop` had no `else`: a Files-bearing drop resolving to zero
  importable paths (now any browser-origin drag, and — pre-FE-A — *every* drop) was indistinguishable
  from "nothing happened." It now surfaces a friendly banner (`chat.attach.dropUnsupported`, EN+DE)
  when a drop carried Files but yielded no path, matching the Images screen's drop feedback.
- **Tests / verification.** `ChatAttach.test.tsx` now drives the **real bridge shape** — the dropped
  `File` carries no `.path` and a WeakMap stands in for webUtils' File→path resolution — plus an
  explicit FE-A drop-without-`.path` test and the FE-C empty-drop banner test; `ChatUnmount.test.tsx`
  updated to the same shape; `preload-attach.test.ts` is the preload-surface contract (resolver
  exposed + forwards to `webUtils.getPathForFile`). All are teeth-checked (revert the bridge wiring →
  red, verified). jsdom can't exercise `webUtils`, so the unit tests prove the **wiring**; the
  real-Electron leg (bridge exposes the resolver in the actual renderer; `webUtils.getPathForFile` is
  callable in the sandboxed preload on 37.10.3 — a renderer-built File resolves to `''` without
  throwing) was confirmed by launching the built preload under the app's exact `webPreferences`. A
  true native OS drag (Explorer → chat) isn't faithfully automatable (a synthetic File has no on-disk
  path), so the disk→path success leg rests on that availability proof + the wiring tests.

**Phase D (full audit 2026-06-30) — renderer lifecycle & a11y (F1–F8).** A renderer-only sweep
extending the FE-4 mountedRef family; no main-process, IPC, schema, or i18n change (the one banner
reuses the existing `images.err.busy` key). Each fix is independently revertible and the four
behavioral ones are teeth-checked (neuter → red → restore). Suite 2673 → **2677 / 41 skipped** (+4:
F1, F4, F6, F8). Per-finding disposition:
- **F1 (Medium — the one real bug) — `DictationButton.stopAndTranscribe()` fired `onText` after
  unmount, crossing conversations.** `start()` was F21-mountedRef-guarded but the stop path awaited
  the multi-second `transcribeDictation` IPC and then unconditionally called `onText(text)` /
  `onError(...)` / `setState('idle')`. Stop-dictation-then-navigate-away leaked the transcript into
  whatever composer is now mounted (the parent's `mountedRef` doesn't gate its `setInput`). Fix: the
  same `if (!mountedRef.current) return` guard before `onText`/`onError` and before the `finally`
  `setState` — the IPC completes harmlessly, the dead component is never touched. Test:
  `Dictation.test.tsx` resolves `transcribeDictation` AFTER `unmount()` → `onText`/`onError` not
  called, no act-warning (mirrors the F21 test). Teeth: drop the guard → red.
- **F2 (Low, perf) — `Transcript` localized the streaming buffer twice per ~40 ms flush.**
  `localizeServerCopy(t, streamText)` (an O(n) Map-lookup + two regex `.exec` over the growing
  buffer) ran once for the visible bubble and again for `<StreamAnnouncer>`. Now a single
  `const localizedStream = useMemo(() => localizeServerCopy(t, streamText), [t, streamText])` feeds
  both — byte-identical, half the work on the CPU-bound path.
- **F3 (Low) — proactive skill-suggestion debounce setState was unguarded.** `ChatScreen`'s 400 ms
  `refreshSuggestion` resolved `suggestSkills` then `setSkillSuggestion` with no mounted/convId
  check, so a late reply setState'd a dead component or stamped a stale-conversation suggestion. Fix:
  gate the `.then`/`.catch` behind `mountedRef.current && (activeIdRef.current ?? '') === convId`
  (reusing the existing FE-1 `activeIdRef` the stream path already keeps); `convId` is `''` for a
  still-"new" draft, matching `activeId ?? ''` at call time.
- **F4 (Low-Med) — ImagesScreen "Try again" was silently dropped while another turn streamed.** The
  per-turn action stayed clickable while `analyzing`, and `analyze()` early-returned on
  `activeJobId` with no feedback. Fix: thread a `busy` (= `analyzing`) prop through
  `AnswerThread`→`TurnRow` and **disable "Try again" while busy** (mirroring the already-disabled
  composer; Copy stays live — a harmless read); plus defense-in-depth, `analyze()` now returns
  `'started' | 'busy' | 'noop'` and `runAnalyze` surfaces `images.err.busy` if a click still reaches
  the busy guard. Disabling on `analyzing` is *stronger* than the `activeJobId` guard — it also
  covers the create round-trip window before `activeJobId` is set. Test: with a second analysis in
  flight, the prior done turn's "Try again" is `toBeDisabled()`. Teeth: drop `disabled={busy}` → red.
- **F5 (Low) — DEFERRED (accepted).** `Composer`'s auto-grow effect reads `scrollHeight`/`offsetHeight`
  after writing `style.height` → one synchronous reflow per keystroke. It is a single textarea (the
  audit itself rates it acceptable); an rAF batch would add a cancelable frame handle + an unmount
  `cancelAnimationFrame` and risk a one-frame height-lag jump, for a sub-millisecond, imperceptible
  cost. Left as-is by design.
- **F6 (Low, a11y) — `StreamAnnouncer` length-based fallback ADDED.** The announcer only advanced on
  sentence terminators, so a table-/list-/run-on answer with no `. ! ? …`/newline stayed silent until
  completion. When the unannounced tail grows past `ANNOUNCE_SOFT_CAP` (160) with no new terminator,
  it now flushes up to the last **word** boundary (`lastWordBoundary`), holding back the trailing
  partial word — so AT hears progress incrementally. **Accepted residual:** a *pure code block* is
  stripped to ~nothing by `stripMarkdown` (voicing code punctuation is worse a11y than silence), so
  that case stays intentionally quiet; the surrounding prose still announces (recorded in
  known-limitations Accessibility). Test: a 210-char terminator-less buffer announces complete words
  and excludes the trailing partial. Teeth: neuter the fallback → region stays empty → red.
- **F7 (Low) — DEFERRED (accepted; self-heals).** `ChatScreen.onTryAgain` optimistically slices the
  last assistant turn before `stream(...)`. If the IPC throws before the backend mutates, `stream`'s
  `catch` already calls `refreshIfVisible()` → `setMessages(await listMessages(convId))` **in place**
  when the user stayed on the conversation, restoring the answer from the DB; if they switched away,
  the `activeId`-change effect re-reads from the DB on return. So the slice is restored without manual
  re-select in both cases — the audit's "until a manual re-select" framing predates the catch-path
  refresh. Deferring avoids weakening the immediate optimistic feedback (recorded in known-limitations).
- **F8 (Low, hypothesis → CONFIRMED reachable, FIXED) — a superseded vision analyze could wire a
  zombie stream.** The busy guard rejects a second `analyze()` only once `activeJobId` is set, but
  that isn't set until AFTER the `imageAnalyze` create round-trip resolves. A slow round-trip +
  image-switch + re-analyze (the new image resets `analyzing`, re-enabling the composer) leaves two
  analyzes both awaiting `imageAnalyze`; the slower one would reassign the module-global `unsubs`
  over the newer job's (leaking the old listeners), and its own late done/error would then
  `teardownStream()` the newer job and null its `activeJobId`. Fix: each `analyze()` claims a
  monotonic `analyzeGen` (bumped by `abortActive`/`clearVisionSession`); after the await a superseded
  call (`myGen !== analyzeGen`) cancels its now-orphan job main-side and **bails without wiring**, and
  the catch path only touches the turn/flag when still current. Per-handler
  `if (jobId !== snapshot.activeJobId) return` checks are belt-and-braces (the gen guard already
  prevents two jobs' listeners from being live at once). Test (`visionSession.test.ts`, store-level):
  a slow A-create resolving after a switch-to-B is cancelled (`imageCancel('jobA')`) and never wires;
  B is the live job. Teeth: remove the gen bail → A wires, `imageCancel('jobA')` never fires → red.

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

**OCR (`services/ocr/pipeline.ts`, `services/ocr/rasterizer.ts`, `services/ocr/page-cap.ts`).**
- **ING-5 — 1-deep render/recognize look-ahead.** OCR rendered page N (pdfjs, hidden window) then
  awaited recognize(N) (WASM tesseract) before rendering N+1 — two different engines run strictly
  serially. A new pure `pipelinePages(pageCount, renderPage, onPage, opts)` helper renders page N+1
  **while** page N recognizes, keeping recognitions serial and in order. Memory stays bounded (at most
  one extra rendered PNG resident); page ordering, progress %, and cancellation are unchanged. The
  helper is Electron-free so it is unit-testable with fake render/recognize functions.
- **REL-4 — per-page PNG byte cap (backend-audit-2026-06-27).** The hidden window caps render
  *dimensions* at `MAX_RENDER_PIXELS` (4096/side), but the *encoded* PNG it returned over IPC was
  previously unbounded — unlike the vision subsystem, which enforces `VISION_MAX_IMAGE_BYTES`. With
  the 1-deep look-ahead holding up to **two** page PNGs resident, a crafted PDF rasterising near the
  worst case across many pages could drive main-process memory. `services/ocr/page-cap.ts`
  (`assertPageWithinByteCap`, `OCR_MAX_PAGE_PNG_BYTES`, electron-free + unit-tested) now rejects an
  over-cap page the moment the rasterizer receives it — before it is handed to recognition or held
  behind the look-ahead — and the OCR task downgrades to a friendly failure. The cap is **96 MiB**,
  sized to the WORST CASE of a *legitimate* page (a 4096×4096 RGBA bitmap is 64 MiB raw and a
  near-incompressible scan PNG-encodes to about that), **not** the vision path's 20 MiB, which would
  reject real dense color scans; env-overridable via `HILBERTRAUM_MAX_OCR_PAGE_BYTES`. (The vision
  vs OCR caps differ on purpose: vision images are arbitrary user files, OCR pages are bounded by
  the render-dimension cap, so their worst cases — and thus their byte ceilings — differ.)
- **SEC-3 — navigation guard on the hidden window.** The rasterizer's worker window renders
  untrusted PDF bytes; it denies window-open and, via `installNavigationGuard(win.webContents,
  () => false)` (`services/navigation-guard.ts`), **all** navigation on both `will-navigate` *and*
  `will-redirect` (see security-model.md — a redirect reaches a remote origin without firing
  `will-navigate`).

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
  only the constant-factor slice. *(full-audit-2026-06-30 P1 later extended this same dotProduct +
  running-top-K fast path to the compare pairing — see the Phase B note in the Wave-P4 record below.)*

Implemented in Wave P4 (below): the per-query BLOB re-read + re-decode (RAG-1/RAG-6 beyond the dot
product). Still deferred from P2: Composer/`input` move, `DocRow` extraction, FE-5 windowing.

## Performance — design record (perf audit 2026-06-18, Wave P4)
The real fix for the synchronous main-thread vector scan (RAG-1/RAG-6) — the documented MVP deferral
D15. Condensed from `docs/performance-audit-2026-06-18.md` §4.2 after Wave P4 shipped. Stays behind the
**unchanged `VectorIndex.search(queryVector, topK)` signature**, so `rag/index.ts retrieve()` and every
scope filter are untouched. The sibling scans in `analysis/node-vectors.ts` (the summary-tree
`node_vectors` table) and `doctasks/handlers/compare.ts` (compare's one-shot doc-B load) are NOT `VectorIndex`
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
Belt-and-suspenders, three mechanisms (the per-write *full rebuild* was removed in Phase 5 — see the
PERF-1 note below; the original mechanism descriptions are folded into the three bullets):
- **Incremental delta (primary in-band path, PERF-1 / full-audit-2026-06-29 Phase 5; named-delta fast
  path, F12 / post-merge close-out):** `invalidateResidentVectors(db, delta?)` is called at the three
  `embeddings` write sites — `ingestion/index.ts` finalize-insert + reindex chunk-phase delete +
  `deleteDocument`. It MARKS the cache pending (it no longer drops it); the next `getResidentVectors`
  RECONCILES. PERF-1 removed the per-write full *decode*; **F12** removed the per-write O(N) *id-scan*
  for the in-band paths: each write site now passes the **exact** chunk_ids it added/removed (the
  pure-add finalize knows them from its insert; the two delete sites capture them via
  `embeddingChunkIdsForDocument` before the delete), so the reconcile drops the named removed ids and
  `decodeVector`'s only the named added ids by point lookup on the `chunk_id` PRIMARY KEY — **no
  whole-table scan**. A pure-add of K decodes K and reads 0 extra rows. A cheap `Map.size === COUNT(*)`
  gate then confirms consistency; a delta-less `invalidate(db)` (a direct/out-of-band writer — tests,
  the manual bench), a missed/wrong delta, or a truncated-blob omission falls back to the FULL chunk-id
  scan (`SELECT chunk_id`, no decode) — the self-healing path. Both paths key on the UNIQUE `chunk_id`,
  so they stay correct when a deleted row's rowid is reused by a re-index (new row → NEW `chunk_id` →
  old id out, new id in) — also what closes the one signature blind spot: deleting the single max-rowid
  row then inserting one row reusing that rowid leaves `(count, maxRowid)` unchanged, so only the
  explicit flag (not the signature) can see it. The result is byte-identical to a from-scratch rebuild
  for every insert/delete/reindex/same-rowid sequence (an in-band write never mutates a vector under a
  *surviving* chunk_id; re-index mints fresh ids).
- **Staleness signature (self-healing backstop):** a cheap whole-table signature `(COUNT(*), MAX(rowid))`
  is recomputed at the top of every `search`. If the table changed but NO write went through the explicit
  hook (a direct SQL / out-of-band writer — e.g. test seeding), the dirty flag is clear yet the signature
  mismatches → **fall back to a FULL REBUILD**. `MAX(rowid)` is O(1) (rightmost btree leaf) and `COUNT(*)`
  a fast index count — negligible vs the scan they gate. This is the path that makes a missed/buggy
  incremental update self-heal on the next query; it is also the cold first build. **The `COUNT(*)` is
  load-bearing and RETAINED** (full-audit-2026-06-30 P6 considered dropping it but DEFERRED): an
  out-of-band DELETE of a non-max-rowid row leaves `MAX(rowid)` unchanged, so only `COUNT(*)` detects it
  (a tested guarantee). A `COUNT`-free clean path would need a DB-side counter (a trigger = a schema
  change).
- **Security (lock):** `purgeResidentVectors(db)` drops the map outright on workspace LOCK
  (`registerWorkspaceIpc`, beside the embedder's `suspend()`). Distinct from `invalidate` (which only
  marks dirty): the vectors are derived from chunk text and must not linger in main-process RAM after the
  vault re-encrypts — a requirement the staleness signature does NOT cover (the table is unchanged on
  lock). No embedder-switch purge is needed: the cache is per-`Db` and per-chunk (model-agnostic), the
  SQL model-id filter scopes results, and unlock reopens the `Db` → a fresh (empty) cache.

**PERF-1 (full-audit-2026-06-29, Phase 5) — per-write rebuild → incremental.** The original cache DROPPED
the whole map on every `embeddings` write (each insert/delete/reindex `invalidate` = `caches.delete`), so
the next query paid a full ~150 MB re-read + ~580 ms re-decode at the 100k bound — and it recurred after
*every* import/re-index/delete (a heavy "import N docs, ask between each" session paid N full rebuilds).
The incremental delta above removes that: a mutation now only pays the ids-only scan + a decode of the
new rows. **F12 (full-audit-2026-06-29-postmerge close-out)** then removed the ids-only scan too for the
in-band paths — the named delta (above) decodes the new rows by point lookup with no whole-table scan,
falling back to the scan only for a delta-less/out-of-band write or a tripped size gate. The
off-main-thread worker (P4b) and ANN (P4c) remain the longer-term paths and the linear-scan ANN deferral
(D15) is unchanged. Proven in `tests/integration/resident-cache-incremental.test.ts`: equivalence
(incremental map == a from-scratch rebuild byte-for-byte across insert/delete/reindex/same-rowid), the
decode-count speedup (K not N, with a purge→full-decode teeth contrast), the same-rowid blind spot
(signature unchanged → only the hook catches it), the signature backstop self-heal, and the lock-purge
drop; F12 adds the **named-delta equivalence** (delta == cold rebuild), a **no-`SELECT chunk_id`-scan**
assertion (the delta path issues no whole-table scan), delta-composition (add-then-delete nets out), and
the **size-gate self-heal** (a wrong/incomplete delta falls back to the full scan, teeth-checked).
`tests/manual/resident-cache-bench.test.ts` adds the reconcile-cost leg (FULL id-scan vs DELTA no-scan).

**Measurement — confirmed on the PAID drive (D:, b9585; the "real E5-runtime numbers PENDING" item is
now closed).** Two legs, because the scan is **data-independent** (N dot-products of 384-dim Float32 +
sort — identical timing for random unit vectors and real E5 outputs); only the cold-build I/O and the
query-embed round-trip are real-hardware variables.
- **Scan scaling, DB on the real drive (synthetic vectors).** Warm cached scan vs the old
  decode-every-query path: 13.6 ms vs 22.4 ms @ 5k chunks (1.7×), 52.5 ms vs 63.3 ms @ 10k (1.2×),
  164.6 ms vs 225 ms @ 30k (1.4×), 605 ms vs 753 ms @ 100k (1.2×). Cold rebuild (the from-scratch full
  build — now only on the first build or the out-of-band signature-backstop path; an in-band mutation
  pays the incremental reconcile instead, Phase 5) 33 ms @ 5k … 1.48 s @ 100k. These track the earlier mock/SSD projection (~14/50/167/
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
  would scan via `SharedArrayBuffer`, so P4a is also P4b's groundwork. When the trigger fires, the
  P4b design must also cover **residency**, not just blocking: at the 1M-chunk bound the Float32
  vectors are ~1.5 GB (~1.8 GB resident with Map overhead), and a worker scan alone does not fix
  that — only a quantized/disk-resident scheme would (full-audit 2026-07-10 PF-8; no action at
  realistic corpora ≤~10k chunks).
- **P4c (ANN — sqlite-vec / pure-JS HNSW).** sqlite-vec is a **native loadable SQLite extension**, which
  is against the no-native-build / portable cross-OS packaging posture that put the embedder in a
  llama.cpp sidecar rather than `onnxruntime-node` (D15's reasoning). Not adopted; a pure-JS HNSW would
  be reconsidered only if a linear scan over the resident buffer (even off-thread) still bites.

**Phase B (full-audit-2026-06-30, P1 + P2) — the residual row-marshal + the compare quadratic, both
behavior-preserving (equivalence-tested, teeth-checked). No schema/IPC/audit-payload change.**
- **P2 — resident-map iteration on the unscoped path (`embeddings/index.ts`).** The PERF-1/F12 cache
  killed the per-query BLOB read, but the scan still ran `SELECT chunk_id FROM embeddings WHERE …` and
  materialized **one JS row object per in-scope chunk** before the dot-product loop. `VectorIndex.search`
  now splits into `collectResidentHits` (fast) and `collectScopedHits` (the **unchanged** scoped SQL
  scan), sharing the determinism sort. When there is no document/collection scope AND the archived
  exclusion removes nothing, the fast path **iterates the resident map directly** (no `SELECT chunk_id`,
  no transient rows). Two equivalence subtleties are handled exactly: (1) the resident map holds chunks
  under *all* model ids (a transient mock→real migration mix), so the cache now also keeps a
  **`modelByChunk`** map (chunkId → `embedding_model_id`, same key set as `byChunk`, maintained in
  `build` + both reconcile paths) and the fast path replicates `WHERE embedding_model_id = ?` in memory;
  (2) **archiving keeps embeddings**, so archived chunks are resident — the gate `canIterateResident()`
  takes the fast path only when there is no scope union AND (`includeArchived` OR no archived docs exist,
  a cheap `documents`-table probe), else the scoped scan runs byte-unchanged. Result is byte-identical to
  the scoped scan over the same universe (`tests/integration/vector-search-resident-iteration.test.ts`:
  unscoped == all-docs-scoped, hit-for-hit; a `db.prepare` spy confirms the marshal is gone). Measured
  **~5× / query** at 10k–50k chunks (CI-gated `tests/manual/phaseB-perf-bench.test.ts`).
- **P1 — `dotProduct` + running top-K in the compare pairing (`doctasks/compare.ts`).** Section-matched
  compare (mode b) scored *every* doc-B vector with `cosineSimilarity` + a full per-A-chunk
  `sort().slice(topK)` — O(N_A·N_B·dim) + N_A sorts, a multi-second main-thread freeze at ~1000 chunks/
  side. The inline `nearestB` is now the pure, exported **`compareNearestNeighbors`** using `dotProduct`
  (the same RAG-1 unit-vector fast path `VectorIndex` uses — stored vectors are L2-normalized, so
  cosine == dot) + a **running top-K** (descending score, ties broken by doc-B `chunk_index` order). The
  running top-K is byte-identical to a stable dot-sort + slice; on normalized vectors the dot ranking
  equals the old cosine ranking (`tests/unit/compare-nearest-neighbors.test.ts` proves both links).
  Measured **2.2×** on a synthetic 1000×1000 compare. Mode-(c) `alignNodes` (node-vector cosine) is out
  of scope and unchanged.
- **P6 — DEFERRED (the companion).** Dropping the per-search `(COUNT(*), MAX(rowid))` staleness signature
  to a `MAX(rowid)`-only backstop would let an out-of-band DELETE of a non-max-rowid row go undetected
  (a tested guarantee — `resident-cache.test.ts` "reflects a direct DELETE"); a safe O(1) row-count that
  survives out-of-band writes needs a DB-side counter (a trigger = a schema change). So the `COUNT(*)` is
  RETAINED. See the audit report's P6 disposition.

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
  Windows without the privilege). **Symlink-cycle guard (backend audit 2026-06-27, REL-9):** the
  link-following fallback above could recurse forever on a self-referential tree (`a/loop -> ..`),
  so `walk()` now tracks the `realpathSync` of every directory on the *current recursion path* in a
  Set and skips a directory whose real path is already an ancestor. This terminates the cycle while
  keeping every acyclic walk's expansion set byte-identical (a symlink to a *distinct* directory is
  not an ancestor → still followed). Teeth: a junction cycle re-adds the same file 64× without the
  guard, exactly once with it. **SKIPPED — the optional cross-call cache** (reuse the preflight's
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
- **Preview cap stack (backend audit 2026-06-27, REL-5 / MAINT-4).** The preview re-parse formerly
  threaded *none* of the ingest cap stack (only `maxPages`, and only in layout mode), so a pathological
  but already-indexed file (e.g. a 4000-page PDF) could wedge the main process on a "Show more" where
  import would have killed it. Both `extractDocumentPreview` and `extractDocumentPreviewPage` now route
  the re-parse through the **single `parseWithLimits(parser, source, ctx, limits)` decorator** shared
  with the ingest path (`prepareDocument`) — the ONE cap-enforcement point (MAINT-4). It injects
  `maxPages` + `maxInflatedBytes` from the resolved `IngestionLimits` and applies the wall-clock parse
  timeout (audio exempt — its `signal` + the transcriber watchdog bound it instead); the byte ceiling
  stays the ingest path's pre-selection stat (the preview reads the already-import-capped stored copy).
  The ingest path is byte-for-byte unchanged (the decorator injects the same caps it set inline before);
  `ExtractPreviewOptions.limits` is a test seam to dial the caps down.

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
- **ING-6 — flagged, not rewritten** (`doctasks/handlers/shared.ts`; moved there by DX-1, §38). The `materializeDocument` write-temp →
  re-parse → re-embed round-trip is DELIBERATE (it reuses the canonical import path for encryption, FTS,
  citations, and the crash-safe queue-time provenance stamp); documented in a comment so it is not mistaken
  for an oversight.
- **ING-7 — coalesce the re-index status read/write** (`ingestion/index.ts`). The chunk-replace
  transaction read `tree_status` then `extract_status` (two `SELECT`s) and reset each in its own `UPDATE`;
  now one `SELECT` of both + one combined `UPDATE` (four statements → two). The other audit-cited
  per-doc reads in `doctasks/manager.ts` were already single multi-column `SELECT`s — left as-is.
- **ING-8 — async OCR PDF read** (`doctasks/handlers/ocr.ts`; moved there by DX-1, §38). `readStoredPdfBytes` now uses `await readFile`
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
- **FE-3 / FE-5 (renderer tail).** `DocRow` extraction **LANDED** in the full-audit-2026-06-28 **Phase 7
  (PERF-5 Part A)**: a module-level `memo(DocRow)` fed PER-ROW BOOLEANS (`selected`/`menuOpen`) and a
  parent-narrowed `rowTask` (+ a stable `anyTaskActive` boolean), so a 400 ms task-progress tick — or
  opening one row's ⋯ menu, or toggling another row's selection — re-renders ONLY the targeted row, not
  the whole list. The latest-ref `useEventCallback` was extracted to a shared `renderer/lib/` module and
  feeds stable handlers; render-count tests pin the win (teeth: dropping `memo`, or passing the whole
  `selected` Set / `menuOpenId` string, re-renders every row). **PERF-5 Part B (list windowing) — DOCUMENTS
  LIST now DONE** (full-audit-2026-06-29 follow-up **Phase 4 / PERF-2**; see **§36**): the documents list is
  windowed with `@tanstack/react-virtual`, so its DOM + per-row Radix `DropdownMenu.Root` count no longer
  grows linearly with library size. The **chat transcript** half stays deferred as genuinely
  behavior-sensitive (variable-height messages + scroll-to-bottom + find-in-page + StreamAnnouncer); it
  remains the tracked top renderer item. The Composer-`input` move (needs footer handler stabilization
  first) also stays deferred.

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
  hashes are cached by `(path, size, mtime)`: an in-memory map (L1, keyed by absolute path) plus the
  persisted `AppSettings.checksumCache` (L2, injected as a `HashStore`), so an unchanged weight file
  is hashed **once ever**, not once per session. The L2 store keys by the **drive-relative** path
  (forward slashes — CODE-15, full-audit 2026-07-11) so moving the drive between machines (a new
  drive letter / mount point) re-hashes nothing; pre-CODE-15 absolute-key entries are lazily migrated
  on read/write. A size/mtime change re-hashes; the AI Model screen's
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
- **Plain-chat system prompt revised (2026-07-01, owner-approved, supersedes the spec §7.6 wording).**
  From D:\ chat testing: the original `BASE_SYSTEM_PROMPT` (a) had standalone "You do not have internet
  access. / You must not claim to have accessed external services." lines that small local models
  parroted as an offline/no-internet/training-cutoff **disclaimer on almost every answer**, and (b)
  carried **document-grounding** lines ("answer only from the context… / include citations…") that
  leaked into plain chat, so the model **refused general-knowledge questions** and pushed "upload a
  document." Fix: the grounding lines are removed from the base (they already live in full in
  `GROUNDING_RULES`, appended for the grounded path as `GROUNDED_SYSTEM_PROMPT` — so RAG is unchanged),
  and the offline framing is reworked to a single load-bearing guardrail ("never claim to have
  browsed / accessed data you weren't given") plus a positive instruction to **answer general
  questions directly from the model's own knowledge, without per-turn disclaimers**, and to respond in
  the user's language. `GROUNDED_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + GROUNDING_RULES` still governs
  document questions (the later, more-specific rule wins). The frozen spec §7.6 prompt survives only in
  git history (the retired spec — see the retirement legend at the end of this doc); this record
  is the as-built source of truth.
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
  strict role alternation is preserved. **User-first normalization (CB-1, chat-docs audit 2026-07-07):**
  a contiguous tail preserves alternation but NOT first-role parity — an even-length trim can leave an
  assistant-first tail, which strict templates (Mistral-family) `raise_exception` on (HTTP 500) — so in
  the trimmed branch only, `fitMessagesToContext` drops any leading assistant turns to leave the kept
  tail user-first (this also prevents replaying the synthetic compaction pair's ack without its intro);
  the no-trim identity path stays byte-identical (real chats + the compaction pair are user-first, so it
  pops nothing). A `CHAT_RESPONSE_RESERVE_TOKENS` (1024) headroom leaves
  room to generate. `buildChatMessages`/`buildGroundedChatMessages` take an optional
  `contextTokens` (the production callers pass `effectiveContextWindow(runtime, getSettings(db))` —
  the LAUNCHED `--ctx-size` the runtime reports (§L0), settings only as the fallback; omitted = the
  pure, untrimmed builder used by unit tests) (D-1, chat-docs audit 2026-07-07). **Per-turn read hygiene (CB-6, 2026-07-07):**
  `buildTurnFence` sizes the skill fence against just the final turn via a `LIMIT 1` `getLatestMessage`
  (a byte-identical twin of `listMessages(...).at(-1)`) instead of paging the whole history, and
  `generateAssistantMessage` reads `getSettings` **once** per turn, threading the launched window and the
  `chatCompactionEnabled` toggle (new optional `compactionOn` param on `buildChatMessages`, default = a
  fresh read so callers stay byte-identical) rather than re-reading settings three times. This complements the doc-task window budgets
  (`doctasks/summary.ts`), which already sized their inputs to `contextTokens` — the gap was
  only the conversational path. **Since 2026-07-04** the doc-task budgets follow the LAUNCHED
  window too (`DocTaskManager.getContextTokens` → `effectiveContextWindow` of the active runtime),
  so no area budgets against a different context size than the one the sidecar runs with; the
  user can change that size via `settings.contextTokensOverride` (AI Model screen "Context size"
  card, applied at the next model start — rag-design §15.8). **German subword safety (2026-07-01):** `messageTokens` scales the
  1.3 base word rate by `CHAT_TOKENS_PER_WORD_SAFETY` (1.5 → ≈1.95 real tokens/word) because a
  German machine reply tokenizes at ~1.5–2 tokens/word; the 1.3 base under-counted it, so the trim
  kept too much history and the answer overflowed. Mirrors the RAG ÷1.5 German safety (rag-design
  §15.1); one estimate feeds both the trim budget AND the usage meter, so German trims/compacts
  sooner and the meter reads truthfully high (English reads slightly high — accepted, the meter is
  labelled approximate).
- **Conversation compaction (L2, above the L1 floor).** When history approaches the **launched** context
  window (`RuntimeStatus.contextWindow?` / `effectiveContextWindow`, not `settings.contextTokens`),
  `ensureCompacted` (`services/chat/compaction.ts`) summarizes the OLDER turns **once** into a cached
  `kind='compaction'` checkpoint row and assembly thereafter replays a synthetic `user→assistant` summary
  pair + only the post-checkpoint turns — instead of silently dropping the oldest. `fitMessagesToContext`
  still runs after and still guarantees fit; below threshold (or with the `chatCompactionEnabled` setting
  off) behaviour is byte-identical to drop-oldest. **CB-3 (chat-docs audit 2026-07-07):** the trigger is
  capped at L1's own floor — `min(COMPACT_THRESHOLD·window, window − CHAT_RESPONSE_RESERVE_TOKENS)` — so a
  SMALL window (2048/4096) compacts BEFORE L1 silently drops the oldest turns (the crossover is window
  ≈ 6827: windows ≥ that keep the exact `0.85·window` trigger, byte-identical). The pre-pass estimate also
  folds in the previously-omitted fixed costs — the real `compactionSummaryPair` intro/ack text, the base
  system prompt, and the pre-sized skill fence (passed as `reservedTokens`; `generateAssistantMessage`
  builds the fence BEFORE `ensureCompacted`, free since `buildTurnFence` has no checkpoint dependency). Every new path fails safe (any summarizer failure ⇒ no
  checkpoint, turn proceeds). UX: a composer context-usage meter (now with an **always-visible %** that
  updates **live** as the answer streams — `ChatScreen` `liveUsage` = resting read + in-flight user turn +
  streaming-answer estimate, reconciled to the main-process resting read when the turn settles; since
  2026-07-04 the in-flight base is the **REAL assembled prompt usage** reported by the generators over the
  ephemeral `STREAM.usage` channel, so a document turn's injected excerpt block — invisible to any
  renderer estimate — reads true, rag-design §15.8), a one-shot
  "summarizing…" notice (`STREAM.compaction`), and an expandable transcript summary marker. Full design
  record (L0/L1/L2 + trigger + summarizer + UX, with the deferred Phase-3 `/tokenize`):
  [`rag-design.md`](rag-design.md) §15.
- **Honest truncation signal (L0, 2026-07-01).** The balanced/deep chat path sends no `max_tokens`, so a
  long reply on a small window can hit the context ceiling and stop **mid-word** (`finish_reason: 'length'`).
  Previously the app was blind to it — the SSE parser only read `delta.content`, so the partial persisted as
  if complete. Now `readChatSSE`/`parseSseLine` surface `finish_reason` via a new `RuntimeChatOptions.onFinish`
  callback; `generateAssistantMessage` flags `finishReason === 'length'` and persists it as `messages.truncated`
  (additive nullable column; threaded through `Message`, `appendMessage`, and the regenerate delete/restore
  snapshot). The transcript renders a quiet amber "Reply cut off — reached the model's context limit" note
  (`.msg-truncated`, `chat.truncated.*`) with an actionable tooltip. A user Stop carries no finish reason, so
  the intentional partial is **not** flagged. **Since 2026-07-04** (rag-design §15.8) the grounded
  doc-answer paths (`generateGroundedAnswer`/`generateGroundedDataAnswer`) stamp the same flag — a
  budget-filling document turn is where the ceiling actually hits — and a `'length'` that came from a
  `max_tokens` CAP (Fast mode's 1024) is **no longer flagged**: the badge claims "context limit", and a
  capped reply at single-digit meter usage wearing it was a false "context is full" signal.
- **First-answer warm-up hint (#39, 2026-07-09).** The first generation after a model start/switch
  pays one-time costs (weights into memory + the long system-prompt prefill that `cache_prompt: true`
  then reuses — dramatic on CPU-pinned sessions); the sidecar already budgets for it internally
  (`PREFILL_IDLE_MS` ≫ `STREAM_IDLE_MS`) but the user previously got no equivalent signal. Now a new
  optional `ModelRuntime.warmedUp()` (implemented by `LadderRuntime` + `MockRuntime`, flipped on the
  first streamed chunk of any real generation — answer token or reasoning delta) rides
  `RuntimeManager.status()` as `RuntimeStatus.warmedUp`; the ChatScreen arms a per-turn
  `WARMUP_HINT_DELAY_MS` (3 s) timer and, only if the turn has streamed NOTHING by then AND a fresh
  status read says `warmedUp === false`, shows the calm `.chat-warmup-hint` line under the pending
  bubble ("the first answer takes a little longer — the model is warming up"), dropped on the first
  chunk / turn end. Deterministic no-model answers (routing/refusal/listing) never call `chatStream`
  and stream instantly, so they neither mark the runtime warm nor show the hint; an absent field
  fails safe. Design record: design-guidelines §11.11. Tests: `ChatWarmupHint.test.tsx` + the
  `warm-up tracking (#39)` block in `runtime-ladder.test.ts`.
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
- **Regenerate is delete-after-slot (F2, post-merge audit 2026-06-29).** "Regenerate" re-answers the
  last user turn by dropping the previous assistant reply. The destructive delete must NOT commit
  before the stream slot is claimed: `node:sqlite` is synchronous, so a pre-slot
  `deleteLastAssistantMessage` was durable the instant it ran, and any non-abort failure between it
  and the first persisted token — `acquireSlot` rejecting, a sidecar that died mid-session, or (most
  reachably) an `exceed_context_size_error` HTTP 400 because regenerate replays the full history near
  the window — left the turn **answer-less and irrecoverable**. The IPC layer now only does the
  read-only `hasRegenerableAssistantReply` precondition (the unchanged "nothing to regenerate" bail)
  **before** the stream; the delete itself runs **inside** `withChatStream`'s `runFn` via
  `withRegenerateGuard` (`ipc/chat-stream.ts`) — after the slot is held + the controller registered —
  and the snapshot it returns is **re-inserted byte-faithfully** (`restoreMessage`: same id, timestamp,
  citations, coverage, skill stamp) if generation fails for a NON-abort reason. A user Stop (abort)
  keeps the delete (the new partial/empty reply stands). Applied symmetrically to **both** channels —
  `registerChatIpc` (`generateAssistantMessage`) and every `registerRagIpc` `withChatStream` site
  (grounded / whole-doc / compare / exhaustive-run / listing / refusal). The slot/stream semantics are
  otherwise identical; the only change is WHEN the regenerate delete runs.
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
- **Cancellation.** Each in-flight send holds an `AbortController` in the per-conversation
  `inFlightStreams` map in **`ipc/inflight.ts`** (shared by the chat AND RAG channels, not
  `registerChatIpc.ts`); `stopGeneration(conversationId)` aborts it. The runtime's
  `chatStream` honours `options.signal` and stops emitting; whatever streamed so far is persisted
  as the (partial) assistant message and a normal `done` is emitted (D-3, chat-docs audit 2026-07-07).
- **Chat backend robustness (CB-2…CB-5, CB-7 — chat-docs audit 2026-07-07).** A backend sweep of the
  streaming/cancellation path (ledger + `CB-n` disposition in §45; the audit/plan were retired there):
  - **Deterministic teardown (R1).** `withChatStream` publishes a per-stream `streamSettled` promise
    (in `ipc/inflight.ts`) that **resolves — never rejects** — in its `finally`, AFTER `runFn` (and thus
    its abort-driven `appendMessage`) has fully unwound. A lock/quit teardown MUST therefore `abort()`
    every in-flight controller FIRST, then `await` all settles (`awaitInFlightStreamsSettled`), then
    close the DB — so a partial reply persists before `ctx.db` closes (never rejected, so `allSettled`
    can't hang teardown). Covered by `tests/integration/lock-stream-persistence.test.ts`.
  - **CB-2 — regenerate never loses the prior answer on a produced-nothing run.** `withRegenerateGuard`
    deletes the prior reply INSIDE the stream (F2). A user Stop BEFORE the first token *resolves* (does
    not throw) with an unpersisted empty message (`content === ''`), so besides restoring on a non-abort
    throw the guard now also restores on that empty resolve — `restoreMessage` re-inserts the original
    id/timestamp (no duplicate) and `getLatestMessage` returns it so `chat:done` re-shows the answer.
    Two clicks (Regenerate, Stop) no longer silently erase a reply.
  - **CB-4 — a completed-but-empty completion surfaces an error, not a silent blank.** The
    `content === ''` early return is narrowed: a stop-before-first-token OR an all-`<think>`/fence-echo
    reply that stripped to empty (tokens arrived — `receivedAnyToken`) stays the benign silent-empty;
    only a COMPLETED, non-aborted stream that produced zero tokens throws `EmptyCompletionError`.
  - **CB-5 — a hung sidecar aborts with a distinct error instead of wedging.** `readChatSSE` races each
    `reader.read()` against a two-phase idle watchdog (`PREFILL_IDLE_MS` 120 s until the first chunk —
    a near-window regenerate prefill is legitimately slow — then `STREAM_IDLE_MS` 30 s between chunks;
    reasoning deltas count as chunks; `idle` is injectable, the production default keeps live streams
    byte-identical). A timeout cancels the reader and rejects `RuntimeUnresponsiveError`; a user Stop
    (signal abort) still wins first, so a hang is never converted to an abort (the partial persists as
    today) or vice-versa. **Scope:** post-response streaming only — a hang in the initial `server.fetch`
    is a separate seam, deferred.
  - **Friendly-error chain** in `withChatStream` (rethrow-friendly, mapped copy on BOTH the `chat:error`
    event and the invoke rejection): `RuntimeUnresponsiveError` → `main.chat.runtimeUnresponsive`,
    `EmptyCompletionError` → `main.chat.emptyCompletion`, overflow → `main.model.contextExceeded`, else
    raw. Composition: CB-2+CB-4 (a regenerate that produces nothing never loses the prior answer, whether
    it stops or completes empty); CB-3+CB-6 (the fence reorder supplies the compaction pre-pass's
    `reservedTokens`).
  - **CB-7 (per-token IPC batching) — DEFERRED.** The renderer already coalesces re-renders (the
    `ChatScreen` flush timer); the only residual cost is a structured-clone of a short string, and
    batching would add a lifecycle seam to the most safety-sensitive path (`streamSettled` teardown) for
    a negligible, unmeasured gain. Revisit only if profiling shows contextBridge volume is a real
    bottleneck.
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
  **Re-selecting the streaming conversation on remount (2026-07-01).** The poll above only re-attaches
  when the visible `activeId` already points at the streaming conversation — but a fresh mount resets
  `activeId` to `null` (it was never persisted), so on return the screen showed an empty *new* chat
  while the reply streamed invisibly (and, since the one-stream guard is per-conversation, that empty
  conversation would even accept another turn). The Chat screen now, on mount with `activeId` still
  null, calls the read-only `listActiveStreamConversations` IPC (`[...inFlightStreams.keys()]`,
  in-memory + workspace-agnostic like `getActiveStream`) and, if a generation is in flight, selects
  that conversation (most-recent = last key) and mirrors its mode — the existing recovery poll then
  re-attaches. Guarded so it never clobbers a deliberate mid-load click and never yanks the user onto
  an old conversation when nothing is generating.
- **FE audit 2026-07-07 — Chat renderer correctness (CR-1…CR-9).** A renderer-side sweep of
  `ChatScreen.tsx` + `Transcript.tsx` (ledger + per-finding `CR-n` disposition in §45, where the audit
  and plan were retired) hardened the send/switch/stop paths without adding an unstable prop
  to a memoized child on the keystroke/flush hot path. The load-bearing decisions:
  - **CR-2 (transcript scroll bleed) — `key={activeId ?? 'new'}` on the `Transcript` instance, NOT a
    reset-on-effect.** A fresh instance per conversation resets `atBottomRef` + DOM `scrollTop` and the
    mount scroll effect re-pins to the newest message. Keying on `activeId` (not `messages`) is
    decisive: an intra-conversation `refreshIfVisible` and a streaming reattach keep `activeId` stable
    → the key is stable → `React.memo` still skips the transcript on the hot path; only a genuine switch
    (rare) pays the remount. Keying on `messages` would remount on every flush and defeat the memo.
  - **CR-9 (Stop target) — `onStop` targets `streamConvId ?? activeId`; latent hardening, byte-equivalent
    today.** Reachability: `ConversationList` disables every non-active row while streaming
    (`disabled={streaming && !active}`, fed `streaming={busyStreaming}`), and every `activeId`-mutating
    path is `busyStreaming`-guarded, so the Composer's Stop only ever renders in a state where
    `streamConvId === activeId` (local OR recovered stream). The one-line change future-proofs Stop if a
    later change relaxes the disabled-row guard — **that guard must not be relaxed without re-checking
    `onStop`.** `ChatSwitchStop.test.tsx` (T-2) pins the disabled-row invariant so it reddens first.
  - **CR-1 (draft loss) — restore into a still-empty composer, only when the user turn did not persist.**
    `stream` reports persistence from its post-failure `listMessages` (no new IPC); `onSend` restores
    with a `cur === ''` guard (newer in-flight typing wins) so a routine pre-persist reject
    (DOC_TASK_BUSY / no model / slot held) never eats a typed question, while a stopped-partial /
    errored-after-persist turn does not duplicate. **CR-4** confirms a *recovered* stop in the recovery
    tick's completed branch (no local `stream()` finally there — M-U2 parity). **CR-5** branches the send
    on the conversation's own mode (`conversations.find(...)?.mode ?? mode`) so a reattach that failed to
    mirror `mode` still routes a documents send through `askDocuments`. **CR-6/CR-7** clear the error
    banner on `activeId` change (effect ordered before the history load) and add the sibling
    `activeIdRef.current === convId` stale-response guard to the three switch-time loads. **CR-8** drops
    `depths['new']` in `ensureConversation` (SKA-18 parity — a 'new'-composer depth pick must not become
    every later new chat's default). Tests with teeth: `ChatStreamRecovery.test.tsx` (T-1: recovery
    bubble + CR-4 stop + CR-5 routing + re-select guards), `ChatSendFailure.test.tsx` (CR-1 + CR-2),
    `ChatSwitchStop.test.tsx` (T-2). **CR-10** (transcript windowing) stays the accepted PERF-2 chat
    half; **CB-\*/DB-\*** findings are other sessions of the same wave.
- **FE audit 2026-07-07 — Documents renderer polish (DR-1…DR-9).** The Documents half of the same
  sweep (`DocumentsScreen.tsx` + `screens/documents/{DocRow,SectionRail,format}.tsx`; ledger +
  `DR-n` disposition in §45, where the audit and plan were retired). Two of the nine *tighten*
  invariants rather than merely patch: **DR-4**
  replaces the screen-global `previewLoading` boolean (which flipped a memo-busting prop on *every*
  windowed `DocRow` twice per preview) with a per-row `previewLoadingId === d.id` — the clicked row
  gets `true`, every other row a stable `false`, so `DocRow.memo` now *holds* on a preview open
  (`DocumentsScreenPolish.test.tsx` asserts row B's render-count delta is 0; DocRow's boolean prop is
  unchanged). **DR-2** funnels every `refresh()` caller (poll tick, toolbar, `run`, mount) through one
  monotonic `refreshSeq` choke point — an older `listDocuments` snapshot can no longer clobber a newer
  one and stick once the poll interval clears, *reducing* spurious full-list swaps (revert-confirmed
  teeth). The rest: **DR-1** the preview "Show more" updater returns `cur` (not `next`) on
  id-mismatch/closed-modal so a late page can't resurrect a closed modal or clobber a doc-task's
  auto-opened preview (revert-confirmed); **DR-3** the toolbar Refresh `onClick` catches the rejection
  into the banner (every other call site already did); **DR-5** Import is gated on `busy !== null`
  (all four buttons) so a concurrent bulk re-index can't fight the single `busy` scalar — main-side
  job exclusivity stays the correctness backstop, the label still keys on `'import'`; **DR-6** archived
  projects get the `active` class + `aria-current` (mirroring active projects) so a selected archived
  section is visible to the user and screen readers; **DR-7** a failed doc-task's persist-canonical
  error runs through `localizeServerCopy` so the de-AT UI stops leaking raw English; **DR-8** a
  first-mount `role="status"` spinner (new `docs.loading` key, both locales) fills the `docs === null`
  gap that used to render blank; **DR-9** `formatSize` gains a GB tier (locale decimal unchanged). All
  additive/renderer-only; the FE-4 `mountedRef` setState-after-unmount guards and the PERF-2 windowing
  path are untouched. **CB-\*/DB-\*** are other sessions of the wave.
- **`MockRuntime.chatStream`** emits a deterministic reply token-by-token with a small delay so
  the renderer's streaming + stop path is exercised with zero model files. The real
  `LlamaRuntime` (Phase 10) swaps in behind the same `ModelRuntime` interface.
- **Markdown rendering (post-MVP).** Assistant replies (persisted and streaming) render as
  GitHub-flavored Markdown + KaTeX math via **Streamdown** (`@streamdown/math`), a streaming-aware
  drop-in for react-markdown — local models emit Markdown, and raw `**asterisks**` read as broken
  output. Streamdown builds React elements (no `innerHTML`). Its rehype chain is pared to
  `rehype-sanitize` only (we drop `rehype-raw` so model HTML renders as literal text — the no-injection
  posture is unchanged — and drop `rehype-harden` as redundant under the CSP + the link gate below).
  The app ships no Tailwind, so Streamdown's one non-semantic element — `**bold**` as a styled
  `<span>` — is mapped back to `<strong>`; every other element is already semantic and styled by the
  existing `.md` CSS. The `components`/plugin objects are **module-level** in `Transcript.tsx` so their
  references stay stable across the ~40 ms flush — an inline object would defeat Streamdown's block
  memoization (see FE-1, measured). Links are whitelisted to http(s) and get `target="_blank"` so the
  main process's window-open handler routes them to the OS browser and denies everything else. **User
  turns stay plain text** — they are not Markdown and must not be reinterpreted.
  - **KaTeX math — a deliberate win for tax / finance / accounting users.** The whole point of an
    offline local-LLM workspace for a tax professional is to reason over numbers: effective rates,
    depreciation schedules, apportionment, `$$r = \frac{tax}{base}$$`-style formulae. Before this,
    a model that emitted LaTeX math showed raw `\frac{…}{…}` noise; KaTeX now renders it as typeset
    math inline in the answer, persisted and live. Fonts bundle as **local assets**
    (`out/renderer/assets/KaTeX_*.woff2/ttf`) so it stays fully offline under `font-src 'self'` — no
    CDN, consistent with the no-cloud rule. Delimiters are block `$$…$$` / `\(…\)` / `\[…\]`, **not**
    single `$`, so prose like "owes $5 and $10" is never mangled into math.
- **Runtime requirement (decision).** `sendChatMessage` does **not** auto-start a runtime: a chat
  needs a started model (`RuntimeManager.start()`). With no active runtime the handler throws and
  the Chat screen shows a "start a model" empty state that links to Models (and polls
  `getRuntimeStatus` so it flips to the composer by itself once the background auto-start — see the
  Models section — finishes loading). Rationale: starting the real llama.cpp sidecar mid-request is
  heavy and surprising; the startup auto-start is a deliberate, bounded exception that reuses the
  same gated start path.
- **IPC** (`ipc/registerChatIpc.ts`). **Single source of truth: the chat group in
  [`shared/ipc.ts`](../apps/desktop/src/shared/ipc.ts)** — enumerate there, not here, so a new channel
  can't leave this list stale (D-6, Chat & Documents audit 2026-07-07). The notable families:
  **conversation lifecycle** (`createConversation`, `listConversations`, `listMessages`,
  `deleteConversation`, `searchConversations` — Phase 31 full-text); **streaming** (`sendChatMessage`,
  `stopGeneration`, `getActiveStream` + `listActiveStreamConversations` for stream recovery /
  re-selecting the in-flight conversation after navigation); **scope / anchor** (`updateConversationScope`,
  `setConversationScope`, `setConversationCollection`, `setConversationDefaultSkill`); **attachments /
  context** (`listAttachments`, `getConversationContextUsage`, `getConversationSummary`); and **export**
  (`exportConversation`, `exportMessageTable`). Note `suggestSkills` appears in this group in
  `shared/ipc.ts` but is registered by the **skills** IPC (`registerSkillsIpc`), not here. Regenerate reuses
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
  `.parse-preview-<uuid>` working file and shredded on the way out (covered by the startup `.parse*`
  crash sweep); the original bytes are never handed to an external viewer, which is why this is an
  in-app TEXT preview and not a `shell.openPath`. **The transient name carries a per-call `randomUUID()`
  infix (DB-2, Chat & Documents audit 2026-07-07):** the same helper is shared by the preview IPC,
  `buildDocumentSegmentReader`, and `extractSegmentTexts`, so a deterministic `<id>.parse-preview` path
  let two concurrent same-doc reads decrypt into and `shredFile` the SAME file — each shredding the
  other's parse. The uniqueness closes that race; the `.parse` infix keeps the crash sweep covering a
  leak. The two export readers (`.parse-export-<uuid>`, `.parse-export-bin-<uuid>`) got the same fix.
- **IPC** (`ipc/registerDocsIpc.ts`). **Single source of truth: the docs group in
  [`shared/ipc.ts`](../apps/desktop/src/shared/ipc.ts)** — enumerate there, not here, so a new channel
  can't leave this list stale (D-5, Chat & Documents audit 2026-07-07). The notable families:
  **import** (`pickDocuments` → `importDocuments` → `getImportJob`, plus `importPreflight`, the
  Phase-36 size-aware audio confirm); **listing + lifecycle** (`listDocuments`, `deleteDocument`,
  `setDocumentLifecycle`, `addToCollection`/`removeFromCollection`); **single + bulk re-index**
  (`reindexDocument`; `startReindexAll`/`getReindexAllJob`/`cancelReindexAll`); **bounded preview**
  (`previewDocument`, `previewDocumentPage`); and **export** (`exportDocument`, `exportSummary`).
  See the "Document organization" §5 IPC table; full pipeline detail lives in
  [`rag-design.md`](rag-design.md).

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
- **Cancellation & watchdog (backend audit 2026-06-27, REL-1/REL-6).** Audio is EXEMPT
  from the wall-clock `withParseTimeout` (a long recording legitimately transcribes for
  many minutes), so two mechanisms bound a wedged/cancelled child instead: **(1) an
  inactivity watchdog** in `run()` — whisper emits `-pp` progress continuously, so the
  watchdog is reset on every stdout/stderr chunk and only fires when the child has been
  completely silent for `idleTimeoutMs` (default 15 min, `HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS`),
  distinguishing a spinning/hung child (no output → killed + rejected) from a slow-but-
  advancing one (keeps resetting); **(2) a real `AbortSignal`** now threaded end-to-end
  (`IngestionDeps.signal` → `ParseContext.signal` → `AudioParser` → `transcribe`), so the
  import loop aborts the in-flight transcription the moment the workspace locks mid-job
  (`registerDocsIpc` per-job `AbortController`; belt-and-suspenders with `suspend()`). The
  previously-dead abort listener in `run()` is now armed. **REL-6:** `TranscribeOptions.workDir`
  is now **required** (no OS-tmpdir default) — the transient transcript is recognised speech
  (content) and must stay inside the `.parse` crash sweep; an empty `workDir` fails closed
  before any spawn. The watchdog/timeout errors carry only durations, never any transcript.
  **SIGKILL escalation (full-audit 2026-06-29, REL-2):** the watchdog, the abort handler, and
  `suspend()`/`stop()` previously sent a bare `child.kill()` (SIGTERM) and waited on `close` —
  with no escalation. A `whisper-cli` wedged in native decode code that ignores SIGTERM never
  emits `close`, so the watchdog "fired" but the slot stayed held, and `suspend()`/`stop()`
  (on lock/quit) `await`ed an exit that never came — hanging teardown indefinitely with the
  transient still on disk. All three kill sites now route through `killWithEscalation`, which
  mirrors `LlamaServer.stop()`: SIGTERM, then **SIGKILL after `killGraceMs`** (default 2 s) if
  the child hasn't gone (grace timer `unref`'d + cleared on a clean exit). And `suspend()`/`stop()`
  **bound** their cleanup `await` with `suspendTimeoutMs` (default 10 s) so a child that ignores
  even SIGKILL can't hang quit/lock — past the cap the `.parse` crash-sweep is the shred backstop.
- **`AudioParser` implements `DocumentParser`.** `parse(filePath, ctx)` uses the
  transcriber injected per call via the ADDITIVE `ParseContext` (carried from
  `IngestionDeps.transcriber` — the embedder-injection precedent; text parsers ignore
  it). Whisper segments are **packed** into paragraph-sized `ExtractedSegment`s
  (~180-token target, hard cap `AUDIO_SEGMENT_MAX_TOKENS` = `chunkSizeTokens − 100` = 400,
  a margin below the 500-token chunk window) labeled `sectionLabel: "mm:ss–mm:ss"`
  (`h:mm:ss` above an hour) — D29: the time range rides the EXISTING `Citation.section`,
  zero citation-path changes. The cap is measured in **approx-tokens** (`approxTokenCount`,
  CJK/Thai-aware), NOT whitespace words (RAG-N1, full audit 2026-06-28 Phase 4): a space-less
  phrase is a few "words" but hundreds of tokens, so a word cap let an audio segment overflow
  the window and the chunker then windowed+overlapped it. Packing matters twice: distinct
  labels never coalesce in the chunker (raw whisper segments would mean thousands of tiny
  chunks), and the ≤`AUDIO_SEGMENT_MAX_TOKENS` cap makes **each audio chunk one packed
  segment, verbatim, no overlap** — so reconstruction has **no duplicated/dropped spans** —
  which is why `extractDocumentPreview` (and through it translate/compare re-extraction) reads
  audio text from the STORED CHUNKS instead of re-transcribing for minutes. (Exception: the rare
  oversize-single-segment split re-coalesces and may normalize a piece boundary to one whitespace
  — never a dup/loss; see `rag-design.md` §2 "Audio packing" / §3 windowing.)
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
- **Concurrency & timeout (backend audit 2026-06-27, REL-3).** whisper is not internally
  serialized, so the handler holds a **single-flight guard**: a second `dictation:transcribe`
  while one is in flight is rejected with friendly copy (`DICTATION_BUSY_MESSAGE`) BEFORE it
  writes the temp WAV or spawns — rapid mic presses can't double-spawn. A **wall-clock
  ceiling** (`maxDurationMs`, default 10 min, `HILBERTRAUM_DICTATION_TIMEOUT_MS`) drives an
  `AbortController` whose signal is passed to `transcribe` — a wedged child is killed and the
  mic spinner gets the friendly failure instead of hanging forever. The temp WAV is shredded
  in `finally` on every path (success, refusal, timeout).
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
- **Per-page timeout & recovery (backend audit 2026-06-27, REL-2).** A tesseract.js WASM
  job is **not cooperatively cancellable** and recognitions are serialized through one
  worker chain, so one crafted/huge image could wedge OCR for the whole session and Cancel
  only landed between pages. `recognize()` now races `worker.recognize` against a per-page
  timeout (`recognizeTimeoutMs`, default 2 min, `HILBERTRAUM_OCR_PAGE_TIMEOUT_MS`) **and**
  the abort signal; on timeout OR mid-page abort the only real recovery is to `terminate()`
  the worker (cleared → recreated lazily) and reject — which frees the serialized chain so
  the next page proceeds with a fresh worker. A plain recognition error still leaves the
  worker intact (unchanged). The OCR document task surfaces a timed-out page as a friendly
  task failure (the recognition stays unpersisted; Cancel/redo unchanged).
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
  `doctasks/` directory, with the **manager keeping the pump and the handlers owning each kind**
  (DX-1, full-audit-2026-06-29 follow-up Phase 8 — see §38; the earlier audit-M-A4 split first
  carved the window-math siblings out of the monolith). `manager.ts` (the `DocTaskManager`)
  keeps ONLY the queue/pump + arbiter handshake + the `generate` model loop,
  and dispatches each dequeued job via `MODEL_TASK_HANDLERS[kind](task, runtime, ctx)` —
  except `ocr`/`categorize` (no/optional runtime) and, since TG-3, `translation` (dispatched
  directly with the `Translator`; its sidecar-shaped window retry lives in its handler). Each
  kind's actual work lives in its own `handlers/` module: `handlers/index.ts` (the
  `MODEL_TASK_HANDLERS` registry + the `ocr`/`categorize`/`translation` exports), `handlers/shared.ts` (the
  shared doc helpers `materializeDocument`/`buildProvenance`/`extractSegmentTexts`), and one file
  per kind — `tree.ts` (deep index + `extract`), `summary.ts`, `ocr.ts`, `translation.ts`,
  `compare.ts`, `categorize.ts`. The window-math/prompt siblings `summary.ts`/`translation.ts`/
  `compare.ts` at the `doctasks/` root stay (the PURE math + templates each handler calls).
  `context.ts` is the leaf vocabulary module: `DocTaskDeps` (the injected seams, re-exported from
  `manager.ts` for the barrel), `InternalTask` (the in-flight job), and `DocTaskCtx` — the narrow
  orchestration handle (`deps` + the model-slot `arbiter` + the `generate` model-loop fn) the manager
  hands each handler so a `run<Kind>` body calls the shared model loop without a `this` reference.
  A job state machine on the Phase-4/18 async-with-polling precedent:
  `startDocTask({ kind, documentIds, params }) → { jobId }`,
  `getDocTask(jobId) → { state, progress { stepsDone, stepsTotal }, error?, resultRef? }`,
  `cancelDocTask(jobId?)`. States: `queued → running → done | failed | cancelled`; unknown
  job ids report a terminal status so pollers always stop. **Seven `DocTaskKind`s** (`shared/
  types.ts`) run on the one machine: `summary` (Phase 33), `translation` (Phase 34), `compare`
  (Phase 35 — exactly TWO distinct source documents; the others take one), `ocr` (Phase 38), the
  two whole-document-analysis builds `tree` (deep index) and `extract` (structured extract), and
  `categorize` (the bank-statement LLM categorizer, D26). Deps are injected (`getDb`,
  `getRuntime`, `getTranslator` — the TranslateGemma sidecar, TG-3 —, `isChatStreaming`,
  `getContextTokens`, `getStoreDir`, `getIngestionDeps`, `beginDocumentWork`, `getOcrEngine`,
  `rasterizePdf`, `audit`), so the engine tests without Electron; `main/index.ts` wires it and
  exposes it as `AppContext.docTasks`.
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
  in-session — so chat is not refused during a deep-index/extract build (rag-design §14.3).
  **Abort-aware handoff (full-audit 2026-06-29, REL-3):** the builder parks only *between*
  `generate` calls, and a single node's `generate` is a multi-second CPU summarization. Before
  the fix `acquireForChat` had no `signal`, so a user "Stop" landing while a chat was parked
  waiting for the handoff aborted a controller nobody was watching — "Stop" appeared dead for up
  to one tree-node. The chat turn's `AbortController.signal` is now threaded
  `withChatStream → acquireChatSlot → acquireForChat`: an abort during the park rejects the wait
  at once (removing the waiter from the queue and giving back its holder slot, and dropping the
  pause when it was the last waiter — so the builder doesn't park for a chat that's gone).
  `withChatStream` treats that rejection like a no-token Stop: it resolves cleanly via `done`
  with an empty message rather than surfacing `chat:error`. The **R-T1 probe**
  (`tests/manual/server-concurrency-probe.test.ts`, `HILBERTRAUM_CONCURRENCY_PROBE`) showed the
  pinned b9585 would serve two requests on PARALLEL slots at our default args — the
  app-side guard is the only serialization, which is exactly why it exists.
- **Tasks call the active chat runtime** over the locked `chatStream` contract with
  EXPLICIT `maxTokens`/`temperature` — never the answer-depth modes. No runtime running →
  a friendly "start a model first" refusal, never an auto-start (the `sendChatMessage`
  decision). Failures surface friendly §11.4 copy; the raw reason goes to the local log
  only. Cancellation never persists a partial result (chat keeps partials; tasks do not).
  **Exception since TG-3: `translation` runs on the TranslateGemma sidecar**
  (`DocTaskDeps.getTranslator`, see the design record below) — the chat runtime is
  irrelevant to it; an absent translator refuses with `main.translation.noModel` (a deep
  link to the AI Model screen in the UI). The FIFO + chat↔task exclusion apply unchanged
  (plan D9: RAM co-residency — a ~9.5 GiB translate next to a resident chat model).
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
- **Translation (Phase 34, D27/D36; rerouted onto the TranslateGemma sidecar at TG-3): map
  in document order, materialize a NEW document.** `params.sourceLang`/`params.targetLang`
  over the curated 10-language set (widened to 51 by issue #31 — see D5/#31b)
  (`TRANSLATION_LANGUAGE_CODES`, `shared/types.ts` — the
  canonical list the sidecar prompt builder also keys off; validated server-side, source ≠
  target; TranslateGemma needs an explicit source — no auto-detect). **D36 — the input is
  the parser's SEGMENTS, re-extracted from the stored copy via `extractDocumentPreview`,
  NOT the stored chunks:** chunks overlap by ~80 tokens for retrieval, and naive in-order
  chunk concatenation would duplicate text at every boundary in the translated output (a
  summary tolerated that; a faithful translation cannot). The segments are ordered,
  non-overlapping, and exact; the cost is one re-parse — the same cost the in-app preview
  pays, on the same code path (encrypted copies decrypt to a `.parse*` transient and are
  shredded). Overlap-trimming adjacent chunks was rejected as heuristic where the re-parse
  is exact. Windows budget against the SIDECAR's launched `--ctx-size`
  (`Translator.contextWindow()`, 4096 from the manifest) — not the chat window — split by
  **measured token weight** (R-T2: input 1.3 tokens/word, output 2.0; measured on
  Qwen3-4B, kept as conservative defaults until TG-6 re-measures on the Gemma tokenizer)
  and hard-clamped to the model card's ~2K input spec
  (`TRANSLATION_MAX_INPUT_TOKENS = 1800`, plan D4 — over-chunking is the failure mode,
  never overflow). **No window ceiling and no reduce** — a faithful translation may not
  silently truncate; windows are `translator.translate()` calls in order, strictly
  SEQUENTIAL (plan D9 — one `--parallel 1` slot; parallel requests are the #25142
  Windows-Vulkan hang shape); the trained prompt lives INSIDE the sidecar
  (`services/translation/prompt.ts`, greedy temperature 0) — no app-side system/window
  prompts remain. A window the model refuses/garbles is retried ONCE (the sidecar-shaped
  retry lives in `handlers/translation.ts`), then **marked visibly** in the output with
  the original text kept below — never silently dropped; only an all-windows failure fails
  the task. Attribution + provenance stamp the TRANSLATION model's id.
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
  "Translate" opens a small modal with SOURCE + TARGET selects over the curated 10
  (widened to 51 by issue #31 — see D5/#31b)
  (native-name labels, untranslated by design — the Settings language-picker precedent;
  the pair is remembered session-local, source ≠ target enforced in UI and server). With
  no translation model installed (`AppStatus.translationAvailable`, read from
  `ctx.translator` like `ocrAvailable`) the Translate item disables and a sibling
  "Get the translation model…" item deep-links to the AI Model screen (plan O2/D3).
  "Compare (2)" appears on the Phase-17 multi-select at exactly two selections. A done summary opens the
  preview (collapsible section, "Generated by <model> · <date>", Regenerate); a done
  translation reveals the new document in the refreshed list with a quiet "Translated
  from <original>" provenance line (row + preview); a done comparison opens the new
  report's preview with its "Comparison of <A> and <B>" line. Both materialized kinds
  offer Export.

## Translation sidecar — design record (TG wave)

_The TranslateGemma translation wave (TG-1…TG-6, 2026-07-05) as built: the `translation` manifest
role + dedicated `llama-server` sidecar, the doc-task reroute, and the Translate view (text +
document drag-and-drop). This is the COMPLETE record — the plan
(`docs/translategemma-translation-plan.md`) was folded here + into `model-policy.md` (role +
license/research) + `model-benchmarks.md` §11 (measurements + promotion bar) and DELETED at TG-6 per
the CLAUDE.md doc-lifecycle rule; the full original is in git history. In-code comments still cite
the plan's `§N` / `DN` / `ON` / `VN` anchors — the **§-anchor legend** at the end of this record
keeps them resolvable (the "Functionality wave 3" precedent)._

- **TA-1 — main-process lifecycle seams: quit + lock flush the whole doc-task pipeline (translation
  audit fix wave, 2026-07-06; findings H1/H2).** Both lifecycle paths now cancel the running
  doc-task **and the queue**, then await the running task's abort-unwind before the DB closes.
  - **H1 (quit).** `performShutdown` (`shutdown.ts`) aborted the deep-index build + the Translate-view
    job but never the doc-task, so on quit mid-translation `translator.stop()` killed the in-flight
    window, retries failed fast against the `stopped` latch, and a task with an already-succeeded
    window proceeded to `materializeDocument` **during teardown** — a half-translated plaintext
    `.parse` transient racing the DB close. Fix: it now calls `ctx.docTasks.cancelAllDocTasks()` in
    the same best-effort block that aborts the build (before the sidecars stop), and awaits
    `awaitActiveTaskSettled()` (bounded ~5 s) next to the in-flight-stream settle, so the abort-unwind's
    materialize/shred finishes while `ctx.db` is open.
  - **H2 (lock).** `registerWorkspaceIpc` called `ctx.docTasks.cancelDocTask()` (active task only). The
    DB stays open while the lock handler awaits the sidecar suspends, so when the cancelled task
    settled `manager.pump()` dequeued the **next queued** translation into the lock window — decrypting
    document text to a `.parse` transient and cold-starting a fresh ~10 GB sidecar that outlived the
    lock (the old comment's "still-queued tasks fail friendly at dequeue" was false *during* the
    handler). Fix: it now calls `cancelAllDocTasks()` (running + queued) and awaits
    `awaitActiveTaskSettled()` before purge/lock, mirroring the stream-settle treatment.
  - **New manager seams.** `DocTaskManager.cancelAllDocTasks()` walks the running id + a queue snapshot
    and reuses the per-id `cancelDocTask` (each queued task → terminal `cancelled`, dequeued
    synchronously — a queued task never reaches `running`), holding **no permanent latch** (`pump` is
    driven per `startDocTask`, so the manager is usable again after unlock). `awaitActiveTaskSettled()`
    exposes the tracked `run(task)` dispatch promise (resolves immediately when idle); the callers bound
    it with a ~5 s `Promise.race` timeout so a wedged handler can never hang quit/lock.

- **TA-2 — renderer session-store purge moved to the real lock seam (translation audit fix wave,
  2026-07-06; finding H3).** The purge of the three module-level renderer stores (the live TEXT
  translation `lib/translateSession.ts`, the DOCUMENT translation `lib/fileTranslateSession.ts`, and
  the vision session `lib/visionSession.ts`) was **dead code**: it lived in per-screen `useEffect`s
  gated on a component-state `locked` flag read from `getAppStatus().workspaceReady`. But screens
  render one-at-a-time and `App.lockNow` swaps the whole shell to `WorkspaceGate` (unmounting every
  screen) the instant `lockWorkspace` resolves, so the effect could never observe `locked === true`.
  The module stores survive the unmount by design (a running job keeps streaming across navigation),
  so the source text, streamed translation, materialized preview, and image/answer stayed resident
  in renderer memory for the whole locked period — contradicting each store's "dropped on lock"
  contract and security-model.md. Fix: a single **`purgeSessionStores()`** helper
  (`renderer/lib/lockPurge.ts`) that calls all three `clear*` functions, invoked from `App.lockNow`
  right after `lockWorkspace()` resolves (next to `setWorkspace`) — the one seam where the lock
  actually happens. A renderer grep confirmed `App.lockNow` is the **only** lock initiator (no
  auto-lock timer, no main-pushed lock event, no workspace-state polling), so the single call
  covers every path; the helper is the extension point if another initiator is ever added. The dead
  `locked` purge effects — and the confirmed-dead `locked` EmptyState branches (their gate,
  `workspaceReady === isUnlocked()`, is the same signal the shell gates the whole screen on, so it
  can never be observed while mounted) — were removed from `TranslateScreen`/`ImagesScreen` rather
  than left as a defense-claiming no-op. Also fixes the stuck-busy shape: a mid-stream text session
  that returned after unlock stuck `translating` (main's `jobs.stop()` emits no `trError`, and
  `adoptActiveJob` early-returned on the still-set `activeJobId`) is now reset by the purge.

- **TA-4 — SSE reader terminal-frame + error-field handling, control-token sanitization (translation
  audit fix wave, 2026-07-06; findings M2/M3/M4/L1/L4).** The raw `/completion` reader
  (`services/translation/completion.ts`) + prompt builder (`prompt.ts`) were hardened against silent
  truncation and control-token forgery.
  - **M2 (sawFinal).** `readCompletionSSE` treated reader `done` with no terminal `stop:true` frame
    as normal termination, so a server-side close mid-decode resolved the accumulated partial as a
    truncated "success" (the view emitted `trDone` with cut text; the doc-task materialized a
    truncated document). It now tracks `sawFinal` and, if the stream ends without it **and the caller
    did not abort**, throws `IncompleteStreamError` (a `CompletionError` subtype — deliberately NOT an
    `AbortError`, so both consumers hit their existing retry/fail paths: the view job → `runtimeFailed`,
    the doc-task `translateWithRetry` → retry-then-fail).
  - **M3 (error-field).** `parseCompletionLine` handled only `data:` lines; llama.cpp can emit a
    mid-stream failure as a bare `error: {…}` SSE **field** line (compounding M2's silent-truncation
    shape). It now recognizes `error:`-prefixed lines (nested `{error:{…}}` or a bare payload) and maps
    them to `CompletionError`; even an unparseable error field is surfaced, never swallowed. The real
    pin's error framing is a manual-smoke TODO (needs drive access — not gating).
  - **M4 (control-token sanitization).** `buildTranslationPrompt` interpolated source text raw, and
    llama-server tokenizes `/completion` prompts WITH special-token parsing — a document containing a
    literal `<start_of_turn>`/`<end_of_turn>` forged a turn boundary (the D2 "translated, never obeyed"
    guarantee only covered plain-text imperatives). `sanitizeSourceText` now rewrites the two Gemma turn
    markers to a visually-identical, non-token spelling using mathematical angle brackets
    (`⟨start_of_turn⟩`/`⟨end_of_turn⟩` — U+27E8/U+27E9): reversible-safe, human-legible, and confined to
    those exact markers so ordinary `<…>` content is untouched. The builder's own scaffold markers are
    appended AFTER the rewrite, so they survive.
  - **L1 (abort throws).** An abort between token deliveries used to end the generator cleanly, letting
    `translate()` resolve partial output (violating the "resolves with the full text" contract; latent
    because both consumers re-check the signal). The reader now throws the abort reason instead of
    returning, matching what an in-`read()` abort already throws.
  - **L4 (garbled-frame counter).** The reader's parse-failure branch only ever swallows a genuinely
    garbled COMPLETE frame (the `\n`-splitter feeds whole lines, so it is never a partial). It now counts
    such frames and logs a single content-free `log.warn('translation SSE: dropped unparseable frame',
    { count })` per stream (the count only, never the frame text — privacy rule). New
    `tests/unit/translation-completion.test.ts` drives the reader directly (scripted `ReadableStream`:
    mid-line splits, CRLF, no-trailing-newline flush, terminal→`onFinal`, both error shapes, M2/L1/L4).

- **TA-5 — limit-stop detection + view-job empty-window retry (translation audit fix wave,
  2026-07-06; findings M6/M7 + test-gap #4).** The final frame's stop reason is now LOAD-BEARING for
  both translation consumers, so an output-limit truncation can no longer masquerade as a clean window.
  - **M6 (limit-stop detection).** The final frame's stop reason was surfaced only as `stoppingWord`
    via `onFinal`, and NEITHER real consumer passed `onFinal` — any non-empty reply counted as a clean
    window, so a greedy-decode repetition loop (the classic temperature-0 MT pathology) or a token-dense
    window running to the ~2,070-token cap was stitched mid-sentence into the persisted document
    silently. `CompletionFinal` gained `stoppedEos` and a shared `isCleanStop(final)` helper (both next
    to it in `completion.ts`): a window is clean iff its final frame carries a non-empty `stopping_word`
    OR the eos flag. Both consumers now thread `onFinal` and reject a non-clean (limit) window as a
    FAILED attempt — the doc-task `translateWithRetry` folds it into the existing retry-then-mark path
    (empty OR truncated → marked window), so `onFinal` threading (the smaller diff, keeps the smoke's
    runtime-layer consumer working) was preferred over resolving `{text, final}`.
  - **M7 (view-job empty/truncated-window retry).** The doc-task's retry-then-mark policy lived only in
    the doc-task handler; the view loop (`jobs.ts`) accepted whatever each `translate()` resolved, so one
    transiently empty (or, post-M6, truncated) window in a multi-window paste completed "done" with a
    silently missing/cut paragraph. The view loop now retries such a window ONCE and, if it still fails,
    fails the whole job with the existing `runtimeFailed` shape — the interactive view surfaces a visible
    failure rather than inventing a partial-result UI. The genuinely-empty-INPUT fast path is unchanged
    (rejected `badRequest` at start).
  - **Test-gap #4 (timeout ≠ cancel).** A per-request timeout aborts the COMBINED signal with a
    `TimeoutError` while the task's own signal stays unaborted, so `isAbortError(err, taskSignal)` is
    false and the window is retried-then-failed (never mistaken for a user cancel). This hung on the
    abort reason's *name* and was unpinned; `doctasks-translation.test.ts` now pins it (a `TimeoutError`
    single-window run → 2 calls → task fails friendly, not `cancelled`). Also added: the M6 marked-window
    case (doc-task) and empty/truncated-window `runtimeFailed` cases (`translate-ipc.test.ts`, the view),
    plus `isCleanStop`/`stopped_eos` unit coverage. The manual smoke's header notes `stopping_word` is
    now load-bearing (no behavior change expected — a real within-budget window ends on `<end_of_turn>`).

- **TA-6 — sidecar runtime robustness (translation audit fix wave, 2026-07-06; findings M1/M5/L2/L3).**
  Crash recovery, single-flight teardown, and sender-lifetime binding for the TranslateGemma sidecar
  (`services/translation/runtime.ts`, `jobs.ts`, `ipc/registerTranslateIpc.ts`).
  - **M1 (crash recovery).** `TranslationRuntime` never observed the child dying on its own, so a
    mid-session crash left `this.server` pointing at a dead handle: every `translate()` failed with a
    connection error, and each failed attempt re-armed the idle clock, so the outage persisted as long
    as attempts arrived < the 120 s idle window apart. `ensureStarted` now wires `LlamaServer`'s
    existing `onUnexpectedExit` hook (fired only for a healthy child dying outside `stop()`) to null
    `this.server` — **identity-compared** (`if (this.server === server)`) so a late crash notice can
    never clobber a NEWER instance a soft teardown + restart already installed. The next `translate()`
    then cold-starts (the doc-task's one retry gets a fresh spawn). The connection-error catch-path
    fallback (option b) was unnecessary — the sidecar offers the exit callback (option a).
  - **M5 (single-flight teardown).** `teardown()` was not single-flighted: a quit `stop()` arriving
    while a suspend's kill was in its SIGTERM→2 s→SIGKILL window saw `this.server` already nulled and
    resolved immediately (app could exit with the escalation pending → orphan on POSIX), and two
    overlapping suspends let the second's `finally` clear `tearingDown` while the first was still
    killing (a racing `translate()` then cold-started during the vault re-encrypt). A shared
    `teardownPromise` now holds the in-flight pass (mirroring `idleTeardownPromise`): an overlapping
    teardown returns/awaits it instead of starting a second pass, and `tearingDown` + `teardownPromise`
    clear together — via a `.finally` on the shared promise (which runs on a microtask, so the
    assignment always wins even when the body completes without awaiting) — only once it settles. While
    here, a cold start now **awaits a live `idleTeardownPromise` first**, so a translate racing a soft
    idle teardown no longer briefly double-loads ~10 GB (it waits for the dying child, then spawns one).
  - **L2 (dead latch removed).** `TranslateJobService.tearingDown` was dead code — `stop()` has no
    `await` (TA-5 left it synchronous), so the flag set and cleared within one synchronous block and no
    continuation could observe it. The latch (and its defense-claiming comment) were removed; the real
    defense — `stop()` aborts every controller's signal before the vault re-encrypts, so a `run()`
    scheduled just before then sees `signal.aborted` — is now what the `run()` guard checks and the
    comment states.
  - **L3 (cancel-on-destroy; full rebind deferred).** `trToken`/`trDone`/`trError` are bound to the
    starting `webContents` for the job's life; in the multi-window app a destroyed window dropped those
    events silently while the job decoded to the 45-min timeout holding the busy lane. `translateStart`
    now binds the job's lifetime to the sender: a `'destroyed'` listener cancels the job (parity with
    the lock/quit purge), detached on terminal state so a long-lived window running many translations
    does not accumulate one listener per call. A full emitter-**rebind** onto another window via
    `getActive` is deliberately **deferred** (recorded in the TA-wave deferred backlog). Tests: runtime
    crash-recovery + identity-guard, concurrent `stop()`+`suspend()` awaiting the shared teardown,
    overlapping-suspend `tearingDown` hold, translate-awaits-idle-teardown (no double spawn);
    `translate-ipc.test.ts` destroyed-sender cancel + listener-detach.

- **TA-7 — low sweep, doc drift, wave close-out (translation audit fix wave, 2026-07-06;
  findings L9/L11/L12, decision L10, doc-drift D1–D5).**
  - **L9 (window-budget backstop direction).** `translationUsableTokens` clamped `contextTokens`
    **up** to 1024 — the wrong direction: a future manifest with a smaller real context would then
    budget every window against a larger context than the model has, overflowing all of them. It now
    uses the REAL context and only falls back to `TRANSLATION_FALLBACK_CONTEXT_TOKENS` (1024) for a
    **junk/≤0** read (no real context to respect); `translationBudgetWords` clamps the budget DOWN to
    what the real context holds rather than inflating past it. Unit case at ctx 512
    (`doctasks-windows.test.ts`).
  - **L11 (unbounded `tasks` map + wrong expired-kind).** The manager's `tasks` map grew for the whole
    session and the expired-id `getDocTask` fallback hardcoded `kind:'summary'`. Terminal tasks are now
    evicted past `DOC_TASK_MAX_TERMINAL_HISTORY` (16; running/queued never evicted), and a bounded
    `kindHistory` lets an evicted task's late poll echo its REAL kind (never mislabel an evicted
    translation as a summary). Manager eviction + kind-recovery unit tests (`doctasks.test.ts`).
  - **L12 (persisted English strings).** `failedWindowNotice` + `translationAttributionLine` are
    written INTO the generated document, yet were hardcoded English. They now route through `tMain`
    (new en+de keys `main.translation.failedWindowNotice` / `.attributionLine`, parity compile-enforced)
    so the materialized document is in the app language at materialization time — the one deliberate
    persisted-string exception to the canonical-English-in-DB rule. Integration `de`-materialization
    assertion (`doctasks-translation.test.ts`).
  - **L10 (ACCEPTED, no code).** `approxTokenCount` under-charges a pathological glued emoji/astral run,
    so "over-chunk, never overflow" is not an absolute guarantee. Deliberately NOT fixed in this wave
    (touching the shared chunker for a pathological input is not worth the cross-pipeline blast radius;
    the failure mode is an honest failed-window notice). Documented in `known-limitations.md`
    (translation) + the `doctasks/translation.ts` header; a real fix belongs in a separate chunker-owned
    change.
  - **Doc drift D1–D5.** Smoke row / header wording aligned to what the tests assert (identifiers
    verbatim, numbers/dates localize — `packaging.md`, `translategemma-smoke.test.ts`); the
    `doctasks/translation.ts` prompt-reserve comment made past-tense; `security-model.md` log
    enumeration extended with the content-free `error: String(err)` failure log; three stale
    `HILBERTRAUM_TRANSLATION_SMOKE` → `HILBERTRAUM_TRANSLATEGEMMA_SMOKE` smoke comments corrected.

**Translation audit (TA wave) — outcomes.** A four-lens adversarial audit of the shipped TranslateGemma
wave (`docs/translation-audit-2026-07-06.md`, 4 High / 8 Medium / 12 Low + 5 doc-drift) was fixed across
TA-1…TA-7, all on `master`, 2026-07-06 — then the audit report AND the fix plan
(`docs/translation-audit-fix-plan.md`) were folded here and DELETED per the doc-lifecycle rule (git
history keeps both). Per phase: **TA-1** quit+lock flush the whole doc-task pipeline (H1/H2); **TA-2**
renderer session-store purge moved to the real App-level lock seam (H3); **TA-3** renderer store
hardening — per-timer poll latch, post-picker guard, stop/error edges (H4/M8/L5–L8); **TA-4** SSE
terminal-frame + `error:`-field handling + Gemma control-token sanitization (M2/M3/M4/L1/L4); **TA-5**
limit-stop detection + view-job empty-window retry (M6/M7); **TA-6** sidecar crash recovery,
single-flight teardown, sender-destroy cancel (M1/M5/L2/L3); **TA-7** low sweep + doc drift + this
close-out (L9/L11/L12, L10-accept, D1–D5). One decision of record: **L10 accepted as-is** (above).

**Follow-up audit (FA wave) — outcomes.** A second, full-surface pass over the as-built TranslateGemma
feature the same day the TA wave closed (`docs/translation-audit-2026-07-06-followup.md`, 8 new findings
F-1…F-8) was fixed across FA-1…FA-4, all on `master`, 2026-07-06 — then the working paper was folded here
and DELETED per the doc-lifecycle rule (git history keeps it). The `F-N` / `FA-N` anchors that code
comments cite resolve against the **per-finding disposition** below. Per phase: **FA-1** (F-1, F-4);
**FA-2** (F-2, F-5); **FA-3** (F-6, F-3); **FA-4** (F-7, F-8 + this close-out). Suite **3584 / 47** at
close (baseline 3580, +4 FA-4 pins). One decision of record: **F-7 shipped as option (c)**, with option
(a) rejected-with-reason (below).

Per-finding disposition (F-1…F-8):
- **F-1 (HIGH/MED, correctness) — FIXED (FA-1).** View-job retry duplicated already-streamed text into
  the terminal `done`. `jobs.ts` `run()` now checkpoints `job.text` after the `'\n\n'` window separator
  and restores it via `patch()` (cancelled-guarded) before each retry attempt, so a transiently-failed
  attempt's deltas are rolled back and the window lands once. No new IPC (`trDone` carries the full text).
- **F-2 (MED, latency) — FIXED (FA-2).** Both retry loops now classify the failed attempt: a THROW or
  EMPTY reply is TRANSIENT (retry once); a NON-EMPTY non-clean-stop is a deterministic temperature-0
  limit-stop and fails immediately (greedy + `cache_prompt` reproduces the identical truncation — the
  second ~30-min decode was pure waste). Abort contract byte-identical.
- **F-3 (MED, UX) — FIXED (FA-3).** `adoptActiveFileTranslation()` mirrors the text path's `adoptActiveJob`:
  on Translate-screen mount it reads main's active doc-task over the new `getActiveDocTask` IPC and, for a
  running `translation` task, re-seeds `translating` + window progress (null-tolerant `fileName`) and
  resumes the poll under a fresh generation (`pollDocTask` extracted + shared with the fresh start).
- **F-4 (LOW, leak) — FIXED (FA-1).** `registerTranslateIpc` keeps a `jobId → detach` map; the
  `destroyed` listener is now detached on the cancel terminals (which emit neither done nor error) too.
- **F-5 (LOW, hardening) — FIXED (FA-2).** `sanitizeSourceText` rewrites the full Gemma special-token
  family (`<bos>`/`<eos>`/`<unk>`/`<pad>`/`<start_of_image>`/`<end_of_image>` + the two turn markers) to
  the visually-identical `⟨…⟩` non-token spelling; exact-marker alternation leaves ordinary `<…>` HTML
  untouched. `TODO(smoke)` reconfirms the family against the pinned GGUF tokenizer.
- **F-6 (LOW, correctness edge) — FIXED (FA-3, ahead of F-3).** `cancelDocTask(jobId?)` routes a present
  id to `cancelActiveDocTask(id)`, which cancels ONLY when the id IS the active task (else no-op); the
  file store threads its held `docTaskJobId` through both cancel paths, so a stale/superseding Stop can
  never kill a foreign task that took the lane. Absent id keeps the active-task fallback for old callers.
- **F-7 (LOW, availability) — FIXED (FA-4), option (c).** A latched start failure could permanently
  disable translation for the session with only "runtime failed" to show. **Decision:** keep the latch
  (correct for the permanent case — the reranker precedent) but tag its error with a distinct code
  (`TRANSLATION_START_FAILED_CODE`) so both consumers surface actionable "restart the app / free memory"
  copy (new `translate.err.startFailed` + `main.translation.startFailed`, en+de, parity-compile-enforced;
  content-free — no cause message crosses to the renderer, so security-model logging is untouched).
  **Option (a) "classify OOM-shaped failures as non-latching like bind races" — REJECTED:** no reliable
  transient/OOM signature exists across OSes. Verified against `LlamaServer`'s start surface — the only
  machine-readable signal is the exit code, and on Windows the OOM / `std::bad_alloc` exit `0xC0000409`
  COLLIDES with the PERMANENT #20305 minja template crash, while a Linux OOM-kill `SIGKILL` is
  indistinguishable from our own `stop()`. Un-latching on that signature would also un-latch a genuinely
  permanent fault → every window re-spawns + re-awaits the full health timeout (the exact cost the latch
  prevents). Option (b) time-bounding the latch shares that reliance and re-pays the cost on a timer —
  not chosen. The bind-race exemption is unchanged (a bind race still propagates raw, non-latching).
- **F-8 (NIT, cosmetic) — FIXED (FA-4).** The file progress label counted the materialize step
  (`stepsTotal = windows + 1`), so a 12-window doc read "(3/13)". A display-only `windowProgress()`
  helper in `fileTranslateSession.ts` subtracts the materialize step and clamps `windowsDone`, applied on
  BOTH the fresh-start poll and the FA-3 adopt seed; the doc-task's real progress contract is untouched.
  (The DocumentsScreen inline-translate label is a separate surface, out of scope, left as-is.)

**Deferred backlog (audited in the TA wave, deliberately NOT scheduled — recorded for a later wave).**
- Full emitter **rebind** on `getActive` adoption across windows (L3 shipped as cancel-on-destroy only —
  a destroyed sender cancels its job; a live handoff to another window is not built).
- Paste-size cap for the Translate view (multi-hour multi-window pastes).
- `GeneratedProvenance` lacks the translation language pair (a data-contract addition).
- Doc-task dedup on a double-clicked Translate (`hasPendingKind` generalization).
- `extractSegmentTexts` abort signal (cancel during a long encrypted-PDF re-parse).
- Mid-segment split's spurious paragraph break in doc-task output (the view path already avoids it).
- `resolveSidecarSelection` dead `makeReal` param on the translator factory.
- Drop-zone `onDragLeave` child-element flicker; duplicate tab stops.
- File-pane live region (a11y) + partial-output indication after cancel/error.

- **TG-5 — document drag-and-drop in the Translate view (plan §2 D7).** A drop zone
  (`renderer/translate/TranslateDropZone.tsx`, the ImageDropZone template — focusable, drag-over
  state, a WCAG 2.5.7 "choose a document" button, multi-drop rejected) under the input pane. A
  dropped/picked file does NOT go through the live TEXT job; per D7 it rides the EXISTING
  translation **doc-task**: `getDroppedFilePath` (or `pickDocuments`) → `importDocuments(paths,
  {destination:{kind:'temporary'}})` → poll `getImportJob` → `startDocTask('translation', docId,
  {sourceLang,targetLang})` → poll `getDocTask` → on done load the materialized doc's Markdown
  (bounded `previewDocument`) into the SAME output panel + Export (`exportDocument`) / "Show in
  Documents" (`onNavigate('documents')`). NO new parsing/IPC path — provenance, audit and
  encryption invariants ride the doc-task for free. Orchestrated by a second renderer store
  `lib/fileTranslateSession.ts` (the translateSession template — module-level, survives navigation)
  that owns import + doc-task polling + the result load. **One output panel + one busy state
  (recorded):** the screen shows the live text stream OR the file result — ownership is "file if
  the file session is non-idle, else text" (each path resets the other on start, so at most one is
  non-idle → remount-safe with no component flag); the screen's single `busy = textTranslating ||
  fileBusy` disables BOTH triggers, so the file path naturally takes the D9 lane (a real
  `ctx.docTasks` task, so the text path's `hasActiveDocTask()` guard blocks it too). The file path
  shows numeric window progress (`Translating… (3/12)`) driven by `stepsDone/stepsTotal` with the
  materialize step subtracted for display (FA-4 F-8 — `windowProgress()`); the text path deliberately
  shows none. **Deliberate deviation from the plan's "poll (lib/doctasks.ts store)":**
  the new store runs its OWN import + doc-task polling rather than the GLOBAL `doctasks` store's
  `startTask`, so the result load never races a foreign `acknowledgeDocTask` from
  DocumentsScreen/ChatScreen; the backend still enforces one-task-at-a-time, so the D9 lane holds.
  **Temporary-source lifecycle:** the source is imported as a **Temporary** document (never the
  Library); the materialized translation is a **Generated** document (zero membership, findable
  under Documents). We do NOT bespoke-delete the temporary source — it rides the existing
  Temporary-lifecycle retention (owner-gated, Phase E.2). Audit stays content-free (the doc-task
  path already logs ids/kinds only — security-model.md).


- **TG-4 — the Translate view (text path, plan §2 D6).** A new **7th primary** rail destination
  (`ScreenId 'translate'`, between Documents and Images — design-guidelines §2 now "7 primary +
  1 utility") for live TEXT translation on the SAME `ctx.translator` sidecar the doc-task uses (no
  second model). A per-job streaming service `TranslateJobService` (`services/translation/jobs.ts`,
  the vision image-job template) behind new IPC — `translate:start` → `{jobId}` (validates
  `isTranslationLangCode` + source ≠ target + non-empty + a model present; busy-REJECTs a second
  job; refuses while a doc task holds the lane), `translate:cancel`, `translate:getActive` for
  remount recovery, and `STREAM.trToken/trDone/trError(jobId)` (additive, the image-channel shape).
  Single window = fast path; longer text plans with the SHARED `planTranslationWindows`
  (`Translator.contextWindow()` + the D4 clamp — imported, not duplicated) and streams
  window-by-window (blank-line joins) into ONE output. The renderer store
  `lib/translateSession.ts` (visionSession template) keeps a running job alive across navigation;
  a full reload re-adopts via `translate:getActive`. **D9 busy-gating decision (recorded):** the
  view job takes the SAME one-at-a-time lane as doc tasks — it refuses to start while
  `docTasks.hasActiveTask()` (RAM co-residency: 12B translate + a resident chat model + embedder),
  surfaced honestly as "a document task is running". It does NOT block chat (different sidecar;
  chat-during-translate relaxation stays TG-6). The doc-task manager is unchanged (D9 "all other
  kinds unchanged"); the shared `--parallel 1` sidecar serializes the rare reverse race at the
  server. Teardown: `TranslateJobService.stop()` aborts the in-flight job + purges the map, wired
  to lock (`registerWorkspaceIpc`, before `translator.suspend()`) AND quit (`shutdown.ts`) — its
  next window would otherwise lazily respawn the just-suspended sidecar (the TG-3 fix, reused).
  Audit stays content-free (ids/langs only — security-model.md). **END-TO-END VERIFIED** live
  against the real b9849 sidecar (CDP-driven, 2026-07-05): „Guten Morgen. Wie geht es dir?"
  streamed „Good morning. How are you?" (content-free log); the model-missing EmptyState deep-linked
  to AI Model. Two review-workflow bugs were fixed first — a persistent-store error banner that
  reappeared on remount (new store `acknowledgeError()`), and a multi-window paste that flattened
  paragraph structure (split on blank lines into segments before the shared planner).

- **TG-3 — the doc-task reroute (BREAKING, plan O2/D3/D4/D5).** `kind:'translation'` consumes
  `ctx.translator` via `DocTaskDeps.getTranslator` — the chat runtime no longer participates
  (its prompts/temperature were deleted; the manager dispatches translation directly like
  `ocr`, outside `MODEL_TASK_HANDLERS`). Guards: enqueue AND dequeue require a non-null
  translator (`main.translation.noModel`, friendly + deep-linked); chat may be entirely absent.
  Languages widened to the curated 10 (widened to 51 by issue #31 — see D5/#31b) with a
  required `sourceLang` (shared/types owns the
  canonical `TRANSLATION_LANGUAGE_CODES`; the sidecar's prompt maps key off it — one source of
  truth). Window planning moved to `Translator.contextWindow()` + the D4
  `TRANSLATION_MAX_INPUT_TOKENS = 1800` clamp; the Qwen-measured 1.3/2.0 tokens-per-word
  constants were carried as conservative defaults here and REPLACED at TG-6 with the
  Gemma-measured 2.5/3.0 (see the TG-6 bullet above).
  `AppStatus.translationAvailable` (from `ctx.translator`, the `ocrAvailable` twin) gates the
  Documents UI. V6 re-verified: `resolveModelByRole('translation')` carries the manifest's
  `recommendedContextTokens` (4096) into the sidecar launch exactly as vision/reranker do.

- **Why a dedicated sidecar (`services/translation/`).** TranslateGemma is served by its OWN lazy
  `llama-server` (the FIFTH `LlamaServer` composition after chat, E5, reranker, vision) — NOT the
  chat `RuntimeManager`. Forced: a chat-parsing rework (llama.cpp PR #19419) regressed the `--jinja`
  embedded-template path for this model (issue #20305, fix PR #20956 still open — see
  `model-policy.md` "The translation role"), so the sidecar launches **without `--jinja`** and
  cannot ride the chat slot (which hard-codes `CHAT_SERVER_ARGS = ['--jinja', …]`). Desirable
  anyway: chat stays usable, and ctx/prompt/sampling are model-specific (plan §2 D1/D2).
- **Launch args (`runtime.ts`, `translationServerArgs(device)`).** `--ctx-size 4096` (the model
  card's 2K input budget + output headroom, plan §2 D4) `--parallel 1` (`TRANSLATION_SLOT_ARGS` —
  strictly sequential windows; contains the #25142 Windows-Vulkan parallel-translation hang in BOTH
  device postures) the **device posture** (issue #42: `'auto'` = NO device args → b9849 ngl=auto +
  fit=on VRAM-aware offload, the chat rung-1 shape; `'cpu'` = `--device none` via
  `TRANSLATION_CPU_DEVICE_ARGS` — the only CPU-forcing mechanism, never `-ngl`)
  `--chat-template gemma` (`TRANSLATION_TEMPLATE_ARGS` — **REQUIRED**, TG-2 smoke finding: b9849
  crashes at STARTUP validating TranslateGemma's embedded template — the #20305 minja crash at init,
  even without `--jinja` — so we override it with the built-in legacy gemma template; safe because
  `/completion` never applies the chat template). NO `--jinja`, NOT `CHAT_SERVER_ARGS`.
- **Prompt in app code (`prompt.ts`), raw `/completion` (`completion.ts`).** The trained
  single-user-turn prompt is formatted in `buildTranslationPrompt` (our own `code → English name`
  map — the template's dictionary is unusable without jinja) and POSTed to the native `/completion`
  endpoint with `temperature 0` (greedy MT) + `stop: ["<end_of_turn>"]`; `readCompletionSSE` parses
  the bare-object stream (NOT `readChatSSE`'s `choices[].delta` shape). Source text inside `{TEXT}`
  is translated, never obeyed (no "part n of m" scaffolding, D2). VERBATIM template reconciliation
  (plan §7 V1) is done by the `translategemma-smoke` harness against the server's `/props`.
- **Lifecycle — a hybrid.** The vision RUNTIME-4 SOFT idle-teardown interlock (120 s default,
  `HILBERTRAUM_TRANSLATION_IDLE_MS`; re-armed only when the last in-flight window settles) bounds
  the ~10 GB co-residency window (plan §2 D9); the reranker `stop()` (permanent, quit) vs
  `suspend()` (soft, workspace lock → lazy restart) split + `tearingDown`/bind-race-forgiving
  `startFailed` latches keep the session-held instance safe across lock/unlock. Availability-driven:
  `resolveModelByRole('translation')` → `resolveSidecarSelection` → `createSelectedTranslator`
  (null when binary/weights absent; no mock — plan O2). Composed in `compose-services.ts`, carried
  on `AppContext.translator`, stopped on quit (`shutdown.ts`) + suspended on lock
  (`registerWorkspaceIpc`).
- **TG-2 gate — PASSED.** The `translategemma-smoke` harness RAN on the real b9849 Vulkan pin
  (2026-07-05) and PASSED: clean DE↔EN translation, injection-resistant, no stop-token leak,
  ~3.7–4.0 tok/s CPU decode, ~9.5 GiB peak RSS. Its load-bearing finding is the `--chat-template
  gemma` startup fix above (without it b9849 can't start on this model).
- **TG-6 — calibration + closure (the measurements the design rests on).** The manual smoke +
  `llama-tokenize` re-measured the REAL Gemma tokenizer + runtime on the pin (full table in
  `model-benchmarks.md` §11). The load-bearing finding: the Qwen3-4B-measured planner constants
  (`1.3` input / `2.0` output tokens-per-word, carried as "conservative defaults" through TG-3) were
  **unsafe** on the Gemma tokenizer — real input runs to **2.26 tok/word** (Czech; en 1.11 … cs 2.26
  on realistic prose, ~2.8 on token-dense invoice lines) and output to **1.96 tok/source-word**
  (word-sparse German → dense Slavic/Cyrillic; dense short samples ~3.06). At the old constants a
  full ~1,150-word window would have been ~3,200+ input tokens alone, overflowing BOTH the 2K trained
  input and the launched 4096 context (silent truncation). Fix (`doctasks/translation.ts`): a
  translation-specific **`TRANSLATION_INPUT_TOKENS_PER_WORD = 2.5`** (NOT the shared
  `SUMMARY_TOKENS_PER_WORD`, which is the chat model's summary factor for a different tokenizer) +
  **`TRANSLATION_OUTPUT_TOKENS_PER_WORD = 3.0`**, both conservative ceilings over the measured maxima
  so a window can only OVER-chunk, never overflow (the D4 clamp still binds: at 2.5 tok/word a
  clamp-word window's input stays under 2K). Windows shrink to **~690 words** (`windowMaxTokens`
  ≈2,071) — the honest cost of the heavy tokenizer. **D8 (GPU):** TG-6 KEPT the CPU pin for v1
  (~3–4 tok/s tolerable for a background doc-task; GPU deferred, not rejected) — **superseded by
  issue #42 (2026-07-09)**, which pulled GPU forward: see the issue-#40/#42 bullet below. The
  per-window timeout was recalibrated to 45 min (a ~2,070-token full window at the observed-worst
  ~1.1 tok/s is ~30 min; it stays — an upper bound is harmless on a fast GPU decode). **D9 (chat-during-translation relaxation):** KEEP serialization —
  co-residency measured ≈13.2 GiB (translation ≈9.2 + a 4B chat + embedder); a 12B chat pushes the
  pair past a 16 GB machine, so two large models decoding at once is infeasible. **min-RAM (D10):**
  `recommended_min_ram_gb` reset to 17 (the §4 peak+3-headroom rule applied to the measured 13.24 GiB
  co-residency floor, which excludes the Electron shell). **Pre-ship gap — CPU safety-net binary:**
  the pinned pure-CPU b9849 build was fetched + **SHA-256-confirmed** against the runtime-sources pin
  (`fa7d9d93…4352`, exact) at TG-6, but the RUN is still pending: on the dev box Windows Defender
  quarantines the freshly-downloaded, unsigned `llama-server.exe` on execution (only that exe was
  removed; every sibling exe survived), and adding an AV exclusion needs admin. The substantive CPU
  DECODE path is already fully exercised — every TG measurement runs `--device none` (pure CPU) on the
  b9849 server, and the CPU-only binary shares identical server/template/tokenizer code (differs only
  in omitting the Vulkan backend). Run the `cpu-safety-net` leg on a drive/CI where the CPU build ships
  AV-allowlisted before release.
- **Issue #31 (2026-07-07) — false failure banner on every successful translation + language-set
  widening.** Two beta findings, one wave.
  - **#31a — `isCleanStop` misread the pinned server's final frame (the "translation works but the
    failure banner always shows" bug).** TA-5 M6 keyed the clean-stop test on `stopping_word` /
    `stopped_eos` — the LEGACY llama-server fields. The server rework that predates the b9585/b9849
    pins consolidated the `stopped_eos`/`stopped_word`/`stopped_limit` booleans into ONE
    **`stop_type`** field (`'none' | 'eos' | 'limit' | 'word'`), and on Gemma a finished turn ends
    on `<end_of_turn>` as an **EOS-class token** — so the real success frame is `stop_type: "eos"`
    with an **empty** `stopping_word` and NO `stopped_eos`. `isCleanStop` therefore returned false
    for every successful window; the view job classified it a deterministic limit-stop (FA-2 F-2:
    non-empty + no clean stop ⇒ no retry) and failed the job `runtimeFailed` AFTER the full
    translation had already streamed — the issue's always-on "Das Übersetzungsmodell konnte nicht
    fertigstellen" banner. The doc-task path took the same misread into its retry-then-mark branch
    (every window retried once — a full duplicate ~30-min CPU decode — then marked "could not be
    translated" even though the text was fine). **Fix (`completion.ts`):** `CompletionFinal` gained
    `stopType` (parsed from the frame's `stop_type`); `isCleanStop` is now `stop_type ∈
    {eos, word}` OR the legacy signals (non-empty `stopping_word` / `stopped_eos: true`), so older
    frame shapes and the scripted test translators stay valid, and a REAL limit stop
    (`stop_type: "limit"`) still fails the window. Regression-pinned in
    `translation-completion.test.ts` with the exact b9849 success- and limit-frames; the manual
    smoke's window log now prints `stop=<stop_type>` (TA-5's "no behavior change expected" note was
    wrong precisely because the smoke predated M6 — the smoke asserted output fidelity, never the
    frame fields M6 later keyed on).
  - **#31b — language set widened from the curated 10 to the 51-code WMT24++ production tier
    (owner decision on the issue).** `TRANSLATION_LANGUAGE_CODES` now carries the 55
    WMT24++-evaluated locales (arXiv:2601.09012) collapsed to 51 bare codes (regional/script
    variants fold into base codes; `zh` = Simplified). The list REMAINS closed + server-side
    validated (D5's shape survives; only its extent changed): the template's ~160 languages include
    ~105 experimental (GATITOS/SMOL) ones Google flags for higher hallucination — those stay out.
    Per-language round-trip evidence: the original 10 keep their TG-6 smoke record; the widened 41
    ship on the model's own WMT24++ evaluation (MetricX-24 3.60 / COMET22 83.5 for the 12B).
    English prompt names follow the template dictionary where known (`fa` "Persian", `zh` "Chinese
    (Simplified)") — the GGUF `tokenizer.chat_template` stays the verbatim authority, reconciled at
    the next manual smoke. Planner safety on the new space-less scripts (ja/zh/th/…):
    `approxTokenCount` charges them per-character (over-counts vs the real tokenizer), so windows
    still only ever OVER-chunk. The smoke's calibration leg deliberately keeps measuring its
    curated-10 samples (`SMOKE_LANGS`); the pickers render all 51 native names, defaults stay de/en.
- **Issues #40 + #42 (2026-07-09) — restart-free activation + GPU offload.** Two beta findings,
  one wave.
  - **#40 — the translator selection was frozen at startup.** `composeServices` ran once in
    `initBackend`, so downloading TranslateGemma mid-session left `ctx.translator` null until a
    restart — while the Translate empty state kept pointing the user at the download flow (a
    circle). **Fix:** `DownloadManager` gained `onModelInstalled` (fired once when a job reaches
    `done`, after every file is renamed into place — placeholder-hash completions included, since
    the selectors are presence-driven); the IPC wiring routes it to **`AppContext.onModelInstalled`**
    (main/index.ts), which re-runs **`composeTranslator`** (`compose-services.ts` — the ONE
    construction startup and refresh share) and re-assigns `ctx.translator` **only when the slot is
    null or the current instance reports `isStartFailed()`** (`shouldReplaceTranslator`;
    full-audit 2026-07-10 BE-7 — a latched instance is lazy/dead with no child to orphan, so the
    delete-and-re-download repair now activates without a restart; a live sidecar is never
    replaced). Every consumer reads `ctx.translator` live
    (translate jobs, doc tasks — whose `getTranslator` was the one startup-const capture, now fixed
    — core-status IPC, lock/quit teardowns), and the Translate screen already re-reads
    `translationAvailable` on mount/focus. Scope: the **transcriber/reranker/embedder keep the
    restart requirement** — their handles are captured at IPC-registration/ingestion-wiring time
    (`registerDocsIpc` deps, `getIngestionDeps`), so a ctx re-assignment alone would activate them
    inconsistently; adopting the same seam there needs its own capture-site pass
    (`known-limitations.md` records this). Tests: `downloads.test.ts` (hook fires once on `done`,
    on unverified too, never on failed/cancelled, hook faults can't fail the job) +
    `compose-translator.test.ts` (real temp-drive layout: null → live selection as the GGUF lands).
  - **#42 — GPU offload for the translation sidecar (TG-6's deferred D8, pulled forward).** The
    sidecar now runs a two-rung **device ladder** (`runtime.ts`): per COLD START it re-reads the
    SAME Settings signals the chat ladder gets (`gpuMode` + `gpuAutoDisabled`, injected as
    `TranslationGpuDeps` from the shared `gpuSignals` in main/index.ts) — allowed ⇒ launch with
    **no device args** (b9849 ngl=auto + fit=on; on a GPU-less box that IS CPU mode), else
    `--device none`. A **non-bind-race GPU start failure** retries once at forced CPU within the
    same start and arms a **session-scoped `gpuFellBack` latch** (later cold starts pin CPU — no
    repeated GPU health timeouts); a **mid-session crash of a GPU-composed sidecar** arms the same
    latch (the chat §5.3 auto-fallback, session-scoped), so a doc-task's per-window retries can't
    crash-loop a ~10 GB GPU load. Only the FINAL (CPU) rung failing arms the permanent
    `startFailed` latch (F-7 semantics preserved); a bind race stays raw/retryable and touches
    neither latch. The latch deliberately **never writes the persisted `gpuAutoDisabled`** — a 12B
    translation model can fail on a GPU where the smaller chat model runs fine, and chat's ladder
    owns that flag; translation only reads it. #25142 stays contained by `--parallel 1` in both
    postures; the 45-min window timeout stays (upper bound, harmless on GPU). The idle-teardown +
    per-cold-start re-read mean a Settings flip needs no restart. **Open owner action:** the
    GPU-decode re-smoke on a real GPU drive (`model-benchmarks.md` §11.4) — the smoke now defaults
    to the shipping 'auto' posture (`HILBERTRAUM_TRANSLATEGEMMA_SMOKE_DEVICE=cpu` re-measures the
    CPU calibration). Tests: the `translation-runtime.test.ts` ladder suite (off/auto-disabled pin
    CPU, per-cold-start re-read, GPU-fail → CPU fallback + latch, final-rung-only startFailed,
    bind-race neutrality, mid-session GPU crash latch, CPU crash does NOT latch).
  - **#42 reopen (2026-07-10) — cold-start observability.** Field-verified on an RTX 3090: the
    ladder works, but under `--fit` a large RESIDENT chat model silently squeezes the 12B into
    leftover VRAM — a partial offload at ~CPU speed, with no failure for the fallback hook to see
    and no log/UI trace (the fit is also pinned per cold start until the idle teardown re-fits).
    Fix (observability only, no ladder change): `LlamaServer` gains an `onStderrData` tap; the
    translation runtime parses the server's own `load_tensors: offloaded X/Y layers to GPU` line
    (a rolling window across chunk boundaries — the only place the real fit outcome is reported),
    fires `onStarted` once per successful cold start (compose-services logs `"Translation sidecar
    started"` with posture + split, symmetric with the chat `"started via rung …"` line), and
    exposes `deviceStatus()` (last-known survives the teardown, `live` flags a current child) →
    `getAppStatus().translationDevice` → the Translate screen's muted #36-style device line, whose
    partial-offload form names the ~CPU speed and whose tooltip carries cause + remedy. Field
    numbers + the contention case: `model-benchmarks.md` §11.4; user-facing shape:
    `known-limitations.md` "Document translation". Tests: `translation-runtime.test.ts`
    ("cold-start device observability" — chunk-split parse, once-per-start, honest-null CPU form,
    fallback lands as 'cpu', throwing hook harmless), `core-model-ipc.test.ts` (status feed),
    `TranslateScreen.test.tsx` (hint forms + absent-before-first-start).

### §-anchor legend (historical plan citations)

The retired `translategemma-translation-plan.md` was folded — its decisions into this record + the
docs below, its facts/license into `model-policy.md`, its measurements into `model-benchmarks.md`
§11. In-code comments and the kept docs still cite `plan §N`, `DN`, `ON`, `VN`, `TG-N` — the numbers
were never renumbered, so this legend keeps them **resolvable** (the doc-lifecycle "stable anchors"
intent, the "Functionality wave 3" precedent) without churning ~40 comments. Read a historical
anchor as:

| Plan anchor | Meaning | Now lives in |
|---|---|---|
| **O1** | License: Gemma Terms `pending`; download behind the ack gate; not bundled | `model-policy.md` "The translation role" license-review record |
| **O2** | Require the model (no chat fallback) | D3 below + `known-limitations.md` "Document translation" |
| **O3** | 12B only; 4B/27B manifest-only follow-ups | D-table below + `model-benchmarks.md` §11 (promotion bar) |
| **O4** | Curated 10 languages | D5 below + `shared/types.ts` (`TRANSLATION_LANGUAGE_CODES` guard) |
| **§1 / §1.1** | Verified facts (gemma3 arch, 2K input, GGUF source, `--jinja`/#20305) | `model-policy.md` "The translation role" (architecture facts + research note) |
| **§2 D1–D10** | Design decisions | the **decision table** below (and the bullets above) |
| **§3** | Data-contract changes (`translation` role, widened langs, `translate:*` IPC) | as-built in `shared/manifest.ts` / `shared/types.ts` / `shared/ipc.ts` |
| **§4 (TG-1…TG-6)** | The six phases | the per-wave `BUILD_STATE.md` log |
| **§5** | Risks (#20305, #22908, #25142, Gemma Terms, RAM co-residency, drift) | the bullets above + `known-limitations.md` |
| **§6** | Non-goals (image translation, 4B/27B, auto-detect, chat-during-translate) | this record + `model-benchmarks.md` §11 |
| **§7 V1–V6** | Re-verify-at-implementation items (all resolved) | V1 prompt reconciled (smoke `/props`); V2–V4 URL/filename/sha256 (`model-policy.md` + manifest); V5 #20305 still open (`model-policy.md`); V6 `recommendedContextTokens` (the launch) |

**Decision table (D1–D10, as resolved):**

| # | Decision | As built |
|---|---|---|
| D1 | New `translation` role + dedicated lazy sidecar | `services/translation/runtime.ts` — own `LlamaServer`, `--parallel 1`, 120 s soft idle teardown, availability-driven via `resolveModelByRole('translation')` |
| D2 | No `--jinja`; app-side prompt + raw `/completion` | `prompt.ts` (trained single-turn format, own code→English-name map) + `completion.ts` (bare-object SSE); `--chat-template gemma` avoids the #20305 STARTUP crash |
| D3 | Hard model requirement (O2) | enqueue+dequeue require a non-null `Translator`; friendly `main.translation.noModel` + deep link; chat may be absent |
| D4 | 2K input budget, structurally enforced | `--ctx-size 4096` + `TRANSLATION_MAX_INPUT_TOKENS = 1800` clamp in `planTranslationWindows`; TG-6 sized the tokens-per-word constants so the clamp binds in REAL tokens |
| D5 | Curated 10 languages, source+target | `TRANSLATION_LANGUAGE_CODES` (shared) + native-name selects; no auto-detect. **Superseded in extent by issue #31 (2026-07-07):** widened to the 51-code WMT24++ production tier — still a closed, server-validated list (see the issue-#31 bullet above) |
| D6 | Translate view = 7th primary destination | `TranslateScreen` + `TranslateJobService` (`translate:*` IPC, `trToken/trDone/trError`) |
| D7 | Dropped/picked documents ride the doc-task | `TranslateDropZone` → import `{kind:'temporary'}` → `startDocTask('translation')` → materialized Markdown |
| D8 | GPU posture | CPU-pinned shipped at TG-2; TG-6 kept it (GPU deferred, not rejected). **Superseded by issue #42 (2026-07-09):** a two-rung device ladder honours `gpuMode`/`gpuAutoDisabled` per cold start — GPU auto-offload by default, forced-CPU fallback + session latch on a GPU fault (see the issue-#40/#42 bullet above); the GPU-drive re-smoke (§11.4) is the open owner action |
| D9 | Concurrency guards stay | doc-task FIFO + chat↔task exclusion + view-job `docTaskBusy`; TG-6 KEEPS them (co-residency ≈13.2 GiB rules out two large models decoding at once) |
| D10 | Manifest discipline | rank 0, profiles `[]`, not bundled, `license_review: pending`; `recommended_min_ram_gb` set to 17 (§4 rule on the TG-6 co-residency floor 13.24 GiB) |

## Functionality wave 3 — design record (Phases 31–38, decisions D23–D37 + research gates)

_The wave — conversation search · vault password change · document tasks + summary ·
translation · compare · audio transcription · voice dictation · scanned-PDF/photo OCR —
shipped 2026-06-11 (Phases 31–38 ALL DONE). The as-built per-feature mechanisms live in
the sections above (Conversation search under "Chat & streaming"; "Audio transcription",
"Voice dictation", "Scanned-PDF / photo OCR", "Document tasks") and in `security-model.md`
(password change, descriptor v2, dictation + scoped-permission data-paths), `model-policy.md`
(the whisper.cpp transcriber family + the OCR asset class + their licenses), `drive-layout.md`
(whisper family + `ocr/` assets), `known-limitations.md`, `user-guide.md`, `PRIVACY.md`. This
record keeps the wave's DECISIONS and the RESEARCH-GATE evidence — the content the retired
`docs/functionality-wave-3-plan.md` carried as a unit, folded here when that plan file was
deleted in the 2026-06-29 doc cleanup (the full original plan, drafted 2026-06-10 with review
round 1 + plan audit 2026-06-11, is in git history). Decision numbering continues the
project-wide sequence (D1–D7 wave 1 · D8–D15 retrieval · D16–D22 catalog · D-UI1–4 UI wave)._

### §13 Decisions (D23–D37)

| # | Decision | Resolution |
|---|---|---|
| D23 | Search ranking | **RESOLVED (round 1):** bm25 with newest-first tie-break; revisit with use |
| D24 | Password-change mechanism | **RESOLVED (round 1): (b) envelope descriptor v2, migrate-on-first-change** — a random data key wrapped by the password-derived KEK; first change pays the one-time v1→v2 bulk re-encrypt (journaled swap), every later change is an atomic single-file re-wrap. O(1) recurring change, atomic commit point, unlocks future key features (recovery codes, rotation); v1 vaults untouched until they opt in. Direct re-encrypt and migrate-on-unlock rejected |
| D25 | Summary persistence + long-doc strategy | **RESOLVED (round 1):** `documents.summary_json` + budgeted map-reduce with hard ceiling + honest `truncated` flag. Alternatives (summary-as-conversation, unbounded map-reduce) rejected: surface sprawl / CPU latency |
| D26 | Doc-task concurrency vs chat | **RESOLVED (round 1): strict one-at-a-time** — tasks serialize among themselves (one queue), a task refuses to start while a chat answer is streaming, and a chat message sent while a task runs gets friendly copy ("A document task is running — you can cancel it"). Tasks are cancellable so the user is never stuck. R-T1 demoted to informational (see §14); revisit parallelism only with evidence |
| D27 | Translation output form | **RESOLVED (round 1): materialized corpus document** ("<original> (Deutsch)") + `origin_json` provenance — searchable/citable/exportable, encrypted for free. Export-only and a dedicated results panel rejected (results leave the workspace / a whole new surface). **Implemented in Phase 34** |
| D36 | Translation input: chunks vs re-parse | **RESOLVED (Phase 34, 2026-06-11): re-extract the parser's SEGMENTS from the stored copy** (the `extractDocumentPreview` path) and window them with the D25 budget math. Stored chunks overlap by ~80 tokens — in-order concatenation duplicates text at every boundary, which a summary tolerated (D25) but a faithful translation cannot; trimming the overlap out of adjacent chunks was rejected as heuristic (chunk text is whitespace-normalized) where the re-parse is exact. Cost = one re-parse, same as the in-app preview. Regression-tested (every source word exactly once in the output) |
| D28 | Compare result form + big-doc strategy | **RESOLVED (round 1): materialized "Comparison: A vs B" document** (same principle as D27, `origin_json` records both source ids); auto mode-switch full-stuff vs section-matched (vector-paired) by token math. No new result tables. **Implemented in Phase 35** |
| D37 | Compare mode-(a) input + mode decision: chunks vs re-parse | **RESOLVED (Phase 35, 2026-06-11): re-extract the parser's SEGMENTS** (the D36 path) for mode (a)'s input AND for the mode decision itself. Two reasons beyond D36's: chunk overlap would present duplicated text as phantom "shared" content to a comparison, and the ~80-token overlap inflates a chunk-based length estimate by ~16% — enough to mis-route a fitting pair into the heavier mode (b). Mode (b)'s map step deliberately uses the stored CHUNKS instead (the pairing needs their vectors; per-pair notes tolerate overlap like summary partials, D25 precedent). Regression-tested (every source word exactly once in the mode-(a) prompt) |
| D29 | Timestamp representation | **RESOLVED (round 1):** whisper segments → `sectionLabel: "mm:ss–mm:ss"` (existing `Citation.section` surfaces it). No schema change |
| D30 | Dictation capture pipeline | **RESOLVED (round 1):** renderer MediaRecorder → OfflineAudioContext resample → WAV bytes → main temp file (shredded) → transcriber; mic via scoped `setPermissionRequestHandler`. Streaming ASR explicitly out of scope. **Implemented in Phase 37 exactly as locked** |
| D31 | OCR execution context | **RESOLVED (Phase 38, 2026-06-11, by R-O1): the split design** — a hidden BrowserWindow does ONLY the pdf→PNG rasterization (it is the sole context with a canvas: R-O1 probed the Electron-37 `utilityProcess` and found NO OffscreenCanvas/DOM globals at all, killing option (b)); recognition ALWAYS runs MAIN-side in tesseract.js **Node mode** on image-file Buffers (no canvas needed — probed in BOTH runtimes), where the worker script + WASM core load from local `node_modules` with zero CDN involvement. Photos never touch the renderer at all. The renderer↔main round-trip carries only page PNGs |
| D32 | OCR asset distribution | **RESOLVED (Phase 38, 2026-06-11, by R-O2's inventory): ride `runtime-sources.yaml` with a new additive `ocr:` asset class** (plain verified files `{ lang, url, sha256, dest }`, no extraction, no per-OS variance), fetched by `fetch-runtime`'s Phase-36 `--family` mechanism. The drive carries ONLY the traineddata (`ocr/<lang>.traineddata.gz` — tesseract.js reads the `.gz` layout natively, single hash per file); the worker JS + WASM core ship inside the app as the pinned npm deps. A dedicated `fetch-ocr` script family was rejected: two small files don't justify a third script family when the family mechanism already exists |
| D33 | OCR trigger | **RESOLVED (round 1): never automatic for PDFs** — detection notice + explicit "Make searchable (OCR)" cancellable task with progress; photos OCR on import (small, fast). Auto-on-import and a settings toggle rejected (silent slow imports / a key + two code paths before the feature exists) |
| D34 | Whisper invocation mode | **RESOLVED (Phase 36, 2026-06-11, by R-W1): per-file CLI, not a server.** The v1.8.6 zip ships BOTH `whisper-cli.exe` and `whisper-server.exe` — but only for Windows, so "server ships per-OS" (the lean-server condition) fails; and the CLI wins on merits for batch-only use: progressive `-pp` progress + segments while it works (the R-W4 signal), no multi-hundred-MB upload over loopback, no port/health lifecycle, cancel/lock-suspend = kill the child. The localhost-only sidecar rule is moot (no socket). Revisit server mode only if Phase-37 dictation latency demands a warm model |
| D35 | Audio originals on the drive | **RESOLVED (Phase 36, 2026-06-11): keep the copy** — the locked Phase-4 copy-into-workspace contract + `reindexDocument` re-parsing the stored file force it (transcript-only storage would break re-index and the self-contained drive). Shipped with the recommended riders: size-aware import confirmation (>50 MB picked audio, `docs:importPreflight`), honest "Transcribing… N%" progress on import AND re-index, re-index = full re-transcription recorded in `known-limitations.md`. A sha256-keyed transcript cache only on evidence. Bonus that fell out of the packing design: preview/translate/compare read the STORED CHUNKS (exact for audio — no overlap by construction), so only re-index pays the re-transcription |

### §14 Research-gate evidence (run BEFORE the affected phase; all resolved)

| Gate | Question | Finding |
|---|---|---|
| R-S1 | FTS5 `snippet()`/`highlight()` present in both runtimes? | **GO (probed 2026-06-11):** Electron 37.10.3 main process AND system Node 24.13.0, both SQLite 3.50.4: `snippet()`, `highlight()`, `bm25()` all work on a self-contained fts5 table. JS-truncation fallback not needed (Phase 31) |
| R-T1 | llama-server b9585 concurrent-request behavior (slots/queue/reject)? | **Probed 2026-06-11** (`tests/manual/server-concurrency-probe.test.ts`, `HILBERTRAUM_CONCURRENCY_PROBE`, real b9585 + Qwen3-4B): at our default spawn args a second `/v1/chat/completions` is served on a **PARALLEL slot** (continuous batching) — request B fired 1.5 s into A's stream got its first token at +212 ms and finished while A was still streaming (A: first token 49 ms, done 4 386 ms, 700 tok; B: first token 1 718 ms, done 1 791 ms). Not queued, not rejected ⇒ the D26 app-side guard is the ONLY serialization, which is exactly why it exists (predictable latency, no context splitting). INFORMATIONAL; D26 stands. Facts banked for a future parallelism revisit |
| R-T2 | 4B-class quality: long-input translation drift; comparison-format adherence | **RESOLVED 2026-06-11.** _Translation half_ (`tests/manual/translation-smoke.test.ts`, `HILBERTRAUM_TRANSLATION_SMOKE`, real b9585 + Qwen3-4B-instruct-q4, shipping prompts @ temp 0.2): **(1)** no refusals/chatter; an adversarial embedded-instruction window was translated, not obeyed. **(2)** No language drift on a near-budget (~1100-word) EN→DE input (function-word scoring de=42/44, en=0/0). **(3)** Markdown survival complete (h1/h2/bullets/table pipes/bold/blockquote, DE→EN). **(4) The load-bearing finding:** word ratios are ~1.0–1.1 (DE→EN) / ~0.94 (EN→DE), but German output costs **~2 real tokens per source word** (subword-heavy compounds): the first run's half-input/half-output context split CAPPED a near-budget window at `maxTokens` (ratio 0.67, output cut mid-sentence — silent truncation, exactly what this gate exists to catch). **Fix shipped:** usable context now splits by measured weight — input 1.3 tok/word, output 2.0 (`TRANSLATION_OUTPUT_TOKENS_PER_WORD`); at 4096 ctx → 1150-word windows, `maxTokens` 2301; re-run 19/19 numbered sections present, no truncation. **(5)** Number VALUES/names/codes survive; formats localize (14.03.2026 → March 14, 2026) — accepted, documented. Retry policy: one retry then visible marking. _Comparison half_ (`tests/manual/compare-smoke.test.ts`, `HILBERTRAUM_COMPARE_SMOKE`, same model @ temp 0.3, two rounds): **(1)** the 4B holds the dictated four-section report format (all four `##` headings verbatim + exactly once in every probe, clean bullets, zero refusals, no truncation: reports 106–221 words vs the 512-token cap ⇒ `COMPARE_OUTPUT_TOKENS = 512`, a fixed cap not a per-word weight). **(2)** Fact placement correct; names/numbers/dates exact. Round 1 caught two real issues — only-in-one facts ALSO cross-listed under "differs", and the matched-pair map step silently MISSED an only-in-A fact (the silent-omission class). **Round-2 prompt fixes shipped:** an exactly-ONE-section instruction (fixed the reduce; mode (a) still cross-lists one-sided clauses under "differs" — accurate but redundant, documented) and a "check every fact in the section of A" recall instruction (fixed the map miss). **(3)** Mode (b) DOES need the smaller per-pair format — compact `- Same:/- Different:/- Only in A/B:` bullets held at a 256-token map cap. **(4)** Reduce over per-pair notes merged duplicate shared facts, placement correct, no inventions. **(5)** German inputs: report body stays German; the DICTATED headings stay English (cosmetic, in known-limitations) |
| R-W1 | Pinned whisper.cpp release: binaries per OS, server vs CLI, JSON timestamp output, license, archive shapes + hashes | **Pin: v1.8.6** (2026-06-02), probed against the real `ggml-org/whisper.cpp` release assets. **(1)** Prebuilt binaries exist for WINDOWS ONLY — `whisper-bin-x64.zip` (plain CPU, 3.9 MB, sha256 `b07ea0b1…0a822`) plus Win32/BLAS/CUDA variants and an Apple xcframework; NO mac/linux CLI assets ⇒ mac/linux = a documented source-build step. **(2)** The zip nests everything under `Release/` (the existing flatten step handles it) and contains BOTH `whisper-cli.exe` AND `whisper-server.exe` + ggml DLLs + SDL2.dll (zlib). **(3)** D34 → CLI. **(4)** `-oj` JSON shape verified: `transcription[].offsets.{from,to}` in ms + `text`, `result.language`. **(5)** License MIT; model weights MIT (OpenAI) — reviews in `model-policy.md`. (Phase 36) |
| R-W2 | Decodable input formats of the pinned binary (mp3? flac? m4a?) | **RESOLVED** with real files against the real v1.8.6 binary. The binary declares + decodes **wav, mp3, flac, ogg** (all four verified incl. real German mp3/ogg; ogg an upside vs the plan's wav/mp3/flac guess). **m4a: NOT decodable — and the failure mode is the trap this gate existed for: whisper-cli EXITS 0** with "failed to read audio data" on stderr and NO output. ⇒ the transcriber treats "JSON exists and parses" as the only success signal, never the exit code; m4a is descoped with friendly convert-to-WAV/MP3 copy. Format promise = wav/mp3/flac/ogg (Phase 36) |
| R-W3 | Whisper model size for DE+EN on the reference laptop (RTF, RAM) | **RESOLVED** (dev box, 4 threads; TTS German with known ground truth + real LibriVox German speech). **base** (142 MB): RTF ≈ 0.17–0.21 but meaning-destroying word errors on real speech ("Leichenwagen"→"gleichen Wagen", "Töchter"→"Teuchter", "Särge"→"sehrge", "Magd"→"Markt"). **small** (466 MB): RTF ≈ 0.43–0.46 (~2.4×), fixes nearly all; clean-speech German near-perfect, numbers/names/dates exact. **Shipped default: `small`** (German quality is the product promise); real hashes captured for both (base banked for a possible future low-end manifest: `60ed5bc3…2efe`). All profiles recommended (peak RSS ≈ 1.2 GB, batch job). Manifest = `whisper-small-multilingual` (Phase 36) |
| R-W4 | 60-min file: time/memory/progress signal | **RESOLVED**: a real 52-min German mp3 (128 kbps LibriVox) through the small model on the dev CPU (4 threads): **2123 s wall (≈35 min, RTF ≈ 0.68), peak working set 1155 MB**, 616 segments, **`-pp` progress lines every ~5% (20 ticks) + segments streamed progressively to stdout** ⇒ the import job shows real per-file "Transcribing… N%" (CLI `-pp` → ParseContext.onProgress → in-memory map → `DocumentInfo.transcriptionProgress` on the existing polling path — no new channel). Memory is a non-issue; wall time is the honest cost in `known-limitations.md` + the size-aware import confirm (D35). Job UX = per-file percent (Phase 36) |
| R-O1 | pdfjs render-to-OffscreenCanvas in utilityProcess/worker; tesseract.js on Node Buffers w/o canvas | **RESOLVED** in pinned Electron 37.10.3 AND system Node 24.13.0 (two-runtime discipline), tesseract.js pinned 7.0.0. **(1)** `utilityProcess` has NO OffscreenCanvas — nor `document`, `createImageBitmap`, `ImageData`, `DOMMatrix`, `Path2D` (all `undefined`); D31 option (b) impossible in the Electron we pin. **(2)** A hidden BrowserWindow renders fine: the pinned pdfjs LEGACY build rasterized page 1 of a real image-only PDF at 300 DPI (2550×3301) in ~350 ms with an explicit LOCAL `workerSrc`. **(3)** tesseract.js Node mode consumes image-file Buffers WITHOUT canvas in BOTH runtimes (PNG + JPEG decoded inside the WASM core): confidence 95, near-perfect German incl. umlauts/ß. **(4)** Full split-pipeline e2e proved in the pinned Electron: hidden-renderer render → PNG bytes over IPC → main-side recognize, confidence 94, all six probe words (`Auftragsbestätigung`, `Großmann`, `Bürostühle`, `Schloßallee`, `Özdemir`, `Grüßen`) exact. → D31 (split design). (Phase 38) |
| R-O2 | Full vendored-asset inventory for offline tesseract.js + licenses + sizes | **RESOLVED** (source inspection + live probes with a `net.Socket.connect` watch installed). **Node-mode inventory:** workerPath defaults to the LOCAL `tesseract.js/src/worker-script/node/index.js`; the WASM core is `require`d from the LOCAL `tesseract.js-core` package (SIMD variant picked at runtime) — both ship INSIDE the app as npm deps, NOT on the drive. **The two runtime-fetch traps:** `langPath` defaults to `https://cdn.jsdelivr.net/npm/@tesseract.js-data/...` (MUST be set to the drive's `ocr/` dir) and the traineddata cache writes into CWD by default (MUST set `cacheMethod: 'none'`). **No-network proof: zero remote connect attempts across every probe.** **Licenses (reviewed per model-policy.md):** tesseract.js 7.0.0 Apache-2.0 · tesseract.js-core 7.0.0 Apache-2.0 · traineddata Apache-2.0. **Shipped sizes:** `deu.traineddata.gz` 1.27 MB + `eng.traineddata.gz` 2.82 MB ≈ 4.1 MB. **Packaged-app caveat:** `worker_threads` cannot load a script from inside `app.asar` → `asarUnpack` tesseract.js + tesseract.js-core, resolve workerPath through `.unpacked` (release-acceptance item; the green gate never packages). → D32. (Phase 38) |
| R-O3 | `fast` vs `best` traineddata on real German scans | **RESOLVED** on generated German office-scan pages (150-DPI clean + ~82-DPI/JPEG-q0.45 degraded). **Load-bearing finding: true `tessdata_best` (float) CRASHES the tesseract.js WASM core** (`missing function: DotProductSSE`) — only INTEGER models run, so the real choice is `fast` vs `best_int` (what tesseract.js's own CDN default uses). Clean scan: a dead tie (103/104 words exact for both). Degraded scan: **best_int 3 misses vs fast 7 of 104** — fast garbles the reference number `4711-Ä/2026` and `Jürgen`, best_int keeps both. Cost: ~1.3 s vs ~0.8 s per page, +1.6 MB. **Shipped: `best_int`** (`@tesseract.js-data/{deu,eng}@1.0.0`, `4.0.0_best_int`, sha256 pinned in `runtime-sources.yaml`). The `.gz`-on-drive layout (`langPath` + `gzip: true`) verified end-to-end. (Phase 38) |

### §-anchor legend (historical plan citations)

The retired `functionality-wave-3-plan.md` was folded — its per-phase records (§4–§11) into the
topic-doc sections listed below, and its §13/§14 into this record. In-code comments and the kept
docs still cite `wave-3 plan §N` (and `D23`–`D37`, `R-*`); those numbers were never renumbered, so
this legend keeps them **resolvable** (the doc-lifecycle "stable anchors" intent) without churning
~30 comments. Read a historical anchor as:

| Historical anchor | Meaning | Now lives in |
|---|---|---|
| §4 | Conversation search (`messages_fts`, bm25, `chat:search`, the deny-by-default permission rider) | "Chat & streaming → Conversation search" above + `security-model.md` (permission handler) + `user-guide.md` §6 |
| §5 | Vault password change (descriptor v2 envelope, journaled v1→v2 migration, race guard) — decision D24 | `security-model.md` "Vault descriptor" + "Password change" + `user-guide.md` §10 + `known-limitations.md` |
| §6 | Document-task engine + one-click summary (`DocTaskManager`, D25/D26) | "Document tasks" above + `known-limitations.md` "Document tasks & summaries" + `user-guide.md` §7 |
| §7 | Translation workflow (D27 + D36) | "Document tasks" above (translation) + `known-limitations.md` "Document translation" + `user-guide.md` §7 |
| §8 | Compare two documents (D28 + D37) | "Document tasks" above (compare) + `known-limitations.md` "Document comparison" + `user-guide.md` §7 |
| §9 | Audio transcription as ingestion (whisper.cpp, D29/D34/D35) | "Audio transcription" above + `drive-layout.md` (whisper family) + `model-policy.md` (whisper licenses) + `known-limitations.md` "Audio transcription" + `user-guide.md` §7 + `PRIVACY.md` |
| §10 | Voice dictation (D30) | "Voice dictation" above + `security-model.md` (scoped permission + dictation data-path) + `known-limitations.md` "Voice dictation" + `user-guide.md` §6 + `PRIVACY.md` |
| §11 | Scanned-PDF / photo OCR (D31–D33) | "Scanned-PDF / photo OCR" above + `model-policy.md` "The OCR asset class" + `drive-layout.md` (`ocr/` assets) + `known-limitations.md` "Scanned-PDF / photo OCR" |
| §12 | Session-hardening rider (the deny-by-default `setPermissionRequestHandler`) + cross-cutting impact inventory | `security-model.md` (permission handler + the Phase-37 scoped allow); the DB/IPC/audit deltas are recorded in the per-feature sections above |
| §13 | Decisions D23–D37 | this record's "§13 Decisions" above |
| §14 | Research gates R-S1 / R-T1 / R-T2 / R-W1–4 / R-O1–3 with banked findings | this record's "§14 Research-gate evidence" above |
| §15 | Testing posture (zero-network/model/binary/GPU/mic CI; manual harnesses behind `HILBERTRAUM_*` env vars) | the wave's test files (`tests/manual/{whisper,ocr,compare,translation}-smoke.test.ts`, `server-concurrency-probe.test.ts`) |

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
    survives. A child that crashes or never gets healthy makes `start()` throw a clear error. The
    spawn passes **`windowsHide: true`** (REL-7, backend-audit-2026-06-27) so this high-frequency
    spawn (every model start — chat, embedder, reranker, vision all funnel through here) never
    flashes a console window on Windows, matching the tar / transcriber / runtime-download spawns.
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
  throws — any failure → `[]`) and `parseListDevices` parses it (pure, fixture-tested). The
  spawn passes **`windowsHide: true`** (REL-7) so the once-per-session probe never flashes a
  console window on Windows, and the child is **`unref()`'d** right after spawn (REL-8): the
  probe is not tracked by `shutdown()`, so detaching it from the parent event loop means a
  wedged/cold driver can never delay app quit — the probe's own 10 s kill-timeout still reaps it.
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
  `createGpuCrashAutoFallback` persists the flags, **forces a one-shot restart at CPU via
  `RuntimeManager.forceRestart`** — NOT `start()`, whose same-model idempotency guard would
  otherwise swallow the restart entirely (§5.3) — and broadcasts the friendly §11.4 notice
  (`runtime:notice` event → preload `onRuntimeNotice`): *"Switched to compatibility mode for
  stability…"* — never "GPU failed".
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
  retryable without an app restart. A **transient port-bind race never arms either latch**
  (F4/F7, `isBindRaceError` — see GPU record §5.5b): only a genuine load fault latches, so a
  double-unlucky startup port race no longer silently disables imports / reranking for the session.
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

(Verified 2026-06-10 against the then-pinned tag b9585; re-verify on the next pin bump.
**PIN BUMPED 2026-07-01: the live pin is now b9849** — bumped from b9585 as the Qwen3.5
compatibility gate, `runtime-sources.yaml` + model-policy.md. The b9585-tagged facts below are the
last *verified* runtime evidence; the b9849 re-verification is the REQUIRED manual smoke in
`model-benchmarks.md` §9. These facts — `-ngl auto`/`--fit on` defaults, `--device none`,
`--list-devices`, the Vulkan-archive-is-a-full-build property — are long-standing upstream behaviour
expected to hold on b9849, but that is not yet re-confirmed on this project's drive.)

**VISION RE-VERIFIED 2026-07-01 (RUNTIME-5 + RUNTIME-6).** The b9849 vision smoke that §9 owed was
run live on the provisioned `D:\` drive. Garbage ("multilingual token-salad") image descriptions
turned out to be **b9849 default drift**, not a model↔runtime incompatibility — the sidecar returns
coherent output for every valid image when driven directly (CPU/GPU, small/large, PNG/JPEG), and
corrupted input yields a clean load error, never salad. Two defaults the vision launch args never
accounted for:

- **RUNTIME-6 — the salad fix (`--no-mmproj-offload`).** On b9849 the **mmproj/clip projector
  offloads to the GPU by default even under `--device none`** (`llama-server --help`: mmproj-offload
  default = on). On the target hardware (shared-memory Intel Iris Xe iGPU, Vulkan default, co-resident
  with a 6–8 GB chat model on a 16 GB machine) the projector's GPU compute was starved under
  contention and miscomputed the image embeddings → the LM decoded noise as token-salad. The salad
  therefore reproduced ONLY in the full app (contended iGPU), never in an isolated sidecar (free
  iGPU). `VISION_DEVICE_ARGS` now also passes `--no-mmproj-offload`, pinning the projector to CPU and
  completing the "avoid VRAM contention" intent. **Owner-confirmed fixed in-app 2026-07-01.**
- **RUNTIME-5 — a separate large-image crash (`--parallel 1`).** b9849 defaults to `n_slots = 4` with
  a **unified KV cache** (`kv_unified = true`), splitting the 4096-cell context across four slots. The
  warm-reused sidecar (`cache_prompt`) + a 1536-px image's ~1700–3000 vision tokens oversubscribe the
  shared pool → `failed to find a memory slot for batch` / `failed to restore kv cache` → HTTP 500.
  `--parallel 1` (`VISION_SLOT_ARGS`) gives the strictly one-at-a-time vision request the full context
  with a clean KV (`n_slots = 1, kv_unified = false`). A/B-confirmed live: without it a *repeat*
  large-image request 500s; with it, both succeed.

(Open follow-ups, not blocking: a 1536² image is ~3000 tokens ⇒ ~4 min CPU prefill, which can hit the
300 s per-request timeout — consider lowering the renderer `DOWNSCALE_TARGET` 1536→~1280 and/or
raising the vision `--ctx-size` for generation headroom.)

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

**§5.3 Mid-session crash auto-fallback (corrected — full-audit 2026-06-28, REL-1):**

A GPU-backed `llama-server` can die *after* it became healthy — a driver crash, VRAM stolen by
another process. `LlamaServer`'s `onUnexpectedExit` hook fires (only for a healthy server dying
outside `stop()`); `LadderRuntime` forwards it to `onGpuCrash` **only when the backend it landed on
was `gpu`** (factory.ts:137-139). `createGpuCrashAutoFallback` then, in order: persists
`gpuAutoDisabled` + `gpuLastError`, surfaces the friendly compatibility-mode notice, and restarts
the model once at CPU — so the user's *next* message just works.

**The idempotency interaction (the bug this record previously mis-described).** The restart can
**not** go through `RuntimeManager.start()`. After a mid-session crash the manager has not observed
the child's exit: the crashed `LadderRuntime` is still `this.current` with the *same* `modelId`, and
`this.last` still holds the health snapshot cached at start. `start()`'s same-model idempotency guard
(`runtime/index.ts`, "already running / start in flight → no-op") then early-returns a stale status
read — the "restart at CPU" never stops-and-restarts, `status()` keeps reporting the **dead** server
as running/healthy, and the next chat/RAG/doctask turn routes to it and fails. (The earlier wording
here — "restarts the same model once at CPU" — was therefore false; the restart was silently
swallowed. The unit tests missed it because the ladder test injected a *fake* `restart` and the
manager test proved the guard in isolation; nothing wired the real crash path through the real
manager.)

**The fix (option b — a crash-only `forceRestart`).** `RuntimeManager.forceRestart(opts)` runs
`doStop()` (clearing `current`/`last`, so `status()` immediately stops reporting the dead server as
healthy) then `doStart(opts)` inside **one** enqueued op, bypassing **only** the same-model guard.
Normal `start()` idempotency is untouched — a double-click or an AI-Model-screen revisit still must
not restart; only the crash path forces it. `startingModelId` is set synchronously (exactly as
`start()` does) so a concurrent manual `start(sameModel)` *joins* the in-flight restart instead of
queueing a second one. The crash wiring in `main/index.ts` calls `runtimeRef.forceRestart`, not
`start`. (Alternatives weighed: (a) wiring-level `stop()`-then-`start()` — rejected, the two ops
enqueue separately so a concurrent user start could interleave between them; (c) have the manager
subscribe to the runtime's unexpected-exit and clear `current`/`last` itself — more plumbing for no
extra guarantee. `forceRestart` is atomic within the queue and easiest to test.)

**Retry bound (no restart loop).** `gpuAutoDisabled` is persisted **before** the restart, so the
ladder rebuilt inside `doStart` skips rung 1 and lands on CPU (`--device none`). A later crash is
then a *CPU* crash, which `LadderRuntime` does **not** route to `onGpuCrash` (`backend !== 'gpu'`) —
so a GPU session auto-falls-back **at most once**, never in a loop. Re-entrant crash reports while a
restart is in flight are also dropped by `createGpuCrashAutoFallback`'s `restarting` latch.

(`LlamaServer.start()` additionally carries its own single-flight latch (REL-2): two overlapping
direct `start()` calls now share one spawn instead of the second orphaning the first — so the
crash-restart's stop-then-start can never race a stray direct start into a leaked sidecar.)

**§5.5 Port-race retry + bind-vs-device classification (full-audit 2026-06-29, REL-1).** `findFreePort`
binds port 0, reads the assigned port, then **closes** the listener before handing the number to
`llama-server --port N`. In that TOCTOU window another process — or a sibling in-app sidecar (chat +
embedder + reranker + vision start near-simultaneously) — can grab the port, so the child exits
"address already in use". Two corrections: (a) `LlamaServer.start()` now **retries `doStart()` once** on
a bind-class immediate exit (`isBindRaceError`, matched against the start error message which carries
the stderr tail), acquiring a *fresh* free port — bounded to one retry so a genuine failure still
surfaces; this covers the chat runtime AND the embedder/reranker/vision (which compose `LlamaServer`
directly and previously had no retry at all). (b) `LadderRuntime` no longer persists `gpuAutoDisabled`
when a rung-1 failure message is a bind race rather than a device/driver/model fault — so one unlucky
port collision can never disable GPU for the whole session. Only a real device failure auto-disables.

**§5.5b Bind-race aware START-LATCH for the embedder + reranker (full-audit-2026-06-29-postmerge, F4/F7).**
The bind retry above is bounded to ONE attempt, so during the documented near-simultaneous chat + embedder
+ reranker + vision startup a sidecar can still lose the port **twice** and have `start()` throw a
bind-class error. The embedder (`embeddings/e5.ts`) and reranker (`reranker/llama.ts`) each carry a
**failed-start latch** that fails fast (no health-timeout stall) on every subsequent call — intended for a
PERMANENT fault (a corrupt/incompatible GGUF). The latch's `.catch` previously armed for **any** rejection,
so a transient double-bind-race latched a permanent-looking failure: the embedder then **silently disabled
ALL imports for the session** (it has no graceful degradation) until lock/unlock, and the reranker **disabled
reranking for the whole session** (a silent quality regression — `rag/index.ts` falls back to fused order) and
its latch even **survives `suspend()`**. Both `.catch`es now reuse the same `isBindRaceError` classifier as
the retry (the retry and the latch must agree): a bind-class message leaves `startFailed` **null**, so the
next `embed()`/`rerank()` re-attempts a fresh start on a new port. Only a genuine load fault latches — which
makes the reranker's deliberate **keep-the-latch-across-`suspend()`** policy correct again (a bad GGUF won't
load after unlock; a port race must not be remembered). The embedder additionally **clears** its latch on
`suspend()` (its one deliberate difference — see "Models & runtime"), so a replaced weight file is retryable
via lock/unlock.

**§5.5c `tearingDown` guard — suspend() gets the orphan protection stop() has (full-audit-2026-06-29-postmerge, F19).**
`stop()` (will-quit) sets `this.stopped = true` BEFORE `teardown()`, so a racing lazy `ensureStarted` refuses
to spawn and can't leave an orphan. `suspend()` (workspace LOCK) sets no such latch, so a `suspend()` that
interleaved with a concurrent `embed()`/`rerank()` — a RAG-query or tree-build embedding, which are NOT in
`inFlightStreams` and which `abortActiveBuild()` only *cooperatively* cancels — could stop the OLD sidecar
while a fresh `ensureStarted` spawned and **retained** a new one, surviving the lock with chunk/query-text-
derived state in process RAM. Fix (both `embeddings/e5.ts` and `reranker/llama.ts`): a `tearingDown` flag is
set at the top of `teardown()` and cleared in its `finally`; `ensureStarted` refuses (throws "is suspending")
while it is set — at the top AND re-checked after `await this.starting` (a teardown may begin during that
await and null the server it would return). Cleared in `finally`, so a normal post-suspend `embed()`/`rerank()`
still lazily restarts (only `stop()`'s separate, permanent `stopped` latch blocks that). Deterministically
teeth-tested (`e5-embedder.test.ts` / `reranker.test.ts`, F19): a gated-exit child parks teardown's
`server.stop()`, a concurrent embed/rerank fires in that window, and the assertion is that NO sidecar survives
the lock (one spawn, killed) — red without the flag (the concurrent start spawns + is retained).

**Phase-6 extensions of this latch family (full-audit-2026-06-29 follow-up; see §37 for the ledger).**
(a) **REL-2** ports the SAME `tearingDown` shape to `VisionService` (which had no orchestrator-level latch):
set at the top of `stop()`, re-checked in `run()` at the top AND after the `getStatus()` await, so a NEW
`analyze()` arriving during teardown can't rebuild the ~4.6 GB vision sidecar past the lock. (b) **REL-3**
adds the missing BETWEEN-batches re-check to `e5.embed()` (it captures `server` once then loops): each batch
re-throws the same recognizable cancellation if `stopped`/`tearingDown` is set or the captured `server` went
stale (`this.server !== server`), so a `suspend()`/`stop()` mid-ingestion ends as a clean cancel instead of a
confusing "llama-server is not started" on the next batch.

**Phase-C extension (full-audit-2026-06-30 R7; see §39).** `VisionRuntime.stop()` re-calls
`cancelIdleTimer()` AFTER its awaits so its "no idle timer is live on return" postcondition holds LOCALLY. The
race is already closed by armIdleTimer's `this.stopped` + `!this.server` early-returns (both set synchronously
by `stop()` before any await — triple-guarded), so this is a defense-in-depth backstop in the same co-guarded
family, not a live fix.

**§5.6 Shutdown latch + cancellable start (full-audit 2026-07-11 CODE-2/CODE-3; rider CODE-11).**
Two quit-path gaps in the manager/ladder lifecycle, closed together:

- **CODE-3 — `RuntimeManager.shutdown()` latch.** The chat manager was the one runtime without the
  `TranslationRuntime.stopped`-style permanent latch. `startModelRuntime` hashes a multi-GB weight
  *before* touching the manager; a quit beginning in that window found nothing to stop, and the hash
  could then complete inside the teardown's awaited windows and enqueue a fresh start AFTER the stop —
  `app.exit(0)` kills the parent mid-start and orphans the child (Windows especially). Now:
  `performShutdown` arms `runtime.shutdown()` (synchronous, latch-only) as its FIRST act; once armed,
  `start()`/`forceRestart()` reject without invoking the factory, a start already sitting in the queue
  refuses inside `doStart` before it can spawn, and `startModelRuntime` re-checks the latch right after
  its hash completes (`ctx.runtime.isShutdown()`). The awaited `runtime.stop()` stays in the sidecar
  block (REL-4 ordering intact — pinned in `shutdown.test.ts`).
- **CODE-2 — cancellable model start.** `stop()` deliberately queues behind an in-flight `start()`
  (that ordering is what prevents orphans), but the start itself was uncancellable — a 20 GB GGUF load,
  or a failing ladder walking up to 3 rungs × 180 s health timeouts, froze quit and "Lock now" for
  minutes (users hard-kill → orphan, the exact outcome the queue exists to prevent).
  `LlamaServer.stop()` during `waitForHealthy` already worked one layer down (the exit-check throw);
  the fix makes it reachable: the manager tracks the in-flight `startingRuntime` and `stop()` forwards
  a cancel to it directly, and `LadderRuntime.stop()` sets a permanent `cancelled` flag that (a) aborts
  the ladder walk between rungs, (b) stops the in-flight rung's server, (c) never persists
  `gpuAutoDisabled` for a killed attempt (not a device fault), and (d) refuses the rung-4 mock fallback
  for a cancelled start. Queue semantics are unchanged — the queued stop still runs after the start
  settles; the start just settles *promptly* now. Never a bare timeout race (would orphan the loading
  child). Pinned in `runtime-manager.test.ts` ("quit-path lifecycle") + `runtime-ladder.test.ts`
  ("ladder start cancellation").
- **CODE-11 — crash-exit child reap (rider).** A hard `uncaughtException` skips will-quit's awaited
  sidecar stops entirely, and on Windows the children survive `process.exit(1)`. Every sidecar spawn
  funnels through `LlamaServer` or `WhisperCliTranscriber`; both now register/deregister their live
  child PIDs in a module-level registry (`runtime/sidecar.ts`), and the crash handler's last act is a
  best-effort synchronous SIGKILL loop over it (throw-safe per PID, after the vault lock). Residual:
  a crash that bypasses `uncaughtException` itself (native crash of the main process, external kill)
  still orphans — accepted; the OS is the only backstop there.

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
toggle is off. **R5 (full-audit-2026-06-30, §39):** the cache `invalidate()` drops only SETTLED probes
— while a probe is still in flight a re-probe COALESCES onto it rather than spawning a second short-lived
child, so mashing the button during a slow/cold driver init can't stack one-per-click children for a binary. All GPU decisions happen post-unlock (settings live in the possibly-encrypted
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
benchmark-card GPU row. Since #36 the Chat header also carries a muted `model · GPU (name)` /
`model · CPU` one-liner (source: the same `RuntimeStatus.backend`/`gpuName`, plus a
`gpuAutoDisabled` enrichment in the `getRuntimeStatus` handler); when CPU comes from the
auto-disable latch it reads `CPU (compatibility mode)` — the persistent, low-key home of the
ephemeral fallback notice (the `runtime:notice` broadcast also re-reads the status so the
hint flips mid-session). Never "GPU failed" / "your hardware is bad".

### GPU failure modes (all handled, none block)

| Failure | What happens |
|---|---|
| No Vulkan loader / 1.2 driver / RDP session | backend lib doesn't load or 0 devices → the default binary runs on its CPU backends; probe shows CPU |
| Driver enumerates but crashes at model load | rung-1 exit → rung 2 (`--device none`), `gpuAutoDisabled` persisted |
| Driver hangs (never healthy) | 180 s (3 min) health timeout (`DEFAULT_HEALTH_TIMEOUT_MS`; the chat runtime never overrides it) → rung 2; cost = one slow first start, then never again (flag persisted) |
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
   file restricts — "policy only restricts" preserved; since 2026-07-01 `prepare-drive` also
   writes `true` in BOTH postures, so a prepared/sold drive lets the buyer add models on demand —
   still gated by the setting + a per-download confirmation, and update-checks + telemetry stay
   denied so the drive never phones home).
2. `settings.allowNetwork` — the spec §3.6 checkbox, **default on** for a fresh DIY/dev install
   (`DEFAULT_SETTINGS.allowNetwork: true`); gate 1's policy ceiling still wins — a `policy.json`
   hand-edited to deny keeps downloads off regardless of the toggle. A locked workspace reads as off.
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
`Range` header (append iff the server answered 206). A cancel is honoured in EVERY live
state — including `verifying`, where the SHA-256 over a multi-GB weight on USB takes
minutes: the hash result is discarded, nothing is renamed into place, and a two-file
(vision) job stops before its next file (full-audit 2026-07-10 BE-4; previously a cancel
there was silently dropped). One download at a time; jobs are
in-memory, polled over `downloads:start/get/cancel` (the Phase-4 import precedent — no new
event channels). On a VERIFIED success the checksum cache is **primed** with the hash just
computed (`models.ts` `primeChecksum`, keyed by the file's size+mtime) so the Models screen's
install-state refresh reports `installed` WITHOUT re-hashing the multi-GB weight — this removed the
invisible post-download "Checking…" gap where the card briefly looked un-downloaded (2026-07-01); a
placeholder-hash completion still invalidates (it is never trusted). **Lock policy
(full-audit 2026-07-10 BE-2): downloads keep running through a workspace lock** — the
weights live outside the vault, and the persistent checksum cache (the job's only DB
touchpoint) is lock-aware: `createSettingsHashStore` takes a `() => Db` getter (never a raw
handle pinned at IPC registration) and degrades to an in-memory fallback while the vault is
closed, and `runOne` treats any cache fault as non-fatal — the cache is an optimization, so
a download that verified while locked still reports `done` and fires `onModelInstalled`. Audit events
(`model_download_started/verified/failed`) flow through the injected
`DownloadManagerDeps.audit` hook; a placeholder-hash completion records NO "verified".
A job reaching `done` additionally fires `DownloadManagerDeps.onModelInstalled` → wired to
`AppContext.onModelInstalled`, which re-runs the startup-frozen availability selectors — the
translation sidecar today (issue #40; the "Translation sidecar" record has the details).
No update checks, no catalog (only manifests already on the drive), no background anything;
a sanctioned download session is by definition not `offlineMode`. Gate semantics +
licensing: `model-policy.md` §"The in-app downloader"; user-facing posture: `PRIVACY.md`.

**`settings.allowNetwork` now defaults ON (2026-06-13).** The spec §3.6 checkbox was flipped
`false → true` in `DEFAULT_SETTINGS` so a fresh install can download models out of the box
(onboarding feedback). Gate 1 (the policy ceiling) is unchanged and still authoritative: a
`policy.json` with `allow_model_downloads: false` — or the packaged-build `STRICT_POLICY` fallback —
keeps the app offline regardless of the toggle. A prepared/commercial drive now writes
`allow_model_downloads: true` (2026-07-01), so the setting + the per-download confirmation are the
effective gate there; update-checks + telemetry stay hardcoded/denied so the drive never phones home.
A locked workspace still reads the setting as off.

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
cursor), and retention to `AUDIT_MAX_ROWS = 5000` (**wave-1 decision D7** —
fixed for wave 1; configurability is Office-edition admin surface). The prune is slack-gated
(full-audit 2026-07-10 PF-3): an insert prunes back to the ceiling only once the table exceeds
`AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK` (250), insert+prune in one transaction, ordered by the
additive `idx_runtime_events_created` — readers never see the slack (`listAuditEvents` clamps
to the ceiling). **For the user, not
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
and removes manual membership-cleanup ordering. (The later skills `bank_*`/`invoice_*` content tables
needed the same treatment — backend audit 2026-06-27 DATA-1 — but since `CREATE TABLE IF NOT EXISTS`
can't add CASCADE to an existing drive, `deleteDocument` ALSO does an explicit ordered delete of those
rows in one transaction; see "Skills — design record" §10.)

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
  only the link. The **collection case of `fileDocumentByDestination` is now FK-guarded the same way
  (DB-1, Chat & Documents audit 2026-07-07):** `foreign_keys` is ON and the membership FK is enforced,
  so a raw `addToCollection` against a deleted/unknown collection id threw `FOREIGN KEY constraint
  failed` (its `ON CONFLICT DO NOTHING` catches only the PK). Thrown inside the import loop's try it
  miscounted the doc `failed`, skipped its `document_imported` audit event, and — the permanent harm —
  left `pending_destination_json` set so every FUTURE re-index rethrew forever. The fix existence-checks
  the collection + try/catch the race and **degrades to the Library default** on a miss (ids-only
  `log.warn`), making `fileDocumentByDestination` TOTAL. The pending-clear `UPDATE` moved into a
  `finally` in `fileFromPendingDestination` as belt-and-suspenders (the generated-doc `origin_json`
  early-return still fires first and never clears — those rows carry no destination). `resolveScope`
  is documented in rag-design §13.
- **`listDocuments` stuck-row reconcile — task gate (DB-3, Chat & Documents audit 2026-07-07).** The
  `registerDocsIpc` list poll reconciles rows left non-terminal by a killed/lock-interrupted run to
  `failed` (so the UI offers Re-index instead of a perpetual "in progress"). It fires only when nothing
  this module tracks is running (`!importActive && processing.size === 0`) — but doc-task ingestions
  (translation-materialize, OCR re-ingest) drive `documents` rows OUTSIDE that `processing` set, so a
  poll during their long chunk/embed window would flip a live row to `failed`. The sweep is now also
  gated on `!ctx.docTasks?.hasActiveTask()` (matching the sibling tree/extract sweeps). **The `now`
  watermark is kept deliberately — NOT swapped for `PROCESS_START_ISO`:** a mid-session lock→unlock
  strands an import whose `updated_at` is AFTER process start, and only a `now` watermark ever
  reconciles it (a `PROCESS_START_ISO` watermark would wedge it forever — the exact regression the
  audit's first-pass suggestion would have introduced). The task gate closes the live-flip hole; the
  `now` watermark keeps mid-session recovery working. The skill-run sweep still uses `PROCESS_START_ISO`
  (its table bumps no timestamp, so `now` would be wrong there — the two watermarks are not
  interchangeable).
- **Documents backend performance — Session 6 (DB-4, DB-5, DB-6, DB-7; Chat & Documents audit
  2026-07-07).** Four perf/reliability fixes on the same import/list/export hot paths, all additive
  guards on top of the Session-1 (DB-1/2/3) correctness work.
  - **DB-4 — the folder-import queue phase is batched.** `importDocuments` called
    `createQueuedDocument` once per file: N single-statement auto-commit transactions + N wasted
    `SELECT *` re-reads, all synchronous on the IPC thread over a high-latency USB DB — a multi-second
    main-process freeze for a few-thousand-file folder before the job even started (the per-row
    auto-commit pattern DB-1 eliminated for chunk writes). New `createQueuedDocuments(db, files)`
    gathers the `statSync` sizes OUTSIDE the write transaction, then commits all N inserts in ONE
    `BEGIN…COMMIT` (ROLLBACK + rethrow on a mid-batch failure → the caller's lease-release catch cleans
    up, nothing half-queued). The shared bare INSERT is factored into `insertQueuedRow` (returns the
    id, no re-read); **`createQueuedDocument` stays byte-identical** (still re-reads the full
    `DocumentInfo` for its single-doc callers — materialize + ~60 tests). Batch mirrors single-doc
    insert-regardless behaviour: an unstatable path still queues a row (null size), so the id list
    aligns 1:1 with the input files and ING-3 in-order push is preserved. **DEFERRED — the walk stays
    synchronous:** `importDocuments` returns `{jobId, documentIds}` synchronously and the renderer +
    ~tests depend on the ids being present at return, so `expandPathsWithSource` (the recursive
    `readdirSync` walk) was NOT moved off the hot handler — that would change the return contract. Left
    for a later pass. *(Deviation from the plan's literal test wording: the direct unit passes 4 files —
    3 real + 1 nonexistent — and asserts 4 ids in order with sizes-where-statable, rather than "3 ids";
    faithfully matching createQueuedDocument's insert-regardless keeps single/batch consistent and the
    import path unchanged.)*
  - **DB-5 — `listDocuments` embedded-count early-out (the count-map cache was DECLINED).** The
    embeddings⋈chunks `GROUP BY` exists only to flag an `indexed` doc whose vectors predate an embedder
    switch (`staleEmbeddings`); the per-row check fires ONLY on an `indexed` row, so when no row is
    `indexed` — the common case on a mid-import poll (rows are queued/extracting/embedding) — the whole
    full-corpus join scan is pure waste. It is now skipped when `!force && rows.some(r => r.status ===
    'indexed')` is false. The covering `CREATE INDEX IF NOT EXISTS idx_chunks_document ON
    chunks(document_id)` was **already present** (`db.ts`) — not re-added. **The `document_id` count-map
    cache was DECLINED (plan decision #4, durable — do not re-litigate):** it needs a wider invalidation
    surface than the F12/PERF-1 resident-vector cache (it must also catch chunk writes that carry no
    embedding, plus any out-of-band writer), and a stale map surfaces as a **user-visible wrong chunk
    badge / false stale-embeddings flag** — poor risk/benefit for a poll-path optimization. The
    DB-3/ING-2 two-query shape and the resident-vector delta are untouched (no new invalidation
    coupling — the whole reason the cache is declined). The M7 stale-embedding path (an `indexed` row
    present) still builds `embeddedCounts` unchanged.
  - **DB-6 — the `jobs` map is bounded (`IMPORT_JOB_CAP = 16`, evict DONE-only).** Every import in a
    long session was retained forever and the `importActive` list-poll iterated all of them. After each
    `jobs.set` the oldest **done** jobs are evicted down to the cap, mirroring `PICKER_TOKEN_CAP` — but
    an **in-flight job is never evicted** (the loop mutates its `status`, the renderer polls it; it can
    also be the oldest entry on a slow import while newer ones finish). A late poll on an evicted (done)
    id still gets the synthetic `done:true` from `getImportJob`, so pollers stop gracefully.
  - **DB-7 — export readers decrypt asynchronously (completes the PERF-1 invariant).**
    `readStoredDocumentText` / `readStoredDocumentBytes` are now `async` and use `decryptFileAsync` +
    `await readFile` instead of the sync `cipher.decryptFile` + `readFileSync`, so exporting a large
    encrypted DOCX/original no longer blocks the main process for the whole decrypt+read (every other
    decrypt on these flows was already async under PERF-1 — this is a fix, not a break). The `finally`
    shred still runs after the await; the §22-M1 content boundary is unchanged. The two callers
    (`exportDocument` handler, `buildOriginalDocumentReader`) were already async and now `await`. The
    `.parse-export-<uuid>` / `.parse-export-bin-<uuid>` transient uniqueness landed in Session 1 (DB-2).
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
| `skills:export/delete` | save dialog ⇒ `.skill.zip` (package tree only) · default-clear + rm folder — message stamps survive (GAP-1/SKA-38; app skills refuse) | `registerSkillsIpc.ts` |
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


## Skills — design record (Phases S2–S13, §1–§21)

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
  `prepare-drive` — never network-fetched. **Eight** bundled app skills now ship. Three are **Tier-2**
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
whole tree, then **places it as plain files at `user-skills/<id>/`** (folder name == manifest id).
Two **DoS-hardening bounds** sit in the staging loop (audit S-1/S-2, Phase 8):
`inflateEntry` rejects a member whose **central-directory `compressedSize` exceeds the per-file cap**
*before* slicing/inflating — bounding the synchronous inflate **input**, not only its `maxOutputLength`
output (a legitimate text member never compresses past the cap); and after the common-prefix strip the
loop **re-asserts `safeRelPath` on the stripped path** and **rejects two members that collapse to the
same `relPath`** (`SKILL_IMPORT_ERRORS.duplicatePath`) so a later duplicate can't last-writer-wins
shadow a preview-validated `SKILL.md`. It then
reconciles the row to **enabled-with-warning** (DS7) — unless an enabled app skill of the same id is
already effective, in which case the import **coexists disabled** (trust-first precedence, DS12). A
lower version is refused unless developer mode (DS15). **Delete** clears the sticky default ONLY
(full-audit 2026-07-11 GAP-1 — the SKA-38 contract): in one transaction it nulls
`conversations.active_skill_id` pointing at the install id and deletes the row (no FK to cascade),
then removes the folder; `messages.skill_id` is deliberately KEPT — the per-message stamp is
provenance, the JOIN title resolves to NULL and the renderer shows "(removed skill)", so the glyph
+ the "answer without it" undo survive deletion. App skills refuse. **Enable**
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
The offer is surfaced **in the composer picker** — pinned atop the menu when it is open, and (U-3)
mirrored as a quiet, named **hint on the CLOSED trigger** (`chat.skill.suggestedHint`, a
`.skill-suggest-hint` footer affordance) so a user who never opens "Skill: none ▾" still sees the
nudge. `ChatScreen` recomputes the offer **proactively as the draft changes** (debounced ~400 ms via
the same defensive `suggestSkills` call, only when no skill is picked) on top of the open-time refresh.
Both surfaces keep the same invariants: **no canvas chip, no settings key, inert until tapped, never
auto-applied** (§22-D3). The closed hint shows **only while no skill is selected and the offer was not
declined** — an explicit "None" pick sets a renderer-side per-draft `suggestionDismissed` flag (reset
on send / conversation change) so it never re-nags; one tap selects the skill. **Auto-fire (S13)** is
the opt-in extension of this same scorer that *does* apply a skill without a tap, behind a separate
higher threshold + an opt-in + a per-turn undo — see **§18**.

### First-selection skill info card (#46, 2026-07-10)

Beta feedback: selecting a skill changed behavior in ways users only discovered afterwards (#44 the
run button, #45 the `.txt` output) — the picker row's one-line description was the entire in-app
explanation. Now the **first** pick of a skill (ever, by declared id) surfaces a compact
**`SkillInfoCard`** above the composer: three one-sentence lines — **what** it does, what it **needs**
to apply (when that's missing the skill silently routes to a plain answer), and its key honesty
**limit** — plus the pick-lifetime footer ("applies to your questions in this chat until you change or
clear it; *Keep for this conversation* saves it") and a **Learn more** link. The lines come from
`shared/skill-info.ts`, a pure-data catalog keyed by manifest `id` holding `skills.info.<id>.what/
needs/limits` i18n KEYS (EN+DE; the `skill-tools.ts` descriptor-table precedent) — **app skills only**;
a user/unknown skill falls back to its own localized description, so the app never invents honesty
claims about content it didn't author. Once-per-skill memory is `AppSettings.skillInfoSeen: string[]`
(declared ids — content-free; the settings service's generic string[] element-wise sanitizer covers
it), marked seen on first showing; afterwards a quiet **ⓘ** next to the picker chip (`SkillPicker`'s
`onInfo` prop) re-opens the card on demand, and it hides whenever it no longer matches the ACTIVE pick.
An unresolved seen-state (settings read pending/failed) shows nothing — a missed first card, never a
re-nag. **Learn more** deep-links the Skills screen's existing detail modal through a one-shot
renderer-side mailbox (`renderer/lib/skillDetailRequest.ts` — `requestSkillDetail(installId)` +
`consumeSkillDetailRequest()` in `SkillsTab`'s list-load effect); nothing crosses the IPC. Tests:
`SkillInfoCard.test.tsx` (catalog lines, description fallback, handlers), `SkillInfoFirstPick.test.tsx`
(ChatScreen: first-pick shows + persists, seen skill needs the ⓘ, active-pick gating, Learn-more
navigation), `SkillsTab.test.tsx` (deep-link opens the modal / unknown id opens nothing),
`db-settings.test.ts` (`skillInfoSeen` round-trip + junk sanitization).

### §7 Tier-2 tool gate (S10)

`services/skills/tool-registry.ts` is the **static, app-owned** map of `SkillTool`s. A skill never
registers a tool: it only *declares* names via `allowedTools`, and the effective set is
`declared ∩ registry ∩ wired` (`resolveWiredTools` — A2 removed the vestigial third `userGrant` leg,
audit §6.4-low; see the A2 note below). Runs are **app-orchestrated**
(DS4): the app calls `runSkillTool(tool, {skillId, input, ctx, confirmed})` directly. The gate's fixed
order: (1) refuse if the `AbortSignal` is already aborted; (2) **validate input** against `inputSchema`
(a hand-rolled JSON-Schema subset — no validator dep) and refuse **without calling the tool** on a bad
shape; (3) refuse a write/export tool lacking `confirmed:true`; (4) run inside a narrow
`SkillToolContext` whose `documentIds` the gate hands over **frozen** (un-widenable scope), with no
`Db`/SQL/FS/net handle; (5) **validate output** against `outputSchema` — a wrong shape **fails the run**;
(6) bracket with ids/counts-only audit (`skill_run_started`/`done`/`failed` = `{skillId, toolName,
documentCount}`). S10 shipped the gate with one harmless reference tool (`count_selected_documents`).
The full ceiling rationale is in [`security-model.md`](security-model.md) "Skill tool ceiling (Tier-2)".
*(Audit X-2, Phase 10: `count_selected_documents` is **kept deliberately as the gate's test-only
canary** — registered, but no bundled skill declares it and it is intentionally **not wired to a
`run.ts` dispatch seam** (`tool-runs.ts buildToolRunner` returns `null` for it), so it is registry-only
and exposes no live capability. It is the minimal reference the gate tests exercise end-to-end. Both
halves are pinned: `skills-tool-registry.test.ts` asserts it is registered; `skills-tool-run-ipc.test.ts`
asserts `buildToolRunner` returns `null` for it — so removing it OR wiring it up both fail a test.)*

*(Audit SEC-1, backend-audit 2026-06-27 Phase 6 — **the trust gate at the runnable-tools surface**.
The `kind:'tool'` flip (§8) made a declared `allowedTools` effective for any non-instruction skill, and
the run surface gated on enabled/compatibility/confirm but **not on `source`** — so the deliberate
posture "**Tier-2 tools run for `source === 'app'` skills only**" is now enforced explicitly. A single
named predicate `skillCanRunTools(skill)` (`tool-runs.ts`, `source === 'app'`) is the gate; it short-
circuits `runnableToolNames` to `[]` for a non-app skill (so `listRunnableTools` + the run bar offer
nothing) and is re-checked at `startSkillRun` (defense-in-depth: a **forged IPC** call with a user
skill's id is refused with the generic, content-free `run.unavailable` string — no title/path leaks,
audit posture intact). A user `kind:'tool'` skill still **keeps** its declared `allowedTools` (the
parser is untouched) for a future per-tool grant UI — it just runs none of them until that UI exists.
Full rationale in [`security-model.md`](security-model.md) "Skill tool ceiling (Tier-2)" → SEC-1.
**API-3:** the audit/run-state `documentCount` is the v1 constant `1` because every wired tool is
single-document; an in-code TODO at `registerSkillsIpc.ts` marks that it must become a **real count**
if a multi-document tool ever lands, else the audit would understate scope.)*

*(A2, audit §6.2/§6.4-low — **the self-describing tool registry**. A 9th tool used to cost ~9
hardcoded edits (the wired-list, the runner switch, the renderer label/done maps, the save-dialog
constants, two locale catalogs) and the drift shipped user-visible bugs: one CSV save dialog served
**every** export, and one app-wide run controller fired "a skill is already working" across unrelated
conversations. A2 makes ONE `SkillToolDescriptor` per wired tool in `shared/skill-tools.ts` the single
source — `{name, labelKey, seamKind, confirm, resultShape, doneKey?/reconcileKeys?/redactionKeys?,
dialog?}` — and **derives** the rest: `WIRED_TOOL_NAMES` (the wired-list), the `buildToolRunner` guard
(dispatch parity — a tool with no descriptor yields `null` before the switch), the renderer's
label/done copy (`SkillRunBar`), and each export's save-dialog metadata (`descriptor.dialog`). The
table is **pure data importable from BOTH processes** (like `shared/i18n`), so the renderer builds its
maps from the same source the main dispatch uses; a parity test pins descriptor ↔ registry (every
wired name registered; the only registered tool without a descriptor is the X-2 canary; `confirm`
matches the permission-derived `toolRequiresConfirmation`; every `export` carries a dialog). The
bank-shaped run-outcome field `transactionCount` became the domain-neutral **`count`** (additive;
`transactionCount` kept as a deprecated mirror on `SkillRunState` for one release; the renderer reads
`count ?? transactionCount`). The trust model is **unchanged**: a descriptor is app-authored metadata,
not a capability — a skill still cannot register or self-grant a tool, and `skillCanRunTools` (SEC-1)
is the trust decision. Full rationale in [`security-model.md`](security-model.md) "Skill tool ceiling".)*

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
*(Phase-4 perf, audit P-1: the read-only downstream seams take an optional `preloaded` rows arg — the
analysis handler loads the rows once and supplies it, so the seam skips its own load — and return their
validated structured `output` for in-process reuse by that handler; both are no-ops for the run-bar/IPC
path, which passes no rows and maps counts only. See §19.)*
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
The packaged `schemas/transaction.schema.json` (the machine-readable row contract that ships inside every
bank-statement export) is **test-pinned** to the live `TRANSACTION_ROW_SCHEMA` in `tools/bank-statement.ts`
by `tests/unit/skills-transaction-schema-parity.test.ts` — a structural compare (property set, per-property
`type`/`pattern`/`minimum`/`minLength`, `required`) that kills the "hand-maintained mirror" drift risk
(skills-audit-2026-07-07 SK-6); the two are field-for-field identical today, `category` included (an optional
persisted label a categorize run attaches, never emitted by the extractor).

**The invoice skill is the SECOND Tier-2 reference** (`app-skills/invoice/`, `id:'invoice'`), proving the
gate generalizes to a second content-class domain with strong EN+DE coverage. It covers the same
five-tool shape as bank-statement: five tools in `services/skills/tools/invoice.ts` — the three core `extract_invoice` (read-only; the
same `readDocumentChunks` reach over the frozen scope), `validate_invoice_totals` (read-only; deterministic
checks within a half-cent epsilon — line items → net, net + tax → gross, tax vs. rate — each
`ok`/`mismatch`/`unknown`, an honest `reconciled` verdict + a `resultKind` discriminator like
`validate_statement_balances`), and `export_invoice_csv` (confirm-gated `export-file`, the line-items CSV).
**Format-transformation exports (invoice-format-2026-07-01):** the domain adds `export_invoice_json` /
`export_invoice_xml` — pure serializers (`buildInvoiceJson`/`buildInvoiceXml`, XML entity-escaped, 2-dp,
stable shape) over the ALREADY-extracted invoice, behind the generic confirm-gated `runInvoiceFileExport`
seam; and an INLINE path (`detectFormat()` in `analysis/invoice.ts`) that renders "… als JSON/CSV/xml" in a
fenced code block. **Design decision (grounded workflow):** format transformation is pure serialization of a
structured object — it takes **no model** (a serializer cannot invent a figure the parser did not, so §22-D1
holds by construction). LLM-assisted **extraction** is deliberately NOT adopted: the shipped small Q4 model
hallucinates figures and grammar-constrained decoding guarantees valid structure but not valid values — so a
guarded LLM extractor (propose → deterministic re-verify vs a verbatim quote + reconciliation →
drop-on-failure) stays **deferred behind a D52 gold-set recall measurement**, mirroring the Phase-33 "a
category is not a figure" boundary. See `BUILD_STATE.md` INVOICE-FORMAT-1.
Parsing is DETERMINISTIC + OFFLINE and CONSERVATIVE (invoice layouts vary — a known limitation that improves
later): header fields and totals are read from **labeled lines only**, line items split a description from a
trailing quantity + trailing unit-price/line-total money tokens, and anything that cannot be confidently
parsed is **dropped** (header fields are individually optional, never guessed). The deterministic money/date
primitives (`parseAmount`/`parseDate`/`detectCurrency`) and the CSV formula-injection neutralization
(`csvField`) are now **shared** by both domains in `services/skills/tools/money.ts` — one parser per locale
rule, one audited export boundary. The Unicode **word-boundary** matcher `wordIncludes` lives here too
(audit C-1, Phase 2): both the deterministic `categorizeRow` and the LLM `prefilterCategory` now call it,
so a coincidental substring (`coffee`⊃`fee`, `atmosphere`⊃`atm`, `mühlohn`⊃`lohn`) can no longer mis-file
a row to *Fees*/*Cash*/*Income* — and the two categorization paths agree on every description rule. It now
has a **two-sided STRICT** mode (the short, ambiguous English tokens) and a **one-sided COMPOUND** mode
(full-audit-2026-06-29 BL-3) the rule table opts the unambiguous German keywords
(`gebühr`/`gehalt`/`überweisung`/`bargeld`) into, so a de-AT closed compound (`kontoführungsgebühr`)
categorizes while the C-1 guards hold (see the 2026-06-29 Phase 1 note below). The run seam is the sibling
`services/skills/invoice-run.ts`: same `skill_runs` lifecycle, same no-partial-persist
(BEGIN…COMMIT/ROLLBACK), same B2/B4 guards, latest-invoice-for-document downstream target, structured input
(no new `SkillToolContext` accessor — the §14 ceiling is unchanged). The dispatch (`tool-runs.ts`) wires the
five names; the controller / IPC / renderer stay domain-free (the renderer adds only the five tool labels
+ the invoice `resultKind` copy). Content-class isolation holds: the new `invoices` / `invoice_line_items`
tables + `skill_runs` never appear in any log/audit/export (audit stays `{skillId, toolName, documentCount}`).

**A1 — one domain-parameterized run seam (audit §6.1 + §6.4 plumbing bullet; 2026-07-03).** `invoice-run.ts`
was originally a ~500-line **layer-for-layer copy** of `run.ts` — the class that shipped the "45 vs 22
transactions" divergence (two drifted segment readers + a missed `replaceExisting`) and R3's one-path-only
staleness fix. A1 folded that copy into ONE generic engine in `run.ts` (`runDomainExtractionInner`,
`prepareDomainRun` — which owns the SINGLE R3 staleness re-extraction path — `domainPersistFailure`,
`runDomainFileExport`) driven by a per-domain **`DomainRunConfig`** (`{extractToolName, latestId, isStale,
reExtract, deleteForDocument, insertExtraction, countOf, load, toToolInput, buildDownstreamReader,
messages}`). `run.ts` holds `BANK_RUN_CONFIG` + the thin public adapters (`runBankExtraction`, the four
downstream seams) that own the per-document lock and reshape the generic result to the domain-named
`statementId`/`transactionCount` fields; `invoice-run.ts` shrank to `INVOICE_RUN_CONFIG` + its adapters +
`insertInvoiceExtraction` + the ONE authoritative `loadInvoice` (now exported, so `analysis/invoice.ts`
imports it instead of a byte-identical copy). Strictly behavior-preserving (green-to-green, unchanged test
count) — every difference the copies had is a config value/function. **One incidental difference is
PRESERVED, not fixed:** the downstream-run ctx reader is built lazily (bank: `buildReadDocumentChunks`, no
I/O) vs eagerly (invoice: `resolveDocumentReader`, a discarded full-segment read) — inert because
structured-input tools never read chunks; unifying it would change per-run I/O, so it is `buildDownstreamReader`
config and left for a follow-up. The duplicated analysis-handler plumbing (`singleInScopeDocument` ×3,
`shouldFallThroughOnEmpty`, `computeCoverage`, `fmt`, the citation query + `[Sn]` projection) is lifted into
`services/skills/analysis/common.ts`; the per-domain citation SELECTION strategy (bank page-narrow+head;
invoice head+tail) stays in each handler and calls the shared `loadCitationChunks`/`chunksToCitations`.

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
`services/skills/run-controller.ts` owns each active run's lifecycle (state/progress/cancel) and knows
nothing about banks; the bank seam is handed in as an opaque runner by the dispatch
`services/skills/tool-runs.ts` (the one place allowed to map a tool name to `run.ts` — §13).
**Concurrency is keyed per-document (A2, audit §6.2):** the controller holds a `Map<documentId,
ActiveRun>` so unrelated documents/conversations run in parallel; only a second run on the **same**
document is refused. (The old single app-wide slot fired "a skill is already working" across unrelated
chats. The **doc-lock** below — §9-PC-1 — is the real serializer of true same-document write conflicts,
so per-document concurrency here is safe.)
Four generic `skills:*` IPC channels (`listRunnableTools` / `startSkillRun` / `getSkillRun` /
`cancelSkillRun`) wrap it: all `requireUnlocked`, the document scope resolved **main-side** (§22-C4),
the run returning **ids/counts only** (`SkillRunState` = state/progress/counts, never the rows). The
renderer's calm `SkillRunBar` (a `lib/skillruns.ts` polling store — no new event channel) shows the
offer, the busy row ("Running: `<tool>` on `<N>` documents… Cancel"), and the result; write/export tools
are gated by a `ConfirmDialog` before the run starts. **Only an IN-FLIGHT run (running / state-unknown)
suppresses the offer (#44):** a terminal, un-dismissed result row renders ABOVE a restored offer, so
the deterministic routing answers (which name the run button unconditionally — see the routing-handler
record below) can never point at a button a stale result is hiding. For the two document-transform
tools (the descriptors carrying a `docxDialog`) the confirm body also **states the output format up
front (#45)** — derived renderer-side from the selected target's extension, the same signal main's
`buildOriginalDocumentReader` branches on: `.docx` keeps its Word format, anything else saves as a
plain-text `.txt` copy (`chat.skill.confirm.outputDocx`/`outputText`; unknown target name → the full
`outputMatrix` line, never a guess). The renderer derives each tool's label + done
copy from the shared `SkillToolDescriptor` table (A2 — no parallel renderer copy maps), rendering the
`reconcile`/`redaction` result shapes from a content-free `resultKind` discriminator ('reconciled' |
'unreconciled' | 'unchecked'; 'clean' | 'redacted') — the controller/IPC stay bank-free (the
discriminator is an opaque string; the meaning lives only in the descriptor's copy keys). The run's
count rides `SkillRunState.count` (A2's domain-neutral rename; `transactionCount` mirrored one release).

**Run-UI target document for a multi-doc scope (audit U-1).** The v1 tools are single-document, but a
conversation's scope can hold several indexed documents. Rather than silently acting on `docIds[0]`
with an opaque "1 document" label, the run UI surfaces — and lets the user choose — the target:
`listRunnableTools` returns `RunnableToolSet = { tools, documentIds }`, where `documentIds` is the
in-scope indexed ids **in main's resolution order** (`[0]` = the default target). The renderer maps
those **ids → NAMES from its own already-loaded document list** (`docs`/`attachments` in `ChatScreen`),
so a document **title/filename never crosses the IPC** (the §6 content-adjacent posture): `SkillRunState`
and the `skills:*` channels stay ids/counts only. With exactly one in-scope doc the `SkillRunBar` shows
its name (a disabled chooser); with **more than one** it shows a small Radix dropdown (the DepthMenu
pattern) and passes the chosen `documentId` to `startSkillRun`. That id is **UNTRUSTED**: `startSkillRun`
re-resolves the in-scope set and **refuses** an id not in it (`main.skills.run.documentOutOfScope`) —
never trusting a renderer-supplied id past the scope filter; `documentCount` stays the honest **1** (a
single-doc tool), not "all N". The busy/result row names the running target from a renderer-remembered
name (resolved at launch from the same list), falling back to the legacy count label when unknown (e.g.
after a remount). The redaction **routing** answer is likewise count-honest: with scope > 1 it uses
`skills.redactionRouting.answerMulti` ("pick which document on the button"), still content-free.
**Post-extract categorize is an explicit offer (audit U-2, Phase 6):** a read-only extract no longer
silently starts the LLM categorizer; after a successful rows>0 extract the result row offers a one-tap
**"Categorize transactions"** follow-up that targets the SAME document via a renderer-remembered id
(`runTargetId`, the sibling of `runTargetName`) — see §22. The model pass is user-initiated; the run
state stays content-free (no documentId in `SkillRunState`).

**Cross-lane write safety — per-document serialization (audit PC-1, Phase 9).** Three INDEPENDENT
execution lanes can touch the same bank/invoice tables (§22 / the audit §2.3): **Lane A** the chat
analysis auto-run, **Lane B** this `SkillRunController` button run, **Lane C** the `DocTaskManager`
categorize. The main process is single-threaded, so the hazard is not an OS data race but **cooperative
interleaving across `await` points** — one lane parked at an await (e.g. re-reading the stored document)
while another runs its DELETE+INSERT on the SAME statement (the cardinal case: a chat re-extract
`replaceExisting` DELETE racing a button/categorize run → "statement vanished mid-read", orphaned rows,
a nondeterministic final state). A lightweight in-process **per-document async mutex**
(`services/skills/doc-lock.ts` `withDocumentLock(documentId, fn)` — a `Map<documentId, Promise>` chain,
**re-entrant** within one async call chain via `AsyncLocalStorage`) now serializes every **write-capable**
section by `documentId`: the write seams (`runBankExtraction` incl. its `replaceExisting` DELETE+INSERT,
`runBalanceValidation`, `runCategorization`, `runInvoiceExtraction`, `runInvoiceTotalsValidation`)
**self-lock**, and the two MULTI-step lanes wrap their WHOLE sequence in one outer `withDocumentLock`
(the analysis handlers' extract→validate→categorize, and `runCategorize`'s extract→categorize-persist),
so a re-extract from another lane cannot slip BETWEEN a lane's own steps (the inner self-locks are
re-entrant no-ops under the outer hold). **R9 (skills-audit-2026-07-03 SKA-28) closed the last two
unlocked downstream seams:** `runCashflowSummary` and `runDomainFileExport` (all CSV/JSON/XML exports)
now hold ONE re-entrant lock across prepare (incl. the R3 staleness re-extract) + row load +
serialization — previously the self-locked re-extract RELEASED before the load, and a competing
`replaceExisting` extract could interleave in that microtask gap (empty CSV, "saved 0 rows"). The
export's hold is **released BEFORE the save dialog** (the serialized text is materialized first — a
minutes-open dialog must not block the categorize doctask / chat analysis on that document);
`redact_document` still needs no lock (no bank/invoice table). **R9 (SKA-24) also made acquisition
abort-aware:** `withDocumentLock(id, fn, signal?)` — a waiter still PARKED behind another lane (a run
queued behind a long categorize) rejects with `AbortError` on cancel instead of a dead "running"
spinner; the published chain tail still settles (the aborted waiter releases its own link), so later
callers never wedge. The seams thread `deps.signal`, the analysis handlers thread the turn signal, the
categorize doctask threads its task signal. **Posture:** NO new DB/FS/net capability (an in-memory map in the one
main process; the workspace DB is single-writer anyway), no schema change, no IPC change, the audit
payload still `{skillId, toolName, documentCount}`; the key is a document **id** (never content) and
nothing new is logged. The DELETE+INSERT re-extract is already one `BEGIN…COMMIT` — the mutex serializes
*lanes*, that txn keeps a *single* re-extract atomic (no new transaction was added). **Granularity:**
per document — unrelated documents still run fully concurrently. **No deadlock:** the doc lock is finer
than `DocTaskManager.acquireChatSlot()` / the `ModelSlotArbiter` and is always released in a `finally`;
the analysis lane acquires the chat slot FIRST and only then the doc lock, and Lanes B/C never acquire
the chat slot — so no party ever holds the doc lock while waiting on the chat slot (no cycle).

**Renderer run lifecycle — the per-run store (skills-audit-2026-07-03 U6, SKA-6/17/18/25/29/37/38/39/40/41).**
A2 made runs per-document concurrent MAIN-side, but the renderer kept a SINGLE module-level `active` run and
ChatScreen rendered that one app-wide run's bar in EVERY conversation — a second run silently abandoned the
first, a conversation switch could categorize the WRONG document, and a routed answer could be dismissed from
the wrong chat. U6 gives the renderer the same per-document model A2 gave the controller.
`renderer/lib/skillruns.ts` is now a **multi-run store keyed by `runHandle`**: each entry carries
`{run, conversationId, documentId}`, every live handle is polled on its own timer, and the
`useSyncExternalStore` snapshot is rebuilt (a new array) ONLY on a real change — a **shallow-compare**
(`state`/`count`/`resultKind`/`progress`) gates the notify, so a 400 ms no-op poll no longer re-renders
ChatScreen (SKA-39). ChatScreen derives the active conversation's run via `pickConversationRun` and renders
the busy/result bar ONLY when `conversationId === activeId`; a quiet **"working in another chat"** chip covers
runs elsewhere (SKA-6). Poll resilience: **N consecutive failures** flip the entry to a labelled
*"state unknown"* row rather than silently dropping a live run (SKA-40). Reload re-attach: a **`listSkillRuns`
IPC** (ids/counts only — `SkillRunState[]`, which now additively carries the content-free `conversationId?` +
`documentId?`) lets a freshly-mounted renderer **re-adopt** every run main still holds (running AND
terminal-unacknowledged), so a finished run's outcome is shown/acknowledgeable after a reload; a busy refusal
returns the running handle as a fallback re-attach path; the controller **TTL-sweeps** never-acknowledged
terminal runs so its Map stays bounded (SKA-17). The routed-run relay invariants survive the rewrite: the
answer lands only in the launching conversation (C1 — the bar is conversation-gated, so a foreign run is
simply not this effect's run), routed under the RUN's skill (C2), pinned to the run's document resolved from
the store entry BEFORE acknowledge (ux-6). Confirm-refusal: the post-extract **Categorize** offer is hidden
when its remembered document left the current scope, and MAIN **hard-refuses** a confirm-gated run whose
requested document is out of scope even at a single-doc scope (SKA-29 — never trusting main's single-doc
fallback for a write/export; read-only tools keep it). The transcript's undo/*Try again* render only on the
conversation's LAST message when it is the assistant turn (SKA-37), and the glyph + undo key off the persisted
`messages.skill_id` with a *"(removed skill)"* label so a deleted skill keeps its provenance (SKA-38). The
run bar's `aria-live` region is a single always-mounted status container (SKA-41); the 'new'-composer pick is
cleared after being carried onto the created conversation (SKA-18); and the cancel IPC requires a non-empty
handle, with `requireUnlocked` on get/list/cancel/clear (SKA-25). Full residuals in
[`known-limitations.md`](known-limitations.md).

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

**Deletion safety (backend audit 2026-06-27, DATA-1).** The bank/invoice tables reference `documents`
(and their parents) — but the original S11a/S11c DDL omitted `ON DELETE CASCADE`, while `deleteDocument`
deleted only chunks/embeddings/the row. With `foreign_keys = ON` that left the final `DELETE FROM
documents` to throw `SQLITE_CONSTRAINT_FOREIGNKEY` *after* the file was shredded — a corrupt, undeletable
document. Fixed two ways: (1) `deleteDocument` now purges every derivative in FK order inside **one
transaction** — `ingestion/index.ts purgeDocumentDerivatives` (embeddings → chunks → tree_nodes) →
`skills/run.ts purgeSkillDataForDocument` (bank_corrections → bank_transactions → bank_statements,
invoice_line_items → invoices), the **single authoritative teardown list** (MAINT-1) reusing the
re-extract delete — and shreds the workspace copy only **after** the commit; and (2) the schema now
declares `ON DELETE CASCADE` down both chains, so a *fresh* DB stays safe even on a bare `DELETE FROM
documents` (defense-in-depth for the next table). `CREATE TABLE IF NOT EXISTS` can't add the cascade to
an **existing** drive, so there the explicit ordered delete is what's load-bearing — no table-rebuild
migration (the ordered delete already closes the bug). Pinned by
`tests/integration/document-delete-derivatives.test.ts` (real bank+invoice extractions deleted cleanly on
a simulated pre-fix drive; teeth = the un-cascaded FK throws without the ordered delete; plus the
fresh-schema cascade).

**Financial-extraction correctness (backend audit 2026-06-27, Phase 2 — BL-1/BL-2/BL-3).** Parsing/
aggregation-logic only; no schema or audit-payload change (figures stay content-class — never logged/
audited/exported).
- **BL-1 — value-date column (the LINE PARSER, `tools/bank-statement.ts parseLine` +
  `tools/invoice.ts parseLineItem`).** A DACH statement row often prints BOTH a booking date
  (Buchungstag) and a value date (Wertstellung/Valuta) as its first two columns. The shared `MONEY_RE`
  reads a `dd.mm.20yy` date's `.20yy` tail as a 2-decimal amount (`07.06.2026` → `07.06.20` → 706.20),
  so a value date left in the scanned remainder either became the row's first "money" match (empty
  description → the row **silently dropped**) or fed a wrong figure as the amount. Fix: a shared
  `tools/money.ts splitLeadingDates(line)` strips the **whole leading run** of date tokens before the
  money scan (not just the first token); `parseLine` records the first as the booking `date` and a second
  as the optional `valueDate` (schema/CSV already carry it), `parseLineItem` strips and discards (line
  items have no date field). Capped at two leading dates (booking + value), stops at the first non-date
  token (a description is never consumed), handles either column order. The money scanner's **last-token**
  readers (`lastMoneyOnLine` / balance / invoice-total) take the trailing figure — but a **TRAILING** date
  token corrupts that (`Endsaldo 1.234,56 EUR per 30.06.2026` read `30.06.20` → 3006.20), so the original
  "they were never affected" claim was **WRONG**: corrected by **full-audit-2026-06-28 BL-N2** (those
  readers now scrub date tokens via `money.ts stripDateTokens` before the money scan — see the
  full-audit-2026-06-28 record below). This is the **line-parser fallback** (plain-text statements, CSV, and the
  invoice path — which has no geometry pass); the geometry layout's own out-of-column value-date handling
  is §21 (the booking-date column model), a separate seam. Pinned by the 4-column `Buchung Valuta Betrag
  Saldo` fixtures (`skills-bank-statement-tool.test.ts` unit + `skills-analysis-bank.test.ts` end-to-end);
  teeth = reverting to the single-token strip drops/mis-values the rows.
- **BL-2 — single-currency precondition on the completeness gate (`assessCompleteness` /
  `isStatementComplete`) and `reconcileBalances`.** Both summed amounts across currencies: the gate tied
  `opening + Σamounts == closing` and the reconcile chained `prevBalance + amount` regardless of currency,
  so a mixed-currency statement could be mislabelled `complete`/`contradicted` or carry a spurious
  per-row `mismatch`. Now both mirror `summarizeCashflow`'s `currencies.size === 1` guard:
  `assessCompleteness` returns `'unverified'` for a mixed-currency statement (never claims a verdict from
  a meaningless cross-currency sum) and `reconcileBalances` reports every row `unknown` (never reconciled).
  `buildBankAnswer`'s honesty branches are **unchanged** — the mixed-currency answer was already gated on
  `summary.currency` (the `noCurrency` branch), so the SKILL.md ⇔ TS parity contract
  (`skills-skillmd-parity.test.ts`) holds without a wording change; the fix hardens the **public
  predicates** a future caller might trust. Pinned by mixed-currency `assessCompleteness`/`reconcileBalances`
  unit tests; teeth = removing either guard flips the verdict back.
- **BL-3 — currency-blind `categoryTotals` (`analysis/bank-statement.ts`).** The per-category accumulator
  keyed by category alone, summing signed amounts across currencies into one figure. Now keyed by
  `(category, currency)` — each `CategoryTotal` carries its own currency and `buildBankAnswer` renders it
  with `c.currency`. The breakdown is only ever rendered on the **single-currency branch** (so the live
  output is byte-identical, confirmed by the unchanged category tests); the fix removes the latent
  currency-blindness for any future reuse.

**Financial correctness (full-audit-2026-06-28, Phase 1 — BL-N1…N6 / TEST-N2/N6).** A follow-up
multi-persona audit found the §22-D1 honesty posture undermined by locale/grouping parse bugs in the SAME
line-parser layer (silent row loss + confidently-wrong figures) plus under-masking in redaction. Two of the
findings (BL-N1, BL-N2) directly contradicted the just-closed §24 claims. Parsing/aggregation only — no
schema, IPC, or audit-payload change (figures stay content-class). All driven by **adversarial WHOLE-STRING
tests through the real entry points** (closing the TEST-N2 gap: the prior tests fed pre-isolated tokens and
missed the live `MONEY_RE`/`parseDate` bugs). Two owner decisions were taken before implementing:
- **BL-N1 — per-document date-order inference (`money.ts inferDateOrder` → `parseDate(token, order)`,
  threaded through `splitLeadingDates` / `extractTransactionRows` / `extractStatementBalances` /
  `extractInvoice` / `parseLineItem`).** `parseDate` was day-first only, so a US `mm/dd/yyyy` statement
  either **dropped the whole row** (`12/31/2026` → null → `parseLine` returns null) or attached a
  **confidently-wrong month** (`03/05/2026` → 3 May). **DECISION 1 as built (owner): per-document locale
  inference.** `inferDateOrder` scans the document's `nn[./]nn[./]yyyy` tokens and switches the WHOLE
  document to month-first ONLY when one is unambiguously US-ordered (its **second** field is 13–31) AND none
  is unambiguously EU-ordered; otherwise the de-AT **day-first DEFAULT** holds (a fully-ambiguous or
  self-contradictory document is never guessed). This stops the silent row-drop and the wrong month without
  a result-attached caveat (the output schema is frozen for Phase 1). **NB:** the audit's BL-N1 prose stated
  the trigger with the fields **swapped** ("first field > 12 → mm/dd"), which is logically inverted — a
  first field > 12 can only be a **day**, forcing day-first; the mechanically-correct rule (a **second**
  field > 12 forces month-first) is what shipped. **Redaction deliberately does NOT infer** (it stays
  day-first — see BL-N6).
- **BL-N2 — trailing-date balance/total lines (`money.ts stripDateTokens`, used by `lastMoneyOnLine` and
  invoice `lastMoney`).** The last-token balance/total readers read a **TRAILING** date as the figure:
  `Endsaldo 1.234,56 EUR per 30.06.2026` → last MONEY_RE match `30.06.20` → **3006.20** — a wrong
  opening/closing that flips `assessCompleteness` between `complete`/`contradicted` (it can suppress an
  honest total or bless a partial one). This **disproves** the BL-1 "last-token readers were never affected"
  claim (corrected above). Fix: scrub every date-shaped token before the money scan, so a date at **EITHER**
  end is removed — the de-AT date-FIRST `Kontostand per <date> <figure>` shape still reads its figure.
- **BL-N3 — amount column by POSITION (`bank-statement.ts parseLine`).** The amount was `matches[0]` (the
  FIRST money token), so a money-shaped reference in the description stole the amount **and its sign**
  (`Betrag 100,00 EUR -100,00 900,00` → 100, not −100). Fix: with a running balance present (≥2 figures) the
  amount is the **second-to-last** figure and the balance is the last; with one figure it is the amount.
  **Byte-identical on the normal 2-figure row.** (The geometry column model, §21, remains the stronger
  separator; this is the plain-text fallback — a money-shaped token *in* a description is a documented
  residual, known-limitations.)
- **DECISION 2 as built (owner): full grouping support (`MONEY_RE`, TEST-N2).** `MONEY_RE` required a 2-dp
  decimal tail, so a bare de-AT thousands figure `1.000` matched `1.00` → **€1 (a 1000× understatement)**,
  space-grouped `1 234 567,89` read 567.89, and Swiss apostrophe `1'234.56` read 234.56. `MONEY_RE` now has
  three ordered alternatives — space-grouped, the original `.`/`,`/apostrophe **decimal** form, and a bare
  `[.,']`-grouped **thousands** form — with a trailing `(?!\d)` so `1.000` falls through to the thousands
  form → 1000, a **leading `(?<!\d)` anchor** so a match can never start mid-digit-run, and a
  **`(?<![A-Za-z0-9])` boundary on the space-grouped form** so its leading 1–3-digit group only fires at a
  clean word boundary. Together the two boundaries stop the space-grouped form from fusing the 3-digit
  **tail** of a preceding token across a space — whether that tail follows a digit (the geometry
  continuation-line `…778899 300,00` → "899 300,00" → 899300, caught in the pre-merge full-suite run) or a
  letter (`Ref123 456,78` → "123 456,78" → 123456.78, surfaced by the adversarial review). `parseAmount`
  was already correct (it strips spaces/apostrophes and applies the 3-trailing-digit thousands rule), so
  **only the capture changed**. Quantifiers stay bounded/non-backtracking — the ReDoS guarantee holds (the
  200k-char regression tests pass).
- **BL-N5 — integer-cents reconcile (`reconcileBalances`).** The per-row running-balance check compared
  `Math.abs(printed − expected) < MONEY_EPS` in **floats** while `assessCompleteness` (audit C-3) uses
  **integer cents**; a per-row `mismatch` forces `contradicted`. Reconcile now uses the IDENTICAL
  `Math.round(x*100)` integer path — a **consistency/defensive** fix (no realistic 2-dp input distinguishes
  the two; the teeth are structural, so its test is a regression guard, not a before/after flip).
- **BL-N4 — redaction under-masking (`redaction.ts`).** `PHONE_RE` matched only `+`/`0`-prefixed numbers,
  and IBAN detection was case-sensitive (`de89…` survived). Added a **PUNCTUATED** US/national 3-3-4 phone
  alternative (optional leading `1`; `[.\-]` only — so a bare 10-digit run, a prose space-triple, and a
  slashed date are left alone) and a **second case-insensitive COMPACT IBAN** candidate (`maskIbans`
  uppercases before per-country length validation) that catches a lowercase compact IBAN without the
  space-grouped form eating a trailing lowercase prose word. Detection stays conservative (prefer a miss
  over over-masking).
- **BL-N6 — redaction date-masking asymmetry (DOCUMENTED, lowest priority).** `maskDates` masks every
  `parseDate`-valid token and **does not infer locale** (unlike extraction — by design), so an EU
  `31/12/2026` masks while a US `12/31/2026` **leaks** — a locale-asymmetric OUTPUT. Kept best-effort and
  documented in known-limitations; a date-category toggle is a deferred higher-recall wave. There is **no**
  path where masked text is un-masked or a detected value reaches a log/audit (privacy posture unchanged).

**Financial correctness (full-audit-2026-06-29, Phase 1 — BL-1/BL-2/BL-3).** A fresh 7-persona audit found
three more correctness bugs in the SAME shared line-parser / categorizer layer, all verified by direct
trace and fixed **test-first** through the real entry points (parsing/categorization only — no schema, IPC,
or audit-payload change). One is HIGH (wrong figures); two are MEDIUM (silent suppression / mis-bucketing on
the de-AT target locale).
- **BL-1 — leading-minus sign theft (`money.ts MONEY_RE`), HIGH.** The trailing `\s*\)?-?` reached ACROSS
  the column gap and consumed the LEADING minus of the next money token, so `2.500,00 -500,00` parsed as
  amount −2500 / balance +500 (**BOTH** signs flipped). Because every figure flipped UNIFORMLY the running
  chain still tied out, so `reconcileBalances` reported `ok` on confidently-wrong figures — the safety net
  could not catch it. It triggers on ANY negative running balance / leading-minus amount (overdrafts,
  US/international statements, and the §21 PDF-geometry path, which emits a negative balance verbatim). The
  team's own fixtures never used a negative balance, which is why it slipped past the BL-N* round. **Fix:**
  the trailing sign/paren region is now **SPACE-DISAMBIGUATED** — `(?:-|\s*\)|\s+-(?!\s*[-+(]?\d))?` — a
  **glued** trailing minus (`45,90-`, the de-AT debit sign) is always consumed, a paren close is consumed,
  and a **spaced** trailing minus is consumed only when NOT immediately followed by a figure. The
  disambiguator is the SPACE: a glued `-` belongs to the figure on its LEFT, a `-<digit>` after a space is
  the next figure's leading sign. This deliberately **differs** from the audit's first-pass
  `(?:-(?!\s*[-+(]?\d))?` suggestion: once that form's `\s*` has run it also refuses the glued case and
  would have **regressed** the common de-AT row `45,90- 1.908,20` (glued debit + running balance) to
  +45,90. The trailing scans stay UNAMBIGUOUS (each whitespace run is followed by a disjoint atom) and the
  lookahead is zero-width, so MONEY_RE remains ReDoS-linear (the 200k-char regression test stays green).
  Residual: a SPACED trailing minus immediately before a balance figure (`45,90 - 1.908,20`) reads positive
  — genuinely indistinguishable from subtraction (known-limitations).
- **BL-2 — figure-region currency (`bank-statement.ts parseLine`), MEDIUM.** Per-row `detectCurrency(line)`
  scanned the WHOLE line including the free-text description, so a EUR row whose memo read `Netflix USD
  subscription` was tagged USD → the row-currency set grew → `summarizeCashflow` returned no single total,
  `reconcileBalances` marked **every** row `unknown`, and `assessCompleteness` dropped to `unverified`. One
  description string silently killed totalling for the whole statement. **Fix:** detect the per-row currency
  only in the **figure region** (`rest.slice(matches[0].index)` — the text from the first money token on),
  falling back to the statement currency. A currency WORD in the description is ignored; a GENUINE
  foreign-currency row (code/symbol printed NEXT TO the amount, inside the figure region) is still detected,
  so mixed-currency honesty is preserved — preferred over `statementCurrency ?? detectCurrency`, which would
  silently sum a truly-mixed line in one currency.
- **BL-3 — German closed-compound categorization (`money.ts wordIncludes`), MEDIUM (de-AT target locale).**
  The C-1 two-sided word boundary (which stopped `fee`⊂`coffee`) ALSO stopped the de-AT keywords from ever
  matching, because German fuses keywords into closed compounds where the keyword sits at a word edge on
  only ONE side (`kontoführungs+gebühr`, `gehalts+zahlung`) — so account/bank **fees** fell through to the
  generic Spending bucket and überweisung/gehalt compounds missed. **Fix:** `wordIncludes(haystack, needle,
  compound)` gains a **COMPOUND** mode (a boundary on EITHER side suffices — one-sided, not raw substring,
  so a keyword buried with letters on both sides is still rejected); the rule table opts the **unambiguous**
  DE keywords (`gebühr`/`gehalt`/`überweisung`/`bargeld`) in via a per-rule `compound: true`. Short English
  tokens (`fee`/`atm`/…) and the ambiguous `lohn` (⊂ `muehlohn`/`Belohnung`; income is covered by the
  positive-sign fallback) stay **STRICT**, so no C-1 false positive returns. Both `categorizeRow` and
  `prefilterCategory` thread the flag, so the two deterministic paths still **agree** (the C-1 invariant).
  The flag is **matching-only** — `run.ts` seeds just `match_kind`/`pattern` into `bank_category_rules`
  (transparency), so nothing is persisted and no schema change is needed.

**Financial correctness (full-audit-2026-06-29-postmerge, Phase 1 — F1/F3/F6/F8 + T5).** A post-merge
fresh pass found the prior round's **bank** hardening (BL-1/2/3) had not propagated to the sibling
**invoice** path, plus a HIGH amount-column hazard on both. Parsing-only (no schema/IPC/audit-payload
change); all fixed **test-first** through the real `extractTransactionRows`/`parseLineItem`/
`validateInvoiceTotals` entry points (characterization-first, then flipped to the correct values).
- **F1 — uncaptured amount column read the running BALANCE as the amount (`bank-statement.ts parseLine`
  + `invoice.ts parseLineItem`), HIGH.** A whole-euro amount (`50`) or single-decimal (`12,5`) is rejected
  by the 2-dp `MONEY_RE`, so `Sparen 50 1.234,56` collapses to ONE money token — the *balance* — and the
  position heuristic took it as the movement amount (off by the whole balance magnitude; `reconcileBalances`
  cannot catch it because the row records no `balanceAfter`). **Fix — STATEMENT-CONTEXT-AWARE drop (diverged
  from the audit's literal "drop whenever a left digit-run remains").** `parseLine` now FLAGS
  `ambiguousAmount` (one money token + a description ending in a bare number); `extractTransactionRows` drops
  the flagged row **only when the statement has a balance column** (`rows.some(r => r.balanceAfter !==
  undefined)`). The unconditional drop the audit suggested **regressed the flagship HVB "Umsätze"** no-balance
  format (`pdf-bank-layout.test.ts`), where a numeric-ending payee (`REWE … 1234 -19,15`) is a single-token
  row whose lone figure genuinely IS the amount — so it must be kept. The **invoice** mirror drops on the
  OPPOSITE side: it reads the line total as the LAST figure, so it drops a row with an uncaptured numeric
  column to the **RIGHT** of the last money token (`Hosting 12,50 500` → the real total `500` lost), while a
  bare number to the LEFT is a quantity (kept). Residual: a *lone* `Sparen 50 1.234,56` with no balance-column
  row to establish context keeps the old read; and a balance-column row that legitimately has a missing
  balance + numeric payee is dropped (recall loss, never a wrong figure) — both documented in known-limitations.
- **F3 — invoice per-line currency from the WHOLE line + missing single-currency guard (`invoice.ts`),
  MEDIUM.** The BL-2 figure-region fix was never applied to the invoice path: `detectCurrency(line)` scanned
  the description, so `USD adapter cable 12,50` on a EUR invoice tagged the line USD (ISO codes scan before
  symbols). **Fix:** detect on the figure region (`rest.slice(matches[0].index)`) with `documentCurrency`
  fallback — mirror of `bank-statement.ts`. Separately, `validateInvoiceTotals` gained the bank gate's
  **single-currency guard**: a line-item currency set of size > 1 returns `lineItemsSumToNet: 'unknown'`
  rather than summing `lineTotal` across currencies into a meaningless cross-currency figure.
- **F6 — space-column FUSION on the geometry-less invoice path (`invoice.ts isFusedSpaceGroup`), MEDIUM.**
  `MONEY_RE`'s space-grouped alternative reads `<1-3 digits> <3 digits>` as one figure, so `Widget 10 100`
  fuses to `10 100` → 10100 (~100× too large). The bank path is mitigated by the geometry column model (D58);
  the invoice path has no backstop (F10). **Fix:** a matched token with an interior space and NO 2-dp decimal
  tail is the fusion-prone form (a real line total prints cents) → drop the row. A decimal-anchored space group
  (`1 234 567,89`) is kept; a space group WITH a decimal (`15 799,00`) stays the accepted DECISION-2 trade-off.
- **F8 — greedy `quantity` split (`invoice.ts QTY_TRAIL_RE`), LOW (metadata).** A trailing number was split off
  the description as `quantity` even with no unit word, so `iPhone 15` → "iPhone" qty 15. **Fix:** the unit
  token is now a CAPTURING group; the split fires only when a unit token is present OR a unit-price column
  (`amounts.length >= 2`) corroborates it. The columnar `Widget A 2 12,50 25,00` still reads quantity 2.
  `lineTotal` was never affected.
- **T5 — the 2-dp integer-cent invariant (`money.ts parseAmount`).** `parseAmount` now rounds every figure to
  the nearest cent (`Math.round(|value|*100)`), so `Math.round(x*100)` is its EXACT cent value — the
  load-bearing premise of `assessCompleteness`/`reconcileBalances` (which tie out in integer cents) and CSV
  `toFixed(2)`. **Decision:** a >2-dp printed figure (only reachable via the both-separator `1.234,567` form)
  is read to the nearest cent (`1234.57`), **not dropped** — a sub-cent normalisation, never a
  confidently-wrong magnitude. (Single-separator 3-digit-group thousands forms `1.000`/`12.345` are integers,
  unaffected — DECISION 2.) Parens-negative through the real scanner (T4) and negative line totals / credit
  notes (Gutschrift/Rabatt, T9) are now pinned by whole-string tests.

**Financial correctness (full-audit-2026-06-29 follow-up, Phase 1 — FIN-1/2/3/4).** A follow-up audit found
the prior rounds had hardened the per-ROW money parser but left four "confidently-wrong figure / wrong
currency / wrong date" paths in the STATEMENT/DOCUMENT-level orchestration ABOVE it. Parsing-only (no schema,
IPC, or audit-payload change; figures stay content-class). All fixed **characterization-first then test-first**
through the real `extractTransactionsTool`/`extractInvoiceTool`/`extractTransactionRows`/`parseLineItem`/
`reconstructLine` entry points, each teeth-checked. **`BANK_EXTRACTOR_VERSION` 2 → 3** (FIN-1/3/4) and
**`INVOICE_EXTRACTOR_VERSION` 1 → 2** (FIN-1/2/4) — the A9/F5 reuse gate (`isBankStatementStale`/
`isInvoiceStale`) re-extracts older rows on next analysis (the rollback boundary).
- **FIN-1 — document/statement currency by MAJORITY VOTE (`money.ts detectDocumentCurrency`, wired into both
  tool `.run`s), HIGH.** The tool-level fallback was `detectCurrency(joined)` = "first allowlisted code
  ANYWHERE in the joined text wins". On a bare-amount de-AT statement a stray `USD`/`CHF` in a payee MEMO won
  → every bare-amount row fell back to USD → `summarizeCashflow` reported a **VERIFIED total in the wrong
  currency**, and because the mislabel was UNIFORM the mixed-currency guard (fires on >1 distinct currency)
  never tripped. The BL-2/F3 fix had narrowed only the per-ROW figure-region detection; the document-level
  call still scanned everything. **Fix:** `detectDocumentCurrency` votes per line — a MONEY-bearing line votes
  only on its **figure region** (text from the first amount onward, so a left-of-amount memo code is excluded;
  dates are scrubbed first so a leading `dd.mm.yyyy` isn't read as the first "amount"), a MONEY-less line
  (a `Währung EUR` header/label) votes on its whole text; the **most-voted** code wins, ties broken by first
  appearance. A genuinely-foreign statement (code adjacent to amounts) is still detected; a truly-mixed
  statement still reaches the mixed/unverified path because the per-row detection tags each row's own
  figure-region currency (this only supplies the bare-row fallback).
- **FIN-2 — invoice F1 right-side uncaptured-column drop OVER-fired (`invoice.ts UNCAPTURED_AMOUNT_AFTER`),
  MEDIUM.** The F1 drop used `/(?:^|\s)[-+(]?\d/` — fired on ANY trailing digit after the last money match,
  so it deleted valid items with a trailing annotation (`Service 12,50 (Pos. 3)`, `Beratung 1.234,56 19%
  MwSt`, `Line 50,00 EUR 2 Stk`). **Fix:** the region after the last money match must be ENTIRELY a single
  money-shaped-but-rejected bare token (`/^\s*[-+(]?\d[\d.,']*\)?\s*$/` — a whole/grouped integer or
  single-decimal column, no `%`/`x`/unit word/other text), so a true uncaptured total (`Hosting 12,50 500`)
  still drops while an annotated item is kept.
- **FIN-3 — geometry classifier read a bare-thousands amount as a DATE (`pdf-layout.ts DATE_TOKEN_RE`),
  MEDIUM (latent; HIGH harm when it fires).** The old `^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$` let `2.500`
  BACKTRACK into a date (day 2 / month 5 / "year" 00); out of the booking-date column that "date" was
  DROPPED, so row `07.02. EINKAUF 2.500 1.000,00` reconstructed as `…EINKAUF 1.000,00` and the line parser
  read the **BALANCE as the movement amount** (the cardinal wrong-money harm, via a path the F1 guard
  doesn't cover). **Fix:** require a year to be preceded by its own dot (`^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4})?)?$`)
  so `2.500` (one dot) is un-date-able → it survives as text and the line parser's `MONEY_RE` reads it.
  **DIVERGENCE from the audit's "widen `MONEY_TOKEN_RE` to the shared grammar":** `MONEY_TOKEN_RE` was kept
  a 2-dp-only SUBSET (NOT widened). Widening would make a pdf.js-SPLIT amount (`2.000` + `,00`, the M3
  boundary) classify `2.000` as money and emit a row with amount 2000 — silently dropping the cents on a
  `2.000,50`-style split, a **confidently-wrong figure where the row is today safely DROPPED**. The
  `DATE_TOKEN_RE` tightening alone fixes the wrong-figure harm because the reconstructed line is re-parsed by
  the shared `MONEY_RE` (which reads bare-thousands/apostrophe); the trade-off is that a SOLE bare-thousands/
  apostrophe figure stays a gate-safe recall DROP (pre-existing — the old `MONEY_TOKEN_RE` already rejected
  it). The stale `pdf-layout.ts:43` comment ("mirrors the accepted set of the shared `MONEY_RE`") was
  corrected to state the intentional subset.
- **FIN-4 — a memo date flipped the WHOLE document's date order (`money.ts inferDateOrder`), MEDIUM.** The
  scan was over the ENTIRE joined text, so one `03/15/2026` (second field 15 → US) in a payee memo flipped a
  de-AT statement to month-first → every dotted `dd.mm.yyyy` booking date with day ≤ 12 silently day/month-
  swapped (all still valid → none dropped → fully silent; the completeness gate checks balances, not dates).
  **Fix:** the vote is scoped by line KIND — a MONEY-bearing line (a transaction row) votes only on its
  LEADING run of date-column tokens (capped at two, mirroring `splitLeadingDates`; a memo date deeper in the
  row can't vote), while a MONEY-less line (an invoice `Invoice date 06/15/2026` header, a statement period)
  votes on any date it carries. **DIVERGENCE from the audit's "restrict to the leading date column":** the
  pure leading-column rule BROKE invoice US-date detection (an invoice's header dates follow a LABEL, they
  don't lead the line) — hence the split-by-line-kind, which fixes the statement-memo contamination while
  keeping both the single-leading-US-date statement and the labeled US invoice working.

**Financial correctness (full-audit-2026-06-30, Phase A — C1/C5).** A fresh audit found one false-NEGATIVE
in the SAME reconcile/summary layer (parsing-only; no schema, IPC, or audit-payload change; `BANK_EXTRACTOR_VERSION`
unchanged — reconcile re-runs on read). Fixed characterization-first through the real entry points, teeth-checked.
- **C1 — `reconcileBalances` dropped a balance-less gap row from the chain → false `mismatch`, MEDIUM-HIGH.**
  `prevBalance` advanced only on a printed balance, so a mid-statement row with a real `amount` but no printed
  `balanceAfter` (same-day grouping — the bank prints the balance only on the day's last line — or an
  OCR-dropped balance cell) was OMITTED: the next balance-bearing row computed `prevBalance + thisAmount`
  without the gap amount → `mismatch` → `assessCompleteness` → `contradicted` → a correct, verifiable total was
  **withheld** from the user (the inverse of the confidently-wrong harm). **Fix:** a `sinceLastPrinted` cents
  accumulator — a balance-less row stays `unknown` (it prints no balance of its own to check) but its amount is
  folded into the next printed balance's expected value (`toCents(prevBalance) + sinceLastPrinted + toCents(amount)`),
  reset on each printed balance and discarded at the baseline. Since `amount` is a required `number` on every
  `TransactionInput`/the schema, the chain is never "genuinely broken" by a missing amount, so there is **no**
  revert-to-`unknown`-on-missing-amount branch (the audit's conditional is vacuous); a real read error still
  surfaces as a `mismatch`. Supersedes the earlier "`reconcileBalances` over-reporting (honesty)" note's
  drop-the-gap behavior. The normal 2-figure de-AT row and the HVB no-balance listing stay byte-identical.
- **C5 — zero-amount classified inconsistently between `summarizeCashflow` and `categorizeRow`, LOW.**
  `summarizeCashflow` counted `amount >= 0` as inflow while `categorizeRow` files a zero `Uncategorized`
  (neither Income nor Spending). **Fix:** `summarizeCashflow` now uses `> 0` inflow / `< 0` outflow (a `0.00`
  row is neither), matching the breakdown. Output is unchanged (the figure is zero) — a convention-consistency
  fix. T4 (the §4 testing gap) landed alongside: a new `tests/unit/money.test.ts` table-tests the money/date/CSV
  primitives in isolation (apostrophe+decimal `parseAmount`, `csvField` formula-lead × quote × CRLF,
  `wordIncludes(compound)` repeated-needle, `inferDateOrder`/`detectDocumentCurrency` boundaries).

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
are matched against a title only on a user action by a **linear, non-backtracking two-pointer matcher**
(`selector.globMatches`), and the entry length/count are capped at parse time (vuln-scan 2026-06-21
replaced the original glob→RegExp compile entirely — see §13 S2). **Deferred:** S13 auto-fire
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
  (≤200) and count (≤64), and the glob is matched against a title by a **linear, non-backtracking
  two-pointer matcher** (`selector.globMatches`) so a `*?*?…`-style pattern can never hang the
  synchronous main-side scoring. (S12 originally compiled the glob to a bounded RegExp with a >10-`*`
  wildcard cap; **vuln-scan 2026-06-21 replaced that with the linear matcher** because the cap counted
  only `*` — a `*?*?…` pattern with ≤10 stars still compiled to a degree-10 backtracking RegExp — see
  [`known-limitations.md`](known-limitations.md).)
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
- **PC-1 — cross-lane write safety (skills-tools-audit-2026-06-26, Phase 9).** The three lanes that touch
  the bank/invoice tables (Lane A chat analysis, Lane B `SkillRunController`, Lane C `DocTaskManager`
  categorize) had **no cross-lane lock**, so a chat re-extract `replaceExisting` DELETE could race a
  button run / a categorize on the SAME statement (cooperative interleaving across `await` points, not an
  OS data race — the main process is single-threaded). A per-document async mutex
  (`services/skills/doc-lock.ts` `withDocumentLock`, a re-entrant `Map<documentId, Promise>` chain) now
  serializes every write-capable section by `documentId`: the write seams self-lock and the two
  multi-step lanes wrap their whole sequence (re-entrant inner locks). In-memory, per-document (unrelated
  docs stay concurrent), no new capability/schema/IPC, finer than `acquireChatSlot` and `finally`-released
  (no deadlock). R9 (skills-audit-2026-07-03 SKA-24/SKA-28) extended it: acquisition is **abort-aware**
  (a parked waiter rejects on cancel; the published tail still settles) and the summarize/export seams
  gained the outer prepare+load hold (released before the save dialog). Full record in §9.

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
  - **(2026-07-01 follow-up — button/chat extraction parity.)** `readDocumentSegments` is now built by ONE
    shared factory (`ipc/documentSegments.ts` `buildDocumentSegmentReader`) that BOTH the chat-analysis IPC
    (`registerRagIpc`) and the run-bar IPC (`registerSkillsIpc`) call. Previously each IPC had its OWN copy
    of the closure and they **drifted**: the run-bar copy dropped the `{layout}` argument (D58 geometry
    reconstruction), so the "Extract transactions" BUTTON re-read a columnar statement in plain reading
    order (fewer, scrambled rows) while the chat answer used layout mode — the SAME document reported a
    DIFFERENT transaction count *by entry point*. The single factory makes that divergence structurally
    impossible (a `buildDocumentSegmentReader` unit test pins the `{layout, maxPages}` threading). The
    `extract_transactions` / `extract_invoice` run-bar buttons also now pass `replaceExisting: true`
    (matching the analysis + categorize reuse paths — `analysis/bank-statement.ts`, `analysis/invoice.ts`,
    `doctasks/handlers/categorize.ts`), so an explicit re-extract REPLACES rather than accumulating
    duplicate `bank_statements`/`invoices` that `latestBankStatementId`/`latestInvoiceId` (newest wins)
    could otherwise serve divergently to the chat. A `summarize_cashflow` run now also routes an
    analysis-shaped question into the transcript (mirroring the categorize routing, via ChatScreen's
    `ROUTED_RUN_QUESTION` map) so the button surfaces the real in/out/net totals — the figures still stay
    main-side (the run state remains ids/counts-only).
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
- **`reconcileBalances` over-reporting (honesty).** The lone **baseline** row (the first row, or the
  first row after a balance-less run with no PRIOR printed balance to anchor against) is `unknown`, not
  `ok` — it has nothing to compare against, so it is not a genuine check. `reconciled` is true only when
  no row mismatched **and at least one row was actually compared against a predecessor** (`okCount > 0`).
  A single-transaction statement therefore reports `reconciled: false` / `resultKind: 'unchecked'` (it
  verified nothing) instead of a false "reconciled". `validate_statement_balances`' downstream
  `resultKind` was already keyed off `unknown`, so it flowed through unchanged; the baseline row now
  persists `reconciled = NULL` (unchecked) rather than `1`. The invoice path (`validateInvoiceTotals`)
  has **no** baseline concept — each of its three checks is a genuine figure-to-figure comparison — so it
  needed no change. **Updated by full-audit-2026-06-30 C1 (above):** a row whose *immediate* predecessor
  printed no balance is no longer auto-`unknown` — its gap amount is carried in `sinceLastPrinted` and it
  reconciles `ok` against the last printed balance. ONLY the true baseline (no prior printed balance at
  all) stays `unknown`.
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
- **Bundled skills.** The four app skills shipping at the time (`bank-statement`, `invoice`,
  `document-redaction`, `meeting-protocol`) gained a `localized.de` title + description; the four
  **Professional Documents** skills added 2026-06-21 (`contract-brief`, `deadline-obligation-finder`,
  `what-changed`, `share-safe-review`) carry it too, so **all eight bundled skills** are now
  German-localized. (The triggers were already bilingual, which is why German questions already fired
  the suggestion — only the visible text was English.)

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

**Suggestion-selector baseline (S13a — measured, not yet gated).** The same offline harness also
prints the **suggestion**-bar sweep — `formatReport` over the `POLICIES` in
`tests/eval/skill-triggers.{ts,test.ts}`: precision/recall + a confusion matrix for the §6 suggestion
selector, question text scored-but-never-logged. The numbers the deleted `skills-s13-plan.md §3.3`
used to hold now live here — **this record is their durable home** (the harness comments and BUILD_STATE
§5's TS-9 item point at `architecture.md §18`, not the retired plan file). Unlike the auto-fire bar
above, the suggestion selector's own thresholds (a D1/D2 for the *offer* bar, `SUGGEST_SCORE_THRESHOLD`)
are **not yet ratified**, so that eval tier only measures and records — there is **no** hard CI
assertion on it (contrast the S13b auto-fire gate) until the owner sets them. Tracked as the open
**TS-9** item (BUILD_STATE §5 item 7) so measurement-without-a-bar can't silently become permanent.

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
    (#44 closed the other half of this promise: the handler names the button *unconditionally* and
    cannot see the run bar's state, so the bar itself now guarantees the button exists — a terminal,
    un-dismissed result row no longer suppresses the offer; only an in-flight run does.)
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
rows** via the **pure** tool functions. **Single row load + seam-output reuse (Phase-4 perf, audit
P-1/P-2):** the handler loads the statement rows **once** — `loadStatementRowsWithCategories` is now the
sole `bank_transactions` read on the non-category path — and hands them to the downstream seams as a new
optional `preloaded` arg (`prepareStatementRun`/`prepareInvoiceRun` skip their own load when it is
supplied). The read-only seams (`summarize_cashflow`, `validate_statement_balances`,
`validate_invoice_totals`) now **return their validated structured `output`** (`CashflowSummary` /
`ReconcileResult` / `InvoiceTotalsResult`) for **in-process** reuse, so the handler reuses it instead of
recomputing the same pure function over a re-queried row set (a pure recompute is the fallback if a seam
failed). These outputs are figures (content) and stay **in-handler** — they are never mapped into
`ToolRunOutcome`/IPC (the run-bar dispatch in `tool-runs.ts` still maps counts only). The `skill_runs`
lifecycle + ids/counts audit are **unchanged** (the `summarize_cashflow` run + its `skill_run_*` trio
still fire — approach A, not the "drop the summary run" alternative B). Net: a non-category bank question
issues **one** `bank_transactions` read (was three: two seam loads + the handler load); an invoice
question **one** `invoice_line_items` read (was two). The answer is deterministic,
localized Markdown honouring the SKILL.md honesty posture (quote printed figures; surface flagged rows
**before** the headline; never invent), with real `[Sn]` source-chunk citations (M2-safe, never the
synthesised total). On this **exhaustive** path the honesty posture is **code-enforced, not
body-driven**: `buildBankAnswer`/`buildInvoiceAnswer` (`analysis/bank-statement.ts`,
`analysis/invoice.ts`) reimplement those rules directly in TS, so editing the SKILL.md body changes
only the off-topic relevance fallback (where the body rides the fence) — the body and the TS must
therefore be kept in step. **Audit A-1 (Phase 10) pins that step with a parity test**
(`skills-skillmd-parity.test.ts`): for both skills it asserts the SKILL.md body still states each
honesty bullet (unreconciled-before-total, reconcile-or-say-so, never-invent) **and** that the answer
builder still produces the matching honest branch for a constructed unreconciled / contradicted /
mixed-currency / missing-figure case — so a drift in **either** the body or the TS now fails a test.

- **`bank-statement`** (`analysis/bank-statement.ts`): `extract_transactions` →
  `summarize_cashflow` + `validate_statement_balances` (+ `categorize_transactions` only when the
  question is category-shaped). Leads with the count, surfaces unreconciled rows before the totals,
  reports mixed currency as "no single total." Citations narrow to the transactions' `source_page`.
  The category-shaped breakdown runs the **deterministic** rule pass here (0 model calls); since the
  "Categorize" button uses the richer LLM taxonomy, the chat answer **labels** a rule-based breakdown as
  such and points at the button (audit C-2 — see §22 "Consistent breakdown framing"), so the two entry
  points are not silently divergent.
- **`invoice`** (`analysis/invoice.ts`): `extract_invoice` → `validate_invoice_totals`. Surfaces any
  failed reconciliation check (line-items→net, net+tax→gross, tax-vs-rate) **before** the headline
  gross; prints only the figures the invoice states (a field that couldn't be parsed is left out).
  The invoice schema records no per-figure source page, so citations are the document's leading
  source chunks (still real chunks, M2-safe). i18n: `skills.invoiceAnalysis.*` (EN+DE parity), reusing
  the shared `coverage.extract.*` meter + `skills.analysis.refusePartial` refuse copy.
- **Invoice reuse / replace / staleness — parity with the bank path (F5, post-merge audit Phase 3).**
  The invoice analysis handler now uses the **same** reuse-or-re-extract decision as
  `analysis/bank-statement.ts` (it previously re-extracted + INSERTed a fresh `invoices` row on **every**
  analysis question — unbounded content-table bloat for a deterministic re-extraction). `invoices` gained
  an `extractor_version` column (additive nullable migration in `db.ts`, mirroring
  `bank_statements.extractor_version`); every extraction stamps it with `INVOICE_EXTRACTOR_VERSION`
  (`tools/invoice.ts`). The handler resolves `latestInvoiceId(db, docId)` and **REUSES** it when present
  and **not stale**; it re-extracts only when none exists OR `isInvoiceStale` (stored version NULL/legacy
  or `<` current). A re-extract passes `replaceExisting: true`, so `runInvoiceExtraction` calls the shared
  `deleteInvoicesForDocument` (the SAME ordered FK delete `purgeSkillDataForDocument` uses — invoice line
  items, then invoices) **inside** the persist `BEGIN/COMMIT` before the INSERT (atomic swap; a failure
  rolls back to the old). The old `totals_reconciled` flag goes with the replaced row (the validate seam
  recomputes it). `latestInvoiceId` is the single shared "latest invoice" helper (`invoice-run.ts`,
  `created_at DESC, id DESC` tie-break) across both call sites — the downstream run seam and this read-back.
  **Bump `INVOICE_EXTRACTOR_VERSION` whenever the invoice parser changes output for the same input** (it is
  at **1** — baseline = the parser as built through the post-merge Phase 1 F1/F3/F6/F8 hardening; legacy
  NULL rows are stale and re-extract on next reuse). Tests: `skills-analysis-invoice.test.ts` (N questions
  persist exactly one invoice + one line-item set; a fresh invoice is reused with no duplicate; a
  version-NULL invoice is detected stale → re-extracted + replaced in place at the current version).

**Scope resolution (audit X-1, Phase 10).** Each handler's `applies()`/`run()` resolve the in-scope
documents through the **one shared** `documentsInScope(db, scope, { requireChunks })` helper
(`services/skills/scope-documents.ts`) — the single definition of "indexed documents in a resolved
scope," replacing five hand-copied queries. The analysis handlers pass `requireChunks: true` (they read
the stored `chunks`, so an indexed-but-unchunked document is not answerable here); the **run path**
(`resolveInScopeDocumentIds`) and the **suggest/auto-fire path** (`inScopeDocSignals`) pass `false` (the
run re-extracts faithfully from the stored copy; the suggestion is keyword/MIME signal only). The helper
logs nothing and stays main-side — a `title` is content-adjacent and never crosses IPC from it — and its
deterministic `ORDER BY created_at, id` keeps `resolveInScopeDocumentIds[0]` the stable default run
target (U-1/U-2). *(The RAG router keeps its own `registerRagIpc.documentsInScope` — same predicate, a
deliberate sibling in a different layer, outside the skills subsystem this helper unifies.)*

**Tests.** `skills-analysis-bank.test.ts` + `skills-analysis-invoice.test.ts` (handler-level:
`applies()` pre-flight, exhaustive math from rows, flagged check surfaced before the headline, figures
quoted not invented, export never auto-run, coverage `fullyChunked` true/false, real source citations);
`skills-skillmd-parity.test.ts` (audit A-1: the SKILL.md honesty bullets ⇔ the
`buildBankAnswer`/`buildInvoiceAnswer` honest branches, both directions);
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
inside the 2-doc compare below) for the DISSIMILAR-document fallback — a similar version pair now goes
through the **diff-driven** path (compare-diff record below), which reads both docs whole without capping.

**Whole-doc analysis truncation fix (2026-07-04/05, 4-phase wave — full record: `rag-design.md` §14.10).** The
tree rescue above only fires for a document with a **ready** deep-index tree, which auto-builds at ~50 pages —
so every document in the **"gap band"** (~1.5–50 pages) still truncated to its beginning, and a long deliverable
still overran `n_ctx`. Four phases closed both cuts, all in the **shared core `streamWholeDocMapReduce`** (so the
tree rescue and the new chunk path share one engine): **(1)** the map-reduce body was extracted from
`answerWholeDocFromTree` into that core, and a new **`answerWholeDocFromChunks`** runs the same map-reduce over
the document's **de-overlapped raw chunks** (no tree needed) — honest `capped`/untruncated "covers the whole
document"; **(2)** the reduce output cap is **adaptive + notes-first** (`computeReduceBudget` — aims for a
3072-token deliverable, yields toward the 1024 floor so whole-doc coverage survives a 4 k window, `prompt +
output ≤ n_ctx` always); **(3)** the ephemeral `'analysis'` progress notice fires for the silent map-call window
(`windows.length > 1`); **(4)** **continue-generation** re-prompts to FINISH a `finishReason==='length'`
deliverable (same fence + notes + question + a resume anchor, seam de-duplicated) across ≤ 2 bounded passes,
stamping an honest **`Message.truncated`** (OUTPUT-cut, parity with the single-turn grounded path) — kept
distinct from `coverage.truncated` (INPUT coverage) — only when the cap is exhausted. The §14 ceiling + the
fence/guard bracketing are unchanged throughout.

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

**Compare-diff record — deterministic word-level diff is the compare backbone (2026-07-02).**
*Problem it fixes.* Every compare mode above hands the model two walls of text and asks it to *eyeball*
the differences. That reliably MISSES a subtle change — a single deleted word deep in repetitive text —
and lets the model dismiss low-salience/placeholder content ("Lorem ipsum") as "identical, nothing to
compare". In the chat path it was compounded by truncation: at the default 4096-token window
`splitCompareBudget` gives each doc ~half, so a ~2-page version pair had **page 2 (where the change was)
dropped** as the capped tail — the model never saw it. *Fix.* A new pure module **`services/diff`**
computes a **Myers word-level diff** (`wordDiff`, O((N+M)·D) with a `maxEdits` cutoff + a `maxWords`
guard, so it is near-linear for a real version pair and cheaply BAILS to null when the two diverge).
`isPreciseDiffUseful` (the single routing policy) drives compare by the diff ONLY when the pair is
similar (some shared content, changed fraction ≤ 0.5); a rewrite / too-large / too-different pair returns
null and falls through to the existing modes. Both compare paths gained a **diff-driven mode (d)**:
- **Chat** (`grounded-whole-doc-compare`): `retrieveCompareDiff` reads BOTH docs whole (every chunk — no
  cap), diffs them, and feeds the model the **exact changes + a redline** via `buildCompareDiffPrompt`
  (never two whole-doc walls). Coverage is honest **whole-document** (the diff examined every chunk, so a
  page-2 change can't be truncated away); `[Sn]` citations are attributed to the chunks where the changes
  are. Identical docs are stated as such; the whole-doc-compare read is the fallback for a rewrite.
- **Doctask** (`runCompare`, materialized "Comparison: A vs B.md"): `runCompareByDiff` short-circuits an
  identical pair to a model-free report, else materializes a deterministic **redline** (`renderRedline`,
  struck/added words with context) ABOVE a model interpretation of just the changes (`compareDiffPrompt`)
  — so the exact wording is always shown even if the interpretation editorializes. Modes (a)/(b)/(c) run
  only for a rewrite/too-large pair (which is why every prior compare test — all use maximally-dissimilar
  fixtures — is byte-unchanged). The redline **direction** follows document order (there is no reliable
  old/new signal); the doctask uses the user's explicit A/B selection order. `SKILL.md` was updated to
  treat a supplied diff as complete/exact and never dismiss a change as placeholder.
- *Tests.* `tests/unit/diff.test.ts` (the algorithm: the one-word-deletion regression, insert/replace/
  identical, the edit-cutoff → null, near-identical large texts, redline/model rendering);
  `doctasks-compare.test.ts` mode (d) block (one-word redline, identical short-circuit no model call,
  rewrite → fallback); `rag-whole-doc-compare.test.ts` (chat diff path: exact changes reach the model,
  identical, rewrite → whole-doc fallback).

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
  **Amended by §42 P3 (invoice-hardening-2026-07-04):** the invoice *analysis* handler now DOES
  re-extract once via `readDocumentSegments(id, { layout: true })` on a glyph-soup verdict
  (`text_quality:'suspect'`) — D58's own escape clause ("adopt layout there only behind its own
  measurement") was satisfied by the `invoice-de-geometry-columns` fixture. The scope of "bank-only"
  is now precisely: the **run-bar / IPC extract** path and every non-analysis skill never set `layout`;
  the one invoice geometry read is the analysis path's suspect retry.

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
  geometry alone can't reject it. `'kontostand per'` belongs to `BALANCE_LABELS`, so
  `extractTransactionRows` SKIPS any such line — a summary is never counted as a transaction (it is read
  by `extractStatementBalances` instead). It is deliberately kept OUT of `OPENING_LABELS` /
  `CLOSING_LABELS`: the SAME label prints BOTH balances, so it cannot be split by label alone — it is
  disambiguated by DATE in `extractStatementBalances` (see the gate bullet, audit C-4). "Aktueller
  Kontostand" stays excluded (it restates the closing at the top and would corrupt the opening). This
  stops the double-count that broke the tie.
- **The completeness gate (D56 + the D56-R refinement).** New `extractStatementBalances` (printed
  opening/closing, EN+DE labels incl. `balance brought/carried forward`, `opening/closing balance`,
  `Anfangs-/Endsaldo`, `Kontostand per`) feeds `assessCompleteness`, the three-outcome classifier
  (`complete` / `contradicted` / `unverified`); `isStatementComplete` is retained as its boolean
  `=== 'complete'` projection (the unit tests pin the gate by that name).
  - **Cent-exact tie (audit C-3, 2026-06-26).** `assessCompleteness` sums and compares the
    `opening + Σamounts == closing` tie in **integer cents** (`Math.round(amount*100)`), not a float
    `reduce`. Every figure is exactly 2-dp, so the cent sum is exact and the tie is an exact integer test
    — float drift over thousands of rows can no longer push the difference past `MONEY_EPS` and flip a
    genuinely-tying statement to a false `contradicted`. Read-time only; nothing persisted changes.
  - **Single-currency precondition (backend audit 2026-06-27, BL-2).** The tie sums every amount into one
    figure against a single opening/closing pair, so `assessCompleteness` first returns `'unverified'`
    when the rows span more than one currency (a cross-currency Σ is meaningless), and `reconcileBalances`
    reports a mixed-currency statement all-`unknown` — both mirroring `summarizeCashflow`'s
    `currencies.size === 1` guard. `buildBankAnswer`'s mixed-currency branch (already gated on
    `summary.currency` → no single total) is unchanged, so the change only hardens the public predicates;
    the §10 record carries the full note. Also BL-1's value-date column fix lives in the **line parser**
    (`parseLine`, §10), distinct from the geometry booking-date column model below.
  - **`Kontostand per` date disambiguation (audit C-4, 2026-06-26).** Because the same label prints both
    balances, `extractStatementBalances` resolves it by DATE: with two distinct-dated `Kontostand per`
    lines the **earliest** is the opening and the **latest** is the closing; a **single** such line (no
    pair to bracket the period) is the **closing only** (opening undefined → the gate downgrades to an
    honest `unverified` labelled sum, never a false `contradicted` from reading opening == closing).
    Explicit `Anfangs-/Endsaldo` labels still win where both appear. This **changes the persisted
    `opening_balance`/`closing_balance`** on affected statements → `BANK_EXTRACTOR_VERSION` bumped 1 → 2
    (stale v1/NULL statements re-extract via the A9 path on the next reuse).
  - **Persistence & rendering.** Balances persist additively on `bank_statements`
    (`opening_balance`/`closing_balance`, REAL, nullable, content-class — never logged/audited/exported).
    `buildBankAnswer` renders each outcome: `complete` → VERIFIED total + the proven-whole `caveat`;
    `unverified` → the SAME single-currency totals + categories under `unverifiedCaveat` (a labelled sum
    of the rows read — the no-balance "Umsätze" case, the reported bug); `contradicted` →
    `skills.bankAnalysis.incompleteNoTotal` (the honest refusal). Mixed-currency reports no-single-total
    (safe) regardless of outcome. A bounded transaction listing
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
  - **(A3) Sign-column fold.** A standalone `+`/`-` or Soll/Haben `S`/`H` marker is folded into the
    amount's sign (`S`/`-` → debit/negative, `H`/`+` → credit/positive) ONLY when it is the AMOUNT
    column's own sign cell: at/right of the amount (within `SIGN_ZONE_SLACK`) AND nearer the amount than
    any later money column — so a marker printed beside the running BALANCE never flips the amount
    (review fix S3). Conservative by design: a dash FAR from the amount (a description dash) is NEVER read
    as a sign (so it can't flip a total) and a non-folded sign token is kept as description text rather
    than silently dropped (S2). **Caveat (D57):** the EXACT HVB sign
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

**Local re-measurement (2026-06-25, post-Phase-32, refined harness).** The full real HVB online
"Umsätze" listing (Jan–Mar 2025, 45 transaction rows, NO printed opening/closing — the exact file behind
the Phase-32 bug) was re-measured on its own: **transaction recall 100% (45/45)**, **over-extracted 0/1**
(the old `<date> <CUR> <balance>` phantom rows are GONE — the A2 currency-token class + A1 multi-baseline
recovery hold on the real encoding, not just the synthetic fixtures), the D56-R **`unverified` labelled
sum** path (no printed balances), and **hallucinated / partial-total / model-calls all 0**. This confirms
A1/A2/A3 on the real layout and that the boundary-1 over-extraction is resolved in the wild. (Only this
one statement is present on the current machine; the broader 3-text + 1-scan aggregate above still awaits
a re-measure where that corpus lives.)

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
| §22-A2 | Net-new member-by-member safe zip extractor — a `.skill.zip` never routes through `extractWithTar`; zip-bomb enforced on actual inflated bytes | §4 + security-model "Skill-import defences" |
| §22-C2 | Selector reads triggers from the cache, never unpacks a blob | §6 |
| §22-C3/C4 | No FK into `skills` (app-level sweep); scope resolved main-side | §4 + §9 |
| §22-D1/D3 | Honesty posture (drop, don't invent); suggestion is an inert offer | §6 + §8 |
| §22-E2 | Nested-archive defence is magic-byte sniffing, not extension allowlisting (a zip renamed `.csv` is caught) | §4 + security-model "Skill-import defences" |
| §22-E4 | `assertCommercialDrive` gate mirrored in both provisioning scripts | `services/commercial-drive.ts` + `scripts/build-commercial-drive.{ps1,sh}` (parity pinned by `skills-bank-statement.test.ts`) |
| §22-H2 | Fence placement — the RAG skill fence rides in the user turn with the excerpts, never `system` (plain chat: app-bracketed) | §5 + rag-design.md §8 "Grounded prompt" |
| §22-M1 | Content-class rule — ids/counts only; no content in log/audit/IPC | §2 (the consolidated sentinel guard) |
| §22-M2 | App-skill integrity by location, not signature (accepted residual) | §12 + security-model |
| §22-M4 | v1 permissions are a display summary; nothing executes | §1 (DS6) |
| `pdf-geometry-extraction-plan.md` §3.1 / §3.1.3 | Row/column reconstruction; the booking-date column model | §21 (`pdf-layout.ts`) |
| `pdf-geometry-extraction-plan.md` §3.2 | The non-breaking `parseDate` guarantee (year resolved in reconstruction) | §21 |
| `pdf-geometry-extraction-plan.md` §3.5 / D56 | The opening/closing-balance completeness gate (no partial totals) | §21 |
| `pdf-geometry-extraction-plan.md` D50–D58 | Stage-1 architecture decisions (geometry-first; Stage 2 conditional) | §21 |
| `skills-tools-audit-2026-06-26` D-1…T-1 / C-* / P-* / U-* / S-* / PC-1 / X-* / A-1 / R-1 / R-2 | Skills & Tools audit findings (7 personas, 11 phases, no CRITICAL/HIGH) | §23 close-out ledger → the per-finding § noted there |


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
  `responseSchema`) exercises exactly this path in CI. **Batch robustness (audit L-1/L-2, Phase 2):** the
  per-batch output-token budget `batchMaxTokens` is now **length-aware** (a per-row description-length
  allowance) so a verbose batch is far less likely to truncate; an **unparseable** reply is **retried once**
  before the batch drops (a transient truncation gets a second chance); and the streamed reply is bounded by
  a generous char cap (`batchMaxTokens * 8`) so a **looping** local runtime that ignores `maxTokens` can't
  grow `text` unbounded — past the cap the batch is dropped (not retried). Drop-to-`Uncategorized` remains the
  honest final fallback.
- **Model-OPTIONAL.** With no model loaded the module degrades to the deterministic rule pass
  (`categorizeRow`). Confident description-rule matches (Fees/Income/Transfer/Cash) are a PRE-FILTER that
  skips the model; the rest go to the model in batches of `CATEGORIZER_BATCH_SIZE` (=20). Both the PRE-FILTER
  (`prefilterCategory`) **and** the deterministic `categorizeRow` match on the **same shared** Unicode
  WORD-boundary tester (`wordIncludes`, moved into `tools/money.ts` at audit C-1, Phase 2 — review fix P10
  originally hardened only the pre-filter), so a coincidental substring (`fee`⊂`coffee`, `atm`⊂`atmosphere`,
  `lohn`⊂`mühlohn`) never makes a confident wrong match on EITHER path, and the two paths agree on every
  description rule. (Trade-off: a German COMPOUND that merely contains a keyword — `Kontoführungsgebühr` —
  no longer rule-matches deterministically; it goes to the model, exactly as the pre-filter already did.)
- **Model-assisted label.** The breakdown is labelled model-assisted from the authoritative persisted flag
  `bank_statements.categorized_by_model` (=1 whenever the LLM was consulted), written by the categorizer
  doctask (review fix A8). The earlier "any persisted category OUTSIDE the deterministic rule set" heuristic
  is kept ONLY as a back-compat fallback for statements categorized before the flag existed — on its own it
  false-negatives when the model emits only in-rule-set labels (Income/Transfer/Fees/Cash).
  `categorizer.ts` + `doctasks/manager.ts` + `analysis/bank-statement.ts`.
- **Localized display, canonical-English identity.** The PERSISTED category (`bank_categories.name`) and
  the enum stay canonical English (so the schema, persistence, and the model-assisted signal are
  locale-stable); the breakdown DISPLAY label is localized (EN + DE, `skills.bankCategory.*` →
  `categoryLabel`). An unknown name (a future user category) falls back to its raw identifier.

**Decisions as built:**
- **D26 — the categorizer is a `DocTaskManager` kind (`'categorize'`), NOT a model call on the skill-run
  seam.** The `ModelSlotArbiter` only mediates chat ↔ a *yielding* build; the chat↔task one-job-at-a-time
  exclusion (D26) lives in the `DocTaskManager` (chat checks `hasActiveTask()`, tasks check
  `isChatStreaming()`); the skill-run `SkillRunController` is a SEPARATE lane that does not observe the
  D26 *model-slot* exclusion. A model call on `runCategorization` could let two `chatStream` calls hit
  the one llama-server at once. The doctask lane gives D26 exclusion + progress + cancel + `getRuntime()`
  for free. `'categorize'` is the one **model-OPTIONAL** kind (it skips `startDocTask`'s runtime gate; a
  null runtime ⇒ deterministic). **DB-write safety across these lanes (audit PC-1, Phase 9): the lanes
  were mutually unaware of each other's WRITES — now every write-capable section is serialized PER
  DOCUMENT by `withDocumentLock` (`services/skills/doc-lock.ts`), so a chat re-extract DELETE can no
  longer race a button run / a categorize on the same statement (see §9). That doc lock is independent of
  and finer than the D26 model-slot exclusion — it guards table writes, not the llama-server.**
- **Button wiring — wrap the doctask in the skill-run shell.** The existing "Kategorisieren" button keeps
  its `SkillRunController` UX: the `categorize_transactions` runner ENQUEUES a `'categorize'` doctask and
  MIRRORS its progress/cancel into the run bar (`tool-runs.ts` `runCategorizeViaDocTask`). The real job —
  and the model call — runs in the doctask lane, so D26 holds; the shell is a thin status mirror.
- **Auto-extract (the (D) ordering fix).** `runCategorize` AUTO-EXTRACTS the statement first when none
  exists (the "categorize before extract" `needsExtraction` failure is gone). Persistence of
  `category_id` is atomic (BEGIN/COMMIT, no partial annotations survive); the categories are seeded by
  the SHARED `ensureBuiltinCategories` (now the union of the rule set + the LLM taxonomy).
- **Explicit categorize offer after extraction (Q2; audit U-2, Phase 6; DECISION = explicit offer).**
  A read-only `extract_transactions` BUTTON click does NOT start the LLM categorizer on its own. The
  earlier Phase-33 behaviour silently enqueued a background `'categorize'` doctask here — invisible in
  the run bar (it lived in the doctask lane), a **no-surprises violation** for a calm, privacy-posture
  app (a deterministic, advertised read-only action triggering an un-asked model pass). Now, after a
  successful rows>0 extract, the run-bar **result row** offers a one-tap **"Categorize transactions"**
  follow-up; the model invocation is **user-initiated**. The offer targets the SAME document the extract
  ran on: its id is remembered **renderer-side** (`ChatScreen` `runTargetId`, mirroring the Phase-5
  `runTargetName`) and rides back through the existing `onRunTool('categorize_transactions', false,
  documentId)` → `runCategorizeViaDocTask` path (D26 lane unchanged). The offer copy is content-free
  (`chat.skill.run.categorizeOffer`, EN+DE); the run state / IPC stay ids/counts-only (no documentId in
  `SkillRunState`). The audit payload is unchanged (`{skillId, toolName, documentCount}`) — and because
  the categorize is no longer auto-fired, an extract click no longer emits a categorize run's audit trio
  unless the user taps the follow-up. The chat analysis path is unaffected (it never went through that
  runner), and the deterministic 0-model chat breakdown still works with NO prior categorize.
- **Read-back stays 0-model-calls (Q3 routed feedback).** `analysis/bank-statement.ts` REUSES the latest
  statement when it is FRESH (re-extraction is deterministic, so reuse avoids a duplicate AND preserves the
  doctask's persisted categories); a single LEFT-JOINed read (`loadStatementRowsWithCategories`) returns
  each row paired with its PERSISTED category (else `categorizeRow`), so the breakdown alignment is
  structural. The model call happens ONLY in the doctask. After a categorize run completes the renderer
  ROUTES the standard breakdown question into the transcript, so the model-assisted breakdown appears as a
  normal chat answer (`ChatScreen` → the analysis handler, still 0 model calls).
- **Consistent breakdown framing (audit C-2, Phase 2; DECISION = option A).** Two engines categorize the
  same statement by entry point: the chat breakdown runs the **deterministic** rule pass when nothing is
  categorized yet (0 model calls — keeping THIS path 0-model is the load-bearing invariant), while the
  "Categorize" button + the post-extract categorize offer (Q2/U-2) use the **LLM** doctask's richer
  taxonomy. Rather than pull a model
  call onto the chat path (option B — bigger blast radius, crosses into the doctask lane), the chat answer
  now **labels** the rule-based breakdown honestly: when `modelAssisted === false` it appends
  `skills.bankAnalysis.categoryRuleBased` ("a quick rule-based grouping … run the Categorize button for a
  richer, model-assisted breakdown"), the mirror of the model-assisted note. So the two entry points are no
  longer SILENTLY divergent, and the 0-model-call chat contract is preserved.
- **Stale-statement re-extraction (A9; Phase 31–33 follow-up).** Reuse is gated on FRESHNESS:
  `bank_statements.extractor_version` is stamped with `BANK_EXTRACTOR_VERSION` (in `tools/bank-statement.ts`)
  on every extraction; a statement whose stored version is NULL (legacy) or `<` current is STALE
  (`isBankStatementStale`). Both reuse paths — the analysis read-back AND the `categorize` doctask —
  re-extract a stale statement with `replaceExisting`, which DELETES the document's prior statements (+ their
  transactions/corrections, FK order) in the SAME persist transaction before inserting the fresh one. So a
  since-fixed parser bug never keeps serving mis-signed / lost-payee rows (the silent-stale risk is sharpest
  for no-balance "Umsätze" statements, which present an `unverified` sum the D56 gate can't catch), and
  re-extraction never accumulates duplicates. The old per-row categories go with the replaced statement
  (the rows changed because the parser changed them — recompute is the honest move, done by the breakdown's
  deterministic pass / the next categorize run); model categorization re-runs on the next Kategorisieren
  click / the post-extract categorize offer. The single shared `latestBankStatementId` helper (`run.ts`) keeps the load-bearing
  `created_at DESC, id DESC` tie-break identical across all three call sites. **Bump `BANK_EXTRACTOR_VERSION`
  whenever the line parser OR `pdf-layout.ts` reconstruction changes output for the same input.** It is now
  at **2** (1 → 2 at audit C-4, 2026-06-26: the `Kontostand per` date disambiguation changes the persisted
  `opening_balance`/`closing_balance` on Raiffeisen statements — so v1 statements re-extract via this path).

**Tests:** `skills-categorizer.test.ts` (taxonomy/enum, prefilter, model path, off-list/out-of-range
drop, unparseable-batch drop, batching, no-runtime fallback; **Phase 2:** `categorizeRow` agrees with the
prefilter on coincidental substrings, L-1 truncation-retry-then-succeed + retry-once-then-drop, L-2
char-cap drop; **Phase 11 (audit T-1):** an empty input makes NO model call and returns an empty result
(`modelAssisted:false`), and the EXACT batch boundary — exactly `CATEGORIZER_BATCH_SIZE`(20) model-bound
rows is ONE call, 21 is two, a 1-row batch is one — pinning the off-by-one the 25-row batching test only
brackets); `skills-bank-statement-tool.test.ts` (**Phase 2:** `categorizeRow` word-boundary matching —
`coffee`≠Fees, compound `Kontoführungsgebühr`→Spending; **Phase 3:** the cent-exact many-row drift case
stays `complete` (C-3), the `Kontostand per` dated pair maps opening/closing and a lone line is closing-only
→ `unverified` (C-4), `BANK_EXTRACTOR_VERSION === 2`); `skills-run.test.ts` (**Phase 3:** a v1 statement is
detected stale at v2, a freshly-stamped one is not); `doctasks-categorize.test.ts` (model path
persists, deterministic fallback persists, auto-extract-then-categorize, A9 stale-statement re-extract +
replace; **Phase 6:** an extract run leaves the doctask lane untouched and the rows uncategorized — no
hidden model run); `skills-tool-run-ipc.test.ts` (**Phase 6:** an extract with rows enqueues NO
`categorize` doctask — U-2); `SkillRunBar.test.tsx` (**Phase 6:** the result-row "Categorize transactions"
offer renders only after a successful rows>0 extract and fires the categorize path with the remembered id;
absent for a 0-row / non-extract / non-done run); `skills-analysis-bank.test.ts` (persisted model categories
surface + the model-assisted label; **Phase 2:** the rule-based note when `modelAssisted` is false, absent
when model-assisted; no duplicate statement on re-ask; A9 stale statement re-extracted+replaced, fresh
statement reused).

### §23 Skills & Tools audit (2026-06-26) — remediation close-out

A **seven-persona** audit (architecture, security/privacy, performance, LLM/prompt, UX, docs, testing)
swept the whole Skills & Tools surface — selection → the Tier-2 gate → the run seam → the bank / invoice /
redaction tools → the LLM categorizer → the `.skill.zip` installer. **No CRITICAL / HIGH.** All **11
remediation phases are landed** on branch `skills-tools-audit-2026-06-26`. The standalone report
(`docs/skills-tools-audit-2026-06-26.md`) was **deleted** under the CLAUDE.md doc-lifecycle rule once
fully implemented — its design records were folded into the §§ below as each phase shipped, and the full
original report stays **recoverable in git history** (the parent of the Phase-11 close-out commit,
`bd2acdb`), mirroring the 2026-06-13 audit closeout. This ledger is the durable index — read a code
comment's `audit <ID>` citation through it:

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| D-1, D-2 | 1 | docs truth-up: eight bundled skills; the linear `globMatches` matcher (no dead `globToRegExp` cap) | §12/§13; DS17 |
| C-1, C-2, L-1, L-2 | 2 | shared word-boundary `wordIncludes`; rule-based breakdown labels itself; retry-once + char-cap on a batch | §8/§22 |
| C-3, C-4 | 3 | cent-exact completeness sum; `Kontostand per` date disambiguation (`BANK_EXTRACTOR_VERSION` → 2) | §21 |
| P-1, P-2 | 4 | load the rows ONCE; the seams return their validated output for in-process reuse | §8/§19 |
| U-1 | 5 | multi-doc target ids ride the IPC, render-side maps ids→names; the chosen id is validated main-side | §9/§19 |
| U-2 | 6 | a read-only extract no longer auto-runs the model; an explicit one-tap "Categorize" follow-up instead | §9/§22 (D26) |
| U-3 | 7 | a quiet inline "Suggested: …" hint on the closed picker for a high-confidence offer | §6 |
| S-1, S-2 | 8 | bound the inflate INPUT; re-validate + reject a duplicate stripped path | §4; security-model |
| PC-1 | 9 | per-document `withDocumentLock` serializes the three write lanes (no cross-lane race) | §9/§13/§22 |
| X-1, X-2, A-1 | 10 | one `documentsInScope` helper; `count_selected_documents` kept as a test-only canary; a SKILL.md⇔TS parity test | §7/§19 |
| T-1, R-1, R-2 | 11 | test backfill + the two residuals (below) | this section |

**Phase 11 (T-1 / R-1 / R-2) — as built:**

- **T-1 — backfilled only the genuinely-missing edges (no padding).** Two categorizer edges were ADDED to
  `skills-categorizer.test.ts`: an **empty input** makes NO model call and returns an empty result
  (`modelAssisted:false`), and the **exact batch boundary** — exactly `CATEGORIZER_BATCH_SIZE`(20)
  model-bound rows is ONE model call, 21 is two, a 1-row batch is one — pinning the off-by-one the prior
  25-row "batches of 20" test only *brackets*. **Teeth-verified** (a transient batch-step off-by-one made
  the boundary test fail; reverted). The other clustered T-1 gaps were verified **already covered** by the
  earlier phases' own tests and were **NOT re-added**: cross-lane concurrency PC-1
  (`skills-concurrency.test.ts`, Phase 9), multi-doc `docIds[0]`/chooser + the no-title `SkillRunState`
  privacy sentinel + the U-2 no-auto-categorize behaviour (`skills-tool-run-ipc.test.ts`, Phases 5/6), the
  whole-batch-drop / retry-once / char-cap / 25-rows⇒2-calls categorizer cases (`skills-categorizer.test.ts`,
  Phase 2), and the C-3/C-4 completeness numerics (`skills-bank-statement-tool.test.ts`, Phase 3).
- **R-1 — auto-fire corpus is intentionally narrow (no rows invented).** `document-redaction` is STILL the
  ONLY app skill opting into `triggers.autoFire`, and the eval gate already covers it: the harness's
  `APP_SKILL_IDS` and the 33-turn `tests/fixtures/skill-triggers/corpus.json` (four `document-redaction`
  turns among them) drive the S13b gate (`fired-wrong == 0` AND `precision ≥ 0.95`). Per the plan's
  explicit fallback, since NO new skill opts in, no corpus rows were added — the corpus is deliberately
  scoped to the auto-fire surface and the eval gate is unchanged. (See §18 for the auto-fire contract.)
- **R-2 — run-surface eyeball deferred (re-affirmed, surfaced for opt-in).** The live `SkillRunBar`
  Playwright walk (a `walk-skills-runbar.mjs`, to be modelled on `apps/desktop/scripts/walk-skills-composer.mjs`) needs
  a GUI session a test harness cannot drive; every visual state stays unit-covered by
  `SkillRunBar.test.tsx` (offer / running / result / confirm-modal, EN+DE). The honest deferral (the
  documented default since Phase 5) is re-affirmed — no fake captures; the owner may run the capture on a
  GUI machine. Recipe essentials (full version:
  `git show f549ce8:docs/design-review/skills-s12/README.md` — the `docs/design-review/` capture staging
  folder was deleted 2026-07-12 per the delete-captures-after-review convention; the walk scripts
  `mkdirSync` it back on demand): (1) seed ONE indexed statement whose lines match the deterministic
  parser (`<ISO-date> <description> <amount with 2 minor digits>` + a currency marker on the page) —
  `listRunnableTools` returns `[]` without an `indexed` in-scope document; (2) drive extract → the busy
  row → each tool's result row, then the export tool to reach the `ConfirmDialog`; (3) stub
  `dialog.showSaveDialog` so the walk never blocks on an OS dialog; capture every state in both themes ×
  EN/DE; Playwright stays an ad-hoc dev tool (`--no-save`, never a committed dependency).

**Posture held across all 11 phases (load-bearing):** offline / no telemetry; the **content class** (skill
bodies, the draft question, extracted figures, redacted text, document text **and** titles/filenames) is
never logged / audited / echoed — only ids/counts cross the IPC/audit boundary; the audit payload stays
`{skillId, toolName, documentCount}`; schema changes are additive; the Tier-2 gate gained **no new
DB/FS/net capability**; i18n parity is compile-enforced (LLM prompts stay English).

**Backend-audit 2026-06-27 follow-ups on this surface (Phase 6 — SEC-1 / API-3).** A later backend
audit re-examined the same skills surface and landed two dispositions, recorded in §7 (full rationale
in [`security-model.md`](security-model.md) "Skill tool ceiling (Tier-2)" → SEC-1): **SEC-1** — the
run/runnable surface now gates on `source` via `skillCanRunTools(skill)` (`source === 'app'`), so
**Tier-2 tools run for built-in app skills only**; a user-imported `kind:'tool'` skill may declare
`allowedTools` (kept for a future per-tool grant UI) but runs none until that UI exists — enforced at
`runnableToolNames` (the choke point) and re-checked at `startSkillRun` (forged-IPC defense, content-
free refusal). **API-3** — `documentCount` stays the v1 constant `1` (single-document tools) with an
in-code TODO to make it a real count if a multi-document tool lands. The §22 posture above is
unchanged (no new capability; audit payload still `{skillId, toolName, documentCount}`).

### §24 Backend audit (2026-06-27) — remediation close-out

A **multi-persona read-only backend audit** (report `audits/backend-audit-2026-06-27.md`, HEAD `c26d361`)
swept the Electron **main process** + shared/preload of `apps/desktop` — crypto/vault, the data layer, the
full IPC surface, ingestion/parsers, RAG/analysis, doctasks/skills, runtime/downloads, OCR/transcriber/vision,
embeddings/reranker — focusing on what the five prior rounds did **not** cover.
**2 High · 9 Medium · 14 Low · 8 Info; no Critical, no remote-exploitable issue** (offline by construction).
**All 8 remediation phases are landed** on branch `backend-audit-2026-06-27-fixes`. Both the working-paper
plan (`docs/backend-audit-2026-06-27-remediation-plan.md`) and the audit report
(`audits/backend-audit-2026-06-27.md`) were **deleted** under the CLAUDE.md doc-lifecycle rule once every
finding was dispositioned — each phase's decisions were folded into the topic-doc §§ as it landed, and the
report's lasting content (the per-finding dispositions, the **verified-clean inventory**, and the accepted
residuals) lives in **this section**. Both files stay **recoverable in git history**. This ledger is the
durable index — resolve a code comment's `audit <ID>` citation through it:

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **DATA-1** (High), DOC-1, MAINT-1, TEST-1 | 1 | atomic-txn `deleteDocument`: ordered `purgeDocumentDerivatives` → `purgeSkillDataForDocument` (bank/invoice rows) **before** the row delete, stored copy shredded **after** commit; fresh schemas also declare full-chain `ON DELETE CASCADE`; teeth-verified extract-then-delete test | arch §10; known-lim §39–46; rag-design `deleteDocument` row |
| **BL-1** (High), TEST-2 | 2 | shared `money.ts splitLeadingDates` strips the whole leading date run (booking + value date) before the money scan in `parseLine`/`parseLineItem` — value-date column no longer dropped/mis-valued | arch §10 (line parser) / §21 (layout) |
| BL-2 (Med), TEST-6 | 2 | `assessCompleteness`/`reconcileBalances` return `unverified` unless single-currency (mirrors `summarizeCashflow`) | arch §10 |
| BL-3 (Low) | 2 | `categoryTotals` keyed by `(category, currency)` | arch §10 |
| REL-1 (Med), TEST-4 | 3 | `AbortSignal` threaded `ParseContext`→`AudioParser`→`transcribe` + whisper idle watchdog; per-job abort | arch "Audio transcription" |
| REL-2 (Med) | 3 | per-page OCR `Promise.race` timeout + terminate-and-recreate worker on timeout/abort | arch "Scanned-PDF / photo OCR" |
| REL-3 (Med) | 3 | dictation single-flight guard + wall-clock abort | arch "Voice dictation" |
| REL-6 (Low) | 3 | `TranscribeOptions.workDir` now **required** — no OS-tmpdir fallback outside the crash sweep | arch "Audio transcription" |
| REL-5 (Med), MAINT-4 | 4 | one `parseWithLimits(parser, source, ctx, limits)` decorator across **every** parse entry point; preview gains `maxPages`/`maxInflatedBytes`/wall-clock timeout (ingest byte-for-byte unchanged) | rag-design §2 (cap stack); arch "Document ingestion" |
| REL-9 (Low) | 4 | `expandPaths` symlink-cycle guard via recursion-path `realpathSync` Set | arch "Document ingestion" |
| REL-10 (Low) | 4 | `resolvePageYear` single-pass y-range fold (no `Math.max(...spread)`) | arch §21 |
| BL-5 (Info) | 4 | ragged-CSV overflow cells kept under `colN:` (no silent truncation) | rag-design §2 |
| RAG-1 (Med), TEST-3 | 5 | `coverageWhole` gated on `fullyChunked && scannedChunks >= totalChunks` — a multi-doc partial scope falls to "sections scanned" | rag-design §14.5 |
| EMB-1 (Med), MAINT-2, TEST-5 | 5 | reranker drops naive `truncateWords` for the shared CJK/Thai-aware `truncateToApproxTokens`, per-field caps clamped to the context budget (no silent 500 on space-less input) | rag-design §12.4 |
| DATA-2 (Low), EMB-2, TEST-7 | 5 | truncated-blob guard moved **into** `decodeVector` (`Float32Array \| null`) so all call sites skip a corrupt row uniformly | rag-design §12.4 |
| EMB-4 (Info), MAINT-5 | 5 | module-load LE-endianness assert in `codec.ts` | rag-design §12.4 |
| **SEC-1** (Med), DOC-5, TEST-8 | 6 | **DECISION: gate Tier-2 tools to APP skills** — `skillCanRunTools(skill)` = `source === 'app'` at `runnableToolNames` + re-check at `startSkillRun`; a user `kind:tool` skill keeps declared `allowedTools` (future per-tool grant UI) but runs none | arch §7/§23; security-model "Skill tool ceiling (Tier-2)" |
| API-3 (Info) | 6 | `documentCount` left the v1 constant `1` + in-code TODO (no behaviour change) | arch §7/§23 |
| SEC-2 (Low) | 7 | `installPermissionCheckHandler` mirrors the request handler via one shared `grantsMicrophone` predicate | security-model |
| SEC-3 (Low) | 7 | `installNavigationGuard` attaches one deny-predicate to **both** `will-navigate` + `will-redirect` (main shell-only; OCR window deny-all) | security-model |
| SEC-6 (Low) | 7 | `validateAnalyzeRequest` rejects a claimed png/jpeg with a `null` pixel count (`decodeFailed`) instead of byte-cap-only | security-model; arch (vision) |
| REL-4 (Med) | 7 | OCR page PNG byte cap (`assertPageWithinByteCap`, `OCR_MAX_PAGE_PNG_BYTES` = 96 MiB) | arch "Scanned-PDF / photo OCR" |
| REL-7 (Low) | 7 | `windowsHide: true` on the sidecar + GPU-probe spawns | arch (runtime) |
| REL-8 (Low) | 7 | `child.unref()` on the GPU probe so a wedged probe can't delay app quit | arch (runtime) |
| API-1 (Low) | 8 | `requireUnlocked()` preamble (new `main.chat.locked` i18n key) on every DB-touching chat handler | registerChatIpc — parity w/ docs/collections/doctasks |
| DATA-3 (Info), MAINT-3 | 8 | **DECISION: row-count eviction** — `evictSummaryCache` deletes oldest rows past `SUMMARY_CACHE_MAX_ROWS` (50 000), called once per `buildTree`, content-free counter | known-lim "Document tasks & summaries" |
| DOC-2 (Info) | 8 | rag-design "Cap" rewritten to over-cap **rejection** (`main.ingest.tooManyChunks`), not silent truncation | rag-design §14.1 |
| DOC-3 (Low) | 8 | E5 no-prefix retrieval **ceiling** surfaced (floor stays 0; reranker load-bearing) | known-lim "Retrieval quality" |
| DOC-4 (Info) | 8 | `summary_cache` eviction documented | known-lim "Document tasks & summaries" |
| BL-4 (Low) | 8 | redaction date-locale asymmetry (US-order / 2-digit-year slip; names/addresses unmasked) recorded as by-design under-detection | known-lim "Security & privacy" (redaction bullet) |
| DATA-4 (Info) | 8 | `ORDER BY chunk_index` on `documentApproxTokenTotal` (sum is order-independent → **zero behaviour change**) | — (read-shape parity) |

**Accepted residuals & non-code dispositions** (on record, deliberately not changed):

- **SEC-4** (Low, Phase 7) — pre-spawn binary verification is **session-cached per path** (the verify→spawn
  TOCTOU widens to per-session): a deliberate consistency trade-off, documented in `security-model.md`.
- **SEC-5** (Low, Phase 7) — `imageAnalyze` takes raw drag-drop bytes (not picker-token-bound): documented
  boundary, `security-model.md`.
- **API-2** (Info, Phase 8) — `importPreflight` accepts raw renderer paths for the recursive count/size walk:
  a pre-existing documented residual, **no code change**.
- **SEC-7** (Info) — the verified-clean inventory: **no action**, recorded below so it is not re-investigated.
- **TEST-9** (Low) — a double-EOCD / duplicate-name zip adversarial fixture for the installer was **not
  added**; the documented installer behaviour stands and the gap is an accepted residual.

**Verified-clean inventory (attested 2026-06-27 — recorded so it is not re-investigated next round).** The
audit read each of these and found them correct and well-tested; they are deliberately **not** findings:

- **Crypto / vault** — Argon2id default + scrypt legacy; descriptor-bound KDF params with sane bounds; the
  GCM verifier is checked before any DB decrypt; streaming file crypto with atomic temp+rename; key zeroing
  on lock and on wrong password; journaled v1→v2 rekey that recovers old-or-new per file.
- **Zip importer** — enumerate-before-inflate; path/symlink/extension/size re-validation; content-free error
  codes; no zip-slip.
- **Manifest parsing** — no `eval`/`Function`/`require` of package content; no prototype-pollution sink
  (own-enumerable `__proto__`, a fresh sanitized object).
- **Subprocess spawns** — array argv, no shell, hash-verified before spawn, drive-root escape guards.
- **Offline guard** — IPv4-anchored loopback check, fails safe.
- **Audit / log** — ids/counts/filenames only, sentinel-grep enforced, log encrypted at rest.
- **Confused-deputy** — picker capability tokens; drag-drop symlink-rejected + realpath-canonicalised.
- **Data layer** — FKs enforced (`foreign_keys = ON`); migrations idempotent + identifier-validated against
  injection; FTS5 mirrors trigger-synced + VACUUM-safe; `deleteConversation` deletes in FK order;
  `extraction_records`/`tree_nodes`/`document_collections`/`conversation_documents`/`image_turns` all CASCADE
  correctly; the prepared-statement cache is keyed by constant SQL only. *(The one exception — the
  bank/invoice tables lacking CASCADE — was DATA-1, fixed in Phase 1.)*
- **IPC / API surface** — the preload bridge is a closed allow-list; every handler validates id/array shapes;
  exports always go to a `dialog.showSaveDialog` user-chosen path; image/doc/skill-run jobs use
  async-with-polling; unknown job ids resolve to a terminal `failed` rather than throwing.
- **CLAUDE.md hard rules** — re-attested ✅: no cloud / hosted-AI APIs (only the two user-gated downloaders +
  loopback sidecar use `fetch`; CSP `connect-src 'self'`); no telemetry / analytics / remote crash reporting;
  no weights/user-data/logs committed; fully usable offline; user data local + encrypted by default; no
  hardcoded dev paths; Windows first-class; clean swappable service boundaries.

**Posture held across all 8 phases (load-bearing):** offline / no telemetry / no new network egress; the
**content class** (document text + titles/filenames, chat, extracted figures, redacted text) is never
logged/audited — the new lock message and the eviction counter carry **counts only**; schema changes were
additive (or fresh-schema CASCADE); the Electron + vision/OCR caps are defense-in-depth with **no new
DB/FS/net capability**. Final suite **2335 passed / 39 skipped**.

### §25 Full audit (2026-06-28) — remediation close-out

A **multi-persona read-only full audit** (report `audits/full-audit-2026-06-28.md`), run after the
backend audit 2026-06-27 close-out (§24) merged to `master`, swept `apps/desktop` (~47k LOC app, ~52k LOC
tests), `docs/`, `scripts/`, and `model-manifests/` across **seven personas** — security, backend /
architecture, data layer, RAG / ingestion, business logic, frontend, testing, documentation — focusing
where the backend-only prior round did **not** look: the renderer, financial-extraction locale
correctness, CI, and CJK / Thai ingestion. **No Critical, no remote-exploitable issue** (offline by
construction; only loopback sidecars + the two user-gated downloaders touch the network, prod CSP
`connect-src 'self'`). The §1 severity index enumerates **54 findings** — by area REL×5, BL×6, FE×9,
TEST×9, PERF×6, RAG×6, DATA×3, SEC×3, DOC×7 (5 High; the report's "48" headline miscounts its own table).
**All 9 phases (0–8) are landed** on branch `full-audit-2026-06-28-fixes`. The working-paper report was
**deleted** under the CLAUDE.md doc-lifecycle rule once every finding was dispositioned; it had already
been committed to the repo (since `f1fce73`), so the full original stays **recoverable in git history**
(the parent of the Phase-8 close-out commit), mirroring the §24 / 2026-06-27 precedent. Each phase's
decisions were folded into the topic-doc §§ as it landed, and the report's lasting content (the
per-finding dispositions, the **verified-clean inventory**, and the accepted residuals) lives in **this
section**. This ledger is the durable index — resolve a code comment's `full-audit-2026-06-28 <ID>`
citation through it.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **TEST-N1** (High) | 0 | **fixed** — `.github/workflows/ci.yml`: `npm ci → typecheck → build → test` on ubuntu+windows / Node 22.x, stable `ci-success` aggregate gate (the first machine backstop) | packaging.md "Continuous integration (CI)"; BUILD_STATE Phase 0 |
| TEST-N9 (Low) | 0 | **fixed** — `whisper-smoke` `mkdtempSync` moved into `beforeAll` + `afterAll` cleanup (no import-time temp leak in a skipped file) | this ledger; BUILD_STATE Phase 0 |
| **BL-N1** (High), TEST-N2 (High) | 1 | **fixed** — per-document **date-locale inference** (de-AT day-first default; flips to mm/dd only on an unambiguously US-ordered date) stops the silent row-drop / wrong-month; adversarial whole-string tests now drive the real `extractTransactionRows`/`parseLineItem` path (closing the pre-isolated-token gap); grouped figures (`1.000`, `1 234 567,89`, `1'234.56`) fully supported | known-lim "LINE PARSER" bullet; arch §10 (DECISIONS as built) |
| BL-N2 (Med) | 1 | **fixed** — `stripDateTokens` scrubs date tokens at **either** end before the last-money balance/total scan, so `Endsaldo … per 30.06.2026` no longer reads the date as the balance | known-lim "LINE PARSER" BL-N2 sub-bullet; §10 / §24 immunity claim corrected |
| BL-N3 (Med) | 1 | **fixed** — amount column chosen by **position** (second-to-last figure when a balance is present), not the first money-shaped token | known-lim "LINE PARSER" bullet |
| BL-N4 (Med), TEST-N6 (Med) | 1 | **fixed** — redaction masks punctuated US/national phones + case-insensitive IBANs; characterization tests pin the residual under-detection (US-order / 2-digit-year / names-addresses) | known-lim redaction "Phone and IBAN coverage" sub-bullet |
| BL-N5 (Low) | 1 | **fixed (code-only, no residual)** — `reconcileBalances` compares in integer cents, matching `assessCompleteness` | this ledger |
| BL-N6 (Low) | 1 | **docs-only / accepted** — redaction masks every date and deliberately does NOT infer locale (US `12/31` leaks while EU `31/12` masks); by-design best-effort, no leak path to any log | known-lim redaction date-masking sub-bullet |
| **REL-1** (High) | 2 | **fixed** — crash-only `RuntimeManager.forceRestart(opts)` does `doStop()` (clears `current`/`last` so `status()` stops reporting the dead server healthy) then `doStart()`, bypassing only the same-model idempotency guard; bounded to one fallback by persisted `gpuAutoDisabled` | arch §5.3 (corrected) |
| REL-2 (Low) | 2 | **fixed** — `LlamaServer.start()` instance-level `starting` single-flight latch (a 2nd concurrent direct caller joins the one start + waits for health) | arch §5.3 record (runtime) |
| **FE-1** (High) | 3 | **fixed** — `ErrorBoundary` (per-screen inside `<main>` keyed by `screen` + outer last-resort), localized fallback, **local-only** log (no network), nav rail stays alive | arch "Renderer robustness — design record (Phase 3)" |
| FE-2, FE-3, FE-4 (Med) | 3 | **fixed** — unhandled IPC rejections → `friendlyIpcError`/toast; per-skill in-flight Switch guard; `let active`/`mountedRef` unmount guards on every poll | arch renderer record |
| FE-5, FE-6, FE-7, FE-8, FE-9 (Low) | 3 | **fixed** — identity-stable `applyLanguageSetting`; stable React keys (name+index / monotonic id); tracked toast timers; `friendlyIpcError` + localized `UNKNOWN`; explicit Home/End edge select | arch renderer record |
| RAG-N1 (Med) | 4 | **fixed** — audio packing caps on `approxTokenCount` (CJK/Thai-aware) keyed off the chunk window; an over-budget single segment is char-split (space-less-safe), preserving the one-segment-per-chunk / no-overlap invariant | rag-design §2 (audio packing) |
| RAG-N2 (Low) | 4 | **fixed** — chunker char-slices space-less runs at `gcd(size, overlap)` so consecutive CJK/Thai chunks gain the ~80-token overlap (was zero) | rag-design §3 (windowing) |
| REL-4 (Med) | 5 | **fixed** — `deleteConversation` wrapped in one txn (ROLLBACK on throw), mirroring `deleteDocument` | arch §10 (data-layer hardening, Phase 5) |
| REL-5 (Low) | 5 | **fixed** — `deleteImageSession` deletes the row first (in a txn), shreds the file after (DATA-1 ordering) | arch §10 (Phase 5) |
| PERF-3 (Med) | 5 | **fixed** — `idx_messages_conv_kind` serves the per-turn `getLatestCheckpoint` compaction lookup with no SCAN (EXPLAIN-pinned) | arch data-layer index inventory |
| PERF-4 (Low) | 5 | **fixed** — `idx_summary_cache_created` turns the age-ordered eviction into an ordered index scan | arch data-layer index inventory |
| DATA-1 (Low) | 5 | **fixed** — `messages_fts_au` UPDATE trigger gains the `kind IS NOT 'compaction'` guard + `ensureMessagesFtsUpdateKindFilter` backfill | arch §10 (Phase 5) |
| DATA-2 (Low) | 5 | **invariant-only (no code change)** — `tree_edges.child_id` polymorphic-FK no-dangling-edge invariant pinned by an integrity test | arch §10 (Phase 5) |
| DATA-3 (Low) | 5 | **verify-only (no code change)** — `extract.ts` `__scan__` per-chunk idempotency confirmed + pinned by a no-double-count test | arch §10 (Phase 5) |
| RAG-N3 (Med), DOC-N6 (Low), TEST-N4 (Med) | 6 | **fixed** — reranker `MAX_DOC_APPROX_TOKENS` raised 320 → whole chunk window (500 = `CHUNK_DEFAULTS.chunkSizeTokens`) so it scores every chunk in full (n_ctx-safe via the existing clamp); graded-overlap ranking-order test replaces exact-match-only; the E5 prefix-less + reranker-prefix **ceilings** documented with the prefix-migration TODO | rag-design §11 "Known retrieval-quality ceilings" + §12.3 |
| RAG-N4 (Low) | 7 | **fixed** — `MarkdownParser` in-fence flag (a `#` inside a fenced block is code, not a heading) | rag-design §2 |
| RAG-N5 (Low) | 7 | **fixed** — CSV/TSV delimiter pinned by extension (`\t` / `,`), not papaparse auto-detect | rag-design §2 |
| RAG-N6 (Low) | 7 | **already-correct (no code change)** — `corpusNeedsReindex` routes through the shared `buildScopeFilter` (archived parity); pinned by a new `includeArchived` regression test | rag-design §13.6 |
| SEC-N1 (Low) | 7 | **fixed** — `safeRelPath` rejects a NUL member name (fixed `invalidPath`) before any write; `previewSkillPackage` wraps its body in a catch mapping residual throws to a fixed reason (sentinel-grep teeth) | security-model "Skill-import defences" |
| SEC-N2 (Low) | 7 | **fixed** — benchmark IPC (`runBenchmark`/`tryGpuAgain`) gains explicit `requireUnlocked()` parity (localized `main.benchmark.locked`) | security-model "Phase-7 security polish" |
| SEC-N3 (Info) | 7 | **accepted Info residual** — sidecar `serverMessage` 500-char tail is structural-only (our loopback llama.cpp, never user content); pinned by an `INVARIANT (SEC-N3)` comment at the cap | security-model "Phase-7 security polish" |
| TEST-N5 (Med) | 7 | **fixed (tests-only)** — assert observables not mechanisms (key-buffer-zero vs `Buffer.fill` spy; `≤ 1` read counts; `toContain` event arrays) | this ledger |
| TEST-N7 (Low) | 7 | **fixed (tests-only)** — fixed LE byte-layout assertion for `decodeVector` (`[00 00 80 3f] → [1.0]`), independent of encode | this ledger |
| TEST-N8 (Low) | 7 | **fixed (tests-only)** — structural lock test over every registered DB-touching chat/benchmark handler + a retrieve()-level rejecting-embedder test (failure propagates) | this ledger |
| PERF-1 (Med) | 7 | **fixed** — picker image read → `fs/promises` (open → stat → read loop → close in finally), preserving the same-handle TOCTOU invariant + byte cap | this ledger (ING-8 convention) |
| PERF-2 (Med) | 7 | **fixed** — dictation WAV write → `await writeFile` (finally still shreds) | this ledger (ING-8 convention) |
| PERF-6 (Low) | 7 | **fixed** — `AnswerThread` memoized `TurnRow`; the in-flight turn renders plain text, markdown parsed once on completion | this ledger |
| PERF-5 (Med) | 7 | **partially fixed (Part A)** — `DocRow = memo(...)` with stable callbacks so a poll tick / menu open / sibling-select re-renders only the affected row; **Part B (list windowing) re-deferred** (owner decision — no virt lib; variable-height rows + scroll/find/a11y behavior-sensitive) | arch renderer-tail note |
| **DOC-N1** (Med) | 8 | **docs-only** — security-model.md now names all **six** `HILBERTRAUM_SKILL_MAX_*` caps + the `HILBERTRAUM_MAX_IMAGE_BYTES` / `_PIXELS` image caps | security-model.md §6.4 caps bullet + D4 |
| DOC-N2 (Low) | 8 | **fixed (comment)** — `§21 → §22` for the bank-statement LLM categorizer in `doctasks/manager.ts` **and** `skills/categorizer.ts` (2nd instance found by the anchor sweep) | code comments → arch §22 |
| DOC-N3 (Low) | 8 | **docs-only** — README Qwen3.5-4B size `~2.6 → ~2.9 GB`; RAM tiers clarified as *recommended best-fit* vs the table's lower **Min RAM** floor | README.md |
| DOC-N4 (Low) | 8 | **docs-only + parity test** — scoped the "mirrored from assets.ts" claim to the download/verify/plan logic; the default-set ids live only in the two prepare-drive shells (new `prepare-drive-default-set.test.ts` pins their parity) | packaging.md; drive-layout.md |
| DOC-N5 (Low) | 8 | **docs-only** — single-test commands (`npx vitest run <file>`, `-t "<name>"`) + `test:watch` added | CONTRIBUTING.md; README.md |
| DOC-N7 (Low) | 8 | **docs-only** — packaging.md harness matrix gains an "optional inputs" table for the six `HILBERTRAUM_*` artifact-pointer vars | packaging.md |
| REL-3 (Low) | — | **not remediated (accepted)** — rasterizer reply waiter stays channel-only (no request-id correlation); a Low-confidence **HYPOTHESIS** whose impact is bounded by the per-step `withTimeout`; deferred as a correctness margin | this ledger (accepted residuals) |
| TEST-N3 (Med) | 0 / 8 | **partially remediated (accepted)** — the "manual smokes never run in CI" half is accepted-by-design (separate human gate, documented); the canned-fixture **policy** + the `gpu --list-devices` fixture exist, but the SSE + whisper-JSON parser fixtures remain **OUTSTANDING** (follow-up) | packaging.md harness matrix / fixture policy |

**Accepted residuals & non-code dispositions** (on record, deliberately not changed):

- **REL-3** (Low, HYPOTHESIS) — **not remediated**: the OCR rasterizer's hidden-window reply waiter matches
  on channel only (no request/page-id correlation). Impact is a correctness margin (any hang is bounded by
  the per-step `withTimeout`), confidence is Low, and it was never scoped to a phase; deferred as a future
  nicety, not a live defect.
- **TEST-N3** (Med) — **partially remediated**: the manual `HILBERTRAUM_*` smoke matrix is a deliberate
  **separate human pre-release gate** (it can't run in offline CI); the canned-real-output fixture-parser
  **policy** and the b9585 `--list-devices` fixture exist, but the promised **SSE** and **whisper-JSON**
  parser fixtures are still outstanding — an open follow-up so those parse layers gain CI coverage.
- **PERF-5 Part B (list windowing)** — **documents-list DONE** (full-audit-2026-06-29 follow-up Phase 4 /
  PERF-2 — `@tanstack/react-virtual`; see §36); the **chat transcript** half stays deferred (variable-height
  messages + scroll-to-bottom + find-in-page + StreamAnnouncer — genuinely behavior-sensitive), still the
  tracked top renderer item. Part A (row memoization) shipped earlier.
- **E5 `query:`/`passage:` prefix migration** (RAG-N3 / DOC-N6) — **tracked TODO, not done**: it re-embeds
  the whole corpus (its own phase) and would re-enable a meaningful `ragMinSimilarity` floor; the reranker
  full-chunk fix was the smaller-blast-radius lever taken now.
- **DATA-2 / DATA-3** — **invariant-only / verify-only** (no code change): both are pinned by tests, not
  altered behavior.
- **SEC-N3** — **accepted Info residual**: the sidecar `serverMessage` tail is structural-only by upstream
  (loopback llama.cpp) convention, pinned by an invariant comment at the 500-char cap.
- **BL-N5** — a clean code-only fix with **no residual limitation** (not a trade-off), so deliberately
  absent from known-limitations.md.
- **Residual caveats inside fixed findings** (documented in known-limitations.md): BL-N1 — a doc whose dates
  are **all** fully ambiguous reads day-first (silent; the tool output schema is frozen); BL-N3 — an unusual
  layout (two amount columns / a description figure in the amount slot) can still mis-pick; BL-N4 — bare
  un-punctuated phone runs + space-grouped IBANs still slip (best-effort).

**Verified-clean inventory (attested 2026-06-28 — recorded so it is not re-investigated next round).** The
audit read each of these and found them correct and well-tested; they are deliberately **not** findings:

- **Crypto / vault** — lifecycle, key-zeroing on lock / wrong password, journaled v1→v2 rekey: re-attested
  (the §24 crypto inventory still holds end-to-end).
- **The full IPC `requireUnlocked()` surface** — every DB-touching handler **fail-closes** when locked
  (the `ctx.db` getter throws); TEST-N8 added a **structural** lock test over the **chat + benchmark**
  handlers and SEC-N2 closed the one benchmark parity gap. *(Correction, post-merge §30/F16: the
  original TEST-N8 enumerated only chat+benchmark — not "every" module. The audit/core-settings/model/rag
  groups touched `ctx.db` with no **explicit** `requireUnlocked()` preamble, so they fail-closed but
  surfaced the raw English vault string. §30 added the localized preamble to those four groups and
  **generalized** the structural test across the core/model/audit/rag/benchmark/collections modules — see
  `tests/integration/ipc-lock-coverage.test.ts`; the rest (docs/doctasks/images) keep their own dedicated
  locked-vault tests.)*
- **Electron hardening** — deny-by-default navigation / permission guards on both events, the closed preload
  allow-list, CSP `connect-src 'self'`, OCR window deny-all.
- **spawn / process security** — array argv, no shell, hash-verified before spawn, drive-root escape guards,
  `windowsHide` / `child.unref()` on the probe.
- **Offline / SSRF posture** — IPv4-anchored loopback guard (fails safe), per-redirect-hop re-validation
  (https-only + private-range deny), streamed-size cap; only the two user-gated downloaders + loopback
  sidecars use `fetch`. *(Post-merge §30: the private-range deny also now covers the **IPv4-mapped IPv6**
  form — F15 — and the streamed-size cap is now **always bounded** on both downloaders — F17.)*
- **RRF fusion determinism** — the pure `rrfFuse` units stay strong, and the pass-through guarantee (no
  keyword / no reranker ⇒ byte-identical to vector-only) was re-verified in Phase 6.
- **Vector codec hardening** — `decodeVector` truncated-blob guard + module-load LE assert; TEST-N7 added a
  fixed-byte-layout test pinning the on-disk LE contract.
- **FTS injection-safety** — FTS5 triggers synced + VACUUM-safe, identifier-validated migrations; DATA-1
  added the UPDATE-trigger `kind` guard.
- **The SEC-1 Tier-2 app-skill gate** — Tier-2 tools run for built-in **app** skills only
  (`skillCanRunTools`, re-checked at `startSkillRun`): re-attested.
- **Chat-stream lifecycle** — error / abort / destroyed-renderer / key-reuse paths, IPC subscriptions torn
  down in `finally`.

**Posture held across all 9 phases (load-bearing):** offline / no telemetry / no new network egress;
behavior-preserving (every behavioral fix teeth-checked neuter→fail→restore, then restored byte-identical);
the **content class** (document text + titles/filenames, chat, extracted figures, redacted text) is never
logged / audited / exported; schema changes are additive (two `IF NOT EXISTS` indexes + one FTS-trigger
guard); the only Phase-8 code touches are the DOC-N2 comment fix (×2) + the DOC-N4 parity test. Final suite
**2417 passed / 39 skipped** (typecheck + build green across the cumulative branch; no phase regressed
another, verified by one full-suite run at close-out).


### §26 Full audit (2026-06-29) — remediation close-out

A **fresh 7-persona read-only full audit** (report `audits/full-audit-2026-06-29.md`), run after the
2026-06-28 round (§25) was fully remediated and merged (PR #12), swept the real source tree across
**security, RAG/ingestion, backend reliability, renderer, testing, documentation, and financial/business
logic**, with the top findings re-verified firsthand (regex traces, a full-suite run, doc/code diffs).
**No Critical, no remote-exploitable issue** (offline by construction). The report enumerated **2 High,
~9 Medium, ~13 Low**; the two release-blockers were a confirmed financial-correctness bug (BL-1) and an
intermittently-red suite (TEST-1). **All six phases (0–6) landed** on branch `full-audit-2026-06-29-fixes`.
The working-paper report was **retired** under the CLAUDE.md doc-lifecycle rule once every finding was
dispositioned; it was committed first so the full original stays **recoverable in git history** (the parent
of the Phase-6 close-out commit), mirroring the §24 / §25 precedent. Each phase's decisions were folded into
the topic-doc §§ as it landed; the report's lasting content (per-finding dispositions + accepted residuals)
lives in **this section**. This ledger is the durable index — resolve a code comment's
`full-audit-2026-06-29 <ID>` citation through it.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **TEST-1** (High) | 0 | **fixed (test-only)** — `dictation-ipc.test.ts` REL-3 poll swapped from an iteration cap (`i < 100` `setImmediate` ticks, flaked under full-suite CPU load) to a wall-clock deadline (`Date.now() - start < 5000`), matching the rest of the integration suite; 3× consecutive green | this ledger; BUILD_STATE Phase 0 |
| **BL-1** (High, release-blocking) | 1 | **fixed** — `MONEY_RE`'s trailing `\s*\)?-?` stole the NEXT column's leading minus (`2.500,00 -500,00` → amount −2500 / balance +500, both flipped, so `reconcileBalances` blessed the wrong figures); replaced with a **space-disambiguated** trailing region `(?:-\|\s*\)\|\s+-(?!\s*[-+(]?\d))?` — a *glued* `-` is a de-AT debit (consumed), a *spaced* `-<digit>` is the next figure's sign (left alone). **DIVERGED from the audit's literal `(?:-(?!\s*[-+(]?\d))?`** — that form regressed the common de-AT row `45,90- 1.908,20` (glued debit + balance) to +45,90; verified by trace (rationale: BUILD_STATE Phase 1) | arch §8 "Financial correctness (full-audit-2026-06-29, Phase 1)"; known-limitations LINE PARSER (spaced-trailing-minus residual) |
| BL-2 (Med) | 1 | **fixed** — per-row `detectCurrency` now scans only the **figure region** (`rest.slice(matches[0].index)`) with statement-currency fallback, so a `USD`/`$` in a payee memo no longer collapses a EUR statement to the mixed-currency refusal; a genuine figure-adjacent foreign code is still honoured | arch §8 (figure-region currency); known-limitations |
| BL-3 (Med, de-AT target) | 1 | **fixed** — `wordIncludes` gained a one-sided **compound** mode; the unambiguous DE keywords (`gebühr`/`gehalt`/`überweisung`/`bargeld`) opt in via `compound: true` so `Kontoführungsgebühr`→Fees, while English tokens + ambiguous `lohn` stay strict (no C-1 regression); `categorizeRow` + `prefilterCategory` thread the flag (C-1 invariant held) | arch §8 (`wordIncludes` paragraph); known-limitations |
| **REL-1** (Med) | 2 | **fixed** — `LlamaServer.start` retries `doStart` **once** on a bind-class immediate exit (`isBindRaceError`) on a fresh port (covers chat AND embedder/reranker/vision, which had no retry); the ladder no longer persists `gpuAutoDisabled` on a bind race vs a device fault, so a port collision can't disable GPU for the session | arch GPU record §5.5 |
| REL-2 (Med) | 2 | **fixed** — `killWithEscalation` mirrors `LlamaServer.stop()` (SIGTERM → SIGKILL after `killGraceMs`, grace timer unref'd/cleared), wired into the whisper watchdog/abort/`stop()` kill sites; `suspend()`/`stop()` bound the cleanup await (`suspendTimeoutMs`, crash-sweep is the shred backstop) so a SIGTERM-ignoring child can't hang quit/lock | known-limitations "Audio transcription" (SIGKILL/teardown residual); this ledger |
| REL-3 (Med) | 2 | **fixed** — `acquireForChat(signal?)` threads the turn's abort signal (new `waitForHandoff`); a Stop during a deep-index slot park rejects at once (removes the waiter, returns its `chatHolders` slot, drops the pause if last), resolved cleanly via `done` not `chat:error`; all 7 chat/rag call sites forward `controller.signal` | arch doc-task / model-slot-arbiter record; this ledger |
| **DOC-2** (Low) | 2 | **fixed (docs)** — GPU table "60 s health timeout" → "180 s (3 min)" (`DEFAULT_HEALTH_TIMEOUT_MS`; chat runtime never overrides it) | arch GPU record §8 table |
| TEST-2 (Med) | 3 | **fixed (test-only)** — `binary-verify-spawn.test.ts` drives the **real** `verifyBinaryBeforeSpawn` at all three spawn seams (`LlamaServer.start`, GPU `--list-devices` probe, `whisper-cli`) with packaged enforcement ON + a hash-mismatched marker → each refuses to spawn; matching-marker positive control; teeth-checked per seam | arch "Test-enforcement seams — design record (Phase 3)" TEST-2 |
| TEST-3 (Med) | 3 | **fixed (test-only)** — `rag.test.ts` proves a fresh failing embedder over a non-empty corpus makes `generateGroundedAnswer` **reject** (doesn't masquerade as NO_DOCUMENT_CONTEXT) | arch test-enforcement record TEST-3 |
| TEST-4 (Low) | 3 | **fixed (test-only)** — `skills-installer.test.ts` covers `encryptedZip` (GP-flag + ZIP64-sentinel), the SEC-N1 NUL `invalidPath` no-echo, and `pathTooLong` through the real `previewSkillPackage`/`importSkill`; the "no tar" test relabelled documentation-only | arch test-enforcement record TEST-4; this ledger |
| TEST-5 (Low) | 3 | **fixed (test-only)** — the vision success-path no-leak test was **converted** to route through the real `VisionRuntime` (recording `fetch` + SSE body), so the no-prompt/no-image-bytes-in-logs guarantee exercises the real SSE/HTTP path | arch test-enforcement record TEST-5; this ledger |
| **FE-1** (Low) | 4 | **fixed** — `ChatScreen` gained the FE-4-class `mountedRef` (gating the attach-poll + stream-flush setStates) + a flush-timer `clearTimeout` on unmount; the main-side stream is **not** torn down (recovered via `getActiveStream`) — guard-only | arch renderer record (FE-4 bullet, "Extended (full audit 2026-06-29, FE-1)") |
| RAG-1 (Low) | 4 | **fixed** — both fusion input lists carry a `chunkId` tiebreak (vector sort `score desc, chunkId asc`; FTS `ORDER BY bm25(...), chunks_fts.chunk_id`) so equal-score ties are total/reproducible across SQLite versions; resident-cache equivalence oracle aligned | rag-design §11 per-list tie-break note |
| RAG-2 (Low) | 4 | **fixed** — `truncateSnippet` counts AND slices by code point (`[...trimmed]`) so a boundary-straddling astral char no longer leaves a lone surrogate in a citation snippet (display-only) | source comments (`snippet-truncate.test.ts`); this ledger |
| REL-4 (Low) | 4 | **fixed** — `combineSignals` owns an `AbortController` + explicit `setTimeout` and returns `{ signal, clear }`; the three embed/rerank/vision call sites `clear()` in `finally` so an early completion no longer leaves a 120 s/300 s timer + `any`-listener alive (behaviour preserved: caller-abort + timeout still abort, `TimeoutError`, unref'd) | source comments (`combine-signals.test.ts`); this ledger |
| **PERF-1** (Med, the scalability item) | 5 | **fixed** — the resident decoded-vector cache is now **incremental**: `invalidate` marks dirty (no longer drops the map); the next read reconciles via an ids-only scan (drop gone ids) + a point decode of only genuinely-new chunk ids — a pure-add of K into N decodes K, not N. The `(count, maxRowid)` signature is **retained** as the self-healing backstop (out-of-band write → full rebuild); `purge` still drops the map on lock | arch "Performance — design record … Wave P4" (Incremental-delta + PERF-1 Phase-5 note) |
| DOC-1 (Med) | 6 | **fixed (docs)** — `collections.ts` header no longer claims the *shipped* C2 delete-with-documents is "left out of v1"; repointed from the wrong `rag-design §13.7` to **architecture.md §1 C2** (the `projectOnlyDocumentIds` predicate is in the same file) | code comment → arch "Document organization — design record" §1 C2 |
| DOC-3 (Low) | 6 | **fixed (docs)** — `bge-reranker-v2-m3.yaml` `size_on_disk_gb` 1.08 (GiB mislabel) → **1.16** (decimal GB, matching `size_bytes 1159776896 / 1e9` and the other twelve manifests); `model-policy.md` "~1.08 GB" → "~1.16 GB" | model-manifest + model-policy.md reranker row |
| DOC-4 (Low) | 6 | **fixed (docs)** — dropped the dangling `/§11.1` from `benchmark.test.ts`'s "GPU record §8/§11.1" comment (the GPU record is §1–§8; §8 resolves) | code comment → arch GPU record §8 |
| SEC-1 doc half (Low) | 6 | **docs-only** — added an **accepted-residual** note: vault unlock has no attempt counter / rate-limit and only an 8-char floor, so against the lost/stolen-drive threat a weak-but-≥8 password is offline-guessable at interactive-minimum Argon2id cost; at-rest Argon2id+AES-GCM is the primary mitigation; recorded as a defensible offline trade-off | security-model.md "Accepted residual — offline password guessing" |
| TEST-6 (Info) | 3 | **docs-only / by-design** — the **S13b skill-trigger precision bar IS a live CI gate** (`fired-wrong == 0` ∧ `precision ≥ 0.95`, `skill-triggers.test.ts`); the remaining no-automated-floor gap is narrower: **RAG answer-quality + real-model output** (env-gated out of CI by design), caught only by the manual smoke matrix. *(Wording corrected Phase 7 / D1 — the original "owner-gated on D1" claim went stale once the S13b bar landed.)* | arch test-enforcement record TEST-6 |
| **SEC-1 code half** (Low) | — | **accepted residual / open follow-up** — unlock-path rate-limit/attempt-counter + create-time strength meter/floor; deliberately **not** built in the docs-only close-out (a UI rate-limit doesn't bind the offline attacker that is the real threat; the at-rest KDF is the mitigation) | security-model.md residual note |
| SEC-2 (Low) | — | **accepted residual / open follow-up** — `previewSkillPackage` stages path-/size-validated, finally-cleaned content to the shared OS `tmpdir()`; not an escape (skill packages aren't secret). Follow-up: stage under `userSkillsDir` for trust-zone consistency | this ledger |
| SEC-3 (Info) | — | **accepted residual / open follow-up** — the dialog-opener IPCs (`pickSkillPackage`/`pickDocuments`/`imageChooseImage`) mint a capability token pre-unlock, but every **consuming** handler is `requireUnlocked()`-gated so the token is inert until unlock; a consistency gap, not an exploit | this ledger |
| REL-5 (Low) | — | **non-reachable while the single-`DatabaseSync` architecture holds; promote to a real fix only if a second DB connection (e.g. a worker-thread reader) is introduced** — verified (follow-up Phase 6) architecturally non-reachable: exactly one live synchronous `DatabaseSync` connection per session (`db.ts`; others are transient open→seed→checkpoint→close), and all 15–20 `BEGIN…COMMIT` bodies are synchronous (the slow `await embed/generate` sits *outside* the txn). `BEGIN IMMEDIATE` would be a no-op without a second writer, so the `withTransaction(db, fn)` refactor stays deferred. **Precondition made explicit so a future worker-pool/second-connection change can't silently make it reachable** | this ledger; §37 (follow-up Phase 6 REL note) |
| §5 INFO / by-design (CSV single-data-row, DOCX paragraph-split, `embedChunks` single-batch, `corpusNeedsReindex` double-scan, rerank-before-dedup cost) | — | **accepted (no change)** — low-severity edge/robustness notes; each acceptable as-is, recorded so the next audit skips them | this ledger (accepted residuals) |
| PERF-5 Part B (list windowing), E5 `query:`/`passage:` prefix migration | — | **carried forward from §25 (still open)** — list virtualization re-deferred (no virt lib; variable-height rows + scroll/find/a11y behavior-sensitive); the prefix migration re-embeds the whole corpus (its own phase) and would re-enable a `ragMinSimilarity` floor | §25 accepted residuals (unchanged) |

**Accepted residuals & non-code dispositions** (on record, deliberately not changed this round):

- **SEC-1 code half / SEC-2 / SEC-3** — three security **consistency** improvements, none an exploit: the
  offline-guessing residual's *only* binding mitigation is the at-rest KDF (a UI rate-limit doesn't stop the
  drive-in-hand attacker), preview-temp staging is path-/size-validated and finally-cleaned, and the
  dialog-opener tokens are inert until the consuming handler's `requireUnlocked()` gate. Open follow-ups, not
  Phase-6 work (Phase 6 was docs-only by charter).
- **REL-5** — `BEGIN IMMEDIATE` + `withTransaction` is **deferred**, now with the precondition stated
  explicitly: it is **non-reachable while the single-`DatabaseSync` architecture holds** (one live synchronous
  connection per session; every `BEGIN…COMMIT` body synchronous, the slow `await` outside the txn). It becomes
  a real fix to build **only if a second DB connection is introduced** (e.g. a worker-thread reader / a
  connection pool) — that change, not this audit, is what would make `BEGIN IMMEDIATE` load-bearing. Recorded
  so a future worker-pool change can't silently re-open the gap (verified follow-up Phase 6; see §37).
- **§5 by-design edge notes** — CSV single-data-row, DOCX paragraph-split, `embedChunks` single-batch (bounded
  by the 1000-chunk cap), `corpusNeedsReindex` double-scan (only on the already-failed empty-retrieval path),
  and rerank-before-dedup cost (correct by design): all acknowledged, none scoped to a fix.
- **PERF-5 Part B (list windowing)** and **E5 prefix migration** — **carried forward unchanged** from the §25
  accepted residuals (still the owner-dispositioned long-pole items).
- **§-anchor sweep note (not a finding to fix here):** the sweep confirmed DOC-1 (→ §1 C2) and DOC-4 (→ §8)
  resolve and that every audit-introduced code/test comment cites by finding-ID. It also surfaced **two
  pre-existing dangling `§11.1` citations** in `gpu.test.ts` and `runtime-ladder.test.ts` (the same `§11.1`
  DOC-4 flagged, but at locations the report did not name). Per the Phase-6 scope guard (fix only citations
  this audit introduced) they were **left as-is and reported** — a candidate for a future doc-comment pass.

**Posture held across all six phases (load-bearing):** offline / no telemetry / no new network egress;
behavior-preserving (every behavioral fix in Phases 1/2/4/5 teeth-checked neuter→fail→restore; Phases 0/3
were test-only with no `src/` behavior change; Phase 6 was docs/comments-only + the report retirement); the
**content class** (document text + titles/filenames, chat, extracted figures, redacted text) is never logged
/ audited / exported; no schema/IPC/audit-payload change in any phase. Final suite **2463 passed / 39 skipped
(2502 collected)** (typecheck + build green; the Phase-6 docs/comments change touched no test and the suite is
unchanged from Phase 5).

### §27 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 1 — money-parser correctness)

A **fresh post-merge full audit** (report `audits/full-audit-2026-06-29-postmerge.md`), run after §26 was
merged, found the prior round's **bank** hardening had not propagated to the sibling **invoice** path. The
pattern: *the fix exists next door but wasn't applied here.* It enumerated **1 High, ~9 Medium, ~13 Low**;
**Phase 1 — the release-blocker money-parser class — is remediated** on branch `audit-postmerge-phase1-money`
(suite **2483 passed / 39 skipped**, typecheck + build green). Parsing-only; no schema/IPC/audit-payload
change. The design record is **§8 "Financial correctness (full-audit-2026-06-29-postmerge, Phase 1)"**;
resolve a `full-audit-2026-06-29-postmerge <ID>` code comment through this ledger. Later phases (F2/F4/F5/F7/
F9 reliability, F11–F19 RAG/security/concurrency, F20–F24 renderer, D1–D8 docs, T1–T9 test seams) are **not
started** — carried in the report.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **F1** (High, release-blocking) | 1 | **fixed** — an uncaptured amount column read the running BALANCE as the movement amount (`Sparen 50 1.234,56` → 1234.56). Bank: `parseLine` FLAGS `ambiguousAmount` (one money token + bare-number-trailing description); `extractTransactionRows` drops it **only when the statement has a balance column**. **DIVERGED from the audit's literal "drop whenever a left digit-run remains"** — the unconditional drop regressed the HVB "Umsätze" no-balance numeric-payee format (`REWE … 1234 -19,15`), so the drop is statement-context-aware. Invoice mirror drops on the **RIGHT** (line total = LAST figure): `Hosting 12,50 500` → drop | arch §8 (F1); known-limitations LINE PARSER (F1 + residuals) |
| F3 (Med) | 1 | **fixed** — invoice per-line `detectCurrency` now scans only the **figure region** (`rest.slice(matches[0].index)`) with `documentCurrency` fallback (the BL-2 fix, never applied to invoices); `validateInvoiceTotals` gained the bank gate's **single-currency guard** (`lineItemsSumToNet: 'unknown'` for a >1 line-item currency set) | arch §8 (F3); known-limitations (figure-region currency bullet) |
| F6 (Med) | 1 | **fixed** — on the geometry-less invoice path a space-grouped token WITHOUT a 2-dp decimal tail (`Widget 10 100` → 10100) is a likely column fusion → the row is **DROPPED** (`isFusedSpaceGroup`); a decimal-anchored `1 234 567,89` is kept; `15 799,00` stays the accepted DECISION-2 trade-off | arch §8 (F6); known-limitations (grouping bullet) |
| F8 (Low) | 1 | **fixed** — the invoice `quantity` split now requires a unit token (a captured `QTY_TRAIL_RE` group) OR a corroborating unit-price column; `iPhone 15 1.799,00` keeps "iPhone 15", `Widget A 2 12,50 25,00` still reads qty 2. Metadata-only (lineTotal unaffected) | arch §8 (F8); known-limitations (qty bullet) |
| T5 (test/invariant) | 1 | **pinned** — `parseAmount` rounds every figure to the nearest cent (`Math.round(\|value\|*100)`) so the integer-cent invariant holds by construction; a >2-dp `1.234,567` reads `1234.57` (normalised, not dropped). T4 (parens-negative) + T9 (negative line totals / Gutschrift/Rabatt) now pinned through the real scanner | arch §8 (T5); known-limitations (2-dp bullet) |
| F10 (Low) | 1 | **acknowledged (no code change)** — the invoice path runs without geometry layout reconstruction (D58 is bank-only), so it is the most parse-fragile money path; Phase 1 prioritised its robustness (F1 right-side drop, F6 fusion drop) since it has no backstop, and the asymmetry is recorded | arch §8 (F1/F6); known-limitations (invoice geometry note) |
| F2, F4, F7, F9 | 2 | **fixed (Phase 2)** — chat-regenerate data-loss (F2) + embedder/reranker bind-race start-latch (F4/F7) + compaction-failure log (F9); see the **§28 ledger** | arch §28; arch "Chat & streaming"; GPU record §5.5b |
| F5 | 3 | **fixed (Phase 3)** — invoice extraction re-inserted a fresh invoice + line items on every analysis question (no reuse/replace/staleness, where the bank path has all three); now mirrors the bank reuse-or-re-extract gate (`extractor_version` + `isInvoiceStale` + `replaceExisting` atomic swap); see the **§29 ledger** | arch §29; arch §8 (invoice reuse/replace/staleness parity) |
| F14, F15, F16, F17 | 4 | **fixed (Phase 4)** — security consistency: F15 mapped-IPv6 SSRF deny-list bypass, F14 diagnostics-log buffer readable after lock, F16 IPC lock-guard parity + generalized structural test (subsumes **T3**), F17 download size caps always bounded; see the **§30 ledger** | arch §30; security-model §D3 + "encrypted log" record; §25 inventory correction |
| T1, T2, T6, T7, T8, T9, T3 | 5 | **closed (Phase 5, test-only)** — test-enforcement seams: T1 SIGKILL escalation unit test, T2 resident-cache lock-purge IPC wiring, T6/T7 two TEST-1-family flakes de-flaked (fake timers / `vi.waitFor`), T8 crash-fallback real-reap assertion, T9 truncated-ciphertext nit; T3 verified subsumed by F16; T4/T5 done in Phase 1. `git diff src/` empty; see the **§31 ledger** | arch §31; "Test-enforcement seams" record (Phase-5 subsection) |
| F20, F21, F22, F23, F24 | 6 | **fixed (Phase 6, renderer-only)** — frontend a11y + lifecycle: F20 first-run gate phase-focus management (the `finishing` step had no focus target — the real gap; welcome→password & →starter already focused via `autoFocus`), F21 mic-stream leak when getUserMedia resolves after unmount, F22 ModelsScreen poll + DiagnosticsTab activity refreshers join the FE-4 `mountedRef` discipline (the claim now holds), F23 StreamAnnouncer `aria-atomic` drop, F24 Composer fallback caret-timer cleared on unmount; see the **§32 ledger** | arch §32; "Renderer robustness" FE-4 reconciliation |
| D1–D8 + F11/F13 doc-notes | 7 | **fixed / recorded (Phase 7, docs + comments-only)** — the D1–D8 documentation contradictions reconciled to one source of truth + the F11/F13 as-built distinctions carried into the topic docs + a clean §-anchor sweep; see the **§33 ledger** | arch §33; rag-design §14.4 (F11) + §12.1 R3 (F13) |
| F12, F18, F19 | 8 | **fixed (Phase 8, the close-out)** — F12 named-delta resident-cache reconcile (no O(N) id-scan), F18 vision terminal-write cancelled-guard, F19 `tearingDown` race guard on embedder+reranker `suspend()`; the audit report was RETIRED here. The **F11 renderer half** + **F13 code** are carried forward. See the **§34 close-out ledger** | arch §34 (master close-out); Performance/Wave-P4 (F12); GPU §5.5c (F19); Image-understanding §5 (F18) |

**Posture held (Phase 1, load-bearing):** offline / no telemetry / no new network egress; the **content
class** (extracted figures, document text) is never logged/audited/exported; no schema/IPC/audit-payload
change. Every fix is **characterization-first then test-first** (pin current behaviour → assert the correct
post-fix value → red on current code → green after the fix) through the real `extractTransactionRows`/
`parseLineItem`/`validateInvoiceTotals` entry points (TEST-N2 discipline: whole strings, never pre-isolated
tokens). The normal 2-figure de-AT row is byte-identical; the HVB no-balance geometry case
(`pdf-bank-layout.test.ts`) stays green (the F1 divergence exists to protect it).

### §28 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 2 — chat-regenerate data-loss + sidecar bind-race reliability)

**Phase 2** of the post-merge audit closes the reliability cluster — all four "apply the fix that already
exists next door" findings: the regenerate path commits a destructive delete before the REL-3-protected slot
is claimed (F2), and the embedder/reranker start-latches never received the REL-1 bind-race classifier
(F4/F7), plus the silent compaction-failure swallow (F9). Branch `audit-postmerge-phase2-runtime-reliability`
(suite **2492 passed / 39 skipped**, typecheck + build green). No schema/IPC-channel/audit-payload change.
Design records: **"Chat & streaming" (regenerate is delete-after-slot)** + **GPU record §5.5b (bind-race aware
start-latch)**; resolve a `full-audit-2026-06-29-postmerge <ID>` code comment through this ledger.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **F2** (Med, data-loss) | 2 | **fixed** — regenerate dropped the prior assistant reply (committed; `node:sqlite` is synchronous) BEFORE the stream slot was claimed, so a non-abort failure (a context-exceeded 400, a dead sidecar, a rejected slot) left the turn answer-less. The IPC layer now does only the read-only `hasRegenerableAssistantReply` precondition before the stream; the delete runs INSIDE `withChatStream`'s `runFn` via `withRegenerateGuard` (slot held + controller registered) and the snapshot is **re-inserted byte-faithfully** (`restoreMessage`) on a non-abort failure. A user Stop keeps the delete. Applied to **both** channels (`registerChatIpc` + every `registerRagIpc` `withChatStream` site); slot/stream semantics otherwise identical | arch "Chat & streaming" (regenerate is delete-after-slot) |
| **F4** (Med) | 2 | **fixed** — the embedder start-latch (`e5.ts`) armed for ANY rejection, so a transient double-bind-race (REL-1 retries only once) latched a permanent-looking failure and **silently disabled all imports** for the session until lock/unlock. The `.catch` now skips arming when `isBindRaceError(message)` — leaving `startFailed` null so the next `embed()` re-attempts on a fresh port. The latch still arms (and still clears on `suspend()`) for a genuine load fault | arch GPU record §5.5b; known-limitations (embedder latch) |
| **F7** (Low) | 2 | **fixed** — same bind-race exclusion for the reranker (`reranker/llama.ts`). Its latch is more persistent (it deliberately SURVIVES `suspend()`), so latching a race disabled reranking for the whole session (a silent quality regression — retrieval falls back to fused order). Forgiving the race makes the keep-on-`suspend()` policy correct again: only a genuine load fault persists | arch GPU record §5.5b; known-limitations (reranker latch) |
| **F9** (Low) | 2 | **fixed** — `chat/compaction.ts`'s `catch {}` around `summarizeRegion` was fully empty, so a repeatable summarizer BUG (not a user Stop) compacted never, silently, forever (offline/no-telemetry). The fallback to L1 is unchanged; the NON-abort case now `log.warn`s (`conversationId` + the error message — no chat content), an `AbortError` still does not | arch "Chat & streaming" (compaction) |

**Posture held (Phase 2):** offline / no telemetry / no new network egress; the **content class** (chat
text, document text, extracted figures) is never logged/audited/exported (F9's diagnostic carries only the
conversation id + the underlying error message); no schema/IPC-channel/audit-payload change. The bind-race
classifier is **reused, not re-invented** — the retry (§5.5) and the latch (§5.5b) share `isBindRaceError`, so
they can't drift. Every fix is **test-first** (red on current code → green after): F2 drives the real chat +
RAG IPC handlers (`chat-ipc.test.ts`, `rag-regenerate-ipc.test.ts`) with a runtime that 400s on a regenerate
and asserts the prior reply survives + a service-level delete→restore round-trip (`chat.test.ts`); F4/F7
inject a double-bind-race at the real spawn/health seam (`e5-embedder.test.ts`, `reranker.test.ts`) and assert
the latch stays null + a later call retries (F7 also pins survives-`suspend` vs a genuine fault persisting);
F9 spies `log.warn` on a non-abort summarizer throw and asserts the abort path stays silent
(`chat-compaction.test.ts`). **Open (later phases):** F11–F19 RAG/security/concurrency (Phase 4/8), F20–F24
renderer a11y/lifecycle (Phase 6), D1–D8 docs (Phase 7), T1–T9 test seams (Phase 5).

### §29 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 3 — invoice data lifecycle parity)

**Phase 3** closes the single data-integrity finding F5 — again the "apply the fix that already exists next
door" pattern: the **bank** path reuses a fresh extraction and gates re-extraction on a version + staleness
check; the **invoice** path had none of it and re-inserted a brand-new `invoices` row (+ line items) on
**every** analysis-shaped question. The fix is **parity, not a new design** — the invoice path now mirrors
`analysis/bank-statement.ts` exactly. Branch `audit-postmerge-phase3-invoice-lifecycle` (suite **2495 passed
/ 39 skipped**, typecheck + build green). The design record is **§8 "Invoice reuse / replace / staleness —
parity with the bank path"**; resolve a `full-audit-2026-06-29-postmerge F5` code comment through this ledger.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **F5** (Med, data-integrity) | 3 | **fixed** — the invoice analysis handler re-extracted + INSERTed a fresh `invoices` row on every question (silent content-table bloat; a deterministic re-extraction producing identical rows, N questions → N invoices + N×line-items). Now mirrors the bank reuse gate: `invoices` gained an additive nullable `extractor_version` column (`db.ts`, copy of the `bank_statements` migration); `runInvoiceExtraction` stamps `INVOICE_EXTRACTOR_VERSION` (`tools/invoice.ts`) and accepts `replaceExisting`; the handler **REUSES** `latestInvoiceId` when present and **not** `isInvoiceStale`, else re-extracts with `replaceExisting: true` — which DELETEs the prior invoice + line items (FK order, the shared `deleteInvoicesForDocument`) **inside** the persist `BEGIN/COMMIT` before the INSERT (atomic swap). `purgeSkillDataForDocument`'s ordered delete is unchanged (same helper) | arch §8 (invoice reuse/replace/staleness parity); arch §27 (F5 row) |

**Posture held (Phase 3):** offline / no telemetry / no new network egress; the **content class** (extracted
invoice figures) is never logged/audited/exported (`extractor_version` is a provenance int, content-class
adjacent — never surfaced). The schema change is a **single additive nullable column** added through the
existing idempotent `ensureColumn` mechanism: an old on-disk workspace opens cleanly (pre-existing rows are
NULL → stale → re-extracted on next reuse), and the bank table is untouched. `node:sqlite` is synchronous, so
the `replaceExisting` delete-then-insert stays inside one `BEGIN/COMMIT` with no await between. Every fix is
**test-first** (red on current code → green after): `skills-analysis-invoice.test.ts` reproduces the bloat (N
questions persisted N invoices) and now asserts exactly one invoice + one line-item set survive, a fresh
invoice is reused (same id, no duplicate), and a version-NULL invoice is detected stale → re-extracted +
replaced in place at the current version (the tampered figure is gone). **Open (later phases):** F11–F19
RAG/security/concurrency (Phase 4/8), F20–F24 renderer a11y/lifecycle (Phase 6), D1–D8 docs (Phase 7), T1–T9
test seams (Phase 5).

### §30 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 4 — security consistency hardening)

**Phase 4** closes the four security-consistency findings F15/F14/F16/F17. None is a remote exploit (the app
is **offline by construction**); each is a **gap where a documented control didn't fully hold** — a deny-list
that missed one host spelling, a buffer that outlived its lock, lock-guards that fail-closed but spoke the raw
string, and a size cap that could collapse to the backstop. Branch `audit-postmerge-phase4-security-consistency`
(suite **2515 passed / 39 skipped**, typecheck + build green). Every fix is **test-first** (red on current code
→ green). Resolve `full-audit-2026-06-29-postmerge F14/F15/F16/F17` code comments through this ledger.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **F15** (Low→Med, SSRF) | 4 | **fixed** — IPv4-mapped IPv6 bypassed the download deny-list: `new URL()` canonicalizes `[::ffff:127.0.0.1]` → host `::ffff:7f00:1` / `[::ffff:169.254.169.254]` → `::ffff:a9fe:a9fe`, which the dotted-decimal-only regex never matched, so mapped loopback / RFC-1918 / the cloud-metadata IP slipped the guard (reachable via a hostile manifest `download.url` or a redirect `Location:`). `isPrivateOrLoopbackHost` now **denies any host containing `::ffff:`**. The detection-only `offlineGuard.isLoopbackHost` is left as-is (gates no enforcement). Tests: `assets.test.ts` (unit on each spelling + redirect-hop + a public-host positive control) | security-model §D3 (F15) |
| **F14** (Low, data-handling) | 4 | **fixed** — `detachVaultKey()` dropped+zeroed the vault key and reverted to `buffering` but left the in-memory `buffer` holding the just-ended session's metadata (file names/paths/model ids/settings keys — never document/chat text); the buffering read path + the intentionally-ungated `getLogTail`/`exportLog` let a still-mounted Diagnostics screen read/export it **after** lock. **Option (a):** zero the buffer **after** the final encrypted flush (next unlock repopulates from `app.log.enc` — nothing lost); guarded on `mode==='encrypted'` so the pre-FIRST-unlock diagnostics window is preserved. Test: `logging.test.ts` | security-model "Design record — encrypted log" (F14) |
| **F16** (Low, defense-in-depth + doc) | 4 | **fixed** — the §25 inventory overstated "TEST-N8 enumerates every DB-touching handler" (it covered only chat+benchmark); rag/audit/core-settings/model touched `ctx.db` with **no explicit** `requireUnlocked()` (fail-closed via the getter, but raw English string). Added the localized preamble (`main.audit.locked`/`main.settings.locked`/`main.models.locked`; rag reuses `main.chat.locked`) to those four groups and **generalized** the structural lock test across the core/model/audit/rag/benchmark/collections modules (`tests/integration/ipc-lock-coverage.test.ts`), asserting refusal + that the read-only channels (`getLogTail`/`getRuntimeStatus`) still resolve when locked. **Subsumes Phase-5 item T3** (rag:ask lock-rejection). §25 wording corrected | this ledger; §25 inventory correction |
| **F17** (Low, disk-fill) | 4 | **fixed** — `downloadToFile`'s cap fell to the 64 GiB backstop when nothing bounded the body; the **engine** downloader passed no `maxBytes` and the **model** downloader passed one only when `size_bytes` was present. Both now **always** pass a bounded cap: engine = `ENGINE_DOWNLOAD_MAX_BYTES` (2 GiB), model = `modelWeightMaxBytes(role, sizeBytes)` (exact size, else a per-role default: chat/vision 40 GiB, transcriber 8 GiB, embeddings/reranker 4 GiB). Backstop lowered 64→48 GiB (now unreachable from production). The cap policy is extracted to the unit-testable `effectiveDownloadCap`. Tests: `assets.test.ts` (pure helpers), `downloads.test.ts` + `engine-download.test.ts` (injected `downloadImpl` captures the applied cap) | security-model §D3 (F17) |

**Posture held (Phase 4):** offline / no telemetry / no new network egress / no new IPC channel. The only
schema-adjacent change is an additive `role: ModelRole` field on the internal `ModelDownloadTask` (set from
the manifest; the DIY `fetch-*` scripts don't use the TS type). Three new localized i18n keys
(`main.audit.locked`/`main.settings.locked`/`main.models.locked`) added to en + de. The new size-cap
constants live in `assets.ts` (the canonical reference module). Every fix is **test-first** with genuine teeth
— the generalized lock test reddens if any module's `requireUnlocked()` is removed; the SSRF and size-cap
tests red on the pre-fix code. **Open (later phases):** F11–F13/F18/F19 RAG/perf/concurrency (Phase 8),
F20–F24 renderer a11y/lifecycle (Phase 6), D1–D8 docs (Phase 7), T1/T2/T6/T7/T8 test seams (Phase 5; **T3 now
subsumed by F16's generalized lock test**); the §26-carried SEC-1 (code half) / SEC-2 / SEC-3 remain
deferred to their own phase.

### §31 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 5 — test-enforcement seams)

**Phase 5** is **TEST-ONLY** — it closes the seams where a security/reliability control is correct today but
no test proves it stays *wired* (a silent unwiring would redden nothing). Branch
`audit-postmerge-phase5-test-seams` (suite **2518 passed / 39 skipped**, typecheck + build green). **`git diff
src/` is empty** — the only source edits were the temporary teeth-check neuters, each restored byte-identical.
Every new/strengthened test is **teeth-checked**: neuter the guarded control → the test reds → restore. The
disposition for each is in the **"Test-enforcement seams"** record below (extended with a Phase-5 subsection);
resolve a `full-audit-2026-06-29-postmerge T<n>` code comment through that record. T4/T5 landed in Phase 1; T3
was subsumed by F16 (Phase 4).

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **T1** (Med) | 5 | **closed** — the LlamaServer **unit** suite couldn't exercise SIGTERM-ignore→SIGKILL escalation (its `FakeChild.kill()` exits on ANY signal, so `stop()` always settled on the "exited" branch). New `sidecar.test.ts` test with a **stubborn child** (records each signal, dies only on SIGKILL) asserts `signals == [undefined,'SIGKILL']`. Teeth: revert the line-576 gate `this.exited` → `child.killed` → SIGKILL dropped → reds | "Test-enforcement seams" (T1) |
| **T2** (Med) | 5 | **closed** — the resident-cache lock-PURGE (RAG-6 SECURITY requirement) was proven only at the unit tier, never that the lock IPC *calls* it. `workspace-ipc.test.ts` now seeds a real resident map, locks, and asserts `purgeResidentVectors` fired against the LIVE db (spy delegates to the real impl, shared `caches`). Teeth: drop the purge call from the lock handler → spy 0× → reds | "Test-enforcement seams" (T2) |
| **T6** (Low) | 5 | **closed (de-flake)** — the GPU-probe timeout test awaited a real 20 ms `setTimeout` (a TEST-1-family wall-clock flake). Converted to fake timers (`vi.advanceTimersByTimeAsync`, the combine-signals idiom) with an injected trivial `verify`; the kill-on-timeout assertion is preserved. Teeth: neuter the timeout `child.kill('SIGKILL')` → `child.killed` stays false → reds | "Test-enforcement seams" (T6) |
| **T7** (Low) | 5 | **closed (de-flake)** — the privacy-guard snapshot poll was an iteration-capped `for(i<50){sleep(5)}` (TEST-1 sibling). Converted to `vi.waitFor` (the gpu-ipc idiom) — re-polls until the run settles, no fixed cap. The no-secret-in-snapshot assertions are preserved. (The optional `vision-runtime.test.ts` real-timer copies were left as-is — converting them needs the fakeClock seam, out of scope for a quick nit) | "Test-enforcement seams" (T7) |
| **T8** (Low) | 5 | **closed** — the crash-fallback test counted a monkey-patched `stop()` wrapper (`made[0].stops===1`), which still holds if `stop()` stops reaching the child kill (orphan). `runtime-manager.test.ts` now also pins the REAL reap on observable child state: a final `mgr.stop()` + `children[1].child.killed===true` (the LIVE restarted child is genuinely killed). **DIVERGED from the audit's literal "crashed child killed===true"** — the crashed child already `exited`, so `stop()` correctly early-returns before any kill (its `killed` stays false; asserting true would red on correct code). Teeth: early-return `stop()` before the kill → the live child's `killed` stays false → reds | "Test-enforcement seams" (T8) |
| **T3** (Med) | 4 | **verified subsumed** — `ipc-lock-coverage.test.ts` (F16) drives `registerRagIpc` against a locked ctx with NO exemptions, so `rag:ask` is enumerated and asserted to reject with the localized lock copy. No separate Phase-5 test added | §30 (F16); "Test-enforcement seams" (T3) |
| **T9** (Low, nit) | 1/5 | **partially closed** — invoice negative line totals / Gutschrift/Rabatt were pinned in Phase 1; the AES-GCM **truncated (length-reduced) ciphertext** case is added at the `crypto.ts` unit tier (`crypto.test.ts`, one assertion — distinct from the existing bit-flip cases). The `BANK_EXTRACTOR_VERSION` tautological-tripwire and the mock-embedder score-band nits are left as accepted | "Test-enforcement seams" (T9); arch §8 (Phase 1 T9) |

**Posture held (Phase 5):** **no `src/` behavior change** — nothing shipped changed, so no behavior-doc
change. Test-only. The de-flake conversions (T6/T7) removed two real-wall-clock waits (verified stable across
repeated runs); the wiring proofs (T1/T2/T8) each redden on a one-line neuter of the control they guard.
**Open (later phases):** F11–F13/F18/F19 RAG/perf/concurrency (Phase 8), F20–F24 renderer a11y/lifecycle
(Phase 6), D1–D8 docs (Phase 7); the §26-carried SEC-1 (code half) / SEC-2 / SEC-3 remain deferred.

### §32 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 6 — renderer accessibility + lifecycle consistency)

**Phase 6** closes the renderer cluster F20–F24 — frontend accessibility + effect-lifecycle consistency.
**Renderer-only** (plus one test file / case per finding); **no IPC surface, no main-process behavior, no new
user-facing copy** (so no i18n catalog change). Branch `audit-postmerge-phase6-frontend-a11y` (suite **2523
passed / 39 skipped**, typecheck + build green). The FE-4 reconciliation is folded into the **"Renderer
robustness" record** (FE-4 bullet, below); resolve a `full-audit-2026-06-29-postmerge F2<n>` code comment
through this ledger. Test-first where observable in jsdom (F20/F21/F22 each red on current code → green).

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **F20** (Med, a11y) | 6 | **fixed** — the first-run gate swaps the entire card per `phase`; focus is now steered to each step's primary control via `useEffect(…, [phase])` (`WorkspaceGate.tsx` — password input on `password`, Skip on `finishing`, primary action on `starter`; the welcome CTA keeps its mount-time `autoFocus`). `PasswordField` gained an `inputRef` prop (mirroring `Composer`'s pattern). **DIVERGED from the audit's framing** — the audit called `welcome → password` the critical gap, but that field already carried `autoFocus` (the new test is green there pre-fix); the real deterministic gap was the **`finishing` step (no focus target at all → focus reset to `<body>`)**, which the new test reds on pre-fix. The effect also makes every transition re-entry-safe (`autoFocus` fires only on first mount). WCAG 2.4.3 / 3.2.2 | arch §32; `WorkspaceGateFocus.test.tsx` |
| **F21** (Low, privacy/lifecycle) | 6 | **fixed** — `DictationButton.start()` assigned `captureRef` only AFTER `await getUserMedia`, so unmounting while the OS mic prompt was open ran the cleanup first (nothing to release), then stored a LIVE `MediaStream` on the dead component and never `.stop()`d it (OS recording indicator stayed lit). A `mountedRef` (mirroring ChatScreen/DocumentsScreen) now cancels the just-acquired capture and skips `onRecording` when unmounted. Teeth: `Dictation.test.tsx` resolves an injected capture AFTER unmount → asserts `cancel()` fired + recording was never entered | arch §32; "Renderer robustness" FE-4 |
| **F22** (Low, lifecycle) | 6 | **fixed** — `ModelsScreen` was the lone FE-4 hold-out: its download/engine poll callbacks ran `setJob` + (on a live→terminal transition) `void refresh()` with no mounted guard, and the `DiagnosticsTab` `loadActivity`/`loadMoreActivity` refreshers (listed as guarded but weren't) ran `setEvents`/`setMoreAvailable` ungated. Both now carry the `mountedRef` guard, so the architecture's "FE-4 applied uniformly" claim now genuinely holds. Teeth: `ModelsScreenUnmount.test.tsx` parks a `getDownloadJob` tick, unmounts, resolves it → asserts no extra `listModels` (no refresh on a dead component) | arch §32; "Renderer robustness" FE-4 (narrowed) |
| **F23** (Low, a11y) | 6 | **fixed** — the `StreamAnnouncer` live region carefully feeds only newly-completed sentences into a `role="log" aria-live="polite"` region, but `aria-atomic="true"` told the AT to re-read the ENTIRE region on every change (re-announcing prior sentences; double-speak on fast boundaries). Dropped `aria-atomic` (`role="log"` defaults to atomic=false); the sentence-slicing is untouched. `StreamAnnouncer.test.tsx` pins `not aria-atomic="true"` | arch §32; `StreamAnnouncer.test.tsx` |
| **F24** (Low, lifecycle nit) | 6 | **fixed** — `Composer.insertDictation`'s non-`execCommand` fallback (jsdom / future removal) deferred caret restoration via an untracked `setTimeout(…, 0)`. Now tracked in a ref and cleared on unmount (consistency with FE-7/FE-1 timer cleanup). Benign in real Electron (`execCommand` succeeds there), so this is consistency-only; the Dictation insert-at-caret test still passes | arch §32 |

**Posture held (Phase 6):** offline / no telemetry / no new network egress; renderer-only; no IPC channel,
main-process, schema, or i18n-catalog change; the **content class** is untouched (no logging/audit/export
surface added). No happy-path regression — the mic capture (F21), the streaming announcer slicing (F23), the
poll-driven refresh (F22), and the dictation caret-restore (F24) all still work (their existing suites stay
green). Every lifecycle guard **reuses the existing `mountedRef` idiom** (ChatScreen/DocumentsScreen/
DiagnosticsTab), not a new discipline. **Open (later phases):** F11–F13/F18/F19 RAG/perf/concurrency (Phase
8), D1–D8 docs (Phase 7); the §26-carried SEC-1 (code half) / SEC-2 / SEC-3 / REL-5 / PERF-5 Part B / E5-prefix
remain deferred.

### §33 Full audit (2026-06-29, post-merge) — remediation ledger (Phase 7 — documentation reconciliation)

**Phase 7** is **docs- and code-comment-only — no behavior change** (`git diff` shows only `.md`/`.yaml`
files and code COMMENTS; no `src/` logic edit). It reconciles the §3 documentation findings D1–D8 to a single
source of truth, carries the F11/F13 as-built realities into the topic docs, and re-runs the §-anchor sweep.
Branch `audit-postmerge-phase7-docs`. The audit report stays (Phase 8 retires it).

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **D1** (Med) | 7 | **fixed (docs)** — the TEST-6 record claimed the S13b skill-trigger precision bar was "owner-gated on D1 / not yet landed"; it is in fact a **live CI gate** (`skill-triggers.test.ts` asserts `fired-wrong == 0` AND `precision ≥ 0.95`, re-verified live). Corrected the §27 ledger row + the "Test-enforcement seams" TEST-6 record + the BUILD_STATE TEST-6 bullet: the bar IS asserted; the remaining no-CI-floor gap is narrower — real-model **RAG answer quality** + the env-gated quality benchmarks | arch TEST-6 record + §27 row; BUILD_STATE |
| **D2** (Med) | 7 | **fixed (docs)** — `known-limitations.md` claimed the in-app downloader "drives only `tasks[0]` (the GGUF)"; the code fetches **both GGUF + mmproj as one job** (DIST-1, `downloads.ts` `planDownload`; `downloads.test.ts` asserts `totalBytes == gguf + mmproj` + the finish-just-the-projector case). Rewrote the limitation to the as-built reality; user-guide §8 / troubleshooting carry no contradicting claim | known-limitations.md (image-understanding) |
| **D3** (Med) | 7 | **fixed (docs)** — reconciled the reranker "**never bundled by default**" contradiction to ONE story: the reranker **IS** in the DIY `prepare-drive --with-assets` default fetch set (README/packaging/drive-layout — correct, unchanged), but is flagged `bundled_on_preconfigured_drive: false` (advisory/**unused by the validator**) as the intent for a sold/commercial preconfigured drive. Fixed the phrasing in model-policy.md, rag-design.md §12.3, and the reranker manifest comment. The **vision** "never bundled by default" was left — it is genuinely NOT in `--with-assets` (opt-in, true) | model-policy.md; rag-design §12.3; reranker manifest |
| **D4/D5/D6** (Low) | 7 | **fixed (comments)** — four stray test-comment fragments cleaned: `gpu-smoke.test.ts` "60 s health timeout" → **180 s** (`DEFAULT_HEALTH_TIMEOUT_MS`); dropped the dangling `/§11.1` from `gpu.test.ts` (→ §5.1) and `runtime-ladder.test.ts` (→ §5.2) and the dangling `/§9` from `assets.test.ts` (→ §6). The GPU design record is §1–§8; §9/§11.1 never existed (`benchmark.test.ts` was already fixed by DOC-4) | code comments → GPU record §5.1/§5.2/§6 + sidecar `DEFAULT_HEALTH_TIMEOUT_MS` |
| **D7** (Low) | 7 | **fixed (docs)** — reconciled the whisper RTF figures to **two annotated regimes** matching the R-W3/R-W4 source measurements: a **long sustained file ≈ RTF 0.67** (real-time÷1.5 / two-thirds; R-W4 52-min → 35 min, user-guide 30-min → 20-min) and a **short clip ≈ RTF 0.46–0.5** (R-W3 benchmark clips + dictation). Annotated the short-vs-long distinction in known-limitations.md (audio + dictation) and the whisper manifest comment so the figures no longer read as contradictory | known-limitations.md; whisper manifest |
| **D8** (Low) | 7 | **fixed (docs)** — clarified README disk-space: the ~**3 GB** figure is the **hand-built** minimal footprint (4B + embeddings only); the one-command `--with-assets` quick-start default set (8B + embeddings + reranker + Whisper + both runtimes) is ~**7 GB**, so a user sizing a drive from the 3 GB line does not under-provision | README.md |
| **F11** (doc-note) | 7 | **recorded (docs)** — rag-design §14.4: a `mode:'tree'` answer's `[Sn]` citations are **whole-document LEAF PROVENANCE** (`documentLeafProvenance`, up to ~1000 leaves), NOT the 1:1 inline-grounded excerpts of the `generateGroundedAnswer` contract (the tree prompt carries no `[Sn]` markers). A deliberate coverage choice; differentiating the renderer presentation is the Phase-8 follow-up — recorded as a known distinction | rag-design §14.4 |
| **F13** (doc-note) | 7 | **recorded (docs)** — rag-design §12.1 R3: added a one-line **PRECONDITION** that re-enabling a positive `ragMinSimilarity` floor (a goal of the deferred E5 `query:`/`passage:` prefix migration) MUST first move the floor **before** the `topKInitial` cut — `rag/index.ts` applies it after the cut today, so a positive floor would silently lose recall. Coupled to that migration phase | rag-design §12.1 R3 |

**§-anchor sweep (re-run, Phase 7).** Swept every `§` citation in `docs/**`, `README.md`, `BUILD_STATE.md`,
and the `apps/desktop/{src,tests}` comment tree. The §27–§32 post-merge ledgers (Phases 1–6) exist,
are consecutively numbered, and the named-record citations they added (GPU record §5.5b, §22-D1 honesty
posture, security-model `D3`, the "Chat & streaming" / "encrypted log" / "Renderer robustness" / "Test-
enforcement seams" records) all resolve. **Residuals fixed:** the four D4/D5/D6 fragments above, **plus** one
pre-existing dangler the independent sweep surfaced — `image-understanding plan §16` (cited in
`vision-runtime.test.ts` / `vision-smoke.test.ts`) was missing from the image-understanding §-anchor legend;
added a legend row mapping plan §16 → §6 (V4/V5 runtime hardening) + model-benchmarks §8. **Result: clean** —
every `§` citation now resolves.

**Posture held (Phase 7):** offline / no telemetry; no `src/` LOGIC change (docs + code-comments only);
typecheck + `npm test` + `npm run build` re-run green to confirm the comment edits broke no source-grepping
test. **Open (Phase 8, the close-out):** F12/F18/F19 + the F11 renderer half, then retire this audit report.

### §34 Full audit (2026-06-29, post-merge) — remediation CLOSE-OUT

The **post-merge full audit** (report `audits/full-audit-2026-06-29-postmerge.md`) is **COMPLETE** — all
eight phases landed. Its pattern was *"the fix exists next door but wasn't applied here"*: the prior
round (§26) hardened the **bank** parser and the **chat** runtime, and this pass found the **invoice**
parser, the **embedder/reranker** sidecars, and the **regenerate** path had not received the sibling
hardening. **No Critical, no remote exploit** (offline by construction); 1 High (F1), ~9 Medium, ~13 Low,
9 test-seam items (T1–T9), 8 doc items (D1–D8). Each phase folded its decisions into the topic docs as it
landed (the per-phase ledgers **§27–§33**, plus the named records); **this section is the durable master
index** — resolve a `full-audit-2026-06-29-postmerge <ID>` code comment through it. The working-paper
report was **retired** under the CLAUDE.md doc-lifecycle rule once every finding was dispositioned (it was
committed first, so the original stays **recoverable in git history** — the parent of the Phase-8 close-out
commit), mirroring the §24/§25/§26 precedent. Phases ran on stacked, unmerged branches
(`audit-postmerge-phase1-money` … `phase8-closeout`); owner merges when ready.

**Per-phase one-liners:** **P1** money-parser correctness (F1/F3/F6/F8 + the invoice single-currency
guard + the T5 2-dp invariant; §27, §8). **P2** runtime reliability (F2 regenerate data-loss / F4+F7
bind-race start-latch / F9 compaction log; §28). **P3** invoice lifecycle parity (F5 reuse/replace/
staleness; §29). **P4** security consistency (F15 mapped-IPv6 SSRF / F14 log-buffer-on-lock / F16 IPC
lock-guard parity — subsumes T3 / F17 download caps; §30). **P5** test-enforcement seams (T1/T2/T6/T7/T8 +
T9; §31, test-only). **P6** renderer a11y + lifecycle (F20–F24; §32, renderer-only). **P7** docs
reconciliation (D1–D8 + F11/F13 doc-notes; §33, docs/comments-only). **P8** (this close-out) the
low-hangers F12/F18/F19 + report retirement.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **F1** (High) | 1 | **fixed** — uncaptured amount column read the running BALANCE as the amount; bank flags `ambiguousAmount` + drops only when a balance column exists (statement-context-aware — DIVERGED from the literal unconditional drop, which regressed the HVB no-balance format); invoice mirror drops the right-side uncaptured column | §27; §8 (F1); known-limitations |
| F3 (Med) | 1 | **fixed** — invoice per-line `detectCurrency` scans only the figure region + `validateInvoiceTotals` single-currency guard (the BL-2 fix applied to invoices) | §27; §8 (F3) |
| F6 (Med) | 1 | **fixed** — geometry-less invoice space-grouped token w/o a 2-dp tail dropped (`isFusedSpaceGroup`) | §27; §8 (F6) |
| F8 (Low) | 1 | **fixed** — invoice qty split requires a unit token or a corroborating unit-price column | §27; §8 (F8) |
| F10 (Low) | 1 | **acknowledged (no code)** — invoice path runs without geometry (D58 = bank-only); its robustness was prioritised since it has no backstop | §27; §8 |
| **F2** (Med) | 2 | **fixed** — regenerate delete deferred INSIDE `withChatStream` (`withRegenerateGuard`) + byte-faithful restore on non-abort failure; both chat + RAG channels | §28; "Chat & streaming" |
| F4 (Med) | 2 | **fixed** — embedder start-latch skips arming on `isBindRaceError` (a transient double-bind-race no longer silently disables imports) | §28; GPU §5.5b |
| F7 (Low) | 2 | **fixed** — same bind-race exclusion for the reranker (makes the keep-latch-across-`suspend()` policy correct) | §28; GPU §5.5b |
| F9 (Low) | 2 | **fixed** — `compaction.ts` `catch {}` now `log.warn`s the non-abort case (no chat content); abort stays silent | §28; "Chat & streaming" |
| **F5** (Med) | 3 | **fixed** — invoice reuse/replace/staleness parity with bank (`extractor_version` + `isInvoiceStale` + `replaceExisting` atomic swap) | §29; §8 |
| **F15** (Low→Med, SSRF) | 4 | **fixed** — `isPrivateOrLoopbackHost` denies any `::ffff:` host (the mapped-IPv6 form `new URL()` canonicalizes to) | §30; security-model §D3 |
| F14 (Low) | 4 | **fixed** — `detachVaultKey()` zeroes the log buffer after the final encrypted flush (option a; next unlock repopulates) | §30; security-model "encrypted log" |
| F16 (Low) | 4 | **fixed** — localized `requireUnlocked()` on rag/audit/settings/model + generalized `ipc-lock-coverage.test.ts` (**subsumes T3**); §25 wording corrected | §30; §25 inventory |
| F17 (Low) | 4 | **fixed** — both downloaders always pass a bounded cap (engine 2 GiB; model exact-size or per-role default); backstop 64→48 GiB | §30; security-model §D3 |
| **T1** (Med) | 5 | **closed (test)** — LlamaServer unit SIGKILL-escalation test (stubborn child); teeth-checked | §31; "Test-enforcement seams" |
| T2 (Med) | 5 | **closed (test)** — resident-cache lock-purge wiring asserted at the IPC layer against the live db | §31; "Test-enforcement seams" |
| **T3** (Med) | 4 | **subsumed by F16** — `ipc-lock-coverage.test.ts` enumerates `rag:ask` against a locked ctx | §30 (F16); §31 |
| T4 (Med) | 1 | **addressed** — parens-negative pinned through the real `extractTransactionRows` | §27; §8 |
| T5 (Med) | 1 | **fixed + pinned** — `parseAmount` rounds to the nearest cent (the 2-dp integer-cent invariant) | §27; §8 |
| T6 (Low) | 5 | **closed (de-flake)** — GPU-probe timeout → fake timers; teeth-checked | §31 |
| T7 (Low) | 5 | **closed (de-flake)** — privacy-guard poll → `vi.waitFor` | §31 |
| T8 (Low) | 5 | **closed (test)** — crash-fallback pins a REAL child reap (DIVERGED: the crashed child already exited) | §31 |
| T9 (Low nit) | 1/5 | **partially closed** — invoice negative totals/Gutschrift (P1) + AES-GCM truncated-ciphertext (P5); the tautological-tripwire + mock score-band nits accepted | §31; §8 |
| **F20** (Med, a11y) | 6 | **fixed** — first-run gate steers focus per `phase` (the `finishing` step had none — DIVERGED from the welcome→password framing) | §32 |
| F21 (Low) | 6 | **fixed** — `DictationButton` cancels a mic capture acquired after unmount (`mountedRef`) | §32 |
| F22 (Low) | 6 | **fixed** — ModelsScreen polls + DiagnosticsTab refreshers join the FE-4 `mountedRef` discipline | §32; "Renderer robustness" |
| F23 (Low, a11y) | 6 | **fixed** — `StreamAnnouncer` drops `aria-atomic` (additive `role="log"` reads only the new sentence) | §32 |
| F24 (Low) | 6 | **fixed** — Composer fallback caret timer tracked + cleared on unmount | §32 |
| **D1–D8** (Med/Low, docs) | 7 | **fixed (docs)** — D1 TEST-6 record corrected (S13b IS a live CI gate) · D2 downloader fetches GGUF+mmproj · D3 reranker bundling reconciled · D4/D5/D6 four stray comment fragments · D7 whisper RTF two regimes · D8 README disk sizing | §33 |
| **F11** (Low) | 7 / — | **doc-note recorded (P7)**; renderer half **NOT taken (P8)** — the `mode:'tree'` answer's `[Sn]` are whole-document leaf provenance, not inline-grounded excerpts (rag-design §14.4); differentiating the renderer presentation stays the **carried-forward** follow-up (the documented distinction stands) | §33; rag-design §14.4 |
| **F12** (Low, perf) | **8** | **fixed** — the resident-cache reconcile's O(N) `SELECT chunk_id` scan is gone for the in-band paths: the three write sites pass named added/removed chunk_ids → delta fast path (decode only the new rows, no scan), with a `Map.size === COUNT(*)` gate falling back to the full scan (delta-less / out-of-band / wrong delta) — byte-identical to a cold rebuild (PERF-1 contract). Bench leg added | this ledger; Performance/Wave-P4 record |
| **F13** (Low, latent) | 7 / — | **doc-note recorded (P7)**; code **carried forward** — re-enabling a positive `ragMinSimilarity` floor must first move it BEFORE the `topKInitial` cut; coupled to the deferred E5 `query:`/`passage:` prefix migration (inert at the pinned default 0) | §33; rag-design §12.1 R3 |
| **F18** (Low, concurrency) | **8** | **fixed** — VisionService terminal `done` write routes through the cancelled-guarded `set()` (returns whether applied) so a concurrent cancel isn't overwritten / re-emitted. Latent (no await before it today); dual-neuter teeth-check recorded | this ledger; Image-understanding §5 |
| **F19** (Low, concurrency) | **8** | **fixed** — `tearingDown` flag (the `suspend()` analogue of `stop()`'s `stopped`) bars a racing `ensureStarted` from spawning a sidecar that would survive the lock; both embedder + reranker; deterministic interleave teeth-test | this ledger; GPU §5.5c |

**Carried-forward open items (deliberately NOT taken; on record for the next pass):**

- **F11 renderer half** — present `mode:'tree'` answers as whole-document provenance (or cap the persisted
  leaf list) rather than identically to inline-cited answers. The doc-note (rag-design §14.4) is the
  current truth; the renderer change was scoped out of Phase 8 (non-trivial vs the Low severity).
- **F13 code (floor-before-cut)** — a **precondition** of the deferred E5 `query:`/`passage:` prefix
  migration (its own phase): re-enabling a positive `ragMinSimilarity` floor must over-fetch then floor,
  or push the floor into the scan. Inert today (floor pinned at 0).
- **§26-carried (re-verified, still valid):** **SEC-1 code half** (unlock rate-limit/attempt-counter +
  create-time strength meter — the at-rest KDF is the binding mitigation against the offline attacker, so a
  UI rate-limit doesn't bind the real threat); **SEC-2** (preview-temp staging under `userSkillsDir`);
  **SEC-3** (dialog-opener capability tokens inert until the consuming `requireUnlocked()` gate); **REL-5**
  (`BEGIN IMMEDIATE` + a single `withTransaction` guard — the no-`await`-in-txn invariant re-verified true
  at every BEGIN site, so a defense-in-depth margin, its own characterized phase); **PERF-5 Part B** list
  windowing — **documents-list half now CLOSED** (follow-up Phase 4 / PERF-2; see §36); the **chat
  transcript** half remains (Diagnostics activity is a lower-volume secondary target) + the
  **E5-prefix migration**.

**Posture held across all eight phases (load-bearing):** offline / no telemetry / no new network egress; no
schema change beyond the single additive nullable `invoices.extractor_version` (P3) + the internal
`ModelDownloadTask.role` field (P4); content class (document/chat text, extracted figures, redacted text)
never logged/audited/exported. Behavior-preserving: every behavioral fix (P1/P2/P3/P4/P6/P8) is
**teeth-checked** (neuter the guard → red → restore byte-identical); P5 was test-only (`git diff src/`
empty); P7 was docs/comments-only. The F12 byte-equivalence + signature backstop + lock-purge, the vision
cancel semantics (F18), and the stop()/suspend() teardown semantics (F19) are all preserved. Final suite
**2532 passed / 39 skipped (2571 collected)**; typecheck + `npm run build` green.


### §35 Full audit (2026-06-29, follow-up) — Phase 3 (main-thread import I/O + parser memory caps; PERF-1 / PERF-4)

The follow-up audit (`audits/full-audit-2026-06-29-followup.md`) found the gaps had moved *outward* from the
fortified core into main-thread I/O. **Phase 3** removes the synchronous import freeze (PERF-1) and turns an
oversize-text OOM crash into the existing friendly reject (PERF-4). Both are behavior-class fixes with **no
schema / IPC / audit-payload change**; the encrypted-at-rest guarantee and the exact on-disk vault frame are
preserved byte-for-byte. Suite **2559 passed / 39 skipped** (was 2551/39 → **+8**: PERF-4 ×4 + PERF-1
async-crypto ×4); typecheck + `npm run build` green.

- **PERF-1 (High) — async document-cache crypto on the import path.** The document-import / re-index /
  preview / OCR-read path encrypted/decrypted the stored copy through a fully **synchronous** `readSync` /
  `writeSync` + `cipher.update` chunk loop on the Electron **main thread** — multi-second on a large scanned
  PDF over USB, paid **twice** in an encrypted workspace (encrypt-on-store + decrypt-to-parse), freezing the
  UI/IPC and starving the embedder sidecar. FIX: added **async siblings** `encryptFileAsync` /
  `decryptFileAsync` in `workspace-vault.ts` — the SAME streaming AES-256-GCM loop on `fs.promises`
  FileHandles, awaiting each 8 MiB chunk read/write so the event loop runs between chunks (GCM `update` on a
  chunk is sub-ms — per-chunk yielding suffices, no worker thread). They write/read the **byte-identical**
  frame (`MAGIC | iv | tag-placeholder | ciphertext`, the GCM tag positionally patched into its reserved
  slot at `tagPos` after `final()`), cross-verified so a file written by either flavour decrypts with the
  other (and the in-memory blob path). The `DocumentCipher` gained `encryptFileAsync`/`decryptFileAsync`; the
  three already-async import callers (`ingestion processDocument` ×3, `extractDocumentPreview`,
  `doctasks readStoredPdfBytes`) now `await` them, and the plaintext copy went `copyFileSync` →
  `await fs.promises.copyFile`.
  - **DIVERGENCE from the audit's "convert the vault loop" wording (deliberate, mechanically-correct).**
    Rather than make the shared `encryptFile`/`decryptFile` async *in place* — which cascades into the
    **DB-`.enc` lock/unlock/create/rekey lifecycle**, the **synchronous crash-only lock** (the
    `uncaughtException` handler must re-encrypt the working DB **before** `process.exit`; an async lock can't
    finish first → committed in-session data would be lost), and the **synchronous vision streaming emitter**
    (`createImageSession` is reached through a non-awaitable `emit.done`) — i.e. the highest-stakes,
    most-tested code, with the real vault-corruption blast radius the audit itself flagged in its CRITICAL
    RISK note — we **added** async siblings used only by the actual per-import harm. The **session-boundary
    DB lifecycle** (unlock decrypts the whole DB once per session; lock once on lock/quit — NOT "every
    import") and the **bounded, sync-reached paths** (image-history via the vision emitter; text export) stay
    on the synchronous functions. Net effect: the PERF-1 "freeze on **every import**" is gone; the
    once-per-session unlock/lock decrypt freeze is an available follow-up (adopt the async siblings there once
    the crash-lock keeps a synchronous path — `encryptFile` is retained for exactly that).
- **PERF-4 (Medium) — string-safe byte cap for the read-whole-file-to-string formats.** The text / Markdown /
  CSV parsers materialize the file as one UTF-16 JS string (CSV then derives the papaparse row array + the
  rebuilt `lines.join` ≈ 3 full copies at once), so a file approaching the generous 1 GiB `maxBytes` exceeds
  V8's ~512 MB string/heap ceiling and **OOM-crashes** the main process instead of producing the friendly
  `fileTooLarge` reject. FIX: a new `textMaxBytes` ceiling (default **64 MiB**, env `HILBERTRAUM_TEXT_MAX_BYTES`)
  + a `readsWholeFileToString` flag on the txt/markdown/csv parsers; `effectiveMaxBytes(title, limits)` narrows
  the **existing** pre-parse byte checks in `processDocument` to that ceiling for those formats only — so an
  oversize text/CSV file hits the unchanged friendly reject, while the streaming / page-bounded formats
  (PDF/DOCX/audio/image) keep the full `maxBytes`. Streaming parse remains the better long-term fix; the cap
  is the safe win (recorded in known-limitations).

| Finding | Sev | Disposition (one line) | Record / files |
|---|---|---|---|
| **PERF-1** | High | **fixed** — async `encryptFileAsync`/`decryptFileAsync` (FileHandle, per-chunk yield, byte-identical frame) on the document-import path; `copyFileSync` → async `copyFile`. DIVERGED: added async siblings instead of converting the shared sync functions (DB lifecycle + crash-lock + vision emitter stay sync). Teeth: a non-yielding neuter reddens the event-loop-yield test while the frame-identity tests stay green | this §35; `workspace-vault.ts`, `ingestion/index.ts`, `doctasks/manager.ts`; known-limitations |
| **PERF-4** | Med | **fixed** — `textMaxBytes` (64 MiB) + `readsWholeFileToString` flag + `effectiveMaxBytes` narrows the pre-parse byte cap for txt/markdown/csv → friendly `fileTooLarge` reject, not an OOM crash. Format-scoped (PDF keeps full `maxBytes`). Teeth: neuter the narrowing → the over-cap .txt/.csv tests redden | this §35; `ingestion/limits.ts`, `parsers/{index,txt,markdown,csv}.ts`, `ingestion/index.ts`; known-limitations |

**Posture (load-bearing):** offline / no telemetry / no new network egress; encrypted-at-rest + the exact
on-disk vault frame preserved (cross-read tests pin sync↔async equivalence + GCM auth on tamper); content
class never logged. Behavior-preserving: both fixes are **teeth-checked** (neuter → red → restore
byte-identical). Branch `audit-followup-phase3-import-io` (unmerged; do NOT auto-merge/push).


### §36 Full audit (2026-06-29, follow-up) — Phase 4 (documents-list scale; PERF-3 / PERF-2; PERF-6 deferred)

**Phase 4** removes the two ways the documents screen got slower with library size: a hot-path DB parse
(PERF-3) and unbounded list DOM (PERF-2 = the long-deferred PERF-5 Part B). One additive nullable column;
no IPC / audit-payload change; an old on-disk workspace opens cleanly. Suite **2568 passed / 39 skipped**
(was 2559/39 → **+9**: PERF-3 ×7 + PERF-2 ×2); typecheck + `npm run build` green (the new renderer dep
bundles offline — no runtime fetch).

> **Note (location, as of DX-3 — follow-up Phase 8, §38):** the behavior claims below are current, but
> `DocumentsScreen.tsx` was subsequently split into `screens/documents/*` (`DocRow`, `SectionRail`,
> `PreviewModal`, `format.tsx`, `types.ts`) — a behavior-preserving relocation; the windowing + the
> `__docRowRenderCounts` seam described here are intact (the `DocRow` `React.memo` lives in
> `screens/documents/DocRow.tsx` now).

- **PERF-3 (Medium) — `listDocuments` no longer parses the full `ocr_json` blob per OCR'd row.** DB-8 (§
  Performance Wave P5) projected columns on the single-doc getters, but the **list** path still did
  `SELECT *` and fully `JSON.parse`d every row's `ocr_json` — reconstructing `pages[]` **with every page's
  text** — only to read `pageCount`/`languages`/`engineId`/`createdAt` for the OCR badge. At a library of
  large scans that is a megabytes-scale parse + a ~10⁵-object array allocation on the **main thread**, on
  *every* documents-screen mount / import-completion / collection change. FIX: a cheap, additive, nullable
  **`documents.ocr_meta_json`** sidecar holding ONLY the badge metadata (a serialized `DocumentOcrInfo` —
  counts/ids/languages, **never page text**). Written alongside `ocr_json` at OCR-write time
  (`setDocumentOcr`, lock-step; clearing nulls both), and **backfilled once** at `openDatabase` for rows
  imported before the column existed (reads each blob ONCE, extracts meta, writes the sidecar; FK/lifecycle-
  safe; `updated_at` untouched; subsequent opens select zero rows). `listDocuments` now SELECTs an explicit
  **narrow column set that omits `ocr_json`** and reads the badge via `ocrInfoForRow` from the sidecar (with
  a one-shot `parseOcr(ocr_json)` fallback the list path never reaches — its projection omits the blob AND
  the backfill runs first). The meta extractor (`ingestion/ocr-meta.ts` — `ocrMetaFromJson` / `parseOcrMeta`)
  is a **leaf module** (type-only import) so `db.ts` uses it for the backfill without a `db → ingestion`
  cycle, and the page-count semantics (count only well-formed pages) match `parseOcr` exactly. **Measured**
  (50 docs × 2000 pages × 500 chars, ~50 MB OCR text): the per-call `ocr_json` read+parse the projection
  removes costs **~147 ms in isolation**; the projected `listDocuments` runs in **~55 ms** — and the
  megabytes-scale string + ~10⁵-object allocation per call is eliminated.
- **PERF-2 (High at scale; = PERF-5 Part B, documents-list half) — the documents list is windowed.** Every
  document mapped to a live, memoized-but-never-unmounted `DocRow`, each mounting a Radix
  `DropdownMenu.Root` — so the DOM and the count of menu-root state machines grew **linearly** with the
  library (hundreds of mounted roots at scale, on CPU-only hardware). FIX: `@tanstack/react-virtual` (a
  pure-JS, no-native, build-time dep — Vite bundles it; **no runtime network call**). The documents screen
  scrolls **as a whole** inside the app's `.content` container, so the list virtualizes **against that
  existing scroll element** with a `scrollMargin` for the header/hints above it — *additive*, the
  full-screen scroll behavior is unchanged (no inner-pane restructure that would alter scroll position /
  scroll-to). Variable row height (a failed-import error banner, a stale-embeddings notice, a wrapping chip
  cluster — `.doc-row` is `min-height: 56px`, not fixed) is handled by per-row `measureElement` over a 57px
  estimate + overscan, so a taller row self-corrects. The `DocRow` `React.memo` + the `__docRowRenderCounts`
  seam are untouched; a shared `renderRow` keeps the windowed and fallback paths' props wiring in one place.
  - **GATING (truthful, not a test sniff).** Windowing engages only once a real, laid-out viewport is
    resolved (`scrollEl != null && clientHeight > 0`). With no `.content` ancestor or a 0px viewport — a
    unit test rendering the screen standalone under jsdom, or first paint before layout — there is nothing
    to virtualize, so it falls back to rendering **every** row, byte-identical to the pre-PERF-2 list. A 0px
    viewport genuinely can't be windowed; the guard is honest, and it keeps the existing DocumentsScreen
    test corpus on the un-windowed path while a dedicated test drives the **real** windowed path (mocking
    `offsetHeight` — which react-virtual measures, not `getBoundingClientRect`).
  - **KNOWN TRADEOFF (recorded in known-limitations.md):** the browser's find-in-page (Ctrl+F) can't match a
    row that isn't currently mounted. Acceptable for a name-scannable library list (the in-app section/smart-
    view filters search the full set); deliberately **not** applied to the chat transcript.
- **PERF-6 (Low) — DEFERRED with cause.** Moving OCR pages from the one `ocr_json` blob to a per-page child
  table is the clean root-cause fix for PERF-3, but it is a larger schema migration (backfill existing blobs
  into child rows, FK/CASCADE lifecycle, the re-index-reuse + doctasks write paths). PERF-3's metadata
  sidecar **already removed the hot-path parse** (the actual harm), so the child table is left as its own
  future phase rather than forced into this one.

| Finding | Sev | Disposition (one line) | Record / files |
|---|---|---|---|
| **PERF-3** | Med | **fixed** — additive nullable `ocr_meta_json` sidecar (counts/ids only, never text) written at OCR-write + backfilled once at open; `listDocuments` projects a narrow set that omits `ocr_json` and reads the badge from the sidecar. Measured ~147 ms blob-parse removed per call. Teeth: revert the projection to `SELECT *` → the SQL-omission test reddens | this §36; `db.ts`, `ingestion/index.ts`, `ingestion/ocr-meta.ts`; `tests/integration/ocr-meta-list.test.ts` |
| **PERF-2** | High@scale | **fixed (documents list)** — `@tanstack/react-virtual` windows the list against the `.content` scroll element (scrollMargin + per-row measureElement); gated on a resolved non-zero viewport (else render all). Teeth: force `windowed = false` → the bounded-count test reddens. Chat transcript half stays deferred | this §36; `DocumentsScreen.tsx`, `package.json`; `tests/renderer/DocumentsScreen.test.tsx` |
| **PERF-6** | Low | **deferred (cause)** — per-page OCR child table is a larger schema migration; PERF-3 already removed the hot-path parse it would have addressed | this §36 (own future phase) |

**Posture (load-bearing):** offline / no telemetry / no new RUNTIME network egress (the virt lib is a
build-time dep, bundled, verified no `.node` binary); the schema change is additive + nullable and opens old
workspaces cleanly (backfill on first open); content class (OCR page text) is never materialized on the list
path nor placed in the sidecar/logs/export. Branch `audit-followup-phase4-docs-scale` (unmerged; do NOT
auto-merge/push).


### §37 Full audit (2026-06-29, follow-up) — Phase 6 (reliability hardening; REL-1 / REL-2 / REL-3 / REL-4)

**Phase 6** closes four **latent** concurrency/teardown gaps in the sidecar lifecycle. None is a live bug
today — each mirrors a race class already fixed elsewhere (the F19 `tearingDown` family; the lock-path
stream-abort ordering) — so this is **defense-in-depth, proven by teeth-checks** (neuter the guard → the
deterministic interleave test resurrects the race and reddens → restore byte-identical). No IPC / schema /
audit-payload change; behavior-preserving (the robust paths the audit confirmed CLEAN — single-flight start,
bind-race retry, SIGTERM→SIGKILL escalation, the `VisionRuntime` idle interlock, the e5/reranker F19 latch,
`combineSignals` cleanup, partial-on-abort persistence — all stay green). Content class is never logged (a
cancellation diagnostic carries ids + the error message only). Suite **2586 passed / 39 skipped** (was
2579/39 → **+7**: vision-teardown ×2, OCR REL-1 ×1, e5 REL-3 ×1, shutdown REL-4 ×3); typecheck + `npm run
build` green. Branch `audit-followup-phase6-reliability` (unmerged; do NOT auto-merge/push).

- **REL-2 (Low, strongest) — `VisionService.stop()` defeated by a `run()` that rebuilds the runtime during
  teardown.** `run()` does `this.runtime ??= createRuntime(status)` after `await getStatus()`. `VisionService`
  (unlike the embedder/reranker, F19) had **no orchestrator-level latch**, and the per-`VisionRuntime`
  `stopped` flag doesn't help (a rebuilt runtime starts without it). FIX: a `tearingDown` latch on the
  **service** (not the runtime), set at the TOP of `stop()` and cleared in its `finally`; `run()` re-checks it
  **at the top AND immediately after the `getStatus()` await** — a losing `run()` ends `cancelled`, spawns
  nothing. **DIVERGENCE / sharpened repro (recorded):** the audit's "parked in `getStatus()`" variant is
  ALREADY neutralized today by the existing `if (signal.aborted)` check between the await and `createRuntime`
  (`stop()` aborts every vision controller synchronously before yielding). The genuinely-uncovered window the
  latch closes is a **NEW `analyze()` that lands DURING an in-progress teardown** — its controller is fresh
  (stop()'s abort loop ran before the job existed), so `signal.aborted` misses it and, without the latch, it
  would `createRuntime` a fresh ~4.6 GB vision sidecar co-resident with the vault re-encrypt. The
  top-of-`run()` latch is **solely** load-bearing there (single-neuter teeth-check: `createCalls` goes 1→2).
  The post-`getStatus()` re-check is the defense-in-depth twin (co-guarded by `signal.aborted`, like F18 — a
  dual-neuter), kept to mirror e5/reranker's post-`await this.starting` re-check and harden against a refactor
  weakening abort-propagation.
- **REL-1 (Low) — OCR worker init latch nulled from under a concurrent `ensureWorker()`.** `stop()` (lock/quit)
  calls `terminateWorker()` **out of band** — NOT through `this.chain` — so it can race an `ensureWorker()`
  init started inside a chained `recognize()`. The old `terminateWorker` nulled `this.starting`
  unconditionally and never awaited a **pending** init, so the worker that init later produced **outlived the
  teardown** (a leaked WASM worker holding decoded page bytes). FIX (the e5/reranker teardown mirror): capture
  `this.starting`, **await it** if in flight (so the worker it spawns is the one we then terminate), and clear
  the latch only if it is **still** that same promise (a fresh init started during the await is left to run).
  **DIVERGENCE (recorded):** the audit's literal "only null when it equals the promise being torn down
  (capture + compare)" is, without the await, a **no-op** for the reachable harm — nothing can replace
  `this.starting` between a synchronous capture and null, and the pending init is still orphaned. Awaiting the
  init is the mechanically-correct fix; the equals-compare-before-null is kept on top of it (guards a second
  out-of-band terminate that replaces the latch during the await). The audit's "spawns a SECOND worker"
  variant requires an out-of-band terminate that ISN'T `stop()` (none exists today — `recognize()` is
  `stopped`-gated and the timeout/abort terminate runs **inside** the chain), so the concrete reachable harm
  is the init-outlives-`stop()` leak, which the await closes (teeth: drop the await → the late-born worker is
  never terminated).
- **REL-3 (Low) — `e5.embed()` didn't re-check teardown between batches.** `embed()` captures `server` once,
  then loops batches; a `suspend()`/`stop()` mid-loop nulls the sidecar, so the NEXT `server.fetch` threw the
  runtime's `"llama-server is not started"` — a confusing per-document error rather than a clean cancel
  (functionally safe — no orphan). FIX: at the top of each batch iteration, throw the SAME recognizable
  cancellation `ensureStarted` raises (`"Embedder is stopped …"` / `"… is suspending …"`). **DIVERGENCE
  (recorded):** the audit said re-check `this.stopped`/`this.tearingDown`; the load-bearing condition is
  `this.server !== server` (a captured-server **staleness** check). `tearingDown` clears in teardown's
  `finally`, so a `suspend()` that COMPLETED between two batches has it back to `false` — only the staleness
  signal (teardown nulled/replaced `this.server`) catches that interleaving, which is the common one. `stopped`
  is checked first for the quit path (teeth: drop the re-check → the next batch fetches the dead captured
  server and reddens with `"not started"`).
- **REL-4 (Low) — quit `shutdown()` didn't abort in-flight streams before `runtime.stop()`.** The
  workspace-LOCK path aborts in-flight chat/RAG streams first (so each partial reply unwinds as an ABORT and
  `generateAssistantMessage` persists it while `ctx.db` is open), but the quit path killed the sidecar
  directly — a non-abort stream error that **lost** the partial. **DECISION: option (a)** — abort
  `inFlightStreams` before the sidecar stops, mirroring the lock ordering (more consistent than documenting
  the divergence; the partial persists during the awaited `runtime.stop()` window, the same settle guarantee
  the lock path already relies on — neither path awaits the stream itself). The quit teardown was **extracted**
  from `main/index.ts` into `main/shutdown.ts` (`performShutdown(ctx, deps)`) so its ORDERING is unit-testable
  with a fake ctx (the real `main/index.ts` registers app handlers at import time). Teeth: drop the abort loop
  → the stream is never aborted and the ordering test reddens.

| Finding | Sev | Disposition (one line) | Record / files |
|---|---|---|---|
| **REL-2** | Low | **fixed** — service-level `tearingDown` latch (the F19 analogue VisionService lacked); `run()` re-checks at top + after `getStatus()`; a new analyze during teardown can't rebuild the ~4.6 GB sidecar. Teeth: neuter both checks → `createCalls` 1→2 | this §37; GPU §5.5c (F19 family); `vision/index.ts`; `tests/integration/vision-teardown.test.ts` |
| **REL-1** | Low | **fixed** — `terminateWorker` awaits the in-flight init (e5/reranker mirror) so its worker can't outlive teardown, and clears the latch only if unchanged. Teeth: drop the await → late-born worker never terminated | this §37; `ocr/tesseract.ts`; `tests/unit/ocr.test.ts` |
| **REL-3** | Low | **fixed** — per-batch teardown re-check throws the recognizable cancellation (`this.server !== server` staleness + `stopped`/`tearingDown`) instead of a confusing "not started". Teeth: drop it → next batch fetches the dead server | this §37; GPU §5.5b/c; `embeddings/e5.ts`; `tests/integration/e5-embedder.test.ts` |
| **REL-4** | Low | **fixed (option a)** — `performShutdown` (extracted to `main/shutdown.ts`) aborts in-flight streams BEFORE `runtime.stop()`, mirroring the lock path so a partial reply persists at quit. Teeth: drop the abort loop → ordering test reddens | this §37; the LOCK-path record (`registerWorkspaceIpc.lockWorkspace`); `main/shutdown.ts`, `main/index.ts`; `tests/unit/shutdown.test.ts` |

**REL-5 (carried, open):** unchanged — still keep-deferred (architecturally non-reachable while the single
synchronous `DatabaseSync` connection holds; §26 note). Not in Phase 6's scope (the §26 wording strengthening
is Phase 8).


### §38 Full audit (2026-06-29, follow-up) — Phase 8 (maintainability + security hardening) & ROUND CLOSE-OUT

The **2026-06-29 follow-up full audit** (report `audits/full-audit-2026-06-29-followup.md`) is **COMPLETE**
— all eight phases landed. The round's pattern was *"the gaps moved outward"*: away from the
heavily-fortified core primitives (crypto, money parser, sidecar lifecycle, RAG core — all independently
re-confirmed clean) and into document/statement-level orchestration, the Electron-version platform boundary,
and main-thread I/O / DOM scaling. **No Critical, no remote exploit** (offline by construction); 3 High
(FIN-1 wrong-currency / FE-A dead drag-drop / PERF-1 import freeze) + PERF-2-at-scale, ~10 Medium, the rest
Low/Info. Each phase folded its decisions into the topic docs as it landed (the per-phase records **§35**
[Phase 3], **§36** [Phase 4], **§37** [Phase 6], the **Phase-7 subsection** of the Test-enforcement record,
**§8** [Phase 1], **rag-design §14.4** [Phase 5], the **"Drag-drop intake" Renderer-robustness record**
[Phase 2]); **this section is the durable master index** — resolve a `full-audit-2026-06-29-followup <ID>`
code comment through it. Per the CLAUDE.md doc-lifecycle rule the working-paper report was **retired** once
every finding was dispositioned (committed folded-in first, so the original stays **recoverable in git
history** — the parent of the Phase-8 close-out commit), mirroring the §24/§25/§26/§34 precedent. Phases ran
on stacked, unmerged branches (`audit-followup-phase1-financial` … `phase8-closeout`); owner merges when
ready.

**Per-phase one-liners:** **P1** financial correctness (FIN-1..4; release-blocking class; §8). **P2**
Electron-37 drag-drop regression (FE-A `webUtils.getPathForFile` preload bridge + FE-C empty-drop feedback;
Renderer-robustness record). **P3** main-thread import I/O + parser caps (PERF-1 async vault crypto / PERF-4
text-CSV byte cap; §35). **P4** documents-list scale (PERF-3 `ocr_meta_json` sidecar / PERF-2 list windowing
/ PERF-6 deferred; §36). **P5** RAG provenance honesty + Sources a11y (FE-B / F11 renderer half + FE-D;
rag-design §14.4, design-guidelines §11.8). **P6** reliability hardening (REL-1..4 latent teardown races;
§37). **P7** test-suite robustness (TEST-1/TEST-3/DX-2/DX-4/DX-5/DX-6; Phase-7 subsection, test-only). **P8**
(this close-out) maintainability (DX-1/DX-3) + security hardening (SEC-4) + FE-E + REL-5 wording + report
retirement.

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **FIN-1** (High) | 1 | **fixed** — document/statement currency by figure-adjacent majority vote (`detectDocumentCurrency`), so a `USD`/`CHF` in a memo no longer stamps a EUR statement's verified total | §8; `money.ts`; known-limitations |
| FIN-2 (Med) | 1 | **fixed** — invoice right-side "uncaptured column" drop requires the whole trailing region to be ONE money-shaped-but-rejected token (no over-fire on `(Pos. 3)` / `19% MwSt` / `2 Stk`) | §8; `invoice.ts` |
| FIN-3 (Med) | 1 | **fixed** — `DATE_TOKEN_RE` tightened so `2.500` is un-date-able; `MONEY_TOKEN_RE` deliberately NOT widened (DIVERGED — widening would regress the M3 split-amount safety) | §8; `pdf-layout.ts` |
| FIN-4 (Med) | 1 | **fixed** — `inferDateOrder` vote scoped by line KIND (money line → leading date column only; money-less header → any) so a memo's foreign-format date can't flip the doc | §8; `money.ts` |
| **FE-A** (High) | 2 | **fixed** — preload `window.api.getDroppedFilePath` wraps `webUtils.getPathForFile` (Electron-37 removed `File.path`); `pathsFromDrop` calls it; real-Electron 37.10.3 leg verified | Renderer-robustness "Drag-drop intake"; `preload/index.ts`, `ChatScreen.tsx` |
| FE-C (Med) | 2 | **fixed** — `onDrop` shows `chat.attach.dropUnsupported` when a Files-bearing drop yields zero importable paths | Renderer-robustness "Drag-drop intake" |
| **FE-B** (Med-High) | 5 | **fixed (closes the carried F11 renderer half)** — `SourcesDisclosure` takes `coverage.mode`; any whole-document mode renders as **provenance** ("Drawn from the document — N sections", no `[Sn]`, capped at 24 + reveal); relevance/NULL-coverage byte-identical | rag-design §14.4 (AS BUILT) |
| FE-D (Low, a11y) | 5 | **fixed** — `aria-controls`/`role="region"`/`aria-labelledby` on the Sources, Thinking, and SummaryMarker disclosures | design-guidelines §11.8 |
| **FE-E** (Low) | **8** | **fixed** — a THROWN first-run model-listing/verify failure routes to the **Models** screen (not silently to Chat's generic "no model" empty state); an empty list still routes to the `starter` step; never traps the user | this §38; `WorkspaceGate.tsx`; `WorkspaceGate.test.tsx` |
| **PERF-1** (High) | 3 | **fixed** — async `encryptFileAsync`/`decryptFileAsync` (per-chunk yield, byte-identical frame) on the import path; `copyFileSync`→async (DIVERGED — async siblings, the sync crash-lock/DB-lifecycle/vision-emitter stay sync) | §35; `workspace-vault.ts` |
| **PERF-2** (High@scale) | 4 | **fixed (documents list)** — `@tanstack/react-virtual` windows the list (viewport-gated; else render all). **Chat-transcript half carried forward** (behavior-sensitive) | §36; known-limitations (find-in-page) |
| PERF-3 (Med) | 4 | **fixed** — additive nullable `ocr_meta_json` sidecar (counts/ids only) written at OCR-write + backfilled once; `listDocuments` omits `ocr_json` (~147 ms/call removed) | §36 |
| PERF-4 (Med) | 3 | **fixed** — `textMaxBytes` (64 MiB) + `readsWholeFileToString` flag → friendly `fileTooLarge` reject instead of a V8 string-limit OOM for txt/markdown/csv | §35; known-limitations |
| PERF-5 (Low) | — | **accepted / carried → CLOSED by full-audit 2026-07-10 PF-7c** — `ImagesScreen` `AnswerThread` memo defeated by unstable `onCopy`/`onTryAgain`/`onStop` props; closed by the `useEventCallback` sweep + the visionSession 40 ms token batch (perf design record) | this ledger (carried); perf record PF-4/PF-7 |
| PERF-6 (Low) | 4 | **deferred with cause** — per-page OCR child table is a larger schema migration; PERF-3's sidecar already removed the hot-path parse (the actual harm) | §36 |
| **SEC-4** (Low/Info) | **8** | **fixed** — (this SEC-4 is the 2026-06-29 follow-up's; distinct from backend-audit-2026-06-27's SEC-4 = session-cached binary verification, §24 / `security-model.md`) `runtime-sources.ts` rejects `..`/absolute/drive-letter `extract_to` at PARSE time (new `isUnsafeDrivePath`, applied to the sibling OCR `dest` too for consistency); defense-in-depth ahead of the load-bearing `resolveWithinRoot` | this §38; `shared/runtime-sources.ts`; `runtime-sources.test.ts` |
| SEC-1c (Low) | — | **accepted residual / open** — unlock-path rate-limit/attempt-counter + create-time strength floor; the at-rest Argon2id KDF is the binding mitigation against the offline (drive-in-hand) attacker, so a UI rate-limit doesn't bind the real threat | §26 |
| SEC-2 (Low) | — | **accepted residual / open** — stage `previewSkillPackage` content under `userSkillsDir` (trust-zone consistency); today path-/size-validated + finally-cleaned in the shared tmpdir, not an escape | §26 |
| SEC-3 (Info) | — | **accepted residual / open** — dialog-opener IPCs mint a capability token pre-unlock but every consuming handler is `requireUnlocked()`-gated → inert; a consistency gap, not an exploit | §26 |
| **REL-1** (Low) | 6 | **fixed** — OCR `terminateWorker` awaits the in-flight init so it can't outlive teardown | §37 |
| **REL-2** (Low) | 6 | **fixed** — `VisionService` `tearingDown` latch (the F19 analogue) bars a NEW `analyze()` from rebuilding the ~4.6 GB sidecar mid-teardown | §37; GPU §5.5c |
| **REL-3** (Low) | 6 | **fixed** — `e5.embed()` per-batch teardown re-check (captured-server staleness) throws the recognizable cancel, not "not started" | §37; GPU §5.5b/c |
| **REL-4** (Low) | 6 | **fixed (option a)** — `performShutdown` (extracted to `main/shutdown.ts`) aborts in-flight streams BEFORE `runtime.stop()`, mirroring the lock path | §37 |
| REL-5 (Low) | — | **non-reachable / deferred** — verified architecturally non-reachable while the single-`DatabaseSync` architecture holds; **promote to a real fix only if a second DB connection (e.g. a worker-thread reader) is introduced** (precondition made explicit) | §26 (strengthened, P8); §37 |
| **TEST-1** (Med) | 7 | **closed (de-flake)** — the flaky real-timer vision idle block deleted; its two uncovered cases ported to the deterministic injected-clock twin | Phase-7 subsection |
| **TEST-3** (Med) | 7 | **closed (test)** — `rag-pipeline-floor.test.ts`: model-free synthetic floor through the REAL chunk→embed→FTS→RRF→top-k→citation pipeline; teeth-checked ×2 | Phase-7 subsection |
| **DX-1** (Med) | **8** | **fixed (refactor)** — `DocTaskManager` god-class split: each `run<Kind>` extracted to a `doctasks/handlers/*` module keyed by `MODEL_TASK_HANDLERS`; the manager keeps only queue/pump/arbiter + the `generate`/`generateWithRetry` retry loop, handed to handlers via a narrow `DocTaskCtx`. STRICTLY behavior-preserving (1758→~580 lines; full doctasks suite identical green) | this §38; `doctasks/manager.ts`, `doctasks/context.ts`, `doctasks/handlers/{index,shared,tree,summary,ocr,translation,compare,categorize}.ts` |
| DX-2 (Low) | 7 | **fixed** — prod render-counter `import.meta.env.DEV`-guarded (no-ops in a production build; memo test green under DEV) | Phase-7 subsection; `DocumentsScreen.tsx` |
| **DX-3** (Low) | **8** | **fixed (refactor)** — `DocumentsScreen` split: `DocRow`/`SectionRail`/`PreviewModal` to sibling `screens/documents/*` files + pure formatters to `documents/format.tsx` + shared types/keys to `documents/types.ts`. STRICTLY behavior-preserving (2190→1164 lines; Phase-4 virtualization + Phase-7 DEV render-counter intact; all Documents suites green) | this §38; `screens/documents/{format.tsx,types.ts,DocRow.tsx,SectionRail.tsx,PreviewModal.tsx}` |
| DX-4 (Low-Med) | 7 | **closed (test)** — `ipc-lock-coverage` meta-assertion globs every `register*Ipc` export; a new uncovered module reds it | Phase-7 subsection |
| DX-5 (Low) | 7 | **closed (test)** — `runtime-ladder-exit-wiring.test.ts`: a real `LlamaServer` child's `'exit'` drives the §5.3 crash auto-fallback end-to-end; teeth-checked | Phase-7 subsection |
| DX-6 (Low) | 7 | **closed (de-flake)** — three settle-window sleeps → deterministic waits (await the F19-guarded refusal; poll the scripted in-flight count) | Phase-7 subsection |

**Carried-forward open items (deliberately NOT taken; on record for the next pass):**

- **SEC-1c / SEC-2 / SEC-3** — three security **consistency** improvements, none an exploit (re-affirmed
  accepted residuals with their §26 rationale; the at-rest KDF binds the offline attacker, the skill-preview
  staging is validated+cleaned, the dialog-opener tokens are inert until the consuming `requireUnlocked()`).
- **REL-5** — **non-reachable while the single-`DatabaseSync` architecture holds**; becomes a real fix to
  build **only if** a second DB connection (worker-thread reader / connection pool) is introduced. Precondition
  now explicit in §26 so a future worker-pool change can't silently re-open the gap.
- **PERF-5 (ImagesScreen `AnswerThread` memo)** — **CLOSED (full-audit 2026-07-10 PF-7c):** the Images
  screen was next touched exactly as planned — `onCopy`/`onTryAgain`/`onStop` wrapped in
  `useEventCallback`, plus the visionSession per-token notify batched through a 40 ms flush (see the
  Performance design record, PF-4/PF-7 entry).
- **PERF-2 chat-transcript half** — list windowing for the chat transcript stays deferred (variable height +
  scroll-to-bottom + find-in-page + StreamAnnouncer are genuinely behavior-sensitive); the **documents-list
  half is CLOSED** (P4). Still the tracked top renderer item.
- **§26/§34-carried (still open, unchanged):** the **E5 `query:`/`passage:` prefix migration** (its own phase;
  re-embeds the whole corpus) and the coupled **F13 floor-before-cut** precondition (re-enabling a positive
  `ragMinSimilarity` floor must over-fetch then floor) — both inert at the pinned default 0.

**Posture held across all eight phases (load-bearing):** offline / no telemetry / no new network egress; the
only schema change was the single additive nullable `documents.ocr_meta_json` (P4, backfilled on open); no
IPC / audit-payload change in any phase; the **content class** (document/chat text, titles/filenames,
extracted figures, redacted text) is never logged / audited / exported. Behavior-preserving: every behavioral
fix (P1/P2/P3/P4/P5/P6) is **teeth-checked** (neuter the guard → red → restore byte-identical); P7 was
test-only (`git diff src/` a single DEV-guard line); **P8's two refactors (DX-1/DX-3) are STRICTLY
relocation** — the full doctasks suite (154 tests) and the Documents renderer suites (95 tests) are identical
green before and after, and the whole suite is unchanged at **2593 passed / 39 skipped** (+4 vs Phase 7's
2589, all from SEC-4). The SEC-4 validator, the FE-E route, and the REL-5 wording are the only P8 behavior/
doc deltas; `npm run typecheck` + `npm run build` green.


### §39 Skills & Tools audit (2026-07-02) — remediation wave close-out

A four-axis audit (triggering, coverage, determinism-vs-LLM, architecture) swept the whole Skills &
Tools surface and filed **56 findings** — but read them as symptoms of **three design decisions**
(audit §8), not 56 independent bugs. A **20-phase plan** across five tracks (**R** correctness / **W**
complaint-drivers / **U** reach-&-trust / **A** architecture pay-down / **T** eval-infra) landed all of
them on a cumulative branch chain tipped by `fix/skills-t1`. Both working papers —
`docs/skills-remediation-plan.md` (the plan + its §0.2 phase tracker, whose per-phase `[x]` outcome
notes are the condensed as-built decisions) and `docs/skills-audit-2026-07-02.md` (the report) — were
**deleted** under the CLAUDE.md doc-lifecycle rule once fully implemented; the full originals stay
recoverable in git history (present through the Part-A reconcile commit `4c1cd64` and on `fix/skills-t1`;
removed in this close-out). This record is the durable index — read a code comment's `audit §N.M` or
phase-id (`R2`/`W4`/`U1`/`A3`/`T1`) citation through the **§-anchor legend** below. Direct successor to
§23 (the 2026-06-26 audit); the residuals live in [`known-limitations.md`](known-limitations.md).

**The three root-cause decisions (the spine — audit §8):**

1. **Third mode — LLM over extracted, verified data (§8.1 → W3/W4).** Before, a question over a
   tool-skill doc either hit a fixed template (no model) or raw chunks (no structure). The new
   `{mode:'grounded-data', dataBlock, postscript}` outcome streams a model answer over
   `buildGroundedDataPrompt(question, dataBlock)` under FIXED rules — answer only from the data,
   **quote figures verbatim, NO arithmetic**, say when the data lacks the fact, user's language (its own
   `GROUNDED_DATA_SYSTEM_PROMPT`, history replayed so follow-ups don't re-trigger the template). The
   figures stay deterministic (`buildInvoiceJson` / `buildStatementJson` + reconciliation + provenance,
   capped ~150 rows) with a deterministic totals / cashflow **postscript** (verbatim) + the R5 date
   caveat riding under it — **the LLM never computes or moves a figure**, it narrates a parsed, validated
   extract. Invoice (W3) then bank (W4) route by ANSWER SHAPE: `detectFormat`→serializer; a narrow
   word-anchored summary/reconcile stem list (+`warum`/`why` guard)→template; everything else→
   grounded-data. The high-stakes summary shapes keep the template (the 4B model can misread even
   provided figures).

2. **Invert the whole-doc gate — scope-shaped, not phrasing-shaped (§8.2 → A3/W2).** Before, per-skill
   `routeMatch` decided whole-doc vs top-k on the *phrasing*, so the whole-doc machinery was unreachable
   by default (§2.4). Now an additive manifest `analysis: whole-doc|compare|none` (default none,
   instruction-only, honored for instruction skills of ANY source via `manifestAnalysisHandler`) makes
   the whole-document engine the **default** when a matching skill is explicitly active over a
   fully-chunked scope; keywords only opt *out* (`isSmallTalk`) or distinguish a needle-ask
   (`isNeedleShaped` → top-k ONLY when the whole-doc read would truncate AND no tree exists — W1's exact
   budget calculus is the input; deliverable asks never downgrade). Doc-count mismatch **routes
   deterministically** (W2: a single-doc handler NARROWS to the one manifest-signal match that is also
   fully-chunked with an honest `scopeNarrowed` notice, else `selectOne`; `what-changed` at ≠2 →
   `selectTwo`) instead of silently degrading; a document-plausibility gate falls the bank/invoice
   run through to the ordinary grounded path when the doc matches no declared signal.
   **A4 (2026-07-03 audit, SKA-7-structural/8/12/23 — that wave's record is §41 below) finished the
   inversion for the TOOL skills and refined the composition:** (SKA-7) with a bank/invoice skill active over a single fully-chunked doc that
   is plausibly its class (`classMatches` — manifest signals OR a prior extraction; `singleDocMatchesSkillClass`),
   EVERY non-small-talk question runs the handler even on a `routeMatch` miss (answered from the verified
   extract, not top-k) — a separate chat-path composition, distinct from `intends()`; (SKA-8) `intends()` —
   the W2 count-mismatch routing predicate — was decoupled from `applies()` and made VOCABULARY-shaped for
   the whole-doc/compare handlers too, so a general/off-topic question at multi-doc scope falls through to
   the ordinary engines instead of a "pick one document" dead-end; (SKA-12) the needle downgrade **dropped
   the "AND no tree exists" conjunct** — a needle prefers top-k whenever the whole read would truncate, tree
   or no tree (the tree rescues DELIVERABLES only); (SKA-23) the needle downgrade is evaluated **before** the
   D45 fully-chunked refusal for grounded-whole-doc handlers (a downgraded needle makes no whole-document
   claim, so the refusal's premise doesn't apply). Read-side only; no extractor-version bump; SEC-1 unchanged.

3. **One trigger vocabulary, measured (§8.3 → W5/U4).** Before, two drifted keyword lists per skill
   (manifest triggers vs routing gates) matched by raw substring (§4.1/§3.2). Now
   `services/skills/vocabulary.ts` single-sources each skill's bilingual `{term,lang,match,use}`; `match`
   drives ROUTING (word-boundary via `wordIncludes`), the SUGGESTION scorer word/phrase-infers from the
   manifest string; every routing gate calls `routeMatch(skillId,q)` and the 8 `SKILL.md`
   `triggers.keywords` regenerate from the `suggest|both` terms (bidirectional parity test). Scoring
   gained a keyword-REQUIRED gate (a lone doc signal never fires) + longest-match dedupe. An **82→90-item,
   8-skill eval corpus** gates both thresholds (keyword-required suggestion precision **98.4 %**;
   auto-fire threshold-3 **fired-wrong 0 / precision 100 %**). Only then (U4) did
   bank-statement/invoice/meeting-protocol opt into `triggers.autoFire` (default-OFF) with doc signals
   **narrowed to explicitly-scoped docs** so whole-corpus scope can't vacuously corroborate (§4.4).

**As built, per track (disposition — the full detail is the §0.2 tracker in git history):**

| Phase | Audit §§ | Disposition (one line) | Code home |
|---|---|---|---|
| R1 | §5.3 | `normalizeExtractionText` pre-pass (U+2212 / NBSP) at every money/row entry point + sign-aware bare-integer total | `tools/money.ts`, `tools/{bank-statement,invoice}.ts` |
| R2 | §5.2, §5.4 | structural `labelBoundaryOk` + `isFillerOnly` totals gate (kills the `Steuerberatung`→taxTotal theft); German NET/GROSS labels; header-date consumes only when a date parses | `tools/{invoice,bank-statement}.ts` |
| R3 | §5.6, §5.5 | staleness re-extraction in the shared prepare path (run-bar + JSON/CSV/XML exports re-extract stale rows); `sepa`/`überweisung` → `confident:false` so the LLM categorizer sees the row | `run.ts`, `categorizer.ts`, `tool-runs.ts` |
| R4 | §5.1, §4.6 | one `documentsInScope` deterministic order (compare pair labelled A/B by import date, never old/new); id-projection grep-hygiene pin | `analysis/*`, `registerRagIpc.ts`, `what-changed/SKILL.md` |
| R5 | §5.7 | anchor-gated `parseDate` (2-digit-year + bare `dd.mm.`), cross-year month rollover on plain + geometry; additive `date_order_inferred` → one honest caveat (en+de) | `tools/{bank-statement,invoice}.ts` |
| R6 | §5.7 | per-page/segment bounded continuation-association (wrapped descriptions); identity-gated invoice column-debris cleanup (`taxRatePercent`) firing only when qty×unit ≈ lineTotal | `tools/{bank-statement,invoice}.ts` |
| W1 | §2.2 | in-prompt partial-document notice; 1.5 German-subword whole-doc/compare budget divisor; char-based (KMP) chunk de-overlap; tree ceiling flips `coverage.truncated` | `rag/index.ts`, `rag/whole-doc-tree.ts` |
| W2 | §2.1, §3.4, §4.5 | doc-count-agnostic `intends()`/`fallThrough`; W2 pre-pass narrows-or-routes; zero-row plausibility gate → grounded fallthrough | `registerRagIpc.ts`, `analysis/*`, `selector.ts` |
| W3 | §3.1, §8.1 | the third-mode seam (`grounded-data.ts`) + invoice answer-shape routing + totals postscript + Details block | `analysis/invoice.ts`, `rag/grounded-data.ts` |
| W4 | §3.1, §3.3, §3.6 | bank port (`buildStatementDataBlock` / `buildCashflowPostscript`); honest `transactionsMore` + CSV intros | `analysis/bank-statement.ts` |
| W5 | §4.1, §3.2, §4.2, §8.3 | `vocabulary.ts` single-source + `routeMatch` / `countKeywordHits` + keyword-required gate; 82-item 8-skill corpus | `skills/vocabulary.ts`, `selector.ts` |
| U1 | §2.3, §3.6, ux-10/11 | additive `dropped_row_count`; `countPartial` / `countContradicted` headlines; **D56 `complete` outranks the parse-gap gate**; date-**SHAPE** counter (`LEADING_DATE_SHAPE_RE`) — incl. the reconciled `42a4eb9` | `tools/bank-statement.ts`, `analysis/bank-statement.ts` |
| U2 | §5.7, §3.4, §3.5 | Luhn `[CARD]` + 0-leading phone guard + either-order / 2-digit-year dates; read-only `scanRedactionCandidates` (dry-run + share-safe pre-scan, truncation-gated verdict) | `tools/redaction.ts`, `analysis/redaction.ts` |
| U3 | §4.3, ux-6 | per-turn skill apply (session override) + undo on every stamped turn + `keep-for-conversation`; routed relay pins `askDocuments` to the run's doc | `ChatScreen.tsx`, `SkillRunBar.tsx`, `turn.ts` |
| U4 | §2.4, §4.4 | auto-fire signals narrowed to explicitly-scoped docs; redaction manifest↔handler aligned; bank/invoice/meeting opt-in (default-off) | `skills/autofire.ts`, `scope-signals.ts` |
| U5 | §3.6, §6.2, ux | de du-sweep + lint guard; `needsExtraction` names the real button; honest "read-only may auto-run" copy; per-export save-dialog metadata; ephemeral analysis notice | `i18n/{en,de}.ts`, `tool-runs.ts`, `SKILL.md`×8 |
| A1 | §6.1, §6.4 | invoice-run's layer-for-layer copy folded into ONE `DomainRunConfig`-driven engine (`runDomainExtractionInner`); shared `analysis/common.ts` | `run.ts`, `invoice-run.ts`, `analysis/common.ts` |
| A2 | §6.2 | `shared/skill-tools.ts` self-describing `SkillToolDescriptor` single-sources the wired-tool lists + labels + dialogs; `SkillRunController` scoped per-document | `shared/skill-tools.ts`, `run-controller.ts` |
| A3 | §6.3, §8.2 | manifest `analysis:` mode + inverted whole-doc gate (`manifestAnalysisHandler`; `isNeedleShaped` / `isSmallTalk` skill-agnostic) | `analysis/whole-doc-skills.ts`, `registerRagIpc.ts` |
| T1 | §7 | real-layout fixture corpus run through the production extractors + output-**SNAPSHOT** version-bump guard + env-gated real-model smoke (`describe.runIf`, skipped in CI) | `tests/{fixtures/real-layouts,integration/extractor-realworld,e2e-model}` |

Both extractor versions climbed to **8** over the wave (R1→4, R2→5, R5→6, R6→7, U1→8) — every extractor
behavior change bumps by exactly 1 so stale rows re-extract — and the T1 output-snapshot guard
(`extractor-realworld.test.ts`) now FAILS the default suite on any corpus-fixture output change unless the
version was bumped AND the snapshot regenerated. The `42a4eb9` U1-review fix was reconciled onto the tip
in this close-out's **Part A** and owed **no** version bump (no corpus-fixture output moved; the fixtures
are clean, `droppedRowCount` 0). Suite at close: **3071 passed / 44 skipped** (incl. the 3 collected-but-
skipped smoke tests) + typecheck.

**Posture held across all 20 phases (load-bearing):** offline / no telemetry; the **content class**
(skill bodies, the draft question, extracted figures, redacted text, document text **and**
titles/filenames) is never logged / audited / exported — only ids/counts cross the IPC/audit boundary;
schema changes are additive-nullable (`dropped_row_count`, `date_order_inferred`, `taxRatePercent`); LLM
prompts stay English; **the LLM never computes or moves a figure** (§8.1's load-bearing rule); every
behavioral change was adversarially diff-reviewed + teeth-checked. Whole-doc / compare / budget-honesty
detail cross-refs [`rag-design.md`](rag-design.md) §14; the Tier-2 gate / analysis-mode security posture is
in [`security-model.md`](security-model.md).

#### §-anchor legend (audit 2026-07-02 + remediation phase ids)

The retired plan + audit are cited across the skills code, the 8 `SKILL.md` bodies, and the kept docs by
**`audit §N.M`** and **phase id** (`R1`–`R6`, `W1`–`W5`, `U1`–`U5`, `A1`–`A3`, `T1`); those numbers were
never renumbered, so this legend keeps them **resolvable** (the doc-lifecycle "stable anchors" intent)
without churning the comments. Read a historical anchor as:

| Historical anchor | Meaning (audit 2026-07-02) | Landed in |
|---|---|---|
| §2.1 | Multi-doc scope silently disables every whole-doc engine | W2 (§39) + known-limitations |
| §2.2 | "Whole document" is a silent prefix read at default context | W1 + `rag-design.md` §14 |
| §2.3 | Silent row drops asserted as exhaustive reads | U1 (`droppedRowCount`) |
| §2.4 | Whole-doc machinery unreachable by default | A3 gate inversion + U4 auto-fire |
| §3.1 | Fixed templates intercept every keyword-matched question | W3 / W4 third mode |
| §3.2 | Substring gates fail in both directions | W5 word-boundary matcher |
| §3.3 | Bank template points at a nonexistent escape hatch | W4 (honest `transactionsMore`) |
| §3.4 | Routing / scope-policing delegated to the model | W2 + U2 dry-run |
| §3.5 | share-safe: the LLM owns what determinism should | U2 share-safe pre-scan |
| §3.6 | Smaller determinism items (CSV honesty, badges) | U1 / U5 |
| §4.1 | Two drifted keyword vocabularies per skill | W5 vocabulary single-source |
| §4.2 | Raw-substring suggestion + biased scoring | W5 scoring |
| §4.3 | Sticky-default: no per-turn apply / undo | U3 |
| §4.4 | Auto-fire corroboration vacuous at whole-corpus scope | U4 narrowed signals |
| §4.5 | No document-plausibility gate | W2 plausibility gate |
| §4.6 | "One scope query" already violated | R4 `documentsInScope` |
| §5.1 | `what-changed` compare direction unspecified | R4 A/B labelling |
| §5.2 | Invoice label-prefix consumes line items as totals | R2 `labelBoundaryOk` / `isFillerOnly` |
| §5.3 | Unicode-minus / NBSP side doors | R1 normalization pre-pass |
| §5.4 | Missing German totals labels → phantom items | R2 label set |
| §5.5 | `'sepa'` rule blocks the LLM for de-AT rows | R3 `confident:false` |
| §5.6 | Run-bar serves / exports stale-extractor rows | R3 staleness re-extraction |
| §5.7 | Medium/low extraction (dates, column debris, redaction gaps) | R5 / R6 / U2 |
| §6 / §6.1 | Second domain added by copy, not parameterization | A1 run seam |
| §6.2 | A 9th tool skill costs ≥10 files across four layers | A2 self-describing registry |
| §6.3 | Routing intelligence is app code; skills portable in name only | A3 manifest analysis mode |
| §6.4 | Shared handler plumbing | A1 / A2 (`analysis/common.ts`) |
| §7 | Testing & evaluation infrastructure | T1 |
| §8.1 / §8.2 / §8.3 | The three root-cause recommendations | the spine above (W3·W4 / A3·W2 / W5·U4) |
| `R#` / `W#` / `U#` / `A#` / `T1` phase ids | The 20 remediation phases (5 tracks) | the disposition table above (§39) |


### §41 Skills & Tools audit 2 (2026-07-03) — remediation wave close-out

The follow-up pass over the post-§39 surface (five scoped lenses — extractors; analysis + routing; run
seam/IPC/persistence; package lifecycle; renderer UX — plus an orchestrator sweep of the activation
core; audited at `fix/skills-close` @ `e1d63f1`, 3071 green). Verdict: **the 2026-07-02 wave held** —
no Critical, no security-boundary breach, no data-loss path; SEC-1 survived every id-shadowing and
manifest probe. **45 findings (`SKA-1`…`SKA-45`: 6 High · 12 Medium · 24 Low · 3 Info)** landed in a
**nine-phase wave** (`R7 → R8 → W6 → W7 → A4 → U6 ∥ U7 → R9 → T2`) on stacked `fix/skills2-*` branches.
The working paper `docs/skills-audit-2026-07-03.md` was **deleted** under the CLAUDE.md doc-lifecycle
rule (full original in git history, last present on `fix/skills2-t2`); this record is the durable
index — read a code comment's **`SKA-N`** or `skills-audit-2026-07-03 §N.M` citation through the
**§-anchor legend** below. Direct successor to §39; residuals live in
[`known-limitations.md`](known-limitations.md).

**The audit's assessment (kept):** the activation ladder (manual per-turn pick → measured suggestion →
opt-in auto-fire → scope-shaped active-skill routing) is well designed and stays as built; the one
wrong layer was **tool-skill routing still gating on phrasing** — fixed as the wave's spine, below.

**The three clusters the findings reduced to (the spine):**

1. **Compose the honesty gates into the third mode (SKA-4/5/21/22 → W6).** Grounded-data shipped
   (§39 spine 1) without the wave's own honesty plumbing: its deterministic postscript echoed computed
   in/out/net on `contradicted`/`unverified` statements the template refuses to total, and
   `droppedRowCount` never reached the mode. Now `buildCashflowPostscript` takes the D56
   `CompletenessStatus` (echo only when not contradicted; `unverifiedCaveat` + `countPartial` hedges
   ride when owed), both data blocks declare MISSING lines vs whole-document provenance honestly,
   `invoiceTotalsCurrency` never stamps mixed-currency totals with one row's code, and the data block
   is delimited (`BEGIN/END DOCUMENT DATA` + not-instructions line). D56 `complete` still OUTRANKS the
   parse-gap hedge (a tying balance proves the dropped line didn't move it).
2. **Kill the last invented-figure classes (SKA-1/2/13/14 → R7; SKA-3 → R8).** A mid-line/trailing
   date in a row's money region read as the AMOUNT (a period line became a transaction); dd.mm.yy
   dates were money-shaped and invisible to every date scrub; the geometry classifier ate `d.dd`
   amounts as out-of-column dates (balance-as-amount); money-bearing vendor/number header lines
   vanished into headers. Fixed structurally: `scanMoneyWithBlankedDates` (same-length blanked scan so
   description slicing never shifts), the double-guarded 2-digit-year date alternative, row-context-
   gated geometry reclassification, and an amount-shaped-money gate on header consumption — **both
   extractor versions → 9**, snapshot regenerated once. R8 gave redaction a same-length **detection
   shadow** (NBSP/U+2011/print-variant separators + parenthesized US phones mask; offsets stay exact).
3. **Finish the inversion + tune the classifiers (SKA-7/8/12/23 → A4; SKA-9/10/11/19/20 → W7).** The
   §39 gate inversion stopped one layer short of the highest-stakes answers: bank/invoice TOOL skills
   still routed by `routeMatch` phrasing. W7 first closed the measured vocabulary gaps (German money
   terms, separable-verb summary stems, the explanatory `warum/why` format guard, thanks/ack
   small-talk fillers, synthesis-ask needle vetoes; decision: `spend on` DROPPED from the category
   stems), growing the eval corpus per family; then A4 added the structural half — the detail formerly
   noted at §39 spine 2 as "to fold into this record": `classMatches` (manifest doc signals OR a prior
   extraction) + fully-chunked + not-small-talk runs the handler on ANY `routeMatch` miss, `intends()`
   became vocabulary-shaped so multi-doc off-topic questions fall through instead of "pick one
   document", the needle downgrade dropped its tree conjunct (SKA-12) and moved before the D45 refusal
   (SKA-23). Read-side only; no new capability (SEC-1 unchanged).

**As built, per phase (dispositions; branch chain `fix/skills2-r7` … `fix/skills2-t2`):**

| Phase | SKA items | Disposition (one line) | Code home |
|---|---|---|---|
| R7 | 1, 2, 13, 14 | date-vs-money disambiguation quartet (blanked-date money scan; yy-date guard; geometry row-context gate; header amount-gate); versions → **9**; 3 new corpus fixtures | `tools/{money,bank-statement,invoice}.ts`, `parsers/pdf-layout.ts` |
| R8 | 3 | same-length detection shadow for Unicode print-variant separators + `(ddd)` US phones, both `run` and `scanRedactionCandidates` | `tools/redaction.ts` |
| W6 | 4, 5, 21, 22 | grounded-data honesty composition: status-gated postscript echo, droppedRowCount threading + MISSING note, mixed-currency never stamped, delimited data block | `analysis/{bank-statement,invoice}.ts`, `rag/grounded-data.ts` |
| W7 | 9, 10, 11, 19, 20, 7-vocab, 45-minors | answer-shape + classifier vocabulary tuning (route-only); eval corpus grown per family; decision: DROP the spend-stems | `skills/vocabulary.ts`, both handlers |
| A4 | 7-structural, 8, 12, 23 | tool-skill single-doc inversion (`classMatches`), vocabulary-shaped `intends()`, needle-downgrade tree conjunct dropped + evaluated before D45 | `registerRagIpc.ts`, `analysis/*` |
| U6 | 6, 17, 18, 25, 29, 37–41 | per-run renderer store keyed by handle, conversation-gated run bar, `listSkillRuns` re-adopt IPC, empty-handle cancel refused, confirm-gated out-of-scope hard refusal, shallow-compare + poll tolerance, one aria-live region, undo/stamp fixes | `renderer/lib/skillruns.ts`, `ChatScreen.tsx`, `SkillRunBar.tsx`, `registerSkillsIpc.ts` |
| U7 | 15, 16, 30–36, 42, 45-riders | package lifecycle hardening: paragraph-merged SKILL.md bodies (fence-trim keeps the rules), per-folder discovery guards + surfaced error codes, case-fold zip guard, content-free YAML errors (before 32), note codes, staging sweep, export mirrors import (decision), bidi rejection | `registry.ts`, `installer.ts`, `shared/skill-manifest.ts`, `SkillsTab.tsx`, SKILL.md ×8 |
| R9 | 24, 26, 27, 28, 44 | abort-aware `withDocumentLock`; staleness flipped to `v !== CURRENT` (decision — downgrade re-extracts); B4-guarded export tail + write-time 'done' (+ the redaction-seam rider); one lock across prepare+load+serialize (TOCTOU); EN `transfer` demoted (decision) | `doc-lock.ts`, `run.ts`, `invoice-run.ts`, `categorizer.ts` |
| T2 | test-infra + ledger | snapshot self-checks (hash recompute + version pin); controller reject/throw-after-abort edges; persist-failure-keeps-old ×2 domains; two-conversations-same-doc IPC; dropped-row + contradicted corpus fixtures e2e; SEC-1 + mixed-currency IPC pins; :743 reachability repair; **SKA-43 declined** (accepted residual) | `tests/*` only — zero production changes |

Extractor versions climbed **8 → 9** exactly once (R7); every other phase verified NO snapshot
interaction. The T1 output-snapshot guard gained self-checks (T2): a hand-edited hash or a
bump-without-regenerate now fails the default suite; the same-commit input-edit exemption is the
recorded acceptance. Suite at close: **3272 passed / 44 skipped** + typecheck; the env-gated
real-model smoke ran 3/3 green against a local Qwen3.5-4B GGUF as the wave's final sanity pass.

**Posture held across all nine phases:** offline / no telemetry; the content class never crosses the
IPC/audit/log boundary (ids/counts only — re-verified by sentinel tests each phase); **the LLM never
computes or moves a figure**; additive-only schema/IPC surface (`listSkillRuns`,
`SkillRunState.conversationId?`/`documentId?`, `runningHandle` on the busy refusal); every behavioral
phase adversarially reviewed + every fix teeth-checked RED against its revert. Decisions taken inside
the wave (all recorded with rationale in known-limitations): SKA-20 drop the spend-stems; SKA-26 flip
staleness to `!==`; SKA-34 export mirrors import; SKA-44 demote EN `transfer`; SKA-43 accept the
double needle-turn scan (no cache — milliseconds vs the following model call, and a stale memoized
total would mis-size the needle downgrade / compare split); SKA-45's `buildSkillFence` O(n²) loop
accepted (64 KiB-cap-bounded).

#### §-anchor legend (audit 2026-07-03 — `SKA-N` + section citations)

Code comments, tests, and the kept docs cite this audit as **`SKA-N`** and
`skills-audit-2026-07-03 §N.M`; neither was renumbered. Read them as:

| Section anchor | Meaning (audit 2026-07-03) | Now lives at |
|---|---|---|
| §1 / §2 | Executive summary / activation-model assessment (kept as built) | this record's intro + assessment |
| §3.1–§3.4 | The findings, by severity (High/Medium/Low/Info) | the `SKA-N` table below |
| §4 | Documentation audit (9 doc↔code mismatches) | fixed inside the owning phases (W6/W7/R7/U7/A4) |
| §5 | Testing audit (gaps by theme) | T2 row above + U6/R9 attributions |
| §6 | Performance audit | W7/A4 routing fixes + the SKA-43/39 residual notes |
| §7 / §8 | The nine phase specs / execution order | the disposition table above |
| §9 | Checked clean (activation ladder, W2/A3 plumbing, run seam, installer matrix, prompt assembly, extractor internals, i18n, eval corpus) | verified sound — not re-filed, no record needed |

| SKA | Finding (one line) | Landed in |
|---|---|---|
| 1 | mid-line/trailing date in the money region parsed as the AMOUNT (invented rows/items) | R7 |
| 2 | dd.mm.yy dates money-shaped + invisible to every date scrub | R7 |
| 3 | redaction missed NBSP/U+2011 print-variants + parenthesized US phones | R8 |
| 4 | grounded-data postscript echoed totals on contradicted/unverified statements (D56 bypass) | W6 |
| 5 | droppedRowCount honesty never reached grounded-data | W6 |
| 6 | renderer run store single-slot; run bar cross-conversation (wrong-doc categorize chain) | U6 |
| 7 | tool-skill analysis phrasing-gated (on-topic misses fell to raw top-k) | W7 (vocabulary) + A4 (structural) |
| 8 | A3×W2: sticky instruction skill + multi-doc scope → "pick one document" for everything | A4 |
| 9 | German separable verbs evaded the summary-template stems | W7 |
| 10 | format detection lacked an explanatory (warum/why) guard | W7 |
| 11 | `isSmallTalk` missed high-frequency thanks/ack variants | W7 |
| 12 | needle over an over-budget doc WITH a tree ran a ~13-call map-reduce | A4 |
| 13 | geometry classifier read d.dd amounts as dates (balance-as-amount) | R7 |
| 14 | money-bearing vendor/number header lines swallowed (figure vanished) | R7 |
| 15 | fence-trim guaranteed minimum was the bare heading (honesty rules trimmable) | U7 |
| 16 | one unreadable SKILL.md killed ALL skill discovery | U7 |
| 17 | a renderer reload orphaned an in-flight run irrecoverably | U6 |
| 18 | the 'new'-composer skill pick resurrected on later empty composers | U6 |
| 19 | `isNeedleShaped` fired on synthesis asks | W7 |
| 20 | 'spend on' routed to the category template (decision: stems dropped) | W7 |
| 21 | mixed-currency invoice totals stamped with one row's currency | W6 |
| 22 | grounded-data block undelimited (document text rode under prompt authority) | W6 |
| 23 | needle over a not-fully-chunked doc refused where a smaller doc answers | A4 |
| 24 | Cancel did not reach a run parked on the document lock | R9 |
| 25 | empty-handle `cancelSkillRun` aborted EVERY in-flight run | U6 |
| 26 | extractor-version DOWNGRADE unhandled (decision: staleness flipped to `!==`) | R9 |
| 27 | export tail lacked the B4 terminal-status guard (+ the redaction-seam rider) | R9 |
| 28 | summarize/export loaded rows after the staleness re-extract lock released (TOCTOU) | R9 |
| 29 | a CONFIRMED export could run against a different doc via the single-doc fallback | U6 |
| 30 | zip duplicate-path rejection was case-sensitive | U7 |
| 31 | YAML parse errors embedded raw attacker frontmatter | U7 |
| 32 | discovery/reconcile errors computed then dropped by every consumer | U7 |
| 33 | a failed import showed only the generic toast | U7 |
| 34 | import/export tree asymmetry (decision: export mirrors import) | U7 |
| 35 | import-preview notes unlocalized + attacker-influenced | U7 |
| 36 | crash-leftover `.skill-import-*` staging dirs never swept | U7 |
| 37 | undo/try-again rendered on a stale last-assistant turn | U6 |
| 38 | deleting a skill erased the stamp AND the undo | U6 |
| 39 | run-store poll re-notified (re-rendered) every 400 ms with no change | U6 |
| 40 | one transient poll error silently dropped a live run | U6 |
| 41 | per-state-branch aria-live region missed the first announcement | U6 |
| 42 | document-redaction SKILL.md named only the English button | U7 |
| 43 | double full-document scan per needle turn | **accepted residual** (T2 decision; known-limitations) |
| 44 | EN `transfer` categorizer rule confident (decision: demoted) | R9 |
| 45 | content/robustness minors (keyword gaps, trailing-space entries, autoFire comment, bidi titles, fence O(n²)) | W7 + U7; fence-loop = accepted residual (T2) |
| `R7`–`T2` phase ids | the nine remediation phases | the disposition table above (§41) |


### §42 Invoice hardening (invoice-hardening-2026-07-04) — incident-driven wave

A real user transcript (a glyph-mangled crypto-scam invoice PDF) surfaced four compounding failures:
(1) *"Analysiere die Rechnung im Roh format - **nicht im json**"* re-served the **byte-identical JSON
dump** 9 ms after the question (`detectFormat` matched the bare `\bjson\b` token inside a negation;
the serialization path is deterministic, 0 model calls); (2) the extractor scraped **confident garbage
totals** (net 4 / tax 0 / gross 914 against items summing ~1084) from per-glyph text —
`validateInvoiceTotals` *detected* the mismatch but every answer shape printed the figures anyway, and
the grounded-data echo asserted them as *"wörtlich aus dem Dokument"*; (3) *"Wer ist der Empfänger?"*
was structurally unanswerable — the schema had **no recipient field** and grounded-data confines the
model to the extract; (4) the exported transcript rendered **mojibake** in CP1252-defaulting viewers
(UTF-8 with no BOM). Landed as four stacked `fix/invoice-hardening-p1…p4` branches:

- **P1 — format-intent correctness.** `detectFormat` is negation-aware per MENTION (a format token
  preceded by `nicht/not/ohne/statt/kein…` within a 24-char window does not count; "als CSV, nicht als
  JSON" still serializes CSV) and raw-aware (an explicit `Rohformat/raw/Fließtext/Klartext/plain
  text/Prosa` ask disables the short-circuit). Backstop in `run()`: when the question carries any
  negator and the dump would byte-duplicate the previous assistant turn, fall through to grounded-data.
- **P2 — reconciliation is gating, not decorative.** Extractor v10: a bare-integer currency-adjacent
  totals read is tracked WEAK and retracted when it participates in a mismatched check with no ok check
  corroborating it (one validation snapshot; decimal reads untouched). Answer layers mirror the bank
  `contradicted` suppression: mismatched totals print under an UNVERIFIED heading + caveat, the
  grounded-data figure echo is replaced by a suppression note, and the data block carries a WARNING
  instructing the model to treat every figure as unverified.
- **P3 — text-quality signal + recipient + off-schema fall-through.** Extractor v11:
  `looksLikeGlyphSoup` (shared, `money.ts` — ≥3 single-glyph-run lines AND ≥20% of non-empty lines)
  stamps `textQuality:'suspect'` (persisted, `invoices.text_quality`); the analysis handler re-extracts
  ONCE through the geometry (layout) segment reader — `reconstructPage` emits non-transaction rows as
  raw visual-order text, exactly what a columnar invoice needs — and a still-soupy retry persists
  `'suspect-confirmed'` (final). On a suspect layer, figures are presented only when the invoice's own
  arithmetic POSITIVELY reconciles them; otherwise the localized `unreadableLayout` refusal (OCR/original
  guidance). The header gains `recipient` (labeled lines only, reference-noun guard;
  `invoices.recipient`). A question naming a header field the extract does NOT carry falls through to
  the relevance path (`fallThrough`) so the model reads the document text.
- **P4 — enforcement + polish.** Real-layout corpus gains the adversarial invoice fixtures
  (`invoice-us-glyph-soup`, `invoice-de-unreconcilable-totals`) and the FIRST geometry-invoice fixture
  (`invoice-de-geometry-columns`, via the real `reconstructPage` — closes the T1 residual); the snapshot
  guard covers all of them. Plain-text exports (`.md`/`.txt` only — never JSON/log) get a UTF-8 BOM
  (`bomFor`, `save-export.ts`) so legacy Windows viewers stop rendering mojibake.

Decisions worth keeping: negation windows beat sentence-level negation detection (clause-level negators
must not disarm a distant format ask); weak-read retraction is CORROBORATION-weighted (an ok check
outweighs a mismatch — a corroborated weak figure survives a strong misprint elsewhere); under a soup
text layer the presentation bar INVERTS (reconciled-or-refuse), because "printed verbatim" is
meaningless when the print itself was misread; the geometry retry is once-per-document
(`suspect-confirmed`), never per-turn. i18n keys added (en+de): `totalsHeadingUnverified`,
`unreconciledCaveat`, `figureEchoSuppressed`, `detailRecipient`, `unreadableLayout`,
`textQualityCaveat`.


### §43 Invoice skills & tools audit (invoice-skills-audit-2026-07-06) — remediation ledger + close-out

A fresh three-pass audit of the invoice skill/tool surface (tool/parser code · analysis pipeline &
run lifecycle · docs-vs-code consistency), run **after** the §42 incident wave and cross-checked
against the prior ledgers (§8/§24/§26/§27/§29/§34/§40/§42) so already-fixed / explicitly-deferred
items were not re-reported. It found **2 HIGH · 10 MEDIUM · 12 LOW** (findings numbered **T-** =
tool/parser, **P-** = pipeline/lifecycle, **D-** = docs). Both HIGH landed first. Remediated across a
seven-phase wave **IA-1…IA-7**, all on `master` (unpushed): `IA-1` d26cc13, `IA-2` a8c4fdc, `IA-3`
129afbb, `IA-4` 13e9a69, `IA-5` 9d7c4cb, `IA-6` 6f8b90b, `IA-7` (this close-out). The worst user
journey (soup invoice → refusal telling the user to OCR → same refusal forever) is dissolved (P-1+P-2),
the shared-parser sign-flip is closed (T-1), and every finding is fixed — **none deferred**. Extractor
versions moved `INVOICE_EXTRACTOR_VERSION` **11 → 13** (IA-2 T-1 = 12; IA-3 batch = 13) and
`BANK_EXTRACTOR_VERSION` **9 → 11** (IA-2 T-1 = 10; IA-3 T-6 shared date-order = 11); IA-4/IA-5/IA-6
are answer-layer / reader-construction / lifecycle changes with **no** version bump. Final suite
**3616/47**, typecheck clean (before this docs-only close-out).

Per-finding disposition (fixed-in-phase@commit / decision taken):

| # | Sev | Phase | Disposition (decision / mechanism) |
|---|---|---|---|
| **P-1** | HIGH | IA-1 `d26cc13` | **fixed** — staleness gate was extractor-VERSION-only; the re-index/OCR-re-ingest teardown deleted chunks/embeddings/trees but NOT the extraction rows → a `suspect-confirmed` refusal survived the very OCR the app instructed, and a changed text layer kept answering from old content. `purgeSkillDataForDocument(db, id)` now runs inside the re-index teardown transaction (`services/ingestion/index.ts` `prepareDocument`). **Decision — simple purge over a content-fingerprint column** (no reason to escalate emerged); covers the **bank twin** automatically. |
| **T-1** | HIGH | IA-2 `a8c4fdc` | **fixed** — `MONEY_RE`'s leading class signed a `-` even with ≤4 spaces before the figure → dash-as-separator layouts flipped sign (`Beratung – 1.500,00` → −1500; bank `GUTSCHRIFT - 34,39` → −34,39), and the plain path disagreed with the geometry path. Leading `-`/`+` now signs ONLY when GLUED to the magnitude/paren (mirror of the trailing-side BL-1 fix); `lastCurrencyAdjacentInteger` got the same rule. Bumped INVOICE 11→12 + BANK 9→10 (stale rows re-extract). |
| **T-2** | MED | IA-3 `129afbb` | **fixed — SPLIT, not refuse.** A one-line multi-label totals row (`Netto … MwSt … Brutto …`) assigned the LAST figure to the FIRST label; `readMultiLabelTotals` now attributes each figure (found on a date-/percent-blanked copy) to its own nearest-preceding boundary-matched label under a strict engage guard (≥2 figures, every figure preceded by a filler-only totals-label run, ≥2 distinct fields — else falls through unchanged, so `Miete netto 1.000,00` is never hijacked). |
| **T-3** | MED | IA-3 `129afbb` | **fixed** — a 2-dp tax RATE (`MwSt 20,00 %`) read as the tax AMOUNT; `lastMoney` now scans `blankPercentFigures(stripDateTokens(line))` (new `PERCENT_FIGURE_RE`) so a percent-attached figure is never read as currency. |
| **T-4** | MED | IA-3 `129afbb` | **fixed** — de-AT `USt` / `Steuerbetrag` / `Nettosumme` became phantom line items; added `ust`/`steuerbetrag` to `TAX_LABELS`, `nettosumme` to `NET_LABELS` (`USt-IdNr: ATU…` still falls through). known-limitations `USt` residual note rewritten as closed. |
| **T-5** | MED | IA-3 `129afbb` | **fixed — GATE, not count** (SKA-14 precedent). `applyHeader`'s date branches swallowed a figure on a flattened header/summary line; all header branches now early-return on `carriesAmountShapedMoney`, so `Rechnungsdatum: … Betrag: 1.500,00` surfaces the figure as a line item (accepted trade-off: the date on such a combined line is not captured — drop-don't-guess). |
| **T-6** | MED | IA-3 `129afbb` | **fixed** — dotted `dd.mm` header dates matched raw `MONEY_RE`, suppressing the `'default'` date-order honesty caveat; `inferDateOrderResult` classifies lines by date-scrubbed `hasMoneyToken`. SHARED `money.ts` → drove the **BANK 10→11** bump on the correctness/staleness principle (no bank corpus fixture moved; two invoice fixtures flipped `dateOrderInferred 'evidence'→'default'`, correctly). |
| **T-7** | MED | IA-3 `129afbb` | **fixed — WIDEN tolerance, not a new status.** `taxMatchesRate` demanded exact-cent equality, flagging legally-correct per-line-rounded VAT (3×6,67=20,01 vs round2(sum)=20,00) as `mismatch`; tolerance widened to `±max(1 cent, n×½ cent)` (a new "within rounding" status would ripple through the answer layer + i18n; a euro-off tax still mismatches). Downstream check only → did not itself warrant a bump. |
| **P-2** | MED | IA-1 `d26cc13` | **fixed** — a cancelled/transiently-failed geometry retry permanently burned the one retry; the `'suspect-confirmed'` promotion + UPDATE now live INSIDE the `retry.ok && retry.invoiceId` branch, so a non-ok retry leaves `text_quality='suspect'` for a later turn. (Full abort→calm-cancel propagation completed in IA-4.) |
| **P-3** | MED | IA-4 `13e9a69` | **fixed — invoice + bank twin, no version bump.** A Stop during the analysis auto-run was swallowed (handler RETURNED `couldNotRead` / a recomputed answer, sailing past `withChatStream`'s throw-only calm-cancel); on a seam `cancelled` (or late `ctx.signal?.aborted`) the handler now throws `DOMException(…, 'AbortError')` → empty message, nothing persisted. Seam contract verified: a genuine non-cancel failure still returns `couldNotRead`. |
| **P-4** | MED | IA-5 `9d7c4cb` | **fixed — bank-mirror lazy reader.** Every non-format invoice question eagerly re-parsed the whole document from disk (decrypt+PDF+OCR) under the per-document lock and discarded it; `INVOICE_RUN_CONFIG.buildDownstreamReader` now binds the bank's lazy `buildReadDocumentChunks(db, new Set([id]))` (closing the A1 "left to a follow-up"). Extraction path stays on `resolveDocumentReader`; every downstream tool takes structured input and reads no chunk. |
| **D-1** | MED | IA-1 `d26cc13` | **fixed** — live decision D58 ("layout mode is bank-statement ONLY") contradicted the shipped invoice geometry retry; D58 (§21) + known-limitations amended with the §42-P3 superseding note (the invoice ANALYSIS path re-extracts once via layout on a `suspect` verdict; the run-bar extract stays reading-order). |
| **T-8** | LOW | IA-3 `129afbb` | **fixed** — bare `(netto)` qualifier on a GROSS label mis-landed net in `grossTotal`; `\bnetto\b`/`\bnet\b` added to `EXCL_TAX_RE` (consulted only after a GROSS label matched). |
| **T-9** | LOW | IA-6 `6f8b90b` | **fixed** — `validateNode` used prototype-chain `in` against `properties`/required; both checks now `Object.prototype.hasOwnProperty.call(...)` so an own key named `constructor`/`toString`/… is not waved through `additionalProperties:false` (defence-in-depth; nothing downstream dereferenced the extra keys). |
| **T-10** | LOW | IA-3 `129afbb` | **fixed** — wrapped-description continuation gate used raw `MONEY_RE` (same root cause as T-6); switched to `!hasMoneyToken(line)`, so a money-less date follower keeps its continuation. Theme-1 sweep of the remaining raw-`MONEY_RE` sites explicitly cleared (all date-scrubbed or conservative). |
| **T-11** | LOW | IA-2 `a8c4fdc` | **fixed** — `lastCurrencyAdjacentInteger` did O(n²) slices + per-match `new RegExp`; replaced by an index walk + hoisted `CURRENCY_SYMBOL_SET`/`ISO_CODES.has`. **Deviation (recorded):** symbol regexes REPLACED by Set membership, not merely hoisted (subsumes the hoist, kills the O(n²)). |
| **P-5** | LOW | IA-6 `6f8b90b` | **fixed** — four single-row `invoices` reads per question collapse to one `loadInvoiceMeta` projection (`date_order_inferred`/`dropped_row_count`/`text_quality`), read once up front + re-read once only when the retry replaces the row (3/4 → 1/2; answers byte-identical). |
| **P-6** | LOW | IA-6 `6f8b90b` | **fixed — SQL `substr`, not a row `LIMIT`.** `loadCitationChunks` (SHARED by invoice+bank builders) selected the whole `text` column to keep ≤12 citations; now selects `substr(text,1,281)` (bank narrows by arbitrary `page_number`, invoice needs head+tail → a row cap would break a caller; snippet cut to 280 → 281 is byte-identical). |
| **P-7** | LOW | IA-6 `6f8b90b` | **fixed** — a hard crash stranded `skill_runs` rows at `'started'` forever; new `reconcileStuckSkillRuns(db, beforeIso)` (`registerDocsIpc.ts`, idle-gated). **Watermark decision:** `skill_runs` bumps no `updated_at`, so it uses a module-load `PROCESS_START_ISO` watermark (not `now`) — only previous-session rows are reconciled, a live run is never clobbered. |
| **P-8** | LOW | IA-6 `6f8b90b` | **fixed** — `domainPersistFailure` + the `prepareDomainRun` catch called `finishRun` unguarded (a doomed terminal UPDATE could throw out, strand the row, and reject the seam raw); new `finishRunGuarded` (SKA-27 `finishTail` pattern generalized — one retry, content-free log, envelope stands) backs both exits. |
| **D-2** | LOW | IA-1 `d26cc13` | **fixed** — the two `tool-runs.ts` comments asserting "invoices are never geometry-reconstructed" rescoped to the run-bar path (the one geometry read is the analysis handler's P3 suspect retry). |
| **D-3** | LOW | IA-7 (this) | **fixed** — §8 said "three" invoice tools/labels in two sentences; corrected to "five" (three core + the JSON/XML format exports, documented in the same §). |
| **D-4** | LOW | IA-7 (this) | **fixed** — `app-skills/invoice/SKILL.md` body described only the CSV export; the closing sentence now covers the JSON/XML exports its `allowedTools` frontmatter grants (whole invoice — header, line items, totals). No parity-test text pin on that sentence (the parity test pins only the honesty bullets in `paragraphs[0]`). |
| **D-5** | LOW | IA-7 (this) | **fixed** — `troubleshooting.md` "skill tool found nothing" section gained a glyph-soup refusal bullet: what `unreadableLayout` means, the automatic once-per-document layout retry, the OCR/original guidance, and (post-IA-1) that running OCR re-reads the document so the next question re-extracts — no delete-and-restart needed. |

**§-anchor legend (keeps the code-comment citations resolvable after the report was retired).** In-code
comments cite this audit as `invoice-audit-2026-07-06 <T-n|P-n>`, `IA-<n>`, `IA-<n> <P-n>`, or the bare
`audit P-n` (the shared bank/invoice `P-1`/`P-2` provenance labels predate this wave — see §19/§29 for
those). All resolve here: the `T-*`/`P-*`/`D-*` finding ids and the `IA-1…IA-7` phase labels are the
rows above; `INVOICE_EXTRACTOR_VERSION` history entries 12 (IA-2) and 13 (IA-3) and
`BANK_EXTRACTOR_VERSION` 10 (IA-2) and 11 (IA-3) carry the same tags in their in-file version logs.
Report retired: `git rm docs/audits/invoice-skills-audit-2026-07-06.md` (recoverable in git history; the
full finding bodies + the IA-1…IA-6 SHIPPED dispositions live there).

### §44 Skills content-vs-runtime audit (skills-audit-2026-07-07) — remediation ledger + close-out

An app-skills **content ↔ runtime truth** audit swept all 9 bundled skills (SKILL.md frontmatter +
bodies + the two bank-statement aux files) against the runtime they describe — the tool registry/impls,
the whole-doc/compare engines, the redaction/edit seams, the suggestion/auto-fire heuristic, the
loader/parity plumbing, and the renderer i18n. Cross-checked against the prior skills waves (§23/§39/§41),
the invoice audit (§43), and the beta wave (the §20–§23 beta-feedback records above) so already-fixed /
accepted residuals were not re-reported. It found **2 HIGH · 5 MEDIUM · 8 LOW · 3 INFO** (findings
**SK-1…SK-18**). Both HIGH landed; every actionable finding is fixed; the 3 INFO + the SK-3b runtime half
are recorded as deliberate non-fixes ([`known-limitations.md`](known-limitations.md)). Remediated across a
**five-phase wave** on `master` (unpushed): P1 `c08a0a9`, P2 `4f541c1`, P3 `1af932b`, P4 `8063a1e`, P5
(this docs-only close-out). Only **SK-2** (render-cap → `truncated`) and **SK-6** (schema parity test)
touched code; the rest are `app-skills/` body/aux + renderer-i18n text with matching version bumps (SK-12).
Final suite **3800/47**, typecheck clean.

Per-finding disposition (fixed → phase@commit / declined → rationale / info → note):

| # | Sev | Phase | Disposition (decision / mechanism) |
|---|---|---|---|
| **SK-1** | HIGH | P1 `c08a0a9` | **fixed** — document-edit's stale "writes a plain `.txt` copy" replaced with the true output matrix (`.docx` keeps its format; PDF/plain-text/Markdown → plain-text copy). **Decision D-P1a:** the matrix is stated in BOTH document-edit and document-redaction (shared Phase-9 seam, `run.ts:1519-1523`/`:1781-1789`) — symmetry over silence on a real user question. Corrupt-DOCX→`.txt` fallback (`run.ts:1696-1699`) deliberately NOT claimed (rare degradation the save dialog already surfaces; promising it would teach the model to hedge every DOCX answer). Version → 1.1.0. |
| **SK-2** | HIGH | P2 `4f541c1` | **fixed (design, not a patch)** — the 200-change render cap in `renderChangesForModel`/`renderRedline` fired without setting `truncated`, so >200 coalesced changes within the token budget produced a prompt asserting "complete and exact" over a capped list. `DIFF_RENDER_MAX` now exported from `services/diff` as the single source of truth and passed explicitly to both renderers at both consumers; `retrieveCompareDiff` ORs `changes.length > DIFF_RENDER_MAX` into `truncated` (cap + flag can't drift); the PARTIAL prompt wording generalized to be true for BOTH truncation causes. Second consumer `doctasks/handlers/compare.ts` emits an explicit PARTIAL note under `## Exact changes` when the cap fires. New teeth-checked `tests/unit/rag-compare-diff-truncation.test.ts`. Version → 1.1.0. |
| **SK-3a** | MED | P2 `4f541c1` | **fixed (wording half)** — what-changed's scope rule ("the app replies … before you are ever called") was false on the `intends()`-miss fall-through and at 0 docs; rewritten inside paragraph 0 to discriminate on what the model can SEE — A/B labels or an exact-changes block ⇒ compare; ordinary passages with no diff ⇒ simply answer from the material. |
| **SK-3b** | MED | P2 (declined) | **declined runtime change — decision D-P2a.** Suppressing the user-chosen compare fence on the relevance fall-through would silently drop instructions the user deliberately selected (the per-message glyph shows the skill applied), and the reworded rule 1 is coherent on both paths. Recorded in [`known-limitations.md`](known-limitations.md) beside the SKA-8 fall-through record. Revisit only if the gold set later shows comparison-framed answers on non-compare fall-through turns. |
| **SK-4** | MED | P3 `1af932b` | **fixed** — deadline-obligation-finder promised "one or more documents"; the `analysis: whole-doc` engine requires exactly one in-scope doc (`whole-doc-skills.ts:99-103`), multi-doc → the W2 pre-pass narrows or asks. Description + body reworded to single-document ("in a document" / "in einem Dokument", formal register) + a what-changed-style "the app handles document scope … do not police this" sentence; the coverage-honesty rule kept. Multi-doc sweep rejected (D45 one-doc-at-a-time posture; its own plan if beta demand appears). Version → 1.1.0. |
| **SK-5** | MED | P4 `8063a1e` | **fixed** — the two bank-statement aux files taught the instruction-only v1 (decline to sum/validate/categorize/export) — the opposite of shipped behavior. `examples/reading-a-statement.md` rewritten around the stable honesty posture (kept the three-question structure; "Where the numbers come from" replaces "What this version does not do"; exports always ask before saving); `schemas/transaction.schema.json` `description` fixed to reality (produced by `extract_transactions`, mirrors + pinned to the TS export). Files are never injected at runtime but ride skill export (`installer.ts:840-862`) — first thing a contributor reads. |
| **SK-6** | MED | P4 `8063a1e` | **fixed** — `transaction.schema.json` was a hand-maintained mirror with no parity pin. `TRANSACTION_ROW_SCHEMA` exported from `tools/bank-statement.ts` (test-motivated, comment says so); new `tests/unit/skills-transaction-schema-parity.test.ts` structurally compares the JSON to the TS export (property-name set, per-property `type`/`pattern`/`minimum`/`minLength`, `required`, `additionalProperties`), the intentional `category` delta encoded by name. Teeth-checked (`^[A-Z]{3}$`→`{4}$` → RED). §8 carries the pin note. |
| **SK-7** | MED | P3 `1af932b` | **fixed** — share-safe-review named the sibling skill by EN name only and quoted EN boilerplate under an "answer in the user's language" rule. §4 → "Document Redaction / Dokument schwärzen" (SKA-42 name-both precedent); §3/§4 boilerplate reframed to license translation ("in the user's language, equivalent to:" / "tell the user, in their language:") with the English kept as canonical content. Version → 1.1.0. |
| **SK-8** | LOW | P1 `c08a0a9` | **fixed** — "just below the chat box" was spatially wrong (`SkillRunBar` renders ABOVE the composer, `ChatScreen.tsx:1721,1736`). Fixed in the same commit across both SKILL.md bodies, the EN routing copy, and the DE ("direkt über dem Eingabefeld", formal register `skill-i18n.test.ts` gates) so the model's directions and the on-screen UI agree. |
| **SK-9** | LOW | P1 `c08a0a9` | **fixed** — redaction body enumerated only the three default locate categories; added a clause noting that when the user steers the scope, other located items are masked as `[REDACTED]` (default still the three, matching `DEFAULT_LOCATE_DIRECTIVE`). |
| **SK-10** | LOW | P3 `1af932b` | **fixed** — invoice honesty rule listed 2 of `validateInvoiceTotals`' 3 checks; added "or the tax doesn't match the stated rate" (`taxMatchesRate`) + the closing paragraph's "add up (including the stated tax rate)". |
| **SK-11** | LOW | P1 `c08a0a9` | **fixed** — document-edit's "never repeat document text back to them" was over-broad (find/replace terms are user-typed and already in the transcript); narrowed to allow naming the user's own terms while forbidding quoting any OTHER document text. Redaction's stricter rule kept (its sensitive strings are app-detected, not user-typed). |
| **SK-12** | LOW | P1–P5 | **adopted as convention** (see the checklist note below) — 8/9 skills were frozen at 1.0.0 despite body changes; for app skills `version` is display-only but an exported copy re-imported as a *user* skill runs `compareSemver` upgrade decisions (`installer.ts:626,713`), so a forever-1.0.0 defeats that path. Applied across P1–P4. |
| **SK-13** | LOW | P1 `c08a0a9` | **fixed** — DOCX "byte-for-byte identical" holds for untouched nodes/parts but a rewritten node re-escapes entities (`docx-rewrite.ts` `xmlEscape`), so unchanged characters inside it are character- but not byte-stable; prose → "identical, character for character", the `docx-rewrite.ts:130-131` comment aligned. No behavior change (an entity-preserving rewriter was rejected — real complexity for zero user-visible gain). |
| **SK-14** | LOW | P1/P3/P4 | **fixed** — the `autoFire` "score ≥ 3 bar" comment reads as the suggestion bar; added "(auto-fire bar; the suggestion offer bar is score ≥ 2 with a mandatory keyword hit)" to all four tool skills' frontmatter comments (document-redaction P1, invoice + meeting-protocol P3, bank-statement P4). Comment-only. |
| **SK-15** | LOW | P2 `4f541c1` | **fixed** — what-changed named an "Exact changes" block it never sees; the diff rule now quotes the real runtime label ("Exact word-level changes (redline)", `rag/index.ts:1168`) and defers to the block's own PARTIAL / further-changes markers. |
| **SK-16** | INFO | — | **note (no change)** — `validate_statement_balances` is a per-row running-balance chain (`tools/bank-statement.ts:815-864`); the opening+Σ=closing tie lives in `assessCompleteness` (:504-531) on the answer layer. The composition satisfies the SKILL.md honesty rule; the tool name just covers less than the sentence implies. Recorded in known-limitations. |
| **SK-17** | INFO | — | **note (watch beta)** — meeting-protocol's "audio transcript" works via the audio-file **import** path (AudioParser → document); live dictation returns composer text and never becomes a document (`registerDictationIpc.ts:76-120`), so the skill runs over imported audio documents only, not over a dictation. A body clause is the cheap fix if beta users hit it. Recorded in known-limitations. |
| **SK-18** | INFO | — | **note (do NOT "fix")** — invoice/bank `mimeTypes` deliberately omit `text/plain` while the bodies say "or pasted text"; pasted text carries no mime signal and a lone keyword (=2) already clears the suggest bar, so the two are consistent — "fixing" it would be a precision regression. Recorded in known-limitations. |

**Version convention (SK-12) — part of the SKILL.md-editing checklist.** For a bundled app skill
`version:` is display-only (upgrade `compareSemver` is gated on `existingUser`, `installer.ts:626,713`);
but an **exported** bundled skill re-imported as a *user* skill DOES run semver upgrade/downgrade
decisions, so a frozen 1.0.0 defeats that path. Rule going forward: **bump minor when the model-visible
body changes, patch when only aux files / frontmatter comments change.** This wave: document-edit /
document-redaction / what-changed / deadline-obligation-finder / share-safe-review / invoice → **1.1.0**
(body); meeting-protocol → **1.1.1** (comment-only patch); bank-statement → **1.0.1** (aux + comment only,
body untouched). Fold this line into every future SKILL.md-editing pass.

**§-anchor legend (keeps the code/test/doc citations resolvable after the report + plan were retired).**
In-code comments and pinned docs/tests cite this audit three ways — `audit SK-n` (terse in-code form),
`skills-audit-2026-07-07 SK-n` (full form), and a bare `SK-n` in a test `describe`/comment. All resolve to
the table above. Live citations at retirement:
- **SK-2** — `services/diff/index.ts:280`, `services/doctasks/handlers/compare.ts:189`,
  `services/rag/index.ts:904,1176` (`audit SK-2`); the `rag-design.md` render-cap invariant note +
  `tests/unit/rag-compare-diff-truncation.test.ts` (`skills-audit-2026-07-07 SK-2` / bare `SK-2`).
- **SK-6** — `services/skills/tools/bank-statement.ts:53` (`audit SK-6`); this record's §8 pin note +
  `tests/unit/skills-transaction-schema-parity.test.ts` (`skills-audit-2026-07-07 SK-6`).
- **SK-3b** — the `known-limitations.md` fall-through record (`skills-audit-2026-07-07 SK-3b, decision
  D-P2a`).

Report + plan retired: `git rm docs/skills-audit-2026-07-07.md docs/skills-remediation-plan-2026-07-07.md`
(recoverable in git history; the full finding bodies + the P1–P4 SHIPPED dispositions live there, and in
the BUILD_STATE dated 2026-07-07 Phase entries). This ledger is the durable index.

### §45 Chat & Documents audit (2026-07-07) — remediation ledger + close-out

A five-pass audit (chat backend, chat renderer, docs backend, docs renderer, tests + docs-accuracy)
swept the **Chat** view (`ChatScreen` + `renderer/chat/*` + the chat service / IPC / compaction) and
the **Documents** view (`DocumentsScreen` + `renderer/screens/documents/*` + the docs IPC / ingestion /
collections). Overall health was good — nothing Critical, no routine-path backend data-loss — so the
findings are one **coverage** High (renderer stream-recovery was untested) plus a long tail of Medium /
Low correctness, UX, i18n, a11y, perf, and doc-accuracy items: **CB-1…CB-7 · CR-1…CR-10 · DB-1…DB-7 ·
DR-1…DR-9 · D-1…D-6 · T-1…T-8**. Remediated across a **seven-session wave** on `master` (unpushed), each
session a reviewable/bisectable unit ending with the per-phase ritual: **S1** `c3b4ffc` (docs data
integrity), **S2** `6e89879` (chat renderer + recovery tests), **S3** `628d286` (docs renderer polish),
**S4** `b5c46cb` (chat backend foundations), **S5** `b38f819` (chat backend robustness + D-1…D-4 + T-5),
**S6** `76445ab` (docs backend performance + D-5), **S7** (this test/doc close-out — T-3, T-4, T-6, T-7,
T-8, D-6). Suite grew **3813 → 3874/47**, typecheck clean, build green throughout. Four design decisions
overrode the audit's first-pass suggestions and are recorded as durable (below): CB-7 **deferred**, CR-9
**latent-hardened**, the DB-3 **`now`-watermark** keep, and the DB-5 **count-map cache decline** (plus the
DB-4 walk-stays-sync deferral).

Per-finding disposition (fixed → session@commit / deferred·declined·accepted → rationale). Design detail
"as built" lives in the per-session records cited in the legend below; this table is the index.

| # | Sev | Session | Disposition (decision / mechanism) |
|---|---|---|---|
| **CB-1** | MED | S4 `b5c46cb` | **fixed** — `fitMessagesToContext` now normalizes the kept tail user-first (trimmed branch only, `while`-pop a leading assistant, length-1 guard keeps the final user turn, before the identity check), so a strict Mistral-style template never sees an assistant-first list and the synthetic compaction pair is never replayed ack-without-intro. |
| **CB-2** | LOW | S5 `b38f819` | **fixed** — `withRegenerateGuard` restores the prior reply on an unpersisted-empty resolve (`content === ''`, the Stop-before-first-token path), re-inserting the original id/timestamp and returning it via `getLatestMessage` so `chat:done` re-shows the answer. Composes with CB-4. |
| **CB-3** | LOW | S5 `b38f819` | **fixed** — compaction trigger capped at `min(COMPACT_THRESHOLD·window, window − reserve)` so small (2048/4096) windows compact before L1 drops history (≥6827 keeps `0.85·window` byte-identical); pre-pass estimate folds in the real summary-pair + system-prompt + a caller-supplied `reservedTokens` (fence built before compaction). |
| **CB-4** | LOW | S5 `b38f819` | **fixed** — completed, non-aborted, **zero-token** stream throws `EmptyCompletionError` (friendly-mapped) instead of a silent blank; abort-before-first-token and all-`<think>`/fence-echo empties stay the benign silent-empty (`receivedAnyToken`/`caughtAbort` narrowing). |
| **CB-5** | LOW | S5 `b38f819` | **fixed** — `readChatSSE` races each read against a two-phase idle watchdog (`PREFILL_IDLE_MS` 120 s → `STREAM_IDLE_MS` 30 s; reasoning deltas reset it) → `RuntimeUnresponsiveError` on a hung sidecar; a user Stop still wins first. Post-response streaming only. |
| **CB-6** | LOW | S4 `b5c46cb` | **fixed** — `buildTurnFence` sizes the fence via a new `LIMIT 1` `getLatestMessage` twin instead of paging the whole history; `generateAssistantMessage` reads `getSettings` once (threaded `compactionOn` default param). |
| **CB-7** | LOW | S5 (deferred) | **DEFERRED — decision #1.** Per-token IPC batching NOT implemented: the renderer already coalesces re-renders (the flush timer), the residual is a structured-clone of a short string, and batching would add a lifecycle seam to the safety-sensitive stream teardown for an unmeasured gain. Revisit only if profiling shows contextBridge volume is a real bottleneck. Docs note in the streaming record. |
| **CR-1** | MED | S2 `6e89879` | **fixed** — draft restored on a pre-persist send failure (`stream` returns whether the user turn persisted; `restoreDraft` = `setInput((cur) => cur === '' ? text : cur)`, newer in-flight typing wins), never on a stopped-but-persisted turn. |
| **CR-2** | MED | S2 `6e89879` | **fixed** — `key={activeId ?? 'new'}` remounts `Transcript` per conversation (resets `atBottomRef` + `scrollTop`, mount effect re-pins); keyed on `activeId` (not `messages`) so refresh/streaming reattach keep the key stable and `React.memo` still skips on the hot path. |
| **CR-3** | LOW-MED | S2 `6e89879` | **fixed** — a second attach is blocked while one is pending (`\|\| pendingImport != null`) + the composer paperclip withheld, so the first import's watcher is never orphaned. |
| **CR-4** | LOW | S2 `6e89879` | **fixed** — the recovery tick's completed branch honors the stop flag (`chat.stopped` toast; ref reset makes a StrictMode double-invoke a no-op) — the recovered path has no local `stream()` finally. |
| **CR-5** | LOW | S2 `6e89879` | **fixed** — `stream` branches on the conversation's own mode (`conversations.find(convId)?.mode ?? mode`), so a reattach whose `listConversations` failed still routes a documents send through `askDocuments`. |
| **CR-6** | LOW | S2 `6e89879` | **fixed** — `useEffect(() => setError(null), [activeId])` placed before the history-load effect clears a stale banner on switch/delete/mode-deselect. |
| **CR-7** | LOW | S2 `6e89879` | **fixed** — the sibling `activeIdRef.current === convId` stale-response guard added to the three switch-time loads (history, `refreshContextInfo`, `refreshAttachments`). |
| **CR-8** | LOW | S2 `6e89879` | **fixed** — `ensureConversation` deletes `depths['new']` alongside the SKA-18 skill re-key, so a 'new'-composer depth pick doesn't become every later new chat's default. |
| **CR-9** | LOW-MED | S2 (latent) | **LATENT-HARDENED — decision #2.** `onStop` targets `streamConvId ?? activeId` — byte-equivalent today (ConversationList `disabled={streaming && !active}` + `busyStreaming` guards ⇒ `streamConvId === activeId` wherever Stop renders). Adopted as future-proofing; the reachability argument is recorded (T-2 pins the invariant) so the disabled-row guard is not relaxed unchecked. |
| **CR-10** | LOW | — (accepted) | **KNOWN / ACCEPTED — out of scope.** The un-virtualized transcript + full-parse-on-first-open is the deferred **chat half of PERF-2** (docs half closed, §36). Kept as Low with `content-visibility: auto` as the cheap first step if it ever bites. |
| **DB-1** | MED | S1 `c3b4ffc` | **fixed** — the `collection` case of `fileDocumentByDestination` FK-guards (existence check + try/catch, degrade to `fileIntoLibraryIfUnfiled`), making it total so the `pending_destination_json = NULL` clear (moved to a `finally`) always runs — no more perpetual re-index wedge. |
| **DB-2** | MED | S1 `c3b4ffc` | **fixed** — the `.parse-preview` / `.parse-export*` transients are unique per call (`…-${randomUUID()}${ext}`, `.parse` infix kept for the crash sweep), so concurrent same-doc readers never decrypt-into/shred a shared path. |
| **DB-3** | LOW | S1 `c3b4ffc` | **fixed** — the `listDocuments` stuck-row sweep is gated on `!ctx.docTasks?.hasActiveTask()` too, so a live translation-materialize / OCR re-ingest is never flipped to `failed`. **Kept the `now` watermark (decision #3)** — a mid-session lock→unlock strands an import whose `updated_at` is after process start, and only `now` reconciles it (`PROCESS_START_ISO` would wedge it forever). |
| **DB-4** | MED | S6 `76445ab` | **fixed** — `createQueuedDocuments` commits N queue inserts in one `BEGIN…COMMIT` (sizes `statSync`'d outside the txn; no `SELECT *` re-read), replacing N auto-commit INSERTs on the USB-latency DB; `createQueuedDocument` stays byte-identical. **Walk stays synchronous — deferred:** `importDocuments` returns ids synchronously and tests/renderer depend on them, so the directory walk was not moved off the hot handler. |
| **DB-5** | LOW | S6 `76445ab` | **fixed** — `listDocuments` short-circuits the embeddings⋈chunks GROUP BY when no row is `indexed` (the common mid-import poll); covering index already present. **The `document_id` count-map cache was DECLINED (decision #4)** — it needs a wider invalidation surface than the resident-vector cache (chunk writes with no embedding + out-of-band writers), and a stale map surfaces as a user-visible wrong chunk badge / false stale flag. |
| **DB-6** | LOW | S6 `76445ab` | **fixed** — `IMPORT_JOB_CAP = 16`, evicting oldest **done** jobs only (an in-flight job — possibly the oldest on a slow import — is never evicted); a late poll on an evicted id still gets the synthetic `done:true`. |
| **DB-7** | LOW | S6 `76445ab` | **fixed** — `readStoredDocumentText`/`readStoredDocumentBytes` are `async` (`decryptFileAsync` + `await readFile`), so a large encrypted export no longer blocks the main process (completes the PERF-1 convention). |
| **DR-1** | MED | S3 `628d286` | **fixed** — the preview "Show more" updater returns `cur` (not `next`) on id-mismatch/closed-modal, so a late page can't resurrect a closed modal or clobber a doc-task's auto-opened preview. |
| **DR-2** | MED | S3 `628d286` | **fixed** — a monotonic `refreshSeq` choke point gates before both `setDocs` and the selected-prune (`if (seq !== refreshSeq.current) return`), so an out-of-order `listDocuments` can't clobber a newer snapshot and stick. |
| **DR-3** | LOW | S3 `628d286` | **fixed** — the toolbar Refresh `onClick` catches the `listDocuments` rejection into the banner (`friendlyIpcError`). |
| **DR-4** | LOW | S3 `628d286` | **fixed** — per-row `previewLoadingId === d.id` (was a screen-global boolean); this **tightens** `DocRow.memo` (a stable `false` on every other row) and shows the right row as "Opening…". |
| **DR-5** | LOW | S3 `628d286` | **fixed** — all four Import buttons gate on `busy !== null` (label still keys on `'import'`), so a concurrent bulk re-index can't fight the shared `busy` scalar. |
| **DR-6** | LOW | S3 `628d286` | **fixed (a11y)** — archived projects in the section rail get the `active` class + `aria-current`, mirroring active ones. |
| **DR-7** | LOW | S3 `628d286` | **fixed (i18n)** — a failed doc-task's canonical-English error goes through `localizeServerCopy(t, status.error)`. |
| **DR-8** | LOW | S3 `628d286` | **fixed (UX)** — a first-mount `role="status"` spinner (`docs.loading`, en+de) fills the blank-list gap while `docs == null`. |
| **DR-9** | LOW | S3 `628d286` | **fixed** — `formatSize` gains a GB tier (locale decimals unchanged). |
| **D-1** | MED | S5 `b38f819` | **doc fixed** — `architecture.md` context-budget wording → `effectiveContextWindow(runtime, getSettings(db))` (the launched window wins; settings only as fallback). |
| **D-2** | MED | S5 `b38f819` | **doc fixed** — same one-phrase correction in `rag-design.md`. |
| **D-3** | LOW | S5 `b38f819` | **doc fixed** — the in-flight `AbortController` map is `inFlightStreams` in `ipc/inflight.ts` (shared with the RAG channel), not `registerChatIpc.ts`. |
| **D-4** | LOW-MED | S5 `b38f819` | **doc fixed** — new "Deterministic teardown (R1)" bullet: `streamSettled` / `awaitInFlightStreamsSettled` + the abort-first-then-await-then-close-DB contract, plus the CB-2/CB-4/CB-5 sentences. |
| **D-5** | LOW | S6 `76445ab` | **doc fixed** — the docs-IPC enumeration replaced with a single-source pointer to `shared/ipc.ts` (docs group), naming the notable families. |
| **D-6** | LOW | S7 (this) | **doc fixed** — the chat-IPC enumeration replaced with a single-source pointer to `shared/ipc.ts` (chat group), noting `suggestSkills` is registered by the **skills** IPC (`registerSkillsIpc`), not `registerChatIpc`. |
| **T-1** | HIGH (cov) | S2 `6e89879` | **tests** — renderer stream-recovery (`ChatStreamRecovery.test.tsx`): live bubble + locked composer + refresh-on-completion (folds CR-4), fresh-mount re-select + documents-mode mirror (folds CR-5), user-click-not-yanked. |
| **T-2** | MED | S2 `6e89879` | **tests** — mid-stream conversation switch + Stop target (`ChatSwitchStop.test.tsx`): the non-active row is `disabled`, Stop aborts the streaming conversation — the invariant that keeps CR-9 safe. |
| **T-3** | MED | S7 (this) | **tests** — docs-IPC guard preconditions (`docs-ipc.test.ts`): a gated embedder parks a doc in `processing` → delete/reindex/preview all reject `/still being processed/`; a `docTasks.isDocumentBusy → true` variant → delete/reindex reject `/task is running/i` with a **negative control** that preview resolves (pins the asymmetry). |
| **T-4** | MED | S7 (this) | **tests** — import-loop lock-mid-job break (`docs-ipc.test.ts`): a custom ctx whose `isUnlocked` flips false inside the first file's embed → job `done`, `completed===1`, f1 non-terminal (raw SELECT), lease balanced; then backdate + unlock → `listDocuments` reconciles f1 → `failed`. **Teeth revert-confirmed** (drop the drain's `processing.delete` → f1 stays `embedding`). |
| **T-5** | LOW | S5 `b38f819` | **tests** — compaction boundaries (`chat-compaction.test.ts`): region `=== MIN_COMPACTABLE_TURNS` proceeds vs `MIN−1` returns; size `=== threshold` proceeds vs `threshold−1` against the CB-3 `min(0.85·window, window−reserve)`. |
| **T-6** | LOW | S7 (this) | **tests (de-mock)** — `ChatUnmount.test.tsx` drops the `clearTimeout(<exact id>)` spy for a behavioral assertion (advance past `STREAM_FLUSH_MS`, no setState-after-unmount warning) — refactor-robust across a `clearTimeout`→`mountedRef` change; keeps the (b) `listDocuments`-count assertion. |
| **T-7** | LOW | S7 (this) | **tests (de-flake)** — the `cancelReindexAll` test now gates the embedder per file (park the first re-embed, cancel in flight, release) for a deterministic `completed === 1` instead of racing the clock; non-racy poll ceilings bumped (`runImport` 200→400). |
| **T-8** | LOW | S7 (this) | **tests** — chat export handlers (`chat-ipc.test.ts`, electron mock extended with `dialog`+`BrowserWindow`): `exportConversation` sanitizes the defaultPath (`Report: Q1/Q2 <draft>` → `Report Q1Q2 draft.md`), returns null-on-cancel (no audit), audits `{conversationId}` only (no title/path leak); `exportMessageTable` static `table.csv` + null-on-no-table. **Teeth revert-confirmed** (weaken `safeName` → the `/`-bearing path reddens). |

**§-anchor legend (keeps the `CB-n` / `CR-n` / `DB-n` / `DR-n` / `D-n` / `T-n` code/test/doc citations
resolvable after the report + plan were retired).** In-code comments, tests, and BUILD_STATE cite these
findings by the bare id (sometimes qualified `Chat & Documents audit 2026-07-07 <id>`); all resolve to the
table above. The design "as built" lives in the per-session §-records this wave added, which carry the
same ids:
- **Chat backend (CB-1, CB-6)** — the "History fits the context window" bullet (user-first normalization +
  `getLatestMessage` LIMIT-1 tail read + single `getSettings`).
- **Chat backend robustness (CB-2…CB-5, CB-7)** — the streaming/cancellation record's "Deterministic
  teardown (R1)" bullet (CB-2 restore, CB-4 `EmptyCompletionError`, CB-5 watchdog, the
  `runtimeUnresponsive → emptyCompletion → overflow → raw` friendly chain, the CB-7 deferral) + the
  L2-compaction bullet's CB-3 cap/fold-in note.
- **Chat renderer (CR-1…CR-9)** — the "Stream recovery across navigation" record's "FE audit 2026-07-07 —
  Chat renderer correctness" bullet (CR-9 reachability + CR-2 rationale). CR-10 is the accepted PERF-2
  chat half (§36 / Already-known).
- **Documents renderer (DR-1…DR-9)** — the FE record's "Documents renderer polish (DR-1…DR-9)" bullet
  (DR-4 tightens `DocRow.memo`, DR-2 reduces spurious swaps).
- **Documents backend (DB-1…DB-7)** — the doc-organization reliability/perf record: the §4 DB-1
  FK-guard/`finally` + DB-3 task-gate/`now`-watermark note, the `extractDocumentPreview` `.parse-preview`
  DB-2 note, and the "Documents backend performance — Session 6 (DB-4…DB-7)" bullet (batch + walk-deferral,
  the DB-5 decline-the-cache decision, DB-6 evict-done-only, DB-7 async decrypt).
- **Docs (D-1…D-6)** — folded into the cited sentences: the context-budget wording (D-1/D-2), the
  `inflight.ts` + R1 teardown bullet (D-3/D-4), and the docs-/chat-IPC single-source pointers to
  `shared/ipc.ts` (D-5 §above / D-6 in the Chat & streaming IPC bullet).

Report + plan retired: `git rm docs/chat-docs-audit-2026-07-07.md docs/chat-docs-remediation-plan-2026-07-07.md`
(recoverable in git history; the full finding bodies + fix designs + the per-session SHIPPED dispositions
live there, and in the seven `BUILD_STATE.md` Session entries dated 2026-07-07/08). This ledger is the
durable index; the only open item is the owner push of the whole unpushed local-`master` wave (Sessions
1–7).

### §46 Full audit (2026-07-10) — remediation ledger + close-out

A five-pass full audit (backend correctness · renderer · security/supply-chain · performance · test
suite, baseline `fa846cf` = the v0.1.46 bump, suite 3956/47) plus a parallel documentation audit swept
the whole repo. It found **0 Critical**: one High code finding (BE-3) and two High doc findings
(DOC-101/102) over a Medium/Low tail — **BE-1…BE-7 · RD-1…RD-6 · SC-1 · PF-1…PF-8 · TS-1…TS-9 ·
DOC-101…DOC-112** (43 ids). Remediated across a **14-phase wave committed directly to `master`**
(P1 `16ccbbc` → P13 `19dfbc9`; P14 = this close-out), suite **3956 → 4024/47**, typecheck + build
green throughout. The audit's headline negative results are worth recording: **the hard rules
verified clean** — every `fetch`/`net` site is a loopback sidecar client or the single gated
downloader, the offline guard is intact, no telemetry/analytics/crash-reporting anywhere in the
dependency tree, and the Electron hardening + S1 log policy hold. And **every prior ledger residual
re-verified accurate** — PERF-2/PERF-5B, the P4b/P4c triggers (still unmet), the DB-5 decline, DB-8,
the E5-prefix ceiling and the §26/§34/§40 carried items all still match their recorded rationale
(carried PERF-5 is the one item this wave CLOSED, via PF-7c).

**This record is the only durable artifact of the round.** Unlike prior audits, the full report, the
docs-audit report, and the remediation plan were **uncommitted working papers for their whole life
and were deleted (plain `rm`, never tracked) at this close-out — there is no recoverable copy in git
history.** Finding detail survives as: this table, the dated 2026-07-10 `BUILD_STATE.md` phase
entries, and the phase commits.

Per-finding disposition (fixed → phase@commit / deferred·watch → where registered):

| # | Sev | Phase | Disposition (decision / mechanism) |
|---|---|---|---|
| **BE-1** | MED | P2 `7a1b61a` | **fixed** — settings write-gate holes closed: `null` rejected unless the key's default is null (a `{checksumCache: null}` patch used to brick every checksum reader until row repair), the five null-default keys shape-checked when non-null (bounded strings for ids/`gpuLastError`, plain objects for `lastBenchmark`/`gpuProbe`), `registerCoreIpc` rejects a null/non-object patch up front with friendly copy, and the hash-store reader degrades a pre-fix corrupted row to a cache miss. The `rag*` numeric knobs stay deliberately unclamped (open item, BUILD_STATE §5). |
| **BE-2** | MED | P3 `57d205b` | **fixed** — download jobs no longer pin a raw DB handle across a multi-hour run (a workspace lock used to flip a COMPLETED download to `failed`, losing the #40 activation + the audit event): checksum-cache faults can't change job outcome, and `createSettingsHashStore` takes a live-handle **getter** with an in-memory degrade. Recorded policy: **downloads keep running through a workspace lock** (weights live outside the vault). |
| **BE-3** | HIGH | P1 `16ccbbc` | **fixed** — German COVERAGE/SUMMARY/COMPARE router regexes: verb stems sat behind a trailing `\b` (never matched inflections — "Auflistung", "Zusammenfassung", "Vergleiche") and ASCII `\b` never matched before "Überblick", so realistic German list/count questions silently took top-k partials and the #38 deep-index hint never fired. Stems now follow `AGGREGATION_RE`'s documented rule (leading `\b` only); inflected-DE table + EN byte-identical controls pin it. |
| **BE-4** | LOW | P3 `57d205b` | **fixed** — `cancel()` also acts in `verifying` (the minutes-long SHA-256 over a multi-GB weight was silently uncancellable and a two-file job started its next file); abort re-checked after the hash and between tasks; `.part`-retention/resume contracts unchanged. |
| **BE-5** | LOW | P4 `47a9e62` | **fixed** — the no-runtime `getContextTokens` fallback now mirrors the next start's real precedence through the ONE shared `launchContextTokens(settings, manifest)` helper, so `maybeEnqueueTreeBuild` plans against the actual 32k+ window instead of the legacy 4096. |
| **BE-6** | LOW | P4 `47a9e62` | **fixed** — `buildTree` also yields at the top of each level (the in-level yield skipped every level's LAST node, making the chat-slot worst case ≈ two nodes vs the documented "≈ one"); hoisted outside the #41 re-pack retry so a retry can't double-yield; arbiter test pins the level-boundary park. |
| **BE-7** | LOW | P3 `57d205b` | **fixed** — `onModelInstalled` also replaces a `startFailed`-latched translator (new `isStartFailed()`; a latched instance is lazy/dead, no child to orphan), unblocking the delete-and-re-download repair without a restart; the never-replace-a-LIVE-sidecar rule holds. |
| **RD-1** | MED | P8 `b7d93e8` | **fixed** — first send of a just-created conversation: a racing `listMessages` used to resolve `[]` after the optimistic append and wipe the user's bubble for the whole first answer; the history load now skips exactly one fetch for a conversation id this instance just created (characterization test written first, watched fail). |
| **RD-2** | LOW | P8 `b7d93e8` | **fixed** — `SkillRunTarget.name` is `string \| null` (placeholder applied at render time), so `confirmFormatKey` genuinely falls back to the output-matrix line for an unresolved target instead of asserting ".txt" for a possibly-`.docx` source. |
| **RD-3** | LOW | P8 `b7d93e8` | **fixed** — `recommendedContextTokens` locale-formatted at the second Models site; DE `models.tech.contextValue` "Tokens" → "Token". |
| **RD-4** | LOW | P8 `b7d93e8` | **fixed** — a non-preset `contextTokensOverride` renders a synthetic selected `<option>` so the context-size select never shows blank. |
| **RD-5** | LOW | P8 `b7d93e8` | **fixed** — the ModelsScreen mount-refresh `.catch` gains the file's one missing `mountedRef` guard (FE-4 discipline). |
| **RD-6** | LOW | P8 `b7d93e8` | **fixed** — `confirmTool` is cleared once its tool leaves `runnableTools`, so a pending confirm can't outlive its offer row and re-open (teeth revert-confirmed). |
| **SC-1** | LOW | P13 `19dfbc9` | **fixed + watch** — all five third-party actions in `release.yml`/`ci.yml` SHA-pinned from their exact tags (+ `# vX.Y.Z` comments), the repo's `cla.yml` idiom; no other workflow semantics changed. **Watch: owner-observed validation on the next tag/`workflow_dispatch` run** (the packaging tests don't execute workflows). |
| **PF-1** | MED | P7 `01ae6be` | **fixed** — the StreamAnnouncer sentence-boundary scan starts at the previous announce point (with a terminator-class backup that provably re-syncs) instead of index 0 per ~40 ms flush — O(n²) → O(n) per answer; a 300-flush oracle test pins byte-identical announcements against the old whole-buffer implementation. |
| **PF-2** | LOW-MED | P7 `01ae6be` | **fixed** — the live word meter advances incrementally per flushed chunk (`endedInWord` carries mid-word chunk boundaries) instead of re-splitting the whole growing answer; equivalence-tested per-flush against the old `split`-based count. |
| **PF-3** | LOW-MED | P7 `01ae6be` | **fixed** — `idx_runtime_events_created` added on the ensure-on-open path; the audit-log prune is slack-gated (`AUDIT_MAX_ROWS` 5000 + 250, prune back to the cap) and runs in ONE transaction with its insert; `recordEvent`'s never-throws contract kept. |
| **PF-4** | LOW | P11 `c453f6d` | **fixed** — ONE manifest walk+parse per `composeServices` pass feeds all role resolvers (was five synchronous walks in `initBackend` before the window exists); deliberately NO stateful cache — per-action IPC callers stay fresh (real-discovery walk-count test). |
| **PF-5** | LOW | — | **watch-item** — `listDocuments` is load-all with an unindexed `created_at` sort; fine at ≤~1k documents, multi-MB IPC payload at ~10k. Registered in `known-limitations.md` (documents-list bullet); revisit together with the DB-8 `ocr_json` projection migration when a library approaches that scale. |
| **PF-6** | LOW | P12 `46d14ec` | **fixed (−20.5%)** — six screens route-level lazy behind the per-screen ErrorBoundary (Documents/Settings/Models/Images/Skills/Translate); init bundle 1,255 → 998 kB. The audit's −30% aspiration is unreachable screens-only: Chat stays deliberately eager (lazy Chat would de-facto split the shared chat components) and the ~290 kB i18n catalogs are excluded by design — both reserved as separate decisions. |
| **PF-7** | LOW | P11 `c453f6d` | **fixed (a–d)** — (a) Home runtime poll gates on value change + stops once running (focus re-arm); (b) doctasks store ports the `sameRun`-style no-change gate; (c) visionSession batches token notifies through a 40 ms flush + the `useEventCallback` sweep over ImagesScreen handlers — **closes carried-forward PERF-5** (2026-06-30 ledger row marked); (d) ScopePopover memoizes its list derivations. |
| **PF-8** | LOW | — | **watch-item** — the resident vector cache at the 1M-chunk bound is a RAM problem (~1.8 GB resident), not just scan time; the P4b worker fixes blocking, not residency. Folded into the P4b deferral record (above) so the residency axis is part of the P4b design when its ">100 ms routinely" trigger fires. |
| **TS-1** | MED | P10 `9f044d8` | **fixed** — fixed-sleep sweep: the six remaining raw sleep sync points converted to deterministic gates (`reached()` probes, `seenSignal` polls, a positive-control sentinel, an empty-`act` flush); every surviving sleep comment-justified; full suite run 3× — zero flakes; CONTRIBUTING gains the no-fixed-sleeps rule. |
| **TS-2** | MED | P9 `d6846d1` | **fixed** — webPreferences flags, prod/dev CSP, and the window-open policy extracted verbatim to `window-security.ts` and pin-tested by name/value (a deliberate `sandbox: false` reddens — verified + reverted); a source-level scan keeps the literals from being re-inlined at the call sites. |
| **TS-3** | MED | — | **deferred → owner design** — the real-model quality gate is human-remembered (opt-in `HILBERTRAUM_*` runs), not mechanical; the proposed release-workflow smoke-record gate (fail unless a smoke record is newer than the last model/runtime-affecting commit) needs the owner's design call. Registered in BUILD_STATE §5. |
| **TS-4** | LOW | P9 `d6846d1` | **fixed** — `stubApi` caches ONE spy per accessed name (stable identities), warns once per unmocked name actually called, and exposes opt-in `assertNoUnexpectedApiCalls()`; renderer-tier sweep found zero fresh-spy reliance. |
| **TS-5** | LOW | P9 `d6846d1` | **fixed** — EXPLAIN QUERY PLAN assertions match index NAMES, never planner phrasing (the Node-pinned-SQLite coupling is commented); the teeth counterfactuals kept. |
| **TS-6** | LOW | P13 `19dfbc9` | **fixed** — optional `test:coverage` (v8 provider, `@vitest/coverage-v8` devDep) + root passthrough; deliberately not CI-wired, no threshold; `coverage/` gitignored; documented in CONTRIBUTING. |
| **TS-7** | LOW | — | **deferred → owner call** — no macOS CI leg despite first-class macOS support and a history of cross-platform path bugs; a `macos-latest` entry is cheap (the suite is offline and Electron-binary-free) but costs CI minutes. Registered in BUILD_STATE §5. |
| **TS-8** | LOW | P13 `19dfbc9` | **fixed** — the screenshot harness polls a per-case READY condition (fonts + per-case selector + brand-`img` complete) with the old 1.8 s/4.5 s settles kept as timeout ceilings; 11-case walk 19.3 s, captures verified. |
| **TS-9** | LOW | — | **known-open (registered)** — the S13a suggestion-selector eval tier measures and prints its baseline without a hard bar (ratification pending owner D1); the AUTO-FIRE precision bar IS a live CI gate. Registered in BUILD_STATE §5 so it doesn't silently become permanent. |
| **DOC-101** | HIGH | P5 `0fba6d0` | **fixed** — the 2026-07-01 download-posture flip propagated to the four lagging docs (model-policy's canonical gate section, packaging, troubleshooting, user-guide ×3) + one architecture clause + the `policy.ts` comments; duplicated gate re-tellings replaced by pointers to the canonical model-policy section. |
| **DOC-102** | HIGH | P5 `0fba6d0` | **fixed** — user-guide §7 "ten" translation languages → **51** (defers to §7a's list). |
| **DOC-103** | MED | P5 `0fba6d0` | **fixed** — Translate activates as soon as the download finishes (#40); the transcriber/reranker/embedder restart requirement is now stated instead. |
| **DOC-104** | MED | P5 `0fba6d0` | **fixed** — "local logs are not encrypted" corrected: the diagnostics log is `app.log.enc` under the vault key; model files are public weights, not user data. |
| **DOC-105** | LOW | P6 `437e63c` | **fixed** — the three architecture spots presenting the curated 10-language set as current each gained the append-only "(widened to 51 by issue #31 — see D5/#31b)" pointer. |
| **DOC-106** | MED | P6 `437e63c` | **fixed** — bundled-skill count "eight" → **nine**; `document-edit` added to the drive-layout + README lists. |
| **DOC-107** | MED | P6 `437e63c` | **fixed** — the orphaned `L-2`/`L-3` finding-ids cited from code now resolve (security-model.md gained the 2026-06-13 low-severity ledger entries); the SEC-4 id overload disambiguated at both sites. |
| **DOC-108** | LOW | P6 `437e63c` | **fixed** — user-guide gains the context-size-picker details, the interface-Language / chat-compaction / Developer-mode sentences, and the #39 warm-up-hint note. |
| **DOC-109** | LOW | P5+P6 | **fixed** — `_Last updated_` stamps refreshed on the five stale docs, each only after that doc was actually verified or edited. |
| **DOC-110** | LOW | P6 `437e63c` | **fixed** — the big-slot plan's reconcile note names the post-dating Qwen3.5 27B/35B manifests as new, unpromoted big-slot-class candidates. |
| **DOC-111** | LOW | P6 `437e63c` | **fixed (item 3 partly INVALID)** — troubleshooting names `app.log(.enc)`; the user-guide import list gains `tsv`; two §-citation drifts re-pointed precisely — but `doctasks/context.ts`'s rag-design §14.5 cite was **verified CORRECT and left unchanged** (the audit's proposed re-point to §14.7 was invalid; §14.5 holds the no-surprise-CPU-spend invariant verbatim). |
| **DOC-112** | LOW | — | **superseded** — the launch working papers' executed-but-unticked checklists resolve with the owner's launch close-out, which deletes the release-readiness paper (tracked by the launch flip checklist, outside this audit). |

Surviving open items were registered where they belong before the reports were deleted: **TS-3, TS-7,
TS-9, the unclamped `rag*` knobs, and the SC-1 pin validation** in `BUILD_STATE.md` §5; **PF-5** in
[`known-limitations.md`](known-limitations.md); **PF-8** in the P4b deferral record above.

**§-anchor legend.** Commits, code comments, tests, and BUILD_STATE cite this audit as
`full-audit 2026-07-10 <ID>` (or the bare id beside a qualified cite); all resolve to the table above.
The design "as built" lives where each phase folded it: the downloader record (BE-2 lock policy, BE-4
cancel-during-verify), `launchContextTokens` in `services/models.ts` (BE-5), the perf design record
(PF-1…PF-4 and the PF-7 wave paragraph, incl. the PERF-5 closure), packaging.md's bundle record (PF-6)
and CI record (SC-1), `window-security.ts` + its CONTRIBUTING bullet (TS-2), CONTRIBUTING's
no-fixed-sleeps rule (TS-1) and coverage invocation (TS-6), and the swept docs themselves
(DOC-101…111, each stamped).

### §47 Full audit (2026-07-11) — remediation ledger + close-out

A nine-pass pre-release audit at baseline `dda1d25` (post issues-#48–#53 wave + launch close-out,
suite 4053/47): post-audit delta, backend core, backend infrastructure, renderer/UI + i18n,
security & data handling, test-suite quality, docs accuracy, performance, and a follow-up gap pass
over the areas the core pass named not-deep-audited (skills runtime, doc-task handlers, ingestion
parsers). It found **0 Critical**: one High code finding (CODE-1) and two High doc findings
(DOC-1/2) over a Medium/Low tail — **CODE-1…CODE-48 · GAP-1…GAP-7 · DOC-1…DOC-13 (+TQ-6, folded
into CODE-9; DOC-12 = CODE-24)**. Remediated across a **ten-phase wave (A–I + this close-out J)
committed directly to `master`** (A `e7cda05` → I `815b3c0`; every phase ran a review round, whose
follow-up fixes are `8884d55`/`ba44a6b`/`9a393ea`/`96e439a`/`234ba35`/`d7787b1`), suite
**4053 → 4165/47** (+112), typecheck + build green throughout. Headline negative results worth
recording: **the dedicated security pass found no new vulnerabilities** (Electron hardening, IPC
validation, downloader, crypto, offline guarantee all verified holding; the known accepted
residuals stand as documented); **the test-suite pass judged the suite trustworthy for a public
release with no systemic over-mocking** (real crypto + real SQLite + injected-boundary fakes with
teeth); performance re-traced clean outside CODE-4/20/21; and every 2026-07-10 (§46) residual was
treated as KNOWN and not re-reported. Owner decisions asked + answered mid-round, all executed:
**GAP-1** provenance survives (SKA-38 honoured), **CODE-31** truthful relabel (emitted scope
unchanged), **CODE-15** and **CODE-16** approved.

**This record is the only durable artifact of the round.** The full report and the phased
remediation plan (`docs/audits/full-audit-2026-07-11*.md`) were uncommitted working papers for
their whole life and were deleted (plain `rm`, never tracked) at this close-out — **there is no
recoverable copy in git history** (the §46 round's handling). Finding detail survives as: this
table, the residuals list below, the dated 2026-07-11 BUILD_STATE §5 item, and the phase commits.

Per-finding disposition (fixed → phase@commit / registered → where; premise corrections and
review-round findings are folded into their rows):

| # | Sev | Phase | Disposition (decision / mechanism) |
|---|---|---|---|
| **CODE-1** | HIGH | B `d8ad526`+`8884d55` | **fixed** — a failed vault lock can no longer silently destroy the session: (1a) `WorkspaceController.lock()` restores a consistent UNLOCKED controller on re-encrypt failure (ENOSPC-realistic) — plaintext DB re-opened, key kept for retry, typed content-free `VaultLockError` → friendly `main.workspace.lockFailed` EN+DE + a `workspace_lock_failed` audit event (pairs with the before-lock `workspace_locked` entry as attempt+failure); (1b) init()'s crash sweep salvages instead of shredding a plaintext working file bearing the **failed-lock signature** — newer-than-`.enc` mtime **+ no live `-wal`/`-shm` + valid SQLite header** (the report's mtime-only spec was tightened: bare mtime matches EVERY mid-session crash leftover, and rolling a torn file forward would replace the intact stale `.enc` with garbage) — moved aside as `<db>.recovery` and rolled forward at the next unlock; `WorkspaceController.shutdown()` clean-closes the reopened DB after a failed quit-lock so the disk rests salvageable. Review follow-up `8884d55` (F1): the unlock roll-forward re-guards `.recovery` (header + strictly-newer-than-`.enc`) — a spent snapshot that outlived its best-effort shred (Windows AV/indexer) could otherwise silently roll the vault BACK on every later unlock or encrypt shred-garbage over the good `.enc`. NO on-disk format change (VAULT_VERSION/envelope untouched). Residual **F3** (accepted): a failed INTERACTIVE lock + immediate hard kill still shreds (the reopen recreates `-wal`/`-shm`) — a double failure inside the now-RECORDED power-cut trade-off; **F4** no-action: a throw at `db.close()` itself would leak one handle for the session (practically unreachable, self-heals). Docs: security-model "Lock failure & durability" (records the previously-undocumented mid-session power-cut trade-off AND the plaintext-`.recovery` confidentiality trade), troubleshooting "Could not lock". |
| **CODE-2** | MED | C `82d18dd`+`ba44a6b` | **fixed** — quit/"Lock now" no longer waits out an uncancellable model start (20 GB GGUF / failing ladder ≈ minutes): the manager tracks the in-flight `startingRuntime` and `stop()` cancels it; `LadderRuntime` gains a permanent `cancelled` flag — aborts between rungs, stops the in-flight rung's server so `waitForHealthy` unblocks via its exit-check throw (never a bare timeout race), never persists `gpuAutoDisabled` for a killed attempt, refuses the mock fallback for a cancelled start; a cancel landing in `LlamaServer`'s pre-spawn window is covered by the ladder's post-start re-check; queue semantics unchanged (stop still runs after start settles — it just settles promptly). Residual (registered): a SECOND start still QUEUED behind the in-flight one (triple overlap: switch, switch again, lock) is out of the cancel's reach on the interactive-lock path — the QUIT path is fully covered by CODE-3's latch re-checks; epoch/counter machinery to cancel queued-but-unstarted ops deliberately not added. |
| **CODE-3** | MED | C | **fixed** — `RuntimeManager.shutdown()` permanent latch (the `TranslationRuntime.stopped` pattern), armed as `performShutdown`'s FIRST act (ordering pinned at index 0); once armed, `start()`/`forceRestart()` reject without invoking the factory, `doStart` re-checks at its top AND — review follow-up `ba44a6b` — again after its internal model-switch `doStop()` (a seconds-long window the top check + the CODE-2 cancel both missed: `startingRuntime` not yet set, factory would spawn and the quit's queued stop waited out the full load), and `startModelRuntime` re-checks after its multi-GB weight hash (the background-auto-start window). |
| **CODE-4** | MED | D `6136569`+`9a393ea` | **fixed (Option 1; measured 123×)** — FTS5 delete triggers rowid-targeted: nullable `fts_rowid` handle column on `chunks`/`messages`, AI triggers stamp it via `last_insert_rowid()` (probed: reflects the trigger's own FTS5 insert), AD/AU delete `WHERE rowid = old.fts_rowid` — O(log N) (EQP idxStr `0:=`) instead of a per-row full shadow-table scan (`0:`; EQP prints "SCAN" for BOTH shapes — the idxStr is the discriminator). WHEN-split `_legacy` NULL-fallback twin triggers keep legacy-row correctness incl. under a rolled-back binary (a constant conjunct on a virtual-table scan is evaluated per row — no plan-time short-circuit); compaction checkpoint rows park at NULL and are excluded from the legacy AD scan (R8/DATA-1 semantics preserved; `au_legacy` deliberately keeps firing for kind transitions). Reproduced 3578 ms → 3.3 ms for the 250-chunk delete on the 50k fixture. One-time idempotent migration `ensureFtsRowidSync` + single-scan `backfillFtsRowids`; review follow-up `9a393ea` made it **crash-atomic** (DROPs + CREATEs + backfill in ONE transaction) and **self-healing** (sentinel flipped to `row?.sql.includes('fts_rowid')` — a MISSING AD trigger means "must upgrade"; DROP-IF-EXISTS DDL makes the re-run safe against any torn state): a kill mid-upgrade could otherwise tear the trigger set permanently (deletes silently stop maintaining the index → ghost hits) or lose the backfill (corpus parked on the scan path forever). Registered observation (pre-existing, no action): the fresh-create `ensureChunksFts`/`ensureMessagesFts` share the non-atomic exec shape — the flipped sentinel now self-heals their torn TRIGGER states; a torn FTS-content backfill there remains unrepaired, as before. Docs: rag-design §11 "Trigger sync is rowid-targeted". |
| **CODE-5** | MED | E `7f5d291` | **fixed** — `retrieveCompareDiff` budgets `changesText + redlineText` JOINTLY (top-level check + `fitChangesToBudget`'s fit test); over budget the redline drops FIRST, the load-bearing change list only shrinks after (the doctask mode-d precedent) — closes the ~2×-budget #41 context-exceeded class on the primary version-compare route. rag-design §14 mode-d note. |
| **CODE-6** | MED | F1 `b7bbaac` | **fixed** — doctasks store ports the skillruns SKA-40 tolerance: `MAX_POLL_FAILURES = 3` consecutive-failure counter (any success resets), below the max the task/snapshot stays untouched, at the max polling stops and the task is KEPT flagged `stateUnknown` instead of `setActive(null)` (one transient poll rejection used to vanish the busy/Cancel UI mid-run and un-gate every task button). F2 rider (`9b4df23`): DocRow renders the labelled `docs.task.stateUnknown` row + Dismiss (the SkillRunBar treatment) via screen-owned `onDismissTask` → `acknowledgeDocTask()`. |
| **CODE-7** | MED | F1 | **fixed** — `SettingsScreen.patch` try/catch + `settings.saveFailed` toast (EN+DE) + mountedRef; on failure the controls keep showing the server's last-confirmed values. Registered nit: the blanket mounted-guard also skips the GLOBAL theme/language apply when the IPC reply lands post-unmount (persisted server-side, applied on next settings read; millisecond window) — candidate narrowing to the local `setSettings` only. |
| **CODE-8** | MED | G `43b6f7e` | **fixed (premise corrected)** — `.one/.other` pairs + `tCount` for the five non-pluralized `{count}`/`{done}` strings EN+DE (DE adjective endings; `docs.reindexAllDone`'s `{done}` → `{count}`), all five call sites converted. The report's "common single-failure case" is UI-unreachable for the confirm titles today (the toolbar buttons are `length > 1`-gated) — pairs landed anyway (defense-in-depth; the toast's singular IS reachable via mount-adoption of a total=1 job, pinned RTL). Plus the **catalog-hygiene net**: a static scan failing any new plain-`t('` consumption of a counting key without `.one/.other` siblings (reviewed non-grammatical allowlist; NUL-tolerant read; dynamic-expression keys out of static reach by design — acceptable for a regression net). The net flagged `diag.bench.cores` "(1 cores)" — same class, not in the finding list: allowlisted + registered, one-pair fix on the next i18n pass. |
| **CODE-9/TQ-6** | MED | I `815b3c0` | **registered (release checklist)** — the real llama-server wire contract + composite quality/perf behaviors live ONLY in env-gated manual smokes (the mock never emits `reasoning_content`, always finishes `stop`); the concrete (a)–(g) inventory — real SSE wire contract / real-model+RAG answer quality / `ragMinSimilarity` vs the real E5 distribution / server concurrency / per-model bring-up + template leak / all perf numbers / real GPU behavior — is pasted into BUILD_STATE §5's TS-3 bullet so CI-green is never mistaken for evidence there; both SSE fixture files carry b9849 provenance comments ("re-verify on pin bump"). The mechanical smoke-record gate remains the §46 TS-3 owner design item. |
| **CODE-10** | LOW-MED | B | **fixed** — `encryptFile`/`encryptFileAsync` fsync the frame BEFORE the atomic rename (the `writeVaultDescriptor` idiom) — covers lock, create, rekey staging and sidecar writes in one place; fs-wiring pins with teeth via `vi.mock('node:fs')` in a dedicated file (test-infra lesson below). |
| **CODE-11** | LOW-MED | C | **fixed** — module-level sidecar child-PID registry (registered/deregistered at both spawn funnels: `LlamaServer` + `WhisperCliTranscriber`); the `uncaughtException` handler best-effort SIGKILLs every registered child after the vault lock (throw-safe per PID) — a crash exit no longer strands up to five llama-servers on Windows. Accepted residual (GPU record §5.6): a crash that bypasses `uncaughtException` itself still orphans. |
| **CODE-12** | LOW | C | **fixed** — `invalidateBinaryVerification(binPath)` evicts the binary-verifier's session-cached verdict after `installOne` writes the fresh marker; repair-after-tamper no longer stays refused (silent MockRuntime) until app restart. |
| **CODE-13** | LOW | C | **fixed** — engine `cancel()` honours `verifying`/`extracting` (post-verify, post-extract-before-marker, and between-family abort re-checks; the downloads.ts BE-4 mirror, new injectable `verifyImpl` seam); an engine job that would rimraf the LIVE chat family's dir is refused while a model runtime runs — review follow-up `ba44a6b`: via `chatEngineInUse()` (running OR `status().startingModelId` in flight), since `activeModelId()` alone is null during a multi-GB START whose loading child already executes from the dir. Registered residuals: a model started while an engine download is ALREADY in flight can still race the pre-clean rimraf (pre-existing exposure, now narrower); a cancel DURING extraction deliberately leaves a fully-verified marker-less binary (self-heals — `runtimeInstallCurrent` false, next install re-runs; pre-spawn verifier treats it `skip-legacy`); the guard does not exempt a MOCK-backed runtime, so a user with no engine yet is refused the FIRST install with the while-running copy (safe-side; polish candidate: exempt `status().backend === 'mock'`). |
| **CODE-14** | LOW | B | **fixed (spec corrected)** — fresh-vault creation stages the new DB as `.enc.new` and writes the descriptor LAST as the single commit point (the rekey-journal ordering): crash-before → neither artifact exists → `uninitialized`, onboarding retries cleanly; crash-after → the existing `recoverPendingRekey` rolls forward. The report's literal ".enc first, descriptor last" would have bricked differently — an orphan `.enc` without a descriptor reads as `locked` (the H4 wipe-guard, correctly). |
| **CODE-15** | LOW | I | **fixed (owner-approved)** — persistent checksum-cache keys are drive-RELATIVE (forward-slash `driveRelKey`; `createSettingsHashStore(getDb, rootPath?)`), (size, mtime) validity unchanged, lazy-migrate-on-miss from the legacy absolute key + orphan cleanup on set/delete; `rootPath` threaded through all **five** call sites (the report/plan said 3 — `registerModelIpc` ×3, `registerDownloadIpc`, `vision/status`; a partial wiring would have re-hashed via one path and migrated via another). Drive-letter move now zero-recompute (tested). Rootless construction keeps absolute keys verbatim (escape-guard belt, not a behavior change). known-limitations' "trusts size+mtime" bullet deliberately unchanged — the documented limitation is unaffected and it never claimed absolute-path keying. |
| **CODE-16** | LOW | I | **fixed (owner-approved)** — `MAX_SETTINGS_OBJECT_BYTES = 256 KB` serialized-JSON cap for `checksumCache`/`lastBenchmark`/`gpuProbe` + array-reject for the object-default `checksumCache` (SEC-1 bounding style); the block sits after the null-default chain because `checksumCache` has a non-null object default; legitimate `null` clears pass upstream untouched. Four write-gate pins. |
| **CODE-17** | LOW | E | **fixed** — conversation auto-title truncation is code-point-safe (the `truncateSnippet`/RAG-2 idiom); no more `�`-tailed persisted titles. |
| **CODE-18** | LOW | E | **fixed** — the R1 abort+closed-DB persist guard extracted into shared `persistAssistantMessage` (chat.ts) and applied at ALL FOUR persist sites (plain chat + rag/index.ts ×2 + whole-doc-tree.ts) — the grounded Stop+lock race now drops the partial quietly instead of erroring. Registered residual: `generateGroundedAnswer`'s canned NO_DOCUMENT_CONTEXT/REINDEX early return (~:1608) still persists via raw `appendMessage` — the one remaining unguarded site; much narrower window (no model stream to park in); fix-when-touched. |
| **CODE-19** | LOW | E | **fixed (+rider)** — the compaction region boundary is exchange-aligned (walks back to end on an ASSISTANT turn), so an odd compactable count no longer replaces the synthetic ack via `collapseToAlternating`. Rider (a Phase-D fixture discovery, FIXED here): `deleteLastAssistantMessage` AND `hasRegenerableAssistantReply` now exclude `kind='compaction'` rows — a checkpoint at the conversation tail can no longer be deleted by a regenerate; both queries look at the last VISIBLE message. |
| **CODE-20** | LOW | D | **fixed** — `addToCollection`/`removeFromCollection`/`setDocumentsLifecycle` loops run in ONE `BEGIN…COMMIT/ROLLBACK` (`runBatch`; one USB fsync per batch AND all-or-nothing — three poisoned-id tests watched red first); rider: `insertQueuedRow`'s constant INSERT hoisted to `prepareCached`. |
| **CODE-21** | LOW | D | **fixed** — `listDocumentsByIds(db, embedderId, ids)` (shares `rowToInfo`/`LIST_DOCUMENT_COLUMNS`, every aggregate `IN (…)`-scoped) replaces the whole-library materialization in `listAttachments` (the PF-5 chat rider); equivalence + no-full-table-aggregation prepare-spy guard. The documents-SCREEN load-all (PF-5 proper) is unchanged and stays a `known-limitations` watch item. |
| **CODE-22** | LOW | E | **fixed** — the translation GPU offload-line parse matches on `window + chunk` BEFORE slicing to 512 bytes — a single large stderr chunk containing the line + trailing log no longer loses it (the #42 device hint stays honest). |
| **CODE-23** | LOW | G | **fixed** — TranslateScreen `gpuLayers === 0` renders the CPU wording (`translate.device.gpuNone`(+`Title`) EN+DE) instead of the self-contradictory "partly on the graphics card (0/49 layers)"; known-limitations' hint-form enumeration extended. |
| **CODE-24/DOC-12** | LOW/MED | H `633dc45`+`d7787b1` | **fixed (byte-identity proven test-first)** — the literal U+0000 in `analysis/extract.ts` `contentHashOf` → `\u0000` escape: five hash constants captured against the PRE-edit code stay green (no persisted extraction-cache hash invalidates), the file diffs as text, ripgrep sees content. The recommended **NUL-ban net** (src/** read as buffers) found a SECOND offender the audit missed for exactly the CODE-24 reason (rg skips NUL-bearing files): `doctasks/compare.ts` `pairKey` (in-memory key, NUL past git's 8000-byte binary-sniff window — so git diffed it as text while rg still skipped it) — fixed identically. Review follow-up `d7787b1`: the fix's OWN test file shipped 2 literal NULs (comments — the authoring-tool escape trap), recreating the class inside its own guard: escaped, the frozen constants re-verified green, and the net extended to **tests/**** (binary fixtures excluded by the extension filter). Lesson recorded: byte-verify any tool-written escape sequences — the net now enforces it mechanically for both trees. |
| **CODE-25** | LOW | G | **fixed (scoped)** — the two new DE ASCII-quote closers + the `:657` precedent → `„…“`. Registered: seven-plus OLDER same-class de.ts values (~:428, :594–595, :907, :1059/:1061, :2150, :2171, :2290) left for one mechanical sweep on a future copy pass (the catalog's 66 correct `“` closers establish the convention). |
| **CODE-26…29** | LOW-MED/LOW | F1 | **fixed (class)** — shared `runAndSurface(fn, onError)` in `renderer/lib/errors.ts` (awaits, catches, routes `friendlyIpcError`, surfaces per site, never rejects); converted: **CODE-26** App "Lock now" (dismissible error banner; session stores NOT purged and shell stays unlocked — coherent with CODE-1a, main really is still unlocked), **CODE-27** Diagnostics "Try GPU again" (`gpuRetryError` banner, new `diag.gpu.tryFailed` EN+DE, + the file-uniform mountedRef it was missing), **CODE-28** both ModelsScreen poll-completion refreshes (→ screen error banner), **CODE-29** the DocRow task-cancel (screen-owned `onCancelTask` prop, useEventCallback-stable for the PERF-5 memo) + the bulk-re-index cancel. |
| **CODE-30** | LOW-MED | F2 `9b4df23` | **fixed** — the SKA-18 'new'-key carry+delete extracted into shared `carryNewComposerPicks`, used by BOTH creation entry points ("+ New chat" bypassed it: a composer skill/depth pick silently vanished, then resurrected on the next empty composer); the discarded promise now catches → `setError`. Registered nit: an interleaved first-send + "+ New chat" click can double-carry the picks onto both conversations — benign (idempotent delete; each gets the visibly-selected pick), not scheduled. |
| **CODE-31** | LOW-MED | F2 | **fixed (owner-decided: relabel truthfully; emitted scope unchanged)** — the attach-chat reset reads `chat.scope.attachmentsOnlyTap` "Just the files in this chat" / „Nur die Dateien in diesem Chat", keyed on the same `fileCount` the "Answering from:" chip reads (label and chip stay coherent); the emitted explicit-empty scope resolves attachments-only per the confirmed-deliberate D71 backend semantics; the no-attachment case keeps "All documents". One user-guide clause updated (it quoted the old reset wording — the phase's sole doc touch). |
| **CODE-32** | LOW-MED | F2 | **fixed** — DR-2 request-seq (`previewSeq`) shared by `onPreview` AND the done-task auto-open; loading flag clears functionally (`cur === d.id ? null : cur`) — last-resolved can no longer show the wrong document. |
| **CODE-33** | LOW-MED | F2 | **fixed** — DocRow's `onContextMenu` respects the `busy !== null` gate the "⋯" trigger already had (no Delete/Re-index mid-import via right-click). |
| **CODE-34** | LOW-MED | F2 | **fixed** — ImagesScreen delete: success toast ONLY on success; failure → resync + `images.err.deleteFailed` banner. |
| **CODE-35** | LOW | F2 | **fixed** — PreviewModal owns a local `loadMoreError` rendered inside the dialog (above the overlay); the screen's `onPreviewLoadMore` rethrows instead of parking the error under the modal. Registered nit: the error is component state and the modal isn't keyed on `preview.id`, so a done-task auto-open that replaces the preview in place keeps a prior document's error visible until the next attempt — polish candidate `key={preview.id}` (also resets coverage/loading per document). |
| **CODE-36** | LOW | F2 | **fixed** — saved-analysis open THROW → `images.err.openFailed` (distinct from the vanished-entry silent resync); copy failures get the PreviewModal-style `images.answer.copyFailed` toast. |
| **CODE-37** | LOW | F2 | **fixed (scoped)** — per-action SkillsTab failure keys EN+DE (`skills.row.onFailed/offFailed`, `skills.delete.failed`, `skills.export.failed`) replace the blanket "Skills couldn't be loaded." Registered: `setAutoFire`'s catch (outside the finding's line range) still toasts the blanket key — one-key polish for a later i18n pass. |
| **CODE-38** | LOW | F2 | **fixed** — `refreshCollections` rides the same DR-2 `refreshSeq` (stale snapshot dropped) and keeps the PRIOR list on failure — one transient error no longer empties the Projects rail. |
| **CODE-39** | LOW | F2 | **fixed (+1 site)** — the two swallowed done-task catches (list refresh + result auto-open) → `setError`; PLUS the F1-discovered THIRD ChatScreen `cancelActiveDocTask` site (the busy banner's cancel, an explicit `.catch(() => undefined)`) — same swallowed-outcome class, folded in. |
| **CODE-40** | LOW | F2 +`234ba35` | **fixed (review-hardened)** — the CR-1 draft restore compares the persisted TAIL (`last.role === 'user' && content ===`) instead of `some(content ===)`, so a busy-rejected repeated question restores the draft. The bare tail compare had a narrow regression the old `some()` handled: `stream()`'s try also spans the two POST-send refreshes, so a fully successful send whose refresh threw reached the catch with an assistant tail and restored the already-answered question. Closed by a `sendSucceeded` latch set when the send IPC resolves — the tail compare runs only for send FAILURES (red-verified). |
| **CODE-41** | LOW-MED | G | **fixed** — ContextMeter `fmtTokens` locale-aware via `toLocaleString(lang)` (the M-U5 treatment): German "6,4k von 12,8k Token" in `title` AND `aria-valuetext`; EN output byte-identical. |
| **CODE-42** | LOW | G | **fixed** — `fileTx.errorMessage` routed through `localizeServerCopy` (DR-7 parity; doc-task failures are persist-canonical English), German-UI RTL pin. |
| **CODE-43** | LOW | G | **fixed** — the three DE "Tokens" values → „Token" per the catalog's own RD-3 glossary. |
| **CODE-44** | LOW | G | **fixed** — dead `chat.scope.usingSome.one/.other` pair deleted EN+DE; SectionRail's never-read `collections` prop dropped. |
| **CODE-45** | LOW | G | **fixed** — the missing-interpolation dev-warn hoisted above the `lang !== 'en'` branch (a forgotten param on the EN dev/CI default used to ship a literal `{name}` silently); rendering unchanged, no test depended on EN silence. |
| **CODE-46** | LOW | H | **fixed** — the symlink-gated ingestion tests `console.warn` when privilege-skipped + a CI-Linux positive control (`if CI && linux → expect(symlinkOk).toBe(true)`), so the trio can't silently vanish everywhere. |
| **CODE-47** | LOW | H | **fixed (report premise wrong)** — the row Cancel is the DELIBERATE no-arg active-task fallback (`cancelActiveDocTask()` → `cancelDocTask(null)` server-side), verified empirically (`CalledWith('j1')` red, received `[]`); passing the jobId would change a shared store fn's intentional semantics. The truthful teeth-giving pin is the zero-arg `toHaveBeenCalledWith()` — any stray/foreign/stale id now reddens, satisfying the finding's intent — applied to all three suites (Summary/Compare/Translate). |
| **CODE-48** | INFO | — | **no action (documented watch items)** — the SSE idle-watchdog tests ride real timers with ~2× margin (legitimate wall-clock semantics; widen proportionally if ever flaky); the Diagnostics copy/save tests are near fixture pass-throughs; the ocr-meta SQL-text assertion is a deliberate, comment-justified perf guard. |
| **GAP-1** | MED | E `7f5d291`+`96e439a` | **fixed (owner-decided: provenance survives — SKA-38 honoured)** — `deleteSkill()` drops the `messages.skill_id` sweep and keeps ONLY the `conversations.active_skill_id` clear (a deleted skill must not stay the sticky default); the per-message stamp survives deletion and the "(removed skill)" label is reachable via the real path. The SKA-38 test re-pointed at the REAL `deleteSkill()` (it bypassed it via raw SQL — a test bug under both outcomes; lesson: BOTH sides of the code-vs-contract contradiction had their own green test, each blind to the other's path); the installer's old sweep-pinning test updated to the new contract; known-limitations bullet updated. Review follow-up `96e439a`: this doc's §4 installer prose + IPC-table row still described the removed sweep — updated to as-built (the historical §-legend row deliberately untouched per the S1 policy). |
| **GAP-2** | LOW | E | **fixed** — the four unguarded failure exits in `skills/run.ts` route through `finishRunGuarded` (the P-8 treatment): a doomed terminal UPDATE resolves the friendly envelope, never rejects raw; no more runs stranded 'started' until next-session reconcile. |
| **GAP-3** | LOW | E | **fixed** — `PdfParser` awaits `loadingTask.promise` INSIDE the try/finally that destroys it: a corrupt/password PDF no longer leaks the pdf.js transport + up-to-`maxBytes` buffer per failed parse. |
| **GAP-4** | LOW | E | **fixed** — the redact/edit locate catches use the app-wide `isAbortError(e, signal)` instead of the narrow DOMException name-check: a cancel surfacing as a wrapped runtime error records 'cancelled', not 'failed'. (Redaction's observable end state was coincidentally already correct — the degraded locate fell through to the gate's own abort pre-check; the EDIT seam misrecording 'failed' is the discriminating regression test.) |
| **GAP-5** | LOW | E | **fixed** — delete/re-index IPC (and the reindex-all batch skip) refuse under an in-flight SKILL run via new `ctx.skillRunActive` (assigned by registerSkillsIpc from its module-local controller; `main.docs.skillRunning` EN+DE — the `requireNoActiveTask` mirror): no more mid-run interleaving / friendly-but-confusing persistFailed / orphaned rows under FK-off. Registered nit: the batch-skip branch has no direct test (shares probe + shape with the pinned doctask half) — optional hardening. |
| **GAP-6** | LOW | E | **fixed** — redact + edit refuse `confirmed !== true` UP FRONT (gate copy mirrored) — no more full multi-window LLM locate pass before the gate refusal (no security impact; the gate always blocked the write); edit's DOCX branch gains redaction's explicit `confirmed === true` pre-touch check (branch parity). |
| **GAP-7** | LOW | E | **fixed (premise half-stale; contract decided + documented)** — the pre-persist abort check already existed at audit HEAD (needed only a citing comment); the REAL gap was as reported: a cancel during the signal-less re-ingest was ignored and reported 'done' under a header claiming "cancel persists NOTHING". Decided contract: a pre-persist cancel actually cancels (nothing persisted); a post-persist cancel deliberately completes **'done'** (the work is real — never "cancelled, nothing happened" about a now-searchable document); header rewritten, both halves pinned (gated-rasterizer + gated-embedder tests). |
| **DOC-1** | HIGH | A `e7cda05` | **fixed** — README RAM tiers (both spots) → the shipped §6.3 mapping: ≤12 GB → Qwen3-4B · 16–20 GB → Ministral 8B · ≥24 GB → Gemma 4 12B (re-verified against `benchmark.test.ts` before editing). |
| **DOC-2** | HIGH | A | **fixed** — `docs/benchmark.md` best-fit table, same correction. Phase-A review found the SAME stale tiers in `docs/model-policy.md:70–71` (present-tense pre-#48 mapping the report's DOC table never named) — fixed as a Phase-H rider (`633dc45`): restated to §6.3 with a §6.3/#48/benchmark.test.ts citation, mirroring model-benchmarks §6.2's superseded-by-§6.3 handling. |
| **DOC-3** | MED | A | **fixed** — retired "Start" button quote → "Use this model" (README + troubleshooting). |
| **DOC-4** | MED | A | **fixed** — `cd ai_drive` → `cd HilbertRaum`; the README tree root relabelled (a clone of the renamed repo lands in `HilbertRaum/`). |
| **DOC-5** | LOW | A | **fixed** — TranslateGemma Min RAM 14 → 13 GB (the manifest value; the other 16 RAM cells verified exact). |
| **DOC-6** | MED | H `633dc45` | **fixed (slot added)** — the dangling skills-s13 references: §18 documented only the AUTO-FIRE ratified contract, so the "Suggestion-selector baseline (S13a — measured, not yet gated)" half-paragraph was ADDED to §18 per the plan's fallback; BUILD_STATE §5 TS-9, both eval-harness comments, and the adjacent S13b §2.1 comment re-pointed at it; historical dated citations left alone (resolvable via the §44 legend, the S1 policy). |
| **DOC-7** | LOW | A | **fixed** — the two 4045 gate lines → 4053, re-referenced to the #42-reopen wave (`:29` keeps a one-clause note that the #51–#53 wave itself landed at 4045, so the historical record stays truthful; the third 4045 hit is genuinely historical, left per the report). |
| **DOC-8** | LOW | A | **fixed (scope widened)** — `PRIVATE_AI_DRIVE` → `HILBERTRAUM` in the five shell usage texts + the `commercial-drive.ts` comment (the report's path corrected: the file is `apps/desktop/src/main/services/commercial-drive.ts`, not `scripts/`); a sixth tracked hit in `launcher.test.ts` → neutral `/Volumes/MYDRIVE` (the acceptance grep demands zero tracked hits; test intent preserved). |
| **DOC-9/10/11** | LOW | A | **fixed** — user-guide: skill picker "None" → "No skill"; the §7 scope chip → "Answering from: {source}" (aligning with the doc's own correct §~350); "Settings → Developer/Chat" → the General-tab cards (three tabs exist). |
| **DOC-12** | MED | H | = **CODE-24** (the NUL byte made `extract.ts` binary-diffing — a public reviewer could not diff a security-adjacent service file). |
| **DOC-13** | INFO | — | **no change (watch)** — SECURITY.md's "private vulnerability reporting … where available" stays honest until the flip (PVR re-confirmed 404 on the renamed repo); the enable-at-flip action lives in BUILD_STATE §5 item 10. |

**Surviving residuals & watch items** (the plan's "discovered during remediation" register survives
here; everything is Low, none flip-blocking):

- **Accepted / no-action (recorded in the rows above):** CODE-1 F3 (failed interactive lock +
  immediate hard kill — inside the power-cut trade-off) and F4; CODE-2 triple-overlap queued
  start (interactive-lock path only); CODE-11 crash-bypass orphan (§5.6); CODE-13
  cancel-during-extract marker-less binary + the engine-download-vs-model-start race; the Phase-D
  torn-FTS-content-backfill observation (pre-existing); CODE-48's watch trio; DOC-13.
- **Fix-when-touched polish candidates:** CODE-13 mock-backend first-install exemption ·
  CODE-7 mounted-guard narrowing · the CODE-18 canned-answer persist site ·
  CODE-35 `key={preview.id}` · CODE-37 `setAutoFire` failure key · `diag.bench.cores` plural pair
  (CODE-8 net allowlist) · the seven-plus older DE ASCII-quote closers (CODE-25) · a direct GAP-5
  batch-skip test · exporting `TOKENS_PER_WORD` (the compare-budget tests hard-code `1.3`, the
  pre-existing SK-2 idiom — a constant change would silently desync the tests' budget currency).
- **Owner items:** the CODE-9/TQ-6 manual-smoke inventory (BUILD_STATE §5, TS-3 sub-list) and the
  unchanged §46 carry-overs (TS-3/TS-7/TS-9, `rag*` knobs, SC-1).
- **Test-infra lessons (recorded for future sessions):** `vi.spyOn` on `node:fs` does NOT
  intercept a source module's internal named-import calls — use `vi.mock('node:fs',
  importOriginal)` in a dedicated file (`workspace-vault-durability.test.ts` is the template);
  `utimesSync` copies truncate sub-ms mtime precision — pin fixture mtimes to a clean-ms `Date`;
  EQP prints "SCAN" for both FTS5 lookup shapes — assert the idxStr (`0:=` vs `0:`); byte-verify
  any tool-written escape sequences (the NUL-ban net now enforces this for src/** AND tests/**).

**§-anchor legend.** Commits, code comments, tests, and BUILD_STATE cite this audit as
`full-audit 2026-07-11 <ID>` (or the bare id beside a qualified cite); all resolve to the table
above. The design "as built" lives where each phase folded it: security-model's "Lock failure &
durability" + troubleshooting's "Could not lock" (CODE-1/10/14), the GPU record §5.6 "Shutdown
latch + cancellable start" (CODE-2/3/11), rag-design §11 "Trigger sync is rowid-targeted" (CODE-4)
and the §14 mode-d joint-budget note (CODE-5), this doc's §18 "Suggestion-selector baseline"
(DOC-6) and the updated §4 skill-delete prose (GAP-1), the "Checksum cache (two tiers)" record +
`shared/types.ts` comment (CODE-15), `renderer/lib/errors.ts` `runAndSurface` (CODE-26…29), the
catalog-hygiene and NUL-ban nets in the test suite (CODE-8, CODE-24), and the swept launch docs
themselves (DOC-1…11 + the model-policy rider).

### §48 Full audit (2026-07-12) — remediation ledger + close-out

The **final pre-public-flip audit**, at baseline `b4017be` (the BUILD_STATE restructure; gate
4168/47, typecheck clean, prior full build green per §47). Method: orchestrator + fan-out to
fresh-context sub-agents — **three mechanical Opus sweeps** (secrets/PII, old-repo references,
repo hygiene) and **five Fable analysis passes** (delta-since-§47, vault/shutdown,
manifests/downloads/paths, docs accuracy, public-readiness + tests), with an **independent Fable
verifier** on the one Medium-High candidate (SEC-1, confirmed end-to-end). Prior ledgers
§24/§26/§34/§40/§43–§47 were consulted; dispositioned findings were not re-reported without new
evidence. Verdict: **0 Critical, 0 High — cleared to flip once the operational gaps closed.**
Four Mediums — SEC-1 (a genuine vault-guarantee violation), GAP-1 + DOC-1 (operational flip
gates, not code), DOC-2 (a privacy-default contradiction in a developer contract doc) — over a
Low/Info tail: **SEC-1/SEC-2 · GAP-1 · DOC-1…DOC-11 · REL-1…REL-4 · CODE-1 · TQ-1/TQ-2 ·
LIC-1/LIC-2 · PF-1/PF-2** plus watch-items. Remediated across a **six-phase wave committed
directly to `master`** (Phase 1 `9ca8b79`+`6a33f25` → Phase 5 `032b014`; Phase 6 = this
close-out), suite **4168 → 4190/47** (+22: 4 SEC-1, 6 REL/CODE, 12 Phase 5), typecheck + build
green throughout. Every phase passed an **independent reviewer before landing**; the whole round
needed exactly one repair (Phase 1 commit 1: a docs edit had clobbered §47's CODE-10 bullet —
restored).

**This record is the only durable artifact of the round.** The full report and the phased
remediation plan (`docs/audits/full-audit-2026-07-12*.md`) were uncommitted working papers for
their whole life and were deleted (plain `rm`, never tracked) at this close-out — **there is no
recoverable copy in git history** (the §46/§47 handling). Finding detail survives as: this
table, the dated 2026-07-12 BUILD_STATE §5 item-12 block, and the phase commits.

Per-finding disposition (fixed → phase@commit / OWNER → where surfaced; reviewer fine-print is
folded into its rows):

| # | Sev | Phase | Disposition (decision / mechanism) |
|---|---|---|---|
| **SEC-1** | MED (upgradeable MED-HIGH) | P1c1 `9ca8b79` | **fixed** — "Lock now" during an import could write a document sidecar encrypted under the **all-zero AES key**: `documentCipher()` closed over `const key = this.key` — the SAME Buffer `lock()` zeroes in place before nulling the reference — so a cipher captured pre-lock whose `encryptFileAsync` ran after the fill encrypted the whole file under 32 zero bytes. Reachable through the supported flow: the import loop parks in `await sha256File(origin)` (seconds–minutes on USB) with no unlock re-check; `lockWorkspace` cancels streams/doc-tasks/tree-build but never imports (only `changePassword` consults the `docWork` hold counter), and the loop's break-on-lock path deliberately DRAINS the in-flight prepare — which then wrote a GCM-valid `.enc` into `workspace/documents/`, decryptable with a public key (false assurance: the file *looks* encrypted) and persisting indefinitely (the startup sweep matches only `.parse`/`.tmp`; deleting the reconciled-`failed` row shreds nothing since `stored_path` stays NULL). Mitigating factor (why MED not HIGH): import never deletes the plaintext origin file, so the sidecar usually duplicates bytes already at rest in plaintext — the upgrade case is removable-media import + deleted original. Fix: every `documentCipher` closure re-reads `this.key` **per invocation** and throws a typed content-free `VaultLockedError` when null (check-then-`createCipheriv` is synchronous — cannot race `lock()`; an encrypt already past `createCipheriv` finishes under the real key, harmless ciphertext); the false "stops working only at process exit" doc-comment corrected; the drained prepare fails clean (row reconciles `failed`). **Red-then-green characterization on record** (the pre-fix captured cipher really produced a sidecar decryptable under 32 zero bytes) + a gated-`sha256File` integration test driving a real `lock()` across an import (real vault, real crypto; only the hash timing gated). Docs: security-model "Lock failure & durability" lock-during-import bullet; known-limitations orphan-sidecar note. The finding survived independent adversarial verification (every load-bearing step re-derived from code). Deferred belt (accepted residual, BUILD_STATE §5): the orphan-`.enc` startup sweep — it runs while the DB is LOCKED, so it cannot know which ids are live; a pre-fix orphan self-heals only on re-index. |
| **SEC-2** | LOW | P3 `fa5aa93` (doc) + P5 `032b014` (code) | **fixed (both halves)** — the recorded L-7 residual scoped the tar-containment gap "build-time only" (`scripts/fetch-runtime.*`), but the shipped app's engine installer performs the same unchecked OS-`tar` extraction (`runtime-download.ts` `extractWithTar`) of an archive whose source list (`runtime-sources.yaml`) lives on the user-writable drive. **Doc half:** BUILD_STATE §8's L-7 row corrected to "build-time AND in-app", posture re-derived from code — sha256 verified strictly BEFORE install/extract, OS tar's implicit `..` refusal, symlink members the residual soft spot — plus a nuance the audit itself missed, now recorded: a `placeholder` hash still extracts, flagged `job.unverified` (posture unchanged by the code half). **Code half:** `install()` now runs an exported `assertExtractedSymlinksContained` sweep over the FINAL post-flatten layout — any symlink/junction member resolving outside `extractTo` fails the install (job `failed`, NO marker written); lexical `readlink` resolution so broken escaping links are still caught; segment-aware `..` check. The optional `--no-same-owner --no-same-permissions -k` tar flags were **dropped** per the plan's own criterion: bsdtar 3.8.4 (Windows System32) accepts them (verified live), but GNU tar's `-k` makes an existing file a HARD error — it would trip on the legitimately-retained archive `cpu/` dir — and no GNU tar existed on the dev machine to verify against. New `engine-extract-containment.test.ts` (7 tests; junction-based fixtures run unprivileged on Windows, zero platform skips); teeth verified by disabling the sweep call (the escaping-link job flipped `done`), restored byte-identical. The skills importer never shared the gap (own enumerate-before-inflate extractor, §22-A2). Registered nit N1 (BUILD_STATE §5): the sweep removes only the FIRST offender before throwing — the next install's pre-clean removes the rest. |
| **GAP-1** | MED | P3 `fa5aa93` + OWNER | **fixed (checklist half) / OWNER (execution)** — the flip checklist (BUILD_STATE §5 item 10) had no "push `master` first" step while `origin/master` sat behind on the pre-restructure tree: the remote tip `ed1332c` (= the local `v0.1.47` tag) predates the BUILD_STATE restructure AND carries the literal NUL in this file — flipping without pushing would publish that stale tree as the repo's read-first doc. Item 10 now opens with "push `master` BEFORE flipping", with the `v0.1.47` tag push called out as its OWN deliberate decision (pushing a tag triggers `release.yml`'s draft build); the ahead-count was re-derived live at edit time (5 — Phases 1–3 had landed since the audit's "2"). The actual push + tag decision remain owner actions (§5 item 12 batch ①). |
| **DOC-1** | MED | P2 `a02db64` (+P5 pin) | **fixed** — the BUILD_STATE restructure moved the archive verbatim from repo root to `docs/`, breaking its relative markdown links (README advertises the file; GitHub rendered a wall of dead links — a mechanical relocation break, NOT the by-design frozen-archive staleness). One scripted pass de-linkified **258** real relative links to inline code (the F6 recipe: only the `](target)` wrapper dropped, prose byte-identical; the header's `../BUILD_STATE.md` link kept live; archive-header relocation note added; NUL/LF byte-verified). The audit's 264/265 census over-counted 6 code-span false positives (2 regex/call-syntax + 4 in a stray-backtick paragraph) — the count was re-done through `marked`/CommonMark, the ground truth. P5 (`032b014`) landed the deferred hygiene pin: `repo-hygiene.test.ts` asserts build-log.md's relative markdown link targets equal exactly `['../BUILD_STATE.md']` (which must resolve) after stripping code fences + CommonMark-paired inline spans, keeping the 6 non-link `](…)` sequences invisible to it; teeth verified live (a planted dead link failed the assertion, reverted). |
| **DOC-2** | MED | P4 `4fec951` | **fixed** — `data-contracts.md`'s Settings contract said "Default `allowNetwork: false`"; the code default is **true** ("Network is PERMITTED by default so model/engine downloads work on a fresh install", `shared/types.ts`) and PRIVACY.md documents on-by-default correctly — the file's ONE privacy-adjacent claim pointed the wrong way. Restated on-by-default with the policy-ceiling caveat, mirroring the code comment. |
| **DOC-3** | LOW | P4 | **fixed** — data-contracts catalog/pin staleness, both occurrences: "11 manifests" → **19 model manifests across 6 role dirs** (14 chat + E5 + reranker + whisper + translation + vision; re-counted via `git ls-files`); runtime pin `b9585` → **b9849** (re-verified against `runtime-sources.yaml`). |
| **DOC-4** | LOW | P4 | **fixed** — data-contracts Phase-13 launcher filenames predated the HilbertRaum rename → the real `launchers/` contents: `Start HilbertRaum.cmd` / `Start HilbertRaum.command` / `start-hilbertraum.sh` / `READ ME FIRST.txt` (dir listed at edit time). |
| **DOC-5** | LOW | P4 | **fixed** — data-contracts `AuditEventType` "25 values as of Phase 38" → **42** (enum re-counted in `shared/types.ts`, now named the authoritative list). |
| **DOC-6** | LOW | P4 | **fixed** — README's disk-space upgrade figures (~10/~19 GB) didn't add up from their stated ~7 GB default-set basis → **~11 / ~21 GB**, reworded as an explicit 8B→14B/30B chat-model swap (re-derived from manifest `size_bytes`: ≈7.1 GB default set; −5.2 + 9.3 ≈ 11.5, −5.2 + 18.6 ≈ 20.8). A deeper PRE-EXISTING staleness surfaced in review — the stated 4-model basis itself omits the vision model — is a registered residual, deliberately outside this fix (see the watch-items row). |
| **DOC-7** | LOW | P4 | **fixed** — README's Documentation table gained the missing `docs/product-vision.md` row (placed first — it is CLAUDE.md read-first #2 and the launch-facing "why this exists" doc). |
| **DOC-8** | LOW | P4 | **fixed** — README's offline-guard sentence dropped the "while offline" qualifier (implying an always-armed monitor; the guard is a no-op when not offline and the fresh-install posture is network-permitted). Aligned with PRIVACY.md: logs (never blocks) any attempt to reach a remote host **while offline**; local `127.0.0.1`/`localhost` exempt (re-verified against `offlineGuard.ts`'s detection-only design). |
| **DOC-9** | LOW | P4 | **fixed** — product-vision described the voice exclusion as "reversed by shipping: local voice input/output" — only INPUT shipped (Whisper transcription + dictation). Narrowed to voice input; "voice output/TTS remains out of scope" (a no-TTS grep over the app source came back empty). |
| **DOC-10** | LOW | P4 | **fixed** — the "bundled default" terminology collision (the catalog `bundled_on_preconfigured_drive` flag, only on Qwen3 4B, vs the DIY `-WithAssets` default-set chat model = Ministral 3 8B): README's row relabeled "preconfigured-drive bundled default & weak-laptop fallback" (+ a pointer to the DIY default-set model); model-policy's purpose line now names both concepts distinctly (`prepare-drive.ps1` `$DefaultModelIds` re-verified); packaging.md's "Ministral 3 8B today" was already correct, left as-is. |
| **DOC-11** | INFO | P4 | **fixed** — the spec-§22 legend row at this file's end resolved only via a two-hop pointer (→ the BUILD_STATE §4 stub → data-contracts); re-pointed directly at data-contracts.md "MVP Definition of Done". The round's only other architecture.md touch — single hunk, §47 untouched, byte-verified NUL-free. |
| **REL-1** | LOW | P1c2 `6a33f25` | **fixed** — a spent `.recovery` that outlived its best-effort shred (Windows AV/indexer hold without FILE_SHARE_DELETE) made `preserveNewerPlaintext`'s salvage `renameSync` fail into a swallowing catch, after which the unconditional `shredStalePlaintext` destroyed `dbPath` — the ONLY fresh salvageable copy (one-shot, silent; four independent low-probability conditions, likelier on exFAT/FAT32 where POSIX rename semantics are unavailable; the verifier CONFIRMED the mechanism). Fix: pre-shred a pre-existing `.recovery` BEFORE the rename. Forced-failure unit test (held-target `renameSync`) red-verified. Reviewer fine-print (recorded nuance, BUILD_STATE §5): in a REL-2 probe-error corner a coexisting `.recovery` can be unconsumed-FRESH — the in-code "spent or garbage" justification slightly overstates. |
| **REL-2** | LOW | P1c2 | **fixed** — unlock's `.recovery` roll-forward freshness probe (`fileHasSqliteHeader` + `statSync`) had no exception guard: a Windows AV/indexer hold without FILE_SHARE_READ (or the file vanishing between `existsSync` and `openSync`) threw EBUSY/EPERM/ENOENT raw out of unlock → generic `openFailed` until the hold cleared — the exact Windows condition the `8884d55` class exists for. Fix: tri-state `fresher` probe guard — on ANY probe error, leave `.recovery` in place and unlock normally (never shred on a probe error; the next unlock retries). `encryptFile` sits deliberately OUTSIDE the guard so a failed roll-forward still fails the unlock. Forced-failure test red-verified. |
| **REL-3** | LOW | P1c2 | **fixed (doc)** — security-model's "the `.recovery` exposure window ends at the next unlock" held only for THIS build: `RECOVERY_SUFFIX` sits outside every OLDER sweep pattern, so an older app copy (portable drives carry the app; downgrades/multiple copies are the product's own scenario) neither rolls it forward nor shreds it. Qualified "under this app version or newer" + the older-app-copy behavior + a one-line troubleshooting hint. Recorded nuance (reviewer, BUILD_STATE §5): under an active REL-2 probe error the window can extend one unlock further. |
| **REL-4** | LOW | P1c2 | **fixed** — quit's in-flight-stream settle await was unbounded (`Promise.allSettled` with no ceiling; contrast the 5 s doc-task bound in `shutdown.ts`): a settle promise wedged for any reason stalled quit forever → user hard-kills → mid-session wal state → next-launch shred (the documented trade-off, but triggered by our own stall). Fix: `STREAM_SETTLE_TIMEOUT_MS = 5_000` bounded race INSIDE `awaitInFlightStreamsSettled`, covering the quit AND interactive-lock paths in one place. Never-settling-stream tests red-verified (pre-fix: vitest timeout). |
| **CODE-1** | INFO/LOW | P1c2 | **fixed** — `cleanRelative` persisted `source_relative_path` with HOST separators (the one persisted string in the app not posix-normalized, unlike `driveRelKey`/`markerBinaryKey`): a Windows-populated workspace showed `sub\folder\file.pdf` breadcrumbs on macOS/Linux. One-liner `rel.split(sep).join('/')`; display-only re-verified (persisted, never read back for resolution/matching anywhere incl. the renderer — no migration needed); cross-platform assertion red-verified on Windows. |
| **TQ-1** | LOW | P5 `032b014` | **fixed** — the hygiene NUL net walked only `src/`, `tests/`, `docs/`, root `*.md`, missing `app-skills/*/SKILL.md` (ships to the drive and is PARSED for YAML frontmatter — the exact class a BOM recently broke) and `.github/*.md`; it also checked NUL only. Net extended to `app-skills/**` + `.github/**` (same extension filter; both roots verified binary-free) plus a **UTF-8 BOM ban** (first 3 bytes ≠ EF BB BF) over every NUL-net root + root `*.md` — 642 files, all pre-verified clean; a `files.length > 500` guard keeps a silently-moved root from hollowing the net. Teeth demonstrated live: planted BOM and NUL files each failed their assertion, then reverted. |
| **TQ-2** | LOW | P5 | **fixed** — the rank-1 auto-recommendable `qwen3-4b-instruct-2507-q4` manifest had no CI invariant or presence pin (the exact gap issue #48 closed for the fast-tier pair, recurring one manifest over). Added to the incumbents presence list + a Phase-29 invariant block asserting the manifest's COMMITTED values: rank 1 AND the original 4B's rank 2 pinned as a PAIR (the ordering cannot silently invert), apache-2.0 approved, real sha256 = download hash, no mmproj, no legacy profiles. The five non-chat roles got the thin coverage too: one-manifest-per-role presence + real-hash pin — license posture deliberately NOT pinned (TranslateGemma `pending` is the standing sell-gate owner decision). Red-verified for real: the reranker manifest's `id` is `bge-reranker-v2-m3-f16` ≠ its filename — the first draft failed until the committed id was read. No overlap with the PROD-1 RAM-gate sweep. |
| **LIC-1** | LOW | P5 | **fixed** — `apps/desktop/package.json` (the file the packaged app's metadata derives from) declared no license; added `"license": "GPL-3.0-or-later"` (matches root; `electron-builder.yml` carries no conflicting field — the win-portable/mac-dir/linux-AppImage targets consume none). Metadata-only. |
| **LIC-2** | LOW | — | **OWNER (registered — §5 item 12 batch ③)** — no third-party-notices aggregation for bundled npm deps: packaged builds bundle Vite-compiled renderer code (KaTeX incl. SIL-OFL fonts, streamdown, react) and asar'd prod deps (pdfjs-dist, tesseract.js — both Apache-2.0, which asks for NOTICE preservation in distributions); the MODEL manifests' own review notes are stricter than the app (granite: "ship the LICENSE/NOTICE attribution with the drive"). Recommended: generate a THIRD-PARTY-NOTICES (`license-checker`-class) into packaged artifacts. Not a flip blocker. **Post-close-out execution 2026-07-12 (owner-approved): DONE** — committed generated `THIRD-PARTY-NOTICES.md` (226 shipped packages = the app.asar production closure minus the electron-builder `files:` negations; per-package license texts incl. pdfjs-dist's embedded font/wasm licenses, the KaTeX-fonts SIL-OFL-1.1 notice, and automatic Apache-2.0 NOTICE pickup — none exist in the current set), generator `scripts/generate-third-party-notices.mjs` + shared computation `scripts/lib/shipped-packages.mjs`, shipped beside `model-manifests` via `extraResources`, drift-gated by `tests/integration/third-party-notices.test.ts` (a stale file fails the gate naming the regeneration command). |
| **PF-1** | INFO | P6 (this close-out) | **fixed** — `flake.nix`'s garbled comment word ("# ponytail: only loaded on Linux") removed: the line annotates the `lib.optionals stdenv.isLinux electronLibs` include and now reads "Only loaded on Linux; macOS Electron ships self-contained." |
| **PF-2** | LOW | — | **OWNER (registered — §5 item 12 batch ②)** — the unpushed `41acc47` is a 2,125-deletion structural commit (spec retirement → product-vision.md, stamp removal, the architecture.md NUL repair, hygiene-net extension; content verified fine hunk-by-hunk) named just "docs update". A rebase-reword is cheap while unpushed but rewrites the hashes of ALL later commits — the stale-hash sweep must cover BUILD_STATE §5 item 12 (incl. the `41acc47` cite inside batch ② itself), BUILD_STATE §8's L-7 update (`032b014`), AND this §48 ledger throughout (the six phase-commit cites plus the `b4017be` baseline cites). Couple with GAP-1's push decision. **Post-close-out execution 2026-07-12 (owner-approved): DONE** — reworded while still unpushed (the commit, originally "docs update", is now `41acc47` with a message naming the spec retirement + stamp removal + NUL fix; the rebase rewrote all 11 unpushed hashes, trees byte-identical) and the stale-hash sweep applied in the same pass: 28 citations across BUILD_STATE (§5 item 12, §8 L-7) and this §48 ledger now carry the post-reword hashes — every hash in this section is current. |
| **watch** | INFO | — | **registered** — ① cla.yml's `djuro-agent` allowlist still removed ("temporarily…", publicly visible at flip) — restore once the post-launch CLA smoke PR is confirmed green (§5 item 10 sidebar / batch ⑤). ② `.claude/skills/screenshot-verify/SKILL.md` is the sole tracked `.claude` file and publishes at flip — confirm deliberate (batch ⑥). ③ `reviewed_by: comilionas` in the TranslateGemma manifest — normalize to "project maintainer" (as the other manifests) or keep (a public GitHub handle, not private PII; batch ④). ④ the literal NUL on the `v0.1.47`/`origin` tree resolves with GAP-1's push — until then don't use that tree as a grep baseline. ⑤ `.enc.tmp` not swept: a hard crash mid-lock-encrypt leaves a partial-CIPHERTEXT `<enc>.tmp` (`shredStalePlaintext` covers `<db>.tmp` only); exposure nil (overwritten next lock), one `rmSync` would tidy — registered §5 beside the SEC-1 orphan-sweep deferral. ⑥ Phase-4 observation (reviewer-CONFIRMED): `prepare-drive.ps1` `$DefaultModelIds` includes `qwen2.5-vl-3b-instruct-q4` (added 2026-07-01), so the real `--with-assets` model footprint is ≈10.4 GB, not the ~7 GB the README basis sentence states (its 4-model list omits vision), and README's vision table row still says "opt-in; in-app download" — pre-existing staleness outside DOC-6's scope, registered §5. **Post-close-out execution 2026-07-12 (owner-directed):** watch ① = batch ⑤ DONE (`djuro-agent` restored; smoke PR #55 verified green — block → sign → ✅, signature on `cla-signatures`); watch ② = batch ⑥ RESOLVED as do-NOT-publish (owner decision — SKILL.md untracked via `git rm --cached`, the `.gitignore` `.claude` rule now covers it; file stays local); watch ③ = batch ④ DONE (normalized to "project maintainer (Claude-assisted review, HF card/LFS verification)"). |

**Clean verdicts** (what the round checked and found sound — the audit's appendix, preserved):

- **Secrets/PII:** clean across 757 tracked files (keys, tokens, the owner email, `peter`, dev
  paths, internal URLs/IPs); commits `e7cda05..HEAD` introduced none. `169.254.169.254` /
  `router.local` sit inside SSRF-defense code; `hilbertraum.local` is the product's own schema
  namespace.
- **Old-repo references:** no functional stale `comilionas/AI_Drive` reference; cla.yml's three
  URLs verified on `HilbertraumAI/HilbertRaum`; the `cla-signatures` branch intact (LOAD-BEARING
  — never delete); all GitHub-facing metadata correct or repo-relative.
- **Repo hygiene:** NUL-clean everywhere (byte-verified method); BUILD_STATE at 62% bytes / 70%
  lines of its retention budget; no tracked weights/user-data/logs/generated artifacts;
  `.gitignore` comprehensive; lockfile + npm pin intact; the three restructure-created docs LF
  and BOM-free.
- **Manifest→download→spawn chain:** https enforced per redirect hop + SSRF deny-list; sha256
  verified before rename and before extract; re-hash-before-spawn for sidecars; drive-relative
  posix checksum keys — verified across all 19 model manifests (every sha256 64-hex, every URL
  https, ranks/licenses consistent, only TranslateGemma `pending`).
- **Cross-platform paths:** both wire/persisted keys (`driveRelKey`, `markerBinaryKey`)
  posix-normalized; `resolveTarBinary` uses `win32.join` (the Ubuntu-CI regression class,
  correct). Only `source_relative_path` leaked host separators — CODE-1, display-only, fixed.
- **Vault/shutdown crash matrix:** every lock/unlock/create crash window walked returns to a
  safe state; the §47 CODE-1/10/14 + `8884d55` fixes hold under adversarial re-derivation; the
  "no on-disk format change" claim TRUE. This round's real findings are the lock-during-import
  window (SEC-1) and the AV-hold edges (REL-1/2) — new windows, not regressions of covered ones.
- **Quit-vs-model-start latch (`82d18dd`/`ba44a6b`):** holds — `stopped` checked at all four
  points incl. after the internal model-switch `doStop`.
- **Tests/CI:** 4168/47 at baseline, identical chain on two OS legs, no silently-unrun tests
  (all 47 skips env/platform-gated manual smokes, zero unconditional `.skip`), the retention
  budget net has teeth; the §47 "no systemic over-mocking" judgment stands. Naming note
  (Info, deliberate — not drift): two bench gates use a `RUN_*` env prefix rather than
  `HILBERTRAUM_*`/`PAID_*` — deliberate env gates, do not re-flag. Public front-line
  docs (README, PRIVACY, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, user-guide, troubleshooting)
  clean above Low. Performance re-traced clean — nothing in the round's delta touches a hot path
  (REL-4's quit stall filed under reliability).

Surviving open items were registered before the papers were deleted: the **owner batch ①–⑥**
(GAP-1 push+tag · PF-2 reword · LIC-2 notices · `reviewed_by` normalization · `djuro-agent`
restore · the tracked `.claude` skill), the **SEC-1 orphan-`.enc` / `.enc.tmp` sweep** deferral,
the **README default-set vision omission**, the **REL-1/REL-3 comment nuances + SEC-2 N1**, and
the **TS-7 macOS-CI carry-over** — all in `BUILD_STATE.md` §5 (item 12's close-out block; TS-7
in item 7).

**§-anchor legend.** Commits, code comments, and tests cite this audit as
`full-audit 2026-07-12 <ID>` (or the bare id beside a qualified cite); all resolve to the table
above. This doc's § numbers collide across records (deliberate, never renumbered) — "§48" means
THIS section, the 2026-07-12 ledger directly following §47. The design "as built" lives where
each phase folded it: `workspace-vault.ts`'s per-invocation-cipher + salvage-guard comments,
security-model's "Lock failure & durability" bullets and known-limitations' orphan-sidecar note
(SEC-1, REL-1/2/3), `ipc/inflight.ts`'s bounded settle (REL-4), `runtime-download.ts`'s
`assertExtractedSymlinksContained` + BUILD_STATE §8's corrected L-7 row (SEC-2), the
hygiene/BOM/build-log-pin nets in `repo-hygiene.test.ts` (TQ-1, DOC-1), the 2507 + per-role
invariants in `committed-catalog.test.ts` (TQ-2), BUILD_STATE §5 item 10's push-first step
(GAP-1) and item 12's owner batch (GAP-1/PF-2/LIC-2 + watch-items), and the swept docs
themselves (DOC-1…11, REL-3).

### §49 Full audit (2026-07-12b) — remediation ledger + close-out

The **final pre-public-release round**, run the same day as §48 (the "b" disambiguates the round
tags), at baseline `06920c1` (v0.1.48 + three doc-plan retirements; suite 4195/47 green,
re-run at audit start), audited delta `032b014..HEAD`. Method: orchestrator + **six parallel
fresh-context finder passes** (public-release lens, license/notices, contributor-docs
readability, docs-vs-code accuracy, delta code review, tests + hard-rules hygiene), each
grounded in ledgers §46/§47/§48 + BUILD_STATE §5 before reporting; **independent adversarial
verifier** on every Medium+ candidate. Verdict: **the repo is publish-ready — 0 Critical,
0 flip-blocking High.** The one High (LIC-1, CONFIRMED) gated the **first commercial drive
sale, not the repo flip**; the other 23 findings were Low/Info polish. All 24 dispositioned:
23 fixed across a **five-phase wave committed directly to `master`** (Phase 1 `015c9d9`,
Phase 2 `a93e970`, Phase 3 `e49630e`, Phase 4 `486c96c`, Phase 5 `c16f433`; Phase 6 = this
close-out), 1 declined by owner decision (SEC-2). Gate progression **4195/47 → 4199/49 (P2) →
4201/49 (P3) → 4214/49 (P4) → 4216/49 (P5)**, typecheck + build green throughout; the +2 skips
are TQ-2's POSIX-symlink probe cases (Windows-skip, run on the Ubuntu CI leg).

**This record is the only durable artifact of the round.** The working paper
(`docs/audits/full-audit-2026-07-12b.md`) was an uncommitted working paper for its whole life
and was deleted at this close-out — **no recoverable copy in git history** (the §46–§48
handling). Finding detail survives as: this table, the dated 2026-07-12 BUILD_STATE §5
entries, and the five phase commits.

**Owner-decisions batch (ratified 2026-07-12, one pass):** ① LIC-1 — build the
drive-attribution mechanism NOW, this round's scope (→ Phase 4). ② PF-2 — swap the staged
preview header id to a ranked model. ③ LIC-3 — add the extra-notices map. ④ SEC-2 — SKIP the
hardlink probe; register a watch-item at close-out. ⑤ GAP-2 — add the architecture.md layout
block. ⑥ DOC-7 — tense-fix the two present-tense pointers.

Per-finding disposition (fixed → phase@commit; OWNER = ratified batch item):

| # | Sev | Phase | Disposition (decision / mechanism) |
|---|---|---|---|
| **LIC-1** | HIGH | P4 `486c96c` | **fixed (OWNER: build now)** — the `build-commercial-drive` flow shipped Apache-2.0 model weights, MIT llama.cpp/whisper.cpp binaries, and Apache-2.0 OCR traineddata onto a sold drive with **no license or attribution text at all**, despite every approved Apache-2.0 manifest's own review note instructing "ship the LICENSE/NOTICE attribution with the drive" (a `license_url` in YAML is not an Apache-2.0 §4(a) license copy on an offline product; the upstream bin zips carry no LICENSE — empirically confirmed on the real smoke drive); the step-7 "SELLABLE" gate passed a zero-attribution drive green. **Gate = first drive SALE, not the flip** (the GitHub release channel co-locates source, LICENSE, and in-artifact notices). Mechanism landed: in-repo pinned `licenses/` upstream texts (Apache-2.0, llama.cpp MIT "The ggml authors", whisper.cpp MIT, SDL2 zlib) + committed generated `DRIVE-NOTICES.md` (`scripts/generate-drive-notices.mjs` + `scripts/lib/drive-notices.mjs` — deterministic; all 19 manifests + 3 runtime families derived at generation time; MIT weights carry pinned offline copyright lines with a throw-on-unpinned net); `prepare-drive.{ps1,sh}` copy LICENSE + THIRD-PARTY-NOTICES.md + DRIVE-NOTICES.md to drive root; SELLABLE gate (both scripts) + `assertCommercialDrive` fail on a missing/empty artifact (**red-verified** — the old assert passed a zero-attribution drive); a script-drift test pins all 4 scripts to `DRIVE_LICENSE_ARTIFACTS`; hygiene nets extended (+txt, +licenses/); docs: drive-layout.md, packaging.md, model-policy.md's license-review-gate discharge paragraph. Residual watch: DRIVE-NOTICES.md's GPL source-availability URL assumes the public repo — true once the flip lands. |
| **LIC-2** | LOW | P4 | **fixed** — the packaged artifact carried the project's own GPL license only as the package.json SPDX string (root LICENSE outside the apps/desktop build context and unlisted; on the win-portable target even the notices live inside the self-extracting archive). Added extraResources `../../LICENSE → LICENSE.txt` + test pin; the notices header's "beside the executable" softening deliberately SKIPPED as optional. Presence in the actual packaged artifact rides the next manual R2 package smoke (registered residual). |
| **LIC-3** | INFO | P5 `c16f433` | **fixed (OWNER: add the map)** — six shipped npm packages publish no license file in their tarball (dingbat-to-unicode, isarray, react-remove-scroll-bar, rehype-katex, remark-math, tr46 — MIT/BSD notices not reproduced, repo pointer only) and tesseract.js-core's WASM statically links leptonica (BSD-style) without its license text. `scripts/lib/extra-notices.mjs`: deterministic pinned verbatim texts + a leptonica attribution block; the map applies ONLY on the no-license-file path (never overrides a shipped file); 2 test pins. All 226 shipped licenses verified GPL-compatible; zero UNLICENSED/NC. |
| **DOC-1** | LOW | P1 `015c9d9` | **fixed** — packaging.md contradicted model-policy.md AND the prepare-drive scripts: it said vision is "opt-in: `--with-assets` does NOT fetch it by default", but `qwen2.5-vl-3b-instruct-q4` has been in `$DefaultModelIds`/`DEFAULT_MODEL_IDS` since 2026-07-01 (real default set ≈10.4 GB, not ~7 GB). New evidence extending §48 watch-item ⑥ (which named only README); all three packaging.md spots corrected alongside the registered README fix. |
| **DOC-2** | LOW | P1 | **fixed** — stale Qwen3.5 27B/35B download sizes in README + model-policy (~16.7 / ~20.6 GB vs manifest `size_bytes` ≈17.6 / ≈22.2 GB) — the exact understated estimates that caused the dl-size-cap-2026-07-03 bug; six cells re-derived from `size_bytes` (all other size cells verified matching per-manifest). |
| **DOC-3** | LOW | P1 | **fixed** — the model-policy catalog table listed 12 of the 14 shipped chat manifests, omitting the rank-0 fast-tier pair (qwen3.5-2b ~1.3 GB, qwen3.5-0.8b ~0.6 GB); two rows added mirroring the wave's rank-0 rows, with the model-benchmarks §9 fast-tier verdicts (0.8B surviving candidate; 2B failed its eval). |
| **DOC-4** | INFO | P1 | **fixed** — README's repo-tree comment omitted the `translation` manifest role (the repo has 6 role dirs); one-word fix. |
| **DOC-5** | INFO | P1 | **fixed** — data-contracts' thinking-switch rationale spoke of "the b9585 default" in present tense (pin is b9849; the operative enable_thinking claim verified TRUE in `llama.ts`); reworded to the "verified on b9585; expected on the b9849 pin" idiom. |
| **DOC-6** | INFO | P1 | **fixed** — architecture.md's R-2 recipe cited the walk script at `scripts/…`; it lives under `apps/desktop/scripts/` (a root `scripts/` dir exists without walk scripts, so the ambiguity was real). Qualified once; historical design-guidelines/build-log occurrences left per convention. |
| **DOC-7** | INFO | P5 | **fixed (OWNER: tense-fix the two)** — design-guidelines kept two PRESENT-TENSE pointers at the deleted `docs/design-review/` dirs (06920c1 had dispositioned all five mentions "dated narrative, stay verbatim" <1 day earlier, so re-touching was an owner call): :596 → "went to", :802 → "lived in"; the three dated-narrative mentions stay verbatim. |
| **DOC-8** | INFO | P1 | **fixed** — CONTRIBUTING's bare "spec §9.2" cite (the only bare `spec §N` in a front-line onboarding doc, resolvable only via a two-hop chain) re-pointed directly at architecture.md's "Swappable interfaces (spec §9.2)". |
| **GAP-1** | LOW | P1 | **fixed** — the corporate-proxy `npm ci` silent-hang workaround (`scripts/setup-dev.{ps1,sh}` → `NODE_OPTIONS=--use-system-ca` on Node ≥22.15; a documented real occurrence on the dev machine, with no error message to search for) was documented only in packaging.md's script table — unreachable from the contributor onboarding path. Added to CONTRIBUTING's Dev setup. |
| **GAP-2** | INFO | P5 | **fixed (OWNER: add layout block)** — architecture.md (8,477 lines) had no TOC/layout map, with the two load-bearing resolution tools (Module↔spec map, spec-retirement legend) at the very END. 15-line "Layout of this file" block added to the header as a pure insertion — no renumbering, no moves, ledgers untouched, whole file byte-verified. NOT about §-collisions (standing decision, untouched). |
| **CODE-1** | LOW | P2 `a93e970` | **fixed** — `npm run preview:build`/`screenshot` emits the dev-only preview harness (incl. the staged marketing chat) to `out/preview/`, which `electron-vite build` never clears — so a subsequent LOCAL `npm run package` folded the whole harness into app.asar via the `out/**/*` glob (dead weight + discoverable staged chat in a released artifact; release CI unaffected — fresh checkouts — but this bites the documented local/owner flow incl. the commercial-drive `-AppArtifact` path). `- '!out/preview/**'` in electron-builder.yml files + packaging.test.ts pin (the mermaid-negation template). |
| **SEC-1** | INFO | P3 `e49630e` | **fixed** — the §48 SEC-1 class, one key consumer over: changePassword's v1→v2 migration zero-fills the live key Buffer in place while logging (`vaultKey`, reference retained via `encryptionKey()`) still references it; `rekeyVaultLog` re-attaches only AFTER changePassword returns. The window was walked — nothing can persist inside it TODAY (no live defect) — but any future `log.error` in the window would atomically rewrite `app.log.enc` under 32 zero bytes (the §48 false-assurance shape; all lock paths verified safe via detachVaultKey). Belt: `persistEncrypted`/`rotateEncryptedIfNeeded` refuse an all-zero key — the belt lives in logging.ts because vault→logging would cycle the shredFile import. **Red-verified** (the unguarded code really rewrote app.log.enc under the zero key) + a security-model.md clause. |
| **SEC-2** | INFO | — | **DECLINED (OWNER: skip probe, register watch-item)** — hypothesis (Low confidence, never empirically tested): the containment sweep (`runtime-download.ts`) covers symlinks/junctions but not tar HARDLINK members whose linkname points outside the extract dir (a hardlink is not a symlink dirent). Likely moot: libarchive/bsdtar checks linknames, hardlinks need an existing same-volume target, and the hash is owner-pinned. §48 SEC-2 dispositioned symlinks only — hardlinks were never dispositioned either way. Registered as a watch-item: BUILD_STATE §8's L-7 clause + §5 residuals. If it ever bites: run the one-time hardlink-escape tar fixture probe (Windows bsdtar + GNU tar) and extend the sweep if it extracts. |
| **REL-1** | LOW | P3 | **fixed** — both notices-generator sorts used no-locale `localeCompare` (host ICU: dev = de-AT, CI = en/C) feeding a byte-exact drift gate; the current 226-name set sorts identically under all probed locales, but ICU punctuation collation isn't guaranteed stable across versions — divergence would surface as a confusing STALE failure on CI that dev-machine regeneration can't fix. Package sort → raw code-unit; license-file sort → case-folded code-unit (keeps the committed ICU-primary order); regeneration verified byte-identical. |
| **REL-2** | INFO | P3 | **fixed** — the generator threw raw ENOENT if the closure ever gained a platform-gated optional dep absent from host node_modules (npm skips os/cpu-mismatched optionals; nothing in the current set trips it). Lockfile-metadata fallback section + warning; the package stays in the list so the drift gate stays in sync. |
| **TQ-1** | LOW | P2 | **fixed** — the repo-hygiene NUL/BOM nets filtered to `ts|tsx|js|jsx|json|css|md|html` and never walked root `scripts/` or `apps/desktop/scripts/` — exactly the file class this delta added (the notices `.mjs` libs are imported by a CI test, so a BOM there breaks the suite with an opaque parse error; the class recurred 4× historically; all five delta files verified clean — coverage gap, not a live offense). Nets extended: +`mjs|cjs|mts|yml|yaml`, +both `scripts/` roots + `model-manifests/`; teeth demonstrated live (planted offenders failed, reverted). |
| **TQ-2** | LOW | P2 | **fixed** — all 7 containment tests planted absolute-target links to EXISTING dirs, so the sweep's explicitly-claimed relative-target resolution and broken-escaping-link catch had no driving test on either CI leg (a refactor to realpath — which throws on dangling links — would silently reopen the SEC-2(§48) escape with all 7 green). 3 tests added (escaping relative `../..` from a nested dir, dangling escaping link, contained-relative negative case), **red-verified against 3 sweep mutations**; 2 probe-skip on Windows → run on the Ubuntu leg. |
| **TQ-3** | INFO | P3 | **fixed (both options)** — the notices drift gate recomputed via the SAME lib as the generator (detects staleness, not correctness), and `prodClosure` skipped peerDependencies, which npm 7+ auto-installs and electron-builder ships (verified: zero REQUIRED peers missing today). Peer fold in the walk (output byte-identical, confirmed via the "unchanged" print) + an independent lockfile-derived belt test, red-verified by mutation (flipping the optionality filter surfaced 49 optional-peer entries). |
| **TQ-4** | INFO | P2 | **fixed** — §48 LIC-1's `license` field in apps/desktop/package.json had no asserting test; one-line pin: desktop license === root license === `GPL-3.0-or-later`. |
| **PF-1** | LOW | P1 | **fixed** — BUILD_STATE §2 published the developer's absolute repo path — the one developer-specific absolute path in the tracked tree (tree-wide sweep; not a hard-rule violation, but registered nowhere, and the pre-flip re-grep is scoped to things that "crept in since the scan", so it evaded that net too). Line neutralized. |
| **PF-2** | INFO | P5 | **fixed (OWNER: swap to ranked)** — the marketing preview header hard-coded `qwen3.5-35b-a3b-q4kxl`: (a) a near-miss of the real manifest id (missing `-ud`) and (b) an unproductized, rank-deferred model (§5 item 8) — website captures would show a header model no shipping user can select. Swapped to the ranked `ministral3-8b-instruct-2512-q4`, with a comment recording the deliberate-swap-on-promotion convention. Dev-harness only, never bundled; zero product impact. |

**Reviewer passes (every phase reviewed independently BEFORE its commit; 4 of 5 needed real
pre-commit repairs or nits):** P1 — 2 real same-class leftovers caught (README `-WithAssets`
walkthrough paragraph, drive-layout.md default-set list), repaired pre-commit. P2 — APPROVE,
0 defects; one nit registered for close-out (`.ps1`/`.sh` outside the hygiene extension
filter). P3 — 1 real should-fix repaired pre-commit (packaging.test.ts's independent
`prodClosure` mirror had silently diverged from the peer-folded walk) + 3 nits applied. P4 —
1 should-fix repaired pre-commit (the MIT weights' copyright lines were URL-only — the exact
offline-attribution defect class the round existed to close) + `Get-Item -Force` hardening.
P5 — APPROVE, 2 nits applied pre-commit (provenance-sentence precision for the 2
non-repo-sourced texts; test-comment sequencing).

**Clean verdicts** (what the round checked and found sound — preserved from the paper's §9):

- **Secrets/PII delta (`032b014..HEAD`, 12 commits):** clean — no keys/tokens/credentials;
  only noreply@anthropic.com trailers + upstream license-attribution emails in the notices
  file; IPs only 127.0.0.1/169.254.169.254 (SSRF-defense context); no personal paths added.
- **Preview commits (e6c2f87 + follow-up):** content appropriate — staged data explicitly
  labeled fictional in-code and in the commit message; no names/IBANs/accounts; dev-harness
  only, builds to gitignored out/preview, NOT in the shipped electron-vite inputs (the only
  packaging interaction was CODE-1's local-flow glob leak).
- **Merge cc5cce9:** lossless — cla.yml resolution keeps djuro-agent exactly once; both-parent
  diffs walked, no silently dropped hunks.
- **Tracked-file inventory (743 files):** nothing under .claude/ tracked; no editor configs,
  weights, logs, user data; only deliberate binaries (icons + one test fixture PNG).
- **Private-repo assumptions:** none functional — cla.yml URLs on HilbertraumAI/HilbertRaum;
  residual `comilionas` hits are CLA account names + dated ledger prose (per §48); owner email
  absent from the tree; no private dashboard/infra links; workflows use SHA-pinned public
  actions + GITHUB_TOKEN on hosted runners.
- **License/GPL posture:** root LICENSE = verbatim GPLv3; both package.json SPDX consistent;
  226-package closure 100% GPL-compatible (203 MIT / 8 Apache-2.0 / BSD/ISC tail; zero
  UNLICENSED/NC); notices file matches computeShippedPackages byte-for-byte; CLA v1.1 coherent
  with GPL dual-licensing; Contributor Covenant 2.1 with attribution; no vendored third-party
  code needing attribution.
- **§48 code fixes re-derived sound:** SEC-1 per-invocation key (no zeroed-but-non-null
  interleave; the only other key consumer is logging — became SEC-1 this round); REL-4 bounded
  settle (timer cleared in finally; late unwind hits the CODE-18 guard; both callers covered);
  SEC-2 sweep (single in-app extraction path, junctions covered, broken links caught, throw
  fails the job marker-less; skills importer separate by design).
- **Docs/onboarding:** clone→ci→dev→test path complete on all 3 OSes except GAP-1; the three
  doc-plan retirements left ZERO dead references; zero dead relative links across README/
  CONTRIBUTING/all 15 docs; §-anchor legends resolve; data-contracts sample-verified against
  code; i18n EN+DE parity spot-check clean; CLAUDE.md structural claims true.
- **Tests (re-derivation, not just green):** §48 SEC-1 tests drive the REAL import flow;
  the containment suite runs unskipped on BOTH CI legs; the notices drift gate genuinely
  fails on any prod-dep change on both legs without node_modules; no over-mocking in any new
  suite (the §47/§48 verdict stands); no flaky tests observed.
- **Hygiene:** independent byte-level scan of 688 files (incl. .yml/.mjs/.txt the in-repo net
  excludes) — NUL/BOM/UTF-16-clean everywhere; no hardcoded dev paths in src/scripts/tests
  (only generic fixtures); no cloud endpoints in src/; path-separator discipline holds in
  every persisted/wire string changed since 41acc47; lockfile discipline intact (npm@11.6.2
  pin, lockfileVersion 3, v0.1.48 consistent).
- **Performance:** nothing in the delta touches a runtime hot path (requireKey null-check =
  noise vs AES-GCM streaming; the containment sweep is a one-shot install-time walk; the
  notices generator/gate + hygiene nets are script/test-time only). The §46/§47/§48 perf
  verdicts stand; no new perf findings.

Surviving residuals/watch-items were registered in `BUILD_STATE.md` §5 before the paper was
deleted: ① the **SEC-2 hardlink hypothesis** (owner-declined probe — watch-item, with the
BUILD_STATE §8 L-7 clause); ② **DRIVE-NOTICES.md's GPL source-availability URL** assumes the
public repo — flip-gate coupling; ③ **LIC-2 packaged-artifact presence** rides the next manual
R2 package smoke; ④ **`.ps1`/`.sh` still outside the hygiene extension filter** (Phase-2
reviewer nit).

**§-anchor legend.** Commits, code comments, and tests cite this audit as
`full-audit 2026-07-12b <ID>` (or the bare id beside a qualified cite); all 24 ids —
**LIC-1…LIC-3 · DOC-1…DOC-8 · GAP-1/GAP-2 · CODE-1 · SEC-1/SEC-2 · REL-1/REL-2 · TQ-1…TQ-4 ·
PF-1/PF-2** — resolve to the table above. This doc's § numbers collide across records
(deliberate, never renumbered) — "§49" means THIS section, the 2026-07-12b ledger directly
following §48. The design "as built" lives where each phase folded it: `licenses/` +
`scripts/generate-drive-notices.mjs` / `scripts/lib/drive-notices.mjs` + `DRIVE-NOTICES.md` +
the SELLABLE-gate artifact checks (LIC-1), the extraResources LICENSE.txt entry (LIC-2),
`scripts/lib/extra-notices.mjs` (LIC-3), logging.ts's zero-key belt + security-model's clause
(SEC-1), the extended nets in `repo-hygiene.test.ts` (TQ-1), the relative/dangling cases in
`engine-extract-containment.test.ts` (TQ-2), the peer fold + belt test in
`third-party-notices.test.ts` (TQ-3), the packaging.test.ts pins (CODE-1, TQ-4), this file's
header layout block (GAP-2), and the swept docs themselves (DOC-1…8, GAP-1, PF-1).

### §20 Span-transform engine (beta-feedback-2026-07 Phase 6, decision D74)

The C-wave of the beta-feedback wave (#22 LLM-located redaction, #23 targeted edits) asks for one
architecture: **locate spans, replace mechanically, never regenerate** — exactly the posture
`redaction.ts` already had. Phase 6 lifts that already-correct splice core out of `redaction.ts` into a
reusable, replacement-strategy-aware module, `services/skills/tools/span-transform.ts` — the shared
substrate Phase 7/8 will locate spans for and splice through. **No user-visible behavior change** landed
this phase (the redaction run is byte-for-byte the token output — see the decision below); this is
groundwork + one new replacement strategy + occurrence-anchored find.

- **`applySpans(text, spans)`** — the generalized `maskStep`. Splices `{start,length,replacement}` spans
  in a single left-to-right pass, sorted by start (input order not assumed). A span is applied only when
  it is in-bounds, positive-length, and does not overlap an already-applied span; otherwise it is
  **skipped and reported** (`{text, applied, skipped}`). **Byte-identity OUTSIDE applied spans holds by
  construction** — every non-span byte is copied through verbatim (the D58 posture, now the engine's
  guarantee, not just redaction's). Overlap resolution is deterministic: equal-start spans keep the
  first, skip the rest; the caller decides ordering by the list it builds.
- **Replacement strategies (D74):** `token` (the fixed `[EMAIL]`-style labels; length changes) and
  `perChar` (`replacementText` returns `█` — U+2588, one BMP unit — repeated to the span's UTF-16
  length). Per-char is **same-length by construction**, so line lengths and the extracted-text layout
  survive; `█` carries no digit/`@`/scheme and is not a shadow-mapped separator, so masking stays
  **idempotent** AND keeps the SKA-3 same-length shadow invariant.
- **`locateOccurrences(text, needle, {line?, nth?})`** — the deterministic verify half of the
  locate→verify→splice discipline (D75/D76). Finds **verbatim, non-overlapping** occurrences (a single
  wrong byte is a miss), each with its 0-based offset, length, 1-based line, and 1-based global index.
  `line` restricts to occurrences starting on that line; `nth` (1-based, within the line-filtered set)
  picks one; out of range / absent needle / wrong line ⇒ `[]` (the caller drops the unverifiable span).
  No model, no fuzzy match.

**Shadow discipline stays a redaction concern (recorded).** The engine has no detection-shadow concept
(the shadow is a detector-input artifact, not a property of a transform). `redaction.ts`'s `maskStep`
now builds its accepted-span list from the shadow matches and splices the **SAME span list into BOTH the
text and its same-length shadow** via `applySpans` — preserving `shadow === detectionShadow(text)`
because every replacement carries no shadow-mapped character (`token` is pure ASCII; `perChar` is `█`).
The one-shot exported detectors (`maskEmails`/…) stay token strategy (their tests pin the fixed tokens);
`redactText(input, strategy='token')` threads the strategy through the six fixed-order passes. Counts are
strategy-independent, so `scanRedactionCandidates` (the dry-run / share-safe pre-scan) is identical under
either strategy.

**Token-vs-per-char decision for the WRITTEN FILE — kept token this phase (option b, the lower risk).**
Plan §9 allowed landing the per-char default now (a) or deferring the visible switch to Phase 7 (b). We
chose **(b)**: `redactText` and the `redact_document` input schema now carry an **optional `strategy`
enum** (`token`|`perChar`, validated by the gate; unknown values refused), but the run seam
(`runDocumentRedaction`) passes **no** strategy, so the tool defaults to `token` and the written
`redacted.txt` is **byte-for-byte the current `[EMAIL]`-token output**. Rationale: Phase 6's stated goal
is *no user-visible change* (the redaction run keeps working byte-for-byte); flipping the file to `█`
runs now would change user-facing output while its explanatory copy (SKILL.md, the run report,
known-limitations) does not change until Phase 7's wave — a partial visible change divorced from its
context, and it would need the written-byte pins (`skills-redaction.test.ts`) rewritten. Deferring keeps
every existing redaction pin green and makes the Phase-7 flip a **one-line caller change**
(`redactText(joined, 'perChar')` / the seam passing the strategy), not an engine change. **When Phase 7
flips it,** update the `skills-redaction.test.ts` written-content assertions (they assert `[EMAIL]`/
`[IBAN]` in the saved bytes) and `known-limitations.md` (the file now contains `█` runs) at that time.

**Tests:** `skills-span-transform.test.ts` (+18: `applySpans` byte-identity outside spans, ascending
single-pass, out-of-bounds/zero-length/overlap skip-and-report, abutting spans; `replacementText`
token/perChar; `redactText` perChar length + line-count + idempotent + shadow-invariant + counts-parity,
token reproduces the current masks; `locateOccurrences` verbatim/line/nth/drop-on-mismatch/non-overlap +
a locate→splice composition) and `skills-redaction-tool.test.ts` (+3: the `perChar` strategy plumbs
through the gate to `█` masks with unchanged counts, the no-strategy default is byte-for-byte the token
output, the gate refuses an unknown strategy). All prior redaction pins stay green under the token
default. Suite 3717/47 (was 3696; +21).


### §21 LLM-located redaction — locate → verify → sweep (beta-feedback-2026-07 Phase 7, D73/D75/D78)

Redaction v2 (#22 part 2): "replace all names and addresses, keep the city" works because the local model
ONLY LOCATES spans — it **never generates the output text** (D73). The output is source bytes everywhere
outside a verified span, so **hallucination is structurally impossible**; misses shrink because the model
adds judgement (names/addresses the regex floor cannot detect) and the sweep turns one confirmation into
document-wide coverage (D75). The deterministic regex floor (§20 / §8) stays as the baseline under the
model pass. Builds directly on the §20 span-transform engine.

- **Locate pass** (`services/skills/tools/redaction-locate.ts`, runtime-touching): the seam feeds the
  document as **overlapping, globally line-numbered windows** (40 lines, 8-line overlap so an entity
  straddling a window edge is seen whole) to `deps.runtime` under a **grammar-constrained JSON schema**
  (D55) — `{ entities: [{ text, category: name|address|org|other, line }] }` — at **temperature 0**. The
  mock runtime ignores the schema, so `parseLocateReply` re-validates every field. A window's malformed
  reply is skipped (that window contributes nothing; the floor still covers it — never a hard fail); an
  abort throws `AbortError` (the seam maps it to a calm cancel). This is LOCATE-ONLY — the returned
  strings are UNVERIFIED proposals.
- **Verify + sweep** (`redaction.ts` `verifyAndSweepEntities`, runtime-free so it unit-tests without a
  model): each proposed string is confirmed only when it is present **verbatim** in the source
  (`locateOccurrences`, no fuzzy match); an unconfirmed / too-short (`< MIN_ENTITY_CHARS`) / letter-less
  proposal is **dropped and counted** (D78 honesty). A confirmed string is masked at **every** occurrence
  (the model may report one). Duplicate proposals of the same string are swept once, not re-dropped.
- **Combined redaction** (`redactWithEntities`): entities are masked FIRST — verified against the pristine
  input, spliced via `applySpans` — then the six regex detectors run over the entity-masked text, so the
  floor still covers every email/IBAN/… not already inside an entity. Both passes are mechanical splices,
  so **byte-identity outside the union of masked spans holds** (D58). `entities` empty ⇒ exactly the floor,
  which is how the seam degrades. The **written file flips to `perChar` `█`** here (D74/D75), so line
  layout survives (the §20-recorded Phase-7 flip; the `skills-redaction.test.ts` / privacy-guard /
  IPC written-content pins moved from `[EMAIL]`/`[IBAN]` to `█`).
- **Where the model call lives.** Tools hold no runtime handle (§14 ceiling), so the locate pass runs in
  the SEAM (`runDocumentRedaction`) via `deps.runtime` (the IPC injects `ctx.runtime.active()`), like the
  bank categorizer/enricher model surfaces. The seam reads the joined text once (the reader is a cheap
  in-memory closure after resolve), locates, then hands the VERIFIED-shape entity proposals to the pure
  `redact_document` tool as structured **input** — which `runSkillTool` audits/logs ids/counts only, never
  the input, so the proposed strings (CONTENT) stay inside the §6 content boundary. The tool does the
  deterministic verify+sweep+floor and returns per-category counts + the dropped count.
- **Steerability (D73).** The user's instruction (`deps.instruction`) rides into the locate system prompt
  as the scoping directive ("names and street addresses; keep city names"); the schema's category set is
  FIXED, so the instruction only widens/narrows what the model PROPOSES — the app never interprets prose.
  Absent ⇒ the default directive (names + addresses + orgs). (The run-bar button collects no free text yet,
  so the IPC passes no instruction today; the pipeline supports it end-to-end — a future text field wires
  straight in.)
- **Degrade, never a silent partial (D78).** No runtime — or a model failure that is NOT a user cancel —
  degrades to the deterministic floor with an honest note. The seam's `resultKind` carries BOTH whether
  anything was masked AND whether the model ran: `redacted`/`clean` (model ran) vs `redactedFloor`/
  `cleanFloor` (rule-based only); the run-bar copy says "offline rule-based detection only, no model
  running." The completion line keeps the "best-effort, not a guarantee — review before sharing" reminder
  and never claims "fully anonymized" (SKILL.md honesty block rewritten to "AI-assisted best-effort with a
  deterministic floor").
- **Flow & gates unchanged.** Still user-initiated + confirm-gated (`export-file`); `skill_runs` stays
  content-free (entity VALUES never logged/audited — a privacy-guard test drives a secret name through the
  locate pass and asserts it reaches no sink). The `saveTextFile` boundary's trust model is untouched.

**Concurrency note (carried forward).** Unlike the enricher (which runs inside the chat turn, holding the
chat lane) the redaction run-bar seam does not hold the D26 chat↔task arbiter, so its locate call could in
principle run concurrently with a chat stream on the one llama-server. Accepted for this best-effort pass
per the plan (deps.runtime in the seam); routing redaction through the doctask lane like `categorize` is
the follow-up if it bites.

**Tests:** `skills-redaction-locate.test.ts` (+18: schema shape; window empty/overlap/global-numbering;
`parseLocateReply` keep-valid/drop-off-enum/malformed; `locateEntities` per-window temp-0 schema call +
abort; `verifyAndSweepEntities` verify/sweep-all/drop-unverifiable/drop-short/dedup; `redactWithEntities`
entities+floor/perChar-length/byte-identity/empty=floor/dropped-count), `skills-redaction.test.ts` (+5
Phase-7 seam: locate→sweep-all-occurrences+floor with steering & temp-0 schema, drop-hallucinated,
cancel-mid-locate, model-missing degrade leaves the name, model-failure degrade still saves; existing
pins moved to `█` + the degraded `redactedFloor`/`cleanFloor` discriminators), `skills-privacy-guard.test.ts`
(+1: a located name value is masked out and never touches audit/log/skill_runs) + the perChar flip on the
existing redaction case, `skills-tool-run-ipc.test.ts` (the end-to-end redaction moved to `█` + the
no-model `redactedFloor` discriminator). Suite 3739/47 (was 3717; +22).


### §22 Format-preserving targeted edits — locate → verify → splice (beta-feedback-2026-07 Phase 8, #23, D76)

Targeted edits (#23): "Vollmachtgeber → Vollmachtgeberin including dependent pronouns" works without
touching anything else. It shares the §20 span engine + the §21 locate→verify pattern, but is a NEW skill
(`app-skills/document-edit/`, tool `apply_document_edits`) so redaction's privacy posture stays untangled.
The local model ONLY LOCATES occurrence-anchored find→replace edits — it **never regenerates the document**
(D73/D76). Output is source bytes everywhere outside a verified span, so **hallucination is structurally
impossible** (the #23 failure mode) and **diff-verifiability holds by construction** (only verified spans
change — the `applySpans` guarantee). Output is `.txt` this phase; same-format DOCX export is Phase 9.

- **Locate pass** (`services/skills/tools/document-edit-locate.ts`, runtime-touching): the seam feeds the
  document as **overlapping, globally line-numbered windows** (40 lines, 8-line overlap — identical to §21)
  to `deps.runtime` under a **grammar-constrained JSON schema** (D55) — `{ edits: [{ line, find,
  occurrence, replace }] }` — at **temperature 0**. The mock runtime ignores the schema, so `parseEditReply`
  re-validates in code (empty `find` dropped; missing line/occurrence default to 1; empty `replace` = a
  deletion). A window's malformed reply is skipped; an abort throws `AbortError` (calm cancel).
- **Verify + splice** (`document-edit.ts` `verifyAndSpliceEdits`, runtime-free so it unit-tests without a
  model): each proposed `find` is confirmed only when present **verbatim at its `{line, occurrence}`
  anchor** (`locateOccurrences(text, find, {line, nth: occurrence})`, no fuzzy match); a miss / wrong-line /
  out-of-range occurrence is **dropped and counted**. Unlike redaction (which SWEEPS all occurrences of a
  confirmed string) an edit replaces **only its anchored occurrence** — the D76 precision that makes
  grammatical-agreement edits (der→die only where it refers) expressible: the model emits one edit per
  occurrence. Spans are spliced via `applySpans`; an overlapping same-occurrence duplicate drops (leftmost
  wins), so `dropped` = unverifiable finds + overlap-skipped spans. Byte-identity outside the edited spans
  holds (D58).
- **The tool** (`apply_document_edits`, confirm-gated `export-file`): reads the selected document's chunks,
  takes the seam-located `edits` as structured input, verifies+splices, returns the edited text + applied/
  dropped/total counts. Tools hold no runtime handle (§14), so the model call stays in the seam.
- **Run seam** (`run.ts` `runDocumentEdit`, mirroring `runDocumentRedaction`): records the `skill_runs`
  lifecycle, runs the locate pass MAIN-side via `deps.runtime`, hands the VERIFIED-shape edits to the pure
  tool as input (`runSkillTool` audits/logs ids/counts only — the find/replace values, CONTENT, stay inside
  the §6 boundary), and writes the confirm-gated MAIN-side `edited.txt` via `saveTextFile`. When nothing
  matches verbatim it reports `none` and writes **no file** (never dresses an unchanged copy up as an edit).
- **Where the instruction comes from (the central Phase-8 decision).** Unlike redaction (where the
  instruction is optional STEERING), the edit instruction is the CORE input. Decision: **the conversation's
  latest user message** — the IPC resolves it MAIN-side from `conversationId` (`chat.ts`
  `getLatestUserMessage`) and threads it through `BuildRunnerArgs.instruction` → the seam → the locate
  prompt. This wires an end-to-end instruction with **no new renderer input widget** (the user's chat ask
  IS the edit request); the content stays main-side, scored/used but NEVER logged (the §6/scope posture).
  Rejected alternatives: a free-text field on the run bar (a real renderer surface, screenshot-gated, for
  no gain over the chat message the user already typed) and a chat-routed auto-run (an edit must stay
  user-initiated + confirm-gated). Phase 7 left `deps.instruction` plumbed-but-unwired for redaction's
  button; Phase 8 actually collects it (for the edit tool; redaction's button steering stays a follow-up).
- **No floor, so refuse cleanly (D78).** There is no rule-based fallback for edits (an edit is a user
  instruction the model must interpret). With **no runtime** the run refuses with `needsModel` ("start a
  model"); with **no instruction**, `needsInstruction` ("say what to change first"); a genuine model failure
  mid-locate refuses with `editFailed` — never a silent nothing. A user cancel mid-locate is a calm cancel.
- **Report + honesty.** The completion surface states the applied count + an `edited` / `editedPartial`
  (some requested text wasn't found and was skipped) / `none` discriminator + "review before sharing". The
  exact dropped count rides the seam result (`droppedCount`, tested); like §21's dropped-entity count it is
  surfaced qualitatively in the run bar (applied count + the partial discriminator), not as a second numeric
  on the ids/counts channel. Honesty posture (D78): never claim more than "the edits you asked for, where
  they were found verbatim."
- **Routing** (`analysis/document-edit.ts`, `mode:'routing'` — mirrors §21's redaction routing): an
  edit-shaped ask (the `document-edit` vocabulary's `route|both` entries — find-and-replace phrases + edit
  verbs, EN+DE, pinned by the vocabulary-parity test) over ≥1 in-scope doc DEFLECTS to the user-initiated
  run button (a chat ask never silently rewrites — the #23 failure mode); reads no content, no
  citations/coverage. The generic chat regeneration path is NOT removed. `autoFire:false` — a write-edit is
  deliberately activated (still SUGGESTED on the discriminating phrases; the suggestion offer is separate
  from auto-fire).

**Tests:** `skills-document-edit-locate.test.ts` (+16: schema shape; window empty/overlap/global-numbering;
`parseEditReply` keep-valid/drop-empty-find/malformed/default-line-occurrence; `locateDocumentEdits`
per-window temp-0 schema + instruction + abort; `verifyAndSpliceEdits` occurrence-precision /
German-agreement-multi-pair-byte-identity / drop-unverifiable / drop-wrong-line / drop-out-of-range /
empty-replace-deletes / same-occurrence-duplicate-drops), `skills-document-edit.test.ts` (+13: SKILL.md
kind:tool+autoFire-off, discovery/dispatch, seam edited/editedPartial/none, needsModel/needsInstruction
refusals, cancel-mid-locate, confirm-gate, dismissed-save), `skills-privacy-guard.test.ts` (+1: a located
find/replace value is renamed out and never touches audit/log/skill_runs), + the skill-count updates
(vocabulary 8→9, skillmd-parity `ALL_APP_SKILL_IDS`, eval label space + 4 corpus true positives,
tool-registry list). Suite 3773/47 (was 3739; +34).

### §23 Same-format DOCX export — `<w:t>` node rewrite (beta-feedback-2026-07 Phase 9, #22/#23, D77)

The export half of the C wave: **DOCX in → DOCX out with formatting intact.** A Word `.docx` source is
redacted / edited IN PLACE — styles, numbering, tables, headers and every other zip part survive because
the ONLY thing that changes is the text CONTENT inside `<w:t>` nodes of `word/document.xml`. This extends the
D58 "byte-identity outside the located spans" guarantee from the extracted text to the real file: every
non-`document.xml` zip part is byte-identical (decompressed), and inside `document.xml` every character
outside a located span is byte-identical too. PDF/TXT output stays `.txt` (the segment-faithful path); **PDF
re-export is out of scope** (D77 — writing PDFs is a separate problem; a scanned/image PDF has only an OCR
text layer to redact). Builds on the §20 span engine, the §21 redaction locate→verify→sweep, and the §22
edit locate→verify→splice.

- **The faithful `.txt` half was already satisfied** (Phase 7/8): both seams read via `resolveDocumentReader`,
  which prefers the newline-preserving parser SEGMENTS (`readDocumentSegments`) over the collapsed chunk
  table, and the per-char `█` masks (D74) preserve line length — the Phase-7 test "writes a FAITHFUL copy
  from the verbatim segments" pins it. Phase 9 adds the DOCX writer on top.
- **The re-anchoring problem (the crux, D77).** The DOCX `<w:t>` text layer differs from the
  mammoth-extracted chunk text the model located against in Phase 7/8 (mammoth flattens paragraph structure;
  the `<w:t>` layer concatenates run text with a `\n` at each `</w:p>`). So spans verified against the
  extracted text do NOT map to DOCX offsets. The flow for a DOCX source: build the `<w:t>` text layer, **RE-RUN
  the locate pass + verify over THAT layer** (not the extracted text) — producing `TransformSpan[]` in
  DOCX-text-layer offsets — then splice those spans across the node map. The seam reuses the existing PURE
  halves: `redactWithEntities(...).spans` and `verifyAndSpliceEdits(...).spans` now expose the span union
  (Phase 9 additions) so the DOCX writer takes the SPANS, not the final flat string.
- **New module `services/export/docx-rewrite.ts`** (pure, main-side, no fs/net):
  - `readDocxTextLayer(bytes)` → `{ text, nodes }` — loads the zip (jszip), concatenates every `<w:t>`
    node's UNESCAPED text in document order (paragraph-newline separated) and builds a node→offset map.
  - `applySpansToDocx(bytes, spans)` → `Buffer` — re-parses the SAME node map, rewrites only the `<w:t>`
    nodes a span touches (a span crossing a run boundary splits across nodes; the replacement is emitted once,
    in the node where the span starts; unchanged nodes keep their raw escaped bytes verbatim), and re-zips
    with every other part copied through. XML is touched only inside `<w:t>` text content.
  - `jszip` (already transitive under mammoth) is promoted to a **direct dependency** and imported lazily
    (only loads when a `.docx` is actually rewritten).
- **Reading the ORIGINAL stored bytes.** The seams reach content only through segments/chunks, never the raw
  file. `readStoredDocumentBytes` (ingestion) decrypts the stored copy to raw bytes for ANY format (mirror of
  `readStoredDocumentText` but binary); `buildOriginalDocumentReader` (IPC) probes the source format by the
  stored TITLE extension and returns `{ format:'docx', bytes }` ONLY for a Word source (a non-DOCX source is
  never decrypted just to be discovered non-DOCX). The §14 ceiling holds: the **seam** holds the FS/cipher
  reach via the injected closure; the pure tool never does.
- **Binary write + save dialog.** `saveBinaryFile` (IPC) is the `.docx` sibling of `saveTextFile` (identical
  save-dialog + privacy posture, `writeFile` with a Buffer, no `'utf8'`). Each document-transform descriptor
  names its own `docxDialog` (a `.docx` filter) beside its `.txt` `dialog`; the source-format branch lives in
  the **seam** (keyed off the document's stored extension via `readOriginalDocument`): DOCX source → the DOCX
  writer + `redacted.docx`/`edited.docx`; everything else → the unchanged `.txt` path.
- **The seam branch (both `runDocumentRedaction` + `runDocumentEdit`).** A DOCX source with the binary save +
  a confirmed run: build the layer, feed it to the tool as ONE chunk (so the gate/audit/counts run THROUGH the
  tool over exactly the rewritten layer), and the seam ALSO computes the SAME span set and splices it across
  the node map. A structural DOCX failure (corrupt zip / no `document.xml`) FALLS BACK to the segment-faithful
  `.txt` path so the transform still ships. The `.txt` trust model (confirm gate, `saveTextFile`) is unchanged.
- **What Phase 9 does NOT do (recorded).** No PDF writing (PDF/scan output stays `.txt`; a scanned/image PDF
  redacts only its OCR text layer). No DOCX *builder* (docx/docxtemplater would regenerate structure and break
  diff-verifiability) — only `<w:t>` content is rewritten. The model still LOCATES only; it never generates
  output text. The D58 byte-identity invariant is extended to "every non-`document.xml` zip part byte-identical,
  every non-span `<w:t>` char byte-identical".
- **#45 (beta feedback 2026-07-09): the format cliff is now stated BEFORE the run.** The pre-run
  `ConfirmDialog` for the two transform tools appends an output-format line derived from the selected
  target's extension (the same title-extension signal `buildOriginalDocumentReader` branches on):
  `.docx` → "keeps this document's Word format", anything else → "will be plain text (.txt)"; an unknown
  target name falls back to the full matrix line (`chat.skill.confirm.outputDocx`/`outputText`/`outputMatrix`,
  EN+DE). Behavior is unchanged — only the honesty moved earlier. Format-preserving **PDF output stays
  open** (issue #45's stages 1–2): a true-redaction PDF or a regenerated, attributed PDF both need a
  PDF-writing dependency (only `pdfjs-dist`, a reader, is in the tree) and — for regeneration — a shipped
  embeddable font; that is an owner decision recorded in BUILD_STATE §5.

**Tests:** `docx-rewrite.test.ts` (+6: text-layer concatenation/unescape, non-document.xml parts byte-identical
after a rewrite, only the targeted `<w:t>` text changed, a span crossing two runs splits correctly, a
length-changing edit across runs, umlauts/UTF-8 survive), `skills-redaction.test.ts` (+4: DOCX redacted
in place → valid `.docx` + masked layer + parts byte-equal; a located name swept across paragraphs; the
source-format branch; corrupt-DOCX → `.txt` fallback), `skills-document-edit.test.ts` (+2: DOCX edited in
place, occurrence-precise; source-format branch), `skills-privacy-guard.test.ts` (+2: a DOCX-redacted PII /
DOCX-edited find-value touches no sink), `skills-tool-registry.test.ts` (+1: the two document-transform tools
carry a `.docx` `docxDialog`; no other tool does), + the `redactText`/`redactWithEntities`/`verifyAndSpliceEdits`
`spans` field. Suite 3788/47 (was 3773; +15).

### Beta feedback wave 1 (issues #22–#28, D68–D78) — close-out + §-anchor legend

The wave from the first beta session (2026-07-06, lawyer, 0.1.40) is **COMPLETE — Phases 1–10, issues
#22–#28, decisions D68–D78** (BUILD_STATE has the per-phase records). Cluster A (papercuts) + B (scope &
coverage trust) landed in `rag-design.md` + `design-guidelines.md`; cluster C (format-preserving document
transforms) is the §20–§23 sub-record above. Phase 10 added the CI gold set
([`model-benchmarks.md` §12](model-benchmarks.md) — synthetic lawyer documents driven through the pipeline
with a scripted runtime; the real-model + e2e eyeball are recorded there as `PAID_*`/owner manual harnesses),
this legend, and the deletion of the plan.

The working plan `docs/beta-feedback-2026-07-plan.md` was folded into the records below and **deleted** (full
text in git history, per the CLAUDE.md doc-lifecycle rule). In-code comments + kept docs still cite the plan's
`§N` / `DN` and `Phase N`; this legend keeps them **resolvable** without churning the comments. Read a
historical citation as:

| Historical anchor | Meaning | Now lives in |
|---|---|---|
| plan §1 / §2 | Issue clustering; the redaction-skill current-state audit | this legend; §20 (the engine the wave extended) |
| plan §4 / Phase 1 / **D68** | DE citation labels `S{n}`→`Q{n}`, display-time only (#28) | `rag-design.md` §3 (display-time citation-label note) |
| plan §5 / Phase 2 / **D69** | Conversation-memory meter, `role="meter"` not progressbar (#25) | `design-guidelines.md` §11.9 |
| plan §6 / Phase 3 / **D70** | One "Use this model" action = select + start runtime (#27) | `design-guidelines.md` §11.10 |
| plan §7 / Phase 4 / **D71** | Single-document scope by default + always-visible "Answering from:" (#26) | `rag-design.md` §10 (scope subsection) |
| plan §8 / Phase 5 / **D72** | Coverage fraction stamped on every grounded answer (#24) | `rag-design.md` §14.4 |
| plan §9 / Phase 6 / **D74** | Span-transform engine (`applySpans`/`locateOccurrences`, per-char `█` masks) | **§20** (this record) |
| plan §10 / Phase 7 / **D73 · D75 · D78** | LLM-located redaction — locate → verify → sweep; the honesty posture | **§21** (this record) |
| plan §11 / Phase 8 / **D76** | Format-preserving targeted edits — locate → verify → splice (occurrence-precise) (#23) | **§22** (this record) |
| plan §12 / Phase 9 / **D77** | Same-format DOCX export — `<w:t>` node rewrite; PDF re-export out of scope (#22/#23) | **§23** (this record) |
| plan §13 / Phase 10 | Gold set + close-out (fold the plan, delete it) | this legend + `model-benchmarks.md` §12 |
| plan §14 | Offline / privacy / honesty constraints & risks | carried in each record's honesty/privacy notes |

**Disambiguation:** this record contains **two** §20–§23 blocks — the earlier §20–§24 (Wave-2 analysis, PDF
geometry, the bank categorizer, the S&T + backend audit close-outs) and the beta-feedback §20–§23 above. Each
beta header carries its `beta-feedback-2026-07 Phase N` tag, which is the stable grep disambiguator (e.g.
`§21 LLM-located redaction … Phase 7`). Code comments that mean the beta sections cite them by the descriptive
title + phase tag, so the collision never mis-resolves.


## Generic result tables — design record (result-tables wave 2026-07-05, §1–§6 + D59–D67)

_Condensed from the retired working paper `docs/result-tables-plan.md` (all phases — 1, 1.5, 1.6,
2, 3 v1 — shipped 2026-07-05 via PRs #14/#16; file deleted 2026-07-12, full text:
`git show f2b628c:docs/result-tables-plan.md`). **§-anchor legend: the §-numbers below match the
retired plan 1:1**, so code/test/doc citations of the form "result-tables plan §3" / `D59`–`D67`
resolve here unchanged (decision numbering continues the repo series after the
invoice-hardening/whole-doc waves' D44–D58). The consciously-deferred residuals are listed in §6
and tracked for issue-filing at the public flip (BUILD_STATE §5 item 10)._

### §1 The problem (observed failure, 2026-07-05)

"Categorize all transactions and export them, including the category, as CSV" failed although both
halves existed, in five seams: the bank handler's format short-circuit returned on the `csv` token
BEFORE the categorization block ran; `transactionsToCsv` hardcoded seven columns
(`TransactionInput` had no category field); the file-export lane's `loadTransactions` never joined
`bank_categories`; nothing decomposed "categorize AND export" into two steps; and the no-skill
route classified the ask as top-k relevance. Diagnosis: **which rows**, **which columns**, and
**the deliverable** were fused at compile time — every "but what if the user asks for X" failure
(category, subcategory, German column names, grouping) is the same failure. The general fix (D59):
request → typed TableRequest → deterministic rows → constrained-LLM derived columns → generic
table → schema-agnostic serializer → inline render or confirm-gated export, resting on the
runtime's grammar-constrained JSON output (D55).

### §2 Decisions (D59–D63)

| # | Decision | Why |
|---|---|---|
| D59 | Schema-driven table pipeline: separate rows / columns / deliverable; serializers take a `TableSpec` (columns + typed cells), never a fixed struct | Kills the whole class, not one prompt shape; generalizes to invoice line items, deadlines, extractions |
| D60 | `TableSpec` + `tableToCsv` live in `services/tables/` (pure, main-side); `transactionsToCsv` becomes a `TableSpec` builder + delegate | Both CSV surfaces (inline format answer, file export) reuse ONE audited serializer incl. the `csvField` formula-injection neutralization (S12 F4) |
| D61 | `TransactionInput` gains OPTIONAL `category?: string` (+ row schema) | The category travels WITH the row through the existing seams (no index-matched parallel arrays crossing a seam); backward compatible — the extractor never emits it |
| D62 | The category column is **presence-gated**: emitted only when ≥ 1 row carries a category | Byte-identical CSV/JSON for every existing non-category flow (tests pin this); an always-empty column would imply "categorized, all blank" — dishonest |
| D63 | A category-shaped format ask runs the categorize seam FIRST (persisting, `skill_runs` lifecycle intact), then serializes rows+categories; the honest `categoryAssisted`/`categoryRuleBased` note rides under the fenced block | A model-assigned category must never masquerade as a parser figure |

### §3 Phase 1 — schema-agnostic serializer + category end-to-end (as built)

`services/tables/index.ts`: `TableColumn { key, label, kind?: 'text'|'money'|'integer' }`,
`TableSpec`, `tableToCsv()` — money cells fixed 2-dp dot-decimal, `csvField` neutralization on
text, blank for null/undefined, `\r\n` + trailing newline (the existing CSV contract).
`skills/tools/bank-statement.ts`: `TransactionInput.category?` (+ `TRANSACTION_ROW_SCHEMA`);
`transactionsToCsv` builds a presence-gated `TableSpec` (D62) and delegates;
`statementToPlainObject` emits `category` under the same gate (JSON parity).
`skills/analysis/bank-statement.ts`: the category block (seed-if-unpersisted + reload +
`modelAssisted`) hoisted ABOVE the format short-circuit (D63); non-category format asks stay
byte-identical. `skills/run.ts` `loadTransactions`: LEFT JOIN `bank_categories` — the
confirm-gated file export carries the column whenever the statement has been categorized.
Deliberately NOT in scope: chat-triggered file export (stays a confirm-gated UI action; the inline
CSV is copyable) and new i18n keys (the existing `formatIntroCsv` + category notes compose).

### §3a Phase 1.5 — user-defined category sets from the prompt (D64/D65)

"Kategorisiere in Miete, Lebensmittel, Kinder und Sonstiges …" works end-to-end. **D64**: a custom
set runs the enum-constrained categorizer **inline in the chat slot** — not a doctask enqueue (the
chat turn already holds the exclusive model slot, so one llama-server is never hit twice and the
answer arrives in the same turn); with NO runtime the ask is REFUSED with friendly copy echoing
the parsed set — the deterministic rules cannot know the user's labels, and a silent
fixed-taxonomy fallback would answer a different question. **D65**: the prompt parse is
**conservative and all-or-nothing** (`parseRequestedCategories`: categorize stem + preposition,
deliverable-tail cut, ≥ 2 plausible labels of ≤ 40 chars / ≤ 4 words; ONE bad token rejects the
whole parse) — a half-understood list must never silently categorize into garbage; refusal copy
and output both echo the parsed labels so a mis-parse is immediately visible. As built:
`categorizer.ts` takes an optional `categories` list (per-run enum/prompt/validation; prefilter
skipped; `Uncategorized` always appended as the drop target); `persistCategorization` (run.ts)
persists assignments + `categorized_by_model` atomically, inserting user labels as NON-builtin
`bank_categories` rows; the handler REUSES a prior run when the persisted labels ⊆ the requested
set; `categoryLabel` never probes the i18n catalog with a user-defined name (content must not
reach the diagnostics log). `SkillAnalysisContext.runtime` is the one sanctioned model hook,
threaded from `registerRagIpc`.

### §3b Phase 1.6 — taxonomy CSV referenced from the prompt (D66/D67)

"Kategorisiere nach den Kategorien in `taxonomie.csv` …". **D66**: the referenced file is found by
**name across the indexed library** (`findDocumentByName`: case-insensitive title match,
extension-stripped stems, statement excluded, ties → most recently updated) — never by widening
scope, since the bank handler requires exactly ONE in-scope document. **D67**: the CSV's second
column is a per-label **gloss fed to the model prompt** (never persisted, never an enum value) —
`Kinder;Schule, Kita, Taschengeld` → `- Kinder (Schule, Kita, Taschengeld)`; the single biggest
quality lever for custom labels on a small model. As built: `parseTaxonomyFileRef` (categorize
stem + a quoted-or-bare `.csv` token) and `parseTaxonomyCsv` (one label per line,
first-of-`;`/tab/`,` delimiter, header + `#`-comment skip, all-or-nothing like D65, 2–40 labels);
missing / unparseable → honest refusals NAMING the file (`customTaxonomyNotFound` /
`customTaxonomyUnparseable`, EN+DE). The parser understands BOTH text shapes it can be handed —
the raw file and the app CSV importer's LINEARIZED form (`Header: value; …` lines, detected by the
constant first key and reconstructed before the label/gloss split); a full-path reference is
reduced to its basename (the library stores titles, and the app deliberately cannot read an
arbitrary disk path — the file must be imported first). File labels accept real-world shapes
(`Kfz/Auto`, `Essen & Trinken`, `Vers. + Vorsorge`). Caveats (recorded in known-limitations):
filename auto-scope can narrow the turn to the taxonomy file itself; filenames with spaces need
quotes; chunk-boundary splits only matter for files far beyond 40 labels.

### §4 Phase 2 — result-table artifact + message-level export (as built)

`result_tables` (db.ts SCHEMA, next to `extraction_records`): one generic tabular artifact per
assistant message — columns/rows as JSON (CONTENT — never logged/audited), `row_count`, a
content-free `source` discriminator, and a `message_id` FK **ON DELETE CASCADE** (regenerate
delete + conversation delete purge automatically). Store seam `services/tables/store.ts`:
`saveResultTable` best-effort — empty / over-cap (`MAX_RESULT_TABLE_ROWS` 10 000) / unserializable
persists NOTHING and never blocks the answer; `loadResultTable` tolerant like `parseCoverage`.
`SkillAnalysisResult.table?: TableSpec` — the bank format path (CSV *and* JSON asks) emits
`transactionsTableSpec(rows)` (the ONE column definition all tabular surfaces share);
`registerRagIpc` persists it right after the plain-answer `appendMessage` and lights
`Message.hasResultTable` on the returned object; `listMessages` derives the flag via an EXISTS
subselect — table content never rides message loading. `chat:exportMessageTable` IPC:
`requireUnlocked` → `loadResultTable` → `tableToCsv` (the one audited CSV path) → `saveTextExport`
(save dialog = consent, no confirm modal — the transcript-export posture; no BOM on .csv); audit
event `message_table_exported`, metadata `{ messageId, rows }` only. Renderer: an "Export CSV"
action in `MessageActions`, rendered only on answers with `hasResultTable`. Notes: answers
produced before 2026-07-05 carry no table (no backfill — the table is the answer's artifact);
only the bank format path emits one so far (invoice port = §6); tables key off messages, so no
document-purge hook is needed.

### §5 Phase 3 v1 — TableRequest parse + derived-column enrichment (as built + conscious deferrals)

`services/skills/enricher.ts`: **`wantsExtraColumns`** — a cheap deterministic PRE-GATE
(spalte/column/subcategory/payee/… stems): a plain "als CSV" turn stays the Phase-1 **0-model**
short-circuit (pinned by a zero-calls integration test); only a column-shaped ask pays the parse
call. **`parseTableRequest`** — ONE grammar-constrained call (D55) turning the ask into
`DerivedColumn { name, description?, enumValues? }[]` (≤ 4), validated ALL-OR-NOTHING (the D65
posture: an invalid name or one shadowing a fixed column rejects the whole request → plain-table
fallback, never a half-understood one; an empty list is a valid "no extra columns" outcome).
**`enrichRows`** — batched (12 rows/call) per-row fill of EVERY requested column over the WHOLE
extracted row set; enum columns grammar-enum-constrained (+ the `unknown` drop target), free text
length-capped (60); `unknown`/invalid/dropped cells serialize as **blank** — absent, never
invented; unparseable batch → one retry → blanks (the categorizer's L-1/L-2 posture incl. the
runaway-output char cap). Enriched turns emit an EXTENDED `TableSpec` (fixed columns + category
presence-gated + derived columns) through the same fenced answer, the persisted result table, and
the message-level export, with the honest `derivedColumnsNote` (EN+DE) naming the model-filled
columns; any parse/enrich fault falls back to the plain table. **Consciously DEFERRED** (still
open): **no-skill tabular routing** (§1 seam 5 — needs a GENERIC row extractor, which does not
exist; the A4 class-match inversion already routes most statement questions to the handler;
revisit when a second tabular domain lands); the model parse GATES on the deterministic pre-gate
rather than replacing the format regexes (cheaper, honest to D55's cost); `filter` / `groupBy` /
`deliverable` fields of the original TableRequest sketch not parsed; JSON-format asks not
enriched (CSV only in v1).

### §6 Residuals open at retirement (2026-07-12)

Registered for issue-filing at the public flip (BUILD_STATE §5 item 10) and narrated user-facing
in `known-limitations.md` ("categorize … as CSV/JSON"):

- **Invoice parity** — the invoice handler has the same format short-circuit shape; port the
  `TableSpec` delegation there (its serializers already share `csvField`).
- **Derived-column quality eval** — free-form derived columns on a small model need an eval item
  (mitigated today by enum grammars + the explicit `unknown` drop target).
- **No-skill tabular routing** — the §5 deferral; needs a generic row extractor first.
- **`filter`/`groupBy`/`deliverable` parse + JSON-ask enrichment** — the remaining §5 deferrals.

## Test-enforcement seams — design record (full audit 2026-06-29, Phase 3)

The 2026-06-29 audit's testing review flagged a class of gap distinct from a bug: a **security/reliability
control that is correct in isolation but that no test proves stays *wired*.** A regression that silently
stopped *calling* the control (not one that broke the control's logic) would redden no test — the control
could be fully correct and fully unwired. Phase 3 closed four such gaps with test-only additions; every new
test is **teeth-checked** (neuter the guarded control → the test reddens → restore byte-identical), and the
teeth-check is the whole point — a test that passes whether or not the control is wired is worthless here.
The closures deliberately use the **real seam** (the `FakeChild` / llama-runtime / transcriber harnesses, a
recording `fetch`, the real `VisionRuntime`), never a new fake that re-creates the bypass.

- **TEST-2 — spawn seams re-hash the binary before spawn (`tests/integration/binary-verify-spawn.test.ts`,
  new).** The binary-verifier verdict/cache matrix is well unit-tested, and each spawn seam *had* a refusal
  test — but those **inject a fake** `verifyBinary: () => 'mismatch'`, proving only "IF the verdict is
  mismatch, the seam refuses", not that the seam still **calls the real verifier**. The new tests drive the
  real `verifyBinaryBeforeSpawn` end-to-end at all three seams — `LlamaServer.start`, the GPU
  `--list-devices` probe, and the `whisper-cli` spawn — with **packaged enforcement ON**
  (`initBinaryVerification(false)`) and a real on-disk install marker whose recorded hash mismatches the
  binary's bytes: each seam refuses to spawn (no child created). A matching-marker **positive control**
  proves the refusal is genuinely the hash mismatch, not an always-refuse artefact. Teeth: drop the
  `verifyBinary`/`verify` call at a seam → the spawn proceeds and the refusal test reddens
  (verified: LlamaServer resolves instead of rejecting, the probe's spawn count is 1, whisper proceeds).
  See the verifier itself in `security-model.md` "engine-binary re-hash-before-spawn".
- **TEST-3 — an embed failure PROPAGATES at `generateGroundedAnswer`, not only `retrieve()`
  (`tests/integration/rag.test.ts`, +1).** `TEST-N8` proves `retrieve()` rejects on a failing embedder, but
  `generateGroundedAnswer` awaits `retrieve` and early-returns `NO_DOCUMENT_CONTEXT`/`REINDEX_NEEDED` on
  empty chunks — so a regression wrapping `retrieve` in `try/catch → []` would make a transient embed fault
  **masquerade as "no documents"** (a falsely-empty corpus) and redden nothing. The new test uses a **fresh**
  failing embedder (defeating the per-instance query-vector LRU) over a **non-empty** corpus (so the genuine
  empty⇒[] path can't masquerade) and asserts `generateGroundedAnswer` **rejects** rather than returning the
  friendly no-context answer. Teeth: swallow the `retrieve` into `[]` → it resolves with the no-context
  answer and the test reddens.
- **TEST-4 — the installer's coded error constants (`tests/integration/skills-installer.test.ts`, +4).**
  Three coded guards had no test: the ZIP64 / encrypted-GP-flag rejection (`encryptedZip` — both the GP-flag
  bit-0 path and the `0xFFFFFFFF` ZIP64-sentinel size path), the **SEC-N1** NUL-byte content-leak defence
  (`invalidPath`, asserting the fixed reason never echoes the crafted name), and the path-length cap
  (`pathTooLong`). Each is driven through the real `previewSkillPackage`/`importSkill` and asserts the fixed
  structural reason + its stable `errorCode` (never throws raw / leaks a path). The "never routes through
  tar" test is relabelled **documentation-only** (a source grep — there is no runtime call site to intercept,
  since the installer simply never imports the shell-tar extractor). Teeth: neuter each named guard → its
  fixture's `errorCodes` assertion no longer holds.
- **TEST-5 — the real `VisionRuntime` success path keeps the no-leak guarantee
  (`tests/integration/vision-security.test.ts`, converted in place).** The success-path no-leak test
  previously replaced `createRuntime` with a hand-written fake `analyze`, so the **real** runtime's request
  construction (base64-inlining the image into the data-URL body) + SSE parsing were never exercised by the
  no-leak assertion. It now runs through the real `VisionRuntime` (recording `fetch` + an SSE body), so the
  prompt + image bytes genuinely pass through `runAnalyze` → `server.fetch('/v1/chat/completions', …)` →
  `readChatSSE`, then asserts NO diagnostics-log call (any level) carries the prompt, the answer, or the
  base64 image bytes. Teeth: log `opts.question` or the image data-URL at the runtime layer → the spy
  captures it and the test reddens.
- **TEST-6 (INFO) — answer-quality floor in CI is partial, by design.** *(Wording corrected Phase 7 / D1 —
  the original claim that the S13b bar was "owner-gated on D1 / not yet landed" went stale the moment the bar
  shipped.)* The **S13b skill-trigger precision bar IS a live CI gate**: `eval/skill-triggers.test.ts` asserts
  the ratified `threshold-3` auto-fire policy clears D1 on the labelled corpus — `fired-wrong == 0` **AND**
  `precision ≥ 0.95` (§18) — so any regression of `scoreSkillTriggers`/the threshold reddens CI. The
  `eval/skill-triggers` *measurement* block (precision/recall + confusion matrix) still prints as a baseline
  alongside it. What remains **without** an automated CI floor is **narrower**: real-model **RAG answer
  quality** (faithfulness/grounding output) and the **real-model quality benchmarks**, which are **env-gated
  out of CI by design** (they need GGUF weights CI doesn't ship; see `model-benchmarks.md` D19). Net: those
  remaining accuracy dimensions are caught **only by the manual smoke matrix** (the deliberate separate human
  pre-release gate, like the `HILBERTRAUM_*` artifact smokes) — an accepted posture.

Suite after Phase 3: **2446 passed / 39 skipped (2485 collected)** (was 2437/39 → **+9 tests**; TEST-5 was a
conversion, not an addition). No `src/` behavior change — the only source edits were the temporary
teeth-check neuters, each restored byte-identical.

### Post-merge audit (2026-06-29), Phase 5 — five more seams (T1/T2/T6/T7/T8), one nit (T9), one verify (T3)

The post-merge audit's §4 testing review found the same *class* recurring — a control correct in isolation but
not proven *wired* — at five more seams. Phase 5 closes them with the same discipline (real seam, inject only
at the boundary, every closure teeth-checked). **Test-only; `git diff src/` empty.** The §31 ledger above
carries the one-line disposition for each; the detail and teeth:

- **T1 — SIGTERM-ignore → SIGKILL escalation, now teeth-tested at the UNIT tier
  (`tests/unit/sidecar.test.ts`, +1).** The file's `FakeChild.kill()` exits on ANY signal, so
  `LlamaServer.stop()` always settled on the "exited" branch and never reached the escalation — the integration
  tier was the only place it was genuinely exercised. The new test uses a **stubborn child** (the LlamaServer
  mirror of the transcriber's `makeStubbornChild(['SIGKILL'])`): it records each kill signal, sets `killed`
  the moment a signal is *sent* (real `ChildProcess` semantics), but only emits `exit` on `SIGKILL`. With a
  1 ms `killGraceMs` it asserts `signals == [undefined,'SIGKILL']` (polite SIGTERM first, then forceful
  escalation). Teeth: revert the line-576 escalation gate `if (!this.exited)` → `if (!child.killed)` (the exact
  bug the line-572 comment warns about — `child.killed` is true the instant a signal is sent) → SIGKILL is
  never sent → `signals` stays `[undefined]` → reds.
- **T2 — resident-cache lock-PURGE wiring, now asserted at the IPC layer
  (`tests/integration/workspace-ipc.test.ts`, +1).** `purgeResidentVectors` (RAG-6, a stated SECURITY
  requirement — chunk-text-derived vectors must not linger in main-process RAM after the vault re-encrypts) was
  proven only at the unit tier (`resident-cache-incremental.test.ts`); the lock IPC's *call* to it was
  unasserted. The new test seeds a REAL resident map (doc → chunk → embedding → `getResidentVectors`), locks
  via the real IPC handler, and asserts the purge fired against the LIVE workspace db. The spy delegates to the
  real `purgeResidentVectors` (sharing the real `caches` singleton, the resident-cache-incremental decode-spy
  idiom), so the genuine purge still runs; the captured arg is asserted by **reference** (`toBe`, not
  `toHaveBeenCalledWith`) because the post-lock db is closed and a deep-compare would touch its throwing
  `isTransaction` getter. Teeth: drop `purgeResidentVectors(ctx.db)` from the lock handler → spy 0× → reds.
- **T6 — GPU-probe timeout, de-flaked to fake timers (`tests/unit/gpu.test.ts`, converted in place).** The old
  test awaited a real 20 ms `setTimeout` against a never-exiting child — a TEST-1-family wall-clock flake. It
  now drives the probe's own kill-timeout through `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(20)` (the
  `combine-signals.test.ts` idiom), with `verify` injected as a trivial resolver so only the timeout path is
  under fake-timer control (no real fs/microtask racing the timer; the verify path has its own test). The
  assertion is preserved (probe resolves `[]` on timeout AND the child is killed). Teeth: neuter the timeout's
  `child.kill('SIGKILL')` → `child.killed` stays false → reds.
- **T7 — privacy-guard snapshot poll, de-flaked to `vi.waitFor`
  (`tests/integration/skills-privacy-guard.test.ts`, converted in place).** The old `for(i<50 &&
  running){sleep(5)}` was a structural TEST-1 sibling (bounded iterations × a fixed sleep over mutable state).
  It now re-polls via `vi.waitFor` (the `gpu-ipc.test.ts` idiom) until the run settles, no fixed cap; the
  no-secret-in-snapshot assertions are preserved. (The optional redundant real-timer copies in
  `vision-runtime.test.ts` were left as-is — converting them needs the fakeClock injection seam, beyond a quick
  nit.)
- **T8 — crash-fallback now pins a REAL child reap, not just a stop()-wrapper count
  (`tests/integration/runtime-manager.test.ts`, +2 assertions).** The crash test counted a monkey-patched
  `stop()` wrapper (`made[0].stops===1`), which still holds if a regression makes `stop()` stop reaching the
  child kill (an orphan). The test now also asserts observable child state: a final `mgr.stop()` +
  `children[1].child.killed===true` (the LIVE restarted CPU child is genuinely killed). This **DIVERGED from
  the audit's literal "crashed child `killed===true`"** — empirically the crashed GPU child already `exited`
  (via `crash()`), so the manager's `stop()` correctly early-returns on `this.exited` *before* any kill and the
  crashed child's `killed` stays **false** (asserting true would red on correct code — verified). The genuine
  "stop reaches the kill / no orphan" property lives on the live child instead. Teeth: early-return `stop()`
  before the kill → the live child's `killed` stays false → reds (while `made[0].stops===1` still passes —
  exactly the gap T8 closes).
- **T9 (nit) — AES-GCM truncated-ciphertext at the `crypto.ts` unit tier (`tests/unit/crypto.test.ts`, +1).** A
  length-reduced ciphertext (distinct from the existing bit-flip cases) must still fail GCM authentication
  (the tag was computed over the full ciphertext); the streaming layer already covers a truncated on-disk
  frame, this pins core `decrypt` itself. The other T9 nits were dispositioned in Phase 1 (invoice negative
  line totals / Gutschrift/Rabatt) or left as accepted (the tautological `BANK_EXTRACTOR_VERSION` tripwire;
  the mock-embedder score-band).
- **T3 (verify only) — subsumed by F16.** `tests/integration/ipc-lock-coverage.test.ts` drives
  `registerRagIpc` against a locked ctx with no exemptions, so `rag:ask` is enumerated and asserted to reject
  with the localized lock copy. No separate Phase-5 test added (confirmed green).

Suite after Phase 5: **2518 passed / 39 skipped (2557 collected)** (was 2515/39 after Phase 4 → **+3 tests**;
T6/T7/T8 were conversions/strengthenings, not additions). **No `src/` behavior change** — the only source
edits were the temporary teeth-check neuters, each restored byte-identical (`git diff src/` empty).

### Full audit (2026-06-29, follow-up), Phase 7 — test-suite robustness (TEST-3 / TEST-1 / DX-4 / DX-2 / DX-5 / DX-6)

The 2026-06-29 follow-up audit's §4 testing review found the same recurring class — plus the one
**material coverage gap** (no automated end-to-end RAG-retrieval floor) and an actively-flaky block.
Phase 7 is **test-only**: `git diff src/` is a SINGLE line (DX-2's DEV-guard). It closes the gap, retires
the flaky vision real-timer block, and makes three "works today but no test proves it stays wired" seams
self-enforcing — every added wiring test TEETH-CHECKED with the standing discipline (neuter the guarded
control → red → restore byte-identical). Suite **2589 passed / 39 skipped** (was 2586/39 after Phase 6 →
**+3 net**: TEST-3 ×3 + DX-4 ×1 + DX-5 ×1 − TEST-1 net ×2; DX-2/DX-6 are guards/conversions, no count change).

- **TEST-3 — model-free RAG-pipeline retrieval FLOOR (`tests/integration/rag-pipeline-floor.test.ts`, new,
  +3).** The scorer (`eval/score.test.ts`) and the S13b skill-trigger precision bar are CI-gated, but
  actual retrieval→answer quality was asserted ONLY in env-gated MANUAL suites (`tests/manual/model-eval`,
  `rag-quality`) — so a regression in chunking / embedding-prefix / reranking / `ragMinSimilarity` / top-k /
  FUSION / citation assembly passed CI green. The floor draws the mock line at the SAME `MockEmbedder` seam
  the RAG integration suite uses (deterministic, hash-based, offline) over a CONSTRUCTED corpus where the
  known-correct chunk wins both the vector and the keyword channel, then runs the REAL pipeline end-to-end:
  real chunker (`processDocument`) → `MockEmbedder` → `VectorIndex` cosine scan → FTS5 keyword scan → RRF
  fusion → dedup → top-k trim → `[Sn]`/`Citation[]` assembly. Asserts (a) the known-correct chunk ranks #1
  with its citation assembled, (b) the result caps at `topKFinal`, (c) `generateGroundedAnswer` persists a
  cited answer whose first citation is the answer doc. The real-model EM/hallucination benchmark stays
  MANUAL; this guards the PLUMBING that feeds it. Teeth: reverse `rrfFuse`'s sort (rag/hybrid.ts) → a
  distractor ranks first → (a)/(c) red (verified); drop the `selected.length >= topKFinal` break
  (rag/index.ts) → 5 returned → (b) red (verified).
- **TEST-1 — the flaky real-timer vision idle-teardown block is DELETED
  (`tests/integration/vision-runtime.test.ts`, net −2).** It raced real `setTimeout`s against tiny
  `idleTimeoutMs` in BOTH directions (`sleep(15)` not-yet-torn-down, `sleep(60)` torn-down) — the known
  T6/T7 "real-timer copies left" residual. Every case it covered is now asserted DETERMINISTICALLY by the
  injected-clock twin: teardown-after-idle + cold restart → (b), in-flight guard → (a); the two UNCOVERED
  cases were PORTED — clock-reset → new **(d)** (re-entry CLEARS T1 / re-arms T2, asserted via the fake
  clock's `set`/`clear` counts, then T2 fires the teardown), stop()-cancels-timer → new **(f)** (stop()
  clears the pending timer; a later stale fire is inert via the `stopped` guard in `idleTeardown`). No idle
  `sleep` remains in the block; stable across repeated full-suite runs.
- **DX-4 — IPC lock-guard enumeration is now self-checking
  (`tests/integration/ipc-lock-coverage.test.ts`, +1).** The hand-kept `MODULES` array + a free-text
  "covered elsewhere" comment meant a NEW `register*Ipc` module simply not listed went entirely unchecked
  (the exact drift the file exists to prevent). New meta-assertion globs EVERY `register*Ipc` export from
  the source tree (regex on the `export function` decl) and asserts union(`MODULES`, the new
  `COVERED_ELSEWHERE` reason-map) == discovered (`unaccounted == stale == []`). `COVERED_ELSEWHERE`
  annotates each of the 9 not-driven-here modules with WHY (a named dedicated locked-vault test, or
  pre-unlock-by-design at the setup gate — download/engine guard their lone `ctx.db` read behind
  `isUnlocked()`; dictation never touches `ctx.db`; workspace IS the lock gate). Teeth: add a stub
  `src/main/ipc/registerStubIpc.ts` → it lands in `unaccounted` → reds (verified; stub deleted).
- **DX-2 — the `__docRowRenderCounts` perf instrument no longer ships active in production
  (`renderer/screens/DocumentsScreen.tsx`, the SOLE `src/` line).** The per-render Map write is guarded
  behind `import.meta.env.DEV`, so it no-ops in a production build (verified: `npm run build` clean);
  vitest runs with DEV true, so the PERF-5 memo test (`DocumentsScreen.test.tsx`, 48 green) still observes
  the bumps. No production behaviour change (the exported Map stays an empty no-op in prod).
- **DX-5 — the sidecar crash → auto-fallback WIRING is pinned end-to-end
  (`tests/integration/runtime-ladder-exit-wiring.test.ts`, new, +1).** `runtime-ladder.test.ts` proves the
  ladder ROUTES a crash by hand-invoking `calls[0].onUnexpectedExit(info)` on a STUB makeLlama — never that
  the real `LlamaServer` wires its child's `'exit'` event to that callback. The new test drives the REAL
  `createLlamaRuntime`→`LlamaServer` (only spawn/fetch/port injected, the e5/reranker/vision gated-child
  style), starts it to healthy on a GPU-reporting probe (backend `'gpu'`), then emits a REAL `'exit'`
  (code 134 + a stderr tail) and asserts the §5.3 GPU crash auto-fallback fired: persisted failure
  carrying `code 134` + the tail, the compatibility-mode notice, and ONE CPU restart of the same model.
  Teeth: drop the `this.opts.onUnexpectedExit?.()` call in `LlamaServer`'s `'exit'` handler (or its
  `ready && !stopping` gate) → no crash reaches the ladder → `restarts`/`persisted` stay empty → reds
  (verified).
- **DX-6 — three settle-window real sleeps converted to deterministic waits (no count change).**
  `reranker.test.ts` / `e5-embedder.test.ts`: the fixed 25 ms "nothing spawned in the teardown window"
  sleep is replaced by `expect(await {rerank,embed}2).toBe('rejected')` — under the F19 `tearingDown`
  guard the racing call REFUSES on its own, so the absence is asserted by its settled outcome (a regression
  that spawned a second child instead resolves `'ok'` AND bumps the spawn count the final assertion still
  checks). `doctasks.test.ts`: the 40 ms "let the stream start" sleep is replaced by
  `while (runtime.concurrent === 0) await tick()` (the scripted runtime's observable in-flight count), so
  the mid-stream cancel lands deterministically once a generation is genuinely running. These assert/await
  an absence-or-start so they are un-teeth-checkable by nature, but no longer race the wall clock.

`git diff src/` after Phase 7 = the single DX-2 DEV-guard line; every teeth-check neuter (hybrid.ts fusion
sort, rag/index.ts top-k break, sidecar.ts `'exit'`→hook) was restored byte-identical, and the DX-4 stub
module was deleted.

### Full audit (2026-06-30), Phase F — test-suite robustness (T1 / T2 / T3; T5–T7 dispositions)

The 2026-06-30 audit's §4 testing review found the same two recurring failure modes the earlier rounds chased:
**(a) timing-dependent premises** (a fixed `sleep(N)` that, under CPU starvation, lets the assertion pass
**vacuously** before the interleave it means to exercise even happens) and **(b) private-state / implementation-
detail oracles** (a counter or flag that passes whether or not the real user-visible behavior holds) — plus two
coverage gaps (transaction rollback, SSRF numeric-host). Phase F is **test-only** (branch
`audit-2026-06-30-phaseF-tests`, stacked on C): `git diff src/` is **EMPTY** (the T7 numeric-host gap turned out
already-closed by the URL parser — no guard change needed). Every new oracle drives the **real** entry point
(`VisionService`, the real `DocTaskManager`+handlers, the real `processDocument`, the real `changePassword`, the
real `assertSafeDownloadUrl`), determinism comes from injected gates + state-polling (NEVER a fixed `sleep(N)` to
gate a correctness premise), and every added rollback/flag oracle is **teeth-checked** (neuter the guarded control
→ red → restore byte-identical). Suite **2673 passed / 41 skipped** (Phase-C baseline 2669/41 → **+4**: T3 ×2
rollback + T7 ×2 SSRF; T1/T2/T6 were de-flakes/strengthenings at the same test count). **T4** (the `money.ts`
pure-function table test) landed WITH Phase A, not here (§4 T4 ✅).

- **T1 — the vision teardown/cancel real-timer sleeps are replaced by deterministic park gates
  (`tests/integration/vision-teardown.test.ts` + `vision-cancel.test.ts`, de-flaked in place).** `void this.run(…)`
  is launched detached, so a fixed `sleep(2)`/`sleep(5)` was the ONLY thing "guaranteeing" the run() had reached
  the interleave point (the `getStatus()` park / the gated runtime stop) before the teardown fired — under load it
  hadn't, and `expect(createCalls).toBe(0)` could pass without the REL-2 interleave happening at all. Each test now
  PARKS the run() on an injected gate and `while (cond) await tick()`-polls an observable counter (the gated
  `getStatus`/`stop` flips `statusEntries`/`stopEntered`; the racing job is polled to a settled state) before the
  teardown — `setImmediate` queue-drains, no wall clock. **Teeth (verified empirically against the real
  `VisionService`, recorded honestly per the R7 co-guarded-twin precedent):** both REL-2 `tearingDown` checks (the
  top-of-run latch AND the post-`getStatus()` re-check) are **co-guards**, so each scenario reddens only on its
  DUAL neuter, never a single one — (1) a fresh-controller analyze during an in-flight teardown is co-guarded by
  the **top latch + post-getStatus re-check** (neuter both → a 2nd runtime spawns → red; either alone is
  backstopped); (2) a run() parked in `getStatus()` during a genuinely IN-FLIGHT teardown is co-guarded by
  **`signal.aborted` + the post-getStatus re-check** (neuter both → red; either alone green). Test (2) was
  redesigned to hold the teardown in flight (gated runtime stop) so the post-`getStatus()` re-check — the exact
  guard the audit worried could ship green vacuously — is a LIVE co-guard there, not bypassed by a completed
  `stop()`. The vision-cancel F18 dual-neuter (drop the abort re-check AND the `set()` cancelled-guard → the
  cancelled job is resurrected to `done`) still reds with the deterministic drain. *(Discovered: the prior
  vision-teardown comment claimed the top latch was a load-bearing SINGLE neuter — empirically it is co-guarded by
  the post-getStatus re-check; the comment is corrected.)*
- **T2 — the DocumentsScreen render-count deltas are now PAIRED with user-visible behavioral assertions
  (`tests/renderer/DocumentsScreen.test.tsx`, both PERF-5 memo cases strengthened).** The private
  `__docRowRenderCounts` Map was the SOLE oracle, so a regression where the click stops toggling selection / opening
  the menu (but an unrelated re-render still bumps the count) passed green — and since DX-2 DEV-guards the counter,
  the oracle degenerates if DEV ever flips. Each test now asserts the click's EFFECT first — selection toggle:
  `toBeChecked()` on the toggled row, the siblings `not.toBeChecked()`, and the selection toolbar reads `1 selected`;
  ⋯ menu: `getByRole('menu')` opened with its `Re-index` item, the sibling row titles intact — then keeps the
  render-count deltas as a SECONDARY perf oracle. **Teeth:** dropping `memo(DocRow)` reds the delta assertions
  (perf oracle intact) while the behavioral assertions still pass (proving the two layers are independent); a
  toggle/open regression would red the behavioral layer the counter could not catch.
- **T3 — injected-failure ROLLBACK coverage extended to the categorize persist and the ingestion chunk-insert loop
  (the two genuinely-untested high-blast-radius BEGIN…COMMIT sites).** Mirroring the `data-layer-hardening`
  gold standard (`deleteConversation`): wrap the **real** shared connection so one targeted `.run()` throws
  mid-transaction, drive the **real** function, and assert (a) NOTHING partial persisted AND (b) a subsequent
  `BEGIN/COMMIT` succeeds (the single shared `DatabaseSync` is not poisoned). **(i)** `doctasks-categorize.test.ts`
  — the real `DocTaskManager`+`runCategorize` persist (handlers/categorize.ts:110); throw on the first
  `UPDATE bank_transactions SET category_id` → rows stay uncategorized, the in-txn `ensureBuiltinCategories` seed is
  rolled back (`bank_categories` count 0), the statement is never marked model-assisted, a fresh `BEGIN/COMMIT`
  opens, and a one-shot-recovered clean re-run categorizes normally. **(ii)** `ingestion.test.ts` — the real
  `processDocument` chunk transaction (ingestion/index.ts:750, the ~1000-insert loop); throw on the SECOND
  `INSERT INTO chunks` so a chunk is inserted-then-rolled-back → `chunkCount 0`, connection clean, clean re-process
  indexes. **Teeth:** neuter each handler's `ROLLBACK` → the dangling `BEGIN` poisons the connection / a partial
  row survives → both tests red; restored. *(Discovered — the audit's "only 1 of ~12 sites tested" is inaccurate:
  `commitNode` already has the H11 injected-edge-insert rollback test (`whole-doc-analysis.test.ts:421`) and the
  extraction insert has its own (`whole-doc-extract.test.ts:221`) — both driving the real function with the gold-
  standard assertions; T3 closes the categorize + ingestion gaps, the genuinely-missing pair.)*
- **T5 (Low, backlog) — swept the integration suite for fixed `sleep(N)` that gate a CORRECTNESS premise; converted
  the cheap ones, recorded the residuals.** Most fixed-duration `setTimeout` are STATE-POLL loop intervals
  (`while (cond) … setTimeout`, e.g. the `waitTerminal`/`waitFor`/`pollUntil` helpers and the `while (!x.release)`
  gates) — deterministic by construction, left as-is. The three genuine correctness-gates converted to state-polls:
  `reranker.test.ts:125` and `e5-embedder.test.ts:262` (`sleep(1)` "let the request reach fetch" → `while
  (!seenSignal) await …` so the abort lands only after the signal was genuinely handed to fetch), and
  `ocr-task.test.ts:210` (`sleep(30)` "let the task start" → a `rasterizeReached` flag in the gate, polled, so the
  cancel lands once the task is genuinely parked rasterizing). **Recorded residuals (NOT converted, with rationale,
  per "keep the timeout headroom"):** `chat.test.ts:171` + `image-history.test.ts:111` are timestamp-monotonicity
  gaps (a small real-clock gap so `updated_at` strictly increases — converting needs a timestamp-injection seam
  into `createConversation`/`appendMessage`/`addImageTurn`, out of test-only scope; low flake risk given ISO-ms
  resolution + real elapsed insert work); `core-model-ipc.test.ts:448` is an ABSENCE-settle for a wrongly-fired
  fire-and-forget `void startModelRuntime(…)` (in the correct case NO racing call exists to await, so the 50 ms is
  a low-risk upper bound on a would-be async start); `ingestion-limits.test.ts:80/254` are deliberate slow-operation
  SIMULATIONS (the duration MODELS a slow parse to exercise the wall-clock timeout — correct as-is, not a gate).
  **The full-suite 3× (15 s) timeout headroom (vitest.config.ts) is RETAINED** — it absorbs the orthogonal,
  pre-existing CPU-starvation renderer flake ("1-2 per run, a different test each time, all pass in isolation"),
  which Phase F neither introduced nor is in scope to eliminate (it is a load-timeout, not a fixed-sleep premise
  gate); observed once across four full runs (an untouched DocumentsScreen `organization` case), passing in
  isolation, with two consecutive identical green runs confirmed.
- **T6 (Low, backlog) — the password-change race guard now pins the REAL `changingPassword` lifecycle, not the
  poked field (`password-change.test.ts`, the doc-work direction).** The old test SET the private flag from outside
  and asserted only the guard's CONSEQUENCE (`beginDocumentWork` throws when the flag is set) — if `changePassword`
  forgot to set/clear it, the test still passed. Since `changePassword` is synchronous (no outside interleave), the
  test now traps the private flag via `Object.defineProperty` to (1) RECORD its real transitions and (2) at the
  instant the real `changePassword` flips it true (mid-work), prove `beginDocumentWork()` is genuinely refused —
  asserting `transitions === [true, false]` (SET then CLEARED around the real Argon2id rewrap) AND
  `refusedWhileChanging`. **Teeth:** neuter `changePassword`'s `this.changingPassword = true` → `transitions` is
  `[false]` and the refusal never fires → red (the old field-poking test could not catch this). The reciprocal
  direction (a real doc-work lease refusing a real `changePassword`, `password-change.test.ts:375`) was already
  strong and is left intact.
- **T7 (Low, backlog) — already-mitigated; pinned, NO src change.** The audit flagged the SSRF deny-list
  (`assets.ts isPrivateOrLoopbackHost`) as "literal-dotted-decimal only", missing decimal/octal/hex IP encodings of
  loopback (`https://2130706433/`). Driving the REAL path shows it is NOT bypassable: `assertSafeDownloadUrl` reads
  the host via `new URL(raw).hostname`, and the **WHATWG URL parser CANONICALIZES every numeric IPv4 spelling to
  dotted-decimal** before the classifier sees it (`new URL('https://2130706433/').hostname === '127.0.0.1'`,
  `0x7f000001`/`017700000001`/`0x7f.0.0.1` likewise; `2852039166` → `169.254.169.254`), so the existing
  dotted-decimal deny-regex already rejects them. Pinned with regression tests in BOTH the F15 styles
  (`assets.test.ts`): an integration test that the real `downloadToFile`→`assertSafeDownloadUrl` rejects a redirect
  to each numeric encoding with `/private\/loopback/`, and a unit test that `isPrivateOrLoopbackHost(new
  URL(…).hostname)` denies them. The decision (numeric-host SSRF is closed by URL canonicalization, no guard change)
  is now documented and regression-guarded rather than left undocumented.

`git diff src/` after Phase F = **EMPTY** (test-only; the T7 gap was already closed by the URL parser, so no guard
change was made); every teeth-check neuter (vision `tearingDown`×2 / `signal.aborted` / the F18 pair, `memo(DocRow)`,
the categorize + ingestion `ROLLBACK`s, `changePassword`'s flag SET) was restored byte-identical.


### §39 Full audit (2026-06-30) — Phase C (lock/teardown reliability; R1 live + R2–R7 latent)

**Phase C** (branch `audit-2026-06-30-phaseC-reliability`, stacked on the Phase-B perf branch) closes the
one genuinely LIVE teardown race the audit found (R1) plus six LATENT / defense-in-depth concurrency &
lifecycle hazards (R2–R7). Behavior-preserving — no schema / IPC / audit-payload change; each guard is
independently revertible and teeth-checked by a DETERMINISTIC interleave test (injected clocks / gated
promises / state-polling, no `sleep(N)`) that RED→GREENs, with the neuter restored byte-identical. Content
class (document text, chat, figures) is never logged — a teardown diagnostic carries ids + the error
message only. Suite **2669 passed / 41 skipped** (Phase-B baseline 2653/41 → **+16** Phase-C tests);
`npm run typecheck` + `npm run build` green; two consecutive full runs identical (no new timing flake).

- **R1 (Medium — the live race) — the lock/quit path could persist a chat partial against a closing DB.**
  `lockWorkspace`/`performShutdown` aborted in-flight streams then awaited `runtime.stop()` + purge + `lock()`,
  but the partial-reply persistence runs in the chat IPC's OWN promise (the `for await` unwinds →
  `generateAssistantMessage` → `appendMessage`), which the teardown NEVER awaited — `inFlightStreams` held
  only `AbortController`s. It relied on `runtime.stop()` outrunning the abort-unwind; for an already-exited /
  mock sidecar `stop()` can resolve first → either the partial is silently dropped (the REL-4 data-loss class,
  on the lock path) or `appendMessage` throws against the now-closed DB → an UNHANDLED REJECTION only
  `log.warn`'d by the global handler. **Fix (deterministic, two layers):** (1) `withChatStream` now publishes a
  per-stream **`streamSettled`** promise alongside the controller (`ipc/inflight.ts`), resolved (never
  rejected) in its `finally` AFTER the run — and thus its abort-driven `appendMessage` — fully unwinds;
  `lockWorkspace` and `performShutdown` call **`awaitInFlightStreamsSettled()`** after the sidecar stop and
  before purge/`lock()`, so persist-before-close is the ORDERING, not a race (placed AFTER the stop so a
  generation ignoring its signal is still unwound by the dead sidecar — no teardown stall; `allSettled` so one
  stream can't block teardown). (2) Defense-in-depth: `generateAssistantMessage` wraps the partial-persist
  `appendMessage` and swallows cleanly (→ empty message, a `log.warn` with the conversation id only) when
  `opts.signal?.aborted && !db.isOpen` — a locked DB during an ABORT persist — while a genuine open-DB error
  still propagates. This SUPERSEDES the §37 REL-4 "the partial persists during the awaited `runtime.stop()`
  window" reliance (that was the race). Teeth: drop either settle-await → the lock/quit ordering test reds (DB
  closed before the partial persists); drop the guard → the locked-DB persist test rejects instead of resolving
  empty. (`ipc/inflight.ts`, `ipc/chat-stream.ts`, `ipc/registerWorkspaceIpc.ts`, `main/shutdown.ts`,
  `services/chat.ts`; tests `chat-stream` ×2, `shutdown` ×1, `workspace-ipc` ×1, `lock-stream-persistence` ×3.)
- **R2 (Medium, latent) — arbiter `acquireForChat` fast path installed no abort listener.** When a yielding
  build is ALREADY parked (`reacquireReject !== null`), the fast path increments `chatHolders` and skips
  `waitForHandoff` — so an aborted fast-path holder freed its slot only when `withChatStream`'s `finally` ran
  the returned release fn (a transient stall: the build resumed only via the OTHER chat). **Fix:** install the
  release-on-abort on BOTH paths — a single `release` closure (shared `released` latch with the returned fn, so
  the slot is given back EXACTLY once) plus `signal.addEventListener('abort', release, { once })`. The slow
  path's `waitForHandoff` still handles an abort WHILE PARKED and throws before the listener is installed.
  Teeth: neuter the listener → the parked-build resume test reds (chatHolders stuck); the idempotency test pins
  no double-decrement (a naive fix would resume the build prematurely). (`analysis/model-slot-arbiter.ts`;
  `model-slot-arbiter.test.ts` ×2.)
- **R3 (Medium, latent) — resident-cache reconcile mutated the live map in place before committing.** A throw
  mid-`reconcileDelta`/`reconcileFull` (a transient DB read error / truncated row) left the map half-mutated
  (some removed ids dropped, only some added ids decoded). Single-threaded synchrony means no search observes
  it mid-reconcile, and `pending` staying set self-heals on the next query — but the in-place-before-commit
  ordering was the one spot a throw left mixed state. **Fix:** STAGE every decode into a local array (the new
  pure `decodeRow`), then APPLY removals + additions to the live maps in one throwless `applyStaged` step — a
  throw during staging leaves the prior committed maps untouched for a clean retry. `byChunk` + `modelByChunk`
  commit TOGETHER (the P2 key-alignment invariant). Crucially this stages only the |added|+|removed| delta, NOT
  a clone of the resident map, so **Phase-B P2 resident-iteration and the F12 O(K) delta perf are preserved**;
  the deferred-P6 `COUNT(*)` staleness path is untouched. Teeth: inject a `db.prepare` whose 2nd point-lookup
  throws mid-reconcile → the live map is still the pristine base at the throw (with in-place mutation it already
  shows the partial), and the next clean query equals a from-scratch build. (`embeddings/resident-cache.ts`;
  `resident-cache.test.ts` ×1.)
- **R4 (Low, latent) — OCR pipeline double-drained the final page's recognition.** The in-try final `await
  prevOnPage` and the catch's `await prevOnPage.catch(...)` both awaited the SAME already-settled promise for
  the last page (harmless, but the "drain the in-flight look-ahead" guarantee is wrong for the last page — there
  is none). **Fix:** `const last = prevOnPage; prevOnPage = null; if (last) await last`, so the catch only
  drains a genuinely still-pending look-ahead (a render/abort throw mid-loop while recognize(N-1) runs). Teeth:
  the final-page recognition is awaited exactly once (no catch re-await). (`ocr/pipeline.ts`; `ocr-pipeline.test.ts` ×1.)
- **R5 (Low, latent) — GPU probe re-spawn stacked children on "Try GPU again" mashing.** The probe timeout
  `SIGKILL`s but doesn't await the (unref'd) reap, and `invalidate()` did `cache.clear()` unconditionally — so
  rapid invalidate()+re-probe WHILE a probe was still in flight dropped the in-flight entry and spawned a SECOND
  child per click. **Fix:** track `inFlight` per binary; `invalidate()` drops only SETTLED entries, and a
  re-probe during the in-flight window COALESCES onto the existing promise (one child) — the entry becomes
  invalidate-able once it settles, so the feature (a fresh probe after a settled timeout) is intact. Teeth: with
  the old `cache.clear`, mashing during an in-flight probe spawns 1+N children; coalesced → 1.
  (`runtime/gpu.ts`; `gpu.test.ts` ×1.)
- **R6 (Low, latent) — OCR rasterizer `expect()` orphaned a superseded waiter.** A fresh `expect(channel)`
  overwrote a pending `waiter` without settling it; safe under today's single-in-flight protocol, but a
  duplicate frame / refactor would orphan the prior promise to its 60 s `withTimeout`. **Fix:** the per-run
  waiter closure is extracted to a pure, exported `RasterReplySlot` (behavior-identical: `expect`/`awaits`/
  `deliver`/`fail` map 1:1 to the old `waiter`/`expectChannel` logic) whose `expect()` REJECTS a still-pending
  prior waiter (`'superseded'`) before re-arming. Teeth: two `expect()`s without an intervening settle → the
  first rejects rather than hangs. (`ocr/rasterizer.ts`; new `ocr-rasterizer-slot.test.ts` ×3.)
- **R7 (Low, latent) — vision `analyze()` finally `armIdleTimer()` vs a concurrent `stop()`.** The audit flagged
  a timer armed in `stop()`'s await window surviving its `cancelIdleTimer()`. **Verified ALREADY closed** — and
  TWICE: `armIdleTimer` returns early on BOTH `this.stopped` AND `!this.server`, and `stop()` sets `stopped` and
  awaits before nulling `server`, both synchronously, so a racing `analyze()` finally can't arm a surviving
  timer today. The fix re-calls `cancelIdleTimer()` AFTER `stop()`'s awaits as a third, **defense-in-depth**
  backstop making stop()'s "no live idle timer on return" postcondition LOCAL (independent of armIdleTimer's
  guards) — it only becomes load-bearing if a future refactor weakens both checks (the §37 REL-2 / F18
  co-guarded-twin pattern; cross-ref **GPU §5.5c**). The test (g) is a PROPERTY/regression guard for the
  interlock (no idle timer survives a stop racing an analyze settle) — single- AND dual-neuter stay green (the
  `!this.server` guard also blocks the arm; it is genuinely triple-guarded), recorded transparently rather than
  over-claimed. (`vision/runtime.ts`; `vision-runtime.test.ts` test (g).)

| Finding | Sev | Disposition (one line) | Record / files |
|---|---|---|---|
| **R1** | Med (live) | **fixed** — `streamSettled` registry + `awaitInFlightStreamsSettled()` make lock/quit await each aborted partial's persist BEFORE closing the DB (supersedes the §37 REL-4 race); `appendMessage` locked-DB guard swallows cleanly. Teeth: drop a settle-await → ordering reds; drop the guard → locked persist rejects | this §39; `ipc/inflight.ts`, `ipc/chat-stream.ts`, `registerWorkspaceIpc.ts`, `main/shutdown.ts`, `services/chat.ts` |
| **R2** | Med | **fixed** — fast-path holder installs the same release-on-abort listener as the slow path (shared `released` latch). Teeth: neuter → parked-build resume reds; idempotency pins single-release | this §39; `analysis/model-slot-arbiter.ts` |
| **R3** | Med | **fixed** — reconcile STAGES decodes then commits `byChunk`+`modelByChunk` atomically (`decodeRow`/`applyStaged`); a throw leaves the prior maps intact. Preserves Phase-B P2 + F12 O(K). Teeth: 2nd-lookup throw → live map pristine at throw, next query = from-scratch | this §39; `embeddings/resident-cache.ts` |
| **R4** | Low | **fixed** — null `prevOnPage` before the in-try final await so the catch drains only a still-pending look-ahead. Teeth: final-page recognition awaited exactly once | this §39; `ocr/pipeline.ts` |
| **R5** | Low | **fixed** — `invalidate()` drops only SETTLED probes; an in-flight re-probe coalesces (one child per binary). Teeth: mashing spawns 1, not 1+N | this §39; `runtime/gpu.ts`; GPU §5.4 "Try GPU again" |
| **R6** | Low | **fixed** — `RasterReplySlot.expect()` rejects a superseded prior waiter; extracted from the closure for testability. Teeth: two expect()s → first rejects | this §39; `ocr/rasterizer.ts` |
| **R7** | Low | **already-mitigated; defense-in-depth added** — `stop()` re-cancels the idle timer after its awaits (the race is already closed by armIdleTimer's `stopped`+`!server` guards — triple-guarded; property test, not RED→GREEN-able) | this §39; `vision/runtime.ts`; GPU §5.5c |

**No reliability issue OUT of R1–R7's scope surfaced during the work** (the audit's R1–R7 set was complete).
The original new findings still open after Phase C: S1 (audit-log filename policy — Phase E) and the report's
S1/C2/C3/C4 etc. Phases F/D/E remain; the report is NOT retired.

### §40 Full audit (2026-06-30) — remediation CLOSE-OUT

The **2026-06-30 full audit** (report `audits/full-audit-2026-06-30.md`) is **COMPLETE** — all seven phases
(A–G) landed. The round's pattern was *"the gaps have moved to the edges"*: the heavily-fortified core
(crypto/vault, the IPC lock-guard surface, child-process spawn, the money whole-string parser, the RAG core,
the resident-cache contract) was re-confirmed clean, and the new findings were one financial false-NEGATIVE
(C1), two scale cliffs (P1/P2), one live teardown race (R1), a cluster of post-DX-1/DX-3 doc drift (D1–D10),
and a set of latent/defense-in-depth + policy-consistency items. **No Critical, no remote exploit** (offline
by construction); 2 High-for-future-agents (the doc drift) + High-@-scale (P1), ~9 Medium, the rest Low/Info.
Each phase folded its decisions into the topic docs as it landed (the per-phase records: **§8** [Phase A
financial] + the new `money.test.ts`; the **Performance "Wave P4" / compare** records [Phase B]; **§39** [Phase
C reliability]; the **"Test-enforcement seams" Phase-F subsection** [Phase F]; the **"Renderer robustness"
Phase-D subsection** [Phase D]; **this §40** for the Phase-E security items; the **§3 doc table + barrel/README/
security-model edits** [Phase G]); **this section is the durable master index** — resolve a
`full-audit-2026-06-30 <ID>` code comment through it. Per the CLAUDE.md doc-lifecycle rule the working-paper
report was **retired** once every finding was dispositioned (committed folded-in first, so the original stays
**recoverable in git history** — the parent of the Phase-E close-out commit), mirroring the §24/§25/§26/§34/§38
precedent. Phases ran on stacked, unmerged branches: **master ← B (`audit-2026-06-30-phaseB-perf`) ← C
(`…-phaseC-reliability`) ← F (`…-phaseF-tests`) ← D (`…-phaseD-renderer`) ← E (`…-phaseE-security`)**, with G
+ A already merged to local master; the owner merges the stack in order (B → C → F → D → E) when ready — **do
NOT auto-merge/push.**

**Per-phase one-liners:** **A** financial correctness (C1 balance-less-gap false `mismatch` → withheld total;
C5 zero-amount classification; + T4 `money.test.ts`; §8). **B** performance hot paths (P1 compare
`dotProduct`+running-top-K 2.2×; P2 unscoped search iterates the resident map ~5×; P6 deferred; equivalence-
first; Performance "Wave P4"/compare records). **C** lock/teardown reliability (R1 the one live race +
R2–R7 latent; §39). **F** test-suite robustness (T1–T3 + T5–T7 dispositioned, T4 was in A; test-only;
"Test-enforcement seams" Phase-F). **D** renderer lifecycle & a11y (F1 the one real bug + F2–F8;
renderer-only; "Renderer robustness" Phase-D). **E** (this close-out) security consistency (S1 audit-log
filename **policy change** + S2/S3 parity gaps + S4 re-affirm) + report retirement. **G** documentation
reconciliation (D1–D10 + M1; docs/comments-only; §3 of the report).

| Finding(s) | Phase | Disposition (one line) | Record |
|---|---|---|---|
| **C1** (Med-High) | A | **fixed** — `reconcileBalances` carries a `sinceLastPrinted` cents accumulator: a balance-less row stays `unknown` but folds its amount into the NEXT printed balance's expected value, so a same-day-grouped / OCR-dropped-balance row no longer breaks the chain → no false `mismatch` → the correct total is no longer withheld. Parsing-only (no `BANK_EXTRACTOR_VERSION` bump; re-validates on read). Teeth: neuter the accumulator → the two gap tests red | §8; `skills/tools/bank-statement.ts`; known-limitations LINE PARSER |
| C2 (Low) | — | **carried forward** — three citation-snippet builders (`skills/analysis/bank-statement.ts`, `…/invoice.ts`, `analysis/coverage.ts`) still `slice(0,280)` by UTF-16 code unit (the RAG-2 surrogate-split, off the main RAG path). Route through `truncateSnippet` next time those files are touched. Cosmetic `�` only | this §40 (carried) |
| C3 (Low) | — | **carried forward** — `documentLeafProvenance` labels from the full-`ids` loop index, so a missing leaf row yields non-contiguous `[Sn]`. Latent (whole-doc answers aren't inline-`[Sn]`-cited today, FE-B). Filter-then-index when next touched | this §40 (carried) |
| C4 (Low) | — | **carried forward** — `aggregateExtractions` item `count` is `COUNT(*)` (record-count), not `COUNT(DISTINCT chunk_id)`, so a value the model repeats within one chunk overstates occurrences vs the cited sections. Couples with P3 (same query) | this §40 (carried) |
| **C5** (Low) | A | **fixed** — `summarizeCashflow` now treats `0.00` as neither inflow nor outflow (`>0`/`<0`), matching `categorizeRow`'s `Uncategorized`; a shared comment pins the convention. NOT output-observable (adding 0 is a no-op) → the test pins the convention/guards regression | §8; `skills/tools/bank-statement.ts` |
| **P1** (High @ scale) | B | **fixed** — compare mode-(b) `nearestB` → the pure exported `compareNearestNeighbors` using `dotProduct` (cosine==dot on L2-normalized stored vectors) + a running top-K (no per-A-chunk sort). Equivalence proven in two exact links; measured **2.2×** (1253→571 ms on 1000×1000). Behavior-preserving; teeth-checked | Performance "Wave P4" / compare record; `doctasks/compare.ts`, `doctasks/handlers/compare.ts` |
| **P2** (Med @ scale) | B | **fixed** — `VectorIndex.search` splits into `collectResidentHits` (iterates the resident map directly on the unscoped path, skips the `SELECT chunk_id` marshal) + `collectScopedHits` (the **byte-unchanged** scoped scan); `modelByChunk` added for the in-memory model filter; archived-exclusion preserved via `canIterateResident`. Measured **5.0–5.5×** at 50k/10k. Equivalence-tested; teeth-checked | Performance "Wave P4" record; `embeddings/index.ts`, `embeddings/resident-cache.ts` |
| P3 (Med @ corpus scale) | — | **carried forward** — `aggregateExtractions` GROUP_CONCATs all chunk_ids into one multi-MB string then `split+Set` per group on the main thread. Fix with `GROUP_CONCAT(DISTINCT …)` + a provenance cap (also fixes C4). Bites only at very large corpora | this §40 (carried) |
| P4 (Med @ long chats) | — | **carried forward** — `listMessages` re-marshals the whole history + per-row `JSON.parse(citations_json)` over IPC on every open AND after every turn (O(turns)). Fix with `listMessagesSince(rowid)` + initial-open pagination. Distinct from the deferred renderer transcript windowing | this §40 (carried); §36 (the windowing residual) |
| P5 (Low) | — | **carried forward** — `maybeEnqueueTreeBuild` loads ≤1000 chunks + token-counts on every ingest just to decide whether to enqueue; gate cheaply on persisted Σ`token_count` first | this §40 (carried) |
| **P6** (Low) | B | **⏸ deferred (investigated, NOT applied)** — dropping `computeSignature`'s per-search `COUNT(*)` breaks a TESTED out-of-band non-max-rowid DELETE staleness guarantee (`resident-cache.test.ts`); a `MAX(rowid)`-only or maintained-in-band count can't see that delete, and a safe O(1) count needs a **DB-side trigger = a schema change, out of scope**. The `COUNT(*)` is RETAINED; the conflict is documented at the `getResidentVectorIndex` docstring + the module STALENESS bullet. Schema-touching follow-up tracked | §2 P6 (report, now folded here); `embeddings/resident-cache.ts` |
| **R1** (Med, the one live race) | C | **fixed** — `streamSettled` registry + `awaitInFlightStreamsSettled()` make lock/quit await each aborted chat-partial's persist BEFORE closing the DB (supersedes the §37 REL-4 race-reliance) + an `appendMessage` locked-DB ABORT guard. Teeth: drop a settle-await → ordering reds; drop the guard → locked persist rejects | §39; `ipc/inflight.ts`, `ipc/chat-stream.ts`, `registerWorkspaceIpc.ts`, `main/shutdown.ts`, `services/chat.ts` |
| **R2–R6** (Med/Low, latent) | C | **fixed + RED→GREEN teeth-checked** — R2 arbiter fast-path abort listener; R3 resident-cache stage-then-commit reconcile (Phase-B P2/F12 preserved); R4 OCR final-page single-drain; R5 GPU-probe coalescing; R6 rasterizer `RasterReplySlot` supersede-reject | §39; `model-slot-arbiter.ts`, `resident-cache.ts`, `ocr/pipeline.ts`, `runtime/gpu.ts`, `ocr/rasterizer.ts` |
| **R7** (Low, latent) | C | **already-mitigated; defense-in-depth added** — `armIdleTimer` is triple-guarded (`stopped`+`!server`), so a racing `analyze()` finally can't arm a surviving timer; `stop()` re-cancels after its awaits as a locality backstop (property test, recorded transparently) | §39; `vision/runtime.ts`; GPU §5.5c |
| **F1** (Med, the one real bug) | D | **fixed** — `DictationButton.stopAndTranscribe()` `mountedRef`-guards `onText`/`onError`/`setState`, so a stop-then-navigate no longer leaks the transcript into another conversation's composer or setStates a dead component. Teeth: drop the guard → red | "Renderer robustness" Phase-D; `chat/DictationButton.tsx` |
| F2, F3 (Low, guards) | D | **fixed** — F2 memoizes `localizeServerCopy` (one compute feeds the bubble + `StreamAnnouncer`); F3 gates the proactive skill-suggestion debounce on `mountedRef` + `activeIdRef`-convId match (no stale-conversation suggestion / dead setState) | "Renderer robustness" Phase-D; `chat/Transcript.tsx`, `screens/ChatScreen.tsx` |
| **F4** (Low-Med) | D | **fixed** — ImagesScreen per-turn "Try again" disabled while `analyzing` (Copy stays live) AND `analyze()` → `'started'\|'busy'\|'noop'` surfaces `images.err.busy` on the busy early-return (no silently-swallowed click). Teeth: drop `disabled={busy}` → red | "Renderer robustness" Phase-D; `screens/ImagesScreen.tsx`, `images/AnswerThread.tsx` |
| F5 (Low) | D | **deferred (accepted)** — Composer per-keystroke reflow left as-is (single textarea, imperceptible; rAF adds risk for no gain) | "Renderer robustness" Phase-D; known-limitations |
| **F6** (Low, a11y) | D | **fixed + residual** — `StreamAnnouncer` gains a length fallback (past `ANNOUNCE_SOFT_CAP` with no terminator it flushes to the last WORD boundary, so tables/lists/run-on prose announce incrementally). Accepted residual: a pure code block stays intentionally quiet | "Renderer robustness" Phase-D; known-limitations Accessibility |
| F7 (Low) | D | **deferred (accepted; self-heals)** — regenerate optimistic slice is restored in place by `stream`'s `catch` `refreshIfVisible()` + the `activeId`-change effect; no manual re-select | "Renderer robustness" Phase-D; known-limitations |
| **F8** (Low, hypothesis → CONFIRMED) | D | **fixed** — superseded vision analyze no longer wires a zombie stream: per-call `analyzeGen` (bumped by `abortActive`/`clearVisionSession`) cancels the orphan job and bails without wiring; per-handler `jobId === activeJobId` checks. Teeth: remove the gen bail → red | "Renderer robustness" Phase-D; `lib/visionSession.ts` |
| **S1** (Low-Med, **policy decision**) | **E** | **fixed — option (a), the consistent choice (a deliberate audit-payload change).** Document titles/filenames are now **CONTENT**: `document_imported` / `document_reindexed` (incl. the doc-task *materialize* path) record `documentId` + `status` + `chunkCount` only, a **fixed** message string with NO title. Aligns the document channel with the chat channel (withholds the conversation title) and the collections channel (refuses the project name); closes the plaintext-`activity-log.json`-export leak. The `audit.ts` privacy-rule comment, the `shared/types.ts` AuditEventType docs, and security-model.md are updated. Test: the privacy sentinel now greps the imported file's basename (a `FILENAME_SENTINEL`) across import → re-index → summarize → translate → compare AND the real `exportAuditLog` payload; teeth: re-add a title to one message → reds (verified). **Owner veto path:** option (b) was to ACCEPT the leak + document it — NOT taken; if the owner prefers (b), revert the message change and keep only the doc note | **this §40**; `registerDocsIpc.ts`, `doctasks/handlers/shared.ts`, `services/audit.ts`, `shared/types.ts`; security-model.md "Audit log data class"; `audit-ipc.test.ts` |
| **S2** (Low) | **E** | **fixed** — `parseSkillManifestFromDir` adds a `statSync().size > maxFileBytes` pre-check before each read (mirroring `stageFolder`): the over-cap **SKILL.md is rejected**, the optional **manifest.json is skipped** (same fate as a malformed one) — so the unencrypted-`user-skills/` drop-in / per-turn read path no longer reads an over-cap file wholesale into the main process (a local memory-exhaustion DoS). Distinct from §26 SEC-2 (preview staging zone). Teeth: the discriminators (under the default cap the same files are read) red on guard removal | **this §40**; `skills/manifest.ts`; `skills-registry.test.ts` ×2 |
| **S3** (Low) | **E** | **fixed** — `transcribeDictation` now `requireUnlocked()`-refuses on a locked vault BEFORE any disk write, closing the F16 lock-guard parity gap (it dispatched on `ctx.transcriber` presence only, landing a transient plaintext WAV in the documents dir while the vault holds only `.enc` sidecars). New `main.dictation.locked` copy (en+de). Distinct from §26 SEC-3 (dialog-opener token minting). Test: rejects when locked + NO file under `documents/`; the lock-coverage `COVERED_ELSEWHERE` reason updated | **this §40**; `registerDictationIpc.ts`; `i18n/en.ts`+`de.ts`; `dictation-ipc.test.ts`, `ipc-lock-coverage.test.ts` |
| **S4** (Info, re-affirm) | **E** | **re-affirmed ACCEPTED residual (§22-M2 "trust by location, not signature")** — unsigned, user-writable manifests can redirect a download to any **public** HTTPS host (hash verify doesn't help; attacker controls URL + `sha256`). Precondition = a local FS write; every fetch is gated by policy ∧ `allowNetwork` ∧ per-download confirm; SSRF private/loopback/metadata + mapped-IPv6 already denied. A host **allowlist** was weighed and **declined** (breaks legitimate offline curation, doesn't bind the local-write attacker). No code change | **this §40**; security-model.md D3 (S4 note) |
| **T1** (Med) | F | **closed (test)** — vision teardown/cancel real-timer `sleep(N)` → injected park gates + `while(cond) await tick()`; test (2) holds the teardown IN FLIGHT so the post-`getStatus()` re-check is a live co-guard. Teeth recorded honestly (both `tearingDown` checks are co-guards → DUAL-neuter reds; the prior "single-neuter" comment corrected) | "Test-enforcement seams" Phase-F; `vision-teardown.test.ts`, `vision-cancel.test.ts` |
| T2 (Med) | F | **closed (test)** — DocumentsScreen render-count deltas PAIRED with behavioral assertions (`toBeChecked()`+siblings / `getByRole('menu')`+item); deltas kept as a secondary perf oracle. Teeth: drop `memo(DocRow)` reds the deltas, behavior passes | "Test-enforcement seams" Phase-F; `DocumentsScreen.test.tsx` |
| T3 (Med) | F | **closed (test)** — injected-failure ROLLBACK tests for the categorize persist + the ingestion chunk-insert loop (no partial rows + connection-not-poisoned + clean recovery; teeth-checked). **Audit correction:** `commitNode` (H11) + the extraction insert already had rollback tests — "1 of ~12" was ≥3 | "Test-enforcement seams" Phase-F; `doctasks-categorize.test.ts`, `ingestion.test.ts` |
| **T4** (Low-Med) | **A** | **landed with Phase A** — new `tests/unit/money.test.ts`: 42 pure-function table tests (`parseAmount` incl. apostrophe-decimal + 2-dp invariant, `MONEY_RE` boundaries, `detectCurrency`/`detectDocumentCurrency`, `inferDateOrder`/`parseDate`, `wordIncludes`, `csvField`). Offline | §8; `tests/unit/money.test.ts` |
| T5 (Low) | F | **closed (swept)** — the 3 genuine correctness-gating fixed waits (`reranker`/`e5`/`ocr-task`) → state-polls; residuals recorded (timestamp-monotonicity, absence-settle, slow-op sims); 3× timeout headroom retained | "Test-enforcement seams" Phase-F |
| T6 (Low) | F | **closed (test)** — `changingPassword` lifecycle pinned via a property-trap on the real `changePassword` (`[true,false]` + in-flight refusal). Teeth: neuter the flag SET → red (the field-poking test could not) | "Test-enforcement seams" Phase-F; `password-change.test.ts` |
| T7 (Low) | F | **already-mitigated; pinned, NO src change** — WHATWG `new URL` canonicalizes numeric IPv4 → dotted-decimal before the deny-regex, so the decimal/octal/hex loopback encodings are already rejected; regression-pinned in both F15 styles | "Test-enforcement seams" Phase-F; `assets.test.ts` |
| **D1–D10** (Med/Low, docs) | G | **fixed (docs)** — the post-DX-1/DX-3 doc drift reconciled to the as-built `handlers/`/`context.ts`/`MODEL_TASK_HANDLERS` layout (D1–D5), the "Move to project…"/toolbar labels (D6/D7), the §36 split note (D8), the version-hygiene note (D9), and the README/security-model cosmetics (D10). 2 same-class extras folded/flagged transparently | §3 of the report (folded); architecture.md "Document tasks", rag-design.md, `services/doctasks.ts`, user-guide.md, README.md, security-model.md |
| **M1** (Low) | G | **fixed (comment-only)** — the duplicated RAG-1 determinism comment block in `VectorIndex.search` deleted | §3 of the report; `embeddings/index.ts` |

**Carried-forward open items (deliberately NOT taken this round; on record for the next pass):**

- **C2 / C3 / C4** (Low correctness/honesty) — the three off-main-path surrogate-slice citation builders (C2), the non-contiguous `[Sn]` leaf-provenance labels (C3), and the `aggregateExtractions` record-count-vs-distinct-section `count` (C4). Each is cosmetic/latent today; fix opportunistically when those files are next touched (C4 couples with P3).
- **P3 / P4 / P5** (perf, not in Phase-B scope) — the `aggregateExtractions` GROUP_CONCAT materialization (P3, also fixes C4), the per-turn `listMessages` whole-history re-marshal (P4), and the eager tree-build gating chunk-load (P5). None bite at today's typical sizes; each has a recorded fix.
- **P6** (Low, **Phase-B deferred with cause**) — the per-search `COUNT(*)` staleness backstop is load-bearing for a tested out-of-band non-max-rowid DELETE guarantee; a safe O(1) replacement needs a DB-side counter trigger (a schema change). Tracked as the schema-touching follow-up.
- **F5 / F7** (renderer, **Phase-D accepted**) — Composer per-keystroke reflow (F5, imperceptible) and the regenerate optimistic slice (F7, verified self-healing). Both in known-limitations.
- **T5 residuals** (Phase-F) — the timestamp-monotonicity / absence-settle / deliberate slow-op-simulation waits were left as state-polls with retained timeout headroom, recorded (not converted) because they need a timestamp/no-racing-call seam.
- **S4** — the §22-M2 *trust-by-location* download residual, **re-affirmed accepted** (above; a host allowlist was weighed and declined).
- **§26/§34/§38-carried, RE-VERIFIED still open & DISTINCT from this round's S2/S3:**
  - **SEC-1c** — unlock-path rate-limit / attempt-counter + create-time strength floor; the at-rest Argon2id KDF is the binding mitigation against the offline (drive-in-hand) attacker, so a UI rate-limit doesn't bind the real threat.
  - **SEC-2** — stage `previewSkillPackage` content under `userSkillsDir` (trust-zone consistency); today path-/size-validated + finally-cleaned in the shared tmpdir. **This is NOT closed by S2** — S2 caps the drop-in *read* path's file size; SEC-2 is about the *staging directory* of the import preview. Different seams; both remain.
  - **SEC-3** — the dialog-opener IPCs mint a capability token pre-unlock but every consuming handler is `requireUnlocked()`-gated → inert. **This is NOT closed by S3** — S3 lock-gates *dictation*; SEC-3 is about *dialog-opener token minting*. Different seams; SEC-3 remains an accepted consistency residual.
  - **REL-5** — `BEGIN IMMEDIATE` + a single `withTransaction` guard: non-reachable while the single-`DatabaseSync` architecture holds (every `BEGIN…COMMIT` body synchronous); promote to a real fix only if a second DB connection is introduced.
  - **PERF-2 chat-transcript windowing** (the documents-list half is closed, §36) and the **E5 `query:`/`passage:` prefix migration** + its coupled **F13 floor-before-cut** precondition (inert at the pinned default 0).

**Posture held across all seven phases (load-bearing):** offline / no telemetry / no new network egress. The
ONLY intended behavior change to the data-class boundary is **S1** (titles/filenames moved INTO the content
class — a *strengthening*: the **content class** [document/chat text, titles/filenames, project names,
extracted figures, redacted text] is now never logged / audited / exported end-to-end, which several prior
posture statements already asserted aspirationally). **No schema change** in any phase (P6's O(1) fix was
deferred precisely to avoid one; S1 records the same ids it always did, just drops the title from the
message). Behavior-preserving otherwise: every behavioral fix (A/B/C/D + S2/S3) is **teeth-checked** (neuter →
red → restore byte-identical); F (test-only, `git diff src/` empty) and G (docs/comments-only) made no `src/`
behavior change beyond G's single M1 comment deletion. S2/S3 are behavior-preserving except their intended
lock-gate / size-cap refusals. Each S1–S4 fix is independently revertible. Final suite **2680 passed / 41
skipped** (Phase-D baseline 2677/41 → **+3**: S2 ×2 + S3 ×1; S1 extended the existing privacy sentinel +
realigned 3 dependent tests at the same count); `npm run typecheck` + `npm run build` green.

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
  guards + the D4 header pixel-bomb cap + `validateAnalyzeRequest` — the SEC-3 main-side re-validation
  `importDocuments` lacks). **SEC-6 (backend-audit-2026-06-27):** `validateAnalyzeRequest` now rejects
  a **claimed** png/jpeg whose header won't parse (`decodedPixelCount` → `null`) as `decodeFailed`
  instead of falling through to byte-cap-only — a `null` pixel count for a known-png/jpeg MIME means
  malformed/forged bytes and previously silently disabled the D4 pixel-bomb guard.
  `runtime.ts` (`VisionRuntime` on `LlamaServer` directly with the §1 args; lazy single-flight
  `ensureStarted`; `analyze` builds the base64 `image_url` request + `readChatSSE`; the §6
  idle-teardown interlock), `index.ts` (`VisionService`: ephemeral job map, own one-job
  serialization, busy-reject, cancel via AbortController, lock/quit `stop()`). **F18
  (full-audit-2026-06-29-postmerge):** the terminal success `done` write routes through the
  cancelled-guarded `set()` helper (which now returns whether it applied) — not a raw `jobs.set` — so a
  concurrent `cancel()` can't be silently overwritten by `done` (nor re-fire `emit.done`). Latent today
  (no `await` between the `signal.aborted` check and the write), it hardens the path against a refactor
  that inserts one; `tests/integration/vision-cancel.test.ts` pins the contract and the dual-neuter
  (remove the abort check AND the `set()` guard → resurrection) is the recorded teeth-check.
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
| plan §16 | V4/V5 runtime hardening — the idle-teardown interlock + lifecycle latches (RUNTIME-4) and the V5 smoke/acceptance | §6 (+ model-benchmarks §8 for the smoke) |
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
(the `AnswerThread` answer now uses the shared `AssistantMarkdown` — Streamdown (GFM + KaTeX) —
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

## Original MVP spec — retirement record & §-anchor legend (2026-07-11)

The frozen original product/architecture spec **`CLAUDE_HilbertRaum_MVP.md` was retired and
deleted on 2026-07-11** (full text: `git show ed1332c:CLAUDE_HilbertRaum_MVP.md`). A five-way
coverage audit confirmed every substantive section is either represented in the as-built topic
docs or deliberately superseded; the durable **product intent** (thesis, target user, commercial
model, positioning guardrails, scope boundaries, future editions/backends) was condensed into
[`product-vision.md`](product-vision.md), and the §17 canonical USB demo script into
[`packaging.md`](packaging.md). Code comments, tests, manifests, and docs keep citing **`spec §N`**
unchanged — those anchors resolve here:

| Spec anchor | Resolves to (as-built) |
|---|---|
| §0 operating rules | `CLAUDE.md` "Hard rules" + `CONTRIBUTING.md` "Ground rules"; the "not RAM expansion" guardrail → [`product-vision.md`](product-vision.md) |
| §1.1, §1.2/§1.3/§1.4, §19, §23 | [`product-vision.md`](product-vision.md) (naming, thesis, commercial model, target user, future editions, philosophy) |
| §1.5 / "success criterion #10" | [`product-vision.md`](product-vision.md) success definition; portability as-built in [`drive-layout.md`](drive-layout.md) "Launchers" |
| §2.1 scope includes / §2.2 excludes | `README.md` features / [`product-vision.md`](product-vision.md) scope boundaries |
| §3.1 drive role | [`product-vision.md`](product-vision.md) positioning guardrails |
| §3.2 runtime strategy | Overview + "Swappable interfaces (spec §9.2)" (this doc); future backends → [`product-vision.md`](product-vision.md) |
| §3.3 model strategy | [`model-policy.md`](model-policy.md) (deviations from the spec's model list are recorded inline — e.g. the spec-§7.3 dropped-models note) |
| §3.5 security baseline | [`security-model.md`](security-model.md) "Security baseline (spec §3.5)" |
| §3.6 offline mode | [`security-model.md`](security-model.md) "Offline posture (spec §3.6)" |
| §6 drive layout, `drive.json`/`policy.json` | [`drive-layout.md`](drive-layout.md) (incl. "Naming reconciliation"); canonical code `services/drive.ts` / `services/policy.ts` |
| §7.1–§7.11 app modules | the "Module ↔ spec map" table above + this doc's per-module sections; §7.6's base prompt superseded by `chat.ts` `BASE_SYSTEM_PROMPT` (see "Chat & streaming"); §7.7/§7.8 pipeline + defaults → [`rag-design.md`](rag-design.md) §1/§3/§8 |
| §8 data model, §8.2 ids | `services/db.ts` `SCHEMA` (this doc's "Storage" section) |
| §9.1 command surface | `ipc/register*Ipc.ts` + `preload/index.ts` (Overview) |
| §9.2 service interfaces | "Swappable interfaces (spec §9.2)" (this doc) |
| §10.x UI screens | [`design-guidelines.md`](design-guidelines.md) — §10.3 → §3 (+ D-UI4 Quick/Balanced/Thorough), §10.4 → §11.6, §10.6 → §2/§11.3; §10.7 → "Diagnostics & transcript export" (this doc) |
| §11.1–§11.4 benchmark & profiles | [`benchmark.md`](benchmark.md) (goals / detection steps / profile classification / "Warnings"); the §11.4 friendly-language rule also in [`design-guidelines.md`](design-guidelines.md) §7 |
| §12, §12.2 packaging / §12.3 updates | [`packaging.md`](packaging.md) (commercial drive + release workflow); manual drive update in [`drive-layout.md`](drive-layout.md) |
| §13 model licensing | [`model-policy.md`](model-policy.md) "Manifest fields" + "License review gate" |
| §17 demo script | [`packaging.md`](packaging.md) "The canonical USB demo (original spec §17)" |
| §18.1 offline statement | `shared/i18n/en.ts` `privacy.statement.offline` (verbatim) |
| §22 definition of done | [`data-contracts.md`](data-contracts.md) "MVP Definition of Done (§4 / spec §22) — checklist" |

Any spec anchor not in the table (e.g. §16 milestones, §20 open questions, §21 implementation
plan) is completed history — resolved in `BUILD_STATE.md`'s phase log or decided in this doc's
design records — and resolvable in full via the `git show` pointer above.
