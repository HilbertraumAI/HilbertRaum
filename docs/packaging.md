# Packaging — sidecars & model weights

_Last updated: 2026-06-09 (Phase 10)_

This documents **where the runtime binaries and model weights live on the drive** and that they are
**not** in the git repository. Full installer/portable-build packaging (electron-builder,
prepare-drive scripts) lands in **Phase 11**; this page covers the runtime-side layout Phase 10
introduced.

## Hard rules (recap)
- **Never commit** model weights, sidecar binaries, user data, embeddings, logs, or generated files
  (CLAUDE.md / spec §0). `.gitignore` already excludes `models/`, `*.gguf`, and `runtime/`.
- The app stays **fully usable offline**. Sidecars bind **`127.0.0.1` only** (loopback); nothing the
  app spawns listens on a routable interface.

## Drive layout (spec §6)
```
<drive root>/
  runtime/
    llama.cpp/
      win/    llama-server.exe   (+ DLLs)
      mac/    llama-server
      linux/  llama-server
  models/
    chat/        qwen3-1.7b-instruct-q4.gguf  …
    embeddings/  multilingual-e5-small-q8.gguf
  model-manifests/   (committed YAML — the only model metadata in git)
  workspace/   config/   logs/
```

- **Sidecar binaries** — prebuilt `llama.cpp` `llama-server` executables, one folder per OS. The OS
  sub-dir (`win`/`mac`/`linux`) and the executable name (`llama-server.exe` on Windows, `llama-server`
  elsewhere) are resolved by `resolveLlamaServerPath(rootPath, platform)` in
  `services/runtime/sidecar.ts`. A `PAID_LLAMA_BIN` env var overrides the path for dev.
- **Model weights** — GGUF files under `models/`, resolved from each manifest's `local_path` (relative
  to the drive root) via `weightPath(rootPath, manifest)`. They are **git-ignored**; a real drive is
  built by Phase 11's prepare-drive scripts (and verified against the manifest `sha256`, which is a
  `REPLACE_WITH_REAL_HASH` placeholder until real weights are produced).

## How the app uses them at runtime (Phase 10)
- The **runtime factory** (`createSelectingRuntimeFactory`) and the **embedder factory**
  (`createSelectedEmbedder`) each return the **real** backend (`LlamaRuntime` / `E5Embedder`) only when
  **both** the `llama-server` binary **and** the relevant GGUF weights exist; otherwise they fall back
  to the mock. So with an empty `runtime/` + `models/` (the repo's default, and CI), the app launches
  and every test passes on the mocks — the real backends are a drop-in the moment the files appear.
- Both real backends spawn `llama-server` on a random **loopback** port and talk to it over HTTP
  (`/v1/chat/completions` streaming for chat, `/v1/embeddings` for the embedder). The processes are
  killed on `stop()` and on `will-quit` (no orphaned `llama-server`).

## Acquiring the binaries / weights (manual, R5)
Phase 10's live path needs artifacts **not in the repo**:
- a `llama.cpp` `llama-server` build for your OS (place under `runtime/llama.cpp/<os>/`), and
- the GGUF weights named by the manifests (place under `models/...`).

With those present, start a chat model on the Models screen to get real on-device inference and real
tokens/sec in the benchmark. Automated, scripted provisioning + checksum verification is Phase 11.
