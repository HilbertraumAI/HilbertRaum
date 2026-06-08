# BUILD STATE — Private AI Drive Lite

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.

_Last updated: 2026-06-09 — Phase 2 complete; Phase 3 next_

---

## 1. Current status

| Phase | Name | Status |
|---|---|---|
| 0 | Repo skeleton & tooling | 🟢 done |
| 1 | App shell, workspace & settings | 🟢 done |
| 2 | Model manifests & runtime contract | 🟢 done |
| 3 | Basic chat (mock runtime) | 🟡 next |
| 4 | Document ingestion & chunking | ⚪ not started |
| 5 | Embeddings & vector search (mock) | ⚪ not started |
| 6 | RAG chat with citations | ⚪ not started |
| 7 | Hardware benchmark & recommendation | ⚪ not started |
| 8 | Privacy & offline hardening | ⚪ not started |
| 9 | Encrypted workspace | ⚪ not started |
| 10 | Real llama.cpp runtime & embeddings | ⚪ not started |
| 11 | Drive layout, scripts & packaging | ⚪ not started |

Legend: ⚪ not started · 🟡 in progress · 🟢 done · 🔴 blocked

---

## 2. Environment (verified 2026-06-09)

| Tool | Status |
|---|---|
| Node | v24.13.0 ✅ |
| npm | 11.6.2 ✅ |
| corepack | 0.34.5 ✅ (pnpm available if needed) |
| git | 2.54.0.windows.1 ✅ |
| winget | available ✅ |
| Rust / Cargo / rustup | ❌ NOT installed |
| Python | ❌ NOT installed |

OS: Windows 11 Pro (10.0.26200). Shell: PowerShell + bash both available.
Repo root: `f:\_coding\ai_drive`.

---

## 3. Decisions log

- **Stack = Electron + React + TS + Vite** (user choice; Rust not installed). Spec §4 permits Electron fallback.
- **Package manager = npm** with workspaces.
- **SQLite = `node:sqlite`** → fallback `sql.js` (WASM) if unstable. Avoid native `better-sqlite3`.
  ⚠️ **`node:sqlite` lives in the bundled Node of *Electron's main process*, not the system Node.**
  It needs Node ≥ 22.5. Electron 33 bundles Node 20 (no `node:sqlite`), so **Electron is pinned to
  `^37` (Node 22.x)**. Validate `node:sqlite` *inside Electron* at the start of Phase 1, not against
  system Node.
- **Mock-first:** `MockRuntime` + `MockEmbedder` so the app runs with zero model files. Real llama.cpp/embeddings deferred to Phase 10, behind the same interfaces.
- **Vector search = cosine over SQLite-stored vectors** for MVP.
- **Plaintext dev workspace allowed in dev**; encrypted is the commercial default (Phase 9).
- **YAML parsing = `yaml` npm package** (Phase 2 decision). Pure JS, no native deps, MIT, offline.
  Chosen over hand-rolling for reliability; parsing happens in the main process only. Validation is a
  hand-written pure function in `shared/manifest.ts` so it is shared with the renderer and unit-tested
  without I/O.
- **Manifest `local_path` is relative to the drive root** (existing Phase 0 manifests already include
  the `models/` prefix), so weight files resolve to `<root>/models/...`. Recommendation is data-driven
  via an optional `recommended_profiles` list on each manifest.

---

## 4. Shared data contracts (the actual "transported data")

> Source of truth for cross-module/cross-phase types. Keep in sync with `apps/desktop/src/shared/`.
> Phases append/refine here so later phases know the exact shapes.

### IPC command surface (spec §9.1) — target
```ts
getAppStatus(): Promise<AppStatus>
getDriveStatus(): Promise<DriveStatus>
runBenchmark(): Promise<BenchmarkResult>
listModels(): Promise<ModelInfo[]>
selectModel(modelId: string): Promise<void>
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
Wired so far: core (Phase 1) + `listModels`/`selectModel`/`startRuntime`/`stopRuntime` (Phase 2).
Chat/docs/benchmark handlers land in their phases._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helpers: `openDatabase(path)`, `listTables(db)`.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts; `seedSettings` seeds on first run. Default `allowNetwork:false`,
`workspaceMode:'plaintext_dev'`, `contextTokens:4096`.

### Workspace/paths
✅ `src/main/services/workspace.ts` — `resolvePaths({envRoot,fallbackRoot})` → `ResolvedPaths`
(rootPath, workspacePath, modelsPath, logsPath, configPath, dbPath, isPreparedDrive).
`ensureWorkspaceDirs`, `buildDriveStatus` (adds platform/arch/free/writable). See `docs/drive-layout.md`.

### Core IPC (Phase 1 live)
✅ `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings` registered in
`src/main/ipc/registerCoreIpc.ts`, invoked from `initBackend()` in `main/index.ts`.

### Models + runtime (Phase 2 live)
✅ **Manifest** schema/validator in `src/shared/manifest.ts` (`ModelManifest`, `validateManifest`,
`isRealSha256`). YAML files under `model-manifests/` (chat: Qwen3 1.7B/4B/8B Q4; embeddings: E5 small).
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
select/start-stop. Hardware profile **stubbed `LITE`** until Phase 7.

### Streaming contract
TBD in Phase 3 (chosen approach: main → renderer via IPC event channel `chat:token:<requestId>` with `{token}` / `chat:done` / `chat:error`). Preload helper `onToken(requestId, cb)` already stubbed. _Confirm in Phase 3._

---

## 5. Next actions (do these next) — START OF PHASE 3

Phase 3 = Basic chat with the mock runtime (spec Milestone 3 / Step 4). Build, in order:
1. `services/chat.ts` — create conversation, append user/assistant messages, build the system prompt
   (spec §7.6), persist to `conversations`/`messages`. UUIDs + ISO timestamps (see §7 conventions).
2. **Streaming** — implement `MockRuntime.chatStream` for real token-by-token emit and wire the
   main→renderer event channel already locked in §"Streaming contract": `chat:token:<id>` /
   `chat:done:<id>` / `chat:error:<id>`. Support **stop/cancel** via `AbortSignal` (the
   `RuntimeChatOptions.signal` field is already on the interface). The active runtime is reachable via
   `ctx.runtime.active()`.
3. IPC: `createConversation`, `listConversations`, `listMessages`, `sendChatMessage` (streaming),
   `stopGeneration`. Channel names already exist in `shared/ipc.ts`. Add preload methods.
4. Chat screen — conversation list, streamed message view, stop, regenerate, copy. Guard with a
   "select & start a model first" empty-state (Models screen already selects/starts the runtime).
5. Tests: conversation persistence, message ordering, stop cancels the stream.
6. **Ritual:** update `docs/architecture.md` (chat/runtime) + this file's streaming contract; commit.

Notes / gotchas for Phase 3:
- `MockRuntime.chatStream` currently yields one stub string — replace with chunked emit + delay so the
  UI streaming path is exercised without a real model.
- A chat request needs a running runtime; `RuntimeManager.start()` must have been called (Models
  screen "Start runtime"). Decide whether `sendChatMessage` auto-starts the selected model.
- `messages.citations_json` exists in the schema but stays null until Phase 6 (RAG).

Phase 2 is DONE: typecheck clean, **47/47 tests pass** (added manifest validate, checksum verify,
model-state computation, recommendation mapping, manifest discovery/dupe/recurse, manifests-dir
resolution, selectModel persistence, runtime manager/mock). `npm run build` green (main bundle now
244.71 kB — `yaml` is bundled into main). Models screen lists/verifies/selects/starts models against
the Phase 0 manifests. (Live `npm run dev` window smoke = manual.)

---

## 6. Open issues / risks

- **R1 `node:sqlite` ✅ RESOLVED** — works in Electron 37 (Node 22.21) main process and in vitest
  (system Node 24). Only an experimental warning (harmless). Bundler resolution fixed via
  `createRequire` in `db.ts`. `sql.js` fallback not needed.
- **R2 Electron binary download** — `npm i electron` pulls a ~100MB binary; needs dev-time internet. The *app* stays offline; only dev install needs network.
- **R3 PDF/DOCX parsers** — pick pure-JS libs (`pdfjs-dist`, `mammoth`) to avoid native deps. Validate Phase 4.
- **R4 Argon2id** — native `argon2` may not build on Node 24; fallback to `node:crypto` `scrypt` documented in Phase 9.
- **R5 Real llama.cpp** — needs platform sidecar binaries + a GGUF model not in repo; Phase 10 live test is manual.
- **R6 TLS-intercepting proxy on this machine** — `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (corporate root CA). Workaround: `NODE_OPTIONS=--use-system-ca npm install` (Node 24 reads the Windows cert store). If that fails, `npm config set strict-ssl false` (dev-only, less secure) or set `NODE_EXTRA_CA_CERTS`. Affects dev installs only; the app stays offline.

---

## 7. Conventions

- IDs: UUID v4 (`crypto.randomUUID()`). Timestamps: ISO-8601 UTC.
- No network in core path. No telemetry. Models/workspace/logs are git-ignored.
- Every service hides behind an interface from spec §9.2 to keep the Tauri/Rust swap open.
