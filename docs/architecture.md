# Architecture — Private AI Drive Lite

_Last updated: 2026-06-09 (Phases 11–13 + audit rounds — see the new sections below)_

## Overview

Private AI Drive Lite is an **Electron** desktop app. It maps the spec's Tauri/Rust design onto
TypeScript while preserving the same module boundaries (spec §7) and command surface (spec §9.1), so
a future move to Tauri/Rust is a localized swap.

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed)                                    │
│  Screens: Onboarding · Home · Chat · Documents · Models ·      │
│           Privacy & Offline · Diagnostics · Settings           │
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
- `DocumentParser` — txt/md/pdf/docx/csv adapters (Phase 4).
- `VectorIndex` — cosine over SQLite-stored vectors (Phase 5) → `sqlite-vec`/HNSW later.

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
- **Recommendation** is data-driven: each manifest lists `recommended_profiles`; the picker returns
  the first chat/embedding model matching the current hardware profile. The profile comes from the
  persisted Phase-7 benchmark (`lastBenchmark?.profile`), defaulting to `UNKNOWN` until the user runs
  a benchmark.
- **`services/runtime/`** defines the `ModelRuntime` interface and a `RuntimeManager` that owns the
  single active runtime and restarts it on model switch. `MockRuntime` returns healthy immediately;
  its `chatStream` is a stub until Phase 3, and the real `LlamaRuntime` (localhost-only sidecar)
  lands in Phase 10. The factory passed to `RuntimeManager` is the only thing that changes.
- **IPC** (`ipc/registerModelIpc.ts`): `listModels`, `selectModel`, `startRuntime`, `stopRuntime`.
  The active runtime is stopped on `will-quit`.

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
- **Cancellation.** Each in-flight send holds an `AbortController` in a per-conversation map in
  `ipc/registerChatIpc.ts`; `stopGeneration(conversationId)` aborts it. The runtime's
  `chatStream` honours `options.signal` and stops emitting; whatever streamed so far is persisted
  as the (partial) assistant message and a normal `done` is emitted.
- **`MockRuntime.chatStream`** emits a deterministic reply token-by-token with a small delay so
  the renderer's streaming + stop path is exercised with zero model files. The real
  `LlamaRuntime` (Phase 10) swaps in behind the same `ModelRuntime` interface.
- **Runtime requirement (decision).** `sendChatMessage` does **not** auto-start a runtime: a chat
  needs a model explicitly started on the Models screen (`RuntimeManager.start()`). With no active
  runtime the handler throws and the Chat screen shows a "start a model" empty state that links to
  Models. Rationale: starting the real llama.cpp sidecar is heavy and is an explicit user action;
  keeping it explicit keeps the service boundary clean and the error path obvious.
- **IPC** (`ipc/registerChatIpc.ts`): `createConversation`, `listConversations`, `listMessages`,
  `sendChatMessage` (streaming), `stopGeneration`. Regenerate reuses `sendChatMessage` with
  `options.regenerate` — it deletes the last assistant message, then re-streams from history.

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
- **IPC** (`ipc/registerDocsIpc.ts`): `pickDocuments`, `importDocuments`, `getImportJob`,
  `listDocuments`, `deleteDocument`, `reindexDocument`. Full pipeline detail lives in
  [`rag-design.md`](rag-design.md).

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
- **UI**: `PrivacyScreen.tsx` (spec §7.10/§18.1) renders the offline statement, where data lives, the
  live network state, the plaintext-dev-mode caveat, and the logs-are-local guarantee. The sidebar
  badge reflects the live `getPolicy()` state.
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
  (no repeated GPU health timeouts on later starts); Diagnostics' "Try GPU again" clears it.
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
  `gpuMode 'auto' | 'off'` (default ON). Diagnostics shows the **Acceleration** line (live
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
| `services/security/` + `services/workspace-vault.ts` | 3.5 encryption, 7.9 workspace modes |
| `services/drive.ts` + `services/assets.ts` | §6 drive layout, §12 packaging |
| `services/launcher.ts` + `services/preflight.ts` | §6 launchers, §11.4 first-run check |
| `services/commercial-drive.ts` | §12.2 sellable-drive gate, §13 license reviews |
