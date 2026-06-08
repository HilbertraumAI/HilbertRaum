# Architecture — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 2)_

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
- **CSP**: same-origin only; no remote origins (see `src/renderer/index.html`). Hardened in Phase 8.

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
