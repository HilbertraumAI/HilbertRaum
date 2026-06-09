# Packaging — portable build, sidecars & model weights

_Last updated: 2026-06-09 (Phase 11)_

This documents **how the app is packaged into a portable build**, **where the runtime binaries and
model weights live on the drive**, and that those artifacts are **not** in the git repository.
Phase 10 introduced the runtime-side layout; Phase 11 adds the `electron-builder` portable build +
the `prepare-drive`/`verify-models` scripts.

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
tokens/sec in the benchmark.

## Portable build (electron-builder, Phase 11)

The app is packaged with **electron-builder** (`apps/desktop/electron-builder.yml`). The primary
target is a **portable Windows `.exe`** that launches from an external drive; macOS (`dir`) and
Linux (`AppImage`) targets are defined for architecture parity (spec rule: keep all three
supported), even though only Windows is produced on the current dev machine.

```bash
npm run package        # electron-vite build + electron-builder (current OS targets)
npm run package:win    # build + a Windows portable .exe specifically
```

Key config points:
- **Electron ≥ 37 (Node 22.x)** is required so the packaged main process has `node:sqlite`
  (`electron` is pinned `^37`). A downgraded/stripped runtime would lose it — do not downgrade.
- **Production `dependencies` ship inside `app.asar`** (`pdfjs-dist` / `mammoth` / `papaparse` /
  `yaml`), so the lazy `require()`s in the parsers + manifest loader resolve at runtime.
- **`model-manifests/` ship as `extraResources`** (beside `app.asar`). The packaged main process
  finds them via `resolveManifestsDir(app.getAppPath())`, which walks up to `resources/model-manifests`;
  `PAID_MANIFESTS_DIR` overrides. Weights + sidecar binaries are **never** bundled — they live on
  the prepared drive.
- The build output goes to `apps/desktop/release/` (git-ignored).

### Launching from a drive
Copy the portable `.exe` to the drive root next to the prepared layout, then launch it with
`PAID_DRIVE_ROOT` pointing at the drive root (the drive's launcher sets this; `resolvePaths` keys
off `config/drive.json`). The app then reads `models/`, `workspace/`, `config/`, etc. from the drive.

> ⚠️ **Producing the actual artifact is a MANUAL step (R2/R5).** electron-builder may download the
> platform Electron binary at build time (R2, dev-only network), and a real USB-drive launch with a
> live model needs the weights + sidecar binaries that are not in the repo (R5). With npm workspaces,
> production deps are hoisted to the root `node_modules`; if electron-builder can't collect them,
> build from `apps/desktop` or temporarily disable hoisting. None of this affects `npm test` /
> `typecheck` / `npm run build` (the green gate), which do not invoke electron-builder.

## Preparing a drive — scripts (Phase 11)

`scripts/` provisions and verifies a drive. The scripts are **self-contained** (a drive can be laid
out on a fresh machine with no Node/npm); their layout + config shapes mirror the unit-tested
`apps/desktop/src/main/services/drive.ts` (the canonical reference — keep them in sync).

| Script | Purpose |
|---|---|
| `prepare-drive.{ps1,sh}` | Create the directory tree, copy manifests + user docs, generate `config/{drive,policy}.json`. `-DryRun`/`--dry-run` prints the plan. `-Dev`/`--dev` → a plaintext developer drive. |
| `verify-models.{ps1,sh}` | SHA-256 each present weight vs its manifest hash (placeholder → *UNVERIFIED*; real mismatch → fail/exit 1). `-Generate`/`--generate` writes `config/checksums.json`. |
| `setup-dev.{ps1,sh}` | Dev bootstrap: `NODE_OPTIONS=--use-system-ca npm install` (R6) + build + test smoke. |

End-to-end (Windows example):
```powershell
.\scripts\prepare-drive.ps1 -Target E:\          # lay out the drive
# ... drop GGUF weights into E:\models\... and llama-server into E:\runtime\llama.cpp\win\ ...
.\scripts\verify-models.ps1 -Target E:\ -Generate  # verify + record real hashes
npm run package:win                               # build the portable .exe
copy .\apps\desktop\release\*.exe E:\             # place the launcher on the drive
```

These artifacts (weights, sidecar binaries, the workspace DB, logs, the portable `.exe`) are all
**git-ignored** — they live on the drive, never in the repo.
