# Architecture — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 8)_

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
- `ModelRuntime` — `MockRuntime` (now) → `LlamaRuntime` (Phase 10).
- `Embedder` — `MockEmbedder` (now) → real local embedder (Phase 10).
- `DocumentParser` — txt/md/pdf/docx/csv adapters (Phase 4).
- `VectorIndex` — cosine over SQLite-stored vectors (Phase 5) → `sqlite-vec`/HNSW later.

## Storage
`node:sqlite` — built into the Node bundled by **Electron 37** (Node 22.21). It is loaded via
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
  the first chat/embedding model matching the current hardware profile (stubbed `LITE` until the
  Phase 7 benchmark).
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
- **`services/offlineGuard.ts`** — `assertOfflinePosture()` runs at startup: logs the posture and (in
  dev/developer mode) installs a defensive tripwire over `net.Socket.prototype.connect` that **logs**
  any remote connection while offline. **Loopback (`127.0.0.1`/`localhost`/`::1`) is exempt** (dev
  renderer + Phase-10 sidecar). The guard never blocks or throws.
- **UI**: `PrivacyScreen.tsx` (spec §7.10/§18.1) renders the offline statement, where data lives, the
  live network state, the plaintext-dev-mode caveat, and the logs-are-local guarantee. The sidebar
  badge reflects the live `getPolicy()` state.
- Full detail in [`security-model.md`](security-model.md).

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
| `services/rag.ts` | 7.8 RAG |
| `services/benchmark.ts` | 7.3 benchmarker |
| `services/policy.ts` | 7.10 privacy/offline |
| `services/logging.ts` | 7.11 diagnostics/logs |
| `services/security/` | 3.5 encryption |
