# BUILD STATE — Private AI Drive Lite

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.

_Last updated: 2026-06-09 — Phase 0 complete; Phase 1 next_

---

## 1. Current status

| Phase | Name | Status |
|---|---|---|
| 0 | Repo skeleton & tooling | 🟢 done |
| 1 | App shell, workspace & settings | 🟡 next |
| 2 | Model manifests & runtime contract | ⚪ not started |
| 3 | Basic chat (mock runtime) | ⚪ not started |
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
- **SQLite = `node:sqlite`** (Node 24 built-in) → fallback `sql.js` (WASM) if unstable. Avoid native `better-sqlite3` (no Node 24 prebuilts). _To be validated in Phase 1._
- **Mock-first:** `MockRuntime` + `MockEmbedder` so the app runs with zero model files. Real llama.cpp/embeddings deferred to Phase 10, behind the same interfaces.
- **Vector search = cosine over SQLite-stored vectors** for MVP.
- **Plaintext dev workspace allowed in dev**; encrypted is the commercial default (Phase 9).

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
_Status: TypeScript types implemented in `apps/desktop/src/shared/types.ts`; channel names in
`src/shared/ipc.ts`. Handlers not yet wired (Phase 1)._

### DB schema
Spec §8 (settings, conversations, messages, documents, chunks, embeddings, runtime_events). _Not yet created — Phase 1._

### Streaming contract
TBD in Phase 3 (chosen approach: main → renderer via IPC event channel `chat:token:<requestId>` with `{token}` / `chat:done` / `chat:error`). _Placeholder; confirm in Phase 3._

---

## 5. Next actions (do these next) — START OF PHASE 1

Phase 1 = App shell, workspace & settings (spec Milestone 1). Build, in order:
1. `services/logging.ts` — local rotating logger writing to `<workspace>/logs/` (no upload).
2. `services/workspace.ts` — resolve root path (priority: `PAID_DRIVE_ROOT` env → prepared-drive layout detection via `config/drive.json` → app-data fallback `app.getPath('userData')`). Create `workspace/`, `logs/`, `models/` dirs; detect writability + free space (`fs.statfs`); build `DriveStatus`.
3. `services/db.ts` — open `node:sqlite` DB at `<workspace>/paid.sqlite`; run migrations creating all spec §8 tables; expose typed helpers.
4. `services/settings.ts` — get/update settings backed by `settings` table; seed `DEFAULT_SETTINGS`.
5. `ipc/registerCoreIpc.ts` — wire `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings`; call from `main/index.ts` `app.whenReady`.
6. Flesh out Home + Diagnostics + a basic Settings screen using real data.
7. Tests: path resolution, settings round-trip, migration creates tables, drive-status shape.
8. **Ritual:** update `docs/drive-layout.md` + `docs/architecture.md`; update this file; commit.

Phase 0 is DONE: typecheck clean, 2/2 tests pass, `npm run build` produces main/preload/renderer
bundles. (Live `npm run dev` window smoke is recommended manually by the user.)

---

## 6. Open issues / risks

- **R1 `node:sqlite` stability on Node 24** — may print experimental warning or need a flag. Mitigation: `sql.js` WASM fallback. Validate Phase 1.
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
