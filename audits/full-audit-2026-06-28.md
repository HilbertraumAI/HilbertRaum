# HilbertRaum — Full multi-perspective audit (2026-06-28)

> Multi-persona audit (security · backend/architecture · data layer · RAG/ingestion · business logic ·
> frontend · testing · documentation). Read-only: no code was changed. Conducted after the
> **backend audit 2026-06-27** was fully remediated (8 phases + close-out, merged to `master`).
> Scope: `apps/desktop` (~47k LOC app, ~52k LOC tests, 2335 passing / 39 skipped), `docs/`, `scripts/`,
> `model-manifests/`. This is a working paper — fold into topic docs and delete per the CLAUDE.md
> doc-lifecycle rule once remediated.

---

## 1. Executive summary

**Overall health: strong and unusually mature.** Six prior audit rounds (the latest backend-focused) are
visible everywhere: single-flight latches on every sidecar, no-orphan teardown, content-free logging,
bounded caches, transactional multi-row writes, `requireUnlocked()` on every DB-touching IPC handler,
deny-by-default Electron hardening, and a genuinely behavioral test suite. **No new Critical issue and no
remote-exploitable issue was found** — the offline-by-construction posture holds end-to-end (only loopback
sidecars and two user-gated downloaders touch the network; prod CSP is `connect-src 'self'`).

**The prior audit was backend-only, so the highest-value new findings cluster where it didn't look:**

1. **`HIGH` — GPU mid-session crash auto-fallback is a silent no-op** (REL-1). The advertised self-healing
   CPU fallback collides with the `RuntimeManager` same-model idempotency guard and never actually
   restarts; after a GPU crash the manager reports "healthy" while the next chat turn hits a dead server.
2. **`HIGH` — Locale date handling silently loses/mis-parses financial data** (BL-N1). US-ordered
   `mm/dd/yyyy` dates drop entire transaction rows (day > 12) or attach a confidently-wrong month
   (both ≤ 12) during *extraction* — documented only for redaction, not extraction.
3. **`HIGH` — No top-level React error boundary** (FE-1). Any screen render throw blanks the whole offline
   app with no recovery path.
4. **`HIGH` — No CI of any kind** (TEST-N1). A 2335-test suite is green only by author discipline; the
   documented pre-release gate has no machine backstop.
5. **`HIGH` — Money extraction tests assert pre-isolated tokens** (TEST-N2), masking live `MONEY_RE`
   locale bugs (whole-euro figures, space/apostrophe grouping under-extracted).

**Biggest opportunities:** (a) add CI + close the money/locale parsing gaps as one "financial correctness"
wave (the test gap and the bugs share a root); (b) a small "CJK/Thai token-vs-word" wave (the prior
audit fixed the embedder/reranker but the same confusion remains in audio packing and chunk overlap);
(c) renderer robustness (error boundary + a handful of unhandled-rejection / lifecycle fixes), since the
renderer is the least-audited surface. Everything else is Medium/Low polish on an already-solid base.

**Counts:** 5 High · 13 Medium · 25 Low · 3 Info (48 findings). Severity reflects impact; confidence is
per-finding below. Two High findings (BL-N1, BL-N2) directly contradict claims in the just-closed §24
audit docs, so they are genuinely new remaining bugs, not re-reports.

### Severity index

| ID | Title | Sev | Conf | Area |
|----|-------|-----|------|------|
| REL-1 | GPU mid-session crash auto-fallback defeated by idempotency guard | High | High | Reliability |
| BL-N1 | US-ordered dates dropped / mis-parsed during extraction | High | High | Business logic |
| FE-1 | No top-level React error boundary | High | High | Frontend |
| TEST-N1 | No CI pipeline exists | High | High | Testing |
| TEST-N2 | Money extraction tests assert pre-isolated tokens (mask live bugs) | High | High | Testing |
| REL-4 | `deleteConversation` is not atomic | Medium | High | Data/Reliability |
| PERF-1 | Synchronous large image read on the main thread | Medium | High | Performance |
| PERF-2 | Synchronous 64 MiB WAV write on the main thread (dictation) | Medium | High | Performance |
| PERF-3 | Missing index for per-conversation compaction/checkpoint queries | Medium | Medium | Performance |
| PERF-5 | Documents list: no virtualization, rows not memoized | Medium | Medium | Performance |
| RAG-N1 | Audio segment packing counts words → CJK/Thai chunk overflow | Medium | High | RAG/Ingestion |
| RAG-N3 | Reranker scores only first ~320 tokens of 500-token chunks | Medium | High | RAG/Quality |
| BL-N2 | Trailing-date balance lines parse the date as the balance | Medium | High | Business logic |
| BL-N3 | Bank `parseLine` takes the FIRST money token as the amount | Medium | High | Business logic |
| BL-N4 | Redaction misses US phones + lowercase IBANs | Medium | High | Data-handling |
| FE-2 | Unhandled IPC rejections (cancelDownload, pickSkillPackage) | Medium | High | Frontend |
| FE-3 | Skill enable/disable Switch double-submit / desync | Medium | Medium | Frontend |
| FE-4 | setState-after-unmount in import poll (recurring pattern) | Medium | Medium | Frontend |
| TEST-N3 | Manual smokes never run automatically; promised parser fixtures missing | Medium | High | Testing |
| TEST-N4 | Retrieval ranking ORDER tested only on exact-match queries | Medium | High | Testing |
| TEST-N5 | Implementation-detail assertions (Buffer.fill spy, prepare counts) | Medium | High | Testing |
| TEST-N6 | Redaction under-detection has no characterization test | Medium | High | Testing |
| DOC-N1 | Undocumented runtime caps; security-model names 2 of 6 skill caps | Medium | High | Docs |
| REL-2 | `LlamaServer.start()` lacks instance-level single-flight | Low | Medium | Reliability |
| REL-3 | Rasterizer message waiter single-slot (no request-id correlation) | Low | Low | Reliability |
| REL-5 | `deleteImageSession` shreds file before the row delete | Low | High | Data/Reliability |
| PERF-4 | `summary_cache` eviction full-scan + sort (no `created_at` index) | Low | High | Performance |
| PERF-6 | Vision answer turns re-parse markdown every streaming tick | Low | Medium | Performance |
| DATA-1 | `messages_fts_au` update trigger lacks the `kind='compaction'` guard | Low | High | Data-integrity |
| DATA-2 | `tree_edges.child_id` polymorphic FK invariant enforced by convention | Low | Medium | Data-integrity |
| DATA-3 | `extraction_records` `__scan__` marker growth — verify idempotent replace | Low | Medium | Data-layer |
| RAG-N2 | Chunker overlap dropped entirely for space-less (CJK/Thai) scripts | Low | Medium | RAG/Quality |
| RAG-N4 | Markdown parser splits on `#` inside fenced code blocks | Low | High | Ingestion |
| RAG-N5 | TSV files rely on papaparse delimiter auto-detection | Low | Medium | Ingestion |
| RAG-N6 | `corpusNeedsReindex` ignores `includeArchived` | Low | Medium | RAG-correctness |
| BL-N5 | `reconcileBalances` uses float comparison vs integer-cents elsewhere | Low | Medium | Business logic |
| BL-N6 | Redaction masks all dates → locale-asymmetric output content | Low | Medium | Data-handling |
| SEC-N1 | NUL-byte `.skill.zip` member name leaks a raw path from preview | Low | High | Security |
| SEC-N2 | Benchmark IPC handlers lack explicit `requireUnlocked()` (fail-closed) | Low | High | Security |
| FE-5 | App settings/policy effect re-runs on every UI-language change | Low | High | Frontend |
| FE-6 | Array-index / `Date.now()` React keys on transient lists | Low | Medium | Frontend |
| FE-7 | Toast auto-dismiss `setTimeout` untracked | Low | High | Frontend |
| FE-8 | Raw English `Error.message` in localized diagnostics copy | Low | Medium | Frontend/i18n |
| FE-9 | SegmentedControl Home/End handlers correct only via modulo wrap | Low | Medium | Frontend/a11y |
| TEST-N7 | `decodeVector` little-endian on-disk contract not byte-pinned | Low | High | Testing |
| TEST-N8 | Lock guard tested on 3/14 handlers; retrieve-embed-failure untested | Low | High | Testing |
| TEST-N9 | `whisper-smoke` leaks a temp dir at module load even when skipped | Low | High | Testing |
| DOC-N2 | Stale §-anchor: `manager.ts` cites architecture.md §21 (should be §22) | Low | High | Docs |
| DOC-N3 | README model size/RAM drift (Qwen3.5-4B 2.6 vs 2.9 GB; RAM tiers) | Low | High | Docs |
| DOC-N4 | packaging.md "default-set mirrored from assets.ts" is misleading | Low | High | Docs |
| DOC-N5 | No documented single-test command; `test:watch` undocumented | Low | High | Docs |
| DOC-N6 | rag-design understates the reranker/E5 retrieval-quality ceiling | Low | High | Docs |
| DOC-N7 | Several test-harness `HILBERTRAUM_*` env vars undocumented | Low | High | Docs |
| SEC-N3 | Sidecar `serverMessage` tail content-free only by upstream convention | Info | Low | Security |

---

## 2. Findings (detail)

### Reliability / backend

#### REL-1 — GPU mid-session crash auto-fallback is defeated by the RuntimeManager same-model idempotency guard
- **Category:** Reliability · **Severity:** High · **Confidence:** High
- **Location:** `apps/desktop/src/main/index.ts:181` (wiring) → `apps/desktop/src/main/services/runtime/index.ts:135-137` (idempotency guard); crash origin `services/runtime/factory.ts:137-139`.
- **Description:** When a GPU-backed `llama-server` dies mid-session, the crash hook calls
  `createGpuCrashAutoFallback`'s `restart(opts)`, wired as `runtimeRef?.start(opts)` with the **same**
  `modelId`. But the crashed `LadderRuntime` is still `RuntimeManager.current` (the manager never observes
  the child exit, never clears `current`/`last`). `start()` early-returns when
  `this.current?.modelId === opts.modelId`, so the "restart at CPU" resolves to a status read and never
  stops-and-restarts. `gpuAutoDisabled` is persisted (so a *real* restart would land on CPU), but the
  restart itself is short-circuited.
- **Evidence:** `index.ts:181` `restart: (opts) => runtimeRef?.start(opts) ?? Promise.resolve()`;
  `runtime/index.ts:135-137` the same-model guard; `factory.ts:137-139` crash hook fires without clearing
  `current`. Tests inject a *fake* `restart` (`runtime-ladder.test.ts:210-263`) so the real manager
  interaction is never exercised; `runtime-manager.test.ts:155-186` separately proves the idempotency.
- **Consequences:** After a GPU driver/VRAM crash the manager keeps reporting `running/healthy` (it cached
  `this.last` at start and never re-polls), shows the friendly "compatibility mode" notice, persists
  `gpuAutoDisabled` — but the next chat/RAG/doctask turn routes to a dead server and fails. The user must
  manually Stop/Start. The advertised auto-recovery does nothing.
- **Recommended fix:** Make the crash restart force a real restart: have the crash handler `stop()` then
  `start()` (so `current` is cleared first), or add a `RuntimeManager.forceRestart(opts)` that bypasses
  the same-model guard for the crash path, or notify the manager to clear `current`/`last` on unexpected
  exit before invoking the fallback. Reset `this.last` so `status()` stops reporting a healthy dead server.
- **Testing needed:** Integration test wiring the **real** `RuntimeManager` + `createSelectingRuntimeFactory`
  (fake spawn) where a started GPU runtime emits an unexpected `exit`; assert exactly one stop + one start,
  backend ends `cpu`, `status().healthy` reflects the new server, and a chat turn after the crash succeeds.
- **Docs:** Correct `architecture.md` GPU record §5.3 ("restarts the same model once at CPU"); document the
  idempotency interaction + chosen fix.

#### REL-4 — `deleteConversation` is not atomic
- **Category:** Data-integrity / Reliability · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/chat.ts:692-696`.
- **Description:** Two separate auto-committed deletes (`messages` then `conversations`) with no surrounding
  transaction; `messages` has no `ON DELETE CASCADE`. A crash / lock / `SQLITE_BUSY` past the 5 s
  `busy_timeout` between the two leaves messages deleted but the conversation row surviving. Contrast
  `deleteDocument` (`ingestion/index.ts:1462-1469`), which the DATA-1 fix made transactional.
- **Evidence:** the two bare `db.prepare(...).run(...)` deletes; schema `db.ts:77` (no cascade), `db.ts:79`
  (only `idx_messages_conversation`).
- **Consequences:** Orphaned empty thread (or a checkpoint row pointing at a half-deleted thread) that
  can't be repopulated. Note compaction checkpoint rows live in `messages` too.
- **Recommended fix:** Wrap both deletes in `BEGIN…COMMIT` + `ROLLBACK` on throw, mirroring `deleteDocument`.
- **Testing needed:** Inject a failure between the two deletes; assert both rows are rolled back (still
  present), not half-deleted.
- **Docs:** Note transactional parity in the data-layer record.

#### REL-2 — `LlamaServer.start()` lacks instance-level single-flight
- **Category:** Concurrency · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/main/services/runtime/sidecar.ts:308-381`.
- **Description:** `start()` guards only with `if (this.child) return`, but `this.child` is assigned *after*
  `await verifyBinary` and `await findPort`. Two overlapping direct `start()` calls both pass the guard and
  both spawn; the second orphans the first (port + RAM, never stopped). Every production composer
  (E5/reranker/vision/LadderRuntime) wraps this in its own `starting` promise, so it's not reachable today
  — a latent foot-gun for any future direct caller, plus the early `return` (vs returning the in-flight
  promise) can resolve before the server is healthy if mis-sequenced.
- **Evidence:** `sidecar.ts:309` guard; `:338` assignment after the two awaits; the four wrappers each hold a
  `starting` latch (`e5.ts:110`, `reranker/llama.ts:95`, `vision/runtime.ts:154`).
- **Recommended fix:** Add an instance `private starting: Promise<void> | null` and return it when set.
- **Testing needed:** Two concurrent `start()` calls (fake spawn/findPort) spawn exactly one child.

#### REL-3 — Rasterizer hidden-window message waiter is single-slot with no request-id correlation
- **Category:** Reliability · **Severity:** Low · **Confidence:** Low (HYPOTHESIS)
- **Location:** `apps/desktop/src/main/services/ocr/rasterizer.ts:99-161`.
- **Description:** Replies are matched only by channel, not by a request/page id. `expect()` overwrites
  `waiter`/`expectChannel` without guarding the previous waiter was consumed; an out-of-order/duplicated
  frame could in principle resolve the wrong step. The per-step `withTimeout` bounds any hang, so impact is
  a correctness margin, not a live hang.
- **Evidence:** `rasterizer.ts:100-108` (reassigns each call), `:127` (drops non-matching channel), `:190`
  (`render` carries `pageNumber` but the `page` reply isn't matched on it).
- **Recommended fix:** Correlate replies with a monotonic request id echoed by the worker; verify the
  returned page number matches the request.
- **Testing needed:** Fake-worker test emitting a stale/duplicate `page` frame; assert it's ignored.

#### REL-5 — `deleteImageSession` shreds the file before the row delete
- **Category:** Data-integrity / Reliability · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/vision/history.ts:222-228`.
- **Description:** Inverts the DATA-1 ordering rule: `shredFile(stored)` runs *before*
  `DELETE FROM image_sessions`. A failed delete leaves a row whose file is already gone → an
  undeletable/unopenable ghost session (self-healing on retry, hence Low).
- **Recommended fix:** Delete the row first (ideally in a transaction), then shred.
- **Testing needed:** Force a DELETE failure after shred; assert recoverable state.

### Performance

#### PERF-1 — Synchronous large image read on the main thread
- **Category:** Performance · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/registerImagesIpc.ts:138-171`.
- **Description:** Picker image-read uses fully synchronous fs (`openSync`/`fstatSync`/`readSync` loop) to
  read up to ~20 MiB (env-overridable higher) on the Electron main thread, blocking the event loop —
  contradicting the codebase's own ING-8 fix that converted the OCR path to async `readFile`
  (`doctasks/manager.ts:923-936`).
- **Consequences:** A ~20 MiB read off USB stalls all IPC, token streaming, and window responsiveness;
  raising `HILBERTRAUM_MAX_IMAGE_BYTES` worsens it.
- **Recommended fix:** `fs/promises` `open` → `fh.stat()` → `fh.read()`/`readFile` → `close()` in `finally`;
  keep the same-fd fstat-then-read TOCTOU invariant.
- **Testing needed:** Existing vision-security/read tests pass; add a byte-cap-on-open-handle + close-on-throw
  test.

#### PERF-2 — Synchronous 64 MiB WAV write on the main thread (dictation)
- **Category:** Performance · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/registerDictationIpc.ts:90` (cap at `:34`).
- **Description:** `writeFileSync(tempPath, audio)` writes the renderer-supplied audio (capped 64 MiB) to a
  transient WAV synchronously before spawning whisper — same divergence from the async-I/O convention.
- **Recommended fix:** `fs/promises` `writeFile` (handler is already async); keep `finally` shred.
- **Testing needed:** Existing dictation tests pass; verify temp shred on the write-failure path.

#### PERF-3 — Missing index for per-conversation compaction/checkpoint queries
- **Category:** Performance · **Severity:** Medium · **Confidence:** Medium
- **Location:** `apps/desktop/src/main/services/chat.ts:482-494` (`getLatestCheckpoint`), `:460-479`,
  `:539-545`; schema `db.ts:79` (only `idx_messages_conversation`).
- **Description:** `messages` has only a `conversation_id` index. `getLatestCheckpoint` runs on *every* chat
  and grounded turn and filters `conversation_id AND kind='compaction'` with `ORDER BY rowid DESC LIMIT 1`
  — an O(messages-in-conversation) partial scan per turn on a high-latency USB drive.
- **Recommended fix:** `CREATE INDEX IF NOT EXISTS idx_messages_conv_kind ON messages(conversation_id, kind, rowid)`
  in the additive-index block. Serves the checkpoint lookup, the `kind IS NOT 'compaction'` listing
  filters, and the summary-marker lookup.
- **Testing needed:** `EXPLAIN QUERY PLAN` assertion that `getLatestCheckpoint` uses the index (no `SCAN`).
- **Docs:** Add to the perf/data-layer index inventory in `architecture.md`.

#### PERF-4 — `summary_cache` eviction full-scan + sort (no `created_at` index)
- **Category:** Performance · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/analysis/summary-cache.ts:54-72`; schema `db.ts:224-233`
  (PK `(content_hash, model_id)` only).
- **Description:** Eviction `ORDER BY created_at ASC` with no index → full scan + temp B-tree sort of up to
  50 000+ rows on each over-cap tree build (cold for most users; only fires past the cap).
- **Recommended fix:** `CREATE INDEX IF NOT EXISTS idx_summary_cache_created ON summary_cache(created_at)`,
  or accept + document the residual.

#### PERF-5 — Documents list: no virtualization, rows not memoized
- **Category:** Render-performance · **Severity:** Medium · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/screens/DocumentsScreen.tsx` (`visibleDocs.map(...)`, ~981-1265).
- **Description:** Each doc row (Radix dropdown, badges, provenance) is rendered inline, not as a
  `React.memo` child, with no windowing. `visibleDocs`/`sourcesById` are memoized but the row subtree is
  not, so the 400 ms import-poll `refresh()`, a menu open, or any unrelated state change reconciles all
  rows. The chat-list FE-3/FE-4 fixes were applied to `ConversationList` but not here.
- **Consequences:** Jank/CPU on large libraries (hundreds–thousands of docs), worst during active imports.
- **Recommended fix:** Extract `DocRow = memo(...)` with stable callbacks (the `useEventCallback` pattern
  already in ChatScreen); add list virtualization above a threshold.
- **Testing needed:** Render-count test that a poll-driven `refresh()` re-renders only changed rows.

#### PERF-6 — Vision answer turns re-parse markdown every streaming tick
- **Category:** Render-performance · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/images/AnswerThread.tsx` ~47-96.
- **Description:** Per-turn `<AssistantMarkdown text={turn.answer} />` with no memo; each streamed token
  re-parses markdown for every (including settled) turn. Mirrors the chat-transcript FE-1 fix not applied
  here. Bounded (short per-image threads), hence Low.
- **Recommended fix:** Memoize a `Turn` row by turn id; render the in-flight turn as plain text, parse
  markdown once on completion.

### Data layer

#### DATA-1 — `messages_fts_au` update trigger lacks the `kind='compaction'` guard
- **Category:** Data-integrity · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/db.ts:540-543` (vs the guarded insert trigger `:532-534`).
- **Description:** The insert trigger has `WHEN new.kind IS NOT 'compaction'` (so checkpoint summaries never
  enter conversation search); the update trigger re-inserts content unconditionally. Unreachable today (code
  never UPDATEs `messages.content`), but a future in-place edit of a compaction row would index its summary
  text into user-facing search.
- **Recommended fix:** Add the same `kind` guard to the update trigger's insert.
- **Testing needed:** UPDATE a compaction row's content; assert it doesn't appear in `searchMessages`.

#### DATA-2 — `tree_edges.child_id` polymorphic FK invariant enforced only by convention
- **Category:** Data-integrity · **Severity:** Low · **Confidence:** Medium
- **Location:** schema `db.ts:201-211`; teardowns in `ingestion/index.ts:731`, `tree-build.ts:173`,
  `purgeDocumentDerivatives` (`ingestion/index.ts:1443`).
- **Description:** `child_id` references either `chunks.id` or `tree_nodes.id` (no FK to chunks). Safe only
  because every current chunk-delete path also deletes the document's `tree_nodes` (cascading the edges).
  Correct today, but a future chunk-mutating path that skips the tree teardown would dangle edges →
  silently lost tree leaves.
- **Recommended fix:** No schema change; add an integrity assertion/test for the invariant.

#### DATA-3 — `extraction_records` `__scan__` marker growth — verify idempotent replace
- **Category:** Data-layer · **Severity:** Low · **Confidence:** Medium (HYPOTHESIS)
- **Location:** schema `db.ts:244-259`; `analysis/extract.ts`.
- **Description:** One bookkeeping `__scan__` marker per scanned chunk. Bounded per chunk (cascade on
  chunk/document delete), so genuinely Low — the open question is whether re-extract deletes prior markers
  for a chunk before re-inserting. The one derived table whose row count scales with
  `chunks × extract-generations` and wasn't examined in the DATA-3 eviction pass.
- **Recommended fix:** Confirm `extract.ts` is idempotent per chunk (delete-then-insert or `ON CONFLICT`).
- **Testing needed:** Run extract twice over the same doc; assert the marker count doesn't double.

### RAG / ingestion

#### RAG-N1 — Audio segment packing counts whitespace words → CJK/Thai chunk overflow
- **Category:** Ingestion · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/ingestion/parsers/audio.ts:96-122`; consumer
  `ingestion/index.ts:964-976, 1084-1094`.
- **Description:** `packTranscriptSegments` caps a packed segment at `AUDIO_SEGMENT_MAX_WORDS = 400` via
  `text.split(/\s+/).length`, "to stay below the 500-token chunk window so every audio chunk is one packed
  segment verbatim (no windowing, no overlap)." For space-less scripts a 1,200-character phrase is a few
  "words" but ~1,200 tokens → the chunker windows it with 80-token overlap → breaks the
  one-segment-per-chunk-no-overlap invariant that `audioSegmentsFromChunks` relies on for lossless
  reconstruction.
- **Consequences:** CJK/Thai transcript preview / translate / compare emit duplicated text at every overlap
  boundary. Retrieval is unaffected (overlap is benign there).
- **Recommended fix:** Measure with `approxTokenCount` (CJK/Thai-aware) keyed off `CHUNK_DEFAULTS.chunkSizeTokens`;
  char-split oversize single segments for space-less scripts.
- **Testing needed:** `packTranscriptSegments` unit test on a JA/TH transcript (every packed segment ≤ window
  tokens); round-trip integration test asserting no duplicated spans.
- **Docs:** `rag-design.md` §2 audio row + the audio.ts note (token-based, space-less-safe).

#### RAG-N3 — Reranker scores only the first ~320 approx-tokens of 500-token chunks
- **Category:** Quality · **Severity:** Medium · **Confidence:** High (mechanism), Medium (magnitude)
- **Location:** `apps/desktop/src/main/services/reranker/llama.ts:34-35, 169-170`; interaction with
  `rag/index.ts:284-312`.
- **Description:** Chunks are 500 approx-tokens but the reranker truncates each candidate to
  `MAX_DOC_APPROX_TOKENS = 320` before scoring. The reranker (rag-design §12.3, the load-bearing relevance
  separator) never sees the last ~36% of a chunk, and that truncated score drives both final ordering *and*
  the dedup-by-page winner (`rag/index.ts:303-312`).
- **Consequences:** A chunk whose key sentence is in its second half is under-scored, can lose its page's
  dedup slot, or drop out of `topKFinal`. The §12.3 quality win was itself measured under this truncation.
- **Recommended fix:** Reduce chunk size toward the rerank budget, or raise `MAX_DOC_APPROX_TOKENS` toward
  the chunk size (bounded by the candidate cap), or score head+tail. At minimum document the ceiling.
- **Testing needed:** Rerank-quality fixture where the discriminating sentence is in a chunk's tail.
- **Docs:** `rag-design.md` §11/§12.3 — state the prefix-scoring explicitly (see DOC-N6).

#### RAG-N2 — Chunker overlap dropped entirely for space-less (CJK/Thai) scripts
- **Category:** Quality · **Severity:** Low · **Confidence:** Medium (mechanism verified, recall impact HYPOTHESIS)
- **Location:** `apps/desktop/src/main/services/ingestion/chunker.ts:160-192` (`windowByTokens`), via
  `atomize` `:132-150`.
- **Description:** A pure-CJK run is hard-cut into atoms of `cap = size` (500) tokens each; the overlap
  step-back only re-includes an atom whose tokens `≤ ov` (80), which is never true for 500-token atoms → 0
  overlap between consecutive CJK chunks. The 80-token overlap that prevents boundary-straddling facts from
  being missed is absent for non-space-separated languages.
- **Recommended fix:** Hard-cut at `cap - overlap`, or special-case overlap for character-sliced atoms.
- **Testing needed:** `windowByTokens` unit test on a long pure-CJK string (consecutive windows share ~`ov`).

#### RAG-N4 — Markdown parser splits sections on `#` inside fenced code blocks
- **Category:** Ingestion · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/ingestion/parsers/markdown.ts:10, 30-39`.
- **Description:** No fence tracking; a `# comment` / `#define` inside a ` ``` ` block is read as a heading,
  fragmenting the code block and stamping a bogus `sectionLabel` → wrong citations.
- **Recommended fix:** Track an in-fence flag (toggle on ` ``` `/`~~~`); skip heading detection inside fences.
- **Testing needed:** `MarkdownParser` test on a doc with `#`-bearing fenced code (block stays one segment).

#### RAG-N5 — TSV files rely on papaparse delimiter auto-detection
- **Category:** Ingestion · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/main/services/ingestion/parsers/csv.ts:19, 24`.
- **Description:** `.tsv` is registered but `Papa.parse(raw, { skipEmptyLines: true })` passes no `delimiter`
  → auto-guess can pick `,` for a tab file whose cells contain commas → every `header: value` mis-paired,
  silently (doc still reaches `indexed`).
- **Recommended fix:** Branch on extension — `{ delimiter: '\t' }` for `.tsv`, `{ delimiter: ',' }` for `.csv`.
- **Testing needed:** `CsvParser` test on a `.tsv` whose cells contain commas.

#### RAG-N6 — `corpusNeedsReindex` ignores `includeArchived`
- **Category:** RAG-correctness · **Severity:** Low · **Confidence:** Medium (HYPOTHESIS on visibility)
- **Location:** `apps/desktop/src/main/services/rag/index.ts:145-172`.
- **Description:** Its counts gate on `status='indexed'` + membership but apply no archived exclusion, while
  `retrieve()` excludes archived by default. In an all-archived scope, retrieval returns nothing but
  `corpusNeedsReindex` counts the archived docs as visible → the empty-context branch shows a stale
  no-context/reindex diagnosis instead of "all archived." A wrong-diagnosis honesty bug, not a data bug.
- **Recommended fix:** Apply the same archived exclusion as retrieval when `scope.includeArchived` is falsy.
- **Testing needed:** Extend `rag-scope.test.ts` with an all-archived scope.

### Business logic

#### BL-N1 — US-ordered dates silently dropped / mis-parsed during extraction
- **Category:** Correctness · **Severity:** High · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/tools/money.ts:98-109` (`parseDate`), consumed by
  bank `parseLine` (`bank-statement.ts:109-111`) and invoice header/date parsing (`invoice.ts:155-158`).
- **Description:** `parseDate` reads dotted/slashed dates strictly day-first (de-AT target). For US-locale
  `mm/dd/yyyy`: (a) day > 12 (`12/31/2026`, `06/15/2026`) → `null` → `parseLine` drops the *whole row*
  silently (`bank-statement.ts:110` `if (dates.length === 0) return null`); (b) both ≤ 12 (`03/05/2026`,
  US Mar 5) → parsed as May 3, a confidently-wrong date on the row. The docs disclose this only as a
  redaction under-detection (known-limitations BL-4); the extraction consequence — lost rows + wrong dates
  — is undocumented and worse.
- **Evidence:** verified directly: `parseDate('12/31/2026') → null`, `parseDate('03/05/2026') → 2026-05-03`;
  `bank-statement.ts:110` drops null-date rows.
- **Consequences:** On a US-formatted statement ~half the rows (day > 12) vanish from totals/cashflow/CSV
  with no warning; survivors can carry the wrong month. The completeness gate masks the loss as
  `'unverified'` rather than flagging it. (Context: the app primarily targets de-AT, but nothing restricts
  imports to that locale.)
- **Recommended fix:** Detect locale ambiguity per document (if any `nn/nn/yyyy` token has first field > 12
  and second ≤ 12, infer mm/dd order for the whole doc) or surface a caveat; at minimum document the harm.
- **Testing needed:** Fixtures: a US-ordered statement (rows with day > 12) → assert detection or caveat,
  not silent drop; an ambiguous `03/05/2026` case.
- **Docs:** known-limitations.md — extend BL-4 to cover extraction date mis-parse / row loss, not only
  redaction under-masking.

#### BL-N2 — Trailing-date balance lines parse the date as the opening/closing balance
- **Category:** Business logic · **Severity:** Medium · **Confidence:** High (mechanism), Medium (occurrence)
- **Location:** `apps/desktop/src/main/services/skills/tools/bank-statement.ts:178-182` (`lastMoneyOnLine`),
  used by `extractStatementBalances` (`:219, :224-229`); invoice `lastMoney` (`invoice.ts:160-165`).
- **Description:** Balances are read via the *last* `MONEY_RE` match. A line shaped
  `Endsaldo 1.234,56 EUR per 30.06.2026` matches `30.06.20` as the last money token → parsed to **3006.20**
  as the closing balance (verified). This directly contradicts the in-code claim at `money.ts:128-129` that
  last-token readers "take the trailing figure, so they were never affected" — which assumes the date
  always *leads*. The de-AT `Kontostand per <date> <figure>` shape is date-first (correct); the
  figure-then-trailing-date balance line is the unconfirmed trigger.
- **Consequences:** A wrong closing/opening balance feeds `assessCompleteness`: an honest tying statement
  can flip to `'contradicted'` (refuses to present any total), or a garbage balance could spuriously
  *agree* and mislabel a partial sum `'complete'`.
- **Recommended fix:** Strip trailing date tokens before the money scan in `lastMoneyOnLine`/`lastMoney`
  (mirror `splitLeadingDates` from the end), or exclude any `MONEY_RE` match adjacent to a 4-digit-year date.
- **Testing needed:** Balance/total lines with the figure followed by a date in `dd.mm.yyyy` and `dd/mm/yyyy`;
  end-to-end `assessCompleteness` proving a tying statement stays `'complete'`.
- **Docs:** Correct the architecture.md §24/§10 BL-1 immunity claim.

#### BL-N3 — Bank `parseLine` takes the FIRST money token as the amount
- **Category:** Correctness · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/tools/bank-statement.ts:112-117`.
- **Description:** Amount = `matches[0]`, balance = last. A money-shaped token in the description (a
  reference number with cents, an inline price) before the real amount column is taken as the amount, with
  its sign. Verified: `'Betrag 100,00 EUR -100,00 900,00'` → amount 100 (should be −100).
- **Consequences:** Wrong-signed/wrong-valued transactions silently enter totals/cashflow/categorization
  (sign drives Income/Spending)/CSV.
- **Recommended fix:** Prefer the amount column by position relative to the running balance (e.g.
  second-to-last money token when a balance is present), or use the geometry/column model; at minimum
  document the assumption.
- **Testing needed:** Fixture with a money-shaped token inside the description preceding the real amount.

#### BL-N4 — Redaction misses common US phones + lowercase IBANs (under-masking PII)
- **Category:** Data-handling · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/tools/redaction.ts:97` (`PHONE_RE`), `:84`/`:130`
  (IBAN).
- **Description:** `PHONE_RE` matches only `+`-prefixed or leading-`0` numbers, so `555-123-4567` /
  `1-800-555-1234` slip through. IBAN detection is case-sensitive, so `de89370400440532013000` (lowercase)
  is never a candidate. Verified.
- **Consequences:** Personal data the user expects masked is written to the "redacted" copy. Best-effort
  posture acknowledged, but these are common formats.
- **Recommended fix:** Add a guarded US/national phone alternative; make IBAN detection case-insensitive
  (uppercase before per-country length validation).
- **Testing needed:** Cases for `555-123-4567`, `1-800-555-1234`, lowercase/mixed-case IBANs.
- **Docs:** known-limitations.md redaction bullet — note format coverage caveats.

#### BL-N5 — `reconcileBalances` uses float comparison while `assessCompleteness` uses integer cents
- **Category:** Correctness · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/main/services/skills/tools/bank-statement.ts:477-478` vs `:307-309`.
- **Description:** The C-3 fix made `assessCompleteness` sum in integer cents; per-row `reconcileBalances`
  still compares `Math.abs(printed - expected) < MONEY_EPS` in floats. A `mismatch` here forces
  `assessCompleteness` to `'contradicted'`, so a borderline float comparison can still flip the gate the
  integer path was meant to stabilize. Low (per-row drift is tiny).
- **Recommended fix:** Convert the per-row reconcile to integer cents too.

#### BL-N6 — Redaction masks every date → locale-asymmetric output content
- **Category:** Data-handling · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/main/services/skills/tools/redaction.ts:151-161, :101`.
- **Description:** `maskDates` masks any `parseDate`-valid token with no context, so meaningful dates
  (contract/effective/due dates) are destroyed while names/addresses survive. Combined with the day-first
  limitation, an EU `31/12/2026` is masked but the US `12/31/2026` is left in clear — a locale-dependent
  inconsistency in the *output document content*, not just recall.
- **Recommended fix:** Document the date-category behavior + asymmetry; consider opt-in date masking if a
  category UI lands.

### Frontend / renderer

#### FE-1 — No top-level React error boundary
- **Category:** Error-handling · **Severity:** High · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/App.tsx:211-273`, `main.tsx:15-19`; verified zero
  `ErrorBoundary`/`componentDidCatch`/`getDerivedStateFromError` in the renderer.
- **Description:** No error boundary anywhere. Any screen render throw (incl. `react-markdown` on malformed
  model output, or a Radix portal) unmounts the whole tree → blank white window, no recovery, no localized
  message — at odds with the "never trap the user" tone elsewhere.
- **Consequences:** One render error takes down the entire offline app; the user must force-quit; no remote
  crash reporting to even notice.
- **Recommended fix:** Add a class `ErrorBoundary` (log via the existing local log channel, no network) with
  a localized fallback + reset/navigate-home; wrap each screen keyed by `screen` (re-mount clears the
  error) and an outer boundary around `<App/>`. Keep the nav rail alive.
- **Testing needed:** Render a throwing child inside the boundary → localized fallback shows, shell
  survives; navigating away resets the boundary.
- **Docs:** Note the error-boundary contract in `architecture.md` (renderer section).

#### FE-2 — Unhandled IPC rejections (cancelDownload, pickSkillPackage)
- **Category:** IPC-usage · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/screens/ModelsScreen.tsx:345`;
  `screens/settings/SkillsTab.tsx:117-126`.
- **Description:** `cancelDownload(...).then(setJob)` has no `.catch`; `await pickSkillPackage(mode)` sits
  outside the try in `pick()`. Either rejection becomes an unhandled rejection with no user feedback.
- **Recommended fix:** Route through the existing `run()` helper / add `.catch` → friendly error; move
  `pickSkillPackage` inside the try (or its own catch → `toast(t('skills.import.failed'))`).
- **Testing needed:** Rejecting `cancelDownload`/`pickSkillPackage` surfaces a friendly error, no throw.

#### FE-3 — Skill enable/disable Switch double-submit / desync
- **Category:** IPC-usage · **Severity:** Medium · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/screens/settings/SkillsTab.tsx:141-160`.
- **Description:** `applyEnabled` calls enable/disable then `refresh()` with no in-flight disable and no
  optimistic update; rapid toggling fires overlapping calls and last-resolved-`refresh()`-wins can leave
  the toggle disagreeing with server state.
- **Recommended fix:** Per-skill in-flight set (disable the Switch while pending); ignore stale results /
  serialize with a sequence guard.
- **Testing needed:** A second toggle while the first is pending is suppressed; final UI matches last
  completed server state.

#### FE-4 — setState-after-unmount in import poll (recurring pattern)
- **Category:** React-correctness · **Severity:** Medium · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/screens/DocumentsScreen.tsx` ~314-332; same shape in
  `settings/PrivacyTab.tsx:18-22`, DiagnosticsTab refreshers, SkillsTab settings load, GeneralTab ~93-95
  (HomeScreen does it right with `let active`).
- **Description:** An in-flight async poll tick (`await getImportJob`) can resolve after the interval is
  cleared and `setState` on an unmounted component; the fire-and-forget `.then(setX)` shape recurs across
  several mount-effects.
- **Recommended fix:** Adopt HomeScreen's `let active = true; … if (active) setX(); return () => { active = false }`
  uniformly (or an AbortController); check the guard before each `setX` inside the poll tick.
- **Testing needed:** Unmount-mid-poll asserts no state update after cleanup.

#### FE-5 — App settings/policy effect re-runs on every UI-language change
- **Category:** React-correctness · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/App.tsx:100-122`; `i18n.tsx:100-104`.
- **Description:** `I18nProvider` recreates `applyLanguageSetting` via `useMemo(..., [lang])`; the App effect
  lists it in deps alongside `[screen, unlocked]`, so a language switch re-fires `getPolicy()` + `getSettings()`
  and re-applies theme/language (a feedback path — the effect can change `lang`). Benign (idempotent) but
  fragile.
- **Recommended fix:** Make `applyLanguageSetting` identity-stable (`useCallback([])`, it only needs
  `setLang`); drop it from the App effect deps, or split language-apply out of the policy/settings effect.

#### FE-6 — Array-index / `Date.now()` React keys on transient lists
- **Category:** React-correctness · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/chat/ScopePopover.tsx:218-220` (`key={`pending-${i}`}`);
  `screens/ChatScreen.tsx:1469-1476` (`optimistic-${Date.now()}`).
- **Description:** Index keys on the pending-attachment list can mis-associate chips when an item resolves
  out of order; two optimistic user turns in the same ms collide on key.
- **Recommended fix:** Key pending chips by file name/id; use a monotonic counter or `crypto.randomUUID()`
  for the optimistic id.

#### FE-7 — Toast auto-dismiss `setTimeout` untracked
- **Category:** React-correctness · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/components/Toast.tsx:34-40`.
- **Description:** The 4 s dismiss timer isn't tracked/cleared; if the provider unmounts within 4 s it
  setState's on an unmounted component. Provider is effectively permanent, so minimal impact.
- **Recommended fix:** Track timer ids in a ref; clear in a cleanup effect.

#### FE-8 — Raw English `Error.message` in localized diagnostics copy
- **Category:** i18n · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/screens/settings/DiagnosticsTab.tsx` ~296-297, 373, ~315/138.
- **Description:** Benchmark failures interpolate a raw English `err.message` into `t('diag.bench.failed', …)`
  instead of `friendlyIpcError`; a literal `'UNKNOWN'` is rendered where neighbors use `t('diag.app.unknown')`.
- **Recommended fix:** Pass `friendlyIpcError(err)` (or a mapped code); replace the `'UNKNOWN'` literal.

#### FE-9 — SegmentedControl Home/End handlers correct only via modulo wrap
- **Category:** Accessibility · **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/components/SegmentedControl.tsx:56-62`.
- **Description:** `Home → move(len-1, 1)`, `End → move(0, -1)` land on first/last only because `move` wraps
  modulo and skips disabled segments — obscure and fragile under future changes to `move`.
- **Recommended fix:** Implement Home/End directly (first/last non-disabled), or add an explanatory comment.
- **Testing needed:** Keyboard test: Home → first enabled, End → last enabled, including disabled ends.

### Security

#### SEC-N1 — NUL-byte `.skill.zip` member name leaks a raw path from `previewSkillPackage`
- **Category:** Security / Data-handling · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/installer.ts:256-270` (`safeRelPath`), `:408-419`
  (`writeStaged`), `:539-592` (catch-less try/finally); `ipc/registerSkillsIpc.ts:171-174` (no try/catch).
- **Description:** A central-directory member name with an embedded NUL (`a b.md`) passes every
  `safeRelPath` check (no control-char/NUL rejection), reaches `writeFileSync`, throws a raw
  `ERR_INVALID_ARG_VALUE` whose message embeds the attacker-controlled path; `previewSkillPackage` has no
  `catch`, so the raw error is serialized to the renderer. Breaks the documented "never throws / returns
  `ok:false`" contract and the §22-M1 fixed-structural-string invariant. `importSkill` is not affected (it
  catches and re-maps). No file escapes staging; the leaked bytes are the attacker's own.
- **Recommended fix:** Reject `name.includes(' ')` in `safeRelPath`, and/or wrap the preview body/handler
  in a catch that maps unknown throws to a generic reason (mirror `importSkill`).
- **Testing needed:** Adversarial NUL-name fixture → `previewSkillPackage` returns `{ok:false}` with a fixed
  reason, never rejects; extend the sentinel-grep test to assert the path never appears in the IPC error.
  (Also closes the spirit of the deferred TEST-9 adversarial-fixture residual.)

#### SEC-N2 — Benchmark IPC handlers lack explicit `requireUnlocked()` (fail-closed)
- **Category:** Security · **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/registerBenchmarkIpc.ts:107-110`.
- **Description:** `runBenchmark`/`tryGpuAgain` touch `ctx.db` (via `updateSettings`) without the
  `requireUnlocked()` preamble every other DB-touching handler uses. Not exploitable (`ctx.db` getter
  throws when locked → fail-closed); only the error surfaced is the raw English string instead of the
  localized `main.*.locked`.
- **Recommended fix:** Add `requireUnlocked()` for parity (cosmetic).

#### SEC-N3 — (Info) Sidecar `serverMessage` 500-char tail is content-free only by upstream convention
- **Category:** Data-handling · **Severity:** Info · **Confidence:** Low (HYPOTHESIS)
- **Location:** `apps/desktop/src/main/services/runtime/llama.ts:303-322`; surfaced via `ipc/chat-stream.ts:134-136`,
  `doctasks/manager.ts:550, 1671`.
- **Description:** On a non-JSON error body, `ChatRequestError.message` appends `raw.slice(0, 500)` of the
  response, which flows into `log.error` and (for non-overflow chat errors) the renderer `STREAM.error`.
  Content-free *in practice* (llama.cpp error bodies are structural), but the guarantee rests on upstream
  behavior, not a local guard. A future runtime that reflected request text in error bodies would carry it
  into the local log + renderer.
- **Recommended fix:** Optional — pin the invariant with a test/comment, or sanitize the fallback to a fixed
  structural string + numeric status. Re-verify on each runtime pin bump.

### Testing

#### TEST-N1 — No CI pipeline exists
- **Category:** Test-infra · **Severity:** High · **Confidence:** High
- **Location:** repo root (absence); verified no `.github/workflows`, only sample git hooks, no
  husky/lint-staged/`ci` script.
- **Description:** Nothing runs `npm test` / `npm run typecheck` / `npm run build` automatically on
  commit/push/PR. The suite is fully offline-capable (mock runtime + mock embedder), so this is not a
  technical blocker. The repo's own anti-false-green guard (`tests/full-suite-guard.ts`) only matters if
  something runs it.
- **Consequences:** A regression / typecheck break / silently-dropped suite can land on `master` unnoticed;
  the documented pre-release gate (`packaging.md` §M-A5) has no machine backstop.
- **Recommended fix:** Minimal GitHub Actions on push/PR: `npm ci && npm run typecheck && npm run build && npm test`.
  Cache or skip the `postinstall` Electron verify in CI.
- **Testing needed:** Full suite passes in a clean offline runner; `FullSuiteGuard` fires on a deliberately
  excluded file.
- **Docs:** Add a CI section to `BUILD_STATE.md` / `packaging.md`; note the `HILBERTRAUM_*` manual matrix
  remains a separate human gate.

#### TEST-N2 — Money extraction "integration" tests assert pre-isolated tokens, masking live `MONEY_RE` locale bugs
- **Category:** Over-mocking / Coverage-gap · **Severity:** High · **Confidence:** High (reproduced)
- **Location:** `money.ts:42` (`MONEY_RE`); tests `tests/unit/skills-bank-statement-tool.test.ts:67-76`,
  `skills-invoice-tool.test.ts:65-71`.
- **Description:** `parseAmount` is tested only with already-isolated tokens; no test drives adversarial
  strings through the real `MONEY_RE → parseAmount` extraction path. Reproduced live bugs that path hides:
  `"Grocery 1.000"` → 1 (1000× understatement), `"Amount 1 234 567,89"` → 567.89 (gross truncation),
  `"1'234.56"` → 234.56 (Swiss apostrophe).
- **Consequences:** Silent under-extraction of whole-euro and grouped amounts on real DACH/CH statements.
  Partly limited by the reconciliation gate (mismatched totals → "unverified"), but the extracted figures
  are wrong and untested.
- **Recommended fix:** Table-driven test feeding whole strings through `extractTransactionRows`/`parseLineItem`,
  covering `1.000`, `2.500`, `1 234 567,89`, `1'234.56`; decide + pin intended behavior for whole-euro
  figures (related to BL-N1/BL-N2/BL-N3 — bundle as the financial-correctness wave).
- **Docs:** known-limitations.md money/locale bullet — which separators are/aren't supported.

#### TEST-N3 — Manual smokes never run automatically; promised parser fixtures are missing
- **Category:** Coverage-gap · **Severity:** Medium · **Confidence:** High
- **Location:** `tests/manual/*.test.ts` (all `describe.skipIf(!enabled)` on `HILBERTRAUM_*`); `tests/real-model/`,
  `tests/real-data/`.
- **Description:** The riskiest surface (real spawn, llama-server SSE incl. `reasoning_content`, GPU
  `--list-devices`, whisper-cli JSON, WASM OCR, vision `--mmproj`) runs only in env-gated smokes that can't
  run in offline CI. The promised mitigation — canned-real-output fixture parser tests — is only partially
  built (only the `gpu.test.ts` `--list-devices` fixture exists per packaging.md:374).
- **Recommended fix:** Build the canned-fixture parser tests for SSE/whisper-JSON/rerank so the *parse layer*
  is CI-covered without weights; track per-release which `HILBERTRAUM_*` smokes were last run in BUILD_STATE.
- **Docs:** Add `RUN_RESIDENT_BENCH` to the packaging.md harness matrix.

#### TEST-N4 — Retrieval/fusion ranking ORDER tested only on exact-match queries
- **Category:** Over-mocking · **Severity:** Medium · **Confidence:** High
- **Location:** `embeddings/mock.ts:32-51`; tests `tests/integration/rag.test.ts:192-203`,
  `embeddings.test.ts:190-208`, `hybrid-search.test.ts:299-321`.
- **Description:** The mock embedder is feature-hashing (cosine ≈ shared exact tokens), and every CI
  retrieval-ordering test queries text byte-identical to the target chunk, so the only assertion is
  "exact-match ranks #1" — a degenerate case a broken cosine would still pass. The assembled `retrieve()`
  rescue test asserts membership only. (The pure `rrfFuse` unit tests ARE strong — the gap is the assembled
  path.)
- **Recommended fix:** CI test with graded token overlap (4/2/1 shared tokens) asserting full order with
  strict `<` between adjacent scores; extend the rescue test to assert relative rank.

#### TEST-N5 — Implementation-detail assertions break on safe refactors
- **Category:** Brittle-test · **Severity:** Medium · **Confidence:** High
- **Location:** `tests/integration/workspace-vault.test.ts:98-110` (Buffer.fill spy);
  `skills-analysis-bank.test.ts:181,255` & `skills-analysis-invoice.test.ts:164` (exact `db.prepare` counts);
  `tests/unit/skills-bank-statement-tool.test.ts:358`, `skills-redaction-tool.test.ts:160` (exact event arrays).
- **Description:** Asserts mechanism not outcome: spying `Buffer.prototype.fill` to "prove" key-zeroing
  (passes even if the key isn't zeroed, if any other `fill(0)` runs — a false sense of security; breaks if
  zeroing uses `randomFill`/`.set`); `expect(reads).toBe(1)` pins a query-coalescing optimization; exact
  audit-event array equality breaks if an internal seam splits.
- **Recommended fix:** Assert the observable (key buffer is all-zero after lock) not the spy; relax counts to
  `toBeLessThanOrEqual` or drop for an output assertion; use `toContain`/`not.toContain` for events.

#### TEST-N6 — Redaction under-detection has no characterization test
- **Category:** Coverage-gap / Failure-path-gap · **Severity:** Medium · **Confidence:** High
- **Location:** `skills/tools/redaction.ts`; tests `tests/unit/skills-redaction-tool.test.ts:81-89`.
- **Description:** The acknowledged BL-4 asymmetry (US `mm/dd/yyyy` + 2-digit years slip through; names/
  addresses never masked) has no characterization test; `:84` even asserts `03/15/2026` is *left unmasked*
  as correct, which is the un-redacted leak path. No test documents the names/addresses non-coverage.
- **Recommended fix:** Explicit characterization tests asserting the current (intentional-limitation)
  behavior, so any change must update the assertion; cross-reference from known-limitations.md.

#### TEST-N7 — `decodeVector` little-endian on-disk contract not byte-pinned
- **Category:** Coverage-gap · **Severity:** Low · **Confidence:** High
- **Location:** `embeddings/codec.ts:15-42`; tests `tests/integration/embeddings.test.ts:129-161`.
- **Description:** Only round-trip tested (encode→decode), which can't catch a symmetric endianness bug.
  No test feeds known LE bytes and asserts the float. Low (all targets LE; module-load guard fails loudly on
  BE), but a future `DataView` BE write would pass round-trip while corrupting on-disk vectors.
- **Recommended fix:** One fixed-byte-layout assertion locking the LE contract.

#### TEST-N8 — Lock guard tested on 3/14 handlers; retrieve-embed-failure untested
- **Category:** Failure-path-gap · **Severity:** Low · **Confidence:** High
- **Location:** `ipc/registerChatIpc.ts:69-73` (14 `requireUnlocked()` sites); test `chat-ipc.test.ts:81-98`;
  `rag/index.ts:231`.
- **Description:** The lock test (verified to have teeth) covers only 3 "representative" handlers — a new
  handler added without the guard wouldn't be caught. Embedder failure *during query embedding inside
  `retrieve()`* is untested (no try/catch there → propagate-vs-swallow unspecified by tests).
- **Recommended fix:** Parametrized lock test over all DB-touching handlers (or a structural test that every
  registered DB handler is guarded); a retrieve()-level rejecting-embedder test asserting intended behavior.

#### TEST-N9 — `whisper-smoke` leaks a temp dir at module load even when skipped
- **Category:** Test-infra · **Severity:** Low · **Confidence:** High
- **Location:** `tests/manual/whisper-smoke.test.ts:40` (module-scope `mkdtempSync`).
- **Description:** Runs during collection on every suite run (file always collected) though the `describe` is
  skipped, never cleaned up — an import-time side effect in a "skipped" file.
- **Recommended fix:** Move into a `beforeAll` inside the gated `describe` with an `afterAll` cleanup.

### Documentation

#### DOC-N1 — Undocumented runtime caps; security-model names 2 of 6 skill caps
- **Category:** Undocumented-config · **Severity:** Medium · **Confidence:** High
- **Location:** `docs/security-model.md:493-542` & Image-understanding § ↔ `services/skills/limits.ts:53-64`,
  `services/vision/limits.ts:15,32`.
- **Description:** `security-model.md` says the §6.4 skill caps are "all env-overridable" but names only
  `HILBERTRAUM_SKILL_MAX_TOTAL_BYTES` / `_FILE_BYTES`; `limits.ts` reads six (also `_FILES`, `_PATH_LEN`,
  `_DEPTH`, `_BODY`). `vision/limits.ts` reads `HILBERTRAUM_MAX_IMAGE_BYTES` (named in no .md; only the
  sibling `_MAX_IMAGE_PIXELS` appears, in BUILD_STATE only).
- **Recommended fix:** List all six `HILBERTRAUM_SKILL_MAX_*` (mirror the malicious-document cap list that
  does name each); add `HILBERTRAUM_MAX_IMAGE_BYTES` next to the pixel cap.

#### DOC-N2 — Stale §-anchor: `manager.ts` cites architecture.md §21, should be §22
- **Category:** Anchor-integrity · **Severity:** Low · **Confidence:** High
- **Location:** `services/doctasks/manager.ts:1544` ↔ `docs/architecture.md:2783` (§21) / `:3089` (§22).
- **Description:** `runCategorize` cites "§21" (geometry extractor) for the bank-statement LLM categorizer,
  whose record is §22 (Phase 33, D26). Exactly the anchor drift the CLAUDE.md rule guards against.
- **Recommended fix:** `§21 → §22` in the comment.

#### DOC-N3 — README model size / RAM drift
- **Category:** Doc-contradiction · **Severity:** Low · **Confidence:** High
- **Location:** `README.md:189, 79, 179-181, 191` ↔ `model-manifests/chat/qwen3.5-4b-ud-q4kxl.yaml:8`,
  `model-policy.md:31`, `ministral3-8b-…yaml:9`.
- **Description:** README says Qwen3.5-4B "~2.6 GB"; manifest/model-policy say ~2.9 GB. README RAM-tier prose
  ("16–24 GB → Ministral 8B", a recommended best-fit) can be misread as a hard minimum vs the table's "12 GB."
- **Recommended fix:** Fix README size to ~2.9 GB; clarify RAM tiers are recommended best-fit vs minimum.

#### DOC-N4 — packaging.md "default-set mirrored from assets.ts" is misleading
- **Category:** Doc-drift · **Severity:** Low · **Confidence:** High
- **Location:** `docs/packaging.md:166-167` (& `drive-layout.md:169`) ↔ `scripts/prepare-drive.ps1:74-79` /
  `prepare-drive.sh:30-35` (no equivalent in `assets.ts`).
- **Description:** The default-set model-id list lives only in the two prepare-drive shells, not `assets.ts`,
  with no parity test. A maintainer editing the "canonical" assets.ts would see no effect.
- **Recommended fix:** Scope the "mirrored from assets.ts" claim to download/verify/plan logic; state the
  default-set ids live in `scripts/prepare-drive.{ps1,sh}` and must stay in sync (consider a parity test).

#### DOC-N5 — No documented single-test command; `test:watch` undocumented
- **Category:** Doc-gap · **Severity:** Low · **Confidence:** High
- **Location:** `CONTRIBUTING.md:15,28-33`, `README.md:169,257` ↔ `apps/desktop/package.json:13-14`.
- **Description:** Contributor docs show only `npm test` (whole suite); no single-file/filter command and
  `test:watch` is never mentioned → slow iteration for new contributors.
- **Recommended fix:** Add `cd apps/desktop && npx vitest run path/to/file.test.ts`, `npx vitest -t "name"`,
  and `npm run test:watch` to CONTRIBUTING.

#### DOC-N6 — rag-design understates the reranker/E5 retrieval-quality ceiling
- **Category:** Doc-mismatch · **Severity:** Low · **Confidence:** High
- **Location:** `docs/rag-design.md` §11/§12.1 R3/§12.3 ↔ `embeddings/e5.ts` (no `query:`/`passage:` prefixes),
  `reranker/llama.ts:34` (320-token truncation).
- **Description:** The load-bearing limitations (E5 runs prefix-less → compressed cosines; reranker scores
  only a 320-token prefix — see RAG-N3) are buried/implicit, while the prose presents the reranker as a clean
  fix. Future work may over-trust the reranker and under-invest in the prefix migration (the real lever,
  which would also re-enable a meaningful `ragMinSimilarity` floor).
- **Recommended fix:** A "Known retrieval-quality ceilings" note in §11 cross-linking R3 + the §12.3 rerank
  truncation; make the prefix migration a tracked TODO with expected impact.

#### DOC-N7 — Several test-harness `HILBERTRAUM_*` env vars undocumented
- **Category:** Undocumented-config · **Severity:** Low · **Confidence:** High
- **Location:** `docs/packaging.md:342-368` ↔ `tests/manual/*.test.ts`.
- **Description:** Six harness-input vars are documented only as inline test-file comments:
  `HILBERTRAUM_SMOKE_MODEL`, `HILBERTRAUM_GEMMA_MODEL`, `HILBERTRAUM_OCR_IMAGE`, `HILBERTRAUM_REAL_MODEL_PATH`,
  `HILBERTRAUM_RESIDENT_REAL_N`, `HILBERTRAUM_EVAL_DIR`.
- **Recommended fix:** Add an "optional inputs" column/footnote to the packaging.md harness matrix.

---

## 3. Documentation audit (summary)

The docs are **accurate and well-maintained** — the §-anchor citation system is real and almost entirely
intact, documented constants match code (chunk sizes, RRF k=60, FTS shape, codec hardening, summary_cache
eviction, the SEC-1 app-skill Tier-2 gate, service interfaces), every npm/script/CLI flag exists, and the
doc-lifecycle rule is being followed (the two lingering plan files are exactly the CLAUDE.md whitelist:
`big-slot-embeddings-plan.md` is genuinely open — Phase 30 unstarted; `functionality-wave-3-plan.md` is a
done-but-still-densely-cited wave, justified for now).

**Actionable doc items:** DOC-N1 (Medium — undocumented runtime caps) and DOC-N2…N7 (Low — anchor slip,
README size/RAM drift, the "mirrored from assets.ts" claim, missing single-test command, the
retrieval-ceiling note, test-harness env vars). Plus the doc-update riders attached to the code findings
(REL-1 GPU §5.3, BL-N1/BL-N2 known-limitations + §24 BL-1 immunity claim, RAG-N1/N3 §2/§11/§12.3).

**`HILBERTRAUM_*` env vars:** 54 referenced in code. Undocumented runtime caps to fix:
`HILBERTRAUM_MAX_IMAGE_BYTES`, `HILBERTRAUM_SKILL_MAX_BODY`, `_MAX_DEPTH`, `_MAX_FILES`, `_MAX_PATH_LEN`
(DOC-N1). Undocumented test-harness inputs: `HILBERTRAUM_EVAL_DIR`, `HILBERTRAUM_GEMMA_MODEL`,
`HILBERTRAUM_OCR_IMAGE`, `HILBERTRAUM_REAL_MODEL_PATH`, `HILBERTRAUM_RESIDENT_REAL_N`,
`HILBERTRAUM_SMOKE_MODEL` (DOC-N7). All others are documented.

---

## 4. Testing audit (summary)

**Strengths (verified, genuinely strong — leave alone):** crypto/vault lifecycle, runtime-manager
lifecycle (gated fake child, serialized switch, idempotent start, no real spawns/timers), chat-stream
lifecycle (error/abort/destroyed-renderer/key-reuse), navigation-guard (both events), conversation-search
(real pre-migration backfill), WorkspaceGate states, embedding-mismatch, reranker index-mapping contract,
chunker boundaries, FTS migrations, `rrfFuse` units, renderer a11y (behavioral, not render-without-crash).
The "teeth-verified" claim is real — independently confirmed by neutering `requireUnlocked` (the lock test
failed as it should).

**Two systemic weaknesses:** (1) **no CI** (TEST-N1) — discipline-only green; (2) **money-string parsing is
tested at the seam** (TEST-N2), hiding live locale bugs. Plus: retrieval *order* only exercised on
exact-match (TEST-N4), a cluster of implementation-detail asserts (TEST-N5), no redaction-under-detection
characterization (TEST-N6), the codec LE contract unpinned (TEST-N7), lock-guard breadth + retrieve-embed
failure gaps (TEST-N8), and a temp-dir leak in a skipped smoke (TEST-N9).

**Avoiding over-mocking (this codebase's own good practice, codified):**
1. Mock the *environment* (`electron`, child processes, HTTP), never the unit under test (`parseAmount`,
   `decodeVector`, the chunker, crypto all run for real — keep that line).
2. Make doubles *non-degenerate*: the reranker fake returns score-sorted (catches a broken mapping); the
   mock embedder's exact-match degeneracy is exactly why ranking-order tests are weak — feed *graded* inputs.
3. Assert *observable outcomes*, not mechanisms (key buffer is zero after lock > spying `Buffer.fill`).
4. Drive failure paths through the *real entry point* (the money bug hides because tests call `parseAmount`
   directly instead of `extractTransactionRows`).
5. Membership over exact sequences for audit/event streams.
6. For i18n, assert via the catalog key, not raw English literals.

---

## 5. Performance audit (summary)

The backend is careful (single-flight, bounded caches, transactions, op-queues). New perf items:

- **Main-thread blocking I/O** (PERF-1 image read, PERF-2 dictation WAV write) — two handlers use sync fs for
  large attacker-influenced buffers, diverging from the codebase's own ING-8 async convention. Validate by
  measuring event-loop stall on a ~20 MiB / 64 MiB input off USB before/after the async conversion.
- **DB query shape** (PERF-3 missing compaction index on the universal chat path; PERF-4 summary_cache
  eviction full-scan). Validate with `EXPLAIN QUERY PLAN` assertions.
- **Render** (PERF-5 Documents list not virtualized/memoized — re-renders all rows on the 400 ms import poll;
  PERF-6 vision answer markdown re-parse per tick). Validate with render-count tests and a large-N profile.
- **Scalability headroom:** `MAX_CHUNKS_PER_DOCUMENT=1000`, summary_cache 50k cap, vision/download job maps
  bounded, resident vector cache signature-invalidated — all sound. No unbounded growth found beyond the
  DATA-3 `__scan__` question (verify-only).

No expensive-query / N+1 / memory-leak issues beyond the above; the streaming chat path is correctly batched
(40 ms flush via refs) and IPC subscriptions are torn down in `finally`.

---

## 6. Phased remediation plan

Each phase is scoped to run in a fresh session. Every phase ends with the per-phase ritual (tests green,
build/launch OK, docs + BUILD_STATE updated, commit referencing the phase). Prefer characterization tests
before changing parsing/ranking behavior.

### Phase 0 — CI + safety net (do first)
- **Goal:** A machine backstop so every later phase is verified automatically.
- **Scope:** TEST-N1 (+ TEST-N9 temp-leak cleanup while here).
- **Files:** new `.github/workflows/ci.yml`; `tests/manual/whisper-smoke.test.ts`; `package.json` (cache/skip
  `postinstall` Electron verify in CI via `HILBERTRAUM_SKIP_ELECTRON_CHECK`).
- **Steps:** workflow on push/PR running `npm ci && npm run typecheck && npm run build && npm test` (offline,
  no weights); cache npm + the Electron binary; move the whisper-smoke `mkdtempSync` into `beforeAll`.
- **Tests:** confirm the suite passes in a clean runner; force-exclude a file to prove `FullSuiteGuard` fires.
- **Docs:** CI section in BUILD_STATE/packaging.md; note the `HILBERTRAUM_*` manual matrix stays a human gate.
- **Acceptance:** green required check on a PR; typecheck + build + 2335 tests run in CI.
- **Risk:** Electron binary download in CI — mitigate with caching / skip-verify. Rollback: delete the workflow.

### Phase 1 — Financial correctness (highest user-impact bug cluster)
- **Goal:** Stop silent financial data loss / confidently-wrong figures; lock behavior with real-path tests.
- **Scope:** BL-N1, BL-N2, BL-N3, BL-N4, BL-N5, BL-N6, and the test gaps TEST-N2, TEST-N6.
- **Files:** `services/skills/tools/money.ts`, `bank-statement.ts`, `invoice.ts`, `redaction.ts`; tests under
  `tests/unit/skills-*` and `tests/integration/skills-analysis-*`.
- **Steps:** (1) **Characterization tests first** — drive whole adversarial strings through
  `extractTransactionRows`/`parseLineItem`/`extractStatementBalances`/redaction (US dates, day>12, whole-euro,
  grouped/apostrophe figures, trailing-date balance lines, in-description money tokens, US phones, lowercase
  IBANs) to pin *current* behavior. (2) Fix BL-N1 (locale-aware date order or explicit caveat + stop silent
  row drop), BL-N2 (strip trailing dates / exclude year-adjacent money in `lastMoneyOnLine`/`lastMoney`),
  BL-N3 (amount-column-by-position), BL-N4 (phone/IBAN coverage), BL-N5 (integer cents in reconcile),
  BL-N6 (document/optionally gate date masking). (3) Update tests to the corrected behavior.
- **Tests:** the above + an `assessCompleteness` end-to-end proving a tying statement stays `'complete'`
  through a trailing-date closing line and is not corrupted by an in-description money token.
- **Docs:** known-limitations.md (extraction date locale + parse assumptions + redaction format coverage);
  correct the §24/§10 BL-1 immunity claim.
- **Acceptance:** the reproduced bugs (1000× understatement, dropped US rows, 3006.20 balance) are fixed or
  explicitly caveated; neutering each fix fails its test.
- **Risk:** locale inference heuristics can mis-fire — prefer a conservative caveat over a wrong guess; keep
  the de-AT day-first default. Rollback: revert per-fix (independent).

### Phase 2 — GPU crash auto-fallback (reliability)
- **Goal:** Make the documented self-healing CPU fallback actually restart.
- **Scope:** REL-1 (+ REL-2 instance single-flight while in `sidecar.ts`).
- **Files:** `services/runtime/index.ts` (manager), `index.ts` (crash wiring), `services/runtime/factory.ts`,
  `sidecar.ts`; tests `runtime-manager.test.ts`, `runtime-ladder.test.ts`.
- **Steps:** force a real restart on crash (stop-then-start, or a `forceRestart` bypassing the same-model
  guard, or clear `current`/`last` on unexpected exit); reset `this.last` so `status()` reflects the dead
  server; add the `LlamaServer` `starting` latch.
- **Tests:** integration with the **real** RuntimeManager + fake spawn: an unexpected `exit` triggers exactly
  one stop + one start, backend ends `cpu`, `status().healthy` is correct, a chat turn after the crash works.
- **Docs:** correct architecture.md GPU §5.3.
- **Acceptance:** the new integration test fails on `master` and passes after the fix.
- **Risk:** restart loop on a persistently-crashing server — keep the existing `gpuAutoDisabled` persistence
  so the restart lands on CPU, and bound retries. Rollback: revert the crash-path change.

### Phase 3 — Renderer robustness
- **Goal:** No blank-screen on a render throw; close unhandled-rejection / lifecycle gaps.
- **Scope:** FE-1, FE-2, FE-3, FE-4, FE-5, FE-6, FE-7, FE-8, FE-9.
- **Files:** new `renderer/components/ErrorBoundary.tsx`; `App.tsx`, `main.tsx`; `ModelsScreen.tsx`,
  `SkillsTab.tsx`, `DocumentsScreen.tsx`, `PrivacyTab.tsx`, `DiagnosticsTab.tsx`, GeneralTab; `i18n.tsx`;
  `ScopePopover.tsx`, `ChatScreen.tsx`, `Toast.tsx`, `SegmentedControl.tsx`; new i18n keys (en+de).
- **Steps:** add the error boundary (localized fallback, local-log, per-screen + outer); fix the two
  unhandled rejections; add the Switch in-flight guard; apply the `let active` unmount guard uniformly;
  stabilize `applyLanguageSetting`; fix keys; track the toast timer; route diagnostics errors through
  `friendlyIpcError` + localize `'UNKNOWN'`; clarify Home/End.
- **Tests:** boundary fallback + reset; rejecting cancelDownload/pickSkillPackage show friendly errors;
  Switch double-submit suppressed; unmount-mid-poll no setState; keyboard Home/End.
- **Docs:** error-boundary contract in architecture.md (renderer section).
- **Acceptance:** a thrown screen shows the fallback with the shell alive; no unhandled rejections in the
  touched paths. **Risk:** low; mostly additive. Rollback: per-fix.

### Phase 4 — CJK/Thai token-vs-word wave
- **Goal:** Extend the prior audit's token-awareness fix from embedder/reranker to ingestion.
- **Scope:** RAG-N1, RAG-N2.
- **Files:** `services/ingestion/parsers/audio.ts`, `chunker.ts`; tests under `tests/unit`.
- **Steps:** measure audio packing with `approxTokenCount` keyed off the chunk window; char-split oversize
  segments; give the chunker overlap for character-sliced atoms (hard-cut at `cap - overlap`).
- **Tests:** packed segments ≤ window tokens for JA/TH; lossless round-trip (no duplicated spans);
  consecutive CJK windows share ~`overlap`.
- **Docs:** rag-design.md §2 audio + §3 windowing (space-less notes). **Risk:** chunk-boundary changes affect
  new ingestions only (re-index self-heals). Rollback: revert per-file.

### Phase 5 — Data-layer hardening
- **Goal:** Atomicity + indexes + trigger/FK invariants.
- **Scope:** REL-4, REL-5, PERF-3, PERF-4, DATA-1, DATA-2, DATA-3.
- **Files:** `services/chat.ts`, `services/vision/history.ts`, `services/db.ts`,
  `services/analysis/summary-cache.ts`, `analysis/extract.ts`; tests under `tests/integration`.
- **Steps:** wrap `deleteConversation` in a txn; reorder `deleteImageSession` (delete row then shred); add
  `idx_messages_conv_kind` + `idx_summary_cache_created` (additive, `IF NOT EXISTS`); guard `messages_fts_au`
  with the `kind` filter; verify `extract.ts` `__scan__` idempotency; add the `tree_edges` invariant test.
- **Tests:** rollback-on-failure for the two deletes; `EXPLAIN QUERY PLAN` for the two indexes; the FTS
  update-guard test; the `__scan__` no-double-count test.
- **Docs:** data-layer/index inventory in architecture.md. **Risk:** very low (additive indexes, txn wraps).

### Phase 6 — Reranker scoring depth (quality; do after CI + tests exist)
- **Goal:** Make the load-bearing reranker see the whole chunk (or document the ceiling deliberately).
- **Scope:** RAG-N3 (+ DOC-N6).
- **Files:** `services/reranker/llama.ts`, possibly `chunker.ts` (chunk size) and `rag/index.ts` (dedup);
  tests + a rerank-quality fixture.
- **Steps:** decide between reducing chunk size toward the rerank budget, raising `MAX_DOC_APPROX_TOKENS`, or
  head+tail scoring; measure latency/`n_ctx` impact; add a tail-discriminating fixture.
- **Tests:** tail-relevance fixture ranks correctly; latency within budget.
- **Docs:** rag-design.md §11/§12.3 ceiling note + the prefix-migration TODO.
- **Risk:** chunk-size change forces re-index for the quality gain; latency regression if the cap is raised
  too far — measure first. Rollback: revert the constant.

### Phase 7 — Ingestion edge cases + small security/test polish
- **Goal:** Close the remaining Low items.
- **Scope:** RAG-N4 (markdown fences), RAG-N5 (TSV delimiter), RAG-N6 (corpusNeedsReindex archived),
  SEC-N1 (NUL member name), SEC-N2 (benchmark requireUnlocked), SEC-N3 (serverMessage pin),
  TEST-N4/N5/N7/N8, PERF-1/PERF-2 (async I/O), PERF-5/PERF-6 (render).
  *(Split into 2 sub-sessions if large; PERF-1/2 can ride Phase 3 if preferred.)*
- **Files:** the respective modules + tests.
- **Steps/Tests/Docs:** per each finding above. **Risk:** low; all independent.

### Phase 8 — Documentation reconciliation + close-out
- **Goal:** Apply doc-only fixes and fold this audit per the doc-lifecycle rule.
- **Scope:** DOC-N1…N7 + any doc riders not yet applied; then fold the per-finding dispositions into the
  topic-doc §§, update BUILD_STATE, delete this plan/report file (recoverable in git history).
- **Files:** `security-model.md`, `architecture.md`, `rag-design.md`, `README.md`, `packaging.md`,
  `model-policy.md`, `drive-layout.md`, `CONTRIBUTING.md`, `known-limitations.md`, `BUILD_STATE.md`.
- **Acceptance:** all env vars documented; anchors resolve; README sizes/RAM correct; a §-ledger for this
  audit exists (mirroring §24). **Risk:** none (docs only).

---

## 7. Recommended execution order & dependencies

1. **Phase 0 (CI)** — first; everything else relies on it as a backstop. No code dependency.
2. **Phase 1 (financial correctness)** — highest user impact (silent wrong money); independent of others.
   Do its characterization tests first. Pairs naturally with TEST-N2/N6.
3. **Phase 2 (GPU crash)** — highest reliability impact; independent; needs the Phase-0 net to verify the new
   integration test.
4. **Phase 3 (renderer robustness)** — highest blast-radius UX risk (blank screen); independent.
5. **Phase 4 (CJK/Thai)** — independent; one root cause, clean wave.
6. **Phase 5 (data-layer)** — independent, low-risk, additive.
7. **Phase 6 (reranker depth)** — **after** Phase 0 + the retrieval-order test (TEST-N4) exist, so the quality
   change is measurable; benefits from a CI perf check.
8. **Phase 7 (edge-case + polish)** — after the big rocks; all independent, batchable.
9. **Phase 8 (docs + close-out)** — last; folds every phase's record and deletes this working paper.

**Cross-cutting dependencies:** TEST-N2/N6 belong with Phase 1; TEST-N4 should precede Phase 6; DOC riders on
REL-1/BL-N1/BL-N2/RAG-N1/RAG-N3 are applied in their own phases, with the final reconciliation in Phase 8.
Phases 1–7 are otherwise mutually independent and can be parallelized across sessions/branches if desired
(they touch disjoint modules), then merged in any order, with Phase 8 last.
