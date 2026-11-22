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
listModels(): Promise<ModelInfo[]>   // incl. display-only entries for a newer HilbertRaum (role 'unknown', #847)
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
updateSettings(patch: RendererSettingsPatch): Promise<AppSettings>  // renderer-owned keys only (#868)
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
the in-app model downloader, async-with-polling) + `listDownloadJobs`/`dismissDownloadJob`
(`downloads:list`/`downloads:dismiss`, issue #314 — reload recovery: which downloads still need
the user, and dismissing one main-side) +
`getAuditEvents(limit?, beforeId?)`/`exportAuditLog` (`audit:list`/`audit:export`, Phase 19 —
the Diagnostics Activity panel, newest-first paging + save-dialog export) +
`searchConversations` (`chat:search`, Phase 31) + `changeWorkspacePassword`
(`workspace:changePassword`, Phase 32) +
`saveCodeBlock(messageId, content, language)` (`chat:saveCodeBlock`, issue #286 — save one
fenced code block from a persisted assistant answer as its own file; renderer-supplied bytes,
verbatim, no BOM; resolves with the path or null on cancel) +
`startDocTask`/`getDocTask`/`cancelDocTask` (`doctasks:start/get/cancel`, Phases 33–35 —
document tasks, async-with-polling; `cancelDocTask()` with no jobId cancels the active task — since
#689 only the chat busy banner sends none, the Documents row sends its task's id;
shapes `StartDocTaskRequest`/`DocTaskStatus`/`DocumentSummary` in `shared/types.ts`, and
`DocumentInfo` gained an optional `summary` from the additive `documents.summary_json` column;
Phase 34: `kind: 'translation'` takes BOTH `params.sourceLang: TranslationSourceLang` and
`params.targetLang: TranslationTargetLang` (as shipped since TG-3 — TranslateGemma has no
auto-detect and source ≠ target is enforced server-side; both are `TranslationLangCode`, the
closed 51-code WMT24++ set of `TRANSLATION_LANGUAGE_CODES` since issue #31 — the original
Phase-34 `'de'|'en'` target-only shape is history, updated in place per this file's charter;
issue #164 D-3), `resultRef.documentId` = the NEW materialized document, and `DocumentInfo`
gained an optional `origin: DocumentOrigin` from the additive `documents.origin_json` column;
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
`importPreflight(paths, pickerToken?)` (`docs:importPreflight`, Phase 36 — read-only selection summary
driving the large-audio import confirm; `DocumentInfo` gained optional `transcriptionProgress`;
since PR #275 (#240) a live `pickDocuments` token makes main count its own vetted paths without
spending the token, while a token-less call is the raw seam, capped at `MAX_DROP_PATHS` = 512
strings before any filesystem call; since PR #283 (#274) the walk behind it is asynchronous and
`ImportPreflight` gained the additive optional `exhausted?: 'entries' | 'depth' | 'time'`
(`WalkExhausted`, declared once in `shared/types.ts`) — present only when the walk was cut by its
budget, so `fileCount` is then a lower bound; `ImportJob` (the `importDocuments` result, still
`{ jobId, documentIds }` complete at resolution) and `ImportJobStatus` (`getImportJob` /
`getActiveImportJob`) carry the same field for the import's own walk) +
`transcribeDictation(audio: Uint8Array): Promise<string>` (`dictation:transcribe`, Phase 37 —
voice dictation: 16 kHz mono WAV bytes in, plain text out; request/response, nothing persisted,
no audit; `AppStatus` gained the additive `dictationAvailable: boolean` gate). #504:
`TranscribeOptions` gained the additive `vad?: boolean` — dictation passes `true`, imports
nothing; the whisper manifest declares the Silero VAD file as its second required `files[]`
entry (the #310 multi-file shape), so `resolveModelByRole`'s `requiredPaths` carries it.
#527: `AppStatus` gained the additive-optional `transcriberMissing?: TranscriberMissing | null`
(`'model' | 'engine' | 'model-and-engine' | 'engine-unsupported'`, null while a transcriber is
selected — the `ocrState` precedent), read from `AppContext.transcriberMissing`, which is stored
with the slot; `IngestionDeps`/`ParseContext` carry it to the AudioParser, and
`documents.error_message` gained three persist-canonical English values
(`main.ingest.audioNeedsEngine`, `…audioNeedsModelAndEngine`, `…audioEngineUnsupported`,
display-map translated; `audioNeedsTranscriber` unchanged) — no schema change. Renderer
navigation gained the virtual target `models:voice` (the AI Model screen on Browse, Voice task).
#539 added `models:images` and `models:translation` (the same landing, Images / Translation task);
`NavResolution.modelsFocus` is now `ModelsFocus = 'voice' | 'images' | 'translation'` (renderer-only,
session state, never persisted; plain `models` still resolves to exactly `{ screen: 'models' }`).
#530 (`architecture.md` "Engine load failures — design record"): `AppStatus` gained the
additive-optional `engineProblems?: EngineProblem[]` — `{ family: 'llama_cpp' | 'whisper_cpp',
reason: 'library-missing' | 'system-too-old' | 'files-damaged' | 'vc-runtime-missing' |
'blocked', os: 'win' | 'mac' | 'linux', name?: string, exit: string }` (`name` is a library
FILE name or a version tag such as `GLIBC_2.34`, never a path; `exit` is for Diagnostics), the chat
engine first; a SESSION verdict held in main memory (`runtime/engine-load.ts`), never persisted.
New invoke channel `recheckEngine(): Promise<EngineRecheckResult>` (`engine:recheck`, no payload,
admission-gated — refused while locked; `{ problems: EngineProblem[] }` = what is still refused
after re-starting each engine with a verdict) and the payload-free event
`EVENTS.engineProblemsChanged` (`engine:problemsChanged`, preload `onEngineProblemsChanged`) on a
new, different or cleared verdict. `runtime:notice` gained an optional second argument
`target?: 'models'` (preload `onRuntimeNotice(cb(message, target?))`): the notice's button opens
the AI Model screen instead of Diagnostics. `TranslateErrorCode` and `VisionErrorCode` gained
`'engineCannotRun'`. `documents.error_message` gained three persist-canonical English values —
`main.ingest.engineCannotRun`, `main.ingest.voiceEngineCannotRun` (exact match) and the
INTERPOLATED `main.ingest.engineLibraryMissing` (`{library}` = the file name) — display-map
translated; rows that stored the raw loader line before #530 (absolute drive path included) are
rewritten to them at every session start. Settings: a `gpuAutoDisabled` whose `gpuLastError`
classifies as a load refusal is cleared (both fields) at every session start. No schema change.
#532 (`architecture.md` "Engine load failures" §8): `EngineProblem` gained the additive-optional
`afterInstall?: boolean` — a `'files-damaged'` verdict about the very program this session's
engine install put on the drive (session-only, like the verdict; the UI then offers no second
reinstall). Since #670 (§10 there) the verdict keeps it for every later `'files-damaged'` report
until it is dropped, whichever program reports (on a Kit, the `cpu/` net); since #678 (§11) a `cpu/`
net the reinstall replaced is a fresh copy too. The shape is unchanged.
The engine-downloader additions are listed under the downloader below. No new channel, no schema
change.
#1012 (`security-model.md` "Re-hash sidecar binaries before spawn"): a `'files-damaged'` verdict can
also come from the pre-spawn check — a file the engine copy's install marker records is missing, or
(code review round 6) changed, and the program was never started. Its `exit` is then `'not started'` and it carries no `name`. Same shape,
same channels, same "Install again" offer. An engine file the check could not read just now
(`EngineFilesUnreadableError`, no verdict) is reported with the new key `main.engine.filesUnreadable`:
- `TranslateErrorCode` gained `'filesUnreadable'`;
- a document translation task fails with that key's text, which is now a friendly task error;
- `documents.error_message` gained the key's English text as a persist-canonical, exact-match value (an
  audio import; display-mapped), so that English value is frozen like the other row texts;
- dictation rejects with it;
- a chat start shows it as a `runtime:notice` with the `'models'` target (code review round 5: its button
  opens the AI Model screen, where the model can be started again);
- `VisionErrorCode` gained `'filesUnreadable'` (round 5; the renderer maps it to the same key, and an
  unknown code still falls back to `runtimeFailed`).
#634 (`rag-design.md` §12.4 "#634 amendment"): `documents.error_message` gained three
persist-canonical English values for a search-model failure — `main.ingest.searchModelTimeout`,
`…searchModelCannotStart`, `…searchModelFailed` (exact match, display-map translated) — and a lock
or quit that cut an embed off stores the existing `main.ingest.interrupted`. Rows that stored the
embedder's raw failure before #634 ("The operation timed out.", "terminated", a start failure's
stderr tail with the weight file's absolute path) are rewritten to them at every session start. A
document question's `rag:ask` rejection carries the matching `main.chat.searchModel*` copy. No new
channel, no schema change.
Phase 38: `kind: 'ocr'` on the same doc-task channels (one PDF; the target must be
scan-detected or already OCR'd; needs the OCR engine, not the chat runtime);
`DocumentInfo` gained the DERIVED `scanDetected` flag + optional `ocr: DocumentOcrInfo`
(metadata of the additive `documents.ocr_json` column — the recognized text itself is
content and never leaves the DB); `AppStatus` gained the additive
`ocrAvailable: boolean` gate. The internal `OCR_RASTER` channels (shared/ipc.ts) bind
ONLY the hidden rasterizer window's preload, never the app bridge.
**#538 / #574 / #575 / #576 (2026-10-05; architecture.md "OCR quality amendment"):**
`documents.ocr_json` pages gained optional `confidence` (0–100, the reading's mean) and `turn`
(0/90/180/270, the clockwise turn the kept reading was made at; absent = 0). `DocumentOcrInfo`
(= `documents.ocr_meta_json`) gained `textPageCount` (pages whose reading produced text; the
open-time backfill re-derives older sidecars) and `lowConfidencePageCount` (text pages under 65;
absent when no page carries a confidence) — counts only. A PHOTO row now has an `ocr_meta_json`
(pageCount 1) with NO `ocr_json` behind it, rewritten by each import/re-index and NULLed when the
read fails. New additive column `documents.scanned_pages_json` = `{ pages: number[], pageCount }`
— a TEXT PDF's scanned pages (under 25 characters of text, painting an image), page numbers only,
written at import/re-index (NULL: none, a whole scan, or not parsed since); `DocumentInfo` gained
`scannedPages?: { count, pageCount } | null` (counts only), and the `ocr` smart view includes such
rows. `kind: 'ocr'` now also admits a PDF with `scannedPages`, and for it reads only those pages.
`OcrInstallLanguage` gained `role: 'language' | 'orientation'`; `ocr:status` lists the third pin
`osd`. The internal `RasterizePdfOptions` gained `pages` (render only these). No schema-version
change.
**Issue #188 (wave 188):** `DocumentInfo` gained the optional `storedCopy?: 'present' | 'missing'`
— whether the document's workspace copy is on disk right now, so the `⋯` menu can refuse to offer a
byte-level action that would fail after the click. It is populated ONLY by callers that hold a store
dir (`listDocuments(db, embedderId, storeDir)`; the docs IPC passes it), derived from ONE
`readdirSync` of `workspace/documents/` per call rather than a stat per row. **`undefined` means
"not evaluated", never "missing"** — `getDocument`/`createQueuedDocument` results simply do not
carry it, and every consumer must treat absence as unknown. Backed by the additive
`documents.stored_name` column (the stored copy's leaf name, RELATIVE to the store dir; NULL until
the resolver heals the row) — see architecture.md "Portable stored copies — design record".
(`pickDocuments` + `reindexDocument` are Phase-4 additions to the `IPC` registry beyond the spec
§9.1 list — picker + re-index UX; `getPolicy` is a Phase-8 addition; the four `workspace:*` channels
are Phase-9 additions.) `createConversation` now also accepts an optional `mode`
('chat' | 'documents') and an optional `scopeDocumentIds` (Phase 17); `Conversation` carries
`scopeDocumentIds: string[] | null` (additive `conversations.scope_json` column, guarded
ALTER-TABLE migration in `db.ts`). **#138 (D-7):** since the document-organization wave it
ALSO takes `collectionId?: string` (creation anchor) and `scope?: DocumentScope` (the
composite `scope_v2_json` union — see rag-design §13; #301 P4 finding M10 adds the additive
`documentsOff?: true` flag — "Knowledge packs" below), with the companions
`setConversationScope(conversationId, scope | null)`, `setConversationCollection(conversationId,
collectionId | null)`, and `listAttachments(conversationId): Promise<DocumentInfo[]>` (the
chat's temporary attachments). **#571:** `listAttachments` also returns the chat's FAILED attachments
that were never filed (`pending_destination_json` still names the conversation; `status: 'failed'`,
no link — N4 holds), so the renderer can mark them *"(not readable yet)"*; and `resolveScope` unions
every unfiled one (failed or importing) into `RetrievalScope.documentIds`. No shape change: the same
`DocumentInfo`, the same `RetrievalScope`._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helper: `openDatabase(path)` (tests list the tables with
`tests/helpers/db-fixtures.ts` `listTables`, #840). **#571** added one additive
partial index, `idx_documents_pending_dest ON documents(id) WHERE pending_destination_json IS NOT
NULL` (created after `ensureColumn`, like the other migrated-column indexes) — no column, no
migration. **#581** added connection-local TEMP objects, created on every open after the
migrations: the one-row `temp.corpus_generation` counter and six `corpus_generation_*` TEMP
triggers that bump it on a `documents` insert, delete or change of `status`, `title`,
`mime_type` or `lifecycle` on a row that is `indexed` before or after, and on any
`document_collections` insert, delete or re-key.
`corpusGeneration(db)` reads it (the skill-suggestion memo's key, `skills/scope-signals.ts`).
Nothing reaches the workspace file, so an older build sees no change and `SCHEMA_VERSION` stays.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts (what each key may hold is the write gate below; who may write it through IPC is `SETTINGS_WRITERS`, see the end of this section); `seedSettings` seeds on first run. Default `allowNetwork:true`
(network is PERMITTED on a fresh install so model/engine downloads work — the policy ceiling still
wins; a commercial `policy.json` can force it back off), `workspaceMode:'plaintext_dev'`,
`contextTokens:4096`. **Phase 7 added `lastBenchmark`**
(JSON `BenchmarkResult | null`, default `null`) — the persisted hardware profile lives here.
**The performance wave (2026-09-05) added `BenchmarkResult.gpuVramMb`** (the total MiB of the
SAME device `gpu` names — the BUDGET device `nextStartMemory` selects for the NEXT start (the
largest usable card by the `shared/gpu-rules.ts` rule; PR #308 audit decision 9 unified with the
PR #303 audit P5 pairing rule at the merge of the two) — null with the GPU off or auto-disabled or
on an integrated-only machine even when a device is probed, never the first device listed; optional;
absent on older results) **and `benchmarkHistory`** (`BenchmarkResult[]`, default `[]`,
one entry per computer keyed by `machineKey`, capped at `MAX_BENCHMARK_HISTORY = 8`; the write
gate keeps plain-object elements only; since the PR #303 audit an outgoing `lastBenchmark` from
another computer is backfilled into it before being replaced, the cap evicts the oldest OTHER
machine, and the two keys are always written in one `updateSettings` call, history first — see
`benchmark.md` "History per machine") **and `modelPlacements`** (`Record<modelId, ModelPlacement>`,
default `{}`: where each model's last start landed per llama.cpp's load log, stamped with
`machineKey`; object-valued, size-capped); see `benchmark.md` "History per machine" / "Your model".
**Since the PR #303 audit (H1/L8, owner decision G7) these three keys are VALIDATED, not merely
shape-checked — on WRITE and on READ**, by the pure normalizers in
[`shared/benchmark-schema.ts`](../apps/desktop/src/shared/benchmark-schema.ts)
(`normalizeBenchmarkResult` / `normalizeBenchmarkHistory` / `normalizeModelPlacement(s)`, plus
`normalizeEffectiveRead` / `normalizeSpeedBasis`; `machineKey` lives there too and
`services/performance.ts` re-exports it):

- `lastBenchmark` — a `BenchmarkResult` is valid when it is a plain object carrying EITHER a
  parseable `ranAt` OR a real `HardwareProfile` (the LEGACY profile-only blob, kept valid by G3
  with an unknown identity, `ranAt: ''` as the unknown-date sentinel — never a fabricated "now" —
  and safe defaults). `{}` and friends are rejected. Every figure is finite and `>= 0` or `null`,
  a malformed identity normalizes to the unknown one (so `machineKey` returns `null`, never half a
  key), `warnings` keeps its strings, and the optional legacy fields (`gpuVramMb`, `speedBasis`,
  `measuredModelId`, `effectiveRead`) stay ABSENT when the record has none — absence is what the
  screens render as "approximate" / "not recorded".
- `benchmarkHistory` — each element is normalized, invalid AND unkeyed entries are dropped (the
  history is addressed by machine, so an entry `machineKey` cannot key could never be matched),
  one record per key survives (newest `ranAt`), newest first, capped at `MAX_BENCHMARK_HISTORY`.
- `modelPlacements` — each record must validate (non-empty `modelId`, `'gpu' | 'cpu'` backend,
  positive whole `contextTokens`, parseable `at`; layer/buffer figures finite `>= 0` or `null`; an
  ALL-NULL reading is valid — L7 renders it as `unknown`; a self-contradicting `gpuLayers >
  totalLayers` is rejected) AND be filed under its own `modelId`. Since P5 a record may carry
  **`devices?: PlacementDevice[]`** (DR2) — the log's `device_info` rows `{ label, name, totalMb,
  freeMb, computeMb }`, validated per row (both join keys non-empty strings, figures finite or
  null; junk rows dropped, a non-array reads as `[]`, absence stays absent). Since #329 it may
  also carry **`gpuRsMb?` / `cpuRsMb?`** — the recurrent-state cache a hybrid (Gated-DeltaNet)
  model allocates beside the KV buffers (`llama_memory_recurrent: <device> RS buffer size`),
  allocated per sequence and therefore kept out of `gpuKvMb`/`cpuKvMb`. Like `devices?`, each is
  set only when the raw record has the key: absence means the recording build predates the pair
  (so its `gpuKvMb` is KV-only), while present-and-`null` means the recording build printed no
  usable `RS` figure — a dense model prints none, and `figure()` also nulls a malformed value.
- `gpuProbe` (P5) — `{ devices: GpuDevice[], probedAt, machineKey? }` via `normalizeGpuProbe`,
  behind the unchanged top-level object gate: a `devices` ARRAY is required (junk items dropped —
  a device needs a non-empty `name` and a finite `totalMb`; `id` reads as `''` and `freeMb` as
  `0` when unusable; an all-junk list is an EMPTY probe, which is a result), `probedAt` a
  parseable date or the unknown sentinel, and **`machineKey`** (M8.3, owner decision G3) — the
  computer the probe ran on, written by `probeAndPersistGpu` — a string or `null`, kept ABSENT
  when the stored probe has none: an unstamped legacy probe is never re-stamped, readers
  (`eligibleGpuProbe` in `shared/gpu-rules.ts`) treat it as eligible until a local refresh
  replaces it, and a probe stamped with another machine's key supplies nothing. Every path of
  `probeAndPersistGpu` that reaches the write persists this session's stamped answer — a probe
  that cannot run (no binary) or that threw writes `{ devices: [], probedAt, machineKey }` like an
  empty successful probe (PR #308 audit decision 6; an empty stamped result re-stamps no old
  device), each only after the admission + unlock-epoch re-check. **Installing the chat engine
  refreshes it** (issue #323, 2026-09-06): `EngineDownloadManager.onInstalled` → `registerEngineIpc`
  → `refreshGpuProbeAfterRuntimeInstall` (registerBenchmarkIpc.ts) re-runs `probeAndPersistGpu`
  (cache invalidated first; the same admission / epoch checks and push) when a `llama_cpp` install
  reaches `done` and this machine's ELIGIBLE probe lists no device — the empty stamped probe of a
  benchmark run before the binary existed, a missing probe, or a foreign-stamped one; an eligible
  probe that already lists a device is left alone, a whisper-only / failed / cancelled install
  changes nothing, and the benchmark itself is never re-run.

On WRITE, garbage is IGNORED (a `lastBenchmark` that normalizes to nothing leaves the previous
result standing — the convention every mistyped value here follows; `null` is still the explicit
clear), while the two collections store what survived. On READ the repair is IN MEMORY only: a row
written by an older build, a hand-edited DB or a half-written blob is normalized for the caller
and the stored row is left untouched, so `getSettings` keeps its no-side-effect contract. The
256 KB `MAX_SETTINGS_OBJECT_BYTES` ceiling is a **`JSON.stringify(...).length` cap** (UTF-16 code
units, not verified UTF-8 bytes) applied to the normalized value.
**The post-MVP UX round added `autoStartActiveModel`** (boolean, default `true`) **and
`checksumCache`** (`Record<path, {size, mtimeMs, sha256}>`, default `{}` — the persisted L2 of
the weight-file hash cache).
**The i18n phases (39–42) added `uiLanguage`** (`UiLanguageSetting`, default `'system'`;
architecture.md i18n record D-L2, D-L9, §3.2): `'system'` or a code of the language registry
(`UI_LANGUAGES` in `shared/i18n/languages.ts`; since the two 2026-11 UI-languages waves `en`,
`de`, `es`, `fr`, `it`, `nl`, `pl`, `tr`, `ru`, `uk`, in registry order; Ukrainian is `uk`, never
the country code `ua`). `UiLanguageSetting` is derived from the registry, so registering a
language widens the union. The write gate (`updateSettings`) stores only an `isUiLanguageSetting`
value and drops anything else. The READ path does not validate the row: a value this build does
not register (a newer build's language on a shared drive) comes back as stored, resolves like
`'system'` (`resolveUiLanguage`, in main and in the renderer), and is never rewritten by the read,
so the newer build still finds the choice. Before unlock the renderer cannot read it and uses its
per-computer localStorage mirror `hilbertraum.uiLanguage` instead (D-L3).
⚠️ **Settings live INSIDE the (possibly encrypted) DB** — unreadable before unlock (Phase 9). The
unencrypted `config/workspace.json` vault descriptor is the only pre-unlock artifact;
`workspaceMode` is set to the active mode by the `WorkspaceController` at create, at a plaintext open and at every unlock, and the write gate accepts only `encrypted` or `plaintext_dev`. The renderer cannot set it (#858).
**Who writes which key (#868).** `settings:update` accepts only the keys [`SETTINGS_WRITERS`](../apps/desktop/src/shared/settings-writers.ts) marks renderer-owned (`satisfies Record<keyof AppSettings, 'renderer' | 'main'>`, so a new key fails typecheck until it has an owner). A main-owned key (`workspaceMode`, `activeModelId`, `activeEmbeddingModelId`, `lastBenchmark`, `benchmarkHistory`, `modelPlacements`, `gpuAutoDisabled`, `gpuLastError`, `gpuProbe`, `checksumCache`) is dropped with a log line and the rest of the patch is saved; a key that is no setting is dropped and only counted in that line, never named. The main process writes its keys through `updateSettings(db, …)` directly (the active ids through `models:select` / `runtime:use`). The preload's `updateSettings(patch: RendererSettingsPatch)` makes a literal patch with a main-owned key fail typecheck in the renderer too. The 19 renderer-owned keys are the 14 the screens write plus the five retrieval tuning keys, which no screen writes; the write gate bounds those: `ragTopKInitial` and `ragTopKFinal` to 1–200 and `ragMaxContextTokens` to 256–131,072, each floored to a whole number and clamped, `ragMinSimilarity` clamped to 0–1, and a non-finite value of these four is dropped with the previous value kept; `contextTokens` keeps its 2,048 floor (a non-finite value still falls back to it) and is clamped to 131,072.

### Workspace/paths
✅ `src/main/services/workspace.ts` — `resolvePaths({envRoot,fallbackRoot})` → `ResolvedPaths`
(rootPath, workspacePath, modelsPath, logsPath, configPath, dbPath, isPreparedDrive).
`ensureWorkspaceDirs`, `buildDriveStatus` (adds platform/arch/free/writable, and `imagesBytes`: the size of `workspace/images/`, `0` when empty, `null` when unreadable). See `docs/drive-layout.md`.

### Core IPC (Phase 1 live)
✅ `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings` registered in
`src/main/ipc/registerCoreIpc.ts`, invoked from `initBackend()` in `main/index.ts`.

**#888 — save before the window closes** ([`security-model.md`](security-model.md) "App-shell gate &
lifecycle"): the main→renderer event `EVENTS.saveBeforeClose` (`app:saveBeforeClose`, payload
`requestId: number`), its one-way answer `IPC.saveBeforeCloseDone` (`app:saveBeforeCloseDone`, a
renderer→main `send` of `{ requestId, unsaved: boolean }`), the preload method
`onSaveBeforeClose(cb: () => Promise<SaveBeforeCloseResult>): () => void`, and the type
`SaveBeforeCloseResult = { unsaved: boolean }` (`shared/types.ts`). Main sends the event to the
closing main window once per close attempt and waits up to `CLOSE_SAVE_BOUND_MS` (8 s,
`main/close-guard.ts`), longer than the window's own bounds (the review store's 6 s inside the
bridge's `BEFORE_CLOSE_SAVE_BOUND_MS`, 6.5 s). The preload runs `cb` and sends the answer itself
once `cb` settles; a rejection, a throw or any answer but `unsaved: false` is sent as
`unsaved: true`, and main then asks the user before closing. The bridge answers `unsaved: true` too
for a registrant that throws or has not settled by its bound, unless it was registered best effort
(`registerBeforeClose(save, { bestEffort: true })`, the language pick): such a one counts only when
it answers `unsaved: true` itself. The answer is received by an `ipcMain.on` listener per request,
like `perf:mark` (not a `guardedHandle`, so outside `ipc-lock-coverage`): it accepts only the
window's own `webContents` and the current request id, and it answers while the workspace is locked
too. Renderer side: `renderer/lib/beforeClose.ts` (`registerBeforeClose`, `saveAllBeforeClose`,
`installBeforeCloseBridge`, installed from `main.tsx`); the registrants are the review store and the
Settings language pick. Nothing is persisted; no schema change.

### Models + runtime (Phase 2 live)
✅ **Manifest** schema/validator in `src/shared/manifest.ts` (`ModelManifest`, `validateManifest`,
`isRealSha256`). YAML files under `model-manifests/` (originally chat: Qwen3 4B/8B/14B Q4 + 30B-A3B
MoE + embeddings: E5 small F16 — five; 1.7B dropped, see §9). **The live catalog spans 6 role dirs**
(chat + E5 embeddings + bge-reranker + whisper transcriber + translategemma translation +
qwen2.5-vl vision, in `model-manifests/{chat,embeddings,reranker,transcriber,translation,vision}/`).
`model-policy.md` is the authoritative catalog and manifest count — this doc no longer restates a
hard total (the number drifted twice, see DOC-3/F-20).
✅ **`services/models.ts`** — `resolveManifestsDir`, `discoverManifests`, `sha256File`,
`verifyChecksum`, `computeInstallState`, `recommendChatModelId` (dispatching to
`recommendModelIdByRam` / `recommendModelIdByVram`; `recommendModelId` is the legacy
profile-based fallback — PR #308 §6.6), `buildModelList`, `selectModel`. The embeddings ★ (`ModelInfo.recommended`
on an embeddings card) is `pickManifestForRole(all, 'embeddings')` when it fits the machine's RAM, not a RAM ranking
(#848 review; the same pick `resolveModelByRole` composes and the Performance rows name). `manifestFilesPresent`
(#890) is `computeInstallState`'s synchronous first two steps (supported runtime/format, every declared file
exists; no hashing), behind the images pick `pickVisionManifest` (`services/vision/status.ts`).
States: `unsupported→missing→checksum_failed→installed` (+`running` overlay). `ModelInfo` shape per
`shared/types.ts`. **#932**: `ModelInfo.noChecksum?: true` marks a `checksum_failed` model whose manifest
carries a placeholder hash on any file (`hasPlaceholderHash`, decided from the manifest alone): no checksum on
record, not a damaged file. The card shows "No checksum" (`models.state.noChecksum`) and `models.noChecksum.hint`,
and offers no Download. `ModelState`, `ModelStartVerdict` and every start gate are unchanged: the model is still
refused outside developer leniency. Every manifest path (`local_path`, `mmproj.local_path`, `files[].local_path`) is
resolved against the **drive root**.
✅ **A manifest for a newer HilbertRaum (#847)** — `DiscoveryResult { manifests, unsupported, errors }`:
a `role` this build does not know, or a `min_app_version` above the app (`setManifestAppVersion`, set once
at startup from `app.getVersion()` and by the sell gate from `--app-version`; unset = unknown, which is
fail-safe), routes a file to `unsupported: { manifest: UnsupportedManifest, sourceFile }[]`
(`shared/manifest.ts`: `id`, `displayName`, `role | null`, `family | null`, `sizeOnDiskGb | null`,
`minAppVersion | null`, `localPaths`), never to `manifests`, so no consumer of a `ModelManifest` can
select, start, verify or download one. One id space with `manifests`, in which a usable manifest ALWAYS keeps its
id whatever the walk order (F-847-4): a same-id newer entry is a duplicate in `errors`, not listed; among
newer entries the first in walk order wins. `min_app_version` is exactly `MAJOR.MINOR.PATCH` (anything else
is newer; a pre-release app is older than its release; `manifestNeedsNewerApp`).
`buildModelList` appends one display-only `ModelInfo` per entry, after the models: `role: 'unknown'`
(the union's one non-role member), `declaredRole?`, `needsNewerApp: true`, `state: 'unsupported'`,
`recommended: false`, no `download`, `filesPresent` (every declared file exists; existence only). The
sell gate reports each entry as a problem. Frozen for every later release to meet: the app-update plan's
Appendix B.
✅ **`ModelManifest.files?: RequiredFileSpec[]`** (#310) — the ADDITIONAL required files of a
weight beyond `local_path`/`sha256` (the primary — a shard set's shard 1), each
`{ localPath, sha256, download? }`. Emitted after `local_path`/`sha256`/`download`/`mmproj` in the
YAML (key-order rule — see "Drive layout, scripts & packaging" below). `manifestFiles()` appends
these as `ManifestFile.kind: 'extra'` (the union is now `'weight' | 'mmproj' | 'extra'`;
`ChecksumLabel.file` gained `'extra'` too), so every consumer that walks `manifestFiles()`
— `computeInstallState`, the verify-bar/load-progress byte totals, the #114 prefetch list, the
re-verify cache invalidation, `verifyDriveModels`, `buildChecksumsJson` — covers the whole weight
with no further change. Validator: each member requires a drive-relative, non-repeating
`local_path` and a `sha256`; a per-file `download` is all-or-nothing with the top-level `download`;
a `local_path` matching the `-NNNNN-of-NNNNN.gguf` shard convention must be index 00001 and
`files:` must declare exactly the remaining siblings (shard-completeness rule). An empty `files:`
list is rejected. No forward-compat `format` marker yet — an older build ignores `files:` and
reports shard 1 `installed` (known limitation; #311 owns a marker decision).
✅ **`services/runtime/`** — `ModelRuntime` interface + `RuntimeManager` (single active runtime,
restart on switch) + `MockRuntime` (health ok; `chatStream` stubbed until Phase 3). Factory swap →
`LlamaRuntime` in Phase 10. `RuntimeStatus` shape per `shared/types.ts`.
**Local-api wave P1 (additive):** `RuntimeChatOptions.lane?: 'in-app' | 'external'` (omitted =
`'in-app'`) marks the admission lane; the manager wraps the factory-returned runtime in a
generation-gate decorator (`active()` hands out the decorated instance).
**#1003 (follow-ups wave 7, additive):** `RuntimeChatOptions.auxiliary?: boolean` marks a helper call inside a turn
(today only the cross-language translation, `rag/cross-language.ts`). It streams as any call and sends the same
request body, but `LadderRuntime` and `MockRuntime` do not mark the runtime warm for it, so `RuntimeStatus.warmedUp`
stays false until the turn's answer streams (the #39 hint). Omitted = `false`, the behaviour before.
**`RuntimeManager.isExternallyBusy()` is the external-admission predicate** (any in-flight
generation OR no active runtime — fail closed, covers the start window + #109 warm-up);
`isGenerating()` is the narrower any-lane read. `RuntimeManager.setExternalPreemption(hook)`
registers the local-API admission's abort hook — fired on EVERY in-app generation entry, then the
gate awaits external teardown, bounded ~5 s (D8). Gate counts are epoch-reset on every model
start/stop (leak self-heal). `ExternalGenerationBusyError` is the typed same-frame refusal an
external-lane `chatStream` pull throws while the in-app lane is active or another external stream
runs (HTTP layer maps it to 429). External-lane consumer contract: the stream generator MUST be
settled on every exit path (`finally { await gen.return() }`).
`services/local-api/admission.ts`: `LocalApiAdmission.tryAdmit(id, signal?) → Admission | 'busy' |
'locked' | 'aborted'`; `Admission = { id, signal, ready: Promise<boolean>, release() }` (queue
depth 0–1, ~30 s cap; `abortAll(reason)` = pre-emption AND teardown; invariant `ready:false ⇒
signal aborted`; holders release only AFTER the stream generator settles — releasing mid-teardown
would spuriously refuse the queued waiter at promotion).
**Local-api wave P2 (additive):** `AppSettings` gains `localApiEnabled: boolean` (default false,
D3), `localApiPort: number` (default 4980, clamped [1024, 65535] by `updateSettings`), and
`localApiTokenRequired: boolean` (default true, D4). **The access key itself never enters
AppSettings** (`getSettings` spreads every stored row to the renderer on three IPC surfaces) — it
lives in the dedicated single-row workspace-DB table `local_api_token (id=1 CHECK, token,
updated_at)`, read/written ONLY by `services/local-api/token.ts` (`getOrCreateToken` /
`rotateToken` / `maskToken` — `hr-` + 32 bytes base64url; masked form `hr-…<last4>` is all the
renderer ever sees; encrypted at rest on an encrypted workspace, unreadable pre-unlock — D7).
New audit event `local_api_toggled` (metadata `{ enabled: boolean }` ONLY — the audit-log export
writes metadata verbatim to plaintext outside the vault); `localApiEnabled` +
`localApiTokenRequired` join the `privacyKeys` settings_changed allowlist (booleans only, port
excluded).
**Local-api wave P3 — the exposed HTTP contract (what external apps code against; the
client-facing rendering of this same contract is [`local-api.md`](local-api.md) §6, which must be
updated in the same change whenever anything below moves):**
`LocalApiServer` (`services/local-api/server.ts` + `handlers.ts`) binds **127.0.0.1 AND ::1**
(O5; never 0.0.0.0; no-IPv6 machines degrade to v4-only; the two listen calls, `127.0.0.1` and
then `::1` on the same port, are pinned by `local-api-server.test.ts` "listens on 127.0.0.1 AND
::1, never 0.0.0.0; the two listeners share the port"), default port **4980** (O1).
Every response carries `Server: HilbertRaum/<version>`. Pipeline order (security contract):
Host (loopback names only; absent ⇒ 403) → OPTIONS ⇒ 403 `no_cors` (before the Origin check;
**no CORS header is ever emitted**) → Origin (`http(s)` non-loopback + literal `null` ⇒ 403;
absent/custom app schemes pass) → content-type (POST = `application/json`, charset tolerated; else
415) → Bearer auth (constant-time; when token NOT required a present Authorization is IGNORED; both
routes gated) → route.
Routes (D6 — nothing else): **GET `/v1/models`** → `{object:'list', data:[{id, object:'model',
owned_by:'hilbertraum', context_window}]}`; never consumes an admission slot; distinct probe
outcomes: 200 running · 503 `model_starting` + Retry-After · 503 `model_not_loaded`.
**POST `/v1/chat/completions`**: messages = role∈{system,user,assistant} × string content
(text-only content-parts flatten; image parts 400); capability fields (`tools`/`functions`,
`audio`/`modalities`, `n>1`, `response_format.type:'json_object'`) → 400 `unsupported_field`
naming the field; benign fields (`top_p`, penalties, `n:1`, `user`, `stream_options`) accepted
and IGNORED (v1 does not pass them through — deviation noted in the wave log);
`response_format.json_schema` → grammar-constrained decoding (`responseSchema[Name]`).
External generations run `lane:'external'`, mode balanced (thinking OFF), `max_tokens` clamped
to the launched context window. **Streaming**: role-first `chat.completion.chunk` → content
deltas → `finish_reason` chunk → `data: [DONE]`. **Non-streaming** (SDK default): one
`chat.completion` object. **`usage` is deliberately ABSENT in v1** (the SSE reader discards
token counts; documented rather than fabricated). Client disconnect aborts the generation in
both modes. Errors are OpenAI-shaped `{"error":{message,type,code}}`: 400 invalid/unsupported ·
401 `invalid_api_key` · 403 permission (`forbidden_host`/`forbidden_origin`/`no_cors`) ·
404 `unknown_route` · 413 `body_too_large` (counted bytes, 1 MB; Content-Length never trusted) ·
415 · 429 `busy` + Retry-After (derived from measured tok/s; ~5–180 s, default 30) ·
502 `runtime_unresponsive` · 503 `model_starting`/`model_not_loaded`/`workspace_locked`/
`server_stopped` (`model_starting` from the start REQUEST on, its weight check included — #599). **Pre-emption (D8)**: an in-app turn aborts the external stream → in-band
`{"error":{type:'server_error', code:'preempted_by_user'}}` frame, stream closes **without**
`[DONE]` (retry-with-backoff); teardown uses code `server_stopped` the same way: for the active request, for the one waiting in the queue, and for a request that arrives while a stop, a disable or a re-port is pending or running (#859). **A deliberate model
stop or switch (#600)** ends the active request first with the model gate's own code — `model_not_loaded`
after a stop, `model_starting` (+ Retry-After) after a switch or a stop the app follows with a start
(`stop({ startFollows })`: an engine update, the demo → real engine restart); 503 before any bytes, the
same in-band frame after, and the same 503 for a request queued behind it (`LocalApiServer.endForModelChange`,
called from the runtime's model-stop hook). Baseline
limits: headersTimeout 10 s, requestTimeout DISABLED (CPU generations exceed 300 s; watchdogs +
a 15 s SSE drain-timeout reclaim wedged slots — the runtime's CB-5 watchdogs end a wedged
sidecar with 502 `runtime_unresponsive`: no headers in 180 s, then before the first token 120 s
of silence or 10 min without prompt progress, then 30 s without text; `local-api.md` §6.7, #598), body-idle 30 s (body phase only),
maxConnections 16 per listener: one on 127.0.0.1 and one on ::1, so up to 32 at once. Lifecycle: `ctx.localApi` built in initBackend; started ONLY from the three
post-unlock seams via `maybeStartLocalApi` when policy ∧ setting permit (D3/D7) — both seams
delegate to `applyLocalApiSettings` (one gate); stopped first in `runLockTeardown` (best-effort,
pinned) + `performShutdown` (pinned); start/stop/applySettings are SERIALIZED inside the server
(a disable racing a mid-bind start acts on the settled state); `LOCAL_API_SETTINGS_KEYS`
(`shared/local-api.ts`) is the change-detection list; a failed bind lands in
`LocalApiStatus.lastError` (`'port_in_use' | 'start_failed' | null`) — the P4 card's error
surface. Abort classification uses the shared `isAbortError` + typed `isExceedContextError`
(never message regexes); a queued waiter re-resolves runtime + status after promotion (a model
switch during the wait can never stream from the stopped runtime); reclaimed/truncated streams
count as rejected, never served. `isStrictLoopbackHostname` (`shared/local-api.ts`) is the ONE
enforcement-grade loopback classifier (Host + Origin; handles WHATWG's bracketed
`URL.hostname` for IPv6).
**Policy ceiling (O3/O4 owner-ratified 2026-08-18):** `PrivacyPolicy.network.allowLocalApi`
(file key `allow_local_api`, restrict-only) — DEFAULT true / STRICT false / **STANDALONE true**
(O3: without it the feature is policy-dead on every GitHub-release install; the setting stays
default-off behind consent). There is deliberately NO `PolicyStatus` copy field: the
Settings card reads the ceiling from `policy.network.allowLocalApi` and derives its effective
state with `localApiEffectivelyEnabled(policy, setting)` — the SAME single derivation the P3
start seams use (policy ∧ setting). `prepare-drive` writes
`allow_local_api: false` explicitly on commercial drives, `true` on `--dev` drives (O4;
`buildPolicyJson` is canonical, script-drift-pinned in both provisioning scripts).
**Absent-key rule (owner decision 2026-08-18):** the key is newer than the drives in the field, so
`mergePolicyObject` treats an ABSENT `allow_local_api` as "not yet decided" and inherits the
permissive `DEFAULT_POLICY` value rather than the packaged build's STRICT base — otherwise every
pre-wave drive would have been silently policy-denied. Distinct from two neighbours that still fail
CLOSED: a value that is present but not a boolean falls back to the base, and a MALFORMED file never
reaches the merge at all (`parsePolicy` returns the base, the M-4 rule).
**Renderer surfaces (local-api wave P4).** `AppStatus.localApi?: LocalApiStatus | null` —
additive + optional (the `translationDevice` shape), read live off `ctx.localApi?.status()`;
null when no server object exists. `LocalApiStatus` = `{ running, port, tokenRequired,
requestsServed, rejectedCount, lastError, externalActive, lastPreemptedAt }` — **counts and
flags only**, nothing that could describe a caller or a prompt (D1); `externalActive` +
`lastPreemptedAt` (epoch ms of the last D8 pre-emption) exist so the Settings card raises its
concurrent-use warning only while it is TRUE, not permanently. Three IPC channels carry the
access key, and nothing else does: `localApi:getConnectionInfo` →
`LocalApiConnectionInfo { serverAddress, maskedKey }` (`hr-…abcd` — the full key never crosses
IPC), `localApi:copyKey` → boolean (Electron `clipboard` write MAIN-side + a best-effort clear
after 60 s if the clipboard still holds it), `localApi:regenerateToken` →
`LocalApiConnectionInfo` (rotates AND calls `LocalApiServer.abortExternalRequests`, because
auth is checked once at admission — SEC-F6). All three refuse via `workspaceAdmitsWork`.
`localApiServerAddress(port)` and `MIN/MAX_LOCAL_API_PORT` live in `shared/local-api.ts` so the
card, the write gate, and the docs cannot disagree about the pasteable URL or the clamp.
✅ **IPC** `src/main/ipc/registerModelIpc.ts` — `listModels(lazyVerify?: boolean)` (#138 D-7:
the RT-3 param — `true` hashes only the active model on a cold cache. Since #382 every routine
caller passes it: the gate-into-chat path, the Performance screen and an ordinary Models-screen
visit. It is omitted — hashing the full set — only by the Models screen's explicit "Check all
model files" action), `selectModel`, `startRuntime`,
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
`messages.pack_outcomes_json` (#301 P4, findings M6/M7) is additive and null on every
pre-P4 row and every message with no knowledge pack in scope — see "Knowledge packs"
below for the shape and the whitelist that parses it.
`messages.truncated_cause` (#498) is additive and nullable: `'context' | 'cap' | 'repeat'` next to
`messages.truncated`, surfaced as `Message.truncatedCause` (`TruncationCause`) and written
only alongside `truncated: true`. NULL on every complete reply and every pre-#498 row — a
truncated legacy row reads back as `'context'`, the flag's historical meaning — and it is
carried verbatim through the regenerate delete/restore snapshot (`DeletedMessage`).
`'repeat'` (#994, follow-ups wave 7) marks a whole-document answer the app stopped because it kept
repeating itself ([`rag-design.md`](rag-design.md) §14.10). An app older than that release reads it
as an unknown value, so as `'context'`: its tooltip then advises a larger context, a harmless
setting hint on a rare answer.
`messages.ended_early` (#600) is additive and nullable: `'model' | 'user' | 'lock'` (`EndedEarly`),
surfaced as `Message.endedEarly`: `'model'` = the user stopped or switched the chat model mid-turn
(#600), `'user'` = the chat's Stop button, `'lock'` = "Lock now" or quit (both #612). On an assistant
row the partial was cut ("Reply stopped"; stamped by `persistAssistantMessage` from the turn's abort
reason, `endedEarlyCause` in `chat/ended-early.ts` — a bare abort carries no cause — and never on a
row with `truncated` set, #742: the two flags do not share a row); on a
user row the question got no answer (`markUnansweredQuestion`, last visible row only). Its OWN column,
never a `truncated_cause` value — an older app reads an unknown cause as "raise the context size" and
ignores this column. Unknown values read back as undefined; carried verbatim through `DeletedMessage`.
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
reply is persisted (marked `endedEarly: 'user'`, #612; a turn with no answer yet marks its question
`'user'`), a normal `done` fires. "Lock now" and quit abort the same way with `'lock'`; a re-ask they
cut restores its predecessor, as a model stop does below (#612).
**Model stop or switch mid-turn (#600, additive — channel shape unchanged):** the runtime's
model-stop hook aborts every in-flight turn with `endedEarlyAbortReason('model')` BEFORE the sidecar is killed,
so the turn ends exactly like a Stop (`done`, partial persisted) — the partial carries
`endedEarly: 'model'`, a re-ask whose saved answer carries that marker restores its predecessor
instead (one transaction; a complete answer saved before the stop landed stays), and a turn with no
answer marks its question. A sidecar that DIES under a turn instead (crash, OS kill) rejects with
`RuntimeConnectionLostError` → `chat:error:<id>` with the friendly `main.chat.connectionLost` copy; its
partial is not persisted (the F-02 rule).
**Mid-stream runtime failure (audit 2026-07-16 F-02, additive — channel shape unchanged):** an
in-band SSE error frame from the runtime rejects the stream (`ChatStreamError`) instead of
ending it cleanly, so a partial can never persist as a complete answer; it reaches the renderer
on `chat:error:<id>` as the friendly localized `main.chat.streamError` copy (still an error
string). The structural server reason goes to the local log only — never to the renderer.
**Regenerate:** `sendChatMessage` with `options.regenerate = true` deletes the last assistant
message and re-streams from existing history (no new user turn).
**What `done` carries when a re-ask ends with no new answer (#779, additive — channel shape unchanged):**
the previous answer is restored, and `done` (and the invoke's resolved value) is that restored `Message`
— for a Stop before the first token (CB-2) and for an abort thrown before anything streamed (a Stop,
model stop, lock or quit during document search, the reranker, a knowledge-pack arm or the
categorizer). A non-abort failure restores it too but stays an error (`chat:error:<id>`, the invoke
rejects). One documented twin carries an empty `Message` instead: a Stop while the re-ask is still parked
waiting for the chat slot behind a deep-index build. Nothing was deleted then, so the previous answer
stands untouched; the renderer re-lists the conversation after the invoke resolves and does not read the
`done` payload (it never subscribes to `onDone`).
**Send again (#613, additive):** `sendChatMessage(conversationId, '', { resendMessageId })` and
`askDocuments(conversationId, '', skillInstallId, false, pinnedDocumentId, resendMessageId)` answer the
conversation's unanswered last question: the user turn with that id, which must still be the last visible
message (else `main.chat.nothingToResend`, nothing streamed or written). No user turn is appended and
nothing is deleted; `regenerate` wins when both are set. The attempt clears that question's
`ended_early` when it starts (slot held) and sets it again if it too ends early.
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
templates — verified on b9585, and on the b11146 pin: `reasoning_content` deltas, no `<think>` in
content, #512). Chat sidecars spawn with **`CHAT_SERVER_ARGS` = `--jinja --reasoning-format
deepseek -lv 4 -np 1`** (the first two pin the mechanism's preconditions; `-lv 4` prints the
load log the placement parser reads; `-np 1` = one server slot, #319; chat only — the embedder,
reranker, translation and vision sidecars keep their own args). Reasoning streams as
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
✅ **Kit bundled set (#766):** manifest `bundled_on_preconfigured_drive` →
`ModelManifest.bundledOnPreconfiguredDrive` (optional boolean, default false; a non-boolean is a
validation error). Read only by the sell gate (`assertCommercialDrive`) and, flat, by the scripts
(`fetch-models --bundled`, `verify-models --kit`, the builder's license pre-flight). The app never
reads it at runtime.
✅ **Speculative decoding (#182):** manifest `speculative_decoding` (closed enum, today only
`mtp`, chat role only) → `ModelManifest.speculativeDecoding` → `RuntimeStartOptions
.speculativeDecoding` (supplied by `startModelRuntime`, explicit `null` when absent) → the start
ladder's **rung 1a**, which spawns with `CHAT_SERVER_ARGS` + `MTP_SERVER_ARGS` = `--spec-type
draft-mtp --spec-draft-n-max 2`. The manifest names a scheme and NEVER supplies arguments (the
flag list is code-owned; extras are appended last in `buildArgs`, so a free-form field could
override `--host`). The ladder gates the rung on the budget device (`primaryUsefulDevice`) having
the weight's bytes + `MTP_VRAM_HEADROOM_MB` free, and forced-CPU rungs never carry the flags. Design record:
`architecture.md` "MTP speculative decoding".
✅ **Prompt cache (#512; replaces the #399 D5 family gate):** manifest `disable_prompt_cache`
(optional boolean, default false = cache on; chat role only; a non-boolean or another role is a
validation error) → `ModelManifest.disablePromptCache?: true` (ABSENT unless true) →
`RuntimeStartOptions.disablePromptCache` (supplied by `startModelRuntime` as an explicit boolean) →
the chat argv builder (`LlamaRuntime`), which appends exactly ONE `--cache-ram` after
`CHAT_SERVER_ARGS` and before the rung args: `0` when the field is true, else
`min(8192, floor(total RAM MiB / 8))` from `os.totalmem()` (`shared/prompt-cache-rules.ts`,
`promptCacheServerArgs`). The manifest states a fact and never supplies the flag. Chat only — the
embedder, reranker, translation and vision sidecars pass no `--cache-ram`. `RuntimeStartOptions.family`
(the #399 gate's input) is gone. An older app ignores the unknown key, i.e. keeps the cache on.
✅ **Graphics-memory cache term (PR #308 audit decision 11, 2026-09-06):** manifest
`estimated_context_cache_gib` (optional; a number ≥ 0 — wrong type or a negative value is a
validation error, never a silent default) → `ModelManifest.estimatedContextCacheGib?: number`
(ABSENT when omitted; the 0.5 GiB default is the picker's, `VRAM_DEFAULT_CONTEXT_CACHE_GIB`). It is
the per-model context-cache term of `estimateGraphicsNeedMib` (services/models.ts, §6.6 rule C):
the cache the runtime allocates at the model's recommended window under the app's launch (ubatch
2048, and — since the 2026-09-07 `-np 1` decision on issue #319 — **ONE server slot**, not b9849's
four unified ones). Carried by exactly the seven decision models (Gemma 4 12B 2.4, 26B-A4B **0.8**,
E2B 0.1, Qwen3.8 27B UD-Q4/Q5 **0.9**, Qwen3.5 9B **0.3**, 4B **0.2**), the Qwen3.5 9B UD-Q3_K_XL
sibling's 0.3 (2026-11-20: same architecture, and the f16 cache does not depend on the weight
quantization) and TranslateGemma's measured
0.75 for its sidecar's headroom gate (#473); all nine are pinned in `committed-catalog.test.ts`; the
GGUF-header estimate (BUILD_STATE §5 item 22 (e)) retires it.
Six are DERIVED from the launch config; the 26B-A4B's is MEASURED off its first hardware start
(#412, 2026-09-08 — the derived 1.5 it replaced was 2.02× the 760.00 MiB the start logged).
✅ **Host-mapped weight share (#321, owner decision 2026-09-07):** manifest
`host_mapped_weights_mib` (optional; a number ≥ 0, validated exactly like the cache term above —
wrong type or a negative value is an error, never a silent default) →
`ModelManifest.hostMappedWeightsMib?: number` (ABSENT when omitted, and `estimateGraphicsNeedMib`
then charges the whole file to the card — the conservative direction). The weights that stay
HOST-mapped even on a FULL offload — the embedding/output tables — which the estimate subtracts from
BOTH the weights term and the 15 % working share, because neither the weights nor the buffers that
share stands for are on the card (§5 item 22 (e), 2026-09-08; #321 subtracted them from the share
only, which closed 323 MiB of the E2B's 2,748 MiB over-estimate while 2,152.50 stayed). MEASURED
per model, not derived: the app has no GGUF-header parser, so each figure is read off the
`CPU_Mapped model buffer size` line of a full-offload start under `eval/results/hardware/` (a
PARTIAL offload inflates that line with the layers that did not fit — the 9B logs 545.62 MiB at
33/33 but 824.31 at 31/33). Carried by the five models started for #318 (E2B 2,152.50, 9B 545.62,
Gemma 12B 787.50, 27B UD-Q4 682.03, UD-Q5 682.03) and, since the #391 hardware round of 2026-09-08,
by the last two as well (4B 497.31 off a 33/33 start, MoE 26B 577.50 off a 31/31 one). Those seven,
plus TranslateGemma's 787.69 (#473), are pinned in `committed-catalog.test.ts`; the seven include all
five rank-3 models, so **every model rule C can ever star carries a measured figure**. They are NOT every ranked manifest: 8 of the 15 carry none
and keep the whole file as their base — the "absent" branch below is a live case, reached by the
"Your model" estimate for a model the user installs by hand, not merely a rule for future
manifests. The
GGUF-header derivation that would have covered models never started is RETIRED (the picker judges
models the user has not downloaded, so the number has to travel in the catalog); what stays open
under BUILD_STATE §5 item 22 (e) is narrower — nothing recomputes the field when a manifest's
weights change.
**How the slot count enters the term** (§6.6 point 4, measured on the pin): the KV cache — and
Gemma's sliding-window cache — is sized in CELLS from `--ctx-size` and is counted **once** whatever
the slot count is; only the **recurrent state** is per-sequence, so `-np 1` divides just that share
by four. Hence the three Gemma terms did not move at all and the four Qwen ones did. The two 27B
figures use the MTP recurrent state (both opt into `speculative_decoding`); that does not
double-count `MTP_VRAM_HEADROOM_MB`, which gates whether rung 1a is *attempted* and covers the draft
head's own weights + KV.
✅ **Processor-path rank and step-down (2026-11-20, `model-benchmarks.md` §6.7):** manifest
`recommendation_rank_cpu` (optional; a number ≥ 0 — a wrong type or a negative value is a
validation error, never a silent default, because the field moves a recommendation) →
`ModelManifest.recommendationRankCpu?: number`, and manifest `step_down_to` (optional; a
non-empty model id, trimmed; any other type or an empty string is an error; called
`cpu_step_down_to` until §6.8 made the card path follow it too) →
`ModelManifest.stepDownTo?: string`. Both are ABSENT when omitted. The rank is read only by
`recommendModelIdForProcessor` (services/models.ts), which `recommendChatModelId` reaches for
memory class `cpu`: it replaces `recommendation_rank` there (0 = selectable but never the
automatic pick on a processor; absent = the ordinary rank). `step_down_to` names the chat
model that a benchmark under `SLOW_PICK_TOKENS_PER_SECOND` on this one steps to (absent = the end
of its chain), on the processor and, since §6.8, on a card that carries card ranks; each path
follows a link only to a target it may pick. The validator does not resolve the target id. The
committed values and the chain invariants (every target exists, is ranked on the processor, needs
no more RAM than its source, and no chain loops) are pinned in `committed-catalog.test.ts` ("§6.7
processor path"). An older app ignores both keys and gives the RAM pick.
✅ **Card-path rank and measured need (2026-11-20, `model-benchmarks.md` §6.8):** manifest
`recommendation_rank_gpu` (optional; a number ≥ 0, validated like `recommendation_rank_cpu`) →
`ModelManifest.recommendationRankGpu?: number`, and manifest `projected_graphics_need_mib`
(optional; a number ≥ 0, validated the same way; 0 is a figure, not "absent") →
`ModelManifest.projectedGraphicsNeedMib?: number`. Both are ABSENT when omitted. When ANY chat
manifest carries `recommendation_rank_gpu`, `recommendModelIdByVram` ranks by it (absent = the
ordinary rank) and picks the highest-ranked model that fits the card outright, so §6.6 decision 2
does not apply to such a catalog. `projected_graphics_need_mib` is llama.cpp's own fit projection
("projected to use N MiB of device memory") read off a full-offload start under the app's launch
(the manifest's context, `-np 1`, batch and ubatch 2048, its speculative decoding). Where present,
`estimateGraphicsNeedMib` returns it plus `VRAM_FIT_MARGIN_MIB` (1,024) and the derived terms
(weights, `host_mapped_weights_mib`, `estimated_context_cache_gib`) do not enter. That moves the
picker's fit and the Performance screen's pre-start estimate for a discrete card. The sidecar gates'
`chatGraphicsShareMib` does not read it. Every value is pinned to its row of
`eval/results/hardware/i9-9900x-rtx-3090-24gb-128gb/projected-graphics-need-b12110-20261120.tsv`,
and every model the card path can pick must carry one (`committed-catalog.test.ts`). A pin bump
re-reads them. An older app ignores both keys and keeps rule C on the derived estimate.

### Document ingestion (Phase 4 live)
✅ **`services/ingestion/`** (spec §7.7). Full detail in [`docs/rag-design.md`](rag-design.md).
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
  approximation** (`approxTokenCount`: 1 whitespace word ≈ 1 token, a space-less-script character ≈ 1
  token, a word over 16 characters `ceil(len / 4)`). Windows step by
  `size − overlap`, overlap clamped `< size`, no chunk crosses a segment boundary (so each chunk
  has exactly one `pageNumber`/`sectionLabel`), global cap at `maxChunks`.
- **`index.ts`** — lifecycle + persistence. `createQueuedDocument`, `processDocument` (never
  throws: failures → `failed` + `error_message`), `reindexDocument`, `listDocuments`,
  `getDocument`, `deleteDocument`, `expandPathsWithSource` (the async walk the import runs, #274;
  the synchronous `expandPaths` is the tests' reference walk, #687), `documentsDir`. Statuses
  `queued→extracting→chunking→embedding→indexed` (+`failed`/`deleted`); `embedding` writes the
  vectors (Phase 5).
- **DB:** `documents` (status, `original_path`, `stored_path`, `sha256`, `mime_type`,
  `size_bytes`) + `chunks` (`chunk_index`, `text`, `source_label` = document title,
  `page_number`, `section_label`, `token_count`). `chunkCount` is computed per `listDocuments`.
- **Types:** `DocumentInfo`, `ImportJob`, `ImportJobStatus`, `IngestionStatus` (already in
  `shared/types.ts`) filled to match.

### Document storage + import model (LOCKED — Phase 4)
- **Stored copy.** Imports are **copied into `workspace/documents/<id><ext>`** (`stored_path`);
  `original_path` is also kept. `<ext>` is the extension of the document's `title`, which is the
  file name without trailing spaces, and without trailing dots when a supported extension is then
  left (#918: `report.pdf.` → `report.pdf`, "Washington, D.C." unchanged); the parser, the MIME
  type and the export names read the same title. Self-contained drive: re-index re-parses the stored copy; delete
  removes the stored copy + chunks + embeddings + row (never the original).
- **Async-with-polling.** `importDocuments(paths, options?: ImportOptions)` (#138 D-7: `options`
  carries `destination` — `{ kind: 'conversation', conversationId }` files a chat attachment —
  and `pickerToken`, the D1 capability below) expands the selection, inserts `queued` rows,
  returns `{ jobId, documentIds }`, then ingests **sequentially in the background**. The
  `documents` table is the per-file source of truth (survives restart); the `ImportJobStatus`
  aggregate is **in-memory** in `registerDocsIpc.ts`, read via `getImportJob(jobId)` (unknown job
  → `done:true` so pollers stop). The **Documents screen** polls `getImportJob` + `listDocuments`
  every 400 ms while a job runs. No streaming channel is used (ingestion progress is coarse).
- **Picker.** `pickDocuments('files' | 'folder')` opens the OS dialog in **main**
  (renderer has no dialog access); Windows can't mix file+dir selection, hence the mode.
  **#138 (D-7):** it returns `PickDocumentsResult` — `{ paths, token }` where `token` is the
  ONE-TIME picker capability (vuln-scan D1): `importDocuments` resolves a picker import from
  the token main-side and ignores renderer-supplied paths for that flow.
- **Mount re-attach (#141/DOC-1).** `getActiveImportJob(): Promise<ImportJobStatus | null>` —
  parameterless read of the in-flight import (at most one runs), so the Documents screen
  re-attaches its progress poll on mount (the `getReindexAllJob` recovery pattern).
- **Documents screen** (`renderer/screens/DocumentsScreen.tsx`): import files/folder, per-file
  status badge + chunk count + size, error surfacing, delete + re-index.

### Embeddings + vector search (Phase 5 live)
✅ **`services/embeddings/`** (spec §6, §7.8, §9.2). Full detail in [`docs/rag-design.md`](rag-design.md) §6.
- **`index.ts`** — `Embedder` interface (`id`, `dimensions`, `embed(texts) =>
  Promise<Float32Array[]>` — L2-normalized, one per input); `encodeVector`/`decodeVector`
  (Float32 ↔ BLOB; decode copies to a 4-byte-aligned buffer); `cosineSimilarity`; and the
  `VectorIndex` class (`search(queryVector, topK)` linear-scan cosine → `{ chunkId, score }[]`
  sorted desc, dimension-mismatched rows skipped; `searchText(query, topK)` embeds then searches).
- **`mock.ts`** — `MockEmbedder` (`createMockEmbedder`): deterministic feature-hashing vectors
  (SHA-256 tokens → signed buckets → L2-normalize), zero network. `MOCK_EMBEDDING_DIMENSIONS =
  384`, `MOCK_EMBEDDING_MODEL_ID = 'mock-embedder'`.
- **Ingestion wiring:** `processDocument`/`reindexDocument` accept `IngestionDeps
  { embedder? }`; the `embedding` step embeds all chunks in one batch and inserts `embeddings`
  rows tagged with `embedder.id`. `registerDocsIpc` passes `ctx.embedder` only (since rag-design
  §10 it no longer passes the `activeEmbeddingModelId` setting into ingestion; the
  `embeddingModelId` override no production caller set was removed by #660). **`AppContext` now
  carries `embedder`** (created in `main/index.ts`).
- **`embeddings` table** (spec §8, already existed): `chunk_id` PK, `embedding_model_id`,
  `vector_blob` (raw Float32 bytes), `dimensions`, `created_at`. No new IPC (askDocuments = Phase 6).

### RAG chat with citations (Phase 6 live)
✅ **`services/rag/index.ts`** (spec §7.6, §7.8). Full detail in [`docs/rag-design.md`](rag-design.md) §8.
- **`retrieve(db, embedder, question, settings)`** → `{ chunks: RetrievedChunk[], citations:
  Citation[] }`. Embeds the question, `VectorIndex.searchText(topKInitial)`, joins hits →
  `chunks`, drops `< minSimilarity`, **dedups by `(document_id, page_number)`** (page-less
  chunks keyed by chunk id), trims to `topKFinal` under `maxContextTokens` (chunker's
  `approxTokenCount`; top chunk always kept), assigns `[S1]…` labels **per query (not
  stored)**.
- **`buildGroundedPrompt(question, chunks, skillFence?, truncation?, analysisBlock?)`** — pure;
  builds the grounded **user turn** only: `Question:` + the optional skill fence, partial-document
  notice and analysis block (the share-safe PII pre-scan) + `Document excerpts:` (numbered
  `[Sn] File: X | Page: 4` / `| Section: Y` + quoted text, the spec §7.8 source-context format,
  fenced by `EXCERPT_BEGIN` / `EXCERPT_END` + `EXCERPT_GUARD_LINE`, #228) + trailing `Answer:`.
  The rules are not in it: `GROUNDING_RULES` ride in the **system** message
  `GROUNDED_SYSTEM_PROMPT` = `BASE_SYSTEM_PROMPT` + `GROUNDING_RULES` (RT-2, so `cache_prompt`
  reuses them across turns). `buildGroundedChatMessages` sends that system prompt (grounded-data
  mode passes `GROUNDED_DATA_SYSTEM_PROMPT`) and replaces the **last user turn** with the
  grounded prompt.
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
- **Issue #80 (wave R80) — the per-answer actionable skill offer:** `Message` gained optional
  **`skillOffer?: SkillOffer`**, where `SkillOffer` = `SkillSuggestion` (installId + title) +
  a required **`source: 'deterministic' | 'classifier'`** provenance marker (`shared/types.ts`).
  Persisted as the additive nullable **`messages.skill_offer_json`** (STRUCTURAL only — id +
  title + provenance, never question/document text; tolerant parse — a malformed payload reads
  as "no offer"; since the #132/#135 fix it is part of the regenerate delete/restore snapshot —
  `DeletedMessage.skillOfferJson` — so the F2/CB-2 restore legs keep the offer). Written by `askDocuments` on exactly two decision classes: the deterministic
  #54 amount-aggregation offer, and the bounded single-shot D55 grammar classification
  (`services/analysis/classify.ts` — enum of gated skill ids + mandatory `none`; every fault
  degrades to NULL). Undefined on user turns, ordinary answers, and pre-migration rows — an
  older app ignores the column. The renderer's accept action re-runs the turn through the
  EXISTING regenerate path (`askDocuments(conversationId, '', installId, true)`) — no new IPC
  channel. **#138 (D-7): the full live signature is**
  `askDocuments(conversationId, question, skillInstallId?: string | null, regenerate?: boolean,
  pinnedDocumentId?: string | null)` — the 5th param (U3/ux-6) pins a documents answer to ONE
  in-scope document (the routed-run relay passes the run's target); main re-validates it
  against the resolved scope. The composer-picker `SkillSuggestion` contract itself is byte-unchanged.

### Hardware benchmark + recommendation (Phase 7 live)
✅ **`services/benchmark.ts`** (spec §7.3, §11). Full detail in [`docs/benchmark.md`](benchmark.md).
- **`detectSystem()`** (`node:os`) → `{ os, arch, cpuModel, cpuCores, ramGb, gpu }`; never
  throws (failed probe → `''`/`0`); `detectSystem` itself always reports `gpu: null` — the
  REAL probe lives in `runtime/gpu.ts` and is **injected** by the IPC layer (Phase 16:
  `RunBenchmarkDeps.gpu: { name, useful, totalMb?, budgetMb?, memoryClass?, card? }`), keeping this module
  `child_process`-free. `name` / `totalMb` are the **budget device's** (`nextStartMemory` in
  `services/performance.ts`, PR #308 audit decisions 6/9); `totalMb` is the graphics TILE's figure
  (→ `BenchmarkResult.gpuVramMb`), never the picker's input. **`budgetMb`** (P3, decision 10) is
  the picker's input: `graphicsBudgetMib(device)` = the probe's `freeMb`, else `totalMb − 1024`
  (`GRAPHICS_IDLE_ALLOWANCE_MIB`), raw MiB; absent/null → the RAM pick. `useful` and `memoryClass`
  answer different questions: `useful` = `gpuUsefulForProfile` over ALL probed devices (the hardware
  carries a usable card; the profile bump), `memoryClass` = the NEXT start's class (honours
  `gpuMode` / `gpuAutoDisabled`, names one budget device), so `{ useful: true, memoryClass: 'cpu' }`
  is a valid input — a card present, the GPU switched off.
- **`PickerMemory`** (`services/models.ts`) — `{ memoryClass, ramGb, budgetMb: number | null, card?: CardEvidence | null }`,
  the input of `recommendChatModelId(manifests, memory, speedSignal?)`: `discrete` with a positive
  `budgetMb` → **the card path, §6.6 rule C as amended by §6.8**
  (`recommendModelIdByVram(manifests, budgetMib, ramGb, role, signal, card)`): eligible(m) =
  `fitsGraphicsMemory(m, budgetMib)` — `estimateGraphicsNeedMib(m)` = the manifest's
  `projectedGraphicsNeedMib` + 1,024 where it carries one (§6.8; every model the card path can pick
  does), else the derived (unrounded weights MiB − `hostMappedWeightsMib` ?? 0) × 1.15 +
  (`estimatedContextCacheGib` ?? 0.5) × 1024 + 1,024, whose OFFLOADABLE weights carry both the base
  and the 15 % working share (§5 item 22 (e), 2026-09-08) and whose cache term is computed for the
  app's ONE server slot since #319 — AND `recommendedMinRamGb ≤ ramGb` AND not
  `landedPartlyOnCard(m, budgetMib, card)` (a stored start of the model on this card with layers
  left off, at a context no larger than `launchContextTokens` gives the next start, with at least the
  present budget free then, within `PARTIAL_EVIDENCE_TOLERANCE_MIB` = 256). With card ranks in the
  catalog (`recommendationRankGpu` replaces `recommendationRank`) the pick is the highest-ranked
  eligible model outright; without them the RAM pick stands where it is eligible (decision 2), else
  the highest-RANKED eligible model; ties by tier then size, ranked-only guard, else the RAM pick of
  the ordinary ranks (partial-offload fallback). A slow reading then moves it once inside the
  eligible pool: with card ranks along the `stepDownTo` chain first, else (or off the chain) the
  §6.5 step. `card` is `cardEvidenceFor(settings, machineKey)` at every seam: the stored
  `modelPlacements` of this machine (and unstamped ones) plus the two context settings.
  `cpu` → **§6.7 the processor path**
  (`recommendModelIdForProcessor(manifests, ramGb, signal)`: the RAM stages over a view in which
  `recommendationRankCpu` replaces `recommendationRank`, then a slow reading follows the pick's
  `stepDownTo` chain, and one off the chain is §6.5; a catalog without either field gives
  exactly the RAM pick); `unified`, or `discrete` with no budget → the RAM pick,
  byte-identical to `recommendModelIdByRam`. Both seams build it from ONE decision: `pickerMemoryFor(s)`
  (registerModelIpc → `BuildModelListOptions.memoryClass` / `.graphicsBudgetMb` / `.cardEvidence`) and
  `probeAndPersistGpu` (→ `GpuBenchmarkInput.budgetMb` / `.card`), each calling `graphicsBudgetMib` on
  `nextStartMemory`'s device. `weightsMib(m)` is the shared unrounded GB → MiB conversion the
  Performance pre-start estimate reuses (decision 8). The committed grid, thresholds and the nine
  cache terms are pinned in `committed-catalog.test.ts` ("§6.6 rule C").
- **`classifyProfile(ramGb, { tokensPerSecond?, gpuUseful? })`** — pure; spec §11.3
  thresholds + the conservative Phase-16 GPU bump (`gpuUseful` is precomputed by
  `gpuUsefulForProfile`: ≥ `USABLE_VRAM_MB`, 5120 MiB since #321, AND not integrated) + low-tok/sec downgrade; invalid
  RAM → `UNKNOWN`.
- **`measureDriveSpeed(workspacePath)`** → `{ readMbps, writeMbps, error? }`; 8 MB temp file
  written **inside the workspace**, timed write(`fsync`)+read, **always cleaned up**, failure
  → `null` + `error`. `writeMbps` is the honest probe figure; `readMbps` is **page-cached** (RAM
  speed, not the drive — audit 2026-07-16 F-35), since #108 **retired from display** and never a
  gate input; still computed + persisted for continuity. See `docs/benchmark.md`.
- **`EffectiveReadSample`** (`shared/types.ts`, issues #108/#110/#107) —
  `{ mbps, bytes, ms, source: 'model_load' | 'checksum', modelId, at }`: an honest read sample
  measured as a byproduct of real multi-GB reads (`services/read-speed.ts` session latch).
  Honesty guards (adversarial-review round 2026-08-09): sample floors ≥ 64 MB / ≥ 250 ms, plus
  ≥ 2 GiB for `model_load` (parse/KV-alloc/graph-init fixed costs must not dominate the window);
  the source ranking (`preferCandidate` — `model_load` beats `checksum`, else newest wins; except
  that since **#404** a media-bound `checksum`, one under 100 MB/s, displaces a `model_load` and
  is not displaced by one, `benchmark.md` §6.3) is ONE
  exported rule applied by the latch, by persistence, and by the latch-vs-persisted resolution
  (`effectiveReadOrPersisted`), so a fresh session's ordinary checksum sample never overwrites last
  session's model-load sample; `'download'`-labelled hashes never sample (they read bytes the app
  just wrote — page-cache-resident, the F-35 class); a start whose install-state pass really
  hashed suppresses its own load-window sample (`suppressNextModelLoadSample` — the hash warmed
  the cache), and since **#392** (2026-09-08) so does a start over a weight hashed ANYWHERE in the
  session: `recordChecksumRead` takes the hashed absolute path and `recordModelLoadRead` drops a
  sample whose file set intersects the paths remembered for this process (main-process lifetime,
  never cleared on a workspace lock — the page cache is OS-level; a process restart is the
  pre-existing boundary). The #114 prefetch skip stays on the one-shot flag only. The shape of
  `EffectiveReadSample` is unchanged — this is a recording rule, not a field.
  Persisted as **`BenchmarkResult.effectiveRead?: EffectiveReadSample | null`** —
  optional (absent on results persisted before the field existed; `null` = nothing measured
  yet) — written by `persistEffectiveRead` (registerModelIpc), which is registered as the
  read-speed OBSERVER (fires on every accepted sample, so a background download path persists
  too) and **also re-keys the slow-read warning in place** (`upsertSlowReadWarning`): the only
  automatic benchmark runs before any model exists, so the #110 warning must track the sample
  between benchmark runs — and is removed again when a fast sample lands. Since the PR #303
  audit (M2/L2/M6) the persisted sample is **identity-gated**: it is written to, and carried
  forward from, results of THIS machine only — `lastBenchmark` when its `machineKey` is this
  machine's or unknown on either side (G3: compatibility, not provenance; an unkeyed result
  never gets a fabricated key or a history entry) **and** this machine's `benchmarkHistory`
  entry, each compared separately (`services/benchmark-persistence.ts`); a foreign headline is
  never touched, and with no eligible destination the sample stays un-handled for a later retry.
  `ranAt` is unchanged by a sample-only update. Injected into `runBenchmark` via
  `RunBenchmarkDeps.effectiveRead` (identity-gated, ranking-aware carry-forward) and
  re-resolved after the run so a sample landing mid-run is folded in, never overwritten. Feeds
  the Diagnostics "Measured read speed" row (which carries the sample's own date — the card's
  "Last run" describes the benchmark, not this row), the #110 gate, and the #107 estimate.
- **`measureTokensPerSecond(runtime)`** → `SpeedReading | null` (only when a runtime is
  active; the paragraph prompt under a 64-token cap). Since #291: `{ tokensPerSecond, basis,
  tokens }` — `basis: 'timings'` is llama-server's own `predicted_per_second` (decode only,
  prefill excluded, tokens not chunks) over `tokens = predicted_n`; `basis: 'chunks'` is the
  wall-clock chunk-count fallback for a runtime without `timings` (the mock), over `tokens`
  streamed chunks. Persisted as **`BenchmarkResult.speedBasis?: { basis, tokens } | null`** —
  optional (absent on results persisted before the field existed, which were all chunk-based and
  render as approximate; `null` = nothing measured). No migration. Beside it, since issue #322
  (2026-09-06, §6.5 amendment, owner-confirmed),
  **`BenchmarkResult.speedIdentity?: SpeedSampleIdentity | null`** = `{ memoryClass, deviceName,
  contextTokens, backend }`: the NEXT-start class and budget device at benchmark time
  (`GpuBenchmarkInput.memoryClass` / `.name`), the running model's launched window
  (`ModelRuntime.contextWindow`) and its rung (`ModelRuntime.backend`) — each of the last three
  null when unknown; normalised by `normalizeSpeedIdentity` (an unknown class nulls the record;
  absence stays absent; `null` = nothing measured). `speedSignalFor(s)` →
  `sampleCountsForNextStart(identity, nextStartMemoryFor(s, machineKey(detectSystem())))` hands the picker a sample
  that carries an identity only when the next start runs on a path NO FASTER than the measured
  one (§6.5 "Sample identity"): a card measurement counts for the same card and for a processor
  start; a processor measurement counts for a processor start only; a different card and the
  mock never count; the context is recorded, not matched; a legacy sample without the field
  steers as before.
- **`buildWarnings(...)`** — spec §11.4 friendly copy. Since #110 the PRIMARY drive warning is
  the interpolated slow-read note (`effectiveReadMbps < SLOW_EFFECTIVE_READ_MBPS = 100`; no
  sample → no warning); the write-keyed slow-drive note (`< SLOW_DRIVE_MBPS = 30`) stays as the
  secondary broken-media check with unchanged copy. Warnings warn, never block. Preflight feeds
  probe figures only and binds its note by exact canonical-English match.
- **`runBenchmark(deps)`** → `BenchmarkResult` (the existing `shared/types.ts` shape):
  detection + drive + optional tokens/sec + `classifyProfile` + `recommendChatModelId` + warnings +
  the injected `effectiveRead`.
- **`ipc/registerBenchmarkIpc.ts`** — `runBenchmark()` (`benchmark:run`); runs it, persists to
  `settings.lastBenchmark` + `settings.benchmarkHistory`, returns the result, and streams
  `benchmark:progress` (`BenchmarkProgressStep`) to the requesting window (so the Performance
  screen draws a step list only for a run IT started; any other held span gets one announced
  background line instead — #438, `benchmark.md` "An automatic run's step list") — a step only when it
  succeeded (`'drive'` only on a successful probe, `'speed'` only on an obtained reading,
  `'done'` always, and `'done'` PRECEDES the persist and the occupancy release). `performance:get`
  returns the `PerformanceSnapshot` the Performance screen renders (`current`,
  **`recommendation: LiveRecommendation | null`** = `{ modelId: string | null; basis: MemoryClass }`
  — the LIVE chat pick for the next start (PR #308 audit decision 8), computed by
  `liveChatRecommendation(settings, manifests)` in registerModelIpc.ts from the same inputs the
  `listModels` handler feeds `buildModelList`: `pickerMemoryFor(s)`, `machineRamGb()`,
  `speedSignalFor(s)` (the persisted `{ tokensPerSecond, measuredModelId }` pairing, handed over
  only when its `speedIdentity` describes a path no slower than the next start's, #322; the
  handler calls the same function), `basis` = the memory class the pick was judged against; null only
  without a catalog; `current.recommendedModelId` is the historical figure and is never rewritten —,
  `currentMachine`,
  `currentGpu` — the budget device for the next start, `{ name, totalMb, useful }` or null, the same
  device `BenchmarkResult.gpu` and the `listModels` ★ go by, never `settings.gpuProbe.devices[0]` —,
  `graphicsDevice` — the device the graphics TILE names, `{ name, totalMb, useful }` or null
  (`displayDevice` over the same eligible probe): a superset of `currentGpu` — equal to it when a
  usable card exists, else the largest device that does not look integrated even when it is under
  the usable gate (the 6 GB laptop card Vulkan reports at 5,9xx MiB, #321), else the integrated
  device; null in the SAME cases as `currentGpu` (no eligible probe, no device in it, GPU switched
  off / auto-disabled), so the tile's "acceleration is off" copy stands. Whether the card is USED
  is `currentGpu`'s question, never this field's (owner decision 2026-09-07) —,
  `otherMachines`, `running` (the `benchmark` occupancy span, read directly),
  `placement: { memoryClass, ramMb, vramMb, model, recommendedContextTokens, observed,
  observedMismatch, verdict, models: ResidentModelRow[], totals: { ramAllMb, bothOnCard,
  chatAndTranslationOnCard } }` (the
  pre-start `verdict` on a discrete card is `estimateGraphicsNeedMib(manifest) ≤
  graphicsBudgetMib(device)` — the picker's fit — with `needMb` = the unrounded weights and
  `budgetMb` = the card's total; `PlacementVerdictInput` in services/performance.ts carries
  `graphicsBudgetMb`, `manifest` and the base's `gpuName` for it),
  `observed: { lastAnswer, lastModelLoad, lastChecksum }`).
  **`benchmark:moved-drive-notice`** (§5 item 22 (a), 2026-09-08) returns
  **`MovedDriveNotice | null`** = `{ kind: 'restored'; ranAt: string } | { kind: 'measuring' } |
  { kind: 'owed' }` — what the moved-drive check did for THIS unlock session, for Home's notice.
  It is **session state, not settings**: after a restore, `lastBenchmark` is this machine's and
  nothing persisted distinguishes "restored just now" from an ordinary same-machine launch, so
  the memo is keyed like SD2's `attemptMemo` (workspace DB handle + unlock epoch) and a
  lock/unlock retires it. `restored` = this computer's stored entry was put back and **nothing
  was re-measured** (`ranAt` is that result's own date); `measuring` = a `new-machine` decision
  whose background measurement is under way (Home offers NO check for it); `owed` = that
  measurement ended in anything but a run. Null on a same-machine launch, a `first-run` on a
  fresh workspace (not a moved drive), a completed check, or a locked workspace. Nothing is
  written; the getter never throws. **P5 (M8 / DR1 / DR5), merged with
  PR #308 decisions 6/9**: `currentGpu` is `{ name, totalMb, useful } | null` — the ELIGIBLE
  probe's BUDGET device for the next start (`eligibleGpuProbe`, `shared/gpu-rules.ts`, then
  `nextStartMemoryFor` in services/performance.ts: the largest usable card, `useful` = the shared
  `isUsefulDevice` verdict on it; `name` and `totalMb` always describe one device; null with no
  eligible probe, no usable device, or the GPU switched off / auto-disabled — the screen never
  falls back to the raw settings probe, and reads `getSettings` for the two GPU flags only);
  `current` gets that device folded in (name and memory together) only for the current machine
  and only when it predates `gpuVramMb`; `placement.memoryClass` and `placement.vramMb` are the
  NEXT start's (`cpu` / null when the flags force the processor, whatever the probe lists — the
  same answer `pickerMemoryFor` gives the Models ★; on Apple Silicon the class stays `unified`
  there and only `vramMb` goes null, #746, so the class never says a start uses the GPU);
  `ResidentModelRow.device` is where a row
  runs under the CURRENT configuration (`'cpu'` for chat/translation when the next start uses no
  GPU, `nextStartUsesGpu` — no
  usable card, GPU off / auto-disabled — or when the matching observed start was on the CPU
  backend, or the translation sidecar's posture is `--device none`; **Wave 8 ruling (a)**: for
  the reranker role, `'gpu'`/`'cpu'` follows its own headroom gate against the RUNTIME's
  committed chat model, never `settings.activeModelId` — see `rag/device-posture.ts`);
  **#914 (owner decision G-5 (c))**: `ResidentModelRow.onDrive: boolean` is whether every file of
  the row's model is on this drive (`manifestFilesPresent`, presence only, no hash) — false for a
  catalog model that is not downloaded and for a row with no manifest (no model, or an active
  model outside the catalog); every non-chat row still names the catalog's model for its role
  (`pickManifestForRole`; images: the pick among the vision models on the drive, else the
  catalog's) whether or not it is on the drive, and the screen shows "not on this drive"
  (`perf.models.notOnDrive`) in place of "not loaded". **Loaded beats `onDrive`** (#914 code
  review): a row that is `loaded` (a weight deleted while the runtime holds it open, a manifest
  removed under a running model) says "loaded now" and counts in the total, whatever `onDrive`
  says. `placement.model.sizeOnDiskGb` and the chat row's `sizeOnDiskGb` are `number | null`: null
  for a model outside the catalog (it was `0`, shown as "0.0 GB"). `placement.model.onDrive:
  boolean` (#914 code review) is computed once in `buildPlacement`: the active model's files are on
  this drive, or the chat runtime holds it right now. When it is false, "Your model" uses
  `perf.model.lineNoSize` (no size on disk), states no verdict, note or "Choose a smaller model",
  and its pill says "not on this drive"; the renderer reads this field, never the chat row. On a
  `discrete` card the chat/translation line (`perf.models.card`) needs both models here (on the
  drive or loaded) with a size; with the chat model here and on the card but no translation model
  here, the chat-only line `perf.models.cardChat` keeps the card figure.
  **#933**: `ResidentModelRow.fileCheck: ModelFileVerdict` (`'ok' | 'damaged' | 'unverified'`) is what
  the checksum cache already knows about the row's files (`knownFileVerdict`, services/models.ts:
  synchronous, never a hash, over `checksumCacheView`, a read-only view of the snapshot's own
  `settings.checksumCache`, so the getter never writes settings): `damaged` = a live cached digest
  differs from the manifest's; `unverified` = a placeholder hash outside developer leniency
  (`developerLeniency`); `ok` otherwise, and for a row not on the drive. Unless the row is `loaded`
  (loaded beats it), a non-`ok` row reads `perf.models.damaged` / `perf.models.noChecksum` in place of
  "not loaded", adds nothing to `totals.ramAllMb` and is not added to a card line.
  `placement.model.fileCheck?: ModelFileVerdict` is the chat row's verdict, `'ok'` while the chat
  runtime holds the model; absent reads `'ok'`. Not `'ok'` → "Your model" states no verdict, note or
  "Choose a smaller model" (its line keeps the size on disk) and its pill says what its row says. The
  images row names the first vision candidate whose files are `ok` (as `getVisionStatus` passes over a
  refused one), else the first.
  `totals.ramAllMb` is class-aware (`loadedAtOnceMb`: every row on `cpu`; processor rows + the
  observed chat spill + the live translation spill + (Wave 8 ruling (d)) a `'gpu'`-posture
  reranker row contributing 0 on `discrete`; the full sum on `unified`, compared against the
  unified budget), on every class over the rows that are `loaded`, or `onDrive` with `fileCheck: 'ok'`
  (#933), only (null when no
  such row has a size, i.e. nothing installed; 0 when every counted row runs on the card, an
  estimated chat spill not counted; a small value is an observed small spill — the screen leaves
  the line out while it would read 0.0 GB), and `totals.bothOnCard` is true when two or more of
  chat, translation and the reranker are genuinely resident on the card — chat with an observed
  GPU start and at least one layer offloaded, translation live with layers on the card, the
  reranker `'gpu'`-postured and loaded.
  **#495 follow-up:** `totals.chatAndTranslationOnCard` is chat-and-translation specifically,
  never the reranker — it gates `perf.models.cardBoth`'s pair-naming sentence so that sentence
  stays true when the contending pair `bothOnCard` reports is chat+reranker or
  translation+reranker instead of chat+translation.
  The verdict is asked for the EFFECTIVE class (the next start's, and `cpu` when the flags force
  the processor or the observed start was CPU). Two `placement` fields were added by
  the PR #303 audit P4: **`recommendedContextTokens`** (`number | null`) is the context the
  RECOMMENDED model would launch with — the live `recommendation.modelId`, the model the screen's
  CTA starts, never the id saved with the check (PR #308 decision 8 on top of #303 M5) — resolved
  main-side by the launch path's own
  `launchContextTokens` — the screen used to recompute it with `??` and showed a "0-token context"
  for a manifest stating no window, while the runtime starts such a model on
  `settings.contextTokens` (M5 residual); **`observedMismatch`**
  (`{ contextTokens, backend, at } | null`) reports a stored/latched placement that is real but
  does not describe the current configuration (a different context size, or a GPU measurement
  under a forced-CPU configuration) — the record is kept, `observed` goes `null` so the row falls
  back to the weights-only ESTIMATE the current settings would actually produce (on a discrete
  card that estimate is the picker's fit above), and the copy
  dates the earlier measurement instead of presenting it as the fit.
  The observed figures are SESSION latches only — session = the main-process lifetime (they
  survive a workspace lock/unlock, an app restart clears them) — and never fall back to a
  persisted sample, foreign or same-machine (PR #303 audit M3/G2): the answer figures are never
  persisted; the read samples persist SEPARATELY into the benchmark records (`effectiveRead` on
  `lastBenchmark` and this machine's history entry) where the Drive tile reads them with their
  own source and date. Local-API answers never pass through the chat observer and never latch.
  Registered in `initBackend()`; exposed on preload `api.runBenchmark` / `api.getPerformance` /
  `api.onBenchmarkProgress` / `api.onPerformanceChanged`.
- **`EVENTS.performanceChanged`** (`performance:changed`, PR #303 audit G6) — a PAYLOAD-FREE
  main → renderer push to every live window: "something `performance:get` reads changed, re-read
  it". Emitted by `notifyPerformanceChanged()` (`ipc/performance-notify.ts`) only AFTER a
  mutation — a benchmark run taking / releasing its span (the release push, after the persist,
  is the idle signal; a busy-refused run emits nothing), every accepted read-speed sample
  (including a ranked loser), the answer latch, a placement observation, the restore / seed /
  backfill / GPU-probe writes (every `probeAndPersistGpu` write, the empty probe of a probe that
  could not run or threw included), chat-runtime transitions (`RuntimeManager.onChange`),
  resident-sidecar transitions (`onResidencyChange` on the embedder, reranker, translation and
  vision runtimes), a model download reaching `done` (#914, after the `onModelInstalled`
  selectors; the rows read which model files are on the drive), and the snapshot's settings keys
  (`PERFORMANCE_SETTINGS_KEYS`) — and never
  from a getter. The read stays gated; the event carries nothing to gate. Preload:
  `onPerformanceChanged(cb: () => void): () => void` (returns the unsubscribe). No polling.

- **Renderer:** `DiagnosticsScreen` Run-benchmark button → RAM / CPU / OS-arch / measured read
  speed (`effectiveRead` or "not measured yet") / drive write / tokens-sec / profile /
  recommended model + warnings; re-loads `lastBenchmark` on mount. `HomeScreen` profile reflects
  the persisted value via `getAppStatus`.
- **`RuntimeStatus.unresponsive?`** (issue #599) — `true` while the RUNNING model stopped
  responding: a `/health` re-probe failed (a frozen or suspended process; the `getRuntimeStatus`
  handler re-probes at most every ~10 s, each probe bounded at 3 s), or an answer ended on the CB-5
  watchdog (`RuntimeUnresponsiveError` — sticky: a passing probe cannot clear it, only the next
  completed answer or a restart). `healthy` reads `false` meanwhile. Absent otherwise. The AI Model
  card shows "Not responding" + Restart (`restartRuntime`).
- **`RuntimeStatus.startRequested?`** (issue #599) — `true` from the moment a model start is
  requested (`startModelRuntime`, before its weight check) until it settles; `startingModelId` is set
  only once the load begins. Absent otherwise. "Is starting" keys on either
  (`shared/runtime-status.ts` `isModelStarting`): Chat's waiting screen, the `main.modelStarting`
  refusal (chat, document answers, doc tasks), the local API's `model_starting`, and the engine
  update's busy refusal.
- **`RuntimeStatus.answering?`** (issue #600) — `true` while a chat or document answer streams on
  the running model (`inFlightStreams` non-empty), added by the `getRuntimeStatus` handler; absent
  otherwise. The AI Model card shows a note then (stopping or switching ends that answer, keeping its
  text) and polls the status until it clears.
- **`RuntimeStatus.starting?`** (issue #107) — `{ elapsedMs, bytesTotal?, expectedMs? }`:
  present while `startingModelId` is (incl. the GPU-crash `forceRestart` window). The manager
  resolves `elapsedMs` (stamped with `startingModelId`, RE-stamped at queue-drain in `doStart`
  so a switch's elapsed measures THIS load, not the old model's stop) and `bytesTotal`
  (`RuntimeStartOptions.weightBytes` — the manifest's full declared file set (`manifestFiles()`:
  the weight, a vision model's mmproj, and any #310 `files:` entries) — else one
  `statSync(modelPath)`), both once per window, never per poll tick. The
  `getRuntimeStatus` handler adds only `expectedMs` (bytesTotal over the effective-read sample,
  memoized per window). `expectedMs` is an ESTIMATE — renderers present it as approximate and
  cap displayed progress below 100% (ChatScreen caps at 97%; the window also spans the #109
  warm-up tail, which the cap absorbs). Absent fields → the indeterminate line.

### Privacy & offline policy (Phase 8 live)
✅ **`services/policy.ts`** (spec §3.5/§3.6/§6). Pure + resilient; never throws.
- **Types** (in `shared/types.ts`): `PrivacyPolicy` (`network`/`workspace`/`models`),
  `NetworkPolicy`/`WorkspacePolicy`/`ModelsPolicy`, `PolicyStatus`. `DEFAULT_POLICY` lives in
  `policy.ts` (main-only).
- **`parsePolicy(contents, onWarn?, base?)`** → `PrivacyPolicy` merged over `base` (default
  `DEFAULT_POLICY`); malformed JSON → `base` + warn. The private `mergePolicyObject(base, raw)` maps
  snake_case JSON → camelCase, taking a field only when it is a real boolean.
  **`loadPolicy(configDir, onWarn?, opts?)`** → `{ policy, policyFilePresent, driveFilePresent,
  allowNetworkByDefault }` (reads optional `policy.json` + `drive.json`; with no usable
  `policy.json`, `opts.isDev: false`, a packaged build, takes `STRICT_POLICY` on a provisioned dir and
  `STANDALONE_POLICY` on an unprovisioned one). The result is cached per config dir; each warning is
  told once, to the first reader that passes `onWarn`, whichever read found it (#752).
- **`resolveNetwork(policy, allowNetworkSetting)`** → `{ networkAllowedByPolicy, networkAllowed,
  offlineMode }` (effective = policy ∧ setting). **`buildPolicyStatus(configDir, allowNetworkSetting,
  onWarn?, opts?)`** → `PolicyStatus` (the `getPolicy()` IPC shape; `telemetryAllowed` hardcoded false).
  **`currentPolicyStatus({ paths: { configPath }, isDev, workspace: { isUnlocked() }, db }, onWarn?)`**
  → `PolicyStatus` right now: `buildPolicyStatus` over the `allowNetwork` setting, a locked workspace
  reading as off (#758). `getPolicy` returns it and the offline tripwire asks it at each remote connect.
✅ **`services/offlineGuard.ts`** — `isLoopbackHost(host)` (127.0.0.0/8, ::1, localhost exempt),
  `installOfflineNetworkGuard({ isOffline, onViolation })` (wraps `net.Socket.prototype.connect`, logs
  remote attempts on every route, Node's normalized argument array included (#751), **never blocks**,
  returns an uninstaller; always installs and asks `isOffline()` at the connect, only for a remote host,
  a throw counting as offline (#758)), `assertOfflinePosture({ readPosture, log, warn, onViolation? })`
  (startup self-check; logs the startup posture, installs the guard in ALL builds for the session, with
  `readPosture().offlineMode` as its `isOffline`). `OfflinePosture` = `{ offlineMode, networkAllowed }`,
  the two `PolicyStatus` fields it reads.
✅ **IPC** `registerCoreIpc.ts`: `getPolicy` (`policy:get`) returns `currentPolicyStatus(ctx)` (#758);
  `getAppStatus.offlineMode`/`networkAllowed` now come from the policy resolution. Preload exposes
  `api.getPolicy` + `PreloadApi`. `main/index.ts` calls `assertOfflinePosture()` in `initBackend()`
  and applies the dev/prod CSP response header in `createWindow()`.
✅ **Renderer:** `PrivacyScreen.tsx` (spec §7.10/§18.1 copy) replaces the placeholder — offline
  statement, "where your data lives" (`getDriveStatus`), live network state (turned off in Settings /
  disabled by policy / allowed; the default is allowed, #805), plaintext-dev-mode caveat, logs-local guarantee. Sidebar `offline-badge` is a
  live button (reads `getPolicy`, links to Privacy).

### Encrypted workspace (Phase 9 live)
✅ **`services/security/crypto.ts`** (spec §3.5) — pure KDF + AEAD, no I/O.
- **KDF:** `deriveKey(password, salt, params)` → 32-byte key; it derives only with `KDF_ALGOS`
  (`isKnownKdfAlgo`), the list the vault's format check (#845) reads too. `KdfParams` is per-algo
  (`argon2id: m/t/p` · `scrypt: N/r/p`); `DEFAULT_KDF = { argon2id, m=19456, t=2, p=1, keyLen=32 }`
  for NEW vaults. A legacy vault unlocks from the params its descriptor recorded (the unlock derives
  with `descriptor.kdf`, scrypt or Argon2id); `SCRYPT_KDF = { scrypt, N=32768, r=8, p=1 }` is an
  exported constant that no code reads (see the §3 KDF decision). `generateSalt()` → 16 random
  bytes. Deterministic for the same password+salt+params.
- **AEAD:** `encrypt(key, plaintext) → { iv(12), tag(16), ciphertext }` (AES-256-GCM, fresh IV),
  `decrypt(key, blob)` (throws on wrong key/tamper). `serializeBlob`/`deserializeBlob`
  (`MAGIC(8)|iv|tag|ct` on-disk frame; `MAGIC` = the family `HRAUMEN` + the frame version byte `1`).
  `classifyFrameMagic(head) → 'current' | 'newer' | 'foreign'` (#845); `deserializeBlob` and the
  streaming readers throw **`VaultNewerError`** (`{ what: 'descriptor'|'kdf'|'frame'|'journal', found }`,
  `isVaultNewerError`) for a `newer` frame, before any output is opened, and "unrecognised header" for a
  `foreign` one. `makeVerifier(key)`/`verifyKey(key, verifier)` (password
  check via a known-plaintext GCM blob — never touches the DB).
✅ **`services/workspace-vault.ts`** (spec §7.9) — the lock/unlock lifecycle.
- **Descriptor:** `VaultDescriptor { version, mode:'encrypted', kdf, saltB64, verifier, dataKey? }` at
  **`config/workspace.json`** (unencrypted; the only pre-unlock artifact). `dataKey` (v2) is the data
  key wrapped by the password-derived key; every published release writes v2 with Argon2id
  (`apps/desktop/tests/fixtures/vault-golden/PROVENANCE.md`).
  `readVaultDescriptorChecked(path) → { kind: 'absent' | 'unreadable' | 'newer' (what, found) | 'ok'
  (descriptor) }` (#845); `readVaultDescriptor` is its back-compat face (`ok` → the descriptor, else
  null; a newer descriptor still counts as "a vault exists" for `isDescriptorUnreadable`, so no create
  over it); `writeVaultDescriptor` (atomic: temp + fsync + rename). **Byte-order mark (#974):** the
  readers of `config/workspace.json`, `workspace/rekey-journal.json` (the format verdict's and the
  recovery's) and `config/working-copy-lost.json` remove one leading U+FEFF before `JSON.parse`; a
  second mark, or a file holding only the mark, still reads as unreadable. No writer writes a mark.
  `vaultPathsFrom({configPath,dbPath,logsPath?})` →
  `VaultPaths { descriptorPath, encPath = <dbPath>.enc, dbPath, logsPath? }` (`logsPath` is optional
  and additive — older callers omit it; without it the rekey does not account for the rotated log).
- **Rekey journal (on-disk, #241):** `workspace/rekey-journal.json` — `{ version: 1, staged: string[],
  remove: string[] }`, absolute paths; written atomically by `stageRekey` BEFORE any `<file>.new` is
  staged, cleared by `applyPendingRekey`/`discardPendingRekey` once every entry is accounted for
  (an unreachable entry keeps it; an unparseable or unknown-`version` file is renamed to
  `rekey-journal.json.corrupt`, never deleted; only `staged` entries ending in `.enc.new` are honoured,
  and since #1014 round 4 every string entry is read, so any other is refused and counted, never dropped
  unseen; staged paths from the scan and the journal are de-duplicated on a folded spelling).
  **What is honoured, and where (#1014):** a `staged` entry is acted on by a recovery before the
  password only when it ends `.enc.new` and lies inside the workspace folder on the disk (no folder
  between the workspace folder and the entry is a link, and the entry's folder, resolved, lies in
  the resolved workspace folder; round 3); one outside it, or (round 5) inside it by its text but
  through a link (an out-of-store copy's stage) only by the unlock, once the open database lists its stored copy
  (`documents.stored_path`, by the resolver's out-of-store rule) and the stage opens under the
  data key while the stored copy does not, and by a password change, which holds the database.
  Round 4: an entry whose containment a stat cannot answer (`lstat` on the way or either `realpath`
  failing for any reason but ENOENT) is neither acted on nor dropped: each pass keeps it in the
  journal it settles (a rollback too) and counts it, and the next pass judges it again; since
  round 6 only while its stage may still be there (a file, or a stat that cannot tell), as for a
  deferred entry, so a stage a pass swapped in anyway is not named afterwards. A
  `remove` entry is never used as a path: one named `app.1.log.enc` (either path separator)
  removes the rotated log at `<logsPath>/app.1.log.enc`. Every other entry is left as it is. A
  journal with a stage waiting for the unlock is kept until the unlock settles every stage it lists
  (swapped in, already in place, or one that does not open under the data key); a stage it may not
  judge yet (a link, a folder, a second hard link, a current stored copy, a hold, a newer build's
  frame, and, round 4, an `lstat` of either file that fails for any reason but ENOENT) keeps it.
  Round 3: after each pass the journal is rewritten (temp + rename, the same
  format) to list only the entries still waiting (a stage still staged, an out-of-store stage on
  an unreachable location, an outside stage waiting for the database), or cleared when none wait;
  it never goes on listing the staged database or an in-store stage it settled. Its `remove` is
  `["app.1.log.enc"]` while the journal asked for the rotated log and that log is still at
  `<logsPath>/app.1.log.enc` (round 6: a log another program held at the commit had its flag
  dropped, and stayed under the retired key), else `[]`. The write temp is never written through
  a link: whatever is at `rekey-journal.json.tmp` is removed first (a link by `unlink`; a folder
  there fails the write) and the temp is created anew (`wx`).
  Round 5: a roll-forward that throws (a held file stopped a swap) settles and counts first, and
  since round 6 every pass reports its count even when the settle itself throws.
  What a pass leaves as it is is counted when it has settled the journal:
  `WorkspaceController.takeJournalRefusals(): number` returns the sum since the last call, logged
  as one count-only line after the start and one after each unlock. A refused entry is counted
  once, by the pass that drops it; a folder left in place (at a write temp's name, at a stored
  copy's name) and an unjudged entry (round 4) by each pass that meets them. Round 4: the unlock's
  recovery before the password and a password change's passes add to the same sum (nothing logs
  right after a change: its count goes with the next unlock's line). Round 5: so does the unlock's
  out-of-store pass for a listed stage it leaves: one that does not open under the data key (once:
  it is dropped) and one it keeps unsettled (at each unlock). The file format is unchanged.
  `listVaultKeyCiphertexts(vaultPaths, db) → VaultKeyCiphertext[]` = `{ path, kind: 'document' |
  'image' | 'out-of-store' | 'rotated-log', action: 'rekey' | 'delete' }` is the class registry the
  stage journals. The descriptor is unchanged. **Downgrade caveat:** a build older than the #241 fix
  never reads the journal — on a pending migration it rolls only the DB + `documents/` forward and
  leaves `images/` and out-of-store twins staged (a current build finishes them); a completed
  migration is a plain v2 vault. Constants: `REKEY_JOURNAL_NAME`, `IMAGES_DIR_NAME`,
  `DOCUMENTS_DIR_NAME`, `ROTATED_ENCRYPTED_LOG_NAME` (`app.1.log.enc`, deleted at the commit).
  **Staged database in doubt (#973):** `recoverPendingRekey` leaves the whole staged set (and the
  journal) as it is when a v2 descriptor sits beside a `hilbertraum.sqlite.enc.new` that no journal
  lists and an `.enc` that is there (any stat answer but ENOENT); a journal entry lists it only by
  its full path, folded as `pathKey` folds it (review round 3: a match by the folder and file names,
  which every workspace shares, let a stale journal vouch for a foreign stage), so an entry written
  under another drive letter or mount point leaves the stage in doubt, for the unlock to authenticate.
  #1014 round 4: and only an entry the journal's containment admits lists a stage, here and for the
  #1001 stages below; one it does not admit (through a link) or cannot judge vouches for nothing.
  `unlockEncryptedVault(…, onStageInDoubt?)` resolves it
  after the data key is unwrapped: the module-private `authenticatesUnder(path, key) → boolean` (one
  GCM pass, nothing written; false when the tag fails or the file is no `HRAUMEN1` frame, cut short
  or another magic; a newer frame throws `VaultNewerError`) true → `applyPendingRekey` (outcome
  `rolled-forward`), false → the file is deleted, then `recoverPendingRekey` runs again for the rest of
  the staged set (`removed`); a read that fails with ENOENT is no stage, with EISDIR or ENOTDIR (a
  folder at the name), like a delete that fails, leaves the file as it is and opens `.enc` (`left`),
  and with any other code (EBUSY, EPERM, EACCES, EIO, …) throws `VaultRecoveryBlockedError`
  (→ `vault_recovery_blocked`, nothing changed, before the `.recovery` roll-forward; since #1014
  round 5 with that code in its `code`, for the log line).
  `onStageInDoubt(outcome: StageInDoubtOutcome)` hears the outcome as soon as it is true, also when a
  later step of the unlock fails; the pass is timed as the perf mark `vault_stage_check` (`checkMs`,
  `stageBytes`). While a stage is in doubt at `init()`, a loss the start judged (#875 `startup`, #892
  `unclean`) is held in memory instead of marked; the controller marks it when the outcome is
  `removed` or `left`, drops it on `rolled-forward`, and settles a hold no outcome reached at the
  next successful unlock (recorded while `.enc`'s frame IV is still the one it was judged against,
  dropped otherwise); it is never carried past that unlock, and a create clears it.
  **Staged sidecars in doubt (#1001):** the same rule per stored copy. A `documents/` or `images/`
  `*.enc.new` file (found by scan; a folder at such a name is no stage, for any recovery or the format
  verdict; a journal entry counts only when it names a file, too) that no journal lists by its folded full path, beside a stored copy
  that is there (any stat answer but ENOENT), is in doubt. `applyPendingRekey(vaultPaths, skip?)`
  takes an optional set of folded paths it leaves as they are (default: none, so `changePassword`
  and the direct callers are unchanged); `recoverPendingRekey` (the start, the unlock before the
  password, #973's R5 re-run) and #973's `rolled-forward` branch pass the sidecars in doubt, and the
  rest of the set rolls as before. After the data key is unwrapped and the staged database is
  decided, `unlockEncryptedVault(…, onStageInDoubt?, onSidecarStages?)` judges each one, cheapest first.
  Before any read, two `lstatSync` calls (a link is never followed): either file no regular file (a
  symbolic link, a junction, a folder) → `left`; the stage with `nlink > 1` or of another size than the
  stored copy → only the staged name deleted (`removed`), the stage never read. Then
  `authenticatesUnder`: true, and the stored copy itself NOT authenticating under the data key
  (a pending stage's stored copy is under the retired key; one more read), with `nlink` 1 → the stored copy renamed
  to `<stored>.tmp`, the stage renamed into place, then `<stored>.tmp` shredded (`rolledForward`; a
  failed rename of the stage renames the stored copy back, `left`; when that fails too, the stored copy
  stays at `<stored>.tmp` for the session, `setAside`, and the next start shreds it and renames the
  stage into place); true but the stored copy authenticates (it is current) → only the staged name
  deleted (`removed`); a stored copy that cannot be read, or that another name shares (`nlink > 1`) →
  `left`; false (tag fails, or no `HRAUMEN1` frame) → the stage deleted
  (`removed`); a read that fails with ENOENT → nothing; any other read failure, or a delete or swap
  that fails → the stage left as it is (`left`), never `VaultRecoveryBlockedError`, judged again at
  the next unlock. `<stored>.tmp` is a name the start's sweep shreds. `onSidecarStages(outcome: SidecarStageOutcome)` hears
  `{ rolledForward, removed, left, setAside }` (counts only) once the pass ends, also when a later step of the
  unlock fails; the pass is timed as the perf mark `vault_sidecar_stage_check` (`files`,
  `stageBytes`, `checkMs`). A stage whose stored copy is gone (ENOENT) is no doubt and is renamed
  into place at the start, as before. The loss hold reads the staged database only.
  `WorkspaceController.init()` removes a stray `.enc.new`
  and `.enc.new.tmp` when there is no descriptor file, no `.enc` and no journal (each ENOENT); the
  state stays `uninitialized`. No on-disk shape changes.
  `createImageSession(db, dir, req, cipher, beginWork?)` — the optional fifth argument is the
  document-work lease factory (`() => ctl.beginDocumentWork()`), taken before the first await.
- **File crypto + hygiene:** `encryptFile`/`decryptFile` (atomic temp+rename; `decryptFile` throws
  `FrameAuthError` when the GCM tag fails, #860 V5b), `shredFile`
  (overwrite-random + unlink, best-effort), `cleanSidecars` (shred `-wal`/`-shm`).
- **Lifecycle:** `createEncryptedVaultOnDisk(vaultPaths, password, kdf?, opts?)` seeds a new
  database, encrypts it to `.enc.new`, shreds the plaintext and its WAL/SHM, writes the descriptor (the
  commit point), then renames `.enc.new` to `.enc`, leaving the vault LOCKED (`opts.legacyV1`, tests
  only, builds a v1 descriptor); `unlockEncryptedVault(vaultPaths, password) → { db, key, descriptor }`
  (format verdict → verify → decrypt → open). It throws **`VaultNewerError`** before the password is
  checked (#845); **`WrongPasswordError`** when the verifier fails; after the password verified,
  `VaultRecoveryBlockedError` (#242), `WorkspaceNewerError` (#247; #985: also for a `.recovery` the
  probe calls `newer` that may hold the freshest data, right after the password check and before the
  staged-file check, the roll-forward or any shred), **`VaultDamagedError`** when `.enc`
  fails its GCM tag (#860 V5b) or decrypts to something SQLite calls not a database or corrupt (#208;
  its `damage`, `'failed-authentication' | 'not-a-database'`, goes to the log only),
  and `VaultOpenFailedError` when the open could not finish otherwise (#844).
  `lockEncryptedVault(vaultPaths, db, key, encryptFileImpl?, onProbeFallback?)` (checkpoint+close →
  `-wal` check, with one retry → probe → re-encrypt → shred). It refuses while the `-wal` still holds
  commits after the retry, and unless the probe reads the file as a database; once it has judged the
  file, every failure is a **`LockStoppedError`** (`reason: 'wal' | 'probe' | 'encrypt'`, `verdict:
  { walPending, probe | null }`, an encrypt failure as its `cause`), which the controller reads
  instead of probing again (#876 review round 2). **`walAwaitsCheckpoint(dbPath)`** (`services/db.ts`):
  stats `<dbPath>-wal` first (32 bytes or less never counts); true when it has a valid WAL header
  (magic `0x377f0682`/`0x377f0683`) and frames after it, or has frames but cannot be opened or read
  (a hold); a noise `-wal` is false. **`checkpointLeftoverWal(dbPath)`** → `{ outcome: 'checkpointed'
  | 'busy', log, checkpointed } | { outcome: 'damaged' | 'failed', code }`: the lock's one retry, a
  plain open (SQLite's own WAL recovery decides what the WAL holds), `PRAGMA wal_checkpoint(TRUNCATE)`
  and close; `damaged` (CORRUPT/NOTADB) means the WAL cannot be replayed into the file and no longer
  refuses the lock. `stageRekey` refuses the same pending WAL (no retry: its connection is open).
  **`probeDatabaseFile(path)`**
  (`services/db.ts`, #876) → `{ verdict: 'database' | 'damaged' | 'not-database' | 'gone' | 'unknown'
  | 'unchecked', code? } | { verdict: 'newer', found }`: the
  header through `node:fs` (#985: a schema stamp, `user_version` at offset 60 read as a signed
  big-endian 32-bit integer, above `SCHEMA_VERSION` answers `newer` with the stamp as `found`,
  before SQLite opens the file), then an `immutable=1` read-only open (no lock, no `-wal`/`-shm`; the
  `\\?\` long form on Windows) that reads the schema, the first row of every table and the last row
  of every rowid table, then the root-page header of every index through `node:fs`. It reads the
  main file alone: beside a `-wal` that holds commits its verdict is about a stale or torn file.
  `damaged` = the SQLite header, but SQLite calls the structure CORRUPT, NOTADB or (the probe's
  own reads only, review round 3) TOOBIG, or an index root is no b-tree page, or the page size or
  the schema format number (header byte 47 above 4) is one no SQLite writes; the schema is read with
  `trusted_schema` OFF; `not-database` = no SQLite header (noise, empty,
  cut short); `unknown` = the header read itself failed (a hold), never read as lost; `unchecked`
  (review round 2) = the header reads but the structure could not be read for a reason that is not
  damage (any other SQLite error, an index-root read that fails), with `code` (SQLite's result code
  and fixed description, or a Node error code). **The probe only adds a refusal or a discard for
  proven damage:** every site judges an `unchecked` file by its header, as before the probe, and
  reports it (`ProbeFallbackNote(site, code)`, `site` = `lock` | `salvage` | `recovery` | `rekey`);
  the controller keeps the notes, `takeProbeFallbacks()` returns them once, and the lock, unlock and
  password-change handlers log each ("A workspace file was judged by its SQLite header …"). The one
  verdict for the lock's guard and its #855 verdict, the startup salvage, the
  `.recovery` roll-forward and `stageRekey`. **`newer` is never discarded** (#985): the salvage
  keeps the file as `.recovery` (`preserved`, or `kept-only-copy` with `.enc` missing; no #875
  marker; with `.enc` missing no `encrypted_file_missing` notice), the unlock throws
  `WorkspaceNewerError(found)` (→ `workspace_newer`) for a `.recovery` that may hold the freshest
  data (`.enc` missing or not judged, or the copy at least as new by mtime) right after the password
  check, before the staged-file check, the roll-forward or any shred, and keeps one older than a
  present `.enc` (a spent leftover) as it is, unencrypted, with `UnlockedVault.newerRecoveryLeft`
  set (the controller's `takeNewerRecoveryLeft()` returns it once, for one content-free log line, no
  audit type; the copy stays until a later failed lock's salvage replaces it or a newer build's
  unlock shreds it as spent), the create
  refuses with the same error while a working file or `.recovery` probes `newer`, and the lock and
  `stageRekey` read it as a database.
  `sqliteJudgedDamaged(err)` (the #844 classifier) lives beside it.
  `plaintextAllowed(policy, { isDev })` gates plaintext (now **enforced**): it needs a policy that
  allows it and a dev build; the `developerMode` setting plays no part (it lives in the encrypted DB).
- **Vault format versions (#845):** `vaultFormatVerdict(vaultPaths) → { kind: 'ok' } | { kind:
  'newer', what, found }`, read-only and independent of the password. It runs first in
  `WorkspaceController.init()` (before the failed-lock salvage, the crash sweep and the rekey recovery)
  and in `unlockEncryptedVault` (before the rekey recovery, the `.recovery` roll-forward and the
  decrypt). A `newer` verdict writes, shreds and renames nothing of the vault: the workspace reports `locked`, the
  create flow is refused, and every unlock throws `VaultNewerError`, which the unlock IPC answers with
  `workspace_newer` (+ `main.workspace.newer`, no new key) and a log line naming `what` and `found`.
  While startup's verdict is `newer`, `unlock()` and `create()` re-read the disk first: once the newer
  artifact is gone (the newer copy rolled back, a backup restored), `init()` runs the salvage, sweep and
  rekey recovery it skipped, before anything is decrypted. "Numeric" below means a number, integer or not,
  or a string holding a decimal number (`"3"`): shipped builds compare `version` with `>=`, which
  JavaScript applies to both.

  | Artifact | Read as `newer` (`what`) | Not newer: as before |
  |---|---|---|
  | `config/workspace.json` | any numeric `version` above 2 (3, 2.5, `"3"`), checked before any shape check (`descriptor`); a v1/v2 descriptor whose `kdf.algo` is a string other than `scrypt`/`argon2id` (`kdf`) | unparseable, a field missing, a v2 without `dataKey`, a `version` string holding no number (`"3.0.0"`): `unreadable` ("restore a backup"); out-of-bounds KDF params: refused at derive (tamper); a `dataKey` under a version that is not a v2's (missing, null, 0, 1; no v1 ever had one): `unreadable`, so only the descriptor needs restoring |
  | `workspace/hilbertraum.sqlite.enc` and every staged file a recovery would swap in (`.enc.new`, `documents/` and `images/` `*.enc.new`, the journal's entries) | first 8 bytes `HRAUMEN` + an ASCII digit `2`–`9` (`frame`) | any other magic (`HRAUMEN` + `0`, a letter or another byte, i.e. a damaged version byte; `PAIDENC1`, written before 0.1.10; noise): "unrecognised header", the generic unlock error |
  | `workspace/rekey-journal.json` | any numeric `version` above 1 (2, 2.5), whatever the descriptor says (`journal`) | unparseable or another `version`: quarantined as `.corrupt` |
  | `logs/app.log.enc`, `logs/app.1.log.enc` | a `newer` `app.log.enc`: `logging.ts` keeps the session's log in memory and never persists or rotates over it; a `newer` `app.1.log.enc`: only the rotation onto it is skipped (the live `app.log.enc` keeps persisting, up to the 2 MB buffer cap) | a corrupt or foreign-key log: started fresh (overwritten), as before |

  **The plaintext working copy** (`workspace/hilbertraum.sqlite`, its `.recovery`) is judged by
  `probeDatabaseFile`, not by this verdict: a schema stamp above `SCHEMA_VERSION` is `newer`, kept by
  the start and refused by the unlock with `WorkspaceNewerError` (#985, see the probe above).

  **Not part of the vault:** startup's ZIM transient sweep still runs before the verdict is read
  (`main/index.ts`): it deletes the knowledge-pack reader's temporary listing files under
  `workspace/zim-transient/` (a newer build's included), which never hold workspace data.

  **Residual:** a `newer` verdict also skips startup's crash sweep, so a newer build's own crash leftovers (its
  plaintext working database and `-wal`/`-shm`, its transient decrypted copies) stay on the drive until a newer
  build starts and sweeps them. Deliberate: they may hold that build's unsaved data, and the verdict's rule is that
  nothing is written, shredded or renamed.

  `changePassword` re-reads the descriptor on disk first and refuses (nothing derived or written) when it
  is newer or no longer the one the session unlocked; the IPC answers `error` +
  `main.workspace.changeFailed` (the current password still works). **Frozen constraints for any future
  format** (builds shipped before #845 cannot be changed): they read a descriptor with `mode` other
  than `encrypted`, or without `dataKey`, as unreadable (safe), but a v3 that keeps `dataKey` as a v2
  (unsafe: it unlocks, and a password change rewrites it as v2) — so a v3 must drop or rename
  `dataKey` (or change `mode`); a field added to a v2 descriptor without a version bump is dropped by
  any build's password change; never stage `.enc.new` (or any `*.enc.new`) under a v2 descriptor
  before the commit point — every shipped build rolls a staged file forward under a v2 descriptor and
  quarantines a journal it cannot read, so a newer build's uncommitted stage would end up under a key
  that exists nowhere (from #973 on, a journal-less `.enc.new` beside an existing `.enc` is rolled
  forward only once it authenticates under the unwrapped data key, and deleted when its tag fails,
  and from #1001 on the same holds for a journal-less `documents/` or `images/` `*.enc.new` beside
  its stored copy, but the builds before them remain); `HRAUMEN1` is the only frame shipped builds read (they call any other magic an
  unrecognised header), and a later frame version is one ASCII digit `2`–`9` after `HRAUMEN` (any other byte
  there reads as damage from #845 on).
- **`WorkspaceController`** (stateful, on `AppContext`): `init()` (startup: the #845 format verdict
  first, then plaintext opens immediately, encrypted stays locked, else uninitialized),
  `newerVaultFormat()` (what the last verdict found newer, or null; `main/index.ts` logs it at startup),
  `isNewerWorkspace()` (#247), `isRecoveryBlocked()` (#242), `getState() → WorkspaceStateInfo`,
  `requireDb()` (throws while locked), `isUnlocked()`, `unlock(password)`, `create(password, mode)`,
  `lock()` (no-op for plaintext: it returns with the database open and disarms the latch),
  `shutdown()` (the quit's lock; for plaintext a checkpoint + close),
  `changePassword(current, next, kdf?)`, `beginDocumentWork()` → release (refused with
  `VaultBusyError` during a password change), `beginLock()` / `isLocking()` / `cancelLock()` (the
  AUD-02 latch), `unlockEpoch()` (AUD-03), `encryptionKey()` and `documentCipher()` (null while
  locked or in plaintext), `takeWorkingCopyLost()` (#875, below), `discardedOnlyCopy()` (#911),
  `takeRestoredMissingEnc()` (#911,
  below), `takeStageOutcome() → 'removed' | 'left' | null` (#973: the last unlock removed a staged
  `.enc.new` that does not open under the data key, or left one it could neither judge nor remove;
  returned once, for the unlock IPC's one content-free log line on its success and failure paths, no
  audit type), `takeSidecarStageOutcome() → { rolledForward, removed, left, setAside } | null` (#1001: what the
  last unlock did with the staged document and image copies in doubt, counts only, null when it found
  none; returned once, for the same IPC's one line, logged only when it removed or left any).
- **Working copy lost (#855, #875):** a lock that finds the working file gone or no longer a
  database (`probeDatabaseFile`: `gone`, `not-database` or `damaged`) while `.enc` is there shreds
  what is left, drops the key and finishes `locked` at the last good snapshot. From then until the
  next successful unlock, `getState()` reports `lockNotice: 'working_copy_lost'` while the state is
  `locked`. The lock also writes
  **`config/working-copy-lost.json`** = `{ "v": 1, "enc": "<base64 of the 12-byte IV of .enc>", "cause": "lock" }`
  (`cause`: `lock` | `startup` | `unclean` | `unclean-full`)
  (temp + fsync + rename, best-effort), so a lock at quit, a crash or a session end is reported at
  the next start: `init()` (encrypted branch, after the verdict, the salvage, the sweep and the
  rekey recovery) adopts a v1 marker whose `enc` equals the IV of the `.enc` there now, and removes
  one that names another (a later lock by any build re-encrypted `.enc`: stale). A marker of
  another `v`, or one that is not JSON, is neither shown nor removed; under a newer-format verdict
  none is read. The startup salvage raises the same notice when the sweep shreds a newer working
  file whose header reads but whose structure is `damaged` (no shred of ours leaves a header; a
  header-less one is a successful lock's shred survivor and raises nothing); its marker says
  `"cause": "startup"`. **An unclean end (#892):** beside live `-wal`/`-shm` (the mid-session crash
  state the sweep shreds as before) `preserveNewerPlaintext` returns `'swept-unclean'`, sweep-safe
  exactly like `'not-needed'`, when the working file or its `-wal` is newer than `.enc` and
  `probeDatabaseFile` reads the working file as `database`, `damaged` or `unchecked` (`not-database`,
  `unknown`, `gone` and any error raise nothing; since #892's code review the check reads only the
  100-byte header that the probe's first step reads, which lets through exactly those three answers,
  and notes no probe fallback). `init()` then reads the free space through the
  controller's injected `freeBytes(path)` (default `disk-space.ts` `freeBytesSync`, statfs) BEFORE
  the sweep, and records the loss AFTER the sweep and the rekey recovery, only while `.enc` has a
  readable frame and still the IV it had before that recovery (a roll-forward that swapped it opens
  the staged copy of the session; an `.enc` with no readable frame names no snapshot):
  `lockNotice: 'session_not_closed'`, marker `"cause": "unclean"`; or
  `'session_not_closed_full'` / `"unclean-full"` when the free space is below the size of the working
  file plus its `-wal`, both read before the sweep (the session's lock needed room for its checkpoint
  and its encrypt; a null answer, or any error, is not full). The notice per cause: `lock`, `startup`
  → `working_copy_lost`. The reader
  maps a cause this build writes (`lock`, `startup`, `unclean`, `unclean-full`) 1:1 and **any other
  (a later build's, or none) to `unclean`**, never to `lock`. Known limits: every marker write
  (temp + rename, the same for all four causes since #875) replaces whatever file is there, a marker
  of another `v` included, although reading and removing leave such a marker alone; and
  `unclean-full` is measured once, at the start that sweeps, so it stays `_full` until the unlock
  even if space is freed before a later start (its copy speaks in the past for that reason); and a
  session run on a computer whose clock is behind the one that last locked the drive leaves a
  working file and `-wal` older than `.enc`, so its loss is not reported (the salvage's mtime rule,
  which treats such a file as derived data); and `unclean-full` measures the room, not why the session
  ended: a pulled drive or a power cut on a drive short of that room is reported as `unclean-full` too. A
  successful unlock consumes it: the
  flag clears, this build's marker is
  removed, and `takeWorkingCopyLost() → { cause, lostAt: <marker mtime ISO> | null } | null` returns
  it once, for the unlock IPC to log ("The changes since the last saved state were lost …") and
  audit (`workspace_working_copy_lost`, metadata `{ cause, lostAt }`, `cause` = `lock` | `startup` |
  `unclean` | `unclean-full` | `recovery`). `recovery` is a loss the unlock itself makes: `unlockEncryptedVault` shreds a
  `.recovery` newer than `.enc` whose structure is `damaged` (`UnlockedVault.recoveryDiscarded`),
  recorded with no `lostAt` (the event's own time is when); that copy is shredded only once the
  unlock has succeeded, so a failed unlock keeps the evidence and the next one records it (except with `.enc` missing,
  #911, where the right password shreds it at once: no unlock could succeed) (review
  round 2; an older damaged copy is a spent leftover: shredded, nothing recorded). `create()` removes
  a v1 marker a wiped vault left (with no vault, startup never reads one) and clears the record in
  memory; the commercial sell gate refuses a drive that carries it (`noUserData`, #893). Older builds ignore the file; the descriptor is untouched.
- **Encrypted file missing (#911):** the one state in which the start keeps plaintext instead of
  sweeping it: the descriptor is encrypted, a working file is there, **no encrypted snapshot of any
  kind exists** (a stat of `.enc` says ENOENT, and no `.enc.new` is staged) and the #845 verdict
  found nothing newer. `preserveNewerPlaintext` then replays the `-wal` into the main file
  (`checkpointLeftoverWal`), probes the file and moves a
  `database` (or `unchecked`, judged by its header) to `<db>.recovery`: outcome `'kept-only-copy'`,
  sweep-safe like `'preserved'`. A copy whose structure is `damaged`, a shred survivor or a file
  gone meanwhile is `'not-needed'` (swept; no notice), except that a `damaged` one is
  `'discarded-only-copy'`: swept the same way, and `discardedOnlyCopy()` is true for that start, for
  `main/index.ts`'s content-free log line. The sidecars are left to the sweep that
  follows every path that does not block (named after the working file, they never pair with the
  `.recovery`). `'failed'` (blocked, every file kept, as
  #242): a stat of `.enc` that fails other than ENOENT, a `-wal` that still holds commits after the
  replay, a probe that cannot read the file, a rename that cannot land. The `.recovery` contract is
  unchanged and now also carries this state: no start sweeps it, and the unlock rolls it forward
  over a missing `.enc` (every build since 0.1.47). **No marker** is written, and the marker format
  (`v`, `enc`, the `cause` set) is unchanged: the notice is derived from the disk at every start
  (descriptor encrypted, `.enc` ENOENT, a `.recovery` that starts like a database: the #892 header
  read; at `init()` and after a failed unlock only), so `getState()` reports
  `lockNotice: 'encrypted_file_missing'` while locked, across restarts and builds, until a
  successful unlock. That unlock sets `UnlockedVault.restoredMissingEnc` (the roll-forward
  encrypted over a missing `.enc`), and `takeRestoredMissingEnc() -> boolean` returns it once for
  the unlock IPC's content-free log line (no audit type). With no `.enc` and nothing rolled forward,
  `unlockEncryptedVault` throws `VaultMissingError` after the verifier (a wrong password is still
  `WrongPasswordError` and touches nothing; `keptCopyDiscarded` tells the IPC's log line whether a
  kept copy went), having shredded a `.recovery` that was spent or
  `damaged` (#875 keeps a damaged one until an unlock succeeds; with no `.enc` none can). `.enc` and
  the working file are not written. A failed unlock re-reads the notice from the disk, so it goes
  once no copy is kept. The unlock judges `.enc` once, by the start's ENOENT-only rule: a stat that fails
  otherwise, with a `.recovery` there, throws `VaultRecoveryBlockedError` and rolls nothing forward.
  **A returned `.enc`:** the start never replaces a snapshot, but the unlock
  applies the CODE-1b roll-forward rule to an `.enc` that came back after the start: the kept copy
  replaces it unless that `.enc` is newer by mtime. A newer one wins, the kept copy is shredded as a
  spent leftover, and nothing records the session it held.
✅ **IPC** `ipc/registerWorkspaceIpc.ts` — `getWorkspaceState` (`workspace:getState`) →
  `WorkspaceStateInfo`; `unlockWorkspace(password)` / `createWorkspace(password, mode)` →
  **`WorkspaceActionResult`** (`{ok:true,state}` | `{ok:false, reason:'wrong_password'|
  'vault_damaged'|'vault_missing'|'vault_descriptor_missing'|'vault_descriptor_unreadable'|'vault_open_failed'|
  'vault_recovery_blocked'|'workspace_newer'|
  'workspace_exists'|'plaintext_not_allowed'|'refused'|'error', message}` — a
  wrong password / policy refusal is a normal result, not a throw; `vault_damaged` (#208) is the
  password-verified-but-undecryptable-to-a-database unlock failure, deliberately distinct from
  `wrong_password`, and since #844 only what SQLite itself calls not a database or corrupt, plus
  (#860 V5b) a `.enc` that fails its GCM tag after the password verified;
  `vault_open_failed` (#844) is the unlock whose open could not finish on a database SQLite does
  not call damaged (an upgrade step or the unlock's settings write, on a full drive, an I/O
  error, a bug in a new step) — the failed open never rewrites `.enc`; free space and retry,
  or start the previous version after an update;
  `vault_missing` (#911) is the unlock whose password verified while `.enc` is missing and no
  `.recovery` copy was rolled forward over it: `.enc` and the working file not written (a spent or
  damaged `.recovery` shredded); put the file back or restore the
  workspace folder from a backup, never create a new workspace (create's table maps it to `null`:
  never sent there);
  `vault_descriptor_missing` (#807, C-S2) is the unlock refused because `.enc` is there but
  `config/workspace.json` is missing or unreadable (`VaultDescriptorMissingError`): no password can be
  checked or open it, nothing is written; put the file back or restore it from a backup, never
  create a new workspace (before, a plain error that read "Could not open the workspace.");
  `vault_descriptor_unreadable` (#955 item 1) is the unlock refused because `config/workspace.json`
  is there but cannot be read and a stat of `.enc` says ENOENT (`VaultDescriptorUnreadableError`;
  any other stat failure proves nothing and stays `error`): no password can open anything, nothing
  is written; don't delete the key file, restore both files from a backup (before, a plain error
  that read "Could not open the workspace."). The create answers it too, with the same key, for such
  a file that appeared under its create form (the gate shows it on the create form, no switch);
  `workspace_exists` (#807) is the create refused because a workspace is already on the drive
  (`WorkspaceExistsError`: an encrypted descriptor, the `.enc`, an unreadable descriptor beside an
  `.enc` or a newer build's artifact; since #954 any descriptor file, read live, so also one put back
  after the start; also the `createEncryptedVaultOnDisk` belt over an `.enc` or a descriptor file,
  at its start and right before its commit), and
  `plaintext_not_allowed` (#807) the create without a password that the policy or the build does
  not allow (`PlaintextNotAllowedError`); both used to be `refused` with the vault's English
  sentence, matched by its wording, and nothing on the disk changes (the start's steps for a vault
  that appeared after the start run at the unlock). Since #955 the state then reads `locked`: the
  gate re-reads it after `workspace_exists`
  and, when it reads `locked`, hands it to App (`onStateChange`), which shows the unlock form with the
  refusal; create's `refused` is now only
  a password under `MIN_PASSWORD_LENGTH` or not a string. A Node file error during create (an
  `EPERM … rename`) is `error` (`createFailed`), logged content-free (#807: it used to match the old
  wording and reach the gate raw);
  `vault_recovery_blocked` (#242) is the unlock refused because a held
  `.recovery` file blocks the failed-lock salvage (since #911 also a stat of `.enc` that fails
  other than ENOENT, or a `-wal` the start could not replay while `.enc` is missing; since #973 also
  a staged `.enc.new` in doubt that the unlock cannot read: a hold, or an I/O error such as EIO;
  since #1015 also a committed password change's swap, or its temps, that the rekey recovery cannot
  finish for a file error (a hold; never a folder at a temp's or a stored copy's name, which is
  left and counted, round 3; a folder at `.enc` still blocks): `VaultRecoveryBlockedError.code`
  carries that file error's code for the log line, and `WorkspaceController.recoveryBlockedCode()`
  the start's) — retry once the hold clears, nothing lost;
  `workspace_newer` (#247, PR #289) is the unlock or create refused because the database was
  written by a NEWER build — nothing written, update the app; since #845 also the unlock refused
  because the vault format itself is a newer build's, see "Vault format versions"). Since the 2026-11 UI languages
  wave the lock screen renders a failed unlock or create from `reason` in its own language
  (`shared/workspace-failure-keys.ts`, one table per call; architecture.md i18n record D-L3);
  every reason a call sends has a key (create's `refused` renders `main.workspace.passwordTooShort`
  with `{ min }`, #807 A2), so `message` is shown only for a reason a table maps to `null` (one the
  call never sends) or doesn't know. `MIN_PASSWORD_LENGTH` (`shared/types.ts`) is the one password floor for main, the
  gate, the change-password card and the strength meter;
  **Schema stamp (#247):** the workspace database carries `PRAGMA user_version` =
  `SCHEMA_VERSION` (`services/db.ts`; `1` since PR #289). `openDatabase` reads it before any
  PRAGMA that writes: `0` (every database written before the stamp) and any lower value run the
  additive migrations and are stamped in place; an equal value skips only the stamp write — the
  additive migrations still run on every open, so an equal-stamped file missing a newer column gets
  it, and on a complete schema a second open changes nothing; a HIGHER value throws the typed `WorkspaceNewerError` with the handle closed and the
  file byte-identical. Bump `SCHEMA_VERSION` only for a change an older build must not open.
  Builds ≤ 0.1.59 never read the stamp, so it protects only pairs whose older build is newer
  than PR #289. **Later-writer rule (#985, frozen for every later release):** schema text an older
  SQLite cannot parse (a newer clause in an index, a trigger, a generated column, a table option)
  ships only together with a bump of `SCHEMA_VERSION`. An older build's SQLite fails every schema
  read of such a file with CORRUPT ("malformed database schema"), and from #985 on its start and
  unlock keep a working copy or `.recovery` only when the stamp says `newer`: without the bump that
  file reads as damaged and is discarded. Builds before #985 discard it either way;
  `lockWorkspace` → `WorkspaceStateInfo`, with `lockNotice: 'working_copy_lost'` when the lock
  finished at the last good snapshot because the working file was gone or no longer a database
  (#855); since #875 `getWorkspaceState` reports it too, while locked, until the next unlock, and
  since #892 also `session_not_closed` / `session_not_closed_full` for a start that swept the
  session an unclean end left (see "Working copy lost" above). Since #911 `getWorkspaceState` also
  reports `encrypted_file_missing` while a copy the start kept over a missing `.enc` waits for the
  unlock (see "Encrypted file missing" above). `changeWorkspacePassword(current, next)` (`workspace:changePassword`) →
  `WorkspaceActionResult`: `wrong_password` (a wrong or non-string current password), `refused`
  (a new password under `MIN_PASSWORD_LENGTH` or not a string, the workspace locked or a lock under
  way, or document work in progress: `VaultBusyError`, whose message is `tMain` text since #807), `error` (anything else, #845's refusals
  included: the current password still works). Registered in `initBackend()`; exposed on preload `api` +
  `PreloadApi`.
- **Types** (`shared/types.ts`): `WorkspaceStateName` (`uninitialized|locked|unlocked`),
  `WorkspaceStateInfo { state, mode, plaintextAllowed, encryptionRequired, lockNotice? }`
  (`lockNotice`: `working_copy_lost` | `session_not_closed` | `session_not_closed_full`, #892;
  `encrypted_file_missing`, #911),
  `WorkspaceActionResult`.
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
  id, modelPath, dimensions?, contextTokens? }`. The model is `resolveModelByRole('embeddings')`'s pick
  (#848): the manifest flagged `default_for_role: true` (`ModelManifest.defaultForRole`), else the first
  of the role in `discoverManifests`' walk (each folder's entry names in code-unit order, on every OS). The
  flag decides whether or not the file is present: a missing default weight composes the `MockEmbedder`,
  never another installed embeddings model. `activeEmbeddingModelId` does not choose it.
✅ **`VectorIndex`** — optional 3rd ctor arg `{ embeddingModelId? }`: a non-empty id scopes the cosine
  scan to `WHERE embedding_model_id = ?` (mismatch guard); default scans all rows. **`rag.retrieve`**
  passes `{ embeddingModelId: embedder.id }`.
✅ **`main/index.ts`** — builds the selecting runtime factory + selected embedder; `resolveEmbeddingModel`
  reads the embeddings manifest pre-unlock; `will-quit` now also calls `ctx.embedder.stop?.()`.
  **R5: live inference is manual** (binaries + GGUF not in repo); everything else is tested with a mocked
  child process / mocked loopback `fetch`.

### Drive layout, scripts & packaging (Phase 11 live)
✅ **`services/drive.ts`** — the canonical, unit-tested reference for drive prep (the scripts mirror it):
- `DRIVE_LAYOUT_DIRS` (the list itself: see
  [`drive-layout.md`](drive-layout.md); `script-drift` holds both prepare-drive scripts to it).
- `buildDriveJson(opts) → DriveJson` (the `config/drive.json` marker, spec §6 shape);
  `buildPolicyJson({dev?}) → PolicyJson` (snake_case; `allow_model_downloads: true`, update checks off;
  commercial vs dev posture). `script-drift` holds the scripts to both shapes; no app code writes them.
- `verifyDriveModels(root, manifests) → ModelVerifyResult[]` (status `verified|unverified_placeholder|
  mismatch|missing|unsupported`, reusing `models.ts` `verifyChecksum`/`isRealSha256`);
  `buildChecksumsJson(root, manifests) → ChecksumsJson` (generate-mode capture of present-weight hashes).
✅ **`scripts/`** (repo root, self-contained; no Node/npm needed to prep a drive):
- `prepare-drive.{ps1,sh}` — `-Target`/`--target` (required), `-DryRun`/`--dry-run`, `-Force`/`--force`,
  `-Dev`/`--dev`. Creates the layout, copies `model-manifests/` + user docs onto the drive, writes
  `config/{drive,policy}.json`. Idempotent; config only (re)written with `--force`.
- `verify-models.{ps1,sh}` — `-Target`/`--target`, `-Generate`/`--generate`, `-Strict`/`--strict`,
  `-Kit`/`--kit`. Flat-YAML line-parses the
  manifests, SHA-256s present weights, prints `VERIFIED/UNVERIFIED/MISMATCH/MISSING/UNSUPPORTED`,
  **exit 1 on a real-hash mismatch**; `--generate` writes `config/checksums.json`. `--strict` exits 1
  unless every manifest's files are VERIFIED; `--kit` (#766) applies that only to the models a Kit
  ships (bundled, or any file on the drive), prints `CATALOG` for the rest, and needs ≥ 1 bundled. Reads a `files:`
  list the same way (#310): the primary is unlabeled, the mmproj projector keeps its own
  `(mmproj)` label, and each `files:` entry is verified with a positional `(file N/M)` label;
  `--generate` emits one `checksums.json` entry per declared file. The `files:` block must be
  emitted AFTER `local_path`/`sha256`/`download`/`mmproj` in a manifest's YAML — a key-order rule
  the flat first-match scraper depends on (see `docs/model-policy.md` "Manifest fields").
- `setup-dev.{ps1,sh}` — `NODE_OPTIONS=--use-system-ca npm ci` (R6; lockfile-exact, issue #49) + build + test smoke.
✅ **Packaging** — `apps/desktop/electron-builder.yml` (portable Windows + mac/linux parity;
  `model-manifests/` as `extraResources`; asar; Electron ≥37). `npm run package` / `package:win`
  (root + workspace). New dev dep **`electron-builder ^26.15.2`**. Output → `apps/desktop/release/`
  (git-ignored, added to `.gitignore` alongside the existing `models/`/`*.gguf`/`/runtime/` ignores).
✅ **Docs** — `docs/user-guide.md` (non-technical §17 path) + `docs/troubleshooting.md` (§18) added;
  `docs/packaging.md` + `docs/drive-layout.md` extended (portable build, the scripts, win/mac/linux
  reconciliation). prepare-drive copies user-guide/troubleshooting + `PRIVACY.md` onto the drive.

### Provisioning / asset loader (Phase 12 live)
✅ **Schema** — `shared/manifest.ts` `DownloadSpec` + optional `ModelManifest.download` (validated only
  when present; real `download.sha256` must equal a real top-level `sha256`). Optional
  `download.withdrawn?: string` (issue #196) — a dated note that the pinned upstream file is GONE;
  non-empty string or reject, and it applies to `mmproj.download` too (model-policy.md "Withdrawn
  upstream sources"). `shared/runtime-sources.ts`
  `RuntimeBuild`/`RuntimeSources` + `validateRuntimeSources` (mirror `validateManifest`). The committed
  model manifests (the original six, incl. the later 14B/30B-A3B) carry real upstream URLs + placeholder hashes.
  **(Updated since Phase 12 — see `model-policy.md` for the live catalog and its authoritative
  manifest count (this doc no longer restates a hard total — it drifted twice, see DOC-3/F-20): the
  catalog spans 6 role dirs (chat + E5 + bge-reranker + whisper transcriber + translategemma
  translation + qwen2.5-vl vision), and `runtime-sources.yaml` is pinned to the REAL
  `ggml-org/llama.cpp@b12110` release (= upstream v0.9.0; bumped from b9585 for the Qwen3.5 gate,
  then from b9849 under #512, then from b11146 under #729) with real URLs + SHA-256, plus `whisper_cpp:`/`ocr:`
  asset blocks — the original "b9196 placeholder / one CPU build per OS" text below is the Phase-12
  as-built snapshot.)** The Phase-12 snapshot: `runtime-sources.yaml` referenced
  `ggml-org/llama.cpp@b9196` as a PLACEHOLDER, one CPU build per OS.
  `models.ts` `RESERVED_MANIFEST_FILES` excludes `runtime-sources.yaml` from model discovery.
✅ **`services/assets.ts`** — the canonical, unit-tested asset logic (mirrors `drive.ts`; NO real network):
- `planModelDownloads(root, manifests, {only?, acceptLicense?}) → ModelDownloadTask[]` — only manifests
  with a `download` block; reads fs to mark `present-verified`/`present-unverified`/`download`/
  `license-blocked` (license gate ∧ `acceptLicense`)/`source-withdrawn` (#196 — `download.withdrawn`
  is set and the file would have to be fetched; decided BEFORE the license gate, and the task
  carries the note as `withdrawn`); reuses `weightPath`/`verifyChecksum`. Plans one task per
  declared file with its own `download` block — the weight, the mmproj projector, and every #310
  `files[]` entry that carries `download` (kind `'extra'`) — same job, `DownloadManager` sums their
  bytes and resumes each separately (DIST-1 unchanged).
- `selectRuntimeBuild(sources, {os, arch, backend?}) → RuntimeBuild | null` (default = first os/arch
  match = the CPU build) · `planRuntimeDownload(root, build, version) → {url, zipDest, extractTo,
  binaryPath, sha256, ...}` (escape-guarded) · `runtimeBinaryName(os)`.
- `verifyDownloadedFile(path, expected, label?, signal?) → {ok, actual, reason}` (placeholder/missing/
  mismatch are NOT a pass; an aborted `signal` rejects, #752) · `downloadToFile(url, dest, {fetchImpl?,
  onProgress?})` (injected fetch) · `flushToDevice(path)` (best-effort fsync before a rename) ·
  `isDiskError(err)` · `failureReason(err)` (a content-free label for a failed download, never its
  message) · `formatAssetPlan(modelTasks, runtimePlan)`.
✅ **`scripts/`** (self-contained, dual `.ps1`/`.sh`, OS-native downloader; `.ps1` pure ASCII):
- `fetch-models.{ps1,sh}` — `-Target`/`--target` (req), `-Only`/`--only`, `-Bundled`/`--bundled`
  (the Kit bundled set only, exit 1 when it plans none, #766), `-AcceptLicense`/`--accept-license`,
  `-DryRun`/`--dry-run`. Per `download`-block manifest: download (resume via
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
  unverified, error, stoppedBy? }` (`unverified` = placeholder-hash download, the model stays UNVERIFIED;
  `stoppedBy: 'networkOff'` on a `cancelled` job that switching internet access off stopped, #782);
  `ModelInfo.download?: ModelDownloadInfo { url, sizeBytes, licenseUrl, licenseApproved,
  withdrawn? }` (`withdrawn` = the manifest's #196 note; the card shows it INSTEAD of a Download
  button, and `DownloadManager.start` refuses such a manifest before any request). `sizeBytes` is
  every file the model downloads, summed from their `download` blocks (a vision model's projector
  and any `files:` entry with the weight, #768), or null when any of them declares no `size_bytes`.
✅ **`services/downloads.ts`** — `DownloadGates { policyAllows, settingAllows }`,
  `assertDownloadAllowed(gates)` (friendly, cause-specific refusals: policy vs. Settings),
  `DownloadManager({ fetchImpl?, log?, audit?, onModelInstalled? })` with `start({rootPath, manifest,
  gates, licenseAccepted?, hashStore?}) → Promise<DownloadJob>`, `get(jobId)`, `cancel(jobId)`
  (keeps the `.part`), `activeJob()` (held until the run settles, so a cancelled job stays there until
  it has, #752), and (#314) `list() → DownloadJob[]` / `dismiss(jobId)`. `start()` also refuses, before
  any job exists, a download whose bytes still to fetch exceed the drive's free space
  (`main.download.notEnoughSpace`, #768).
  **`networkSwitched(on, onStopped?)`** (#782; the same method on `EngineDownloadManager` and
  `OcrInstallManager`, all three over one `NetworkSwitch` from `downloads.ts`): internet access was
  switched off (`on` false) or back on. Off: a `queued`/`downloading` job is cancelled at once; a job in
  a local phase stops at its next network request; a start whose planning straddled the switch-off is
  refused with `main.download.networkOff` while the switch is still off (model and OCR; the engine makes
  its job before its first await). On withdraws a stop not yet due. `onStopped` runs once, for a job that
  really stopped. Wiring: `AppContext.downloadsNetworkSwitched` (registerDownloadIpc) and
  `installsNetworkSwitched` (registerEngineIpc: engine + OCR), called by `settings:update` on a real
  `allowNetwork` flip with an `onStopped` that sends `AppContext.runtimeNotice(main.download.stoppedNetworkOff,
  'models')` (index.ts assigns its notifier).
  `list()` returns snapshots of the active job (if any) plus every retained terminal job that is
  still UNRESOLVED and not dismissed, in creation order — never a verified `done`, never a
  `cancelled` one. `dismiss(jobId)` records the id (unknown ids are a no-op) so `list()` stops
  offering it; `pruneTerminalJobs()` drops a pruned job's dismissal record with it, so the set
  stays bounded by `MAX_TERMINAL_JOBS`. One live job at a time; `.part` → verify → rename;
  mismatch deletes the partial; success primes the checksum cache with the hash OF THAT FILE (a
  placeholder-hash file has its entry invalidated instead) — a multi-file model (#310 `files:`, or a
  vision mmproj) updates each file's entry independently as its own task completes. A COMPLETE `.part`
  (cancel/crash during verify, failed rename) is verified in place rather than Range-resumed —
  match renames, mismatch discards + clean restart (F-13, full-audit 2026-07-16).
✅ **`ResolvedModel.requiredPaths: string[]`** (#310, `services/resolve-model.ts`) — every file a
  sidecar-backed role's weight needs, absolute, from `manifestFiles()`; `modelPath` stays the
  primary (shard 1). `resolveSidecarSelection` (`select-sidecar-backed.ts`) reports the role
  unavailable unless EVERY path in `requiredPaths` exists (existence only, no hashing — same
  posture as before); absent/empty falls back to `[modelPath]`.
✅ **`assets.ts` seam (additive):** `DownloadDeps += { signal?, headers?, append?, onResponse? }`,
  `downloadToFile → DownloadToFileResult { status, received, contentLength }` (append only on a
  real 206); `PlanModelOptions += { hashStore? }` (present multi-GB weights are not re-hashed).
✅ **IPC** `ipc/registerDownloadIpc.ts` — `downloadModel(modelId, {licenseAccepted?})`,
  `getDownloadJob(jobId)`, `cancelDownload(jobId)`, and (#314) `listDownloadJobs() →
  DownloadJob[]` (`downloads:list`) + `dismissDownloadJob(jobId)` (`downloads:dismiss`); gates
  re-read per call (policy from disk, setting from the possibly-locked DB ⇒ off) — the last two
  are ungated like `downloads:get`/`downloads:cancel`: read-only / in-memory, no network, no DB,
  no unlock requirement. Preload exposes all five. **Renderer:**
  ModelsScreen Download button (missing/checksum_failed models with a manifest `download`
  block), gate explanations, the confirmation modal (size/license/URL + license-ack checkbox),
  progress + cancel via 1 s polling; SettingsScreen hint updated.
✅ **`shared/downloads.ts` — `isUnresolvedDownloadResult(job)`** (#314): ONE predicate for
  "this finished download is still the user's problem" — `failed`, or `done && unverified ===
  true`. `DownloadManager.list()` filters by it and ModelsScreen derives its result panel from
  it, so the two can never disagree about what survives a reload.
✅ **Job retention and scoping (#314, explicit):** jobs live in **main-process memory for the
  app-process lifetime** — up to 20 terminal jobs (`MAX_TERMINAL_JOBS`), each listed until it is
  dismissed or pruned by newer jobs, whichever comes first. They are **not workspace-scoped**
  (the manager is constructed once at app bootstrap and takes `rootPath` per call), so a
  workspace lock or switch does not clear them. A **renderer reload keeps them** — that is what
  `downloads:list` recovers, by adopting the live job, else the most recent unresolved result.
  A full **app restart loses all of it**: nothing about a job is persisted (job `error` strings
  are session-only by design). Only the resumable `.part` and an already-verified weight survive
  a restart; resuming after one still takes a manual Download click.

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
✅ **Engine and OCR installs (#843, additive):** `engine_install_started | engine_install_finished |
  engine_install_failed`, recorded in `registerEngineIpc` (started once `start()` has resolved, in the
  `engine:download` handler — a job cannot settle before that, and nothing reorders the two — and the end
  from `EngineDownloadManager.onSettled`, whose listener now also gets `EngineJobEnd { reason, cause?,
  preview }`; `kind`, `versions` and `sizeBytes` come from the job's stored plan alone). Neither call can
  fail the install: an audit fault is logged and dropped. Metadata `{ jobId, kind:
  'install'|'update'|'reinstall', families, versions: { <family>: <pin> }, sizeBytes: number|null, trigger:
  'user' }`; a failure adds `reason` (`cancelled`, `networkOff`, `checksumMismatch`, `fileMissing`,
  `placeholderHash`, `download`, `incomplete`, `install`, `notReplaced`, since #986 `noSpace` (no room to
  unpack, refused before anything was touched) and `filesInUse` (the swap's rename was refused and the
  installed copy put back), and `internal` for an exception no
  step caught — the job then ends `failed` instead of staying in a live status) and, for `download`, `cause`
  (`failureReason`: `network`, `http-404`, `write`, …); for `noSpace` (#986) the two byte counts its message
  named, `neededBytes` and `freeBytes` (from the new `EngineJobEnd.space?: { neededBytes, freeBytes }`).
  `ocr_install_started | ocr_install_finished |
  ocr_install_failed` come from `services/ocr-install.ts` through the new `StartOcrInstallOptions.audit?`
  sink, which `registerEngineIpc` wires to `ctx.audit` adding the same `trigger: 'user'`: `{ jobId,
  languages, bytes, trigger }`, plus `outcome` when finished and `reason` (the `main.ocr.*` key's last
  part, `cancelled` or `networkOff`) and `cause` when not; the manager calls the sink inside a guard at both
  ends, so a failing sink never fails or blocks the install. Never `job.error` (friendly copy that can carry
  a path). A request refused before a job exists records nothing, as a model download's. A knowledge-pack
  tools install is an engine job, so it is recorded as `engine_install_*` with `families: ['kiwix_tools']`
  (the labels say "engine or tools"). An end that is still in the recorder's memory buffer (workspace
  locked) when the app quits is lost. The names are permanent: an in-app updater records the same types
  with its own `trigger`.
✅ **`services/offlineGuard.ts` seam (additive):** `AssertOfflinePostureDeps.onViolation?(host)`.
✅ **IPC** `ipc/registerAuditIpc.ts` — `getAuditEvents`, `exportAuditLog` (JSON, save-dialog
  pattern). **Renderer:** Diagnostics Activity card (on-demand, type filter, paging, export).
⚠️ The privacy rule (ids/filenames/counts, never content) is a CONTRACT for every future call
  site — extend the sentinel test when adding events.

### Plug-and-play distribution (Phase 13 live)
✅ **`launchers/`** (repo templates copied to the drive root by the pipeline) — `Start
  HilbertRaum.cmd` (`%~dp0` → set `HILBERTRAUM_DRIVE_ROOT` → spawn `HilbertRaum-*-portable.exe`), `Start
  HilbertRaum.command` (macOS, exec the `.app` binary with the env exported), `start-hilbertraum.sh`
  (Linux, next to the AppImage), `READ ME FIRST.txt` (friendly first-run + SmartScreen/
  Gatekeeper "Run anyway" copy).
✅ **`services/preflight.ts`** — `runPreflight({ rootPath, measureSpeed? }) →
  PreflightResult { rootPath, writable, freeBytes, slowDriveWarning, problems[] }` (spec §11.4 tone;
  non-blocking). Reuses `buildDriveStatus` + `measureDriveSpeed`/`buildWarnings`. `LOW_FREE_SPACE_BYTES
  = 2 GB`. `PreflightResult` lives in `shared/types.ts`. IPC `runPreflight` (`preflight:run`) in
  `registerCoreIpc` → preload `api.runPreflight`; **HomeScreen** shows a non-blocking note.
✅ **`services/commercial-drive.ts`** — the sell gate `assertCommercialDrive(rootPath, manifests, runtimeSources?,
  whisperSources?, ocrSources?, opts?: { platforms, appVersion, families? }) → Promise<CommercialAssertion { ok,
  problems[], checks{ policyCommercial, networkDenied, weightsVerified, licensesApproved, noUserData, runtimeCurrent,
  runtimeHashed, optionalRuntimesConsistent, kiwixSourceBundle, ocrAssetsVerified, appSkillsPresent, userSkillsEmpty,
  licenseArtifactsPresent, platformMatrixDeclared, appArtifactsPresent, launchersPresent }, modelResults }>`. Never
  throws; every failed check adds a `problems[]` line. `noUserData` (#893) is a rule, not a list of names: no entry
  directly in `workspace/` or `logs/` (`USER_DATA_DIRS`; a file or a link, never followed, is named `<dir>/<name>`, a
  non-empty folder `<dir>/<name>/*`, an empty folder passes) and no `config/workspace.json*` or
  `config/working-copy-lost.json*` (`USER_DATA_CONFIG_FILES`, exact or `<name>.*`, any case); one sorted problem per
  entry, `user data present on a drive meant to ship empty: <path>`. It fails closed: `workspace/`, `logs/`, `config/`
  or a folder directly in the first two that cannot be listed (no read or enter right), and a file where one of the
  three folders belongs, each add `user data unreadable on a drive meant to ship empty: <dir>/` or `<dir> (not a
  folder)`; only a missing path (ENOENT) passes. A link is what Node's `Dirent` calls one (a symlink, a junction; a
  cloud placeholder folder is a folder). The builders' native pre-flight states the same rule (`user data present:
  <path>`, `user data unreadable: <path>`; `script-drift.test.ts` pins both lists). The Kit rule (#766): a model SHIPS when it is bundled
  (`bundled_on_preconfigured_drive`) or has any file on the drive; at least one model is bundled, every shipped weight
  is VERIFIED (`weightsVerified`) and every shipped model's `license_review.status` is `approved` (`licensesApproved` —
  `--accept-license` never overrides it); a manifest with no file on the drive is the in-app catalog and is not checked.
  The runtime pins are opt-in (`runtimeCurrent` / `runtimeHashed` read each build's `.hilbertraum-runtime.json`);
  without `opts` the drive is not sellable (`platformMatrixDeclared`). The CLI `out/tools/assert-commercial-drive.mjs`
  (`--target --platforms --app-version [--json]`; exit 0 sellable / 1 not / 2 usage, an unknown platform included) runs
  it on a drive's own manifests and pin; `--json` prints one `{ ok, problems, checks }` line on stdout, any log
  line goes to stderr (#767). The TS build plan (`planCommercialDrive`/`formatPlan`) had no caller and was removed (#770).
✅ **`scripts/build-commercial-drive.{ps1,sh}`** — self-contained dual-shell master pipeline; `-Target`/`--target`
  (req), `-AcceptLicense`, `-AppArtifact` (pre-built signed apps to copy, one per platform), `-Platforms` (default all
  three), `-KiwixSourceDir`, `-SkipPackage`, `-VerifyOnly`, `-DryRun` (each also `--kebab-case` in the .sh).
  Orchestrates prepare-drive (`-Force`) → fetch-models `--bundled` → fetch-runtime (every OS, `--commercial`) →
  [kiwix source bundle, then kiwix_tools] → (package = manual) → copy launchers+docs → verify-models `--generate` →
  native pre-flight (verify-models `--kit` for the weights) + the canonical gate above, which alone prints SELLABLE.
  Before step 1 it refuses a missing `-AppArtifact` and a differently named prior app at the root (exit 1). PS uses
  **hashtable** splatting for named params.
✅ **Packaging/signing** — `electron-builder.yml` `win.signtoolOptions` + `mac.notarize`/
  `hardenedRuntime`/`gatekeeperAssess:false`/`entitlements: build/entitlements.mac.plist`; secrets are
  env-driven + git-ignored. The green gate does NOT sign (it never runs electron-builder).
✅ **Tests** — `tests/integration/preflight.test.ts` (ok/slow/read-only/low-space at the shipped floor/
  unmeasurable) + `tests/integration/launcher-execution.test.ts` +
  `tests/integration/commercial-drive.test.ts` (`assertCommercialDrive` passes verified-commercial, fails
  network/plaintext/placeholder-weight/user-data, …) + `script-execution.test.ts` / `script-orchestration.test.ts` (the
  builder and the gate CLI executed). **Signing + notarization + the real USB launch = manual (R5/R7).**

### Evidence Pack / Review Mode (EP-1 Phases 0–6 live — contracts, storage, snapshot engine + IPC, review UI, HTML + PDF export, freshness, selections)
The wave is CLOSED (2026-07-18); the durable design record is `architecture.md` "Evidence
Pack / Review Mode — design record (EP-1, §1–§8)" — its §-anchor legend resolves the
historical `plan §N`/`spec §N` citations below (the retired plan survives at
`git show b77295c0:docs/evidence-pack-implementation-plan.md`). This section records the
AS-BUILT shapes; P5 was renderer/i18n-only — no shared-shape changes.

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
  state; `availabilityAtCreation` is nullable and reported only for resolved identities;
  **P2 (ZIM wave #301, PR #294 review H2/M11, 2026-09-05)** added four ADDITIVE fields —
  `sourceKind: 'document' | 'archive'` (always written; absent/`'document'` = the classic
  document source), `archiveTitle`, `packId` (`knowledge_packs.id`, the pack's UUID),
  `articlePath` (archive sources only, else null) — no new storage column,
  `SCHEMA_VERSION` unchanged; an archive source is forced `identity:'unresolved'` with
  null `documentId`/`documentSha256`/`mimeType`/`availabilityAtCreation` before either
  resolver branch runs, and `packId`/`articlePath` are the source's stable locator
  carried through every export),
  `EvidenceGenerationSnapshot` (spec §18.3 but **every field optional** per plan §1.3 — absent
  renders "Unavailable", never invented; `answerEndedEarly` (#612; it replaced #600's never-released
  `answerStopped` boolean) records why the answer ended early — `EndedEarly`, a model stop, the Stop
  button or lock/quit, `null` on a complete answer — so the pack names the cause instead of "No output
  truncation was recorded"),
  `EvidenceLink`, `EvidenceReviewItem`,
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
  `removeEvidenceLink`, `recordEvidenceExport`, `listEvidenceExports`. The pure
  `deriveReadyGate` (D-7: required = non-heading block items, NULL `blockKind` counts as
  required; 'not_applicable' counts as decided; selections never gate) lives in
  `shared/evidence-review.ts` since #839: the renderer's review store runs the same function
  for live progress (it was a byte-identical renderer copy, `computeReadyGate`, under an
  equivalence matrix; that name is still exported from `reviewSession.ts` for PR #511).
✅ **Audit literals (types only — no emitter until Phase 1):** `evidence_review_created`,
  `evidence_review_ready`, `evidence_review_deleted`, `evidence_pack_exported`. Metadata
  contract: ids/counts ONLY — never titles, notes, reviewer labels, snippets, or paths.
  (The exhaustive Diagnostics label record forced the matching `diag.audit.*` EN/DE keys to
  land now; behaviorally inert until an event exists.)
✅ **Tests:** `tests/unit/evidence-review-gate.test.ts` (D-7 matrix, the pure snapshot parsers,
  and the spec-§9.1 `isReviewEligible` rule) +
  `tests/integration/evidence-reviews.test.ts` (schema on fresh/reopened DBs via `listTables`;
  decided items, notes and the reviewer label surviving a reopen (the restart leg, moved from
  `evidence-reviews-ipc.test.ts`); a pre-P4 workspace gaining `freshness_ack_json`;
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
  since #643 `capped` + `labelledExcerpts` → `direct_excerpt`, labelled and auto-linked;
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
✅ **Eligibility rule (`shared/evidence-review.ts`):** pure `isReviewEligible(message)` (spec §9.1):
  assistant ∧ (citations non-empty ∨ coverage present). **#976 (follow-ups wave 6, G-7):** the spec's third
  leg, "or the conversation is a documents conversation", is gone: a small-talk reply, the fixed no-context
  reply, a routing answer, a refusal, a "use the button" pointer and the deterministic coverage-extract
  listing carry neither field and have nothing to review. The predicate no longer takes a conversation. A
  message that already has a review keeps its entry whatever it carries: the renderer shows the action
  on `isReviewEligible(m) || reviewSummary != null`, and `ChatScreen` stores every summary the one batch
  read (`evidence:summariesForConversation`) returns, and runs that read once for a documents conversation
  even when none of its answers has sources. No main-side change: `createEvidenceReviewFromMessage` still
  checks only the role. "Persisted and not streaming" stays the caller's gate (a streaming reply has no
  row yet) — Phase 2 wires it.
✅ **IPC surface (`evidence:*` in `shared/ipc.ts`; handlers in
  `main/ipc/registerEvidenceReviewsIpc.ts`, wired in `main/index.ts`; preload methods of the
  same names on `window.api` — 13 shipped in Phase 1, `evidence:countForConversation` added
  in Phase 2 for the D-2 delete confirm, `evidence:export` added in Phase 3 with its
  pipeline, `evidence:acknowledgeFreshness` + `evidence:sourceContext` added in Phase 4,
  `evidence:summariesForConversation` + `evidence:bulkAction` added by the AUD-12/AUD-13
  remediation as the BATCH forms of two surfaces that previously fanned out per message /
  per item; #840 removed `evidence:getForMessage` and `evidence:delete`, which no screen
  called, so 17 remain):**
  | preload method | channel | shape |
  |---|---|---|
  | `createEvidenceReview(messageId)` | `evidence:create` | → `EvidenceReviewDetail`; IDEMPOTENT (existing review returned, audit only on real creation); throws localized `invalidRequest` on a malformed id, ids-only errors on unknown/non-assistant message |
  | `getEvidenceReview(reviewId)` | `evidence:get` | → `EvidenceReviewDetail \| null` |
  | `getEvidenceReviewSummariesForConversation(conversationId)` | `evidence:summariesForConversation` | → `EvidenceReviewSummary[]` — **AUD-12**: the chat transcript's whole chip state in ONE round trip, keyed by `messageId` renderer-side. Each element is a review's head + its gate (the `EvidenceReviewSummary` shape; main's per-message `getEvidenceReviewForMessage` builds the same shape, and its one product caller is `evidence:create`'s idempotency check) with the derived `outdated` overlay. Service side it is TWO statements for any conversation length — one indexed head read on `conversation_id`, one join for the item rows the gates derive from. `[]` for an unknown/malformed id |
  | `updateEvidenceReview(reviewId, patch)` | `evidence:update` | → `EvidenceReview \| null`; malformed patch fields DROPPED, never coerced |
  | `updateEvidenceReviewItem(itemId, patch)` | `evidence:updateItem` | → `EvidenceReviewItem \| null`; unknown decision literals dropped (stored decision untouched) |
  | `applyEvidenceReviewBulkAction(reviewId, action)` | `evidence:bulkAction` | → `EvidenceReviewItem[] \| null` — **AUD-13**: one of the three sanctioned conservative sweeps (`EvidenceReviewBulkAction` = `'headings_not_applicable' \| 'clear_decisions' \| 'undecided_follow_up'`) applied to the whole review in ONE transaction, returning the refreshed items. Null on an unknown id, an UNRECOGNIZED action name (never mapped onto a nearby one), and on a READY review (the same write guard the per-item patch enforces). The head activity stamp moves only when the sweep matched something. The forbidden blanket "mark all supported" has no literal in the union, so it cannot be requested |
  | `createEvidenceSelection(reviewId, input)` | `evidence:createSelection` | → `EvidenceReviewItem \| null` (null = refused offsets — never clamped) |
  | `deleteEvidenceSelection(itemId)` | `evidence:deleteSelection` | → `boolean` (blocks refuse) |
  | `setEvidenceLink(itemId, key, input)` | `evidence:setLink` | → `EvidenceReviewItem \| null`; **origin FORCED to `'reviewer'`** — only the snapshot builder mints `'answer_marker'` (a renderer payload can never fake "cited by the answer") |
  | `removeEvidenceLink(itemId, key)` | `evidence:removeLink` | → `boolean` |
  | `markEvidenceReviewReady(reviewId)` | `evidence:markReady` | → `{ review, gate } \| null` (refuses + gate says why while ineligible; an ALREADY-ready review is a NO-OP — original `completed_at` kept, no second audit event; the service returns an additional `becameReady` flag the handler audits on and STRIPS from the wire — review FIX-5) |
  | `reopenEvidenceReview(reviewId)` | `evidence:reopen` | → `EvidenceReview \| null` |
  | `refreshEvidenceReviewState(reviewId)` | `evidence:refreshState` | → `EvidenceReviewFreshness \| null` — **REAL since Phase 4** (spec §21.2): snapshot vs workspace from STORED facts only — document existence by snapshotted id, stored `documents.sha256` vs snapshot hash (**never re-hashed**), `messages.content` vs `answer_snapshot` (exact), coverage semantic-fields compare. Unresolved identities report `'unverifiable'`, NEVER `'changed'`. No model, no network, no file I/O |
  | `acknowledgeEvidenceReviewFreshness(reviewId)` | `evidence:acknowledgeFreshness` | → `EvidenceReviewFreshness \| null` — Phase 4 (spec §15.5/§28.6): persists `{acknowledgedAt, fingerprint}` into `freshness_ack_json`; the fingerprint canonicalizes the CURRENT drift so a LATER change lapses the acknowledge. NO-OP on a non-outdated review (nothing written). Writes ONLY its own column — status/completed_at/updated_at untouched (§18.4), NOT subject to the ready-state write-guard (lifecycle metadata, not a decision edit). No audit event (not a spec-§22 type) |
  | `getEvidenceSourceContext(reviewId, sourceKey)` | `evidence:sourceContext` | → `EvidenceSourceContext \| null` — Phase 4 (D-5, spec §10.2.4): the STORED extracted text (`chunks` table — never a source-file read) around one source's persisted excerpt, resolved from the review's OWN snapshot (`documentId` never crosses the wire from the renderer). Ladder: snapshotted `sourceChunkId` (verified to belong to the snapshotted document — a foreign chunk id never leaks another document's text) → stored-text containment search (`instr`) → honest `located:false`. Context = located chunk ± one neighbor, ≤1200 chars/side, surrogate-safe boundaries. Null on unknown review/key and on unresolved-identity sources |
  | `countEvidenceReviewsForConversation(conversationId)` | `evidence:countForConversation` | → `number` — Phase 2 (plan §7.6, D-2): the conversation-delete confirm names how many reviews the cascade removes. Count only, never content; malformed/unknown ids read `0` |
  | `exportEvidencePack(reviewId, options)` | `evidence:export` | → `EvidenceExportRecord \| null` — Phase 3 (plan §8.3): save dialog → deterministic HTML render → ATOMIC write (tmp sibling → fsync → sha256 of the ON-DISK bytes → rename) → `evidence_exports` row. Null on unknown/malformed id (no dialog) or user cancel; any failure UP TO the rename leaves no destination file and no row (spec §28.9). A POST-rename record failure (workspace-DB error, or the review deleted in another window while the dialog was open) UNLINKS the just-written file and REJECTS with distinct localized copy (`main.evidenceReviews.exportNotRecorded`; if even the unlink fails, `…exportFileNotRecorded` states the file exists WITHOUT a history record) — null never means "exported", and a real export is never reported as a cancel (fix round FIX-1). Works on draft AND ready reviews (the ready guard covers item mutations only — tested). `options: EvidencePackExportRequest` (= `Partial<EvidencePackOptions> & {format?}`) resolves against `EVIDENCE_PACK_OPTION_DEFAULTS` main-side; the RESOLVED option set persists to `options_json` (the format NEVER does — `evidence_exports.format` is its column). **P6 (plan §11): PDF over the SAME channel** — `format: 'pdf'` (literal only; anything else reads 'html') prints the SAME rendered HTML through the hidden-window harness AFTER the dialog; the save dialog OFFERS both filters (requested first) and the chosen extension has the final word (`packFormatForDestination`: `.pdf`⇒pdf, `.html`/`.htm`⇒html, else the request — file content, extension and recorded format always agree). A failed/killed print = a pre-rename failure: no file, no row |
  Every handler `requireUnlocked()` (`main.evidenceReviews.locked`, EN+DE; auto-enforced by
  `ipc-lock-coverage.test.ts`). **Ready-state write guard (Phase-2 review FIX-1, spec
  §18.4):** while a review is `ready`, the six ITEM-LEVEL mutations (`updateEvidenceReviewItem`,
  `applyEvidenceReviewBulkAction`, `setEvidenceLink`, `removeEvidenceLink`,
  `createEvidenceSelection`, `deleteEvidenceSelection`)
  REFUSE through their normal null/false channel — `ready` + undecided is a state the D-7 gate
  can never produce, so it must be unreachable by mutation too; reopen first. HEAD edits
  (`updateEvidenceReview`: title D-6 / reviewer label D-3 / general note) stay allowed.
  Type `EvidenceReviewFreshness` shipped in P1 as `{ reviewId, outdated }` and was widened
  ADDITIVELY in P4 (all new fields optional on the wire — see the Phase-4 block).
✅ **Audit emitters:** `evidence_review_created` (`{reviewId, messageId,
  conversationId, itemCount, sourceCount, autoLinkCount}`), `evidence_review_ready`
  (`{reviewId, requiredTotal, decidedTotal}`), and — Phase 3 — `evidence_pack_exported`
  (`{reviewId, format}` **only**: the destination path, the bare file name and the review
  title, which seeds the suggested name, are content and never audited) — ids/counts ONLY;
  review titles/labels/notes/answer text/source titles AND the export path are sentinel-swept
  through the REAL handlers in `audit-ipc.test.ts`. `evidence_review_deleted` (`{reviewId}`)
  had one emitter, the `evidence:delete` channel, which no screen called (the app has no
  review delete, B-03); #840 removed the channel, so no build emits it now. The literal and its
  `diag.audit.*` label stay, so rows an older build wrote still read.
✅ **i18n:** `main.evidenceReviews.locked` + `main.evidenceReviews.invalidRequest` (emission
  set) and persist-canonical `main.evidenceReviews.defaultTitle` ('Evidence review' — the
  fallback written to `evidence_reviews.title` when a conversation title trims empty; in
  `DISPLAY_MAP_KEYS` like `main.chat.defaultTitle`). All EN+DE.
✅ **Phase-1 tests:** `tests/unit/evidence-segment.test.ts` (markdown zoo, stable keys,
  marker parity against the real display rewrite incl. the two boundary-spanning repros
  two-sided — FIX-3) + `tests/integration/evidence-snapshot.test.ts` (per-answer-class
  builds: relevance auto-links, whole-doc/extract ZERO links, unknown-present-mode weakest
  class — FIX-1, legacy no-citation, unresolved-title, deleted-source, empty answer,
  default-title fallback, nearest-preceding question turn, determinism, end-to-end
  display-parity links, and the FIX-2 atomicity leg: an injected SQLite-trigger failure
  mid-build rolls back the three tables the build writes (head, items, links) and surfaces
  the original error) + `tests/integration/evidence-reviews-ipc.test.ts` (the full
  create→read→update→decide→select→link→ready→reopen→refresh round trip over the
  mocked-electron harness incl. a documentId-resolved source and a real selection deletion —
  the four answer classes are the builder's, pinned in `evidence-snapshot.test.ts` — payload
  guards, reviewer-origin forcing, the real freshness verdict over the wire, idempotent
  create, markReady already-ready no-op — FIX-5, **runtime tripwire + the real offline
  connect-guard asserted after every test of the file** (`tripwireRuntime` /
  `useOfflineGuard`, `tests/helpers/evidence-fixtures.ts`) — the plan §6
  no-model/no-network assertions) + new legs in `audit-ipc.test.ts` and
  `ipc-lock-coverage.test.ts`; the spec §9.1 `isReviewEligible` rule is pinned in
  `tests/unit/evidence-review-gate.test.ts`.

**Phase 3 — evidence-pack export, self-contained HTML (as built):**

✅ **Types (`shared/types.ts`):** `EvidencePackLanguage` ('en'|'de' — the pack's content
  language, chosen at export and FROZEN into the file; never re-localized later. The renderer
  maps its UI language through `packLanguageFor(uiLanguageInfo(lang))` (`shared/evidence-review.ts`,
  UI-languages owner call D-5 (b), 2026-11-11; architecture.md i18n record D-L11): the UI language when its
  registry entry has `evidencePack: true`, else `'en'`, so it is always one of these two values,
  whatever the UI language — English and German write their own; the other eight, Spanish,
  French, Italian and Russian (registered 2026-11-12) and Dutch, Polish, Turkish and Ukrainian
  (registered 2026-11-13), all `evidencePack: false`, map to `'en'`) and
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
  unknown keys dropped, language kept only when `isPackLanguage` ('en'/'de'), else 'en') and
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
  newPackId?, now?})` — load → resolve format+options → mint packId+generatedAt
  (PRE-dialog — the P4 TOCTOU posture: verdict + stamps all pre-dialog) → dialog
  (injected; the electron dialog lives at the IPC layer; `chooseDestination(
  suggestedFileName, format)`) → build+render ONCE, AFTER the dialog (P6 FIX-1: the
  EFFECTIVE format is threaded into the model — `EvidencePackModel.format:
  EvidenceExportFormat`, meta gains `format` — so the cover/Integrity "Format" line
  states what the artifact IS: `packExport.meta.formatValuePdf` on PDFs, the P3
  `formatValue` on HTML; exactly ONE line branches — pinned by a byte-level swap test —
  and cancel renders nothing) → [PDF only, P6: `renderPdf(html, {packId})` — the injected
  hidden-window print, fed the render output VERBATIM; #563 dropped `sourceHtmlPath`]
  → `writePackFileAtomic(dest, content, packId)` (tmp
  sibling → fsync → hash the READ-BACK on-disk bytes → rename; accepts string OR Buffer —
  the SAME tail serves both formats; failure removes the tmp and rethrows — no half-written
  destination ever) → `recordEvidenceExport` (row only AFTER the final file exists + is
  hashed, spec §20.3; bare `file_name`, the EFFECTIVE format, resolved options into
  `options_json`). `renderPdf` is REQUIRED (a missing printer can never silently degrade a
  PDF request).
  **The transient sibling is named PER EXPORT, never from the destination alone
  (AUD-17):** `packTmpPath(dest, packId)` → `${dest}.<packId token>.tmp`, minted by the private
  `exportToken` helper: the pack id's alphanumerics, capped at a UUID's 32 hex characters;
  an id that sanitises away falls back to a random token — no content can reach a file
  name. (Until #563 it also named the PDF print source, `printSourcePath` →
  `${dest}.<packId token>.print.tmp.html`.) Two exports saving to the SAME path must share no transient at all: they used to
  share both, and the collision — documented at the time as "the loser fails cleanly" — in
  fact let one export read back, hash, and rename the OTHER review's bytes under its own
  `evidence_exports` row, while the PDF seam let a print pick up the other pack entirely.
  `writePackFileAtomic` therefore takes `packId` as a REQUIRED third argument: the
  read-back hash is only trustworthy if nothing else can write that file between the fsync
  and the read. What two same-destination exports still share is the DESTINATION itself
  (later rename wins — the user's own instruction). Since #563 the PDF print writes no file at
  all (harness block below); the AUD-16 cleanup (one retry + an ids-only `log.warn`) went with
  the file.
  Encoding (string content): UTF-8 **without** BOM (unlike md/txt/csv `bomFor` — the
  `<meta charset>` is the contract; recorded hash = on-disk bytes).
  `suggestedPackFileName(title, format)` = the review title through the shared file-name rule
  (content — which is why path/name never reach audit) + the format's extension. The rule is
  `fileNameStem(title, { fallback, keepParens?, maxCodePoints? })` (`main/services/text.ts`, #899):
  NFC first, and every space, tab, line break or no-break space becomes a plain space; letters,
  numbers, space, `_`, `-` (and `(` `)` with `keepParens`), a combining mark only inside
  a character that holds a letter or number (a vowel sign stays, and a keycap `1️⃣` keeps its
  selector, its base being a number; a stripped emoji's variation selector goes with it); format
  characters go, ZWJ and ZWNJ included; whole characters (graphemes) up to 60 code points
  (never half an astral letter, #839, nor a letter without its vowel sign; a character carrying
  more marks than the whole cap keeps only its letter, one holding more letters than the cap is
  left out); composed again (NFC) once built; no leading space or `-`, no trailing space, `-` or
  opening `(` (`_` stays at both ends); the fallback (`evidence-pack`
  here) when no letter or number is left; `_` appended to a Windows device name (`CON`, `NUL`,
  `COM1`, …). The chat transcript export (fallback `chat`) and the three document exports
  (`documentFileName` in `registerDocsIpc.ts`: the title's extension is cut only when it is one, a
  dot then 1-10 letters or digits, and the original export keeps it; fallback `document`, with
  `(` `)`; a trailing "(…)" group such as a translation's "(Deutsch)" kept whole, the name
  before it cut instead) build their suggested names through the same rule.
✅ **PDF print harness (P6, `main/services/evidence-pack/print-pdf.ts` — plan §11/D-1):**
  `printEvidencePackHtmlToPdf(html, {packId})` → PDF `Buffer`. Dedicated
  hidden `BrowserWindow` per print — `SECURE_WINDOW_WEB_PREFERENCES` spread (sandboxed),
  **no preload at all** (no IPC surface; wiring-pinned in `window-security.test.ts`),
  window-open + will-navigate/will-redirect ALL denied; holds the page in memory
  (#563: `printPages.open(html)` in `app-protocol.ts` → `{url: hilbertraum://print/<64 hex>,
  release}`; served once by the scheme handler with `EVIDENCE_PACK_CSP`, `nosniff`,
  `no-store`; at most `PRINT_MAX_PENDING` = 4 slots, a fifth print throws before any window;
  `release` in `finally`), `loadURL` (= did-finish-load) → `document.fonts.ready` →
  `printToPDF` with the FULL
  D-1 option set (verified supported by the installed Electron 43 types, and re-smoked on
  the packaged Electron 43.4.0 / Chromium 150 build — DEP-4 P4, 2026-08-18: every option
  accepted, output a valid `%PDF-1.4 … %%EOF`, and `generateTaggedPDF` produced actual
  `StructTreeRoot`/`MarkInfo` structures): `pageSize:'A4'`,
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
  (`reviewSession.ts`): `exportReviewPack(options)` DRAINS pending edits first (saves in
  passes until nothing is queued, #889 — an edit made while that save was writing is in the
  pack too; the pack renders persisted data; a failed save REFUSES, and so does an edit still
  queued when the drain's passes run out — pinned by test), then
  merges the returned record into `detail.exports` newest-first under the `openToken`
  staleness guard. Outcomes: 'exported' | 'cancelled' (native-dialog cancel — silent) | 'failed'
  (+friendly copy, rendered inline in the panel). A token change (lock/switch) landing
  AFTER a successful export still returns 'exported' (state untouched — the export is
  real; only a genuine rejection reports 'failed'; the lock case is pinned in
  `reviewSession.test.ts` › "an export that %s after the lock purge reports the truthful
  outcome and leaves the purged store empty").
✅ **Phase-3 tests:** `tests/unit/evidence-pack-model.test.ts` ×13 (option boundary, §16.1
  normalization, honesty-mapping reuse pin, option matrix) +
  `tests/unit/evidence-pack-html.test.ts` ×26 (escapeHtml, §29.4 injection suite incl.
  hostile source key/machineLabel/sha256/raw coverage mode + the structural remote-ref
  sweep over the HOSTILE render, §17.2 self-containment, D-1 print contract, EN/DE
  freezing, ordinal-stable item numbering, zone-less-timestamp verbatim, determinism) +
  `tests/integration/evidence-pack-export.test.ts` ×15 (the five §29.5 GOLDEN packs under
  `tests/fixtures/evidence-packs/` — relevance/whole-doc/partial-coverage/missing-source/
  German, normalized timestamps + pack ids, regenerate via `UPDATE_EVIDENCE_PACK_GOLDENS=1`;
  atomicity (failing write, short write and failing rename leave no file, no tmp, no row:
  `evidence-pack-export-async-fs.test.ts`); the two POST-rename record-failure paths —
  injected INSERT trigger, review deleted mid-dialog — unlink the destination and throw
  `EvidencePackRecordError`; cancel → nothing; no-BOM encoding;
  recorded-hash-matches-file-bytes; ready-review export; real offline guard across every
  test) + export legs in `evidence-reviews-ipc.test.ts` (cancel; both
  post-rename failures surface their LOCALIZED distinct copy — `exportNotRecorded` with the
  file removed, `exportFileNotRecorded` with the file kept unrecorded — with no row and no
  audit event; malformed/unknown ids → null without opening the dialog; hostile options →
  resolved defaults persisted; runtime tripwire) and `audit-ipc.test.ts` (a ready review
  exported over the wire to a path-sentinel destination; event = `{reviewId, format}`
  exactly) + `tests/renderer/ReviewExport.test.tsx` ×9 (panel
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
  unparsedChunks/fullyChunked, and since #643 `labelledExcerpts` when it is set) — `nodeIds` +
  unknown extras excluded (plumbing, not claims). `labelledExcerpts` canonicalizes only when
  `true`: unset it is omitted, so every coverage stored before the field existed digests to the
  same bytes and no acknowledgement lapsed (the AUD-19 pin still holds, now with the field set false).
  **That projection is a stored-data contract, and it is exhaustiveness-constrained (AUD-19).**
  Its canonical string is digested into the persisted fingerprint below, so changing *which*
  `CoverageInfo` fields it covers — or their order — lapses EVERY acknowledgement already
  stored in every workspace (signed-off reviews silently re-close the export gate). The
  projection literal therefore `satisfies Record<keyof CoverageInfo, unknown>`: a coverage
  field added to `shared/types.ts` and not listed is a COMPILE error, never a field silently
  dropped from drift detection (which would let an export proceed with no outdated banner and
  no acknowledge gate). Deliberately-excluded plumbing is listed with `undefined` — present
  for the constraint, omitted by `JSON.stringify`, so the emitted bytes are unchanged. An
  integration test pins both the exact fingerprint bytes and the field-set parity.
  `acknowledgeEvidenceReviewFreshness(db, reviewId)` writes `freshness_ack_json`
  `{acknowledgedAt, fingerprint}`; the fingerprint is the sorted canonical string of every
  non-'unchanged' fact **including the observed current value** (fix round FIX-1:
  `src:{key}=changed:{current sha}`, `answer=changed:{digest(current text)}`,
  `coverage=changed:{digest(canonical current)}`; missing/unverifiable stay state
  literals — no value exists), so ANY later drift change lapses the acknowledge — incl. a
  RE-change of an already-changed fact (sha ff→ee after acknowledging aa→ff), a second
  answer edit, changed→recovered→changed-again (no stale-ack resurrection), and a NEW
  deletion (adds a fact). Hashes only, inside the encrypted row. Also exports
  `compareStoredHashes` (the ack parser is module-private).
✅ **Read overlay (IPC boundary):** `evidence:get` + `evidence:summariesForConversation` responses
  carry the REAL computed `outdated` (the chat chip + a fresh open render truthfully);
  SERVICE-level reads and every write-path return (`update`/`markReady`/`reopen`/`create`)
  keep the constant-false overlay — the renderer's freshness UI reads the store's refresh
  result exclusively, never a write-return's flag.
✅ **Export pipeline (P4 change, spec §20.1):** `exportEvidencePackToFile` now EXECUTES the
  refresh step — computes the verdict up front, REFUSES an outdated review whose drift is
  unacknowledged (`EvidencePackOutdatedError` → localized
  `main.evidenceReviews.exportOutdated`, thrown BEFORE any dialog/file work), and INJECTS
  the verdict into `buildEvidencePackModel(detail, options, meta, freshness?)` (4th
  OPTIONAL param — the model stays pure; the goldens run the real export pipeline, so their verdicts come from the seeded workspace). Pack rendering:
  cover outdated warning + acknowledge stamp (§21.3 "prominent snapshot warning"),
  coverage-section mismatch records (`packExport.coverage.answerChangedNow`/
  `coverageChangedNow`/`sourcesChangedNow`/`sourcesMissingNow` — missing counts NEW
  deletions only) + `freshnessChecked` note (the P3 fixed `freshnessNote` is the pure
  model's no-verdict branch, reachable only by direct model/render callers such as tests; every
  exported pack carries `freshnessChecked`), per-card §15.4/§15.5 warnings, and the §16.1.7 source
  register column becomes **Availability at export** (available / changed-since-review /
  missing / cannot-verify from `EvidencePackSource.currentState`). A deleted source NEVER
  blocks export (§28.7). Model additions: `EvidencePackFreshness` + `outdated` overridden
  by the injected verdict + `EvidencePackSource.currentState` (null = no verdict, P3 shape).
✅ **Source-in-context (`main/services/evidence-pack/source-context.ts`, D-5):**
  `getEvidenceSourceContext(db, reviewId, sourceKey)` — see the IPC table row for the full
  resolution ladder + security posture. The context window is 1200 stored-text characters per
  side (`CONTEXT_WINDOW_CHARS`, module-private).
✅ **Renderer:** store (`reviewSession.ts`) gains `freshness` state +
  `refreshReviewFreshness()` (module-internal; fired automatically after every successful
  open — fire-and-forget, `openToken`-guarded; a failed check leaves the last honest state) +
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
✅ **Phase-4 tests:** `tests/integration/evidence-freshness.test.ts` ×31 (engine verdicts
  incl. unresolved-never-changed under mutation AND deletion of same-titled docs,
  hash-absent unverifiable, answer/coverage drift, reserialized-coverage false-positive
  pin, ready-not-erased; acknowledge persist/no-op/lapse-on-new-drift/malformed-record/
  lifecycle-stamps-untouched + the FIX-1 value-bearing-fingerprint legs (re-change lapse,
  second answer edit, changed→recovered→changed-again no-resurrect, canonical stored
  shape); the export gate's two other proofs live in `evidence-pack-export.test.ts`
  (refused before any dialog or print: "outdated-unacknowledged refuses BEFORE any dialog
  or print work — the P4 order holds for PDF"; the §28.6 pack recording: the
  `outdated-acknowledged` golden) + §28.7 deleted-source export + MIXED changed+deleted
  drift end-to-end incl. new-deletion-lapses-acknowledge; IPC legs for the new channels +
  real read overlay + the LOCALIZED outdated-export rejection over the wire (FIX-6: no row,
  no audit event); source-context located/mismatch/stale-chunk-id/
  foreign-chunk-id-leak-guard/missing/not-located/truncated-snippet — all
  under the REAL offline guard, with NO document files on disk anywhere) + the 6th GOLDEN
  `outdated-acknowledged` (+ regenerated 5 — freshness note + at-export column) + P4
  describe blocks in `evidence-pack-html.test.ts` ×5, `ReviewScreen.test.tsx` ×10 (refresh
  ON OPEN, banner/chip/badges, banner names newly-missing facts, acknowledge flow,
  missing-without-banner, unresolved-badge-only, resolved-cannot-verify badge,
  creation-missing keeps only its creation badge, context modal ×2), `ReviewExport.test.tsx`
  ×3 (export gate), `reviewSession.test.ts` ×5 (refresh-on-open, no-refresh-on-failed-open,
  openToken purge guard, acknowledge merge/failure), `ReviewEntryPoints.test.tsx` (Outdated
  chip joins Ready), `GermanSmoke` (outdated overlay DE). Review renderer test files
  (incl. `lockPurge.test.ts`'s review leg) stub the refresh structurally via
  `stubReviewApi` (`tests/helpers/evidenceReview.ts`).
✅ **Phase-6 tests (PDF):** `tests/unit/evidence-pack-print-pdf.test.ts` ×9, ×12 since #563,
  ×10 since the 2026-11 test audit (the served-once and two-print rows were duplicates of
  `app-protocol.test.ts` and `evidence-pack-export-concurrent.test.ts`; fake electron: the
  D-1 option literals + footer no-@font-face/escaping pins, preload-free sandboxed posture
  + deny-all navigation, teardown on success/print-failure/load-failure/
  app-quit-mid-print/step-timeout — runs everywhere incl. CI) + `evidence-pack-export.
  test.ts` P6 describe ×6, ×5 since the 2026-11 test audit (seam contract: verbatim html +
  the per-export `${dest}.<packId token>.print.tmp.html` (since #563: `{packId}` only, and
  nothing but the PDF beside the destination) + the PDF self-description line;
  extension-override both directions incl. the format line following the EFFECTIVE
  format; cancel-under-PDF ⇒ no print/no file/no row;
  killed-print ⇒ no file/no siblings/no row; outdated-refusal BEFORE dialog AND print) +
  the post-rename unlink on PDF, now the `FIX-1b (pdf)` row of the atomicity describe +
  helpers +3 new (Buffer atomic write, both format resolvers; the pre-existing
  `suggestedPackFileName` test extended for the format param) +
  `evidence-pack-html.test.ts` +1 (format-line branch: PDF wording on
  cover AND integrity, byte-level one-line-swap equivalence pin) +
  `evidence-reviews-ipc.test.ts` ×2 (dialog
  filter list both-formats/requested-first through the REAL handler + REAL harness on a
  fake BrowserWindow; audit `{reviewId, format:'pdf'}`; malformed format → html-first) +
  `ReviewExport.test.tsx` +1 (PDF sends `format:'pdf'`; the defaults test now pins the
  radio: HTML checked) + `window-security.test.ts` +1 (print window preload-free) +
  **`evidence-pack-pdf-smoke.test.ts` ×11 — REAL Electron** (spawns the installed binary
  on an esbuild bundle of the REAL harness; SKIPS where the binary/display is absent —
  CI never installs Electron — and always runs on the Windows dev box): EN+DE golden
  prints verified with pdfjs — page count, CURRENT-catalog sentinels (DE umlauts/ß),
  pack-id + `1/{totalPages}` footer, outline depth EXACTLY 3 with catalog section titles,
  `/MarkInfo Marked` (tagged) true, kill-after-load rejection with no output, and every
  Chromium request a `hilbertraum://print/<token>` page (#563), one per print, with the REAL
  offline guard silent across the run.

### Image understanding (vision) — wave #117–#124 additions (2026-08-09)

The vision DTOs live in `shared/types.ts` ("Image understanding" block); the full design is
`architecture.md` "Image understanding — design record". Contract changes from the 2026-08-09
images wave (issues #117–#124):

- **`VisionErrorCode` WIDENED (additive)** with `'timedOut'` (the per-request timeout fired —
  remedy: retry / smaller image), `'contextExceeded'` (the sidecar's 4096-token context
  overflowed — remedy: shorter question / fresh analysis), and `'emptyQuestion'` (blank
  question — an input problem, replacing the misleading `'emptyResponse'` reuse for that
  case). Skew-safe by contract: renderers MUST keep an unknown-code fallback (`AnswerThread`'s
  `ERR_KEY` lookup falls back to the `runtimeFailed` copy), so main may add codes without a
  lockstep renderer change.
- **`ImageAnalyzeRequest` persistence fields are CLAMPED main-side** (#120 item 2): `name` is
  truncated to 255 chars, `width`/`height` are coerced to finite positive integers (≤ 1e6) or
  null, and a `sessionId` that names no existing session row is treated as absent (a new
  session is created) instead of trusted for the append.
- **New IPC `images:clearSessions`** (#122): bulk "clear image history" — transactional row
  deletes (turns cascade), best-effort post-commit shreds of every stored image, preserving
  the REL-5 row-first/shred-after ordering. `requireUnlocked`-gated like its siblings.
  Resolves with the number of sessions removed. `ImageSessionSummary.sizeBytes` (already
  shipped) now backs the per-entry size + total the history UI shows.
- **`DriveStatus` WIDENED (additive)** with `imagesBytes: number | null` (#122): the on-disk
  footprint of `workspace/images/` (sum of stored file sizes, `.enc` overhead included), `0`
  when empty/absent, `null` when unreadable. Surfaced in the Diagnostics "System" card beside
  free space — runaway image-history growth threatens the lock path's re-encrypt free-space
  need, so it must be visible where storage is reported.

### Post-Phase-38 renderer bridge surfaces — backfill (2026-08-09, #138)

Coverage above effectively stopped at Phase 38 + EP-1 + the #80/#107–110/#117–124 bullets;
the surfaces below shipped without landing here. Each entry states the bridge contract
(method names + owning types in `shared/types.ts`) and points at the living design record
that carries the full story — the record stays authoritative for behavior; THIS list is the
charter-required index so a contributor consulting the declared source of truth sees the
whole renderer-visible surface.

- **Engine (llama.cpp/whisper.cpp sidecar) downloader** — `getEngineStatus(): Promise<EngineStatus>`
  (`installed`/`available`/`version`/`backend`/`missingFamilies`), `downloadEngine(request?: EngineDownloadRequest): Promise<EngineDownloadJob>`,
  `getEngineJob(jobId)`, `cancelEngineDownload(jobId)` (a UI caller since #144; `verifying`/
  `extracting` are cancellable states — F-33). `EngineDownloadJob` =
  `{ jobId, status: queued|downloading|verifying|extracting|done|failed|cancelled, receivedBytes,
  totalBytes|null, unverified, binaryPath|null, error|null }`. This doc is the living home of
  these two types (previously only `docs/packaging.md` + the frozen build-log described them);
  gating (policy ∧ setting) mirrors the model downloader (Phase 18 above).
  **#339 P8-1 additions (the `kiwix_tools` family contract; the family contract only — no IPC
  change):** `shared/runtime-sources.ts` `RuntimeSources` gains `optional?: boolean` (declarative;
  the code-side `SidecarFamilySpec.optional` in `services/assets.ts` is load-bearing — a
  user-writable drive yaml cannot promote an optional family into the default install) and
  `executables?: string[]` (base names; `[0]` is the primary binary; a family absent this key
  ships the single binary its spec names, the llama/whisper shape); `RuntimeBuild` gains
  `runtimeFiles?: string[]` (per build — non-executable files the executables need, e.g. the
  Windows ICU DLLs); `RuntimeSourcesResult` gains `families?: Partial<Record<RuntimeFamily,
  RuntimeSources>>` (a keyed map covering every family; `sources`/`whisper` stay as aliases into
  the same objects — no existing reader moves). `EngineStatus` gains `missingOptionalFamilies?:
  string[]` (additive/optional; an optional family with a host build but no binary — never folded
  into `installed` or `missingFamilies`, and never fetched by the argument-less `downloadEngine`).
  The install marker's `binaries` map (unchanged shape, `Record<string, string>`) now holds one
  entry per declared file for a multi-file family — every executable plus every `runtimeFiles`
  entry, hashed all-or-nothing. *Since #998 (`architecture.md` "In-app engine updates" §7) every
  writer records EVERY file of the copy, the declared ones first, never the marker or a nested
  `cpu`, `cpu.new` or `cpu.old`; same shape, so a reader that looks up its own keys is unaffected.*
  *Since #1012 the pre-spawn verifier reads EVERY key too (a nested net folder's keys excepted, that copy's
  own; `NESTED_NET_FOLDERS` in `assets.ts` is the one list): a key whose file differs blocks the spawn, a
  key whose file is gone is `missing` (the program or a library: `.dll`, `.so`, `.so.N`, `.dylib`) or
  `missing-other` (any other file), a key whose file cannot be read is `unreadable`, and a key that
  leaves the copy's folder (`recordedFilePath`) is refused. Only `ok`, `mismatch`, `skip-*` (and, code review round 7, the knowledge-pack tools' hashed `missing-other`) are
  cached for the session. Same shape; a marker that records the program alone checks the program alone.* `CommercialGateOptions` (the sell-gate options object) gains
  `families?: Partial<Record<RuntimeFamily, RuntimeSources | null>>` for families beyond the two
  grandfathered positional params (`platforms`, `appVersion`); the gate's `checks` record gains
  `optionalRuntimesConsistent: boolean` (an optional family is either fully provisioned — every
  declared file present, hashed and matching — or entirely absent; never folded into
  `runtimeCurrent`/`runtimeHashed`).
  **#729 addition (no IPC change):** `SidecarFamilySpec` gains `neverInstalled?: readonly string[]` (base
  names, code-side; the llama family's `['llama-connect']`), and `RuntimeDownloadPlan` gains `excludedPaths:
  string[]` (absolute, resolved inside the extract dir). A `neverInstalled` name is removed after the flatten
  (a dangling link too), is never one of the required executables or the marker's `binaries` map, and wins over a
  yaml `executables` entry of the same name, compared without case. A yaml `runtime_files` entry naming it makes
  the install fail closed (removed, then missing), so a yaml can never bring it back. The `fetch-runtime` twins
  carry the same list (`script-drift.test.ts`) and also remove it on a re-run that finds the install current.
  `findNeverInstalledFiles(dir, bases, skipDirs)` (`assets.ts`) is the sell gate's recursive, case-insensitive
  search: `assertCommercialDrive` fails `runtimeCurrent` for a Kit that holds one anywhere under an install dir.
  **#339 P8-2 additions (the consent step; the channel is unchanged, its PAYLOAD is new):**
  `downloadEngine` takes an OPTIONAL `EngineDownloadRequest = { families?: string[] }`. Absent
  (the preload sends NO payload — pinned by `preload-engine.test.ts`) = the default install,
  required families only. `{ families: ['kiwix_tools'] }` is the ONLY way the optional family is
  ever fetched; the main handler validates the payload against the code's family names
  (`parseEngineDownloadRequest` — an unknown name, an empty list, a duplicate or a non-object
  rejects with `main.engine.badRequest`) and passes `kiwixToolsActive` from the per-family
  sidecar PID registry (P8-1 R-e), so the install is refused while a pack is being served.
  **#532 additions (the damaged-files repair; same channels, all additive/optional):**
  `EngineDownloadRequest` gains `reinstall?: boolean`: install the named families although they
  are present and current by their marker. It needs an explicit `families` list of REQUIRED
  families and a real boolean (else `main.engine.badRequest`), and main admits it only for
  families holding a `'files-damaged'` verdict this session (else `main.engine.nothingToRepair`).
  Since #678 (`architecture.md` "Engine load failures" §11) that verdict must not be `afterInstall`,
  the rule the screen already offered by, and the job replaces the builds the verdict names: the
  main build, the chat engine's `cpu/` net, or both. The request and job shapes are unchanged.
  `EngineStatus` gains `reinstallableFamilies?: string[]` (required families with a host build
  whose binary IS on the drive). `EngineDownloadJob` gains `families?: string[]` (what the job
  installs; absent on the synthetic unknown-job answer) and `reinstall?: boolean`, so a screen
  attributes progress to the surface that started the job. The chat-runtime guard
  (`chatRuntimeActive`) no longer counts a model answering on the demo runtime.
  **#516 additions (engine updates; same channels, additive/optional — `architecture.md` "In-app
  engine updates"):** `EngineStatus` gains `engineVersions?: EngineVersionInfo[]` — per family on
  the drive with a host build: `{ family, optional, installed: string|null, installedBackend:
  string|null, pinned, pinnedBackend, relation: 'current'|'older'|'newer'|'unknown', cpuNet?:
  { installed, pinned, relation } }`; `pinned` comes from the app's own `runtime-sources.yaml`,
  never the drive's (#842). `EngineDownloadRequest` gains `update?: boolean` (explicit
  REQUIRED `families`, never with `reinstall`; only `older` installs and an older `cpu/` net are
  replaced, else `main.engine.nothingToUpdate`; refused while work runs, `main.engine.updateBusy`),
  and `EngineDownloadJob` gains `update?: boolean`. **Behaviour change:** the argument-less
  `downloadEngine()` now installs MISSING required families only — it used to re-install every
  family not current by its marker. `older` compares versions only (the pin in another backend is
  `current`). `AppContext` gains the internal `ingestionActive?: () => boolean` (the docs IPC's
  `processing` set, plus the internal `articleSavesActive`). No new channel, no schema change.
  **#339 P8-4 additions (the corresponding-source bundle; declarative pin + a sell-gate check —
  no IPC, no preload):** `model-manifests/runtime-sources.yaml` gains a `source_bundle:` key
  under `kiwix_tools:` (dir + a `files:` list, `recipe_url`, optional `recipe_commit`) —
  `shared/runtime-sources.ts` types it as `RuntimeSourceFile { component, version, license, name,
  sha256, sizeBytes?, url }` and `RuntimeSourceBundle { dir, files, recipeUrl?, recipeCommit? }`,
  with `RuntimeSources.sourceBundle?: RuntimeSourceBundle`. Additive/forward-compatible: an app
  built before P8-4 ignores the unknown key. Unlike `builds[].sha256`, every `files[].sha256` MUST
  be a real digest — a placeholder cannot discharge a corresponding-source duty, so the validator
  refuses one. `CommercialAssertion`'s `checks` record gains `kiwixSourceBundle: boolean`
  (fail-closed and marker-independent: true when no `kiwix_tools` binary is on the drive OR the
  bundle is complete and hash-matching; false only with a recorded problem — a hand-placed,
  marker-less binary still triggers the check).
  `EngineStatus` gains `optionalFamilies?: EngineOptionalFamily[]` = `{ family, version,
  sizeBytes: number | null, url, license, installed }` — what the dialog states, read from the
  pinned yaml (`version`, `url`, the new per-build `size_bytes`, validated as a positive
  integer, `RuntimeBuild.sizeBytes?`) and from the CODE-side `SidecarFamilySpec.license`
  (`GPL-3.0-or-later` for kiwix_tools) — never from copy or from the drive's user-writable yaml.
  After a job that installed `kiwix_tools` completes, the main side runs ONE background
  `ZimService.reconcile` (the searchability key carries the tools fingerprint, D-Z11/D-Z15) and
  the panel learns the result through `packs:changed`; the network gate is unchanged
  (`policy.network.allowModelDownloads ∧ allowNetwork`). **P8-1 shipped no IPC channel** (the
  count stays 145) and **no preload change** — `missingOptionalFamilies` and the gate additions ride the existing
  `engineStatus` payload / the existing assert-tool call, unread by the renderer until the
  consent step (#339 P8-2).
  **#843 additions (the engine's confirmation; one new channel, additive):** `getEnginePlan(request?:
  EngineDownloadRequest): Promise<EngineDownloadPreview>` (`engine:plan`, read-only; the preload sends
  NO payload for the argument-less call, as `downloadEngine` does). The handler validates the request
  exactly like `engine:download` (`parseEngineDownloadRequest`, then `main.engine.nothingToRepair` for a
  reinstall without a damaged-files verdict) and answers from `previewEngineDownload` = the step
  selection `EngineDownloadManager.start()` runs (`planEngineSteps`), with the same bundled pins and,
  for a reinstall, the same refused builds — or throws the selection refusal `start()` would at that
  moment (`nothingToUpdate`, `alreadyInstalled`, `noHostBuild`, …). The gates, the one-job check, the
  engine-in-use refusals (`main.engine.runtimeRunning` and its twins) and the update's
  `main.engine.updateBusy` are not part of it; `start()` and the update handler check them after
  Confirm (and plan again). `EngineDownloadPreview = { kind:
  'install'|'update'|'reinstall', items: EngineDownloadPreviewItem[], totalBytes: number|null }`, with
  `EngineDownloadPreviewItem = { family, version, installed: string|null, backend, os, arch, safetyNet,
  url, sizeBytes: number|null, license, bundledLicense: string|null, licenseUrl: string|null }`.
  `license`, `bundledLicense` (per OS) and `licenseUrl` (`<repo>/blob/<version>/LICENSE`, only for a
  plain tag) come from the code-side `SidecarFamilySpec` (new optional `bundledLicenses`,
  `licenseRepo`; `license` is now set for the two required families too), `sizeBytes` from the pin's
  `size_bytes`, which every committed llama.cpp and whisper.cpp build now carries. The renderer sends
  Confirm's request unchanged to `engine:download`: main keeps no consent token.
  **#986 additions (the staged engine swap; no IPC, no preload, no schema change; `architecture.md` "In-app
  engine updates" §6):** `EngineJobEndReason` (`runtime-download.ts`) gains `noSpace` and `filesInUse`, and
  `EngineJobEnd` gains `space?: EngineSpaceShortfall = { neededBytes, freeBytes }` (set for `noSpace`); the
  job's `error` is `main.engine.notEnoughSpace` (`{needed}`, `{free}`, the model downloader's unit rules) or
  `main.engine.filesInUse` (new keys, all ten catalogs). **Behaviour change:** a cancel is honoured until the
  swap's first rename, even after the extraction (it used to finish the install, #516), and arrives too late
  after it; a failed step leaves the installed copy as it was (it used to leave none, #752). New exports:
  `assets.ts` `EngineSwapDirs { live, staging, previous }` + `engineSwapDirs(rootPath, extractTo)` (the exact
  `<live>.new` / `<live>.old` siblings, contained by `resolveWithinRoot`; refuses an install folder that is
  the drive root), `planInFolder(plan, dir)` (the plan rebased, same marker keys), `engineFolderComplete(plan,
  dir?)` (the marker parses AND every file its `binaries` map records is present; the plan's required files
  only for a marker without the map, review round 2); `InstallStep.cpuNet?` (a main build's net plan, which a
  job recovers, guards and carries whatever it installs); `runtime-download.ts` `stageEngineInstall(plan,
  stagingDir, { extract?, signal?, log? })` (extract + checks + hashes + flush + marker inside `stagingDir`;
  the app-update plan's W-30 install reuses it), `engineFolderDeletesSettled()`, `recoverEngineSwaps(rootPath,
  manifestsDir, { platform?, arch?, log?, warn? })` (called in `index.ts` before any engine is resolved,
  what it could not do through `warn`; every engine job runs the same rule on its folders before phase 1;
  never throws); `fs-retry.ts` `renameWithRetry(from, to, platform?)` + `renameMayClear(err, platform?)` +
  `RENAME_RETRY_BUDGET_MS` (12 s of waits, EPERM/EACCES/EBUSY on Windows only) + `removeRetry(platform?)`
  (`rm`'s `maxRetries`/`retryDelay` within the same budget, Windows only); phase 2 installs a family's
  `cpu/` net before its main build; `archive-size.ts`
  `extractedArchiveBytes(path, clusterBytes)` (zip central directory or tar.gz ustar headers, each file
  rounded to the unit; null for anything it cannot size, Zip64 included). `assertCommercialDrive` fails
  `runtimeCurrent` (or `optionalRuntimesConsistent`) for a leftover `<extract_to>.new` / `.old` beside a
  pinned build, and the Kit gate scripts' pre-flight says so too.
  **#998 / #999 / #1000 additions (no IPC, no preload, no schema, no copy change; `architecture.md` "In-app
  engine updates" §7):** the marker's `binaries` records every file of the copy (above). `runtime-download.ts`:
  `makeTarExtractor({ spawn?, graceMs?, goneBoundMs? })` builds the default extractor (`extractWithTar =
  makeTarExtractor()`), whose promise settles only once its tar child has exited (or 10 s after SIGKILL,
  logged); `ExtractFn` gains an optional fourth parameter `log`; `ExtractSpawn`, `TarExtractorOptions`.
  `StartEngineDownloadOptions.beforeReplace` is now awaited after every copy is staged, with the spawn gate
  held. **Behaviour change:** a job stages every step (unpacked, member-checked, hashed, flushed, marked in
  `<live>.new`) before it holds the spawn gate or calls `beforeReplace`, so a download or stage that fails or
  is cancelled never pauses anything and replaces nothing; the deletes of every copy it staged and did not swap
  in are queued in a `finally`; a stage whose archive lists a member the copy lacks fails `incomplete`
  (`main.engine.extractFailed`); the pre-swap check reads the staged marker's keys. `assets.ts`
  `flushToDeviceAsync(path)` (`FileHandle.sync()`, best-effort). `archive-size.ts` `archiveMembers(path)` (every
  non-folder member name as written, links included; null for an unreadable, Zip64 or non-ASCII listing).
  `assertCommercialDrive` fails `runtimeHashed` (or `optionalRuntimesConsistent`) for a further key a marker
  records that is missing, modified or outside its folder; a marker that records only the required files passes
  as before. `classifyLoadFailure` reads `no CPU backend found` as `files-damaged`. **Round 1:** each family is
  all or nothing up to its swaps and the job's other families still install, with the first failure as the
  job's end; a member or required file that cannot be hashed fails the stage when the archive could be listed
  (no map only for an unlisted archive); links that are not files and macOS metadata (`archive-size.ts`
  `isMacMetadataName(path)`: `._*`, `__MACOSX/`, `.DS_Store`) are never recorded nor expected; a job awaits
  `engineFolderDeletesSettled()` before its recovery, and a staged copy it does not swap in loses its marker at
  once.
- **In-app OCR language-file install (#410)** — its own narrow installer, NOT an engine family
  (`EngineStatus`/`EngineDownloadRequest`/the `engine:*` channels are unchanged). Four channels,
  all through `registerEngineIpc`'s guarded handler, pre-unlock like the engine ones:
  `getOcrInstallStatus(): Promise<OcrInstallStatus>` (`ocr:status`), `installOcr():
  Promise<OcrInstallJob>` (`ocr:install` — takes NO payload: the preload sends none, and main
  refuses any argument with `main.ocr.badRequest` without echoing it), `getOcrInstallJob(jobId)`
  (`ocr:getJob`), `cancelOcrInstall(jobId)` (`ocr:cancel`). Types (`shared/types.ts`):
  `OcrInstallLanguage = { lang, role, sizeBytes, installed }` (role `'language' | 'orientation'`
  since #538; installed = on the drive AND matching the pinned hash); `OcrInstallStatus = {
  available, languages: OcrInstallLanguage[], totalBytes (the not-installed languages' sizes),
  sourceHost: string | null (computed in main from the pinned URLs), license (code-side
  'Apache-2.0') }`; `OcrInstallJob = { jobId, status:
  queued|downloading|verifying|activating|done|failed|cancelled, receivedBytes, totalBytes,
  outcome: OcrRefreshOutcome | null, error: string | null }` — session-only, never persisted;
  `outcome` is set on `done`, which the job reaches only after the engine slot was refreshed.
  `OcrRefreshOutcome = 'activated' | 'restartRequired' | 'unchanged' | 'startFailed'` is what
  `refreshOcrSlot` (`main/services/compose-services.ts`) did to `AppContext.ocrEngine`, which is
  now MUTABLE (read live by every consumer, including the doc-task deps). What is installed is
  pinned in code (`OCR_PINS`: `{ lang, sha256, sizeBytes }` for `deu` + `eng`, drift-tested
  against `runtime-sources.yaml`); the yaml's `ocr:` block contributes only each pinned language's
  URL — its `dest` is ignored (always `ocr/<lang>.traineddata.gz`) and a differing `sha256` is
  refused. No schema change; `main.ingest.imageNeedsOcr` (persist-canonical) is unchanged — the
  photo row's remedy is appended at display time (`displayMapKey`, `renderer/lib/displayMap.ts`).
  Record: `architecture.md` "In-app OCR install — design record".
- **Image understanding (vision)** — `imageGetStatus(): Promise<VisionStatus>`,
  `imageChooseImage()` (opaque token + name + sizeBytes; the path stays in main, D2),
  `imageReadBytes(token)`, `imageAnalyze(req: ImageAnalyzeRequest): Promise<ImageJob>`,
  `imageGetJob`/`imageCancel`, per-job streams `onImageToken`/`onImageDone`/`onImageError`,
  history `listImageSessions`/`getImageSession`/`deleteImageSession`/`clearImageSessions`.
  Types: `VisionStatus`, `ImageJob`, `ImageSessionSummary`/`ImageSessionDetail`
  (see also the #117–#124 wave section above). Record: `architecture.md` "Image
  understanding — design record". #913 (additive, skew-safe): `VisionUnavailableReason` gained
  `'damaged'` (a vision model on the drive failed its file check: a check found a file damaged, or
  its hash is a placeholder outside developer mode) and `VisionErrorCode` gained `'modelDamaged'`
  (the job's twin, when the status changed after the screen read it). No schema change.
- **Translate view (text path)** — `translateStart(req: TranslateRequest): Promise<TranslateJob>`,
  `translateCancel(jobId)`, `getActiveTranslateJob(): Promise<TranslateJob | null>` (remount
  recovery), streams `onTranslateToken`/`onTranslateDone`/`onTranslateError`. Record:
  `architecture.md` "Translation sidecar — design record" (TG waves). #913: `TranslateErrorCode`
  gained `'modelDamaged'` (the start check refused a weight a check found damaged; additive, the
  screen keeps its unknown-code fallback).
  Wave #156–#165 additions (2026-08-09): `TranslateErrorCode` gained `'tooLong'` and
  `shared/types.ts` the `TRANSLATE_MAX_TEXT_CHARS = 200_000` paste bound (#160 BE-3);
  `AppStatus` carries the additive gates `translationAvailable: boolean` (issue #40) and
  `translationDevice?: TranslationDeviceStatus` (issue #42 reopen — the Translate screen's
  device hint; recorded here per #164 D-7a, the `dictationAvailable`/`ocrAvailable` siblings'
  precedent). #473 (2026-10-12) adds the optional `TranslationDeviceStatus.cpuCause?:
  TranslationCpuCause` (`'beside-chat' | 'chat-starting' | 'too-large'`): why the headroom gate
  put a start on the processor, absent when Settings or the session latch chose it
  (`architecture.md` GPU record §9). #671 (2026-10-13) adds the optional
  `TranslationDeviceStatus.gpuBuffers?: boolean`: did the start's load log put a buffer on a
  graphics device (`PlacementParser.gpuBufferEvidence`)? `false` (every buffer under a
  processor-side label) means it ran on the processor whatever `gpuLayers` says (a start with no
  usable device, or under `--device none`, prints `49/49 layers` too); absent when there is nothing
  to judge by. Readers go through `translationRanOnProcessor` (`shared/runtime-status.ts`;
  `architecture.md` translation record, "#671 amendment"). PR #268 (#232): `AppStatus.ocrState?: OcrState`
  (`'available' | 'probing' | 'unavailable' | 'missing'`, additive-optional, same precedent) says
  WHY `ocrAvailable` is what it is — `ocrAvailable` itself now reads the engine's execution state
  (false while a packaged build's startup execution probe runs and after any worker failure), no
  longer mere engine presence; `documents.error_message` gained one persist-canonical English
  value (`main.ingest.imageOcrUnavailable`, display-map translated) — no schema change. Doc-task
  side (#157): `cancelDocTask(jobId)` with a PRESENT id is an exact-id
  targeted cancel, running OR queued (stale-safe: a settled id no-ops, except a finished deep-index
  tree, whose cancel reaches the extract pass it chained, #689); NEW
  `listActiveDocTasks(): Promise<DocTaskStatus[]>` (`doctasks:listActive`) returns running +
  queued tasks in lane order — the file-translation reload-adoption read (`getActiveDocTask`
  keeps its running-only contract for the #38 chain-adopt).
- **Skills surface** — `listSkills`/`getSkill`/`importSkill`/`deleteSkill`/`enableSkill`/
  `disableSkill`/`getSkillReconcileStatus`, suggestion `suggestSkills(conversationId, question?)`,
  Tier-2 runs `listRunnableTools(skillInstallId, conversationId): Promise<RunnableToolSet>`
  (tools + in-scope `documentIds` — resolved at FETCH time, so the renderer re-fetches after a
  scope write or attach settle, #140), `startSkillRun(req): Promise<StartSkillRunResult>`,
  `getSkillRun`/`listSkillRuns`/`cancelSkillRun(runHandle)`/`clearSkillRun(runHandle)`
  (ids/counts-only `SkillRunState`; cancel and clear require the run handle — there is no
  cancel-all). Record: `architecture.md` Skills records (§42/§44).
- **Collections CRUD** — `listCollections(): Promise<Collection[]>`, `createCollection(name)`,
  `renameCollection`, `archiveCollection`, `deleteCollection`, membership
  `addToCollection`/`removeFromCollection`, lifecycle `setDocumentLifecycle`. Types:
  `Collection`, `DocumentScope`. Record: rag-design §13 + the document-organization record.
- **Context compaction reads** — `getConversationContextUsage(conversationId): Promise<ContextUsage>`
  (`usedTokens`/`window`), `getConversationSummary(conversationId): Promise<ConversationSummaryMarker | null>`,
  events `onCompaction(conversationId, cb)` (notice kind: 'compaction' | 'analysis') and
  `onContextUsage(conversationId, cb)` (the real assembled-prompt usage, fired once per turn).
  Record: architecture.md compaction record.
- **Stream recovery** — `getActiveStream(conversationId): Promise<ActiveStreamSnapshot | null>`
  (`content`/`reasoning` accumulated so far) and `listActiveStreamConversations(): Promise<string[]>`
  — the remount re-attach pair the Chat screen polls (renderer tolerance for transient
  rejections is #148 CH-4). Record: architecture.md "Chat & streaming".
- **Bulk re-index** — `startReindexAll(documentIds)`, `getReindexAllJob(): Promise<ReindexJobStatus | null>`
  (parameterless mount recovery), `cancelReindexAll()`. Type: `ReindexJobStatus`.
- **Smaller members** (owned here so the index is complete): `exportMessageTable(messageId)`
  (result-table CSV via save dialog), `previewDocument`/`previewDocumentPage` (bounded pages: main
  clamps `limit` to 1–50 and a non-finite `offset`/`limit` to 0/50, #681),
  `exportSummary(documentId)`, `exportDocumentOriginal(documentId)` (#90 — stored original
  bytes via save dialog), `saveCodeBlock(messageId, content, language)` (#286 — one fenced
  code block from a persisted assistant answer, renderer-supplied bytes, via save dialog),
  `exportLog()`/`getLogTail()`, `getDroppedFilePath(file)` (the
  Electron-37 `webUtils.getPathForFile` bridge — drag-drop path resolution), `perfMark(event)`
  (one-way, allowlisted timing mark for opt-in measurement runs — no data channel),
  `onModelVerifyProgress(cb)` (cold-hash progress stream), `cancelModelVerify(verifyRunId):
  Promise<boolean>` (`models:cancelVerify` — #420: stop the Models screen's "Check all model
  files" pass, keyed by the run id the RENDERER minted and passed to `listModels(lazyVerify,
  verifyRunId)`; `true` when a pass was aborted, `false` when nothing was running under that id —
  a no-op, never an error. Not gated on an unlocked workspace, like `stopRuntime`: it only stops
  work already running and touches no database), `onScopeNotice(conversationId, cb)`
  (filename auto-scope one-shot), `copyToClipboard(text): Promise<boolean>` (main-process
  clipboard — the renderer's `navigator.clipboard` is denied in the packaged renderer).

### Channel-surface completion sweep (2026-08-20, docs/code audit E-1)

The #138 backfill above closed the *feature* gaps. A mechanical pass over every key in
`shared/ipc.ts` (158 channels since #888 added `app:saveBeforeCloseDone`; 157 since #530 added `engine:recheck`; 156 since #410 added the four `ocr:*` install channels — 152 before it, counted from the `IPC` keys on master `4086a4cf`, so the figure had drifted past the "148" recorded here; 148 channels since #420 added `models:cancelVerify`; 147 since #340 Tier-2 added `packs:saveArticle` — the keys of its `IPC` constant (138 at the time of this
sweep, +7 `packs:*` keys added by #301 P7); the `STREAM` builders, `OCR_RASTER` and `EVENTS`
(7 since #888 added `app:saveBeforeClose`; 3 at the sweep, `packs:changed` added; #530 added `engine:problemsChanged` to `EVENTS`) are separate constants, #259) against this file then found **16** that
appeared under neither their method name nor their channel string — mostly siblings of documented
calls that arrived one at a time. Listed here so the declared source of truth is complete; each
one's behaviour stays owned by the design record named beside it.

- **`restartRuntime(): Promise<RuntimeStatus | null>`** (`runtime:restart`, #599) — start the RUNNING
  model again with the options it was started with, past `startRuntime`'s same-model no-op
  (`RuntimeManager.restartCurrent` → `forceRestart(opts, 'switch')`): its in-flight answers end as a
  switch ends them (#600). Gated on the unlocked workspace like `startRuntime`; aborts a deep-index
  build first; audits `runtime_started` ("restarted"). Null when no model runs. The AI Model card
  offers it for a model that stopped responding (design-guidelines §11.22); the app never calls it
  on its own.
- **`useModel(modelId): Promise<RuntimeStatus>`** (`runtime:use`) — the MERGED select-and-start
  action, and the one a UI caller should reach for. It persists the active chat slot, emits
  `model_selected`, and starts the runtime in one handler so the spec-§7.4 install gate and the RAM
  gate run once and the audit trail is a single event chain. The separate `selectModel` /
  `startRuntime` pair still exists; the merge exists because a first-time user could not tell which
  of two buttons led to chatting (`registerModelIpc.ts`; design-guidelines §11.10).
- **`copyToClipboard(text): Promise<boolean>`** (`clipboard:write`) — main-side clipboard write,
  resolving to whether it succeeded. Not a convenience wrapper: `navigator.clipboard` needs a
  secure context and a focused document, and is unreliable in the packaged renderer, where it
  produced a user-visible copy error (then served from `file://`; from `hilbertraum://app/` since
  #560).
- **`setConversationDefaultSkill(conversationId, installId | null): Promise<void>`**
  (`chat:setDefaultSkill`) — persists a conversation's sticky default skill; `null` clears it
  (skills plan §10.1).
- **Whole-document analysis read-backs** — `documentCoverage(documentId): Promise<DocumentCoverage
  | null>` (`analysis:coverage`) and `listAllExtractions(req: ExtractionListingRequest):
  Promise<ExtractionListing | null>` (`analysis:listAll`), the read-only "list every X" aggregation
  over precomputed structured extractions. Zero model calls; `null` for an invalid type
  (rag-design §14.4/§14.5).
- **Image-analysis history** — `listImageSessions(): Promise<ImageSessionSummary[]>`
  (`images:listSessions`, newest first, no image bytes), `getImageSession(id):
  Promise<ImageSessionDetail | null>` (`images:getSession`, metadata + DECRYPTED bytes + all
  turns), `deleteImageSession(id): Promise<void>` (`images:deleteSession`, shreds the stored image
  and cascade-removes its turns). The already-documented `clearImageSessions()` is their bulk twin
  (architecture.md "Image understanding" record; security-model.md "Encrypted image-analysis
  history").
- **`getActiveTranslateJob(): Promise<TranslateJob | null>`** (`translate:getActive`) — the
  remount-recovery read for the Translate view: the renderer's module store dies with a full
  reload, so the active job has to be re-fetchable from main (TG-5).
- **`setCollectionArchived(id, archived): Promise<Collection>`** (`collections:setArchived`) —
  archive/unarchive a project (rag-design §13).
- **Skill import/export** — `pickSkillPackage(mode?: 'file' | 'folder'): Promise<SkillPickResult | null>`
  (`skills:pick`; `{ token, path }` since PR #275 (#240) — the path is renderer display only, the
  one-time token is what the next two redeem, the `pickDocuments` D1 shape; the picker is
  unlock-gated), `previewSkillPackage(token): Promise<SkillPreview>` (`skills:preview`, a full
  validation that writes NOTHING — the permission-summary preview, skills plan §9.2; reads through
  the token without spending it), `importSkill(token): Promise<SkillInfo>` (`skills:import`, spends
  the token; a non-token argument is refused before any filesystem call),
  `exportSkill(installId): Promise<string | null>` (`skills:export`),
  `acknowledgeSkillWarning(installId): Promise<SkillInfo>` (`skills:acknowledgeWarning`, the
  enabled-with-warning DS7 path), and `getSkillReconcileStatus(): Promise<SkillReconcileStatus>`
  (`skills:reconcileStatus`) — **counts and fixed reason codes only**, never folder names or
  human-readable lines, because those can carry a validated path (SKA-32 / §22-M1).
- **`EVENTS.modelVerifyProgress`** (`models:verifyProgress`) — an EVENT, not an invoke:
  `ModelVerifyProgress` pushed to the calling renderer (`event.sender`) while first-run weight
  hashing runs, so the first-run gate and the first cold Models visit show a determinate bar
  instead of an opaque spinner. First-run-only in practice — the checksum cache makes later passes
  a no-op. **#420:** `runId` is the RENDERER's id when it supplied one to `listModels` (the Models
  screen's full pass always does), which makes it the handle `models:cancelVerify` takes; otherwise
  main mints one as before. A cancelled pass still emits its terminal `done`, so the bar settles
  rather than lingering.

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


---

### Knowledge packs (ZIM wave live — rag-design §17)

**Channels (`packs:` namespace, registerZimIpc.ts; all requireUnlocked except `packs:status`):**
`packs:list` (DB-ONLY — no filesystem probe, no availability write; `KnowledgePack[]`) ·
`packs:add` (native picker + registration in ONE main-side handler — no renderer-supplied
archive path exists on this surface; returns `KnowledgePackAddResult` (#301 P5, finding L1):
`{ outcome: 'cancelled' | 'success' | 'partial' | 'failure', added: KnowledgePack[], failed:
number, failureReason: 'not-a-zim' | 'tools-missing' | 'manager' | 'path-unsupported' | 'other' |
null }` — the invariants of §9.19 (c)1 in one sentence; codes only, never a path or a tool's
stderr; a lock landing mid-add still REJECTS with the friendly locked copy. `'path-unsupported'`
(#340, owner ruling 2026-09-06, option M) is set ONLY when the platform is win32 AND the
manager's command line still held a non-ASCII character (`KiwixManageError.nonAsciiArgv`, #787:
the app found no ASCII spelling of the archive's path from its own library folder — a non-ASCII
file name, or a non-ASCII folder outside the app's own) AND the manager actually ran and exited
non-zero (`kind: 'exit'`) — a spawn/verify/timeout failure, an archive whose path holds such a
character but reached the tool in an ASCII spelling, or any other platform, still classifies as
`'manager'`) · `packs:remove`
(tombstone, file untouched) · `packs:setEnabled` · `packs:refresh` (#301 P3b, finding L7 —
schedules a background reconciliation and returns `{ started: boolean }` at once;
completion arrives via the `packs:changed` event, not the return value) · `packs:status`
(`KnowledgePackStatus = { toolsInstalled, refreshing, revision, excluded? }` — additive over the P3a
`{ toolsInstalled }` shape; `excluded?: KnowledgePackCollision[] | null` (#340, rag-design D-Z16)
is the served library's collision losers `{ packId, collidesWith }` from the service's memory —
recomputed from the registry at every reconciliation and mutation, from the resolved set at every
library build, `null` until this session computed one and after a lock; absent on an older main —
never a database read, so the channel stays lock-exempt) · `packs:getArticle` (`PackArticle | null` — plain sectioned
TEXT, never HTML, carrying the converter's superscript/subscript markers (`m^2`, `10^6`, `H_2O` — #488,
rag-design §17), which the retrieval matchers fold back out but the viewer shows as delivered; whitespace
is collapsed everywhere except inside a `<pre>` code block, whose lines keep their indentation (#627 —
so a section's text can start with spaces), and a crawled site's own footer/menu is not in it, nor are
German Wikipedia's navigation boxes (#662), sister-project links or legal-topics notice (#673); German
Wikipedia's authority data is a section of its own labelled `Normdaten` (#673); a section's text omits its
heading's own first line, and only that line (`articleSections`, #673); `PackArticle.notice: string | null` (#662) is the archive's own
license line (mwoffliner's `zim-footer`, one line, at most 1,500 characters, a cut one ending in ` …`), never a section — the
viewer shows it after the article and a saved copy ends with it as a `## License` section;
the read follows exactly ONE same-book redirect — kiwix-serve answers a ZIM
alias entry with `302 → /content/<book>/<target>` (P7 T19) — while a cross-book, chained or
contract-refused target returns `null` and the locator does not change; both requests carry
`Range: bytes=0-`, which routes the read past the upstream Windows cut-short defect and makes
`206` as much an article as `200` (#339, rag-design D-Z22); a `/raw` read that
kiwix-serve leaves incomplete anyway (the body stops short and the connection hangs) is retried —
`ARTICLE_READ_IDLE_MS` 1 s between chunks and `ARTICLE_READ_TIMEOUT_MS` 4 s per attempt,
`ARTICLE_READ_ATTEMPTS` 3 counting resumes, only on those timers, never on the caller's own abort
(P7 T19 finding 3, an upstream truncation); a stall that delivered part of the body is resumed
with `Range: bytes=<received>-` and accepted only against an exact `Content-Range`, so a partial
body never reaches a caller; `PackArticle` adds `partial: boolean`, true when `html.ts`'s converter
stopped short of the whole article — input cap, work budget or unterminated markup —
Phase 1, PR #294 review H1; the modal shows a hint line instead of presenting the partial
text as complete; a refused entry key (empty, > 2048 chars, a control character, a `.`/`..`
segment, a lone surrogate — validated inside the one encoder `client.ts`
`encodeArticlePath`, #301 P5 finding L5) → null, no request issued; URL-shaped and
empty-segment keys stay accepted) · `packs:saveArticle` (`(packId, articlePath) →
PackArticleSaveResult { documentId, title, alreadySaved, chunkCount }` — "Save to my
documents" in the article viewer, #340 Tier-2, D-Z21; `requireUnlocked`; the same locked
copy as every other pack-touching channel when a lock lands mid-save; two friendly
failures, never a half-born document — `main.zim.articleUnavailable` when the entry can no
longer be re-read main-side, `main.zim.saveFailed` when the import itself does not reach
`indexed`).

**Event `EVENTS.knowledgePacksChanged`** (`packs:changed`, #301 P3b, finding L7) — an
EVENT, not an invoke (the `EVENTS.modelVerifyProgress` shape above, but broadcast to
EVERY window via `BrowserWindow.getAllWindows()`, not just the calling one):
`KnowledgePacksChangedEvent = { epoch, revision, refreshing, reason: 'reconcile-start' |
'reconcile-end' | 'mutation' }`, emitted by `ZimService` only AFTER the producing
operation's `assert()` — a pass finishing under an old epoch announces nothing. Producers:
the reconcile (start/end) and `registerPack`/`removePack`/`setPackEnabled` (`'mutation'`).
Consumers subscribe via preload `onKnowledgePacksChanged(cb)` and ignore an event whose
`epoch` is below the last one seen.

**Shapes (shared/types.ts):** `KnowledgePack` (id = archive UUID, title, language,
zimDate, articleCount, sizeBytes, leaf, enabled, available, `unavailableReason: 'missing'
| 'identity-mismatch' | null` — additive, #301 P3b finding M5; null whenever `available`
is true, addedAt; `searchable?: 'yes' | 'no' | 'unknown'` / `searchableHint?: 'yes' | 'no'
| null` — additive, #301 P4 finding M7, absent reads as `'unknown'`); `DocumentScope.packIds?:
string[]` / `RetrievalScope.packIds?` (additive — a pack-less scope serializes
byte-identically; consumed only by the ZIM retrieval arm, never by `buildScopeFilter`);
`DocumentScope.documentsOff?: true` / `RetrievalScope.noDocuments?: true` (additive, #301
P4 finding M10, owner ruling D4 — the explicit, additive "packs only" flag and its resolved
deny-all counterpart; NEVER derived from an empty selection, so a pre-P4 row and a
documents-on scope serialize byte-identically; see "Retrieval outcomes and searchability"
below); `MAX_SELECTED_PACKS = 12` (#301 P4 finding M8, owner ruling §7 — the one constant
the popover, chip, arm and outcomes all read); `KnowledgePackOutcomeStatus = 'searched' |
'skipped' | 'failed'`, `KnowledgePackOutcomeReason` (14 codes — `selection-limit`,
`removed`, `disabled`, `file-missing`, `identity-mismatch`, `not-served`, `not-searchable`,
`tools-missing`, `mode`, `search-failed`, `read-failed`, `timeout`, `deadline`,
`server-restarted`), `KnowledgePackOutcome = { packId, title: string | null, status,
reason: KnowledgePackOutcomeReason | null, found: number, admitted: number }` (#301 P4
findings M6/M7/M8 — codes only, never a path, filename or stderr) and `Message.packOutcomes?:
KnowledgePackOutcome[]` (additive; undefined on a legacy row — the renderer says "outcome
not recorded" rather than inventing one); `Citation` additive archive fields
(`sourceKind: 'archive'`, `packId`, `archiveTitle`, `articlePath`; archive citations carry
NO documentId/chunkId). Evidence review snapshots persist the same four fields as
`sourceKind`/`archiveTitle`/`packId`/`articlePath` in `source_snapshot_json` (P2, review
H2/M11, #301): an archive citation is always `identity:'unresolved'` on write and read,
and the pack id + article path survive into the HTML/PDF evidence pack and the Markdown
transcript export even though identity is never resolved. `KnowledgePackAddResult` /
`KnowledgePackAddFailureReason` (#301 P5, finding L1 — the `packs:add` return shape above).

**Table `knowledge_packs`** (db.ts SCHEMA): id PK (ZIM UUID) · title/description/
language/zim_date/article_count/media_count/size_bytes · leaf + recorded_path
(stored-copy resolution: `<drive>/zim/<leaf>` first) · enabled 0/1 · unavailable_at
(file vanished — mark, never delete) · removed_at (tombstone so drive auto-discovery
cannot resurrect a removed pack) · added_at/updated_at · `searchable` TEXT (`'yes' | 'no'`,
NULL = unknown), `searchable_key` TEXT (the fingerprint the verdict was taken under) and
`ftindex_hint` TEXT (`'yes' | 'no'`, NULL = no tag) — three columns added #301 P4, finding
M7, all nullable via `ensureColumn`, no `SCHEMA_VERSION` bump. No FK from conversations —
a removed pack degrades to “not retrieved from” (the skills C3 rule).

**Audit:** `knowledge_pack_added` ({ packId, sizeBytes, articleCount }) ·
`knowledge_pack_removed` ({ packId }). Pack titles/filenames are CONTENT — never in
`runtime_events` (sentinel-tested in zim-ipc-session.test.ts: the T17 add-DTO legs and the save-article legs).

**Service publication (P3a):** `ZimService` (`services/zim/index.ts`) publishes one
tuple per pack revision, `{ revision, build, generation, port, libraryXmlPath }` (or,
when nothing is enabled/available, `{ revision, kind: 'empty' }` — no child, no XML).
`revision`, `build` and `generation` are monotonic counters owned by the service for
the life of the process; `generation` is ONE allocator shared by library builds and
kiwix-serve children, so a rebuild and a child spawn (including a bind-race retry or a
crash restart) never reuse a value. Library files are named `library.<build>.xml`
under the service's temp library directory. `ZimService.serverState(): { revision,
build, generation, port, alive } | null` is the read P5's request guard consumes
before and after a request; no IPC channel changed.

**Session, identity and discovery (P3b, #301, findings H4/M4/M5/L3/L4/L7 — full record:
rag-design §17 D-Z8/D-Z10/D-Z11):** every pack operation captures the unlock epoch and
re-asserts admission/epoch/cancellation after every await; lock/quit abort the registry
and clean `<workspacePath>/zim-transient/` (`library.<build>.xml` + `meta-<n>/library.xml`,
plaintext while present). A pack's identity is its header UUID (bytes 8–23), checked on
every resolve; `packs:list` is DB-only, and one serialized reconciliation (session start,
`packs:refresh`) heals paths/availability and registers unknown UUIDs WITHOUT touching
`enabled`/`removed_at` — a user's remove/disable always wins over a late pass. Serving
names follow the pinned libkiwix rule; a collision keeps the ascending-UUID winner and
excludes the loser. The citation locator stays `packId + articlePath`, resolved against
the current serving map on every read.

**Request guard (P5, #301, finding M1 / owner ruling D1(a)):** `ZimService.withServer(db,
op, request)` wraps every kiwix-serve request the ask arm and the article viewer make. It
captures the published tuple — revision, generation, port, alive — from `serverState()`
before the request and reads it again after the response; a response observed across a
change of that tuple is discarded whatever it contained, because on a reused loopback port
a body that arrived after the app's own child died cannot be told apart from another
process's. A discarded attempt is retried EXACTLY ONCE, and only while the same admitted
session still holds — `op.assert()` still passes, the operation was not cancelled — with
eligibility recomputed under the CURRENT revision, never against a list captured before the
first attempt. A second discard rejects with `StaleServerError` (an ordinary error, mapped
to P4's per-ask outcome), never `AbortError` (which is reserved for admission refusals: lock,
lock+unlock into a new session, or the ask's own cancellation — none of these retry). The
guard detects an OBSERVED LIFECYCLE CHANGE of the app's own child; it does not authenticate
the server — see "kiwix-serve — the one unauthenticated sidecar" in `security-model.md`
(residual R-9).

**Retrieval outcomes and searchability (P4, #301, findings M3/M6/M7/M8/M10 — full record:
rag-design §17 D-Z4/D-Z11/D-Z12):** documents-off scope is an explicit, additive
`DocumentScope.documentsOff` persisted by both scope owners and resolved by `resolveScope`
into `RetrievalScope.noDocuments` only when no file is attached to the chat (attachments
stay in scope); `buildScopeFilter`, the resident-vector fast path and `retrieve`'s pre-embed
skip all honour it. A pack's searchability is CONFIRMED only by a validated `/suggest`
probe (`GET /suggest?content=<name>&term=the&count=1`, `'yes'` iff the body is a JSON array
with a `kind:"pattern"` entry) run at the end of a reconciliation and, in the background, once
per completed `packs:add` batch and on `packs:setEnabled(…, true)` (`ZimService.scheduleSearchabilityProbe`,
rag-design D-Z15, #340 — a `packs:changed` `'mutation'` follows a landed verdict), under the SAME
request guard as an ask, and cached against `<file size>:<file mtime>:<kiwix-serve binary
size>:<mtime>` — a 404, a timeout, a malformed body or a response observed across a server
change never confirms "no"; a confirmed-no pack is skipped by an ask but stays readable.
Each ask allocates at most `MAX_SELECTED_PACKS = 12` packs' worth of work: up to
`MAX_EXTERNAL_CANDIDATES = 24` candidates admitted round-robin in title order after every
pack settles **on the `capped` scope** (step 4-4's default; the `gpu` profile's `all` scope and
the `cpu-hi` opt-in's `top48` lift this cap — `rag-design.md` §17 PR-B record), at most
`PACK_SEARCH_CONCURRENCY = 2` packs searched at once, under one
`EXTERNAL_RETRIEVAL_DEADLINE_MS = 20_000` ms deadline shared with the request guard's one
retry. `classifyPackSelection` (`zim/packs.ts`) classifies every selected pack id BEFORE
any eligibility filter, so a missing tools bundle or an all-unavailable selection cannot
erase the outcomes; every pack gets exactly one `KnowledgePackOutcome` per ask. The
carriage is the persisted `Message` itself — `chat:done` already sends it in full, so no
new IPC channel or preload change exists — via the additive `messages.pack_outcomes_json`
column (parsed through the tolerant whitelist `parsePackOutcomes` in `chat.ts`), which
therefore also rides `listMessages`, `getLatestMessage`, the `DeletedMessage` snapshot /
`restoreMessage`, and `exportTranscript` (a "Knowledge packs:" block after "Sources:").
`PackOutcomesNotice.tsx` renders it under any assistant turn that carries outcomes, even
with zero citations; a legacy turn that cites an archive but carries none shows an explicit
"outcome not recorded" line. A whole-document, compare or grounded-data answer produces
`skipped/mode` for every selected pack — packs are still not queried on those paths, but
the answer now says so. Since #734 the coverage-extract listing and a tool skill's template
answer do too. The D45 refusal, the W2 routing answer and a `routing` handler's button pointer
(redaction, document edit) record none (owner call, #734): they make no document claim, so their
`pack_outcomes_json` stays NULL with packs ticked.

**Manual harness env (P5, finding L8):** the real-tool smoke (`tests/manual/zim-real.test.ts`)
is gated by `HILBERTRAUM_ZIM_SMOKE`; once requested, `HILBERTRAUM_ZIM_TOOLS_DIR` /
`HILBERTRAUM_ZIM_FILE` / `HILBERTRAUM_ZIM_QUERY` are all REQUIRED (a requested-but-invalid
combination FAILS the run; unrequested is a genuine skip) and `HILBERTRAUM_ZIM_EXPECT_ARTICLE`
is optional. `HILBERTRAUM_ZIM_FIXTURES_DIR` is the separate, optional zim-html realism leg
(`tests/unit/zim-html.test.ts`). `HILBERTRAUM_KIWIX_BIN` stays as a dev-only resolver override
(`kiwix-manage` resolves as its sibling binary). See `docs/packaging.md`'s manual-harness
matrix (the `zim-real` row) for the full input table.

**Lock-channel inventory:** `ipc-lock-coverage.test.ts`'s `registerZimIpc` group gained
`packs:refresh` as a DB-touching (non-exempt) channel; `packs:status` remains the sole
exempt channel (in-memory service state only — its `excluded` field, #340, is the service's
cached list, never a query). The IPC surface was unchanged by the follow-up wave, then gained
one channel with #340 Tier-2 (`packs:saveArticle`): 147 channels. (The earlier "145" figure was one
short of the constant by the time it was recorded; 147 is counted from the `IPC` keys on this branch.)

**#340 L3-b (D-Z20):** no shape change — `makeArm` gains an optional `{ expand }` (main-side
only), the outcome union, the per-answer note, IPC and preload are unchanged.

**#340 Tier-2 (D-Z21) shapes:** `ArchiveOrigin` (`shared/types.ts`) is a new `DocumentOrigin`
member — `{ type: 'archive', packId, articlePath, archiveTitle: string | null, createdAt }`,
parsed by `parseOrigin`'s archive branch (`services/ingestion/index.ts`) alongside the legacy
and `GeneratedProvenance` shapes. `GeneratedKind` gains `'article'`; `provenanceView` maps an
`ArchiveOrigin` to `{ kind: 'article', sourceDocumentIds: [] }` — no source DOCUMENT, since the
copy was derived from a ZIM entry, not another document (staleness never fires for it).
`PackArticleSaveResult = { documentId, title, alreadySaved, chunkCount }` is `packs:saveArticle`'s
return shape (above); `chunkCount` is 0 when `alreadySaved`. A second invoke for the same
entry while the first is still importing joins that import (`alreadySaved: true`, the same
`documentId`) — the duplicate check reads the DB before the import runs, so the in-flight map is
what keeps two copies from being filed. The saved row is filed into the Library once indexed
(a user-chosen import, unlike the D3/N1 work-products that carry an origin and never get a
membership), so the default documents chat scope finds it. `ServiceContext.articleSaveActive`
(`services/context.ts`) is the in-flight probe the docs IPC delete / re-index guards consult
beside their own `processing` set and `skillRunActive`. New audit type
`'knowledge_pack_article_saved'` carries `{ packId, documentId, status: 'indexed', chunkCount }`
only — the entry path and both titles are content and never ride it. New plaintext op kind
`'article-save'` (`services/ingestion/plaintext-ops.ts`) tracks the `.parse.md` transient the
save writes before handing it to `createQueuedDocument` → `processDocument`, so a lock/quit
mid-save sweeps it like any other in-flight plaintext.

**Step 4-4 (Phase 4 PR-B, Wave 4 ruling (a)):** `AppSettings` gains `ragRerankWideScope: boolean`
(default `false`, the generic `typeof` write gate — no special-case needed, same as
`chatCompactionEnabled`/`localApiEnabled`) — the `cpu-hi` rerank hardware profile's opt-in
(`rag/rerank-profile.ts`'s `rerankScopeFor`: reranks the wider `top48` knowledge-pack candidate
pool on a machine with no usable GPU but at least `CPU_HI_MIN_THREADS` processor threads; no
effect on the `gpu` profile, which reranks `GPU_RERANK_SCOPE` regardless, or the `default`
profile). Surfaced as a `Switch` in `SettingsScreen.tsx`'s performance card beside the GPU
toggle; no new IPC channel (rides the existing `getSettings`/`updateSettings` pair). No shape
change to `ExternalCandidate`/`RetrievedChunk`/`Citation` — the scope widens WHICH chunks the
arm admits, never their fields.
