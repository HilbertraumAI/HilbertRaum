# Implementation Plan — Private AI Drive Lite (Electron MVP)

_Last updated: 2026-06-09_

This is the master, phased build plan for the Private AI Drive Lite MVP.
It is derived from the source specification in
[`../CLAUDE_Private_AI_Drive_Lite_MVP.md`](../CLAUDE_Private_AI_Drive_Lite_MVP.md)
and adapted to the chosen stack.

> **How to use this file with the build state file**
> - This file (`IMPLEMENTATION_PLAN.md`) is the *static* plan: phases, scope, acceptance criteria. It changes rarely.
> - [`../BUILD_STATE.md`](../BUILD_STATE.md) is the *dynamic* handoff file that carries data between steps/sessions: what is done, decisions made, current data contracts, next actions, open issues. **Read `BUILD_STATE.md` first at the start of every session.**
> - **After completing each phase**, you MUST: (1) update `BUILD_STATE.md`, and (2) update the relevant docs under `docs/`. This is a hard rule (see §"Per-phase ritual").

---

## 0. Key decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Desktop framework | **Electron** + React + TypeScript + Vite (via `electron-vite`) | Rust/Cargo not installed; spec permits Electron as fallback. Pure Node tooling works immediately. |
| Backend language | TypeScript in Electron **main** process | One language across the stack; clean service boundaries preserve a future Tauri/Rust swap. |
| Package manager | **npm** (workspaces) | Installed and working; spec preferred pnpm but npm is the boring, available choice. Documented as swappable. |
| SQLite driver | `node:sqlite` (Node 24 built-in) with fallback to `sql.js` (WASM) | Avoids native compilation (`better-sqlite3` lacks Node 24 prebuilts). Portable across OSes. |
| Inference (default) | **Mock runtime first**, real `llama.cpp` `llama-server` sidecar later | Lets the whole app run with no model files present. |
| Embeddings (default) | **Deterministic mock embedder** first, real local model later | Same reason; keeps RAG testable offline with zero downloads. |
| Vector store | Cosine search over vectors stored in SQLite (`embeddings` table) | Simplest reliable cross-platform option; no Docker/server. Upgrade to `sqlite-vec`/HNSW later. |

These mirror the swappable interfaces in spec §9.2 (`ModelRuntime`, `Embedder`, `DocumentParser`, `VectorIndex`). All implementations sit behind those interfaces so the mock→real swap is local.

---

## 1. Architecture (Electron mapping of spec §4/§7/§9)

```
apps/desktop/
├── src/
│   ├── main/                 # Electron main process = the "Rust backend" equivalent
│   │   ├── index.ts          # app lifecycle, window, runtime shutdown on quit
│   │   ├── ipc/              # IPC handlers mirroring spec §9.1 commands
│   │   ├── services/         # business logic (one module per spec §7 module)
│   │   │   ├── workspace.ts      # §7.9 workspace/drive manager + settings
│   │   │   ├── db.ts            # SQLite open/migrate (spec §8 schema)
│   │   │   ├── models.ts        # §7.4 model manifest loader + checksums
│   │   │   ├── runtime/         # §7.5 ModelRuntime interface + MockRuntime + LlamaRuntime
│   │   │   ├── chat.ts          # §7.6 chat service
│   │   │   ├── ingestion/       # §7.7 parsers + chunker
│   │   │   ├── embeddings/      # §6 Embedder interface + MockEmbedder + real
│   │   │   ├── rag/             # §7.8 retrieval + grounded prompt + citations (index.ts)
│   │   │   ├── benchmark.ts     # §7.3 hardware benchmark + profiles
│   │   │   ├── policy.ts        # §3.5/§3.6 offline/network policy
│   │   │   └── logging.ts       # §7.11 local rotating logs
│   ├── preload/              # contextBridge typed API (no nodeIntegration in renderer)
│   ├── renderer/            # React UI (spec §10 screens)
│   │   ├── screens/         # Onboarding, Home, Chat, Documents, Models, Settings, Privacy, Diagnostics
│   │   ├── components/
│   │   └── lib/             # typed client over window.api
│   └── shared/             # types shared between main/preload/renderer (spec §9.1 contracts)
└── tests/                  # unit + integration (spec §15)
```

**Security posture (Electron-specific, satisfies spec §3.5):**
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` where feasible, a strict CSP with **no remote origins**, and **no network code in the core path**. Renderer only talks to main via the preload `contextBridge`.

---

## 2. Phases

Each phase is a vertical slice that leaves the app runnable. Phases map to spec milestones (§16) and the spec's own step list (§21).

### Phase 0 — Repo skeleton & tooling  *(spec Milestone 0 / Step 1)*
- **Goal:** A buildable Electron+React+TS app with placeholder UI; all planning/doc infrastructure in place.
- **Deliverables:** root `package.json` (workspaces), `apps/desktop` `electron-vite` scaffold, TS configs, `.gitignore` (excludes models/workspace/logs/node_modules), this plan, `BUILD_STATE.md`, core docs (README, CLAUDE.md, LICENSE, PRIVACY.md, SECURITY.md, CONTRIBUTING.md). _(ESLint/Prettier were planned but never installed; the `lint` scripts were removed in audit round 4 — `typecheck` is the static gate.)_
- **Acceptance:** `npm run dev` opens a window with a placeholder screen; `npm run build` succeeds; no model runtime yet.
- **Tests:** typecheck passes; a trivial unit test runner (vitest) runs green.
- **Docs to update:** `docs/architecture.md` (initial), README run instructions.

### Phase 1 — App shell, workspace & settings  *(Milestone 1 / Step 2)*
- **Goal:** App detects/creates a workspace, loads/saves settings in SQLite, shows real status.
- **Deliverables:** `workspace.ts` (resolve workspace dir from drive/env/default app-data; create `workspace/`, `logs/`, dirs; detect drive root & free space & writability per spec §7.2), `db.ts` (open SQLite, run migrations for spec §8 tables), `settings` get/update, `logging.ts`. IPC: `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings`. Screens: Home (status), Diagnostics (OS/paths/health), basic Settings, Onboarding shell.
- **Acceptance:** spec Milestone 1 criteria — workspace path detected, dirs created, settings persist across restart, Home shows status, Diagnostics shows OS + paths.
- **Tests:** path handling, settings round-trip, migration creates tables.
- **Docs:** `docs/drive-layout.md`, `docs/architecture.md`.

### Phase 2 — Model manifests & runtime launcher contract  *(Milestone 2 / Step 3, partial 5)*
- **Goal:** Manifests load & validate; model states computed (installed/missing/checksum_failed/...); Models screen; `ModelRuntime` interface + start/stop scaffolding (mock-backed health check).
- **Deliverables:** manifest schema + validator (`shared/manifest.ts`), example manifests in `model-manifests/`, `models.ts` (discover, validate, sha256 verify, recommend-by-profile stub, select active), Models screen. `runtime/index.ts` (interface), `runtime/mock.ts` health. IPC: `listModels`, `selectModel`, `startRuntime`, `stopRuntime`.
- **Acceptance:** manifests parse; missing model shown clearly; checksum mismatch flagged; runtime start/stop returns health (mock).
- **Tests:** manifest parsing, checksum verification, model recommendation, model-state computation.
- **Docs:** `docs/model-policy.md`, `model-manifests/README.md`.

### Phase 3 — Basic chat (mock runtime)  *(Milestone 3 / Step 4)*
- **Goal:** Create conversations, stream a mock response token-by-token, persist messages, stop generation.
- **Deliverables:** `chat.ts` (create conversation, append messages, system prompt from spec §7.6), `runtime/mock.ts` streaming (IPC event stream / chunked emit), Chat screen (conversation list, message stream, stop, regenerate, copy). IPC: `createConversation`, `sendChatMessage` (streaming via events), `stopGeneration`, conversation/message loaders.
- **Acceptance:** spec Milestone 3 — send message, response streams into UI, conversation persists, stop works.
- **Tests:** conversation persistence, message ordering, stop cancels stream.
- **Docs:** `docs/architecture.md` (chat/runtime), update `BUILD_STATE` data contracts for streaming.

### Phase 4 — Document ingestion & chunking  *(Milestone 4 / Step 6)*
- **Goal:** Import txt/md/pdf/docx/csv, extract text, chunk, store metadata, show status & errors.
- **Deliverables:** `ingestion/parsers/*` (`TxtParser`, `MarkdownParser`, `PdfParser`, `DocxParser`, `CsvParser`) behind `DocumentParser` interface; `ingestion/chunker.ts` (size 500 / overlap 80 tokens approx, max 1000 chunks/file); ingestion job tracking (statuses per spec §7.7); Documents screen (import, per-file status, errors, delete/re-index). IPC: `importDocuments`, `getImportJob`, `listDocuments`, `deleteDocument`.
- **Acceptance:** spec Milestone 4 — import formats, text extracted, chunks created + metadata stored, failures shown clearly. Bad files handled gracefully.
- **Tests:** each parser on fixtures, chunker boundaries/overlap, error capture for corrupt file.
- **Docs:** `docs/rag-design.md` (ingestion), sample-data README.

### Phase 5 — Embeddings & vector search (mock embedder)  *(Milestone 5 / Step 7)*
- **Goal:** Embed chunks locally (deterministic mock), embed query, return top-k via cosine, all offline.
- **Deliverables:** `embeddings/index.ts` (`Embedder` interface), `embeddings/mock.ts` (deterministic hash-based vectors, fixed dims), vector storage in `embeddings` table, `VectorIndex` cosine search, re-index on embedding-model change. IPC wired into ingestion + retrieval.
- **Acceptance:** spec Milestone 5 — chunks embedded locally, query embedded locally, top chunks returned, **no network calls** (assert in test).
- **Tests:** determinism, cosine ranking sanity, model-id tagged on embeddings, no-network assertion.
- **Docs:** `docs/rag-design.md` (embeddings/vector store).

### Phase 6 — RAG chat with citations  *(Milestone 6 / Step 8)*
- **Goal:** Ask questions over documents; inject retrieved chunks; answer cites sources; snippets shown in UI.
- **Deliverables:** `rag/index.ts` (retrieve top_k_initial 12 → final 6, dedup, build grounded prompt from spec §7.8 template, source labels `[S1]...`), citation parsing + storage (`messages.citations_json`), Chat "Ask Documents" mode + source snippet panel. IPC: `askDocuments`.
- **Acceptance:** spec Milestone 6 — relevant chunks injected, answer cites sources, snippets visible. Citation-uncertainty copy used when retrieval is weak.
- **Tests:** grounded prompt assembly, citation formatting/parsing, dedup by document/page.
- **Docs:** `docs/rag-design.md` (full pipeline + citation format).

### Phase 7 — Hardware benchmark & recommendation  *(Milestone 7 / Step 9)*
- **Goal:** Detect RAM/CPU/OS/arch (+GPU best-effort), measure drive read/write, classify profile, recommend model, warn gently.
- **Deliverables:** `benchmark.ts` (os/`process` + `node:os` for RAM/cpu; temp-file disk speed test; optional short model run when a real runtime exists), profile classification (TINY/LITE/BALANCED/PRO/UNKNOWN per spec §7.3/§11), recommendation table, Diagnostics + Onboarding integration, user-facing language per spec §11.4/§18.2. IPC: `runBenchmark`.
- **Acceptance:** spec Milestone 7 — RAM/OS/CPU detected, drive speed checked, profile assigned, recommended model shown, weak-hardware warning (non-blocking).
- **Tests:** classification thresholds, profile→model mapping, drive-speed warning logic.
- **Docs:** `docs/benchmark.md` (shipped under this name; the spec §5 called it `benchmark-plan.md`).

### Phase 8 — Privacy & offline hardening  *(Milestone 8 / Step 10)*
- **Goal:** Visible offline mode; network disabled by default; privacy page complete; logs local only; plaintext dev mode clearly separated.
- **Deliverables:** `policy.ts` (load `policy.json`/`drive.json`, `allow_network` default false), offline indicator wired everywhere, Privacy & Offline screen (spec §7.10/§18.1 copy), CSP/no-network audit, settings checkbox "Allow internet access for model downloads and updates" (default off). A startup self-check that asserts no outbound network in core path.
- **Acceptance:** spec Milestone 8 criteria.
- **Tests:** policy parsing, default-deny network, no-network integration assertion across core path.
- **Docs:** `docs/security-model.md`, `PRIVACY.md` finalization.

### Phase 9 — Encrypted workspace  *(Milestone 9)*
- **Goal:** Password-protected workspace; lock/unlock; password never stored; salt/KDF params stored.
- **Deliverables:** `security/crypto.ts` (Argon2id KDF — use `node:crypto` `scrypt` as portable fallback if argon2 native unavailable, documented; AES-256-GCM for DB/doc cache), workspace lock/unlock flow, encrypted vs `plaintext_dev` modes (spec §7.9), Onboarding password step. Commercial default = encrypted.
- **Acceptance:** spec Milestone 9 — password-protected workspace, data encrypted/protected, lock/unlock, password not stored.
- **Tests:** KDF determinism with stored params, encrypt/decrypt round-trip, wrong-password failure, no plaintext password persisted.
- **Docs:** `docs/security-model.md` (encryption), `SECURITY.md`.

### Phase 10 — Real llama.cpp runtime & real embeddings  *(spec Step 5 real / §3.2)*
- **Goal:** Replace mocks with real local inference when binaries+models are present; graceful fallback to mock/"missing model" when not.
- **Deliverables:** `runtime/llama.ts` (`LlamaRuntime`: spawn `llama-server` on `127.0.0.1`, random local port, stream via OpenAI-compatible endpoint, shutdown on exit, health check, timeouts), real `Embedder` (llama.cpp embeddings endpoint or ONNX), sidecar discovery under `runtime/`. Drive layout `runtime/llama.cpp/<os>/`.
- **Acceptance:** spec Milestone 2 real criteria — sidecar starts/stops, health works, a real local model answers a prompt; bound to localhost only; not exposed to LAN.
- **Tests:** port binding localhost-only, process cleanup on quit, health timeout handling. (Live model test is manual — needs a GGUF file.)
- **Docs:** `docs/architecture.md` (runtime), `docs/packaging.md` (sidecars).

### Phase 11 — Drive layout, prepare-drive scripts & packaging  *(Milestone 10 / §6 / §12)*
- **Goal:** Scripts to lay out a drive; app launches from drive; packaged build; user docs.
- **Deliverables:** `scripts/prepare-drive.ps1` + `.sh`, `verify-models.ps1` + `.sh`, `setup-dev.ps1` + `.sh`, drive `config/{drive,policy,checksums}.json` generators (spec §6), `electron-builder` packaging config (portable Windows build runnable from external drive), user-guide/troubleshooting docs.
- **Acceptance:** spec Milestone 10 — prepare-drive works, app launches from drive, models verified, user guide included, non-technical demo (spec §17) completable.
- **Tests:** prepare-drive dry-run creates layout, checksum generation/verification.
- **Docs:** `docs/packaging.md`, `docs/drive-layout.md`, user guide.

### Phases 12–13 — Provisioning & distribution *(post-MVP polish)*
- **Goal:** (12) a DIY `fetch-assets` script that downloads + SHA-256-verifies model weights and
  the `llama.cpp` sidecar onto a drive; (13) a plug-and-play commercial drive — portable bundled
  app + per-OS launcher + code-signing/notarization + a one-command "build a sellable drive"
  pipeline. Decision: **portable bundled app, not Docker and not a system installer.**
- **Full plan:** [`provisioning-and-distribution-plan.md`](provisioning-and-distribution-plan.md)
  (research, Docker comparison, per-phase acceptance criteria, data contracts, risks).

---

## 3. Per-phase ritual (MANDATORY)

At the end of **every** phase, in order:

1. Run unit + integration tests for the slice; ensure green.
2. Run/lint the app to confirm it still launches (`npm run dev` smoke check or build).
3. **Update `docs/`** affected by the phase (listed per phase above). Bump the `_Last updated_` date.
4. **Update `BUILD_STATE.md`**: mark phase done, record decisions, refresh data contracts, set next actions, log open issues/risks.
5. Commit with a message referencing the phase + milestone.

A phase is not "done" until steps 3 and 4 are complete.

---

## 4. Definition of Done (MVP — spec §22)

App builds on ≥1 OS; architecture supports Win/macOS/Linux; local model chat works; local doc Q&A works; citations work; manifests work; drive layout works; user data local; privacy docs exist; setup script exists; benchmark recommendation exists; non-technical demo possible; no cloud API; no model weights in git; README explains DIY; commercial drive layout documented.

---

## 4b. Plan analysis & critique (self-review)

**Sequencing — sound.** The mock-first spine (Phases 3/5 use `MockRuntime`/`MockEmbedder`) lets the entire UI + data layer + RAG be built and tested with **zero model files and zero network**, which is exactly the spec's offline ethos. Real inference (Phase 10) only swaps an implementation behind a fixed interface, so it can't destabilize the UI.

**Dependency graph (critical path):**
`P0 → P1 (DB) → {P3 chat, P4 ingestion}`; `P4 → P5 (embeddings) → P6 (RAG)`; `P2` (manifests) is parallel-ish but feeds P3/P10 (model selection). `P7/P8` depend only on P1. `P9` touches P1's storage layer. `P10` swaps P3/P5 internals. `P11` packages everything. → **P1 is the highest-leverage phase**; everything downstream needs the DB + workspace.

**Refinements applied after review:**
- **R1 pulled earlier:** validate `node:sqlite` during **Phase 0** (a 10-line spike) instead of discovering breakage in Phase 1. De-risks the single most load-bearing dependency.
- **Encryption tension (P9):** `node:sqlite` has **no SQLCipher**, so we cannot transparently encrypt the live DB. Decision recorded for P9: use **encryption-at-rest of the whole workspace DB file** — on unlock, decrypt to a working file (kept on the drive, not a temp cloud dir); on lock/quit, re-encrypt and shred the plaintext working copy. Sensitive blobs (extracted text, embeddings) live inside that DB. This keeps P1's plaintext-dev DB and P9's encrypted mode using the *same* schema — encryption wraps the file, not the rows. Field-level encryption remains a future option.
- **Streaming decided up front** (don't defer): main→renderer via a per-request IPC event channel. Locked in §"Streaming contract" of `BUILD_STATE.md` so Phase 3 doesn't re-litigate it.
- **Parser libs pinned to pure-JS** (`pdfjs-dist`, `mammoth`, `papaparse`) to avoid native builds on Node 24 — consistent with the "no native compilation" theme that also drove the SQLite choice.

**Honesty about scope:** Phases 0–9 are fully achievable in TypeScript with no external binaries. Phase 10 (real llama.cpp) and Phase 11 (packaging from a real USB drive) have **manual, hardware-dependent acceptance steps** that cannot be fully automated here — those are explicitly marked manual.

**What the plan deliberately does NOT do** (matches spec §2.2 exclusions): no image gen, no agentic browser, no cloud fallback, no multi-user, no fine-tuning, no voice, no mobile.

---

## 5. Phase → spec milestone map

| Phase | Spec milestone (§16) | Spec step (§21) |
|---|---|---|
| 0 | 0 | 1 |
| 1 | 1 | 2 |
| 2 | 2 (manifests) | 3 |
| 3 | 3 | 4 |
| 4 | 4 | 6 |
| 5 | 5 | 7 |
| 6 | 6 | 8 |
| 7 | 7 | 9 |
| 8 | 8 | 10 |
| 9 | 9 | — |
| 10 | 2 (runtime, real) | 5 |
| 11 | 10 | — |
