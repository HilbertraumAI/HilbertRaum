# Architecture — Private AI Drive Lite

_Last updated: 2026-06-11 (Phase 37 — voice dictation)_

## Overview

Private AI Drive Lite is an **Electron** desktop app. It maps the spec's Tauri/Rust design onto
TypeScript while preserving the same module boundaries (spec §7) and command surface (spec §9.1), so
a future move to Tauri/Rust is a localized swap.

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed)                                    │
│  Screens: Onboarding · Home · Chat · Documents · AI Model ·    │
│           Settings (General / Privacy & data / Diagnostics)    │
│  No Node / no network access — only window.api (typed bridge)  │
└───────────────▲───────────────────────────────┬──────────────┘
                │ contextBridge (preload)        │ IPC events (streams)
┌───────────────┴───────────────────────────────▼──────────────┐
│ Main process (the "backend")                                   │
│  ipc/        → handlers mirroring spec §9.1                     │
│  services/                                                      │
│    workspace · db (node:sqlite) · models · runtime/ ·          │
│    chat · ingestion/ · embeddings/ · rag · benchmark ·         │
│    policy · logging · security/                                 │
└───────────────┬───────────────────────────────┬──────────────┘
                │ spawn (Phase 10)               │ files
        ┌───────▼────────┐              ┌────────▼─────────┐
        │ llama.cpp       │              │ Drive / workspace │
        │ llama-server    │              │ models/ workspace/│
        │ 127.0.0.1 only  │              │ logs/ config/     │
        └────────────────┘              └──────────────────┘
```

## Process model & security
- **Renderer**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Talks only to
  the preload bridge.
- **Preload**: exposes a single typed `window.api` object (see `src/preload/index.ts`).
- **Main**: owns all file I/O, the database, the model runtime, and (later) the llama.cpp sidecar.
- **CSP**: same-origin only; no remote origins. Applied as both an `index.html` meta tag and a
  response header (`session.webRequest.onHeadersReceived`) — strict in production, HMR-compatible in
  dev. See [`security-model.md`](security-model.md).

## Swappable interfaces (spec §9.2)
- `ModelRuntime` — `MockRuntime` **or** `LlamaRuntime`, chosen per `start()` by availability (Phase 10).
- `Embedder` — `MockEmbedder` **or** `E5Embedder`, chosen by availability (Phase 10).
- `Reranker` — `LlamaReranker` **or null**, chosen by availability (Phase 21). Deliberately no mock:
  a mock reranker would invent an ordering; null keeps retrieval byte-identical to the
  vector-only pipeline.
- `DocumentParser` — txt/md/pdf/docx/csv adapters (Phase 4).
- `VectorIndex` — cosine over SQLite-stored vectors (Phase 5) → `sqlite-vec`/HNSW later;
  hybridized with an FTS5 keyword pass + RRF in `rag.retrieve` (Phase 21).

## Storage
`node:sqlite` — built into the Node bundled by **Electron ^37** (Node 22.x). It is loaded via
`createRequire` in `services/db.ts` because the experimental module is absent from
`module.builtinModules`, which otherwise makes bundlers try to resolve a non-existent `sqlite`
package. One SQLite DB per workspace (`workspace/paid.sqlite`) holds the spec §8 tables (settings,
conversations, messages, documents, chunks, embeddings, runtime_events). In encrypted mode (Phase 9)
the whole DB file is encrypted at rest.

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
  single active runtime and restarts it on model switch. `MockRuntime` returns healthy immediately;
  its `chatStream` is a stub until Phase 3, and the real `LlamaRuntime` (localhost-only sidecar)
  lands in Phase 10. The factory passed to `RuntimeManager` is the only thing that changes.
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
  holds only user/assistant turns, so the prompt can evolve (RAG context is appended in
  Phase 6). `messages.citations_json` stays null until Phase 6.
- **Streaming contract (LOCKED).** Main → renderer over per-conversation IPC event channels
  keyed by the conversation id: `chat:token:<id>` (one token per event), `chat:done:<id>`
  (the final assistant `Message`), `chat:error:<id>` (an error string) — helpers in
  `src/shared/ipc.ts` `STREAM`. The renderer subscribes via the preload `onToken/onDone/onError`
  before sending. `sendChatMessage(conversationId, content, options)` *also* resolves with the
  final assistant `Message`, so a caller can simply `await` it; the event channels drive the
  incremental UI. The streaming id is the **conversation id** (one active stream per conversation).
  **Phase 20 added one ADDITIVE channel:** `chat:reasoning:<id>` (preload `onReasoning`) carries
  Deep-mode thinking deltas; token events still carry only answer text, and reasoning is a
  live-display affordance that is never persisted.
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
  `<think>` block from persisted replies AND from assistant turns replayed as history (D6).
  Document answers (`rag/`) never pass a mode — grounded answers always run balanced.
- **Cancellation.** Each in-flight send holds an `AbortController` in a per-conversation map in
  `ipc/registerChatIpc.ts`; `stopGeneration(conversationId)` aborts it. The runtime's
  `chatStream` honours `options.signal` and stops emitting; whatever streamed so far is persisted
  as the (partial) assistant message and a normal `done` is emitted.
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
  `sendChatMessage` (streaming), `stopGeneration`, `deleteConversation`. Regenerate reuses
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
  and persists to the `documents` + `chunks` tables. The `embedding` step is a pass-through
  until Phase 5.
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
  size-aware audio confirm). Full pipeline detail lives in [`rag-design.md`](rag-design.md).

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
- **Audit:** the existing `document_imported` (filename + id only) covers audio; the
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

## Document tasks (Phases 33–35, wave-3 plan §6/§7/§8)
- **`services/doctasks.ts` — the shared task engine.** A job state machine on the Phase-4/18
  async-with-polling precedent: `startDocTask({ kind, documentIds, params }) → { jobId }`,
  `getDocTask(jobId) → { state, progress { stepsDone, stepsTotal }, error?, resultRef? }`,
  `cancelDocTask(jobId?)`. States: `queued → running → done | failed | cancelled`; unknown
  job ids report a terminal status so pollers always stop. All three kinds are implemented
  on the one machine: `summary` (Phase 33), `translation` (Phase 34), `compare` (Phase 35 —
  exactly TWO distinct source documents; the others take one). Deps are injected (`getDb`,
  `getRuntime`, `isChatStreaming`,
  `getContextTokens`, `getStoreDir`, `getIngestionDeps`, `beginDocumentWork`, `audit`), so
  the engine tests without Electron; `main/index.ts` wires it and exposes it as
  `AppContext.docTasks`.
- **Concurrency (D26, RESOLVED): strict one-at-a-time.** Tasks serialize among themselves
  (one FIFO queue, one runner). A task **refuses to start while a chat answer streams**
  (it reads the shared in-flight registry) but owns its own `AbortController` and is
  NEVER an entry in the per-conversation map — `stopGeneration` cannot kill a task and a
  task cannot block a conversation key (fact §2.8). The inverse guard lives in the
  chat/RAG handlers: a message sent while a task is active throws the shared
  `DOC_TASK_BUSY_MESSAGE`, which the chat screen renders with a "Cancel document task"
  button (`cancelDocTask()` with no jobId cancels the active task). The **R-T1 probe**
  (`tests/manual/server-concurrency-probe.test.ts`, `PAID_CONCURRENCY_PROBE`) showed the
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
- **IPC + UI:** `doctasks:start/get/cancel` (+ preload mirrors); `docs:export` saves a
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
    (spec §6 drive layout; `win`/`mac`/`linux` sub-dirs). A `PAID_LLAMA_BIN` env var overrides it for
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

### GPU acceleration: probe + start ladder (Phase 15, [`gpu-support-plan.md`](gpu-support-plan.md))

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
  unless `PAID_GPU_SMOKE` points at a provisioned drive**.
- **The Phase-16 surface** on top of the ladder: Settings' "Use GPU acceleration" toggle binds
  `gpuMode 'auto' | 'off'` (default ON). The Settings "Diagnostics (advanced)" tab shows the **Acceleration** line (live
  `RuntimeStatus.backend`/`gpuName` while running, else the persisted `settings.gpuProbe`), the
  **runtime build** line (`getRuntimeInstall` IPC `runtime:install` → the `.paid-runtime.json`
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

## Diagnostics & transcript export (audit round)
- `getRuntimeStatus` (read-only runtime health), `getLogTail` (tail of the local `app.log`), and
  `exportConversation` (spec §7.6 transcript export via the OS save dialog) round out spec §7.11/§7.6.
- A never-benchmarked workspace is benchmarked **automatically in the background** after it becomes
  usable (spec §2.1 first-run benchmark; `maybeRunFirstBenchmark`).

## Audit log (Phase 19, plan §7)

`services/audit.ts` finally writes the spec §8 `runtime_events` table (created in Phase 1,
unwritten until now): `recordEvent(db, type, message, metadata?)` (NEVER throws), a typed
`AuditEventType` union (`shared/types.ts`), `listAuditEvents` (newest-first, `beforeId`
cursor), and prune-on-insert retention to `AUDIT_MAX_ROWS = 5000`. The app-wide recorder
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

## Data flow (RAG, Phases 4–6)
import → extract text → chunk → embed (local) → store vectors → on question: embed query → cosine
top-k → build grounded prompt with `[S1]…` source labels → local LLM → answer with citations →
render snippets.

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
| `services/benchmark.ts` | 7.3 benchmarker |
| `services/policy.ts` | 7.10 privacy/offline |
| `services/logging.ts` | 7.11 diagnostics/logs |
| `services/audit.ts` | §8 `runtime_events`, 7.11 local-only activity record |
| `services/security/` + `services/workspace-vault.ts` | 3.5 encryption, 7.9 workspace modes |
| `services/drive.ts` + `services/assets.ts` | §6 drive layout, §12 packaging |
| `services/launcher.ts` + `services/preflight.ts` | §6 launchers, §11.4 first-run check |
| `services/commercial-drive.ts` | §12.2 sellable-drive gate, §13 license reviews |
