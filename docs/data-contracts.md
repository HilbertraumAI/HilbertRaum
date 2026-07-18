# Shared data contracts (the actual "transported data")

> Moved **verbatim** from `BUILD_STATE.md` §4 on 2026-07-12 — a pointer stub remains there,
> so existing "BUILD_STATE §4" citations still resolve. When a phase changes shared shapes,
> update the contracts **here** (per-phase ritual step 3, "update affected docs").

> Source of truth for cross-module/cross-phase types. Keep in sync with `apps/desktop/src/shared/`.
> Phases append/refine here so later phases know the exact shapes.

### IPC command surface (spec §9.1) — target
```ts
getAppStatus(): Promise<AppStatus>
getDriveStatus(): Promise<DriveStatus>
runBenchmark(): Promise<BenchmarkResult>
listModels(): Promise<ModelInfo[]>
selectModel(modelId: string): Promise<{ activeModelId; activeEmbeddingModelId }>
startRuntime(modelId: string): Promise<RuntimeStatus>
stopRuntime(): Promise<void>
createConversation(): Promise<Conversation>
sendChatMessage(conversationId, message, options): stream → events
askDocuments(conversationId, question): stream → events
importDocuments(paths: string[]): Promise<ImportJob>
getImportJob(jobId: string): Promise<ImportJobStatus>
listDocuments(): Promise<DocumentInfo[]>
deleteDocument(documentId: string): Promise<void>
getSettings(): Promise<AppSettings>
updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
```
_Status: TypeScript types in `apps/desktop/src/shared/types.ts`; channel names in `src/shared/ipc.ts`.
Wired so far: core (Phase 1) + `listModels`/`selectModel`/`startRuntime`/`stopRuntime` (Phase 2) +
`createConversation`/`listConversations`/`listMessages`/`sendChatMessage`/`stopGeneration` (Phase 3) +
`pickDocuments`/`importDocuments`/`getImportJob`/`listDocuments`/`deleteDocument`/`reindexDocument`
(Phase 4) + `askDocuments` (Phase 6) + `runBenchmark` (Phase 7) + `getPolicy` (Phase 8) +
`getWorkspaceState`/`unlockWorkspace`/`createWorkspace`/`lockWorkspace` (Phase 9) +
`runPreflight` (Phase 13) + `getRuntimeStatus`/`exportConversation`/`getLogTail` (audit round 4 —
spec §7.6 export + §7.11 Diagnostics) + `getRuntimeInstall` (`runtime:install`, Phase 16) +
`tryGpuAgain` (`gpu:try-again`, GPU audit round) + the `runtime:notice` main→renderer event
channel (Phase 15, `EVENTS.runtimeNotice`, preload `onRuntimeNotice`) +
`deleteConversation` (`chat:deleteConversation`), `verifyModel` (`models:verify`) and
`previewDocument` (`docs:preview`) from the post-MVP UX polish rounds +
`updateConversationScope` (`chat:updateScope`, Phase 17 — replace/clear a documents
conversation's "ask selected documents" scope) +
`downloadModel`/`getDownloadJob`/`cancelDownload` (`downloads:start/get/cancel`, Phase 18 —
the in-app model downloader, async-with-polling) +
`getAuditEvents(limit?, beforeId?)`/`exportAuditLog` (`audit:list`/`audit:export`, Phase 19 —
the Diagnostics Activity panel, newest-first paging + save-dialog export) +
`searchConversations` (`chat:search`, Phase 31) + `changeWorkspacePassword`
(`workspace:changePassword`, Phase 32) +
`startDocTask`/`getDocTask`/`cancelDocTask` (`doctasks:start/get/cancel`, Phases 33–35 —
document tasks, async-with-polling; `cancelDocTask()` with no jobId cancels the active task;
shapes `StartDocTaskRequest`/`DocTaskStatus`/`DocumentSummary` in `shared/types.ts`, and
`DocumentInfo` gained an optional `summary` from the additive `documents.summary_json` column;
Phase 34: `kind: 'translation'` takes `params.targetLang: TranslationTargetLang ('de'|'en')`,
`resultRef.documentId` = the NEW materialized document, and `DocumentInfo` gained an optional
`origin: DocumentOrigin` from the additive `documents.origin_json` column;
Phase 35: `kind: 'compare'` takes exactly TWO distinct `documentIds` and `DocumentOrigin` is
now a discriminated union — `{ type: 'translation', translatedFrom, targetLang }` |
`{ type: 'compare', comparedFrom: [a, b] }`; Phase-34 rows persisted without `type` parse as
`'translation'`, an additive migration;
issue #58 (2026-07-17): `DocTaskStatus` gained the ADDITIVE optional `gaps?: DocTaskGaps |
null` — a DONE translation's honest completeness accounting: `{ missingPageRanges: Array<{
from, to }>, failedWindows: number }`, set only when the output is incomplete (absent =
complete; other kinds never set it); `DocumentPreview` gained the additive optional
`pageCount?: number | null` — the parser's declared source page total (PDF; null/absent for
page-less formats), feeding that accounting) +
`exportDocument` (`docs:export`, Phase 34 — save-dialog export of a text document's stored
content, the `exportConversation` pattern; resolves with the path or null on cancel) +
`importPreflight` (`docs:importPreflight`, Phase 36 — read-only selection summary driving the
large-audio import confirm; `DocumentInfo` gained optional `transcriptionProgress`) +
`transcribeDictation(audio: Uint8Array): Promise<string>` (`dictation:transcribe`, Phase 37 —
voice dictation: 16 kHz mono WAV bytes in, plain text out; request/response, nothing persisted,
no audit; `AppStatus` gained the additive `dictationAvailable: boolean` gate).
Phase 38: `kind: 'ocr'` on the same doc-task channels (one PDF; the target must be
scan-detected or already OCR'd; needs the OCR engine, not the chat runtime);
`DocumentInfo` gained the DERIVED `scanDetected` flag + optional `ocr: DocumentOcrInfo`
(metadata of the additive `documents.ocr_json` column — the recognized text itself is
content and never leaves the DB); `AppStatus` gained the additive
`ocrAvailable: boolean` gate. The internal `OCR_RASTER` channels (shared/ipc.ts) bind
ONLY the hidden rasterizer window's preload, never the app bridge.
(`pickDocuments` + `reindexDocument` are Phase-4 additions to the `IPC` registry beyond the spec
§9.1 list — picker + re-index UX; `getPolicy` is a Phase-8 addition; the four `workspace:*` channels
are Phase-9 additions.) `createConversation` now also accepts an optional `mode`
('chat' | 'documents') and an optional `scopeDocumentIds` (Phase 17); `Conversation` carries
`scopeDocumentIds: string[] | null` (additive `conversations.scope_json` column, guarded
ALTER-TABLE migration in `db.ts`)._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helpers: `openDatabase(path)`, `listTables(db)`.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts; `seedSettings` seeds on first run. Default `allowNetwork:true`
(network is PERMITTED on a fresh install so model/engine downloads work — the policy ceiling still
wins; a commercial `policy.json` can force it back off), `workspaceMode:'plaintext_dev'`,
`contextTokens:4096`. **Phase 7 added `lastBenchmark`**
(JSON `BenchmarkResult | null`, default `null`) — the persisted hardware profile lives here.
**The post-MVP UX round added `autoStartActiveModel`** (boolean, default `true`) **and
`checksumCache`** (`Record<path, {size, mtimeMs, sha256}>`, default `{}` — the persisted L2 of
the weight-file hash cache).
⚠️ **Settings live INSIDE the (possibly encrypted) DB** — unreadable before unlock (Phase 9). The
unencrypted `config/workspace.json` vault descriptor is the only pre-unlock artifact;
`workspaceMode` is set to the active mode by the `WorkspaceController` on open.

### Workspace/paths
✅ `src/main/services/workspace.ts` — `resolvePaths({envRoot,fallbackRoot})` → `ResolvedPaths`
(rootPath, workspacePath, modelsPath, logsPath, configPath, dbPath, isPreparedDrive).
`ensureWorkspaceDirs`, `buildDriveStatus` (adds platform/arch/free/writable). See `docs/drive-layout.md`.

### Core IPC (Phase 1 live)
✅ `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings` registered in
`src/main/ipc/registerCoreIpc.ts`, invoked from `initBackend()` in `main/index.ts`.

### Models + runtime (Phase 2 live)
✅ **Manifest** schema/validator in `src/shared/manifest.ts` (`ModelManifest`, `validateManifest`,
`isRealSha256`). YAML files under `model-manifests/` (originally chat: Qwen3 4B/8B/14B Q4 + 30B-A3B
MoE + embeddings: E5 small F16 — five; 1.7B dropped, see §9). **The live catalog spans 6 role dirs**
(chat + E5 embeddings + bge-reranker + whisper transcriber + translategemma translation +
qwen2.5-vl vision, in `model-manifests/{chat,embeddings,reranker,transcriber,translation,vision}/`).
`model-policy.md` is the authoritative catalog and manifest count — this doc no longer restates a
hard total (the number drifted twice, see DOC-3/F-20).
✅ **`services/models.ts`** — `resolveManifestsDir`, `discoverManifests`, `sha256File`,
`verifyChecksum`, `computeInstallState`, `recommendModelId`, `buildModelList`, `selectModel`.
States: `unsupported→missing→checksum_failed→installed` (+`running` overlay). `ModelInfo` shape per
`shared/types.ts`. `local_path` resolved against the **drive root**.
✅ **`services/runtime/`** — `ModelRuntime` interface + `RuntimeManager` (single active runtime,
restart on switch) + `MockRuntime` (health ok; `chatStream` stubbed until Phase 3). Factory swap →
`LlamaRuntime` in Phase 10. `RuntimeStatus` shape per `shared/types.ts`.
✅ **IPC** `src/main/ipc/registerModelIpc.ts` — `listModels`, `selectModel`, `startRuntime`,
`stopRuntime`; wired in `initBackend()`. `ctx` now carries `runtime` + `manifestsDir`. Runtime stopped
on `will-quit`. Preload exposes all four. **Models screen** renders states/license/recommend/verify/
select/start-stop. Hardware profile now comes from the **persisted Phase-7 benchmark**
(`lastBenchmark?.profile ?? 'UNKNOWN'`); the old `LITE` stub is gone.

### Chat + streaming (Phase 3 live)
✅ **`services/chat.ts`** (spec §7.6) — `createConversation`, `listConversations`,
`getConversation`, `listMessages`, `appendMessage`, `deleteLastAssistantMessage`,
`maybeSetTitleFromFirstMessage`, `buildSystemPrompt` (verbatim spec §7.6 base prompt, exported as
`BASE_SYSTEM_PROMPT`), `buildChatMessages`, and the streaming orchestrator
`generateAssistantMessage(db, runtime, conversationId, { signal, onToken })`. UUID v4 ids,
ISO-8601 UTC timestamps. **Message order = `created_at ASC, rowid ASC`** (rowid breaks
equal-ms ties → stable turn order). **System prompt is built per request, NOT persisted**; the
`messages` table holds only user/assistant turns. `Conversation`/`Message` shapes per
`shared/types.ts`. `messages.citations_json` stays null until Phase 6.
✅ **Title:** new conversations are `"New chat"`; first user message sets the title (≤60 chars),
later messages don't overwrite it. Conversations list newest-updated first.
(Phase 42: the default is persist-canonical English — `t('en', 'main.chat.defaultTitle')`,
value unchanged — and display-mapped to the UI language at render, D-L4.)

### Streaming contract (LOCKED — Phase 3; one ADDITIVE channel in Phase 20)
Main → renderer over per-conversation IPC event channels keyed by the **conversation id**
(one active stream per conversation): `chat:token:<id>` (one token/event) / `chat:done:<id>`
(final assistant `Message`) / `chat:error:<id>` (error string). Helpers in `src/shared/ipc.ts`
`STREAM`. Preload exposes `onToken/onDone/onError(requestId, cb) → unsubscribe`. In addition,
`sendChatMessage(conversationId, content, options?)` resolves with the final assistant `Message`,
so callers can simply `await` it; the event channels drive incremental UI.
**Phase 20 (additive):** `chat:reasoning:<id>` (preload `onReasoning`) carries Deep-mode
thinking deltas; token events still carry ONLY answer text. Reasoning is never persisted and
never replayed (D6) — see "Answer-depth modes" below.
**Cancellation:** `ipc/registerChatIpc.ts` keeps a per-conversation `AbortController` map;
`stopGeneration(conversationId)` aborts it → `chatStream` stops on `options.signal`, the partial
reply is persisted, a normal `done` fires.
**Mid-stream runtime failure (audit 2026-07-16 F-02, additive — channel shape unchanged):** an
in-band SSE error frame from the runtime rejects the stream (`ChatStreamError`) instead of
ending it cleanly, so a partial can never persist as a complete answer; it reaches the renderer
on `chat:error:<id>` as the friendly localized `main.chat.streamError` copy (still an error
string). The structural server reason goes to the local log only — never to the renderer.
**Regenerate:** `sendChatMessage` with `options.regenerate = true` deletes the last assistant
message and re-streams from existing history (no new user turn).
**Decision (documented):** `sendChatMessage` does **not** auto-start a runtime — a chat needs a
model explicitly started on the Models screen. No active runtime → handler throws; Chat screen
shows a "start a model" empty state linking to Models. (Heavy llama.cpp start in Phase 10 stays an
explicit user action; keeps the boundary clean.)
✅ **`MockRuntime.chatStream`** now emits a deterministic reply token-by-token (12 ms/token) that
echoes the last user message, honouring `options.signal` for prompt cancellation. **Chat screen**
(`renderer/screens/ChatScreen.tsx`): conversation list, streamed transcript with a live cursor,
stop, regenerate, per-message copy, and the no-runtime empty state.

### Answer-depth modes (Phase 20 live)
✅ `ChatOptions.mode` (`'fast' | 'balanced' | 'deep'` = `ChatDepthMode`) is **read** now:
per message over IPC (enum-guarded in `registerChatIpc`), sticky per conversation in the
renderer for the session (NOT persisted — no schema change). Threads
`generateAssistantMessage` → `RuntimeChatOptions.mode`; the single mapping site is
`runtime/llama.ts` `requestParamsForMode` (D4): fast = thinking off + temp 0.7 + 1024-token
cap · balanced/omitted = thinking off, server defaults · deep = thinking on + temp 0.6.
Explicit `maxTokens`/`temperature` win over mode-derived values.
✅ **Thinking switch (D5):** per-request `chat_template_kwargs: { enable_thinking }` on
`/v1/chat/completions`, ALWAYS sent explicitly (the runtime default is thinking ON for capable
templates — verified on b9585, expected on the b9849 pin). Chat sidecars spawn with **`CHAT_SERVER_ARGS` = `--jinja --reasoning-format
deepseek`** (pins the mechanism's preconditions; embedder excluded). Reasoning streams as
separate `delta.reasoning_content` frames → `RuntimeChatOptions.onReasoning(delta)` →
`chat:reasoning:<id>`; the generator yields answer text only.
✅ **D6:** `stripThinkBlocks` (services/chat.ts) scrubs `<think>…</think>` (incl. an unclosed
trailing block) from persisted assistant content (chat + grounded) and from assistant turns
replayed as history. The collapsed live "Thinking…" block in the streaming bubble is the only
reasoning surface, and it disappears once the persisted reply lands.
✅ **Deep gating:** manifest `supports_thinking_mode` → `ModelManifest.supportsThinkingMode`
(optional boolean, default false) → `RuntimeStatus.supportsThinkingMode` (enriched by the
`getRuntimeStatus` handler for the running model only) → the composer offers Deep only when
true (stale Deep choices coerce to Balanced at send). `askDocuments` never passes a mode —
document answers always run balanced (deep-grounded = wave 2).

### Document ingestion (Phase 4 live)
✅ **`services/ingestion/`** (spec §7.7). Full detail in [`docs/rag-design.md`](docs/rag-design.md).
- **`parsers/`** — `DocumentParser` interface (`{ segments: ExtractedSegment[], mimeType }`) +
  registry (`selectParser`, `supportedExtensions`). Adapters: `TxtParser` (.txt/.text/.log),
  `MarkdownParser` (.md/.markdown/.mdown; segment per ATX heading, `sectionLabel`), `PdfParser`
  (.pdf; pdfjs-dist **legacy** build, no worker; segment per page, `pageNumber`), `DocxParser`
  (.docx; mammoth raw text; segment per paragraph), `CsvParser` (.csv/.tsv; papaparse; rows →
  `header: value` lines). Pure-JS, **lazy-imported** inside `parse()`.
  **Phase 36 additions:** `AudioParser` (.wav/.mp3/.flac/.ogg — the R-W2-verified list; packs
  whisper segments into ≤400-word `ExtractedSegment`s labeled `sectionLabel: "mm:ss–mm:ss"`),
  and `parse(filePath, ctx?)` gained an ADDITIVE optional `ParseContext`
  (`{ transcriber?, onProgress?, workDir? }`) — text parsers ignore it. `IngestionDeps` gained
  optional `transcriber` + `onTranscribeProgress(documentId, percent)` (the embedder-injection
  precedent); `isAudioPath()` + `summarizeImportPaths()` exported for the IPC layer.
- **`chunker.ts`** — `chunkSegments(segments, opts?)` → `DocumentChunk[]`. `CHUNK_DEFAULTS =
  { chunkSizeTokens: 500, chunkOverlapTokens: 80, maxChunks: 1000 }`. **Token counting is an
  approximation** (1 whitespace word ≈ 1 token; `tokenize`/`approxTokenCount`). Windows step by
  `size − overlap`, overlap clamped `< size`, no chunk crosses a segment boundary (so each chunk
  has exactly one `pageNumber`/`sectionLabel`), global cap at `maxChunks`.
- **`index.ts`** — lifecycle + persistence. `createQueuedDocument`, `processDocument` (never
  throws: failures → `failed` + `error_message`), `reindexDocument`, `listDocuments`,
  `getDocument`, `deleteDocument`, `expandPaths`, `documentsDir`. Statuses
  `queued→extracting→chunking→embedding→indexed` (+`failed`/`deleted`); **`embedding` is a
  pass-through** until Phase 5 (no vectors written yet).
- **DB:** `documents` (status, `original_path`, `stored_path`, `sha256`, `mime_type`,
  `size_bytes`) + `chunks` (`chunk_index`, `text`, `source_label` = document title,
  `page_number`, `section_label`, `token_count`). `chunkCount` is computed per `listDocuments`.
- **Types:** `DocumentInfo`, `ImportJob`, `ImportJobStatus`, `IngestionStatus` (already in
  `shared/types.ts`) filled to match.

### Document storage + import model (LOCKED — Phase 4)
- **Stored copy.** Imports are **copied into `workspace/documents/<id><ext>`** (`stored_path`);
  `original_path` is also kept. Self-contained drive: re-index re-parses the stored copy; delete
  removes the stored copy + chunks + embeddings + row (never the original).
- **Async-with-polling.** `importDocuments(paths)` expands the selection, inserts `queued` rows,
  returns `{ jobId, documentIds }`, then ingests **sequentially in the background**. The
  `documents` table is the per-file source of truth (survives restart); the `ImportJobStatus`
  aggregate is **in-memory** in `registerDocsIpc.ts`, read via `getImportJob(jobId)` (unknown job
  → `done:true` so pollers stop). The **Documents screen** polls `getImportJob` + `listDocuments`
  every 400 ms while a job runs. No streaming channel is used (ingestion progress is coarse).
- **Picker.** `pickDocuments('files' | 'folder')` opens the OS dialog in **main**
  (renderer has no dialog access); Windows can't mix file+dir selection, hence the mode.
- **Documents screen** (`renderer/screens/DocumentsScreen.tsx`): import files/folder, per-file
  status badge + chunk count + size, error surfacing, delete + re-index.

### Embeddings + vector search (Phase 5 live)
✅ **`services/embeddings/`** (spec §6, §7.8, §9.2). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §6.
- **`index.ts`** — `Embedder` interface (`id`, `dimensions`, `embed(texts) =>
  Promise<Float32Array[]>` — L2-normalized, one per input); `encodeVector`/`decodeVector`
  (Float32 ↔ BLOB; decode copies to a 4-byte-aligned buffer); `cosineSimilarity`; and the
  `VectorIndex` class (`search(queryVector, topK)` linear-scan cosine → `{ chunkId, score }[]`
  sorted desc, dimension-mismatched rows skipped; `searchText(query, topK)` embeds then searches).
- **`mock.ts`** — `MockEmbedder` (`createMockEmbedder`): deterministic feature-hashing vectors
  (SHA-256 tokens → signed buckets → L2-normalize), zero network. `MOCK_EMBEDDING_DIMENSIONS =
  384`, `MOCK_EMBEDDING_MODEL_ID = 'mock-embedder'`.
- **Ingestion wiring:** `processDocument`/`reindexDocument` accept `IngestionDeps
  { embedder?, embeddingModelId? }`; the `embedding` step embeds all chunks in one batch and
  inserts `embeddings` rows. `registerDocsIpc` passes `ctx.embedder` +
  `getSettings(db).activeEmbeddingModelId`. **`AppContext` now carries `embedder`** (created in
  `main/index.ts`).
- **`embeddings` table** (spec §8, already existed): `chunk_id` PK, `embedding_model_id`,
  `vector_blob` (raw Float32 bytes), `dimensions`, `created_at`. No new IPC (askDocuments = Phase 6).

### RAG chat with citations (Phase 6 live)
✅ **`services/rag/index.ts`** (spec §7.6, §7.8). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §8.
- **`retrieve(db, embedder, question, settings)`** → `{ chunks: RetrievedChunk[], citations:
  Citation[] }`. Embeds the question, `VectorIndex.searchText(topKInitial)`, joins hits →
  `chunks`, drops `< minSimilarity`, **dedups by `(document_id, page_number)`** (page-less
  chunks keyed by chunk id), trims to `topKFinal` under `maxContextTokens` (chunker's
  `approxTokenCount`; top chunk always kept), assigns `[S1]…` labels **per query (not
  stored)**.
- **`buildGroundedPrompt(question, chunks)`** — pure; spec §7.8 template verbatim (rules +
  `Question:` + numbered `Document excerpts:` as `[Sn] File: X | Page: 4` / `| Section: Y` +
  quoted text + trailing `Answer:`). `buildGroundedChatMessages` replaces the **last user
  turn** with the grounded prompt; system stays `BASE_SYSTEM_PROMPT`.
- **`generateGroundedAnswer(...)`** — streams via the runtime and persists the assistant turn
  **with `Citation[]`** (→ `citations_json`). **Empty corpus / weak retrieval → runtime NOT
  called**; persists `NO_DOCUMENT_CONTEXT_ANSWER`, no citations.
- **`ipc/registerRagIpc.ts`** — `askDocuments(conversationId, question)`; **reuses the locked
  Phase-3 streaming contract** (`chat:token/done/error:<id>`) + the **shared in-flight
  registry** (`ipc/inflight.ts`) so `stopGeneration` cancels it. Requires a running runtime
  (same error as chat). Registered in `initBackend()`.
- **Settings:** `ragTopKInitial`/`ragTopKFinal`/`ragMaxContextTokens`/`ragMinSimilarity` on
  `AppSettings` + `DEFAULT_SETTINGS` (spec §7.8 defaults), read via `ragSettingsFrom`.
- **`Citation`** gained optional `snippet` (truncated chunk text, ≤ 600). **Renderer**:
  `ChatScreen` Chat/Ask-Documents toggle (mode is per-conversation), `askDocuments` path, and
  a per-message **Sources** panel with expandable cited snippets.
- **Phase 21 (hybrid + rerank — see the §3 entry / `docs/rag-design.md` §11):** `retrieve()`
  gained a keyword pass (`rag/hybrid.ts` over the trigger-synced `chunks_fts` FTS5 table) fused
  by RRF (k=60), and an optional trailing `reranker?: Reranker | null` param (also on
  `GroundedAnswerOptions.reranker`) that reorders candidates between fusion and dedup. Absent
  reranker + no keyword hits ⇒ byte-identical to the Phase-6 pipeline. `RetrievedChunk.score`
  is stage-dependent (cosine / RRF / rerank logit); `minSimilarity` stays a PRE-rerank cosine
  floor; citations still persist NO scores. `Reranker` lives in `services/reranker/`
  (`AppContext.reranker`, availability-selected, null default). `Embedder`/`Reranker` gained
  optional **`suspend()`** — the workspace-lock teardown that allows a lazy restart (`stop()`
  stays permanent for will-quit).

### Hardware benchmark + recommendation (Phase 7 live)
✅ **`services/benchmark.ts`** (spec §7.3, §11). Full detail in [`docs/benchmark.md`](docs/benchmark.md).
- **`detectSystem()`** (`node:os`) → `{ os, arch, cpuModel, cpuCores, ramGb, gpu }`; never
  throws (failed probe → `''`/`0`); `detectSystem` itself always reports `gpu: null` — the
  REAL probe lives in `runtime/gpu.ts` and is **injected** by the IPC layer (Phase 16:
  `RunBenchmarkDeps.gpu: { name, useful }`), keeping this module `child_process`-free.
- **`classifyProfile(ramGb, { tokensPerSecond?, gpuUseful? })`** — pure; spec §11.3
  thresholds + the conservative Phase-16 GPU bump (`gpuUseful` is precomputed by
  `gpuUsefulForProfile`: ≥ 6144 MiB AND not integrated) + low-tok/sec downgrade; invalid
  RAM → `UNKNOWN`.
- **`measureDriveSpeed(workspacePath)`** → `{ readMbps, writeMbps, error? }`; 8 MB temp file
  written **inside the workspace**, timed write(`fsync`)+read, **always cleaned up**, failure
  → `null` + `error`. `writeMbps` is the honest headline; `readMbps` is **page-cached** (RAM speed,
  not the drive — audit 2026-07-16 F-35), shown labelled "(cached)" and NOT used for the slow-drive
  gate. See `docs/benchmark.md`.
- **`measureTokensPerSecond(runtime)`** → number | `null` (only when a runtime is active;
  prompt + ≤64 tokens). Mock now, real in Phase 10.
- **`buildWarnings(...)`** — spec §11.4 friendly copy (weak hardware / slow drive /
  un-measurable drive); slow drive warns, never blocks.
- **`runBenchmark(deps)`** → `BenchmarkResult` (the existing `shared/types.ts` shape):
  detection + drive + optional tokens/sec + `classifyProfile` + `recommendModelId` + warnings.
- **`ipc/registerBenchmarkIpc.ts`** — `runBenchmark()` (`benchmark:run`); runs it, persists to
  `settings.lastBenchmark`, returns the result. Registered in `initBackend()`; exposed on
  preload `api.runBenchmark` + `PreloadApi`.
- **Renderer:** `DiagnosticsScreen` Run-benchmark button → RAM / CPU / OS-arch / drive
  read-write / tokens-sec / profile / recommended model + warnings; re-loads `lastBenchmark`
  on mount. `HomeScreen` profile reflects the persisted value via `getAppStatus`.

### Privacy & offline policy (Phase 8 live)
✅ **`services/policy.ts`** (spec §3.5/§3.6/§6). Pure + resilient; never throws.
- **Types** (in `shared/types.ts`): `PrivacyPolicy` (`network`/`workspace`/`models`),
  `NetworkPolicy`/`WorkspacePolicy`/`ModelsPolicy`, `PolicyStatus`. `DEFAULT_POLICY` lives in
  `policy.ts` (main-only).
- **`parsePolicy(contents, onWarn?)`** → `PrivacyPolicy` merged over `DEFAULT_POLICY`; malformed JSON
  → defaults + warn. **`mergePolicyObject(base, raw)`** maps snake_case JSON → camelCase, taking a
  field only when it is a real boolean. **`loadPolicy(configDir, onWarn?)`** → `{ policy,
  policyFilePresent, driveFilePresent, allowNetworkByDefault }` (reads optional `policy.json` +
  `drive.json`).
- **`resolveNetwork(policy, allowNetworkSetting)`** → `{ networkAllowedByPolicy, networkAllowed,
  offlineMode }` (effective = policy ∧ setting). **`buildPolicyStatus(configDir, allowNetworkSetting,
  onWarn?)`** → `PolicyStatus` (the `getPolicy()` IPC shape; `telemetryAllowed` hardcoded false).
✅ **`services/offlineGuard.ts`** — `isLoopbackHost(host)` (127.0.0.0/8, ::1, localhost exempt),
  `checkOutboundHost(host, offline)` → `{ host, violation }`, `installOfflineNetworkGuard({ offline,
  onViolation })` (wraps `net.Socket.prototype.connect`, logs remote attempts, **never blocks**,
  returns an uninstaller; no-op when not offline), `assertOfflinePosture({ posture, installGuard,
  log, warn })` (startup self-check; logs posture, installs the guard in ALL builds when offline).
✅ **IPC** `registerCoreIpc.ts`: `getPolicy` (`policy:get`) returns `buildPolicyStatus(...)`;
  `getAppStatus.offlineMode`/`networkAllowed` now come from the policy resolution. Preload exposes
  `api.getPolicy` + `PreloadApi`. `main/index.ts` calls `assertOfflinePosture()` in `initBackend()`
  and applies the dev/prod CSP response header in `createWindow()`.
✅ **Renderer:** `PrivacyScreen.tsx` (spec §7.10/§18.1 copy) replaces the placeholder — offline
  statement, "where your data lives" (`getDriveStatus`), live network state (off by default /
  disabled by policy), plaintext-dev-mode caveat, logs-local guarantee. Sidebar `offline-badge` is a
  live button (reads `getPolicy`, links to Privacy).

### Encrypted workspace (Phase 9 live)
✅ **`services/security/crypto.ts`** (spec §3.5) — pure KDF + AEAD, no I/O.
- **KDF:** `deriveKey(password, salt, params)` → 32-byte key. `KdfParams` is per-algo
  (`argon2id: m/t/p` · `scrypt: N/r/p`); `DEFAULT_KDF = { argon2id, m=19456, t=2, p=1, keyLen=32 }`
  for NEW vaults, `SCRYPT_KDF = { scrypt, N=32768, r=8, p=1 }` still unlocks legacy vaults (see the
  §3 KDF decision). `generateSalt()` → 16 random bytes. Deterministic for the same
  password+salt+params.
- **AEAD:** `encrypt(key, plaintext) → { iv(12), tag(16), ciphertext }` (AES-256-GCM, fresh IV),
  `decrypt(key, blob)` (throws on wrong key/tamper). `serializeBlob`/`deserializeBlob`
  (`MAGIC(8)|iv|tag|ct` on-disk frame). `makeVerifier(key)`/`verifyKey(key, verifier)` (password
  check via a known-plaintext GCM blob — never touches the DB).
✅ **`services/workspace-vault.ts`** (spec §7.9) — the lock/unlock lifecycle.
- **Descriptor:** `VaultDescriptor { version, mode:'encrypted', kdf, saltB64, verifier }` at
  **`config/workspace.json`** (unencrypted; the only pre-unlock artifact).
  `readVaultDescriptor`/`writeVaultDescriptor` (atomic). `vaultPathsFrom({configPath,dbPath})` →
  `VaultPaths { descriptorPath, encPath = <dbPath>.enc, dbPath }`.
- **File crypto + hygiene:** `encryptFile`/`decryptFile` (atomic temp+rename), `shredFile`
  (overwrite-random + unlink, best-effort), `cleanSidecars` (shred `-wal`/`-shm`).
- **Lifecycle:** `createEncryptedVaultOnDisk(vaultPaths, password, kdf?)` (writes descriptor + seeds
  an initial DB + encrypts → `.enc` + shreds, leaving it LOCKED); `unlockEncryptedVault(vaultPaths,
  password) → { db, key, descriptor }` (verify → decrypt → open; throws **`WrongPasswordError`**);
  `lockEncryptedVault(vaultPaths, db, key)` (checkpoint+close → re-encrypt → shred).
  `plaintextAllowed(policy, {isDev, developerMode})` gates plaintext (now **enforced**).
- **`WorkspaceController`** (stateful, on `AppContext`): `init()` (startup: plaintext opens
  immediately, encrypted stays locked, else uninitialized), `getState() → WorkspaceStateInfo`,
  `requireDb()` (throws while locked), `isUnlocked()`, `unlock(password)`, `create(password, mode)`,
  `lock()` (no-op for plaintext).
✅ **IPC** `ipc/registerWorkspaceIpc.ts` — `getWorkspaceState` (`workspace:getState`) →
  `WorkspaceStateInfo`; `unlockWorkspace(password)` / `createWorkspace(password, mode)` →
  **`WorkspaceActionResult`** (`{ok:true,state}` | `{ok:false, reason:'wrong_password'|'refused'|
  'error', message}` — a wrong password / policy refusal is a normal result, not a throw);
  `lockWorkspace` → `WorkspaceStateInfo`. Registered in `initBackend()`; exposed on preload `api` +
  `PreloadApi`.
- **Types** (`shared/types.ts`): `WorkspaceStateName` (`uninitialized|locked|unlocked`),
  `WorkspaceStateInfo { state, mode, plaintextAllowed, encryptionRequired }`, `WorkspaceActionResult`.
✅ **`AppContext.db` is now a getter** over `workspace.requireDb()` (throws while locked) +
  `AppContext.workspace: WorkspaceController`. `main/index.ts` builds the controller from
  `loadPolicy(...).policy` + `isDev`, calls `init()`, and locks on `will-quit`. `registerCoreIpc`'s
  `getAppStatus` now derives `workspaceReady = workspace.isUnlocked()` and `workspaceMode` from the
  controller (reads settings only when unlocked); `getPolicy`/status default `allowNetwork=false`
  while locked (offline ceiling stays intact pre-unlock).
✅ **Renderer:** `screens/WorkspaceGate.tsx` — the pre-app create-password / unlock gate (encrypted
  vs plaintext choice when policy allows, confirm + strength hint, wrong-password error). `App.tsx`
  fetches `getWorkspaceState()` on mount and renders the gate until `unlocked`; sidebar **Lock now**
  button (encrypted only) calls `lockWorkspace`. The Settings workspace card reflects the real mode.

### Real runtime + embedder (Phase 10 live)
✅ **`services/runtime/sidecar.ts`** — discovery + `LlamaServer` lifecycle.
- `resolveLlamaServerPath(rootPath, platform, env)` → binary path | null (`runtime/llama.cpp/<os>/`,
  `HILBERTRAUM_LLAMA_BIN` override); `llamaServerDir`/`llamaServerBinaryName`/`llamaOsDir`; `findFreePort()`;
  `defaultThreadCount()`; `LOOPBACK_HOST = '127.0.0.1'`.
- **`LlamaServer`** owns one child process: `start()` (spawn `--host 127.0.0.1 --port <random> --model
  --ctx-size --threads` + `extraArgs`, then poll `/health` with a **timeout** → throw on crash/timeout),
  `health() → HealthStatus`, `fetch(path, init)` (loopback), `stop()` (kill **and wait for exit**).
  Test seams: injectable `spawn` / `fetchImpl` / `findPort` (+ `ChildProcessLike`/`SpawnFn`/`FetchFn`).
✅ **`services/runtime/llama.ts`** — `LlamaRuntime implements ModelRuntime` (composes `LlamaServer`);
  `chatStream` → OpenAI-compatible `/v1/chat/completions` (`stream:true`, role/content, `max_tokens`/
  `temperature`), `readChatSSE(body, signal)` exported (SSE delta parser). `createLlamaRuntime(opts, deps)`.
✅ **`services/runtime/factory.ts`** — `createSelectingRuntimeFactory({ rootPath, resolveBin?,
  modelExists?, makeLlama?, makeMock?, onSelect? }) → RuntimeFactory` (real iff binary + weights present,
  per `start()`; else mock). Used by `RuntimeManager` in `main/index.ts`.
✅ **`services/embeddings/e5.ts`** — `E5Embedder implements Embedder` (id = manifest id, 384 dims,
  L2-normalized; lazy `llama-server --embedding --pooling mean` sidecar; additive `stop()`).
  `createE5Embedder(opts)`. **`Embedder` gained optional `stop?(): Promise<void>`** (mock omits it).
✅ **`services/embeddings/factory.ts`** — `createSelectedEmbedder({ rootPath, model, … }) → Embedder`
  (real `E5Embedder` iff binary + E5 weights present; else `MockEmbedder`). `EmbeddingModelInfo {
  id, modelPath, dimensions?, contextTokens? }`.
✅ **`VectorIndex`** — optional 3rd ctor arg `{ embeddingModelId? }`: a non-empty id scopes the cosine
  scan to `WHERE embedding_model_id = ?` (mismatch guard); default scans all rows. **`rag.retrieve`**
  passes `{ embeddingModelId: embedder.id }`.
✅ **`main/index.ts`** — builds the selecting runtime factory + selected embedder; `resolveEmbeddingModel`
  reads the embeddings manifest pre-unlock; `will-quit` now also calls `ctx.embedder.stop?.()`.
  **R5: live inference is manual** (binaries + GGUF not in repo); everything else is tested with a mocked
  child process / mocked loopback `fetch`.

### Drive layout, scripts & packaging (Phase 11 live)
✅ **`services/drive.ts`** — the canonical, unit-tested reference for drive prep (the scripts mirror it):
- `DRIVE_OS_DIRS = ['win','mac','linux']`, `DRIVE_LAYOUT_DIRS` (workspace, models/{chat,embeddings},
  model-manifests, runtime/llama.cpp/{win,mac,linux}, logs, config, docs), `driveLayoutDirs(root)`.
- `buildDriveJson(opts) → DriveJson` (the `config/drive.json` marker, spec §6 shape);
  `buildPolicyJson({dev?}) → PolicyJson` (snake_case; network always denied; commercial vs dev posture).
- `verifyDriveModels(root, manifests) → ModelVerifyResult[]` (status `verified|unverified_placeholder|
  mismatch|missing|unsupported`, reusing `models.ts` `verifyChecksum`/`isRealSha256`);
  `buildChecksumsJson(root, manifests) → ChecksumsJson` (generate-mode capture of present-weight hashes).
- `planPrepareDrive(root, manifests, opts) → PreparePlan` (dirs + config files + manifest copies +
  weight destinations + `configWouldOverwrite`) + `formatPlan` (the dry-run report).
✅ **`scripts/`** (repo root, self-contained; no Node/npm needed to prep a drive):
- `prepare-drive.{ps1,sh}` — `-Target`/`--target` (required), `-DryRun`/`--dry-run`, `-Force`/`--force`,
  `-Dev`/`--dev`. Creates the layout, copies `model-manifests/` + user docs onto the drive, writes
  `config/{drive,policy}.json`. Idempotent; config only (re)written with `--force`.
- `verify-models.{ps1,sh}` — `-Target`/`--target`, `-Generate`/`--generate`. Flat-YAML line-parses the
  manifests, SHA-256s present weights, prints `VERIFIED/UNVERIFIED/MISMATCH/MISSING/UNSUPPORTED`,
  **exit 1 on a real-hash mismatch**; `--generate` writes `config/checksums.json`.
- `setup-dev.{ps1,sh}` — `NODE_OPTIONS=--use-system-ca npm install` (R6) + build + test smoke.
✅ **Packaging** — `apps/desktop/electron-builder.yml` (portable Windows + mac/linux parity;
  `model-manifests/` as `extraResources`; asar; Electron ≥37). `npm run package` / `package:win`
  (root + workspace). New dev dep **`electron-builder ^26.15.2`**. Output → `apps/desktop/release/`
  (git-ignored, added to `.gitignore` alongside the existing `models/`/`*.gguf`/`/runtime/` ignores).
✅ **Docs** — `docs/user-guide.md` (non-technical §17 path) + `docs/troubleshooting.md` (§18) added;
  `docs/packaging.md` + `docs/drive-layout.md` extended (portable build, the scripts, win/mac/linux
  reconciliation). prepare-drive copies user-guide/troubleshooting + `PRIVACY.md` onto the drive.

### Provisioning / asset loader (Phase 12 live)
✅ **Schema** — `shared/manifest.ts` `DownloadSpec` + optional `ModelManifest.download` (validated only
  when present; real `download.sha256` must equal a real top-level `sha256`). `shared/runtime-sources.ts`
  `RuntimeBuild`/`RuntimeSources` + `validateRuntimeSources` (mirror `validateManifest`). The committed
  model manifests (the original six, incl. the later 14B/30B-A3B) carry real upstream URLs + placeholder hashes.
  **(Updated since Phase 12 — see `model-policy.md` for the live catalog and its authoritative
  manifest count (this doc no longer restates a hard total — it drifted twice, see DOC-3/F-20): the
  catalog spans 6 role dirs (chat + E5 + bge-reranker + whisper transcriber + translategemma
  translation + qwen2.5-vl vision), and `runtime-sources.yaml` is pinned to the REAL
  `ggml-org/llama.cpp@b9849` release (bumped from b9585 for the Qwen3.5 gate) with real URLs +
  SHA-256, plus `whisper_cpp:`/`ocr:`
  asset blocks — the original "b9196 placeholder / one CPU build per OS" text below is the Phase-12
  as-built snapshot.)** The Phase-12 snapshot: `runtime-sources.yaml` referenced
  `ggml-org/llama.cpp@b9196` as a PLACEHOLDER, one CPU build per OS.
  `models.ts` `RESERVED_MANIFEST_FILES` excludes `runtime-sources.yaml` from model discovery.
✅ **`services/assets.ts`** — the canonical, unit-tested asset logic (mirrors `drive.ts`; NO real network):
- `planModelDownloads(root, manifests, {only?, acceptLicense?}) → ModelDownloadTask[]` — only manifests
  with a `download` block; reads fs to mark `present-verified`/`present-unverified`/`download`/
  `license-blocked` (license gate ∧ `acceptLicense`); reuses `weightPath`/`verifyChecksum`.
- `selectRuntimeBuild(sources, {os, arch, backend?}) → RuntimeBuild | null` (default = first os/arch
  match = the CPU build) · `planRuntimeDownload(root, build, version) → {url, zipDest, extractTo,
  binaryPath, sha256, ...}` (escape-guarded) · `runtimeBinaryName(os)`.
- `verifyDownloadedFile(path, expected) → {ok, actual, reason}` (placeholder/missing/mismatch are NOT a
  pass) · `downloadToFile(url, dest, {fetchImpl?, onProgress?})` + `fetchAndVerify(task, deps)` (injected
  fetch; mismatch deletes the partial + throws) · `formatAssetPlan(modelTasks, runtimePlan)`.
✅ **`scripts/`** (self-contained, dual `.ps1`/`.sh`, OS-native downloader; `.ps1` pure ASCII):
- `fetch-models.{ps1,sh}` — `-Target`/`--target` (req), `-Only`/`--only`, `-AcceptLicense`/
  `--accept-license`, `-DryRun`/`--dry-run`. Per `download`-block manifest: download (resume via
  `curl -C -`/`aria2c`) → SHA-256-verify vs the manifest → mismatch deletes partial + **exit 1**;
  placeholder → *UNVERIFIED*; present+verified → skip. License gate before the first fetch.
- `fetch-runtime.{ps1,sh}` — `-Target`/`--target` (req), `-Os/-Arch/-Backend` overrides, `-DryRun`.
  Reads `runtime-sources.yaml`, picks the host build (default CPU), downloads + verifies the zip,
  `Expand-Archive`/`unzip`/`ditto` into `runtime/llama.cpp/<os>/`, `chmod +x` on mac/linux. Idempotent.
- `prepare-drive.{ps1,sh}` gained `-WithAssets`/`--with-assets` (+ forwards `-AcceptLicense`): after the
  layout, runs `fetch-models` + `fetch-runtime` so one command yields a launch-ready drive. Without the
  flag, behaviour is unchanged. Then points the user at `verify-models --generate`.
  - **Fast-setup default (2026-06):** `-WithAssets` fetches a small but complete **default set** —
    `ministral3-8b-instruct-2512-q4` (chat) + `multilingual-e5-small-q8` (embeddings) +
    `bge-reranker-v2-m3-f16` (reranker) + `whisper-small-multilingual` (transcriber), each via
    `fetch-models --only` (looped, since `--only` takes one id) — **plus both sidecar runtimes**:
    `fetch-runtime` (llama.cpp, default family) AND `fetch-runtime --family whisper_cpp`. Not all ~11
    models; the user pulls the rest (larger chat models) from the app on demand. `-AllModels`/`--all-models` restores fetch-everything
    (one `fetch-models` call, no `--only`); the runtimes are fetched either way. The default id list is
    a `$DefaultModelIds`/`DEFAULT_MODEL_IDS` constant at the top of each script (keep in sync with
    `model-manifests/`). The whisper.cpp runtime fetch is **best-effort**: prebuilt binaries are
    Windows-only, so on a mac/linux host the "no build" miss is a warning, not a failure (those drives
    build whisper.cpp from source). The commercial build (`build-commercial-drive`) calls `fetch-models`
    directly, so it still pre-loads every model — unaffected.
✅ **In-app downloader (the provisioning plan's deferred item)** — ~~deferred~~ **shipped in Phase 18** (see the contract
  section below). **Real downloads + USB-drive launch = manual (R5).**

### In-app model downloader (Phase 18 live)
✅ **Types** (`shared/types.ts`): `DownloadJobStatus = 'queued'|'downloading'|'verifying'|'done'|
  'failed'|'cancelled'`; `DownloadJob { jobId, modelId, status, receivedBytes, totalBytes,
  unverified, error }` (`unverified` = placeholder-hash download, the model stays UNVERIFIED);
  `ModelInfo.download?: ModelDownloadInfo { url, sizeBytes, licenseUrl, licenseApproved }`.
✅ **`services/downloads.ts`** — `DownloadGates { policyAllows, settingAllows }`,
  `assertDownloadAllowed(gates)` (friendly, cause-specific refusals: policy vs. Settings),
  `partPath(dest)`, `DownloadManager({ fetchImpl?, log? })` with `start({rootPath, manifest,
  gates, licenseAccepted?, hashStore?}) → Promise<DownloadJob>`, `get(jobId)`, `cancel(jobId)`
  (keeps the `.part`), `activeJob()`. One live job at a time; `.part` → verify → rename;
  mismatch deletes the partial; success invalidates the checksum-cache entry. A COMPLETE `.part`
  (cancel/crash during verify, failed rename) is verified in place rather than Range-resumed —
  match renames, mismatch discards + clean restart (F-13, full-audit 2026-07-16).
✅ **`assets.ts` seam (additive):** `DownloadDeps += { signal?, headers?, append?, onResponse? }`,
  `downloadToFile → DownloadToFileResult { status, received, contentLength }` (append only on a
  real 206); `PlanModelOptions += { hashStore? }` (present multi-GB weights are not re-hashed).
✅ **IPC** `ipc/registerDownloadIpc.ts` — `downloadModel(modelId, {licenseAccepted?})`,
  `getDownloadJob(jobId)`, `cancelDownload(jobId)`; gates re-read per call (policy from disk,
  setting from the possibly-locked DB ⇒ off). Preload exposes all three. **Renderer:**
  ModelsScreen Download button (missing/checksum_failed models with a manifest `download`
  block), gate explanations, the confirmation modal (size/license/URL + license-ack checkbox),
  progress + cancel via 1 s polling; SettingsScreen hint updated.

### Audit log (Phase 19 live)
✅ **Types** (`shared/types.ts`): `AuditEventType` (the enum in `types.ts` is the authoritative
  list — hard counts drifted before, see DOC-3/F-20; covers runtime/model/document-task/export/
  collection/skill/workspace events + the four EP-1 evidence-review literals, below);
  `AuditEvent { id, type, message, metadata: Record<string,unknown> | null, createdAt }`.
✅ **`services/audit.ts`** — `AUDIT_MAX_ROWS = 5000`, `recordEvent(db, type, message, metadata?,
  createdAt?)` (never throws; prunes on insert), `pruneAuditEvents(db, maxRows?)`,
  `listAuditEvents(db, { limit?, beforeId? })` (newest-first; unknown cursor reads from the top),
  `createAuditRecorder(getDb) → AuditRecorder` (locked-vault memory buffer, bounded 100,
  flush-in-order with original timestamps). **`AppContext.audit?: AuditRecorder`** — optional, so
  partial test contexts stay valid; every call site is `ctx.audit?.(…)`.
✅ **`services/downloads.ts` seam (additive):** `DownloadManagerDeps.audit?` (`DownloadAuditType` =
  the three `model_download_*` values) — injected by `registerDownloadIpc` in production.
✅ **`services/offlineGuard.ts` seam (additive):** `AssertOfflinePostureDeps.onViolation?(host)`.
✅ **IPC** `ipc/registerAuditIpc.ts` — `getAuditEvents`, `exportAuditLog` (JSON, save-dialog
  pattern). **Renderer:** Diagnostics Activity card (on-demand, type filter, paging, export).
⚠️ The privacy rule (ids/filenames/counts, never content) is a CONTRACT for every future call
  site — extend the sentinel test when adding events.

### Plug-and-play distribution (Phase 13 live)
✅ **`services/launcher.ts`** — `resolveDriveRootFromLauncher(launcherPath, flavor?: 'win32'|'posix'|
  'auto')` → the drive root (the launcher's own directory; pure path math, no fs). Handles Windows
  drive-letter + POSIX/macOS paths; throws on empty/relative. **No hardcoded path** — the canonical
  reference the launcher scripts mirror.
✅ **`launchers/`** (repo templates copied to the drive root by the pipeline) — `Start
  HilbertRaum.cmd` (`%~dp0` → set `HILBERTRAUM_DRIVE_ROOT` → spawn `HilbertRaum-*-portable.exe`), `Start
  HilbertRaum.command` (macOS, exec the `.app` binary with the env exported), `start-hilbertraum.sh`
  (Linux, next to the AppImage), `READ ME FIRST.txt` (friendly first-run + SmartScreen/
  Gatekeeper "Run anyway" copy).
✅ **`services/preflight.ts`** — `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) →
  PreflightResult { rootPath, writable, freeBytes, slowDriveWarning, problems[] }` (spec §11.4 tone;
  non-blocking). Reuses `buildDriveStatus` + `measureDriveSpeed`/`buildWarnings`. `LOW_FREE_SPACE_BYTES
  = 2 GB`. `PreflightResult` lives in `shared/types.ts`. IPC `runPreflight` (`preflight:run`) in
  `registerCoreIpc` → preload `api.runPreflight`; **HomeScreen** shows a non-blocking note.
✅ **`services/commercial-drive.ts`** — `planCommercialDrive({ target, os?, acceptLicense? }) →
  CommercialStep[] { id, title, command, manual, description }` (ordered: prepare → fetch-models →
  fetch-runtime → **package [manual]** → copy-app → verify → assert) + `formatPlan`; and
  `assertCommercialDrive(rootPath, manifests) → CommercialAssertion { ok, problems[], checks{
  policyCommercial, networkDenied, weightsVerified, noUserData }, modelResults }` (reuses `loadPolicy`
  + `verifyDriveModels`; flags network-allowed / plaintext / unverified-or-mismatch weights / present
  user data — `workspace/hilbertraum.sqlite[.enc]`, `config/workspace.json`, non-empty `workspace/documents/`).
✅ **`scripts/build-commercial-drive.{ps1,sh}`** — self-contained dual-shell master pipeline mirroring
  the plan; `-Target`/`--target` (req), `-AcceptLicense`/`--accept-license`, `-AppArtifact`/
  `--app-artifact` (a pre-built signed app to copy), `-SkipPackage`/`--skip-package`, `-DryRun`/
  `--dry-run`. Orchestrates prepare-drive (`-Force`) → fetch-models → fetch-runtime → (package =
  manual) → copy launchers+docs → verify-models `--generate` → native posture cross-check (exit 1 if
  not sellable). PS uses **hashtable** splatting for named params. Both dry-run-smoke-tested.
✅ **Packaging/signing** — `electron-builder.yml` `win.signtoolOptions` + `mac.notarize`/
  `hardenedRuntime`/`gatekeeperAssess:false`/`entitlements: build/entitlements.mac.plist`; secrets are
  env-driven + git-ignored. The green gate does NOT sign (it never runs electron-builder).
✅ **Tests** — `tests/integration/launcher.test.ts` (11: `resolveDriveRootFromLauncher` Win/POSIX/auto/
  empty/relative; `runPreflight` ok/slow/read-only/low-space/unmeasurable with an injected speed fn) +
  `tests/integration/commercial-drive.test.ts` (8: ordered plan + manual package + `--accept-license`
  threading + `formatPlan`; `assertCommercialDrive` passes verified-commercial, fails network/plaintext/
  placeholder-weight/user-data). **Signing + notarization + the real USB launch = manual (R5/R7).**

### Evidence Pack / Review Mode (EP-1 Phases 0–6 live — contracts, storage, snapshot engine + IPC, review UI, HTML + PDF export, freshness, selections)
Source of truth while the wave is open: `docs/evidence-pack-implementation-plan.md` §5–§11 (this
section records the AS-BUILT shapes; P5 was renderer/i18n-only — no shared-shape changes;
only the wave close-out remains open).

✅ **`Citation` enrichment (ADDITIVE, `shared/types.ts`):** `documentId?: string | null`
  (`chunks.document_id`) + `chunkId?: string | null` (`chunks.id`), stamped at the **six**
  citation constructors that existed when this landed (enumerated deliberately — a FUTURE
  constructor must add the stamp itself, nothing enforces it globally):
  (1) relevance retrieval, (2) `retrieveWholeDocument`, (3) chunk map-reduce reps
  (`answerWholeDocFromChunks`), (4) compare-diff (`buildDiffResult`) — all `rag/index.ts`;
  (5) deep-index leaf provenance (`documentLeafProvenance`, `analysis/coverage.ts`, reached
  via `whole-doc-tree.ts`); (6) the skill-analysis projection (`chunksToCitations`,
  `skills/analysis/common.ts` — behind the bank/invoice deterministic answers persisted via
  `rag:ask`; `loadCitationChunks` now SELECTs `id`, `chunksToCitations` takes the
  `documentId`). Each site is pinned by a test. `isCitation` (`chat.ts`) validates the fields
  tolerantly: **rows persisted before EP-1 parse byte-identically** (fields absent, never
  null-filled); a mistyped value rejects that element only, exactly like the existing
  optional fields. Purpose: post-EP-1 answers pin source identity exactly; legacy answers
  resolve best-effort by title with an honest `identity: 'unresolved'` state (plan §1.2).
✅ **Tables (`db.ts` SCHEMA, idempotent `IF NOT EXISTS`):** `evidence_reviews` (head + frozen
  `answer_snapshot`/`question_snapshot` TEXT + nullable JSON snapshot columns
  `source_snapshot_json`/`coverage_snapshot_json`/`generation_snapshot_json`; FK `message_id →
  messages(id) ON DELETE CASCADE` — the `result_tables` template, so the REAL
  `deleteConversation` drops the whole chain) → `evidence_review_items` (FK → reviews CASCADE;
  `kind` 'block'|'selection', `block_key`, nullable `block_kind`
  'paragraph'|'list_item'|'heading'|'fence'|'table'|'blockquote' — **beyond spec §18.1**, added
  so the D-7 heading exemption is exact without re-segmenting; NULL = required), →
  `evidence_review_links` (FK → items CASCADE; `link_origin` 'answer_marker'|'reviewer',
  nullable `reviewer_relation`) and `evidence_exports` (FK → reviews CASCADE; D-8 metadata +
  hash only — `file_name` is the bare name, the destination path is NEVER persisted). Indexes
  on each FK column. One ACTIVE review per message = **service-enforced** (deliberately no
  UNIQUE constraint). All tables inherit encrypted-at-rest (same workspace DB). `status`
  stores ONLY `'draft'|'ready'`; **`outdated` is derived, never stored** (spec §18.4 — it can
  never erase ready; the Phase-4 engine computes it on demand — see the Phase-4 block below).
  Phase 4 added ONE additive nullable column: `evidence_reviews.freshness_ack_json` (JSON
  `{ acknowledgedAt, fingerprint }` via `ensureColumn` — the acknowledged-drift record;
  malformed → reads as never-acknowledged, the safe direction).
✅ **Types (`shared/types.ts`):** `ReviewDecision`
  ('supported'|'partly_supported'|'not_supported'|'follow_up'|'not_reviewed'|'not_applicable'),
  `EvidenceReviewStatus` ('draft'|'ready'), `AnswerBlockKind`, `EvidenceSourceSnapshot`
  (spec §18.2 **plus** `identity: 'resolved'|'unresolved'` — the plan-§1.2 honest legacy
  state; `availabilityAtCreation` is nullable and reported only for resolved identities),
  `EvidenceGenerationSnapshot` (spec §18.3 but **every field optional** per plan §1.3 — absent
  renders "Unavailable", never invented), `EvidenceLink`, `EvidenceReviewItem`,
  `EvidenceReadyGate`, `EvidenceReview`, `EvidenceReviewSummary`, `EvidenceReviewDetail`,
  `EvidenceExportFormat` ('html'|'pdf' — the write-side type; `EvidenceExportRecord.format`
  reads as the RAW stored string, see the service bullet), `EvidenceExportRecord`;
  IPC patch/input shapes `EvidenceReviewPatch`, `EvidenceReviewItemPatch`,
  `EvidenceSelectionInput` (UTF-16 offsets into the parent block's `textSnapshot`, exclusive
  end — spec Risk 7; boundaries must not split a surrogate pair, misaligned offsets are
  REFUSED never clamped — F-15), `EvidenceLinkInput`.
✅ **Service (`main/services/evidence-reviews.ts`):** storage CRUD + tolerant row→DTO parsing
  (the `parseCitations` idiom per JSON column; `coverage_snapshot_json` reuses chat.ts's
  now-exported `parseCoverage`). Safe defaults always point AWAY from unearned confidence:
  unknown decision → 'not_reviewed', unknown status → 'draft', unknown link origin →
  'reviewer', unknown source kind → 'whole_document_provenance', unknown identity →
  'unresolved'; malformed JSON → `[]`/null, never a throw. The one deliberate NON-default:
  `evidence_exports.format` passes through RAW on read (writes are typed 'html'|'pdf') — a
  repair-default here would point TOWARD a positive claim about what was exported, so it has
  none. Exports: `createEvidenceReview` (reads `conversation_id` from the message row — never
  trusted from the caller; throws on unknown message / existing review / a title that trims
  empty — the D-6 "never unnamed" invariant holds from birth, stored title is the trimmed
  form; ids-only messages), `getEvidenceReview`, `getEvidenceReviewForMessage`,
  `countEvidenceReviewsForConversation` (the D-2 confirm count), `updateEvidenceReview`,
  `markEvidenceReviewReady` (refuses + returns the gate while ineligible),
  `reopenEvidenceReview`, `deleteEvidenceReview`, `createEvidenceReviewItems` (batch, one
  transaction), `updateEvidenceReviewItem` (patched decisions are normalized ON WRITE — an
  unknown literal never enters storage; a note-only patch leaves the stored decision
  byte-identical), `createEvidenceSelection` (refuses out-of-range AND surrogate-splitting
  offsets — never clamps; F-15), `deleteEvidenceSelection` (selections only — block items are
  structural), `setEvidenceLink` (upsert per (item, key); refuses unknown source keys),
  `removeEvidenceLink`, `recordEvidenceExport`, `listEvidenceExports`, and the pure
  `deriveReadyGate` (D-7: required = non-heading block items, NULL `blockKind` counts as
  required; 'not_applicable' counts as decided; selections never gate).
✅ **Audit literals (types only — no emitter until Phase 1):** `evidence_review_created`,
  `evidence_review_ready`, `evidence_review_deleted`, `evidence_pack_exported`. Metadata
  contract: ids/counts ONLY — never titles, notes, reviewer labels, snippets, or paths.
  (The exhaustive Diagnostics label record forced the matching `diag.audit.*` EN/DE keys to
  land now; behaviorally inert until an event exists.)
✅ **Tests:** `tests/unit/evidence-review-gate.test.ts` (D-7 matrix + pure snapshot parsers) +
  `tests/integration/evidence-reviews.test.ts` (schema on fresh/reopened DBs via `listTables`;
  full round-trip incl. Unicode/markdown/hostile strings; malformed-JSON tolerance; cascade
  through the REAL `deleteConversation`; service-level status derivation; citation enrichment
  pinned at sites 1–5 incl. byte-identical legacy parsing) + the EP-1 enrichment leg in
  `tests/unit/citation-snippet-boundary.test.ts` (site 6, `chunksToCitations`).

**Phase 1 — snapshot engine + IPC surface (as built):**

✅ **Shared marker source (`shared/citation-markers.ts`):** `CITE_CODE_SPLIT_RE` +
  `CITE_MARKER_RE` MOVED here from `renderer/lib/displayMap.ts` (which now imports them —
  same values, zero behavior change) + `extractCitationMarkerOffsets(text) →
  { label, index }[]` (every PROSE marker with its absolute offset, whole-text pass) and
  `extractCitationMarkers(text) → string[]` (deduplicated labels, first-appearance order).
  One regex source AND one pass shape for both the display rewrite and the evidence-review
  marker extraction (plan §6.2 + review FIX-3: the prose/code split must run over the WHOLE
  text on both sides — a code region can span block boundaries); parity is pinned against
  the real `localizeServerCopy` in `tests/unit/evidence-segment.test.ts`, incl. two
  boundary-spanning repros asserted two-sided (display literal ⇒ no marker; display
  citation ⇒ marker).
✅ **Segmenter (`main/services/evidence-pack/segment.ts`, pure):** `segmentAnswerBlocks(md) →
  AnswerBlock[] { blockKey, blockKind, ordinal, text, markers }`. Deterministic line scanner
  (NOT a markdown parser; rules documented in the module header + pinned by the zoo tests):
  fences (```/~~~, unclosed swallows to EOF), single-line ATX headings, `>`-run blockquotes,
  ≥2-pipe-line tables (kept as ONE unit), top-level list items with nested children attached,
  paragraphs; blank line ends any non-fence block; CRLF normalized. `blockKey =
  `b{ordinal}-{kind}-{sha256/12(text)}`` — stable against the SNAPSHOT (spec Risk 7), unique
  within an answer (ordinal keeps identical text distinct). Empty answer → zero blocks.
  Block `markers` are NOT extracted per block: ONE whole-snapshot offset pass
  (`extractCitationMarkerOffsets`) is assigned to blocks by range (FIX-3), so a block's
  markers are byte-derivable from what the chat UI renders as citation vs literal code.
✅ **Snapshot builder (`main/services/evidence-pack/snapshot.ts`):**
  `createEvidenceReviewFromMessage(db, messageId, deps { appVersion?, modelDisplayName? }) →
  EvidenceReviewDetail` — the complete draft from persisted rows ONLY (no model, no network,
  no re-retrieval; deps injected so the module stays electron-free). Source resolution:
  `Citation.documentId` pins identity (row gone ⇒ `identity:'resolved'` +
  `availabilityAtCreation:'missing'` — a deleted source is NOT "unresolved"); legacy
  citations resolve by EXACT title match only when UNIQUE (0 or >1 ⇒ `identity:'unresolved'`,
  availability null — never guessed). `kind` from `coverage.mode` (`relevance`→
  `direct_excerpt`, `tree|capped`→`whole_document_provenance`, `extract`→`structured_record`;
  NO stamp → `direct_excerpt` — the pre-D72 relevance fallback the renderer already uses,
  `answerMode:'unknown'` still recorded; a PRESENT-but-unrecognized mode — a workspace from
  a NEWER app, `parseCoverage` accepts any string — maps to the WEAKEST claim
  `whole_document_provenance`, no labels, ZERO auto-links, and the switch is compile-time
  exhaustive so a new `CoverageMode` member reds the build — review FIX-1). `machineLabel`
  only on direct excerpts (provenance labels are never citation markers — M2); source `key` =
  citation label (uniquified defensively). Items: one block item per segment, `block_kind`
  persisted on EVERY item, headings default `decision:'not_applicable'`. Auto-links:
  direct-excerpt answers only, marker→label, `origin:'answer_marker'`; whole-doc/extract/
  unknown-mode answers get ZERO (spec §13.3 hard rule, tested with a literal `[S1]` in a
  tree answer). Creation is ONE transaction around head + items + links (review FIX-2:
  all-or-nothing vs thrown errors AND process crash; the swallowed-rollback nesting keeps
  the original failure as the thrown error; `insertEvidenceReviewItems` is the exported
  NON-transactional core `createEvidenceReviewItems` wraps — SQLite refuses nested BEGIN);
  links still write AFTER sources+items inside the txn (`setEvidenceLink` validates keys).
  Also exports `sourceKindForMode`, `buildEvidenceSourceSnapshots`. `parseCitations` is now
  exported from `chat.ts` (the `parseCoverage` precedent — same tolerant validator).
✅ **Eligibility rule (`shared/evidence-review.ts`):** pure `isReviewEligible(message,
  conversation?)` (spec §9.1): assistant ∧ (citations non-empty ∨ coverage present ∨
  `conversation.mode === 'documents'`). "Persisted and not streaming" stays the caller's
  gate (a streaming reply has no row yet) — Phase 2 wires it.
✅ **IPC surface (17 channels, `evidence:*` in `shared/ipc.ts`; handlers in
  `main/ipc/registerEvidenceReviewsIpc.ts`, wired in `main/index.ts`; preload methods of the
  same names on `window.api` — 13 shipped in Phase 1, `evidence:countForConversation` added
  in Phase 2 for the D-2 delete confirm, `evidence:export` added in Phase 3 with its
  pipeline, `evidence:acknowledgeFreshness` + `evidence:sourceContext` added in Phase 4):**
  | preload method | channel | shape |
  |---|---|---|
  | `createEvidenceReview(messageId)` | `evidence:create` | → `EvidenceReviewDetail`; IDEMPOTENT (existing review returned, audit only on real creation); throws localized `invalidRequest` on a malformed id, ids-only errors on unknown/non-assistant message |
  | `getEvidenceReview(reviewId)` | `evidence:get` | → `EvidenceReviewDetail \| null` |
  | `getEvidenceReviewForMessage(messageId)` | `evidence:getForMessage` | → `EvidenceReviewSummary \| null` (entry-point state) |
  | `updateEvidenceReview(reviewId, patch)` | `evidence:update` | → `EvidenceReview \| null`; malformed patch fields DROPPED, never coerced |
  | `updateEvidenceReviewItem(itemId, patch)` | `evidence:updateItem` | → `EvidenceReviewItem \| null`; unknown decision literals dropped (stored decision untouched) |
  | `createEvidenceSelection(reviewId, input)` | `evidence:createSelection` | → `EvidenceReviewItem \| null` (null = refused offsets — never clamped) |
  | `deleteEvidenceSelection(itemId)` | `evidence:deleteSelection` | → `boolean` (blocks refuse) |
  | `setEvidenceLink(itemId, key, input)` | `evidence:setLink` | → `EvidenceReviewItem \| null`; **origin FORCED to `'reviewer'`** — only the snapshot builder mints `'answer_marker'` (a renderer payload can never fake "cited by the answer") |
  | `removeEvidenceLink(itemId, key)` | `evidence:removeLink` | → `boolean` |
  | `markEvidenceReviewReady(reviewId)` | `evidence:markReady` | → `{ review, gate } \| null` (refuses + gate says why while ineligible; an ALREADY-ready review is a NO-OP — original `completed_at` kept, no second audit event; the service returns an additional `becameReady` flag the handler audits on and STRIPS from the wire — review FIX-5) |
  | `reopenEvidenceReview(reviewId)` | `evidence:reopen` | → `EvidenceReview \| null` |
  | `refreshEvidenceReviewState(reviewId)` | `evidence:refreshState` | → `EvidenceReviewFreshness \| null` — **REAL since Phase 4** (spec §21.2): snapshot vs workspace from STORED facts only — document existence by snapshotted id, stored `documents.sha256` vs snapshot hash (**never re-hashed**), `messages.content` vs `answer_snapshot` (exact), coverage semantic-fields compare. Unresolved identities report `'unverifiable'`, NEVER `'changed'`. No model, no network, no file I/O |
  | `acknowledgeEvidenceReviewFreshness(reviewId)` | `evidence:acknowledgeFreshness` | → `EvidenceReviewFreshness \| null` — Phase 4 (spec §15.5/§28.6): persists `{acknowledgedAt, fingerprint}` into `freshness_ack_json`; the fingerprint canonicalizes the CURRENT drift so a LATER change lapses the acknowledge. NO-OP on a non-outdated review (nothing written). Writes ONLY its own column — status/completed_at/updated_at untouched (§18.4), NOT subject to the ready-state write-guard (lifecycle metadata, not a decision edit). No audit event (not a spec-§22 type) |
  | `getEvidenceSourceContext(reviewId, sourceKey)` | `evidence:sourceContext` | → `EvidenceSourceContext \| null` — Phase 4 (D-5, spec §10.2.4): the STORED extracted text (`chunks` table — never a source-file read) around one source's persisted excerpt, resolved from the review's OWN snapshot (`documentId` never crosses the wire from the renderer). Ladder: snapshotted `sourceChunkId` (verified to belong to the snapshotted document — a foreign chunk id never leaks another document's text) → stored-text containment search (`instr`) → honest `located:false`. Context = located chunk ± one neighbor, ≤1200 chars/side, surrogate-safe boundaries. Null on unknown review/key and on unresolved-identity sources |
  | `deleteEvidenceReview(reviewId)` | `evidence:delete` | → `boolean` |
  | `countEvidenceReviewsForConversation(conversationId)` | `evidence:countForConversation` | → `number` — Phase 2 (plan §7.6, D-2): the conversation-delete confirm names how many reviews the cascade removes. Count only, never content; malformed/unknown ids read `0` |
  | `exportEvidencePack(reviewId, options)` | `evidence:export` | → `EvidenceExportRecord \| null` — Phase 3 (plan §8.3): save dialog → deterministic HTML render → ATOMIC write (tmp sibling → fsync → sha256 of the ON-DISK bytes → rename) → `evidence_exports` row. Null on unknown/malformed id (no dialog) or user cancel; any failure UP TO the rename leaves no destination file and no row (spec §28.9). A POST-rename record failure (workspace-DB error, or the review deleted in another window while the dialog was open) UNLINKS the just-written file and REJECTS with distinct localized copy (`main.evidenceReviews.exportNotRecorded`; if even the unlink fails, `…exportFileNotRecorded` states the file exists WITHOUT a history record) — null never means "exported", and a real export is never reported as a cancel (fix round FIX-1). Works on draft AND ready reviews (the ready guard covers item mutations only — tested). `options: EvidencePackExportRequest` (= `Partial<EvidencePackOptions> & {format?}`) resolves against `EVIDENCE_PACK_OPTION_DEFAULTS` main-side; the RESOLVED option set persists to `options_json` (the format NEVER does — `evidence_exports.format` is its column). **P6 (plan §11): PDF over the SAME channel** — `format: 'pdf'` (literal only; anything else reads 'html') prints the SAME rendered HTML through the hidden-window harness AFTER the dialog; the save dialog OFFERS both filters (requested first) and the chosen extension has the final word (`packFormatForDestination`: `.pdf`⇒pdf, `.html`/`.htm`⇒html, else the request — file content, extension and recorded format always agree). A failed/killed print = a pre-rename failure: no file, no row |
  Every handler `requireUnlocked()` (`main.evidenceReviews.locked`, EN+DE; auto-enforced by
  `ipc-lock-coverage.test.ts`). **Ready-state write guard (Phase-2 review FIX-1, spec
  §18.4):** while a review is `ready`, the five ITEM-LEVEL mutations (`updateEvidenceReviewItem`,
  `setEvidenceLink`, `removeEvidenceLink`, `createEvidenceSelection`, `deleteEvidenceSelection`)
  REFUSE through their normal null/false channel — `ready` + undecided is a state the D-7 gate
  can never produce, so it must be unreachable by mutation too; reopen first. HEAD edits
  (`updateEvidenceReview`: title D-6 / reviewer label D-3 / general note) stay allowed.
  Type `EvidenceReviewFreshness` shipped in P1 as `{ reviewId, outdated }` and was widened
  ADDITIVELY in P4 (all new fields optional on the wire — see the Phase-4 block).
✅ **Audit emitters:** `evidence_review_created` (`{reviewId, messageId,
  conversationId, itemCount, sourceCount, autoLinkCount}`), `evidence_review_ready`
  (`{reviewId, requiredTotal, decidedTotal}`), `evidence_review_deleted` (`{reviewId}`),
  and — Phase 3 — `evidence_pack_exported` (`{reviewId, format}` **only**: the destination
  path, the bare file name and the review title, which seeds the suggested name, are content
  and never audited) — ids/counts ONLY; review titles/labels/notes/answer text/source titles
  AND the export path are sentinel-swept through the REAL handlers in `audit-ipc.test.ts`.
✅ **i18n:** `main.evidenceReviews.locked` + `main.evidenceReviews.invalidRequest` (emission
  set) and persist-canonical `main.evidenceReviews.defaultTitle` ('Evidence review' — the
  fallback written to `evidence_reviews.title` when a conversation title trims empty; in
  `DISPLAY_MAP_KEYS` like `main.chat.defaultTitle`). All EN+DE.
✅ **Phase-1 tests:** `tests/unit/evidence-segment.test.ts` (markdown zoo, stable keys,
  marker parity against the real display rewrite incl. the two boundary-spanning repros
  two-sided — FIX-3) + `tests/integration/evidence-snapshot.test.ts` (per-answer-class
  builds: relevance auto-links, whole-doc/extract ZERO links, unknown-present-mode weakest
  class — FIX-1, legacy no-citation, unresolved-title, deleted-source, empty answer,
  default-title fallback, determinism, end-to-end display-parity links, and the FIX-2
  atomicity leg: an injected SQLite-trigger failure mid-build rolls back all four tables and
  surfaces the original error) + `tests/integration/evidence-reviews-ipc.test.ts` (full
  round trips over the mocked-electron harness for all four answer classes incl. a
  documentId-resolved source and a real selection deletion, payload guards, reviewer-origin
  forcing, freshness stub, idempotent create, markReady already-ready no-op — FIX-5,
  **runtime-tripwire + real offline connect-guard asserted in every test of the file** —
  the plan §6 no-model/no-network assertions) + new legs in `audit-ipc.test.ts` and
  `ipc-lock-coverage.test.ts`.

**Phase 3 — evidence-pack export, self-contained HTML (as built):**

✅ **Types (`shared/types.ts`):** `EvidencePackLanguage` ('en'|'de' — the pack's content
  language, chosen at export and FROZEN into the file; never re-localized later) and
  `EvidencePackOptions { language, includeReviewerNotes, includeSourceExcerpts,
  includeDocumentHashes, includeUnreviewedItems, includeTechnicalDetails }` (spec §16.2).
  Defaults live in `EVIDENCE_PACK_OPTION_DEFAULTS` (`shared/evidence-review.ts`): everything
  §16.1-mandated ON, `includeTechnicalDetails` OFF. **There is NO source-path flag**: the
  review snapshot carries no file paths, so no pack can ever contain one — structurally
  stronger than the spec's "default off" (recorded in known-limitations + security-model).
  `evidencePaneMode(coverage)` MOVED from `renderer/review/EvidencePane.tsx` to
  `shared/evidence-review.ts` (re-exported from the old site; semantics unchanged) so the
  pack's coverage-honesty section reuses the ONE mapping (unknown-PRESENT modes stay
  whole-doc/WEAK).
✅ **Pack model (`main/services/evidence-pack/pack-model.ts`, pure):**
  `resolveEvidencePackOptions(raw)` (untrusted-boundary resolver — literal booleans only,
  unknown keys dropped, language 'de' only on the literal) and
  `buildEvidencePackModel(detail, options, {packId, generatedAt}) → EvidencePackModel` —
  the nine §16.1 sections normalized from the STORED review read-model only: cover, Q&A
  (frozen snapshots), review summary (fixed-order decision counts, `lastExportedAt` =
  newest PRIOR export), item-by-item (links resolve to 1-based register indexes; option
  filters honest — hidden unreviewed items are COUNTED, their register relations kept),
  evidence + source registers, coverage/limitations (creation-time facts + an explicit
  not-re-verified statement — the freshness engine is P4), generation (absent → null →
  "Unavailable"), integrity. `EVIDENCE_PACK_SCHEMA_VERSION = 1` stamps the pack AND the
  `evidence_exports.schema_version` column.
✅ **HTML renderer (`main/services/evidence-pack/render-html.ts`, pure):** new `escapeHtml`
  (the docx `xmlEscape` shape widened to quotes — `& < > " '`; every content string escaped
  exactly once, AFTER i18n interpolation) + `renderEvidencePackHtml(model)` — ONE fixed
  self-contained template: zero scripts, zero remote refs (no `url()`/`@import`/
  `@font-face`/`http(s)`), one embedded `<style>`, index-derived internal anchors only
  (`#src-N`, `#item-N`). **Print contract (D-1 — Phase 6 feeds THIS SAME HTML to
  `printToPDF`):** `@page { size: A4 }`, `break-inside: avoid` on item/source cards +
  warnings + table rows, semantic `h1→h2→h3` hierarchy (= the PDF bookmark tree), system
  font stack only, grayscale-readable warning blocks (border + ⚠ + text). Answer/item text
  renders as ESCAPED plain text (`white-space: pre-wrap`) — deliberately NO main-side
  markdown-to-HTML conversion (injection surface + determinism risk); the pack says so.
  Inline `[S{n}]` markers localize per pack language via the SHARED citation-marker regexes
  (DE `[Q{n}]`; code spans/fences stay literal — display parity). Timestamps render through
  `formatPackTimestamp` (`YYYY-MM-DD HH:MM UTC` — locale-independent; unparseable →
  verbatim). i18n: `packExport.*` EN+DE + reused `review.*`/`chat.sources.marker` keys.
  Determinism: same detail + options + language ⇒ byte-identical except packId/generatedAt.
✅ **Export pipeline (`main/services/evidence-pack/export.ts`):**
  `exportEvidencePackToFile(db, reviewId, rawOptions, deps {chooseDestination, renderPdf,
  newPackId?, now?})` — load → resolve format+options → build → render → dialog (injected;
  the electron dialog lives at the IPC layer; `chooseDestination(suggestedFileName, format)`)
  → [PDF only, P6: `renderPdf(html, {packId, sourceHtmlPath})` — the injected hidden-window
  print, AFTER the dialog, fed the render output VERBATIM] → `writePackFileAtomic` (tmp
  sibling → fsync → hash the READ-BACK on-disk bytes → rename; accepts string OR Buffer —
  the SAME tail serves both formats; failure removes the tmp and rethrows — no half-written
  destination ever) → `recordEvidenceExport` (row only AFTER the final file exists + is
  hashed, spec §20.3; bare `file_name`, the EFFECTIVE format, resolved options into
  `options_json`). `renderPdf` is REQUIRED (a missing printer can never silently degrade a
  PDF request); the transient print source is `${dest}.print.tmp.html` — a SIBLING in the
  user-sanctioned directory (never an OS temp dir), removed by the harness in `finally`.
  Encoding (string content): UTF-8 **without** BOM (unlike md/txt/csv `bomFor` — the
  `<meta charset>` is the contract; recorded hash = on-disk bytes).
  `suggestedPackFileName(title, format)` slugs the review title (content — which is why
  path/name never reach audit) + the format's extension.
✅ **PDF print harness (P6, `main/services/evidence-pack/print-pdf.ts` — plan §11/D-1):**
  `printEvidencePackHtmlToPdf(html, {packId, sourceHtmlPath})` → PDF `Buffer`. Dedicated
  hidden `BrowserWindow` per print — `SECURE_WINDOW_WEB_PREFERENCES` spread (sandboxed),
  **no preload at all** (no IPC surface; wiring-pinned in `window-security.test.ts`),
  window-open + will-navigate/will-redirect ALL denied; writes the source html sibling,
  `loadFile` (= did-finish-load) → `document.fonts.ready` → `printToPDF` with the FULL
  D-1 option set (verified supported by the installed Electron 37 types): `pageSize:'A4'`,
  `preferCSSPageSize` (the template's `@page` is authoritative), `printBackground`,
  `displayHeaderFooter` + empty-span `headerTemplate` (suppresses Chromium's default
  date/title header) + `footerTemplate` = escaped pack-id + `pageNumber`/`totalPages`
  (system-font stack + inline styles ONLY — a template `@font-face` fails the print),
  `generateDocumentOutline` (the h1→h2→h3 tree becomes bookmarks),
  `generateTaggedPDF` (EXPERIMENTAL per Electron — best-effort accessibility, never a
  PDF/UA claim; known-limitations.md). Teardown in `finally` on success/failure AND on
  app quit (`before-quit` hook destroys the window; a killed print rejects → the pipeline
  writes nothing); 60 s per-step timeout (rasterizer discipline); concurrent prints are
  independent (own window, no shared channels). PDF bytes are NONDETERMINISTIC
  (CreationDate/ID) — goldens stay HTML-side; PDFs are smoke-verified via pdfjs.
✅ **Renderer:** `ReviewSummaryView` actions row gains **Create evidence pack** (draft AND
  ready), opening an INLINE options panel (no nested modal): §24.3 encryption-boundary
  warning + the five §16.2 checkboxes at the shared defaults + (P6) the file-format radio
  (`review.export.format*` — HTML default, PDF opt-in; sent as `format` on the same wire
  object); the status line shows
  `review.status.lastExported` (display-only — the status ENUM is unchanged); the export
  history renders real `detail.exports` rows **including the recorded SHA-256** (truncated
  mono display + a copy-full-hash action via `copyToClipboard` — the pack's own integrity
  note and the user guide point the reader here, fix round FIX-2). Store
  (`reviewSession.ts`): `exportReviewPack(options)` FLUSHES pending edits first (the pack
  renders persisted data; a failed flush REFUSES — pinned by test), then merges the
  returned record into `detail.exports` newest-first under the `openToken` staleness
  guard. Outcomes: 'exported' | 'cancelled' (native-dialog cancel — silent) | 'failed'
  (+friendly copy, rendered inline in the panel). A token change (lock/switch) landing
  AFTER a successful export still returns 'exported' (state untouched — the export is
  real; only a genuine rejection reports 'failed').
✅ **Phase-3 tests:** `tests/unit/evidence-pack-model.test.ts` ×13 (option boundary, §16.1
  normalization, honesty-mapping reuse pin, option matrix) +
  `tests/unit/evidence-pack-html.test.ts` ×26 (escapeHtml, §29.4 injection suite incl.
  hostile source key/machineLabel/sha256/raw coverage mode + the structural remote-ref
  sweep over the HOSTILE render, §17.2 self-containment, D-1 print contract, EN/DE
  freezing, ordinal-stable item numbering, zone-less-timestamp verbatim, determinism) +
  `tests/integration/evidence-pack-export.test.ts` ×15 (the five §29.5 GOLDEN packs under
  `tests/fixtures/evidence-packs/` — relevance/whole-doc/partial-coverage/missing-source/
  German, normalized timestamps + pack ids, regenerate via `UPDATE_EVIDENCE_PACK_GOLDENS=1`;
  atomicity: failing write AND failing rename leave no file/no tmp/no row; the two
  POST-rename record-failure paths — injected INSERT trigger, review deleted mid-dialog —
  unlink the destination and throw `EvidencePackRecordError`; cancel → nothing; no-BOM
  encoding; recorded-hash-matches-file-bytes; ready-review export; real offline guard
  across every test) + export legs in `evidence-reviews-ipc.test.ts` (ready-review export
  over the wire, cancel, post-rename failure surfaces the LOCALIZED distinct copy with no
  file/row/audit event, boundary guards, hostile options → resolved defaults persisted,
  runtime tripwire) and `audit-ipc.test.ts` (path-sentinel destination; event =
  `{reviewId, format}` exactly) + `tests/renderer/ReviewExport.test.tsx` ×9 (panel
  defaults, payload shape, history merge, cancel/failure, flush-before-export ordering,
  flush-FAILURE refusal, ready-review export, hash display + full-hash copy;
  `exportEvidencePack` in the stub sets under the structural no-call tripwire).

**Phase 4 — freshness engine, Outdated lifecycle, source-in-context (as built):**

✅ **Types (`shared/types.ts`, all ADDITIVE):** `EvidenceSourceFreshnessState`
  ('unchanged'|'changed'|'missing'|'unverifiable'), `EvidenceSourceFreshness {key, state}`,
  `EvidenceFreshnessComparison` ('unchanged'|'changed'|'unverifiable'),
  `EvidenceReviewFreshness` widened with OPTIONAL `answerState`, `coverageState`,
  `sources[]`, `acknowledgedAt` (the P1 `{reviewId, outdated}` shape stays valid on the
  wire), and `EvidenceSourceContext` (the D-5 result: title, availability, `hashState`
  'match'|'mismatch'|'unknown', persisted `snippet`, `located` + bounded
  `before`/`match`/`after`, page/section).
✅ **Freshness engine (`main/services/evidence-pack/freshness.ts`):**
  `computeEvidenceReviewFreshness(db, reviewId)` — STORED-fact comparison only (spec §21.2:
  the stored `documents.sha256` is the basis; NO re-hashing, NO file I/O — pinned
  structurally by tests whose documents have no files at all). Verdicts: resolved+row+both
  hashes → unchanged/changed; resolved+row-gone → missing; unresolved identity OR absent
  hash → 'unverifiable' (**never 'changed'** — binding). `outdated` = POSITIVE drift only:
  answer text ≠ snapshot ∨ coverage semantic fields ≠ snapshot ∨ ≥1 source 'changed'.
  **Deletion does NOT flip outdated** (spec §25.2/§28.7 letter: unavailability warning, not
  an overlay; §28.6's acknowledge gate is reserved for CHANGED content). Coverage compare =
  fixed semantic projection (mode/counts/treeStatus/treeLevels/tier/truncated/
  unparsedChunks/fullyChunked) — `nodeIds` + unknown extras excluded (plumbing, not claims).
  `acknowledgeEvidenceReviewFreshness(db, reviewId)` writes `freshness_ack_json`
  `{acknowledgedAt, fingerprint}`; the fingerprint is the sorted canonical string of every
  non-'unchanged' fact **including the observed current value** (fix round FIX-1:
  `src:{key}=changed:{current sha}`, `answer=changed:{digest(current text)}`,
  `coverage=changed:{digest(canonical current)}`; missing/unverifiable stay state
  literals — no value exists), so ANY later drift change lapses the acknowledge — incl. a
  RE-change of an already-changed fact (sha ff→ee after acknowledging aa→ff), a second
  answer edit, changed→recovered→changed-again (no stale-ack resurrection), and a NEW
  deletion (adds a fact). Hashes only, inside the encrypted row. Also exports
  `compareStoredHashes`, `parseFreshnessAck`.
✅ **Read overlay (IPC boundary):** `evidence:get` + `evidence:getForMessage` responses
  carry the REAL computed `outdated` (the chat chip + a fresh open render truthfully);
  SERVICE-level reads and every write-path return (`update`/`markReady`/`reopen`/`create`)
  keep the constant-false overlay — the renderer's freshness UI reads the store's refresh
  result exclusively, never a write-return's flag.
✅ **Export pipeline (P4 change, spec §20.1):** `exportEvidencePackToFile` now EXECUTES the
  refresh step — computes the verdict up front, REFUSES an outdated review whose drift is
  unacknowledged (`EvidencePackOutdatedError` → localized
  `main.evidenceReviews.exportOutdated`, thrown BEFORE any dialog/file work), and INJECTS
  the verdict into `buildEvidencePackModel(detail, options, meta, freshness?)` (4th
  OPTIONAL param — the model stays pure; goldens inject fixed verdicts). Pack rendering:
  cover outdated warning + acknowledge stamp (§21.3 "prominent snapshot warning"),
  coverage-section mismatch records (`packExport.coverage.answerChangedNow`/
  `coverageChangedNow`/`sourcesChangedNow`/`sourcesMissingNow` — missing counts NEW
  deletions only) + `freshnessChecked` note (the P3 fixed `freshnessNote` renders only
  when NO verdict was injected), per-card §15.4/§15.5 warnings, and the §16.1.7 source
  register column becomes **Availability at export** (available / changed-since-review /
  missing / cannot-verify from `EvidencePackSource.currentState`). A deleted source NEVER
  blocks export (§28.7). Model additions: `EvidencePackFreshness` + `outdated` overridden
  by the injected verdict + `EvidencePackSource.currentState` (null = no verdict, P3 shape).
✅ **Source-in-context (`main/services/evidence-pack/source-context.ts`, D-5):**
  `getEvidenceSourceContext(db, reviewId, sourceKey)` — see the IPC table row for the full
  resolution ladder + security posture. `CONTEXT_WINDOW_CHARS = 1200` per side.
✅ **Renderer:** store (`reviewSession.ts`) gains `freshness` state +
  `refreshReviewFreshness()` (fired automatically after every successful open —
  fire-and-forget, `openToken`-guarded; a failed check leaves the last honest state) +
  `acknowledgeReviewFreshness()`. ReviewScreen: Outdated banner (drift facts + §21.3
  options + acknowledge action / acknowledged stamp; role=status) + an ADDITIONAL
  `⚠ Outdated` chip (Draft/Ready never replaced); EvidencePane cards gain freshness badges
  (changed / NEWLY-missing / resolved-cannot-verify; unresolved keeps only its identity
  badge) + **Open source in context** (resolved sources only) → `SourceContextModal`
  (highlighted excerpt + hash-state line + stored-text note). ReviewSummaryView: at-open
  changed/missing-now counts + the §28.6 export gate (button disabled + hint + inline
  acknowledge while outdated-unacknowledged; main refuses too). MessageActions/Transcript:
  the entry chip row gains `⚠ Outdated` when the summary's computed overlay says so.
✅ **i18n:** +9 `review.outdated.*`, +3 `review.source.*` freshness badges, +11
  `review.sourceContext.*`, +4 `review.summary.sources{Changed,Missing}Now.*`,
  `review.status.outdated`, +13 `packExport.*` freshness keys,
  `main.evidenceReviews.exportOutdated` — EN+DE (DE draft register at P4 close; the
  native pass landed in P5 — design-guidelines §11.13 — and removed the draft flags).
✅ **Phase-4 tests:** `tests/integration/evidence-freshness.test.ts` ×28 (engine verdicts
  incl. unresolved-never-changed under mutation AND deletion of same-titled docs,
  hash-absent unverifiable, answer/coverage drift, reserialized-coverage false-positive
  pin, ready-not-erased; acknowledge persist/no-op/lapse-on-new-drift/malformed-record/
  lifecycle-stamps-untouched + the FIX-1 value-bearing-fingerprint legs (re-change lapse,
  second answer edit, changed→recovered→changed-again no-resurrect, canonical stored
  shape); export gate refused-before-dialog + §28.6 pack recording + §28.7 deleted-source
  export + MIXED changed+deleted drift end-to-end incl. new-deletion-lapses-acknowledge;
  IPC legs for the new channels + real read overlay + the LOCALIZED outdated-export
  rejection over the wire; source-context located/mismatch/stale-chunk-id/
  foreign-chunk-id-leak-guard/missing/not-located/truncated-snippet — all under the REAL
  offline guard, with NO document files on disk anywhere) + the 6th GOLDEN
  `outdated-acknowledged` (+ regenerated 5 — freshness note + at-export column) + P4
  describe blocks in `evidence-pack-html.test.ts` ×5, `ReviewScreen.test.tsx` ×8 (refresh
  ON OPEN, banner/chip/badges, banner names newly-missing facts, acknowledge flow,
  missing-without-banner, unresolved-badge-only, context modal ×2), `ReviewExport.test.tsx`
  ×3 (export gate), `reviewSession.test.ts` ×5 (refresh-on-open, no-refresh-on-failed-open,
  openToken purge guard, acknowledge merge/failure), `ReviewEntryPoints.test.tsx` (Outdated
  chip joins Ready), `GermanSmoke` (outdated overlay DE). Review renderer test files
  (incl. `lockPurge.test.ts`'s review leg) stub the refresh structurally via
  `stubReviewApi` (`tests/helpers/evidenceReview.ts`).
✅ **Phase-6 tests (PDF):** `tests/unit/evidence-pack-print-pdf.test.ts` ×9 (fake
  electron: the D-1 option literals + footer no-@font-face/escaping pins, preload-free
  sandboxed posture + deny-all navigation, teardown on success/print-failure/load-failure/
  app-quit-mid-print/step-timeout — runs everywhere incl. CI) + `evidence-pack-export.
  test.ts` P6 describe ×5 (seam contract: verbatim html + `${dest}.print.tmp.html`;
  extension-override both directions; killed-print ⇒ no file/no siblings/no row;
  outdated-refusal BEFORE dialog AND print; post-rename unlink on PDF) + helpers ×4
  (Buffer atomic write, format resolvers) + `evidence-reviews-ipc.test.ts` ×2 (dialog
  filter list both-formats/requested-first through the REAL handler + REAL harness on a
  fake BrowserWindow; audit `{reviewId, format:'pdf'}`; malformed format → html-first) +
  `ReviewExport.test.tsx` +1 (PDF sends `format:'pdf'`; the defaults test now pins the
  radio: HTML checked) + `window-security.test.ts` +1 (print window preload-free) +
  **`evidence-pack-pdf-smoke.test.ts` ×6 — REAL Electron** (spawns the installed binary
  on an esbuild bundle of the REAL harness; SKIPS where the binary/display is absent —
  CI never installs Electron — and always runs on the Windows dev box): EN+DE golden
  prints verified with pdfjs — page count, CURRENT-catalog sentinels (DE umlauts/ß),
  pack-id + `1/{totalPages}` footer, outline depth EXACTLY 3 with catalog section titles,
  `/MarkInfo Marked` (tagged) true, kill-after-load rejection with no output, and EVERY
  Chromium request `file://` + the REAL offline guard silent across the run.

### MVP Definition of Done (§4 / spec §22) — checklist
| Criterion | Status |
|---|---|
| App builds on ≥1 OS | ✅ `npm run build` green (Windows) |
| Architecture supports Win/macOS/Linux | ✅ path/OS abstractions + 3 sidecar dirs + 3 builder targets |
| Local model chat works | ✅ mock now; real `LlamaRuntime` wired (live = manual, R5) |
| Local doc Q&A works | ✅ ingestion + embeddings + RAG (mock + real backends) |
| Citations work | ✅ Phase 6 (`citations_json`, source panel) |
| Manifests work | ✅ discover/validate/verify/recommend/select |
| Drive layout works | ✅ `prepare-drive` (dry-run tested); `resolvePaths` marker |
| User data local | ✅ no network in core path; loopback-only sidecars |
| Privacy docs exist | ✅ PRIVACY.md, Privacy screen, security-model |
| Setup script exists | ✅ `scripts/setup-dev.{ps1,sh}` |
| Benchmark recommendation exists | ✅ Phase 7 |
| Non-technical demo possible | ✅ documented end-to-end (user-guide.md); live run = manual (R5) |
| No cloud API | ✅ enforced (offline guard, CSP, deny-by-default policy) |
| No model weights in git | ✅ `.gitignore` (`models/`, `*.gguf`, `/runtime/`, `release/`) |
| README explains DIY | ✅ (+ user-guide + packaging + drive-layout) |
| Commercial drive layout documented | ✅ drive-layout.md + packaging.md |

**Remaining = MANUAL acceptance only (R2/R5):** producing the real portable `.exe` (Electron binary
download R2; npm-workspace dep hoisting may need a tweak) and a live USB-drive run with real weights +
sidecar binaries (not in repo). The selectors fall back to mocks when those files are absent, so dev +
CI are unaffected.

