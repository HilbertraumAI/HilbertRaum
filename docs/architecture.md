# Architecture — HilbertRaum

_Last updated: 2026-06-15. Absorbs the GPU §1–§8, downloader, audit-log and depth-mode design records. Feature changes since: Phase 38 (scanned-PDF/photo OCR) and the whole-document-analysis wave (Phases 1–4 — deep index, coverage meter, structured extract, symmetric compare), whose design record is [`rag-design.md`](rag-design.md) §14._

## Overview

HilbertRaum is an **Electron** desktop app. It maps the spec's Tauri/Rust design onto
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
│  services/   (~35 modules — see Module ↔ spec map below)        │
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


## Skills — design record (Phases S2–S12, §1–§12)

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
  `prepare-drive` — never network-fetched. **Two** bundled app skills now ship, one per tier:
  **`bank-statement`** is the **Tier-2** reference (`kind: tool`, app-orchestrated tools through the
  §7 gate), and **`meeting-protocol`** is the **Tier-1** reference (`kind: instruction`,
  `allowedTools` empty / `reservesTools` false — it only injects fenced guidance). meeting-protocol
  is also the **bilingual-trigger** reference: its `triggers.keywords` carry German and English terms,
  with umlaut singular/plural pairs listed separately (`beschluss`/`beschlüsse`,
  `aufgabe`/`aufgaben`) because §6 matching is case-insensitive *substring* (`question.includes`), so
  an umlaut breaks the substring and each form must appear in its own right.

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
**inert until tapped** — never auto-applied (auto-fire is the deferred S13 wave).

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
for `kind:'tool'`) and uses the reconcile/validate body.

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
exported** (§9.5) — distinct from the non-secret skill packages.

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
  row at `started` forever.
- **CSV leading-whitespace formula injection.** `CSV_FORMULA_LEAD` now also neutralizes a formula
  trigger that hides behind leading whitespace (`"  =cmd"`) — some importers trim before evaluating —
  in addition to the leading-control-char and bare-`= + - @` cases.
- **Reconcile one-active-per-id (DS12 safety net).** `reconcileSkills` collapses the rare case where two
  AVAILABLE rows of one declared id end up both enabled (a DB rebuild, or an app skill shipped after a
  same-id user skill was enabled): it keeps the highest-precedence one (trust app > user → version →
  recency) and disables the rest. The enable IPC + import already enforced this on their paths; reconcile
  was the gap.

### §-anchor legend (historical plan citations)

The wave's two plan files were folded into this record (§1–§12) and `security-model.md`, but in-code
comments and the kept docs still cite the **original plan's** section numbers (`skills plan §N`,
`§22-*`). Those numbers were never renumbered into §1–§12; this legend keeps them **resolvable** (the
doc-lifecycle "stable anchors" intent) without churning ~130 comments. Read a historical `§N` as:

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
| §22-A1/A5/A6 | One skill-resolution path; stamp only when placed; fence pre-sized | §5 |
| §22-C2 | Selector reads triggers from the cache, never unpacks a blob | §6 |
| §22-C3/C4 | No FK into `skills` (app-level sweep); scope resolved main-side | §4 + §9 |
| §22-D1/D3 | Honesty posture (drop, don't invent); suggestion is an inert offer | §6 + §8 |
| §22-M1 | Content-class rule — ids/counts only; no content in log/audit/IPC | §2 (the consolidated sentinel guard) |
| §22-M2 | App-skill integrity by location, not signature (accepted residual) | §12 + security-model |
| §22-M4 | v1 permissions are a display summary; nothing executes | §1 (DS6) |


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
| `services/downloads.ts` + `services/runtime-download.ts` | in-app model + engine downloader (Phase 18) |
| `services/benchmark.ts` | 7.3 benchmarker |
| `services/policy.ts` | 7.10 privacy/offline |
| `services/logging.ts` | 7.11 diagnostics/logs |
| `services/audit.ts` | §8 `runtime_events`, 7.11 local-only activity record |
| `services/security/` + `services/workspace-vault.ts` | 3.5 encryption, 7.9 workspace modes |
| `services/drive.ts` + `services/assets.ts` | §6 drive layout, §12 packaging |
| `services/launcher.ts` + `services/preflight.ts` | §6 launchers, §11.4 first-run check |
| `services/commercial-drive.ts` | §12.2 sellable-drive gate, §13 license reviews |
